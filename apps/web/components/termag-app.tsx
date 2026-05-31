"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  BellOff,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Command as CommandIcon,
  Copy,
  ExternalLink,
  FolderPlus,
  Laptop,
  Menu,
  Monitor,
  Moon,
  Network,
  Plus,
  Search,
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
import type { AgentDeviceStatus, Project, Tab, TmuxDeviceSession, TmuxWindow } from "./types";
import type { Platform } from "@/lib/platform";
import { cn, statusDot } from "@/lib/utils";
import { startCaffeinateOnDevice, stopCaffeinateOnDevice } from "@/lib/broker";

// Heavy dialogs are split into their own chunks and loaded only when opened.
const CommandPalette = lazy(() =>
  import("./command-palette").then(m => ({ default: m.CommandPalette }))
);
const SearchPalette = lazy(() =>
  import("./search-palette").then(m => ({ default: m.SearchPalette }))
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
const AttachTmuxDialog = lazy(() =>
  import("./attach-tmux-dialog").then(m => ({ default: m.AttachTmuxDialog }))
);
const NewSshHostDialog = lazy(() =>
  import("./new-ssh-host-dialog").then(m => ({ default: m.NewSshHostDialog }))
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

function normalizeAgentDevice(input: unknown): AgentDeviceStatus {
  if (typeof input === "string") {
    return { name: input, connected: true };
  }
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const rawTmux =
    raw.tmux && typeof raw.tmux === "object" ? (raw.tmux as Record<string, unknown>) : null;
  return {
    name: String(raw.name || "Local device"),
    connected: raw.connected !== false,
    version: typeof raw.version === "string" ? raw.version : null,
    fake: Boolean(raw.fake),
    streamCount: Number.isFinite(Number(raw.streamCount)) ? Number(raw.streamCount) : undefined,
    uptimeSec: Number.isFinite(Number(raw.uptimeSec)) ? Number(raw.uptimeSec) : undefined,
    memMb: Number.isFinite(Number(raw.memMb)) ? Number(raw.memMb) : undefined,
    lastSeenAt: typeof raw.lastSeenAt === "string" ? raw.lastSeenAt : null,
    roots:
      raw.roots && typeof raw.roots === "object"
        ? (raw.roots as Record<string, string>)
        : undefined,
    tmuxSessions: normalizeTmuxSessions(raw.tmuxSessions ?? rawTmux?.sessions),
  };
}

function normalizeTmuxSessions(input: unknown): TmuxDeviceSession[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  return input
    .map((session): TmuxDeviceSession => {
      const raw = (session && typeof session === "object" ? session : {}) as Record<
        string,
        unknown
      >;
      return {
        name: String(raw.name || ""),
        path: typeof raw.path === "string" ? raw.path : undefined,
        windowCount: Number.isFinite(Number(raw.windowCount)) ? Number(raw.windowCount) : undefined,
        windows: normalizeTmuxWindows(raw.windows),
      };
    })
    .filter(session => session.name);
}

function normalizeTmuxWindows(input: unknown): TmuxWindow[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((window): TmuxWindow => {
      const raw = (window && typeof window === "object" ? window : {}) as Record<string, unknown>;
      return {
        index: Number.isFinite(Number(raw.index)) ? Number(raw.index) : 0,
        id: String(raw.id || ""),
        name: String(raw.name || ""),
        target: String(raw.target || ""),
        path: typeof raw.path === "string" ? raw.path : undefined,
      };
    })
    .filter(window => window.target || window.id || window.name);
}

function shellArg(value: string) {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

function connectCommand(projectName: string, wholeSession = false) {
  return `termag connect -p ${shellArg(projectName)}${wholeSession ? " --session" : ""}`;
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
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [tokenDevices, setTokenDevices] = useState<string[]>([]);
  const [activeProjectId, setActiveProjectId] = useState(initialProjects[0]?.id ?? "");
  const [activeTabId, setActiveTabId] = useState(initialProjects[0]?.tabs[0]?.id ?? "");
  // Open by default on desktop, closed on mobile (the drawer pattern). The
  // initial decision is made server-side via platform.showShortcuts (false on
  // phones) so there's no flash of an open drawer.
  const [sidebarOpen, setSidebarOpen] = useState(platform.showShortcuts);
  const [showCtrl, setShowCtrl] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [focusedDevice, setFocusedDevice] = useState<string | null>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [newDeviceOpen, setNewDeviceOpen] = useState(false);
  const [newSshHostOpen, setNewSshHostOpen] = useState(false);
  const [bootstrapOpen, setBootstrapOpen] = useState(false);
  // Counter incremented after a successful host add. DevicesDialog
  // re-runs its parallel fetch whenever this changes, so background
  // additions show up immediately if Devices happens to be open.
  const [hostsRefreshTrigger, setHostsRefreshTrigger] = useState(0);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [attachTmuxOpen, setAttachTmuxOpen] = useState(false);
  const [newProjectDevice, setNewProjectDevice] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [agentDevices, setAgentDevices] = useState<AgentDeviceStatus[]>([]);
  const [theme, setTheme] = useState(user.theme);
  const [caffeinateActive, setCaffeinateActive] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState("");
  // Live xterm titles keyed by sessionId. Tools inside the terminal can set
  // a title via OSC 0/2; we mirror it onto the corresponding tab label.
  const [liveTitles, setLiveTitles] = useState<Record<string, string>>({});
  // Mobile-only: viewing the ctrl shell instead of the active agent tab.
  // On desktop the ctrl pane is always visible side-by-side, so this state
  // doesn't change what gets rendered there.
  const [mobileViewCtrl, setMobileViewCtrl] = useState(false);
  // Drag-and-drop reorder state for the sidebar project list.
  const [dragProjectId, setDragProjectId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | null>(null);

  const handleSessionTitle = useCallback((sessionId: string, title: string) => {
    setLiveTitles(current =>
      current[sessionId] === title ? current : { ...current, [sessionId]: title }
    );
  }, []);
  const initialTab = initialProjects[0]?.tabs[0];
  const tabHistory = useTabHistory(
    initialProjects[0] && initialTab ? { [initialProjects[0].id]: [initialTab.id] } : {}
  );
  const activeProjectIdRef = useRef(activeProjectId);
  const activeTabIdRef = useRef(activeTabId);

  const activeProject = useMemo(
    () => projects.find(project => project.id === activeProjectId) ?? projects[0],
    [projects, activeProjectId]
  );
  const activeTab = useMemo(
    () => activeProject?.tabs.find(tab => tab.id === activeTabId) ?? activeProject?.tabs[0],
    [activeProject, activeTabId]
  );
  const ctrlSession = useMemo(
    () => activeProject?.sessions.find(session => session.kind === "ctrl"),
    [activeProject]
  );
  const connectedDeviceNames = useMemo(
    () => new Set(agentDevices.filter(device => device.connected).map(device => device.name)),
    [agentDevices]
  );
  const activeDeviceConnected = Boolean(
    activeProject && connectedDeviceNames.has(activeProject.rootKey)
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
        setSearchOpen(false);
        setDevicesOpen(false);
        setFocusedDevice(null);
        setNewDeviceOpen(false);
        setNewProjectOpen(false);
        setAttachTmuxOpen(false);
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
          const tabId = project.tabs[0]?.id;
          if (tabId) {
            handlers.selectTab(project.id, tabId);
          }
        }
        return;
      }

      if (mod && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }

      // `/` opens the search palette when nothing typeable has focus
      // (vim/help convention). xterm.js focuses a hidden textarea while
      // the terminal is active — we treat that as typing too and skip,
      // so `/` inside a shell still works normally. The Mod+Shift+F
      // shortcut stays as the always-works alternative.
      if (!mod && !event.altKey && !event.shiftKey && event.key === "/") {
        const target = event.target as HTMLElement | null;
        const tagName = target?.tagName?.toLowerCase();
        const isTyping = tagName === "input" || tagName === "textarea" || target?.isContentEditable;
        if (!isTyping) {
          event.preventDefault();
          setSearchOpen(true);
          return;
        }
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
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let cancelled = false;

    const connect = () => {
      if (cancelled) {
        return;
      }
      ws = new WebSocket(url);
      ws.onopen = () => {
        attempts = 0;
        ws.send(JSON.stringify({ type: "subscribe-devices" }));
      };
      ws.onmessage = event => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "agent") {
            if (Array.isArray(msg.devices)) {
              setAgentDevices(msg.devices.map(normalizeAgentDevice));
            }
          }
        } catch {
          // ignore malformed payloads
        }
      };
      ws.onclose = () => {
        if (cancelled) {
          return;
        }
        setAgentDevices(current => current.map(device => ({ ...device, connected: false })));
        attempts += 1;
        const delay = Math.min(15000, 500 * 2 ** Math.min(attempts, 5));
        retryTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => {
        // close handler will fire next and schedule the retry
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      ws?.close();
    };
  }, []);

  const reloadProjects = useCallback(
    async (nextProjectId?: string, nextTabId?: string) => {
      const res = await fetch("/api/projects");
      if (!res.ok) {
        return;
      }
      const next = await res.json();
      const desiredProjectId = nextProjectId ?? activeProjectIdRef.current;
      const desiredTabId = nextTabId ?? activeTabIdRef.current;
      setProjects(next);
      const project = next.find((item: Project) => item.id === desiredProjectId) ?? next[0];
      setActiveProjectId(project?.id || "");
      const tab = project?.tabs.find((item: Tab) => item.id === desiredTabId) ?? project?.tabs[0];
      setActiveTabId(tab?.id || "");
      if (project?.id && tab?.id && nextTabId) {
        tabHistory.remember(project.id, tab.id);
      }
    },
    [tabHistory]
  );

  const reorderProjects = useCallback(
    async (sourceId: string, targetId: string, before: boolean) => {
      if (sourceId === targetId) {
        return;
      }
      let nextOrder: string[] = [];
      setProjects(current => {
        const fromIdx = current.findIndex(p => p.id === sourceId);
        if (fromIdx < 0) {
          return current;
        }
        const reordered = [...current];
        const [source] = reordered.splice(fromIdx, 1);
        let toIdx = reordered.findIndex(p => p.id === targetId);
        if (toIdx < 0) {
          toIdx = reordered.length;
        } else if (!before) {
          toIdx += 1;
        }
        reordered.splice(toIdx, 0, source);
        nextOrder = reordered.map(p => p.id);
        return reordered;
      });
      if (nextOrder.length === 0) {
        return;
      }
      const res = await fetch("/api/projects/order", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectIds: nextOrder }),
      });
      if (!res.ok) {
        console.error(
          "[termag] reorderProjects failed",
          res.status,
          await res.text().catch(() => "")
        );
        await reloadProjects();
      }
    },
    [reloadProjects]
  );

  const createProject = useCallback(
    async (input: {
      rootKey: string;
      relativePath: string;
      name?: string;
      agentTypes: string[];
      customAgents: string[];
    }) => {
      const customAgents = input.customAgents.map(spawnCommand => ({ spawnCommand }));
      const builtinAgents = input.agentTypes.map(agentType => ({ agentType }));
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          rootKey: input.rootKey,
          relativePath: input.relativePath,
          agents: [...customAgents, ...builtinAgents],
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        return { ok: false, error: body?.error };
      }
      const project = await res.json();
      await reloadProjects(project.id, project.tabs?.[0]?.id);
      return { ok: true };
    },
    [reloadProjects]
  );

  const attachTmuxSession = useCallback(
    async (input: { rootKey: string; sessionName: string }) => {
      const res = await fetch("/api/tmux/attach", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        return { ok: false, error: body?.error };
      }
      const project = await res.json();
      await reloadProjects(project.id, project.tabs?.[0]?.id);
      return { ok: true };
    },
    [reloadProjects]
  );

  const createTab = useCallback(
    async (projectId: string) => {
      const res = await fetch(`/api/projects/${projectId}/tabs`, { method: "POST" });
      if (!res.ok) {
        console.error("[termag] createTab failed", res.status, await res.text().catch(() => ""));
        return;
      }
      const tab = await res.json();
      await reloadProjects(projectId, tab.id);
    },
    [reloadProjects]
  );

  const copyText = useCallback(async (id: string, value: string) => {
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
    setCopiedCommand(id);
    window.setTimeout(() => {
      setCopiedCommand(current => (current === id ? "" : current));
    }, 1500);
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
    [reloadProjects]
  );

  const renameTab = useCallback(
    async (projectId: string, tabId: string, name: string) => {
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
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        console.error("[termag] renameTab failed", res.status, await res.text().catch(() => ""));
        await reloadProjects();
      }
    },
    [projects, reloadProjects]
  );

  const closeTab = useCallback(
    async (projectId: string, tabId: string) => {
      const project = projects.find(item => item.id === projectId);
      if (!project || project.tabs.length <= 1) {
        return;
      }
      const res = await fetch(`/api/projects/${projectId}/tabs/${tabId}`, { method: "DELETE" });
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
  }, [platform.showShortcuts]);

  const selectTab = useCallback(
    (projectId: string, tabId: string) => {
      setActiveProjectId(projectId);
      setActiveTabId(tabId);
      tabHistory.remember(projectId, tabId);
      closeDrawerOnMobile();
    },
    [tabHistory, closeDrawerOnMobile]
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
  }, [theme]);

  const toggleCaffeinate = useCallback(async () => {
    if (!activeProject) {
      return;
    }

    try {
      if (caffeinateActive) {
        await stopCaffeinateOnDevice(user.id, activeProject.rootKey);
        setCaffeinateActive(false);
      } else {
        await startCaffeinateOnDevice(
          user.id,
          activeProject.rootKey,
          "while-task",
          "User request from web UI"
        );
        setCaffeinateActive(true);
      }
    } catch (error) {
      console.error("Failed to toggle caffeinate:", error);
    }
  }, [activeProject, caffeinateActive, user.id]);

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
          projectName: project.name,
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
    return [...result.entries()];
  }, [devices, projects]);

  const openNewProject = useCallback((device?: string) => {
    setCreateMenuOpen(false);
    setNewProjectDevice(device ?? null);
    setNewProjectOpen(true);
  }, []);

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
    if (activeTab?.session) {
      window.dispatchEvent(
        new CustomEvent("termag:kill-session", { detail: { sessionId: activeTab.session.id } })
      );
    }
  }, [activeTab]);

  const openDevices = useCallback((deviceName?: string) => {
    setFocusedDevice(deviceName ?? null);
    setDevicesOpen(true);
  }, []);

  return (
    <PlatformProvider platform={platform}>
      <main className="flex h-dvh bg-bg text-text">
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
            "fixed inset-y-0 left-0 z-40 w-[260px] md:static md:translate-x-0",
            sidebarOpen ? "translate-x-0" : "-translate-x-full md:w-0 md:overflow-hidden"
          )}
        >
          <div className="flex h-14 items-center justify-between px-3">
            <span className="flex items-baseline gap-1.5 px-1">
              <span className="text-sm font-semibold tracking-tight">termag</span>
              <span className="text-sm font-normal text-muted">next</span>
            </span>
            <div className="relative flex items-center gap-0.5">
              <button
                type="button"
                className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text"
                onPointerDown={event => event.stopPropagation()}
                onClick={() => setCreateMenuOpen(value => !value)}
                title="New device, session, or tmux connection"
                aria-label="New device, session, or tmux connection"
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
                  <button
                    type="button"
                    className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-muted hover:bg-panel2 hover:text-text"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      setAttachTmuxOpen(true);
                    }}
                  >
                    <Terminal className="h-3.5 w-3.5" />
                    <span className="whitespace-nowrap">Connect tmux session</span>
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
                  <button
                    type="button"
                    className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-muted hover:bg-panel2 hover:text-text"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      setNewSshHostOpen(true);
                    }}
                  >
                    <Network className="h-3.5 w-3.5" />
                    <span className="whitespace-nowrap">New SSH host</span>
                  </button>
                  <div className="my-1 h-px bg-line" />
                  <button
                    type="button"
                    className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-muted hover:bg-panel2 hover:text-text"
                    onClick={() => copyText("quick-new-session", "termag new")}
                  >
                    {copiedCommand === "quick-new-session" ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    <span className="truncate">
                      {copiedCommand === "quick-new-session" ? "Copied" : "Copy termag new"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-muted hover:bg-panel2 hover:text-text"
                    onClick={() => copyText("quick-adopt-session", "termag adopt")}
                  >
                    {copiedCommand === "quick-adopt-session" ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    <span className="truncate">
                      {copiedCommand === "quick-adopt-session" ? "Copied" : "Copy termag adopt"}
                    </span>
                  </button>
                </div>
              )}
              <button
                type="button"
                className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text"
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
                    {groupProjects.map(project => {
                      const isActiveProject = project.id === activeProject?.id;
                      const isDragging = dragProjectId === project.id;
                      const dropBefore = dropTarget?.id === project.id && dropTarget.before;
                      const dropAfter = dropTarget?.id === project.id && !dropTarget.before;
                      return (
                        <div
                          key={project.id}
                          draggable
                          onDragStart={event => {
                            setDragProjectId(project.id);
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", project.id);
                          }}
                          onDragOver={event => {
                            if (!dragProjectId || dragProjectId === project.id) {
                              return;
                            }
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            const rect = (
                              event.currentTarget as HTMLDivElement
                            ).getBoundingClientRect();
                            const before = event.clientY < rect.top + rect.height / 2;
                            if (dropTarget?.id !== project.id || dropTarget.before !== before) {
                              setDropTarget({ id: project.id, before });
                            }
                          }}
                          onDragLeave={() => {
                            if (dropTarget?.id === project.id) {
                              setDropTarget(null);
                            }
                          }}
                          onDrop={event => {
                            if (!dragProjectId) {
                              return;
                            }
                            event.preventDefault();
                            const rect = (
                              event.currentTarget as HTMLDivElement
                            ).getBoundingClientRect();
                            const before = event.clientY < rect.top + rect.height / 2;
                            reorderProjects(dragProjectId, project.id, before);
                            setDragProjectId(null);
                            setDropTarget(null);
                          }}
                          onDragEnd={() => {
                            setDragProjectId(null);
                            setDropTarget(null);
                          }}
                          className={cn(
                            "relative",
                            isDragging && "opacity-40",
                            dropBefore &&
                              "before:absolute before:inset-x-2 before:-top-px before:h-px before:bg-text",
                            dropAfter &&
                              "after:absolute after:inset-x-2 after:-bottom-px after:h-px after:bg-text"
                          )}
                        >
                          <div
                            className={cn(
                              "group/project flex h-9 w-full items-center rounded-md hover:bg-panel2",
                              isActiveProject && "bg-panel2 shadow-sm"
                            )}
                          >
                            <div
                              role="button"
                              tabIndex={0}
                              className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-l-md px-2 text-left text-sm"
                              title={`${project.rootKey}/${project.relativePath}`}
                              onClick={() => {
                                const tabId = project.tabs[0]?.id;
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
                                  const tabId = project.tabs[0]?.id;
                                  if (tabId) {
                                    selectTab(project.id, tabId);
                                  } else {
                                    setActiveProjectId(project.id);
                                    closeDrawerOnMobile();
                                  }
                                }
                              }}
                            >
                              <span
                                className={cn(
                                  "h-2 w-2 shrink-0 rounded-full",
                                  statusDot(
                                    connectedDeviceNames.has(project.rootKey)
                                      ? project.status
                                      : "sleeping"
                                  )
                                )}
                              />
                              <TabLabel
                                name={project.name}
                                className="min-w-0 flex-1 truncate"
                                onRename={next => renameProject(project.id, next)}
                              />
                            </div>
                            <button
                              type="button"
                              className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-muted opacity-0 hover:bg-bg hover:text-text focus:opacity-100 group-hover/project:opacity-100"
                              onPointerDown={event => event.stopPropagation()}
                              onClick={event => {
                                event.stopPropagation();
                                setProjectMenuId(current =>
                                  current === project.id ? null : project.id
                                );
                              }}
                              title="Project actions"
                              aria-label={`${project.name} actions`}
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
                              <button
                                type="button"
                                className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-muted hover:bg-panel2 hover:text-text"
                                onClick={() =>
                                  copyText(`connect:${project.id}`, connectCommand(project.name))
                                }
                              >
                                {copiedCommand === `connect:${project.id}` ? (
                                  <Check className="h-3.5 w-3.5" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                                <span className="truncate">
                                  {copiedCommand === `connect:${project.id}`
                                    ? "Copied"
                                    : "Copy connect command"}
                                </span>
                              </button>
                              <button
                                type="button"
                                className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-muted hover:bg-panel2 hover:text-text"
                                onClick={() =>
                                  copyText(
                                    `connect-session:${project.id}`,
                                    connectCommand(project.name, true)
                                  )
                                }
                              >
                                {copiedCommand === `connect-session:${project.id}` ? (
                                  <Check className="h-3.5 w-3.5" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                                <span className="truncate">
                                  {copiedCommand === `connect-session:${project.id}`
                                    ? "Copied"
                                    : "Copy session command"}
                                </span>
                              </button>
                            </div>
                          )}
                          {project.tabs.length > 0 && (
                            <div className="mt-0.5 space-y-0.5 pl-4">
                              {project.tabs.map(tab => {
                                const isActiveTab = isActiveProject && tab.id === activeTab?.id;
                                const tabManaged = tab.session?.tmuxManaged !== false;
                                return (
                                  <div
                                    key={tab.id}
                                    role="button"
                                    tabIndex={0}
                                    className={cn(
                                      "group/tab flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-panel2",
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
                                    <span
                                      className={cn(
                                        "h-1.5 w-1.5 shrink-0 rounded-full",
                                        statusDot(
                                          connectedDeviceNames.has(project.rootKey)
                                            ? tab.status
                                            : "sleeping"
                                        )
                                      )}
                                    />
                                    <TabLabel
                                      name={tab.name}
                                      liveTitle={tab.session ? liveTitles[tab.session.id] : null}
                                      className="min-w-0 flex-1 truncate"
                                      onRename={next => renameTab(project.id, tab.id, next)}
                                    />
                                    {/* Per-tab notification toggle. First
                                      click on any tab requests Notification
                                      permission (cached after that). The
                                      hook then watches for working/waiting
                                      → idle/error transitions and fires a
                                      browser notification for subscribed
                                      tabs only. */}
                                    {notify.permission !== "unsupported" && (
                                      <span
                                        className={cn(
                                          "grid h-4 w-4 shrink-0 place-items-center rounded text-muted hover:bg-bg hover:text-text",
                                          notify.subscribed.has(tab.id)
                                            ? "opacity-100 text-accent"
                                            : "opacity-0 group-hover/tab:opacity-100"
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
                                      </span>
                                    )}
                                    {project.tabs.length > 1 && (
                                      <span
                                        className="grid h-4 w-4 shrink-0 place-items-center rounded text-muted opacity-0 hover:bg-bg hover:text-text group-hover/tab:opacity-100"
                                        title={tabManaged ? "Delete (kill tmux window)" : "Detach"}
                                        onClick={event => {
                                          event.stopPropagation();
                                          closeTab(project.id, tab.id);
                                        }}
                                      >
                                        ×
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
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
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text"
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
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      statusDot(activeDeviceConnected ? activeProject?.status : "sleeping")
                    )}
                  />
                  <h1 className="truncate text-sm font-semibold">
                    {activeProject?.name ?? "No project"}
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
                title={`Search scrollback${shortcutSuffix(["mod", "shift", "F"], platform)}`}
                onClick={() => setSearchOpen(true)}
              >
                <Search className="h-4 w-4" />
              </IconButton>
              <IconButton
                title="Toggle ctrl pane"
                onClick={() => setShowCtrl(value => !value)}
                className="hidden md:grid"
              >
                {showCtrl ? (
                  <ChevronRight className="h-4 w-4" />
                ) : (
                  <ChevronLeft className="h-4 w-4" />
                )}
              </IconButton>
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
              <IconButton
                title={caffeinateActive ? "Stop preventing sleep" : "Prevent sleep"}
                onClick={toggleCaffeinate}
              >
                <Coffee className={`h-4 w-4 ${caffeinateActive ? "text-yellow-500" : ""}`} />
              </IconButton>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 gap-3 bg-bg p-2 md:p-3">
            {activeTab?.session && activeProject ? (
              // Agent pane: tabs become the pane's top edge — active tab merges
              // with the canvas below it. On mobile, a ctrl pseudo-tab is appended
              // so the user can swap the single visible terminal to the project's
              // ctrl shell. On desktop the ctrl shell is the side pane and the
              // pseudo-tab is hidden.
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-bg">
                <div className="flex h-9 items-end gap-px overflow-x-auto bg-panel pl-1.5 pr-1">
                  {activeProject.tabs.map(tab => {
                    const isActive = tab.id === activeTab.id && !mobileViewCtrl;
                    const tabManaged = tab.session?.tmuxManaged !== false;
                    return (
                      <div
                        key={tab.id}
                        role="button"
                        tabIndex={0}
                        className={cn(
                          "group/tab flex h-7 cursor-pointer items-center gap-2 rounded-t-md px-3 text-xs",
                          isActive ? "bg-bg text-text" : "text-muted hover:text-text"
                        )}
                        onClick={() => {
                          setMobileViewCtrl(false);
                          selectTab(activeProject.id, tab.id);
                        }}
                        onKeyDown={event => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setMobileViewCtrl(false);
                            selectTab(activeProject.id, tab.id);
                          }
                        }}
                      >
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            statusDot(activeDeviceConnected ? tab.status : "sleeping")
                          )}
                        />
                        <TabLabel
                          name={tab.name}
                          liveTitle={tab.session ? liveTitles[tab.session.id] : null}
                          className="max-w-[180px] truncate"
                          onRename={next => renameTab(activeProject.id, tab.id, next)}
                        />
                        {activeProject.tabs.length > 1 && (
                          <span
                            className="grid h-4 w-4 shrink-0 place-items-center rounded text-muted opacity-0 hover:bg-panel2 hover:text-text group-hover/tab:opacity-100"
                            title={tabManaged ? "Delete (kill tmux window)" : "Detach"}
                            onClick={event => {
                              event.stopPropagation();
                              closeTab(activeProject.id, tab.id);
                            }}
                          >
                            ×
                          </span>
                        )}
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className="ml-1 flex h-7 items-center gap-1.5 rounded-t-md px-2 text-[11px] text-muted hover:text-text"
                    title={`New agent${shortcutSuffix(["mod", "enter"], platform)}`}
                    onClick={() => createTab(activeProject.id)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <Shortcut keys={["mod", "enter"]} />
                  </button>
                  {/* ctrl pseudo-tab — mobile only */}
                  {ctrlSession && (
                    <div
                      role="button"
                      tabIndex={0}
                      className={cn(
                        "group/tab ml-auto flex h-7 cursor-pointer items-center gap-2 rounded-t-md px-3 text-xs md:hidden",
                        mobileViewCtrl ? "bg-bg text-text" : "text-muted hover:text-text"
                      )}
                      onClick={() => setMobileViewCtrl(true)}
                      onKeyDown={event => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setMobileViewCtrl(true);
                        }
                      }}
                      title="Project ctrl shell"
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          statusDot(activeDeviceConnected ? ctrlSession.status : "sleeping")
                        )}
                      />
                      <span className="font-mono">ctrl</span>
                    </div>
                  )}
                </div>
                <div className="flex min-h-0 flex-1">
                  {mobileViewCtrl && ctrlSession ? (
                    <TerminalPane
                      key={ctrlSession.id}
                      active
                      sessionId={ctrlSession.id}
                      title={liveTitles[ctrlSession.id] || "ctrl"}
                      status={activeDeviceConnected ? ctrlSession.status : "sleeping"}
                      onTitleChange={handleSessionTitle}
                      hideHeader
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
                  <div className="mb-2 font-medium text-text">
                    Start or connect a tmux workspace.
                  </div>
                  <div className="mb-3 text-muted">
                    Create a device token, then run a shell command or use the + menu.
                  </div>
                  <div className="flex items-center gap-2 rounded-md border border-line bg-bg p-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
                      termag new
                    </code>
                    <button
                      type="button"
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text"
                      title="Copy new-session command"
                      aria-label="Copy new-session command"
                      onClick={() => copyText("empty-connect", "termag new")}
                    >
                      {copiedCommand === "empty-connect" ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                  <a
                    href="https://github.com/yeutterg/termag-next#quick-setup"
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
            {/* ctrl pane: only on md+, hidden on mobile */}
            {showCtrl && ctrlSession && (
              <div className="hidden min-h-0 flex-1 md:flex">
                <TerminalPane
                  key={ctrlSession.id}
                  active
                  sessionId={ctrlSession.id}
                  title={liveTitles[ctrlSession.id] || "ctrl"}
                  status={activeDeviceConnected ? ctrlSession.status : "sleeping"}
                  onTitleChange={handleSessionTitle}
                />
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
              onSearch={() => setSearchOpen(true)}
              onDevices={() => openDevices()}
              onAddDevice={() => setNewDeviceOpen(true)}
              // SSH host add lives inside the Devices dialog (the section
              // owns the dialog state). Open Devices first; the SSH add
              // button is one click away.
              onAddSshHost={() => openDevices()}
              authMode={authMode}
            />
          </Suspense>
        )}
        {searchOpen && (
          <Suspense fallback={null}>
            <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} />
          </Suspense>
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
              projects={projects}
              focusedDevice={focusedDevice}
              onTokenDeleted={name => {
                setTokenDevices(current => current.filter(device => device !== name));
              }}
              onAddDevice={() => setNewDeviceOpen(true)}
              onAddSshHost={() => setNewSshHostOpen(true)}
              onBootstrap={() => setBootstrapOpen(true)}
              onCleanup={() => reloadProjects()}
              refreshTrigger={hostsRefreshTrigger}
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
        {newSshHostOpen && (
          <Suspense fallback={null}>
            <NewSshHostDialog
              open={newSshHostOpen}
              onOpenChange={setNewSshHostOpen}
              // Bump a counter so the DevicesDialog's parent-side fetch
              // re-runs if Devices is open in the background. Without
              // this, a host added while Devices is showing wouldn't
              // appear until the user closes and re-opens Devices.
              onCreated={() => setHostsRefreshTrigger(n => n + 1)}
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
        {attachTmuxOpen && (
          <Suspense fallback={null}>
            <AttachTmuxDialog
              open={attachTmuxOpen}
              onOpenChange={setAttachTmuxOpen}
              onAttach={async input => {
                const result = await attachTmuxSession(input);
                if (result.ok && !platform.showShortcuts) {
                  setSidebarOpen(false);
                }
                return result;
              }}
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
        "grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text",
        className
      )}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
