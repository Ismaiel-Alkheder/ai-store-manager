"use client";
import { useEffect, useState } from "react";
import AdminAccountControls from "@/components/AdminAccountControls";

type ProductVariant = {
    id?: string;
    title?: string;
    price: string;
    inventoryQuantity: number;
};

type Product = {
    id: string;
    title: string;
    variants: {
        nodes: ProductVariant[];
    };
};

type Order = {
    id: string;
    name: string;
    createdAt: string;
    displayFinancialStatus: string;
    displayFulfillmentStatus: string;

    totalPriceSet: {
        shopMoney: {
            amount: string;
            currencyCode: string;
        };
    };
};

type ApprovalStatus =
    | "PENDING"
    | "APPROVED"
    | "REJECTED"
    | "CANCELLED";

type OrderApproval = {
    id: string;
    source: "ORDER";
    action: "REVIEW_FULFILLMENT";
    orderName: string;
    orderId: number;
    reason: string;
    status: ApprovalStatus;
    createdAt: string;
    decidedAt: string | null;
};

type InventoryApproval = {
    id: string;
    source: "INVENTORY";
    action: "REVIEW_RESTOCK";

    inventoryAlertId: number;
    inventoryItemId: number;
    locationId: number;

    available: number;

    productTitle: string;
    variantTitle: string;
    sku: string;

    reason: string;
    status: ApprovalStatus;

    createdAt: string;
    decidedAt: string | null;
};

type ApprovalItem =
    | OrderApproval
    | InventoryApproval;

type InventoryAlert = {
    id: number;

    inventoryItemId: number;
    locationId: number;

    available: number;
    status: string;

    productTitle: string;
    variantTitle: string;
    sku: string;

    productId: string | null;
    variantId: string | null;

    createdAt: string;
    updatedAt: string;
    resolvedAt: string | null;
};

type RestockReceipt = {
    quantityReceived: number;
    stockBefore: number;
    stockAfter: number;
    status: string;
    shopifyAdjustmentId: string | null;
    completedAt: string | null;
};

type RestockTask = {
    id: string;

    inventoryApprovalId: string;
    inventoryAlertId: number;

    inventoryItemId: number;
    locationId: number;

    availableWhenApproved: number;

    productTitle: string;
    variantTitle: string;
    sku: string;

    status: string;

    createdAt: string;
    updatedAt: string;
    completedAt: string | null;

    receipt: RestockReceipt | null;
};

type AgentEvent = {
    id: number;
    eventKey: string;

    source: string;
    eventType: string;

    entityType: string;
    entityId: string;

    title: string;
    message: string | null;

    status: string | null;

    createdAt: string;
};

type TopProduct = {
    productName: string;
    unitsSold: number;
};

type StoreAnalytics = {
    source: string;

    ordersAnalyzed: number;
    currency: string;

    sales: {
        totalOrderValue: number;
        averageOrderValue: number;
        paidOrders: number;
        needsFulfillment: number;
    };

    inventory: {
        openAlerts: number;
        activeRestockTasks: number;
        completedRestocks: number;
    };

    approvals: {
        pending: number;
    };

    topProducts: TopProduct[];

    generatedAt: string;
};

type FulfillmentLineItem = {
    fulfillmentOrderLineItemId: string;
    productTitle: string;
    variantTitle: string;
    sku: string;
    totalQuantity: number;
    remainingQuantity: number;
    requiresShipping: boolean;
};

type FulfillmentTask = {
    id: string;
    orderId: string;
    orderName: string;
    financialStatus: string;
    orderFulfillmentStatus: string;
    fulfillmentOrderStatus: string;
    requestStatus?: string | null;
    locationName?: string | null;
    remainingQuantity: number;
    lineItems: FulfillmentLineItem[];
    status: string;
    warning: string | null;
    completedAt: string | null;
    shopifyFulfillmentId: string | null;
};

type FulfillmentSettings = {
    fulfillmentMode: "MANUAL" | "AUTOMATIC";
    autoShipEnabled: boolean;
    automaticBehavior: {
        acceptFulfillmentRequests: boolean;
        shipAutomatically: boolean;
    };
};

type SecurityEvent = {
    id: number;
    eventType: string;
    outcome: string;
    message: string | null;
    createdAt: string;
};

