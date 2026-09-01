import { NextResponse } from "next/server";
import db from "@/lib/database";
import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";
import {
    ensureFulfillmentSchema,
} from "@/lib/fulfillment-schema";

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
  ADD ORDER APPROVAL TAG
*/

async function addApprovalTag(
    orderId: number
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

    const mutation = `
    mutation AddTag(
      $id: ID!,
      $tags: [String!]!
    ) {
      tagsAdd(
        id: $id,
        tags: $tags
      ) {
        node {
          id
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

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
                query: mutation,

                variables: {
                    id:
                        `gid://shopify/Order/${orderId}`,

                    tags: [
                        "AI_APPROVED_FOR_FULFILLMENT",
                    ],
                },
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
            JSON.stringify(result.errors)
        );
    }

    const userErrors =
        result.data?.tagsAdd
            ?.userErrors || [];

    if (userErrors.length > 0) {
        throw new Error(
            userErrors
                .map(
                    (
                        item: {
                            message: string;
                        }
                    ) => item.message
                )
                .join(", ")
        );
    }
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
  ENSURE FULFILLMENT TASKS FOR
  AN APPROVED ORDER

  This is a recovery/reconciliation path.

  If a webhook was missed, approval can
  still read Shopify directly and create
  the missing fulfillment task.

  It does NOT fulfill the order.
*/

async function ensureApprovedFulfillmentTasks(
    orderId: number
) {
    const token =
        await getAccessToken();

    const orderGid =
        `gid://shopify/Order/${orderId}`;

    const query = `
      query ApprovedOrderFulfillment(
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
            "Order not found while reconciling fulfillment."
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
    let protectedCount = 0;

    for (
        const fulfillmentOrder
        of fulfillmentOrders
    ) {
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
                    Number(
                        item.remainingQuantity ||
                        0
                    ),
                0
            );

        /*
          If Shopify says nothing remains,
          there is no new task to create.
        */

        if (
            remainingQuantity <=
            0
        ) {
            continue;
        }

        /*
          Approval exists, but financial
          and fulfillment-order safety
          checks still override approval.
        */

        let taskStatus =
            "READY_TO_FULFILL";

        let warning:
            string | null = null;

        if (
            order
                .displayFinancialStatus !==
            "PAID"
        ) {
            taskStatus =
                "REVIEW_REQUIRED";

            warning =
                `Order financial status is ${order.displayFinancialStatus}. Review before fulfillment.`;
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

        const fulfillmentOrderId =
            fulfillmentOrder.id;

        const fulfillmentNumber =
            fulfillmentOrderId
                .split("/")
                .pop();

        const taskId =
            `fulfillment-task-${fulfillmentNumber}`;

        const existing =
            db.prepare(`
        SELECT *
        FROM fulfillment_tasks
        WHERE fulfillment_order_id = ?
        LIMIT 1
      `).get(
                fulfillmentOrderId
            ) as any;

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

                orderId,
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
                `fulfillment-approval-recovery:${taskId}`,

                "SHOPIFY",

                "FULFILLMENT_TASK_CREATED",

                "ORDER",

                String(
                    orderId
                ),

                "Fulfillment task recovered after approval",

                `${order.name} fulfillment task was created from Shopify during approval reconciliation.`,

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
                    recovery:
                        true,
                }),

                now
            );

            continue;
        }

        /*
          Never overwrite terminal/sensitive
          states during reconciliation.
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
            protectedCount++;
            continue;
        }

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
    }

    return {
        orderName:
            order.name,

        financialStatus:
            order
                .displayFinancialStatus,

        fulfillmentStatus:
            order
                .displayFulfillmentStatus,

        fulfillmentOrderCount:
            fulfillmentOrders.length,

        createdCount,
        updatedCount,
        protectedCount,
    };
}

/*
  INVENTORY ITEM INFORMATION
*/

async function getInventoryDetails(
    inventoryItemId: number,
    token: string
) {
    const shop =
        process.env.SHOPIFY_SHOP;

    if (!shop) {
        throw new Error(
            "SHOPIFY_SHOP missing"
        );
    }

    const query = `
    query InventoryItemDetails(
      $id: ID!
    ) {
      inventoryItem(
        id: $id
      ) {
        id
        sku

        variant {
          id
          title

          product {
            id
            title
          }
        }
      }
    }
  `;

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

                variables: {
                    id:
                        `gid://shopify/InventoryItem/${inventoryItemId}`,
                },
            }),
        }
    );

    const result =
        await response.json();

    if (
        !response.ok ||
        result.errors
    ) {
        throw new Error(
            "Could not load inventory item"
        );
    }

    return result.data?.inventoryItem;
}

/*
  FORMAT ORDER APPROVAL
*/

