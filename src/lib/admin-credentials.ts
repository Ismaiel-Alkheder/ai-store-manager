import crypto from "node:crypto";

import db from "@/lib/database";

export const runtime = "nodejs";

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    session_version INTEGER NOT NULL DEFAULT 1
  )
`);

/*
  Existing development databases may have been created
  before session_version existed.

  Add the column once when needed.
*/
const adminCredentialColumns = db
    .prepare(`
      PRAGMA table_info(admin_credentials)
    `)
    .all() as Array<{
        name?: string;
    }>;

const hasSessionVersionColumn =
    adminCredentialColumns.some(
        (column) =>
            column.name ===
            "session_version"
    );

if (!hasSessionVersionColumn) {
    db.exec(`
      ALTER TABLE admin_credentials
      ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1
    `);
}

function parseHash(stored: string) {
    const [algorithm, salt, expectedHash] =
        stored.split("$");

    if (
        algorithm !== "scrypt" ||
        !salt ||
        !expectedHash ||
        !/^[a-f0-9]+$/i.test(
            expectedHash
        )
    ) {
        throw new Error(
            "Admin password hash has an invalid format."
        );
    }

    return {
        salt,
        expectedHash,
    };
}

function bootstrapCredentialIfNeeded() {
    const existing = db
        .prepare(`
      SELECT
        password_hash,
        session_version
      FROM admin_credentials
      WHERE id = 1
      LIMIT 1
    `)
        .get() as
        | {
            password_hash?: string;
            session_version?: number;
        }
        | undefined;

    if (existing?.password_hash) {
        return;
    }

    const bootstrapHash =
        process.env.ADMIN_PASSWORD_HASH;

    if (!bootstrapHash) {
        throw new Error(
            "ADMIN_PASSWORD_HASH is missing. It is required to bootstrap the first admin credential."
        );
    }

    // Validate before persisting.
    parseHash(bootstrapHash);

    db.prepare(`
    INSERT INTO admin_credentials (
      id,
      password_hash,
      updated_at,
      session_version
    )
    VALUES (1, ?, ?, 1)
  `).run(
        bootstrapHash,
        new Date().toISOString()
    );
}

function getCredentialRow() {
    bootstrapCredentialIfNeeded();

    const row = db
        .prepare(`
      SELECT
        password_hash,
        session_version
      FROM admin_credentials
      WHERE id = 1
      LIMIT 1
    `)
        .get() as
        | {
            password_hash?: string;
            session_version?: number;
        }
        | undefined;

    if (!row?.password_hash) {
        throw new Error(
            "Admin credential could not be loaded."
        );
    }

    const sessionVersion =
        Number(
            row.session_version ?? 1
        );

    if (
        !Number.isInteger(
            sessionVersion
        ) ||
        sessionVersion < 1
    ) {
        throw new Error(
            "Admin session version is invalid."
        );
    }

    return {
        passwordHash:
            row.password_hash,
        sessionVersion,
    };
}

function getStoredHash() {
    return getCredentialRow()
        .passwordHash;
}

export function getAdminSessionVersion() {
    return getCredentialRow()
        .sessionVersion;
}

export function verifyCurrentAdminPassword(
    password: string
) {
    const stored =
        getStoredHash();

    const {
        salt,
        expectedHash,
    } = parseHash(stored);

    const actualHash = crypto
        .scryptSync(
            password,
            salt,
            64
        )
        .toString("hex");

    const actual =
        Buffer.from(
            actualHash,
            "hex"
        );

    const expected =
        Buffer.from(
            expectedHash,
            "hex"
        );

    if (
        actual.length !==
        expected.length
    ) {
        return false;
    }

    return crypto.timingSafeEqual(
        actual,
        expected
    );
}

export function createAdminPasswordHash(
    password: string
) {
    const salt = crypto
        .randomBytes(18)
        .toString("hex");

    const hash = crypto
        .scryptSync(
            password,
            salt,
            64
        )
        .toString("hex");

    return `scrypt$${salt}$${hash}`;
}

export function validateNewAdminPassword(
    password: string
) {
    if (password.length < 12) {
        return "New password must be at least 12 characters.";
    }

    if (
        !/[A-Za-z]/.test(
            password
        )
    ) {
        return "New password must contain at least one letter.";
    }

    if (!/[0-9]/.test(password)) {
        return "New password must contain at least one number.";
    }

    return null;
}

export function changeAdminPassword(
    newPassword: string
) {
    const passwordHash =
        createAdminPasswordHash(
            newPassword
        );

    bootstrapCredentialIfNeeded();

    /*
      The password update and session-version bump happen
      in one SQLite UPDATE. Once the remaining auth layer
      checks session_version, every older session can be
      invalidated immediately after a password change.
    */
    const result = db
        .prepare(`
      UPDATE admin_credentials
      SET
        password_hash = ?,
        updated_at = ?,
        session_version = session_version + 1
      WHERE id = 1
    `)
        .run(
            passwordHash,
            new Date().toISOString()
        );

    if (result.changes !== 1) {
        throw new Error(
            "Admin credential could not be updated."
        );
    }

    return getAdminSessionVersion();
}
