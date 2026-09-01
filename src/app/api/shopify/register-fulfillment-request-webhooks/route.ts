import {
    NextResponse,
} from "next/server";

import {
    hasAdminSession,
} from "@/lib/require-admin";

import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

export const runtime =
    "nodejs";

const TOPICS = [
    "FULFILLMENT_ORDERS_FULFILLMENT_REQUEST_SUBMITTED",
    "FULFILLMENT_ORDERS_FULFILLMENT_REQUEST_ACCEPTED",
    "FULFILLMENT_ORDERS_FULFILLMENT_REQUEST_REJECTED",
] as const;

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
                method:
                    "POST",

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

    const data =
        await response.json();

    if (!response.ok) {
        throw new Error(
            `Could not get Shopify access token: ${response.status} ${JSON.stringify(
                data
            )}`
        );
    }

    return data.access_token;
}

async function shopifyGraphQL(
    query: string,

    variables: Record<
        string,
        unknown
    >,

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
                method:
                    "POST",

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

                cache:
                    "no-store",
            }
        );

    const result =
        await response.json();

    if (!response.ok) {
        throw new Error(
            `Shopify request failed: ${response.status} ${JSON.stringify(
                result
            )}`
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

async function listTopic(
    topic: string,
    token: string
) {
    const data =
        await shopifyGraphQL(
            `
      query ExistingWebhookSubscriptions(
        $topic: WebhookSubscriptionTopic!
      ) {
        webhookSubscriptions(
          first: 100,
          topics: [$topic]
        ) {
          nodes {
            id
            topic
            uri
          }
        }
      }
      `,
            {
                topic,
            },
            token
        );

    return (
        data
            ?.webhookSubscriptions
            ?.nodes || []
    );
}

async function createWebhook(
    topic: string,
    uri: string,
    token: string
) {
    const data =
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
                topic,

                webhookSubscription: {
                    uri,
                    format:
                        "JSON",
                },
            },
            token
        );

    const result =
        data
            ?.webhookSubscriptionCreate;

    const userErrors =
        result
            ?.userErrors ||
        [];

    if (
        userErrors.length >
        0
    ) {
        throw new Error(
            userErrors
                .map(
                    (
                        item: any
                    ) =>
                        item.message
                )
                .join(
                    "; "
                )
        );
    }

    return result
        ?.webhookSubscription;
}

async function deleteWebhook(
    id: string,
    token: string
) {
    const data =
        await shopifyGraphQL(
            `
      mutation DeleteWebhook(
        $id: ID!
      ) {
        webhookSubscriptionDelete(
          id: $id
        ) {
          deletedWebhookSubscriptionId
          userErrors {
            field
            message
          }
        }
      }
      `,
            {
                id,
            },
            token
        );

    const result =
        data
            ?.webhookSubscriptionDelete;

    const userErrors =
        result
            ?.userErrors ||
        [];

    if (
        userErrors.length >
        0
    ) {
        throw new Error(
            userErrors
                .map(
                    (
                        item: any
                    ) =>
                        item.message
                )
                .join(
                    "; "
                )
        );
    }

    return result
        ?.deletedWebhookSubscriptionId;
}

export async function POST(request: Request) {
    try {
        if (!(await hasAdminSession())) {
            return NextResponse.json(
                {
                    success:
                        false,

                    error:
                        "Unauthorized.",
                },
                {
                    status:
                        401,
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

        const rawBaseUrl =
            process.env
                .WEBHOOK_BASE_URL;

        if (!rawBaseUrl) {
            return NextResponse.json(
                {
                    error:
                        "WEBHOOK_BASE_URL missing",
                },
                {
                    status:
                        500,
                }
            );
        }

        const baseUrl =
            rawBaseUrl
                .trim()
                .replace(
                    /\/+$/,
                    ""
                );

        const callbackUri =
            `${baseUrl}/api/webhooks/fulfillment-request`;

        /*
          Validate early so a malformed env
          value is visible immediately.
        */

        new URL(
            callbackUri
        );

        const token =
            await getAccessToken();

        const results:
            any[] = [];

        for (
            const topic
            of TOPICS
        ) {
            const existing =
                await listTopic(
                    topic,
                    token
                );

            let keeper =
                existing.find(
                    (
                        item: any
                    ) =>
                        item.uri ===
                        callbackUri
                );

            let action =
                "KEPT_EXISTING";

            if (!keeper) {
                keeper =
                    await createWebhook(
                        topic,
                        callbackUri,
                        token
                    );

                action =
                    "CREATED";
            }

            const duplicates =
                (
                    await listTopic(
                        topic,
                        token
                    )
                ).filter(
                    (
                        item: any
                    ) =>
                        item.id !==
                        keeper.id
                );

            const removed:
                string[] = [];

            for (
                const duplicate
                of duplicates
            ) {
                const deletedId =
                    await deleteWebhook(
                        duplicate.id,
                        token
                    );

                if (
                    deletedId
                ) {
                    removed.push(
                        deletedId
                    );
                }
            }

            const final =
                await listTopic(
                    topic,
                    token
                );

            results.push({
                topic,
                callbackUri,
                action,
                keeper,
                duplicatesRemoved:
                    removed.length,
                final,
            });
        }

        return NextResponse.json({
            success:
                true,

            callbackUri,
            results,
        });
    } catch (error) {
        return NextResponse.json(
            {
                success:
                    false,

                error:
                    error instanceof Error
                        ? error.message
                        : "Could not register fulfillment request webhooks",
            },
            {
                status:
                    500,
            }
        );
    }
}
