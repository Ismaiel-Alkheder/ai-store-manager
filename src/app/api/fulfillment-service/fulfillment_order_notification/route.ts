import crypto from "node:crypto";
import { NextResponse } from "next/server";

import db from "@/lib/database";
import { ensureFulfillmentSchema } from "@/lib/fulfillment-schema";

export const runtime = "nodejs";

ensureFulfillmentSchema(db);

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const initNow = new Date().toISOString();

db.prepare(`
  INSERT OR IGNORE INTO app_settings (key, value, updated_at)
  VALUES ('fulfillment_mode', 'MANUAL', ?)
`).run(initNow);

db.prepare(`
  INSERT OR IGNORE INTO app_settings (key, value, updated_at)
  VALUES ('auto_ship_enabled', 'false', ?)
`).run(initNow);

const API_VERSION = "2026-07";

function verifyShopifyHmac(rawBody: string, hmacHeader: string | null) {
    const secret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!secret || !hmacHeader) {
        return false;
    }

    const digest = crypto
        .createHmac("sha256", secret)
        .update(rawBody, "utf8")
        .digest("base64");

    try {
        return crypto.timingSafeEqual(
            Buffer.from(digest, "utf8"),
            Buffer.from(hmacHeader, "utf8")
        );
    } catch {
        return false;
    }
}

function getSetting(key: string, fallback: string) {
    const row = db
        .prepare(`
      SELECT value
      FROM app_settings
      WHERE key = ?
      LIMIT 1
    `)
        .get(key) as { value?: string } | undefined;

    return String(row?.value ?? fallback);
}

function getFulfillmentMode() {
    return getSetting("fulfillment_mode", "MANUAL").toUpperCase() ===
        "AUTOMATIC"
        ? "AUTOMATIC"
        : "MANUAL";
}

function getAutoShipEnabled() {
    return getSetting("auto_ship_enabled", "false").toLowerCase() === "true";
}

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

function sumRemaining(lineItems: any[]) {
    return (lineItems || []).reduce(
        (total: number, item: any) =>
            total + Number(item?.remainingQuantity || 0),
        0
    );
}

async function acceptFulfillmentRequest(
    fulfillmentOrderId: string,
    token: string
) {
    const data = await shopifyGraphQL(
        `
    mutation AutoAcceptFulfillmentRequest($id: ID!, $message: String) {
      fulfillmentOrderAcceptFulfillmentRequest(
        id: $id,
        message: $message
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
            message: "Automatically accepted by AI Test Warehouse",
        },
        token
    );

    const result = data?.fulfillmentOrderAcceptFulfillmentRequest;

    return {
        fulfillmentOrder: result?.fulfillmentOrder || null,
        userErrors: result?.userErrors || [],
    };
}

async function createFulfillment(
    fulfillmentOrderId: string,
    token: string
) {
    const data = await shopifyGraphQL(
        `
    mutation AutoCreateFulfillment(
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
                notifyCustomer: false,
            },
            message: "Automatically shipped by AI Test Warehouse",
        },
        token
    );

    const result = data?.fulfillmentCreate;

    return {
        fulfillmentId: result?.fulfillment?.id || null,
        userErrors: result?.userErrors || [],
    };
}

