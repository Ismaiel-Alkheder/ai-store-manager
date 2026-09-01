import {
    createHmac,
    timingSafeEqual,
} from "crypto";

import {
    NextResponse,
} from "next/server";

import db from "@/lib/database";

import {
    ensureFulfillmentSchema,
} from "@/lib/fulfillment-schema";

export const runtime = "nodejs";

ensureFulfillmentSchema(db);

/*
  VERIFY SHOPIFY WEBHOOK
*/

function verifyShopifyWebhook(
    rawBody: Buffer,
    hmacHeader: string,
    secret: string
) {
    const calculated =
        createHmac(
            "sha256",
            secret
        )
            .update(rawBody)
            .digest("base64");

    const received =
        Buffer.from(hmacHeader);

    const expected =
        Buffer.from(calculated);

    if (
        received.length !==
        expected.length
    ) {
        return false;
    }

    return timingSafeEqual(
        received,
        expected
    );
}

/*
  GET SHOPIFY ACCESS TOKEN
*/

async function getAccessToken() {
    const shop =
        process.env.SHOPIFY_SHOP;

    const clientId =
        process.env.SHOPIFY_CLIENT_ID;

    const clientSecret =
        process.env.SHOPIFY_CLIENT_SECRET;

    if (
        !shop ||
        !clientId ||
        !clientSecret
    ) {
        throw new Error(
            "Missing Shopify environment variables"
        );
    }

    const response =
        await fetch(
            `https://${shop}.myshopify.com/admin/oauth/access_token`,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded",
                },

                body:
                    new URLSearchParams({
                        grant_type:
                            "client_credentials",

                        client_id:
                            clientId,

                        client_secret:
                            clientSecret,
                    }),
            }
        );

    if (!response.ok) {
        throw new Error(
            "Could not get Shopify access token"
        );
    }

    const data =
        await response.json();

    return data.access_token;
}

/*
  SHOPIFY GRAPHQL
*/

