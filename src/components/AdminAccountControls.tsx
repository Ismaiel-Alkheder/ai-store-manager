"use client";
import { useState } from "react";
export default function AdminAccountControls({
    variant = "light",
}: {
    variant?: "light" | "dark";
}) {
    const [busy, setBusy] =
        useState(false);

    async function logout() {
        setBusy(true);

        try {
            await fetch(
                "/api/admin/logout",
                {
                    method: "POST",
                }
            );
        } finally {
            window.location.assign(
                "/login"
            );
        }
    }

    const dark =
        variant === "dark";

    const baseStyle:
        React.CSSProperties = {
        appearance: "none",
        borderRadius: 10,
        padding: "9px 12px",
        fontSize: 13,
        fontWeight: 800,
        cursor: "pointer",
        textDecoration: "none",
        transition:
            "transform 120ms ease, opacity 120ms ease",
    };

    const secondary:
        React.CSSProperties =
        dark
            ? {
                ...baseStyle,
                border:
                    "1px solid rgba(255,255,255,0.28)",
                background:
                    "rgba(255,255,255,0.10)",
                color: "#ffffff",
            }
            : {
                ...baseStyle,
                border:
                    "1px solid #cbd5e1",
                background:
                    "#ffffff",
                color: "#334155",
            };

    const logoutStyle:
        React.CSSProperties =
        dark
            ? {
                ...baseStyle,
                border:
                    "1px solid rgba(254,202,202,0.45)",
                background:
                    "rgba(220,38,38,0.18)",
                color: "#ffffff",
            }
            : {
                ...baseStyle,
                border:
                    "1px solid #fecaca",
                background:
                    "#fef2f2",
                color: "#991b1b",
            };

    return (
        <div
            style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
            }}
        >
            <a
                href="/change-password"
                style={secondary}
            >
                Change Password
            </a>

            <button
                type="button"
                style={logoutStyle}
                onClick={() =>
                    void logout()
                }
                disabled={busy}
            >
                {busy
                    ? "Signing out…"
                    : "Log out"}
            </button>
        </div>
    );
}
