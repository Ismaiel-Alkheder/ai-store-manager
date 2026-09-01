"use client";

import {
    FormEvent,
    useEffect,
    useState,
} from "react";

export default function LoginPage() {
    const [busy, setBusy] =
        useState(false);

    const [error, setError] =
        useState("");

    const [message, setMessage] =
        useState("");

    useEffect(() => {
        const params =
            new URLSearchParams(
                window.location.search
            );

        if (
            params.get(
                "passwordChanged"
            ) === "1"
        ) {
            setMessage(
                "Password changed successfully. Please sign in with your new password."
            );
        }
    }, []);

    async function submit(
        event: FormEvent<HTMLFormElement>
    ) {
        event.preventDefault();

        if (busy) {
            return;
        }

        /*
          Read the password directly from the form.

          This is more reliable than relying on React state
          because browsers/password managers can autofill
          password fields without firing React's onChange,
          especially in Incognito/InPrivate windows.
        */
        const formData =
            new FormData(
                event.currentTarget
            );

        const passwordValue =
            formData.get(
                "password"
            );

        const password =
            typeof passwordValue ===
                "string"
                ? passwordValue
                : "";

        if (!password) {
            setError(
                "Password is required."
            );
            return;
        }

        setBusy(true);
        setError("");
        setMessage("");

        try {
            const response =
                await fetch(
                    "/api/admin/login",
                    {
                        method:
                            "POST",

                        headers: {
                            "Content-Type":
                                "application/json",
                        },

                        credentials:
                            "same-origin",

                        body:
                            JSON.stringify({
                                password,
                            }),
                    }
                );

            const payload =
                await response
                    .json()
                    .catch(
                        () => null
                    );

            if (!response.ok) {
                throw new Error(
                    payload?.error ||
                    `Sign in failed (${response.status}).`
                );
            }

            const params =
                new URLSearchParams(
                    window.location.search
                );

            const requestedNext =
                params.get("next");

            const safeNext =
                requestedNext &&
                    requestedNext.startsWith(
                        "/"
                    ) &&
                    !requestedNext.startsWith(
                        "//"
                    )
                    ? requestedNext
                    : payload?.redirectTo ||
                    "/dashboard";

            window.location.assign(
                safeNext
            );
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not sign in."
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
                    maxWidth: 560,
                    margin:
                        "56px auto 0",
                }}
            >
                <div className="asm-eyebrow">
                    AI Store Manager
                </div>

                <h1 className="asm-title">
                    Admin Sign In
                </h1>

                <p className="asm-subtitle">
                    Enter your administrator
                    password to continue.
                </p>
            </section>

            <section
                className="asm-card"
                style={{
                    maxWidth: 560,
                    margin:
                        "18px auto 0",
                    padding: 24,
                }}
            >
                <form
                    onSubmit={
                        submit
                    }
                >
                    <label
                        htmlFor="admin-password"
                        style={{
                            display:
                                "block",
                            fontWeight:
                                800,
                            marginBottom:
                                7,
                        }}
                    >
                        Admin password
                    </label>

                    <input
                        id="admin-password"
                        name="password"
                        className="asm-input"
                        type="password"
                        autoComplete="current-password"
                        disabled={
                            busy
                        }
                        required
                        autoFocus
                    />

                    {message ? (
                        <div
                            className="asm-alert"
                            style={{
                                marginTop:
                                    16,
                            }}
                        >
                            {
                                message
                            }
                        </div>
                    ) : null}

                    {error ? (
                        <div
                            className="asm-alert asm-alert--danger"
                            style={{
                                marginTop:
                                    16,
                            }}
                        >
                            {error}
                        </div>
                    ) : null}

                    <button
                        className="asm-btn"
                        type="submit"
                        disabled={
                            busy
                        }
                        style={{
                            width:
                                "100%",
                            marginTop:
                                18,
                        }}
                    >
                        {busy
                            ? "Signing in…"
                            : "Sign in"}
                    </button>
                </form>
            </section>
        </main>
    );
}
