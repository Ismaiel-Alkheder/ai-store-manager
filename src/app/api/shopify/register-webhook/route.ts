import { NextResponse } from "next/server";

import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

async function getAccessToken() {
    const shop = process.env.SHOPIFY_SHOP;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!shop || !clientId || !clientSecret) {
        throw new Error("Shopify environment variables are missing.");
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
        const text = await response.text();

        throw new Error(
            `Could not get Shopify access token: ${response.status} ${text}`
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
        }
    );

    const result = await response.json();

    if (!response.ok) {
        throw new Error(
            `Shopify GraphQL failed: ${response.status}`
        );
    }

    if (result.errors) {
        throw new Error(JSON.stringify(result.errors));
    }

    return result.data;
}

async function deleteWebhook(id: string) {
    const data = await shopifyGraphQL(
        `
      mutation DeleteWebhook($id: ID!) {
        webhookSubscriptionDelete(id: $id) {
          deletedWebhookSubscriptionId
          userErrors {
            field
            message
          }
        }
      }
    `,
        { id }
    );

    const result =
        data.webhookSubscriptionDelete;

    if (result.userErrors.length > 0) {
        throw new Error(
            `Could not delete duplicate webhook ${id}: ${JSON.stringify(
                result.userErrors
            )}`
        );
    }

    return result.deletedWebhookSubscriptionId;
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

        const rawBaseUrl =
            process.env.WEBHOOK_BASE_URL;

        if (!rawBaseUrl) {
            throw new Error(
                "WEBHOOK_BASE_URL is missing."
            );
        }

        const baseUrl =
            rawBaseUrl.trim().replace(/\/+$/, "");

        const callbackUrl =
            `${baseUrl}/api/webhooks/orders-create`;

        const existingData =
            await shopifyGraphQL(`
        query GetOrderWebhooks {
          webhookSubscriptions(
            first: 50,
            topics: ORDERS_CREATE
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
            existingData.webhookSubscriptions.nodes as Array<{
                id: string;
                topic: string;
                uri: string;
            }>;

        const alreadyCorrect =
            existing.find(
                (webhook) =>
                    webhook.uri === callbackUrl
            );

        let primaryWebhook:
            | {
                id: string;
                topic: string;
                uri: string;
            }
            | null = null;

        let action = "UNCHANGED";

        if (alreadyCorrect) {
            primaryWebhook = alreadyCorrect;
            action = "KEPT_EXISTING";
        } else if (existing.length > 0) {
            const first = existing[0];

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
                        id: first.id,
                        webhookSubscription: {
                            uri: callbackUrl,
                        },
                    }
                );

            const result =
                updateData.webhookSubscriptionUpdate;

            if (result.userErrors.length > 0) {
                return NextResponse.json(
                    {
                        error: "Could not update webhook",
                        details: result.userErrors,
                        callbackUrl,
                    },
                    { status: 400 }
                );
            }

            primaryWebhook =
                result.webhookSubscription;

            action = "UPDATED";
        } else {
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
                        topic: "ORDERS_CREATE",
                        webhookSubscription: {
                            uri: callbackUrl,
                        },
                    }
                );

            const result =
                createData.webhookSubscriptionCreate;

            if (result.userErrors.length > 0) {
                return NextResponse.json(
                    {
                        error: "Could not create webhook",
                        details: result.userErrors,
                        callbackUrl,
                    },
                    { status: 400 }
                );
            }

            primaryWebhook =
                result.webhookSubscription;

            action = "CREATED";
        }

        if (!primaryWebhook) {
            throw new Error(
                "Could not determine primary ORDERS_CREATE webhook."
            );
        }

        const duplicates =
            existing.filter(
                (webhook) =>
                    webhook.id !==
                    primaryWebhook!.id
            );

        const deletedWebhookIds:
            string[] = [];

        for (const duplicate of duplicates) {
            const deletedId =
                await deleteWebhook(
                    duplicate.id
                );

            if (deletedId) {
                deletedWebhookIds.push(
                    deletedId
                );
            }
        }

        const finalData =
            await shopifyGraphQL(`
        query VerifyOrderWebhooks {
          webhookSubscriptions(
            first: 50,
            topics: ORDERS_CREATE
          ) {
            nodes {
              id
              topic
              uri
            }
          }
        }
      `);

        return NextResponse.json({
            success: true,
            action,
            callbackUrl,
            primaryWebhook,
            duplicatesRemoved:
                deletedWebhookIds.length,
            deletedWebhookIds,
            finalSubscriptions:
                finalData.webhookSubscriptions.nodes,
        });
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Webhook registration failed.",
            },
            { status: 500 }
        );
    }
}
