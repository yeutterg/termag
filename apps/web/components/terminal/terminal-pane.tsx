"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";
import type { ITheme, Terminal as XTerm } from "@xterm/xterm";
import { cn, statusDot } from "@/lib/utils";

// Palettes hoisted so they're stable references — set as term.options.theme
// on init AND swapped live whenever the html.dark class flips.
const DARK_THEME: ITheme = {
  background: "#00000000",
  foreground: "#E4E4E7",
  cursor: "#FAFAFA",
  selectionBackground: "#404040",
  black: "#18181B",
  red: "#EF4444",
  green: "#22C55E",
  yellow: "#F59E0B",
  blue: "#3B82F6",
  magenta: "#A78BFA",
  cyan: "#06B6D4",
  white: "#D4D4D8",
  brightBlack: "#71717A",
  brightRed: "#F87171",
  brightGreen: "#4ADE80",
  brightYellow: "#FBBF24",
  brightBlue: "#60A5FA",
  brightMagenta: "#C4B5FD",
  brightCyan: "#22D3EE",
  brightWhite: "#FAFAFA",
};

const LIGHT_THEME: ITheme = {
  background: "#00000000",
  foreground: "#18181B",
  cursor: "#18181B",
  selectionBackground: "#D4D4D8",
  black: "#18181B",
  red: "#B91C1C",
  green: "#15803D",
  yellow: "#B45309",
  blue: "#1D4ED8",
  magenta: "#7C3AED",
  cyan: "#0E7490",
  white: "#71717A",
  brightBlack: "#52525B",
  brightRed: "#DC2626",
  brightGreen: "#16A34A",
  brightYellow: "#D97706",
  brightBlue: "#2563EB",
  brightMagenta: "#9333EA",
  brightCyan: "#0891B2",
  brightWhite: "#09090B",
};

const PAGE_SUSPEND_MS = 90_000;
const RECONNECT_RESET_AFTER_MS = 60_000;
const MAX_INPUT_CHARS = 32 * 1024;
const XTERM_WRITE_PAUSE_BYTES = 1024 * 1024;
const XTERM_WRITE_RESUME_BYTES = 256 * 1024;
const pageActivityListeners = new Set<(active: boolean) => void>();
let pageVisibilityTimer: ReturnType<typeof setTimeout> | null = null;
let pageVisibilityBound = false;
let pageIsActive = true;

function publishPageActivity(active: boolean) {
  pageIsActive = active;
  for (const listener of pageActivityListeners) {
    listener(active);
  }
}

function onPageVisibilityChange() {
  if (pageVisibilityTimer) {
    clearTimeout(pageVisibilityTimer);
    pageVisibilityTimer = null;
  }
  if (document.visibilityState === "visible") {
    publishPageActivity(true);
    return;
  }
  pageVisibilityTimer = setTimeout(() => {
    pageVisibilityTimer = null;
    publishPageActivity(false);
  }, PAGE_SUSPEND_MS);
}

function subscribePageActivity(listener: (active: boolean) => void) {
  pageActivityListeners.add(listener);
  listener(pageIsActive);
  if (!pageVisibilityBound) {
    document.addEventListener("visibilitychange", onPageVisibilityChange);
    pageVisibilityBound = true;
    onPageVisibilityChange();
  }
  return () => {
    pageActivityListeners.delete(listener);
    if (pageActivityListeners.size === 0 && pageVisibilityBound) {
      document.removeEventListener("visibilitychange", onPageVisibilityChange);
      pageVisibilityBound = false;
      if (pageVisibilityTimer) {
        clearTimeout(pageVisibilityTimer);
      }
      pageVisibilityTimer = null;
    }
  };
}

const themeListeners = new Set<(theme: ITheme) => void>();
let sharedThemeObserver: MutationObserver | null = null;

