"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";
import type { ITheme, Terminal as XTerm } from "@xterm/xterm";
import { prefersLowDataMode } from "@/lib/mobile-data";
import { detectPlatformFromUserAgent } from "@/lib/platform";
import { cn, statusDot } from "@/lib/utils";

// Palettes hoisted so they're stable references — set as term.options.theme
// on init AND swapped live whenever the html.dark class flips.
const DARK_THEME: ITheme = {
  background: "#0A0A0A",
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
  background: "#FFFFFF",
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
const FILE_UPLOAD_CHUNK_BYTES = 192 * 1024;
const FILE_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
const FILE_UPLOAD_MAX_FILES = 20;
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
  /** Locally echo simple composer edits until the authoritative Herdr tail arrives. */
  optimisticInput?: boolean;
}

function TerminalPaneImpl({
  sessionId,
  active,
  title,
  status,
  onTitleChange,
  hideHeader,
  optimisticInput = false,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Driver/read-only state is null until the agent's first driver-changed
  // message arrives. The most recent focus/click/keystroke owns the
  // single-writer lease; only a true read-only state needs UI.
  const [driverState, setDriverState] = useState<{ driver: boolean; readOnly: boolean } | null>(
    null
  );
  const driverStateRef = useRef<{ driver: boolean; readOnly: boolean } | null>(null);
  const [pageActive, setPageActive] = useState(true);
  const [connectionIssue, setConnectionIssue] = useState<{
    fatal: boolean;
    message: string;
  } | null>(null);
  const manualReconnectRef = useRef<(() => void) | null>(null);
  // xterm receives programmatic focus after its first connection so keyboard
  // users can type immediately. That focus must not claim Herdr's controller
  // lease: merely opening Terminalz should remain an observer and must not
  // resize the terminal shown in the native Herdr app.
  const suppressFocusClaimRef = useRef(false);
  const uploadWaitersRef = useRef(
    new Map<
      string,
      {
        socket: WebSocket;
        resolve: (path: string) => void;
        reject: (error: Error) => void;
      }
    >()
  );
  const inputWaitersRef = useRef(
    new Map<
      string,
      {
        socket: WebSocket;
        resolve: () => void;
        reject: (error: Error) => void;
      }
    >()
  );
  const optimisticEchoRef = useRef<(data: string) => void>(() => {});
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Capture latest onTitleChange so the xterm listener (set up once) always
  // invokes the current callback without rebinding the terminal.
  const onTitleChangeRef = useRef(onTitleChange);

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  useEffect(() => subscribePageActivity(setPageActive), []);

  useEffect(() => {
    if (!active || !pageActive || !hostRef.current) {
      return;
    }
    const lowData = prefersLowDataMode();
    let disposed = false;
    let term: XTerm | null = null;
    let fitAddon: { fit: () => void } | null = null;
    let raf = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: ResizeObserver | null = null;
    let onVisibilityRef: (() => void) | null = null;
    let onOnlineRef: (() => void) | null = null;
    let onWindowBlurRef: (() => void) | null = null;
    let onWindowFocusRef: (() => void) | null = null;
    let onPageShowRef: ((event: PageTransitionEvent) => void) | null = null;
    let onVisualViewportRef: (() => void) | null = null;
    let unsubscribeTheme: (() => void) | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let titleTimer: ReturnType<typeof setTimeout> | null = null;
    let checkpointFollowTimer: ReturnType<typeof setTimeout> | null = null;
    let wakeWatchdog: ReturnType<typeof setInterval> | null = null;
    let pendingTitle = "";
    let reconnectAttempts = 0;
    let connectedAt = 0;
    let lastSocketActivity = 0;
    let fatalMessage = "";
    let resyncRequested = false;
    let queuedWriteBytes = 0;
    let parserPaused = false;
    let visibilityPaused = document.visibilityState === "hidden";
    let brokerPaused = false;
    let followCheckpoint = false;
    let checkpointScrollOffset = 0;
    let optimisticSinceCheckpoint = false;
    let optimisticBackground = "";

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

    function writeTerminal(
      data: string | Uint8Array,
      followBottom = false,
      restoreCursor = "",
      restoreScrollOffset = 0
    ) {
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
        const restoreScroll = () => {
          if (!term || disposed) {
            return;
          }
          if (followBottom) {
            term.scrollToBottom();
          } else if (restoreScrollOffset > 0) {
            term.scrollToLine(Math.max(0, term.buffer.active.baseY - restoreScrollOffset));
          }
        };
        if (restoreCursor && !disposed && term) {
          // Reapply the authoritative cursor after scrollToBottom. Some xterm
          // renderers otherwise paint the cursor at the final footer write
          // even though the checkpoint's last CSI moved it into the composer.
          term.write(restoreCursor, restoreScroll);
        } else {
          restoreScroll();
        }
        if (parserPaused && queuedWriteBytes <= XTERM_WRITE_RESUME_BYTES) {
          parserPaused = false;
          if (!disposed) {
            syncBrokerPause();
          }
        }
      });
    }

    function echoOptimisticInput(data: string) {
      if (!optimisticInput || !term || disposed) {
        return;
      }
      if (/^[^\u0000-\u001f\u007f]+$/u.test(data)) {
        if (!optimisticSinceCheckpoint) {
          // Removes Codex's placeholder (or any stale cells after the real
          // cursor) before the first locally-echoed character.
          writeTerminal(`${optimisticBackground}\x1b[K`);
        }
        optimisticSinceCheckpoint = true;
        writeTerminal("\x1b[?25h");
        writeTerminal(data);
      } else if (data === "\u007f" || data === "\b") {
        optimisticSinceCheckpoint = true;
        writeTerminal(`${optimisticBackground}\x1b[?25h`);
        writeTerminal("\b \b");
      }
    }
    optimisticEchoRef.current = echoOptimisticInput;

    function rejectPendingTransfers(message: string, socket?: WebSocket) {
      for (const [key, waiter] of uploadWaitersRef.current) {
        if (!socket || waiter.socket === socket) {
          uploadWaitersRef.current.delete(key);
          waiter.reject(new Error(message));
        }
      }
      for (const [key, waiter] of inputWaitersRef.current) {
        if (!socket || waiter.socket === socket) {
          inputWaitersRef.current.delete(key);
          waiter.reject(new Error(message));
        }
      }
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
    // All input sites (term.onData, onVisibility, ResizeObserver) read
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
      const params = new URLSearchParams({
        sessionId,
        cols: String(term.cols),
        rows: String(term.rows),
        ...(lowData ? { dataMode: "low" } : {}),
      });
      const wsUrl = `${protocol}//${window.location.host}/api/ws/terminal?${params}`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (error) {
        setConnectionIssue({
          fatal: true,
          message: error instanceof Error ? error.message : "Unable to open terminal connection",
        });
        return;
      }
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        connectedAt = Date.now();
        lastSocketActivity = connectedAt;
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
        driverStateRef.current = null;
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
          suppressFocusClaimRef.current = true;
          term!.focus();
          queueMicrotask(() => {
            suppressFocusClaimRef.current = false;
          });
        }
      };
      ws.onmessage = event => {
        lastSocketActivity = Date.now();
        // Binary frames carry raw terminal output (no JSON wrapper). Text
        // frames carry control messages — ready/sleeping/exit/refresh.
        if (typeof event.data !== "string") {
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          const decoded = new TextDecoder().decode(bytes);
          const tail = decoded.slice(-64);
          const cursor = tail.match(/(\x1b\[\d+;\d+H\x1b\[\?25h)$/)?.[1] ?? "";
          if (optimisticInput && followCheckpoint) {
            const backgrounds = [...decoded.matchAll(/\x1b\[(?:48;2;\d+;\d+;\d+|48;5;\d+)m/g)];
            optimisticBackground = backgrounds.at(-1)?.[0] ?? optimisticBackground;
          }
          writeTerminal(bytes, followCheckpoint, cursor, checkpointScrollOffset);
          if (followCheckpoint) {
            if (checkpointFollowTimer) {
              clearTimeout(checkpointFollowTimer);
            }
            checkpointFollowTimer = setTimeout(() => {
              followCheckpoint = false;
              checkpointFollowTimer = null;
            }, 250);
          }
          return;
        }
        let msg: {
          type?: string;
          data?: string;
          message?: string;
          uploadId?: string;
          offset?: number;
          path?: string;
          inputId?: string;
        };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        // Full checkpoint payloads already begin with RIS. Do not clear xterm
        // when this control message arrives: the payload is a separate
        // WebSocket message, and clearing here exposes an empty black frame on
        // every interactive Herdr redraw. Parsing reset + replacement content
        // together keeps the update visually atomic.
        if (msg.type === "checkpoint") {
          const buffer = term?.buffer.active;
          checkpointScrollOffset = buffer ? Math.max(0, buffer.baseY - buffer.viewportY) : 0;
          followCheckpoint = checkpointScrollOffset === 0;
          optimisticSinceCheckpoint = false;
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
        if (msg.type === "driver-changed") {
          // Multi-subscriber model: agent's SessionStream broadcasts on every
          // driver change so each viewer knows whether they're driving or
          // riding along. UI just reads two flags out of state.
          const nextDriverState = {
            driver: Boolean((msg as { driver?: unknown }).driver),
            readOnly: Boolean((msg as { readOnly?: unknown }).readOnly),
          };
          driverStateRef.current = nextDriverState;
          setDriverState(nextDriverState);
        }
        if (
          (msg.type === "file-upload-complete" || msg.type === "file-upload-error") &&
          msg.uploadId &&
          Number.isSafeInteger(msg.offset)
        ) {
          const key = `${msg.uploadId}:${msg.offset}`;
          const waiter = uploadWaitersRef.current.get(key);
          uploadWaitersRef.current.delete(key);
          if (msg.type === "file-upload-complete" && msg.path) {
            waiter?.resolve(msg.path);
          } else {
            waiter?.reject(new Error(msg.message || "Upload failed"));
          }
        }
        if (
          (msg.type === "terminal-input-complete" || msg.type === "terminal-input-error") &&
          msg.inputId
        ) {
          const waiter = inputWaitersRef.current.get(msg.inputId);
          inputWaitersRef.current.delete(msg.inputId);
          if (msg.type === "terminal-input-complete") {
            waiter?.resolve();
          } else {
            waiter?.reject(new Error(msg.message || "Terminal did not accept the uploaded path"));
          }
        }
      };
      ws.onclose = event => {
        if (disposed) {
          return;
        }
        // Reject only work sent through this socket. A replacement may have
        // already started another upload using the component-level waiter
        // maps, and a delayed close from the old socket must not cancel it.
        rejectPendingTransfers("Terminal disconnected during file attachment", ws);
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

    function reconnectImmediately(force = false) {
      if (disposed || !term) {
        return;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const current = wsRef.current;
      if (current?.readyState === WebSocket.OPEN && !force) {
        return;
      }
      if (current) {
        wsRef.current = null;
        current.close();
      }
      connectWS();
    }

    function reconnectAfterWake(force = false) {
      scheduleFit();
      const stale = lastSocketActivity > 0 && Date.now() - lastSocketActivity > 30_000;
      reconnectImmediately(force || stale);
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
      term = new Terminal({
        allowTransparency: false,
        cursorBlink: true,
        fontFamily,
        fontSize: 12,
        lineHeight: 1,
        scrollback: lowData ? 500 : 2000,
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
      if (detectPlatformFromUserAgent(navigator.userAgent).isMac) {
        term.attachCustomKeyEventHandler(event => {
          if (event.type !== "keydown" || event.ctrlKey || event.metaKey) {
            return true;
          }
          if (event.key === "Enter" && event.shiftKey && !event.altKey) {
            event.preventDefault();
            sendInput("\x1b[13;2u");
            return false;
          }
          if (!event.altKey || event.shiftKey) {
            return true;
          }
          const data =
            event.key === "Backspace"
              ? "\x1b\x7f"
              : event.key === "ArrowLeft"
                ? "\x1bb"
                : event.key === "ArrowRight"
                  ? "\x1bf"
                  : null;
          if (!data) {
            return true;
          }
          event.preventDefault();
          sendInput(data);
          return false;
        });
      }
      if (!lowData && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
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
        echoOptimisticInput(data);
        sendInput(data);
      });

      // Pause the output stream when the tab/app is hidden — saves a lot of
      // cellular data when a phone is locked or backgrounded. The broker
      // keeps a bounded tail and requests a fresh runtime checkpoint if the
      // stream overflows while paused.
      const onVisibility = () => {
        const wasHidden = visibilityPaused;
        visibilityPaused = document.visibilityState === "hidden";
        if (visibilityPaused && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "release-drive" }));
        }
        syncBrokerPause();
        if (!visibilityPaused) {
          reconnectAfterWake(wasHidden);
        }
      };
      document.addEventListener("visibilitychange", onVisibility);
      onVisibilityRef = onVisibility;

      const onOnline = () => reconnectAfterWake(true);
      window.addEventListener("online", onOnline);
      onOnlineRef = onOnline;

      const onWindowBlur = () => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "release-drive" }));
        }
      };
      window.addEventListener("blur", onWindowBlur);
      onWindowBlurRef = onWindowBlur;

      const onWindowFocus = () => reconnectAfterWake();
      window.addEventListener("focus", onWindowFocus);
      onWindowFocusRef = onWindowFocus;

      const onPageShow = (event: PageTransitionEvent) => reconnectAfterWake(event.persisted);
      window.addEventListener("pageshow", onPageShow);
      onPageShowRef = onPageShow;

      wakeWatchdog = setInterval(() => {
        if (document.visibilityState !== "visible") {
          return;
        }
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          if (lastSocketActivity > 0 && Date.now() - lastSocketActivity > 30_000) {
            reconnectImmediately(true);
          } else {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        } else {
          reconnectImmediately();
        }
      }, 15_000);

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
    })().catch(error => {
      console.error("[termag] terminal initialization failed", error);
      setConnectionIssue({
        fatal: true,
        message: error instanceof Error ? error.message : "Terminal initialization failed",
      });
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (titleTimer) {
        clearTimeout(titleTimer);
      }
      if (checkpointFollowTimer) {
        clearTimeout(checkpointFollowTimer);
      }
      if (wakeWatchdog) {
        clearInterval(wakeWatchdog);
      }
      observer?.disconnect();
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      rejectPendingTransfers("Terminal closed during file attachment");
      wsRef.current?.close();
      wsRef.current = null;
      if (onVisibilityRef) {
        document.removeEventListener("visibilitychange", onVisibilityRef);
      }
      if (onOnlineRef) {
        window.removeEventListener("online", onOnlineRef);
      }
      if (onWindowBlurRef) {
        window.removeEventListener("blur", onWindowBlurRef);
      }
      if (onWindowFocusRef) {
        window.removeEventListener("focus", onWindowFocusRef);
      }
      if (onPageShowRef) {
        window.removeEventListener("pageshow", onPageShowRef);
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
      if (optimisticEchoRef.current === echoOptimisticInput) {
        optimisticEchoRef.current = () => {};
      }
    };
  }, [active, optimisticInput, pageActive, sessionId]);

  function claimDrive() {
    const ws = wsRef.current;
    if (
      suppressFocusClaimRef.current ||
      ws?.readyState !== WebSocket.OPEN ||
      driverStateRef.current?.readOnly
    ) {
      return;
    }
    // Send even when our cached state says we are the driver. Another viewer
    // may have focused the same terminal a moment ago and its state update can
    // still be in flight; server ordering makes the latest interaction win.
    ws.send(JSON.stringify({ type: "claim-drive" }));
  }

  function sendInput(data: string, echoInBrowser = false): boolean {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN || driverStateRef.current?.readOnly) {
      return false;
    }
    // terminal-input is an atomic claim+write at the agent. That makes the
    // latest keystroke authoritative without a second browser→broker frame or
    // a race where control changes between separate claim and input messages.
    if (echoInBrowser) {
      optimisticEchoRef.current(data);
    }
    sendTerminalInput(ws, data);
    return true;
  }

  function uploadChunk(file: File, uploadId: string, offset: number, data: string) {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Terminal is not connected"));
    }
    return new Promise<string>((resolve, reject) => {
      const key = `${uploadId}:${offset}`;
      uploadWaitersRef.current.set(key, { socket: ws, resolve, reject });
      ws.send(
        JSON.stringify({ type: "file-upload-chunk", uploadId, fileName: file.name, offset, data })
      );
    });
  }

  function insertUploadedPath(path: string) {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN || driverStateRef.current?.readOnly) {
      return Promise.reject(new Error("File uploaded, but the terminal is not accepting input"));
    }
    const inputId = crypto.randomUUID().replaceAll("-", "");
    const displayPath = `'${path.replaceAll("'", `'\\''`)}' `;
    // Bracketed paste is essential for coding-agent TUIs. Codex turns an
    // explicitly pasted image path into a real image attachment; ordinary
    // typed characters only leave path text in the composer. Shells and other
    // TUIs also understand bracketed paste and receive the safely quoted path.
    const data = `\x1b[200~${displayPath}\x1b[201~`;
    optimisticEchoRef.current(displayPath);
    return new Promise<void>((resolve, reject) => {
      inputWaitersRef.current.set(inputId, { socket: ws, resolve, reject });
      ws.send(JSON.stringify({ type: "input", inputId, data }));
    });
  }

  async function uploadDroppedFiles(files: FileList) {
    setUploading(true);
    try {
      const droppedFiles = Array.from(files);
      if (droppedFiles.length > FILE_UPLOAD_MAX_FILES) {
        throw new Error(`Attach at most ${FILE_UPLOAD_MAX_FILES} files at a time`);
      }
      for (const file of droppedFiles) {
        if (file.size > FILE_UPLOAD_MAX_BYTES) {
          throw new Error(`${file.name} exceeds the 16 MiB upload limit`);
        }
        const uploadId = crypto.randomUUID().replaceAll("-", "");
        let uploadedPath = "";
        for (let offset = 0; offset < Math.max(file.size, 1); offset += FILE_UPLOAD_CHUNK_BYTES) {
          const bytes = new Uint8Array(
            await file.slice(offset, offset + FILE_UPLOAD_CHUNK_BYTES).arrayBuffer()
          );
          let binary = "";
          for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
          }
          uploadedPath = await uploadChunk(file, uploadId, offset, btoa(binary));
        }
        // Insert a safely shell-quoted local path at the current cursor. This
        // is terminal input, not broker-side command execution. Unlike normal
        // keystrokes, wait for the agent to acknowledge that it accepted this
        // path so a reconnect cannot turn an upload into a false success.
        await insertUploadedPath(uploadedPath);
        termRef.current?.focus();
      }
    } catch (error) {
      setConnectionIssue({
        fatal: false,
        message: error instanceof Error ? error.message : "File upload failed",
      });
    } finally {
      setUploading(false);
    }
  }

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
      onDragEnterCapture={event => {
        event.preventDefault();
        dragDepthRef.current += 1;
        setDragActive(true);
      }}
      onDragOverCapture={event => event.preventDefault()}
      onDragLeaveCapture={event => {
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) {
          setDragActive(false);
        }
      }}
      onDropCapture={event => {
        event.preventDefault();
        event.stopPropagation();
        dragDepthRef.current = 0;
        setDragActive(false);
        if (event.dataTransfer.files.length) {
          void uploadDroppedFiles(event.dataTransfer.files);
        } else {
          setConnectionIssue({ fatal: false, message: "This drop did not contain a local file" });
        }
      }}
    >
      {connectionIssue && (
        <div className="absolute left-2 top-2 z-30 flex max-w-[calc(100%-1rem)] items-center gap-2 rounded-md border border-line bg-panel/95 px-2 py-1 text-[11px] text-muted shadow-lg backdrop-blur">
          <span className="truncate">
            {!connectionIssue.fatal && connectionIssue.message === "Connection lost"
              ? "Reconnecting…"
              : connectionIssue.message}
          </span>
          <button
            type="button"
            className="min-h-9 shrink-0 rounded border border-line bg-bg px-2 font-medium text-text hover:bg-panel2 md:min-h-7"
            onClick={() => {
              if (connectionIssue.fatal || connectionIssue.message === "Connection lost") {
                manualReconnectRef.current?.();
              } else {
                setConnectionIssue(null);
              }
            }}
          >
            {connectionIssue.fatal || connectionIssue.message === "Connection lost"
              ? "Reconnect"
              : "Dismiss"}
          </button>
        </div>
      )}
      {(dragActive || uploading) && (
        <div className="pointer-events-none absolute inset-2 z-40 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-bg/90 text-sm font-medium text-text">
          {uploading ? "Uploading attachment…" : "Drop files to attach"}
        </div>
      )}
      {hideHeader && isReadOnly && (
        <div
          className="absolute right-2 top-2 z-20 inline-flex h-6 items-center gap-1 rounded border border-line bg-panel/95 px-2 text-[10px] text-muted shadow"
          title="Read-only session"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-muted" />
          Read-only
        </div>
      )}
      {!hideHeader && (
        <header className="flex h-9 shrink-0 items-center justify-between bg-panel px-3 text-xs">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn("h-1.5 w-1.5 rounded-full", statusDot(status))} />
            <span className="truncate font-medium">{title}</span>
          </div>
          <div className="flex items-center gap-2">
            {isReadOnly && (
              <span
                className="inline-flex h-6 items-center gap-1 rounded border border-line bg-panel2 px-2 text-[10px] text-muted"
                title="Read-only session"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-muted" />
                Read-only
              </span>
            )}
            <span className="font-mono text-[10px] text-muted">{status ?? "sleeping"}</span>
          </div>
        </header>
      )}
      <div
        ref={hostRef}
        className="min-h-0 flex-1 bg-bg"
        onPointerDown={claimDrive}
        onFocusCapture={claimDrive}
        // iPad-first: two-finger horizontal swipe switches tabs. The
        // gesture dispatches a window-level CustomEvent ('termag:tab-swipe')
        // that termag-app resolves against the active project's tab order.
        // Single-finger gestures pass through to xterm for selection.
        onTouchStart={onTabSwipeStart}
        onTouchEnd={onTabSwipeEnd}
      />
      <MobileSoftKeys
        onInput={data => {
          sendInput(data);
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
