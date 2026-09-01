import { NextResponse } from "next/server";

import db from "@/lib/database";
import { ensureFulfillmentSchema } from "@/lib/fulfillment-schema";
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
        throw new Error("Missing Shopify environment variables.");
    }

    const response = await fetch(
        `https://${shop}.myshopify.com/admin/oauth/access_token`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
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
            `Could not get Shopify access token: ${response.status} ${JSON.stringify(data)}`
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
            body: JSON.stringify({ query, variables }),
            cache: "no-store",
        }
    );

    const result = await response.json();

    if (!response.ok) {
        throw new Error(
            `Shopify request failed: ${response.status} ${JSON.stringify(result)}`
        );
    }

    if (result.errors) {
        throw new Error(JSON.stringify(result.errors));
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
        { status }
    );
}

function normalizeFulfillmentOrderId(value: unknown) {
    const raw = String(value || "").trim();

    if (!raw) {
        return null;
    }

    if (raw.startsWith("gid://shopify/FulfillmentOrder/")) {
        return raw;
    }

    if (/^\d+$/.test(raw)) {
        return `gid://shopify/FulfillmentOrder/${raw}`;
    }

    return null;
}

function sumRemaining(lineItems: any[]) {
    return (lineItems || []).reduce(
        (total: number, item: any) =>
            total + Number(item?.remainingQuantity || 0),
        0
    );
}

