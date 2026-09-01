import OpenAI from "openai";
import { NextResponse } from "next/server";

import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

export const runtime = "nodejs";

export async function POST(request: Request) {
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

        if (!isSameOriginAdminRequest(request)) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Invalid request origin.",
                },
                {
                    status: 403,
                }
            );
        }

        const apiKey = process.env.OPENAI_API_KEY;

        if (!apiKey) {
            return NextResponse.json(
                {
                    error:
                        "OPENAI_API_KEY is missing.",
                },
                {
                    status: 500,
                }
            );
        }

        const body =
            await request.json();

        const products =
            Array.isArray(body?.products)
                ? body.products
                : [];

        const orders =
            Array.isArray(body?.orders)
                ? body.orders
                : [];

        const client = new OpenAI({
            apiKey,
        });

        const storeData = {
            products: products.map(
                (product: {
                    title: string;
                    variants?: {
                        nodes?: {
                            title?: string;
                            price: string;
                            inventoryQuantity: number;
                        }[];
                    };
                }) => ({
                    title:
                        product.title,

                    variants:
                        product.variants
                            ?.nodes
                            ?.map(
                                (
                                    variant
                                ) => ({
                                    title:
                                        variant.title,

                                    price:
                                        variant.price,

                                    inventoryQuantity:
                                        variant.inventoryQuantity,
                                })
                            ) || [],
                })
            ),

            orders: orders.map(
                (order: {
                    name: string;
                    displayFinancialStatus: string;
                    displayFulfillmentStatus: string;
                    totalPriceSet: {
                        shopMoney: {
                            amount: string;
                            currencyCode: string;
                        };
                    };
                    lineItems?: {
                        nodes: {
                            name: string;
                            quantity: number;
                        }[];
                    };
                }) => ({
                    name:
                        order.name,

                    paymentStatus:
                        order.displayFinancialStatus,

                    fulfillmentStatus:
                        order.displayFulfillmentStatus,

                    total:
                        order.totalPriceSet
                            ?.shopMoney,

                    items:
                        order.lineItems
                            ?.nodes || [],
                })
            ),
        };

        const response =
            await client.responses.create({
                model:
                    "gpt-5.6-luna",

                instructions: `
أنت مدير متجر إلكتروني ذكي يساعد صاحب متجر Shopify.

حلل بيانات المتجر وأعط تقريراً مختصراً وواضحاً باللغة العربية.

ركز على:
1. الطلبات التي تحتاج إلى انتباه.
2. الطلبات المدفوعة التي لم يتم تنفيذها.
3. وضع المخزون.
4. المنتجات التي تستحق المراجعة.
5. أهم ثلاث توصيات لصاحب المتجر.

لا تدّعي أنك نفذت أي إجراء.
لا تغير الأسعار.
لا تلغي الطلبات.
لا تنفذ Refund.
أنت تقوم بالتحليل والتوصية فقط.
      `,

                input: `
هذه بيانات متجر Shopify الحالية:

${JSON.stringify(
                    storeData,
                    null,
                    2
                )}
      `,

                max_output_tokens:
                    600,
            });

        return NextResponse.json({
            analysis:
                response.output_text,
        });
    } catch (error) {
        console.error(
            "AI analysis error:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "AI analysis failed.",
            },
            {
                status: 500,
            }
        );
    }
}
