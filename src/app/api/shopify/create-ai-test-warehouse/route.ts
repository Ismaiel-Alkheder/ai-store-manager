import {
    NextResponse,
} from "next/server";

import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";
import { denyDiagnosticRouteInProduction } from "@/lib/dev-only-route";

export const runtime =
    "nodejs";

const SERVICE_NAME =
    "AI Test Warehouse";

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
    >,
    token: string
) {
    const shop =
        process.env.SHOPIFY_SHOP;

    if (!shop) {
        throw new Error(
            "SHOPIFY_SHOP missing"
        );
    }

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

async function listServices(
    token: string
) {
    const data =
        await shopifyGraphQL(
            `
      query FulfillmentServices {
        shop {
          fulfillmentServices {
            id
            serviceName
            handle
            callbackUrl
            type
            inventoryManagement
            trackingSupport
            requiresShippingMethod

            location {
              id
              name
            }
          }
        }
      }
      `,
            {},
            token
        );

    return data
        ?.shop
        ?.fulfillmentServices ||
        [];
}

async function updateService(
    id: string,
    callbackUrl: string,
    token: string
) {
    const data =
        await shopifyGraphQL(
            `
      mutation UpdateFulfillmentService(
        $id: ID!,
        $name: String!,
        $callbackUrl: URL!
      ) {
        fulfillmentServiceUpdate(
          id: $id,
          name: $name,
          callbackUrl: $callbackUrl,
          inventoryManagement: false,
          trackingSupport: false,
          requiresShippingMethod: true
        ) {
          fulfillmentService {
            id
            serviceName
            handle
            callbackUrl
            type
            inventoryManagement
            trackingSupport
            requiresShippingMethod

            location {
              id
              name
            }
          }

          userErrors {
            field
            message
          }
        }
      }
      `,
            {
                id,
                name:
                    SERVICE_NAME,
                callbackUrl,
            },
            token
        );

    const result =
        data
            ?.fulfillmentServiceUpdate;

    const userErrors =
        result
            ?.userErrors ||
        [];

    if (
        userErrors.length >
        0
    ) {
        throw new Error(
            userErrors
                .map(
                    (
                        item: any
                    ) =>
                        item.message
                )
                .join(
                    "; "
                )
        );
    }

    return result
        ?.fulfillmentService;
}

async function createService(
    callbackUrl: string,
    token: string
) {
    const data =
        await shopifyGraphQL(
            `
      mutation CreateFulfillmentService(
        $name: String!,
        $callbackUrl: URL!
      ) {
        fulfillmentServiceCreate(
          name: $name,
          callbackUrl: $callbackUrl,
          inventoryManagement: false,
          trackingSupport: false,
          requiresShippingMethod: true
        ) {
          fulfillmentService {
            id
            serviceName
            handle
            callbackUrl
            type
            inventoryManagement
            trackingSupport
            requiresShippingMethod

            location {
              id
              name
            }
          }

          userErrors {
            field
            message
          }
        }
      }
      `,
            {
                name:
                    SERVICE_NAME,

                callbackUrl,
            },
            token
        );

    const result =
        data
            ?.fulfillmentServiceCreate;

    const userErrors =
        result
            ?.userErrors ||
        [];

    if (
        userErrors.length >
        0
    ) {
        throw new Error(
            userErrors
                .map(
                    (
                        item: any
                    ) =>
                        item.message
                )
                .join(
                    "; "
                )
        );
    }

    return result
        ?.fulfillmentService;
}

export async function POST(request: Request) {
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

        if (!isSameOriginAdminRequest(request)) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Invalid request origin.",
                },
                { status: 403 }
            );
        }

        const rawBaseUrl =
            process.env
                .WEBHOOK_BASE_URL;

        if (!rawBaseUrl) {
            return NextResponse.json(
                {
                    success:
                        false,

                    error:
                        "WEBHOOK_BASE_URL missing",
                },
                {
                    status:
                        500,
                }
            );
        }

        const baseUrl =
            rawBaseUrl
                .trim()
                .replace(
                    /\/+$/,
                    ""
                );

        /*
          Shopify appends:
          /fulfillment_order_notification
        */
        const callbackUrl =
            `${baseUrl}/api/fulfillment-service`;

        new URL(
            callbackUrl
        );

        const token =
            await getAccessToken();

        const existingServices =
            await listServices(
                token
            );

        const existing =
            existingServices.find(
                (
                    item: any
                ) =>
                    item
                        .serviceName ===
                    SERVICE_NAME
            );

        let service:
            any;

        let action:
            "CREATED" |
            "KEPT_EXISTING" |
            "UPDATED";

        if (!existing) {
            service =
                await createService(
                    callbackUrl,
                    token
                );

            action =
                "CREATED";
        } else {
            const needsUpdate =
                existing
                    .callbackUrl !==
                callbackUrl ||
                existing
                    .inventoryManagement !==
                false ||
                existing
                    .trackingSupport !==
                false ||
                existing
                    .requiresShippingMethod !==
                true;

            if (
                needsUpdate
            ) {
                service =
                    await updateService(
                        existing.id,
                        callbackUrl,
                        token
                    );

                action =
                    "UPDATED";
            } else {
                service =
                    existing;

                action =
                    "KEPT_EXISTING";
            }
        }

        return NextResponse.json({
            success:
                true,

            action,

            callbackUrl,

            notificationEndpoint:
                `${callbackUrl}/fulfillment_order_notification`,

            service,
        });
    } catch (error) {
        return NextResponse.json(
            {
                success:
                    false,

                error:
                    error instanceof Error
                        ? error.message
                        : "Could not create AI Test Warehouse",
            },
            {
                status:
                    500,
            }
        );
    }
}