export default function DashboardPage() {
    const [products, setProducts] =
        useState<Product[]>([]);

    const [orders, setOrders] =
        useState<Order[]>([]);

    const [approvals, setApprovals] =
        useState<ApprovalItem[]>([]);

    const [
        inventoryAlerts,
        setInventoryAlerts,
    ] = useState<InventoryAlert[]>([]);

    const [
        restockTasks,
        setRestockTasks,
    ] = useState<RestockTask[]>([]);

    const [
        agentEvents,
        setAgentEvents,
    ] = useState<AgentEvent[]>([]);

    const [
        securityEvents,
        setSecurityEvents,
    ] = useState<SecurityEvent[]>([]);

    const [
        analytics,
        setAnalytics,
    ] = useState<StoreAnalytics | null>(
        null
    );

    const [
        fulfillmentTasks,
        setFulfillmentTasks,
    ] = useState<FulfillmentTask[]>([]);

    const [
        fulfillmentSettings,
        setFulfillmentSettings,
    ] = useState<FulfillmentSettings>({
        fulfillmentMode: "MANUAL",
        autoShipEnabled: false,
        automaticBehavior: {
            acceptFulfillmentRequests: false,
            shipAutomatically: false,
        },
    });

    const [
        lastRefreshedAt,
        setLastRefreshedAt,
    ] = useState<Date | null>(null);

    const [
        receivedQuantities,
        setReceivedQuantities,
    ] = useState<Record<string, string>>(
        {}
    );

    const [
        receivingTaskId,
        setReceivingTaskId,
    ] = useState<string | null>(null);

    const [loading, setLoading] =
        useState(true);

    const [error, setError] =
        useState("");

    const [
        aiAnalysis,
        setAiAnalysis,
    ] = useState("");

    const [
        aiAnalysisLoading,
        setAiAnalysisLoading,
    ] = useState(false);

    const [
        aiAnalysisError,
        setAiAnalysisError,
    ] = useState("");

    const [
        aiAnalysisGeneratedAt,
        setAiAnalysisGeneratedAt,
    ] = useState<Date | null>(null);

    async function loadData() {
        /*
          Load each Dashboard API independently.

          This prevents one temporary API failure
          from blocking the Approval Queue refresh.
        */

        const requests = [
            {
                name: "products",
                url: "/api/shopify/products",
            },
            {
                name: "orders",
                url: "/api/shopify/orders",
            },
            {
                name: "approvals",
                url: "/api/approvals",
            },
            {
                name: "inventoryAlerts",
                url: "/api/inventory-alerts",
            },
            {
                name: "restockTasks",
                url: "/api/restock-tasks",
            },
            {
                name: "agentEvents",
                url: "/api/agent-events",
            },
            {
                name: "securityEvents",
                url: "/api/admin/security-events?limit=20",
            },
            {
                name: "analytics",
                url: "/api/store-analytics",
            },
            {
                name: "fulfillmentTasks",
                url: "/api/fulfillment-tasks",
            },
            {
                name: "fulfillmentSettings",
                url: "/api/fulfillment-settings",
            },
        ] as const;

        try {
            const results =
                await Promise.allSettled(
                    requests.map(
                        async (request) => {
                            const response =
                                await fetch(
                                    request.url,
                                    {
                                        cache: "no-store",
                                    }
                                );

                            if (!response.ok) {
                                throw new Error(
                                    `${request.name} returned HTTP ${response.status}`
                                );
                            }

                            return {
                                name:
                                    request.name,

                                data:
                                    await response.json(),
                            };
                        }
                    )
                );

            const failures:
                string[] = [];

            for (
                let index = 0;
                index < results.length;
                index++
            ) {
                const result =
                    results[index];

                const request =
                    requests[index];

                if (
                    result.status ===
                    "rejected"
                ) {
                    console.error(
                        `Dashboard ${request.name} error:`,
                        result.reason
                    );

                    failures.push(
                        request.name
                    );

                    continue;
                }

                const {
                    name,
                    data,
                } =
                    result.value;

                if (
                    name ===
                    "products"
                ) {
                    setProducts(
                        data.products
                            ?.nodes ||
                        []
                    );
                }

                if (
                    name ===
                    "orders"
                ) {
                    setOrders(
                        data.orders
                            ?.nodes ||
                        []
                    );
                }

                if (
                    name ===
                    "approvals"
                ) {
                    setApprovals(
                        data.approvals ||
                        []
                    );
                }

                if (
                    name ===
                    "inventoryAlerts"
                ) {
                    setInventoryAlerts(
                        data.alerts ||
                        []
                    );
                }

                if (
                    name ===
                    "restockTasks"
                ) {
                    setRestockTasks(
                        data.tasks ||
                        []
                    );
                }

                if (
                    name ===
                    "agentEvents"
                ) {
                    setAgentEvents(
                        data.events ||
                        []
                    );
                }

                if (
                    name ===
                    "securityEvents"
                ) {
                    setSecurityEvents(
                        data.events ||
                        []
                    );
                }

                if (
                    name ===
                    "analytics"
                ) {
                    setAnalytics(
                        data
                    );
                }

                if (
                    name ===
                    "fulfillmentTasks"
                ) {
                    setFulfillmentTasks(
                        data.tasks ||
                        []
                    );
                }

                if (
                    name ===
                    "fulfillmentSettings"
                ) {
                    setFulfillmentSettings({
                        fulfillmentMode:
                            data.fulfillmentMode ===
                                "AUTOMATIC"
                                ? "AUTOMATIC"
                                : "MANUAL",

                        autoShipEnabled:
                            data.autoShipEnabled ===
                            true,

                        automaticBehavior: {
                            acceptFulfillmentRequests:
                                data
                                    .automaticBehavior
                                    ?.acceptFulfillmentRequests ===
                                true,

                            shipAutomatically:
                                data
                                    .automaticBehavior
                                    ?.shipAutomatically ===
                                true,
                        },
                    });
                }
            }

            setLastRefreshedAt(
                new Date()
            );

            if (
                failures.length >
                0
            ) {
                setError(
                    `Some dashboard sections could not refresh: ${failures.join(
                        ", "
                    )}. Other sections are still updating normally.`
                );
            } else {
                setError("");
            }
        } catch (err) {
            console.error(
                "Dashboard error:",
                err
            );

            setError(
                err instanceof Error
                    ? err.message
                    : "Could not load dashboard."
            );
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        loadData();

        const interval =
            setInterval(() => {
                loadData();
            }, 30000);

        return () => {
            clearInterval(interval);
        };
    }, []);

    async function analyzeStore() {
        if (aiAnalysisLoading) {
            return;
        }

        try {
            setAiAnalysisLoading(true);
            setAiAnalysisError("");

            const response =
                await fetch(
                    "/api/ai/analyze",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json",
                        },
                        credentials:
                            "same-origin",
                        cache: "no-store",
                        body: JSON.stringify({
                            products,
                            orders,
                        }),
                    }
                );

            const result =
                await response
                    .json()
                    .catch(() => null);

            if (!response.ok) {
                throw new Error(
                    result?.error ||
                    `AI analysis returned HTTP ${response.status}.`
                );
            }

            if (
                typeof result?.analysis !==
                "string" ||
                !result.analysis.trim()
            ) {
                throw new Error(
                    "The AI analysis was empty."
                );
            }

            setAiAnalysis(
                result.analysis.trim()
            );

            setAiAnalysisGeneratedAt(
                new Date()
            );
        } catch (err) {
            console.error(
                "AI analysis error:",
                err
            );

            setAiAnalysisError(
                err instanceof Error
                    ? err.message
                    : "Could not generate the AI store report."
            );
        } finally {
            setAiAnalysisLoading(false);
        }
    }

    async function decide(
        id: string,
        decision:
            | "APPROVED"
            | "REJECTED"
    ) {
        try {
            const response =
                await fetch(
                    "/api/approvals",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json",
                        },

                        body: JSON.stringify({
                            id,
                            decision,
                        }),
                    }
                );

            const result =
                await response.json();

            if (!response.ok) {
                alert(
                    result.error ||
                    "Approval failed"
                );

                return;
            }

            await loadData();
        } catch (err) {
            console.error(
                "Approval error:",
                err
            );

            alert(
                "Could not process approval."
            );
        }
    }

    async function receiveInventory(
        taskId: string
    ) {
        const quantityText =
            receivedQuantities[taskId];

        const quantity =
            Number(quantityText);

        if (
            !Number.isInteger(quantity) ||
            quantity <= 0
        ) {
            alert(
                "Please enter a positive whole number."
            );

            return;
        }

        const confirmed =
            window.confirm(
                `Receive ${quantity} units into Shopify inventory?`
            );

        if (!confirmed) {
            return;
        }

        try {
            setReceivingTaskId(
                taskId
            );

            const response =
                await fetch(
                    "/api/restock-tasks",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json",
                        },

                        body: JSON.stringify({
                            id: taskId,

                            receivedQuantity:
                                quantity,
                        }),
                    }
                );

            const result =
                await response.json();

            if (!response.ok) {
                alert(
                    result.error ||
                    "Could not receive inventory."
                );

                return;
            }

            alert(
                `Inventory received successfully.\n\nStock before: ${result.stockBefore}\nReceived: ${result.receivedQuantity}\nStock after: ${result.stockAfter}`
            );

            setReceivedQuantities(
                (current) => ({
                    ...current,
                    [taskId]: "",
                })
            );

            await loadData();
        } catch (err) {
            console.error(
                "Receive inventory error:",
                err
            );

            alert(
                "Could not receive inventory."
            );
        } finally {
            setReceivingTaskId(
                null
            );
        }
    }

    const pendingApprovals =
        approvals.filter(
            (item) =>
                item.status === "PENDING"
        );

    const approvalHistory =
        approvals.filter(
            (item) =>
                item.status !== "PENDING"
        );

    const openInventoryAlerts =
        inventoryAlerts.filter(
            (item) =>
                item.status === "OPEN"
        );

    const activeRestockTasks =
        restockTasks.filter(
            (item) =>
                item.status !== "COMPLETED"
        );

    const completedRestockTasks =
        restockTasks.filter(
            (item) =>
                item.status === "COMPLETED"
        );

    const waitingApprovalFulfillmentTasks =
        fulfillmentTasks.filter(
            (task) =>
                task.status ===
                "WAITING_APPROVAL"
        );

    const readyFulfillmentTasks =
        fulfillmentTasks.filter(
            (task) =>
                task.status ===
                "READY_TO_FULFILL"
        );

    const reviewFulfillmentTasks =
        fulfillmentTasks.filter(
            (task) =>
                task.status ===
                "REVIEW_REQUIRED"
        );

    const processingFulfillmentTasks =
        fulfillmentTasks.filter(
            (task) =>
                task.status ===
                "PROCESSING"
        );

    const completedFulfillmentTasks =
        fulfillmentTasks.filter(
            (task) =>
                task.status ===
                "COMPLETED"
        );

    if (loading) {
        return (
            <main
                style={{
                    padding: "40px",
                    fontFamily:
                        "Arial, sans-serif",
                }}
            >
                <h2>
                    Loading store data...
                </h2>
            </main>
        );
    }

    const waitingApprovalCount =
        fulfillmentTasks.filter(
            (task) =>
                String(
                    task.status || ""
                ).toUpperCase() ===
                "WAITING_APPROVAL"
        ).length;

    const reviewRequiredCount =
        fulfillmentTasks.filter(
            (task) =>
                String(
                    task.status || ""
                ).toUpperCase() ===
                "REVIEW_REQUIRED"
        ).length;

    const rejectedCount =
        fulfillmentTasks.filter(
            (task) =>
                String(
                    task.requestStatus || ""
                ).toUpperCase() ===
                "REJECTED"
        ).length;

    const needsAttentionCount =
        waitingApprovalCount +
        reviewRequiredCount;

    return (
        <main
            className="dashboardPage"
            style={{
                padding: "32px",
                maxWidth: "1280px",
                margin: "0 auto",
                fontFamily:
                    "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
                color: "#0f172a",
            }}
        >
            <div
                style={{
                    padding: "28px 30px",
                    borderRadius: "20px",
                    background:
                        "linear-gradient(135deg, #0f172a 0%, #1e3a8a 55%, #2563eb 100%)",
                    color: "#ffffff",
                    boxShadow:
                        "0 18px 42px rgba(15, 23, 42, 0.18)",
                    border:
                        "1px solid rgba(255,255,255,0.12)",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "20px",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                }}
            >
                <div>
                    <div
                        style={{
                            fontSize: "13px",
                            fontWeight: "700",
                            letterSpacing: "0.08em",
                            textTransform: "uppercase",
                            opacity: 0.78,
                        }}
                    >
                        Shopify Operations
                    </div>

                    <h1
                        style={{
                            margin: "7px 0 6px",
                            fontSize: "34px",
                            lineHeight: 1.15,
                        }}
                    >
                        AI Store Manager
                    </h1>

                    <p
                        style={{
                            margin: 0,
                            color: "rgba(255,255,255,0.82)",
                            fontSize: "15px",
                        }}
                    >
                        Store health, approvals, inventory, fulfillment, and automation in one dashboard.
                    </p>
                </div>

                <AdminAccountControls variant="dark" />
            </div>

            {error && (
                <div
                    style={{
                        padding: "15px 16px",
                        border:
                            "1px solid #fecaca",
                        borderRadius:
                            "12px",
                        marginTop:
                            "20px",
                        background:
                            "#fef2f2",
                        color:
                            "#991b1b",
                        boxShadow:
                            "0 4px 14px rgba(153, 27, 27, 0.06)",
                    }}
                >
                    ⚠️ {error}
                </div>
            )}

            {/* NEEDS ATTENTION */}

            <h2
                style={{
                    marginTop: "35px",
                }}
            >
                Needs Attention
            </h2>

            <div
                style={{
                    display: "grid",
                    gridTemplateColumns:
                        "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: "20px",
                    marginTop: "20px",
                }}
            >
                <Card
                    title="Needs Attention"
                    value={
                        needsAttentionCount.toString()
                    }
                />

                <Card
                    title="Waiting Approval"
                    value={
                        waitingApprovalCount.toString()
                    }
                />

                <Card
                    title="Review Required"
                    value={
                        reviewRequiredCount.toString()
                    }
                />

                <Card
                    title="Rejected"
                    value={
                        rejectedCount.toString()
                    }
                />
            </div>

            {needsAttentionCount > 0 ? (
                <div
                    style={{
                        marginTop: "18px",
                        padding: "16px",
                        border: "1px solid #f59e0b",
                        borderRadius: "12px",
                        background:
                            "rgba(245, 158, 11, 0.08)",
                    }}
                >
                    <strong>
                        Action required
                    </strong>

                    <div
                        style={{
                            marginTop: "6px",
                            color: "#475569",
                        }}
                    >
                        {waitingApprovalCount >
                            0
                            ? `${waitingApprovalCount} order(s) are waiting for approval. `
                            : ""}

                        {reviewRequiredCount >
                            0
                            ? `${reviewRequiredCount} fulfillment task(s) require review.`
                            : ""}
                    </div>

                    <a
                        href="/fulfillment"
                        style={{
                            display:
                                "inline-block",
                            marginTop:
                                "12px",
                            padding:
                                "10px 14px",
                            borderRadius:
                                "10px",
                            background:
                                "#b45309",
                            color: "#fff",
                            textDecoration:
                                "none",
                            fontWeight:
                                "bold",
                        }}
                    >
                        Review Fulfillment Tasks
                    </a>
                </div>
            ) : (
                <div
                    style={{
                        marginTop: "18px",
                        padding: "16px",
                        border: "1px solid #86efac",
                        borderRadius: "12px",
                        background:
                            "rgba(34, 197, 94, 0.08)",
                    }}
                >
                    <strong>
                        No fulfillment action
                        is currently required.
                    </strong>
                </div>
            )}

            {/* AUTOMATION STATUS */}

            <h2
                style={{
                    marginTop: "35px",
                }}
            >
                Automation Status
            </h2>

            <div
                style={{
                    display: "grid",
                    gridTemplateColumns:
                        "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: "20px",
                    marginTop: "20px",
                }}
            >
                <Card
                    title="Fulfillment Mode"
                    value={
                        fulfillmentSettings.fulfillmentMode
                    }
                />

                <Card
                    title="Auto-Accept"
                    value={
                        fulfillmentSettings
                            .automaticBehavior
                            .acceptFulfillmentRequests
                            ? "ON"
                            : "OFF"
                    }
                />

                <Card
                    title="Auto-Ship"
                    value={
                        fulfillmentSettings
                            .automaticBehavior
                            .shipAutomatically
                            ? "ON"
                            : "OFF"
                    }
                />

                <Card
                    title="Fulfillment Tasks"
                    value={
                        fulfillmentTasks.length.toString()
                    }
                />
            </div>

            <div
                style={{
                    marginTop: "18px",
                    padding: "18px",
                    border: "1px solid #dbe3ee",
                    borderRadius: "16px",
                    background: "#ffffff",
                    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "18px",
                    flexWrap: "wrap",
                }}
            >
                <div>
                    <strong>
                        Fulfillment Control Center
                    </strong>

                    <div
                        style={{
                            marginTop: "5px",
                            color: "#475569",
                        }}
                    >
                        Manage approvals,
                        fulfillment requests,
                        retries, warehouse
                        decisions, and shipping
                        from the dedicated page.
                    </div>
                </div>

                <a
                    href="/fulfillment"
                    style={{
                        display: "inline-block",
                        padding: "11px 16px",
                        borderRadius: "10px",
                        background: "#111827",
                        color: "#fff",
                        textDecoration: "none",
                        fontWeight: "bold",
                    }}
                >
                    Open Fulfillment Manager
                </a>
            </div>

            {/* STORE ANALYTICS */}

            <h2
                style={{
                    marginTop: "40px",
                }}
            >
                Store Analytics
            </h2>

            {analytics ? (
                <>
                    <div
                        style={{
                            display: "grid",

                            gridTemplateColumns:
                                "repeat(auto-fit, minmax(180px, 1fr))",

                            gap: "20px",

                            marginTop: "20px",
                        }}
                    >
                        <Card
                            title="Orders Analyzed"
                            value={
                                analytics.ordersAnalyzed.toString()
                            }
                        />

                        <Card
                            title="Total Order Value"
                            value={`${analytics.currency} ${formatMoney(
                                analytics.sales
                                    .totalOrderValue
                            )}`}
                        />

                        <Card
                            title="Average Order"
                            value={`${analytics.currency} ${formatMoney(
                                analytics.sales
                                    .averageOrderValue
                            )}`}
                        />

                        <Card
                            title="Paid Orders"
                            value={
                                analytics.sales
                                    .paidOrders.toString()
                            }
                        />

                        <Card
                            title="Needs Fulfillment"
                            value={
                                analytics.sales
                                    .needsFulfillment.toString()
                            }
                        />

                        <Card
                            title="Pending Approvals"
                            value={
                                analytics.approvals
                                    .pending.toString()
                            }
                        />

                        <Card
                            title="Low Inventory"
                            value={
                                analytics.inventory
                                    .openAlerts.toString()
                            }
                        />

                        <Card
                            title="Active Restocks"
                            value={
                                analytics.inventory
                                    .activeRestockTasks.toString()
                            }
                        />
                    </div>

                    <h3
                        style={{
                            marginTop: "30px",
                        }}
                    >
                        Top Products by Units Sold
                    </h3>

                    {analytics.topProducts.length ===
                        0 ? (
                        <p>
                            No product sales data
                            available.
                        </p>
                    ) : (
                        <div
                            style={{
                                border:
                                    "1px solid #dbe3ee",

                                borderRadius:
                                    "12px",

                                overflow:
                                    "hidden",
                            }}
                        >
                            {analytics.topProducts.map(
                                (
                                    product,
                                    index
                                ) => (
                                    <div
                                        key={
                                            product.productName
                                        }
                                        style={{
                                            display:
                                                "flex",

                                            justifyContent:
                                                "space-between",

                                            gap:
                                                "20px",

                                            padding:
                                                "15px 18px",

                                            borderBottom:
                                                index ===
                                                    analytics
                                                        .topProducts
                                                        .length -
                                                    1
                                                    ? "none"
                                                    : "1px solid #dbe3ee",
                                        }}
                                    >
                                        <span>
                                            <strong>
                                                {index + 1}.
                                            </strong>{" "}
                                            {
                                                product.productName
                                            }
                                        </span>

                                        <strong>
                                            {
                                                product.unitsSold
                                            }{" "}
                                            units
                                        </strong>
                                    </div>
                                )
                            )}
                        </div>
                    )}

                    <p
                        style={{
                            marginTop: "12px",
                        }}
                    >
                        <small>
                            Analytics generated from
                            up to the latest 50 Shopify
                            orders. Order value is not
                            yet adjusted for detailed
                            refunds.
                        </small>
                    </p>
                </>
            ) : (
                <p>
                    Analytics unavailable.
                </p>
            )}

            {/* AI STORE REPORT */}

            <section
                style={{
                    marginTop: "42px",
                    padding: "24px",
                    border: "1px solid #bfdbfe",
                    borderRadius: "18px",
                    background:
                        "linear-gradient(135deg, #eff6ff 0%, #ffffff 58%, #eef2ff 100%)",
                    boxShadow:
                        "0 10px 30px rgba(37, 99, 235, 0.08)",
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
                            maxWidth: "760px",
                        }}
                    >
                        <div
                            style={{
                                color: "#1d4ed8",
                                fontSize: "13px",
                                fontWeight: "800",
                                letterSpacing:
                                    "0.06em",
                                textTransform:
                                    "uppercase",
                            }}
                        >
                            Read-only AI analysis
                        </div>

                        <h2
                            style={{
                                margin:
                                    "6px 0 7px",
                            }}
                        >
                            AI Store Report
                        </h2>

                        <p
                            style={{
                                margin: 0,
                                color: "#475569",
                                lineHeight: 1.6,
                            }}
                        >
                            Analyze the currently loaded products and orders to identify priorities and recommendations. This report cannot change prices, orders, inventory, or fulfillment.
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={
                            analyzeStore
                        }
                        disabled={
                            aiAnalysisLoading ||
                            (products.length ===
                                0 &&
                                orders.length ===
                                0)
                        }
                        aria-busy={
                            aiAnalysisLoading
                        }
                        style={{
                            padding:
                                "12px 18px",
                            border: "none",
                            borderRadius: "11px",
                            background:
                                aiAnalysisLoading ||
                                    (products.length ===
                                        0 &&
                                        orders.length ===
                                        0)
                                    ? "#94a3b8"
                                    : "#2563eb",
                            color: "#ffffff",
                            fontWeight: "800",
                            cursor:
                                aiAnalysisLoading ||
                                    (products.length ===
                                        0 &&
                                        orders.length ===
                                        0)
                                    ? "not-allowed"
                                    : "pointer",
                            boxShadow:
                                "0 7px 18px rgba(37, 99, 235, 0.22)",
                        }}
                    >
                        {aiAnalysisLoading
                            ? "Analyzing store..."
                            : aiAnalysis
                                ? "Refresh AI Report"
                                : "Generate AI Report"}
                    </button>
                </div>

                {aiAnalysisError && (
                    <div
                        role="alert"
                        style={{
                            marginTop: "18px",
                            padding: "13px 15px",
                            border:
                                "1px solid #fecaca",
                            borderRadius:
                                "11px",
                            background:
                                "#fef2f2",
                            color: "#991b1b",
                        }}
                    >
                        ⚠️ {aiAnalysisError}
                    </div>
                )}

                {aiAnalysis ? (
                    <div
                        style={{
                            marginTop: "20px",
                            padding: "20px",
                            border:
                                "1px solid #dbeafe",
                            borderRadius:
                                "14px",
                            background: "#ffffff",
                        }}
                    >
                        <AiAnalysisContent
                            analysis={
                                aiAnalysis
                            }
                        />

                        {aiAnalysisGeneratedAt && (
                            <div
                                style={{
                                    marginTop:
                                        "18px",
                                    paddingTop:
                                        "12px",
                                    borderTop:
                                        "1px solid #e2e8f0",
                                    color:
                                        "#64748b",
                                    fontSize:
                                        "12px",
                                    direction:
                                        "ltr",
                                    textAlign:
                                        "left",
                                }}
                            >
                                Generated {aiAnalysisGeneratedAt.toLocaleString()}
                            </div>
                        )}
                    </div>
                ) : (
                    !aiAnalysisError && (
                        <div
                            style={{
                                marginTop:
                                    "18px",
                                color: "#64748b",
                                fontSize:
                                    "14px",
                            }}
                        >
                            No AI report has been generated in this session yet.
                        </div>
                    )
                )}
            </section>

            {/* FULFILLMENT OVERVIEW */}

            <h2
                style={{
                    marginTop: "45px",
                }}
            >
                Fulfillment Overview
            </h2>

            <div
                style={{
                    display: "grid",
                    gridTemplateColumns:
                        "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: "20px",
                    marginTop: "20px",
                }}
            >
                <Card
                    title="Waiting Approval"
                    value={
                        waitingApprovalFulfillmentTasks.length.toString()
                    }
                />

                <Card
                    title="Ready to Fulfill"
                    value={
                        readyFulfillmentTasks.length.toString()
                    }
                />

                <Card
                    title="Review Required"
                    value={
                        reviewFulfillmentTasks.length.toString()
                    }
                />

                <Card
                    title="Processing"
                    value={
                        processingFulfillmentTasks.length.toString()
                    }
                />

                <Card
                    title="Completed"
                    value={
                        completedFulfillmentTasks.length.toString()
                    }
                />
            </div>

            <h3
                style={{
                    marginTop: "30px",
                }}
            >
                ⏳ Waiting for Fulfillment Approval
            </h3>

            {waitingApprovalFulfillmentTasks.length ===
                0 ? (
                <p>
                    No fulfillment tasks are
                    waiting for approval.
                </p>
            ) : (
                waitingApprovalFulfillmentTasks
                    .slice(0, 5)
                    .map((task) => (
                        <div
                            key={task.id}
                            style={{
                                border:
                                    "1px solid #dbe3ee",
                                borderRadius:
                                    "12px",
                                padding: "18px",
                                marginBottom:
                                    "12px",
                            }}
                        >
                            <div
                                style={{
                                    display:
                                        "flex",
                                    justifyContent:
                                        "space-between",
                                    gap: "20px",
                                    flexWrap:
                                        "wrap",
                                }}
                            >
                                <div>
                                    <strong>
                                        {task.orderName}
                                    </strong>

                                    <div>
                                        Payment:{" "}
                                        {
                                            task.financialStatus
                                        }
                                    </div>

                                    <div>
                                        Remaining
                                        quantity:{" "}
                                        {
                                            task.remainingQuantity
                                        }
                                    </div>

                                    <div>
                                        Request:{" "}
                                        {
                                            task.requestStatus ||
                                            "—"
                                        }
                                    </div>

                                    <div>
                                        Location:{" "}
                                        {
                                            task.locationName ||
                                            "—"
                                        }
                                    </div>
                                </div>

                                <strong>
                                    WAITING_APPROVAL
                                </strong>
                            </div>

                            {task.lineItems.length >
                                0 && (
                                    <div
                                        style={{
                                            marginTop:
                                                "12px",
                                        }}
                                    >
                                        {task.lineItems.map(
                                            (
                                                item
                                            ) => (
                                                <div
                                                    key={
                                                        item.fulfillmentOrderLineItemId
                                                    }
                                                >
                                                    {
                                                        item.productTitle
                                                    }{" "}
                                                    — Qty{" "}
                                                    {
                                                        item.remainingQuantity
                                                    }
                                                </div>
                                            )
                                        )}
                                    </div>
                                )}
                        </div>
                    ))
            )}

            {waitingApprovalFulfillmentTasks.length >
                5 && (
                    <p>
                        And{" "}
                        {
                            waitingApprovalFulfillmentTasks.length -
                            5
                        }{" "}
                        more task(s) waiting for
                        approval.
                    </p>
                )}

            <h3
                style={{
                    marginTop: "30px",
                }}
            >
                📦 Orders Ready for Fulfillment
            </h3>

            {readyFulfillmentTasks.length === 0 ? (
                <p>
                    ✅ No orders are currently ready
                    for fulfillment.
                </p>
            ) : (
                readyFulfillmentTasks
                    .slice(0, 5)
                    .map((task) => (
                        <div
                            key={task.id}
                            style={{
                                border:
                                    "2px solid #dbe3ee",
                                borderRadius:
                                    "12px",
                                padding: "18px",
                                marginBottom:
                                    "12px",
                            }}
                        >
                            <div
                                style={{
                                    display:
                                        "flex",
                                    justifyContent:
                                        "space-between",
                                    gap: "20px",
                                    flexWrap:
                                        "wrap",
                                }}
                            >
                                <div>
                                    <strong>
                                        {task.orderName}
                                    </strong>

                                    <div>
                                        Payment:{" "}
                                        {
                                            task.financialStatus
                                        }
                                    </div>

                                    <div>
                                        Remaining
                                        quantity:{" "}
                                        {
                                            task.remainingQuantity
                                        }
                                    </div>
                                </div>

                                <strong>
                                    {
                                        task.status
                                    }
                                </strong>
                            </div>

                            {task.lineItems.length >
                                0 && (
                                    <div
                                        style={{
                                            marginTop:
                                                "12px",
                                        }}
                                    >
                                        {task.lineItems.map(
                                            (
                                                item
                                            ) => (
                                                <div
                                                    key={
                                                        item.fulfillmentOrderLineItemId
                                                    }
                                                >
                                                    {
                                                        item.productTitle
                                                    }{" "}
                                                    — Qty{" "}
                                                    {
                                                        item.remainingQuantity
                                                    }
                                                </div>
                                            )
                                        )}
                                    </div>
                                )}
                        </div>
                    ))
            )}

            {reviewFulfillmentTasks.length >
                0 && (
                    <p>
                        ⚠️{" "}
                        {
                            reviewFulfillmentTasks.length
                        }{" "}
                        fulfillment task(s) require
                        manual review before shipping.
                    </p>
                )}

            {/* SECURITY ACTIVITY */}

            <h2
                style={{
                    marginTop: "45px",
                }}
            >
                Security Activity
            </h2>

            <div
                style={{
                    marginTop: "18px",
                    padding: "18px",
                    border: "1px solid #dbe3ee",
                    borderRadius: "16px",
                    background: "#ffffff",
                    boxShadow:
                        "0 8px 24px rgba(15, 23, 42, 0.06)",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        justifyContent:
                            "space-between",
                        alignItems: "center",
                        gap: "16px",
                        flexWrap: "wrap",
                        marginBottom: "14px",
                    }}
                >
                    <div>
                        <strong>
                            Admin Security Log
                        </strong>

                        <div
                            style={{
                                marginTop: "5px",
                                color: "#64748b",
                                fontSize: "14px",
                            }}
                        >
                            Recent sign-in and account security events.
                        </div>
                    </div>

                    <span
                        style={{
                            padding: "7px 10px",
                            borderRadius: "999px",
                            background: "#eff6ff",
                            color: "#1d4ed8",
                            fontSize: "12px",
                            fontWeight: "800",
                        }}
                    >
                        {securityEvents.length} event
                        {securityEvents.length === 1
                            ? ""
                            : "s"}
                    </span>
                </div>

                {securityEvents.length === 0 ? (
                    <p
                        style={{
                            margin: 0,
                            color: "#64748b",
                        }}
                    >
                        No security events recorded yet.
                    </p>
                ) : (
                    securityEvents
                        .slice(0, 20)
                        .map((event) => {
                            const outcome =
                                String(
                                    event.outcome ||
                                    ""
                                ).toUpperCase();

                            const isSuccess =
                                outcome ===
                                "SUCCESS";

                            const isFailure =
                                outcome ===
                                "FAILURE";

                            const accent =
                                isSuccess
                                    ? "#15803d"
                                    : isFailure
                                        ? "#b91c1c"
                                        : "#475569";

                            const soft =
                                isSuccess
                                    ? "#f0fdf4"
                                    : isFailure
                                        ? "#fef2f2"
                                        : "#f8fafc";

                            return (
                                <div
                                    key={event.id}
                                    style={{
                                        display:
                                            "grid",
                                        gridTemplateColumns:
                                            "minmax(0, 1fr) auto",
                                        gap: "18px",
                                        alignItems:
                                            "start",
                                        padding:
                                            "14px 0",
                                        borderTop:
                                            "1px solid #e2e8f0",
                                    }}
                                >
                                    <div
                                        style={{
                                            minWidth: 0,
                                        }}
                                    >
                                        <div
                                            style={{
                                                display:
                                                    "flex",
                                                gap: "9px",
                                                alignItems:
                                                    "center",
                                                flexWrap:
                                                    "wrap",
                                            }}
                                        >
                                            <strong>
                                                {securityEventIcon(
                                                    event.eventType,
                                                    event.outcome
                                                )}{" "}
                                                {securityEventLabel(
                                                    event.eventType
                                                )}
                                            </strong>

                                            <span
                                                style={{
                                                    padding:
                                                        "4px 8px",
                                                    borderRadius:
                                                        "999px",
                                                    background:
                                                        soft,
                                                    color:
                                                        accent,
                                                    fontSize:
                                                        "11px",
                                                    fontWeight:
                                                        "800",
                                                }}
                                            >
                                                {outcome ||
                                                    "INFO"}
                                            </span>
                                        </div>

                                        {event.message && (
                                            <div
                                                style={{
                                                    marginTop:
                                                        "6px",
                                                    color:
                                                        "#475569",
                                                    fontSize:
                                                        "14px",
                                                    lineHeight:
                                                        1.5,
                                                }}
                                            >
                                                {
                                                    event.message
                                                }
                                            </div>
                                        )}
                                    </div>

                                    <small
                                        style={{
                                            color:
                                                "#64748b",
                                            whiteSpace:
                                                "nowrap",
                                        }}
                                    >
                                        {formatDate(
                                            event.createdAt
                                        )}
                                    </small>
                                </div>
                            );
                        })
                )}
            </div>

            {/* AGENT ACTIVITY */}

            <h2
                style={{
                    marginTop: "45px",
                }}
            >
                Agent Activity Log
            </h2>

            {agentEvents.length === 0 ? (
                <p>
                    No agent events yet.
                </p>
            ) : (
                agentEvents
                    .slice(0, 20)
                    .map(
                        (event) => (
                            <div
                                key={
                                    event.eventKey
                                }
                                style={{
                                    border:
                                        "1px solid #dbe3ee",

                                    borderRadius:
                                        "10px",

                                    padding:
                                        "16px",

                                    marginBottom:
                                        "10px",
                                }}
                            >
                                <div
                                    style={{
                                        display:
                                            "flex",

                                        justifyContent:
                                            "space-between",

                                        gap:
                                            "20px",

                                        flexWrap:
                                            "wrap",
                                    }}
                                >
                                    <strong>
                                        {eventIcon(
                                            event.eventType
                                        )}{" "}
                                        {event.title}
                                    </strong>

                                    <small>
                                        {formatDate(
                                            event.createdAt
                                        )}
                                    </small>
                                </div>

                                {event.message && (
                                    <p>
                                        {event.message}
                                    </p>
                                )}

                                <small>
                                    Source:{" "}
                                    {event.source}

                                    {" | "}

                                    Type:{" "}
                                    {event.eventType}

                                    {event.status && (
                                        <>
                                            {" | "}
                                            Status:{" "}
                                            {event.status}
                                        </>
                                    )}
                                </small>
                            </div>
                        )
                    )
            )}

            {/* LOW INVENTORY */}

            <h2
                style={{
                    marginTop: "45px",
                }}
            >
                Low Inventory Alerts
            </h2>

            {openInventoryAlerts.length ===
                0 ? (
                <p>
                    ✅ Inventory levels look
                    good.
                </p>
            ) : (
                openInventoryAlerts.map(
                    (alert) => (
                        <div
                            key={alert.id}
                            style={{
                                padding: "20px",
                                marginBottom:
                                    "15px",
                                border:
                                    "2px solid #dbe3ee",
                                borderRadius:
                                    "12px",
                            }}
                        >
                            <h3>
                                ⚠️ Low Stock —{" "}
                                {
                                    alert.productTitle
                                }
                            </h3>

                            <p>
                                <strong>
                                    Variant:
                                </strong>{" "}
                                {
                                    alert.variantTitle
                                }
                            </p>

                            <p>
                                <strong>
                                    SKU:
                                </strong>{" "}
                                {alert.sku}
                            </p>

                            <p>
                                <strong>
                                    Available:
                                </strong>{" "}
                                {alert.available}
                            </p>

                            <p>
                                <strong>
                                    Status:
                                </strong>{" "}
                                {alert.status}
                            </p>
                        </div>
                    )
                )
            )}

            {/* RESTOCK TASKS */}

            <h2
                style={{
                    marginTop: "45px",
                }}
            >
                Restock Tasks
            </h2>

            {activeRestockTasks.length ===
                0 ? (
                <p>
                    ✅ No active restock tasks.
                </p>
            ) : (
                activeRestockTasks.map(
                    (task) => (
                        <div
                            key={task.id}
                            style={{
                                padding: "20px",
                                marginBottom:
                                    "15px",
                                border:
                                    "2px solid #dbe3ee",
                                borderRadius:
                                    "12px",
                            }}
                        >
                            <h3>
                                📋 Restock Task
                            </h3>

                            <p>
                                <strong>
                                    Product:
                                </strong>{" "}
                                {
                                    task.productTitle
                                }
                            </p>

                            <p>
                                <strong>
                                    Inventory when
                                    approved:
                                </strong>{" "}
                                {
                                    task.availableWhenApproved
                                }
                            </p>

                            <p>
                                <strong>
                                    Status:
                                </strong>{" "}
                                {task.status}
                            </p>

                            <div
                                style={{
                                    marginTop:
                                        "20px",
                                }}
                            >
                                <input
                                    type="number"
                                    min="1"
                                    step="1"
                                    placeholder="Received quantity"
                                    value={
                                        receivedQuantities[
                                        task.id
                                        ] || ""
                                    }
                                    onChange={(
                                        event
                                    ) =>
                                        setReceivedQuantities(
                                            (
                                                current
                                            ) => ({
                                                ...current,

                                                [task.id]:
                                                    event.target
                                                        .value,
                                            })
                                        )
                                    }
                                    style={{
                                        padding:
                                            "10px",

                                        width:
                                            "180px",

                                        marginRight:
                                            "10px",
                                    }}
                                />

                                <button
                                    onClick={() =>
                                        receiveInventory(
                                            task.id
                                        )
                                    }
                                    disabled={
                                        receivingTaskId ===
                                        task.id
                                    }
                                    style={{
                                        padding:
                                            "10px 18px",

                                        cursor:
                                            "pointer",
                                    }}
                                >
                                    {receivingTaskId ===
                                        task.id
                                        ? "Receiving..."
                                        : "📥 Receive Inventory"}
                                </button>
                            </div>
                        </div>
                    )
                )
            )}

            {/* APPROVAL QUEUE */}

            <h2
                style={{
                    marginTop: "45px",
                }}
            >
                Approval Queue
            </h2>

            {pendingApprovals.length ===
                0 ? (
                <p>
                    ✅ No pending approvals.
                </p>
            ) : (
                pendingApprovals.map(
                    (item) => (
                        <div
                            key={item.id}
                            style={{
                                border:
                                    "2px solid #dbe3ee",

                                borderRadius:
                                    "12px",

                                padding:
                                    "20px",

                                marginBottom:
                                    "15px",
                            }}
                        >
                            {item.source ===
                                "ORDER" ? (
                                <>
                                    <h3>
                                        📦 Fulfillment
                                        Review
                                    </h3>

                                    <p>
                                        <strong>
                                            Order:
                                        </strong>{" "}
                                        {
                                            item.orderName
                                        }
                                    </p>
                                </>
                            ) : (
                                <>
                                    <h3>
                                        📦 Restock Review
                                    </h3>

                                    <p>
                                        <strong>
                                            Product:
                                        </strong>{" "}
                                        {
                                            item.productTitle
                                        }
                                    </p>

                                    <p>
                                        <strong>
                                            Available:
                                        </strong>{" "}
                                        {
                                            item.available
                                        }
                                    </p>
                                </>
                            )}

                            <p>
                                <strong>
                                    Action:
                                </strong>{" "}
                                {item.action}
                            </p>

                            <p>
                                <strong>
                                    Reason:
                                </strong>{" "}
                                {item.reason}
                            </p>

                            <button
                                onClick={() =>
                                    decide(
                                        item.id,
                                        "APPROVED"
                                    )
                                }
                                style={{
                                    padding:
                                        "10px 18px",

                                    marginRight:
                                        "10px",

                                    cursor:
                                        "pointer",
                                }}
                            >
                                ✅ Approve
                            </button>

                            <button
                                onClick={() =>
                                    decide(
                                        item.id,
                                        "REJECTED"
                                    )
                                }
                                style={{
                                    padding:
                                        "10px 18px",

                                    cursor:
                                        "pointer",
                                }}
                            >
                                ❌ Reject
                            </button>
                        </div>
                    )
                )
            )}

            {/* COMPLETED RESTOCKS */}

            <h2
                style={{
                    marginTop: "45px",
                }}
            >
                Completed Restocks
            </h2>

            {completedRestockTasks.map(
                (task) => (
                    <div
                        key={task.id}
                        style={{
                            padding:
                                "18px",

                            marginBottom:
                                "12px",

                            border:
                                "1px solid #dbe3ee",

                            borderRadius:
                                "10px",
                        }}
                    >
                        <h3>
                            ✅ {
                                task.productTitle
                            }
                        </h3>

                        {task.receipt && (
                            <>
                                <p>
                                    Stock before:{" "}
                                    {
                                        task.receipt
                                            .stockBefore
                                    }
                                </p>

                                <p>
                                    Received:{" "}
                                    {
                                        task.receipt
                                            .quantityReceived
                                    }
                                </p>

                                <p>
                                    Stock after:{" "}
                                    {
                                        task.receipt
                                            .stockAfter
                                    }
                                </p>
                            </>
                        )}
                    </div>
                )
            )}

            {/* RECENT ORDERS */}

            <h2
                style={{
                    marginTop: "45px",
                }}
            >
                Recent Orders
            </h2>

            {orders.map(
                (order) => (
                    <div
                        key={order.id}
                        style={{
                            border:
                                "1px solid #dbe3ee",

                            borderRadius:
                                "10px",

                            padding:
                                "20px",

                            marginBottom:
                                "15px",
                        }}
                    >
                        <h3>
                            {order.name}
                        </h3>

                        <p>
                            Amount:{" "}
                            {
                                order
                                    .totalPriceSet
                                    .shopMoney
                                    .amount
                            }{" "}
                            {
                                order
                                    .totalPriceSet
                                    .shopMoney
                                    .currencyCode
                            }
                        </p>

                        <p>
                            Payment:{" "}
                            {
                                order.displayFinancialStatus
                            }
                        </p>

                        <p>
                            Fulfillment:{" "}
                            {
                                order.displayFulfillmentStatus
                            }
                        </p>
                    </div>
                )
            )}

            {/* PRODUCTS */}

            <h2
                style={{
                    marginTop: "45px",
                }}
            >
                Products
            </h2>

            {products.map(
                (product) => (
                    <div
                        key={product.id}
                        style={{
                            borderBottom:
                                "1px solid #dbe3ee",

                            padding:
                                "15px 0",
                        }}
                    >
                        <strong>
                            {product.title}
                        </strong>

                        {product.variants
                            ?.nodes?.map(
                                (
                                    variant,
                                    index
                                ) => (
                                    <div
                                        key={
                                            variant.id ||
                                            index
                                        }
                                    >
                                        Price: $
                                        {
                                            variant.price
                                        }

                                        {" — "}

                                        Inventory:{" "}
                                        {
                                            variant.inventoryQuantity
                                        }
                                    </div>
                                )
                            )}
                    </div>
                )
            )}

            {/* APPROVAL HISTORY */}

            <h2
                style={{
                    marginTop: "45px",
                }}
            >
                Approval History
            </h2>

            {approvalHistory.map(
                (item) => (
                    <div
                        key={item.id}
                        style={{
                            padding:
                                "12px 0",

                            borderBottom:
                                "1px solid #dbe3ee",
                        }}
                    >
                        {item.source ===
                            "ORDER"
                            ? item.orderName
                            : item.productTitle}

                        {" — "}

                        {item.action}

                        {" — "}

                        <strong>
                            {item.status}
                        </strong>
                    </div>
                )
            )}

            <div
                style={{
                    marginTop:
                        "50px",

                    paddingTop:
                        "15px",

                    borderTop:
                        "1px solid #dbe3ee",
                    color:
                        "#64748b",
                }}
            >
                <small>
                    Dashboard refreshes
                    automatically every 30
                    seconds.
                    {lastRefreshedAt
                        ? ` Last refresh: ${lastRefreshedAt.toLocaleTimeString()}.`
                        : ""}
                    {" "}
                    The Fulfillment Manager
                    keeps its faster smart-sync
                    schedule for operational
                    status changes.
                </small>
            </div>

            <style jsx global>{`
                body {
                    margin: 0;
                    background:
                        linear-gradient(180deg, #eef4ff 0px, #f7f9fc 360px, #f7f9fc 100%);
                }

                .dashboardPage h2 {
                    color: #0f172a;
                    font-size: 21px;
                    line-height: 1.25;
                    padding-left: 12px;
                    border-left: 4px solid #2563eb;
                    letter-spacing: -0.01em;
                }

                .dashboardPage button,
                .dashboardPage a {
                    transition:
                        transform 120ms ease,
                        box-shadow 120ms ease,
                        opacity 120ms ease;
                }

                .dashboardPage button:hover:not(:disabled),
                .dashboardPage a:hover {
                    transform: translateY(-1px);
                }

                .dashboardPage input,
                .dashboardPage select {
                    border-color: #cbd5e1 !important;
                    border-radius: 10px !important;
                    background: #ffffff !important;
                }

                @media (max-width: 700px) {
                    .dashboardPage {
                        padding: 18px !important;
                    }
                }
            `}</style>
        </main>
    );
}

