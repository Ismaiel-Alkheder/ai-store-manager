"use client";

import {
    useEffect,
    useState,
} from "react";

import type {
    MarketCandidate,
    MarketConfidence,
    MarketScan,
} from "@/lib/market-scan-types";

type MarketProduct = {
    title: string;
    totalInventory?: number;
    variants: {
        nodes: Array<{
            title?: string;
            price: string;
            inventoryQuantity: number;
        }>;
    };
};

type MarketScanResponse = {
    success?: boolean;
    scans?: MarketScan[];
    scan?: MarketScan;
    error?: string;
    retryAfterSeconds?: number;
};

const confidenceStyle: Record<
    MarketConfidence,
    {
        background: string;
        color: string;
    }
> = {
    LOW: {
        background: "#fee2e2",
        color: "#991b1b",
    },
    MEDIUM: {
        background: "#fef3c7",
        color: "#92400e",
    },
    HIGH: {
        background: "#dcfce7",
        color: "#166534",
    },
};

function CandidateCard({
    candidate,
    rank,
}: {
    candidate: MarketCandidate;
    rank: number;
}) {
    const confidence =
        confidenceStyle[
            candidate.confidence
        ];

    return (
        <article
            dir="rtl"
            style={{
                padding: "18px",
                border: "1px solid #dbeafe",
                borderRadius: "14px",
                background: "#ffffff",
                boxShadow:
                    "0 8px 22px rgba(15, 23, 42, 0.05)",
            }}
        >
            <div
                style={{
                    display: "flex",
                    justifyContent:
                        "space-between",
                    alignItems: "flex-start",
                    gap: "12px",
                }}
            >
                <div>
                    <div
                        style={{
                            color: "#2563eb",
                            fontWeight: 800,
                            fontSize: "13px",
                        }}
                    >
                        المرشح {rank}
                    </div>
                    <h3
                        style={{
                            margin: "5px 0 4px",
                            fontSize: "18px",
                        }}
                    >
                        {candidate.name}
                    </h3>
                    <div
                        style={{
                            color: "#475569",
                            fontSize: "14px",
                        }}
                    >
                        العمر {candidate.ageRange} ·
                        السعر المستهدف ${candidate.targetRetailPriceMin.toFixed(
                            0
                        )}
                        –${candidate.targetRetailPriceMax.toFixed(
                            0
                        )}
                    </div>
                </div>

                <span
                    style={{
                        padding: "5px 9px",
                        borderRadius: "999px",
                        background:
                            confidence.background,
                        color: confidence.color,
                        fontSize: "12px",
                        fontWeight: 800,
                    }}
                >
                    {candidate.confidence}
                </span>
            </div>

            <p
                style={{
                    margin: "14px 0 8px",
                    lineHeight: 1.65,
                }}
            >
                {candidate.concept}
            </p>

            <p
                style={{
                    margin: "8px 0",
                    lineHeight: 1.65,
                }}
            >
                <strong>دليل السوق: </strong>
                {candidate.trendEvidence}
            </p>

            <p
                style={{
                    margin: "8px 0",
                    lineHeight: 1.65,
                }}
            >
                <strong>سبب الملاءمة: </strong>
                {candidate.whyFit}
            </p>

            <p
                style={{
                    margin: "8px 0",
                    lineHeight: 1.65,
                }}
            >
                <strong>التميّز المقترح: </strong>
                {candidate.differentiation}
            </p>

            <div
                style={{
                    display: "grid",
                    gridTemplateColumns:
                        "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: "14px",
                    marginTop: "14px",
                }}
            >
                <div>
                    <strong>
                        شروط التوريد
                    </strong>
                    <ul
                        style={{
                            margin: "7px 0 0",
                            paddingRight: "20px",
                            lineHeight: 1.7,
                        }}
                    >
                        {candidate.sourcingRequirements.map(
                            requirement => (
                                <li
                                    key={
                                        requirement
                                    }
                                >
                                    {requirement}
                                </li>
                            )
                        )}
                    </ul>
                </div>

                <div>
                    <strong>المخاطر</strong>
                    <ul
                        style={{
                            margin: "7px 0 0",
                            paddingRight: "20px",
                            lineHeight: 1.7,
                        }}
                    >
                        {candidate.risks.map(
                            risk => (
                                <li key={risk}>
                                    {risk}
                                </li>
                            )
                        )}
                    </ul>
                </div>
            </div>
        </article>
    );
}

