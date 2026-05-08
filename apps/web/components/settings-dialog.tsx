'use client';

import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type Token = { id: string; name: string; tokenPrefix: string; createdAt: string };

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { email: string; name?: string | null };
  agentConnected: boolean;
  onTokenDeleted?: (tokenName: string) => void;
}

export function SettingsDialog({ open, onOpenChange, user, agentConnected, onTokenDeleted }: SettingsDialogProps) {
  const [tokens, setTokens] = useState<Token[]>([]);

  useEffect(() => {
    if (open) fetch('/api/agent-tokens').then((res) => res.json()).then(setTokens).catch(() => setTokens([]));
  }, [open]);

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
        <div className="mb-3">
          <h3 className="text-sm font-medium">Devices</h3>
          <p className="text-xs text-muted">Create one token per device from the + menu. Revoke a token to disconnect that device.</p>
        </div>
        <div className="space-y-2">
          {tokens.length === 0 && (
            <div className="rounded-md border border-line bg-bg px-3 py-6 text-center text-sm text-muted">
              No devices yet. Use + → New Device to create the first device token.
            </div>
          )}
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
                  onTokenDeleted?.(token.name);
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
