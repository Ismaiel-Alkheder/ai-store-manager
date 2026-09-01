import { NextResponse } from "next/server";

import {
    ADMIN_SESSION_COOKIE,
    isSecureCookie,
} from "@/lib/admin-auth";

import {
    recordAdminAuditEvent,
} from "@/lib/admin-audit";

import {
    hasAdminSession,
} from "@/lib/require-admin";

import {
    isSameOriginAdminRequest,
} from "@/lib/require-same-origin";

export const runtime = "nodejs";

function safeAudit(
    input: Parameters<typeof recordAdminAuditEvent>[0]
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

export async function POST(request: Request) {
    if (!isSameOriginAdminRequest(request)) {
        safeAudit({
            eventType: "ADMIN_LOGOUT_ORIGIN_REJECTED",
            outcome: "FAILURE",
            message:
                "Admin logout request was rejected because the request origin was invalid.",
        });

        return NextResponse.json(
            {
                success: false,
                error: "Invalid request origin.",
            },
            { status: 403 }
        );
    }

    const hadValidSession =
        await hasAdminSession();

    if (hadValidSession) {
        safeAudit({
            eventType: "ADMIN_LOGOUT_SUCCEEDED",
            outcome: "SUCCESS",
            message:
                "Admin logged out successfully.",
        });
    }

    const response = NextResponse.json({
        success: true,
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
}
