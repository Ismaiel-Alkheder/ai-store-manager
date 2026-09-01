import { NextResponse } from "next/server";

import db from "@/lib/database";

import {
    ensureFulfillmentSchema,
} from "@/lib/fulfillment-schema";
import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

export const runtime = "nodejs";

ensureFulfillmentSchema(db);

const API_VERSION = "2026-07";

async function getAccessToken() {
    const shop = process.env.SHOPIFY_SHOP;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!shop || !clientId || !clientSecret) {
        throw new Error(
            "Missing Shopify environment variables."
        );
    }

    const response = await fetch(
        `https://${shop}.myshopify.com/admin/oauth/access_token`,
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: clientSecret,
            }),
            cache: "no-store",
        }
    );

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            `Could not get Shopify access token: ${response.status} ${JSON.stringify(
                data
            )}`
        );
    }

    return data.access_token as string;
}

async function shopifyGraphQL(
    query: string,
    variables: Record<string, unknown>,
    token: string
) {
    const shop = process.env.SHOPIFY_SHOP;

    if (!shop) {
        throw new Error("SHOPIFY_SHOP missing.");
    }

    const response = await fetch(
        `https://${shop}.myshopify.com/admin/api/${API_VERSION}/graphql.json`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": token,
            },
            body: JSON.stringify({
                query,
                variables,
            }),
            cache: "no-store",
        }
    );

    const result = await response.json();

    if (!response.ok) {
        throw new Error(
            `Shopify request failed: ${response.status} ${JSON.stringify(
                result
            )}`
        );
    }

    if (result.errors) {
        throw new Error(
            JSON.stringify(result.errors)
        );
    }

    return result.data;
}

function fail(
    message: string,
    status = 400,
    extra: Record<string, unknown> = {}
) {
    return NextResponse.json(
        {
            success: false,
            error: message,
            ...extra,
        },
        {
            status,
        }
    );
}

function normalizeFulfillmentOrderId(
    value: unknown
) {
    const raw = String(value || "").trim();

    if (!raw) {
        return null;
    }

    if (
        raw.startsWith(
            "gid://shopify/FulfillmentOrder/"
        )
    ) {
        return raw;
    }

    if (/^\d+$/.test(raw)) {
        return `gid://shopify/FulfillmentOrder/${raw}`;
    }

    return null;
}

