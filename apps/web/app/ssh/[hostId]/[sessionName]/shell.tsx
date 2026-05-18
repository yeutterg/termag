'use client';

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
  return (
    <div className="flex h-screen w-screen flex-col bg-bg text-text">
      <header className="flex items-center justify-between border-b border-line bg-panel px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">
            {hostName} <span className="text-muted">/ {sessionName}</span>
          </div>
          <div className="truncate text-xs text-muted">{hostLabel} — ssh + tmux attach</div>
        </div>
        <div className="text-xs text-muted">⌨️ keystrokes go straight to the remote tmux session</div>
      </header>
      <main className="min-h-0 flex-1">
        <TerminalPane
          sessionId={stableKey}
          active
          title={`${hostName}:${sessionName}`}
          hideHeader
          ssh={{ hostId, tmuxName: sessionName }}
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
