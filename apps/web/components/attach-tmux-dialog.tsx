'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';

type TmuxWindow = {
  index: number;
  id: string;
  name: string;
  target: string;
  path?: string;
};

type TmuxSession = {
  rootKey: string;
  name: string;
  path?: string;
  windowCount?: number;
  windows: TmuxWindow[];
};

interface AttachTmuxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAttach: (session: { rootKey: string; sessionName: string }) => Promise<{ ok: boolean; error?: string }>;
}

export function AttachTmuxDialog({ open, onOpenChange, onAttach }: AttachTmuxDialogProps) {
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attaching, setAttaching] = useState('');

  const groups = useMemo(() => {
    const next = new Map<string, TmuxSession[]>();
    for (const session of sessions) {
      next.set(session.rootKey, [...(next.get(session.rootKey) ?? []), session]);
    }
    return [...next.entries()];
  }, [sessions]);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/tmux/sessions');
      if (!res.ok) throw new Error('Could not load tmux sessions');
      setSessions(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load tmux sessions');
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void loadSessions();
  }, [loadSessions, open]);

  async function attach(session: TmuxSession) {
    const key = `${session.rootKey}:${session.name}`;
    setAttaching(key);
    setError('');
    const result = await onAttach({ rootKey: session.rootKey, sessionName: session.name });
    setAttaching('');
    if (!result.ok) {
      setError(result.error || 'Could not attach that tmux session.');
      await loadSessions();
      return;
    }
    onOpenChange(false);
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4" onClick={() => onOpenChange(false)}>
      <section className="mx-auto mt-[8vh] flex max-h-[82vh] max-w-2xl flex-col rounded-lg border border-line bg-panel p-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Attach tmux session</h2>
            <p className="mt-1 text-sm text-muted">Existing sessions become projects. Their tmux windows become terminal tabs.</p>
          </div>
          <button
            type="button"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-panel2 hover:text-text disabled:opacity-50"
            onClick={loadSessions}
            disabled={loading}
            title="Refresh tmux sessions"
            aria-label="Refresh tmux sessions"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && <div className="rounded-md border border-line bg-bg p-3 text-sm text-muted">Loading connected devices...</div>}
          {!loading && groups.length === 0 && (
            <div className="rounded-md border border-line bg-bg p-3 text-sm text-muted">
              No unattached tmux sessions found on connected devices.
            </div>
          )}
          <div className="space-y-4">
            {groups.map(([device, deviceSessions]) => (
              <section key={device}>
                <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wider text-muted">{device}</div>
                <div className="space-y-2">
                  {deviceSessions.map((session) => {
                    const sessionKey = `${session.rootKey}:${session.name}`;
                    return (
                      <div key={sessionKey} className="rounded-md border border-line bg-bg p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{session.name}</div>
                            {session.path && <div className="mt-0.5 truncate font-mono text-[11px] text-muted">{session.path}</div>}
                          </div>
                          <button
                            type="button"
                            className="h-8 shrink-0 rounded-md bg-text px-3 text-xs font-medium text-bg disabled:opacity-60"
                            disabled={attaching === sessionKey}
                            onClick={() => attach(session)}
                          >
                            {attaching === sessionKey ? 'Attaching' : 'Attach'}
                          </button>
                        </div>
                        <div className="mt-3 space-y-1 pl-2">
                          {session.windows.map((window) => (
                            <div key={window.target} className="flex h-7 items-center gap-2 rounded px-2 text-xs text-muted">
                              <span className="w-6 shrink-0 font-mono text-[10px]">{window.index}</span>
                              <span className="min-w-0 flex-1 truncate text-text">{window.name || window.id}</span>
                              <span className="shrink-0 font-mono text-[10px]">{window.id}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>

        {error && <div className="mt-3 text-xs text-bad">{error}</div>}
      </section>
    </div>
  );
}