/*
  POST /api/fulfillment-service/accept

  Body:
  {
    "fulfillmentOrderId": "8725525791029",
    "confirm": true,
    "message": "Accepted by AI Test Warehouse",
    "estimatedShippedAt": "2026-08-31T18:00:00Z"
  }

  The route acts as OUR fulfillment service.

  Safety rules:
  - explicit confirm:true is required
  - the Fulfillment Order must be assigned to a
    location owned by this app
  - it must currently appear in
    assignedFulfillmentOrders(
      assignmentStatus: FULFILLMENT_REQUESTED
    )
  - only requestStatus SUBMITTED is accepted
  - retries after ACCEPTED are idempotent
*/
export async function POST(
    request: Request
) {
    try {
        if (!(await hasAdminSession())) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Unauthorized.",
                },
                { status: 401 }
            );
        }

        if (!isSameOriginAdminRequest(request)) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Invalid request origin.",
                },
                { status: 403 }
            );
        }

        const body = await request.json();

        const fulfillmentOrderId =
            normalizeFulfillmentOrderId(
                body?.fulfillmentOrderId
            );

        const confirm =
            body?.confirm === true;

        const message =
            typeof body?.message === "string"
                ? body.message.trim().slice(0, 1000)
                : "";

        const estimatedShippedAt =
            typeof body?.estimatedShippedAt ===
                "string" &&
                body.estimatedShippedAt.trim()
                ? body.estimatedShippedAt.trim()
                : null;

        if (!fulfillmentOrderId) {
            return fail(
                "A valid fulfillmentOrderId is required."
            );
        }

        if (!confirm) {
            return fail(
                "Explicit confirmation is required. Send confirm: true."
            );
        }

        const token = await getAccessToken();

        /*
          First check the live Fulfillment Order.
    
          This also makes a retry safe if the request
          was already accepted.
        */
        const liveData = await shopifyGraphQL(
            `
      query FulfillmentServiceAcceptSafetyCheck(
        $id: ID!
      ) {
        fulfillmentOrder(id: $id) {
          id
          status
          requestStatus

          assignedLocation {
            name
            location {
              id
            }
          }

          order {
            id
            name
            displayFinancialStatus
            displayFulfillmentStatus
          }

          lineItems(first: 100) {
            nodes {
              id
              remainingQuantity
            }
          }
        }
      }
      `,
            {
                id: fulfillmentOrderId,
            },
            token
        );

        const live =
            liveData?.fulfillmentOrder;

        if (!live) {
            return fail(
                "Shopify Fulfillment Order was not found.",
                404
            );
        }

        if (
            live.requestStatus === "ACCEPTED"
        ) {
            const now =
                new Date().toISOString();

            db.prepare(`
        UPDATE fulfillment_tasks
        SET
          fulfillment_order_status = ?,
          request_status = ?,
          status = ?,
          warning = ?,
          updated_at = ?
        WHERE fulfillment_order_id = ?
      `).run(
                live.status || "IN_PROGRESS",
                "ACCEPTED",
                "PROCESSING",
                `Fulfillment request accepted by ${live.assignedLocation?.name ||
                "the fulfillment service"
                }. Waiting for shipment completion.`,
                now,
                fulfillmentOrderId
            );

            return NextResponse.json({
                success: true,
                alreadyAccepted: true,
                action:
                    "ACCEPT_FULFILLMENT_REQUEST",
                fulfillmentOrder: {
                    id: live.id,
                    status: live.status,
                    requestStatus:
                        live.requestStatus,
                    assignedLocation:
                        live.assignedLocation?.name ||
                        null,
                },
                order: {
                    id: live.order?.id || null,
                    name:
                        live.order?.name || null,
                    financialStatus:
                        live.order
                            ?.displayFinancialStatus ||
                        null,
                    fulfillmentStatus:
                        live.order
                            ?.displayFulfillmentStatus ||
                        null,
                },
            });
        }

        if (
            live.requestStatus !== "SUBMITTED"
        ) {
            return fail(
                `Fulfillment request status is ${live.requestStatus}. Only SUBMITTED requests can be accepted.`,
                409
            );
        }

        if (live.status !== "OPEN") {
            return fail(
                `Fulfillment Order status is ${live.status}. Expected OPEN before acceptance.`,
                409
            );
        }

        const remainingQuantity =
            (
                live.lineItems?.nodes || []
            ).reduce(
                (
                    total: number,
                    item: any
                ) =>
                    total +
                    Number(
                        item.remainingQuantity || 0
                    ),
                0
            );

        if (remainingQuantity <= 0) {
            return fail(
                "No remaining quantity needs fulfillment.",
                409
            );
        }

        /*
          Critical ownership check:
    
          Only fulfillment orders assigned to a
          fulfillment-service location OWNED BY THIS APP
          appear in assignedFulfillmentOrders.
    
          This prevents this route from accidentally
          accepting a request assigned to another
          third-party service such as Snow City Warehouse.
        */
        const assignedData =
            await shopifyGraphQL(
                `
        query RequestedAssignedFulfillmentOrders {
          assignedFulfillmentOrders(
            first: 100,
            assignmentStatus: FULFILLMENT_REQUESTED
          ) {
            nodes {
              id
              status
              requestStatus

              assignedLocation {
                name
                location {
                  id
                }
              }

              order {
                id
                name
              }
            }
          }
        }
        `,
                {},
                token
            );

        const assignedOrders =
            assignedData
                ?.assignedFulfillmentOrders
                ?.nodes || [];

        const ownedRequest =
            assignedOrders.find(
                (item: any) =>
                    item.id ===
                    fulfillmentOrderId
            );

        if (!ownedRequest) {
            return fail(
                "This Fulfillment Order is not currently a FULFILLMENT_REQUESTED order assigned to a fulfillment-service location owned by this app.",
                409,
                {
                    fulfillmentOrderId,
                    assignedLocation:
                        live.assignedLocation?.name ||
                        null,
                }
            );
        }

        const mutationData =
            await shopifyGraphQL(
                `
        mutation AcceptFulfillmentRequest(
          $id: ID!,
          $message: String,
          $estimatedShippedAt: DateTime
        ) {
          fulfillmentOrderAcceptFulfillmentRequest(
            id: $id,
            message: $message,
            estimatedShippedAt: $estimatedShippedAt
          ) {
            fulfillmentOrder {
              id
              status
              requestStatus

              assignedLocation {
                name
                location {
                  id
                }
              }

              order {
                id
                name
                displayFinancialStatus
                displayFulfillmentStatus
              }
            }

            userErrors {
              field
              message
            }
          }
        }
        `,
                {
                    id: fulfillmentOrderId,
                    message: message || null,
                    estimatedShippedAt,
                },
                token
            );

        const mutationResult =
            mutationData
                ?.fulfillmentOrderAcceptFulfillmentRequest;

        const userErrors =
            mutationResult
                ?.userErrors || [];

        if (userErrors.length > 0) {
            return fail(
                "Shopify rejected the fulfillment-request acceptance.",
                409,
                {
                    userErrors,
                }
            );
        }

        const accepted =
            mutationResult
                ?.fulfillmentOrder;

        if (
            !accepted ||
            accepted.requestStatus !==
            "ACCEPTED"
        ) {
            throw new Error(
                "Shopify did not confirm requestStatus ACCEPTED."
            );
        }

        const now =
            new Date().toISOString();

        const localUpdate =
            db.prepare(`
        UPDATE fulfillment_tasks
        SET
          fulfillment_order_status = ?,
          request_status = ?,
          status = ?,
          warning = ?,
          updated_at = ?
        WHERE fulfillment_order_id = ?
      `).run(
                accepted.status ||
                "IN_PROGRESS",
                accepted.requestStatus,
                "PROCESSING",
                message
                    ? `Fulfillment request accepted by ${accepted
                        .assignedLocation
                        ?.name ||
                    "the fulfillment service"
                    }: ${message}`
                    : `Fulfillment request accepted by ${accepted
                        .assignedLocation
                        ?.name ||
                    "the fulfillment service"
                    }. Waiting for shipment completion.`,
                now,
                fulfillmentOrderId
            );

        /*
          We deliberately do NOT insert an agent event
          here. The Shopify
          fulfillment_request_accepted webhook is the
          authoritative event source and will create the
          activity event without us fabricating a second
          acceptance event.
        */

        return NextResponse.json({
            success: true,
            action:
                "ACCEPT_FULFILLMENT_REQUEST",
            localTaskUpdated:
                Number(localUpdate.changes) >
                0,
            remainingQuantity,
            fulfillmentOrder: {
                id: accepted.id,
                status: accepted.status,
                requestStatus:
                    accepted.requestStatus,
                assignedLocation:
                    accepted.assignedLocation
                        ?.name || null,
                locationId:
                    accepted.assignedLocation
                        ?.location?.id || null,
            },
            order: {
                id:
                    accepted.order?.id ||
                    live.order?.id ||
                    null,
                name:
                    accepted.order?.name ||
                    live.order?.name ||
                    null,
                financialStatus:
                    accepted.order
                        ?.displayFinancialStatus ||
                    live.order
                        ?.displayFinancialStatus ||
                    null,
                fulfillmentStatus:
                    accepted.order
                        ?.displayFulfillmentStatus ||
                    live.order
                        ?.displayFulfillmentStatus ||
                    null,
            },
            message:
                message || null,
            estimatedShippedAt,
        });
    } catch (error) {
        console.error(
            "AI Test Warehouse accept error:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not accept fulfillment request.",
            },
            {
                status: 500,
            }
        );
    }
}