export default function MarketScanPanel({
    products,
}: {
    products: MarketProduct[];
}) {
    const [scan, setScan] =
        useState<MarketScan | null>(null);
    const [loading, setLoading] =
        useState(false);
    const [historyLoading, setHistoryLoading] =
        useState(true);
    const [message, setMessage] =
        useState("");

    useEffect(() => {
        let cancelled = false;

        async function loadLatestScan() {
            try {
                const response = await fetch(
                    "/api/ai/market-scan",
                    {
                        cache: "no-store",
                    }
                );
                const data =
                    (await response.json()) as MarketScanResponse;

                if (!response.ok) {
                    throw new Error(
                        data.error ||
                            `Market Scan history returned HTTP ${response.status}`
                    );
                }

                if (!cancelled) {
                    setScan(
                        data.scans?.[0] ||
                            null
                    );
                }
            } catch (error) {
                if (!cancelled) {
                    setMessage(
                        error instanceof Error
                            ? error.message
                            : "Could not load Market Scan history."
                    );
                }
            } finally {
                if (!cancelled) {
                    setHistoryLoading(false);
                }
            }
        }

        void loadLatestScan();

        return () => {
            cancelled = true;
        };
    }, []);

    async function runMarketScan() {
        setLoading(true);
        setMessage("");

        try {
            const response = await fetch(
                "/api/ai/market-scan",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                    },
                    body: JSON.stringify({
                        products,
                    }),
                }
            );
            const data =
                (await response.json()) as MarketScanResponse;

            if (
                response.status === 429 &&
                data.scan
            ) {
                setScan(data.scan);

                const hours = Math.max(
                    1,
                    Math.ceil(
                        Number(
                            data.retryAfterSeconds ||
                                0
                        ) / 3600
                    )
                );

                setMessage(
                    `A current scan is already saved. A new scan will be available in about ${hours} hour${
                        hours === 1 ? "" : "s"
                    }.`
                );
                return;
            }

            if (!response.ok || !data.scan) {
                throw new Error(
                    data.error ||
                        `Market Scan returned HTTP ${response.status}`
                );
            }

            setScan(data.scan);
            setMessage(
                "Market Scan completed and saved."
            );
        } catch (error) {
            setMessage(
                error instanceof Error
                    ? error.message
                    : "Market Scan failed."
            );
        } finally {
            setLoading(false);
        }
    }

    return (
        <section
            style={{
                marginTop: "42px",
                padding: "24px",
                border: "1px solid #bae6fd",
                borderRadius: "18px",
                background:
                    "linear-gradient(135deg, #f0f9ff 0%, #ffffff 62%, #ecfeff 100%)",
                boxShadow:
                    "0 10px 30px rgba(14, 116, 144, 0.07)",
            }}
        >
            <div
                style={{
                    display: "flex",
                    justifyContent:
                        "space-between",
                    alignItems: "flex-start",
                    gap: "18px",
                    flexWrap: "wrap",
                }}
            >
                <div
                    style={{
                        maxWidth: "780px",
                    }}
                >
                    <div
                        style={{
                            color: "#0e7490",
                            fontSize: "13px",
                            fontWeight: 800,
                            letterSpacing:
                                "0.06em",
                            textTransform:
                                "uppercase",
                        }}
                    >
                        Live web research · Read only
                    </div>
                    <h2
                        style={{
                            margin: "6px 0 7px",
                        }}
                    >
                        Future Builders Market Scan
                    </h2>
                    <p
                        style={{
                            margin: 0,
                            color: "#475569",
                            lineHeight: 1.6,
                        }}
                    >
                        Researches current US demand and
                        proposes exactly three product
                        candidates for ages 6–12 and a
                        $20–$60 retail target. It never
                        creates or changes a Shopify
                        product.
                    </p>
                </div>

                <button
                    type="button"
                    onClick={runMarketScan}
                    disabled={
                        loading ||
                        products.length === 0
                    }
                    aria-busy={loading}
                    style={{
                        padding: "12px 18px",
                        border: "none",
                        borderRadius: "11px",
                        background:
                            loading ||
                            products.length === 0
                                ? "#94a3b8"
                                : "#0891b2",
                        color: "#ffffff",
                        fontWeight: 800,
                        cursor:
                            loading ||
                            products.length === 0
                                ? "not-allowed"
                                : "pointer",
                    }}
                >
                    {loading
                        ? "Researching the US market…"
                        : "Run Market Scan"}
                </button>
            </div>

            <p
                style={{
                    margin: "12px 0 0",
                    color: "#64748b",
                    fontSize: "13px",
                }}
            >
                Manual only · 6-hour cost guard · Sources
                included · No Shopify writes
            </p>

            {message && (
                <div
                    role="status"
                    style={{
                        marginTop: "14px",
                        padding: "10px 12px",
                        borderRadius: "9px",
                        background: "#e0f2fe",
                        color: "#0c4a6e",
                    }}
                >
                    {message}
                </div>
            )}

            {historyLoading ? (
                <p
                    style={{
                        marginTop: "20px",
                    }}
                >
                    Loading saved Market Scan…
                </p>
            ) : !scan ? (
                <p
                    style={{
                        marginTop: "20px",
                        color: "#475569",
                    }}
                >
                    No Market Scan has been run for this
                    store yet.
                </p>
            ) : (
                <div
                    style={{
                        marginTop: "22px",
                    }}
                >
                    <div
                        dir="rtl"
                        style={{
                            padding: "16px",
                            borderRadius: "12px",
                            background: "#ecfeff",
                            color: "#164e63",
                            lineHeight: 1.7,
                        }}
                    >
                        {scan.result.summary}
                    </div>

                    <div
                        style={{
                            display: "grid",
                            gap: "14px",
                            marginTop: "16px",
                        }}
                    >
                        {scan.result.candidates.map(
                            (candidate, index) => (
                                <CandidateCard
                                    key={`${candidate.name}-${index}`}
                                    candidate={
                                        candidate
                                    }
                                    rank={index + 1}
                                />
                            )
                        )}
                    </div>

                    <div
                        dir="rtl"
                        style={{
                            display: "grid",
                            gridTemplateColumns:
                                "repeat(auto-fit, minmax(260px, 1fr))",
                            gap: "16px",
                            marginTop: "18px",
                        }}
                    >
                        <div
                            style={{
                                padding: "16px",
                                border: "1px solid #cbd5e1",
                                borderRadius: "12px",
                                background: "#ffffff",
                            }}
                        >
                            <strong>
                                إشارات السوق
                            </strong>
                            {scan.result.marketSignals.map(
                                signal => (
                                    <p
                                        key={
                                            signal.signal
                                        }
                                        style={{
                                            margin:
                                                "10px 0 0",
                                            lineHeight: 1.65,
                                        }}
                                    >
                                        <strong>
                                            {signal.signal}:
                                        </strong>{" "}
                                        {signal.evidence}{" "}
                                        {signal.implication}
                                    </p>
                                )
                            )}
                        </div>

                        <div
                            style={{
                                padding: "16px",
                                border: "1px solid #fecaca",
                                borderRadius: "12px",
                                background: "#fff7ed",
                            }}
                        >
                            <strong>
                                مفاهيم يجب تجنبها الآن
                            </strong>
                            {scan.result.avoid.length ===
                            0 ? (
                                <p>
                                    لا توجد إضافات في هذه
                                    الجولة.
                                </p>
                            ) : (
                                <ul
                                    style={{
                                        paddingRight:
                                            "20px",
                                        lineHeight: 1.7,
                                    }}
                                >
                                    {scan.result.avoid.map(
                                        item => (
                                            <li
                                                key={
                                                    item.productConcept
                                                }
                                            >
                                                <strong>
                                                    {
                                                        item.productConcept
                                                    }
                                                    :
                                                </strong>{" "}
                                                {item.reason}
                                            </li>
                                        )
                                    )}
                                </ul>
                            )}
                        </div>
                    </div>

                    <div
                        dir="rtl"
                        style={{
                            marginTop: "18px",
                            padding: "16px",
                            borderRadius: "12px",
                            background: "#f8fafc",
                            lineHeight: 1.7,
                        }}
                    >
                        <p
                            style={{
                                margin: 0,
                            }}
                        >
                            <strong>
                                الخطوة التالية:
                            </strong>
                            {scan.result.nextStep}
                        </p>
                        <p
                            style={{
                                margin: "8px 0 0",
                                color: "#64748b",
                            }}
                        >
                            {scan.result.disclaimer}
                        </p>
                    </div>

                    <div
                        style={{
                            marginTop: "18px",
                        }}
                    >
                        <h3
                            style={{
                                margin: "0 0 8px",
                            }}
                        >
                            Research sources (
                            {scan.sourceCount})
                        </h3>
                        <ul
                            style={{
                                margin: 0,
                                paddingLeft: "20px",
                                lineHeight: 1.8,
                            }}
                        >
                            {scan.citations.map(
                                citation => (
                                    <li
                                        key={
                                            citation.url
                                        }
                                    >
                                        <a
                                            href={
                                                citation.url
                                            }
                                            target="_blank"
                                            rel="noreferrer noopener"
                                        >
                                            {
                                                citation.title
                                            }
                                        </a>
                                    </li>
                                )
                            )}
                        </ul>
                    </div>

                    <p
                        style={{
                            margin: "14px 0 0",
                            color: "#64748b",
                            fontSize: "13px",
                        }}
                    >
                        Generated {new Date(
                            scan.createdAt
                        ).toLocaleString()} · {scan.model}
                    </p>
                </div>
            )}
        </section>
    );
}
