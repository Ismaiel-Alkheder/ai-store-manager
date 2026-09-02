import { NextResponse } from "next/server";

import { hasAdminSession } from "@/lib/require-admin";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

type ShopifyOrder = {
    test: boolean;
    tags: string[];
};

function getAnalyticsStartDate() {
    const value =
        process.env.ANALYTICS_START_DATE;

    if (!value) {
        throw new Error(
            "ANALYTICS_START_DATE is missing."
        );
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        throw new Error(
            "ANALYTICS_START_DATE is invalid."
        );
    }

    return date.toISOString();
}

function hasTestTag(order: ShopifyOrder) {
    const testTags = new Set([
        "test",
        "ai-test",
        "ai_test",
        "development",
        "demo",
    ]);

    return (order.tags || []).some(tag =>
        testTags.has(
            tag.trim().toLowerCase()
        )
    );
}

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

        const analyticsStartDate =
            getAnalyticsStartDate();

        const accessToken =
            await getAccessToken();

        const query = `
          query GetProductionOrders(
            $searchQuery: String!
          ) {
            orders(
              first: 250
              reverse: true
              sortKey: CREATED_AT
              query: $searchQuery
            ) {
              nodes {
                id
                name
                createdAt
                test
                tags
                sourceName
                displayFinancialStatus
                displayFulfillmentStatus

                totalPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }

                lineItems(first: 50) {
                  nodes {
                    name
                    quantity
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
                    variables: {
                        searchQuery:
                            `created_at:>='${analyticsStartDate}'`,
                    },
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

        const fetchedOrders = (
            result.data?.orders
                ?.nodes || []
        ) as ShopifyOrder[];

        const excludedByTestFlag =
            fetchedOrders.filter(
                order =>
                    order.test === true
            ).length;

        const excludedByTestTag =
            fetchedOrders.filter(
                order =>
                    order.test !== true &&
                    hasTestTag(order)
            ).length;

        const orders =
            fetchedOrders.filter(
                order =>
                    order.test !== true &&
                    !hasTestTag(order)
            );

        return NextResponse.json({
            orders: {
                nodes: orders,

                pageInfo:
                    result.data
                        ?.orders
                        ?.pageInfo || {
                        hasNextPage: false,
                    },
            },

            dataQuality: {
                analyticsStartDate,

                fetchedOrders:
                    fetchedOrders.length,

                excludedByTestFlag,

                excludedByTestTag,

                truncated:
                    Boolean(
                        result.data
                            ?.orders
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
