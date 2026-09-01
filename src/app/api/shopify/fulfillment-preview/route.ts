import {
    NextRequest,
    NextResponse,
} from "next/server";

import { hasAdminSession } from "@/lib/require-admin";
import { denyDiagnosticRouteInProduction } from "@/lib/dev-only-route";

export const runtime = "nodejs";

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
  SHOPIFY GRAPHQL
*/

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
                variables,
            }),
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

    return result.data;
}

/*
  GET FULFILLMENT PREVIEW

  Example:

  /api/shopify/fulfillment-preview
  ?orderId=7640037523765
*/

export async function GET(
    request: NextRequest
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

        const orderId =
            request.nextUrl.searchParams.get(
                "orderId"
            );

        if (!orderId) {
            return NextResponse.json(
                {
                    error:
                        "orderId query parameter is required.",
                },
                { status: 400 }
            );
        }

        /*
          Accept either numeric ID:
    
          7640037523765
    
          or Shopify GID.
        */

        const orderGid =
            orderId.startsWith(
                "gid://shopify/Order/"
            )
                ? orderId
                : `gid://shopify/Order/${orderId}`;

        /*
          We intentionally do NOT request:
    
          customer
          shippingAddress
    
          because Fulfillment Preview does
          not need customer personal data.
        */

        const query = `
      query FulfillmentPreview(
        $orderId: ID!
      ) {
        order(id: $orderId) {
          id
          name
          createdAt

          displayFinancialStatus
          displayFulfillmentStatus

          fulfillmentOrders(
            first: 50
          ) {
            nodes {
              id

              status
              requestStatus

              createdAt
              updatedAt

              assignedLocation {
                name

                address1
                address2
                city
                province
                zip
                countryCode

                location {
                  id
                }
              }

              lineItems(
                first: 100
              ) {
                nodes {
                  id

                  totalQuantity
                  remainingQuantity

                  inventoryItemId

                  lineItem {
                    id
                    name
                    quantity
                    sku

                    variant {
                      id
                      title
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

        const data =
            await shopifyGraphQL(
                query,
                {
                    orderId:
                        orderGid,
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
                { status: 404 }
            );
        }

        const fulfillmentOrders =
            order.fulfillmentOrders
                ?.nodes || [];

        const fulfillmentPreview =
            fulfillmentOrders.map(
                (
                    fulfillmentOrder: any
                ) => {
                    const lineItems =
                        fulfillmentOrder
                            .lineItems
                            ?.nodes || [];

                    const remainingItems =
                        lineItems.filter(
                            (item: any) =>
                                Number(
                                    item.remainingQuantity
                                ) > 0
                        );

                    const remainingQuantity =
                        remainingItems.reduce(
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
                            fulfillmentOrder.id,

                        status:
                            fulfillmentOrder.status,

                        requestStatus:
                            fulfillmentOrder
                                .requestStatus,

                        createdAt:
                            fulfillmentOrder
                                .createdAt,

                        updatedAt:
                            fulfillmentOrder
                                .updatedAt,

                        assignedLocation: {
                            name:
                                fulfillmentOrder
                                    .assignedLocation
                                    ?.name ||
                                "Unknown location",

                            locationId:
                                fulfillmentOrder
                                    .assignedLocation
                                    ?.location
                                    ?.id ||
                                null,

                            address1:
                                fulfillmentOrder
                                    .assignedLocation
                                    ?.address1 ||
                                null,

                            address2:
                                fulfillmentOrder
                                    .assignedLocation
                                    ?.address2 ||
                                null,

                            city:
                                fulfillmentOrder
                                    .assignedLocation
                                    ?.city ||
                                null,

                            province:
                                fulfillmentOrder
                                    .assignedLocation
                                    ?.province ||
                                null,

                            zip:
                                fulfillmentOrder
                                    .assignedLocation
                                    ?.zip ||
                                null,

                            countryCode:
                                fulfillmentOrder
                                    .assignedLocation
                                    ?.countryCode ||
                                null,
                        },

                        remainingQuantity,

                        hasRemainingItems:
                            remainingQuantity > 0,

                        lineItems:
                            lineItems.map(
                                (item: any) => ({
                                    fulfillmentOrderLineItemId:
                                        item.id,

                                    lineItemId:
                                        item.lineItem
                                            ?.id ||
                                        null,

                                    name:
                                        item.lineItem
                                            ?.name ||
                                        "Unknown item",

                                    sku:
                                        item.lineItem
                                            ?.sku ||
                                        "No SKU",

                                    variantTitle:
                                        item.lineItem
                                            ?.variant
                                            ?.title ||
                                        null,

                                    totalQuantity:
                                        Number(
                                            item.totalQuantity ||
                                            0
                                        ),

                                    remainingQuantity:
                                        Number(
                                            item.remainingQuantity ||
                                            0
                                        ),

                                    inventoryItemId:
                                        item.inventoryItemId,
                                })
                            ),
                    };
                }
            );

        const totalRemaining =
            fulfillmentPreview.reduce(
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

        return NextResponse.json({
            source:
                "shopify",

            previewOnly:
                true,

            order: {
                id:
                    order.id,

                name:
                    order.name,

                createdAt:
                    order.createdAt,

                financialStatus:
                    order.displayFinancialStatus,

                fulfillmentStatus:
                    order.displayFulfillmentStatus,
            },

            summary: {
                fulfillmentOrderCount:
                    fulfillmentPreview.length,

                totalRemainingQuantity:
                    totalRemaining,

                hasItemsToFulfill:
                    totalRemaining > 0,
            },

            fulfillmentOrders:
                fulfillmentPreview,
        });
    } catch (error) {
        console.error(
            "Fulfillment preview error:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not load fulfillment preview.",
            },
            { status: 500 }
        );
    }
}