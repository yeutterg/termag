"use client";

import { useState } from "react";
import { X, Split, Pin, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tab } from "@/lib/session-manager";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onTabSwitch: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onSplitHorizontal: (tabId: string) => void;
  onSplitVertical: (tabId: string) => void;
  onPin: (tabId: string) => void;
  onRename?: (tabId: string, newName: string) => void;
  className?: string;
}

export function TabBar({
  tabs,
  activeTabId,
  onTabSwitch,
  onTabClose,
  onSplitHorizontal,
  onSplitVertical,
  onPin,
  onRename,
  className,
}: TabBarProps) {
  const [renamingTab, setRenamingTab] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const handleDoubleClick = (tab: Tab) => {
    if (onRename) {
      setRenamingTab(tab.id);
      setNewName(tab.name);
    }
  };

  const handleRenameSubmit = () => {
    if (renamingTab && newName.trim() && onRename) {
      onRename(renamingTab, newName.trim());
      setRenamingTab(null);
      setNewName("");
    }
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleRenameSubmit();
    } else if (e.key === "Escape") {
      setRenamingTab(null);
      setNewName("");
    }
  };

  // Filter to show only root tabs (not splits)
  const rootTabs = tabs.filter(t => !t.splitFrom);

  return (
    <div
      className={cn("flex items-center gap-1 bg-gray-100 dark:bg-gray-800 px-2 py-1", className)}
    >
      {rootTabs.map(tab => {
        const isActive = activeTabId === tab.id;
        const hasChildren = tabs.some(t => t.splitFrom === tab.id);

        return (
          <div key={tab.id} className="relative group">
            <div
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer transition-all",
                "hover:bg-white dark:hover:bg-gray-700",
                isActive ? "bg-white dark:bg-gray-700 shadow-sm" : "bg-transparent"
              )}
              onClick={() => onTabSwitch(tab.id)}
              onDoubleClick={() => handleDoubleClick(tab)}
            >
              {tab.isPinned && <Pin className="h-3 w-3 text-gray-400" />}

              {renamingTab === tab.id ? (
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onBlur={handleRenameSubmit}
                  onKeyDown={handleRenameKeyDown}
                  onClick={e => e.stopPropagation()}
                  className="bg-transparent outline-none text-sm font-medium"
                  autoFocus
                />
              ) : (
                <span className="text-sm font-medium truncate max-w-32">{tab.name}</span>
              )}

              {hasChildren && <Split className="h-3 w-3 text-gray-400" />}

              <button
                onClick={e => {
                  e.stopPropagation();
                  onPin(tab.id);
                }}
                className="p-0.5 hover:bg-gray-200 dark:hover:bg-gray-600 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                title={tab.isPinned ? "Unpin" : "Pin"}
              >
                <Pin className={cn("h-3 w-3", tab.isPinned && "text-blue-500")} />
              </button>

              <button
                onClick={e => {
                  e.stopPropagation();
                  onTabClose(tab.id);
                }}
                className="p-0.5 hover:bg-red-100 dark:hover:bg-red-900 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                title="Close tab"
              >
                <X className="h-3 w-3 text-gray-400 hover:text-red-500" />
              </button>
            </div>

            {/* Split menu */}
            {isActive && (
              <div className="absolute top-full left-0 mt-1 bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 z-10 opacity-0 group-hover:opacity-100 invisible group-hover:visible transition-all">
                <button
                  onClick={e => {
                    e.stopPropagation();
                    onSplitHorizontal(tab.id);
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 w-full"
                >
                  <Split className="h-4 w-4 rotate-90" />
                  Split Horizontal
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    onSplitVertical(tab.id);
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 w-full"
                >
                  <Split className="h-4 w-4" />
                  Split Vertical
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleDoubleClick(tab);
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 w-full"
                >
                  <Copy className="h-4 w-4" />
                  Rename
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