function subscribeTheme(listener: (theme: ITheme) => void) {
  themeListeners.add(listener);
  if (!sharedThemeObserver) {
    sharedThemeObserver = new MutationObserver(() => {
      const theme = currentTheme();
      for (const notify of themeListeners) {
        notify(theme);
      }
    });
    sharedThemeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }
  return () => {
    themeListeners.delete(listener);
    if (themeListeners.size === 0) {
      sharedThemeObserver?.disconnect();
      sharedThemeObserver = null;
    }
  };
}

function sendTerminalInput(ws: WebSocket, data: string) {
  for (let start = 0; start < data.length; ) {
    let end = Math.min(data.length, start + MAX_INPUT_CHARS);
    // Do not divide a UTF-16 surrogate pair. A 32K-character chunk is at
    // most 128 KiB of UTF-8, comfortably below the broker/agent input cap.
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) {
      end -= 1;
    }
    ws.send(JSON.stringify({ type: "input", data: data.slice(start, end) }));
    start = end;
  }
}

function currentTheme(): ITheme {
  return document.documentElement.classList.contains("dark") ? DARK_THEME : LIGHT_THEME;
}

interface TerminalPaneProps {
  sessionId: string;
  active: boolean;
  title: string;
  status?: string;
  onTitleChange?: (sessionId: string, title: string) => void;
  /** Suppress the pane's own header — used when tabs above provide it. */
  hideHeader?: boolean;
  /**
   * When set, the pane connects to the SSH-attach WebSocket endpoint
   * (`/api/ws/ssh-terminal`) instead of the per-session endpoint. The
   * `sessionId` prop is still required (used as the local React key /
   * title-change identifier) but ignored for routing.
   */
  ssh?: { hostId: string; tmuxName: string };
  /**
   * Read-only share viewer mode. Connects to the broker's
   * /api/ws/share-terminal?code= endpoint, which resolves the
   * (sshHostId, tmuxName) on the server side from the code. Inputs are
   * suppressed both at the pane (no input messages sent) and at the
   * broker (read-only subscriber flag).
   */
  share?: { code: string };
  /**
   * Optional callback fired with the latest subscriber count for the
   * session. Parents (e.g., the SSH attach shell) use this to render a
   * "👁 N" chip when more than one client is attached. Only the SSH path
   * sends these messages today; agent attaches will follow.
   */
  onSubscriberCount?: (count: number) => void;
}

