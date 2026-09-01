import { NextResponse } from "next/server";
import { hasAdminSession } from "@/lib/require-admin";
import { denyDiagnosticRouteInProduction } from "@/lib/dev-only-route";

export const runtime = "nodejs";

async function getAccessToken() {
    const shop =
        process.env.SHOPIFY_SHOP;

    const clientId =
        process.env.SHOPIFY_CLIENT_ID;

    const clientSecret =
        process.env.SHOPIFY_CLIENT_SECRET;

    if (
        !shop ||
        !clientId ||
        !clientSecret
    ) {
        throw new Error(
            "Missing Shopify environment variables"
        );
    }

    const response =
        await fetch(
            `https://${shop}.myshopify.com/admin/oauth/access_token`,
            {
                method:
                    "POST",

                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded",
                },

                body:
                    new URLSearchParams({
                        grant_type:
                            "client_credentials",

                        client_id:
                            clientId,

                        client_secret:
                            clientSecret,
                    }),
            }
        );

    const data =
        await response.json();

    if (!response.ok) {
        throw new Error(
            `Could not get Shopify access token: ${response.status} ${JSON.stringify(
                data
            )}`
        );
    }

    return data.access_token;
}

async function shopifyGraphQL(
    query: string,
    variables: Record<
        string,
        unknown
    >
) {
    const shop =
        process.env.SHOPIFY_SHOP;

    if (!shop) {
        throw new Error(
            "SHOPIFY_SHOP missing"
        );
    }

    const token =
        await getAccessToken();

    const response =
        await fetch(
            `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
            {
                method:
                    "POST",

                headers: {
                    "Content-Type":
                        "application/json",

                    "X-Shopify-Access-Token":
                        token,
                },

                body:
                    JSON.stringify({
                        query,
                        variables,
                    }),

                cache:
                    "no-store",
            }
        );

    const result =
        await response.json();

    if (!response.ok) {
        throw new Error(
            `Shopify request failed: ${response.status} ${JSON.stringify(
                result
            )}`
        );
    }

    if (result.errors) {
        throw new Error(
            JSON.stringify(
                result.errors
            )
        );
    }

    return result.data;
}

export async function GET(
    request: Request
) {
    try {
        const productionBlock =
            denyDiagnosticRouteInProduction();

        if (productionBlock) {
            return productionBlock;
        }

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

        const url =
            new URL(
                request.url
            );

        const locationId =
            url.searchParams.get(
                "locationId"
            );

        if (!locationId) {
            return NextResponse.json(
                {
                    error:
                        "locationId is required.",
                },
                {
                    status:
                        400,
                }
            );
        }

        const gid =
            locationId.startsWith(
                "gid://shopify/Location/"
            )
                ? locationId
                : `gid://shopify/Location/${locationId}`;

        const data =
            await shopifyGraphQL(
                `
        query FulfillmentServicePreview(
          $id: ID!
        ) {
          location(
            id: $id
          ) {
            id
            name
            fulfillsOnlineOrders

            fulfillmentService {
              id
              serviceName
              handle
              callbackUrl
              type
              inventoryManagement
              trackingSupport
              requiresShippingMethod
            }
          }
        }
        `,
                {
                    id:
                        gid,
                }
            );

        if (
            !data?.location
        ) {
            return NextResponse.json(
                {
                    error:
                        "Location not found.",
                },
                {
                    status:
                        404,
                }
            );
        }

        return NextResponse.json({
            diagnosticOnly:
                true,

            location:
                data.location,
        });
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not inspect fulfillment service.",
            },
            {
                status:
                    500,
            }
        );
    }
}
