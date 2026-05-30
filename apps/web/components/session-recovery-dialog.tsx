"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useState, useEffect, useMemo } from "react";
import { RefreshCw, X, Clock, RotateCcw, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getLatestSnapshot,
  getAllSnapshots,
  recoverFromSnapshot,
  deleteSessionHistory,
  hasRecoveryData,
  formatTimeSinceLastSave,
  getTimeSinceLastSave,
  type SessionSnapshot,
} from "@/lib/session-history";
import { useToast } from "./toast-provider";

interface SessionRecoveryDialogProps {
  isOpen: boolean;
  sessionId: string;
  onRecover: (state: SessionSnapshot["state"]) => void;
  onDismiss: () => void;
}

export function SessionRecoveryDialog({
  isOpen,
  sessionId,
  onRecover,
  onDismiss,
}: SessionRecoveryDialogProps) {
  const [selectedSnapshot, setSelectedSnapshot] = useState<SessionSnapshot | null>(null);
  const { success } = useToast();

  // Compute snapshots outside of effect to avoid setState in effect
  const snapshots = useMemo(() => {
    if (!isOpen || !sessionId) {
      return [];
    }
    const allSnapshots = getAllSnapshots(sessionId);
    return allSnapshots.reverse(); // Most recent first
  }, [isOpen, sessionId]);

  const timeSinceSave = useMemo(() => {
    if (!isOpen || !sessionId) {
      return "";
    }
    const latest = getLatestSnapshot(sessionId);
    if (latest) {
      const time = getTimeSinceLastSave(sessionId);
      if (time !== null) {
        return formatTimeSinceLastSave(time);
      }
    }
    return "";
  }, [isOpen, sessionId]);

  // Set selected snapshot when snapshots change
  useEffect(() => {
    setSelectedSnapshot(snapshots[0] || null);
  }, [snapshots]);

  const handleRecover = () => {
    if (selectedSnapshot) {
      const state = recoverFromSnapshot(selectedSnapshot);
      onRecover(state);
      success("Session recovered successfully");
      onDismiss();
    }
  };

  const handleDelete = () => {
    if (confirm("Are you sure you want to delete all recovery data for this session?")) {
      deleteSessionHistory(sessionId);
      setSnapshots([]);
      setSelectedSnapshot(null);
      success("Recovery data deleted");
      onDismiss();
    }
  };

  const handleDismiss = () => {
    onDismiss();
  };

  if (!isOpen || snapshots.length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-md w-full">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 p-4 bg-blue-50 dark:bg-blue-950 border-b border-blue-200 dark:border-blue-800">
          <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-lg">
            <RefreshCw className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">
              Session Recovery Available
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">Last saved {timeSinceSave}</p>
          </div>
          <button
            onClick={handleDismiss}
            className="p-1 hover:bg-blue-200 dark:hover:bg-blue-800 rounded transition-colors"
          >
            <X className="h-4 w-4 text-gray-600 dark:text-gray-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            We found unsaved changes from your previous session. Would you like to recover them?
          </p>

          {/* Snapshots List */}
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {snapshots.map((snapshot, index) => (
              <button
                key={snapshot.timestamp}
                onClick={() => setSelectedSnapshot(snapshot)}
                className={cn(
                  "w-full p-3 rounded-lg text-left transition-colors",
                  selectedSnapshot?.timestamp === snapshot.timestamp
                    ? "bg-blue-100 dark:bg-blue-900 border-2 border-blue-500"
                    : "bg-gray-50 dark:bg-gray-800 border-2 border-transparent hover:bg-gray-100 dark:hover:bg-gray-700"
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-gray-500" />
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {index === 0 ? "Latest" : `Snapshot ${snapshots.length - index}`}
                    </span>
                  </div>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {new Date(snapshot.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={handleDelete}
            className="flex items-center gap-1 px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 rounded transition-colors"
          >
            <Trash2 className="h-4 w-4" />
            Discard
          </button>

          <div className="flex gap-2">
            <button
              onClick={handleDismiss}
              className="px-4 py-2 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 rounded-lg font-medium hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors border border-gray-300 dark:border-gray-600"
            >
              Start Fresh
            </button>
            <button
              onClick={handleRecover}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
            >
              <RotateCcw className="h-4 w-4" />
              Recover
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Hook to check for recovery data on component mount
 */
export function useSessionRecovery(sessionId: string) {
  // Compute recovery status directly
  const hasRecovery = useMemo(() => {
    if (!sessionId) {
      return false;
    }
    return hasRecoveryData(sessionId);
  }, [sessionId]);

  const [isOpen, setIsOpen] = useState(false);

  // Auto-show recovery dialog if data exists
  useEffect(() => {
    if (hasRecovery) {
      setIsOpen(true);
    }
  }, [hasRecovery]);

  return {
    hasRecovery,
    isOpen,
    setIsOpen,
  };
}
