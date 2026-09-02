import OpenAI from "openai";
import type {
    Response as OpenAIResponse,
} from "openai/resources/responses/responses";
import { NextResponse } from "next/server";

import {
    createMarketScan,
    listMarketScans,
} from "@/lib/market-scans";
import type {
    MarketCitation,
    MarketScanResult,
} from "@/lib/market-scan-types";
import { hasAdminSession } from "@/lib/require-admin";
import { isSameOriginAdminRequest } from "@/lib/require-same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MARKET_MODEL =
    process.env.OPENAI_MARKET_MODEL
        ?.trim() || "gpt-5.6";

const COOLDOWN_MILLISECONDS =
    6 * 60 * 60 * 1000;

type ProductInput = {
    title?: string;
    totalInventory?: number;
    variants?: {
        nodes?: Array<{
            title?: string;
            price?: string;
            inventoryQuantity?: number;
        }>;
    };
};

const marketScanSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        summary: {
            type: "string",
        },
        marketSignals: {
            type: "array",
            minItems: 3,
            maxItems: 5,
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    signal: {
                        type: "string",
                    },
                    evidence: {
                        type: "string",
                    },
                    implication: {
                        type: "string",
                    },
                },
                required: [
                    "signal",
                    "evidence",
                    "implication",
                ],
            },
        },
        candidates: {
            type: "array",
            minItems: 3,
            maxItems: 3,
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    name: {
                        type: "string",
                    },
                    concept: {
                        type: "string",
                    },
                    ageRange: {
                        type: "string",
                    },
                    targetRetailPriceMin: {
                        type: "number",
                    },
                    targetRetailPriceMax: {
                        type: "number",
                    },
                    trendEvidence: {
                        type: "string",
                    },
                    whyFit: {
                        type: "string",
                    },
                    differentiation: {
                        type: "string",
                    },
                    sourcingRequirements: {
                        type: "array",
                        minItems: 3,
                        maxItems: 6,
                        items: {
                            type: "string",
                        },
                    },
                    risks: {
                        type: "array",
                        minItems: 1,
                        maxItems: 5,
                        items: {
                            type: "string",
                        },
                    },
                    confidence: {
                        type: "string",
                        enum: [
                            "LOW",
                            "MEDIUM",
                            "HIGH",
                        ],
                    },
                },
                required: [
                    "name",
                    "concept",
                    "ageRange",
                    "targetRetailPriceMin",
                    "targetRetailPriceMax",
                    "trendEvidence",
                    "whyFit",
                    "differentiation",
                    "sourcingRequirements",
                    "risks",
                    "confidence",
                ],
            },
        },
        avoid: {
            type: "array",
            maxItems: 3,
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    productConcept: {
                        type: "string",
                    },
                    reason: {
                        type: "string",
                    },
                },
                required: [
                    "productConcept",
                    "reason",
                ],
            },
        },
        nextStep: {
            type: "string",
        },
        disclaimer: {
            type: "string",
        },
    },
    required: [
        "summary",
        "marketSignals",
        "candidates",
        "avoid",
        "nextStep",
        "disclaimer",
    ],
} as const;

function validHttpUrl(value: string) {
    try {
        const url = new URL(value);

        return (
            url.protocol === "https:" ||
            url.protocol === "http:"
        );
    } catch {
        return false;
    }
}

function fallbackCitationTitle(
    url: string
) {
    try {
        return new URL(url).hostname.replace(
            /^www\./,
            ""
        );
    } catch {
        return "Market source";
    }
}

function collectCitations(
    response: OpenAIResponse
): MarketCitation[] {
    const titles = new Map<
        string,
        string
    >();
    const citedUrls = new Set<string>();
    const searchUrls = new Set<string>();

    for (const item of response.output) {
        if (item.type === "message") {
            for (const content of item.content) {
                if (
                    content.type !==
                    "output_text"
                ) {
                    continue;
                }

                for (
                    const annotation of
                    content.annotations
                ) {
                    if (
                        annotation.type ===
                            "url_citation" &&
                        validHttpUrl(
                            annotation.url
                        )
                    ) {
                        citedUrls.add(
                            annotation.url
                        );
                        titles.set(
                            annotation.url,
                            annotation.title
                        );
                    }
                }
            }
        }

        if (
            item.type ===
                "web_search_call" &&
            item.action.type === "search"
        ) {
            for (
                const source of
                item.action.sources || []
            ) {
                if (
                    validHttpUrl(source.url)
                ) {
                    searchUrls.add(
                        source.url
                    );
                }
            }
        }
    }

    const blockedDomains = [
        "reddit.com",
        "wikipedia.org",
    ];

    const isUsefulSource = (
        url: string
    ) => {
        try {
            const hostname = new URL(url)
                .hostname
                .replace(/^www\./, "");

            return !blockedDomains.some(
                domain =>
                    hostname === domain ||
                    hostname.endsWith(
                        `.${domain}`
                    )
            );
        } catch {
            return false;
        }
    };

    const orderedUrls = [
        ...citedUrls,
        ...searchUrls,
    ].filter(isUsefulSource);

    return Array.from(
        new Set(orderedUrls)
    )
        .slice(0, 12)
        .map(url => ({
            url,
            title:
                titles.get(url) ||
                fallbackCitationTitle(url),
        }));
}