function securityEventLabel(
    eventType: string
) {
    const labels: Record<string, string> = {
        ADMIN_LOGIN_SUCCEEDED:
            "Admin sign-in succeeded",
        ADMIN_LOGIN_FAILED:
            "Admin sign-in failed",
        ADMIN_LOGIN_RATE_LIMITED:
            "Sign-in temporarily blocked",
        ADMIN_LOGIN_ORIGIN_REJECTED:
            "Sign-in origin rejected",
        ADMIN_LOGIN_INVALID_REQUEST:
            "Invalid sign-in request",
        ADMIN_LOGIN_ERROR:
            "Sign-in system error",
        ADMIN_PASSWORD_CHANGED:
            "Admin password changed",
        ADMIN_PASSWORD_CHANGE_UNAUTHORIZED:
            "Unauthorized password change attempt",
        ADMIN_PASSWORD_CHANGE_ORIGIN_REJECTED:
            "Password change origin rejected",
        ADMIN_PASSWORD_CHANGE_INVALID_REQUEST:
            "Invalid password change request",
        ADMIN_PASSWORD_CHANGE_CURRENT_PASSWORD_FAILED:
            "Current password verification failed",
        ADMIN_PASSWORD_CHANGE_CONFIRMATION_MISMATCH:
            "Password confirmation mismatch",
        ADMIN_PASSWORD_CHANGE_REUSED_PASSWORD:
            "Password reuse rejected",
        ADMIN_PASSWORD_CHANGE_POLICY_REJECTED:
            "Password policy rejected change",
        ADMIN_PASSWORD_CHANGE_ERROR:
            "Password change system error",
    };

    return (
        labels[eventType] ||
        eventType
            .replace(/^ADMIN_/, "")
            .replaceAll("_", " ")
            .toLowerCase()
            .replace(/\b\w/g, (letter) =>
                letter.toUpperCase()
            )
    );
}

