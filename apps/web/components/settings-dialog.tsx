'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type Token = { id: string; name: string; tokenPrefix: string; createdAt: string };

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { email: string; name?: string | null };
  agentConnected: boolean;
}

export function SettingsDialog({ open, onOpenChange, user, agentConnected }: SettingsDialogProps) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [createdToken, setCreatedToken] = useState('');

  useEffect(() => {
    if (open) fetch('/api/agent-tokens').then((res) => res.json()).then(setTokens).catch(() => setTokens([]));
  }, [open]);

  async function createToken(formData: FormData) {
    const res = await fetch('/api/agent-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: formData.get('name') || 'laptop' })
    });
    if (!res.ok) return;
    const body = await res.json();
    setCreatedToken(body.token);
    setTokens((items) => [body, ...items]);
  }

  async function createTokenFromForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await createToken(new FormData(event.currentTarget));
    event.currentTarget.reset();
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4" onClick={() => onOpenChange(false)}>
      <section className="mx-auto mt-[10vh] max-w-xl rounded-lg border border-line bg-panel p-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Settings</h2>
            <p className="text-sm text-muted">{user.email}</p>
          </div>
          <span className={cn('rounded-full px-2 py-1 text-xs', agentConnected ? 'bg-good/15 text-good' : 'bg-panel2 text-muted')}>
            {agentConnected ? 'Agent connected' : 'Agent sleeping'}
          </span>
        </div>
        <form onSubmit={createTokenFromForm} className="mb-4 flex gap-2">
          <input name="name" placeholder="Token name" className="h-9 min-w-0 flex-1 rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent" />
          <button className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-bg">Create token</button>
        </form>
        {createdToken && (
          <div className="mb-4 border border-warn bg-warn/10 p-3">
            <div className="mb-1 text-xs font-medium text-warn">Token shown once</div>
            <code className="break-all font-mono text-xs">{createdToken}</code>
          </div>
        )}
        <div className="space-y-2">
          {tokens.map((token) => (
            <div key={token.id} className="flex items-center justify-between rounded-md border border-line bg-bg px-3 py-2 text-sm">
              <div>
                <div>{token.name}</div>
                <div className="text-xs text-muted">{token.tokenPrefix}</div>
              </div>
              <button
                className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-bad"
                onClick={async () => {
                  await fetch(`/api/agent-tokens/${token.id}`, { method: 'DELETE' });
                  setTokens((items) => items.filter((item) => item.id !== token.id));
                }}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
