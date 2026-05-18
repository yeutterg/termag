'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NewSshHostDialog, type SshHost, colorToCss } from './new-ssh-host-dialog';
import type { AgentDeviceStatus } from './types';

interface SshHostsSectionProps {
  open: boolean;
  // Live device snapshots from the broker (used to find tmux sessions on
  // each SSH host — they arrive via the same agent-status channel).
  devices: AgentDeviceStatus[];
}

export function SshHostsSection({ open, devices }: SshHostsSectionProps) {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function reload() {
    try {
      const res = await fetch('/api/ssh-hosts');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = await res.json();
      setHosts(Array.isArray(next) ? next : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load SSH hosts');
    }
  }

  useEffect(() => {
    if (!open) return;
    setError('');
    reload();
  }, [open]);

  async function deleteHost(host: SshHost) {
    if (!window.confirm(`Remove SSH host "${host.name}"? Active sessions will be detached.`)) return;
    setBusy(host.id);
    try {
      const res = await fetch(`/api/ssh-hosts/${host.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHosts((items) => items.filter((item) => item.id !== host.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove host');
    } finally {
      setBusy('');
    }
  }

  async function testHost(host: SshHost) {
    setBusy(host.id);
    try {
      const res = await fetch(`/api/ssh-hosts/${host.id}`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        // Display the live error inline. The DB record gets updated by
        // the server side; refresh to pick it up.
        setError(body?.error || `Probe failed (HTTP ${res.status})`);
      } else {
        setError('');
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not test host');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">SSH hosts</h3>
          <p className="text-xs text-muted">Remote tmux over ssh — no agent install needed. Auth defers to your broker&apos;s ssh-agent + ~/.ssh/config.</p>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-bg px-2 text-xs text-text hover:bg-panel2"
        >
          <Plus className="h-3.5 w-3.5" />
          Add SSH host
        </button>
      </div>
      <div className="space-y-2">
        {hosts.length === 0 && (
          <div className="rounded-md border border-line bg-bg px-3 py-5 text-center text-sm text-muted">
            No SSH hosts yet.
          </div>
        )}
        {hosts.map((host) => {
          // The broker pushes ssh-host tmux sessions through the same
          // agent-status channel with kind: 'ssh', so they show up in
          // `devices` under the host name.
          const matching = devices.find((device) => device.name === host.name);
          const sessions = matching?.tmuxSessions ?? [];
          const connected = Boolean(matching?.connected);
          const accent = colorToCss(host.color);
          return (
            <div
              key={host.id}
              className="rounded-md border border-line bg-bg p-3"
              // Left border-strip carries the user's accent color when set.
              // Subtle enough not to fight the dashboard theme but obvious
              // enough to glance-distinguish prod from staging.
              style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full', connected ? 'bg-good' : 'bg-muted/40')} />
                    <span className="text-sm font-medium">{host.name}</span>
                    <span className="text-xs text-muted">{host.user}@{host.host}{host.port !== 22 ? `:${host.port}` : ''}</span>
                  </div>
                  {host.lastError && !connected && (
                    <div className="mt-1 text-xs text-bad">{host.lastError}</div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    title="Test connection"
                    disabled={busy === host.id}
                    onClick={() => testHost(host)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-panel2 disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Remove host"
                    disabled={busy === host.id}
                    onClick={() => deleteHost(host)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-bad/10 hover:text-bad disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {sessions.length > 0 && (
                <ul className="mt-2 divide-y divide-line/60 rounded-md border border-line/60">
                  {sessions.map((session) => (
                    <li key={session.name} className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
                      <span className="truncate font-mono">{session.name}</span>
                      <span className="ml-auto whitespace-nowrap text-muted">
                        {session.windowCount === 1 ? '1 window' : `${session.windowCount} windows`}
                      </span>
                      {/* Opening in a new tab avoids losing the dashboard
                          state — the tab is a thin wrapper around the
                          terminal pane in ssh mode. */}
                      <a
                        href={`/ssh/${host.id}/${encodeURIComponent(session.name)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-md border border-line bg-bg px-2 py-0.5 text-xs text-accent hover:bg-accent/10"
                      >
                        Open <ExternalLink className="h-3 w-3" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      {error && <div className="mt-3 text-xs text-bad">{error}</div>}
      <NewSshHostDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={() => { reload(); }}
      />
    </div>
  );
}
