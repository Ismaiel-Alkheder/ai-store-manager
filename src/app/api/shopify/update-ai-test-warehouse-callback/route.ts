import { NextResponse } from "next/server";



import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

export const runtime = "nodejs";

const SERVICE_NAME = "AI Test Warehouse";

async function getAccessToken(): Promise<string> {
    const shop = process.env.SHOPIFY_SHOP;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!shop || !clientId || !clientSecret) {
        throw new Error("Missing Shopify environment variables");
    }

    const response = await fetch(
        `https://${shop}.myshopify.com/admin/oauth/access_token`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: clientSecret,
            }),
        }
    );

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            `Could not get Shopify access token: ${response.status} ${JSON.stringify(data)}`
        );
    }

    const token = data?.access_token;

    if (typeof token !== "string" || !token) {
        throw new Error("Shopify access token missing from response");
    }

    return token;
}

async function shopifyGraphQL(
    query: string,
    variables: Record<string, unknown>,
    token: string
) {
    const shop = process.env.SHOPIFY_SHOP;

    if (!shop) {
        throw new Error("SHOPIFY_SHOP missing");
    }

    const response = await fetch(
        `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": token,
            },
            body: JSON.stringify({
                query,
                variables,
            }),
            cache: "no-store",
        }
    );

    const result = await response.json();

    if (!response.ok) {
        throw new Error(
            `Shopify request failed: ${response.status} ${JSON.stringify(result)}`
        );
    }

    if (result.errors) {
        throw new Error(JSON.stringify(result.errors));
    }

    return result.data;
}

async function findAiTestWarehouse(token: string) {
    const data = await shopifyGraphQL(
        `
      query FulfillmentServices {
        shop {
          fulfillmentServices {
            id
            serviceName
            handle
            callbackUrl
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

    const services = data?.shop?.fulfillmentServices ?? [];

    return services.find(
        (service: { serviceName?: string }) =>
            service.serviceName === SERVICE_NAME
    );
}

async function updateCallback(
    id: string,
    callbackUrl: string,
    token: string
) {
    const data = await shopifyGraphQL(
        `
      mutation UpdateFulfillmentService(
        $id: ID!
        $name: String!
        $callbackUrl: URL!
      ) {
        fulfillmentServiceUpdate(
          id: $id
          name: $name
          callbackUrl: $callbackUrl
          inventoryManagement: false
          trackingSupport: false
          requiresShippingMethod: true
        ) {
          fulfillmentService {
            id
            serviceName
            handle
            callbackUrl
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
            name: SERVICE_NAME,
            callbackUrl,
        },
        token
    );

    const result = data?.fulfillmentServiceUpdate;
    const userErrors = result?.userErrors ?? [];

    if (userErrors.length > 0) {
        throw new Error(
            userErrors
                .map((item: { message?: string }) => item.message || "Unknown Shopify error")
                .join("; ")
        );
    }

    if (!result?.fulfillmentService) {
        throw new Error("Shopify did not return the updated fulfillment service");
    }

    return result.fulfillmentService;
}

export async function POST(request: Request) {
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

        if (!isSameOriginAdminRequest(request)) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Invalid request origin.",
                },
                {
                    status: 403,
                }
            );
        }

        const rawBaseUrl = process.env.WEBHOOK_BASE_URL;

        if (!rawBaseUrl) {
            return NextResponse.json(
                {
                    success: false,
                    error: "WEBHOOK_BASE_URL missing",
                },
                {
                    status: 500,
                }
            );
        }

        const baseUrl = rawBaseUrl.trim().replace(/\/+$/, "");
        const callbackUrl = `${baseUrl}/api/fulfillment-service`;

        new URL(callbackUrl);

        const token = await getAccessToken();
        const existing = await findAiTestWarehouse(token);

        if (!existing) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        "AI Test Warehouse was not found. No new fulfillment service was created.",
                },
                {
                    status: 404,
                }
            );
        }

        if (existing.callbackUrl === callbackUrl) {
            return NextResponse.json({
                success: true,
                action: "ALREADY_CURRENT",
                callbackUrl,
                notificationEndpoint:
                    `${callbackUrl}/fulfillment_order_notification`,
                service: existing,
            });
        }

        const previousCallbackUrl = existing.callbackUrl;
        const service = await updateCallback(
            existing.id,
            callbackUrl,
            token
        );

        return NextResponse.json({
            success: true,
            action: "UPDATED",
            previousCallbackUrl,
            callbackUrl,
            notificationEndpoint:
                `${callbackUrl}/fulfillment_order_notification`,
            service,
        });
    } catch (error) {
        console.error(
            "Update AI Test Warehouse callback error:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not update AI Test Warehouse callback",
            },
            {
                status: 500,
            }
        );
    }
}

