import { NextResponse } from "next/server";

/*
  Diagnostic and test-only routes can call this helper
  at the very start of their handler.

  In production they behave as if the route does not exist.
  In development the helper returns null and the route
  continues normally.
*/
export function denyDiagnosticRouteInProduction() {
    if (
        process.env.NODE_ENV ===
        "production"
    ) {
        return NextResponse.json(
            {
                error: "Not found.",
            },
            {
                status: 404,
            }
        );
    }

    return null;
}
