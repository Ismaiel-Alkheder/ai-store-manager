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
                    events: [],
                },
                {
                    status: 401,
                }
            );
        }

        const rows =
            db.prepare(`
        SELECT
          id,
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

        FROM agent_events

        ORDER BY
          datetime(created_at) DESC,
          id DESC

        LIMIT 100
      `).all() as any[];

        const events =
            rows.map((row) => {
                let metadata = null;

                if (row.metadata_json) {
                    try {
                        metadata =
                            JSON.parse(
                                row.metadata_json
                            );
                    } catch {
                        metadata = null;
                    }
                }

                return {
                    id: row.id,
                    eventKey: row.event_key,
                    source: row.source,
                    eventType: row.event_type,
                    entityType: row.entity_type,
                    entityId: row.entity_id,
                    title: row.title,
                    message: row.message,
                    status: row.status,
                    metadata,
                    createdAt: row.created_at,
                };
            });

        return NextResponse.json({
            source: "sqlite",
            count: events.length,
            events,
        });
    } catch (error) {
        console.error(
            "Agent events error:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not read agent events",
                events: [],
            },
            {
                status: 500,
            }
        );
    }
}
