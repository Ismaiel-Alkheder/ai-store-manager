import { NextResponse } from "next/server";
import { hasAdminSession } from "@/lib/require-admin";
import { denyDiagnosticRouteInProduction } from "@/lib/dev-only-route";

async function getAccessToken() {
    const shop = process.env.SHOPIFY_SHOP;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!shop || !clientId || !clientSecret) {
        throw new Error("Missing Shopify environment variables.");
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

    return data.access_token as string;
}

async function shopifyGraphQL(
    query: string,
    variables: Record<string, unknown>
) {
    const shop = process.env.SHOPIFY_SHOP;

    if (!shop) {
        throw new Error("SHOPIFY_SHOP is missing.");
    }

    const token = await getAccessToken();

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
            `Shopify GraphQL failed: ${response.status} ${JSON.stringify(result)}`
        );
    }

    if (result.errors) {
        throw new Error(
            JSON.stringify(result.errors)
        );
    }

    return result.data;
}

export async function GET(request: Request) {
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

        const url = new URL(request.url);

        const orderId =
            url.searchParams.get(
                "orderId"
            );

        if (
            !orderId ||
            !/^\d+$/.test(orderId)
        ) {
            return NextResponse.json(
                {
                    error:
                        "Provide a numeric Shopify orderId query parameter.",
                },
                {
                    status: 400,
                }
            );
        }

        const data =
            await shopifyGraphQL(
                `
      query FulfillmentActionPreview($orderId: ID!) {
        order(id: $orderId) {
          id
          name
          displayFinancialStatus
          displayFulfillmentStatus
          fulfillmentOrders(first: 50) {
            nodes {
              id
              status
              requestStatus
              assignedLocation {
                name
                location { id }
              }
              supportedActions {
                action
                externalUrl
              }
              lineItems(first: 100) {
                nodes {
                  id
                  remainingQuantity
                  productTitle
                  variantTitle
                  sku
                }
              }
            }
          }
        }
      }
      `,
                {
                    orderId:
                        `gid://shopify/Order/${orderId}`,
                }
            );

        const order =
            data?.order;

        if (!order) {
            return NextResponse.json(
                {
                    error:
                        "Order not found.",
                },
                {
                    status: 404,
                }
            );
        }

        const fulfillmentOrders =
            (
                order.fulfillmentOrders
                    ?.nodes || []
            ).map((fo: any) => {
                const actions =
                    (
                        fo.supportedActions ||
                        []
                    ).map(
                        (item: any) =>
                            item.action
                    );

                const remainingQuantity =
                    (
                        fo.lineItems
                            ?.nodes || []
                    ).reduce(
                        (
                            total: number,
                            item: any
                        ) =>
                            total +
                            Number(
                                item.remainingQuantity ||
                                0
                            ),
                        0
                    );

                return {
                    id:
                        fo.id,

                    status:
                        fo.status,

                    requestStatus:
                        fo.requestStatus,

                    assignedLocation:
                        fo.assignedLocation
                            ?.name ||
                        null,

                    supportedActions:
                        fo.supportedActions ||
                        [],

                    supportsRequestFulfillment:
                        actions.includes(
                            "REQUEST_FULFILLMENT"
                        ),

                    supportsCreateFulfillment:
                        actions.includes(
                            "CREATE_FULFILLMENT"
                        ),

                    remainingQuantity,
                };
            });

        return NextResponse.json({
            diagnosticOnly: true,

            order: {
                id:
                    order.id,

                name:
                    order.name,

                financialStatus:
                    order.displayFinancialStatus,

                fulfillmentStatus:
                    order.displayFulfillmentStatus,
            },

            fulfillmentOrders,
        });
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not inspect fulfillment actions.",
            },
            {
                status: 500,
            }
        );
    }
}
