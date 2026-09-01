import { NextResponse } from "next/server";

import {
    ADMIN_SESSION_COOKIE,
    isSecureCookie,
} from "@/lib/admin-auth";

import {
    changeAdminPassword,
    validateNewAdminPassword,
    verifyCurrentAdminPassword,
} from "@/lib/admin-credentials";

import {
    hasAdminSession,
} from "@/lib/require-admin";

import {
    isSameOriginAdminRequest,
} from "@/lib/require-same-origin";

import {
    recordAdminAuditEvent,
} from "@/lib/admin-audit";

export const runtime = "nodejs";

function safeAudit(
    input: Parameters<typeof recordAdminAuditEvent>[0]
) {
    try {
        recordAdminAuditEvent(input);
    } catch (error) {
        console.error("Admin audit log write failed:", error);
    }
}

export async function POST(request: Request) {
    try {
        if (!(await hasAdminSession())) {
            safeAudit({
                eventType: "ADMIN_PASSWORD_CHANGE_UNAUTHORIZED",
                outcome: "FAILURE",
                message:
                    "Password change was rejected because no valid admin session was present.",
            });

            return NextResponse.json(
                {
                    success: false,
                    error: "Unauthorized.",
                },
                { status: 401 }
            );
        }

        if (!isSameOriginAdminRequest(request)) {
            safeAudit({
                eventType: "ADMIN_PASSWORD_CHANGE_ORIGIN_REJECTED",
                outcome: "FAILURE",
                message:
                    "Password change was rejected because the request origin was invalid.",
            });

            return NextResponse.json(
                {
                    success: false,
                    error: "Invalid request origin.",
                },
                { status: 403 }
            );
        }

        const body = await request.json();

        const currentPassword =
            typeof body?.currentPassword === "string"
                ? body.currentPassword
                : "";

        const newPassword =
            typeof body?.newPassword === "string"
                ? body.newPassword
                : "";

        const confirmPassword =
            typeof body?.confirmPassword === "string"
                ? body.confirmPassword
                : "";

        if (!currentPassword || !newPassword || !confirmPassword) {
            safeAudit({
                eventType: "ADMIN_PASSWORD_CHANGE_INVALID_REQUEST",
                outcome: "FAILURE",
                message:
                    "Password change request was missing one or more required fields.",
            });

            return NextResponse.json(
                {
                    success: false,
                    error:
                        "Current password, new password, and confirmation are required.",
                },
                { status: 400 }
            );
        }

        if (!verifyCurrentAdminPassword(currentPassword)) {
            safeAudit({
                eventType: "ADMIN_PASSWORD_CHANGE_CURRENT_PASSWORD_FAILED",
                outcome: "FAILURE",
                message:
                    "Password change failed because the current password was incorrect.",
            });

            return NextResponse.json(
                {
                    success: false,
                    error: "Current password is incorrect.",
                },
                { status: 401 }
            );
        }

        if (newPassword !== confirmPassword) {
            safeAudit({
                eventType: "ADMIN_PASSWORD_CHANGE_CONFIRMATION_MISMATCH",
                outcome: "FAILURE",
                message:
                    "Password change failed because the new password confirmation did not match.",
            });

            return NextResponse.json(
                {
                    success: false,
                    error: "New password and confirmation do not match.",
                },
                { status: 400 }
            );
        }

        if (currentPassword === newPassword) {
            safeAudit({
                eventType: "ADMIN_PASSWORD_CHANGE_REUSED_PASSWORD",
                outcome: "FAILURE",
                message:
                    "Password change failed because the new password matched the current password.",
            });

            return NextResponse.json(
                {
                    success: false,
                    error:
                        "The new password must be different from the current password.",
                },
                { status: 400 }
            );
        }

        const policyError = validateNewAdminPassword(newPassword);

        if (policyError) {
            safeAudit({
                eventType: "ADMIN_PASSWORD_CHANGE_POLICY_REJECTED",
                outcome: "FAILURE",
                message:
                    "Password change failed because the new password did not meet the password policy.",
            });

            return NextResponse.json(
                {
                    success: false,
                    error: policyError,
                },
                { status: 400 }
            );
        }

        changeAdminPassword(newPassword);

        safeAudit({
            eventType: "ADMIN_PASSWORD_CHANGED",
            outcome: "SUCCESS",
            message:
                "Admin password was changed successfully and previous sessions were invalidated.",
        });

        const response = NextResponse.json({
            success: true,
            signedOut: true,
            redirectTo: "/login?passwordChanged=1",
        });

        response.cookies.set({
            name: ADMIN_SESSION_COOKIE,
            value: "",
            httpOnly: true,
            secure: isSecureCookie(),
            sameSite: "strict",
            path: "/",
            maxAge: 0,
            priority: "high",
        });

        return response;
    } catch (error) {
        console.error("Admin password change error:", error);

        safeAudit({
            eventType: "ADMIN_PASSWORD_CHANGE_ERROR",
            outcome: "FAILURE",
            message:
                "Password change failed because of an internal error.",
        });

        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not change admin password.",
            },
            { status: 500 }
        );
    }
}
