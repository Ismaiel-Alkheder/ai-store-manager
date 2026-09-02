import { NextResponse } from "next/server";
import db from "@/lib/database";
import { hasAdminSession } from "@/lib/require-admin";

export const runtime = "nodejs";

type ShopifyOrder = {
    id: string;
    name: string;
    createdAt: string;
    test: boolean;
    tags: string[];
    sourceName: string | null;
    displayFinancialStatus: string;
    displayFulfillmentStatus: string;
    totalPriceSet?: {
        shopMoney?: {
            amount?: string;
            currencyCode?: string;
        };
    };
    lineItems?: {
        nodes?: Array<{
            name: string;
            quantity: number;
        }>;
    };
};

/*
  ANALYTICS CONFIGURATION
*/

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
            "ANALYTICS_START_DATE is invalid. Use an ISO date such as 2026-09-02T00:00:00Z."
        );
    }

    return date.toISOString();
}

/*
  SHOPIFY ACCESS TOKEN
*/

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

    const response = await fetch(
        `https://${shop}.myshopify.com/admin/oauth/access_token`,
        {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/x-www-form-urlencoded",
            },

            body: new URLSearchParams({
                grant_type:
                    "client_credentials",

                client_id:
                    clientId,

                client_secret:
                    clientSecret,
            }),

            cache: "no-store",
        }
    );

    if (!response.ok) {
        throw new Error(
            "Could not get Shopify access token"
        );
    }

    const data =
        await response.json();

    return data.access_token;
}

/*
  SHOPIFY ORDERS
*/

async function getOrders(
    analyticsStartDate: string
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

    const query = `
    query StoreAnalyticsOrders(
      $searchQuery: String!
    ) {
      orders(
        first: 250,
        reverse: true,
        sortKey: CREATED_AT,
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
                    token,
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
            `Shopify request failed: ${response.status}`
        );
    }

    if (result.errors) {
        throw new Error(
            JSON.stringify(
                result.errors
            )
        );
    }

    return {
        orders: (
            result.data?.orders
                ?.nodes || []
        ) as ShopifyOrder[],

        hasNextPage: Boolean(
            result.data?.orders
                ?.pageInfo
                ?.hasNextPage
        ),
    };
}

function hasTestTag(order: ShopifyOrder) {
    const testTags = new Set([
        "test",
        "ai-test",
        "ai_test",
        "development",
        "demo",
    ]);

    return (order.tags || []).some(
        tag =>
            testTags.has(
                tag.trim().toLowerCase()
            )
    );
}

/*
  ANALYTICS
*/

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

        const analyticsStartDate =
            getAnalyticsStartDate();

        const shopifyResult =
            await getOrders(
                analyticsStartDate
            );

        const fetchedOrders =
            shopifyResult.orders;

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

        const orderCount =
            orders.length;

        /*
          ORDER VALUE
        */

        const totalOrderValue =
            orders.reduce(
                (total, order) => {
                    return (
                        total +
                        Number(
                            order.totalPriceSet
                                ?.shopMoney
                                ?.amount || 0
                        )
                    );
                },
                0
            );

        const averageOrderValue =
            orderCount > 0
                ? totalOrderValue /
                orderCount
                : 0;

        /*
          PAID ORDERS
        */

        const paidOrders =
            orders.filter(
                order =>
                    order.displayFinancialStatus ===
                    "PAID"
            );

        /*
          PAID ORDERS THAT NEED FULFILLMENT
        */

        const needsFulfillment =
            orders.filter(
                order =>
                    order.displayFinancialStatus ===
                        "PAID" &&
                    order.displayFulfillmentStatus !==
                        "FULFILLED"
            );

        /*
          PRODUCT SALES BY UNIT
        */

        const productUnits =
            new Map<string, number>();

        for (const order of orders) {
            const lineItems =
                order.lineItems
                    ?.nodes || [];

            for (const item of lineItems) {
                const current =
                    productUnits.get(
                        item.name
                    ) || 0;

                productUnits.set(
                    item.name,
                    current +
                        Number(
                            item.quantity || 0
                        )
                );
            }
        }

        const topProducts =
            Array.from(
                productUnits.entries()
            )
                .map(
                    ([
                        productName,
                        unitsSold,
                    ]) => ({
                        productName,
                        unitsSold,
                    })
                )
                .sort(
                    (a, b) =>
                        b.unitsSold -
                        a.unitsSold
                )
                .slice(0, 5);

        /*
          SQLITE INVENTORY STATUS
        */

        const openInventoryAlerts:
            any = db
                .prepare(`
        SELECT COUNT(*) AS count
        FROM inventory_alerts
        WHERE status = 'OPEN'
      `)
                .get();

        const activeRestockTasks:
            any = db
                .prepare(`
        SELECT COUNT(*) AS count
        FROM restock_tasks
        WHERE status != 'COMPLETED'
      `)
                .get();

        const completedRestocks:
            any = db
                .prepare(`
        SELECT COUNT(*) AS count
        FROM restock_tasks
        WHERE status = 'COMPLETED'
      `)
                .get();

        const pendingApprovals:
            any = db
                .prepare(`
        SELECT
          (
            SELECT COUNT(*)
            FROM approvals
            WHERE status = 'PENDING'
          )
          +
          (
            SELECT COUNT(*)
            FROM inventory_approvals
            WHERE status = 'PENDING'
          )
          AS count
      `)
                .get();

        /*
          CURRENCY
        */

        const currency =
            orders[0]
                ?.totalPriceSet
                ?.shopMoney
                ?.currencyCode ||
            "USD";

        return NextResponse.json({
            source:
                "shopify + sqlite",

            analyticsStartDate,

            ordersAnalyzed:
                orderCount,

            dataQuality: {
                fetchedOrders:
                    fetchedOrders.length,

                excludedByTestFlag,

                excludedByTestTag,

                truncated:
                    shopifyResult.hasNextPage,
            },

            currency,

            sales: {
                totalOrderValue:
                    Number(
                        totalOrderValue.toFixed(
                            2
                        )
                    ),

                averageOrderValue:
                    Number(
                        averageOrderValue.toFixed(
                            2
                        )
                    ),

                paidOrders:
                    paidOrders.length,

                needsFulfillment:
                    needsFulfillment.length,
            },

            inventory: {
                openAlerts:
                    Number(
                        openInventoryAlerts
                            ?.count || 0
                    ),

                activeRestockTasks:
                    Number(
                        activeRestockTasks
                            ?.count || 0
                    ),

                completedRestocks:
                    Number(
                        completedRestocks
                            ?.count || 0
                    ),
            },

            approvals: {
                pending:
                    Number(
                        pendingApprovals
                            ?.count || 0
                    ),
            },

            topProducts,

            generatedAt:
                new Date().toISOString(),
        });
    } catch (error) {
        console.error(
            "Store analytics error:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not generate store analytics",
            },
            { status: 500 }
        );
    }
}
