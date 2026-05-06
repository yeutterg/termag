'use client';

import { type FormEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Command as CommandIcon,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  Sun,
  TerminalSquare
} from 'lucide-react';
import { TerminalPane } from './terminal/terminal-pane';
import { PlatformProvider, Shortcut, shortcutSuffix } from './shortcut';
import { TabLabel } from './tab-label';
import { useTabHistory } from './use-tab-history';
import type { Project, Tab } from './types';
import type { Platform } from '@/lib/platform';
import { AGENT_DEFAULTS } from '@/lib/defaults';
import { cn, statusDot, statusLabel } from '@/lib/utils';

// Heavy dialogs are split into their own chunks and loaded only when opened.
const CommandPalette = lazy(() => import('./command-palette').then((m) => ({ default: m.CommandPalette })));
const SearchPalette = lazy(() => import('./search-palette').then((m) => ({ default: m.SearchPalette })));
const SettingsDialog = lazy(() => import('./settings-dialog').then((m) => ({ default: m.SettingsDialog })));

type AuthMode = 'oauth' | 'password' | 'trusted';

interface TermagAppProps {
  user: { id: string; email: string; name?: string | null; theme: string };
  initialProjects: Project[];
  roots: Record<string, string>;
  platform: Platform;
  authMode: AuthMode;
}

