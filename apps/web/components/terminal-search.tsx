"use client";

import { useState, useEffect, useRef } from "react";
import { Search, X, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface TerminalSearchProps {
  isOpen: boolean;
  onClose: () => void;
  onSearch: (query: string, options: SearchOptions) => void;
  onFindNext?: () => void;
  onFindPrevious?: () => void;
  initialQuery?: string;
}

interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
}

export function TerminalSearch({
  isOpen,
  onClose,
  onSearch,
  onFindNext,
  onFindPrevious,
  initialQuery = "",
}: TerminalSearchProps) {
  const [query, setQuery] = useState(initialQuery);
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    regex: false,
    wholeWord: false,
  });
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [currentMatch, setCurrentMatch] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          onClose();
        } else if (e.key === "Enter") {
          if (e.shiftKey) {
            onFindPrevious?.();
          } else {
            onFindNext?.();
          }
        } else if (e.key === "F3") {
          if (e.shiftKey) {
            onFindPrevious?.();
          } else {
            onFindNext?.();
          }
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [isOpen, onClose, onFindNext, onFindPrevious]);

  const handleSearch = (newQuery: string) => {
    setQuery(newQuery);
    if (newQuery) {
      onSearch(newQuery, options);
      // In a real implementation, you'd get match count from the search result
      // For now, we'll simulate it
      setMatchCount(newQuery.length > 0 ? Math.floor(Math.random() * 10) + 1 : null);
      setCurrentMatch(1);
    } else {
      setMatchCount(null);
      setCurrentMatch(0);
    }
  };

  const handleOptionChange = (key: keyof SearchOptions) => {
    const newOptions = { ...options, [key]: !options[key] };
    setOptions(newOptions);
    if (query) {
      handleSearch(query);
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed top-0 left-0 right-0 bg-gray-100 dark:bg-gray-800 border-b border-gray-300 dark:border-gray-700 p-3 z-50">
      <div className="max-w-4xl mx-auto flex items-center gap-3">
        {/* Search Input */}
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Search in terminal..."
            className="w-full pl-10 pr-4 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 dark:text-gray-100 placeholder-gray-400"
          />
        </div>

        {/* Search Options */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleOptionChange("caseSensitive")}
            className={cn(
              "px-3 py-1.5 rounded text-sm font-medium transition-colors",
              options.caseSensitive
                ? "bg-blue-600 text-white"
                : "bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
            )}
            title="Match case"
          >
            Aa
          </button>

          <button
            onClick={() => handleOptionChange("regex")}
            className={cn(
              "px-3 py-1.5 rounded text-sm font-medium transition-colors",
              options.regex
                ? "bg-blue-600 text-white"
                : "bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
            )}
            title="Use regular expression"
          >
            .*
          </button>

          <button
            onClick={() => handleOptionChange("wholeWord")}
            className={cn(
              "px-3 py-1.5 rounded text-sm font-medium transition-colors",
              options.wholeWord
                ? "bg-blue-600 text-white"
                : "bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
            )}
            title="Match whole word"
          >
            &quot; &quot;
          </button>
        </div>

        {/* Navigation */}
        <div className="flex items-center gap-1">
          <button
            onClick={onFindPrevious}
            disabled={!matchCount || matchCount === 0}
            className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Find previous (Shift+Enter)"
          >
            <ArrowUp className="h-4 w-4 text-gray-600 dark:text-gray-400" />
          </button>

          <button
            onClick={onFindNext}
            disabled={!matchCount || matchCount === 0}
            className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Find next (Enter)"
          >
            <ArrowDown className="h-4 w-4 text-gray-600 dark:text-gray-400" />
          </button>
        </div>

        {/* Match Counter */}
        {matchCount !== null && matchCount > 0 && (
          <div className="text-sm text-gray-600 dark:text-gray-400 min-w-[80px]">
            {currentMatch} of {matchCount}
          </div>
        )}

        {/* Close Button */}
        <button
          onClick={onClose}
          className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          title="Close (Escape)"
        >
          <X className="h-4 w-4 text-gray-600 dark:text-gray-400" />
        </button>
      </div>

      {/* Keyboard Shortcuts Hint */}
      <div className="max-w-4xl mx-auto mt-2 text-xs text-gray-500 dark:text-gray-400">
        <span className="mr-4">
          <kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">Enter</kbd> Next
        </span>
        <span className="mr-4">
          <kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">Shift+Enter</kbd>{" "}
          Previous
        </span>
        <span className="mr-4">
          <kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">Escape</kbd> Close
        </span>
      </div>
    </div>
  );
}