function TerminalPaneImpl({
  sessionId,
  active,
  title,
  status,
  onTitleChange,
  hideHeader,
  ssh,
  share,
  onSubscriberCount,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Driver/read-only state is null until the agent's first driver-changed
  // message arrives, so we don't render a stale "Take control" badge during
  // the brief reconnect window. After the first message lands, we trust the
  // agent and re-render on every update.
  const [driverState, setDriverState] = useState<{ driver: boolean; readOnly: boolean } | null>(
    null
  );
  const [pageActive, setPageActive] = useState(true);
  const [connectionIssue, setConnectionIssue] = useState<{
    fatal: boolean;
    message: string;
  } | null>(null);
  const manualReconnectRef = useRef<(() => void) | null>(null);
  const sshHostId = ssh?.hostId;
  const sshTmuxName = ssh?.tmuxName;
  const shareCode = share?.code;
  // Capture latest onTitleChange so the xterm listener (set up once) always
  // invokes the current callback without rebinding the terminal.
  const onTitleChangeRef = useRef(onTitleChange);
  // Same trick for the subscriber-count callback so the WS message
  // handler (set up once) always sees the latest callback.
  const onSubscriberCountRef = useRef(onSubscriberCount);

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  useEffect(() => {
    onSubscriberCountRef.current = onSubscriberCount;
  }, [onSubscriberCount]);

  useEffect(() => subscribePageActivity(setPageActive), []);

  useEffect(() => {
    if (!active || !pageActive || !hostRef.current) {
      return;
    }
    let disposed = false;
    let term: XTerm | null = null;
    let fitAddon: { fit: () => void } | null = null;
    let raf = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: ResizeObserver | null = null;
    let onKill: ((event: Event) => void) | null = null;
    let onVisibilityRef: (() => void) | null = null;
    let onOnlineRef: (() => void) | null = null;
    let onVisualViewportRef: (() => void) | null = null;
    let unsubscribeTheme: (() => void) | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let titleTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingTitle = "";
    let reconnectAttempts = 0;
    let connectedAt = 0;
    let fatalMessage = "";
    let resyncRequested = false;
    let queuedWriteBytes = 0;
    let parserPaused = false;
    let visibilityPaused = document.visibilityState === "hidden";
    let brokerPaused = false;

    function syncBrokerPause() {
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN) {
        return;
      }
      const shouldPause = visibilityPaused || parserPaused;
      if (shouldPause === brokerPaused) {
        return;
      }
      brokerPaused = shouldPause;
      ws.send(JSON.stringify({ type: shouldPause ? "pause" : "resume" }));
    }

    function writeTerminal(data: string | Uint8Array) {
      if (!term || disposed) {
        return;
      }
      const byteCount = typeof data === "string" ? data.length * 2 : data.byteLength;
      queuedWriteBytes += byteCount;
      if (!parserPaused && queuedWriteBytes >= XTERM_WRITE_PAUSE_BYTES) {
        parserPaused = true;
        syncBrokerPause();
      }
      term.write(data, () => {
        queuedWriteBytes = Math.max(0, queuedWriteBytes - byteCount);
        if (parserPaused && queuedWriteBytes <= XTERM_WRITE_RESUME_BYTES) {
          parserPaused = false;
          if (!disposed) {
            syncBrokerPause();
          }
        }
      });
    }

    function fitAndResize() {
      if (disposed || !term || !fitAddon) {
        return;
      }
      fitAddon.fit();
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    }

    function scheduleFit() {
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      resizeTimer = setTimeout(fitAndResize, 80);
    }

    // WebSocket lifecycle is its own function so we can re-run it on disconnect.
    // All input sites (term.onData, onKill, onVisibility, ResizeObserver) read
    // wsRef.current at call time so they always target the latest socket — no
    // stale closure over a closed WS after a reconnect.
    function connectWS() {
      if (disposed || !term) {
        return;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      // Hint the broker to trim initial scrollback when the user is on a
      // metered/cellular connection or has Low Data Mode on.
      type ConnectionLike = { saveData?: boolean; effectiveType?: string };
      const conn = (navigator as Navigator & { connection?: ConnectionLike }).connection;
      const saveDataHint =
        conn?.saveData || /^(slow-2g|2g|3g)$/.test(conn?.effectiveType ?? "") ? "&saveData=1" : "";
      // Three connection modes. Share routes through a public WS path
      // that authenticates via the share code; SSH attaches use hostId
      // + tmuxName; everything else is sessionId-keyed. The on-wire
      // protocol is identical from this point on (binary frames for
      // output, JSON for control), so nothing else here has to branch.
      const wsUrl = shareCode
        ? `${protocol}//${window.location.host}/api/ws/share-terminal?code=${encodeURIComponent(shareCode)}&cols=${term.cols}&rows=${term.rows}`
        : sshHostId && sshTmuxName
          ? `${protocol}//${window.location.host}/api/ws/ssh-terminal?hostId=${encodeURIComponent(sshHostId)}&tmuxName=${encodeURIComponent(sshTmuxName)}&cols=${term.cols}&rows=${term.rows}`
          : `${protocol}//${window.location.host}/api/ws/terminal?sessionId=${sessionId}&cols=${term.cols}&rows=${term.rows}${saveDataHint}`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        connectedAt = Date.now();
        brokerPaused = false;
        visibilityPaused = document.visibilityState === "hidden";
        if (reconnectAttempts > 0) {
          writeTerminal("\r\n\x1b[2m[reconnected]\x1b[0m\r\n");
        }
        const justReconnected = reconnectAttempts > 0;
        fatalMessage = "";
        setConnectionIssue(null);
        // Driver state is unknown until the agent's first driver-changed
        // message lands. Showing the previous connection's state would be
        // misleading after a reconnect (drive likely went to someone else).
        setDriverState(null);
        fitAddon?.fit();
        ws.send(JSON.stringify({ type: "resize", cols: term!.cols, rows: term!.rows }));
        // If the tab was hidden when we opened (background tab, page-restore,
        // visibility flicker mid-handshake), the visibilitychange event
        // already fired before the WS was open and was dropped. Send the
        // pause now so the broker isn't burning bandwidth on an offscreen
        // viewer.
        syncBrokerPause();
        // Only steal focus on the initial connect — yanking focus mid-typing
        // when the broker hiccups would be infuriating.
        if (!justReconnected) {
          term!.focus();
        }
      };
      ws.onmessage = event => {
        // Binary frames carry raw terminal output (no JSON wrapper). Text
        // frames carry control messages — ready/sleeping/exit/refresh.
        if (typeof event.data !== "string") {
          writeTerminal(new Uint8Array(event.data as ArrayBuffer));
          return;
        }
        let msg: { type?: string; data?: string; message?: string };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === "output") {
          writeTerminal(msg.data ?? "");
        } // legacy/control fallback
        // Queue RIS through xterm's parser so bytes already waiting in its
        // write buffer cannot land after a synchronous reset and corrupt the
        // newly-arriving full checkpoint.
        if (msg.type === "checkpoint") {
          writeTerminal("\x1bc");
        }
        if (msg.type === "resync") {
          resyncRequested = true;
          writeTerminal(`\x1bc\x1b[2m[${msg.message ?? "refreshing terminal state"}]\x1b[0m\r\n`);
          ws.close(1012, "terminal resync");
        }
        if (msg.type === "sleeping") {
          writeTerminal(`\r\n${msg.message ?? "Agent sleeping"}\r\n`);
        }
        if (msg.type === "exit") {
          writeTerminal("\r\n[session ended]\r\n");
        }
        if (msg.type === "fatal") {
          fatalMessage = msg.message || "terminal unavailable";
          writeTerminal(`\r\n\x1b[31m[${fatalMessage}]\x1b[0m\r\n`);
          try {
            ws.close(1008, "terminal unavailable");
          } catch {}
        }
        if (msg.type === "subscribers" && typeof (msg as { count?: unknown }).count === "number") {
          onSubscriberCountRef.current?.((msg as { count: number }).count);
        }
        if (msg.type === "driver-changed") {
          // Multi-subscriber model: agent's SessionStream broadcasts on every
          // driver change so each viewer knows whether they're driving or
          // riding along. UI just reads two flags out of state.
          setDriverState({
            driver: Boolean((msg as { driver?: unknown }).driver),
            readOnly: Boolean((msg as { readOnly?: unknown }).readOnly),
          });
        }
      };
      ws.onclose = event => {
        if (disposed) {
          return;
        }
        // Ignore a delayed close from a superseded socket. Letting it schedule
        // another reconnect would create overlapping connections and xterm
        // output duplication after rapid network changes.
        if (wsRef.current !== ws) {
          return;
        }
        wsRef.current = null;
        brokerPaused = false;
        // Code 1008 (policy violation) is the broker's "this session is gone /
        // you're not authorized" signal. Retrying would just loop forever, so
        // surface the reason and stop. Anything else is treated as a transient
        // network blip and gets exponential-backoff retry.
        if (event.code === 1008) {
          const reason = fatalMessage || event.reason || "session unavailable";
          writeTerminal(`\r\n\x1b[2m[disconnected: ${reason}]\x1b[0m\r\n`);
          setConnectionIssue({ fatal: true, message: reason });
          return;
        }
        if (resyncRequested) {
          resyncRequested = false;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectWS();
          }, 0);
          return;
        }
        if (connectedAt > 0 && Date.now() - connectedAt >= RECONNECT_RESET_AFTER_MS) {
          reconnectAttempts = 0;
        }
        connectedAt = 0;
        reconnectAttempts += 1;
        setConnectionIssue({ fatal: false, message: "Connection lost" });
        if (reconnectAttempts === 1) {
          writeTerminal("\r\n\x1b[2m[disconnected, reconnecting…]\x1b[0m\r\n");
        }
        // Exponential backoff capped at 30s. Resets to 1s on next successful
        // open. Tab visibility doesn't pause this; the next visible tick will
        // open the new socket which fast-tracks recovery on a phone wake-up.
        const ceiling = Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempts - 1, 5));
        const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectWS();
        }, delay);
      };
      ws.onerror = () => {
        // The close handler will follow with reconnect bookkeeping; nothing to
        // do here. Suppress the noisy default console error.
      };
    }

    function reconnectImmediately() {
      if (disposed || !term) {
        return;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const current = wsRef.current;
      if (current?.readyState === WebSocket.OPEN) {
        return;
      }
      if (current) {
        wsRef.current = null;
        current.close();
      }
      connectWS();
    }

    manualReconnectRef.current = () => {
      fatalMessage = "";
      resyncRequested = false;
      reconnectAttempts = 0;
      setConnectionIssue(null);
      const current = wsRef.current;
      wsRef.current = null;
      current?.close();
      connectWS();
    };

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostRef.current) {
        return;
      }

      // xterm renders to <canvas>; ctx.font does NOT reliably resolve CSS
      // variables, so 'var(--font-mono)' would fall through to the next
      // hard-coded family. next/font hashes the font name (e.g. __DM_Mono_xxx),
      // so we resolve the var at runtime and pass the actual loaded family.
      const monoVar = getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim();
      const fontFamily = [monoVar, '"DM Mono"', "SFMono-Regular", "Consolas", "monospace"]
        .filter(Boolean)
        .join(", ");
      type ConnectionLike = { saveData?: boolean; effectiveType?: string };
      const connection = (navigator as Navigator & { connection?: ConnectionLike }).connection;
      const constrained =
        Boolean(connection?.saveData) ||
        /^(slow-2g|2g|3g)$/.test(connection?.effectiveType ?? "") ||
        window.matchMedia("(max-width: 767px)").matches;
      term = new Terminal({
        allowTransparency: true,
        cursorBlink: true,
        fontFamily,
        fontSize: 12,
        lineHeight: 1.4,
        scrollback: constrained ? 500 : 2000,
        theme: currentTheme(),
      });

      // Live theme reactivity: when html.dark flips (cycleTheme button or
      // prefers-color-scheme media-query), swap palettes without recreating
      // the terminal. Without this, switching themes leaves the previous
      // foreground/brightBlack baked in until the page reloads.
      unsubscribeTheme = subscribeTheme(theme => {
        if (term) {
          term.options.theme = theme;
        }
      });
      const fit = new FitAddon();
      fitAddon = fit;
      term.loadAddon(fit);
      term.open(hostRef.current);
      termRef.current = term;
      if (!constrained && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
        void import("@xterm/addon-web-links").then(({ WebLinksAddon }) => {
          if (!disposed && term) {
            term.loadAddon(new WebLinksAddon());
          }
        });
      }

      // OSC 0/2 escape sequences fire here whenever a tool inside the
      // terminal changes its window title (e.g. shells, vim, claude).
      term.onTitleChange(next => {
        const trimmed = next?.trim();
        if (!trimmed) {
          return;
        }
        pendingTitle = trimmed;
        if (titleTimer) {
          return;
        }
        titleTimer = setTimeout(() => {
          titleTimer = null;
          onTitleChangeRef.current?.(sessionId, pendingTitle);
        }, 250);
      });

      // Bind once: every input goes through whatever socket is currently
      // assigned to wsRef.current. After a reconnect, the new WS just gets
      // the keystrokes naturally.
      term.onData(data => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          sendTerminalInput(ws, data);
        }
      });

      onKill = (event: Event) => {
        const custom = event as CustomEvent<{ sessionId: string }>;
        const ws = wsRef.current;
        if (custom.detail?.sessionId === sessionId && ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "kill" }));
        }
      };
      window.addEventListener("termag:kill-session", onKill);

      // Pause the output stream when the tab/app is hidden — saves a lot of
      // cellular data when a phone is locked or backgrounded. The broker
      // keeps a bounded tail and requests a fresh runtime checkpoint if the
      // stream overflows while paused.
      const onVisibility = () => {
        visibilityPaused = document.visibilityState === "hidden";
        syncBrokerPause();
        if (!visibilityPaused) {
          scheduleFit();
          reconnectImmediately();
        }
      };
      document.addEventListener("visibilitychange", onVisibility);
      onVisibilityRef = onVisibility;

      const onOnline = () => reconnectImmediately();
      window.addEventListener("online", onOnline);
      onOnlineRef = onOnline;

      const onVisualViewport = () => scheduleFit();
      window.visualViewport?.addEventListener("resize", onVisualViewport);
      window.visualViewport?.addEventListener("scroll", onVisualViewport);
      window.addEventListener("orientationchange", onVisualViewport);
      onVisualViewportRef = onVisualViewport;

      observer = new ResizeObserver(() => {
        if (disposed) {
          return;
        }
        scheduleFit();
      });
      observer.observe(hostRef.current!);

      raf = requestAnimationFrame(() => {
        if (disposed) {
          return;
        }
        fit.fit();
        connectWS();
      });
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (titleTimer) {
        clearTimeout(titleTimer);
      }
      observer?.disconnect();
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      wsRef.current?.close();
      wsRef.current = null;
      if (onKill) {
        window.removeEventListener("termag:kill-session", onKill);
      }
      if (onVisibilityRef) {
        document.removeEventListener("visibilitychange", onVisibilityRef);
      }
      if (onOnlineRef) {
        window.removeEventListener("online", onOnlineRef);
      }
      if (onVisualViewportRef) {
        window.visualViewport?.removeEventListener("resize", onVisualViewportRef);
        window.visualViewport?.removeEventListener("scroll", onVisualViewportRef);
        window.removeEventListener("orientationchange", onVisualViewportRef);
      }
      manualReconnectRef.current = null;
      unsubscribeTheme?.();
      term?.dispose();
      termRef.current = null;
    };
  }, [active, pageActive, sessionId, shareCode, sshHostId, sshTmuxName]);

  function claimDrive() {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN && !driverState?.readOnly) {
      ws.send(JSON.stringify({ type: "claim-drive" }));
    }
  }

  const showBadge = driverState !== null && !driverState.driver;
  const isReadOnly = driverState?.readOnly === true;

  // Two-finger horizontal swipe → tab switch. Tracked here so the
  // gesture is local to the pane and doesn't intercept other touches.
  // Resolves to a CustomEvent so termag-app stays the authority on tab
  // ordering and on which project is active.
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const onTabSwipeStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 2) {
      swipeStartRef.current = null;
      return;
    }
    const [a, b] = [event.touches[0], event.touches[1]];
    swipeStartRef.current = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }, []);
  const onTabSwipeEnd = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start) {
      return;
    }
    const touch = event.changedTouches[0];
    if (!touch) {
      return;
    }
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    // 80px threshold + dominant horizontal axis (3:1) keeps accidental
    // vertical scrolls / pinches from firing tab switches.
    if (Math.abs(dx) < 80 || Math.abs(dx) < Math.abs(dy) * 3) {
      return;
    }
    window.dispatchEvent(
      new CustomEvent("termag:tab-swipe", {
        detail: { direction: dx < 0 ? "next" : "prev" },
      })
    );
  }, []);

  return (
    <section
      className={cn(
        "relative flex min-h-0 flex-1 flex-col overflow-hidden bg-bg",
        !hideHeader && "rounded-lg border border-line"
      )}
    >
      {connectionIssue && (
        <div className="absolute left-2 top-2 z-30 flex max-w-[calc(100%-1rem)] items-center gap-2 rounded-md border border-line bg-panel/95 px-2 py-1 text-[11px] text-muted shadow-lg backdrop-blur">
          <span className="truncate">
            {connectionIssue.fatal ? connectionIssue.message : "Reconnecting…"}
          </span>
          <button
            type="button"
            className="min-h-9 shrink-0 rounded border border-line bg-bg px-2 font-medium text-text hover:bg-panel2 md:min-h-7"
            onClick={() => manualReconnectRef.current?.()}
          >
            Reconnect
          </button>
        </div>
      )}
      {hideHeader && showBadge && (
        <button
          type="button"
          onClick={claimDrive}
          disabled={isReadOnly}
          className="absolute right-2 top-2 z-20 inline-flex h-6 items-center gap-1 rounded border border-line bg-panel/95 px-2 text-[10px] text-muted shadow hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
          title={isReadOnly ? "Read-only session" : "Take keyboard control from the current driver"}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-muted" />
          {isReadOnly ? "Read-only" : "Take control"}
        </button>
      )}
      {!hideHeader && (
        <header className="flex h-9 shrink-0 items-center justify-between bg-panel px-3 text-xs">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn("h-1.5 w-1.5 rounded-full", statusDot(status))} />
            <span className="truncate font-medium">{title}</span>
          </div>
          <div className="flex items-center gap-2">
            {showBadge && (
              <button
                type="button"
                onClick={claimDrive}
                disabled={isReadOnly}
                className="inline-flex h-6 items-center gap-1 rounded border border-line bg-panel2 px-2 text-[10px] text-muted hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
                title={
                  isReadOnly ? "Read-only session" : "Take keyboard control from the current driver"
                }
              >
                <span className="h-1.5 w-1.5 rounded-full bg-muted" />
                {isReadOnly ? "Read-only" : "Take control"}
              </button>
            )}
            <span className="font-mono text-[10px] text-muted">{status ?? "sleeping"}</span>
          </div>
        </header>
      )}
      <div
        ref={hostRef}
        className="min-h-0 flex-1 bg-bg"
        // iPad-first: two-finger horizontal swipe switches tabs. The
        // gesture dispatches a window-level CustomEvent ('termag:tab-swipe')
        // that termag-app resolves against the active project's tab order.
        // Single-finger gestures pass through to xterm for selection.
        onTouchStart={onTabSwipeStart}
        onTouchEnd={onTabSwipeEnd}
      />
      <MobileSoftKeys
        onInput={data => {
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            sendTerminalInput(ws, data);
          }
          termRef.current?.focus();
        }}
      />
    </section>
  );
}

