'use client';

import { memo, useEffect, useRef } from 'react';
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
  // Capture latest onTitleChange so the xterm listener (set up once) always
  // invokes the current callback without rebinding the terminal.
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;

  useEffect(() => {
    if (!active || !hostRef.current) return;
    let disposed = false;
    let term: XTerm | null = null;
    let raf = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: ResizeObserver | null = null;
    let onKill: ((event: Event) => void) | null = null;
    let onVisibilityRef: (() => void) | null = null;
    let themeObserverRef: MutationObserver | null = null;

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

      raf = requestAnimationFrame(() => {
      if (disposed) return;
      fit.fit();
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // Hint the broker to trim initial scrollback when the user is on a
      // metered/cellular connection or has Low Data Mode on. UA-based phone
      // detection happens server-side too — both fire the same trim path.
      type ConnectionLike = { saveData?: boolean; effectiveType?: string };
      const conn = (navigator as Navigator & { connection?: ConnectionLike }).connection;
      const saveDataHint = conn?.saveData || /^(slow-2g|2g|3g)$/.test(conn?.effectiveType ?? '') ? '&saveData=1' : '';
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws/terminal?sessionId=${sessionId}&cols=${term!.cols}&rows=${term!.rows}${saveDataHint}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        fit.fit();
        ws.send(JSON.stringify({ type: 'resize', cols: term!.cols, rows: term!.rows }));
        term!.focus();
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
      };
      ws.onclose = () => {
        if (!disposed) term!.write('\r\n[disconnected]\r\n');
      };
      ws.onerror = () => {
        if (!disposed) term!.write('\r\n[connection error]\r\n');
      };

      term!.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      });

      onKill = (event: Event) => {
        const custom = event as CustomEvent<{ sessionId: string }>;
        if (custom.detail?.sessionId === sessionId && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'kill' }));
        }
      };
      window.addEventListener('termag:kill-session', onKill);

      // Pause the output stream when the tab/app is hidden — saves a lot of
      // cellular data when a phone is locked or backgrounded. Broker buffers
      // up to 64 KB; older bytes drop, the next visible frame includes a
      // [output trimmed while paused] marker.
      const onVisibility = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
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
      });
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
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

  return (
    <section className={cn('flex min-h-0 flex-1 flex-col overflow-hidden bg-bg', !hideHeader && 'rounded-lg border border-line')}>
      {!hideHeader && (
        <header className="flex h-9 shrink-0 items-center justify-between bg-panel px-3 text-xs">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn('h-1.5 w-1.5 rounded-full', statusDot(status))} />
            <span className="truncate font-medium">{title}</span>
          </div>
          <span className="font-mono text-[10px] text-muted">{status ?? 'sleeping'}</span>
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
