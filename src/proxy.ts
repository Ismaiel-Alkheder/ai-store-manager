import {
    NextRequest,
    NextResponse,
} from "next/server";

import {
    ADMIN_SESSION_COOKIE,
    verifyAdminSessionToken,
} from "@/lib/admin-auth";

export function proxy(
    request: NextRequest
) {
    const pathname =
        request.nextUrl.pathname;

    const token =
        request.cookies.get(
            ADMIN_SESSION_COOKIE
        )?.value;

    const authenticated =
        verifyAdminSessionToken(
            token
        );

    if (
        pathname ===
        "/login"
    ) {
        if (authenticated) {
            return NextResponse.redirect(
                new URL(
                    "/dashboard",
                    request.url
                )
            );
        }

        return NextResponse.next();
    }

    if (!authenticated) {
        const loginUrl =
            new URL(
                "/login",
                request.url
            );

        loginUrl.searchParams.set(
            "next",
            `${request.nextUrl.pathname}${request.nextUrl.search}`
        );

        return NextResponse.redirect(
            loginUrl
        );
    }

    return NextResponse.next();
}

export const config = {
    matcher: [
        "/dashboard/:path*",
        "/fulfillment/:path*",
        "/change-password/:path*",
        "/login",
    ],
};
