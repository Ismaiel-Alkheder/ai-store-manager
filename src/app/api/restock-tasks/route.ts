import {
    randomUUID,
} from "crypto";

import {
    NextResponse,
} from "next/server";

import db from "@/lib/database";

import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

export const runtime = "nodejs";

const LOW_STOCK_LIMIT = 5;

/*
  SHOPIFY TOKEN
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
  GENERIC SHOPIFY GRAPHQL
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
  PRODUCT DETAILS
*/

async function getInventoryItemDetails(
    inventoryItemId: number,
    token: string
) {
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

    const data =
        await shopifyGraphQL(
            query,
            {
                id:
                    `gid://shopify/InventoryItem/${inventoryItemId}`,
            },
            token
        );

    return data?.inventoryItem;
}

/*
  CURRENT AVAILABLE QUANTITY

  Shopify supports reading the inventory
  level for a particular location and
  requesting the "available" quantity.
*/

async function getCurrentAvailable(
    inventoryItemId: number,
    locationId: number,
    token: string
) {
    const query = `
    query CurrentInventory(
      $inventoryItemId: ID!,
      $locationId: ID!
    ) {
      inventoryItem(
        id: $inventoryItemId
      ) {
        inventoryLevel(
          locationId: $locationId
        ) {
          quantities(
            names: ["available"]
          ) {
            name
            quantity
          }
        }
      }
    }
  `;

    const data =
        await shopifyGraphQL(
            query,
            {
                inventoryItemId:
                    `gid://shopify/InventoryItem/${inventoryItemId}`,

                locationId:
                    `gid://shopify/Location/${locationId}`,
            },
            token
        );

    const quantities =
        data?.inventoryItem
            ?.inventoryLevel
            ?.quantities || [];

    const available =
        quantities.find(
            (
                item: {
                    name: string;
                    quantity: number;
                }
            ) =>
                item.name ===
                "available"
        );

    if (!available) {
        throw new Error(
            "Could not determine current available inventory."
        );
    }

    return Number(
        available.quantity
    );
}

/*
  RECEIVE INVENTORY

  Delta is positive because stock
  physically arrived.

  changeFromQuantity protects against
  accidentally applying our adjustment
  to an unexpected starting quantity.

  Shopify requires the idempotency key
  for this API version.
*/

async function receiveInventoryInShopify(
    inventoryItemId: number,
    locationId: number,
    receivedQuantity: number,
    stockBefore: number,
    taskId: string,
    idempotencyKey: string,
    token: string
) {
    const mutation = `
    mutation ReceiveInventory(
      $input: InventoryAdjustQuantitiesInput!,
      $idempotencyKey: String!
    ) {
      inventoryAdjustQuantities(
        input: $input
      )
      @idempotent(
        key: $idempotencyKey
      ) {
        userErrors {
          field
          message
        }

        inventoryAdjustmentGroup {
          id
          createdAt
          reason
          referenceDocumentUri

          changes {
            name
            delta
          }
        }
      }
    }
  `;

    const data =
        await shopifyGraphQL(
            mutation,
            {
                input: {
                    reason:
                        "received",

                    name:
                        "available",

                    referenceDocumentUri:
                        `gid://ai-store-manager/RestockTask/${taskId}`,

                    changes: [
                        {
                            delta:
                                receivedQuantity,

                            inventoryItemId:
                                `gid://shopify/InventoryItem/${inventoryItemId}`,

                            locationId:
                                `gid://shopify/Location/${locationId}`,

                            changeFromQuantity:
                                stockBefore,
                        },
                    ],
                },

                idempotencyKey,
            },
            token
        );

    const payload =
        data
            ?.inventoryAdjustQuantities;

    const userErrors =
        payload?.userErrors || [];

    if (
        userErrors.length > 0
    ) {
        throw new Error(
            userErrors
                .map(
                    (
                        item: {
                            message: string;
                        }
                    ) =>
                        item.message
                )
                .join(", ")
        );
    }

    if (
        !payload
            ?.inventoryAdjustmentGroup
    ) {
        throw new Error(
            "Shopify did not return an inventory adjustment."
        );
    }

    return payload
        .inventoryAdjustmentGroup;
}

/*
  GET RESTOCK TASKS
*/

