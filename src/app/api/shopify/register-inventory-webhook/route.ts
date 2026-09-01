import { NextResponse } from "next/server";

import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

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

async function shopifyGraphQL(
    query: string,
    variables: Record<string, unknown> = {}
) {
    const shop = process.env.SHOPIFY_SHOP;

    if (!shop) {
        throw new Error("SHOPIFY_SHOP missing");
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
        }
    );

    const result = await response.json();

    if (result.errors) {
        throw new Error(
            JSON.stringify(result.errors)
        );
    }

    return result.data;
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

        const baseUrl =
            process.env.WEBHOOK_BASE_URL;

        if (!baseUrl) {
            throw new Error(
                "WEBHOOK_BASE_URL missing"
            );
        }

        const callbackUrl =
            `${baseUrl}/api/webhooks/inventory-update`;

        const existingData =
            await shopifyGraphQL(`
        query {
          webhookSubscriptions(
            first: 20,
            topics: INVENTORY_LEVELS_UPDATE
          ) {
            nodes {
              id
              topic
              uri
            }
          }
        }
      `);

        const existing =
            existingData.webhookSubscriptions.nodes;

        if (existing.length > 0) {
            const webhook = existing[0];

            const updateData =
                await shopifyGraphQL(
                    `
          mutation UpdateWebhook(
            $id: ID!,
            $webhookSubscription: WebhookSubscriptionInput!
          ) {
            webhookSubscriptionUpdate(
              id: $id,
              webhookSubscription: $webhookSubscription
            ) {
              webhookSubscription {
                id
                topic
                uri
              }

              userErrors {
                field
                message
              }
            }
          }
          `,
                    {
                        id: webhook.id,

                        webhookSubscription: {
                            uri: callbackUrl,
                        },
                    }
                );

            return NextResponse.json({
                success: true,
                action: "UPDATED",

                webhook:
                    updateData
                        .webhookSubscriptionUpdate
                        .webhookSubscription,

                userErrors:
                    updateData
                        .webhookSubscriptionUpdate
                        .userErrors,
            });
        }

        const createData =
            await shopifyGraphQL(
                `
        mutation CreateWebhook(
          $topic: WebhookSubscriptionTopic!,
          $webhookSubscription: WebhookSubscriptionInput!
        ) {
          webhookSubscriptionCreate(
            topic: $topic,
            webhookSubscription: $webhookSubscription
          ) {
            webhookSubscription {
              id
              topic
              uri
            }

            userErrors {
              field
              message
            }
          }
        }
        `,
                {
                    topic:
                        "INVENTORY_LEVELS_UPDATE",

                    webhookSubscription: {
                        uri: callbackUrl,
                    },
                }
            );

        return NextResponse.json({
            success: true,
            action: "CREATED",

            webhook:
                createData
                    .webhookSubscriptionCreate
                    .webhookSubscription,

            userErrors:
                createData
                    .webhookSubscriptionCreate
                    .userErrors,
        });
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not register inventory webhook",
            },
            {
                status: 500,
            }
        );
    }
}
