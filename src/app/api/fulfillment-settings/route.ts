import { NextResponse } from "next/server";

import db from "@/lib/database";
import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

export const runtime = "nodejs";

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

function getMode() {
    return getSetting("fulfillment_mode", "MANUAL").toUpperCase() ===
        "AUTOMATIC"
        ? "AUTOMATIC"
        : "MANUAL";
}

function getAutoShipEnabled() {
    return getSetting("auto_ship_enabled", "false").toLowerCase() === "true";
}

function snapshot() {
    const fulfillmentMode = getMode();
    const autoShipEnabled = getAutoShipEnabled();

    return {
        fulfillmentMode,
        autoShipEnabled,
        automaticBehavior: {
            acceptFulfillmentRequests: fulfillmentMode === "AUTOMATIC",
            shipAutomatically:
                fulfillmentMode === "AUTOMATIC" && autoShipEnabled,
        },
    };
}

export async function GET() {
    if (!(await hasAdminSession())) {
        return NextResponse.json(
            {
                success: false,
                error: "Unauthorized.",
            },
            { status: 401 }
        );
    }

    return NextResponse.json({
        success: true,
        ...snapshot(),
    });
}

export async function POST(request: Request) {
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

        const body = await request.json();
        const confirm = body?.confirm === true;

        if (!confirm) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Explicit confirmation is required. Send confirm: true.",
                },
                { status: 400 }
            );
        }

        const requestedMode =
            body?.mode === undefined || body?.mode === null
                ? null
                : String(body.mode).toUpperCase();

        const requestedAutoShip =
            typeof body?.autoShipEnabled === "boolean"
                ? body.autoShipEnabled
                : null;

        if (requestedMode === null && requestedAutoShip === null) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        "Provide at least one setting: mode or autoShipEnabled.",
                },
                { status: 400 }
            );
        }

        if (
            requestedMode !== null &&
            requestedMode !== "MANUAL" &&
            requestedMode !== "AUTOMATIC"
        ) {
            return NextResponse.json(
                {
                    success: false,
                    error: "mode must be MANUAL or AUTOMATIC.",
                },
                { status: 400 }
            );
        }

        const updatedAt = new Date().toISOString();

        /*
          node:sqlite DatabaseSync does NOT provide db.transaction()
          like better-sqlite3 does, so use explicit SQL transaction
          statements instead.
        */
        db.exec("BEGIN IMMEDIATE");

        try {
            if (requestedMode !== null) {
                db.prepare(`
          INSERT INTO app_settings (key, value, updated_at)
          VALUES ('fulfillment_mode', ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `).run(requestedMode, updatedAt);
            }

            if (requestedAutoShip !== null) {
                db.prepare(`
          INSERT INTO app_settings (key, value, updated_at)
          VALUES ('auto_ship_enabled', ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `).run(
                    requestedAutoShip ? "true" : "false",
                    updatedAt
                );
            }

            db.exec("COMMIT");
        } catch (error) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // Ignore rollback failure and preserve original error.
            }

            throw error;
        }

        return NextResponse.json({
            success: true,
            ...snapshot(),
            updatedAt,
        });
    } catch (error) {
        console.error("Fulfillment settings update error:", error);

        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not update fulfillment settings.",
            },
            { status: 500 }
        );
    }
}