function securityEventIcon(
    eventType: string,
    outcome: string
) {
    if (
        eventType ===
        "ADMIN_PASSWORD_CHANGED"
    ) {
        return "🔐";
    }

    if (
        String(outcome).toUpperCase() ===
        "SUCCESS"
    ) {
        return "✅";
    }

    if (
        String(outcome).toUpperCase() ===
        "FAILURE"
    ) {
        return "⚠️";
    }

    return "•";
}

function eventIcon(
    eventType: string
) {
    switch (eventType) {
        case "NEW_ORDER":
            return "🛒";

        case "NEEDS_FULFILLMENT":
            return "📦";

        case "LOW_INVENTORY_DETECTED":
            return "⚠️";

        case "LOW_INVENTORY_RESOLVED":
            return "✅";

        case "ORDER_APPROVAL_CREATED":
        case "RESTOCK_REVIEW_CREATED":
            return "📝";

        case "ORDER_APPROVAL_APPROVED":
        case "RESTOCK_REVIEW_APPROVED":
        case "RESTOCK_TASK_COMPLETED":
            return "✅";

        case "ORDER_APPROVAL_REJECTED":
        case "RESTOCK_REVIEW_REJECTED":
            return "❌";

        case "RESTOCK_TASK_CREATED":
            return "📋";

        case "INVENTORY_RECEIVED":
            return "📥";

        case "FULFILLMENT_TASK_CREATED":
            return "📦";

        case "ORDER_FULFILLED":
            return "✅";

        case "FULFILLMENT_REQUEST_SUBMITTED":
            return "📤";

        case "FULFILLMENT_REQUEST_ACCEPTED":
            return "✅";

        case "FULFILLMENT_REQUEST_REJECTED":
            return "❌";

        default:
            return "•";
    }
}

