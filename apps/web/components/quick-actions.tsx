"use client";

import { useState } from "react";
import {
  Copy,
  ClipboardPaste,
  Trash2,
  Maximize2,
  Minimize2,
  Search,
  MoreHorizontal,
  Check,
  LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard, pasteFromClipboard } from "@/lib/usability";
import { useToast } from "./toast-provider";

interface QuickActionsProps {
  onClear?: () => void;
  onCopy?: () => string | null;
  onPaste?: (text: string) => void;
  onSearch?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onResetZoom?: () => void;
  className?: string;
}

interface ActionButtonProps {
  icon: LucideIcon;
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
  onCopy,
  onPaste,
  onSearch,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  className,
}: QuickActionsProps) {
  const [showMore, setShowMore] = useState(false);
  const [copied, setCopied] = useState(false);
  const { success, error } = useToast();

  const handleCopy = async () => {
    let text: string | null = null;
    if (onCopy) {
      text = onCopy();
    }

    if (!text) {
      // Try to get selected text
      const selection = window.getSelection();
      text = selection?.toString() || null;
    }

    if (text) {
      const success = await copyToClipboard(text);
      if (success) {
        setCopied(true);
        success("Copied to clipboard");
        setTimeout(() => setCopied(false), 2000);
      } else {
        error("Failed to copy");
      }
    }
  };

  const handlePaste = async () => {
    const text = await pasteFromClipboard();
    if (text && onPaste) {
      onPaste(text);
      success("Pasted from clipboard");
    } else {
      error("Nothing to paste");
    }
  };

  const handleClear = () => {
    if (onClear) {
      onClear();
      success("Terminal cleared");
    }
  };

  return (
    <div className={cn("flex items-center gap-1", className)}>
      {/* Primary Actions */}
      <ActionButton
        icon={copied ? Check : Copy}
        label={copied ? "Copied!" : "Copy"}
        onClick={handleCopy}
      />

      <ActionButton icon={ClipboardPaste} label="Paste" onClick={handlePaste} />

      {onSearch && <ActionButton icon={Search} label="Search" onClick={onSearch} />}

      {onClear && <ActionButton icon={Trash2} label="Clear" onClick={handleClear} />}

      {/* Zoom Controls */}
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

      {/* More Actions */}
      {(onZoomIn || onZoomOut || onResetZoom) && (
        <div className="w-px h-6 bg-gray-300 dark:bg-gray-700 mx-1" />
      )}

      <button
        onClick={() => setShowMore(!showMore)}
        className="flex flex-col items-center justify-center p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors group relative"
        title="More actions"
      >
        <MoreHorizontal className="h-4 w-4 text-gray-600 dark:text-gray-400" />
        <span className="absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
          More
        </span>
      </button>
    </div>
  );
}
