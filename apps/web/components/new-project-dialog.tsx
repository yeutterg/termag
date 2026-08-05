"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import { DirectoryBrowser } from "./directory-browser";
import type { AgentDeviceStatus } from "./types";

const AGENT_OPTIONS = [
  { id: "shell", label: "Shell" },
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "codex-yolo", label: "Codex YOLO" },
  { id: "claude-yolo", label: "Claude Code YOLO" },
] as const;

export type NewProjectInput = {
  deviceName: string;
  rootKey: string;
  relativePath: string;
  name?: string;
  agentTypes: string[];
  customAgents: string[];
  runtime?: "herdr" | "tmux";
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

type TokenWithDefaults = {
  id: string;
  name: string;
  defaultRootKey?: string | null;
  defaultRelativePath?: string | null;
};

export function NewProjectDialog({
  open,
  onOpenChange,
  onCreate,
  agentDevices,
  knownDeviceNames,
  selectedDevice,
}: NewProjectDialogProps) {
  const devices = useMemo(() => {
    const names = new Set<string>(knownDeviceNames);
    for (const device of agentDevices) {
      names.add(device.name);
    }
    return [...names];
  }, [agentDevices, knownDeviceNames]);

  const initialDevice =
    selectedDevice && devices.includes(selectedDevice) ? selectedDevice : (devices[0] ?? "");

  const [deviceName, setDeviceName] = useState(initialDevice);
  const [tokens, setTokens] = useState<TokenWithDefaults[]>([]);
  const [tokensLoaded, setTokensLoaded] = useState(false);
  const [rootKey, setRootKey] = useState("");
  const [relativePath, setRelativePath] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [runtime, setRuntime] = useState<"herdr" | "tmux" | null>(null);
  const [runtimeSessionId, setRuntimeSessionId] = useState("");

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    fetch("/api/agent-tokens")
      .then(res => (res.ok ? res.json() : []))
      .then(next => {
        if (cancelled) {
          return;
        }
        setTokens(Array.isArray(next) ? next : []);
        setTokensLoaded(true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setTokens([]);
        setTokensLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    queueMicrotask(() => {
      setDeviceName(current => {
        if (selectedDevice && devices.includes(selectedDevice)) {
          return selectedDevice;
        }
        if (current && devices.includes(current)) {
          return current;
        }
        return devices[0] ?? "";
      });
    });
  }, [open, selectedDevice, devices]);

  const currentDevice = useMemo(
    () => agentDevices.find(device => device.name === deviceName) || null,
    [agentDevices, deviceName]
  );
  const currentToken = useMemo(
    () => tokens.find(token => token.name === deviceName) || null,
    [tokens, deviceName]
  );
  const protocolV2 = (currentDevice?.protocolVersion ?? 1) >= 2;
  const herdrSessions = useMemo(
    () => currentDevice?.runtimeSessions?.find(item => item.kind === "herdr")?.sessions ?? [],
    [currentDevice]
  );
  const effectiveRuntime = runtime ?? (herdrSessions.length > 0 ? "herdr" : "tmux");
  const effectiveRuntimeSessionId = herdrSessions.some(session => session.id === runtimeSessionId)
    ? runtimeSessionId
    : (herdrSessions[0]?.id ?? "");
  const deviceRoots: Record<string, string> = useMemo(() => {
    const reported =
      currentDevice?.roots && Object.keys(currentDevice.roots).length > 0
        ? currentDevice.roots
        : null;
    if (reported) {
      return reported;
    }
    // Fallback: the device hasn't reported health yet but we know its name —
    // assume the convention (rootKey == deviceName, path unknown). The user
    // can still type a path via the browser's "type a path" mode.
    return deviceName ? { [deviceName]: "" } : {};
  }, [currentDevice, deviceName]);

  const defaultRootKey = currentToken?.defaultRootKey ?? "";
  const defaultRelativePath = currentToken?.defaultRelativePath ?? "";

  // When the device or its defaults change, reset the picker.
  useEffect(() => {
    if (!open) {
      return;
    }
    queueMicrotask(() => {
      setRootKey(
        defaultRootKey && deviceRoots[defaultRootKey] !== undefined
          ? defaultRootKey
          : (Object.keys(deviceRoots)[0] ?? "")
      );
      setRelativePath(
        defaultRootKey && deviceRoots[defaultRootKey] !== undefined ? defaultRelativePath : ""
      );
      setError("");
    });
  }, [open, tokensLoaded, defaultRootKey, defaultRelativePath, deviceRoots]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    if (!deviceName) {
      setError("Create a device first.");
      return;
    }
    if (!rootKey) {
      setError("Pick a root folder for this project.");
      return;
    }
    const formData = new FormData(event.currentTarget);
    const customAgents = String(formData.get("customAgents") || "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    const agentTypes = formData.getAll("agentTypes").map(String).filter(Boolean);
    if (!protocolV2 && agentTypes.length + customAgents.length === 0) {
      setError("Select at least one agent.");
      return;
    }
    setError("");
    setSubmitting(true);
    const result = await onCreate({
      deviceName,
      rootKey,
      relativePath,
      name: String(formData.get("name") || "").trim() || undefined,
      agentTypes,
      customAgents,
      runtime: protocolV2 ? effectiveRuntime : undefined,
      runtimeSessionId:
        protocolV2 && effectiveRuntime === "herdr" ? effectiveRuntimeSessionId : undefined,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error || "Could not create that project. Check the directory and try again.");
      return;
    }
    event.currentTarget.reset();
    onOpenChange(false);
  }

  if (!open) {
    return null;
  }
  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4" onClick={() => onOpenChange(false)}>
      <section
        className="mx-auto mt-[6vh] flex max-h-[88vh] max-w-lg flex-col rounded-lg border border-line bg-panel p-4 shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="mb-4">
          <h2 className="text-base font-semibold">New session</h2>
          <p className="mt-1 text-sm text-muted">Device / Folder / Command</p>
        </div>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Device</span>
            <select
              value={deviceName}
              onChange={event => {
                setDeviceName(event.target.value);
                setRuntime(null);
                setRuntimeSessionId("");
              }}
              required
              disabled={devices.length === 0}
              className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
            >
              {devices.length === 0 && <option value="">Create a device first</option>}
              {devices.map(device => (
                <option key={device} value={device}>
                  {device}
                </option>
              ))}
            </select>
          </label>
          {protocolV2 && (
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Runtime</span>
                <select
                  value={effectiveRuntime}
                  onChange={event => setRuntime(event.target.value as "herdr" | "tmux")}
                  className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
                >
                  {herdrSessions.length > 0 && <option value="herdr">HerdR</option>}
                  <option value="tmux">tmux</option>
                </select>
              </label>
              {effectiveRuntime === "herdr" && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">HerdR session</span>
                  <select
                    value={effectiveRuntimeSessionId}
                    onChange={event => setRuntimeSessionId(event.target.value)}
                    className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
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
          )}
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted">Folder</span>
              {currentToken &&
                (currentToken.defaultRootKey || currentToken.defaultRelativePath) && (
                  <span className="truncate text-[10px] text-muted">
                    Default: {currentToken.defaultRootKey}
                    {currentToken.defaultRelativePath ? `/${currentToken.defaultRelativePath}` : ""}
                  </span>
                )}
            </div>
            {deviceName ? (
              <DirectoryBrowser
                key={`${deviceName}:${defaultRootKey}:${defaultRelativePath}`}
                deviceName={deviceName}
                roots={deviceRoots}
                initialRootKey={rootKey || defaultRootKey || undefined}
                initialRelativePath={relativePath || defaultRelativePath || undefined}
                onChange={(nextRoot, nextRel) => {
                  setRootKey(nextRoot);
                  setRelativePath(nextRel);
                }}
              />
            ) : (
              <div className="rounded-md border border-line bg-bg px-3 py-3 text-xs text-muted">
                No device selected.
              </div>
            )}
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Project name</span>
            <input
              name="name"
              type="text"
              autoComplete="off"
              placeholder="Defaults to the folder name"
              className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
            />
          </label>
          {!protocolV2 && (
            <fieldset>
              <legend className="mb-2 text-xs font-medium text-muted">Start with</legend>
              <div className="grid grid-cols-2 gap-2">
                {AGENT_OPTIONS.map(agent => (
                  <label
                    key={agent.id}
                    className="flex h-9 items-center gap-2 rounded-md border border-line bg-bg px-3 text-sm"
                  >
                    <input
                      name="agentTypes"
                      value={agent.id}
                      type="checkbox"
                      defaultChecked={agent.id === "shell"}
                      className="h-4 w-4 accent-current"
                    />
                    <span>{agent.label}</span>
                  </label>
                ))}
              </div>
              <label className="mt-2 block">
                <span className="mb-1 block text-xs font-medium text-muted">Other command</span>
                <textarea
                  name="customAgents"
                  rows={2}
                  placeholder={"gemini\nopencode"}
                  className="min-h-16 w-full resize-y rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs outline-none focus:border-accent"
                />
              </label>
            </fieldset>
          )}
          {protocolV2 && (
            <div className="rounded-md border border-line bg-bg px-3 py-2 text-xs text-muted">
              The local runtime creates the shell. HerdR spaces and tabs appear locally without
              taking focus.
            </div>
          )}
          {error && <div className="text-xs text-bad">{error}</div>}
          <button
            type="submit"
            disabled={submitting}
            className="h-9 shrink-0 rounded-md bg-text px-3 text-sm font-medium text-bg disabled:opacity-60"
          >
            {submitting ? "Creating..." : "Create session"}
          </button>
        </form>
      </section>
    </div>
  );
}