function formatDate(
    value: string
) {
    try {
        return new Date(
            value
        ).toLocaleString();
    } catch {
        return value;
    }
}

function formatMoney(
    value: number
) {
    return value.toLocaleString(
        "en-US",
        {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }
    );
}

function AiAnalysisContent({
    analysis,
}: {
    analysis: string;
}) {
    return (
        <div
            dir="rtl"
            lang="ar"
            style={{
                color: "#1e293b",
                lineHeight: 1.8,
                textAlign: "right",
            }}
        >
            {analysis
                .split("\n")
                .map((line, index) => {
                    const text =
                        line.trim();

                    if (!text) {
                        return (
                            <div
                                key={index}
                                style={{
                                    height: "8px",
                                }}
                            />
                        );
                    }

                    if (
                        text.startsWith(
                            "### "
                        )
                    ) {
                        return (
                            <h4
                                key={index}
                                style={{
                                    margin:
                                        "16px 0 5px",
                                    color:
                                        "#1e40af",
                                    fontSize:
                                        "16px",
                                }}
                            >
                                {text.slice(
                                    4
                                )}
                            </h4>
                        );
                    }

                    if (
                        text.startsWith(
                            "## "
                        )
                    ) {
                        return (
                            <h3
                                key={index}
                                style={{
                                    margin:
                                        "18px 0 6px",
                                    color:
                                        "#1e3a8a",
                                    fontSize:
                                        "19px",
                                }}
                            >
                                {text.slice(
                                    3
                                )}
                            </h3>
                        );
                    }

                    if (
                        text.startsWith(
                            "# "
                        )
                    ) {
                        return (
                            <h3
                                key={index}
                                style={{
                                    margin:
                                        "18px 0 6px",
                                    color:
                                        "#1e3a8a",
                                    fontSize:
                                        "21px",
                                }}
                            >
                                {text.slice(
                                    2
                                )}
                            </h3>
                        );
                    }

                    const bulletMatch =
                        text.match(
                            /^[-*]\s+(.+)$/
                        );

                    if (bulletMatch) {
                        return (
                            <div
                                key={index}
                                style={{
                                    display:
                                        "flex",
                                    gap: "9px",
                                    margin:
                                        "4px 0",
                                }}
                            >
                                <span
                                    aria-hidden="true"
                                    style={{
                                        color:
                                            "#2563eb",
                                        fontWeight:
                                            "900",
                                    }}
                                >
                                    •
                                </span>
                                <span>
                                    {
                                        bulletMatch[1]
                                    }
                                </span>
                            </div>
                        );
                    }

                    return (
                        <p
                            key={index}
                            style={{
                                margin:
                                    "5px 0",
                            }}
                        >
                            {text}
                        </p>
                    );
                })}
        </div>
    );
}