export async function GET() {
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

        const rows =
            db.prepare(`
        SELECT
          rt.*,

          ir.quantity_received,
          ir.stock_before,
          ir.stock_after,
          ir.status AS receipt_status,
          ir.shopify_adjustment_id,
          ir.completed_at AS receipt_completed_at

        FROM restock_tasks rt

        LEFT JOIN inventory_receipts ir
          ON ir.restock_task_id = rt.id

        ORDER BY rt.created_at DESC
      `).all() as any[];

        if (
            rows.length === 0
        ) {
            return NextResponse.json({
                source:
                    "sqlite + shopify",

                tasks: [],
            });
        }

        const token =
            await getAccessToken();

        const tasks =
            await Promise.all(
                rows.map(
                    async (row) => {
                        let item:
                            any = null;

                        try {
                            item =
                                await getInventoryItemDetails(
                                    row.inventory_item_id,
                                    token
                                );
                        } catch (
                        error
                        ) {
                            console.error(
                                "Could not enrich restock task:",
                                row.id,
                                error
                            );
                        }

                        return {
                            id:
                                row.id,

                            inventoryApprovalId:
                                row.inventory_approval_id,

                            inventoryAlertId:
                                row.inventory_alert_id,

                            inventoryItemId:
                                row.inventory_item_id,

                            locationId:
                                row.location_id,

                            availableWhenApproved:
                                row.available_when_approved,

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

                            status:
                                row.status,

                            createdAt:
                                row.created_at,

                            updatedAt:
                                row.updated_at,

                            completedAt:
                                row.completed_at,

                            receipt:
                                row.quantity_received !==
                                    null
                                    ? {
                                        quantityReceived:
                                            row.quantity_received,

                                        stockBefore:
                                            row.stock_before,

                                        stockAfter:
                                            row.stock_after,

                                        status:
                                            row.receipt_status,

                                        shopifyAdjustmentId:
                                            row.shopify_adjustment_id,

                                        completedAt:
                                            row.receipt_completed_at,
                                    }
                                    : null,
                        };
                    }
                )
            );

        return NextResponse.json({
            source:
                "sqlite + shopify",

            tasks,
        });
    } catch (error) {
        console.error(
            "Restock tasks error:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not read restock tasks",

                tasks: [],
            },
            { status: 500 }
        );
    }
}

