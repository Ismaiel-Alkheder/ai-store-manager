import { NextResponse } from "next/server";
import db from "@/lib/database";
import { hasAdminSession } from "@/lib/require-admin";
import { denyDiagnosticRouteInProduction } from "@/lib/dev-only-route";

export const runtime = "nodejs";

export async function GET() {
    try {
        const productionBlock =
            denyDiagnosticRouteInProduction();

        if (productionBlock) {
            return productionBlock;
        }

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

        const activity = db
            .prepare(`
        SELECT *
        FROM activity
        ORDER BY id DESC
        LIMIT 10
      `)
            .all();

        const approvals = db
            .prepare(`
        SELECT *
        FROM approvals
        ORDER BY created_at DESC
        LIMIT 10
      `)
            .all();

        return NextResponse.json({
            database: "SQLite",
            activityCount: activity.length,
            approvalCount: approvals.length,
            latestActivity: activity,
            latestApprovals: approvals,
        });
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Database error",
            },
            { status: 500 }
        );
    }
}