function cardAccent(
    title: string,
    value: string
) {
    const key = `${title} ${value}`.toUpperCase();

    if (
        key.includes("REJECT") ||
        key.includes("REVIEW REQUIRED")
    ) {
        return {
            accent: "#dc2626",
            soft: "#fef2f2",
        };
    }

    if (
        key.includes("WAITING") ||
        key.includes("NEEDS ATTENTION") ||
        key.includes("PENDING")
    ) {
        return {
            accent: "#d97706",
            soft: "#fffbeb",
        };
    }

    if (
        key.includes("AUTO") ||
        key.includes("AUTOMATIC") ||
        key.includes("FULFILLMENT MODE")
    ) {
        return {
            accent: "#2563eb",
            soft: "#eff6ff",
        };
    }

    if (
        key.includes("COMPLETED") ||
        key.includes("PAID") ||
        key.includes("ON")
    ) {
        return {
            accent: "#15803d",
            soft: "#f0fdf4",
        };
    }

    if (
        key.includes("SALES") ||
        key.includes("ORDER") ||
        key.includes("AVERAGE")
    ) {
        return {
            accent: "#4f46e5",
            soft: "#eef2ff",
        };
    }

    return {
        accent: "#64748b",
        soft: "#f8fafc",
    };
}

function Card({
    title,
    value,
}: {
    title: string;
    value: string;
}) {
    const theme =
        cardAccent(
            title,
            value
        );

    return (
        <div
            style={{
                padding: "20px",
                border:
                    "1px solid #dbe3ee",
                borderTop:
                    `4px solid ${theme.accent}`,
                borderRadius:
                    "16px",
                background:
                    "#ffffff",
                boxShadow:
                    "0 7px 22px rgba(15, 23, 42, 0.055)",
                minHeight:
                    "106px",
            }}
        >
            <div
                style={{
                    color:
                        "#64748b",
                    fontSize:
                        "13px",
                    fontWeight:
                        "700",
                    letterSpacing:
                        "0.02em",
                }}
            >
                {title}
            </div>

            <div
                style={{
                    fontSize:
                        "28px",
                    fontWeight:
                        "800",
                    marginTop:
                        "9px",
                    color:
                        theme.accent,
                }}
            >
                {value}
            </div>
        </div>
    );
}