/*
  POST /api/fulfillment-service/ship

  Body:
  {
    "fulfillmentOrderId": "8725525791029",
    "confirm": true,
    "notifyCustomer": false,
    "message": "Shipped by AI Test Warehouse"
  }

  This route acts as OUR fulfillment service.

  Safety:
  - explicit confirm:true
  - live Shopify state check
  - request must already be ACCEPTED
  - Fulfillment Order must be assigned to a fulfillment-service
    location owned by this app (verified through assignedFulfillmentOrders
    with FULFILLMENT_ACCEPTED)
  - fulfills all remaining items in the Fulfillment Order
  - retries are idempotent once Shopify reports no remaining quantity
*/
export async function POST(request: Request) {
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

        const fulfillmentOrderId = normalizeFulfillmentOrderId(
            body?.fulfillmentOrderId
        );

        const confirm = body?.confirm === true;
        const notifyCustomer = body?.notifyCustomer === true;

        const message =
            typeof body?.message === "string"
                ? body.message.trim().slice(0, 1000)
                : "";

        if (!fulfillmentOrderId) {
            return fail("A valid fulfillmentOrderId is required.");
        }

        if (!confirm) {
            return fail(
                "Explicit confirmation is required. Send confirm: true."
            );
        }

        const token = await getAccessToken();

        const liveData = await shopifyGraphQL(
            `
      query FulfillmentServiceShipSafetyCheck($id: ID!) {
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
            { id: fulfillmentOrderId },
            token
        );

        const live = liveData?.fulfillmentOrder;

        if (!live) {
            return fail("Shopify Fulfillment Order was not found.", 404);
        }

        const remainingQuantity = sumRemaining(
            live.lineItems?.nodes || []
        );

        /*
          Idempotent retry after fulfillment is already complete.
        */
        if (
            remainingQuantity <= 0 ||
            live.status === "CLOSED"
        ) {
            const now = new Date().toISOString();

            db.prepare(`
        UPDATE fulfillment_tasks
        SET
          fulfillment_order_status = ?,
          request_status = ?,
          remaining_quantity = 0,
          status = 'COMPLETED',
          warning = NULL,
          completed_at = COALESCE(completed_at, ?),
          updated_at = ?
        WHERE fulfillment_order_id = ?
      `).run(
                live.status || "CLOSED",
                live.requestStatus || "ACCEPTED",
                now,
                now,
                fulfillmentOrderId
            );

            return NextResponse.json({
                success: true,
                alreadyCompleted: true,
                action: "CREATE_FULFILLMENT",
                fulfillmentOrder: {
                    id: live.id,
                    status: live.status,
                    requestStatus: live.requestStatus,
                    assignedLocation:
                        live.assignedLocation?.name || null,
                    remainingQuantity: 0,
                },
                order: {
                    id: live.order?.id || null,
                    name: live.order?.name || null,
                    financialStatus:
                        live.order?.displayFinancialStatus || null,
                    fulfillmentStatus:
                        live.order?.displayFulfillmentStatus || null,
                },
            });
        }

        if (live.requestStatus !== "ACCEPTED") {
            return fail(
                `Fulfillment request status is ${live.requestStatus}. The fulfillment service can ship only after the request is ACCEPTED.`,
                409
            );
        }

        if (
            live.status !== "IN_PROGRESS" &&
            live.status !== "OPEN"
        ) {
            return fail(
                `Fulfillment Order status is ${live.status}. Expected IN_PROGRESS or OPEN before fulfillment.`,
                409
            );
        }

        if (
            live.order?.displayFinancialStatus !== "PAID"
        ) {
            return fail(
                `Order financial status is ${live.order?.displayFinancialStatus}. Expected PAID.`,
                409
            );
        }

        /*
          Ownership check:
          FULFILLMENT_ACCEPTED returns accepted fulfillment requests
          assigned to fulfillment-service locations owned by this app.
        */
        const assignedData = await shopifyGraphQL(
            `
      query AcceptedAssignedFulfillmentOrders {
        assignedFulfillmentOrders(
          first: 100,
          assignmentStatus: FULFILLMENT_ACCEPTED
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
            assignedData?.assignedFulfillmentOrders?.nodes || [];

        const ownedAcceptedOrder = assignedOrders.find(
            (item: any) => item.id === fulfillmentOrderId
        );

        if (!ownedAcceptedOrder) {
            return fail(
                "This Fulfillment Order is not currently an accepted fulfillment request assigned to a fulfillment-service location owned by this app.",
                409,
                {
                    fulfillmentOrderId,
                    assignedLocation:
                        live.assignedLocation?.name || null,
                }
            );
        }

        /*
          Omitting fulfillmentOrderLineItems means:
          fulfill ALL remaining items in this Fulfillment Order.
        */
        const mutationData = await shopifyGraphQL(
            `
      mutation CreateFulfillment(
        $fulfillment: FulfillmentInput!,
        $message: String
      ) {
        fulfillmentCreate(
          fulfillment: $fulfillment,
          message: $message
        ) {
          fulfillment {
            id
          }

          userErrors {
            field
            message
          }
        }
      }
      `,
            {
                fulfillment: {
                    lineItemsByFulfillmentOrder: [
                        {
                            fulfillmentOrderId,
                        },
                    ],
                    notifyCustomer,
                },
                message: message || null,
            },
            token
        );

        const mutationResult =
            mutationData?.fulfillmentCreate;

        const userErrors =
            mutationResult?.userErrors || [];

        if (userErrors.length > 0) {
            return fail(
                "Shopify rejected fulfillmentCreate.",
                409,
                { userErrors }
            );
        }

        const fulfillmentId =
            mutationResult?.fulfillment?.id;

        if (!fulfillmentId) {
            throw new Error(
                "Shopify did not return a fulfillment ID."
            );
        }

        /*
          Read Shopify again after the mutation so the local state is
          based on Shopify's final state, not assumptions.
        */
        const afterData = await shopifyGraphQL(
            `
      query FulfillmentServiceShipResult($id: ID!) {
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
            { id: fulfillmentOrderId },
            token
        );

        const after = afterData?.fulfillmentOrder;

        if (!after) {
            throw new Error(
                "Could not read Fulfillment Order after fulfillmentCreate."
            );
        }

        const remainingAfter = sumRemaining(
            after.lineItems?.nodes || []
        );

        const completed =
            remainingAfter <= 0 ||
            after.status === "CLOSED";

        const now = new Date().toISOString();

        db.prepare(`
      UPDATE fulfillment_tasks
      SET
        fulfillment_order_status = ?,
        request_status = ?,
        order_fulfillment_status = ?,
        remaining_quantity = ?,
        status = ?,
        warning = ?,
        shopify_fulfillment_id = ?,
        completed_at = CASE
          WHEN ? = 1 THEN COALESCE(completed_at, ?)
          ELSE completed_at
        END,
        updated_at = ?
      WHERE fulfillment_order_id = ?
    `).run(
            after.status || live.status,
            after.requestStatus || live.requestStatus,
            after.order?.displayFulfillmentStatus ||
            live.order?.displayFulfillmentStatus ||
            null,
            remainingAfter,
            completed ? "COMPLETED" : "PROCESSING",
            completed
                ? null
                : "Shopify created the fulfillment, but remaining quantity is still greater than zero. Review before taking another action.",
            fulfillmentId,
            completed ? 1 : 0,
            now,
            now,
            fulfillmentOrderId
        );

        return NextResponse.json({
            success: true,
            action: "CREATE_FULFILLMENT",
            fulfillmentId,
            completed,
            notifyCustomer,
            message: message || null,
            fulfillmentOrder: {
                id: after.id,
                status: after.status,
                requestStatus: after.requestStatus,
                assignedLocation:
                    after.assignedLocation?.name || null,
                locationId:
                    after.assignedLocation?.location?.id || null,
                remainingQuantity: remainingAfter,
            },
            order: {
                id: after.order?.id || null,
                name: after.order?.name || null,
                financialStatus:
                    after.order?.displayFinancialStatus || null,
                fulfillmentStatus:
                    after.order?.displayFulfillmentStatus || null,
            },
        });
    } catch (error) {
        console.error(
            "AI Test Warehouse ship error:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not create fulfillment.",
            },
            { status: 500 }
        );
    }
}