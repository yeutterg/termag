"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { signOut } from "next-auth/react";
import { Fragment, useState, useEffect, useMemo, useRef } from "react";
import {
  GitCommit,
  GitFork,
  GitMerge,
  GitBranch,
  Download,
  Laptop,
  LogOut,
  Moon,
  Plus,
  Search,
  Terminal,
  Upload,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { GitOperation } from "@/lib/broker";
import type { Project } from "./types";

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
  const filteredCommands = useMemo(
    () =>
      commands
        .filter(cmd => {
          const search =
            `${cmd.label} ${cmd.description || ""} ${cmd.keywords?.join(" ") || ""}`.toLowerCase();
          return search.includes(query.toLowerCase());
        })
        .sort((left, right) => {
          const leftExact = left.label.toLowerCase() === query.toLowerCase();
          const rightExact = right.label.toLowerCase() === query.toLowerCase();
          return Number(rightExact) - Number(leftExact);
        }),
    [commands, query]
  );

  useEffect(() => setSelectedIndex(0), [query, commands]);

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
      const selectedElement = listRef.current.querySelector<HTMLElement>(
        `[data-command-index="${selectedIndex}"]`
      );
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
    <div className="fixed inset-0 z-50 flex items-start justify-center p-3 pt-[max(5dvh,env(safe-area-inset-top))] sm:pt-[15vh]">
      {/* Backdrop */}
      <button
        type="button"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close command palette"
      />

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
        <div ref={listRef} className="max-h-[min(65dvh,24rem)] overflow-y-auto p-2">
          {filteredCommands.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500 dark:text-gray-400">
              <Search className="h-8 w-8 mb-2 opacity-50" />
              <p>No commands found</p>
            </div>
          ) : (
            filteredCommands.map((cmd, index) => {
              const Icon = cmd.icon;
              const startsCategory =
                index === 0 || filteredCommands[index - 1]?.category !== cmd.category;
              return (
                <Fragment key={cmd.id}>
                  {startsCategory && (
                    <div className="px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-gray-500 first:pt-1 dark:text-gray-400">
                      {cmd.category}
                    </div>
                  )}
                  <button
                    data-command-index={index}
                    onClick={() => handleSelect(cmd)}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                      index === selectedIndex
                        ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                        : "text-gray-900 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-800"
                    )}
                  >
                    {Icon && <Icon className="h-4 w-4 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{cmd.label}</div>
                      {cmd.description && (
                        <div className="truncate text-xs text-gray-500 dark:text-gray-400">
                          {cmd.description}
                        </div>
                      )}
                    </div>
                    {cmd.shortcut && (
                      <kbd className="shrink-0 rounded bg-gray-100 px-2 py-1 text-xs text-gray-500 dark:bg-gray-800">
                        {cmd.shortcut}
                      </kbd>
                    )}
                  </button>
                </Fragment>
              );
            })
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

type TermagCommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  onSession: (projectId: string, tabId: string) => void;
  onNewTab: () => void;
  onKill: () => void;
  onTheme: () => void;
  onDevices: () => void;
  onAddDevice?: () => void;
  onGitOperation?: (operation: GitOperation) => void;
  authMode: "oauth" | "password" | "trusted";
};

async function signOutPassword() {
  await fetch("/api/auth/password", { method: "DELETE" }).catch(() => {});
  window.location.href = "/login";
}

// Adapter used by the dashboard. The generic palette above intentionally
// accepts a command list; keeping this dashboard-specific mapping here means
// the entire command UI remains in its lazy-loaded chunk while preserving the
// original Termag integration contract.
export function TermagCommandPalette({
  open,
  onOpenChange,
  projects,
  onSession,
  onNewTab,
  onKill,
  onTheme,
  onDevices,
  onAddDevice,
  onGitOperation,
  authMode,
}: TermagCommandPaletteProps) {
  const commands = useMemo<Command[]>(() => {
    const sessionCommands = projects.flatMap(project =>
      project.tabs.map(tab => ({
        id: `session:${project.id}:${tab.id}`,
        label: `${project.runtimeSpaceName || project.name} / ${tab.runtimeTabName || tab.name}`,
        description: `${project.rootKey} · ${project.runtimeSessionName || project.relativePath}`,
        icon: Terminal,
        category: "Agents",
        keywords: [project.name, tab.name, project.rootKey],
        action: () => onSession(project.id, tab.id),
      }))
    );
    const actions: Command[] = [
      {
        id: "new-tab",
        label: "New tab in current session",
        icon: Plus,
        category: "Commands",
        action: onNewTab,
        shortcut: "⌘↵",
      },
      {
        id: "kill",
        label: "Close current terminal",
        icon: X,
        category: "Commands",
        action: onKill,
      },
      {
        id: "theme",
        label: "Toggle theme",
        icon: Moon,
        category: "Commands",
        action: onTheme,
        shortcut: "⌘.",
      },
      {
        id: "devices",
        label: "Open devices",
        icon: Laptop,
        category: "Commands",
        action: onDevices,
        shortcut: "⌘;",
      },
    ];
    if (onAddDevice) {
      actions.push({
        id: "add-device",
        label: "Add device agent",
        icon: Plus,
        category: "Commands",
        action: onAddDevice,
      });
    }
    if (onGitOperation) {
      actions.push(
        {
          id: "git-status",
          label: "Git status",
          description: "Show the current branch and working tree",
          icon: GitBranch,
          category: "Git",
          action: () => onGitOperation("git.status"),
        },
        {
          id: "git-stage",
          label: "Git stage paths",
          description: "Stage relative paths in this project",
          icon: GitMerge,
          category: "Git",
          action: () => onGitOperation("git.stage"),
        },
        {
          id: "git-branch",
          label: "Git switch branch",
          description: "Switch to an existing branch",
          icon: GitFork,
          category: "Git",
          action: () => onGitOperation("git.branch"),
        },
        {
          id: "git-commit",
          label: "Git commit",
          description: "Commit staged changes",
          icon: GitCommit,
          category: "Git",
          action: () => onGitOperation("git.commit"),
        },
        {
          id: "git-pull",
          label: "Git pull (fast-forward only)",
          icon: Download,
          category: "Git",
          action: () => onGitOperation("git.pull"),
        },
        {
          id: "git-push",
          label: "Git push",
          icon: Upload,
          category: "Git",
          action: () => onGitOperation("git.push"),
        }
      );
    }
    if (authMode === "oauth") {
      actions.push({
        id: "sign-out",
        label: "Sign out",
        icon: LogOut,
        category: "Account",
        action: () => void signOut({ callbackUrl: "/login" }),
      });
    } else if (authMode === "password") {
      actions.push({
        id: "sign-out",
        label: "Sign out",
        icon: LogOut,
        category: "Account",
        action: () => void signOutPassword(),
      });
    }
    return [...sessionCommands, ...actions];
  }, [
    authMode,
    onAddDevice,
    onDevices,
    onGitOperation,
    onKill,
    onNewTab,
    onSession,
    onTheme,
    projects,
  ]);

  return (
    <CommandPalette
      isOpen={open}
      onClose={() => onOpenChange(false)}
      commands={commands}
      placeholder="Jump to a session, tab, or command..."
    />
  );
}
