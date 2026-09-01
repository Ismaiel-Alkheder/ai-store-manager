import db from "@/lib/database";

type AdminAuditInput = {
    eventType: string;
    outcome: "SUCCESS" | "FAILURE" | "INFO";
    clientKey?: string | null;
    message?: string | null;
    metadata?: Record<string, unknown> | null;
};

export type AdminAuditEvent = {
    id: number;
    eventType: string;
    outcome: string;
    message: string | null;
    createdAt: string;
};

const AUDIT_RETENTION_DAYS = 180;
const AUDIT_MAX_ROWS = 5000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

let schemaReady = false;
let lastCleanupAt = 0;

function ensureAdminAuditSchema() {
    if (schemaReady) {
        return;
    }

    db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      client_key TEXT,
      message TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    )
  `);

    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at
    ON admin_audit_log(created_at DESC)
  `);

    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_admin_audit_log_event_type
    ON admin_audit_log(event_type)
  `);

    schemaReady = true;
}

function cleanupAdminAuditLogIfNeeded() {
    const now = Date.now();

    if (
        lastCleanupAt &&
        now - lastCleanupAt < CLEANUP_INTERVAL_MS
    ) {
        return;
    }

    const cutoff = new Date(
        now -
        AUDIT_RETENTION_DAYS *
        24 *
        60 *
        60 *
        1000
    ).toISOString();

    db.prepare(`
    DELETE FROM admin_audit_log
    WHERE created_at < ?
  `).run(cutoff);

    db.prepare(`
    DELETE FROM admin_audit_log
    WHERE id NOT IN (
      SELECT id
      FROM admin_audit_log
      ORDER BY id DESC
      LIMIT ?
    )
  `).run(AUDIT_MAX_ROWS);

    lastCleanupAt = now;
}

export function recordAdminAuditEvent(input: AdminAuditInput) {
    ensureAdminAuditSchema();

    const eventType = String(input.eventType || "")
        .trim()
        .slice(0, 100);

    if (!eventType) {
        throw new Error(
            "Admin audit eventType is required."
        );
    }

    const message = input.message
        ? String(input.message)
            .trim()
            .slice(0, 1000)
        : null;

    const clientKey = input.clientKey
        ? String(input.clientKey)
            .trim()
            .slice(0, 200)
        : null;

    const metadataJson = input.metadata
        ? JSON.stringify(input.metadata)
        : null;

    db.prepare(`
    INSERT INTO admin_audit_log (
      event_type,
      outcome,
      client_key,
      message,
      metadata_json,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
        eventType,
        input.outcome,
        clientKey,
        message,
        metadataJson,
        new Date().toISOString()
    );

    cleanupAdminAuditLogIfNeeded();
}

export function getAdminAuditEvents(
    limit = 50
): AdminAuditEvent[] {
    ensureAdminAuditSchema();
    cleanupAdminAuditLogIfNeeded();

    const safeLimit = Math.min(
        Math.max(
            Math.trunc(limit) || 50,
            1
        ),
        100
    );

    const rows = db.prepare(`
    SELECT
      id,
      event_type,
      outcome,
      message,
      created_at
    FROM admin_audit_log
    ORDER BY id DESC
    LIMIT ?
  `).all(
        safeLimit
    ) as Array<{
        id: number | bigint;
        event_type: string;
        outcome: string;
        message: string | null;
        created_at: string;
    }>;

    return rows.map((row) => ({
        id: Number(row.id),
        eventType: row.event_type,
        outcome: row.outcome,
        message: row.message,
        createdAt: row.created_at,
    }));
}
