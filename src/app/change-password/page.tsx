"use client";

import { useState } from "react";
import type { FormEvent } from "react";

export default function ChangePasswordPage() {
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        setBusy(true);
        setError("");

        try {
            const response = await fetch("/api/admin/change-password", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    currentPassword,
                    newPassword,
                    confirmPassword,
                }),
            });

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                throw new Error(
                    payload?.error ||
                    `Password change failed (${response.status}).`
                );
            }

            window.location.assign(
                payload?.redirectTo || "/login?passwordChanged=1"
            );
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not change password."
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <main className="asm-page">
            <section
                className="asm-hero"
                style={{
                    maxWidth: 640,
                    margin: "42px auto 0",
                }}
            >
                <div className="asm-eyebrow">Admin Security</div>

                <h1 className="asm-title">Change Password</h1>

                <p className="asm-subtitle">
                    Change the administrator password. You will be signed out after a
                    successful change.
                </p>
            </section>

            <section
                className="asm-card"
                style={{
                    maxWidth: 640,
                    margin: "18px auto 0",
                    padding: 24,
                }}
            >
                <form onSubmit={submit}>
                    <label
                        htmlFor="current-password"
                        style={{
                            display: "block",
                            fontWeight: 800,
                            marginBottom: 7,
                        }}
                    >
                        Current password
                    </label>

                    <input
                        id="current-password"
                        className="asm-input"
                        type="password"
                        autoComplete="current-password"
                        value={currentPassword}
                        onChange={(event) => setCurrentPassword(event.target.value)}
                        disabled={busy}
                        required
                    />

                    <label
                        htmlFor="new-password"
                        style={{
                            display: "block",
                            fontWeight: 800,
                            margin: "16px 0 7px",
                        }}
                    >
                        New password
                    </label>

                    <input
                        id="new-password"
                        className="asm-input"
                        type="password"
                        autoComplete="new-password"
                        value={newPassword}
                        onChange={(event) => setNewPassword(event.target.value)}
                        disabled={busy}
                        minLength={12}
                        required
                    />

                    <div
                        className="asm-muted"
                        style={{
                            marginTop: 7,
                            fontSize: 12,
                        }}
                    >
                        At least 12 characters, including a letter and a number.
                    </div>

                    <label
                        htmlFor="confirm-password"
                        style={{
                            display: "block",
                            fontWeight: 800,
                            margin: "16px 0 7px",
                        }}
                    >
                        Confirm new password
                    </label>

                    <input
                        id="confirm-password"
                        className="asm-input"
                        type="password"
                        autoComplete="new-password"
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.target.value)}
                        disabled={busy}
                        minLength={12}
                        required
                    />

                    {error ? (
                        <div
                            className="asm-alert asm-alert--danger"
                            style={{
                                marginTop: 16,
                            }}
                        >
                            {error}
                        </div>
                    ) : null}

                    <div
                        style={{
                            display: "flex",
                            gap: 10,
                            marginTop: 20,
                            flexWrap: "wrap",
                        }}
                    >
                        <button className="asm-btn" type="submit" disabled={busy}>
                            {busy ? "Changing…" : "Change Password"}
                        </button>

                        <a
                            className="asm-btn asm-btn--secondary"
                            href="/dashboard"
                            style={{
                                textDecoration: "none",
                            }}
                        >
                            Cancel
                        </a>
                    </div>
                </form>
            </section>
        </main>
    );
}
