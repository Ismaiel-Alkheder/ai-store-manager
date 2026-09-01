import { NextResponse } from "next/server";
import { hasAdminSession } from "@/lib/require-admin";

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
        throw new Error(
            `Could not get Shopify access token: ${response.status}`
        );
    }

    const data = await response.json();

    return data.access_token;
}

export async function GET() {
    try {
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

        const shop = process.env.SHOPIFY_SHOP;

        if (!shop) {
            throw new Error("SHOPIFY_SHOP missing");
        }

        const token = await getAccessToken();

        const response = await fetch(
            `https://${shop}.myshopify.com/admin/oauth/access_scopes.json`,
            {
                headers: {
                    "X-Shopify-Access-Token": token,
                },
                cache: "no-store",
            }
        );

        if (!response.ok) {
            throw new Error(
                `Shopify request failed: ${response.status}`
            );
        }

        const data = await response.json();

        return NextResponse.json(data);
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Unknown error",
            },
            { status: 500 }
        );
    }
}
