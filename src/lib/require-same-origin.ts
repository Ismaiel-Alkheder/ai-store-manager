function normalizeConfiguredOrigin(
    value: string | undefined
) {
    if (!value) {
        return null;
    }

    try {
        return new URL(
            value.trim()
        ).origin.toLowerCase();
    } catch {
        return null;
    }
}

function normalizeHeaderValue(
    value: string | null
) {
    if (!value) {
        return null;
    }

    return value
        .split(",")[0]
        .trim()
        .toLowerCase();
}

function buildDevelopmentOrigins(
    request: Request
) {
    const allowedOrigins =
        new Set<string>();

    try {
        allowedOrigins.add(
            new URL(
                request.url
            ).origin.toLowerCase()
        );
    } catch {
        // Ignore malformed request URL.
    }

    const host =
        normalizeHeaderValue(
            request.headers.get(
                "host"
            )
        );

    const forwardedHost =
        normalizeHeaderValue(
            request.headers.get(
                "x-forwarded-host"
            )
        );

    const forwardedProto =
        normalizeHeaderValue(
            request.headers.get(
                "x-forwarded-proto"
            )
        );

    if (host) {
        allowedOrigins.add(
            `http://${host}`
        );

        allowedOrigins.add(
            `https://${host}`
        );
    }

    if (forwardedHost) {
        const proto =
            forwardedProto ===
                "http" ||
                forwardedProto ===
                "https"
                ? forwardedProto
                : "https";

        allowedOrigins.add(
            `${proto}://${forwardedHost}`
        );
    }

    return allowedOrigins;
}

export function isSameOriginAdminRequest(
    request: Request
) {
    const originHeader =
        request.headers.get(
            "origin"
        );

    if (!originHeader) {
        return false;
    }

    let requestOrigin: string;

    try {
        requestOrigin =
            new URL(
                originHeader
            ).origin.toLowerCase();
    } catch {
        return false;
    }

    const configuredOrigin =
        normalizeConfiguredOrigin(
            process.env
                .ADMIN_PUBLIC_ORIGIN
        );

    if (configuredOrigin) {
        return (
            requestOrigin ===
            configuredOrigin
        );
    }

    /*
      Production must use an explicitly configured
      admin origin. This prevents the admin security
      check from trusting a runtime Host header as
      the source of truth.
    */
    if (
        process.env.NODE_ENV ===
        "production"
    ) {
        return false;
    }

    return buildDevelopmentOrigins(
        request
    ).has(requestOrigin);
}
