"use client";

import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  BellOff,
  ChevronsLeft,
  ChevronsRight,
  Command as CommandIcon,
  ExternalLink,
  FolderPlus,
  Laptop,
  Menu,
  Monitor,
  Moon,
  Plus,
  Sun,
  Terminal,
  Zap,
  Coffee,
} from "lucide-react";
import { TerminalPane } from "./terminal/terminal-pane";
import { HealthBanner } from "./health-banner";
import { useSessionNotifications } from "./use-session-notifications";
import { PlatformProvider, Shortcut, shortcutSuffix } from "./shortcut";
import { TabLabel } from "./tab-label";
import { useTabHistory } from "./use-tab-history";
import type { AgentDeviceStatus, Project, Tab } from "./types";
import type { Platform } from "@/lib/platform";
import type { GitOperation, GitOperationResult } from "@/lib/broker";
import { applyLiveInventoryPatch } from "@/lib/live-inventory-patch";
import { prefersLowDataMode } from "@/lib/mobile-data";
import { cn, statusDot } from "@/lib/utils";
import { HerdrStatusIcon } from "./herdr-status-icon";
import { MirroredTerminalLayout } from "./mirrored-terminal-layout";

// Heavy dialogs are split into their own chunks and loaded only when opened.
const CommandPalette = lazy(() =>
  import("./command-palette").then(m => ({ default: m.TermagCommandPalette }))
);
const DevicesDialog = lazy(() =>
  import("./devices-dialog").then(m => ({ default: m.DevicesDialog }))
);
const ShortcutsHelp = lazy(() =>
  import("./shortcuts-help").then(m => ({ default: m.ShortcutsHelp }))
);
const NewDeviceDialog = lazy(() =>
  import("./new-device-dialog").then(m => ({ default: m.NewDeviceDialog }))
);
const NewProjectDialog = lazy(() =>
  import("./new-project-dialog").then(m => ({ default: m.NewProjectDialog }))
);
const BootstrapDeviceDialog = lazy(() =>
  import("./bootstrap-device-dialog").then(m => ({ default: m.BootstrapDeviceDialog }))
);

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

// The lease is deliberately long relative to the renew interval. Mobile
// browsers throttle background timers to roughly one call per minute and
// freeze them outright under memory pressure, and "keep the Mac awake while
// something long runs" is precisely the case where the tab is backgrounded.
// A 10-minute lease survives that; foreground renewals keep it fresh, and a
// visibility change renews immediately rather than waiting for the next tick.
const POWER_LEASE_MS = 600_000;
const POWER_RENEW_MS = 120_000;

function powerLeaseId(deviceName: string): string {
  const key = `termag-power-lease:${deviceName}`;
  let leaseId = sessionStorage.getItem(key);
  if (!leaseId) {
    leaseId = `web:${crypto.randomUUID()}`;
    sessionStorage.setItem(key, leaseId);
  }
  return leaseId;
}

async function updatePowerLease(
  deviceName: string,
  action: "acquire" | "renew" | "release"
): Promise<{ active: boolean }> {
  const response = await fetch(`/api/devices/${encodeURIComponent(deviceName)}/power`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action,
      leaseId: powerLeaseId(deviceName),
      mode: "terminals-awake",
      durationMs: POWER_LEASE_MS,
    }),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || "Power operation failed");
  }
  return { active: Boolean(result.state?.active ?? result.state?.isActive) };
}

function aggregateHerdrStatus(tabs: Tab[]): string {
  const nativeTabStatus = tabs.find(tab => tab.runtimeTabStatus)?.runtimeTabStatus;
  if (nativeTabStatus) {
    return nativeTabStatus;
  }
  const statuses = tabs.map(tab => tab.status);
  return (
    ["blocked", "working", "done", "idle", "unknown"].find(status => statuses.includes(status)) ||
    "unknown"
  );
}

function herdRIndicatorVariant(project?: Project | null): "dot" | "symbol" {
  return project?.runtimeIconStyle === "symbols" ? "symbol" : "dot";
}

function preferredProjectTab(project?: Project | null): Tab | undefined {
  return project?.tabs.find(tab => tab.focused) ?? project?.tabs[0];
}

type SidebarTabGroup = {
  id: string;
  name: string;
  tabs: Tab[];
};

function sidebarTabGroups(project: Project): SidebarTabGroup[] {
  const groups = new Map<string, SidebarTabGroup>();
  for (const tab of project.tabs) {
    const id = project.runtime === "herdr" ? tab.runtimeTabId || tab.id : tab.id;
    const existing = groups.get(id);
    if (existing) {
      existing.tabs.push(tab);
      continue;
    }
    groups.set(id, {
      id,
      name:
        project.runtime === "herdr"
          ? tab.runtimeTabName || tab.runtimePaneName || tab.name
          : tab.name,
      tabs: [tab],
    });
  }
  return [...groups.values()];
}

function preferredProject(projects: Project[]): Project | undefined {
  return projects.find(project => project.runtimeFocused) ?? projects[0];
}

function normalizeAgentDevice(input: unknown): AgentDeviceStatus {
  if (typeof input === "string") {
    return { name: input, connected: true };
  }
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    name: String(raw.name || "Local device"),
    connected: raw.connected !== false,
    version: typeof raw.version === "string" ? raw.version : null,
    fake: Boolean(raw.fake),
    streamCount: Number.isFinite(Number(raw.streamCount)) ? Number(raw.streamCount) : undefined,
    uptimeSec: Number.isFinite(Number(raw.uptimeSec)) ? Number(raw.uptimeSec) : undefined,
    memMb: Number.isFinite(Number(raw.memMb)) ? Number(raw.memMb) : undefined,
    memPeakMb: Number.isFinite(Number(raw.memPeakMb)) ? Number(raw.memPeakMb) : undefined,
    deviceId: typeof raw.deviceId === "string" ? raw.deviceId : null,
    protocolVersion: Number.isFinite(Number(raw.protocolVersion)) ? Number(raw.protocolVersion) : 2,
    capabilities:
      raw.capabilities && typeof raw.capabilities === "object"
        ? (raw.capabilities as Record<string, boolean>)
        : undefined,
    runtimeSessions: Array.isArray(raw.runtimeSessions)
      ? (raw.runtimeSessions as AgentDeviceStatus["runtimeSessions"])
      : undefined,
    roots:
      raw.roots && typeof raw.roots === "object"
        ? (raw.roots as Record<string, string>)
        : undefined,
  };
}

function mergeAgentDeviceHealth(devices: AgentDeviceStatus[], input: unknown): AgentDeviceStatus[] {
  if (!input || typeof input !== "object") {
    return devices;
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.name !== "string") {
    return devices;
  }
  const index = devices.findIndex(device => device.name === raw.name);
  if (index < 0) {
    return [...devices, normalizeAgentDevice(raw)];
  }
  const current = devices[index];
  const next: AgentDeviceStatus = {
    ...current,
    connected: raw.connected !== false,
    version: typeof raw.version === "string" ? raw.version : null,
    streamCount: Number.isFinite(Number(raw.streamCount))
      ? Number(raw.streamCount)
      : current.streamCount,
    uptimeSec: Number.isFinite(Number(raw.uptimeSec)) ? Number(raw.uptimeSec) : current.uptimeSec,
    memMb: Number.isFinite(Number(raw.memMb)) ? Number(raw.memMb) : current.memMb,
    memPeakMb: Number.isFinite(Number(raw.memPeakMb)) ? Number(raw.memPeakMb) : current.memPeakMb,
  };
  if (
    next.connected === current.connected &&
    next.version === current.version &&
    next.streamCount === current.streamCount &&
    next.uptimeSec === current.uptimeSec &&
    next.memMb === current.memMb &&
    next.memPeakMb === current.memPeakMb
  ) {
    return devices;
  }
  const updated = devices.slice();
  updated[index] = next;
  return updated;
}

