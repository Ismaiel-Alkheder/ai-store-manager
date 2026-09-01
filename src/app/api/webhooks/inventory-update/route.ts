import {
    createHmac,
    timingSafeEqual,
} from "crypto";

import { NextResponse } from "next/server";
import db from "@/lib/database";

export const runtime = "nodejs";

const LOW_STOCK_LIMIT = 5;

function verifyWebhook(
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

export async function POST(
    request: Request
) {
    try {
        const secret =
            process.env.SHOPIFY_CLIENT_SECRET;

        if (!secret) {
            return NextResponse.json(
                {
                    error:
                        "SHOPIFY_CLIENT_SECRET missing",
                },
                { status: 500 }
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

        if (
            !hmac ||
            !verifyWebhook(
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
                { status: 401 }
            );
        }

        const payload =
            JSON.parse(
                rawBody.toString("utf8")
            );

        const inventoryItemId =
            Number(
                payload.inventory_item_id
            );

        const locationId =
            Number(payload.location_id);

        const available =
            Number(payload.available);

        const now =
            new Date().toISOString();

        let alertId:
            | number
            | null = null;

        let approvalCreated =
            false;

        /*
          LOW STOCK
        */

        if (
            available <=
            LOW_STOCK_LIMIT
        ) {
            const existingAlert:
                any = db
                    .prepare(`
          SELECT *
          FROM inventory_alerts
          WHERE inventory_item_id = ?
          AND location_id = ?
          AND status = 'OPEN'
          LIMIT 1
        `)
                    .get(
                        inventoryItemId,
                        locationId
                    );

            if (existingAlert) {
                alertId =
                    Number(
                        existingAlert.id
                    );

                db.prepare(`
          UPDATE inventory_alerts
          SET
            available = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
                    available,
                    now,
                    alertId
                );
            } else {
                const result =
                    db.prepare(`
            INSERT INTO inventory_alerts (
              inventory_item_id,
              location_id,
              available,
              status,
              created_at,
              updated_at,
              resolved_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
                        inventoryItemId,
                        locationId,
                        available,
                        "OPEN",
                        now,
                        now,
                        null
                    );

                alertId =
                    Number(
                        result.lastInsertRowid
                    );

                console.log(
                    "LOW INVENTORY ALERT CREATED:",
                    inventoryItemId,
                    available
                );
            }

            /*
              CREATE RESTOCK APPROVAL
            */

            const approvalId =
                `inventory-alert-${alertId}-restock`;

            const existingApproval:
                any = db
                    .prepare(`
          SELECT *
          FROM inventory_approvals
          WHERE id = ?
          LIMIT 1
        `)
                    .get(approvalId);

            const reason =
                `Inventory is low. Only ${available} units remain. ` +
                `The low-stock limit is ${LOW_STOCK_LIMIT}.`;

            if (!existingApproval) {
                db.prepare(`
          INSERT INTO inventory_approvals (
            id,
            action,
            inventory_alert_id,
            inventory_item_id,
            location_id,
            available,
            reason,
            status,
            created_at,
            decided_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
                    approvalId,
                    "REVIEW_RESTOCK",
                    alertId,
                    inventoryItemId,
                    locationId,
                    available,
                    reason,
                    "PENDING",
                    now,
                    null
                );

                approvalCreated =
                    true;

                console.log(
                    "RESTOCK APPROVAL CREATED:",
                    inventoryItemId,
                    available
                );
            } else if (
                existingApproval.status ===
                "PENDING"
            ) {
                db.prepare(`
          UPDATE inventory_approvals
          SET
            available = ?,
            reason = ?
          WHERE id = ?
        `).run(
                    available,
                    reason,
                    approvalId
                );
            }
        }

        /*
          INVENTORY RECOVERED
        */

        if (
            available >
            LOW_STOCK_LIMIT
        ) {
            const openAlerts:
                any[] = db
                    .prepare(`
          SELECT id
          FROM inventory_alerts
          WHERE inventory_item_id = ?
          AND location_id = ?
          AND status = 'OPEN'
        `)
                    .all(
                        inventoryItemId,
                        locationId
                    ) as any[];

            db.prepare(`
        UPDATE inventory_alerts
        SET
          status = 'RESOLVED',
          available = ?,
          updated_at = ?,
          resolved_at = ?
        WHERE inventory_item_id = ?
        AND location_id = ?
        AND status = 'OPEN'
      `).run(
                available,
                now,
                now,
                inventoryItemId,
                locationId
            );

            for (
                const alert
                of openAlerts
            ) {
                db.prepare(`
          UPDATE inventory_approvals
          SET
            status = 'CANCELLED',
            decided_at = ?
          WHERE inventory_alert_id = ?
          AND status = 'PENDING'
        `).run(
                    now,
                    alert.id
                );
            }

            console.log(
                "Inventory recovered:",
                inventoryItemId,
                available
            );
        }

        return NextResponse.json({
            received: true,
            inventoryItemId,
            locationId,
            available,
            lowStock:
                available <=
                LOW_STOCK_LIMIT,
            alertId,
            approvalCreated,
        });
    } catch (error) {
        console.error(
            "Inventory webhook error:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Inventory webhook failed",
            },
            { status: 500 }
        );
    }
}