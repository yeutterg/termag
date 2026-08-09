"use client";

import { type FormEvent, useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

interface BootstrapDeviceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type BootstrapResponse = {
  code: string;
  claimUrl: string;
  expiresAt: string;
  cliCommand: string;
};

// One-time-code bootstrap flow. The user clicks "Generate code", we mint
// one server-side, and show the command + URL the new device's CLI
// redeems. Expires in 15 min; we count down so the user can re-mint if
// they get distracted. The actual agent token is minted inside the
// claim — abandoned codes don't leave token rows behind.
export function BootstrapDeviceDialog({ open, onOpenChange }: BootstrapDeviceDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BootstrapResponse | null>(null);
  const [copied, setCopied] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!result) {
      return;
    }
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [result]);

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = event.currentTarget;
    const data = new FormData(form);
    const deviceName = String(data.get("deviceName") || "").trim();
    setSubmitting(true);
    try {
      const res = await fetch("/api/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(deviceName ? { deviceName } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error || `Could not mint bootstrap code (HTTP ${res.status})`);
        return;
      }
      setResult(body as BootstrapResponse);
    } finally {
      setSubmitting(false);
    }
  }

  async function copy(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(id);
    window.setTimeout(() => setCopied(current => (current === id ? "" : current)), 1500);
  }

  if (!open) {
    return null;
  }
  const expiresInSec = result
    ? Math.max(0, Math.floor((new Date(result.expiresAt).getTime() - now) / 1000))
    : 0;
  const expired = result !== null && expiresInSec === 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4" onClick={() => onOpenChange(false)}>
      <section
        className="mx-auto mt-[10vh] max-w-lg rounded-lg border border-line bg-panel p-4 shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="mb-4">
          <h2 className="text-base font-semibold">Bootstrap new device</h2>
          <p className="mt-1 text-sm text-muted">
            Generates a one-time, 15-minute code. Run the command on the new device — it writes the
            URL + token to <code className="font-mono text-xs">~/.terminalz/config.json</code> for
            you.
          </p>
        </div>
        {!result && (
          <form onSubmit={generate} className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">
                Device name (optional)
              </span>
              <input
                name="deviceName"
                type="text"
                autoFocus
                autoComplete="off"
                placeholder="ipad, vps, homelab"
                className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
              />
            </label>
            {error && (
              <div className="rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="h-9 rounded-md border border-line bg-bg px-3 text-sm text-text hover:bg-panel2"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="h-9 rounded-md bg-text px-3 text-sm font-medium text-bg disabled:opacity-60"
              >
                {submitting ? "Generating…" : "Generate code"}
              </button>
            </div>
          </form>
        )}
        {result && (
          <div className="space-y-3">
            <div className="rounded-md border border-line bg-bg p-3">
              <div className="mb-2 text-xs font-medium text-muted">Run on the new device</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all font-mono text-xs">
                  {result.cliCommand}
                </code>
                <button
                  type="button"
                  onClick={() => copy("cmd", result.cliCommand)}
                  className="flex h-7 items-center gap-1 rounded-md border border-line bg-panel2 px-2 text-xs hover:bg-panel"
                  aria-label="Copy command"
                >
                  {copied === "cmd" ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied === "cmd" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            <div className="rounded-md border border-line bg-bg p-3">
              <div className="mb-2 text-xs font-medium text-muted">
                Or paste this URL into <code className="font-mono">terminalz bootstrap</code>
              </div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all font-mono text-xs">
                  {result.claimUrl}
                </code>
                <button
                  type="button"
                  onClick={() => copy("url", result.claimUrl)}
                  className="flex h-7 items-center gap-1 rounded-md border border-line bg-panel2 px-2 text-xs hover:bg-panel"
                  aria-label="Copy URL"
                >
                  {copied === "url" ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied === "url" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            <div className={expired ? "text-xs text-bad" : "text-xs text-muted"}>
              {expired
                ? "Expired — generate a new code."
                : `Expires in ${formatSec(expiresInSec)}.`}
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setResult(null);
                  setError("");
                }}
                className="h-9 rounded-md border border-line bg-bg px-3 text-sm text-text hover:bg-panel2"
              >
                {expired ? "New code" : "Done"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function formatSec(s: number): string {
  if (s < 60) {
    return `${s}s`;
  }
  const min = Math.floor(s / 60);
  const sec = s % 60;
  return `${min}m ${sec}s`;
}
