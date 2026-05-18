'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { TouchEvent as ReactTouchEvent } from 'react';
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
  /**
   * When set, the pane connects to the SSH-attach WebSocket endpoint
   * (`/api/ws/ssh-terminal`) instead of the per-session endpoint. The
   * `sessionId` prop is still required (used as the local React key /
   * title-change identifier) but ignored for routing.
   */
  ssh?: { hostId: string; tmuxName: string };
}

function TerminalPaneImpl({ sessionId, active, title, status, onTitleChange, hideHeader, ssh }: TerminalPaneProps) {
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
    let fatalMessage = '';

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
      // SSH attaches use a separate endpoint with hostId+tmuxName instead
      // of sessionId. The broker's protocol from this point on is the
      // same (binary frames for output, JSON for control), so nothing
      // else in this component needs to branch.
      const wsUrl = ssh
        ? `${protocol}//${window.location.host}/api/ws/ssh-terminal?hostId=${encodeURIComponent(ssh.hostId)}&tmuxName=${encodeURIComponent(ssh.tmuxName)}&cols=${term.cols}&rows=${term.rows}`
        : `${protocol}//${window.location.host}/api/ws/terminal?sessionId=${sessionId}&cols=${term.cols}&rows=${term.rows}${saveDataHint}`;
      const ws = new WebSocket(wsUrl);
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
        if (msg.type === 'fatal') {
          fatalMessage = msg.message || 'terminal unavailable';
          term!.write(`\r\n\x1b[31m[${fatalMessage}]\x1b[0m\r\n`);
          try { ws.close(1008, 'terminal unavailable'); } catch {}
        }
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
          const reason = fatalMessage || event.reason || 'session unavailable';
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
  }, [active, sessionId, ssh?.hostId, ssh?.tmuxName]);

  function claimDrive() {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN && !driverState?.readOnly) {
      ws.send(JSON.stringify({ type: 'claim-drive' }));
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
    if (!start) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    // 80px threshold + dominant horizontal axis (3:1) keeps accidental
    // vertical scrolls / pinches from firing tab switches.
    if (Math.abs(dx) < 80 || Math.abs(dx) < Math.abs(dy) * 3) return;
    window.dispatchEvent(new CustomEvent('termag:tab-swipe', {
      detail: { direction: dx < 0 ? 'next' : 'prev' }
    }));
  }, []);

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
        onInput={(data) => {
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data }));
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
const ESC = '\u001b';

const MOBILE_PRIMARY_KEYS: Array<[string, string]> = [
  ['Esc', ESC],
  ['Tab', '\t'],
  ['←', `${ESC}[D`],
  ['↓', `${ESC}[B`],
  ['↑', `${ESC}[A`],
  ['→', `${ESC}[C`],
  ['C-c', '\u0003'],
  ['C-d', '\u0004']
];

const MOBILE_SECONDARY_KEYS: Array<[string, string, string?]> = [
  ['C-a', '\u0001', 'start of line'],
  ['C-e', '\u0005', 'end of line'],
  ['C-w', '\u0017', 'delete word back'],
  ['C-u', '\u0015', 'delete line back'],
  ['C-k', '\u000b', 'delete line forward'],
  ['C-r', '\u0012', 'reverse search'],
  ['C-l', '\u000c', 'clear'],
  ['C-z', '\u001a', 'suspend'],
  ['PgUp', `${ESC}[5~`],
  ['PgDn', `${ESC}[6~`],
  ['Home', `${ESC}[H`],
  ['End', `${ESC}[F`],
  ['Del', `${ESC}[3~`],
  ['Ins', `${ESC}[2~`]
];

// F1-F4 use xterm SS3 (ESC O P..S); F5-F12 use CSI (ESC [ NN ~).
const MOBILE_FN_KEYS: Array<[string, string]> = [
  ['F1', `${ESC}OP`], ['F2', `${ESC}OQ`], ['F3', `${ESC}OR`], ['F4', `${ESC}OS`],
  ['F5', `${ESC}[15~`], ['F6', `${ESC}[17~`], ['F7', `${ESC}[18~`], ['F8', `${ESC}[19~`],
  ['F9', `${ESC}[20~`], ['F10', `${ESC}[21~`], ['F11', `${ESC}[23~`], ['F12', `${ESC}[24~`]
];

function MobileSoftKeys({ onInput }: { onInput: (data: string) => void }) {
  const [expanded, setExpanded] = useState<'none' | 'extras' | 'fn'>('none');
  return (
    <div className="md:hidden">
      {expanded === 'fn' && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-line bg-panel2 px-2 py-1">
          {MOBILE_FN_KEYS.map(([label, data]) => (
            <SoftKeyButton key={label} label={label} onClick={() => onInput(data)} />
          ))}
        </div>
      )}
      {expanded === 'extras' && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-line bg-panel2 px-2 py-1">
          {MOBILE_SECONDARY_KEYS.map(([label, data, title]) => (
            <SoftKeyButton key={label} label={label} title={title} onClick={() => onInput(data)} />
          ))}
        </div>
      )}
      <div className="flex h-10 shrink-0 items-center gap-1 border-t border-line bg-panel2 px-2">
        {MOBILE_PRIMARY_KEYS.map(([label, data]) => (
          <SoftKeyButton key={label} label={label} onClick={() => onInput(data)} />
        ))}
        <button
          type="button"
          className="ml-auto h-7 min-w-8 rounded-md border border-line bg-bg px-2 text-xs"
          onClick={() => setExpanded((current) => (current === 'extras' ? 'none' : 'extras'))}
          aria-pressed={expanded === 'extras'}
          title="More keys"
        >
          {expanded === 'extras' ? '×' : '⋯'}
        </button>
        <button
          type="button"
          className="h-7 min-w-8 rounded-md border border-line bg-bg px-2 text-xs"
          onClick={() => setExpanded((current) => (current === 'fn' ? 'none' : 'fn'))}
          aria-pressed={expanded === 'fn'}
          title="Function keys"
        >
          Fn
        </button>
      </div>
    </div>
  );
}

function SoftKeyButton({ label, title, onClick }: { label: string; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="h-7 min-w-8 rounded-md border border-line bg-bg px-2 text-xs"
      onClick={onClick}
      title={title}
    >
      {label}
    </button>
  );
}

export const TerminalPane = memo(TerminalPaneImpl);
