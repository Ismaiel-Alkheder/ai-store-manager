import {
    NextRequest,
    NextResponse,
} from "next/server";

import db from "@/lib/database";

import {
    ensureFulfillmentSchema,
} from "@/lib/fulfillment-schema";

import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

export const runtime = "nodejs";

ensureFulfillmentSchema(db);

/*
  SHOPIFY ACCESS TOKEN
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

    const response = await fetch(
        `https://${shop}.myshopify.com/admin/oauth/access_token`,
        {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/x-www-form-urlencoded",
            },

            body: new URLSearchParams({
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
    >
) {
    const shop =
        process.env.SHOPIFY_SHOP;

    if (!shop) {
        throw new Error(
            "SHOPIFY_SHOP missing"
        );
    }

    const token =
        await getAccessToken();

    const response = await fetch(
        `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
        {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/json",

                "X-Shopify-Access-Token":
                    token,
            },

            body: JSON.stringify({
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
  FORMAT SQLITE TASK
*/

function formatTask(
    row: any
) {
    let lineItems: any[] = [];

    try {
        lineItems =
            JSON.parse(
                row.line_items_json
            );
    } catch {
        lineItems = [];
    }

    return {
        id:
            row.id,

        orderId:
            row.order_id,

        orderGid:
            row.order_gid,

        orderName:
            row.order_name,

        fulfillmentOrderId:
            row.fulfillment_order_id,

        locationId:
            row.location_id,

        locationName:
            row.location_name,

        financialStatus:
            row.financial_status,

        orderFulfillmentStatus:
            row.order_fulfillment_status,

        fulfillmentOrderStatus:
            row.fulfillment_order_status,

        requestStatus:
            row.request_status,

        remainingQuantity:
            row.remaining_quantity,

        lineItems,

        status:
            row.status,

        warning:
            row.warning,

        createdAt:
            row.created_at,

        updatedAt:
            row.updated_at,

        completedAt:
            row.completed_at,

        shopifyFulfillmentId:
            row.shopify_fulfillment_id,
    };
}

/*
  GET SAVED FULFILLMENT TASKS
*/

export async function GET(
    request: NextRequest
) {
    try {
        if (!(await hasAdminSession())) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Unauthorized.",
                },
                {
                    status: 401,
                }
            );
        }

        const orderId =
            request.nextUrl.searchParams.get(
                "orderId"
            );

        let rows: any[];

        if (orderId) {
            rows =
                db.prepare(`
          SELECT *
          FROM fulfillment_tasks
          WHERE order_id = ?
          ORDER BY created_at DESC
        `).all(
                    orderId
                ) as any[];
        } else {
            rows =
                db.prepare(`
          SELECT *
          FROM fulfillment_tasks
          ORDER BY created_at DESC
        `).all() as any[];
        }

        return NextResponse.json({
            source:
                "sqlite",

            tasks:
                rows.map(
                    formatTask
                ),
        });
    } catch (error) {
        console.error(
            "Fulfillment tasks GET error:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not read fulfillment tasks.",

                tasks: [],
            },
            {
                status: 500,
            }
        );
    }
}

