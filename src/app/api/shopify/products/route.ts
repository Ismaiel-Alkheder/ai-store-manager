import { NextResponse } from "next/server";

import { hasAdminSession } from "@/lib/require-admin";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
    const shop = process.env.SHOPIFY_SHOP;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!shop || !clientId || !clientSecret) {
        throw new Error(
            "Shopify environment variables are missing."
        );
    }

    if (
        cachedToken &&
        Date.now() < tokenExpiresAt - 60_000
    ) {
        return cachedToken;
    }

    const response = await fetch(
        `https://${shop}.myshopify.com/admin/oauth/access_token`,
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: clientSecret,
            }),
            cache: "no-store",
        }
    );

    if (!response.ok) {
        const text = await response.text();

        throw new Error(
            `Token request failed: ${response.status} ${text}`
        );
    }

    const data = await response.json();

    if (
        typeof data?.access_token !== "string" ||
        !data.access_token
    ) {
        throw new Error(
            "Shopify token response did not include a valid access token."
        );
    }

    cachedToken = data.access_token;

    const expiresIn =
        Number(data?.expires_in);

    tokenExpiresAt =
        Date.now() +
        (Number.isFinite(expiresIn) && expiresIn > 0
            ? expiresIn * 1000
            : 60 * 60 * 1000);

    return data.access_token;
}

export async function GET() {
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

        const shop =
            process.env.SHOPIFY_SHOP;

        if (!shop) {
            throw new Error(
                "SHOPIFY_SHOP is missing."
            );
        }

        const accessToken =
            await getAccessToken();

        const query = `
      query GetPublishedProducts {
        products(
          first: 100
          reverse: true
          sortKey: UPDATED_AT
          query: "status:active AND published_status:published"
        ) {
          nodes {
            id
            title
            handle
            status
            tags
            vendor
            productType
            publishedAt
            totalInventory
            tracksInventory
            description(truncateAt: 1200)

            variants(first: 100) {
              nodes {
                id
                title
                sku
                price
                compareAtPrice
                inventoryQuantity
                inventoryPolicy
              }
            }
          }

          pageInfo {
            hasNextPage
          }
        }
      }
    `;

        const response = await fetch(
            `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json",
                    "X-Shopify-Access-Token":
                        accessToken,
                },
                body: JSON.stringify({
                    query,
                }),
                cache: "no-store",
            }
        );

        const result =
            await response.json();

        if (!response.ok) {
            throw new Error(
                `Shopify API request failed: ${response.status}`
            );
        }

        if (result.errors) {
            return NextResponse.json(
                {
                    errors:
                        result.errors,
                },
                {
                    status: 500,
                }
            );
        }

        return NextResponse.json({
            products: {
                nodes:
                    result.data
                        ?.products
                        ?.nodes || [],

                pageInfo:
                    result.data
                        ?.products
                        ?.pageInfo || {
                        hasNextPage: false,
                    },
            },

            dataQuality: {
                filter:
                    "ACTIVE_AND_PUBLISHED",

                truncated:
                    Boolean(
                        result.data
                            ?.products
                            ?.pageInfo
                            ?.hasNextPage
                    ),
            },
        });
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Unknown error",
            },
            {
                status: 500,
            }
        );
    }
}