function formatOrderApproval(
    row: any
) {
    return {
        id: row.id,

        source:
            "ORDER",

        action:
            row.action,

        orderName:
            row.order_name,

        orderId:
            row.order_id,

        reason:
            row.reason,

        status:
            row.status,

        createdAt:
            row.created_at,

        decidedAt:
            row.decided_at,
    };
}

/*
  GET ALL APPROVALS
*/

export async function GET() {
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

        const orderRows =
            db.prepare(`
        SELECT *
        FROM approvals
      `).all() as any[];

        const inventoryRows =
            db.prepare(`
        SELECT *
        FROM inventory_approvals
      `).all() as any[];

        let token:
            | string
            | null = null;

        if (
            inventoryRows.length > 0
        ) {
            try {
                token =
                    await getAccessToken();
            } catch (error) {
                console.error(
                    "Could not get Shopify token:",
                    error
                );
            }
        }

        const inventoryApprovals =
            await Promise.all(
                inventoryRows.map(
                    async (row) => {
                        let item:
                            any = null;

                        if (token) {
                            try {
                                item =
                                    await getInventoryDetails(
                                        row.inventory_item_id,
                                        token
                                    );
                            } catch (
                            error
                            ) {
                                console.error(
                                    "Inventory enrichment failed:",
                                    error
                                );
                            }
                        }

                        return {
                            id:
                                row.id,

                            source:
                                "INVENTORY",

                            action:
                                row.action,

                            inventoryAlertId:
                                row.inventory_alert_id,

                            inventoryItemId:
                                row.inventory_item_id,

                            locationId:
                                row.location_id,

                            available:
                                row.available,

                            productTitle:
                                item
                                    ?.variant
                                    ?.product
                                    ?.title ||
                                "Unknown product",

                            variantTitle:
                                item
                                    ?.variant
                                    ?.title ||
                                "Unknown variant",

                            sku:
                                item?.sku ||
                                "No SKU",

                            reason:
                                row.reason,

                            status:
                                row.status,

                            createdAt:
                                row.created_at,

                            decidedAt:
                                row.decided_at,
                        };
                    }
                )
            );

        const approvals = [
            ...orderRows.map(
                formatOrderApproval
            ),

            ...inventoryApprovals,
        ].sort(
            (a, b) =>
                new Date(
                    b.createdAt
                ).getTime() -
                new Date(
                    a.createdAt
                ).getTime()
        );

        return NextResponse.json({
            source:
                "sqlite",

            approvals,
        });
    } catch (error) {
        console.error(
            "Approvals error:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not read approvals",

                approvals: [],
            },
            { status: 500 }
        );
    }
}

