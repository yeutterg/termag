"use client";

import { type FormEvent, useState } from "react";
import { Check, Copy } from "lucide-react";

type Token = { id: string; name: string; tokenPrefix: string; createdAt: string; token?: string };

interface NewDeviceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (token: Token) => void;
}

export function NewDeviceDialog({ open, onOpenChange, onCreated }: NewDeviceDialogProps) {
  const [createdToken, setCreatedToken] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [copied, setCopied] = useState(false);

  async function createDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") || "").trim() || "New device";
    const res = await fetch("/api/agent-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      return;
    }
    const body = await res.json();
    setCreatedToken(body.token);
    setDeviceName(name);
    setCopied(false);
    onCreated?.(body);
    form.reset();
  }

  async function copyToken() {
    if (!createdToken) {
      return;
    }
    try {
      await navigator.clipboard.writeText(createdToken);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = createdToken;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  if (!open) {
    return null;
  }
  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4" onClick={() => onOpenChange(false)}>
      <section
        className="mx-auto mt-[10vh] max-w-lg rounded-lg border border-line bg-panel p-4 shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="mb-4">
          <h2 className="text-base font-semibold">New device</h2>
          <p className="mt-1 text-sm text-muted">
            Create one agent token per physical device. Revoke this token if that device is lost or
            retired.
          </p>
        </div>
        <form onSubmit={createDevice} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Device name</span>
            <input
              name="name"
              type="text"
              autoFocus
              autoComplete="off"
              placeholder="laptop, workstation, vps, homelab"
              className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
            />
          </label>
          <button className="h-9 rounded-md bg-text px-3 text-sm font-medium text-bg">
            Create device token
          </button>
        </form>
        {createdToken && (
          <div className="mt-4 rounded-md border border-warn bg-warn/10 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-xs font-medium text-warn">Token for {deviceName} shown once</div>
              <button
                type="button"
                onClick={copyToken}
                className="flex h-7 items-center gap-1.5 rounded-md border border-warn/30 bg-bg px-2 text-xs text-warn hover:bg-warn/10"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <code className="block break-all font-mono text-xs">{createdToken}</code>
          </div>
        )}
      </section>
    </div>
  );
}
