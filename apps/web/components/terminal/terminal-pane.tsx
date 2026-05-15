'use client';

import { memo, useEffect, useRef, useState } from 'react';
import type { ITheme, Terminal as XTerm } from '@xterm/xterm';
import { cn, statusDot } from '@/lib/utils';

// Palettes hoisted so they're stable references — set as term.options.theme
// on init AND swapped live whenever the html.dark class flips.
const DARK_THEME: ITheme = {
  background: '#00000000',
  foreground: '#E4E4E7',
  cursor: '#FAFAFA',
  selectionBackground: '#404040',
  black: '#18181B',
  red: '#EF4444',
  green: '#22C55E',
  yellow: '#F59E0B',
  blue: '#3B82F6',
  magenta: '#A78BFA',
  cyan: '#06B6D4',
  white: '#D4D4D8',
  brightBlack: '#71717A',
  brightRed: '#F87171',
  brightGreen: '#4ADE80',
  brightYellow: '#FBBF24',
  brightBlue: '#60A5FA',
  brightMagenta: '#C4B5FD',
  brightCyan: '#22D3EE',
  brightWhite: '#FAFAFA'
};

const LIGHT_THEME: ITheme = {
  background: '#00000000',
  foreground: '#18181B',
  cursor: '#18181B',
  selectionBackground: '#D4D4D8',
  black: '#18181B',
  red: '#B91C1C',
  green: '#15803D',
  yellow: '#B45309',
  blue: '#1D4ED8',
  magenta: '#7C3AED',
  cyan: '#0E7490',
  white: '#71717A',
  brightBlack: '#52525B',
  brightRed: '#DC2626',
  brightGreen: '#16A34A',
  brightYellow: '#D97706',
  brightBlue: '#2563EB',
  brightMagenta: '#9333EA',
  brightCyan: '#0891B2',
  brightWhite: '#09090B'
};

function currentTheme(): ITheme {
  return document.documentElement.classList.contains('dark') ? DARK_THEME : LIGHT_THEME;
}

interface TerminalPaneProps {
  sessionId: string;
  active: boolean;
  title: string;
  status?: string;
  onTitleChange?: (sessionId: string, title: string) => void;
  /** Suppress the pane's own header — used when tabs above provide it. */
  hideHeader?: boolean;
}

