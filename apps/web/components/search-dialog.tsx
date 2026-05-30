"use client";

import { useState } from "react";
import { Search, X, Replace } from "lucide-react";
import { cn } from "@/lib/utils";

interface SearchDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSearch?: (query: string) => void;
  onReplace?: (search: string, replace: string) => void;
  mode?: "search" | "replace";
  className?: string;
}

export function SearchDialog({
  isOpen,
  onClose,
  onSearch,
  onReplace,
  mode = "search",
  className,
}: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");

  if (!isOpen) {
    return null;
  }

  const handleSearch = () => {
    if (query.trim() && onSearch) {
      onSearch(query.trim());
      onClose();
    }
  };

  const handleReplace = () => {
    if (query.trim() && onReplace) {
      onReplace(query.trim(), replaceText);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div
        className={cn(
          "relative w-full max-w-xl bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden",
          className
        )}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          {mode === "search" ? (
            <Search className="h-5 w-5 text-gray-400" />
          ) : (
            <Replace className="h-5 w-5 text-gray-400" />
          )}
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={mode === "search" ? "Search..." : "Find..."}
            className="flex-1 bg-transparent outline-none text-gray-900 dark:text-gray-100"
            onKeyDown={e => {
              if (e.key === "Enter") {
                if (mode === "search") {
                  handleSearch();
                } else if (query.trim() && onReplace) {
                  handleReplace();
                }
              }
            }}
          />
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
          >
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {mode === "replace" && (
          <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <Replace className="h-5 w-5 text-gray-400" />
            <input
              type="text"
              value={replaceText}
              onChange={e => setReplaceText(e.target.value)}
              placeholder="Replace with..."
              className="flex-1 bg-transparent outline-none text-gray-900 dark:text-gray-100"
              onKeyDown={e => {
                if (e.key === "Enter") {
                  handleReplace();
                }
              }}
            />
          </div>
        )}

        <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>Press Enter to {mode === "search" ? "search" : "replace"}</span>
          <span>ESC to close</span>
        </div>
      </div>
    </div>
  );
}
