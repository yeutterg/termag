"use client";

import { useState } from "react";
import { Check, Copy, Eye, Share2 } from "lucide-react";
import { TerminalPane } from "@/components/terminal/terminal-pane";

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
  const [shareUrl, setShareUrl] = useState("");
  const [shareExpires, setShareExpires] = useState("");
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState("");
  const [shareCopied, setShareCopied] = useState(false);

  async function mintShareLink() {
    setSharing(true);
    setShareError("");
    try {
      const res = await fetch("/api/share-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sshHostId: hostId, tmuxName: sessionName }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setShareError(body?.error || `Could not mint share link (HTTP ${res.status})`);
        return;
      }
      setShareUrl(body.url || "");
      setShareExpires(body.expiresAt || "");
    } finally {
      setSharing(false);
    }
  }

  async function copyShareUrl() {
    if (!shareUrl) {
      return;
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {}
    setShareCopied(true);
    window.setTimeout(() => setShareCopied(false), 1500);
  }

  return (
    <div className="flex h-[var(--termag-viewport-height)] w-full flex-col bg-bg text-text">
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
          <div className="text-xs text-muted">
            ⌨️ keystrokes go straight to the remote tmux session
          </div>
          {/* Share: mints a TTL'd read-only link for the same tmux
              session. Anyone with the link gets a view-only attach via
              the broker's share-terminal WS endpoint. */}
          <button
            type="button"
            onClick={mintShareLink}
            disabled={sharing}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-bg px-2 text-xs hover:bg-panel2 disabled:opacity-60"
            title="Mint a 30-minute read-only share link"
          >
            <Share2 className="h-3 w-3" />
            {sharing ? "Minting…" : "Share"}
          </button>
        </div>
      </header>
      {(shareUrl || shareError) && (
        <div className="border-b border-line bg-panel2 px-3 py-2 text-xs">
          {shareError && <div className="text-bad">{shareError}</div>}
          {shareUrl && (
            <div className="flex items-center gap-2">
              <span className="text-muted">
                Read-only link{" "}
                {shareExpires ? `(expires ${new Date(shareExpires).toLocaleTimeString()})` : ""}:
              </span>
              <code className="min-w-0 flex-1 break-all font-mono text-[11px]">{shareUrl}</code>
              <button
                type="button"
                onClick={copyShareUrl}
                className="inline-flex h-6 items-center gap-1 rounded border border-line bg-bg px-2 text-[10px] hover:bg-panel"
              >
                {shareCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {shareCopied ? "Copied" : "Copy"}
              </button>
            </div>
          )}
        </div>
      )}
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
        Close this tab to detach. The remote tmux session keeps running; reopen anytime to
        re-attach.
      </footer>
    </div>
  );
}