async function readFulfillmentOrder(
    fulfillmentOrderId: string,
    token: string
) {
    const data = await shopifyGraphQL(
        `
    query ReadFulfillmentOrderAfterAutoAction($id: ID!) {
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

    return data?.fulfillmentOrder || null;
}

export async function POST(request: Request) {
    const rawBody = await request.text();
    const hmacHeader = request.headers.get("x-shopify-hmac-sha256");

    if (!verifyShopifyHmac(rawBody, hmacHeader)) {
        return NextResponse.json(
            {
                success: false,
                error: "Invalid Shopify HMAC.",
            },
            { status: 401 }
        );
    }

    let payload: any;

    try {
        payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
        return NextResponse.json(
            {
                success: false,
                error: "Invalid JSON payload.",
            },
            { status: 400 }
        );
    }

    const kind = String(payload?.kind || "").toUpperCase();

    if (
        kind !== "FULFILLMENT_REQUEST" &&
        kind !== "CANCELLATION_REQUEST"
    ) {
        return NextResponse.json({
            success: true,
            ignored: true,
            kind: kind || null,
        });
    }

    try {
        const assignmentStatus =
            kind === "FULFILLMENT_REQUEST"
                ? "FULFILLMENT_REQUESTED"
                : "CANCELLATION_REQUESTED";

        const token = await getAccessToken();
        const fulfillmentMode = getFulfillmentMode();
        const autoShipEnabled = getAutoShipEnabled();

        const data = await shopifyGraphQL(
            `
      query AIWarehouseAssignedOrders(
        $assignmentStatus: FulfillmentOrderAssignmentStatus!
      ) {
        assignedFulfillmentOrders(
          first: 100,
          assignmentStatus: $assignmentStatus
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
      }
      `,
            { assignmentStatus },
            token
        );

        const assignedOrders =
            data?.assignedFulfillmentOrders?.nodes || [];

        const now = new Date().toISOString();
        let localTasksUpdated = 0;
        const unmatchedFulfillmentOrderIds: string[] = [];
        const autoAccepted: any[] = [];
        const autoAcceptErrors: any[] = [];
        const autoShipped: any[] = [];
        const autoShipErrors: any[] = [];

        for (const fulfillmentOrder of assignedOrders) {
            const fulfillmentOrderId = fulfillmentOrder?.id;

            if (!fulfillmentOrderId) {
                continue;
            }

            const localTask = db
                .prepare(`
          SELECT id, status, request_status
          FROM fulfillment_tasks
          WHERE fulfillment_order_id = ?
          LIMIT 1
        `)
                .get(fulfillmentOrderId) as any;

            if (!localTask) {
                unmatchedFulfillmentOrderIds.push(fulfillmentOrderId);
                continue;
            }

            const remainingQuantity = sumRemaining(
                fulfillmentOrder?.lineItems?.nodes || []
            );

            if (kind === "FULFILLMENT_REQUEST") {
                const result = db
                    .prepare(`
            UPDATE fulfillment_tasks
            SET
              fulfillment_order_status = ?,
              request_status = ?,
              order_fulfillment_status = ?,
              financial_status = ?,
              remaining_quantity = ?,
              location_id = COALESCE(?, location_id),
              location_name = COALESCE(?, location_name),
              status = CASE
                WHEN status = 'COMPLETED' THEN status
                ELSE 'PROCESSING'
              END,
              warning = CASE
                WHEN status = 'COMPLETED' THEN warning
                ELSE NULL
              END,
              updated_at = ?
            WHERE fulfillment_order_id = ?
          `)
                    .run(
                        fulfillmentOrder?.status || "OPEN",
                        fulfillmentOrder?.requestStatus || "SUBMITTED",
                        fulfillmentOrder?.order?.displayFulfillmentStatus || null,
                        fulfillmentOrder?.order?.displayFinancialStatus || null,
                        remainingQuantity,
                        fulfillmentOrder?.assignedLocation?.location?.id || null,
                        fulfillmentOrder?.assignedLocation?.name || null,
                        now,
                        fulfillmentOrderId
                    );

                localTasksUpdated += Number(result.changes);

                const canAutoAccept =
                    fulfillmentMode === "AUTOMATIC" &&
                    fulfillmentOrder?.requestStatus === "SUBMITTED" &&
                    fulfillmentOrder?.status === "OPEN" &&
                    fulfillmentOrder?.order?.displayFinancialStatus === "PAID" &&
                    remainingQuantity > 0;

                if (canAutoAccept) {
                    const acceptResult = await acceptFulfillmentRequest(
                        fulfillmentOrderId,
                        token
                    );

                    const acceptErrors = acceptResult.userErrors || [];
                    const accepted = acceptResult.fulfillmentOrder;

                    if (
                        acceptErrors.length === 0 &&
                        accepted?.requestStatus === "ACCEPTED"
                    ) {
                        db.prepare(`
              UPDATE fulfillment_tasks
              SET
                fulfillment_order_status = ?,
                request_status = 'ACCEPTED',
                order_fulfillment_status = ?,
                status = 'PROCESSING',
                warning = ?,
                updated_at = ?
              WHERE fulfillment_order_id = ?
            `).run(
                            accepted?.status || "IN_PROGRESS",
                            accepted?.order?.displayFulfillmentStatus || null,
                            autoShipEnabled
                                ? "Automatically accepted by AI Test Warehouse. Auto-ship is enabled."
                                : "Automatically accepted by AI Test Warehouse. Shipment remains manual.",
                            new Date().toISOString(),
                            fulfillmentOrderId
                        );

                        autoAccepted.push({
                            fulfillmentOrderId,
                            orderName:
                                accepted?.order?.name ||
                                fulfillmentOrder?.order?.name ||
                                null,
                            requestStatus: accepted?.requestStatus || "ACCEPTED",
                        });

                        /*
                          Auto-ship is deliberately independent.
                          It runs only if:
                          - mode is AUTOMATIC
                          - auto_ship_enabled = true
                          - this exact request was just accepted successfully
                        */
                        if (autoShipEnabled) {
                            const shipResult = await createFulfillment(
                                fulfillmentOrderId,
                                token
                            );

                            const shipErrors = shipResult.userErrors || [];

                            if (shipErrors.length === 0 && shipResult.fulfillmentId) {
                                const after = await readFulfillmentOrder(
                                    fulfillmentOrderId,
                                    token
                                );

                                if (!after) {
                                    throw new Error(
                                        "Could not read Fulfillment Order after automatic fulfillment."
                                    );
                                }

                                const remainingAfter = sumRemaining(
                                    after?.lineItems?.nodes || []
                                );

                                const completed =
                                    remainingAfter <= 0 || after?.status === "CLOSED";

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
                                    after?.status || "CLOSED",
                                    after?.requestStatus || "ACCEPTED",
                                    after?.order?.displayFulfillmentStatus || null,
                                    remainingAfter,
                                    completed ? "COMPLETED" : "REVIEW_REQUIRED",
                                    completed
                                        ? null
                                        : "Auto-ship created a fulfillment, but remaining quantity is still greater than zero. Review required.",
                                    shipResult.fulfillmentId,
                                    completed ? 1 : 0,
                                    new Date().toISOString(),
                                    new Date().toISOString(),
                                    fulfillmentOrderId
                                );

                                autoShipped.push({
                                    fulfillmentOrderId,
                                    orderName:
                                        after?.order?.name ||
                                        accepted?.order?.name ||
                                        null,
                                    fulfillmentId: shipResult.fulfillmentId,
                                    completed,
                                    status: after?.status || null,
                                    requestStatus: after?.requestStatus || null,
                                    fulfillmentStatus:
                                        after?.order?.displayFulfillmentStatus || null,
                                    remainingQuantity: remainingAfter,
                                });
                            } else {
                                const errorMessage = shipErrors
                                    .map((item: any) => item?.message)
                                    .filter(Boolean)
                                    .join(" | ");

                                db.prepare(`
                  UPDATE fulfillment_tasks
                  SET
                    status = 'REVIEW_REQUIRED',
                    warning = ?,
                    updated_at = ?
                  WHERE fulfillment_order_id = ?
                `).run(
                                    `Automatic ship failed: ${errorMessage || "Shopify did not return a fulfillment ID"
                                    }`,
                                    new Date().toISOString(),
                                    fulfillmentOrderId
                                );

                                autoShipErrors.push({
                                    fulfillmentOrderId,
                                    userErrors: shipErrors,
                                });
                            }
                        }
                    } else {
                        const errorMessage = acceptErrors
                            .map((item: any) => item?.message)
                            .filter(Boolean)
                            .join(" | ");

                        db.prepare(`
              UPDATE fulfillment_tasks
              SET
                status = 'REVIEW_REQUIRED',
                warning = ?,
                updated_at = ?
              WHERE fulfillment_order_id = ?
            `).run(
                            `Automatic accept failed: ${errorMessage || "Unknown Shopify error"
                            }`,
                            new Date().toISOString(),
                            fulfillmentOrderId
                        );

                        autoAcceptErrors.push({
                            fulfillmentOrderId,
                            userErrors: acceptErrors,
                        });
                    }
                }
            } else {
                const result = db
                    .prepare(`
            UPDATE fulfillment_tasks
            SET
              fulfillment_order_status = ?,
              request_status = ?,
              order_fulfillment_status = ?,
              financial_status = ?,
              remaining_quantity = ?,
              location_id = COALESCE(?, location_id),
              location_name = COALESCE(?, location_name),
              status = CASE
                WHEN status = 'COMPLETED' THEN status
                ELSE 'REVIEW_REQUIRED'
              END,
              warning = CASE
                WHEN status = 'COMPLETED' THEN warning
                ELSE 'Cancellation requested by merchant. Warehouse review required.'
              END,
              updated_at = ?
            WHERE fulfillment_order_id = ?
          `)
                    .run(
                        fulfillmentOrder?.status || "IN_PROGRESS",
                        fulfillmentOrder?.requestStatus || "CANCELLATION_REQUESTED",
                        fulfillmentOrder?.order?.displayFulfillmentStatus || null,
                        fulfillmentOrder?.order?.displayFinancialStatus || null,
                        remainingQuantity,
                        fulfillmentOrder?.assignedLocation?.location?.id || null,
                        fulfillmentOrder?.assignedLocation?.name || null,
                        now,
                        fulfillmentOrderId
                    );

                localTasksUpdated += Number(result.changes);
            }
        }

        console.log("AI Test Warehouse notification synced:", {
            kind,
            fulfillmentMode,
            autoShipEnabled,
            assignmentStatus,
            assignedOrdersFound: assignedOrders.length,
            localTasksUpdated,
            autoAccepted,
            autoAcceptErrors,
            autoShipped,
            autoShipErrors,
            unmatchedFulfillmentOrderIds,
        });

        return NextResponse.json({
            success: true,
            kind,
            fulfillmentMode,
            autoShipEnabled,
            assignmentStatus,
            assignedOrdersFound: assignedOrders.length,
            localTasksUpdated,
            autoAccepted,
            autoAcceptErrors,
            autoShipped,
            autoShipErrors,
            unmatchedFulfillmentOrderIds,
        });
    } catch (error) {
        console.error("AI Test Warehouse notification sync error:", error);

        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not synchronize assigned fulfillment orders.",
            },
            { status: 500 }
        );
    }
}
