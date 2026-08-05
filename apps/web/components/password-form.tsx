"use client";

import { type FormEvent, useState } from "react";

export function PasswordForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? `Sign-in failed (${res.status})`);
        return;
      }
      window.location.href = "/";
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input
        type="password"
        value={password}
        onChange={event => setPassword(event.target.value)}
        autoFocus
        autoComplete="current-password"
        placeholder="Password"
        className="h-10 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
      />
      {error && <p className="text-xs text-bad">{error}</p>}
      <button
        type="submit"
        disabled={submitting || password.length === 0}
        className="h-10 w-full rounded-md bg-accent px-3 text-sm font-medium text-bg disabled:opacity-50"
      >
        {submitting ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
