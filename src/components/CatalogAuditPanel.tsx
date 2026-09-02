type CatalogVariant = {
    id?: string;
    title?: string;
    sku?: string | null;
    price: string;
    compareAtPrice?: string | null;
    inventoryQuantity: number;
    inventoryPolicy?: string;
};

type CatalogProduct = {
    id: string;
    title: string;
    vendor?: string;
    productType?: string;
    tags?: string[];
    totalInventory?: number;
    tracksInventory?: boolean;
    description?: string;
    variants: {
        nodes: CatalogVariant[];
    };
};

type AuditDecision =
    | "PAUSE_SUPPLIER"
    | "PRIVACY_SAFETY_REVIEW"
    | "REPRICE_OR_REPLACE"
    | "LOW_STOCK_REVIEW"
    | "SAFETY_REVIEW"
    | "OPTIMIZE"
    | "READY";

type ProductAudit = {
    product: CatalogProduct;
    decision: AuditDecision;
    decisionLabel: string;
    decisionColor: string;
    recommendation: string;
    issues: string[];
    variantCount: number;
    soldOutVariants: number;
    lowStockVariants: number;
    compareAtIssues: number;
    minimumPrice: number;
    maximumPrice: number;
    withinTargetPrice: boolean;
    safetyEvidenceRecorded: boolean;
};

const TARGET_MIN_PRICE = 20;
const TARGET_MAX_PRICE = 60;
const LOW_STOCK_LIMIT = 5;

const decisionRank: Record<
    AuditDecision,
    number
> = {
    PAUSE_SUPPLIER: 0,
    PRIVACY_SAFETY_REVIEW: 1,
    REPRICE_OR_REPLACE: 2,
    LOW_STOCK_REVIEW: 3,
    SAFETY_REVIEW: 4,
    OPTIMIZE: 5,
    READY: 6,
};

function finitePrice(value: string) {
    const price = Number(value);

    return Number.isFinite(price)
        ? price
        : null;
}

