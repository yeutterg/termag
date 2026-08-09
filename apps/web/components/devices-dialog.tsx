"use client";

import { useEffect, useState } from "react";
import { ExternalLink, FolderCog, Plus, Trash2, X, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentDeviceStatus } from "./types";
import { DirectoryBrowser } from "./directory-browser";

type Token = {
  id: string;
  name: string;
  tokenPrefix: string;
  lastUsedAt?: string | null;
  defaultRootKey?: string | null;
  defaultRelativePath?: string | null;
};

interface DevicesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { email: string; name?: string | null };
  devices: AgentDeviceStatus[];
  knownDeviceNames?: string[];
  focusedDevice?: string | null;
  onTokenDeleted?: (tokenName: string) => void;
  onAddDevice?: () => void;
  onBootstrap?: () => void;
}

export function DevicesDialog({
  open,
  onOpenChange,
  user,
  devices,
  knownDeviceNames = [],
  focusedDevice,
  onTokenDeleted,
  onAddDevice,
  onBootstrap,
}: DevicesDialogProps) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editingDefault, setEditingDefault] = useState("");
  const [savingDefault, setSavingDefault] = useState("");

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    fetch("/api/agent-tokens")
      .then(response => (response.ok ? response.json() : []))
      .then(value => {
        if (!cancelled) {
          setTokens(Array.isArray(value) ? value : []);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTokens([]);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !focusedDevice) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(`termag-device-${encodeURIComponent(focusedDevice)}`)
        ?.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedDevice, open, tokens]);

  async function patchToken(
    tokenId: string,
    payload: Pick<Token, "defaultRootKey" | "defaultRelativePath">
  ) {
    setSavingDefault(tokenId);
    try {
      const response = await fetch(`/api/agent-tokens/${encodeURIComponent(tokenId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        return;
      }
      const next = await response.json();
      setTokens(current => current.map(token => (token.id === tokenId ? next : token)));
    } finally {
      setSavingDefault("");
    }
  }

  if (!open) {
    return null;
  }

  const deviceByName = new Map(devices.map(device => [device.name, device]));
  const names = [
    ...new Set([
      ...knownDeviceNames,
      ...tokens.map(token => token.name),
      ...devices.map(d => d.name),
    ]),
  ];
  const connectedCount = devices.filter(device => device.connected).length;

  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-3 sm:p-4" onClick={() => onOpenChange(false)}>
      <section
        className="mx-auto mt-[3dvh] flex max-h-[94dvh] max-w-2xl flex-col rounded-lg border border-line bg-panel p-4 shadow-2xl sm:mt-[7dvh] sm:max-h-[86dvh]"
        onClick={event => event.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Machines</h2>
            <p className="text-sm text-muted">{user.email}</p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "rounded-full px-2 py-1 text-xs",
                connectedCount ? "bg-good/15 text-good" : "bg-panel2 text-muted"
              )}
            >
              {connectedCount ? `${connectedCount} connected` : "None connected"}
            </span>
            <button
              type="button"
              className="grid h-11 w-11 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text"
              onClick={() => onOpenChange(false)}
              aria-label="Close machines"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
          {onBootstrap && (
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onBootstrap();
              }}
              className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line bg-bg px-3 text-xs hover:bg-panel2"
            >
              <Zap className="h-4 w-4" /> Bootstrap machine
            </button>
          )}
          {onAddDevice && (
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onAddDevice();
              }}
              className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line bg-bg px-3 text-xs hover:bg-panel2"
            >
              <Plus className="h-4 w-4" /> Create token
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain">
          {!loaded && <div className="h-24 animate-pulse rounded-md border border-line bg-bg/60" />}
          {loaded && names.length === 0 && (
            <div className="rounded-md border border-line bg-bg px-4 py-8 text-center text-sm text-muted">
              No machines yet. Bootstrap one to mirror its Herdr and tmux terminals.
            </div>
          )}
          {loaded &&
            names.map(name => {
              const token = tokens.find(item => item.name === name);
              const device = deviceByName.get(name);
              const roots = device?.roots ?? {};
              const runtimeCounts = (device?.runtimeSessions ?? [])
                .filter(runtime => runtime.available)
                .map(runtime => `${runtime.kind}: ${runtime.sessions.length}`)
                .join(" · ");
              return (
                <article
                  key={name}
                  id={`termag-device-${encodeURIComponent(name)}`}
                  className={cn(
                    "rounded-md border border-line bg-bg p-3",
                    focusedDevice === name && "border-accent/60 ring-1 ring-accent/60"
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "h-2 w-2 shrink-0 rounded-full",
                            device?.connected ? "bg-good" : "bg-muted/40"
                          )}
                        />
                        <span className="truncate text-sm font-medium">{name}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
                        <span>{device?.connected ? "Connected" : "Offline"}</span>
                        {device?.version && <span>agent {device.version}</span>}
                        {typeof device?.memMb === "number" && <span>{device.memMb} MB</span>}
                        {runtimeCounts && <span>{runtimeCounts}</span>}
                      </div>
                      <div className="mt-1 text-[11px] text-muted">
                        {token ? `token ${token.tokenPrefix}` : "No active token row"}
                        {token?.lastUsedAt ? ` · last seen ${formatDate(token.lastUsedAt)}` : ""}
                      </div>
                    </div>
                    {token && (
                      <button
                        type="button"
                        className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-bad"
                        aria-label={`Revoke ${name}`}
                        onClick={async () => {
                          if (!window.confirm(`Revoke ${name} and disconnect its agent?`)) {
                            return;
                          }
                          const response = await fetch(
                            `/api/agent-tokens/${encodeURIComponent(token.id)}`,
                            { method: "DELETE" }
                          );
                          if (response.ok) {
                            setTokens(current => current.filter(item => item.id !== token.id));
                            onTokenDeleted?.(name);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  {Object.keys(roots).length > 0 && (
                    <div className="mt-3 rounded-md border border-line bg-panel px-2 py-1.5 font-mono text-[11px] text-muted">
                      {Object.entries(roots).map(([key, path]) => (
                        <div key={key} className="truncate">
                          {key}: {path}
                        </div>
                      ))}
                    </div>
                  )}

                  {token && (
                    <div className="mt-3 border-t border-line pt-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 text-xs">
                          <div className="font-medium">Default creation folder</div>
                          <div className="truncate text-[11px] text-muted">
                            {token.defaultRootKey
                              ? `${token.defaultRootKey}${token.defaultRelativePath ? `/${token.defaultRelativePath}` : ""}`
                              : "First reported root"}
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          {token.defaultRootKey && (
                            <button
                              type="button"
                              className="grid h-11 w-11 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-bad"
                              disabled={savingDefault === token.id}
                              onClick={() =>
                                patchToken(token.id, {
                                  defaultRootKey: null,
                                  defaultRelativePath: null,
                                })
                              }
                              aria-label="Clear default folder"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          )}
                          <button
                            type="button"
                            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line px-3 text-xs hover:bg-panel2 disabled:opacity-50"
                            disabled={!device?.connected || Object.keys(roots).length === 0}
                            onClick={() =>
                              setEditingDefault(current => (current === token.id ? "" : token.id))
                            }
                          >
                            <FolderCog className="h-4 w-4" /> Set
                          </button>
                        </div>
                      </div>
                      {editingDefault === token.id && device?.connected && (
                        <div className="mt-2">
                          <DirectoryBrowser
                            deviceName={name}
                            roots={roots}
                            initialRootKey={token.defaultRootKey || Object.keys(roots)[0]}
                            initialRelativePath={token.defaultRelativePath || ""}
                            onSelect={async (rootKey, relativePath) => {
                              await patchToken(token.id, {
                                defaultRootKey: rootKey || null,
                                defaultRelativePath: relativePath || null,
                              });
                              setEditingDefault("");
                            }}
                            selectLabel="Save default"
                            disabled={savingDefault === token.id}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </article>
              );
            })}

          <div className="rounded-md border border-line bg-bg p-3 text-xs text-muted">
            The Rust agent discovers Herdr and tmux automatically; no per-session publish command is
            needed. Herdr remains an independent local app.
            <a
              href="https://github.com/yeutterg/terminalz#quick-setup"
              target="_blank"
              rel="noreferrer"
              className="mt-2 flex min-h-11 items-center gap-1 text-accent hover:underline"
            >
              Setup guide <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}
