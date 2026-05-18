'use client';

import { type FormEvent, useState } from 'react';

export type SshHost = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  lastSeenAt: string | null;
  lastError: string | null;
};

interface NewSshHostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (host: SshHost) => void;
}

export function NewSshHostDialog({ open, onOpenChange, onCreated }: NewSshHostDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function createHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = {
      name: String(data.get('name') || '').trim(),
      host: String(data.get('host') || '').trim(),
      port: Number(data.get('port') || '22') || 22,
      user: String(data.get('user') || '').trim()
    };
    if (!payload.name || !payload.host || !payload.user) {
      setError('Name, host, and user are required.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/ssh-hosts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error || `Could not add host (HTTP ${res.status})`);
        return;
      }
      onCreated?.(body as SshHost);
      form.reset();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add host');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4" onClick={() => onOpenChange(false)}>
      <section className="mx-auto mt-[10vh] max-w-lg rounded-lg border border-line bg-panel p-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4">
          <h2 className="text-base font-semibold">Add SSH host</h2>
          <p className="mt-1 text-sm text-muted">
            The broker connects with your machine&apos;s <code className="font-mono text-xs">ssh-agent</code> + <code className="font-mono text-xs">~/.ssh/config</code>.
            Make sure you can run <code className="font-mono text-xs">ssh user@host</code> from the broker non-interactively first.
          </p>
        </div>
        <form onSubmit={createHost} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Display name</span>
            <input
              name="name"
              type="text"
              autoFocus
              autoComplete="off"
              placeholder="vps, homelab, prod-bastion"
              className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
            />
          </label>
          <div className="grid grid-cols-[1fr_5rem] gap-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Host</span>
              <input
                name="host"
                type="text"
                autoComplete="off"
                placeholder="example.com or 10.0.0.42"
                className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Port</span>
              <input
                name="port"
                type="number"
                defaultValue={22}
                min={1}
                max={65535}
                className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">SSH user</span>
            <input
              name="user"
              type="text"
              autoComplete="off"
              placeholder="root, ubuntu, ec2-user"
              className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
            />
          </label>
          {error && <div className="rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="h-9 rounded-md border border-line bg-bg px-3 text-sm text-text hover:bg-panel2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="h-9 rounded-md bg-text px-3 text-sm font-medium text-bg disabled:opacity-60"
            >
              {submitting ? 'Adding…' : 'Add host'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
