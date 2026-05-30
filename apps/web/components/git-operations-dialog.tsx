"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useState, useEffect, useCallback } from "react";
import { GitBranch, GitCommit, RefreshCw, X, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getGitBranches,
  getGitStatus,
  gitCommit,
  gitPush,
  gitPull,
  switchBranch,
  type GitBranch as GitBranchType,
  type GitStatus,
} from "@/lib/git-operations";

interface GitOperationsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  workingDirectory: string;
  sessionId: string;
  onCommandExecute?: (command: string) => void;
  className?: string;
}

export function GitOperationsDialog({
  isOpen,
  onClose,
  workingDirectory,
  sessionId,
  onCommandExecute,
  className,
}: GitOperationsDialogProps) {
  const [activeTab, setActiveTab] = useState<"status" | "branches" | "commit" | "log">("status");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranchType[]>([]);
  const [loading, setLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");

  const loadGitData = useCallback(async () => {
    setLoading(true);
    try {
      const [statusData, branchesData] = await Promise.all([
        getGitStatus(workingDirectory, sessionId),
        getGitBranches(workingDirectory, sessionId),
      ]);
      setStatus(statusData);
      setBranches(branchesData);
    } catch (error) {
      console.error("Failed to load git data:", error);
    } finally {
      setLoading(false);
    }
  }, [workingDirectory, sessionId]);

  useEffect(() => {
    if (isOpen) {
      loadGitData();
    }
  }, [isOpen, loadGitData]);

  const handleCommit = async () => {
    if (!commitMessage.trim()) {
      return;
    }

    const success = await gitCommit(commitMessage, workingDirectory, sessionId);
    if (success && onCommandExecute) {
      onCommandExecute(`git commit -m "${commitMessage}"`);
      setCommitMessage("");
      loadGitData();
    }
  };

  const handlePush = async (branch: string | undefined) => {
    const success = await gitPush(branch, workingDirectory, sessionId);
    if (success && onCommandExecute) {
      onCommandExecute(branch ? `git push origin ${branch}` : "git push");
      loadGitData();
    }
  };

  const handlePull = async (branch: string | undefined) => {
    const success = await gitPull(branch, workingDirectory, sessionId);
    if (success && onCommandExecute) {
      onCommandExecute(branch ? `git pull origin ${branch}` : "git pull");
      loadGitData();
    }
  };

  const handleSwitchBranch = async (branchName: string) => {
    const success = await switchBranch(branchName, workingDirectory, sessionId);
    if (success && onCommandExecute) {
      onCommandExecute(`git checkout ${branchName}`);
      loadGitData();
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
          "relative w-full max-w-3xl bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden",
          className
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <GitBranch className="h-5 w-5 text-gray-600 dark:text-gray-400" />
            <h2 className="font-semibold text-gray-900 dark:text-gray-100">Git Operations</h2>
            <span className="text-xs text-gray-500 dark:text-gray-400">{workingDirectory}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadGitData}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
              title="Refresh"
            >
              <RefreshCw className={cn("h-4 w-4 text-gray-500", loading && "animate-spin")} />
            </button>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
            >
              <X className="h-5 w-5 text-gray-500" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700">
          {(["status", "branches", "commit", "log"] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded-t-lg transition-colors",
                activeTab === tab
                  ? "bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              )}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-4 max-h-96 overflow-y-auto">
          {activeTab === "status" && status && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="font-medium">Current Branch</span>
                <span className="text-sm text-gray-600 dark:text-gray-400">{status.branch}</span>
              </div>

              {status.staged.length > 0 && (
                <div>
                  <span className="font-medium text-green-600 dark:text-green-400">
                    Staged Changes
                  </span>
                  <ul className="mt-2 space-y-1">
                    {status.staged.map((file, i) => (
                      <li key={i} className="text-sm text-gray-700 dark:text-gray-300 font-mono">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {status.unstaged.length > 0 && (
                <div>
                  <span className="font-medium text-yellow-600 dark:text-yellow-400">
                    Unstaged Changes
                  </span>
                  <ul className="mt-2 space-y-1">
                    {status.unstaged.map((file, i) => (
                      <li key={i} className="text-sm text-gray-700 dark:text-gray-300 font-mono">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => handlePush()}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
                >
                  <Play className="h-4 w-4" />
                  Push
                </button>
                <button
                  onClick={() => handlePull()}
                  className="flex items-center gap-2 px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-lg text-sm font-medium"
                >
                  <Play className="h-4 w-4 rotate-180" />
                  Pull
                </button>
              </div>
            </div>
          )}

          {activeTab === "branches" && (
            <div className="space-y-2">
              {branches.map(branch => (
                <div
                  key={branch.name}
                  className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                >
                  <div className="flex items-center gap-2">
                    {branch.isCurrent && <GitBranch className="h-4 w-4 text-blue-500" />}
                    <span className="font-medium">{branch.name}</span>
                    {branch.isRemote && <span className="text-xs text-gray-500">(remote)</span>}
                  </div>
                  {!branch.isCurrent && (
                    <button
                      onClick={() => handleSwitchBranch(branch.name)}
                      className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      Switch
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {activeTab === "commit" && (
            <div className="space-y-4">
              <textarea
                value={commitMessage}
                onChange={e => setCommitMessage(e.target.value)}
                placeholder="Commit message..."
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm"
                rows={4}
              />
              <button
                onClick={handleCommit}
                disabled={!commitMessage.trim()}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium"
              >
                <GitCommit className="h-4 w-4" />
                Commit
              </button>
            </div>
          )}

          {activeTab === "log" && (
            <div className="text-sm text-gray-600 dark:text-gray-400">
              Git log view - would show commit history
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
