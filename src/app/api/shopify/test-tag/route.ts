import { NextResponse } from "next/server";

import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";
import { denyDiagnosticRouteInProduction } from "@/lib/dev-only-route";

async function getAccessToken() {
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

    if (!response.ok) {
        throw new Error("Could not get Shopify access token");
    }

    const data = await response.json();

    return data.access_token;
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

        const shop = process.env.SHOPIFY_SHOP;

        if (!shop) {
            throw new Error("SHOPIFY_SHOP missing");
        }

        const token = await getAccessToken();

        // Get newest order
        const orderQuery = `
      query {
        orders(first: 1, reverse: true) {
          nodes {
            id
            name
            tags
          }
        }
      }
    `;

        const orderResponse = await fetch(
            `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Shopify-Access-Token": token,
                },
                body: JSON.stringify({
                    query: orderQuery,
                }),
            }
        );

        const orderResult = await orderResponse.json();

        if (orderResult.errors) {
            return NextResponse.json(
                {
                    step: "get-order",
                    errors: orderResult.errors,
                },
                { status: 500 }
            );
        }

        const order =
            orderResult.data?.orders?.nodes?.[0];

        if (!order) {
            return NextResponse.json(
                {
                    error: "No order found",
                },
                { status: 404 }
            );
        }

        // Add tag
        const mutation = `
      mutation AddTag($id: ID!, $tags: [String!]!) {
        tagsAdd(
          id: $id
          tags: $tags
        ) {
          node {
            id
          }

          userErrors {
            field
            message
          }
        }
      }
    `;

        const tagResponse = await fetch(
            `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Shopify-Access-Token": token,
                },
                body: JSON.stringify({
                    query: mutation,
                    variables: {
                        id: order.id,
                        tags: [
                            "AI_APPROVED_FOR_FULFILLMENT",
                        ],
                    },
                }),
            }
        );

        const tagResult = await tagResponse.json();

        return NextResponse.json({
            order: order.name,
            orderId: order.id,
            previousTags: order.tags,
            result: tagResult,
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
