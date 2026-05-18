'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, FolderCog, Plus, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentDeviceStatus, Project, Session, TmuxDeviceSession } from './types';
import { DirectoryBrowser } from './directory-browser';
import { SshHostsSection } from './ssh-hosts-section';
import { BootstrapDeviceDialog } from './bootstrap-device-dialog';
import { Zap } from 'lucide-react';

type Token = {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt?: string | null;
  defaultRootKey?: string | null;
  defaultRelativePath?: string | null;
};

interface DevicesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { email: string; name?: string | null };
  devices: AgentDeviceStatus[];
  knownDeviceNames?: string[];
  projects?: Project[];
  focusedDevice?: string | null;
  onTokenDeleted?: (tokenName: string) => void;
  onAddDevice?: () => void;
  onCleanup?: () => void | Promise<void>;
}

type MissingTarget = {
  projectId: string;
  tabId?: string;
  sessionId: string;
  projectName: string;
  label: string;
  tmuxName: string;
};

function rootHintForDevice(device?: AgentDeviceStatus) {
  const roots = device?.roots ? Object.values(device.roots).filter((value) => typeof value === 'string' && value.trim().length > 0) : [];
  return roots[0] || '<project-root>';
}

function shellSingleQuoteContent(value: string) {
  return value.replace(/'/g, "'\\''");
}

export function DevicesDialog({ open, onOpenChange, user, devices, knownDeviceNames = [], projects = [], focusedDevice, onTokenDeleted, onAddDevice, onCleanup }: DevicesDialogProps) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [copied, setCopied] = useState('');
  const [deleting, setDeleting] = useState('');
  const [cleanupError, setCleanupError] = useState('');
  const [editingDefault, setEditingDefault] = useState('');
  const [savingDefault, setSavingDefault] = useState('');
  const [bootstrapOpen, setBootstrapOpen] = useState(false);
  const deviceRefs = useRef(new Map<string, HTMLDivElement>());

  async function patchToken(tokenId: string, payload: Partial<Pick<Token, 'defaultRootKey' | 'defaultRelativePath'>>) {
    setSavingDefault(tokenId);
    try {
      const res = await fetch(`/api/agent-tokens/${tokenId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(await res.text().catch(() => 'Update failed'));
      const next = await res.json();
      setTokens((items) => items.map((item) => (item.id === tokenId ? { ...item, ...next } : item)));
    } finally {
      setSavingDefault((current) => (current === tokenId ? '' : current));
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/agent-tokens')
      .then((res) => (res.ok ? res.json() : []))
      .then((next) => {
        if (!cancelled) setTokens(Array.isArray(next) ? next : []);
      })
      .catch(() => {
        if (!cancelled) setTokens([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function copyText(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopied(id);
    window.setTimeout(() => setCopied((current) => (current === id ? '' : current)), 1500);
  }

  const deviceMap = new Map(devices.map((device) => [device.name, device]));
  const allNames = [...new Set([...knownDeviceNames, ...tokens.map((token) => token.name), ...devices.map((device) => device.name)])];
  const allNamesKey = allNames.join('\0');
  const anyConnected = devices.some((device) => device.connected);

  async function cleanup(payload: Record<string, string>, confirmMessage: string, key: string) {
    if (!window.confirm(confirmMessage)) return;
    setCleanupError('');
    setDeleting(key);
    try {
      const res = await fetch('/api/tmux/cleanup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(await res.text().catch(() => 'Cleanup failed'));
      await onCleanup?.();
    } catch (err) {
      setCleanupError(err instanceof Error ? err.message : 'Cleanup failed');
    } finally {
      setDeleting((current) => (current === key ? '' : current));
    }
  }

  useEffect(() => {
    if (!open || !focusedDevice) return;
    const frame = window.requestAnimationFrame(() => {
      deviceRefs.current.get(focusedDevice)?.scrollIntoView({ block: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [allNamesKey, focusedDevice, open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4" onClick={() => onOpenChange(false)}>
      <section className="mx-auto mt-[7vh] flex max-h-[86vh] max-w-2xl flex-col rounded-lg border border-line bg-panel p-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Devices</h2>
            <p className="text-sm text-muted">{user.email}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={cn('rounded-full px-2 py-1 text-xs', anyConnected ? 'bg-good/15 text-good' : 'bg-panel2 text-muted')}>
              {anyConnected ? `${devices.filter((device) => device.connected).length} connected` : 'No agents connected'}
            </span>
            <button
              type="button"
              onClick={() => setBootstrapOpen(true)}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-bg px-2 text-xs text-text hover:bg-panel2"
              title="One-time code: paste a command on the new device, done"
            >
              <Zap className="h-3.5 w-3.5" />
              Bootstrap
            </button>
            {onAddDevice && (
              <button
                type="button"
                onClick={() => { onOpenChange(false); onAddDevice(); }}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-bg px-2 text-xs text-text hover:bg-panel2"
                title="Create a new device token"
              >
                <Plus className="h-3.5 w-3.5" />
                Add device
              </button>
            )}
          </div>
        </div>
        <BootstrapDeviceDialog open={bootstrapOpen} onOpenChange={setBootstrapOpen} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mb-3">
            <h3 className="text-sm font-medium">Device tokens</h3>
            <p className="text-xs text-muted">One token per device. Revoke to disconnect that device.</p>
          </div>
          <div className="space-y-2">
            {allNames.length === 0 && (
              <div className="rounded-md border border-line bg-bg px-3 py-6 text-center text-sm text-muted">
                No devices yet.
                {onAddDevice && (
                  <button
                    type="button"
                    onClick={() => { onOpenChange(false); onAddDevice(); }}
                    className="ml-1 text-accent hover:underline"
                  >
                    Add your first one.
                  </button>
                )}
              </div>
            )}
            {allNames.map((name) => {
              const token = tokens.find((item) => item.name === name);
              const device = deviceMap.get(name);
              const tmuxSessions = device?.tmuxSessions ?? [];
              const missingTargets = device?.connected && device.tmuxSessions
                ? missingTargetsForDevice(name, tmuxSessions, projects)
                : [];
              const rootsJson = JSON.stringify({ [name]: rootHintForDevice(device) });
              const envTemplate = [
                'export TERMAG_URL=wss://<your-termag-host>/api/ws/agent',
                'export TERMAG_AGENT_TOKEN=tmag_REPLACE_WITH_DEVICE_TOKEN',
                `export TERMAG_AGENT_ROOTS='${shellSingleQuoteContent(rootsJson)}'`
              ].join('\n');
              const connectCommand = `termag new`;
              const sessionCommand = `termag adopt`;
              return (
                <div
                  key={name}
                  ref={(node) => {
                    if (node) deviceRefs.current.set(name, node);
                    else deviceRefs.current.delete(name);
                  }}
                  className={cn(
                    'rounded-md border border-line bg-bg p-3 text-sm',
                    focusedDevice === name && 'border-accent/60 ring-1 ring-accent/60'
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={cn('h-2 w-2 rounded-full', device?.connected ? 'bg-good' : 'bg-muted/40')} />
                        <span className="truncate font-medium">{name}</span>
                        {device?.fake && <span className="rounded bg-panel2 px-1.5 py-0.5 text-[10px] text-muted">fake</span>}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                        <span>{device?.connected ? 'Connected' : 'Sleeping'}</span>
                        <span>agent {device?.version || 'unknown'}</span>
                        {typeof device?.streamCount === 'number' && <span>{device.streamCount} streams</span>}
                        {typeof device?.memMb === 'number' && <span>{device.memMb} MB</span>}
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {token ? `token ${token.tokenPrefix}` : 'connected without a visible active token'}
                        {token?.lastUsedAt ? ` · last seen ${formatDate(token.lastUsedAt)}` : ''}
                      </div>
                    </div>
                    {token && (
                      <button
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-bad"
                        title="Revoke device token"
                        aria-label={`Revoke ${token.name} token`}
                        onClick={async () => {
                          const res = await fetch(`/api/agent-tokens/${token.id}`, { method: 'DELETE' });
                          if (!res.ok) return;
                          setTokens((items) => items.filter((item) => item.id !== token.id));
                          onTokenDeleted?.(token.name);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  {device?.roots && Object.keys(device.roots).length > 0 && (
                    <div className="mt-3 rounded-md border border-line bg-panel px-2 py-1.5 font-mono text-[11px] text-muted">
                      {Object.entries(device.roots).map(([rootName, rootPath]) => (
                        <div key={rootName} className="truncate">{rootName}: {rootPath}</div>
                      ))}
                    </div>
                  )}
                  {token && (
                    <div className="mt-3 border-t border-line pt-3">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <div className="min-w-0">
                          <div className="font-medium text-text">Default folder</div>
                          <div className="truncate text-[11px] text-muted">
                            {token.defaultRootKey
                              ? `${token.defaultRootKey}${token.defaultRelativePath ? `/${token.defaultRelativePath}` : ''}`
                              : 'Not set — picker opens at the first reported root.'}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {token.defaultRootKey && (
                            <button
                              type="button"
                              onClick={() => patchToken(token.id, { defaultRootKey: null, defaultRelativePath: null })}
                              disabled={savingDefault === token.id}
                              className="grid h-7 w-7 place-items-center rounded text-muted hover:bg-panel2 hover:text-bad disabled:opacity-50"
                              title="Clear default folder"
                              aria-label="Clear default folder"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setEditingDefault(editingDefault === token.id ? '' : token.id)}
                            disabled={!device?.connected && !token.defaultRootKey}
                            className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-bg px-2 text-[11px] text-text hover:bg-panel2 disabled:opacity-50"
                            title={device?.connected ? 'Browse to set the default folder' : 'Device must be connected to browse'}
                          >
                            <FolderCog className="h-3.5 w-3.5" />
                            {editingDefault === token.id ? 'Close' : 'Set default'}
                          </button>
                        </div>
                      </div>
                      {editingDefault === token.id && device?.connected && device.roots && Object.keys(device.roots).length > 0 && (
                        <div className="mt-2">
                          <DirectoryBrowser
                            deviceName={name}
                            roots={device.roots}
                            initialRootKey={token.defaultRootKey || Object.keys(device.roots)[0]}
                            initialRelativePath={token.defaultRelativePath || ''}
                            onSelect={async (nextRootKey, nextRelative) => {
                              await patchToken(token.id, {
                                defaultRootKey: nextRootKey || null,
                                defaultRelativePath: nextRelative || null
                              });
                              setEditingDefault('');
                            }}
                            selectLabel="Save as default"
                            disabled={savingDefault === token.id}
                          />
                        </div>
                      )}
                      {editingDefault === token.id && (!device?.connected || !device.roots || Object.keys(device.roots).length === 0) && (
                        <div className="mt-2 rounded-md border border-line bg-bg px-3 py-2 text-[11px] text-muted">
                          Device must be connected and reporting roots to pick a default. Reconnect the agent and try again.
                        </div>
                      )}
                    </div>
                  )}
                  {device?.connected && (
                    <div className="mt-3 border-t border-line pt-3">
                      <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                        <span className="font-medium text-text">tmux sessions</span>
                        <span className="font-mono text-[10px] text-muted">{tmuxSessions.length}</span>
                      </div>
                      {tmuxSessions.length === 0 ? (
                        <div className="py-1 text-xs text-muted">No tmux sessions running.</div>
                      ) : (
                        <div className="space-y-2">
                          {tmuxSessions.map((session) => (
                            <div key={session.name} className="text-xs">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="min-w-0 flex-1 truncate font-mono text-text">{session.name}</span>
                                <span className="shrink-0 text-[10px] text-muted">{session.windowCount ?? session.windows.length} windows</span>
                                <button
                                  type="button"
                                  className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted hover:bg-bad/10 hover:text-bad disabled:opacity-50"
                                  disabled={deleting === `active:${name}:${session.name}`}
                                  title={`Delete tmux session ${session.name}`}
                                  aria-label={`Delete tmux session ${session.name}`}
                                  onClick={() => cleanup(
                                    { mode: 'active', rootKey: name, tmuxSessionName: session.name },
                                    `Delete tmux session "${session.name}" on ${name}? This kills it on the device and removes any Termag project bound to it.`,
                                    `active:${name}:${session.name}`
                                  )}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                              {session.path && <div className="mt-0.5 truncate font-mono text-[10px] text-muted">{session.path}</div>}
                              {session.windows.length > 0 && (
                                <div className="mt-1 space-y-0.5">
                                  {session.windows.map((window) => (
                                    <div key={`${session.name}:${window.target || window.id || window.index}`} className="flex h-6 min-w-0 items-center gap-2 rounded bg-panel px-2 text-[11px] text-muted">
                                      <span className="w-6 shrink-0 font-mono">{window.index}</span>
                                      <span className="min-w-0 flex-1 truncate text-text">{window.name || window.id || window.target}</span>
                                      <span className="shrink-0 font-mono">{window.id || window.target}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {missingTargets.length > 0 && (
                    <div className="mt-3 border-t border-line pt-3">
                      <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                        <span className="font-medium text-bad">Missing Termag targets</span>
                        <span className="font-mono text-[10px] text-bad">{missingTargets.length}</span>
                      </div>
                      <div className="space-y-0.5">
                        {missingTargets.map((target) => (
                          <div key={`${target.projectName}:${target.label}:${target.tmuxName}`} className="flex min-w-0 items-center gap-2 rounded bg-bad/10 px-2 py-1 text-[11px]">
                            <span className="min-w-0 flex-1 truncate text-text">{target.projectName} / {target.label}</span>
                            <span className="shrink-0 truncate font-mono text-bad">{target.tmuxName}</span>
                            <button
                              type="button"
                              className="grid h-5 w-5 shrink-0 place-items-center rounded text-bad hover:bg-bad/15 disabled:opacity-50"
                              disabled={deleting === `missing:${target.sessionId}`}
                              title="Remove stale Termag record"
                              aria-label={`Remove stale Termag record for ${target.projectName} ${target.label}`}
                              onClick={() => cleanup(
                                {
                                  mode: 'missing',
                                  rootKey: name,
                                  projectId: target.projectId,
                                  sessionId: target.sessionId,
                                  ...(target.tabId ? { tabId: target.tabId } : {})
                                },
                                `Remove stale Termag record "${target.projectName} / ${target.label}" from the server? The tmux target is already missing on ${name}.`,
                                `missing:${target.sessionId}`
                              )}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <CopyButton label="Env template" copied={copied === `env:${name}`} onClick={() => copyText(`env:${name}`, envTemplate)} title="Copy TERMAG_URL / TOKEN / ROOTS exports" />
                    <CopyButton label="New shell" copied={copied === `connect:${name}`} onClick={() => copyText(`connect:${name}`, connectCommand)} title="termag new publishes a shell in this directory" />
                    <CopyButton label="Adopt tmux" copied={copied === `session:${name}`} onClick={() => copyText(`session:${name}`, sessionCommand)} title="termag adopt publishes every window in this tmux session" />
                  </div>
                </div>
              );
            })}
          </div>
          {cleanupError && <div className="mt-3 text-xs text-bad">{cleanupError}</div>}
          <SshHostsSection open={open} devices={devices} />
          <div className="mt-4 rounded-md border border-line bg-bg p-3 text-xs text-muted">
            <div className="mb-2 font-medium text-text">Setup</div>
            <p>Install the agent on each device, export its token and roots, then run connect from any terminal to publish a tmux workspace or start a new tmux-backed shell.</p>
            <a
              href="https://github.com/yeutterg/termag-next#quick-setup"
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-accent hover:underline"
            >
              GitHub setup guide
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

function CopyButton({ label, copied, onClick, title }: { label: string; copied: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-panel px-2 text-xs text-muted hover:bg-panel2 hover:text-text"
      onClick={onClick}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
  } catch {
    return value;
  }
}

function missingTargetsForDevice(deviceName: string, tmuxSessions: TmuxDeviceSession[], projects: Project[]): MissingTarget[] {
  const tmuxState = buildTmuxState(tmuxSessions);
  const missing: MissingTarget[] = [];
  for (const project of projects) {
    if (project.rootKey !== deviceName) continue;
    const projectSessionName = project.tmuxSessionName?.trim() || '';

    for (const tab of project.tabs) {
      if (!tab.session) continue;
      if (!tmuxSessionIsLive(tab.session, projectSessionName, tab.name, tmuxState)) {
        missing.push({
          projectId: project.id,
          tabId: tab.id,
          sessionId: tab.session.id,
          projectName: project.name,
          label: tab.name,
          tmuxName: tab.session.tmuxName
        });
      }
    }

    const ctrlSession = project.sessions.find((session) => session.kind === 'ctrl');
    if (ctrlSession && !tmuxSessionIsLive(ctrlSession, projectSessionName, 'ctrl', tmuxState)) {
      missing.push({
        projectId: project.id,
        sessionId: ctrlSession.id,
        projectName: project.name,
        label: 'ctrl',
        tmuxName: ctrlSession.tmuxName
      });
    }
  }
  return missing;
}

function buildTmuxState(tmuxSessions: TmuxDeviceSession[]) {
  const sessions = new Set<string>();
  const windows = new Set<string>();
  const globalWindows = new Set<string>();

  for (const session of tmuxSessions) {
    if (!session.name) continue;
    sessions.add(session.name);
    for (const window of session.windows) {
      for (const candidate of [window.target, window.id, window.name]) {
        if (!candidate) continue;
        windows.add(scopedTmuxTarget(session.name, candidate));
        globalWindows.add(candidate);
      }
    }
  }

  return { sessions, windows, globalWindows };
}

function tmuxSessionIsLive(
  session: Session,
  projectSessionName: string,
  label: string,
  tmuxState: ReturnType<typeof buildTmuxState>
) {
  const tmuxName = session.tmuxName?.trim() || '';
  if (projectSessionName) {
    if (tmuxName === projectSessionName && tmuxState.sessions.has(projectSessionName)) return true;
    for (const candidate of sessionTargetCandidates(session, projectSessionName, label)) {
      if (tmuxState.windows.has(scopedTmuxTarget(projectSessionName, candidate))) return true;
    }
    return false;
  }

  if (tmuxState.sessions.has(tmuxName)) return true;
  for (const candidate of sessionTargetCandidates(session, '', label)) {
    if (tmuxState.globalWindows.has(candidate)) return true;
  }
  return false;
}

function sessionTargetCandidates(session: Session, projectSessionName: string, label: string) {
  const candidates = new Set<string>();
  addTarget(candidates, session.tmuxName);
  addTarget(candidates, session.tmuxWindowName);
  addTarget(candidates, label);

  const tmuxName = session.tmuxName?.trim() || '';
  if (projectSessionName) {
    const prefix = `${projectSessionName}:`;
    if (tmuxName.startsWith(prefix)) addTarget(candidates, tmuxName.slice(prefix.length));
  } else if (tmuxName.includes(':')) {
    addTarget(candidates, tmuxName.slice(tmuxName.lastIndexOf(':') + 1));
  }

  return candidates;
}

function addTarget(candidates: Set<string>, value: string | null | undefined) {
  const trimmed = value?.trim();
  if (trimmed) candidates.add(trimmed);
}

function scopedTmuxTarget(sessionName: string, target: string) {
  return `${sessionName}\u0000${target}`;
}
