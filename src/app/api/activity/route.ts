import { NextResponse } from "next/server";
import db from "@/lib/database";
import { hasAdminSession } from "@/lib/require-admin";

export const runtime = "nodejs";

export async function GET() {
    try {
        if (!(await hasAdminSession())) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Unauthorized.",
                    activity: [],
                },
                {
                    status: 401,
                }
            );
        }

        const rows = db
            .prepare(`
        SELECT
          webhook_id,
          type,
          order_name,
          order_id,
          total,
          currency,
          payment_status,
          fulfillment_status,
          created_at
        FROM activity
        ORDER BY id DESC
        LIMIT 50
      `)
            .all();

        const activity = rows.map((row: any) => ({
            webhookId: row.webhook_id,
            type: row.type,
            orderName: row.order_name,
            orderId: row.order_id,
            total: row.total,
            currency: row.currency,
            paymentStatus: row.payment_status,
            fulfillmentStatus: row.fulfillment_status,
            createdAt: row.created_at,
        }));

        return NextResponse.json({
            activity,
        });
    } catch (error) {
        console.error("Activity database error:", error);

        return NextResponse.json(
            {
                error: "Could not read activity",
                activity: [],
            },
            {
                status: 500,
            }
        );
    }
}