function TerminalPaneImpl({ sessionId, active, title, status, onTitleChange, hideHeader }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Driver/read-only state is null until the agent's first driver-changed
  // message arrives, so we don't render a stale "Take control" badge during
  // the brief reconnect window. After the first message lands, we trust the
  // agent and re-render on every update.
  const [driverState, setDriverState] = useState<{ driver: boolean; readOnly: boolean } | null>(null);
  // Capture latest onTitleChange so the xterm listener (set up once) always
  // invokes the current callback without rebinding the terminal.
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;

  useEffect(() => {
    if (!active || !hostRef.current) return;
    let disposed = false;
    let term: XTerm | null = null;
    let fitAddon: { fit: () => void } | null = null;
    let raf = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: ResizeObserver | null = null;
    let onKill: ((event: Event) => void) | null = null;
    let onVisibilityRef: (() => void) | null = null;
    let themeObserverRef: MutationObserver | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;

    // WebSocket lifecycle is its own function so we can re-run it on disconnect.
    // All input sites (term.onData, onKill, onVisibility, ResizeObserver) read
    // wsRef.current at call time so they always target the latest socket — no
    // stale closure over a closed WS after a reconnect.
    function connectWS() {
      if (disposed || !term) return;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // Hint the broker to trim initial scrollback when the user is on a
      // metered/cellular connection or has Low Data Mode on.
      type ConnectionLike = { saveData?: boolean; effectiveType?: string };
      const conn = (navigator as Navigator & { connection?: ConnectionLike }).connection;
      const saveDataHint = conn?.saveData || /^(slow-2g|2g|3g)$/.test(conn?.effectiveType ?? '') ? '&saveData=1' : '';
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws/terminal?sessionId=${sessionId}&cols=${term.cols}&rows=${term.rows}${saveDataHint}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (reconnectAttempts > 0) {
          term!.write('\r\n\x1b[2m[reconnected]\x1b[0m\r\n');
        }
        const justReconnected = reconnectAttempts > 0;
        reconnectAttempts = 0;
        // Driver state is unknown until the agent's first driver-changed
        // message lands. Showing the previous connection's state would be
        // misleading after a reconnect (drive likely went to someone else).
        setDriverState(null);
        fitAddon?.fit();
        ws.send(JSON.stringify({ type: 'resize', cols: term!.cols, rows: term!.rows }));
        // If the tab was hidden when we opened (background tab, page-restore,
        // visibility flicker mid-handshake), the visibilitychange event
        // already fired before the WS was open and was dropped. Send the
        // pause now so the broker isn't burning bandwidth on an offscreen
        // viewer.
        if (document.visibilityState === 'hidden') {
          ws.send(JSON.stringify({ type: 'pause' }));
        }
        // Only steal focus on the initial connect — yanking focus mid-typing
        // when the broker hiccups would be infuriating.
        if (!justReconnected) term!.focus();
      };
      ws.onmessage = (event) => {
        // Binary frames carry raw terminal output (no JSON wrapper). Text
        // frames carry control messages — ready/sleeping/exit/refresh.
        if (typeof event.data !== 'string') {
          term!.write(new Uint8Array(event.data as ArrayBuffer));
          return;
        }
        let msg: { type?: string; data?: string; message?: string };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === 'output') term!.write(msg.data ?? ''); // legacy/control fallback
        if (msg.type === 'sleeping') term!.write(`\r\n${msg.message ?? 'Agent sleeping'}\r\n`);
        if (msg.type === 'exit') term!.write('\r\n[session ended]\r\n');
        if (msg.type === 'driver-changed') {
          // Multi-subscriber model: agent's SessionStream broadcasts on every
          // driver change so each viewer knows whether they're driving or
          // riding along. UI just reads two flags out of state.
          setDriverState({
            driver: Boolean((msg as { driver?: unknown }).driver),
            readOnly: Boolean((msg as { readOnly?: unknown }).readOnly)
          });
        }
      };
      ws.onclose = (event) => {
        if (disposed) return;
        wsRef.current = null;
        // Code 1008 (policy violation) is the broker's "this session is gone /
        // you're not authorized" signal. Retrying would just loop forever, so
        // surface the reason and stop. Anything else is treated as a transient
        // network blip and gets exponential-backoff retry.
        if (event.code === 1008) {
          const reason = event.reason || 'session unavailable';
          term!.write(`\r\n\x1b[2m[disconnected: ${reason}]\x1b[0m\r\n`);
          return;
        }
        reconnectAttempts += 1;
        if (reconnectAttempts === 1) {
          term!.write('\r\n\x1b[2m[disconnected, reconnecting…]\x1b[0m\r\n');
        }
        // Exponential backoff capped at 30s. Resets to 1s on next successful
        // open. Tab visibility doesn't pause this; the next visible tick will
        // open the new socket which fast-tracks recovery on a phone wake-up.
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempts - 1, 5));
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

    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links')
      ]);
      if (disposed || !hostRef.current) return;

      // xterm renders to <canvas>; ctx.font does NOT reliably resolve CSS
      // variables, so 'var(--font-mono)' would fall through to the next
      // hard-coded family. next/font hashes the font name (e.g. __DM_Mono_xxx),
      // so we resolve the var at runtime and pass the actual loaded family.
      const monoVar = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
      const fontFamily = [monoVar, '"DM Mono"', 'SFMono-Regular', 'Consolas', 'monospace']
        .filter(Boolean)
        .join(', ');
      term = new Terminal({
        allowTransparency: true,
        cursorBlink: true,
        fontFamily,
        fontSize: 12,
        lineHeight: 1.4,
        scrollback: 10000,
        theme: currentTheme()
      });

      // Live theme reactivity: when html.dark flips (cycleTheme button or
      // prefers-color-scheme media-query), swap palettes without recreating
      // the terminal. Without this, switching themes leaves the previous
      // foreground/brightBlack baked in until the page reloads.
      const themeObserver = new MutationObserver(() => {
        if (term) term.options.theme = currentTheme();
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      themeObserverRef = themeObserver;
      const fit = new FitAddon();
      fitAddon = fit;
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(hostRef.current);
      termRef.current = term;

      // OSC 0/2 escape sequences fire here whenever a tool inside the
      // terminal changes its window title (e.g. shells, vim, claude).
      term.onTitleChange((next) => {
        const trimmed = next?.trim();
        if (trimmed) onTitleChangeRef.current?.(sessionId, trimmed);
      });

      // Bind once: every input goes through whatever socket is currently
      // assigned to wsRef.current. After a reconnect, the new WS just gets
      // the keystrokes naturally.
      term.onData((data) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      });

      onKill = (event: Event) => {
        const custom = event as CustomEvent<{ sessionId: string }>;
        const ws = wsRef.current;
        if (custom.detail?.sessionId === sessionId && ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'kill' }));
        }
      };
      window.addEventListener('termag:kill-session', onKill);

      // Pause the output stream when the tab/app is hidden — saves a lot of
      // cellular data when a phone is locked or backgrounded. Broker buffers
      // up to 64 KB; older bytes drop, the next visible frame includes a
      // [output trimmed while paused] marker.
      const onVisibility = () => {
        const ws = wsRef.current;
        if (ws?.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: document.visibilityState === 'hidden' ? 'pause' : 'resume' }));
      };
      document.addEventListener('visibilitychange', onVisibility);
      onVisibilityRef = onVisibility;

      observer = new ResizeObserver(() => {
        if (disposed) return;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          fit.fit();
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: term!.cols, rows: term!.rows }));
          }
        }, 120);
      });
      observer.observe(hostRef.current!);

      raf = requestAnimationFrame(() => {
        if (disposed) return;
        fit.fit();
        connectWS();
      });
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      observer?.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      wsRef.current?.close();
      wsRef.current = null;
      if (onKill) window.removeEventListener('termag:kill-session', onKill);
      if (onVisibilityRef) document.removeEventListener('visibilitychange', onVisibilityRef);
      themeObserverRef?.disconnect();
      term?.dispose();
      termRef.current = null;
    };
  }, [active, sessionId]);

  function claimDrive() {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN && !driverState?.readOnly) {
      ws.send(JSON.stringify({ type: 'claim-drive' }));
    }
  }

  const showBadge = driverState !== null && !driverState.driver;
  const isReadOnly = driverState?.readOnly === true;

  return (
    <section className={cn('flex min-h-0 flex-1 flex-col overflow-hidden bg-bg', !hideHeader && 'rounded-lg border border-line')}>
      {!hideHeader && (
        <header className="flex h-9 shrink-0 items-center justify-between bg-panel px-3 text-xs">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn('h-1.5 w-1.5 rounded-full', statusDot(status))} />
            <span className="truncate font-medium">{title}</span>
          </div>
          <div className="flex items-center gap-2">
            {showBadge && (
              <button
                type="button"
                onClick={claimDrive}
                disabled={isReadOnly}
                className="inline-flex h-6 items-center gap-1 rounded border border-line bg-panel2 px-2 text-[10px] text-muted hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
                title={isReadOnly ? 'Read-only session' : 'Take keyboard control from the current driver'}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-muted" />
                {isReadOnly ? 'Read-only' : 'Take control'}
              </button>
            )}
            <span className="font-mono text-[10px] text-muted">{status ?? 'sleeping'}</span>
          </div>
        </header>
      )}
      <div ref={hostRef} className="min-h-0 flex-1 bg-bg" />
      <div className="flex h-10 shrink-0 items-center gap-1 border-t border-line bg-panel2 px-2 md:hidden">
        {[
          ['Esc', '\u001b'],
          ['Tab', '\t'],
          ['←', '\u001b[D'],
          ['↓', '\u001b[B'],
          ['↑', '\u001b[A'],
          ['→', '\u001b[C'],
          ['C-c', '\u0003'],
          ['C-d', '\u0004']
        ].map(([label, data]) => (
          <button
            key={label}
            className="h-7 min-w-8 rounded-md border border-line bg-bg px-2 text-xs"
            onClick={() => {
              const ws = wsRef.current;
              if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'input', data }));
              }
              termRef.current?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}

export const TerminalPane = memo(TerminalPaneImpl);
