import {
    createHmac,
    randomBytes,
    scryptSync,
    timingSafeEqual,
} from "node:crypto";

import {
    getAdminSessionVersion,
} from "@/lib/admin-credentials";

export const ADMIN_SESSION_COOKIE =
    "asm_admin_session";

const SESSION_VERSION = "v2";
const SESSION_MAX_AGE_SECONDS =
    60 * 60 * 8; // 8 hours

function getSessionSecret() {
    const secret =
        process.env.ADMIN_SESSION_SECRET;

    if (
        !secret ||
        secret.length < 32
    ) {
        throw new Error(
            "ADMIN_SESSION_SECRET is missing or too short. Use at least 32 characters."
        );
    }

    return secret;
}

function encode(input: string) {
    return Buffer.from(
        input,
        "utf8"
    ).toString("base64url");
}

function decode(input: string) {
    return Buffer.from(
        input,
        "base64url"
    ).toString("utf8");
}

function sign(body: string) {
    return createHmac(
        "sha256",
        getSessionSecret()
    )
        .update(
            body,
            "utf8"
        )
        .digest(
            "base64url"
        );
}

export function createAdminSessionToken() {
    const expiresAt =
        Math.floor(
            Date.now() / 1000
        ) +
        SESSION_MAX_AGE_SECONDS;

    const sessionVersion =
        getAdminSessionVersion();

    const payload =
        JSON.stringify({
            role:
                "admin",

            exp:
                expiresAt,

            nonce:
                randomBytes(18)
                    .toString(
                        "base64url"
                    ),

            sessionVersion,
        });

    const encodedPayload =
        encode(payload);

    const body =
        `${SESSION_VERSION}.${encodedPayload}`;

    const signature =
        sign(body);

    return {
        token:
            `${body}.${signature}`,

        maxAge:
            SESSION_MAX_AGE_SECONDS,

        expiresAt,

        sessionVersion,
    };
}

export function verifyAdminSessionToken(
    token?: string | null
) {
    if (!token) {
        return false;
    }

    const parts =
        token.split(".");

    if (
        parts.length !== 3
    ) {
        return false;
    }

    const [
        version,
        encodedPayload,
        suppliedSignature,
    ] = parts;

    if (
        version !==
        SESSION_VERSION ||
        !encodedPayload ||
        !suppliedSignature
    ) {
        return false;
    }

    const body =
        `${version}.${encodedPayload}`;

    const expectedSignature =
        sign(body);

    const supplied =
        Buffer.from(
            suppliedSignature,
            "utf8"
        );

    const expected =
        Buffer.from(
            expectedSignature,
            "utf8"
        );

    if (
        supplied.length !==
        expected.length
    ) {
        return false;
    }

    if (
        !timingSafeEqual(
            supplied,
            expected
        )
    ) {
        return false;
    }

    try {
        const payload =
            JSON.parse(
                decode(
                    encodedPayload
                )
            );

        if (
            payload?.role !==
            "admin"
        ) {
            return false;
        }

        if (
            typeof payload?.exp !==
            "number" ||
            payload.exp <=
            Math.floor(
                Date.now() /
                1000
            )
        ) {
            return false;
        }

        const tokenSessionVersion =
            Number(
                payload?.sessionVersion
            );

        if (
            !Number.isInteger(
                tokenSessionVersion
            ) ||
            tokenSessionVersion <
            1
        ) {
            return false;
        }

        const currentSessionVersion =
            getAdminSessionVersion();

        if (
            tokenSessionVersion !==
            currentSessionVersion
        ) {
            return false;
        }

        return true;
    } catch {
        return false;
    }
}

/*
  Legacy helper retained for compatibility.

  Current login flow uses the SQLite-backed
  verifyCurrentAdminPassword() helper in
  admin-credentials.ts.
*/
export function verifyAdminPassword(
    password: string
) {
    const stored =
        process.env.ADMIN_PASSWORD_HASH;

    if (!stored) {
        throw new Error(
            "ADMIN_PASSWORD_HASH is missing."
        );
    }

    const [
        algorithm,
        salt,
        expectedHash,
    ] = stored.split("$");

    if (
        algorithm !==
        "scrypt" ||
        !salt ||
        !expectedHash
    ) {
        throw new Error(
            "ADMIN_PASSWORD_HASH has an invalid format. Expected scrypt$<salt>$<hash>."
        );
    }

    const actualHash =
        scryptSync(
            password,
            salt,
            64
        ).toString(
            "hex"
        );

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

    return timingSafeEqual(
        actual,
        expected
    );
}

export function isSecureCookie() {
    return (
        process.env.NODE_ENV ===
        "production"
    );
}
