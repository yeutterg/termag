'use client';

import { Eye, Clock } from 'lucide-react';
import { TerminalPane } from '@/components/terminal/terminal-pane';
import { useEffect, useState } from 'react';

interface ShareAttachShellProps {
  code: string;
  hostName: string;
  sessionName: string;
  expiresAt: string;
}

export function ShareAttachShell({ code, hostName, sessionName, expiresAt }: ShareAttachShellProps) {
  const stableKey = `share:${code}`;
  const [subscriberCount, setSubscriberCount] = useState(1);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  const expiresInMs = new Date(expiresAt).getTime() - now;
  const expired = expiresInMs <= 0;

  return (
    <div className="flex h-screen w-screen flex-col bg-bg text-text">
      <header className="flex items-center justify-between border-b border-line bg-panel px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">
            {hostName} <span className="text-muted">/ {sessionName}</span>
            <span className="ml-2 rounded-md bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-warn">read-only</span>
          </div>
          <div className="truncate text-xs text-muted">shared session — input is disabled</div>
        </div>
        <div className="flex items-center gap-3">
          {subscriberCount > 1 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-line bg-bg px-2 py-0.5 text-xs text-muted">
              <Eye className="h-3 w-3" />
              {subscriberCount}
            </span>
          )}
          <span className={expired ? 'inline-flex items-center gap-1 text-xs text-bad' : 'inline-flex items-center gap-1 text-xs text-muted'}>
            <Clock className="h-3 w-3" />
            {expired ? 'expired' : formatRemaining(expiresInMs)}
          </span>
        </div>
      </header>
      <main className="min-h-0 flex-1">
        {!expired ? (
          <TerminalPane
            sessionId={stableKey}
            active
            title={`share:${hostName}:${sessionName}`}
            hideHeader
            share={{ code }}
            onSubscriberCount={setSubscriberCount}
          />
        ) : (
          <div className="grid h-full place-items-center px-4 text-center text-sm text-muted">
            This share link has expired. Ask the owner to mint a new one.
          </div>
        )}
      </main>
    </div>
  );
}

function formatRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m ${s}s`;
}
