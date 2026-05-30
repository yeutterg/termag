"use client";

import {
  Trash2,
  Maximize2,
  Minimize2,
  Search,
  MoreHorizontal,
  RefreshCw,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "./toast-provider";

interface QuickActionsProps {
  onClear?: () => void;
  onSearch?: () => void;
  onRefresh?: () => void;
  onSettings?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onResetZoom?: () => void;
  className?: string;
}

interface ActionButtonProps {
  icon: any;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

function ActionButton({ icon: Icon, label, onClick, disabled = false }: ActionButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col items-center justify-center p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
        "group relative"
      )}
      title={label}
    >
      <Icon className="h-4 w-4 text-gray-600 dark:text-gray-400" />
      <span className="sr-only">{label}</span>
      {/* Tooltip */}
      <span className="absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
        {label}
      </span>
    </button>
  );
}

export function QuickActions({
  onClear,
  onSearch,
  onRefresh,
  onSettings,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  className,
}: QuickActionsProps) {
  const { success } = useToast();

  const handleClear = () => {
    if (onClear) {
      onClear();
      success("Terminal cleared");
    }
  };

  return (
    <div className={cn("flex items-center gap-1", className)}>
      {/* Terminal-specific actions */}
      {onRefresh && <ActionButton icon={RefreshCw} label="Refresh session" onClick={onRefresh} />}

      {onSearch && <ActionButton icon={Search} label="Search in terminal" onClick={onSearch} />}

      {onClear && <ActionButton icon={Trash2} label="Clear terminal" onClick={handleClear} />}

      {/* Zoom controls */}
      {(onZoomIn || onZoomOut || onResetZoom) && (
        <>
          <div className="w-px h-6 bg-gray-300 dark:bg-gray-700 mx-1" />

          {onZoomOut && <ActionButton icon={Minimize2} label="Zoom Out" onClick={onZoomOut} />}

          {onResetZoom && (
            <ActionButton icon={MoreHorizontal} label="Reset Zoom" onClick={onResetZoom} />
          )}

          {onZoomIn && <ActionButton icon={Maximize2} label="Zoom In" onClick={onZoomIn} />}
        </>
      )}

      {/* Settings */}
      {onSettings && (
        <>
          <div className="w-px h-6 bg-gray-300 dark:bg-gray-700 mx-1" />
          <ActionButton icon={Settings} label="Settings" onClick={onSettings} />
        </>
      )}
    </div>
  );
}