/*
  POST = PREPARE FULFILLMENT TASKS

  This DOES NOT fulfill anything.

  Example body:

  {
    "orderId": "7640037523765"
  }
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
                {
                    status: 401,
                }
            );
        }

        if (!isSameOriginAdminRequest(request)) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Invalid request origin.",
                },
                {
                    status: 403,
                }
            );
        }

        const body =
            await request.json();

        const suppliedOrderId =
            String(
                body.orderId || ""
            );

        if (!suppliedOrderId) {
            return NextResponse.json(
                {
                    error:
                        "orderId is required.",
                },
                {
                    status: 400,
                }
            );
        }

        const orderGid =
            suppliedOrderId.startsWith(
                "gid://shopify/Order/"
            )
                ? suppliedOrderId
                : `gid://shopify/Order/${suppliedOrderId}`;

        const numericOrderId =
            orderGid.split(
                "/"
            ).pop() || suppliedOrderId;

        /*
          Read current fulfillment state
          directly from Shopify.
    
          We intentionally avoid customer
          personal information.
        */

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
                }
            );

        const order =
            data?.order;

        if (!order) {
            return NextResponse.json(
                {
                    error:
                        "Order not found.",
                },
                {
                    status: 404,
                }
            );
        }

        const fulfillmentOrders =
            order
                .fulfillmentOrders
                ?.nodes || [];

        const now =
            new Date().toISOString();

        const preparedTasks:
            any[] = [];

        let createdCount = 0;
        let updatedCount = 0;

        for (
            const fulfillmentOrder
            of fulfillmentOrders
        ) {
            const allLineItems =
                fulfillmentOrder
                    .lineItems
                    ?.nodes || [];

            /*
              Only save quantities that
              Shopify currently says remain
              to be fulfilled.
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
                        item.remainingQuantity,
                    0
                );

            /*
              No task needed when nothing
              remains to fulfill.
            */

            if (
                remainingQuantity <= 0
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
              Financial safety guard.
      
              PAID orders can be marked
              READY_TO_FULFILL.
      
              Anything else requires human
              review before we allow the
              actual fulfillment mutation.
            */

            let taskStatus =
                "READY_TO_FULFILL";

            let warning:
                string | null = null;

            if (
                order.displayFinancialStatus !==
                "PAID"
            ) {
                taskStatus =
                    "REVIEW_REQUIRED";

                warning =
                    `Order financial status is ${order.displayFinancialStatus}. ` +
                    `Review the order before fulfillment.`;
            }

            /*
              Also guard unexpected
              fulfillment-order states.
            */

            if (
                fulfillmentOrder.status !==
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

            const existing:
                any = db
                    .prepare(`
          SELECT *
          FROM fulfillment_tasks
          WHERE fulfillment_order_id = ?
          LIMIT 1
        `)
                    .get(
                        fulfillmentOrderId
                    );

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
            ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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

                    order.displayFinancialStatus,
                    order.displayFulfillmentStatus,

                    fulfillmentOrder.status,
                    fulfillmentOrder.requestStatus,

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
                  Add task creation to our
                  unified Agent Activity Log.
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

                    "TASK",

                    "FULFILLMENT_TASK_CREATED",

                    "ORDER",

                    numericOrderId,

                    "Fulfillment task prepared",

                    `${order.name} - ${remainingQuantity} unit(s) remaining to fulfill.`,

                    taskStatus,

                    JSON.stringify({
                        taskId,

                        orderName:
                            order.name,

                        fulfillmentOrderId,

                        remainingQuantity,

                        financialStatus:
                            order.displayFinancialStatus,

                        locationName:
                            fulfillmentOrder
                                .assignedLocation
                                ?.name ||
                            "Unknown location",
                    }),

                    now
                );
            } else if (
                existing.status !==
                "COMPLETED"
            ) {
                /*
                  Refresh the task with the
                  latest Shopify state.
                */

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

                    order.displayFinancialStatus,
                    order.displayFulfillmentStatus,

                    fulfillmentOrder.status,
                    fulfillmentOrder.requestStatus,

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
            }

            const saved:
                any = db
                    .prepare(`
          SELECT *
          FROM fulfillment_tasks
          WHERE fulfillment_order_id = ?
        `)
                    .get(
                        fulfillmentOrderId
                    );

            preparedTasks.push(
                formatTask(saved)
            );
        }

        return NextResponse.json({
            success:
                true,

            previewOnly:
                true,

            noFulfillmentCreated:
                true,

            order: {
                id:
                    order.id,

                name:
                    order.name,

                financialStatus:
                    order.displayFinancialStatus,

                fulfillmentStatus:
                    order.displayFulfillmentStatus,
            },

            createdCount,
            updatedCount,

            tasks:
                preparedTasks,
        });
    } catch (error) {
        console.error(
            "Prepare fulfillment task error:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not prepare fulfillment task.",
            },
            {
                status: 500,
            }
        );
    }
}