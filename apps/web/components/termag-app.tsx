'use client';

import { useEffect, useMemo, useState } from 'react';
import { signOut } from 'next-auth/react';
import { Command } from 'cmdk';
import {
  ChevronLeft,
  ChevronRight,
  Command as CommandIcon,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  Sun,
  TerminalSquare,
  Trash2
} from 'lucide-react';
import { TerminalPane } from './terminal/terminal-pane';
import { AGENT_DEFAULTS } from '@/lib/defaults';
import { cn, statusDot, statusLabel } from '@/lib/utils';

type Session = {
  id: string;
  kind: string;
  tmuxName: string;
  status: string;
};

type Tab = {
  id: string;
  name: string;
  ordinal: number;
  status: string;
  session?: Session | null;
};

type Project = {
  id: string;
  name: string;
  rootKey: string;
  relativePath: string;
  agentType: string;
  agentSpawnCommand: string;
  status: string;
  openedAt: string | Date;
  tabs: Tab[];
  sessions: Session[];
};

interface TermagAppProps {
  user: { id: string; email: string; name?: string | null; theme: string };
  initialProjects: Project[];
  roots: Record<string, string>;
}

export function TermagApp({ user, initialProjects, roots }: TermagAppProps) {
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [activeProjectId, setActiveProjectId] = useState(initialProjects[0]?.id ?? '');
  const [activeTabId, setActiveTabId] = useState(initialProjects[0]?.tabs[0]?.id ?? '');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showCtrl, setShowCtrl] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentConnected, setAgentConnected] = useState(false);
  const [theme, setTheme] = useState(user.theme);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0];
  const activeTab = activeProject?.tabs.find((tab) => tab.id === activeTabId) ?? activeProject?.tabs[0];
  const ctrlSession = activeProject?.sessions.find((session) => session.kind === 'ctrl');

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const wantsDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      root.classList.toggle('dark', wantsDark);
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (mod && event.key === '\\') {
        event.preventDefault();
        setSidebarOpen((value) => !value);
      }
      if (mod && event.key.toLowerCase() === 't') {
        event.preventDefault();
        if (activeProject) createTab(activeProject.id);
      }
      if (mod && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        if (activeProject && activeTab) closeTab(activeProject.id, activeTab.id);
      }
      if (mod && event.key === '.') {
        event.preventDefault();
        cycleTheme();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws/status`);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'agent') setAgentConnected(Boolean(msg.connected));
      if (msg.type === 'refresh') reloadProjects();
    };
    return () => ws.close();
  }, []);

  async function reloadProjects(nextProjectId = activeProjectId, nextTabId = activeTabId) {
    const res = await fetch('/api/projects');
    const next = await res.json();
    setProjects(next);
    setActiveProjectId(nextProjectId || next[0]?.id || '');
    const project = next.find((item: Project) => item.id === nextProjectId) ?? next[0];
    setActiveTabId(nextTabId || project?.tabs[0]?.id || '');
  }

  async function createProject(formData: FormData) {
    const rootKey = String(formData.get('rootKey') || Object.keys(roots)[0]);
    const agentType = String(formData.get('agentType') || 'codex');
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: formData.get('name'),
        rootKey,
        relativePath: formData.get('relativePath'),
        agentType
      })
    });
    if (!res.ok) return;
    const project = await res.json();
    await reloadProjects(project.id, project.tabs?.[0]?.id);
  }

  async function createTab(projectId: string) {
    const res = await fetch(`/api/projects/${projectId}/tabs`, { method: 'POST', body: '{}' });
    if (!res.ok) return;
    const tab = await res.json();
    await reloadProjects(projectId, tab.id);
  }

  async function closeTab(projectId: string, tabId: string) {
    const project = projects.find((item) => item.id === projectId);
    if (!project || project.tabs.length <= 1) return;
    await fetch(`/api/projects/${projectId}/tabs/${tabId}`, { method: 'DELETE' });
    const nextTab = project.tabs.find((tab) => tab.id !== tabId);
    await reloadProjects(projectId, nextTab?.id);
  }

  async function cycleTheme() {
    const next = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';
    setTheme(next);
    await fetch('/api/user/theme', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: next })
    });
  }

  const groups = useMemo(() => {
    const result = new Map<string, Project[]>();
    for (const project of projects) {
      const key = `${project.rootKey}/${project.relativePath.split('/')[0] || ''}`;
      result.set(key, [...(result.get(key) ?? []), project]);
    }
    return [...result.entries()];
  }, [projects]);

  return (
    <main className="flex h-dvh bg-bg text-text">
      <aside className={cn('flex shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-150', sidebarOpen ? 'w-[280px]' : 'w-[56px]')}>
        <div className="flex h-12 items-center justify-between border-b border-line px-3">
          {sidebarOpen ? <span className="text-sm font-semibold">termag</span> : <TerminalSquare className="mx-auto h-4 w-4" />}
          <button className="grid h-8 w-8 place-items-center hover:bg-panel2" onClick={() => setSidebarOpen((value) => !value)}>
            {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {sidebarOpen && (
            <form action={createProject} className="mb-3 border border-line bg-bg p-2">
              <div className="mb-2 text-xs font-medium text-muted">New project</div>
              <input name="name" placeholder="name" className="mb-2 h-8 w-full border border-line bg-panel px-2 text-sm outline-none focus:border-accent" />
              <div className="mb-2 grid grid-cols-[82px_1fr] gap-2">
                <select name="rootKey" className="h-8 border border-line bg-panel px-2 text-sm">
                  {Object.keys(roots).map((root) => <option key={root}>{root}</option>)}
                </select>
                <input name="relativePath" placeholder="repo/path" className="h-8 border border-line bg-panel px-2 text-sm outline-none focus:border-accent" />
              </div>
              <select name="agentType" className="mb-2 h-8 w-full border border-line bg-panel px-2 text-sm">
                {(Object.entries(AGENT_DEFAULTS) as Array<[string, { label: string }]>).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
              </select>
              <button className="flex h-8 w-full items-center justify-center gap-2 bg-accent px-2 text-sm font-medium text-bg">
                <Plus className="h-4 w-4" /> Create
              </button>
            </form>
          )}

          <div className="space-y-3">
            {groups.map(([group, groupProjects]) => (
              <section key={group}>
                {sidebarOpen && <div className="mb-1 px-1 text-[11px] uppercase text-muted">{group}</div>}
                <div className="space-y-1">
                  {groupProjects.map((project) => (
                    <button
                      key={project.id}
                      className={cn('flex h-9 w-full items-center gap-2 px-2 text-left text-sm hover:bg-panel2', project.id === activeProject?.id && 'bg-panel2')}
                      title={`${project.rootKey}/${project.relativePath}`}
                      onClick={() => {
                        setActiveProjectId(project.id);
                        setActiveTabId(project.tabs[0]?.id ?? '');
                      }}
                    >
                      <span className={cn('h-2 w-2 rounded-full', statusDot(agentConnected ? project.status : 'sleeping'))} />
                      {sidebarOpen ? (
                        <>
                          <span className="min-w-0 flex-1 truncate">{project.name}</span>
                          <span className="text-xs text-muted">{AGENT_DEFAULTS[project.agentType as keyof typeof AGENT_DEFAULTS]?.badge ?? project.agentType.slice(0, 2).toUpperCase()}</span>
                        </>
                      ) : (
                        <span className="text-xs font-medium">{project.name.slice(0, 2).toUpperCase()}</span>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>

        <div className="border-t border-line p-2">
          <button className="flex h-9 w-full items-center gap-2 px-2 text-sm hover:bg-panel2" onClick={() => setPaletteOpen(true)}>
            <CommandIcon className="h-4 w-4" />
            {sidebarOpen && <span>Command</span>}
          </button>
          <button className="flex h-9 w-full items-center gap-2 px-2 text-sm hover:bg-panel2" onClick={() => setSettingsOpen(true)}>
            <Settings className="h-4 w-4" />
            {sidebarOpen && <span>Settings</span>}
          </button>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-line bg-panel px-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn('h-2 w-2 rounded-full', statusDot(agentConnected ? activeProject?.status : 'sleeping'))} />
              <h1 className="truncate text-sm font-semibold">{activeProject?.name ?? 'No project'}</h1>
            </div>
            <div className="truncate text-xs text-muted">
              {activeProject ? `${activeProject.rootKey}/${activeProject.relativePath} · ${statusLabel(agentConnected ? activeProject.status : 'sleeping')}` : 'Create a project to start'}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button className="grid h-8 w-8 place-items-center hover:bg-panel2" title="Search" onClick={() => setSearchOpen(true)}><Search className="h-4 w-4" /></button>
            <button className="grid h-8 w-8 place-items-center hover:bg-panel2" title="Toggle ctrl" onClick={() => setShowCtrl((value) => !value)}>
              {showCtrl ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            </button>
            <button className="grid h-8 w-8 place-items-center hover:bg-panel2" title="Theme" onClick={cycleTheme}>
              {theme === 'light' ? <Sun className="h-4 w-4" /> : theme === 'dark' ? <Moon className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
            </button>
          </div>
        </header>

        {activeProject && (
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
            {activeProject.tabs.map((tab) => (
              <button
                key={tab.id}
                className={cn('flex h-8 max-w-[180px] items-center gap-2 border border-transparent px-2 text-sm hover:bg-panel2', tab.id === activeTab?.id && 'border-line bg-panel2')}
                onClick={() => setActiveTabId(tab.id)}
              >
                <span className={cn('h-2 w-2 rounded-full', statusDot(agentConnected ? tab.status : 'sleeping'))} />
                <span className="truncate">{tab.name}</span>
                {activeProject.tabs.length > 1 && (
                  <span
                    className="grid h-5 w-5 place-items-center text-muted hover:text-text"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(activeProject.id, tab.id);
                    }}
                  >
                    ×
                  </span>
                )}
              </button>
            ))}
            <button className="grid h-8 w-8 place-items-center hover:bg-panel2" onClick={() => createTab(activeProject.id)}><Plus className="h-4 w-4" /></button>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {activeTab?.session ? (
            <TerminalPane key={activeTab.session.id} active sessionId={activeTab.session.id} title={activeTab.name} status={agentConnected ? activeTab.session.status : 'sleeping'} />
          ) : (
            <div className="grid flex-1 place-items-center text-sm text-muted">Create a project to open a terminal.</div>
          )}
          {showCtrl && ctrlSession && (
            <TerminalPane key={ctrlSession.id} active sessionId={ctrlSession.id} title="ctrl" status={agentConnected ? ctrlSession.status : 'sleeping'} />
          )}
        </div>
      </section>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        projects={projects}
        onProject={(project) => {
          setActiveProjectId(project.id);
          setActiveTabId(project.tabs[0]?.id ?? '');
        }}
        onNewTab={() => activeProject && createTab(activeProject.id)}
        onKill={() => {
          if (activeTab?.session) {
            window.dispatchEvent(new CustomEvent('termag:kill-session', { detail: { sessionId: activeTab.session.id } }));
          }
        }}
        onTheme={cycleTheme}
        onSettings={() => setSettingsOpen(true)}
      />
      <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} user={user} agentConnected={agentConnected} />
    </main>
  );
}

function CommandPalette({
  open,
  onOpenChange,
  projects,
  onProject,
  onNewTab,
  onKill,
  onTheme,
  onSettings
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  onProject: (project: Project) => void;
  onNewTab: () => void;
  onKill: () => void;
  onTheme: () => void;
  onSettings: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4" onClick={() => onOpenChange(false)}>
      <Command className="mx-auto mt-[12vh] max-w-xl border border-line bg-panel shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <Command.Input className="h-12 w-full border-b border-line bg-transparent px-4 outline-none" placeholder="Jump to project or run command" />
        <Command.List className="max-h-[420px] overflow-auto p-2">
          <Command.Empty className="px-3 py-6 text-sm text-muted">No results.</Command.Empty>
          <Command.Group heading="Projects">
            {projects.map((project) => (
              <Command.Item
                key={project.id}
                value={`project ${project.name} ${project.relativePath}`}
                className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm aria-selected:bg-panel2"
                onSelect={() => {
                  onProject(project);
                  onOpenChange(false);
                }}
              >
                <TerminalSquare className="h-4 w-4" /> {project.name}
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Commands">
            <Command.Item className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm aria-selected:bg-panel2" onSelect={() => { onNewTab(); onOpenChange(false); }}><Plus className="h-4 w-4" /> New session</Command.Item>
            <Command.Item className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm aria-selected:bg-panel2" onSelect={() => { onKill(); onOpenChange(false); }}><Trash2 className="h-4 w-4" /> Kill current session</Command.Item>
            <Command.Item className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm aria-selected:bg-panel2" onSelect={() => { onTheme(); onOpenChange(false); }}><Moon className="h-4 w-4" /> Toggle theme</Command.Item>
            <Command.Item className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm aria-selected:bg-panel2" onSelect={() => { onSettings(); onOpenChange(false); }}><Settings className="h-4 w-4" /> Settings</Command.Item>
            <Command.Item className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm aria-selected:bg-panel2" onSelect={() => signOut({ callbackUrl: '/login' })}><LogOut className="h-4 w-4" /> Sign out</Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}

function SearchPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ id: string; projectName: string; tabName: string; excerpt: string }>>([]);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`).then((res) => res.json()).then(setResults).catch(() => setResults([]));
    }, 180);
    return () => clearTimeout(timer);
  }, [open, query]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4" onClick={() => onOpenChange(false)}>
      <div className="mx-auto mt-[12vh] max-w-2xl border border-line bg-panel shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <input className="h-12 w-full border-b border-line bg-transparent px-4 outline-none" autoFocus placeholder="Search terminal scrollback" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="max-h-[440px] overflow-auto p-2">
          {results.length === 0 ? <div className="px-3 py-6 text-sm text-muted">No results.</div> : results.map((result) => (
            <div key={result.id} className="border-b border-line px-3 py-2 last:border-0">
              <div className="mb-1 text-xs text-muted">{result.projectName} / {result.tabName}</div>
              <pre className="whitespace-pre-wrap font-mono text-xs leading-5">{result.excerpt}</pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SettingsDialog({
  open,
  onOpenChange,
  user,
  agentConnected
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { email: string; name?: string | null };
  agentConnected: boolean;
}) {
  const [tokens, setTokens] = useState<Array<{ id: string; name: string; tokenPrefix: string; createdAt: string }>>([]);
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
    const body = await res.json();
    setCreatedToken(body.token);
    setTokens((items) => [body, ...items]);
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4" onClick={() => onOpenChange(false)}>
      <section className="mx-auto mt-[10vh] max-w-xl border border-line bg-panel p-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Settings</h2>
            <p className="text-sm text-muted">{user.email}</p>
          </div>
          <span className={cn('rounded-full px-2 py-1 text-xs', agentConnected ? 'bg-good/15 text-good' : 'bg-panel2 text-muted')}>
            {agentConnected ? 'Agent connected' : 'Agent sleeping'}
          </span>
        </div>
        <form action={createToken} className="mb-4 flex gap-2">
          <input name="name" placeholder="token name" className="h-9 min-w-0 flex-1 border border-line bg-bg px-2 text-sm outline-none focus:border-accent" />
          <button className="h-9 bg-accent px-3 text-sm font-medium text-bg">Create token</button>
        </form>
        {createdToken && (
          <div className="mb-4 border border-warn bg-warn/10 p-3">
            <div className="mb-1 text-xs font-medium text-warn">Token shown once</div>
            <code className="break-all font-mono text-xs">{createdToken}</code>
          </div>
        )}
        <div className="space-y-2">
          {tokens.map((token) => (
            <div key={token.id} className="flex items-center justify-between border border-line bg-bg px-3 py-2 text-sm">
              <div>
                <div>{token.name}</div>
                <div className="text-xs text-muted">{token.tokenPrefix}</div>
              </div>
              <button
                className="grid h-8 w-8 place-items-center text-muted hover:bg-panel2 hover:text-bad"
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