// Mobile-only soft-modifier bar. Phones and iPads have no physical Esc,
// Tab, Ctrl, F-keys, or arrow keys — without these the terminal is
// nearly unusable for vim/tmux/emacs muscle memory. The main row covers
// the always-needed essentials; the ⋯ button reveals readline + paging
// shortcuts; Fn toggles F1-F12.
const ESC = "\u001b";

const MOBILE_PRIMARY_KEYS: Array<[string, string]> = [
  ["Esc", ESC],
  ["Tab", "\t"],
  ["←", `${ESC}[D`],
  ["↓", `${ESC}[B`],
  ["↑", `${ESC}[A`],
  ["→", `${ESC}[C`],
  ["C-c", "\u0003"],
  ["C-d", "\u0004"],
];

const MOBILE_SECONDARY_KEYS: Array<[string, string, string?]> = [
  ["C-a", "\u0001", "start of line"],
  ["C-e", "\u0005", "end of line"],
  ["C-w", "\u0017", "delete word back"],
  ["C-u", "\u0015", "delete line back"],
  ["C-k", "\u000b", "delete line forward"],
  ["C-r", "\u0012", "reverse search"],
  ["C-l", "\u000c", "clear"],
  ["C-z", "\u001a", "suspend"],
  ["PgUp", `${ESC}[5~`],
  ["PgDn", `${ESC}[6~`],
  ["Home", `${ESC}[H`],
  ["End", `${ESC}[F`],
  ["Del", `${ESC}[3~`],
  ["Ins", `${ESC}[2~`],
];