export function TermagApp({ user, initialProjects, roots, platform, authMode }: TermagAppProps) {
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [activeProjectId, setActiveProjectId] = useState(initialProjects[0]?.id ?? '');
  const [activeTabId, setActiveTabId] = useState(initialProjects[0]?.tabs[0]?.id ?? '');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showCtrl, setShowCtrl] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [agentConnected, setAgentConnected] = useState(false);
  const [theme, setTheme] = useState(user.theme);
  // Live xterm titles keyed by sessionId. Tools inside the terminal can set
  // a title via OSC 0/2; we mirror it onto the corresponding tab label.
  const [liveTitles, setLiveTitles] = useState<Record<string, string>>({});

  const handleSessionTitle = useCallback((sessionId: string, title: string) => {
    setLiveTitles((current) => (current[sessionId] === title ? current : { ...current, [sessionId]: title }));
  }, []);
  const initialTab = initialProjects[0]?.tabs[0];
  const tabHistory = useTabHistory(
    initialProjects[0] && initialTab ? { [initialProjects[0].id]: [initialTab.id] } : {}
  );
  const activeProjectIdRef = useRef(activeProjectId);
  const activeTabIdRef = useRef(activeTabId);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? projects[0],
    [projects, activeProjectId]
  );
  const activeTab = useMemo(
    () => activeProject?.tabs.find((tab) => tab.id === activeTabId) ?? activeProject?.tabs[0],
    [activeProject, activeTabId]
  );
  const ctrlSession = useMemo(
    () => activeProject?.sessions.find((session) => session.kind === 'ctrl'),
    [activeProject]
  );

  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

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

  // The keyboard handler needs the latest project/tab and async actions on
  // every keypress, but we only want to bind the listener once. Park them on
  // a ref so the listener body is stable yet always reads fresh values.
  const handlersRef = useRef<{
    activeProject?: Project;
    activeTab?: Tab;
    createTab: (projectId: string) => void;
    closeTab: (projectId: string, tabId: string) => void;
    cycleTheme: () => void;
    switchRecentTab: (reverse: boolean) => void;
  } | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const handlers = handlersRef.current;
      if (!handlers) return;
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === 'Escape') {
        setPaletteOpen(false);
        setSearchOpen(false);
        setSettingsOpen(false);
        return;
      }
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault();
        handlers.switchRecentTab(event.shiftKey);
      }
      if (mod && event.key === '\\') {
        event.preventDefault();
        setSidebarOpen((value) => !value);
      }
      if (mod && event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setSidebarOpen(true);
        setCreateOpen((value) => !value);
        return;
      }
      if (mod && event.altKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        if (handlers.activeProject) handlers.createTab(handlers.activeProject.id);
      }
      if (mod && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        if (handlers.activeProject && handlers.activeTab) handlers.closeTab(handlers.activeProject.id, handlers.activeTab.id);
      }
      if (mod && event.key === '.') {
        event.preventDefault();
        handlers.cycleTheme();
      }
      if (mod && event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/api/ws/status`;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      ws = new WebSocket(url);
      ws.onopen = () => {
        attempts = 0;
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'agent') setAgentConnected(Boolean(msg.connected));
          if (msg.type === 'refresh') reloadProjects();
        } catch {
          // ignore malformed payloads
        }
      };
      ws.onclose = () => {
        if (cancelled) return;
        attempts += 1;
        const delay = Math.min(15000, 500 * 2 ** Math.min(attempts, 5));
        retryTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => {
        // close handler will fire next and schedule the retry
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reloadProjects = useCallback(async (nextProjectId?: string, nextTabId?: string) => {
    const res = await fetch('/api/projects');
    if (!res.ok) return;
    const next = await res.json();
    const desiredProjectId = nextProjectId ?? activeProjectIdRef.current;
    const desiredTabId = nextTabId ?? activeTabIdRef.current;
    setProjects(next);
    const project = next.find((item: Project) => item.id === desiredProjectId) ?? next[0];
    setActiveProjectId(project?.id || '');
    const tab = project?.tabs.find((item: Tab) => item.id === desiredTabId) ?? project?.tabs[0];
    setActiveTabId(tab?.id || '');
    if (project?.id && tab?.id && nextTabId) tabHistory.remember(project.id, tab.id);
  }, [tabHistory]);

  const createProject = useCallback(async (formData: FormData) => {
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
  }, [roots, reloadProjects]);

  const createProjectFromForm = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await createProject(new FormData(event.currentTarget));
    event.currentTarget.reset();
  }, [createProject]);

  const createTab = useCallback(async (projectId: string) => {
    const res = await fetch(`/api/projects/${projectId}/tabs`, { method: 'POST' });
    if (!res.ok) {
      console.error('[termag] createTab failed', res.status, await res.text().catch(() => ''));
      return;
    }
    const tab = await res.json();
    await reloadProjects(projectId, tab.id);
  }, [reloadProjects]);

  const renameProject = useCallback(async (projectId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setProjects((current) =>
      current.map((project) => (project.id !== projectId ? project : { ...project, name: trimmed }))
    );
    const res = await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: trimmed })
    });
    if (!res.ok) {
      console.error('[termag] renameProject failed', res.status, await res.text().catch(() => ''));
      await reloadProjects();
    }
  }, [reloadProjects]);

  const renameTab = useCallback(async (projectId: string, tabId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Optimistic update so the user sees the new name immediately.
    setProjects((current) =>
      current.map((project) =>
        project.id !== projectId
          ? project
          : { ...project, tabs: project.tabs.map((tab) => (tab.id !== tabId ? tab : { ...tab, name: trimmed })) }
      )
    );
    // Clear any live xterm title for this session so the new name actually shows.
    const tab = projects.find((p) => p.id === projectId)?.tabs.find((t) => t.id === tabId);
    if (tab?.session) {
      const sessionId = tab.session.id;
      setLiveTitles((current) => {
        if (!(sessionId in current)) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
    }
    const res = await fetch(`/api/projects/${projectId}/tabs/${tabId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: trimmed })
    });
    if (!res.ok) {
      console.error('[termag] renameTab failed', res.status, await res.text().catch(() => ''));
      await reloadProjects();
    }
  }, [projects, reloadProjects]);

  const closeTab = useCallback(async (projectId: string, tabId: string) => {
    const project = projects.find((item) => item.id === projectId);
    if (!project || project.tabs.length <= 1) return;
    const res = await fetch(`/api/projects/${projectId}/tabs/${tabId}`, { method: 'DELETE' });
    if (!res.ok) {
      console.error('[termag] closeTab failed', res.status, await res.text().catch(() => ''));
      return;
    }
    const nextTabId = activeTabIdRef.current === tabId ? tabHistory.nextRecent(project, tabId) : activeTabIdRef.current;
    await reloadProjects(projectId, nextTabId);
  }, [projects, reloadProjects, tabHistory]);

  const selectTab = useCallback((projectId: string, tabId: string) => {
    setActiveProjectId(projectId);
    setActiveTabId(tabId);
    tabHistory.remember(projectId, tabId);
  }, [tabHistory]);

  const switchRecentTab = useCallback((reverse: boolean) => {
    if (!activeProject) return;
    const currentTabId = activeTab?.id ?? activeTabIdRef.current;
    const nextTabId = tabHistory.cycle(activeProject, currentTabId, reverse);
    if (nextTabId) selectTab(activeProject.id, nextTabId);
  }, [activeProject, activeTab, selectTab, tabHistory]);

  const cycleTheme = useCallback(async () => {
    const next = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';
    setTheme(next);
    document.documentElement.dataset.termagTheme = next;
    await fetch('/api/user/theme', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: next })
    });
  }, [theme]);

  // Keep the keyboard ref pointed at the latest values without re-binding.
  handlersRef.current = { activeProject, activeTab, createTab, closeTab, cycleTheme, switchRecentTab };

  const groups = useMemo(() => {
    const result = new Map<string, Project[]>();
    for (const project of projects) {
      const key = `${project.rootKey}/${project.relativePath.split('/')[0] || ''}`;
      result.set(key, [...(result.get(key) ?? []), project]);
    }
    return [...result.entries()];
  }, [projects]);

  const onCommandProject = useCallback((project: Project) => {
    const tabId = project.tabs[0]?.id;
    if (tabId) selectTab(project.id, tabId);
    else setActiveProjectId(project.id);
  }, [selectTab]);

  const onCommandNewTab = useCallback(() => {
    if (activeProject) createTab(activeProject.id);
  }, [activeProject, createTab]);

  const onCommandKill = useCallback(() => {
    if (activeTab?.session) {
      window.dispatchEvent(new CustomEvent('termag:kill-session', { detail: { sessionId: activeTab.session.id } }));
    }
  }, [activeTab]);

  const openSettings = useCallback(() => setSettingsOpen(true), []);

  return (
    <PlatformProvider platform={platform}>
    <main className="flex h-dvh bg-bg text-text">
      <aside className={cn('flex shrink-0 flex-col border-r border-line bg-panel/95 transition-[width] duration-150', sidebarOpen ? 'w-[292px]' : 'w-[60px]')}>
        <div className="flex h-14 items-center justify-between border-b border-line px-3">
          {sidebarOpen ? <span className="text-sm font-semibold">termag-next</span> : <TerminalSquare className="mx-auto h-4 w-4" />}
          <button className="grid h-8 w-8 place-items-center rounded-md hover:bg-panel2" title={`Toggle sidebar${shortcutSuffix(['mod', '\\'], platform)}`} onClick={() => setSidebarOpen((value) => !value)}>
            {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {sidebarOpen && (
            <div className="mb-4">
              <button
                className="flex h-9 w-full items-center justify-between rounded-md border border-line bg-panel px-3 text-sm font-medium shadow-sm hover:bg-panel2"
                onClick={() => setCreateOpen((value) => !value)}
              >
                <span className="flex items-center gap-2"><Plus className="h-4 w-4" /> New project</span>
                <Shortcut keys={['alt', 'mod', 'N']} />
              </button>
              {createOpen && (
                <form onSubmit={createProjectFromForm} className="mt-2 rounded-lg border border-line bg-panel p-3 shadow-sm">
                  <div className="mb-2 text-xs font-medium text-muted">Project details</div>
                  <input name="name" placeholder="Name" className="mb-2 h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent" />
                  <div className="mb-2 grid grid-cols-[72px_150px] gap-2">
                    <select name="rootKey" className="h-9 min-w-0 rounded-md border border-line bg-bg px-2 text-sm">
                      {Object.keys(roots).map((root) => <option key={root}>{root}</option>)}
                    </select>
                    <input name="relativePath" placeholder="Repo path" className="h-9 min-w-0 rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent" />
                  </div>
                  <select name="agentType" className="mb-3 h-9 w-full rounded-md border border-line bg-bg px-2 text-sm">
                    {(Object.entries(AGENT_DEFAULTS) as Array<[string, { label: string }]>).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
                  </select>
                  <button className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-bg">
                    <Plus className="h-4 w-4" /> Create project
                  </button>
                </form>
              )}
            </div>
          )}

          <div className="space-y-4">
            {groups.map(([group, groupProjects]) => (
              <section key={group}>
                {sidebarOpen && <div className="mb-1.5 px-1 text-[11px] font-medium uppercase text-muted">{group}</div>}
                <div className="space-y-1">
                  {groupProjects.map((project) => {
                    const isActiveProject = project.id === activeProject?.id;
                    return (
                      <div key={project.id}>
                        <div className={cn('group/project flex h-9 w-full items-center rounded-md hover:bg-panel2', isActiveProject && 'bg-panel2 shadow-sm')}>
                          <div
                            role="button"
                            tabIndex={0}
                            className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-l-md px-2 text-left text-sm"
                            title={`${project.rootKey}/${project.relativePath}`}
                            onClick={() => {
                              const tabId = project.tabs[0]?.id;
                              if (tabId) selectTab(project.id, tabId);
                              else setActiveProjectId(project.id);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                const tabId = project.tabs[0]?.id;
                                if (tabId) selectTab(project.id, tabId);
                                else setActiveProjectId(project.id);
                              }
                            }}
                          >
                            <span className={cn('h-2 w-2 shrink-0 rounded-full', statusDot(agentConnected ? project.status : 'sleeping'))} />
                            {sidebarOpen ? (
                              <>
                                <TabLabel
                                  name={project.name}
                                  className="min-w-0 flex-1 truncate"
                                  onRename={(next) => renameProject(project.id, next)}
                                />
                                <span className="text-xs text-muted">{AGENT_DEFAULTS[project.agentType as keyof typeof AGENT_DEFAULTS]?.badge ?? project.agentType.slice(0, 2).toUpperCase()}</span>
                              </>
                            ) : (
                              <span className="text-xs font-medium">{project.name.slice(0, 2).toUpperCase()}</span>
                            )}
                          </div>
                          {sidebarOpen && (
                            <button
                              type="button"
                              className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-muted opacity-0 hover:bg-bg hover:text-text focus:opacity-100 group-hover/project:opacity-100"
                              onClick={(event) => {
                                event.stopPropagation();
                                createTab(project.id);
                              }}
                              title={`New session${shortcutSuffix(['alt', 'mod', 'T'], platform)}`}
                              aria-label="New session"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                        {sidebarOpen && project.tabs.length > 0 && (
                          <div className="mt-0.5 space-y-0.5 pl-4">
                            {project.tabs.map((tab) => {
                              const isActiveTab = isActiveProject && tab.id === activeTab?.id;
                              return (
                                <div
                                  key={tab.id}
                                  role="button"
                                  tabIndex={0}
                                  className={cn('group/tab flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-panel2', isActiveTab && 'bg-panel2 shadow-sm')}
                                  onClick={() => selectTab(project.id, tab.id)}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                      event.preventDefault();
                                      selectTab(project.id, tab.id);
                                    }
                                  }}
                                >
                                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDot(agentConnected ? tab.status : 'sleeping'))} />
                                  <TabLabel
                                    name={tab.name}
                                    liveTitle={tab.session ? liveTitles[tab.session.id] : null}
                                    className="min-w-0 flex-1 truncate"
                                    onRename={(next) => renameTab(project.id, tab.id, next)}
                                  />
                                  {project.tabs.length > 1 && (
                                    <span
                                      className="grid h-4 w-4 shrink-0 place-items-center rounded text-muted opacity-0 hover:bg-bg hover:text-text group-hover/tab:opacity-100"
                                      title="Close session"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        closeTab(project.id, tab.id);
                                      }}
                                    >
                                      ×
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>

        <div className="border-t border-line p-3">
          <button className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm hover:bg-panel2" onClick={() => setPaletteOpen(true)}>
            <CommandIcon className="h-4 w-4" />
            {sidebarOpen && <><span className="flex-1 text-left">Command</span><Shortcut keys={['mod', 'K']} /></>}
          </button>
          <button className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm hover:bg-panel2" onClick={openSettings}>
            <Settings className="h-4 w-4" />
            {sidebarOpen && <><span className="flex-1 text-left">Settings</span><Shortcut keys={['mod', ',']} /></>}
          </button>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-panel px-4">
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
            <IconButton title={`Search scrollback${shortcutSuffix(['mod', 'shift', 'F'], platform)}`} onClick={() => setSearchOpen(true)}><Search className="h-4 w-4" /></IconButton>
            <IconButton title="Toggle ctrl pane" onClick={() => setShowCtrl((value) => !value)}>
              {showCtrl ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            </IconButton>
            <IconButton title={`Cycle theme${shortcutSuffix(['mod', '.'], platform)}`} onClick={cycleTheme}>
              {theme === 'light' ? <Sun className="h-4 w-4" /> : theme === 'dark' ? <Moon className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
            </IconButton>
          </div>
        </header>

        {activeProject && (
          <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-panel px-3">
            {activeProject.tabs.map((tab) => (
              <button
                key={tab.id}
                className={cn('flex h-8 max-w-[180px] items-center gap-2 rounded-md border border-transparent px-2 text-sm hover:bg-panel2', tab.id === activeTab?.id && 'border-line bg-panel2 shadow-sm')}
                onClick={() => selectTab(activeProject.id, tab.id)}
              >
                <span className={cn('h-2 w-2 rounded-full', statusDot(agentConnected ? tab.status : 'sleeping'))} />
                <TabLabel
                  name={tab.name}
                  liveTitle={tab.session ? liveTitles[tab.session.id] : null}
                  className="truncate"
                  onRename={(next) => renameTab(activeProject.id, tab.id, next)}
                />
                {activeProject.tabs.length > 1 && (
                  <span
                    className="grid h-5 w-5 place-items-center rounded text-muted hover:bg-bg hover:text-text"
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
            <button className="ml-1 flex h-8 items-center gap-2 rounded-md border border-line bg-panel px-2 text-sm hover:bg-panel2" title={`New session${shortcutSuffix(['alt', 'mod', 'T'], platform)}`} onClick={() => createTab(activeProject.id)}>
              <Plus className="h-4 w-4" /><Shortcut keys={['alt', 'mod', 'T']} />
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1 gap-3 bg-bg p-3">
          {activeTab?.session ? (
            <TerminalPane
              key={activeTab.session.id}
              active
              sessionId={activeTab.session.id}
              title={liveTitles[activeTab.session.id] || activeTab.name}
              status={agentConnected ? activeTab.session.status : 'sleeping'}
              onTitleChange={handleSessionTitle}
            />
          ) : (
            <div className="grid flex-1 place-items-center rounded-lg border border-dashed border-line bg-panel text-sm text-muted">Create a project to open a session.</div>
          )}
          {showCtrl && ctrlSession && (
            <TerminalPane
              key={ctrlSession.id}
              active
              sessionId={ctrlSession.id}
              title={liveTitles[ctrlSession.id] || 'ctrl'}
              status={agentConnected ? ctrlSession.status : 'sleeping'}
              onTitleChange={handleSessionTitle}
            />
          )}
        </div>
      </section>

      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            projects={projects}
            onProject={onCommandProject}
            onNewTab={onCommandNewTab}
            onKill={onCommandKill}
            onTheme={cycleTheme}
            onSettings={openSettings}
            authMode={authMode}
          />
        </Suspense>
      )}
      {searchOpen && (
        <Suspense fallback={null}>
          <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} />
        </Suspense>
      )}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} user={user} agentConnected={agentConnected} />
        </Suspense>
      )}
    </main>
    </PlatformProvider>
  );
}

function IconButton({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button className="grid h-8 w-8 place-items-center rounded-md hover:bg-panel2" title={title} onClick={onClick}>
      {children}
    </button>
  );
}
