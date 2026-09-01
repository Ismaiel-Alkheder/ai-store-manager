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
  ========================================
  VERIFY SHOPIFY WEBHOOK
  ========================================
*/

function verifyShopifyWebhook(
    rawBody: Buffer,
    hmacHeader: string,
    secret: string
) {
    const calculated = createHmac(
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
  ========================================
  SHOPIFY ACCESS TOKEN
  ========================================
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
                method:
                    "POST",

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
  ========================================
  SHOPIFY GRAPHQL
  ========================================
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
                method:
                    "POST",

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
  ========================================
  CREATE / UPDATE FULFILLMENT TASKS
  ========================================

  Called automatically after orders/paid.

  This function DOES NOT fulfill
  anything.

  It only creates a local task.
*/

async function prepareFulfillmentTasks(
    numericOrderId: string
) {
    const token =
        await getAccessToken();

    const orderGid =
        `gid://shopify/Order/${numericOrderId}`;

    const query = `
    query PrepareFulfillmentTask(
      $orderId: ID!
    ) {
      order(
        id: $orderId
      ) {
        id
        name

        displayFinancialStatus
        displayFulfillmentStatus

        fulfillmentOrders(
          first: 50
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
      }
    }
  `;

    const data =
        await shopifyGraphQL(
            query,

            {
                orderId:
                    orderGid,
            },

            token
        );

    const order =
        data?.order;

    if (!order) {
        throw new Error(
            "Order not found while preparing fulfillment task."
        );
    }

    const fulfillmentOrders =
        order
            .fulfillmentOrders
            ?.nodes || [];

    const now =
        new Date().toISOString();

    let createdCount = 0;
    let updatedCount = 0;

    /*
      One Shopify order can technically
      have more than one fulfillment order,
      for example across multiple locations.
    */

    for (
        const fulfillmentOrder
        of fulfillmentOrders
    ) {
        const allLineItems =
            fulfillmentOrder
                .lineItems
                ?.nodes || [];

        /*
          Only include quantities that
          Shopify currently says remain.
        */

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
                    Number(
                        item.remainingQuantity ||
                        0
                    ),
                0
            );

        /*
          No physical work remains.
        */

        if (
            remainingQuantity <=
            0
        ) {
            continue;
        }

        const fulfillmentOrderId =
            fulfillmentOrder.id;

        const fulfillmentNumber =
            fulfillmentOrderId
                .split("/")
                .pop();

        const taskId =
            `fulfillment-task-${fulfillmentNumber}`;

        /*
          ==================================
          APPROVAL + SAFETY GATE
          ==================================

          Normal flow:

            PENDING approval
                -> WAITING_APPROVAL

            APPROVED approval
                -> READY_TO_FULFILL

            REJECTED / CANCELLED
                -> REVIEW_REQUIRED

          Financial / Shopify safety checks
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
                `Order financial status is ${order.displayFinancialStatus}. Review the order before fulfillment.`;

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

        /*
          Check whether this Shopify
          Fulfillment Order already has
          a local task.
    
          fulfillment_order_id is UNIQUE.
        */

        const existing =
            db.prepare(`
        SELECT *
        FROM fulfillment_tasks
        WHERE fulfillment_order_id = ?
        LIMIT 1
      `).get(
                fulfillmentOrderId
            ) as any;

        /*
          ==================================
          CREATE NEW TASK
          ==================================
        */

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

                fulfillmentOrderId,

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

            createdCount++;

            /*
              Add the automatic task creation
              to our Agent Activity Log.
            */

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
                `fulfillment-task-created:${taskId}`,

                "SHOPIFY",

                "FULFILLMENT_TASK_CREATED",

                "ORDER",

                numericOrderId,

                "Fulfillment task created automatically",

                `${order.name} has ${remainingQuantity} unit(s) awaiting fulfillment approval/review.`,

                taskStatus,

                JSON.stringify({
                    taskId,

                    orderName:
                        order.name,

                    fulfillmentOrderId,

                    remainingQuantity,

                    financialStatus:
                        order
                            .displayFinancialStatus,

                    locationName:
                        fulfillmentOrder
                            .assignedLocation
                            ?.name ||
                        "Unknown location",

                    createdAutomatically:
                        true,
                }),

                now
            );

            console.log(
                "Automatic fulfillment task created:",
                order.name,
                taskId
            );

            continue;
        }

        /*
          ==================================
          UPDATE EXISTING TASK
          ==================================

          Never overwrite:
            COMPLETED
            PROCESSING

          Also preserve a REVIEW_REQUIRED
          state created by an uncertain
          fulfillment attempt. That state
          requires a person to inspect Shopify
          before any retry is allowed.
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
            existing.status !==
            "COMPLETED" &&
            existing.status !==
            "PROCESSING" &&
            !protectedReview
        ) {
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

                fulfillmentOrderId
            );

            updatedCount++;

            console.log(
                "Automatic fulfillment task updated:",
                order.name,
                existing.id,
                taskStatus
            );
        }
    }

    return {
        createdCount,
        updatedCount,
        fulfillmentOrderCount:
            fulfillmentOrders.length,
    };
}

/*
  ========================================
  WEBHOOK POST
  ========================================
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

        /*
          IMPORTANT:
          Shopify HMAC verification requires
          the original raw request body.
        */

        const rawBody =
            Buffer.from(
                await request.arrayBuffer()
            );

        const hmac =
            request.headers.get(
                "x-shopify-hmac-sha256"
            );

        const webhookId =
            request.headers.get(
                "x-shopify-webhook-id"
            );

        const topic =
            request.headers.get(
                "x-shopify-topic"
            );

        /*
          ==================================
          VERIFY SIGNATURE
          ==================================
        */

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

        if (!webhookId) {
            return NextResponse.json(
                {
                    error:
                        "Webhook ID missing",
                },
                {
                    status: 400,
                }
            );
        }

        const order =
            JSON.parse(
                rawBody.toString(
                    "utf8"
                )
            );

        const numericOrderId =
            String(
                order.id
            );

        const createdAt =
            new Date().toISOString();

        /*
          Shopify typically returns null for
          an entirely unfulfilled order.
    
          We support both null and a possible
          "unfulfilled" value defensively.
        */

        const isUnfulfilled =
            !order.fulfillment_status ||
            order.fulfillment_status ===
            "unfulfilled";

        /*
          ==================================
          DUPLICATE CHECK
          ==================================
    
          We do NOT immediately return here.
    
          If a previous attempt saved the
          activity but failed before creating
          the fulfillment task, a Shopify
          retry must still be allowed to
          repair that missing task.
        */

        const duplicateWebhook =
            db.prepare(`
        SELECT webhook_id
        FROM activity
        WHERE webhook_id = ?
        LIMIT 1
      `).get(
                webhookId
            );

        let type =
            "ORDER_EVENT";

        if (
            topic ===
            "orders/create"
        ) {
            type =
                "NEW_ORDER";
        }

        if (
            topic ===
            "orders/paid"
        ) {
            type =
                "NEEDS_FULFILLMENT";
        }

        /*
          ==================================
          STORE ACTIVITY ONCE
          ==================================
        */

        if (!duplicateWebhook) {
            db.prepare(`
        INSERT INTO activity (
          webhook_id,

          type,

          order_name,
          order_id,

          total,
          currency,

          payment_status,
          fulfillment_status,

          created_at
        )

        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
                webhookId,

                type,

                order.name,

                numericOrderId,

                order.total_price,

                order.currency,

                order.financial_status ||
                "unknown",

                order.fulfillment_status ||
                "unfulfilled",

                createdAt
            );

            console.log(
                "Saved webhook to SQLite:",
                topic,
                type,
                order.name
            );
        } else {
            console.log(
                "Duplicate webhook detected:",
                webhookId,
                topic,
                order.name
            );
        }

        /*
          ==================================
          ORDERS_PAID APPROVAL
          ==================================
    
          Preserve your existing
          REVIEW_FULFILLMENT approval.
        */

        if (
            topic ===
            "orders/paid" &&
            isUnfulfilled
        ) {
            const existingApproval =
                db.prepare(`
          SELECT id
          FROM approvals

          WHERE order_id = ?

          AND action = ?

          LIMIT 1
        `).get(
                    numericOrderId,

                    "REVIEW_FULFILLMENT"
                );

            if (!existingApproval) {
                db.prepare(`
          INSERT INTO approvals (
            id,

            action,

            order_name,
            order_id,

            reason,

            status,

            created_at,
            decided_at
          )

          VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?
          )
        `).run(
                    `order-${numericOrderId}-fulfillment`,

                    "REVIEW_FULFILLMENT",

                    order.name,

                    numericOrderId,

                    "This order is paid but has not been fulfilled.",

                    "PENDING",

                    createdAt,

                    null
                );

                console.log(
                    "Approval created:",
                    order.name
                );
            }

            /*
              ==================================
              AUTOMATIC FULFILLMENT TASK
              ==================================
      
              This replaces the manual:
      
              curl POST /api/fulfillment-tasks
            */

            const taskResult =
                await prepareFulfillmentTasks(
                    numericOrderId
                );

            console.log(
                "Fulfillment task preparation:",
                order.name,
                taskResult
            );

            return NextResponse.json({
                received:
                    true,

                duplicate:
                    Boolean(
                        duplicateWebhook
                    ),

                topic,

                type,

                order:
                    order.name,

                fulfillmentTasks: {
                    automatic:
                        true,

                    created:
                        taskResult.createdCount,

                    updated:
                        taskResult.updatedCount,

                    fulfillmentOrders:
                        taskResult
                            .fulfillmentOrderCount,
                },
            });
        }

        /*
          Other order events.
        */

        return NextResponse.json({
            received:
                true,

            duplicate:
                Boolean(
                    duplicateWebhook
                ),

            topic,

            type,

            order:
                order.name,

            fulfillmentTasks: {
                automatic:
                    false,
            },
        });
    } catch (error) {
        console.error(
            "Webhook processing error:",
            error
        );

        /*
          Returning 500 allows Shopify to
          retry the webhook.
    
          Our database operations above are
          idempotent, so a retry will not
          create duplicate approvals/tasks.
        */

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Webhook failed",
            },
            {
                status: 500,
            }
        );
    }
}