// F1-F4 use xterm SS3 (ESC O P..S); F5-F12 use CSI (ESC [ NN ~).
const MOBILE_FN_KEYS: Array<[string, string]> = [
  ["F1", `${ESC}OP`],
  ["F2", `${ESC}OQ`],
  ["F3", `${ESC}OR`],
  ["F4", `${ESC}OS`],
  ["F5", `${ESC}[15~`],
  ["F6", `${ESC}[17~`],
  ["F7", `${ESC}[18~`],
  ["F8", `${ESC}[19~`],
  ["F9", `${ESC}[20~`],
  ["F10", `${ESC}[21~`],
  ["F11", `${ESC}[23~`],
  ["F12", `${ESC}[24~`],
];

function MobileSoftKeys({ onInput }: { onInput: (data: string) => void }) {
  const [expanded, setExpanded] = useState<"none" | "extras" | "fn">("none");
  return (
    <div className="md:hidden">
      {expanded === "fn" && (
        <div className="grid shrink-0 grid-cols-4 gap-1 border-t border-line bg-panel2 px-2 py-1">
          {MOBILE_FN_KEYS.map(([label, data]) => (
            <SoftKeyButton key={label} label={label} onClick={() => onInput(data)} />
          ))}
        </div>
      )}
      {expanded === "extras" && (
        <div className="grid shrink-0 grid-cols-4 gap-1 border-t border-line bg-panel2 px-2 py-1">
          {MOBILE_SECONDARY_KEYS.map(([label, data, title]) => (
            <SoftKeyButton key={label} label={label} title={title} onClick={() => onInput(data)} />
          ))}
        </div>
      )}
      <div className="flex min-h-12 shrink-0 items-center gap-1 overflow-x-auto border-t border-line bg-panel2 px-2">
        {MOBILE_PRIMARY_KEYS.map(([label, data]) => (
          <SoftKeyButton
            key={label}
            label={label}
            danger={label === "C-c"}
            onClick={() => onInput(data)}
          />
        ))}
        <button
          type="button"
          className="ml-auto h-11 min-w-11 shrink-0 rounded-md border border-line bg-bg px-2 text-xs"
          onPointerDown={event => event.preventDefault()}
          onClick={() => setExpanded(current => (current === "extras" ? "none" : "extras"))}
          aria-pressed={expanded === "extras"}
          title="More keys"
        >
          {expanded === "extras" ? "×" : "⋯"}
        </button>
        <button
          type="button"
          className="h-11 min-w-11 shrink-0 rounded-md border border-line bg-bg px-2 text-xs"
          onPointerDown={event => event.preventDefault()}
          onClick={() => setExpanded(current => (current === "fn" ? "none" : "fn"))}
          aria-pressed={expanded === "fn"}
          title="Function keys"
        >
          Fn
        </button>
      </div>
    </div>
  );
}

function SoftKeyButton({
  label,
  title,
  danger,
  onClick,
}: {
  label: string;
  title?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "h-11 min-w-11 shrink-0 rounded-md border bg-bg px-2 text-xs",
        danger ? "border-bad/70 text-bad" : "border-line"
      )}
      onPointerDown={event => event.preventDefault()}
      onClick={onClick}
      title={title}
    >
      {label}
    </button>
  );
}

export const TerminalPane = memo(TerminalPaneImpl);