function auditProduct(
    product: CatalogProduct
): ProductAudit {
    const variants = product.variants?.nodes || [];

    const prices = variants
        .map((variant) => finitePrice(variant.price))
        .filter(
            (price): price is number =>
                price !== null
        );

    const minimumPrice =
        prices.length > 0
            ? Math.min(...prices)
            : 0;

    const maximumPrice =
        prices.length > 0
            ? Math.max(...prices)
            : 0;

    const soldOutVariants = variants.filter(
        (variant) =>
            Number(variant.inventoryQuantity) <= 0
    ).length;

    const lowStockVariants = variants.filter(
        (variant) => {
            const quantity = Number(
                variant.inventoryQuantity
            );

            return (
                quantity > 0 &&
                quantity <= LOW_STOCK_LIMIT
            );
        }
    ).length;

    const fullySoldOut =
        variants.length === 0 ||
        soldOutVariants === variants.length;

    const compareAtIssues = variants.filter(
        (variant) => {
            if (
                variant.compareAtPrice === null ||
                variant.compareAtPrice === undefined ||
                variant.compareAtPrice === ""
            ) {
                return false;
            }

            const price = finitePrice(variant.price);
            const compareAt = finitePrice(
                variant.compareAtPrice
            );

            return (
                price !== null &&
                compareAt !== null &&
                compareAt <= price
            );
        }
    ).length;

    const withinTargetPrice =
        prices.length > 0 &&
        minimumPrice >= TARGET_MIN_PRICE &&
        maximumPrice <= TARGET_MAX_PRICE;

    const searchableText = [
        product.title,
        product.description || "",
        ...(product.tags || []),
    ]
        .join(" ")
        .toLowerCase();

    const safetyEvidenceRecorded =
        /\b(cpc|cpsia|astm\s*f963)\b/i.test(
            searchableText
        );

    const privacyReviewRequired =
        /\b(tuya|wi-?fi|connected|voice assistant|ai robot)\b/i.test(
            searchableText
        );

    const magnetReviewRequired =
        /\bmagnet(ic|s)?\b/i.test(
            searchableText
        );

    const experimentReviewRequired =
        /\b(chemical|reagent|combustion|circuit|electronic experiment)\b/i.test(
            searchableText
        );

    const supplierCopyDetected =
        /specifications|high-concerned chemical|welcome to our store|choice:/i.test(
            searchableText
        );

    const ageFitRecorded =
        /6\s*[-–]\s*12|6-12y/i.test(
            searchableText
        );

    const issues: string[] = [];

    if (fullySoldOut) {
        issues.push(
            "Every published variant is sold out."
        );
    } else if (soldOutVariants > 0) {
        issues.push(
            `${soldOutVariants} of ${variants.length} variants are sold out.`
        );
    }

    if (lowStockVariants > 0) {
        issues.push(
            `${lowStockVariants} variant(s) have 1–${LOW_STOCK_LIMIT} units available.`
        );
    }

    if (!withinTargetPrice) {
        issues.push(
            `Price range is outside the store target of $${TARGET_MIN_PRICE}–$${TARGET_MAX_PRICE}.`
        );
    }

    if (compareAtIssues > 0) {
        issues.push(
            `${compareAtIssues} variant(s) have Compare-at price less than or equal to the selling price.`
        );
    }

    if (!product.productType?.trim()) {
        issues.push("Product type is missing.");
    }

    if (!product.tags || product.tags.length === 0) {
        issues.push("Product tags are missing.");
    }

    if (product.title.trim().length > 80) {
        issues.push(
            "Title is too long for a clear US retail listing."
        );
    }

    if (supplierCopyDetected) {
        issues.push(
            "Description contains supplier-style copy that needs rewriting."
        );
    }

    if (!ageFitRecorded) {
        issues.push(
            "The 6–12 age fit is not clearly recorded in the catalog text."
        );
    }

    if (!safetyEvidenceRecorded) {
        issues.push(
            "US safety evidence (CPC/CPSIA/ASTM F963) is not recorded in the catalog data."
        );
    }

    if (magnetReviewRequired) {
        issues.push(
            "Magnet safety and small-parts warnings require review."
        );
    }

    if (experimentReviewRequired) {
        issues.push(
            "Experiment/circuit hazards and adult-supervision instructions require review."
        );
    }

    if (privacyReviewRequired) {
        issues.push(
            "Connected-toy privacy and COPPA review is required."
        );
    }

    let decision: AuditDecision;
    let decisionLabel: string;
    let decisionColor: string;
    let recommendation: string;

    if (fullySoldOut) {
        decision = "PAUSE_SUPPLIER";
        decisionLabel = "Pause & review supplier";
        decisionColor = "#b91c1c";
        recommendation =
            "Pause the listing until US availability or a dependable replacement supplier is confirmed.";
    } else if (privacyReviewRequired) {
        decision = "PRIVACY_SAFETY_REVIEW";
        decisionLabel = "Privacy & safety review";
        decisionColor = "#7e22ce";
        recommendation =
            "Do not advertise this connected toy until data collection, parental consent, and US safety documentation are verified.";
    } else if (!withinTargetPrice) {
        decision = "REPRICE_OR_REPLACE";
        decisionLabel = "Reprice or replace";
        decisionColor = "#c2410c";
        recommendation =
            "Check landed cost and market pricing. Keep it only if a credible $20–$60 retail offer remains profitable.";
    } else if (lowStockVariants > 0) {
        decision = "LOW_STOCK_REVIEW";
        decisionLabel = "Review supplier stock";
        decisionColor = "#a16207";
        recommendation =
            "Confirm reliable US delivery and supplier replenishment before sending paid traffic to this product.";
    } else if (!safetyEvidenceRecorded) {
        decision = "SAFETY_REVIEW";
        decisionLabel = "Safety review required";
        decisionColor = "#a16207";
        recommendation =
            "Request CPC, CPSIA, and ASTM F963 evidence before approving the product for US promotion.";
    } else if (
        compareAtIssues > 0 ||
        !product.productType?.trim() ||
        !product.tags ||
        product.tags.length === 0 ||
        supplierCopyDetected ||
        product.title.trim().length > 80
    ) {
        decision = "OPTIMIZE";
        decisionLabel = "Keep & optimize";
        decisionColor = "#1d4ed8";
        recommendation =
            "Keep the product under review while improving title, description, taxonomy, tags, and pricing presentation.";
    } else {
        decision = "READY";
        decisionLabel = "Ready for review";
        decisionColor = "#047857";
        recommendation =
            "The catalog data passes the current rule-based checks; complete a final human review before promotion.";
    }

    return {
        product,
        decision,
        decisionLabel,
        decisionColor,
        recommendation,
        issues,
        variantCount: variants.length,
        soldOutVariants,
        lowStockVariants,
        compareAtIssues,
        minimumPrice,
        maximumPrice,
        withinTargetPrice,
        safetyEvidenceRecorded,
    };
}

