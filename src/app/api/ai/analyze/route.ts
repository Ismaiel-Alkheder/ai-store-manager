import OpenAI from "openai";
import { NextResponse } from "next/server";

import { createAiReport } from "@/lib/ai-reports";
import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

export const runtime = "nodejs";

const AI_MODEL = "gpt-5.6-luna";

type ProductInput = {
    title?: string;
    handle?: string;
    status?: string;
    publishedAt?: string | null;
    tags?: string[];
    vendor?: string;
    productType?: string;
    description?: string;
    totalInventory?: number;
    tracksInventory?: boolean;
    variants?: {
        nodes?: Array<{
            title?: string;
            sku?: string | null;
            price?: string;
            compareAtPrice?: string | null;
            inventoryQuantity?: number;
            inventoryPolicy?: string;
        }>;
    };
};

type OrderInput = {
    name?: string;
    createdAt?: string;
    test?: boolean;
    tags?: string[];
    sourceName?: string | null;
    displayFinancialStatus?: string;
    displayFulfillmentStatus?: string;
    totalPriceSet?: {
        shopMoney?: {
            amount?: string;
            currencyCode?: string;
        };
    };
    lineItems?: {
        nodes?: Array<{
            name?: string;
            quantity?: number;
        }>;
    };
};

function getAnalyticsStartTime() {
    const value =
        process.env.ANALYTICS_START_DATE;

    if (!value) {
        throw new Error(
            "ANALYTICS_START_DATE is missing."
        );
    }

    const time = Date.parse(value);

    if (!Number.isFinite(time)) {
        throw new Error(
            "ANALYTICS_START_DATE is invalid."
        );
    }

    return time;
}

function hasTestTag(tags: string[] = []) {
    const testTags = new Set([
        "test",
        "ai-test",
        "ai_test",
        "development",
        "demo",
    ]);

    return tags.some(tag =>
        testTags.has(
            tag.trim().toLowerCase()
        )
    );
}

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

        const apiKey =
            process.env.OPENAI_API_KEY;

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

        const rawProducts:
            ProductInput[] =
            Array.isArray(body?.products)
                ? body.products
                : [];

        const rawOrders:
            OrderInput[] =
            Array.isArray(body?.orders)
                ? body.orders
                : [];

        const analyticsStartTime =
            getAnalyticsStartTime();

        const products =
            rawProducts.filter(product =>
                product.status === "ACTIVE" &&
                Boolean(product.publishedAt) &&
                !hasTestTag(product.tags)
            );

        const orders =
            rawOrders.filter(order => {
                const createdTime =
                    order.createdAt
                        ? Date.parse(
                            order.createdAt
                        )
                        : Number.NaN;

                return (
                    Number.isFinite(
                        createdTime
                    ) &&
                    createdTime >=
                        analyticsStartTime &&
                    order.test !== true &&
                    !hasTestTag(order.tags)
                );
            });

        const client = new OpenAI({
            apiKey,
        });

        const storeData = {
            scope: {
                products:
                    "ACTIVE_AND_PUBLISHED",
                ordersSince:
                    new Date(
                        analyticsStartTime
                    ).toISOString(),
                testOrdersExcluded:
                    true,
            },

            products: products.map(product => ({
                title:
                    product.title ||
                    "Untitled product",

                handle:
                    product.handle,

                vendor:
                    product.vendor,

                productType:
                    product.productType,

                description:
                    product.description,

                tags:
                    product.tags || [],

                totalInventory:
                    Number(
                        product.totalInventory || 0
                    ),

                tracksInventory:
                    Boolean(
                        product.tracksInventory
                    ),

                variants:
                    product.variants
                        ?.nodes
                        ?.map(variant => ({
                            title:
                                variant.title,

                            sku:
                                variant.sku,

                            price:
                                variant.price,

                            compareAtPrice:
                                variant.compareAtPrice,

                            inventoryQuantity:
                                Number(
                                    variant.inventoryQuantity || 0
                                ),

                            inventoryPolicy:
                                variant.inventoryPolicy,
                        })) || [],
            })),

            orders: orders.map(order => ({
                name:
                    order.name,

                createdAt:
                    order.createdAt,

                sourceName:
                    order.sourceName,

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
            })),
        };

        const response =
            await client.responses.create({
                model:
                    AI_MODEL,

                instructions: `
أنت مدير متجر إلكتروني ذكي يساعد صاحب متجر Shopify متخصصاً في الأدوات والألعاب التعليمية الذكية للأطفال من 6 إلى 12 سنة في السوق الأمريكي.

البيانات المرسلة إليك تقتصر على المنتجات النشطة والمنشورة، وعلى الطلبات الحقيقية منذ تاريخ بدء التحليلات، بعد استبعاد طلبات الاختبار.

اكتب تقريراً مختصراً وواضحاً باللغة العربية يركز على:
1. ملخص صادق للمبيعات والطلبات. إذا لم توجد طلبات حقيقية، اذكر ذلك بوضوح ولا تستنتج أداءً تجارياً غير موجود.
2. الطلبات المدفوعة التي تحتاج إلى تنفيذ.
3. المخزون والمنتجات أو المتغيرات النافدة أو السالبة.
4. جودة بيانات المنتجات: العناوين، الأسعار، الوصف، التصنيف، SKU، وسياسة المخزون.
5. المنتجات التي تحتاج مراجعة سلامة أو خصوصية، خصوصاً المنتجات المغناطيسية والمتصلة بالإنترنت. لا تدّعِ تحققاً قانونياً غير موجود في البيانات.
6. أهم ثلاث توصيات عملية مرتبة حسب الأولوية.

لا تذكر منتجات أو طلبات غير موجودة في البيانات.
لا تدّعي أنك نفذت أي إجراء.
لا تغير الأسعار.
لا تلغي الطلبات.
لا تنفذ Refund.
أنت تقوم بالتحليل والتوصية فقط.
      `,

                input: `
هذه بيانات متجر Shopify الحالية بعد التنقية على الخادم:

${JSON.stringify(
                    storeData,
                    null,
                    2
                )}
      `,

                max_output_tokens:
                    900,
            });

        const analysis =
            response.output_text.trim();

        if (!analysis) {
            throw new Error(
                "AI analysis was empty."
            );
        }

        const report = createAiReport({
            analysis,
            model: AI_MODEL,
            source: "MANUAL",
            productCount:
                storeData.products.length,
            orderCount:
                storeData.orders.length,
        });

        return NextResponse.json({
            success: true,
            analysis,
            report,

            dataQuality: {
                productsReceived:
                    rawProducts.length,

                productsAnalyzed:
                    products.length,

                ordersReceived:
                    rawOrders.length,

                ordersAnalyzed:
                    orders.length,

                analyticsStartDate:
                    new Date(
                        analyticsStartTime
                    ).toISOString(),
            },
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
