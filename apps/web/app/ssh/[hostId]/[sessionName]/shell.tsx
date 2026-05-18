'use client';

import { useState } from 'react';
import { Eye } from 'lucide-react';
import { TerminalPane } from '@/components/terminal/terminal-pane';

interface SshAttachShellProps {
  hostId: string;
  hostName: string;
  hostLabel: string;
  sessionName: string;
}

// Thin client wrapper around TerminalPane in SSH mode. Renders full-bleed
// so the terminal fills the tab — the parent dashboard isn't in the
// picture here.
export function SshAttachShell({ hostId, hostName, hostLabel, sessionName }: SshAttachShellProps) {
  const stableKey = `ssh:${hostId}:${sessionName}`;
  const [subscriberCount, setSubscriberCount] = useState(1);
  return (
    <div className="flex h-screen w-screen flex-col bg-bg text-text">
      <header className="flex items-center justify-between border-b border-line bg-panel px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">
            {hostName} <span className="text-muted">/ {sessionName}</span>
          </div>
          <div className="truncate text-xs text-muted">{hostLabel} — ssh + tmux attach</div>
        </div>
        <div className="flex items-center gap-3">
          {subscriberCount > 1 && (
            // 👁 chip: shown only when more than one client is attached.
            // Helps users notice they're sharing the pty (or that someone
            // else just joined). Comes from the broker's
            // SshSessionStream which broadcasts on subscribe/unsubscribe.
            <span
              className="inline-flex items-center gap-1 rounded-full border border-line bg-bg px-2 py-0.5 text-xs text-muted"
              title={`${subscriberCount} clients attached to this session`}
            >
              <Eye className="h-3 w-3" />
              {subscriberCount}
            </span>
          )}
          <div className="text-xs text-muted">⌨️ keystrokes go straight to the remote tmux session</div>
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <TerminalPane
          sessionId={stableKey}
          active
          title={`${hostName}:${sessionName}`}
          hideHeader
          ssh={{ hostId, tmuxName: sessionName }}
          onSubscriberCount={setSubscriberCount}
        />
      </main>
      {/* Detach hint: closing the tab IS the detach for web — the remote
          tmux session stays alive, other subscribers keep streaming. */}
      <footer className="border-t border-line bg-panel px-3 py-1 text-xs text-muted">
        Close this tab to detach. The remote tmux session keeps running; reopen anytime to re-attach.
      </footer>
    </div>
  );
}
