"use client";

import { useEffect, useState } from "react";
import { X, Search, Keyboard, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

interface Shortcut {
  keys: string[];
  description: string;
  category: string;
}

const shortcuts: Shortcut[] = [
  // Session Management
  { keys: ["Cmd", "K"], description: "Quick session switcher", category: "Navigation" },
  { keys: ["Cmd", "P"], description: "Command palette", category: "Navigation" },
  { keys: ["Cmd", "/"], description: "Search in terminal", category: "Navigation" },
  { keys: ["Cmd", "1-9"], description: "Switch to session 1-9", category: "Navigation" },
  { keys: ["Cmd", "["], description: "Previous session", category: "Navigation" },
  { keys: ["Cmd", "]"], description: "Next session", category: "Navigation" },

  // Session Actions
  { keys: ["Cmd", "T"], description: "New session tab", category: "Sessions" },
  { keys: ["Cmd", "W"], description: "Close current session", category: "Sessions" },
  { keys: ["Cmd", "Shift", "T"], description: "Reopen closed session", category: "Sessions" },
  { keys: ["Cmd", "R"], description: "Rename session", category: "Sessions" },

  // Terminal Actions
  { keys: ["Cmd", "C"], description: "Copy selection", category: "Terminal" },
  { keys: ["Cmd", "V"], description: "Paste from clipboard", category: "Terminal" },
  { keys: ["Cmd", "+"], description: "Increase font size", category: "Terminal" },
  { keys: ["Cmd", "-"], description: "Decrease font size", category: "Terminal" },
  { keys: ["Cmd", "0"], description: "Reset font size", category: "Terminal" },
  { keys: ["Cmd", "L"], description: "Clear terminal", category: "Terminal" },

  // UI Actions
  { keys: ["Cmd", ","], description: "Open settings", category: "UI" },
  { keys: ["Cmd", "?"], description: "Show keyboard shortcuts", category: "UI" },
  { keys: ["Escape"], description: "Close modal/dialog", category: "UI" },
  { keys: ["Cmd", "D"], description: "Toggle devices panel", category: "UI" },

  // Search
  { keys: ["Cmd", "F"], description: "Find in terminal", category: "Search" },
  { keys: ["Cmd", "G"], description: "Find next", category: "Search" },
  { keys: ["Cmd", "Shift", "G"], description: "Find previous", category: "Search" },
];

const categories = Array.from(new Set(shortcuts.map(s => s.category)));

export function EnhancedShortcutsHelp({ onClose }: { onClose: () => void }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("All");

  const filteredShortcuts = shortcuts.filter(shortcut => {
    const matchesSearch =
      shortcut.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      shortcut.keys.some(key => key.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesCategory = activeCategory === "All" || shortcut.category === activeCategory;
    return matchesSearch && matchesCategory;
  });

  const formatKey = (key: string) => {
    if (key === "Cmd") {
      return "⌘";
    }
    if (key === "Ctrl") {
      return "⌃";
    }
    if (key === "Alt") {
      return "⌥";
    }
    if (key === "Shift") {
      return "⇧";
    }
    if (key === "Enter") {
      return "↵";
    }
    if (key === "Escape") {
      return "⎋";
    }
    if (key === "Backspace") {
      return "⌫";
    }
    if (key === "Tab") {
      return "⇥";
    }
    if (key === "Space") {
      return "␣";
    }
    return key.length === 1 ? key.toUpperCase() : key;
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-lg">
              <Keyboard className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Keyboard Shortcuts
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Master these shortcuts to boost your productivity
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {/* Search and Filter */}
        <div className="p-6 border-b border-gray-200 dark:border-gray-800 space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search shortcuts..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-gray-100 dark:bg-gray-800 border-0 rounded-lg focus:ring-2 focus:ring-blue-500 text-gray-900 dark:text-gray-100 placeholder-gray-400"
              autoFocus
            />
          </div>

          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setActiveCategory("All")}
              className={cn(
                "px-3 py-1.5 rounded-full text-sm font-medium transition-colors",
                activeCategory === "All"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
              )}
            >
              All
            </button>
            {categories.map(category => (
              <button
                key={category}
                onClick={() => setActiveCategory(category)}
                className={cn(
                  "px-3 py-1.5 rounded-full text-sm font-medium transition-colors",
                  activeCategory === category
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
                )}
              >
                {category}
              </button>
            ))}
          </div>
        </div>

        {/* Shortcuts List */}
        <div className="flex-1 overflow-y-auto p-6">
          {filteredShortcuts.length === 0 ? (
            <div className="text-center py-12">
              <Search className="h-12 w-12 mx-auto text-gray-400 mb-4" />
              <p className="text-gray-500 dark:text-gray-400">
                No shortcuts found for &quot;{searchQuery}&quot;
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {categories.map(category => {
                const categoryShortcuts = filteredShortcuts.filter(s => s.category === category);
                if (categoryShortcuts.length === 0) {
                  return null;
                }

                return (
                  <div key={category}>
                    <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
                      {category}
                    </h3>
                    <div className="grid gap-2">
                      {categoryShortcuts.map((shortcut, index) => (
                        <div
                          key={index}
                          className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex gap-1">
                              {shortcut.keys.map((key, keyIndex) => (
                                <span
                                  key={keyIndex}
                                  className="px-2 py-1 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded text-sm font-medium text-gray-700 dark:text-gray-300 font-mono"
                                >
                                  {formatKey(key)}
                                </span>
                              ))}
                            </div>
                          </div>
                          <span className="text-sm text-gray-600 dark:text-gray-400">
                            {shortcut.description}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
              <Zap className="h-4 w-4" />
              <span>
                Pro tip: Press{" "}
                <kbd className="px-1.5 py-0.5 bg-white dark:bg-gray-900 rounded text-xs font-mono">
                  Escape
                </kbd>{" "}
                to close this dialog
              </span>
            </div>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
