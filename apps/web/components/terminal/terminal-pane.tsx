'use client';

import { useEffect, useRef, useState } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';

interface TerminalPaneProps {
  sessionId: string;
  active: boolean;
  title: string;
  status?: string;
}

export function TerminalPane({ sessionId, active, title, status }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!active || !hostRef.current) return;
    let disposed = false;
    let term: XTerm | null = null;
    let raf = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: ResizeObserver | null = null;
    let onKill: ((event: Event) => void) | null = null;

    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links')
      ]);
      if (disposed || !hostRef.current) return;

      term = new Terminal({
        allowTransparency: true,
        cursorBlink: true,
        fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, monospace',
        fontSize: 13,
        scrollback: 10000,
        theme: {
          background: '#00000000',
          foreground: '#d8dee9',
          cursor: '#7dd3fc',
          selectionBackground: '#334155'
        }
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(hostRef.current);
      termRef.current = term;

      raf = requestAnimationFrame(() => {
      if (disposed) return;
      fit.fit();
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws/terminal?sessionId=${sessionId}&cols=${term!.cols}&rows=${term!.rows}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        fit.fit();
        ws.send(JSON.stringify({ type: 'resize', cols: term!.cols, rows: term!.rows }));
        term!.focus();
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') term!.write(msg.data);
        if (msg.type === 'sleeping') term!.write(`\r\n${msg.message}\r\n`);
        if (msg.type === 'exit') term!.write('\r\n[session ended]\r\n');
      };
      ws.onclose = () => {
        setConnected(false);
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
      term?.dispose();
      termRef.current = null;
      setConnected(false);
    };
  }, [active, sessionId]);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-sm">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-line bg-panel px-3 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-good' : 'bg-muted'}`} />
          <span className="truncate font-medium">{title}</span>
        </div>
        <span className="rounded-md bg-panel2 px-2 py-1 text-muted">{status ?? 'sleeping'}</span>
      </header>
      <div ref={hostRef} className="min-h-0 flex-1 bg-[#101217]" />
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
