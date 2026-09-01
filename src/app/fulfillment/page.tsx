"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";

import AdminAccountControls from "@/components/AdminAccountControls";

type FulfillmentLineItem = {
    fulfillmentOrderLineItemId?: string | null;
    productTitle?: string | null;
    variantTitle?: string | null;
    sku?: string | null;
    remainingQuantity?: number | null;
};

type FulfillmentTask = {
    id: string;
    orderId?: string | null;
    orderGid?: string | null;
    orderName?: string | null;
    fulfillmentOrderId?: string | null;
    locationName?: string | null;
    financialStatus?: string | null;
    orderFulfillmentStatus?: string | null;
    fulfillmentOrderStatus?: string | null;
    requestStatus?: string | null;
    remainingQuantity?: number | null;
    status?: string | null;
    warning?: string | null;
    updatedAt?: string | null;
    lineItems?: FulfillmentLineItem[] | null;
};

type Approval = {
    id?: string | null;
    orderId?: string | null;
    order_id?: string | number | null;
    orderName?: string | null;
    order_name?: string | null;
    status?: string | null;
    decision?: string | null;
    type?: string | null;
    source?: string | null;
};


type FulfillmentSettings = {
    fulfillmentMode: "MANUAL" | "AUTOMATIC";
    autoShipEnabled: boolean;
    automaticBehavior: {
        acceptFulfillmentRequests: boolean;
        shipAutomatically: boolean;
    };
};

function normalizeTasks(payload: any): FulfillmentTask[] {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.tasks)) return payload.tasks;
    if (Array.isArray(payload?.fulfillmentTasks)) return payload.fulfillmentTasks;
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
}

function normalizeApprovals(payload: any): Approval[] {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.approvals)) return payload.approvals;
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
}

function digits(value?: string | number | null) {
    return String(value ?? "").replace(/\D/g, "");
}

function approvalStatus(value?: string | null) {
    return String(value || "").toUpperCase();
}

function findApproval(task: FulfillmentTask, approvals: Approval[]) {
    const taskOrderId = digits(task.orderId);
    const taskOrderName = String(task.orderName || "").trim();

    return approvals.find((approval) => {
        const aOrderId = digits(approval.orderId ?? approval.order_id ?? "");
        const aOrderName = String(
            approval.orderName ?? approval.order_name ?? ""
        ).trim();

        const sameId =
            taskOrderId.length > 0 &&
            aOrderId.length > 0 &&
            taskOrderId === aOrderId;

        const sameName =
            taskOrderName.length > 0 &&
            aOrderName.length > 0 &&
            taskOrderName === aOrderName;

        return sameId || sameName;
    });
}

function humanTime(value?: string | null) {
    if (!value) return "—";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}


const primaryButtonStyle: React.CSSProperties = {
    appearance: "none",
    WebkitAppearance: "none",
    border: "1px solid #1d4ed8",
    borderRadius: 10,
    padding: "10px 14px",
    background: "#2563eb",
    color: "#ffffff",
    fontWeight: 750,
    fontSize: 14,
    lineHeight: 1.2,
    cursor: "pointer",
    boxShadow: "0 5px 14px rgba(37, 99, 235, 0.18)",
};

const secondaryButtonStyle: React.CSSProperties = {
    ...primaryButtonStyle,
    background: "#ffffff",
    color: "#334155",
    border: "1px solid #cbd5e1",
    boxShadow: "0 2px 8px rgba(15, 23, 42, 0.05)",
};

const dangerButtonStyle: React.CSSProperties = {
    ...primaryButtonStyle,
    background: "#dc2626",
    color: "#ffffff",
    border: "1px solid #b91c1c",
    boxShadow: "0 5px 14px rgba(220, 38, 38, 0.16)",
};

const successButtonStyle: React.CSSProperties = {
    ...primaryButtonStyle,
    background: "#15803d",
    border: "1px solid #166534",
    boxShadow: "0 5px 14px rgba(21, 128, 61, 0.16)",
};

