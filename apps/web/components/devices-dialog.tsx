'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentDeviceStatus } from './types';

type Token = { id: string; name: string; tokenPrefix: string; createdAt: string; lastUsedAt?: string | null };

interface DevicesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { email: string; name?: string | null };
  devices: AgentDeviceStatus[];
  knownDeviceNames?: string[];
  focusedDevice?: string | null;
  onTokenDeleted?: (tokenName: string) => void;
}

export function DevicesDialog({ open, onOpenChange, user, devices, knownDeviceNames = [], focusedDevice, onTokenDeleted }: DevicesDialogProps) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [copied, setCopied] = useState('');
  const deviceRefs = useRef(new Map<string, HTMLDivElement>());

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
          <span className={cn('rounded-full px-2 py-1 text-xs', anyConnected ? 'bg-good/15 text-good' : 'bg-panel2 text-muted')}>
            {anyConnected ? `${devices.filter((device) => device.connected).length} connected` : 'No agents connected'}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mb-3">
            <h3 className="text-sm font-medium">Device tokens</h3>
            <p className="text-xs text-muted">Create one token per device from the + menu. Revoke a token to disconnect that device.</p>
          </div>
          <div className="space-y-2">
          {allNames.length === 0 && (
            <div className="rounded-md border border-line bg-bg px-3 py-6 text-center text-sm text-muted">
              No devices yet. Use the + menu to create the first device token.
            </div>
          )}
          {allNames.map((name) => {
            const token = tokens.find((item) => item.name === name);
            const device = deviceMap.get(name);
            const envTemplate = [
              'export TERMAG_URL=wss://<your-termag-host>/api/ws/agent',
              'export TERMAG_AGENT_TOKEN=tmag_REPLACE_WITH_DEVICE_TOKEN',
              `export TERMAG_AGENT_ROOTS='{"${name.replace(/"/g, '\\"')}":"~/Code"}'`
            ].join('\n');
            const connectCommand = `termag-agent connect --project "My Project"`;
            const sessionCommand = `termag-agent connect --project "My Project" --session`;
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
              <div className="mt-3 flex flex-wrap gap-2">
                <CopyButton label="Env template" copied={copied === `env:${name}`} onClick={() => copyText(`env:${name}`, envTemplate)} />
                <CopyButton label="Current window" copied={copied === `connect:${name}`} onClick={() => copyText(`connect:${name}`, connectCommand)} />
                <CopyButton label="Whole session" copied={copied === `session:${name}`} onClick={() => copyText(`session:${name}`, sessionCommand)} />
              </div>
            </div>
            );
          })}
          </div>
          <div className="mt-4 rounded-md border border-line bg-bg p-3 text-xs text-muted">
            <div className="mb-2 font-medium text-text">Setup</div>
            <p>Install the agent on each device, export its token and roots, then use connect from inside tmux to publish existing workspaces.</p>
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

function CopyButton({ label, copied, onClick }: { label: string; copied: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
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