/*
  APPROVE / REJECT
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

        const {
            id,
            decision,
        } =
            await request.json();

        if (
            decision !==
            "APPROVED" &&
            decision !==
            "REJECTED"
        ) {
            return NextResponse.json(
                {
                    error:
                        "Invalid decision",
                },
                { status: 400 }
            );
        }

        /*
          ORDER APPROVAL
        */

        const orderApproval =
            db.prepare(`
        SELECT *
        FROM approvals
        WHERE id = ?
      `).get(id) as any;

        if (orderApproval) {
            /*
              Allow APPROVED -> APPROVED as an
              idempotent reconciliation request.

              This is useful when an approval
              succeeded but the fulfillment task
              was missing because a webhook was
              missed.

              Other already-decided transitions
              remain blocked.
            */

            const approvalAlreadyApproved =
                orderApproval.status ===
                "APPROVED" &&
                decision ===
                "APPROVED";

            if (
                orderApproval.status !==
                "PENDING" &&
                !approvalAlreadyApproved
            ) {
                return NextResponse.json(
                    {
                        error:
                            "Approval already decided",
                    },
                    { status: 400 }
                );
            }

            /*
              APPROVED decisions first write
              the Shopify audit tag.

              tagsAdd is safe to repeat because
              Shopify will not duplicate the same
              tag on the order.
            */

            if (
                decision ===
                "APPROVED"
            ) {
                await addApprovalTag(
                    orderApproval.order_id
                );
            }

            /*
              If APPROVED, reconcile directly
              against Shopify before updating
              the local approval/task state.

              This means approval can recover a
              missing Fulfillment Task even when
              fulfillment-routing webhook failed.
            */

            let reconciliation:
                | Awaited<
                    ReturnType<
                        typeof ensureApprovedFulfillmentTasks
                    >
                >
                | null = null;

            if (
                decision ===
                "APPROVED"
            ) {
                reconciliation =
                    await ensureApprovedFulfillmentTasks(
                        orderApproval.order_id
                    );
            }

            const decidedAt =
                orderApproval.decided_at ||
                new Date().toISOString();

            /*
              Keep local approval decision and
              WAITING_APPROVAL task transition
              consistent.

              Missing tasks were already created
              by reconciliation above.
            */

            db.exec(
                "BEGIN IMMEDIATE"
            );

            let fulfillmentTasksUpdated = 0;

            try {
                if (
                    orderApproval.status ===
                    "PENDING"
                ) {
                    db.prepare(`
          UPDATE approvals
          SET
            status = ?,
            decided_at = ?
          WHERE id = ?
          AND status = 'PENDING'
        `).run(
                        decision,
                        decidedAt,
                        id
                    );
                }

                if (
                    decision ===
                    "APPROVED"
                ) {
                    const taskUpdate =
                        db.prepare(`
              UPDATE fulfillment_tasks
              SET
                status = 'READY_TO_FULFILL',
                warning = NULL,
                updated_at = ?
              WHERE order_id = ?
              AND status = 'WAITING_APPROVAL'
            `).run(
                            decidedAt,
                            orderApproval.order_id
                        );

                    fulfillmentTasksUpdated =
                        Number(
                            taskUpdate.changes
                        );
                } else {
                    const taskUpdate =
                        db.prepare(`
              UPDATE fulfillment_tasks
              SET
                status = 'REVIEW_REQUIRED',
                warning = 'Fulfillment approval was rejected.',
                updated_at = ?
              WHERE order_id = ?
              AND status = 'WAITING_APPROVAL'
            `).run(
                            decidedAt,
                            orderApproval.order_id
                        );

                    fulfillmentTasksUpdated =
                        Number(
                            taskUpdate.changes
                        );
                }

                db.exec(
                    "COMMIT"
                );
            } catch (error) {
                db.exec(
                    "ROLLBACK"
                );

                throw error;
            }

            return NextResponse.json({
                success: true,

                source:
                    "ORDER",

                decision,

                alreadyApproved:
                    approvalAlreadyApproved,

                fulfillmentTasksUpdated,

                reconciliation,

                fulfillmentAction:
                    decision ===
                        "APPROVED"
                        ? "Approved fulfillment tasks reconciled with Shopify and made READY_TO_FULFILL when safe"
                        : "WAITING_APPROVAL tasks moved to REVIEW_REQUIRED",

                shopifyAction:
                    decision ===
                        "APPROVED"
                        ? "AI_APPROVED_FOR_FULFILLMENT tag added"
                        : "No Shopify action performed",
            });
        }

        /*
          INVENTORY APPROVAL
        */

        const inventoryApproval =
            db.prepare(`
        SELECT *
        FROM inventory_approvals
        WHERE id = ?
      `).get(id) as any;

        if (
            !inventoryApproval
        ) {
            return NextResponse.json(
                {
                    error:
                        "Approval not found",
                },
                { status: 404 }
            );
        }

        if (
            inventoryApproval.status !==
            "PENDING"
        ) {
            return NextResponse.json(
                {
                    error:
                        "Approval already decided",
                },
                { status: 400 }
            );
        }

        const decidedAt =
            new Date().toISOString();

        /*
          Use a transaction so that approval
          and Restock Task stay consistent.
        */

        db.exec(
            "BEGIN IMMEDIATE"
        );

        try {
            db.prepare(`
        UPDATE inventory_approvals
        SET
          status = ?,
          decided_at = ?
        WHERE id = ?
      `).run(
                decision,
                decidedAt,
                id
            );

            /*
              Only an APPROVED restock review
              becomes an actual Restock Task.
            */

            if (
                decision ===
                "APPROVED"
            ) {
                const taskId =
                    `restock-${inventoryApproval.id}`;

                db.prepare(`
          INSERT OR IGNORE
          INTO restock_tasks (
            id,
            inventory_approval_id,
            inventory_alert_id,
            inventory_item_id,
            location_id,
            available_when_approved,
            status,
            created_at,
            updated_at,
            completed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
                    taskId,
                    inventoryApproval.id,
                    inventoryApproval.inventory_alert_id,
                    inventoryApproval.inventory_item_id,
                    inventoryApproval.location_id,
                    inventoryApproval.available,
                    "RESTOCK_APPROVED",
                    decidedAt,
                    decidedAt,
                    null
                );
            }

            db.exec(
                "COMMIT"
            );
        } catch (error) {
            db.exec(
                "ROLLBACK"
            );

            throw error;
        }

        return NextResponse.json({
            success: true,

            source:
                "INVENTORY",

            decision,

            action:
                "REVIEW_RESTOCK",

            restockTaskCreated:
                decision ===
                "APPROVED",

            shopifyAction:
                "No Shopify inventory quantity was changed automatically.",
        });
    } catch (error) {
        console.error(
            "Approval processing error:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Approval failed",
            },
            { status: 500 }
        );
    }
}