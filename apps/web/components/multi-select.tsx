"use client";

import { useState } from "react";
import { CheckSquare, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MultiSelectItem {
  id: string;
  [key: string]: unknown;
}

interface MultiSelectToolbarProps {
  selectedIds: Set<string>;
  totalCount: number;
  onClearSelection: () => void;
  onSelectAll: () => void;
  actions: Array<{
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    onClick: () => void;
    variant?: "danger" | "default";
  }>;
  className?: string;
}

export function MultiSelectToolbar({
  selectedIds,
  totalCount,
  onClearSelection,
  onSelectAll,
  actions,
  className,
}: MultiSelectToolbarProps) {
  if (selectedIds.size === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex items-center gap-3 p-3 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg",
        className
      )}
    >
      <div className="flex items-center gap-2">
        <button
          onClick={onSelectAll}
          className="p-1 hover:bg-blue-200 dark:hover:bg-blue-800 rounded transition-colors"
          title={selectedIds.size === totalCount ? "Deselect all" : "Select all"}
        >
          {selectedIds.size === totalCount ? (
            <CheckSquare className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          ) : (
            <Square className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          )}
        </button>
        <span className="text-sm font-medium text-blue-900 dark:text-blue-100">
          {selectedIds.size} selected
        </span>
      </div>

      <div className="h-6 w-px bg-blue-300 dark:bg-blue-700" />

      <div className="flex items-center gap-1">
        {actions.map((action, index) => (
          <button
            key={index}
            onClick={action.onClick}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
              action.variant === "danger"
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
            )}
            title={action.label}
          >
            <action.icon className="h-4 w-4" />
            <span className="hidden sm:inline">{action.label}</span>
          </button>
        ))}
      </div>

      <div className="h-6 w-px bg-blue-300 dark:bg-blue-700" />

      <button
        onClick={onClearSelection}
        className="p-1 hover:bg-blue-200 dark:hover:bg-blue-800 rounded transition-colors"
        title="Clear selection"
      >
        <X className="h-5 w-5 text-blue-600 dark:text-blue-400" />
      </button>
    </div>
  );
}

interface SelectableItemProps {
  id: string;
  isSelected: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
  className?: string;
}

export function SelectableItem({
  id,
  isSelected,
  onToggle,
  children,
  className,
}: SelectableItemProps) {
  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(id);
  };

  return (
    <div className={cn("relative group", isSelected && "bg-blue-50 dark:bg-blue-950", className)}>
      <button
        onClick={handleCheckboxClick}
        className={cn(
          "absolute left-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors opacity-0 group-hover:opacity-100",
          isSelected && "opacity-100"
        )}
        aria-label={isSelected ? "Deselect" : "Select"}
      >
        {isSelected ? (
          <CheckSquare className="h-4 w-4 text-blue-600 dark:text-blue-400" />
        ) : (
          <Square className="h-4 w-4 text-gray-400" />
        )}
      </button>
      {children}
    </div>
  );
}

export function useMultiSelect(items: MultiSelectItem[]) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSelectMode, setIsSelectMode] = useState(false);

  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(items.map(item => item.id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  const toggleSelectMode = () => {
    setIsSelectMode(prev => !prev);
    clearSelection();
  };

  return {
    selectedIds,
    isSelectMode,
    toggleSelection,
    selectAll,
    clearSelection,
    toggleSelectMode,
    hasSelection: selectedIds.size > 0,
  };
}