type AuthMode = "oauth" | "password" | "trusted";
type DeviceToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  token?: string;
};

interface TermagAppProps {
  user: { id: string; email: string; name?: string | null; theme: string };
  initialProjects: Project[];
  platform: Platform;
  authMode: AuthMode;
}

export function TermagApp({ user, initialProjects, platform, authMode }: TermagAppProps) {
  const initialProject = preferredProject(initialProjects);
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [tokenDevices, setTokenDevices] = useState<string[]>([]);
  const [activeProjectId, setActiveProjectId] = useState(initialProject?.id ?? "");
  const [activeTabId, setActiveTabId] = useState(preferredProjectTab(initialProject)?.id ?? "");
  // Open by default on desktop, closed on mobile (the drawer pattern). The
  // initial decision is made server-side via platform.showShortcuts (false on
  // phones) so there's no flash of an open drawer.
  const [sidebarOpen, setSidebarOpen] = useState(platform.showShortcuts);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitResult, setGitResult] = useState<{
    title: string;
    ok: boolean;
    output: string;
  } | null>(null);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [focusedDevice, setFocusedDevice] = useState<string | null>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [newDeviceOpen, setNewDeviceOpen] = useState(false);
  const [bootstrapOpen, setBootstrapOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectDevice, setNewProjectDevice] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [agentDevices, setAgentDevices] = useState<AgentDeviceStatus[]>([]);
  const [theme, setTheme] = useState(user.theme);
  const powerToggleBusy = useRef(false);
  const [caffeinateActiveState, setCaffeinateActive] = useState(false);
  const [caffeinateStatusDevice, setCaffeinateStatusDevice] = useState<string | null>(null);
  const [caffeinateLeaseDevice, setCaffeinateLeaseDevice] = useState<string | null>(null);
  // Live xterm titles keyed by sessionId. Tools inside the terminal can set
  // a title via OSC 0/2; we mirror it onto the corresponding tab label.
  const [liveTitles, setLiveTitles] = useState<Record<string, string>>({});

  const handleSessionTitle = useCallback(
    (sessionId: string, title: string) => {
      setLiveTitles(current =>
        current[sessionId] === title ? current : { ...current, [sessionId]: title }
      );
    },
    [setLiveTitles]
  );
  const initialTab = preferredProjectTab(initialProject);
  const tabHistory = useTabHistory(
    initialProject && initialTab ? { [initialProject.id]: [initialTab.id] } : {}
  );
  const activeProjectIdRef = useRef(activeProjectId);
  const activeTabIdRef = useRef(activeTabId);
  const reloadStateRef = useRef<{
    running: boolean;
    pending: boolean;
    nextProjectId?: string;
    nextTabId?: string;
    waiters: Array<() => void>;
  }>({ running: false, pending: false, waiters: [] });

  const activeProject = useMemo(
    () => projects.find(project => project.id === activeProjectId) ?? projects[0],
    [projects, activeProjectId]
  );
  const activeTab = useMemo(
    () =>
      activeProject?.tabs.find(tab => tab.id === activeTabId) ?? preferredProjectTab(activeProject),
    [activeProject, activeTabId]
  );
  const topTabs = useMemo(() => {
    if (!activeProject || activeProject.runtime !== "herdr") {
      return activeProject?.tabs ?? [];
    }
    const seen = new Set<string>();
    return activeProject.tabs.filter(tab => {
      const key = tab.runtimeTabId || tab.id;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }, [activeProject]);
  const activeRuntimePanes = useMemo(() => {
    if (!activeProject || !activeTab) {
      return [];
    }
    if (activeProject.runtime !== "herdr" || !activeTab.runtimeTabId) {
      return [activeTab];
    }
    return activeProject.tabs.filter(tab => tab.runtimeTabId === activeTab.runtimeTabId);
  }, [activeProject, activeTab]);
  const connectedDeviceNames = useMemo(
    () => new Set(agentDevices.filter(device => device.connected).map(device => device.name)),
    [agentDevices]
  );
  const activeDeviceConnected = Boolean(
    activeProject && connectedDeviceNames.has(activeProject.rootKey)
  );
  const activeAgentDevice = agentDevices.find(device => device.name === activeProject?.rootKey);
  const powerSupported = Boolean(
    activeAgentDevice &&
    activeAgentDevice.protocolVersion === 2 &&
    activeAgentDevice.capabilities?.powerPolicy
  );
  const gitSupported = Boolean(activeAgentDevice && activeAgentDevice.capabilities?.gitOperations);
  const ownsCurrentPowerLease = Boolean(
    powerSupported && activeProject && caffeinateLeaseDevice === activeProject.rootKey
  );
  const caffeinateActive = Boolean(
    powerSupported &&
    activeProject &&
    caffeinateStatusDevice === activeProject.rootKey &&
    caffeinateActiveState
  );

  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    if (!projectMenuId) {
      return;
    }
    const close = () => setProjectMenuId(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [projectMenuId]);

  useEffect(() => {
    if (!createMenuOpen) {
      return;
    }
    const close = () => setCreateMenuOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [createMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent-tokens")
      .then(res => (res.ok ? res.json() : []))
      .then((tokens: DeviceToken[]) => {
        if (cancelled) {
          return;
        }
        const next = new Set<string>();
        for (const token of tokens) {
          if (token.name) {
            next.add(token.name);
          }
        }
        setTokenDevices([...next]);
      })
      .catch(() => {
        if (!cancelled) {
          setTokenDevices([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const wantsDark =
        theme === "dark" ||
        (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      root.classList.toggle("dark", wantsDark);
    };
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  // The keyboard handler needs the latest project/tab and async actions on
  // every keypress, but we only want to bind the listener once. Park them on
  // a ref so the listener body is stable yet always reads fresh values.
  const handlersRef = useRef<{
    activeProject?: Project;
    activeTab?: Tab;
    projects: Project[];
    createTab: (projectId: string) => void;
    closeTab: (projectId: string, tabId: string) => void;
    cycleTheme: () => void;
    selectTab: (projectId: string, tabId: string) => void;
  } | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const handlers = handlersRef.current;
      if (!handlers) {
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      const typing = isTypingTarget(event.target);

      // Esc and ⌘K are always allowed — even mid-rename. They get the user
      // out (Esc) or into the palette (⌘K) regardless of focus.
      if (event.key === "Escape") {
        setPaletteOpen(false);
        setDevicesOpen(false);
        setFocusedDevice(null);
        setNewDeviceOpen(false);
        setNewProjectOpen(false);
        setCreateMenuOpen(false);
        setProjectMenuId(null);
        setHelpOpen(false);
        return;
      }

      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(value => !value);
        return;
      }

      // Modifier-prefixed shortcuts fire even inside inputs/textareas — the
      // modifier signals app intent, not typing intent. xterm.js focuses a
      // hidden textarea while the terminal is active, so a blanket `typing`
      // guard here would silently kill ⌘1-9 (and every other mod shortcut)
      // whenever the terminal has focus. Only ⌘↵ and `?` yield to inputs.

      // ⌃ + 1-9 jumps to the Nth project (matching the sidebar order). We
      // use Ctrl (not Cmd/mod) because Safari intercepts ⌘1-9 at the menu
      // level and ignores preventDefault. ⌃number isn't bound by macOS or
      // any major browser, and matches the iTerm2 tab-switch convention.
      if (event.ctrlKey && !event.metaKey && /^[1-9]$/.test(event.key)) {
        event.preventDefault();
        const project = handlers.projects[parseInt(event.key, 10) - 1];
        if (project) {
          const tabId = preferredProjectTab(project)?.id;
          if (tabId) {
            handlers.selectTab(project.id, tabId);
          }
        }
        return;
      }

      // Note: ⌃Tab / ⌃⇧Tab and ⌘W are intentionally NOT bound — every
      // major browser hard-binds them to next/prev/close tab and ignores
      // preventDefault. The × button on each tab handles close; ⌘1-9
      // and the palette handle navigation.

      if (mod && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarOpen(value => !value);
        return;
      }

      // Cmd+Enter creates a new tab, but yields to inputs (rename commit etc.).
      if (mod && event.key === "Enter") {
        if (typing) {
          return;
        }
        event.preventDefault();
        if (handlers.activeProject) {
          handlers.createTab(handlers.activeProject.id);
        }
        return;
      }

      // Cmd+Shift+P opens the new-session form.
      if (mod && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setSidebarOpen(true);
        setNewProjectDevice(null);
        setNewProjectOpen(true);
        return;
      }

      // ⌘; opens the devices dialog (replaces ⌘, which is browser settings).
      if (mod && event.key === ";") {
        event.preventDefault();
        setFocusedDevice(null);
        setDevicesOpen(true);
        return;
      }

      if (mod && event.key === ".") {
        event.preventDefault();
        handlers.cycleTheme();
        return;
      }

      // ? (Shift+/) opens the cheat sheet — only when not typing, so users
      // can still type a literal "?" into inputs and the terminal.
      if (event.key === "?" && !typing) {
        event.preventDefault();
        setHelpOpen(true);
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/ws/status`;
    const lowData = prefersLowDataMode();
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let cancelled = false;
    let suspended = lowData && document.visibilityState === "hidden";
    let needsProjectReconcile = suspended;

    const connect = () => {
      if (
        cancelled ||
        suspended ||
        ws?.readyState === WebSocket.OPEN ||
        ws?.readyState === WebSocket.CONNECTING
      ) {
        return;
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const socket = new WebSocket(url);
      ws = socket;
      socket.onopen = () => {
        attempts = 0;
        socket.send(JSON.stringify({ type: "subscribe-devices" }));
        if (needsProjectReconcile) {
          needsProjectReconcile = false;
          window.dispatchEvent(new CustomEvent("termag:refresh-projects"));
        }
      };
      socket.onmessage = event => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "agent") {
            if (Array.isArray(msg.devices)) {
              setAgentDevices(msg.devices.map(normalizeAgentDevice));
            }
          } else if (msg.type === "device-health") {
            setAgentDevices(current => mergeAgentDeviceHealth(current, msg.device));
          } else if (msg.type === "inventory-patch") {
            setProjects(current => applyLiveInventoryPatch(current, msg));
          } else if (msg.type === "refresh") {
            window.dispatchEvent(new CustomEvent("termag:refresh-projects"));
          }
        } catch {
          // ignore malformed payloads
        }
      };
      socket.onclose = () => {
        if (cancelled || suspended || ws !== socket) {
          return;
        }
        ws = null;
        needsProjectReconcile = true;
        setAgentDevices(current => current.map(device => ({ ...device, connected: false })));
        attempts += 1;
        const ceiling = Math.min(15_000, 500 * 2 ** Math.min(attempts, 5));
        const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
        retryTimer = setTimeout(connect, delay);
      };
      socket.onerror = () => {
        // close handler will fire next and schedule the retry
      };
    };

    const reconnectNow = () => {
      if (document.visibilityState === "visible") {
        connect();
      }
    };
    const onVisibility = () => {
      if (lowData && document.visibilityState === "hidden") {
        suspended = true;
        needsProjectReconcile = true;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        const socket = ws;
        ws = null;
        socket?.close(1000, "page hidden");
        return;
      }
      suspended = false;
      connect();
    };
    connect();
    window.addEventListener("online", reconnectNow);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", onVisibility);
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      ws?.close();
    };
  }, []);

  const reloadProjects = useCallback(
    (nextProjectId?: string, nextTabId?: string) => {
      const state = reloadStateRef.current;
      if (nextProjectId) {
        state.nextProjectId = nextProjectId;
      }
      if (nextTabId) {
        state.nextTabId = nextTabId;
      }
      state.pending = true;
      const complete = new Promise<void>(resolve => state.waiters.push(resolve));
      if (state.running) {
        return complete;
      }

      state.running = true;
      void (async () => {
        try {
          while (state.pending) {
            state.pending = false;
            const res = await fetch("/api/projects");
            if (!res.ok) {
              continue;
            }
            const next = (await res.json()) as Project[];
            const desiredProjectId = state.nextProjectId ?? activeProjectIdRef.current;
            const desiredTabId = state.nextTabId ?? activeTabIdRef.current;
            const rememberRequestedTab = state.nextTabId;
            state.nextProjectId = undefined;
            state.nextTabId = undefined;
            setProjects(next);
            const liveSessionIds = new Set(
              next.flatMap(project =>
                project.tabs.flatMap(tab => (tab.session ? [tab.session.id] : []))
              )
            );
            setLiveTitles(current => {
              const entries = Object.entries(current).filter(([sessionId]) =>
                liveSessionIds.has(sessionId)
              );
              return entries.length === Object.keys(current).length
                ? current
                : Object.fromEntries(entries);
            });
            const project = next.find(item => item.id === desiredProjectId) ?? next[0];
            activeProjectIdRef.current = project?.id || "";
            setActiveProjectId(project?.id || "");
            const tab =
              project?.tabs.find(item => item.id === desiredTabId) ?? preferredProjectTab(project);
            activeTabIdRef.current = tab?.id || "";
            setActiveTabId(tab?.id || "");
            if (project?.id && tab?.id && rememberRequestedTab) {
              tabHistory.remember(project.id, tab.id);
            }
          }
        } finally {
          state.running = false;
          const waiters = state.waiters.splice(0);
          for (const resolve of waiters) {
            resolve();
          }
        }
      })();
      return complete;
    },
    [tabHistory]
  );

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        void reloadProjects();
      }, 150);
    };
    window.addEventListener("termag:refresh-projects", refresh);
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      window.removeEventListener("termag:refresh-projects", refresh);
    };
  }, [reloadProjects]);

  const createProject = useCallback(
    async (input: {
      deviceName: string;
      rootKey: string;
      relativePath: string;
      name?: string;
      runtime: "herdr" | "tmux";
      runtimeSessionId?: string;
    }) => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          deviceName: input.deviceName,
          rootKey: input.rootKey,
          relativePath: input.relativePath,
          runtime: input.runtime,
          runtimeSessionId: input.runtimeSessionId,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        return { ok: false, error: body?.error };
      }
      return { ok: true };
    },
    []
  );

  const createTab = useCallback(async (projectId: string) => {
    const res = await fetch(`/api/projects/${projectId}/tabs`, { method: "POST" });
    if (!res.ok) {
      console.error("[termag] createTab failed", res.status, await res.text().catch(() => ""));
      return;
    }
  }, []);

  const renameProject = useCallback(
    async (projectId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        return;
      }
      setProjects(current =>
        current.map(project => (project.id !== projectId ? project : { ...project, name: trimmed }))
      );
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        console.error(
          "[termag] renameProject failed",
          res.status,
          await res.text().catch(() => "")
        );
        await reloadProjects();
      }
    },
    [reloadProjects, setProjects]
  );

  const renameTab = useCallback(
    async (projectId: string, tabId: string, name: string, scope: "tab" | "pane" = "tab") => {
      const trimmed = name.trim();
      if (!trimmed) {
        return;
      }
      // Optimistic update so the user sees the new name immediately.
      setProjects(current =>
        current.map(project =>
          project.id !== projectId
            ? project
            : {
                ...project,
                tabs: project.tabs.map(tab => (tab.id !== tabId ? tab : { ...tab, name: trimmed })),
              }
        )
      );
      // Clear any live xterm title for this session so the new name actually shows.
      const tab = projects.find(p => p.id === projectId)?.tabs.find(t => t.id === tabId);
      if (tab?.session) {
        const sessionId = tab.session.id;
        setLiveTitles(current => {
          if (!(sessionId in current)) {
            return current;
          }
          const next = { ...current };
          delete next[sessionId];
          return next;
        });
      }
      const res = await fetch(`/api/projects/${projectId}/tabs/${tabId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed, scope }),
      });
      if (!res.ok) {
        console.error("[termag] renameTab failed", res.status, await res.text().catch(() => ""));
        await reloadProjects();
      }
    },
    [projects, reloadProjects, setLiveTitles, setProjects]
  );

  const closeTab = useCallback(
    async (projectId: string, tabId: string, scope: "tab" | "pane" = "tab") => {
      const project = projects.find(item => item.id === projectId);
      if (!project || project.tabs.length <= 1) {
        return;
      }
      const query = scope === "pane" ? "?scope=pane" : "";
      const res = await fetch(`/api/projects/${projectId}/tabs/${tabId}${query}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        console.error("[termag] closeTab failed", res.status, await res.text().catch(() => ""));
        return;
      }
      const nextTabId =
        activeTabIdRef.current === tabId
          ? tabHistory.nextRecent(project, tabId)
          : activeTabIdRef.current;
      await reloadProjects(projectId, nextTabId);
    },
    [projects, reloadProjects, tabHistory]
  );

  // On mobile the sidebar is a drawer overlay — close it after the user
  // picks a session so the terminal isn't covered.
  const closeDrawerOnMobile = useCallback(() => {
    if (!platform.showShortcuts) {
      setSidebarOpen(false);
    }
  }, [platform.showShortcuts, setSidebarOpen]);

  const selectTab = useCallback(
    (projectId: string, tabId: string) => {
      setActiveProjectId(projectId);
      setActiveTabId(tabId);
      tabHistory.remember(projectId, tabId);
      closeDrawerOnMobile();
    },
    [tabHistory, closeDrawerOnMobile, setActiveProjectId, setActiveTabId]
  );

  const cycleTheme = useCallback(async () => {
    const next = theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
    setTheme(next);
    document.documentElement.dataset.termagTheme = next;
    await fetch("/api/user/theme", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: next }),
    });
  }, [setTheme, theme]);

  const toggleCaffeinate = async () => {
    // A double click otherwise fires acquire and release concurrently and the
    // surviving state depends on which response lands last.
    if (!activeProject || powerToggleBusy.current) {
      return;
    }
    powerToggleBusy.current = true;

    try {
      const deviceName = activeProject.rootKey;
      // Machine-wide state may be active because another browser/client owns
      // a lease. Only release the lease owned by this browser; otherwise a
      // click should acquire one so this view is independently protected.
      if (ownsCurrentPowerLease) {
        const state = await updatePowerLease(deviceName, "release");
        sessionStorage.removeItem(`termag-power-active:${deviceName}`);
        setCaffeinateLeaseDevice(null);
        setCaffeinateStatusDevice(deviceName);
        setCaffeinateActive(state.active);
      } else {
        const state = await updatePowerLease(deviceName, "acquire");
        sessionStorage.setItem(`termag-power-active:${deviceName}`, "1");
        setCaffeinateLeaseDevice(deviceName);
        setCaffeinateStatusDevice(deviceName);
        setCaffeinateActive(state.active);
      }
    } catch (error) {
      console.error("Failed to toggle caffeinate:", error);
    } finally {
      powerToggleBusy.current = false;
    }
  };

  useEffect(() => {
    const deviceName = activeProject?.rootKey;
    if (!deviceName || !powerSupported) {
      return;
    }
    const controller = new AbortController();
    const ownsLease = sessionStorage.getItem(`termag-power-active:${deviceName}`) === "1";
    fetch(`/api/devices/${encodeURIComponent(deviceName)}/power`, {
      signal: controller.signal,
    })
      .then(async response => {
        if (!response.ok) {
          throw new Error("Power state unavailable");
        }
        return response.json();
      })
      .then(state => {
        setCaffeinateStatusDevice(deviceName);
        setCaffeinateLeaseDevice(ownsLease ? deviceName : null);
        setCaffeinateActive(Boolean(state?.active ?? state?.isActive));
      })
      .catch(error => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setCaffeinateStatusDevice(deviceName);
        setCaffeinateLeaseDevice(ownsLease ? deviceName : null);
        setCaffeinateActive(false);
      });
    return () => controller.abort();
  }, [activeProject?.rootKey, powerSupported]);

  useEffect(() => {
    const deviceName = activeProject?.rootKey;
    if (!deviceName || !ownsCurrentPowerLease) {
      return;
    }
    let disposed = false;
    const renew = () => {
      if (disposed) {
        return;
      }
      updatePowerLease(deviceName, "renew")
        .then(state => {
          if (disposed) {
            return;
          }
          setCaffeinateStatusDevice(deviceName);
          setCaffeinateActive(state.active);
        })
        .catch(() => {
          if (!disposed) {
            setCaffeinateActive(false);
          }
        });
    };
    const timer = window.setInterval(renew, POWER_RENEW_MS);
    // Coming back to the foreground is the one moment we know timers were
    // unreliable, so re-establish the lease immediately instead of waiting
    // out an interval that may not have fired while hidden.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        renew();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    // Release on unload so closing the tab stops holding the machine awake
    // rather than waiting for the lease to lapse. sendBeacon is the only
    // request guaranteed to survive teardown; keepalive fetch is the fallback
    // for browsers that reject a beacon's content type.
    const onPageHide = () => {
      const body = JSON.stringify({
        action: "release",
        leaseId: powerLeaseId(deviceName),
        mode: "terminals-awake",
        durationMs: POWER_LEASE_MS,
      });
      const url = `/api/devices/${encodeURIComponent(deviceName)}/power`;
      const payload = new Blob([body], { type: "application/json" });
      if (!navigator.sendBeacon?.(url, payload)) {
        void fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [activeProject?.rootKey, ownsCurrentPowerLease]);

  // Keep the keyboard ref pointed at the latest values without re-binding.
  useEffect(() => {
    handlersRef.current = {
      activeProject,
      activeTab,
      projects,
      createTab,
      closeTab,
      cycleTheme,
      selectTab,
    };
  }, [activeProject, activeTab, projects, createTab, closeTab, cycleTheme, selectTab]);

  // Flatten projects → tab snapshots so the notifications hook can detect
  // status transitions. Memoize so a no-op render doesn't reset the
  // hook's transition memory (which is keyed by tabId, so resets would
  // cause spurious double-notifications).
  const tabSnapshots = useMemo(
    () =>
      projects.flatMap(project =>
        project.tabs.map(tab => ({
          projectName: project.runtimeSpaceName || project.name,
          tabName: tab.name,
          tabId: tab.id,
          status: tab.status as string,
        }))
      ),
    [projects]
  );
  const notify = useSessionNotifications({ tabSnapshots });

  // Tab swipe handler: two-finger horizontal swipe inside any terminal
  // pane dispatches a `termag:tab-swipe` CustomEvent with `direction:
  // 'next' | 'prev'`. We resolve that against the active project's tab
  // order and jump there. Designed for iPad — keyboard users have ⌃1-9.
  useEffect(() => {
    function onSwipe(event: Event) {
      const detail = (event as CustomEvent<{ direction: "next" | "prev" }>).detail;
      if (!detail) {
        return;
      }
      const project = activeProject;
      const tab = activeTab;
      if (!project || !tab) {
        return;
      }
      const idx = project.tabs.findIndex(t => t.id === tab.id);
      if (idx < 0) {
        return;
      }
      const nextIdx =
        detail.direction === "next"
          ? Math.min(project.tabs.length - 1, idx + 1)
          : Math.max(0, idx - 1);
      const nextTab = project.tabs[nextIdx];
      if (nextTab && nextTab.id !== tab.id) {
        selectTab(project.id, nextTab.id);
      }
    }
    window.addEventListener("termag:tab-swipe", onSwipe as EventListener);
    return () => window.removeEventListener("termag:tab-swipe", onSwipe as EventListener);
  }, [activeProject, activeTab, selectTab]);

  const devices = useMemo(() => {
    const next = new Set(tokenDevices);
    for (const project of projects) {
      next.add(project.rootKey);
    }
    return [...next];
  }, [projects, tokenDevices]);

  const groups = useMemo(() => {
    const result = new Map<string, Project[]>();
    for (const device of devices) {
      result.set(device, []);
    }
    for (const project of projects) {
      const key = project.rootKey;
      result.set(key, [...(result.get(key) ?? []), project]);
    }
    return [...result.entries()].map(([device, deviceProjects]) => [
      device,
      [...deviceProjects].sort((left, right) => {
        const runtimeOrder = (value?: string) => (value === "herdr" ? 0 : value === "tmux" ? 1 : 2);
        const hierarchy =
          runtimeOrder(left.runtime) - runtimeOrder(right.runtime) ||
          (left.runtimeSessionName || "").localeCompare(right.runtimeSessionName || "");
        if (hierarchy) {
          return hierarchy;
        }
        return (
          (left.runtimeOrdinal ?? 0) - (right.runtimeOrdinal ?? 0) ||
          left.name.localeCompare(right.name)
        );
      }),
    ]) as Array<[string, Project[]]>;
  }, [devices, projects]);

  const openNewProject = useCallback(
    (device?: string) => {
      setCreateMenuOpen(false);
      setNewProjectDevice(device ?? null);
      setNewProjectOpen(true);
    },
    [setCreateMenuOpen, setNewProjectDevice, setNewProjectOpen]
  );

  const onCommandSession = useCallback(
    (projectId: string, tabId: string) => {
      selectTab(projectId, tabId);
    },
    [selectTab]
  );

  const onCommandNewTab = useCallback(() => {
    if (activeProject) {
      createTab(activeProject.id);
    }
  }, [activeProject, createTab]);

  const onCommandKill = useCallback(() => {
    if (activeProject && activeTab) {
      void closeTab(
        activeProject.id,
        activeTab.id,
        activeProject.runtime === "herdr" ? "pane" : "tab"
      );
    }
  }, [activeProject, activeTab, closeTab]);

  const onGitOperation = useCallback(
    async (operation: GitOperation) => {
      if (!activeProject || gitBusy) {
        return;
      }
      let input: Record<string, unknown> = {};
      if (operation === "git.commit") {
        const message = window.prompt("Commit message");
        if (!message?.trim()) {
          return;
        }
        input = { message: message.trim() };
      } else if (operation === "git.branch") {
        const branch = window.prompt("Existing branch to switch to");
        if (!branch?.trim()) {
          return;
        }
        input = { branch: branch.trim() };
      } else if (operation === "git.stage") {
        const value = window.prompt("Relative paths to stage (comma-separated)", ".");
        if (!value?.trim()) {
          return;
        }
        const paths = value
          .split(",")
          .map(path => path.trim())
          .filter(Boolean);
        if (paths.length === 0) {
          return;
        }
        input = { paths };
      }

      setGitBusy(true);
      try {
        const response = await fetch("/api/git", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: activeProject.id, operation, ...input }),
        });
        const result = (await response.json()) as GitOperationResult & { error?: string };
        if (!response.ok) {
          throw new Error(result.error || "Git operation failed");
        }
        setGitResult({
          title: operation.replace("git.", "Git "),
          ok: result.ok,
          output:
            result.output ||
            (result.ok ? "Operation completed successfully." : `Git exited ${result.exitCode}.`),
        });
      } catch (error) {
        setGitResult({
          title: operation.replace("git.", "Git "),
          ok: false,
          output: error instanceof Error ? error.message : "Git operation failed",
        });
      } finally {
        setGitBusy(false);
      }
    },
    [activeProject, gitBusy, setGitBusy, setGitResult]
  );

  const openDevices = useCallback(
    (deviceName?: string) => {
      setFocusedDevice(deviceName ?? null);
      setDevicesOpen(true);
    },
    [setDevicesOpen, setFocusedDevice]
  );

  return (
    <PlatformProvider platform={platform}>
      <main className="flex h-[var(--termag-viewport-height)] bg-bg text-text">
        {/* Sidebar: drawer-style on mobile, persistent on md+ */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/40 md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden
          />
        )}
        <aside
          className={cn(
            "flex shrink-0 flex-col bg-panel transition-[width,transform] duration-150",
            // Mobile: full overlay drawer
            "fixed inset-y-0 left-0 z-40 w-[min(86vw,320px)] md:static md:w-[260px] md:translate-x-0",
            sidebarOpen ? "translate-x-0" : "-translate-x-full md:w-0 md:overflow-hidden"
          )}
        >
          <div className="flex h-14 items-center justify-between px-3">
            <span className="flex items-baseline gap-1.5 px-1">
              <span className="text-sm font-semibold tracking-tight">Terminalz</span>
              <span className="text-sm font-normal text-muted">next</span>
            </span>
            <div className="relative flex items-center gap-0.5">
              <button
                type="button"
                className="grid h-11 w-11 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text md:h-7 md:w-7"
                onPointerDown={event => event.stopPropagation()}
                onClick={() => setCreateMenuOpen(value => !value)}
                title="New machine or terminal"
                aria-label="New machine or terminal"
              >
                <Plus className="h-4 w-4" />
              </button>
              {createMenuOpen && (
                <div
                  className="absolute right-8 top-8 z-50 w-52 rounded-md border border-line bg-panel p-1 shadow-xl"
                  onPointerDown={event => event.stopPropagation()}
                >
                  <button
                    type="button"
                    className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-muted hover:bg-panel2 hover:text-text"
                    onClick={() => openNewProject()}
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                    <span className="flex-1 whitespace-nowrap">New session</span>
                    <Shortcut keys={["mod", "shift", "P"]} />
                  </button>
                  <div className="my-1 h-px bg-line" />
                  <button
                    type="button"
                    className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-muted hover:bg-panel2 hover:text-text"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      setBootstrapOpen(true);
                    }}
                  >
                    <Zap className="h-3.5 w-3.5" />
                    <span className="whitespace-nowrap">Bootstrap device</span>
                  </button>
                  <button
                    type="button"
                    className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-muted hover:bg-panel2 hover:text-text"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      setNewDeviceOpen(true);
                    }}
                  >
                    <Laptop className="h-3.5 w-3.5" />
                    <span className="whitespace-nowrap">New device (manual)</span>
                  </button>
                </div>
              )}
              <button
                type="button"
                className="grid h-11 w-11 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text md:h-7 md:w-7"
                onClick={() => setSidebarOpen(false)}
                title={`Collapse sidebar${shortcutSuffix(["mod", "\\"], platform)}`}
                aria-label="Collapse sidebar"
              >
                <ChevronsLeft className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <div className="space-y-3">
              {groups.map(([group, groupProjects]) => (
                <section key={group}>
                  <div className="group/device mb-1 flex h-6 items-center justify-between rounded px-2 text-muted hover:bg-panel2">
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-[10px] font-medium uppercase tracking-wider hover:text-text"
                      title={`Open ${group} device`}
                      onClick={() => openDevices(group)}
                    >
                      {group}
                    </button>
                    <button
                      type="button"
                      className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted opacity-0 hover:bg-bg hover:text-text focus:opacity-100 group-hover/device:opacity-100"
                      title={`New session on ${group}`}
                      aria-label={`New session on ${group}`}
                      onClick={() => openNewProject(group)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="space-y-1">
                    {groupProjects.length === 0 && (
                      <div className="px-2 py-1 text-xs text-muted/70">No projects yet</div>
                    )}
                    {groupProjects.map((project, projectIndex) => {
                      const previousProject = groupProjects[projectIndex - 1];
                      const runtimeSessionChanged =
                        previousProject?.runtime !== project.runtime ||
                        previousProject?.runtimeSessionId !== project.runtimeSessionId;
                      const isActiveProject = project.id === activeProject?.id;
                      const tabGroups = sidebarTabGroups(project);
                      return (
                        <Fragment key={project.id}>
                          {runtimeSessionChanged && (
                            <div className="mt-1 flex h-5 items-center gap-1.5 truncate px-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
                              <Terminal className="h-3 w-3 shrink-0" />
                              <span className="truncate">
                                {project.runtime === "herdr" ? "Herdr" : project.runtime || "tmux"}
                                <span className="px-1 opacity-50">·</span>
                                {project.runtimeSessionName ||
                                  project.runtimeSessionId ||
                                  "default"}
                              </span>
                            </div>
                          )}
                          <div
                            style={{ contentVisibility: "auto", containIntrinsicSize: "auto 80px" }}
                            className="relative"
                          >
                            <div
                              className={cn(
                                "group/project flex h-8 w-full items-center rounded-md hover:bg-panel2",
                                isActiveProject && "bg-panel2 shadow-sm"
                              )}
                            >
                              <div
                                role="button"
                                tabIndex={0}
                                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-l-md px-2 text-left text-sm"
                                title={`${project.rootKey}/${project.relativePath}`}
                                onClick={() => {
                                  const tabId = preferredProjectTab(project)?.id;
                                  if (tabId) {
                                    selectTab(project.id, tabId);
                                  } else {
                                    setActiveProjectId(project.id);
                                    closeDrawerOnMobile();
                                  }
                                }}
                                onKeyDown={event => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    const tabId = preferredProjectTab(project)?.id;
                                    if (tabId) {
                                      selectTab(project.id, tabId);
                                    } else {
                                      setActiveProjectId(project.id);
                                      closeDrawerOnMobile();
                                    }
                                  }
                                }}
                              >
                                {project.runtime === "herdr" ? (
                                  <HerdrStatusIcon
                                    status={
                                      connectedDeviceNames.has(project.rootKey)
                                        ? project.status
                                        : "offline"
                                    }
                                    variant={herdRIndicatorVariant(project)}
                                    className="h-3 w-3"
                                  />
                                ) : (
                                  <span
                                    className={cn(
                                      "h-2 w-2 shrink-0 rounded-full",
                                      statusDot(
                                        connectedDeviceNames.has(project.rootKey)
                                          ? project.status
                                          : "offline"
                                      )
                                    )}
                                  />
                                )}
                                <TabLabel
                                  name={project.runtimeSpaceName || project.name}
                                  className="min-w-0 flex-1 truncate"
                                  onRename={next => renameProject(project.id, next)}
                                />
                              </div>
                              <button
                                type="button"
                                className="mr-1 grid h-10 w-10 shrink-0 place-items-center rounded text-muted opacity-100 hover:bg-bg hover:text-text md:h-6 md:w-6 md:opacity-0 md:focus:opacity-100 md:group-hover/project:opacity-100"
                                onPointerDown={event => event.stopPropagation()}
                                onClick={event => {
                                  event.stopPropagation();
                                  setProjectMenuId(current =>
                                    current === project.id ? null : project.id
                                  );
                                }}
                                title="Project actions"
                                aria-label={`${project.runtimeSpaceName || project.name} actions`}
                              >
                                <Plus className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            {projectMenuId === project.id && (
                              <div
                                className="absolute right-1 top-8 z-30 w-56 rounded-md border border-line bg-panel p-1 shadow-xl"
                                onPointerDown={event => event.stopPropagation()}
                                onClick={event => event.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-muted hover:bg-panel2 hover:text-text"
                                  onClick={() => {
                                    setProjectMenuId(null);
                                    createTab(project.id);
                                  }}
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                  <span className="flex-1">New tab</span>
                                  <Shortcut keys={["mod", "enter"]} />
                                </button>
                              </div>
                            )}
                            {project.tabs.length > 0 && (
                              <div className="mt-0.5 space-y-0.5 pl-4">
                                {tabGroups.map(tabGroup => {
                                  const hasMultiplePanes = tabGroup.tabs.length > 1;
                                  const representative =
                                    tabGroup.tabs.find(tab => tab.focused) ?? tabGroup.tabs[0];
                                  const groupIsActive =
                                    isActiveProject &&
                                    tabGroup.tabs.some(tab => tab.id === activeTab?.id);
                                  return (
                                    <Fragment key={tabGroup.id}>
                                      {hasMultiplePanes && (
                                        <div
                                          role="button"
                                          tabIndex={0}
                                          className={cn(
                                            "group/native-tab flex h-6 cursor-pointer items-center gap-1.5 rounded px-2 text-[10px] font-medium text-muted hover:bg-panel2 hover:text-text",
                                            groupIsActive && "text-text"
                                          )}
                                          onClick={() => selectTab(project.id, representative.id)}
                                          onKeyDown={event => {
                                            if (event.key === "Enter" || event.key === " ") {
                                              event.preventDefault();
                                              selectTab(project.id, representative.id);
                                            }
                                          }}
                                        >
                                          <span className="font-mono opacity-70">↳</span>
                                          <span className="min-w-0 flex-1 truncate">
                                            {tabGroup.name}
                                          </span>
                                          <span className="shrink-0 tabular-nums opacity-60">
                                            {tabGroup.tabs.length}
                                          </span>
                                          {tabGroups.length > 1 && (
                                            <button
                                              type="button"
                                              className="grid h-4 w-4 shrink-0 place-items-center rounded opacity-0 hover:bg-bg group-hover/native-tab:opacity-100 focus:opacity-100"
                                              title="Close Herdr tab"
                                              onClick={event => {
                                                event.stopPropagation();
                                                closeTab(project.id, representative.id, "tab");
                                              }}
                                            >
                                              ×
                                            </button>
                                          )}
                                        </div>
                                      )}
                                      {tabGroup.tabs.map(tab => {
                                        const isActiveTab =
                                          isActiveProject && tab.id === activeTab?.id;
                                        return (
                                          <div
                                            key={tab.id}
                                            role="button"
                                            tabIndex={0}
                                            className={cn(
                                              "group/tab flex h-10 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-panel2 md:h-7",
                                              hasMultiplePanes && "ml-3 w-[calc(100%-0.75rem)]",
                                              isActiveTab && "bg-panel2 shadow-sm"
                                            )}
                                            onClick={() => selectTab(project.id, tab.id)}
                                            onKeyDown={event => {
                                              if (event.key === "Enter" || event.key === " ") {
                                                event.preventDefault();
                                                selectTab(project.id, tab.id);
                                              }
                                            }}
                                          >
                                            {project.runtime === "herdr" ? (
                                              <HerdrStatusIcon
                                                status={
                                                  connectedDeviceNames.has(project.rootKey)
                                                    ? hasMultiplePanes
                                                      ? tab.status
                                                      : aggregateHerdrStatus(tabGroup.tabs)
                                                    : "offline"
                                                }
                                                variant={herdRIndicatorVariant(project)}
                                                className="h-3 w-3 text-xs"
                                              />
                                            ) : (
                                              <span
                                                className={cn(
                                                  "h-1.5 w-1.5 shrink-0 rounded-full",
                                                  statusDot(
                                                    connectedDeviceNames.has(project.rootKey)
                                                      ? tab.status
                                                      : "offline"
                                                  )
                                                )}
                                              />
                                            )}
                                            <TabLabel
                                              name={
                                                hasMultiplePanes
                                                  ? tab.runtimePaneName || tab.name
                                                  : tabGroup.name
                                              }
                                              liveTitle={
                                                tab.session ? liveTitles[tab.session.id] : null
                                              }
                                              className="min-w-0 flex-1 truncate"
                                              onRename={next =>
                                                renameTab(
                                                  project.id,
                                                  tab.id,
                                                  next,
                                                  project.runtime === "herdr" && hasMultiplePanes
                                                    ? "pane"
                                                    : "tab"
                                                )
                                              }
                                            />
                                            {/* Per-tab notification toggle. First
                                      click on any tab requests Notification
                                      permission (cached after that). The
                                      hook then watches for working/waiting
                                      → idle/error transitions and fires a
                                      browser notification for subscribed
                                      tabs only. */}
                                            {notify.permission !== "unsupported" && (
                                              <button
                                                type="button"
                                                className={cn(
                                                  "grid h-9 w-9 shrink-0 place-items-center rounded text-muted hover:bg-bg hover:text-text md:h-4 md:w-4",
                                                  notify.subscribed.has(tab.id)
                                                    ? "opacity-100 text-accent"
                                                    : "opacity-100 md:opacity-0 md:group-hover/tab:opacity-100"
                                                )}
                                                title={
                                                  notify.subscribed.has(tab.id)
                                                    ? "Stop notifying when this session goes idle/errors"
                                                    : "Notify me when this session goes idle or errors"
                                                }
                                                onClick={async event => {
                                                  event.stopPropagation();
                                                  if (notify.permission === "default") {
                                                    await notify.requestPermission();
                                                  }
                                                  notify.toggle(tab.id);
                                                }}
                                              >
                                                {notify.subscribed.has(tab.id) ? (
                                                  <Bell className="h-3 w-3" />
                                                ) : (
                                                  <BellOff className="h-3 w-3" />
                                                )}
                                              </button>
                                            )}
                                            {project.tabs.length > 1 &&
                                              (!hasMultiplePanes || tabGroup.tabs.length > 1) && (
                                                <button
                                                  type="button"
                                                  className="grid h-9 w-9 shrink-0 place-items-center rounded text-muted opacity-100 hover:bg-bg hover:text-text md:h-4 md:w-4 md:opacity-0 md:group-hover/tab:opacity-100"
                                                  title="Close local tab"
                                                  onClick={event => {
                                                    event.stopPropagation();
                                                    closeTab(
                                                      project.id,
                                                      tab.id,
                                                      project.runtime === "herdr" &&
                                                        hasMultiplePanes
                                                        ? "pane"
                                                        : "tab"
                                                    );
                                                  }}
                                                >
                                                  ×
                                                </button>
                                              )}
                                          </div>
                                        );
                                      })}
                                    </Fragment>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </Fragment>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>

          <div className="space-y-0.5 px-2 pb-3 pt-2">
            <button
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted hover:bg-panel2 hover:text-text"
              onClick={() => setPaletteOpen(true)}
            >
              <CommandIcon className="h-3.5 w-3.5" />
              <span className="flex-1 text-left">Command</span>
              <Shortcut keys={["mod", "K"]} />
            </button>
            <button
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted hover:bg-panel2 hover:text-text"
              onClick={() => openDevices()}
            >
              <Laptop className="h-3.5 w-3.5" />
              <span className="flex-1 text-left">Devices</span>
              <Shortcut keys={["mod", ";"]} />
            </button>
            <button
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted hover:bg-panel2 hover:text-text"
              onClick={() => setHelpOpen(true)}
              title="Keyboard shortcuts"
            >
              <span className="grid h-3.5 w-3.5 place-items-center font-mono text-[11px]">?</span>
              <span className="flex-1 text-left">Shortcuts</span>
              <Shortcut keys={["?"]} />
            </button>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {/* Config-misconfiguration banner sits above the chrome so users
            see it on every dashboard view, not just the Devices dialog. */}
          <HealthBanner />
          <header className="flex h-14 shrink-0 items-center justify-between bg-bg px-3 md:px-4">
            <div className="flex min-w-0 items-center gap-2">
              {/* Open the drawer on mobile, expand the desktop sidebar otherwise */}
              {!sidebarOpen && (
                <button
                  type="button"
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text md:h-8 md:w-8"
                  onClick={() => setSidebarOpen(true)}
                  title={`Open sidebar${shortcutSuffix(["mod", "\\"], platform)}`}
                  aria-label="Open sidebar"
                >
                  <Menu className="h-4 w-4 md:hidden" />
                  <ChevronsRight className="hidden h-4 w-4 md:block" />
                </button>
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {activeProject?.runtime === "herdr" ? (
                    <HerdrStatusIcon
                      status={activeDeviceConnected ? activeProject.status : "offline"}
                      variant={herdRIndicatorVariant(activeProject)}
                    />
                  ) : (
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        statusDot(activeDeviceConnected ? activeProject?.status : "offline")
                      )}
                    />
                  )}
                  <h1 className="truncate text-sm font-semibold">
                    {activeProject?.runtimeSpaceName || activeProject?.name || "No project"}
                  </h1>
                </div>
                <div className="truncate font-mono text-[11px] text-muted">
                  {activeProject
                    ? `${activeProject.rootKey} · ${activeProject.relativePath}`
                    : "Create a session to start"}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <IconButton
                title={`Cycle theme${shortcutSuffix(["mod", "."], platform)}`}
                onClick={cycleTheme}
              >
                {theme === "light" ? (
                  <Sun className="h-4 w-4" />
                ) : theme === "dark" ? (
                  <Moon className="h-4 w-4" />
                ) : (
                  <Monitor className="h-4 w-4" />
                )}
              </IconButton>
              {powerSupported && (
                <IconButton
                  title={
                    ownsCurrentPowerLease
                      ? "Stop keeping terminals awake"
                      : caffeinateActive
                        ? "Terminals are kept awake by another lease; add this browser"
                        : "Keep terminals awake (display may sleep and lock)"
                  }
                  onClick={toggleCaffeinate}
                >
                  <Coffee className={`h-4 w-4 ${caffeinateActive ? "text-yellow-500" : ""}`} />
                </IconButton>
              )}
            </div>
          </header>

          <div className="flex min-h-0 flex-1 gap-3 bg-bg p-2 md:p-3">
            {activeTab?.session && activeProject ? (
              // Tabs become the terminal's top edge. Their order and grouping are
              // taken directly from the local runtime inventory.
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-bg">
                <div className="flex h-12 items-end gap-px overflow-x-auto bg-panel pl-1.5 pr-1 md:h-9">
                  {topTabs.map(tab => {
                    const paneGroup = tab.runtimeTabId
                      ? activeProject.tabs.filter(item => item.runtimeTabId === tab.runtimeTabId)
                      : [tab];
                    const preferredPane = paneGroup.find(item => item.focused) ?? paneGroup[0];
                    const isActive = tab.runtimeTabId
                      ? tab.runtimeTabId === activeTab.runtimeTabId
                      : tab.id === activeTab.id;
                    const displayName = tab.runtimeTabName || tab.name;
                    return (
                      <div
                        key={tab.id}
                        role="button"
                        tabIndex={0}
                        className={cn(
                          "group/tab flex h-11 cursor-pointer items-center gap-2 rounded-t-md px-3 text-xs md:h-7",
                          isActive ? "bg-bg text-text" : "text-muted hover:text-text"
                        )}
                        onClick={() => {
                          selectTab(activeProject.id, preferredPane.id);
                        }}
                        onKeyDown={event => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            selectTab(activeProject.id, preferredPane.id);
                          }
                        }}
                      >
                        {activeProject.runtime === "herdr" ? (
                          <HerdrStatusIcon
                            status={
                              activeDeviceConnected ? aggregateHerdrStatus(paneGroup) : "offline"
                            }
                            variant={herdRIndicatorVariant(activeProject)}
                            className="h-3 w-3 text-xs"
                          />
                        ) : (
                          <span
                            className={cn(
                              "h-1.5 w-1.5 shrink-0 rounded-full",
                              statusDot(activeDeviceConnected ? tab.status : "offline")
                            )}
                          />
                        )}
                        <TabLabel
                          name={displayName}
                          liveTitle={
                            activeProject.runtime === "herdr" || !tab.session
                              ? null
                              : liveTitles[tab.session.id]
                          }
                          className="max-w-[180px] truncate"
                          onRename={next => renameTab(activeProject.id, tab.id, next, "tab")}
                        />
                        {topTabs.length > 1 && (
                          <button
                            type="button"
                            className="grid h-11 w-11 shrink-0 place-items-center rounded text-muted opacity-100 hover:bg-panel2 hover:text-text md:h-4 md:w-4 md:opacity-0 md:group-hover/tab:opacity-100"
                            title="Close local tab"
                            onClick={event => {
                              event.stopPropagation();
                              closeTab(activeProject.id, tab.id, "tab");
                            }}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className="ml-1 flex h-11 items-center gap-1.5 rounded-t-md px-3 text-[11px] text-muted hover:text-text md:h-7 md:px-2"
                    title={`New agent${shortcutSuffix(["mod", "enter"], platform)}`}
                    onClick={() => createTab(activeProject.id)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <Shortcut keys={["mod", "enter"]} />
                  </button>
                </div>
                <div className="flex min-h-0 flex-1">
                  {activeProject.runtime === "herdr" ? (
                    <MirroredTerminalLayout
                      tabs={activeRuntimePanes}
                      connected={activeDeviceConnected}
                      liveTitles={liveTitles}
                      onTitleChange={handleSessionTitle}
                    />
                  ) : (
                    <TerminalPane
                      key={activeTab.session.id}
                      active
                      sessionId={activeTab.session.id}
                      title={liveTitles[activeTab.session.id] || activeTab.name}
                      status={activeDeviceConnected ? activeTab.session.status : "sleeping"}
                      onTitleChange={handleSessionTitle}
                      hideHeader
                    />
                  )}
                </div>
              </section>
            ) : (
              <div className="grid flex-1 place-items-center rounded-lg border border-dashed border-line bg-panel px-4">
                <div className="w-full max-w-lg text-sm">
                  <div className="mb-2 font-medium text-text">No mirrored terminals yet.</div>
                  <div className="mb-3 text-muted">
                    Bootstrap the lightweight agent. Running Herdr and tmux sessions appear here
                    automatically.
                  </div>
                  <div>
                    <button
                      type="button"
                      className="inline-flex min-h-11 items-center rounded-md bg-accent px-3 text-xs font-medium text-black hover:brightness-110"
                      onClick={() => setBootstrapOpen(true)}
                    >
                      Bootstrap a device
                    </button>
                  </div>
                  <a
                    href="https://github.com/yeutterg/terminalz#quick-setup"
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-1 text-xs text-accent hover:underline"
                  >
                    Setup instructions
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
            )}
          </div>
        </section>

        {paletteOpen && (
          <Suspense fallback={null}>
            <CommandPalette
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              projects={projects}
              onSession={onCommandSession}
              onNewTab={onCommandNewTab}
              onKill={onCommandKill}
              onTheme={cycleTheme}
              onDevices={() => openDevices()}
              onAddDevice={() => setNewDeviceOpen(true)}
              onGitOperation={
                gitSupported && activeProject && !gitBusy ? onGitOperation : undefined
              }
              authMode={authMode}
            />
          </Suspense>
        )}
        {gitResult && (
          <div className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="git-result-title"
              className="flex max-h-[min(80dvh,640px)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
            >
              <div className="flex min-h-14 items-center justify-between gap-3 border-b border-border px-4">
                <div>
                  <h2 id="git-result-title" className="font-medium capitalize">
                    {gitResult.title}
                  </h2>
                  <p className={gitResult.ok ? "text-xs text-green-400" : "text-xs text-red-400"}>
                    {gitResult.ok ? "Completed" : "Git reported an error"}
                  </p>
                </div>
                <button
                  type="button"
                  className="grid h-11 w-11 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text"
                  onClick={() => setGitResult(null)}
                  aria-label="Close git result"
                >
                  ×
                </button>
              </div>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-text">
                {gitResult.output}
              </pre>
            </div>
          </div>
        )}
        {devicesOpen && (
          <Suspense fallback={null}>
            <DevicesDialog
              open={devicesOpen}
              onOpenChange={open => {
                setDevicesOpen(open);
                if (!open) {
                  setFocusedDevice(null);
                }
              }}
              user={user}
              devices={agentDevices}
              knownDeviceNames={devices}
              focusedDevice={focusedDevice}
              onTokenDeleted={name => {
                setTokenDevices(current => current.filter(device => device !== name));
              }}
              onAddDevice={() => setNewDeviceOpen(true)}
              onBootstrap={() => setBootstrapOpen(true)}
            />
          </Suspense>
        )}
        {newDeviceOpen && (
          <Suspense fallback={null}>
            <NewDeviceDialog
              open={newDeviceOpen}
              onOpenChange={setNewDeviceOpen}
              onCreated={token => {
                if (token.name) {
                  setTokenDevices(current => [...new Set([...current, token.name])]);
                }
              }}
            />
          </Suspense>
        )}
        {bootstrapOpen && (
          <Suspense fallback={null}>
            <BootstrapDeviceDialog open={bootstrapOpen} onOpenChange={setBootstrapOpen} />
          </Suspense>
        )}
        {newProjectOpen && (
          <Suspense fallback={null}>
            <NewProjectDialog
              open={newProjectOpen}
              onOpenChange={setNewProjectOpen}
              onCreate={async input => {
                const result = await createProject(input);
                if (result.ok && !platform.showShortcuts) {
                  setSidebarOpen(false);
                }
                return result;
              }}
              agentDevices={agentDevices}
              knownDeviceNames={devices}
              selectedDevice={newProjectDevice}
            />
          </Suspense>
        )}
        {helpOpen && (
          <Suspense fallback={null}>
            <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
          </Suspense>
        )}
      </main>
    </PlatformProvider>
  );
}

function IconButton({
  children,
  title,
  onClick,
  className,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      className={cn(
        "grid h-11 w-11 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text md:h-8 md:w-8",
        className
      )}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
