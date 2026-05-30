"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useState, useEffect } from "react";
import { Clipboard, X, Clock, Copy as CopyIcon, Trash2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getClipboardHistory,
  deleteClipboardEntry,
  clearClipboardHistory,
  copyToClipboard,
  formatClipboardTime,
  type ClipboardEntry,
} from "@/lib/clipboard-history";

interface ClipboardHistoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect?: (content: string) => void;
  className?: string;
}

export function ClipboardHistoryDialog({
  isOpen,
  onClose,
  onSelect,
  className,
}: ClipboardHistoryDialogProps) {
  const [history, setHistory] = useState<ClipboardEntry[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (isOpen) {
      setHistory(getClipboardHistory());
      setSearch("");
    }
  }, [isOpen]);

  const filteredHistory = history.filter(
    entry =>
      entry.content.toLowerCase().includes(search.toLowerCase()) ||
      entry.source?.toLowerCase().includes(search.toLowerCase())
  );

  const handleCopy = async (entry: ClipboardEntry) => {
    const success = await copyToClipboard(entry.content, entry.type, entry.source);
    if (success) {
      onSelect?.(entry.content);
      onClose();
    }
  };

  const handleDelete = (id: string) => {
    deleteClipboardEntry(id);
    setHistory(getClipboardHistory());
  };

  const handleClearAll = () => {
    if (confirm("Clear all clipboard history?")) {
      clearClipboardHistory();
      setHistory([]);
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div
        className={cn(
          "relative w-full max-w-2xl bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden",
          className
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Clipboard className="h-5 w-5 text-gray-600 dark:text-gray-400" />
            <h2 className="font-semibold text-gray-900 dark:text-gray-100">Clipboard History</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
          >
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
            <Search className="h-4 w-4 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search clipboard history..."
              className="flex-1 bg-transparent outline-none text-sm"
            />
          </div>
        </div>

        {/* History List */}
        <div className="max-h-96 overflow-y-auto">
          {filteredHistory.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500 dark:text-gray-400">
              <Clipboard className="h-8 w-8 mb-2 opacity-50" />
              <p>No clipboard history</p>
            </div>
          ) : (
            filteredHistory.map(entry => (
              <div
                key={entry.id}
                className="group flex items-start gap-3 p-4 hover:bg-gray-50 dark:hover:bg-gray-800 border-b border-gray-100 dark:border-gray-800 last:border-0"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={cn(
                        "text-xs px-2 py-0.5 rounded",
                        entry.type === "command" &&
                          "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300",
                        entry.type === "output" &&
                          "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300",
                        entry.type === "text" &&
                          "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                      )}
                    >
                      {entry.type}
                    </span>
                    {entry.source && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {entry.source}
                      </span>
                    )}
                    <span className="flex items-center gap-1 text-xs text-gray-400">
                      <Clock className="h-3 w-3" />
                      {formatClipboardTime(entry.timestamp)}
                    </span>
                  </div>
                  <pre className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all font-mono">
                    {entry.content}
                  </pre>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleCopy(entry)}
                    className="p-2 hover:bg-blue-100 dark:hover:bg-blue-900 rounded-lg transition-colors"
                    title="Copy"
                  >
                    <CopyIcon className="h-4 w-4 text-gray-500 hover:text-blue-600" />
                  </button>
                  <button
                    onClick={() => handleDelete(entry.id)}
                    className="p-2 hover:bg-red-100 dark:hover:bg-red-900 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4 text-gray-500 hover:text-red-600" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700">
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {filteredHistory.length} items
          </span>
          <button
            onClick={handleClearAll}
            className="text-sm text-red-600 dark:text-red-400 hover:underline"
          >
            Clear All
          </button>
        </div>
      </div>
    </div>
  );
}