/*
  POST = RECEIVE INVENTORY
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

        const id =
            String(
                body.id || ""
            );

        const receivedQuantity =
            Number(
                body.receivedQuantity
            );

        if (!id) {
            return NextResponse.json(
                {
                    error:
                        "Restock task ID is required.",
                },
                { status: 400 }
            );
        }

        if (
            !Number.isInteger(
                receivedQuantity
            ) ||
            receivedQuantity <= 0
        ) {
            return NextResponse.json(
                {
                    error:
                        "Received quantity must be a positive whole number.",
                },
                { status: 400 }
            );
        }

        if (
            receivedQuantity >
            100000
        ) {
            return NextResponse.json(
                {
                    error:
                        "Received quantity is too large.",
                },
                { status: 400 }
            );
        }

        const task =
            db.prepare(`
        SELECT *
        FROM restock_tasks
        WHERE id = ?
      `).get(id) as any;

        if (!task) {
            return NextResponse.json(
                {
                    error:
                        "Restock task not found.",
                },
                { status: 404 }
            );
        }

        /*
          If already completed, don't
          add inventory again.
        */

        const existingReceipt =
            db.prepare(`
        SELECT *
        FROM inventory_receipts
        WHERE restock_task_id = ?
      `).get(id) as any;

        if (
            task.status ===
            "COMPLETED" &&
            existingReceipt?.status ===
            "COMPLETED"
        ) {
            return NextResponse.json({
                success: true,
                alreadyCompleted: true,

                taskId:
                    id,

                receivedQuantity:
                    existingReceipt
                        .quantity_received,

                stockBefore:
                    existingReceipt
                        .stock_before,

                stockAfter:
                    existingReceipt
                        .stock_after,
            });
        }

        if (
            task.status !==
            "RESTOCK_APPROVED"
        ) {
            return NextResponse.json(
                {
                    error:
                        `Restock task cannot receive inventory while status is ${task.status}.`,
                },
                { status: 400 }
            );
        }

        /*
          A PROCESSING receipt may mean:
          - previous request lost connection
          - Shopify completed it but our
            response never arrived
    
          In that case we MUST reuse the
          original idempotency key.
        */

        let receipt =
            existingReceipt;

        let stockBefore:
            number;

        let idempotencyKey:
            string;

        const token =
            await getAccessToken();

        if (
            receipt?.status ===
            "PROCESSING"
        ) {
            if (
                Number(
                    receipt.quantity_received
                ) !==
                receivedQuantity
            ) {
                return NextResponse.json(
                    {
                        error:
                            "A receipt is already processing for this task with a different quantity.",
                    },
                    { status: 409 }
                );
            }

            stockBefore =
                Number(
                    receipt.stock_before
                );

            idempotencyKey =
                receipt.idempotency_key;
        } else {
            stockBefore =
                await getCurrentAvailable(
                    task.inventory_item_id,
                    task.location_id,
                    token
                );

            idempotencyKey =
                randomUUID();

            const now =
                new Date().toISOString();

            /*
              If an explicit previous Shopify
              error occurred, reuse the row but
              begin a fresh attempt with a new
              idempotency key.
            */

            if (
                receipt?.status ===
                "FAILED"
            ) {
                db.prepare(`
          UPDATE inventory_receipts
          SET
            quantity_received = ?,
            stock_before = ?,
            stock_after = NULL,
            idempotency_key = ?,
            status = 'PROCESSING',
            shopify_adjustment_id = NULL,
            error = NULL,
            created_at = ?,
            completed_at = NULL
          WHERE restock_task_id = ?
        `).run(
                    receivedQuantity,
                    stockBefore,
                    idempotencyKey,
                    now,
                    id
                );
            } else {
                db.prepare(`
          INSERT INTO inventory_receipts (
            id,
            restock_task_id,
            inventory_item_id,
            location_id,
            quantity_received,
            stock_before,
            stock_after,
            idempotency_key,
            status,
            shopify_adjustment_id,
            error,
            created_at,
            completed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
                    `receipt-${id}`,
                    id,
                    task.inventory_item_id,
                    task.location_id,
                    receivedQuantity,
                    stockBefore,
                    null,
                    idempotencyKey,
                    "PROCESSING",
                    null,
                    null,
                    now,
                    null
                );
            }

            receipt =
                db.prepare(`
          SELECT *
          FROM inventory_receipts
          WHERE restock_task_id = ?
        `).get(id);
        }

        /*
          Shopify inventory adjustment.
        */

        let adjustment:
            any;

        try {
            adjustment =
                await receiveInventoryInShopify(
                    task.inventory_item_id,
                    task.location_id,
                    receivedQuantity,
                    stockBefore,
                    id,
                    idempotencyKey,
                    token
                );
        } catch (error) {
            /*
              If Shopify explicitly returned
              an error, record it.
      
              Reusing the task later will start
              a fresh safe attempt.
            */

            const message =
                error instanceof Error
                    ? error.message
                    : "Shopify inventory adjustment failed.";

            db.prepare(`
        UPDATE inventory_receipts
        SET
          status = 'FAILED',
          error = ?
        WHERE restock_task_id = ?
      `).run(
                message,
                id
            );

            throw error;
        }

        const stockAfter =
            stockBefore +
            receivedQuantity;

        const completedAt =
            new Date().toISOString();

        /*
          Shopify succeeded.
    
          Now update our local state in
          one SQLite transaction.
        */

        db.exec(
            "BEGIN IMMEDIATE"
        );

        try {
            db.prepare(`
        UPDATE inventory_receipts
        SET
          stock_after = ?,
          status = 'COMPLETED',
          shopify_adjustment_id = ?,
          error = NULL,
          completed_at = ?
        WHERE restock_task_id = ?
      `).run(
                stockAfter,
                adjustment.id,
                completedAt,
                id
            );

            db.prepare(`
        UPDATE restock_tasks
        SET
          status = 'COMPLETED',
          updated_at = ?,
          completed_at = ?
        WHERE id = ?
      `).run(
                completedAt,
                completedAt,
                id
            );

            /*
              Keep our alert immediately in
              sync.
      
              Shopify's inventory webhook will
              also arrive afterward and confirm
              the new quantity.
            */

            if (
                stockAfter >
                LOW_STOCK_LIMIT
            ) {
                db.prepare(`
          UPDATE inventory_alerts
          SET
            available = ?,
            status = 'RESOLVED',
            updated_at = ?,
            resolved_at = ?
          WHERE id = ?
        `).run(
                    stockAfter,
                    completedAt,
                    completedAt,
                    task.inventory_alert_id
                );
            } else {
                db.prepare(`
          UPDATE inventory_alerts
          SET
            available = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
                    stockAfter,
                    completedAt,
                    task.inventory_alert_id
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
                "sqlite + shopify",

            taskId:
                id,

            productInventoryItemId:
                task.inventory_item_id,

            locationId:
                task.location_id,

            receivedQuantity,

            stockBefore,

            stockAfter,

            taskStatus:
                "COMPLETED",

            inventoryAlertStatus:
                stockAfter >
                    LOW_STOCK_LIMIT
                    ? "RESOLVED"
                    : "OPEN",

            shopifyAdjustmentId:
                adjustment.id,
        });
    } catch (error) {
        console.error(
            "Receive inventory error:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not receive inventory.",
            },
            { status: 500 }
        );
    }
}