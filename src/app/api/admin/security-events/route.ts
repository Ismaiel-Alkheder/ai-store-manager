import {
    NextRequest,
    NextResponse,
} from "next/server";

import {
    getAdminAuditEvents,
} from "@/lib/admin-audit";

import {
    hasAdminSession,
} from "@/lib/require-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
    try {
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

        const rawLimit =
            request.nextUrl.searchParams.get("limit");

        const parsedLimit = rawLimit
            ? Number.parseInt(rawLimit, 10)
            : 50;

        const events = getAdminAuditEvents(
            Number.isFinite(parsedLimit)
                ? parsedLimit
                : 50
        );

        return NextResponse.json(
            {
                success: true,
                events,
            },
            {
                headers: {
                    "Cache-Control": "no-store",
                },
            }
        );
    } catch (error) {
        console.error(
            "Admin security events error:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                error:
                    "Could not load security events.",
            },
            {
                status: 500,
            }
        );
    }
}