const warningButtonStyle: React.CSSProperties = {
    ...primaryButtonStyle,
    background: "#d97706",
    border: "1px solid #b45309",
    boxShadow: "0 5px 14px rgba(217, 119, 6, 0.16)",
};

function statusTheme(value?: string | null) {
    const status = String(value || "").toUpperCase();

    if (
        status.includes("COMPLETED") ||
        status.includes("FULFILLED") ||
        status.includes("CLOSED") ||
        status.includes("ACCEPTED")
    ) {
        return {
            color: "#166534",
            background: "#f0fdf4",
            border: "#bbf7d0",
        };
    }

    if (
        status.includes("REVIEW") ||
        status.includes("REJECTED") ||
        status.includes("FAILED")
    ) {
        return {
            color: "#991b1b",
            background: "#fef2f2",
            border: "#fecaca",
        };
    }

    if (
        status.includes("WAITING") ||
        status.includes("UNSUBMITTED") ||
        status.includes("READY")
    ) {
        return {
            color: "#92400e",
            background: "#fffbeb",
            border: "#fde68a",
        };
    }

    if (
        status.includes("PROCESSING") ||
        status.includes("SUBMITTED") ||
        status.includes("IN_PROGRESS")
    ) {
        return {
            color: "#1e40af",
            background: "#eff6ff",
            border: "#bfdbfe",
        };
    }

    return {
        color: "#475569",
        background: "#f8fafc",
        border: "#e2e8f0",
    };
}

function statusPillStyle(value?: string | null): React.CSSProperties {
    const theme = statusTheme(value);

    return {
        display: "inline-flex",
        alignItems: "center",
        width: "fit-content",
        borderRadius: 999,
        padding: "5px 9px",
        border: `1px solid ${theme.border}`,
        background: theme.background,
        color: theme.color,
        fontSize: 12,
        fontWeight: 800,
        lineHeight: 1.2,
    };
}

