import {
    NextRequest,
    NextResponse,
} from "next/server";

import {
    ADMIN_SESSION_COOKIE,
    createAdminSessionToken,
    isSecureCookie,
} from "@/lib/admin-auth";

import {
    verifyCurrentAdminPassword,
} from "@/lib/admin-credentials";

import {
    checkAdminLoginRateLimit,
    clearAdminLoginFailures,
    getAdminLoginClientKey,
    recordFailedAdminLogin,
} from "@/lib/admin-login-rate-limit";

import {
    recordAdminAuditEvent,
} from "@/lib/admin-audit";

import {
    isSameOriginAdminRequest,
} from "@/lib/require-same-origin";

export const runtime = "nodejs";

function safeAudit(
    input: Parameters<
        typeof recordAdminAuditEvent
    >[0]
) {
    try {
        recordAdminAuditEvent(input);
    } catch (error) {
        console.error(
            "Admin audit log write failed:",
            error
        );
    }
}

export async function POST(
    request: NextRequest
) {
    let clientKey: string | null =
        null;

    try {
        if (
            !isSameOriginAdminRequest(
                request
            )
        ) {
            safeAudit({
                eventType:
                    "ADMIN_LOGIN_ORIGIN_REJECTED",
                outcome:
                    "FAILURE",
                message:
                    "Admin login request rejected because the request origin was invalid.",
            });

            return NextResponse.json(
                {
                    success: false,
                    error:
                        "Invalid request origin.",
                },
                {
                    status: 403,
                }
            );
        }

        clientKey =
            getAdminLoginClientKey(
                request
            );

        const rateLimit =
            checkAdminLoginRateLimit(
                clientKey
            );

        if (!rateLimit.allowed) {
            safeAudit({
                eventType:
                    "ADMIN_LOGIN_RATE_LIMITED",
                outcome:
                    "FAILURE",
                clientKey,
                message:
                    "Admin login was temporarily blocked by the rate limiter.",
                metadata: {
                    retryAfterSeconds:
                        rateLimit.retryAfterSeconds,
                },
            });

            const response =
                NextResponse.json(
                    {
                        success: false,
                        error:
                            "Too many failed sign-in attempts. Please try again later.",
                    },
                    {
                        status: 429,
                    }
                );

            response.headers.set(
                "Retry-After",
                String(
                    rateLimit.retryAfterSeconds
                )
            );

            return response;
        }

        const body =
            await request.json();

        const password =
            typeof body?.password ===
                "string"
                ? body.password
                : "";

        if (!password) {
            safeAudit({
                eventType:
                    "ADMIN_LOGIN_INVALID_REQUEST",
                outcome:
                    "FAILURE",
                clientKey,
                message:
                    "Admin login request did not include a password.",
            });

            return NextResponse.json(
                {
                    success: false,
                    error:
                        "Password is required.",
                },
                {
                    status: 400,
                }
            );
        }

        if (
            !verifyCurrentAdminPassword(
                password
            )
        ) {
            recordFailedAdminLogin(
                clientKey
            );

            safeAudit({
                eventType:
                    "ADMIN_LOGIN_FAILED",
                outcome:
                    "FAILURE",
                clientKey,
                message:
                    "Admin login failed because the credentials were invalid.",
            });

            return NextResponse.json(
                {
                    success: false,
                    error:
                        "Invalid credentials.",
                },
                {
                    status: 401,
                }
            );
        }

        clearAdminLoginFailures(
            clientKey
        );

        const session =
            createAdminSessionToken();

        safeAudit({
            eventType:
                "ADMIN_LOGIN_SUCCEEDED",
            outcome:
                "SUCCESS",
            clientKey,
            message:
                "Admin login succeeded.",
            metadata: {
                sessionVersion:
                    session.sessionVersion,
                expiresAt:
                    session.expiresAt,
            },
        });

        const response =
            NextResponse.json({
                success: true,
                redirectTo:
                    "/dashboard",
                expiresAt:
                    session.expiresAt,
            });

        response.cookies.set({
            name:
                ADMIN_SESSION_COOKIE,
            value:
                session.token,
            httpOnly:
                true,
            secure:
                isSecureCookie(),
            sameSite:
                "strict",
            path:
                "/",
            maxAge:
                session.maxAge,
            priority:
                "high",
        });

        return response;
    } catch (error) {
        console.error(
            "Admin login error:",
            error
        );

        safeAudit({
            eventType:
                "ADMIN_LOGIN_ERROR",
            outcome:
                "FAILURE",
            clientKey,
            message:
                "Admin login failed because of an internal error.",
        });

        return NextResponse.json(
            {
                success: false,
                error:
                    "Could not sign in.",
            },
            {
                status: 500,
            }
        );
    }
}
