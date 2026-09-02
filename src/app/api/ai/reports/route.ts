import {
    NextRequest,
    NextResponse,
} from "next/server";

import {
    listAiReports,
} from "@/lib/ai-reports";

import {
    hasAdminSession,
} from "@/lib/require-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: NextRequest
) {
    try {
        if (!(await hasAdminSession())) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Unauthorized.",
                    reports: [],
                },
                {
                    status: 401,
                }
            );
        }

        const rawLimit =
            request.nextUrl.searchParams.get(
                "limit"
            );

        const parsedLimit = rawLimit
            ? Number.parseInt(
                rawLimit,
                10
            )
            : 10;

        const reports = listAiReports(
            Number.isFinite(parsedLimit)
                ? parsedLimit
                : 10
        );

        return NextResponse.json(
            {
                success: true,
                count: reports.length,
                reports,
            },
            {
                headers: {
                    "Cache-Control":
                        "no-store",
                },
            }
        );
    } catch (error) {
        console.error(
            "AI reports error:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not read AI reports.",
                reports: [],
            },
            {
                status: 500,
            }
        );
    }
}