export default function FulfillmentPage() {
    const [tasks, setTasks] = useState<FulfillmentTask[]>([]);
    const [approvals, setApprovals] = useState<Approval[]>([]);
    const [loading, setLoading] = useState(true);
    const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
    const [settings, setSettings] = useState<FulfillmentSettings>({
        fulfillmentMode: "MANUAL",
        autoShipEnabled: false,
        automaticBehavior: {
            acceptFulfillmentRequests: false,
            shipAutomatically: false,
        },
    });
    const [settingsBusy, setSettingsBusy] = useState(false);

    const loadTasks = useCallback(async () => {
        try {
            const response = await fetch("/api/fulfillment-tasks", {
                cache: "no-store",
            });

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                throw new Error(
                    payload?.error ||
                    `Could not load fulfillment tasks (${response.status}).`
                );
            }

            setTasks(normalizeTasks(payload));
            setLastSyncedAt(new Date());
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not load fulfillment tasks."
            );
        } finally {
            setLoading(false);
        }
    }, []);

    const loadAuxiliary = useCallback(async () => {
        const [approvalsResult, settingsResult] = await Promise.allSettled([
            fetch("/api/approvals", { cache: "no-store" }),
            fetch("/api/fulfillment-settings", { cache: "no-store" }),
        ]);

        if (approvalsResult.status === "fulfilled") {
            const approvalResponse = approvalsResult.value;
            const approvalPayload = await approvalResponse.json().catch(() => null);

            if (approvalResponse.ok) {
                setApprovals(normalizeApprovals(approvalPayload));
            }
        }

        if (settingsResult.status === "fulfilled") {
            const settingsResponse = settingsResult.value;
            const settingsPayload = await settingsResponse.json().catch(() => null);

            if (
                settingsResponse.ok &&
                (settingsPayload?.fulfillmentMode === "MANUAL" ||
                    settingsPayload?.fulfillmentMode === "AUTOMATIC")
            ) {
                setSettings({
                    fulfillmentMode: settingsPayload.fulfillmentMode,
                    autoShipEnabled: settingsPayload.autoShipEnabled === true,
                    automaticBehavior: {
                        acceptFulfillmentRequests:
                            settingsPayload?.automaticBehavior
                                ?.acceptFulfillmentRequests === true,
                        shipAutomatically:
                            settingsPayload?.automaticBehavior?.shipAutomatically === true,
                    },
                });
            }
        }
    }, []);

    const loadAll = useCallback(async () => {
        setError("");

        await Promise.allSettled([
            loadTasks(),
            loadAuxiliary(),
        ]);
    }, [loadTasks, loadAuxiliary]);

    useEffect(() => {
        void loadAll();

        const taskIntervalId = window.setInterval(() => {
            if (!busyTaskId && !settingsBusy) {
                void loadTasks();
            }
        }, 5000);

        const auxiliaryIntervalId = window.setInterval(() => {
            if (!busyTaskId && !settingsBusy) {
                void loadAuxiliary();
            }
        }, 30000);

        return () => {
            window.clearInterval(taskIntervalId);
            window.clearInterval(auxiliaryIntervalId);
        };
    }, [
        loadAll,
        loadTasks,
        loadAuxiliary,
        busyTaskId,
        settingsBusy,
    ]);

    const summary = useMemo(() => {
        const result = {
            total: tasks.length,
            waiting: 0,
            ready: 0,
            processing: 0,
            review: 0,
            completed: 0,
        };

        for (const task of tasks) {
            const status = String(task.status || "").toUpperCase();

            if (status === "WAITING_APPROVAL") result.waiting += 1;
            else if (status === "READY_TO_FULFILL") result.ready += 1;
            else if (status === "COMPLETED") result.completed += 1;
            else if (status === "REVIEW_REQUIRED") result.review += 1;
            else result.processing += 1;
        }

        return result;
    }, [tasks]);

    async function updateSettings(
        changes: {
            mode?: "MANUAL" | "AUTOMATIC";
            autoShipEnabled?: boolean;
        },
        confirmationText?: string
    ) {
        if (
            confirmationText &&
            !window.confirm(confirmationText)
        ) {
            return;
        }

        setSettingsBusy(true);
        setMessage("");
        setError("");

        try {
            const response = await fetch("/api/fulfillment-settings", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    ...changes,
                    confirm: true,
                }),
            });

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                throw new Error(
                    payload?.error ||
                    `Could not update fulfillment settings (${response.status}).`
                );
            }

            setSettings({
                fulfillmentMode: payload.fulfillmentMode,
                autoShipEnabled: payload.autoShipEnabled === true,
                automaticBehavior: {
                    acceptFulfillmentRequests:
                        payload?.automaticBehavior?.acceptFulfillmentRequests === true,
                    shipAutomatically:
                        payload?.automaticBehavior?.shipAutomatically === true,
                },
            });

            setMessage("Fulfillment settings updated.");
            await loadAll();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not update fulfillment settings."
            );
        } finally {
            setSettingsBusy(false);
        }
    }

    async function approveTask(task: FulfillmentTask) {
        setBusyTaskId(task.id);
        setMessage("");
        setError("");

        try {
            const approval = findApproval(task, approvals);

            const fallbackApprovalId =
                task.orderId && digits(task.orderId)
                    ? `order-${digits(task.orderId)}-fulfillment`
                    : null;

            const approvalId = approval?.id || fallbackApprovalId;

            if (!approvalId) {
                throw new Error(
                    "Could not find the approval record for this order."
                );
            }

            const response = await fetch("/api/approvals", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    id: approvalId,
                    decision: "APPROVED",
                }),
            });

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                throw new Error(
                    payload?.error ||
                    `Approval failed (${response.status}).`
                );
            }

            setMessage(`Order ${task.orderName || task.id} approved.`);
            await loadAll();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Approval failed.");
        } finally {
            setBusyTaskId(null);
        }
    }

    async function runAction(
        task: FulfillmentTask,
        action: "request" | "retry" | "accept" | "reject" | "ship"
    ) {
        if (!task.fulfillmentOrderId) {
            setError("Missing fulfillmentOrderId.");
            return;
        }

        setBusyTaskId(task.id);
        setMessage("");
        setError("");

        try {
            let url = "";
            let body: Record<string, unknown> = {};

            if (action === "request") {
                url = "/api/fulfillment-tasks/request";
                body = {
                    taskId: task.id,
                    confirm: true,
                    notifyCustomer: false,
                };
            } else if (action === "retry") {
                url = "/api/fulfillment-tasks/retry";
                body = {
                    taskId: task.id,
                    confirm: true,
                    notifyCustomer: false,
                    message: "Retry fulfillment request",
                };
            } else if (action === "accept") {
                url = "/api/fulfillment-service/accept";
                body = {
                    fulfillmentOrderId: task.fulfillmentOrderId,
                    confirm: true,
                    message: "Accepted by AI Test Warehouse",
                };
            } else if (action === "reject") {
                url = "/api/fulfillment-service/reject";
                body = {
                    fulfillmentOrderId: task.fulfillmentOrderId,
                    confirm: true,
                    message: "Rejected by AI Test Warehouse",
                };
            } else {
                url = "/api/fulfillment-service/ship";
                body = {
                    fulfillmentOrderId: task.fulfillmentOrderId,
                    confirm: true,
                    notifyCustomer: false,
                    message: "Shipped by AI Test Warehouse",
                };
            }

            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                const userErrors = Array.isArray(payload?.userErrors)
                    ? payload.userErrors
                        .map((item: any) => item?.message)
                        .filter(Boolean)
                        .join(" | ")
                    : "";

                throw new Error(
                    payload?.error ||
                    userErrors ||
                    `Action failed (${response.status}).`
                );
            }

            const label =
                action === "request"
                    ? "Fulfillment request submitted"
                    : action === "retry"
                        ? "Fulfillment request retried"
                        : action === "accept"
                            ? "Fulfillment request accepted"
                            : action === "reject"
                                ? "Fulfillment request rejected"
                                : "Shipment completed";

            setMessage(`${label} for ${task.orderName || task.id}.`);
            await loadAll();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Action failed.");
        } finally {
            setBusyTaskId(null);
        }
    }

    function isAITestWarehouse(task: FulfillmentTask) {
        return String(task.locationName || "")
            .toLowerCase()
            .includes("ai test warehouse");
    }

    function canApprove(task: FulfillmentTask) {
        if (String(task.status || "").toUpperCase() === "WAITING_APPROVAL") {
            return true;
        }

        const approval = findApproval(task, approvals);
        const state = approvalStatus(approval?.status || approval?.decision);

        return state === "PENDING";
    }

    function canRequest(task: FulfillmentTask) {
        return (
            String(task.status || "").toUpperCase() === "READY_TO_FULFILL" &&
            String(task.requestStatus || "").toUpperCase() === "UNSUBMITTED"
        );
    }

    function canAccept(task: FulfillmentTask) {
        return (
            String(task.requestStatus || "").toUpperCase() === "SUBMITTED" &&
            isAITestWarehouse(task)
        );
    }

    function canReject(task: FulfillmentTask) {
        return (
            String(task.requestStatus || "").toUpperCase() === "SUBMITTED" &&
            isAITestWarehouse(task)
        );
    }

    function canRetry(task: FulfillmentTask) {
        return (
            String(task.status || "").toUpperCase() === "REVIEW_REQUIRED" &&
            String(task.requestStatus || "").toUpperCase() === "REJECTED" &&
            Number(task.remainingQuantity || 0) > 0
        );
    }

    function canShip(task: FulfillmentTask) {
        return (
            String(task.requestStatus || "").toUpperCase() === "ACCEPTED" &&
            Number(task.remainingQuantity || 0) > 0 &&
            isAITestWarehouse(task)
        );
    }

    return (
        <main
            className="fulfillmentPage"
            style={{
                maxWidth: 1320,
                margin: "0 auto",
                padding: 24,
                color: "#0f172a",
                fontFamily:
                    "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
            }}
        >
            <div
                style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 18,
                    alignItems: "center",
                    padding: "24px 26px",
                    borderRadius: 18,
                    background:
                        "linear-gradient(135deg, #0f172a 0%, #1e3a8a 60%, #2563eb 100%)",
                    color: "#ffffff",
                    boxShadow: "0 16px 38px rgba(15, 23, 42, 0.17)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    flexWrap: "wrap",
                }}
            >
                <div>
                    <div
                        style={{
                            fontSize: 12,
                            fontWeight: 800,
                            letterSpacing: "0.08em",
                            textTransform: "uppercase",
                            opacity: 0.75,
                        }}
                    >
                        Operations Center
                    </div>
                    <h1 style={{ margin: "6px 0 6px", fontSize: 30 }}>
                        Fulfillment Manager
                    </h1>
                    <p
                        style={{
                            color: "rgba(255,255,255,0.82)",
                            margin: 0,
                        }}
                    >
                        Approve, request, retry, accept, reject, and ship from one page.
                    </p>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span
                        style={{
                            fontSize: 12,
                            color: "rgba(255,255,255,0.78)",
                        }}
                    >
                        Tasks: 5s · Approvals & settings: 30s
                        {lastSyncedAt
                            ? ` · Last sync ${lastSyncedAt.toLocaleTimeString()}`
                            : ""}
                    </span>

                    <button
                        style={{
                            ...secondaryButtonStyle,
                            background: "rgba(255,255,255,0.12)",
                            color: "#ffffff",
                            border: "1px solid rgba(255,255,255,0.28)",
                            boxShadow: "none",
                        }}
                        onClick={() => void loadAll()}
                    >
                        Refresh
                    </button>

                    <AdminAccountControls variant="dark" />
                </div>
            </div>

            <section
                style={{
                    border: "1px solid #dbe3ee",
                    borderRadius: 18,
                    padding: 18,
                    marginTop: 20,
                    background: "#ffffff",
                    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.055)",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 16,
                        alignItems: "flex-start",
                        flexWrap: "wrap",
                    }}
                >
                    <div>
                        <h2 style={{ margin: 0, fontSize: 20 }}>
                            Automation Settings
                        </h2>
                        <p style={{ margin: "6px 0 0", opacity: 0.7 }}>
                            Control automatic fulfillment behavior from this page.
                        </p>
                    </div>

                    <div
                        style={{
                            display: "flex",
                            gap: 8,
                            flexWrap: "wrap",
                        }}
                    >
                        <button
                            style={
                                settings.fulfillmentMode === "MANUAL"
                                    ? primaryButtonStyle
                                    : secondaryButtonStyle
                            }
                            disabled={settingsBusy}
                            onClick={() =>
                                void updateSettings({
                                    mode: "MANUAL",
                                })
                            }
                        >
                            Manual
                        </button>

                        <button
                            style={
                                settings.fulfillmentMode === "AUTOMATIC"
                                    ? primaryButtonStyle
                                    : secondaryButtonStyle
                            }
                            disabled={settingsBusy}
                            onClick={() =>
                                void updateSettings(
                                    { mode: "AUTOMATIC" },
                                    "Automatic mode will accept new fulfillment requests automatically. Continue?"
                                )
                            }
                        >
                            Automatic
                        </button>
                    </div>
                </div>

                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns:
                            "repeat(auto-fit, minmax(220px, 1fr))",
                        gap: 12,
                        marginTop: 16,
                    }}
                >
                    <div
                        style={{
                            border: "1px solid #bfdbfe",
                            borderRadius: 14,
                            padding: 14,
                            background: "#eff6ff",
                        }}
                    >
                        <div style={{ opacity: 0.65, fontSize: 13 }}>
                            Fulfillment Mode
                        </div>
                        <strong style={{ fontSize: 18 }}>
                            {settings.fulfillmentMode}
                        </strong>
                    </div>

                    <div
                        style={{
                            border: "1px solid #bbf7d0",
                            borderRadius: 14,
                            padding: 14,
                            background: "#f0fdf4",
                        }}
                    >
                        <div style={{ opacity: 0.65, fontSize: 13 }}>
                            Auto-Accept
                        </div>
                        <strong style={{ fontSize: 18 }}>
                            {settings.automaticBehavior.acceptFulfillmentRequests
                                ? "ON"
                                : "OFF"}
                        </strong>
                    </div>

                    <div
                        style={{
                            border: "1px solid #ddd6fe",
                            borderRadius: 14,
                            padding: 14,
                            background: "#f5f3ff",
                        }}
                    >
                        <div style={{ opacity: 0.65, fontSize: 13 }}>
                            Auto-Ship
                        </div>

                        <div
                            style={{
                                display: "flex",
                                gap: 10,
                                alignItems: "center",
                                justifyContent: "space-between",
                                marginTop: 4,
                            }}
                        >
                            <strong style={{ fontSize: 18 }}>
                                {settings.autoShipEnabled ? "ON" : "OFF"}
                            </strong>

                            <button
                                style={
                                    settings.autoShipEnabled
                                        ? dangerButtonStyle
                                        : primaryButtonStyle
                                }
                                disabled={settingsBusy}
                                onClick={() =>
                                    void updateSettings(
                                        {
                                            autoShipEnabled:
                                                !settings.autoShipEnabled,
                                        },
                                        settings.autoShipEnabled
                                            ? undefined
                                            : "Auto-Ship will create Shopify fulfillments automatically after Auto-Accept. Continue?"
                                    )
                                }
                            >
                                {settingsBusy
                                    ? "Saving…"
                                    : settings.autoShipEnabled
                                        ? "Turn Auto-Ship OFF"
                                        : "Turn Auto-Ship ON"}
                            </button>
                        </div>
                    </div>
                </div>

                {settings.fulfillmentMode === "MANUAL" &&
                    settings.autoShipEnabled ? (
                    <div
                        style={{
                            marginTop: 12,
                            padding: 10,
                            borderRadius: 10,
                            border: "1px solid #d8b45c",
                            background: "#fffdf5",
                        }}
                    >
                        Auto-Ship is enabled in storage, but it will not run while
                        Fulfillment Mode is MANUAL.
                    </div>
                ) : null}
            </section>

            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                    gap: 12,
                    margin: "20px 0",
                }}
            >
                {Object.entries(summary).map(([label, value]) => {
                    const theme =
                        label === "completed"
                            ? statusTheme("COMPLETED")
                            : label === "review"
                                ? statusTheme("REVIEW_REQUIRED")
                                : label === "waiting"
                                    ? statusTheme("WAITING_APPROVAL")
                                    : label === "ready"
                                        ? statusTheme("READY_TO_FULFILL")
                                        : label === "processing"
                                            ? statusTheme("PROCESSING")
                                            : statusTheme("DEFAULT");

                    return (
                        <div
                            key={label}
                            style={{
                                border: `1px solid ${theme.border}`,
                                borderTop: `4px solid ${theme.color}`,
                                borderRadius: 14,
                                padding: 15,
                                background: "#ffffff",
                                boxShadow: "0 6px 18px rgba(15, 23, 42, 0.05)",
                            }}
                        >
                            <div
                                style={{
                                    color: "#64748b",
                                    fontSize: 12,
                                    fontWeight: 800,
                                    textTransform: "uppercase",
                                    letterSpacing: "0.04em",
                                }}
                            >
                                {label}
                            </div>
                            <strong
                                style={{
                                    display: "block",
                                    marginTop: 5,
                                    fontSize: 25,
                                    color: theme.color,
                                }}
                            >
                                {value}
                            </strong>
                        </div>
                    );
                })}
            </div>

            {message ? (
                <div
                    style={{
                        padding: 12,
                        border: "1px solid #bbf7d0",
                        borderRadius: 12,
                        marginBottom: 14,
                        background: "#f0fdf4",
                        color: "#166534",
                        boxShadow: "0 4px 14px rgba(21, 128, 61, 0.06)",
                    }}
                >
                    {message}
                </div>
            ) : null}

            {error ? (
                <div
                    style={{
                        padding: 12,
                        border: "1px solid #fecaca",
                        borderRadius: 12,
                        marginBottom: 14,
                        background: "#fef2f2",
                        color: "#991b1b",
                        boxShadow: "0 4px 14px rgba(185, 28, 28, 0.06)",
                    }}
                >
                    {error}
                </div>
            ) : null}

            {loading ? (
                <p>Loading…</p>
            ) : (
                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
                        gap: 16,
                    }}
                >
                    {tasks.map((task) => {
                        const busy = busyTaskId === task.id;
                        const taskTheme = statusTheme(task.status);

                        return (
                            <article
                                key={task.id}
                                style={{
                                    border: `1px solid ${taskTheme.border}`,
                                    borderTop: `4px solid ${taskTheme.color}`,
                                    borderRadius: 16,
                                    padding: 18,
                                    background: "#ffffff",
                                    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.055)",
                                }}
                            >
                                <div
                                    style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        gap: 12,
                                    }}
                                >
                                    <div>
                                        <h2 style={{ margin: 0 }}>
                                            {task.orderName || "Order"}
                                        </h2>
                                        <div style={{ opacity: 0.65, marginTop: 4 }}>
                                            {task.locationName || "No location"}
                                        </div>
                                    </div>

                                    <span style={statusPillStyle(task.status)}>
                                        {task.status || "UNKNOWN"}
                                    </span>
                                </div>

                                <div
                                    style={{
                                        display: "grid",
                                        gridTemplateColumns: "1fr 1fr",
                                        gap: 10,
                                        marginTop: 16,
                                    }}
                                >
                                    <div>
                                        <small>Financial</small>
                                        <div>
                                            <span style={statusPillStyle(task.financialStatus)}>
                                                {task.financialStatus || "—"}
                                            </span>
                                        </div>
                                    </div>

                                    <div>
                                        <small>Order fulfillment</small>
                                        <div>
                                            <span style={statusPillStyle(task.orderFulfillmentStatus)}>
                                                {task.orderFulfillmentStatus || "—"}
                                            </span>
                                        </div>
                                    </div>

                                    <div>
                                        <small>Fulfillment order</small>
                                        <div>
                                            <span style={statusPillStyle(task.fulfillmentOrderStatus)}>
                                                {task.fulfillmentOrderStatus || "—"}
                                            </span>
                                        </div>
                                    </div>

                                    <div>
                                        <small>Request</small>
                                        <div>
                                            <span style={statusPillStyle(task.requestStatus)}>
                                                {task.requestStatus || "—"}
                                            </span>
                                        </div>
                                    </div>

                                    <div>
                                        <small>Remaining</small>
                                        <div>
                                            <strong>{task.remainingQuantity ?? 0}</strong>
                                        </div>
                                    </div>

                                    <div>
                                        <small>Updated</small>
                                        <div>
                                            <strong>{humanTime(task.updatedAt)}</strong>
                                        </div>
                                    </div>
                                </div>

                                {Array.isArray(task.lineItems) &&
                                    task.lineItems.length > 0 ? (
                                    <div
                                        style={{
                                            marginTop: 16,
                                            borderTop: "1px solid #ddd",
                                            paddingTop: 12,
                                        }}
                                    >
                                        {task.lineItems.map((item, index) => (
                                            <div
                                                key={
                                                    item.fulfillmentOrderLineItemId ||
                                                    `${task.id}-${index}`
                                                }
                                                style={{
                                                    display: "flex",
                                                    justifyContent: "space-between",
                                                    gap: 12,
                                                    marginBottom: 10,
                                                }}
                                            >
                                                <div>
                                                    <strong>{item.productTitle || "Product"}</strong>

                                                    {item.variantTitle &&
                                                        item.variantTitle !== "Default Title" ? (
                                                        <div style={{ opacity: 0.65 }}>
                                                            {item.variantTitle}
                                                        </div>
                                                    ) : null}

                                                    {item.sku ? (
                                                        <div style={{ opacity: 0.65 }}>
                                                            SKU: {item.sku}
                                                        </div>
                                                    ) : null}
                                                </div>

                                                <div>Qty {item.remainingQuantity ?? 0}</div>
                                            </div>
                                        ))}
                                    </div>
                                ) : null}

                                {task.warning ? (
                                    <div
                                        style={{
                                            marginTop: 12,
                                            padding: 10,
                                            border: "1px solid #fde68a",
                                            borderRadius: 12,
                                            background: "#fffbeb",
                                            color: "#92400e",
                                        }}
                                    >
                                        {task.warning}
                                    </div>
                                ) : null}

                                <div
                                    style={{
                                        display: "flex",
                                        flexWrap: "wrap",
                                        gap: 8,
                                        marginTop: 16,
                                    }}
                                >
                                    {canApprove(task) ? (
                                        <button
                                            style={primaryButtonStyle}
                                            disabled={busy}
                                            onClick={() => void approveTask(task)}
                                        >
                                            {busy ? "Working…" : "Approve Order"}
                                        </button>
                                    ) : null}

                                    {canRequest(task) ? (
                                        <button
                                            style={primaryButtonStyle}
                                            disabled={busy}
                                            onClick={() => void runAction(task, "request")}
                                        >
                                            {busy ? "Working…" : "Request Fulfillment"}
                                        </button>
                                    ) : null}

                                    {canAccept(task) ? (
                                        <button
                                            style={successButtonStyle}
                                            disabled={busy}
                                            onClick={() => void runAction(task, "accept")}
                                        >
                                            {busy ? "Working…" : "Accept"}
                                        </button>
                                    ) : null}

                                    {canReject(task) ? (
                                        <button
                                            style={dangerButtonStyle}
                                            disabled={busy}
                                            onClick={() => void runAction(task, "reject")}
                                        >
                                            {busy ? "Working…" : "Reject"}
                                        </button>
                                    ) : null}

                                    {canRetry(task) ? (
                                        <button
                                            style={warningButtonStyle}
                                            disabled={busy}
                                            onClick={() => void runAction(task, "retry")}
                                        >
                                            {busy ? "Working…" : "Retry Fulfillment"}
                                        </button>
                                    ) : null}

                                    {canShip(task) ? (
                                        <button
                                            style={successButtonStyle}
                                            disabled={busy}
                                            onClick={() => void runAction(task, "ship")}
                                        >
                                            {busy ? "Working…" : "Ship"}
                                        </button>
                                    ) : null}

                                    {!canApprove(task) &&
                                        !canRequest(task) &&
                                        !canAccept(task) &&
                                        !canReject(task) &&
                                        !canRetry(task) &&
                                        !canShip(task) ? (
                                        <span style={{ opacity: 0.65 }}>
                                            No action required.
                                        </span>
                                    ) : null}
                                </div>
                            </article>
                        );
                    })}
                </div>
            )}

            <style jsx global>{`
        body {
          margin: 0;
          background:
            linear-gradient(180deg, #eef4ff 0px, #f7f9fc 340px, #f7f9fc 100%);
        }

        .fulfillmentPage h2 {
          color: #0f172a;
        }

        .fulfillmentPage article small {
          color: #64748b;
          font-weight: 700;
        }

        .fulfillmentPage button {
          transition:
            transform 120ms ease,
            box-shadow 120ms ease,
            opacity 120ms ease;
        }

        .fulfillmentPage button:hover:not(:disabled) {
          transform: translateY(-1px);
        }

        .fulfillmentPage button:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }

        @media (max-width: 700px) {
          .fulfillmentPage {
            padding: 16px !important;
          }
        }
      `}</style>
        </main>
    );
}
