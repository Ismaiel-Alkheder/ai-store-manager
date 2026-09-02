import { NextResponse } from "next/server";

import db from "@/lib/database";
import { hasAdminSession } from "@/lib/require-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHOPIFY_API_VERSION = "2026-07";
const INVENTORY_ITEM_BATCH_SIZE = 100;

type InventoryAlertRow = {
    id: number;
    inventory_item_id: number;
    location_id: number;
    available: number;
    status: string;
    created_at: string;
    updated_at: string;
    resolved_at: string | null;
};

type InventoryItemNode = {
    id: string;
    sku: string | null;
    variants: {
        nodes: {
            id: string;
            title: string;
            product: {
                id: string;
                title: string;
            };
        }[];
    };
};

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
            `Shopify token request failed: ${response.status} ${text}`
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

    const expiresIn = Number(data?.expires_in);

    tokenExpiresAt =
        Date.now() +
        (Number.isFinite(expiresIn) && expiresIn > 0
            ? expiresIn * 1000
            : 60 * 60 * 1000);

    return data.access_token;
}

function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }

    return chunks;
}

async function getInventoryItemDetails(
    inventoryItemIds: number[],
    token: string
) {
    const shop = process.env.SHOPIFY_SHOP;

    if (!shop) {
        throw new Error("SHOPIFY_SHOP is missing.");
    }

    const query = `
      query InventoryItemDetails($ids: [ID!]!) {
        nodes(ids: $ids) {
          id
          ... on InventoryItem {
            sku
            variants(first: 1) {
              nodes {
                id
                title
                product {
                  id
                  title
                }
              }
            }
          }
        }
      }
    `;

    const itemById = new Map<string, InventoryItemNode>();
    let requestCount = 0;

    for (
        const idBatch of chunk(
            inventoryItemIds,
            INVENTORY_ITEM_BATCH_SIZE
        )
    ) {
        const ids = idBatch.map(
            (id) => `gid://shopify/InventoryItem/${id}`
        );

        const response = await fetch(
            `https://${shop}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Shopify-Access-Token": token,
                },
                body: JSON.stringify({
                    query,
                    variables: { ids },
                }),
                cache: "no-store",
            }
        );

        requestCount += 1;

        const result = await response.json();

        if (!response.ok) {
            throw new Error(
                `Shopify API request failed: ${response.status}`
            );
        }

        if (result.errors) {
            throw new Error(
                JSON.stringify(result.errors)
            );
        }

        const nodes = Array.isArray(result.data?.nodes)
            ? result.data.nodes
            : [];

        for (const node of nodes) {
            if (
                node &&
                typeof node.id === "string"
            ) {
                itemById.set(
                    node.id,
                    node as InventoryItemNode
                );
            }
        }
    }

    return {
        itemById,
        requestCount,
    };
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
                { status: 401 }
            );
        }

        const rows = db
            .prepare(`
              SELECT *
              FROM inventory_alerts
              ORDER BY created_at DESC
            `)
            .all() as InventoryAlertRow[];

        if (rows.length === 0) {
            return NextResponse.json(
                {
                    source: "sqlite + shopify",
                    count: 0,
                    openCount: 0,
                    alerts: [],
                    dataQuality: {
                        shopifyLookupRequests: 0,
                        missingItemDetails: 0,
                    },
                },
                {
                    headers: {
                        "Cache-Control": "no-store",
                    },
                }
            );
        }

        const uniqueInventoryItemIds = Array.from(
            new Set(
                rows.map(
                    (row) => row.inventory_item_id
                )
            )
        );

        const token = await getAccessToken();
        const {
            itemById,
            requestCount,
        } = await getInventoryItemDetails(
            uniqueInventoryItemIds,
            token
        );

        let missingItemDetails = 0;

        const alerts = rows.map((row) => {
            const gid =
                `gid://shopify/InventoryItem/${row.inventory_item_id}`;

            const item = itemById.get(gid);
            const variant = item?.variants?.nodes?.[0];

            if (!item || !variant) {
                missingItemDetails += 1;
            }

            return {
                id: row.id,
                inventoryItemId: row.inventory_item_id,
                locationId: row.location_id,
                available: row.available,
                status: row.status,
                productTitle:
                    variant?.product?.title ||
                    "Unknown product",
                variantTitle:
                    variant?.title ||
                    "Unknown variant",
                sku:
                    item?.sku ||
                    "No SKU",
                productId:
                    variant?.product?.id ||
                    null,
                variantId:
                    variant?.id ||
                    null,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                resolvedAt: row.resolved_at,
            };
        });

        return NextResponse.json(
            {
                source: "sqlite + shopify",
                count: alerts.length,
                openCount: alerts.filter(
                    (alert) => alert.status === "OPEN"
                ).length,
                alerts,
                dataQuality: {
                    shopifyLookupRequests:
                        requestCount,
                    missingItemDetails,
                },
            },
            {
                headers: {
                    "Cache-Control": "no-store",
                },
            }
        );
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
