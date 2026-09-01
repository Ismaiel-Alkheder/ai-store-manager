import {
    NextResponse,
} from "next/server";

import {
    hasAdminSession,
} from "@/lib/require-admin";

import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

export const runtime =
    "nodejs";

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

    const response =
        await fetch(
            `https://${shop}.myshopify.com/admin/oauth/access_token`,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded",
                },

                body:
                    new URLSearchParams({
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

async function graphql(
    query: string,

    variables:
        Record<string, unknown>,

    token: string
) {
    const shop =
        process.env.SHOPIFY_SHOP;

    if (!shop) {
        throw new Error(
            "SHOPIFY_SHOP missing"
        );
    }

    const response =
        await fetch(
            `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json",

                    "X-Shopify-Access-Token":
                        token,
                },

                body:
                    JSON.stringify({
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

export async function POST(request: Request) {
    try {
        if (!(await hasAdminSession())) {
            return NextResponse.json(
                {
                    success: false,

                    error:
                        "Unauthorized.",
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

        const baseUrl =
            process.env
                .WEBHOOK_BASE_URL
                ?.replace(
                    /\/+$/,
                    ""
                );

        if (!baseUrl) {
            return NextResponse.json(
                {
                    error:
                        "WEBHOOK_BASE_URL missing",
                },
                {
                    status: 500,
                }
            );
        }

        const callbackUrl =
            `${baseUrl}/api/webhooks/fulfillment-routing`;

        const token =
            await getAccessToken();

        /*
          Find an existing subscription
          for this topic.
        */

        const listQuery = `
      query {
        webhookSubscriptions(
          first: 100
        ) {
          nodes {
            id
            topic
            uri
          }
        }
      }
    `;

        const existingData =
            await graphql(
                listQuery,
                {},
                token
            );

        const existing =
            existingData
                ?.webhookSubscriptions
                ?.nodes
                ?.find(
                    (item: any) =>
                        item.topic ===
                        "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE"
                );

        /*
          UPDATE EXISTING
        */

        if (existing) {
            const updateMutation = `
        mutation UpdateWebhook(
          $id: ID!,
          $input: WebhookSubscriptionInput!
        ) {
          webhookSubscriptionUpdate(
            id: $id,
            webhookSubscription: $input
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
      `;

            const data =
                await graphql(
                    updateMutation,
                    {
                        id:
                            existing.id,

                        input: {
                            uri:
                                callbackUrl,
                        },
                    },
                    token
                );

            const result =
                data
                    ?.webhookSubscriptionUpdate;

            if (
                result
                    ?.userErrors
                    ?.length
            ) {
                return NextResponse.json(
                    {
                        success:
                            false,

                        userErrors:
                            result.userErrors,
                    },
                    {
                        status: 400,
                    }
                );
            }

            return NextResponse.json({
                success:
                    true,

                action:
                    "UPDATED",

                webhook:
                    result
                        ?.webhookSubscription,

                callbackUrl,
            });
        }

        /*
          CREATE NEW
        */

        const createMutation = `
      mutation CreateWebhook(
        $topic: WebhookSubscriptionTopic!,
        $input: WebhookSubscriptionInput!
      ) {
        webhookSubscriptionCreate(
          topic: $topic,
          webhookSubscription: $input
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
    `;

        const data =
            await graphql(
                createMutation,
                {
                    topic:
                        "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE",

                    input: {
                        uri:
                            callbackUrl,
                    },
                },
                token
            );

        const result =
            data
                ?.webhookSubscriptionCreate;

        if (
            result
                ?.userErrors
                ?.length
        ) {
            return NextResponse.json(
                {
                    success:
                        false,

                    userErrors:
                        result.userErrors,
                },
                {
                    status: 400,
                }
            );
        }

        return NextResponse.json({
            success:
                true,

            action:
                "CREATED",

            webhook:
                result
                    ?.webhookSubscription,

            callbackUrl,
        });
    } catch (error) {
        console.error(
            "Routing webhook registration error:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not register routing webhook.",
            },
            {
                status: 500,
            }
        );
    }
}
