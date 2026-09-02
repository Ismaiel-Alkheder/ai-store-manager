import type {
    ReactNode,
} from "react";

type InventoryAlert = {
    id: number;
    available: number;
    productTitle: string;
    variantTitle: string;
    sku: string;
};

type InventoryAlertGroup = {
    productTitle: string;
    alerts: InventoryAlert[];
    soldOutCount: number;
    lowStockCount: number;
};

function groupAlerts(
    alerts: InventoryAlert[]
): InventoryAlertGroup[] {
    const groups = new Map<
        string,
        InventoryAlert[]
    >();

    for (const alert of alerts) {
        const current =
            groups.get(alert.productTitle) || [];

        current.push(alert);
        groups.set(alert.productTitle, current);
    }

    return Array.from(groups.entries())
        .map(([productTitle, productAlerts]) => ({
            productTitle,
            alerts: productAlerts.sort(
                (a, b) =>
                    a.available - b.available ||
                    a.variantTitle.localeCompare(
                        b.variantTitle
                    )
            ),
            soldOutCount: productAlerts.filter(
                (alert) => alert.available <= 0
            ).length,
            lowStockCount: productAlerts.filter(
                (alert) => alert.available > 0
            ).length,
        }))
        .sort(
            (a, b) =>
                b.soldOutCount - a.soldOutCount ||
                b.alerts.length - a.alerts.length ||
                a.productTitle.localeCompare(
                    b.productTitle
                )
        );
}

export default function InventoryAlertsPanel({
    alerts,
}: {
    alerts: InventoryAlert[];
}) {
    const groups = groupAlerts(alerts);

    const soldOutCount = alerts.filter(
        (alert) => alert.available <= 0
    ).length;

    const lowStockCount =
        alerts.length - soldOutCount;

    return (
        <section
            style={{
                marginTop: "45px",
            }}
        >
            <h2>Low Inventory Alerts</h2>

            {alerts.length === 0 ? (
                <p>
                    ✅ No low-stock alerts are
                    currently open.
                </p>
            ) : (
                <>
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns:
                                "repeat(auto-fit, minmax(150px, 1fr))",
                            gap: "12px",
                            marginBottom: "18px",
                        }}
                    >
                        <SummaryCard
                            label="Affected products"
                            value={groups.length}
                            color="#1d4ed8"
                        />

                        <SummaryCard
                            label="Sold-out variants"
                            value={soldOutCount}
                            color="#b91c1c"
                        />

                        <SummaryCard
                            label="Low-stock variants"
                            value={lowStockCount}
                            color="#a16207"
                        />
                    </div>

                    <p
                        style={{
                            color: "#475569",
                            marginBottom: "16px",
                        }}
                    >
                        Alerts are grouped by product.
                        Open a product to review its
                        affected variants.
                    </p>

                    {groups.map((group) => (
                        <details
                            key={group.productTitle}
                            style={{
                                border:
                                    "1px solid #dbe3ee",
                                borderRadius: "12px",
                                marginBottom: "12px",
                                overflow: "hidden",
                                background: "#ffffff",
                            }}
                        >
                            <summary
                                style={{
                                    cursor: "pointer",
                                    padding: "16px 18px",
                                    fontWeight: 700,
                                    background: "#f8fafc",
                                }}
                            >
                                {group.productTitle}

                                <span
                                    style={{
                                        marginLeft: "10px",
                                        color: "#64748b",
                                        fontWeight: 500,
                                    }}
                                >
                                    ({group.alerts.length}{" "}
                                    affected)
                                </span>

                                {group.soldOutCount > 0 && (
                                    <span
                                        style={{
                                            marginLeft: "10px",
                                            color: "#b91c1c",
                                            fontWeight: 600,
                                        }}
                                    >
                                        {group.soldOutCount}{" "}
                                        sold out
                                    </span>
                                )}

                                {group.lowStockCount > 0 && (
                                    <span
                                        style={{
                                            marginLeft: "10px",
                                            color: "#a16207",
                                            fontWeight: 600,
                                        }}
                                    >
                                        {group.lowStockCount}{" "}
                                        low
                                    </span>
                                )}
                            </summary>

                            <div
                                style={{
                                    overflowX: "auto",
                                }}
                            >
                                <table
                                    style={{
                                        width: "100%",
                                        borderCollapse:
                                            "collapse",
                                        minWidth: "560px",
                                    }}
                                >
                                    <thead>
                                        <tr>
                                            <TableHeader>
                                                Variant
                                            </TableHeader>
                                            <TableHeader>
                                                SKU
                                            </TableHeader>
                                            <TableHeader>
                                                Available
                                            </TableHeader>
                                        </tr>
                                    </thead>

                                    <tbody>
                                        {group.alerts.map(
                                            (alert) => (
                                                <tr
                                                    key={alert.id}
                                                >
                                                    <TableCell>
                                                        {
                                                            alert.variantTitle
                                                        }
                                                    </TableCell>
                                                    <TableCell>
                                                        {alert.sku}
                                                    </TableCell>
                                                    <TableCell>
                                                        <strong
                                                            style={{
                                                                color:
                                                                    alert.available <=
                                                                    0
                                                                        ? "#b91c1c"
                                                                        : "#a16207",
                                                            }}
                                                        >
                                                            {
                                                                alert.available
                                                            }
                                                        </strong>
                                                    </TableCell>
                                                </tr>
                                            )
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </details>
                    ))}
                </>
            )}
        </section>
    );
}

function SummaryCard({
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

function TableHeader({
    children,
}: {
    children: ReactNode;
}) {
    return (
        <th
            style={{
                padding: "11px 14px",
                borderBottom:
                    "1px solid #dbe3ee",
                textAlign: "left",
                color: "#475569",
                fontSize: "13px",
                background: "#f8fafc",
            }}
        >
            {children}
        </th>
    );
}

function TableCell({
    children,
}: {
    children: ReactNode;
}) {
    return (
        <td
            style={{
                padding: "11px 14px",
                borderBottom:
                    "1px solid #eef2f7",
                verticalAlign: "top",
            }}
        >
            {children}
        </td>
    );
}
