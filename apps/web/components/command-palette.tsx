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
  onCreateProject?: () => void;
  onNewSession?: () => void;
  onSwitchProject?: (projectId: string) => void;
  onOpenSettings?: () => void;
  onToggleTheme?: () => void;
  onOpenShortcuts?: () => void;
  onOpenHelp?: () => void;
  onSearchFiles?: () => void;
  onSearchHistory?: () => void;
  onOpenTemplates?: () => void;
  onOpenSnippets?: () => void;
  onClearTerminal?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  projects?: Array<{ id: string; name: string; rootKey: string }>;
}): Command[] {
  const {
    onCreateProject,
    onNewSession,
    onSwitchProject,
    onOpenSettings,
    onToggleTheme,
    onOpenShortcuts,
    onOpenHelp,
    onSearchFiles,
    onSearchHistory,
    onOpenTemplates,
    onOpenSnippets,
    onClearTerminal,
    onZoomIn,
    onZoomOut,
    projects = [],
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
      icon: Minus, // Need to import
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
