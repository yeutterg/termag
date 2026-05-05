'use client';

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

interface TerminalPaneProps {
  sessionId: string;
  active: boolean;
  title: string;
  status?: string;
}

export function TerminalPane({ sessionId, active, title, status }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!active || !hostRef.current) return;
    const term = new Terminal({
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

    let disposed = false;
    const raf = requestAnimationFrame(() => {
      if (disposed) return;
      fit.fit();
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws/terminal?sessionId=${sessionId}&cols=${term.cols}&rows=${term.rows}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        fit.fit();
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        term.focus();
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') term.write(msg.data);
        if (msg.type === 'sleeping') term.write(`\r\n${msg.message}\r\n`);
        if (msg.type === 'exit') term.write('\r\n[session ended]\r\n');
      };
      ws.onclose = () => {
        setConnected(false);
        if (!disposed) term.write('\r\n[disconnected]\r\n');
      };
      ws.onerror = () => {
        if (!disposed) term.write('\r\n[connection error]\r\n');
      };

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      });
    });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (disposed) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fit.fit();
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      }, 120);
    });
    observer.observe(hostRef.current);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      wsRef.current?.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      setConnected(false);
    };
  }, [active, sessionId]);

  return (
    <section className="flex min-h-0 flex-1 flex-col border-l border-line first:border-l-0">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-panel2 px-3 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-good' : 'bg-muted'}`} />
          <span className="truncate font-medium">{title}</span>
        </div>
        <span className="text-muted">{status ?? 'sleeping'}</span>
      </header>
      <div ref={hostRef} className="min-h-0 flex-1 bg-[#07090d]" />
    </section>
  );
}
