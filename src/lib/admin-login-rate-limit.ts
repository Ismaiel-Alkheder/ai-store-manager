import crypto from "node:crypto";

import db from "@/lib/database";

export const ADMIN_LOGIN_WINDOW_SECONDS = 15 * 60;
export const ADMIN_LOGIN_MAX_FAILURES = 5;

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_key TEXT NOT NULL,
    attempted_at INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_client_time
  ON admin_login_attempts (
    client_key,
    attempted_at
  )
`);

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

function cleanupOldAttempts() {
    const cutoff =
        nowSeconds() -
        ADMIN_LOGIN_WINDOW_SECONDS;

    db.prepare(`
    DELETE FROM admin_login_attempts
    WHERE attempted_at < ?
  `).run(cutoff);
}

export function getAdminLoginClientKey(
    request: Request
) {
    const forwardedFor =
        request.headers
            .get("x-forwarded-for")
            ?.split(",")[0]
            ?.trim() || "";

    const realIp =
        request.headers
            .get("x-real-ip")
            ?.trim() || "";

    const userAgent =
        request.headers
            .get("user-agent") || "";

    const remoteIdentity =
        forwardedFor ||
        realIp ||
        "local";

    return crypto
        .createHash("sha256")
        .update(
            `${remoteIdentity}|${userAgent}`
        )
        .digest("hex");
}

export function checkAdminLoginRateLimit(
    clientKey: string
) {
    cleanupOldAttempts();

    const cutoff =
        nowSeconds() -
        ADMIN_LOGIN_WINDOW_SECONDS;

    const row = db
        .prepare(`
      SELECT
        COUNT(*) AS failures,
        MIN(attempted_at) AS oldest_attempt
      FROM admin_login_attempts
      WHERE client_key = ?
      AND attempted_at >= ?
    `)
        .get(
            clientKey,
            cutoff
        ) as
        | {
            failures?: number;
            oldest_attempt?: number | null;
        }
        | undefined;

    const failures =
        Number(
            row?.failures || 0
        );

    if (
        failures <
        ADMIN_LOGIN_MAX_FAILURES
    ) {
        return {
            allowed: true,
            failures,
            retryAfterSeconds: 0,
        };
    }

    const oldestAttempt =
        Number(
            row?.oldest_attempt ||
            nowSeconds()
        );

    const retryAfterSeconds =
        Math.max(
            1,
            ADMIN_LOGIN_WINDOW_SECONDS -
            (nowSeconds() -
                oldestAttempt)
        );

    return {
        allowed: false,
        failures,
        retryAfterSeconds,
    };
}

export function recordFailedAdminLogin(
    clientKey: string
) {
    cleanupOldAttempts();

    db.prepare(`
    INSERT INTO admin_login_attempts (
      client_key,
      attempted_at
    )
    VALUES (?, ?)
  `).run(
        clientKey,
        nowSeconds()
    );
}

export function clearAdminLoginFailures(
    clientKey: string
) {
    db.prepare(`
    DELETE FROM admin_login_attempts
    WHERE client_key = ?
  `).run(clientKey);
}
