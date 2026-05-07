'use client';

import { signOut } from 'next-auth/react';
import { Command } from 'cmdk';
import { Command as CommandIcon, CornerDownLeft, LogOut, Moon, Plus, Search as SearchIcon, Settings, Trash2 } from 'lucide-react';
import { Shortcut } from './shortcut';
import { cn, statusDot } from '@/lib/utils';
import type { Project, Tab } from './types';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  onSession: (projectId: string, tabId: string) => void;
  onNewTab: () => void;
  onKill: () => void;
  onTheme: () => void;
  onSearch: () => void;
  onSettings: () => void;
  authMode: 'oauth' | 'password' | 'trusted';
}

async function signOutPassword() {
  await fetch('/api/auth/password', { method: 'DELETE' }).catch(() => {});
  window.location.href = '/login';
}

type Row = { project: Project; tab: Tab; projectIndex: number; isProjectHead: boolean };

export function CommandPalette({
  open,
  onOpenChange,
  projects,
  onSession,
  onNewTab,
  onKill,
  onTheme,
  onSearch,
  onSettings,
  authMode
}: CommandPaletteProps) {
  if (!open) return null;
  // Flatten to (project × tab). ⌃1-9 jumps to the Nth project, so we tag
  // the first row of each project as a "head" — that's where the shortcut
  // hint renders.
  const rows: Row[] = [];
  projects.forEach((project, projectIndex) => {
    project.tabs.forEach((tab, tabIndex) => {
      rows.push({ project, tab, projectIndex: projectIndex + 1, isProjectHead: tabIndex === 0 });
    });
  });
  return (
    <div className="fixed inset-0 z-50 bg-black/40 p-4 sm:p-6" onClick={() => onOpenChange(false)}>
      <Command
        loop
        className="mx-auto mt-[10vh] flex max-h-[80vh] max-w-xl flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4">
          <SearchIcon className="h-4 w-4 text-muted" />
          <Command.Input
            autoFocus
            className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            placeholder="Jump to an agent…"
          />
          <span className="font-mono text-[10px] text-muted">esc</span>
        </div>
        <div className="border-t border-line/60" />
        <Command.List className="min-h-0 flex-1 overflow-auto p-2">
          <Command.Empty className="px-3 py-6 text-sm text-muted">No matches.</Command.Empty>
          {rows.length > 0 && (
            <Command.Group heading="Agents">
              {rows.map(({ project, tab, projectIndex, isProjectHead }) => (
                <Command.Item
                  key={`${project.id}:${tab.id}`}
                  value={`${project.name} ${project.rootKey} ${tab.name}`}
                  onSelect={() => {
                    onSession(project.id, tab.id);
                    onOpenChange(false);
                  }}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 aria-selected:bg-panel2"
                >
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', statusDot(tab.status))} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-semibold tracking-tight">{project.name}</span>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted">{project.rootKey}</span>
                    </div>
                    <span className="truncate text-xs text-muted">{tab.name}</span>
                  </div>
                  {isProjectHead && projectIndex <= 9 && <Shortcut keys={['ctrl', String(projectIndex)]} />}
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading="Commands">
            <CommandRow icon={<Plus className="h-3.5 w-3.5" />} label="New agent in current project" shortcut={['mod', 'enter']} onSelect={() => { onNewTab(); onOpenChange(false); }} />
            <CommandRow icon={<SearchIcon className="h-3.5 w-3.5" />} label="Search scrollback" shortcut={['mod', 'shift', 'F']} onSelect={() => { onSearch(); onOpenChange(false); }} />
            <CommandRow icon={<Trash2 className="h-3.5 w-3.5" />} label="Kill current session" onSelect={() => { onKill(); onOpenChange(false); }} />
            <CommandRow icon={<Moon className="h-3.5 w-3.5" />} label="Toggle theme" shortcut={['mod', '.']} onSelect={() => { onTheme(); onOpenChange(false); }} />
            <CommandRow icon={<Settings className="h-3.5 w-3.5" />} label="Open settings" shortcut={['mod', ';']} onSelect={() => { onSettings(); onOpenChange(false); }} />
            {authMode === 'oauth' && (
              <CommandRow icon={<LogOut className="h-3.5 w-3.5" />} label="Sign out" onSelect={() => signOut({ callbackUrl: '/login' })} />
            )}
            {authMode === 'password' && (
              <CommandRow icon={<LogOut className="h-3.5 w-3.5" />} label="Sign out" onSelect={() => signOutPassword()} />
            )}
          </Command.Group>
        </Command.List>
        <div className="flex items-center gap-4 border-t border-line/60 px-4 py-2 font-mono text-[10px] text-muted">
          <span className="flex items-center gap-1.5"><CommandIcon className="h-3 w-3" /> navigate</span>
          <span className="flex items-center gap-1.5"><CornerDownLeft className="h-3 w-3" /> open</span>
          <span className="ml-auto">{rows.length} {rows.length === 1 ? 'agent' : 'agents'}</span>
        </div>
      </Command>
    </div>
  );
}

function CommandRow({
  icon,
  label,
  shortcut,
  onSelect
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: Parameters<typeof Shortcut>[0]['keys'];
  onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm aria-selected:bg-panel2"
    >
      <span className="text-muted">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {shortcut && <Shortcut keys={shortcut} />}
    </Command.Item>
  );
}