async function shopifyGraphQL(
    query: string,

    variables: Record<
        string,
        unknown
    >,

    token: string
) {
    const shop =
        process.env.SHOPIFY_SHOP;

    if (!shop) {
        throw new Error(
            "SHOPIFY_SHOP missing"
        );
    }

    const response =
        await fetch(
            `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json",

                    "X-Shopify-Access-Token":
                        token,
                },

                body:
                    JSON.stringify({
                        query,
                        variables,
                    }),
            }
        );

    const result =
        await response.json();

    if (!response.ok) {
        throw new Error(
            `Shopify request failed: ${response.status}`
        );
    }

    if (result.errors) {
        throw new Error(
            JSON.stringify(
                result.errors
            )
        );
    }

    return result.data;
}

/*
  WEBHOOK

  fulfillment_orders/
  order_routing_complete
*/

export async function POST(
    request: Request
) {
    try {
        const secret =
            process.env
                .SHOPIFY_CLIENT_SECRET;

        if (!secret) {
            return NextResponse.json(
                {
                    error:
                        "SHOPIFY_CLIENT_SECRET missing",
                },
                {
                    status: 500,
                }
            );
        }

        const rawBody =
            Buffer.from(
                await request.arrayBuffer()
            );

        const hmac =
            request.headers.get(
                "x-shopify-hmac-sha256"
            );

        const topic =
            request.headers.get(
                "x-shopify-topic"
            );

        const webhookId =
            request.headers.get(
                "x-shopify-webhook-id"
            );

        if (
            !hmac ||
            !verifyShopifyWebhook(
                rawBody,
                hmac,
                secret
            )
        ) {
            return NextResponse.json(
                {
                    error:
                        "Invalid webhook signature",
                },
                {
                    status: 401,
                }
            );
        }

        const payload =
            JSON.parse(
                rawBody.toString(
                    "utf8"
                )
            );

        const suppliedId =
            payload
                ?.fulfillment_order
                ?.id;

        if (!suppliedId) {
            return NextResponse.json(
                {
                    error:
                        "Fulfillment Order ID missing",
                },
                {
                    status: 400,
                }
            );
        }

        /*
          Shopify normally supplies
          a GID here.
    
          We also support numeric IDs
          defensively.
        */

        const fulfillmentOrderId =
            String(
                suppliedId
            ).startsWith(
                "gid://shopify/FulfillmentOrder/"
            )
                ? String(
                    suppliedId
                )
                : `gid://shopify/FulfillmentOrder/${suppliedId}`;

        const token =
            await getAccessToken();

        /*
          At order_routing_complete,
          Shopify says routing is complete
          and the Fulfillment Order exists.
    
          Read that exact Fulfillment Order.
        */

        const query = `
      query RoutingComplete(
        $id: ID!
      ) {
        fulfillmentOrder(
          id: $id
        ) {
          id

          status
          requestStatus

          orderId
          orderName

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

          lineItems(
            first: 100
          ) {
            nodes {
              id

              totalQuantity
              remainingQuantity

              inventoryItemId

              productTitle
              variantTitle
              sku
              requiresShipping
            }
          }
        }
      }
    `;

        const data =
            await shopifyGraphQL(
                query,

                {
                    id:
                        fulfillmentOrderId,
                },

                token
            );

        const fulfillmentOrder =
            data
                ?.fulfillmentOrder;

        if (!fulfillmentOrder) {
            throw new Error(
                "Fulfillment Order was not found after routing."
            );
        }

        const order =
            fulfillmentOrder
                .order;

        if (!order) {
            throw new Error(
                "Order was not found for Fulfillment Order."
            );
        }

        const numericOrderId =
            String(
                order.id
            )
                .split("/")
                .pop() ||
            String(
                fulfillmentOrder
                    .orderId
            );

        const allLineItems =
            fulfillmentOrder
                .lineItems
                ?.nodes || [];

        const remainingLineItems =
            allLineItems
                .filter(
                    (item: any) =>
                        Number(
                            item.remainingQuantity
                        ) > 0
                )
                .map(
                    (item: any) => ({
                        fulfillmentOrderLineItemId:
                            item.id,

                        productTitle:
                            item.productTitle,

                        variantTitle:
                            item.variantTitle ||
                            "Default Title",

                        sku:
                            item.sku ||
                            "No SKU",

                        inventoryItemId:
                            item.inventoryItemId,

                        totalQuantity:
                            Number(
                                item.totalQuantity ||
                                0
                            ),

                        remainingQuantity:
                            Number(
                                item.remainingQuantity ||
                                0
                            ),

                        requiresShipping:
                            Boolean(
                                item.requiresShipping
                            ),
                    })
                );

        const remainingQuantity =
            remainingLineItems.reduce(
                (
                    total: number,
                    item: any
                ) =>
                    total +
                    item.remainingQuantity,
                0
            );

        /*
          Nothing needs fulfillment.
        */

        if (
            remainingQuantity <=
            0
        ) {
            return NextResponse.json({
                received:
                    true,

                topic,

                webhookId,

                fulfillmentOrderId,

                taskCreated:
                    false,

                reason:
                    "No remaining quantity.",
            });
        }

        /*
          APPROVAL + SAFETY GATE

          Normal flow:

            PENDING approval
                -> WAITING_APPROVAL

            APPROVED approval
                -> READY_TO_FULFILL

            REJECTED / CANCELLED
                -> REVIEW_REQUIRED

          Financial and Shopify safety checks
          always override the approval state.
        */

        const approval =
            db.prepare(`
        SELECT status
        FROM approvals
        WHERE order_id = ?
        AND action = ?
        LIMIT 1
      `).get(
                numericOrderId,
                "REVIEW_FULFILLMENT"
            ) as any;

        const approvalStatus =
            approval?.status || null;

        let taskStatus =
            approvalStatus === "APPROVED"
                ? "READY_TO_FULFILL"
                : "WAITING_APPROVAL";

        let warning:
            string | null = null;

        if (
            approvalStatus ===
            "REJECTED" ||
            approvalStatus ===
            "CANCELLED"
        ) {
            taskStatus =
                "REVIEW_REQUIRED";

            warning =
                `Fulfillment approval is ${approvalStatus}.`;
        }

        if (
            order
                .displayFinancialStatus !==
            "PAID"
        ) {
            taskStatus =
                "REVIEW_REQUIRED";

            const financialWarning =
                `Order financial status is ${order.displayFinancialStatus}. Review before fulfillment.`;

            warning =
                warning
                    ? `${warning} ${financialWarning}`
                    : financialWarning;
        }

        if (
            fulfillmentOrder
                .status !==
            "OPEN"
        ) {
            taskStatus =
                "REVIEW_REQUIRED";

            const statusWarning =
                `Fulfillment order status is ${fulfillmentOrder.status}.`;

            warning =
                warning
                    ? `${warning} ${statusWarning}`
                    : statusWarning;
        }

        const fulfillmentNumber =
            fulfillmentOrder.id
                .split("/")
                .pop();

        const taskId =
            `fulfillment-task-${fulfillmentNumber}`;

        const now =
            new Date().toISOString();

        /*
          Idempotency:
          Fulfillment Order ID is UNIQUE.
        */

        const existing =
            db.prepare(`
        SELECT *
        FROM fulfillment_tasks

        WHERE fulfillment_order_id = ?

        LIMIT 1
      `).get(
                fulfillmentOrder.id
            ) as any;

        let action:
            "CREATED" |
            "UPDATED" |
            "UNCHANGED";

        if (!existing) {
            db.prepare(`
        INSERT INTO fulfillment_tasks (
          id,

          order_id,
          order_gid,
          order_name,

          fulfillment_order_id,

          location_id,
          location_name,

          financial_status,
          order_fulfillment_status,

          fulfillment_order_status,
          request_status,

          remaining_quantity,

          line_items_json,

          status,

          warning,

          created_at,
          updated_at,

          completed_at,

          shopify_fulfillment_id
        )

        VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?
        )
      `).run(
                taskId,

                numericOrderId,

                order.id,

                order.name,

                fulfillmentOrder.id,

                fulfillmentOrder
                    .assignedLocation
                    ?.location
                    ?.id ||
                null,

                fulfillmentOrder
                    .assignedLocation
                    ?.name ||
                "Unknown location",

                order
                    .displayFinancialStatus,

                order
                    .displayFulfillmentStatus,

                fulfillmentOrder
                    .status,

                fulfillmentOrder
                    .requestStatus,

                remainingQuantity,

                JSON.stringify(
                    remainingLineItems
                ),

                taskStatus,

                warning,

                now,

                now,

                null,

                null
            );

            action =
                "CREATED";

            db.prepare(`
        INSERT OR IGNORE
        INTO agent_events (
          event_key,

          source,
          event_type,

          entity_type,
          entity_id,

          title,
          message,

          status,

          metadata_json,

          created_at
        )

        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
                `fulfillment-routing:${fulfillmentOrder.id}`,

                "SHOPIFY",

                "FULFILLMENT_TASK_CREATED",

                "ORDER",

                numericOrderId,

                "Fulfillment routing completed",

                `${order.name} has ${remainingQuantity} unit(s) awaiting fulfillment approval/review.`,

                taskStatus,

                JSON.stringify({
                    webhookId,

                    taskId,

                    orderName:
                        order.name,

                    fulfillmentOrderId:
                        fulfillmentOrder.id,

                    remainingQuantity,

                    financialStatus:
                        order
                            .displayFinancialStatus,

                    locationName:
                        fulfillmentOrder
                            .assignedLocation
                            ?.name ||
                        "Unknown location",
                }),

                now
            );
        } else {
            /*
              Preserve terminal / sensitive states.

              Never overwrite:
                COMPLETED
                PROCESSING

              Also preserve a REVIEW_REQUIRED
              state created by an uncertain
              fulfillment attempt.
            */

            const protectedReview =
                existing.status ===
                "REVIEW_REQUIRED" &&
                String(
                    existing.warning || ""
                ).startsWith(
                    "Fulfillment attempt requires review:"
                );

            if (
                existing.status ===
                "COMPLETED" ||
                existing.status ===
                "PROCESSING" ||
                protectedReview
            ) {
                action =
                    "UNCHANGED";
            } else {
                db.prepare(`
        UPDATE fulfillment_tasks

        SET
          order_name = ?,

          location_id = ?,
          location_name = ?,

          financial_status = ?,

          order_fulfillment_status = ?,

          fulfillment_order_status = ?,

          request_status = ?,

          remaining_quantity = ?,

          line_items_json = ?,

          status = ?,

          warning = ?,

          updated_at = ?

        WHERE fulfillment_order_id = ?
      `).run(
                    order.name,

                    fulfillmentOrder
                        .assignedLocation
                        ?.location
                        ?.id ||
                    null,

                    fulfillmentOrder
                        .assignedLocation
                        ?.name ||
                    "Unknown location",

                    order
                        .displayFinancialStatus,

                    order
                        .displayFulfillmentStatus,

                    fulfillmentOrder.status,

                    fulfillmentOrder
                        .requestStatus,

                    remainingQuantity,

                    JSON.stringify(
                        remainingLineItems
                    ),

                    taskStatus,

                    warning,

                    now,

                    fulfillmentOrder.id
                );

                action =
                    "UPDATED";
            }
        }

        console.log(
            "Fulfillment routing complete:",
            order.name,
            action,
            taskStatus,
            remainingQuantity
        );

        return NextResponse.json({
            received:
                true,

            topic,

            order:
                order.name,

            fulfillmentOrderId:
                fulfillmentOrder.id,

            action,

            status:
                taskStatus,

            remainingQuantity,
        });
    } catch (error) {
        console.error(
            "Fulfillment routing webhook error:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Fulfillment routing webhook failed",
            },
            {
                status: 500,
            }
        );
    }
}