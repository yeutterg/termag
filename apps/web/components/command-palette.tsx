'use client';

import { signOut } from 'next-auth/react';
import { Command } from 'cmdk';
import { Command as CommandIcon, LogOut, Moon, Plus, Settings, TerminalSquare, Trash2 } from 'lucide-react';
import { Kbd } from './kbd';
import { Shortcut } from './shortcut';
import type { Project } from './types';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  onProject: (project: Project) => void;
  onNewTab: () => void;
  onKill: () => void;
  onTheme: () => void;
  onSettings: () => void;
  authMode: 'oauth' | 'password' | 'trusted';
}

async function signOutPassword() {
  await fetch('/api/auth/password', { method: 'DELETE' }).catch(() => {});
  window.location.href = '/login';
}

export function CommandPalette({
  open,
  onOpenChange,
  projects,
  onProject,
  onNewTab,
  onKill,
  onTheme,
  onSettings,
  authMode
}: CommandPaletteProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4" onClick={() => onOpenChange(false)}>
      <Command loop className="mx-auto mt-[12vh] max-w-xl overflow-hidden rounded-lg border border-line bg-panel shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-3">
          <CommandIcon className="h-4 w-4 text-muted" />
          <Command.Input autoFocus className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none" placeholder="Jump to project or run command" />
          <Kbd>Esc</Kbd>
        </div>
        <Command.List className="max-h-[420px] overflow-auto p-2">
          <Command.Empty className="px-3 py-6 text-sm text-muted">No results.</Command.Empty>
          <Command.Group heading="Projects">
            {projects.map((project) => (
              <Command.Item
                key={project.id}
                value={`project ${project.name} ${project.relativePath}`}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm aria-selected:bg-panel2"
                onSelect={() => {
                  onProject(project);
                  onOpenChange(false);
                }}
              >
                <TerminalSquare className="h-4 w-4 text-muted" />
                <span className="flex-1">{project.name}</span>
                <span className="text-xs text-muted">{project.rootKey}/{project.relativePath}</span>
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Commands">
            <Command.Item className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm aria-selected:bg-panel2" onSelect={() => { onNewTab(); onOpenChange(false); }}><Plus className="h-4 w-4 text-muted" /> <span className="flex-1">New session</span><Shortcut keys={['alt', 'mod', 'T']} /></Command.Item>
            <Command.Item className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm aria-selected:bg-panel2" onSelect={() => { onKill(); onOpenChange(false); }}><Trash2 className="h-4 w-4 text-muted" /> <span className="flex-1">Kill current session</span></Command.Item>
            <Command.Item className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm aria-selected:bg-panel2" onSelect={() => { onTheme(); onOpenChange(false); }}><Moon className="h-4 w-4 text-muted" /> <span className="flex-1">Toggle theme</span><Shortcut keys={['mod', '.']} /></Command.Item>
            <Command.Item className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm aria-selected:bg-panel2" onSelect={() => { onSettings(); onOpenChange(false); }}><Settings className="h-4 w-4 text-muted" /> <span className="flex-1">Settings</span><Shortcut keys={['mod', ',']} /></Command.Item>
            {authMode === 'oauth' && (
              <Command.Item className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm aria-selected:bg-panel2" onSelect={() => signOut({ callbackUrl: '/login' })}><LogOut className="h-4 w-4 text-muted" /> <span className="flex-1">Sign out</span></Command.Item>
            )}
            {authMode === 'password' && (
              <Command.Item className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm aria-selected:bg-panel2" onSelect={() => signOutPassword()}><LogOut className="h-4 w-4 text-muted" /> <span className="flex-1">Sign out</span></Command.Item>
            )}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
