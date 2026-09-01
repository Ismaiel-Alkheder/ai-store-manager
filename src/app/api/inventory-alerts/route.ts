import { NextResponse } from "next/server";
import db from "@/lib/database";
import { hasAdminSession } from "@/lib/require-admin";

export const runtime = "nodejs";

async function getAccessToken() {
    const shop = process.env.SHOPIFY_SHOP;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!shop || !clientId || !clientSecret) {
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
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: clientSecret,
            }),
        }
    );

    if (!response.ok) {
        throw new Error(
            "Could not get Shopify access token"
        );
    }

    const data = await response.json();

    return data.access_token;
}

async function getInventoryItemDetails(
    inventoryItemId: number,
    token: string
) {
    const shop = process.env.SHOPIFY_SHOP;

    if (!shop) {
        throw new Error("SHOPIFY_SHOP missing");
    }

    const query = `
    query InventoryItemDetails($id: ID!) {
      inventoryItem(id: $id) {
        id
        sku

        variant {
          id
          title

          product {
            id
            title
          }
        }
      }
    }
  `;

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

                variables: {
                    id:
                        `gid://shopify/InventoryItem/${inventoryItemId}`,
                },
            }),

            cache: "no-store",
        }
    );

    const result = await response.json();

    if (!response.ok) {
        throw new Error(
            `Shopify request failed: ${response.status}`
        );
    }

    if (result.errors) {
        throw new Error(
            JSON.stringify(result.errors)
        );
    }

    return result.data?.inventoryItem;
}

export async function GET() {
    try {
        if (!(await hasAdminSession())) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Unauthorized.",
                    alerts: [],
                },
                {
                    status: 401,
                }
            );
        }

        const rows: any[] = db
            .prepare(`
        SELECT *
        FROM inventory_alerts
        ORDER BY created_at DESC
      `)
            .all() as any[];

        const token = await getAccessToken();

        const alerts = await Promise.all(
            rows.map(async (row) => {
                try {
                    const item =
                        await getInventoryItemDetails(
                            row.inventory_item_id,
                            token
                        );

                    return {
                        id: row.id,

                        inventoryItemId:
                            row.inventory_item_id,

                        locationId:
                            row.location_id,

                        available:
                            row.available,

                        status:
                            row.status,

                        productTitle:
                            item?.variant?.product?.title ||
                            "Unknown product",

                        variantTitle:
                            item?.variant?.title ||
                            "Unknown variant",

                        sku:
                            item?.sku ||
                            "No SKU",

                        productId:
                            item?.variant?.product?.id ||
                            null,

                        variantId:
                            item?.variant?.id ||
                            null,

                        createdAt:
                            row.created_at,

                        updatedAt:
                            row.updated_at,

                        resolvedAt:
                            row.resolved_at,
                    };
                } catch (error) {
                    console.error(
                        "Could not load inventory item:",
                        row.inventory_item_id,
                        error
                    );

                    return {
                        id: row.id,

                        inventoryItemId:
                            row.inventory_item_id,

                        locationId:
                            row.location_id,

                        available:
                            row.available,

                        status:
                            row.status,

                        productTitle:
                            "Could not load product",

                        variantTitle:
                            "Unknown",

                        sku:
                            "Unknown",

                        productId: null,
                        variantId: null,

                        createdAt:
                            row.created_at,

                        updatedAt:
                            row.updated_at,

                        resolvedAt:
                            row.resolved_at,
                    };
                }
            })
        );

        return NextResponse.json({
            source: "sqlite + shopify",
            alerts,
        });
    } catch (error) {
        console.error(
            "Inventory alerts error:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not read inventory alerts",

                alerts: [],
            },
            { status: 500 }
        );
    }
}
