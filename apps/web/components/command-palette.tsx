"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useState, useEffect, useRef } from "react";
import {
  Search,
  Terminal,
  Folder,
  Plus,
  Settings,
  File,
  Layers,
  Zap,
  Book,
  Moon,
  Keyboard,
  HelpCircle,
  Minus,
  X,
  Split,
  Copy,
  Clipboard,
  GitBranch,
  GitCommit,
  GitPullRequest,
  GitFork,
  RefreshCw,
  Maximize2,
  Layout,
  Pin,
  Download,
  Upload,
  Play,
  Command,
  Clock,
  History,
  FileType,
  Replace,
  Monitor,
  Sidebar,
  Square,
  GitMerge,
  Type,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface Command {
  id: string;
  label: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  category: string;
  keywords?: string[];
  action: () => void;
  shortcut?: string;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: Command[];
  placeholder?: string;
}

export function CommandPalette({
  isOpen,
  onClose,
  commands,
  placeholder = "Type a command or search...",
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Filter commands
  const filteredCommands = commands
    .filter(cmd => {
      const searchStr =
        `${cmd.label} ${cmd.description || ""} ${cmd.keywords?.join(" ") || ""}`.toLowerCase();
      const queryLower = query.toLowerCase();

      // Exact match gets priority
      if (searchStr === queryLower) {
        return true;
      }

      // Fuzzy match
      return searchStr.includes(queryLower);
    })
    .sort((a, b) => {
      // Exact match first
      const aExact = a.label.toLowerCase() === query.toLowerCase();
      const bExact = b.label.toLowerCase() === query.toLowerCase();
      if (aExact && !bExact) {
        return -1;
      }
      if (!aExact && bExact) {
        return 1;
      }

      // Then by category order
      return 0;
    });

  // Group by category
  const groupedCommands = filteredCommands.reduce(
    (acc, cmd) => {
      if (!acc[cmd.category]) {
        acc[cmd.category] = [];
      }
      acc[cmd.category].push(cmd);
      return acc;
    },
    {} as Record<string, Command[]>
  );

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) {
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex(prev => Math.min(prev + 1, filteredCommands.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex(prev => Math.max(prev - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (filteredCommands[selectedIndex]) {
            filteredCommands[selectedIndex].action();
            onClose();
          }
          break;
        case "Escape":
          onClose();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, filteredCommands, selectedIndex, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const selectedElement = listRef.current.children[selectedIndex] as HTMLElement;
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex]);

  const handleSelect = (command: Command) => {
    command.action();
    onClose();
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Palette */}
      <div className="relative w-full max-w-2xl bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-gray-200 dark:border-gray-700">
          <Search className="h-5 w-5 text-gray-400" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={placeholder}
            className="flex-1 bg-transparent outline-none text-gray-900 dark:text-gray-100 placeholder-gray-500"
          />
          <kbd className="px-2 py-1 text-xs text-gray-500 bg-gray-100 dark:bg-gray-800 rounded">
            ESC
          </kbd>
        </div>

        {/* Command List */}
        <div ref={listRef} className="max-h-96 overflow-y-auto p-2">
          {filteredCommands.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500 dark:text-gray-400">
              <Search className="h-8 w-8 mb-2 opacity-50" />
              <p>No commands found</p>
            </div>
          ) : (
            Object.entries(groupedCommands).map(([category, cmds]) => (
              <div key={category} className="mb-4">
                <div className="px-2 py-1 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {category}
                </div>
                {cmds.map((cmd, _idx) => {
                  const globalIndex = filteredCommands.indexOf(cmd);
                  const isSelected = globalIndex === selectedIndex;
                  const Icon = cmd.icon;

                  return (
                    <button
                      key={cmd.id}
                      onClick={() => handleSelect(cmd)}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors",
                        isSelected
                          ? "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300"
                          : "hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-900 dark:text-gray-100"
                      )}
                    >
                      {Icon && <Icon className="h-4 w-4 shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{cmd.label}</div>
                        {cmd.description && (
                          <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                            {cmd.description}
                          </div>
                        )}
                      </div>
                      {cmd.shortcut && (
                        <kbd className="px-2 py-1 text-xs text-gray-500 bg-gray-100 dark:bg-gray-800 rounded shrink-0">
                          {cmd.shortcut}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">↑↓</kbd>
              Navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">Enter</kbd>
              Select
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">ESC</kbd>
              Close
            </span>
          </div>
          <div>{filteredCommands.length} commands</div>
        </div>
      </div>
    </div>
  );
}

export function useCommandPalette(_commands: Command[]) {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+K or Ctrl+K to open
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setIsOpen(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return {
    isOpen,
    open: () => setIsOpen(true),
    close: () => setIsOpen(false),
  };
}

// Pre-configured command sets for termag
export function getTermagCommands(options: {
  sessionId: string;
  workingDirectory?: string;
  // Project Management
  onCreateProject?: () => void;
  onNewSession?: () => void;
  onSwitchProject?: (projectId: string) => void;
  projects?: Array<{ id: string; name: string; rootKey: string }>;

  // Session Management
  onSwitchTab?: (tabId: string) => void;
  onCloseSession?: () => void;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onCreateTab?: () => void;
  onReopenLastClosed?: () => void;
  tabs?: Array<{ id: string; name: string }>;

  // Clipboard History
  onPasteFromHistory?: () => void;
  onCopyLastOutput?: () => void;
  onCopyCurrentLine?: () => void;

  // Git Operations
  onGitStatus?: () => void;
  onGitCommit?: () => void;
  onGitPush?: () => void;
  onGitPull?: () => void;
  onGitLog?: () => void;
  onGitCreateBranch?: () => void;
  onGitSwitchBranch?: (branch: string) => void;
  gitBranches?: string[];

  // Quick Actions
  onRunSnippet?: (snippetId: string) => void;
  snippets?: Array<{ id: string; name: string; command: string }>;
  onApplyTemplate?: (templateId: string) => void;
  templates?: Array<{ id: string; name: string }>;
  onToggleAutoSave?: () => void;
  onToggleLineNumbers?: () => void;
  onToggleWordWrap?: () => void;

  // Search
  onSearchInFile?: () => void;
  onSearchAllFiles?: () => void;
  onGrepSearch?: () => void;
  onReplaceInFile?: () => void;

  // Window Management
  onFocusTerminal?: () => void;
  onFocusFileExplorer?: () => void;
  onFocusSidebar?: () => void;
  onToggleFullscreen?: () => void;
  onToggleSidebar?: () => void;

  // Advanced
  onExecuteCustomCommand?: () => void;
  onOpenRecentProject?: (projectId: string) => void;
  recentProjects?: Array<{ id: string; name: string }>;
  onPinSession?: () => void;
  onExportSession?: () => void;
  onImportSession?: () => void;

  // Navigation
  onSearchFiles?: () => void;
  onSearchHistory?: () => void;
  onOpenTemplates?: () => void;
  onOpenSnippets?: () => void;

  // Terminal Actions
  onClearTerminal?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;

  // Settings
  onOpenSettings?: () => void;
  onToggleTheme?: () => void;
  onOpenShortcuts?: () => void;

  // Help
  onOpenHelp?: () => void;
}): Command[] {
  const {
    _sessionId,
    _workingDirectory,
    // Project Management
    onCreateProject,
    onNewSession,
    onSwitchProject,
    projects = [],

    // Session Management
    onSwitchTab,
    onCloseSession,
    onSplitHorizontal,
    onSplitVertical,
    onCreateTab,
    onReopenLastClosed,
    tabs = [],

    // Clipboard History
    onPasteFromHistory,
    onCopyLastOutput,
    onCopyCurrentLine,

    // Git Operations
    onGitStatus,
    onGitCommit,
    onGitPush,
    onGitPull,
    onGitLog,
    onGitCreateBranch,
    onGitSwitchBranch,
    gitBranches = [],

    // Quick Actions
    onRunSnippet,
    snippets = [],
    onApplyTemplate,
    templates = [],
    onToggleAutoSave,
    onToggleLineNumbers,
    onToggleWordWrap,

    // Search
    onSearchInFile,
    onSearchAllFiles,
    onGrepSearch,
    onReplaceInFile,

    // Window Management
    onFocusTerminal,
    onFocusFileExplorer,
    onFocusSidebar,
    onToggleFullscreen,
    onToggleSidebar,

    // Advanced
    onExecuteCustomCommand,
    onOpenRecentProject,
    recentProjects = [],
    onPinSession,
    onExportSession,
    onImportSession,

    // Navigation
    onSearchFiles,
    onSearchHistory,
    onOpenTemplates,
    onOpenSnippets,

    // Terminal Actions
    onClearTerminal,
    onZoomIn,
    onZoomOut,

    // Settings
    onOpenSettings,
    onToggleTheme,
    onOpenShortcuts,

    // Help
    onOpenHelp,
  } = options;

  const commands: Command[] = [
    // Project Management
    {
      id: "create-project",
      label: "Create New Project",
      description: "Create a new project with terminal sessions",
      icon: Plus,
      category: "Projects",
      keywords: ["new", "add", "project"],
      action: () => onCreateProject?.(),
      shortcut: "⌘N",
    },
    {
      id: "new-session",
      label: "New Terminal Session",
      description: "Open a new terminal session",
      icon: Terminal,
      category: "Projects",
      keywords: ["session", "terminal", "tab"],
      action: () => onNewSession?.(),
      shortcut: "⌘T",
    },
    ...projects.map(p => ({
      id: `switch-${p.id}`,
      label: `Switch to ${p.name}`,
      description: `Switch to project at ${p.rootKey}`,
      icon: Folder,
      category: "Projects",
      keywords: [p.name, p.rootKey, "switch", "project"],
      action: () => onSwitchProject?.(p.id),
    })),

    // Session Management
    ...tabs.map(t => ({
      id: `switch-tab-${t.id}`,
      label: `Switch to ${t.name}`,
      description: "Switch to this tab",
      icon: Square,
      category: "Session",
      keywords: [t.name, "tab", "switch"],
      action: () => onSwitchTab?.(t.id),
    })),
    {
      id: "close-session",
      label: "Close Current Session",
      description: "Close the current terminal session",
      icon: X,
      category: "Session",
      keywords: ["close", "session", "tab"],
      action: () => onCloseSession?.(),
      shortcut: "⌘W",
    },
    {
      id: "split-horizontal",
      label: "Split Pane Horizontal",
      description: "Split terminal horizontally",
      icon: Split,
      category: "Session",
      keywords: ["split", "horizontal", "pane"],
      action: () => onSplitHorizontal?.(),
      shortcut: "⌘D",
    },
    {
      id: "split-vertical",
      label: "Split Pane Vertical",
      description: "Split terminal vertically",
      icon: Split,
      category: "Session",
      keywords: ["split", "vertical", "pane"],
      action: () => onSplitVertical?.(),
      shortcut: "⌘⇧D",
    },
    {
      id: "create-tab",
      label: "Create New Tab",
      description: "Create a new tab in current project",
      icon: Plus,
      category: "Session",
      keywords: ["tab", "new", "create"],
      action: () => onCreateTab?.(),
      shortcut: "⌘T",
    },
    {
      id: "reopen-closed",
      label: "Reopen Last Closed Tab",
      description: "Reopen the most recently closed tab",
      icon: History,
      category: "Session",
      keywords: ["reopen", "restore", "tab"],
      action: () => onReopenLastClosed?.(),
      shortcut: "⌘⇧T",
    },

    // Clipboard History
    {
      id: "paste-history",
      label: "Paste from Clipboard History",
      description: "Select and paste from clipboard history",
      icon: Clipboard,
      category: "Clipboard",
      keywords: ["paste", "clipboard", "history"],
      action: () => onPasteFromHistory?.(),
      shortcut: "⌘⇧V",
    },
    {
      id: "copy-output",
      label: "Copy Last Command Output",
      description: "Copy the output of the last command",
      icon: Copy,
      category: "Clipboard",
      keywords: ["copy", "output", "result"],
      action: () => onCopyLastOutput?.(),
      shortcut: "⌘⇧C",
    },
    {
      id: "copy-line",
      label: "Copy Current Line",
      description: "Copy the current line in terminal",
      icon: Copy,
      category: "Clipboard",
      keywords: ["copy", "line", "current"],
      action: () => onCopyCurrentLine?.(),
      shortcut: "⌘C",
    },

    // Git Operations
    {
      id: "git-status",
      label: "Git Status",
      description: "Show git repository status",
      icon: GitBranch,
      category: "Git",
      keywords: ["git", "status", "repo"],
      action: () => onGitStatus?.(),
    },
    {
      id: "git-commit",
      label: "Git Commit",
      description: "Commit staged changes",
      icon: GitCommit,
      category: "Git",
      keywords: ["git", "commit", "save"],
      action: () => onGitCommit?.(),
    },
    {
      id: "git-push",
      label: "Git Push",
      description: "Push commits to remote",
      icon: GitPullRequest,
      category: "Git",
      keywords: ["git", "push", "upload"],
      action: () => onGitPush?.(),
    },
    {
      id: "git-pull",
      label: "Git Pull",
      description: "Pull changes from remote",
      icon: GitPullRequest,
      category: "Git",
      keywords: ["git", "pull", "download"],
      action: () => onGitPull?.(),
    },
    {
      id: "git-log",
      label: "View Git Log",
      description: "Show commit history",
      icon: History,
      category: "Git",
      keywords: ["git", "log", "history"],
      action: () => onGitLog?.(),
    },
    {
      id: "git-create-branch",
      label: "Create New Branch",
      description: "Create and checkout a new branch",
      icon: GitFork,
      category: "Git",
      keywords: ["git", "branch", "create"],
      action: () => onGitCreateBranch?.(),
    },
    ...gitBranches.map(b => ({
      id: `git-switch-${b}`,
      label: `Switch to ${b}`,
      description: "Switch to this branch",
      icon: GitMerge,
      category: "Git",
      keywords: ["git", "branch", "switch", b],
      action: () => onGitSwitchBranch?.(b),
    })),

    // Quick Actions
    ...snippets.map(s => ({
      id: `run-snippet-${s.id}`,
      label: `Run: ${s.name}`,
      description: s.command,
      icon: Zap,
      category: "Quick Actions",
      keywords: ["snippet", "run", "execute", s.name, s.command],
      action: () => onRunSnippet?.(s.id),
    })),
    ...templates.map(t => ({
      id: `apply-template-${t.id}`,
      label: `Apply: ${t.name}`,
      description: "Apply this session template",
      icon: Layers,
      category: "Quick Actions",
      keywords: ["template", "apply", t.name],
      action: () => onApplyTemplate?.(t.id),
    })),
    {
      id: "toggle-autosave",
      label: "Toggle Auto-Save",
      description: "Enable or disable session auto-save",
      icon: RefreshCw,
      category: "Quick Actions",
      keywords: ["autosave", "auto", "save"],
      action: () => onToggleAutoSave?.(),
    },
    {
      id: "toggle-line-numbers",
      label: "Toggle Line Numbers",
      description: "Show or hide line numbers",
      icon: Type,
      category: "Quick Actions",
      keywords: ["line", "numbers", "toggle"],
      action: () => onToggleLineNumbers?.(),
    },
    {
      id: "toggle-word-wrap",
      label: "Toggle Word Wrap",
      description: "Enable or disable word wrap",
      icon: FileType,
      category: "Quick Actions",
      keywords: ["wrap", "word", "toggle"],
      action: () => onToggleWordWrap?.(),
    },

    // Search
    {
      id: "search-in-file",
      label: "Search in Current File",
      description: "Search within the current file",
      icon: Search,
      category: "Search",
      keywords: ["search", "file", "current"],
      action: () => onSearchInFile?.(),
      shortcut: "⌘F",
    },
    {
      id: "search-all-files",
      label: "Search Across All Files",
      description: "Search across all project files",
      icon: Search,
      category: "Search",
      keywords: ["search", "all", "files"],
      action: () => onSearchAllFiles?.(),
      shortcut: "⇧⌘F",
    },
    {
      id: "grep-search",
      label: "Grep Search",
      description: "Search using grep pattern",
      icon: Command,
      category: "Search",
      keywords: ["grep", "pattern", "regex"],
      action: () => onGrepSearch?.(),
    },
    {
      id: "replace-in-file",
      label: "Replace in File",
      description: "Find and replace in current file",
      icon: Replace,
      category: "Search",
      keywords: ["replace", "find", "substitute"],
      action: () => onReplaceInFile?.(),
      shortcut: "⌘H",
    },

    // Window Management
    {
      id: "focus-terminal",
      label: "Focus Terminal",
      description: "Focus the terminal window",
      icon: Monitor,
      category: "Window",
      keywords: ["focus", "terminal", "window"],
      action: () => onFocusTerminal?.(),
      shortcut: "⌘1",
    },
    {
      id: "focus-file-explorer",
      label: "Focus File Explorer",
      description: "Focus the file explorer",
      icon: Folder,
      category: "Window",
      keywords: ["focus", "file", "explorer"],
      action: () => onFocusFileExplorer?.(),
      shortcut: "⌘2",
    },
    {
      id: "focus-sidebar",
      label: "Focus Sidebar",
      description: "Focus the sidebar",
      icon: Sidebar,
      category: "Window",
      keywords: ["focus", "sidebar"],
      action: () => onFocusSidebar?.(),
      shortcut: "⌘3",
    },
    {
      id: "toggle-fullscreen",
      label: "Toggle Fullscreen",
      description: "Enter or exit fullscreen mode",
      icon: Maximize2,
      category: "Window",
      keywords: ["fullscreen", "maximize"],
      action: () => onToggleFullscreen?.(),
      shortcut: "F11",
    },
    {
      id: "toggle-sidebar",
      label: "Toggle Sidebar",
      description: "Show or hide the sidebar",
      icon: Layout,
      category: "Window",
      keywords: ["sidebar", "toggle", "hide"],
      action: () => onToggleSidebar?.(),
      shortcut: "⌘B",
    },

    // Advanced
    {
      id: "execute-custom",
      label: "Execute Custom Command",
      description: "Run a custom shell command",
      icon: Play,
      category: "Advanced",
      keywords: ["custom", "command", "execute", "run"],
      action: () => onExecuteCustomCommand?.(),
    },
    ...recentProjects.map(p => ({
      id: `recent-${p.id}`,
      label: `Open Recent: ${p.name}`,
      description: "Open this recent project",
      icon: Clock,
      category: "Advanced",
      keywords: ["recent", "project", p.name],
      action: () => onOpenRecentProject?.(p.id),
    })),
    {
      id: "pin-session",
      label: "Pin Current Session",
      description: "Pin the current session to keep it open",
      icon: Pin,
      category: "Advanced",
      keywords: ["pin", "session", "keep"],
      action: () => onPinSession?.(),
    },
    {
      id: "export-session",
      label: "Export Session State",
      description: "Export current session state to file",
      icon: Download,
      category: "Advanced",
      keywords: ["export", "session", "save"],
      action: () => onExportSession?.(),
    },
    {
      id: "import-session",
      label: "Import Session State",
      description: "Import session state from file",
      icon: Upload,
      category: "Advanced",
      keywords: ["import", "session", "load"],
      action: () => onImportSession?.(),
    },

    // Navigation
    {
      id: "search-files",
      label: "Search Files",
      description: "Search across all project files",
      icon: File,
      category: "Navigation",
      keywords: ["file", "search", "find"],
      action: () => onSearchFiles?.(),
      shortcut: "⌘P",
    },
    {
      id: "search-history",
      label: "Search Command History",
      description: "Search your command history",
      icon: Book,
      category: "Navigation",
      keywords: ["history", "command", "search"],
      action: () => onSearchHistory?.(),
      shortcut: "⌘H",
    },
    {
      id: "open-templates",
      label: "Session Templates",
      description: "Manage and apply session templates",
      icon: Layers,
      category: "Navigation",
      keywords: ["template", "preset", "session"],
      action: () => onOpenTemplates?.(),
    },
    {
      id: "open-snippets",
      label: "Command Snippets",
      description: "Manage your command snippets",
      icon: Zap,
      category: "Navigation",
      keywords: ["snippet", "command", "library"],
      action: () => onOpenSnippets?.(),
    },

    // Terminal Actions
    {
      id: "clear-terminal",
      label: "Clear Terminal",
      description: "Clear the current terminal output",
      icon: Terminal,
      category: "Terminal",
      keywords: ["clear", "reset", "clean"],
      action: () => onClearTerminal?.(),
      shortcut: "⌘L",
    },
    {
      id: "zoom-in",
      label: "Zoom In",
      description: "Increase terminal font size",
      icon: Plus,
      category: "Terminal",
      keywords: ["zoom", "font", "size", "larger"],
      action: () => onZoomIn?.(),
      shortcut: "⌘+",
    },
    {
      id: "zoom-out",
      label: "Zoom Out",
      description: "Decrease terminal font size",
      icon: Minus,
      category: "Terminal",
      keywords: ["zoom", "font", "size", "smaller"],
      action: () => onZoomOut?.(),
      shortcut: "⌘-",
    },

    // Settings
    {
      id: "settings",
      label: "Open Settings",
      description: "Configure termag preferences",
      icon: Settings,
      category: "Settings",
      keywords: ["settings", "preferences", "config"],
      action: () => onOpenSettings?.(),
      shortcut: "⌘,",
    },
    {
      id: "toggle-theme",
      label: "Toggle Dark/Light Mode",
      description: "Switch between dark and light theme",
      icon: Moon,
      category: "Settings",
      keywords: ["theme", "dark", "light", "mode"],
      action: () => onToggleTheme?.(),
    },
    {
      id: "shortcuts",
      label: "Keyboard Shortcuts",
      description: "View all keyboard shortcuts",
      icon: Keyboard,
      category: "Settings",
      keywords: ["shortcut", "key", "help"],
      action: () => onOpenShortcuts?.(),
      shortcut: "?",
    },

    // Help
    {
      id: "help",
      label: "Help & Documentation",
      description: "Open help center and documentation",
      icon: HelpCircle,
      category: "Help",
      keywords: ["help", "docs", "documentation", "support"],
      action: () => onOpenHelp?.(),
      shortcut: "⌘/",
    },
  ];

  return commands;
}
