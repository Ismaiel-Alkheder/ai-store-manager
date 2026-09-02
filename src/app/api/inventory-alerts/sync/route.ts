import { NextResponse } from "next/server";

import db from "@/lib/database";
import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOW_STOCK_LIMIT = 5;
const SHOPIFY_API_VERSION = "2026-07";

type InventoryLevelNode = {
    id: string;
    location: {
        id: string;
        name: string;
    };
    quantities: {
        name: string;
        quantity: number;
    }[];
};

type VariantNode = {
    id: string;
    title: string;
    sku: string | null;
    inventoryItem: {
        id: string;
        tracked: boolean;
        inventoryLevels: {
            nodes: InventoryLevelNode[];
            pageInfo: {
                hasNextPage: boolean;
            };
        };
    };
};

type ProductNode = {
    id: string;
    title: string;
    variants: {
        nodes: VariantNode[];
        pageInfo: {
            hasNextPage: boolean;
        };
    };
};

type ProductsPage = {
    nodes: ProductNode[];
    pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
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

async function shopifyGraphQL<T>(
    token: string,
    query: string,
    variables: Record<string, unknown>
): Promise<T> {
    const shop = process.env.SHOPIFY_SHOP;

    if (!shop) {
        throw new Error("SHOPIFY_SHOP is missing.");
    }

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
                variables,
            }),
            cache: "no-store",
        }
    );

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

    return result.data as T;
}

function numericIdFromGid(
    gid: string,
    resourceName: string
): number {
    const rawId = gid.split("/").at(-1);
    const numericId = Number(rawId);

    if (!Number.isSafeInteger(numericId)) {
        throw new Error(
            `Invalid ${resourceName} ID received from Shopify.`
        );
    }

    return numericId;
}

async function getPublishedProducts(
    token: string
) {
    const query = `
      query InventoryBaseline($after: String) {
        products(
          first: 5,
          after: $after,
          query: "status:active AND published_status:published"
        ) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            variants(first: 50) {
              pageInfo {
                hasNextPage
              }
              nodes {
                id
                title
                sku
                inventoryItem {
                  id
                  tracked
                  inventoryLevels(first: 10) {
                    pageInfo {
                      hasNextPage
                    }
                    nodes {
                      id
                      location {
                        id
                        name
                      }
                      quantities(names: ["available"]) {
                        name
                        quantity
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const products: ProductNode[] = [];
    let after: string | null = null;

    do {
        const data: {
            products: ProductsPage;
        } = await shopifyGraphQL(
            token,
            query,
            { after }
        );

        products.push(...data.products.nodes);

        after = data.products.pageInfo.hasNextPage
            ? data.products.pageInfo.endCursor
            : null;
    } while (after);

    return products;
}

export async function POST(request: Request) {
    try {
        if (!(await hasAdminSession())) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Unauthorized.",
                },
                { status: 401 }
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

        const token = await getAccessToken();
        const products = await getPublishedProducts(token);
        const now = new Date().toISOString();

        let variantsScanned = 0;
        let inventoryLevelsScanned = 0;
        let untrackedVariants = 0;
        let createdAlerts = 0;
        let updatedAlerts = 0;
        let resolvedAlerts = 0;
        let truncatedVariantLists = 0;
        let truncatedInventoryLevelLists = 0;

        const lowStock: {
            product: string;
            variant: string;
            sku: string | null;
            location: string;
            available: number;
        }[] = [];

        db.exec("BEGIN IMMEDIATE");

        try {
            for (const product of products) {
                if (product.variants.pageInfo.hasNextPage) {
                    truncatedVariantLists += 1;
                }

                for (const variant of product.variants.nodes) {
                    variantsScanned += 1;

                    if (!variant.inventoryItem.tracked) {
                        untrackedVariants += 1;
                        continue;
                    }

                    if (
                        variant.inventoryItem.inventoryLevels.pageInfo
                            .hasNextPage
                    ) {
                        truncatedInventoryLevelLists += 1;
                    }

                    const inventoryItemId = numericIdFromGid(
                        variant.inventoryItem.id,
                        "inventory item"
                    );

                    for (
                        const level of
                        variant.inventoryItem.inventoryLevels.nodes
                    ) {
                        inventoryLevelsScanned += 1;

                        const locationId = numericIdFromGid(
                            level.location.id,
                            "location"
                        );

                        const availableQuantity =
                            level.quantities.find(
                                (quantity) =>
                                    quantity.name === "available"
                            );

                        if (!availableQuantity) {
                            continue;
                        }

                        const available = Number(
                            availableQuantity.quantity
                        );

                        if (!Number.isFinite(available)) {
                            continue;
                        }

                        const existingAlert = db
                            .prepare(`
                              SELECT id
                              FROM inventory_alerts
                              WHERE inventory_item_id = ?
                              AND location_id = ?
                              AND status = 'OPEN'
                              LIMIT 1
                            `)
                            .get(
                                inventoryItemId,
                                locationId
                            ) as { id: number } | undefined;

                        if (available <= LOW_STOCK_LIMIT) {
                            lowStock.push({
                                product: product.title,
                                variant: variant.title,
                                sku: variant.sku,
                                location: level.location.name,
                                available,
                            });

                            if (existingAlert) {
                                db.prepare(`
                                  UPDATE inventory_alerts
                                  SET available = ?, updated_at = ?
                                  WHERE id = ?
                                `).run(
                                    available,
                                    now,
                                    existingAlert.id
                                );

                                updatedAlerts += 1;
                            } else {
                                db.prepare(`
                                  INSERT INTO inventory_alerts (
                                    inventory_item_id,
                                    location_id,
                                    available,
                                    status,
                                    created_at,
                                    updated_at,
                                    resolved_at
                                  )
                                  VALUES (?, ?, ?, 'OPEN', ?, ?, NULL)
                                `).run(
                                    inventoryItemId,
                                    locationId,
                                    available,
                                    now,
                                    now
                                );

                                createdAlerts += 1;
                            }
                        } else if (existingAlert) {
                            db.prepare(`
                              UPDATE inventory_alerts
                              SET
                                status = 'RESOLVED',
                                available = ?,
                                updated_at = ?,
                                resolved_at = ?
                              WHERE id = ?
                            `).run(
                                available,
                                now,
                                now,
                                existingAlert.id
                            );

                            db.prepare(`
                              UPDATE inventory_approvals
                              SET status = 'CANCELLED', decided_at = ?
                              WHERE inventory_alert_id = ?
                              AND status = 'PENDING'
                            `).run(
                                now,
                                existingAlert.id
                            );

                            resolvedAlerts += 1;
                        }
                    }
                }
            }

            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }

        return NextResponse.json({
            success: true,
            mode: "READ_ONLY_SHOPIFY",
            threshold: LOW_STOCK_LIMIT,
            productsScanned: products.length,
            variantsScanned,
            inventoryLevelsScanned,
            untrackedVariants,
            lowStockLevels: lowStock.length,
            createdAlerts,
            updatedAlerts,
            resolvedAlerts,
            dataQuality: {
                truncatedVariantLists,
                truncatedInventoryLevelLists,
            },
            lowStockPreview: lowStock.slice(0, 20),
            generatedAt: now,
        });
    } catch (error) {
        console.error(
            "Inventory baseline sync error:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not synchronize inventory alerts.",
            },
            { status: 500 }
        );
    }
}