function moneyRange(
    minimum: number,
    maximum: number
) {
    if (minimum === maximum) {
        return `$${minimum.toFixed(2)}`;
    }

    return `$${minimum.toFixed(2)}–$${maximum.toFixed(2)}`;
}

export default function CatalogAuditPanel({
    products,
}: {
    products: CatalogProduct[];
}) {
    const audits = products
        .map(auditProduct)
        .sort(
            (a, b) =>
                decisionRank[a.decision] -
                    decisionRank[b.decision] ||
                a.product.title.localeCompare(
                    b.product.title
                )
        );

    const pauseCount = audits.filter(
        (audit) =>
            audit.decision === "PAUSE_SUPPLIER"
    ).length;

    const priceFitCount = audits.filter(
        (audit) => audit.withinTargetPrice
    ).length;

    const compareAtIssueCount = audits.reduce(
        (total, audit) =>
            total + audit.compareAtIssues,
        0
    );

    const missingSafetyEvidenceCount = audits.filter(
        (audit) => !audit.safetyEvidenceRecorded
    ).length;

    return (
        <section
            style={{
                marginTop: "42px",
                padding: "24px",
                border: "1px solid #cbd5e1",
                borderRadius: "18px",
                background: "#f8fafc",
            }}
        >
            <div
                style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "18px",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                }}
            >
                <div>
                    <div
                        style={{
                            color: "#334155",
                            fontSize: "13px",
                            fontWeight: 800,
                            letterSpacing: "0.06em",
                            textTransform: "uppercase",
                        }}
                    >
                        Rule-based · Read only
                    </div>

                    <h2
                        style={{
                            margin: "6px 0 7px",
                        }}
                    >
                        Future Builders Catalog Audit
                    </h2>

                    <p
                        style={{
                            margin: 0,
                            color: "#475569",
                            lineHeight: 1.6,
                            maxWidth: "820px",
                        }}
                    >
                        Products are checked against the
                        current strategy: ages 6–12,
                        United States first, $20–$60
                        retail price, dependable supplier
                        stock, and documented US toy
                        safety. No Shopify data is changed.
                    </p>
                </div>
            </div>

            {audits.length === 0 ? (
                <p
                    style={{
                        marginTop: "18px",
                    }}
                >
                    No published products are available
                    for catalog review.
                </p>
            ) : (
                <>
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns:
                                "repeat(auto-fit, minmax(155px, 1fr))",
                            gap: "12px",
                            marginTop: "20px",
                            marginBottom: "18px",
                        }}
                    >
                        <AuditSummary
                            label="Published products"
                            value={audits.length}
                            color="#1d4ed8"
                        />
                        <AuditSummary
                            label="Pause candidates"
                            value={pauseCount}
                            color="#b91c1c"
                        />
                        <AuditSummary
                            label="Within $20–$60"
                            value={priceFitCount}
                            color="#047857"
                        />
                        <AuditSummary
                            label="Compare-at issues"
                            value={compareAtIssueCount}
                            color="#c2410c"
                        />
                        <AuditSummary
                            label="Safety evidence missing"
                            value={missingSafetyEvidenceCount}
                            color="#7e22ce"
                        />
                    </div>

                    {audits.map((audit) => (
                        <details
                            key={audit.product.id}
                            style={{
                                border:
                                    "1px solid #dbe3ee",
                                borderRadius: "12px",
                                background: "#ffffff",
                                marginBottom: "12px",
                                overflow: "hidden",
                            }}
                        >
                            <summary
                                style={{
                                    cursor: "pointer",
                                    padding: "16px 18px",
                                    fontWeight: 700,
                                }}
                            >
                                <span
                                    style={{
                                        display: "inline-block",
                                        color:
                                            audit.decisionColor,
                                        marginRight: "10px",
                                    }}
                                >
                                    {audit.decisionLabel}
                                </span>

                                {audit.product.title}
                            </summary>

                            <div
                                style={{
                                    padding: "0 18px 18px",
                                }}
                            >
                                <div
                                    style={{
                                        display: "grid",
                                        gridTemplateColumns:
                                            "repeat(auto-fit, minmax(150px, 1fr))",
                                        gap: "10px",
                                        marginBottom: "16px",
                                    }}
                                >
                                    <Metric
                                        label="Price"
                                        value={moneyRange(
                                            audit.minimumPrice,
                                            audit.maximumPrice
                                        )}
                                    />
                                    <Metric
                                        label="Inventory"
                                        value={String(
                                            audit.product
                                                .totalInventory ??
                                                0
                                        )}
                                    />
                                    <Metric
                                        label="Variants"
                                        value={String(
                                            audit.variantCount
                                        )}
                                    />
                                    <Metric
                                        label="Sold out"
                                        value={String(
                                            audit.soldOutVariants
                                        )}
                                    />
                                    <Metric
                                        label="Low stock"
                                        value={String(
                                            audit.lowStockVariants
                                        )}
                                    />
                                </div>

                                <p
                                    style={{
                                        margin: "0 0 12px",
                                        lineHeight: 1.6,
                                    }}
                                >
                                    <strong>
                                        Recommended next step:
                                    </strong>{" "}
                                    {audit.recommendation}
                                </p>

                                <strong>Detected issues</strong>

                                <ul
                                    style={{
                                        marginBottom: 0,
                                        paddingLeft: "22px",
                                        lineHeight: 1.65,
                                    }}
                                >
                                    {audit.issues.map((issue) => (
                                        <li key={issue}>
                                            {issue}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </details>
                    ))}
                </>
            )}
        </section>
    );
}

function AuditSummary({
    label,
    value,
    color,
}: {
    label: string;
    value: number;
    color: string;
}) {
    return (
        <div
            style={{
                padding: "14px 16px",
                border: "1px solid #dbe3ee",
                borderRadius: "10px",
                background: "#ffffff",
            }}
        >
            <div
                style={{
                    color: "#64748b",
                    fontSize: "13px",
                    marginBottom: "4px",
                }}
            >
                {label}
            </div>
            <div
                style={{
                    color,
                    fontSize: "26px",
                    fontWeight: 800,
                }}
            >
                {value}
            </div>
        </div>
    );
}

function Metric({
    label,
    value,
}: {
    label: string;
    value: string;
}) {
    return (
        <div
            style={{
                padding: "10px 12px",
                borderRadius: "9px",
                background: "#f8fafc",
            }}
        >
            <div
                style={{
                    color: "#64748b",
                    fontSize: "12px",
                }}
            >
                {label}
            </div>
            <strong>{value}</strong>
        </div>
    );
}