function isMarketScanResult(
    value: unknown
): value is MarketScanResult {
    if (
        !value ||
        typeof value !== "object"
    ) {
        return false;
    }

    const result =
        value as Partial<MarketScanResult>;

    return (
        typeof result.summary ===
            "string" &&
        Array.isArray(
            result.marketSignals
        ) &&
        Array.isArray(result.candidates) &&
        result.candidates.length === 3 &&
        Array.isArray(result.avoid) &&
        typeof result.nextStep ===
            "string" &&
        typeof result.disclaimer ===
            "string"
    );
}

function completeMarketScan(
    response: OpenAIResponse
) {
    if (response.status === "incomplete") {
        const reason =
            response.incomplete_details
                ?.reason;

        throw new Error(
            `Market Scan response stopped before completion${
                reason
                    ? ` (${reason})`
                    : ""
            }.`
        );
    }

    if (
        response.status === "failed" ||
        response.status === "cancelled"
    ) {
        throw new Error(
            response.error?.message ||
                `Market Scan ended with status ${response.status}.`
        );
    }

    if (response.status !== "completed") {
        return null;
    }

    const outputText =
        response.output_text.trim();

    if (!outputText) {
        throw new Error(
            "Market Scan returned no analysis."
        );
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(outputText);
    } catch {
        throw new Error(
            "Market Scan returned incomplete structured data. Please try again."
        );
    }

    if (!isMarketScanResult(parsed)) {
        throw new Error(
            "Market Scan returned an invalid result."
        );
    }

    const citations =
        collectCitations(response);

    if (citations.length === 0) {
        throw new Error(
            "Market Scan returned no source links."
        );
    }

    return createMarketScan({
        result: parsed,
        citations,
        model: MARKET_MODEL,
    });
}

export async function GET(
    request: Request
) {
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

        const responseId = new URL(
            request.url
        ).searchParams.get("responseId");

        if (!responseId) {
            const scans =
                listMarketScans(5);

            return NextResponse.json({
                success: true,
                count: scans.length,
                scans,
            });
        }

        if (
            !/^resp_[A-Za-z0-9_-]+$/.test(
                responseId
            ) ||
            responseId.length > 200
        ) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        "Invalid Market Scan response ID.",
                },
                {
                    status: 400,
                }
            );
        }

        const apiKey =
            process.env.OPENAI_API_KEY;

        if (!apiKey) {
            throw new Error(
                "OPENAI_API_KEY is missing."
            );
        }

        const client = new OpenAI({
            apiKey,
        });

        const response =
            await client.responses.retrieve(
                responseId,
                {
                    include: [
                        "web_search_call.action.sources",
                    ],
                }
            );

        const scan =
            completeMarketScan(response);

        if (!scan) {
            return NextResponse.json(
                {
                    success: true,
                    responseId,
                    status: response.status,
                },
                {
                    status: 202,
                }
            );
        }

        return NextResponse.json({
            success: true,
            responseId,
            status: "completed",
            scan,
        });
    } catch (error) {
        console.error(
            "Market Scan status error:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not read Market Scan status.",
            },
            {
                status: 500,
            }
        );
    }
}

