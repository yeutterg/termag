"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { DirectoryBrowser } from "./directory-browser";
import type { AgentDeviceStatus } from "./types";

export type NewProjectInput = {
  deviceName: string;
  rootKey: string;
  relativePath: string;
  name?: string;
  runtime: "herdr" | "tmux";
  runtimeSessionId?: string;
};

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: NewProjectInput) => Promise<{ ok: boolean; error?: string }>;
  agentDevices: AgentDeviceStatus[];
  knownDeviceNames: string[];
  selectedDevice?: string | null;
}

type TokenDefaults = {
  name: string;
  defaultRootKey?: string | null;
  defaultRelativePath?: string | null;
};

export function NewProjectDialog({
  open,
  onOpenChange,
  onCreate,
  agentDevices,
  selectedDevice,
}: NewProjectDialogProps) {
  const devices = useMemo(
    () => agentDevices.filter(device => device.connected && (device.protocolVersion ?? 2) >= 2),
    [agentDevices]
  );
  const initialDeviceName =
    selectedDevice && devices.some(device => device.name === selectedDevice)
      ? selectedDevice
      : (devices[0]?.name ?? "");
  const [deviceName, setDeviceName] = useState(initialDeviceName);
  const [tokens, setTokens] = useState<TokenDefaults[]>([]);
  const [rootKey, setRootKey] = useState("");
  const [relativePath, setRelativePath] = useState("");
  const [runtime, setRuntime] = useState<"herdr" | "tmux" | null>(null);
  const [runtimeSessionId, setRuntimeSessionId] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const activeDeviceName = devices.some(device => device.name === deviceName)
    ? deviceName
    : initialDeviceName;

  useEffect(() => {
    if (!open) {
      return;
    }
    fetch("/api/agent-tokens")
      .then(response => (response.ok ? response.json() : []))
      .then(value => setTokens(Array.isArray(value) ? value : []))
      .catch(() => setTokens([]));
  }, [open]);

  const device = devices.find(item => item.name === activeDeviceName);
  const roots = useMemo(() => device?.roots ?? {}, [device?.roots]);
  const defaults = tokens.find(token => token.name === activeDeviceName);
  const herdrSessions =
    device?.runtimeSessions?.find(item => item.kind === "herdr" && item.available)?.sessions ?? [];
  const effectiveRuntime = runtime ?? (herdrSessions.length ? "herdr" : "tmux");
  const effectiveRuntimeSessionId = herdrSessions.some(item => item.id === runtimeSessionId)
    ? runtimeSessionId
    : (herdrSessions[0]?.id ?? "");

  useEffect(() => {
    if (!open) {
      return;
    }
    const preferredRoot =
      defaults?.defaultRootKey && roots[defaults.defaultRootKey] !== undefined
        ? defaults.defaultRootKey
        : (Object.keys(roots)[0] ?? "");
    queueMicrotask(() => {
      setRootKey(preferredRoot);
      setRelativePath(
        preferredRoot && preferredRoot === defaults?.defaultRootKey
          ? (defaults.defaultRelativePath ?? "")
          : ""
      );
    });
  }, [activeDeviceName, defaults, open, roots]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    if (!device || !rootKey) {
      setError("Connect a machine and choose one of its allowlisted folders.");
      return;
    }
    if (effectiveRuntime === "herdr" && !effectiveRuntimeSessionId) {
      setError("Choose a running Herdr session.");
      return;
    }
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    const result = await onCreate({
      deviceName: activeDeviceName,
      rootKey,
      relativePath,
      name: String(form.get("name") || "").trim() || undefined,
      runtime: effectiveRuntime,
      runtimeSessionId: effectiveRuntime === "herdr" ? effectiveRuntimeSessionId : undefined,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error || "The local runtime could not create that terminal.");
      return;
    }
    onOpenChange(false);
  }

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-3 sm:p-4" onClick={() => onOpenChange(false)}>
      <section
        className="mx-auto mt-[3dvh] flex max-h-[94dvh] max-w-lg flex-col rounded-lg border border-line bg-panel p-4 shadow-2xl sm:mt-[6dvh] sm:max-h-[88dvh]"
        onClick={event => event.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">New terminal</h2>
            <p className="mt-1 text-sm text-muted">Create it in tmux or the local Herdr app.</p>
          </div>
          <button
            type="button"
            className="grid h-11 w-11 place-items-center rounded-md text-muted hover:bg-panel2"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <label>
            <span className="mb-1 block text-xs font-medium text-muted">Machine</span>
            <select
              value={activeDeviceName}
              onChange={event => {
                setDeviceName(event.target.value);
                setRuntime(null);
                setRuntimeSessionId("");
              }}
              disabled={!devices.length}
              className="min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
            >
              {!devices.length && <option value="">No connected machines</option>}
              {devices.map(item => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label>
              <span className="mb-1 block text-xs font-medium text-muted">Runtime</span>
              <select
                value={effectiveRuntime}
                onChange={event => setRuntime(event.target.value as "herdr" | "tmux")}
                className="min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
              >
                {herdrSessions.length > 0 && <option value="herdr">Herdr</option>}
                <option value="tmux">tmux</option>
              </select>
            </label>
            {effectiveRuntime === "herdr" && (
              <label>
                <span className="mb-1 block text-xs font-medium text-muted">Herdr session</span>
                <select
                  value={effectiveRuntimeSessionId}
                  onChange={event => setRuntimeSessionId(event.target.value)}
                  className="min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
                >
                  {herdrSessions.map(session => (
                    <option key={session.id} value={session.id}>
                      {session.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div>
            <span className="mb-1 block text-xs font-medium text-muted">Allowlisted folder</span>
            {activeDeviceName ? (
              <DirectoryBrowser
                key={`${activeDeviceName}:${defaults?.defaultRootKey || ""}`}
                deviceName={activeDeviceName}
                roots={roots}
                initialRootKey={rootKey || undefined}
                initialRelativePath={relativePath || undefined}
                onChange={(nextRoot, nextRelative) => {
                  setRootKey(nextRoot);
                  setRelativePath(nextRelative);
                }}
              />
            ) : (
              <div className="rounded-md border border-line bg-bg px-3 py-3 text-xs text-muted">
                Bootstrap and connect a machine first.
              </div>
            )}
          </div>

          <label>
            <span className="mb-1 block text-xs font-medium text-muted">Name</span>
            <input
              name="name"
              autoComplete="off"
              placeholder="Defaults to the folder name"
              className="min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
            />
          </label>

          <p className="rounded-md border border-line bg-bg px-3 py-2 text-xs text-muted">
            Herdr remains authoritative when selected: the new space appears locally and its tabs,
            panes, names, order, and status mirror back here.
          </p>
          {error && <div className="text-xs text-bad">{error}</div>}
          <button
            type="submit"
            disabled={submitting || !device || !rootKey}
            className="min-h-11 shrink-0 rounded-md bg-text px-3 text-sm font-medium text-bg disabled:opacity-60"
          >
            {submitting ? "Creating…" : "Create terminal"}
          </button>
        </form>
      </section>
    </div>
  );
}
