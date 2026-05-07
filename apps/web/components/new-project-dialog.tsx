'use client';

import { type FormEvent, useState } from 'react';

const AGENT_OPTIONS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'claude-yolo', label: 'Claude Code YOLO' },
  { id: 'codex', label: 'Codex' },
  { id: 'codex-yolo', label: 'Codex YOLO' }
] as const;

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (formData: FormData) => Promise<boolean>;
  roots: Record<string, string>;
}

export function NewProjectDialog({ open, onOpenChange, onCreate, roots }: NewProjectDialogProps) {
  const [error, setError] = useState('');
  const devices = Object.keys(roots);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const customAgents = String(formData.get('customAgents') || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (formData.getAll('agentTypes').length + customAgents.length === 0) {
      setError('Select at least one agent.');
      return;
    }
    setError('');
    const created = await onCreate(formData);
    if (!created) {
      setError('Could not create that project. Check the directory and try again.');
      return;
    }
    event.currentTarget.reset();
    onOpenChange(false);
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4" onClick={() => onOpenChange(false)}>
      <section className="mx-auto mt-[10vh] max-w-lg rounded-lg border border-line bg-panel p-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4">
          <h2 className="text-base font-semibold">New project</h2>
          <p className="mt-1 text-sm text-muted">Device → Project → Agents</p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-[11rem_1fr]">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Device</span>
              <select
                name="rootKey"
                required
                className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
              >
                {devices.map((device) => (
                  <option key={device} value={device}>{device}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Directory</span>
              <input
                name="directory"
                autoFocus
                required
                placeholder="/path/to/project"
                className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Project name</span>
            <input
              name="name"
              placeholder="Defaults to the directory name"
              className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent"
            />
          </label>
          <fieldset>
            <legend className="mb-2 text-xs font-medium text-muted">Agents</legend>
            <label className="mb-2 block">
              <span className="mb-1 block text-xs font-medium text-muted">Other agents</span>
              <textarea
                name="customAgents"
                rows={2}
                placeholder={'gemini\nopencode'}
                className="min-h-16 w-full resize-y rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs outline-none focus:border-accent"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              {AGENT_OPTIONS.map((agent) => (
                <label key={agent.id} className="flex h-9 items-center gap-2 rounded-md border border-line bg-bg px-3 text-sm">
                  <input
                    name="agentTypes"
                    value={agent.id}
                    type="checkbox"
                    defaultChecked={agent.id === 'codex'}
                    className="h-4 w-4 accent-current"
                  />
                  <span>{agent.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {error && <div className="text-xs text-bad">{error}</div>}
          <button className="h-9 rounded-md bg-text px-3 text-sm font-medium text-bg">Create project</button>
        </form>
      </section>
    </div>
  );
}