export async function POST(
    request: Request
) {
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
                    error:
                        "Invalid request origin.",
                },
                {
                    status: 403,
                }
            );
        }

        const latestScan =
            listMarketScans(1)[0];

        if (latestScan) {
            const elapsed =
                Date.now() -
                Date.parse(
                    latestScan.createdAt
                );

            if (
                Number.isFinite(elapsed) &&
                elapsed >= 0 &&
                elapsed <
                    COOLDOWN_MILLISECONDS
            ) {
                return NextResponse.json(
                    {
                        success: false,
                        error:
                            "A recent Market Scan already exists.",
                        retryAfterSeconds:
                            Math.ceil(
                                (COOLDOWN_MILLISECONDS -
                                    elapsed) /
                                    1000
                            ),
                        scan: latestScan,
                    },
                    {
                        status: 429,
                    }
                );
            }
        }

        const apiKey =
            process.env.OPENAI_API_KEY;

        if (!apiKey) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        "OPENAI_API_KEY is missing.",
                },
                {
                    status: 500,
                }
            );
        }

        const body = await request.json();
        const products: ProductInput[] =
            Array.isArray(body?.products)
                ? body.products.slice(0, 100)
                : [];

        const currentCatalog =
            products.map(product => ({
                title:
                    product.title ||
                    "Untitled product",
                totalInventory: Number(
                    product.totalInventory || 0
                ),
                variants:
                    product.variants?.nodes
                        ?.slice(0, 100)
                        .map(variant => ({
                            title:
                                variant.title ||
                                "Default",
                            price: Number(
                                variant.price || 0
                            ),
                            inventoryQuantity:
                                Number(
                                    variant.inventoryQuantity ||
                                        0
                                ),
                        })) || [],
            }));

        const client = new OpenAI({
            apiKey,
        });

        const response =
            await client.responses.create({
                model: MARKET_MODEL,
                background: true,
                reasoning: {
                    effort: "low",
                },
                tools: [
                    {
                        type: "web_search",
                        external_web_access:
                            true,
                        search_context_size:
                            "medium",
                        user_location: {
                            type: "approximate",
                            country: "US",
                            timezone:
                                "America/Detroit",
                        },
                    },
                ],
                tool_choice: "required",
                include: [
                    "web_search_call.action.sources",
                ],
                max_output_tokens: 8000,
                text: {
                    verbosity: "low",
                    format: {
                        type: "json_schema",
                        name: "future_builders_market_scan",
                        strict: true,
                        schema:
                            marketScanSchema,
                    },
                },
                instructions: `
أنت باحث سوق لمتجر Future Builders المتخصص في الأدوات والألعاب التعليمية الذكية للأطفال.

استخدم البحث الحي على الويب لدراسة السوق الأمريكي الحالي. أعد النتيجة بالعربية، مع إبقاء أسماء فئات المنتجات واضحة وقابلة للبحث بالإنجليزية عند الحاجة.

معايير الاختيار الإلزامية:
- العمر المستهدف 6–12 سنة.
- سعر التجزئة المستهدف من 20 إلى 60 دولاراً أمريكياً.
- منتج صغير أو متوسط، خفيف نسبياً، وسهل الشحن داخل الولايات المتحدة.
- إشارة طلب حديثة يمكن تفسيرها من مصادر الويب، لا من التخمين وحده.
- تجنب تكرار مفاهيم المنتجات الموجودة في الكتالوج المرسل.
- أعط الأولوية لمنتجات يمكن اختبارها بالدروبشيبينغ ثم نقل الفائز منها إلى مخزون أمريكي.

السلامة:
- اعتبر كل نتيجة مرشح بحث فقط، وليست منتجاً معتمداً.
- اشترط قبل الموافقة مستندات CPC وCPSIA وASTM F963 الملائمة.
- تجنب المغناطيسات الصغيرة السائبة، مجموعات المواد الكيميائية أو الاحتراق، والألعاب المتصلة التي تجمع بيانات الأطفال، إلا إذا كانت مخاطرها وضوابطها موثقة بوضوح.

جودة البحث:
- فرّق بوضوح بين دليل السوق والاستنتاج.
- استخدم مصادر أولية أو رسمية، ومتاجر أمريكية كبرى، ومراجعات تحريرية موثوقة. تجنب Reddit وWikipedia ومواقع التسويق بالعمولة أو المحتوى المكرر.
- اجعل البحث مركزاً واستخدم فقط المصادر المرتبطة مباشرة بالاستنتاجات النهائية.
- اكتب حقول النتيجة كنص عادي. لا تضع روابط أو صيغة Markdown أو رموز استشهاد داخل النص؛ ستعرض الواجهة المصادر بصورة منفصلة.
- لا تدّعِ مخزون مورد أو هامش ربح أو امتثالاً لم تثبته المصادر.
- لا توصِ بإطلاق إعلان مدفوع قبل التحقق من المورد والعينة والسلامة.
- لا تنفذ أي تغيير في Shopify.
                `,
                input: `
ابحث عن فرص منتجات حالية تلائم استراتيجية Future Builders، ثم اقترح ثلاثة مرشحين فقط مرتبين حسب قوة الملاءمة.

هذا هو الكتالوج الحالي لتجنب التكرار:
${JSON.stringify(
    currentCatalog,
    null,
    2
)}
                `,
            });

        return NextResponse.json(
            {
                success: true,
                responseId: response.id,
                status: response.status,
            },
            {
                status: 202,
            }
        );
    } catch (error) {
        console.error(
            "Market Scan error:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Market Scan failed.",
            },
            {
                status: 500,
            }
        );
    }
}
