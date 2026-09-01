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
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
    if (!shop) throw new Error("SHOPIFY_SHOP missing.");

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

    if (result.errors) throw new Error(JSON.stringify(result.errors));
    return result.data;
}

function fail(
    error: string,
    status = 400,
    extra: Record<string, unknown> = {}
) {
    return NextResponse.json({ success: false, error, ...extra }, { status });
}

function normalizeFulfillmentOrderId(value: unknown) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    if (raw.startsWith("gid://shopify/FulfillmentOrder/")) return raw;
    if (/^\d+$/.test(raw)) return `gid://shopify/FulfillmentOrder/${raw}`;
    return null;
}

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
        const message =
            typeof body?.message === "string" && body.message.trim()
                ? body.message.trim().slice(0, 1000)
                : "Rejected by AI Test Warehouse";

        if (!fulfillmentOrderId) {
            return fail("A valid fulfillmentOrderId is required.");
        }

        if (!confirm) {
            return fail("Explicit confirmation is required. Send confirm: true.");
        }

        const token = await getAccessToken();

        const liveData = await shopifyGraphQL(
            `
      query RejectSafetyCheck($id: ID!) {
        fulfillmentOrder(id: $id) {
          id
          status
          requestStatus
          assignedLocation {
            name
            location { id }
          }
          order {
            id
            name
            displayFinancialStatus
            displayFulfillmentStatus
          }
          lineItems(first: 100) {
            nodes { id remainingQuantity }
          }
        }
      }
      `,
            { id: fulfillmentOrderId },
            token
        );

        const live = liveData?.fulfillmentOrder;
        if (!live) return fail("Shopify Fulfillment Order was not found.", 404);

        if (live.requestStatus === "REJECTED") {
            const now = new Date().toISOString();
            db.prepare(`
        UPDATE fulfillment_tasks
        SET
          fulfillment_order_status = ?,
          request_status = 'REJECTED',
          status = 'REVIEW_REQUIRED',
          warning = ?,
          updated_at = ?
        WHERE fulfillment_order_id = ?
      `).run(
                live.status || "OPEN",
                `Fulfillment request rejected by ${live.assignedLocation?.name || "the fulfillment service"
                }. Merchant review or rerouting is required.`,
                now,
                fulfillmentOrderId
            );

            return NextResponse.json({
                success: true,
                alreadyRejected: true,
                action: "REJECT_FULFILLMENT_REQUEST",
                fulfillmentOrder: {
                    id: live.id,
                    status: live.status,
                    requestStatus: live.requestStatus,
                    assignedLocation: live.assignedLocation?.name || null,
                },
            });
        }

        if (live.requestStatus !== "SUBMITTED") {
            return fail(
                `Fulfillment request status is ${live.requestStatus}. Only SUBMITTED requests can be rejected.`,
                409
            );
        }

        if (live.status !== "OPEN") {
            return fail(
                `Fulfillment Order status is ${live.status}. Expected OPEN before rejection.`,
                409
            );
        }

        const remainingQuantity = (live.lineItems?.nodes || []).reduce(
            (total: number, item: any) =>
                total + Number(item?.remainingQuantity || 0),
            0
        );

        if (remainingQuantity <= 0) {
            return fail("No remaining quantity needs fulfillment.", 409);
        }

        const assignedData = await shopifyGraphQL(
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
              location { id }
            }
          }
        }
      }
      `,
            {},
            token
        );

        const ownedRequest = (
            assignedData?.assignedFulfillmentOrders?.nodes || []
        ).find((item: any) => item.id === fulfillmentOrderId);

        if (!ownedRequest) {
            return fail(
                "This Fulfillment Order is not a FULFILLMENT_REQUESTED order assigned to a fulfillment-service location owned by this app.",
                409,
                {
                    fulfillmentOrderId,
                    assignedLocation: live.assignedLocation?.name || null,
                }
            );
        }

        const mutationData = await shopifyGraphQL(
            `
      mutation RejectFulfillmentRequest($id: ID!, $message: String) {
        fulfillmentOrderRejectFulfillmentRequest(
          id: $id,
          message: $message
        ) {
          fulfillmentOrder {
            id
            status
            requestStatus
            assignedLocation {
              name
              location { id }
            }
            order {
              id
              name
              displayFinancialStatus
              displayFulfillmentStatus
            }
          }
          userErrors { field message }
        }
      }
      `,
            { id: fulfillmentOrderId, message },
            token
        );

        const result = mutationData?.fulfillmentOrderRejectFulfillmentRequest;
        const userErrors = result?.userErrors || [];

        if (userErrors.length > 0) {
            return fail(
                "Shopify rejected the fulfillment-request rejection.",
                409,
                { userErrors }
            );
        }

        const rejected = result?.fulfillmentOrder;
        if (!rejected || rejected.requestStatus !== "REJECTED") {
            throw new Error("Shopify did not confirm requestStatus REJECTED.");
        }

        const now = new Date().toISOString();
        const localUpdate = db.prepare(`
      UPDATE fulfillment_tasks
      SET
        fulfillment_order_status = ?,
        request_status = 'REJECTED',
        status = 'REVIEW_REQUIRED',
        warning = ?,
        updated_at = ?
      WHERE fulfillment_order_id = ?
    `).run(
            rejected.status || live.status || "OPEN",
            `Fulfillment request rejected by ${rejected.assignedLocation?.name || "AI Test Warehouse"
            }: ${message}`,
            now,
            fulfillmentOrderId
        );

        return NextResponse.json({
            success: true,
            action: "REJECT_FULFILLMENT_REQUEST",
            localTaskUpdated: Number(localUpdate.changes) > 0,
            remainingQuantity,
            fulfillmentOrder: {
                id: rejected.id,
                status: rejected.status,
                requestStatus: rejected.requestStatus,
                assignedLocation: rejected.assignedLocation?.name || null,
                locationId: rejected.assignedLocation?.location?.id || null,
            },
            order: {
                id: rejected.order?.id || live.order?.id || null,
                name: rejected.order?.name || live.order?.name || null,
                financialStatus:
                    rejected.order?.displayFinancialStatus ||
                    live.order?.displayFinancialStatus ||
                    null,
                fulfillmentStatus:
                    rejected.order?.displayFulfillmentStatus ||
                    live.order?.displayFulfillmentStatus ||
                    null,
            },
            message,
        });
    } catch (error) {
        console.error("AI Test Warehouse reject error:", error);

        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not reject fulfillment request.",
            },
            { status: 500 }
        );
    }
}
