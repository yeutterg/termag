/**
 * Example Integration: How to wire up Command Palette in your termag app
 *
 * This file shows how to integrate all command palette features with your
 * actual Prisma sessions, WebSocket agent, and UI components.
 */

import { useState, useEffect } from "react";
import { CommandPalette, getTermagCommands, useCommandPalette } from "@/components/command-palette";
import { GitOperationsDialog } from "@/components/git-operations-dialog";
import { SearchDialog } from "@/components/search-dialog";
import { ClipboardHistoryDialog } from "@/components/clipboard-history-dialog";
import {
  getGitStatus,
  getGitBranches,
  gitCommit,
  gitPush,
  gitPull,
  switchBranch,
} from "@/lib/git-operations";
import { searchInFile, searchAllFiles, grepSearch, replaceInFile } from "@/lib/search-operations";
import {
  getSessionState,
  addTab,
  switchTab,
  closeTab,
  splitTab,
  pinTab,
} from "@/lib/session-manager";
import {
  getActiveSessionForProject,
  createSessionInPrisma,
  activateSession,
  closeSession as closePrismaSession,
  getSessionWorkingDirectory,
} from "@/lib/session-integration";
import { executeCommand } from "@/lib/command-execution";
import {
  copyToClipboard,
  copyLastOutput,
  copyCurrentLine,
  addToClipboardHistory,
} from "@/lib/clipboard-history";
import {
  toggleFullscreen,
  toggleSidebar,
  focusTerminal,
  focusFileExplorer,
  focusSidebar,
} from "@/lib/window-management";

export function CommandPaletteExample() {
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState<string>("");
  const [isGitDialogOpen, setIsGitDialogOpen] = useState(false);
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false);
  const [isClipboardDialogOpen, setIsClipboardDialogOpen] = useState(false);

  // Load active session on mount
  useEffect(() => {
    async function loadSession() {
      if (!currentProjectId) {
        return;
      }

      const session = await getActiveSessionForProject(currentProjectId);
      if (session) {
        setActiveSessionId(session.id);
        const dir = await getSessionWorkingDirectory(session.id);
        if (dir) {
          setWorkingDirectory(dir);
        }
      }
    }
    loadSession();
  }, [currentProjectId]);

  const { isOpen, open, close } = useCommandPalette([]);

  // Command palette commands
  const commands = getTermagCommands({
    sessionId: activeSessionId || "",
    workingDirectory,
    projects: [], // Load from your projects state
    tabs: [], // Load from your tabs state

    // Git Operations
    onGitStatus: async () => {
      if (!activeSessionId) {
        return;
      }
      const status = await getGitStatus(workingDirectory, activeSessionId);
      console.log("Git status:", status);
      setIsGitDialogOpen(true);
    },
    onGitCommit: async () => {
      setIsGitDialogOpen(true);
    },
    onGitPush: async () => {
      if (!activeSessionId) {
        return;
      }
      await gitPush(undefined, workingDirectory, activeSessionId);
    },
    onGitPull: async () => {
      if (!activeSessionId) {
        return;
      }
      await gitPull(undefined, workingDirectory, activeSessionId);
    },
    onGitLog: async () => {
      if (!activeSessionId) {
        return;
      }
      // Would open git log view
    },
    onGitCreateBranch: async () => {
      // Would open branch creation dialog
    },
    onGitSwitchBranch: async (branch: string) => {
      if (!activeSessionId) {
        return;
      }
      await switchBranch(branch, workingDirectory, activeSessionId);
    },
    gitBranches: [], // Load from gitBranches(workingDirectory, activeSessionId)

    // Search
    onSearchInFile: async () => {
      setIsSearchDialogOpen(true);
    },
    onSearchAllFiles: async () => {
      setIsSearchDialogOpen(true);
    },
    onGrepSearch: async () => {
      setIsSearchDialogOpen(true);
    },
    onReplaceInFile: async () => {
      setIsSearchDialogOpen(true);
    },

    // Session Management
    onNewSession: async () => {
      if (!currentProjectId) {
        return;
      }
      const { sessionId } = await createSessionInPrisma(currentProjectId);
      setActiveSessionId(sessionId);
      // Add to session-manager localStorage
      await addTab({
        id: sessionId,
        name: "New Session",
        projectId: currentProjectId,
        sessionId,
        isActive: true,
        isPinned: false,
      });
    },
    onSwitchTab: async (tabId: string) => {
      await switchTab(tabId);
      await activateSession(tabId);
      setActiveSessionId(tabId);
    },
    onCloseSession: async (tabId: string) => {
      await closeTab(tabId);
      await closePrismaSession(tabId);
    },
    onSplitHorizontal: async (tabId: string) => {
      await splitTab(tabId, "horizontal");
    },
    onSplitVertical: async (tabId: string) => {
      await splitTab(tabId, "vertical");
    },
    onReopenLastClosed: async () => {
      // Would reopen last closed tab
    },

    // Clipboard
    onPasteFromHistory: async () => {
      setIsClipboardDialogOpen(true);
    },
    onCopyLastOutput: async () => {
      if (!activeSessionId) {
        return;
      }
      // Would get last terminal output and copy
      await copyLastOutput("last output here");
    },
    onCopyCurrentLine: async () => {
      if (!activeSessionId) {
        return;
      }
      await copyCurrentLine("current line here");
    },

    // Window Management
    onFocusTerminal: async () => {
      focusTerminal();
    },
    onFocusFileExplorer: async () => {
      focusFileExplorer();
    },
    onFocusSidebar: async () => {
      focusSidebar();
    },
    onToggleFullscreen: async () => {
      toggleFullscreen();
    },
    onToggleSidebar: async () => {
      toggleSidebar();
    },

    // Quick Actions
    onToggleAutoSave: () => {
      // Toggle auto-save preference
    },
    onToggleLineNumbers: () => {
      // Toggle line numbers
    },
    onToggleWordWrap: () => {
      // Toggle word wrap
    },

    // Terminal Actions
    onClearTerminal: async () => {
      if (!activeSessionId) {
        return;
      }
      // Clear terminal via agent
      await executeCommand({
        sessionId: activeSessionId,
        command: "clear",
      });
    },
    onZoomIn: () => {
      // Increase font size
    },
    onZoomOut: () => {
      // Decrease font size
    },

    // Settings
    onOpenSettings: () => {
      // Open settings dialog
    },
    onToggleTheme: () => {
      // Toggle theme
    },
    onOpenShortcuts: () => {
      // Open shortcuts dialog
    },

    // Help
    onOpenHelp: () => {
      // Open help dialog
    },
  });

  // Handle search dialog
  const handleSearch = async (query: string) => {
    if (!activeSessionId) {
      return;
    }
    const results = await searchAllFiles(query, workingDirectory, activeSessionId);
    console.log("Search results:", results);
  };

  const handleReplace = async (search: string, replace: string) => {
    if (!activeSessionId) {
      return;
    }
    const result = await replaceInFile(search, replace, "current-file.txt", activeSessionId);
    console.log("Replace result:", result);
  };

  // Handle clipboard selection
  const handleClipboardSelect = async (content: string) => {
    await copyToClipboard(content);
    setIsClipboardDialogOpen(false);
  };

  return (
    <>
      <CommandPalette isOpen={isOpen} onClose={close} commands={commands} />

      <GitOperationsDialog
        isOpen={isGitDialogOpen}
        onClose={() => setIsGitDialogOpen(false)}
        workingDirectory={workingDirectory}
        sessionId={activeSessionId || ""}
        onCommandExecute={command => {
          console.log("Executing:", command);
        }}
      />

      <SearchDialog
        isOpen={isSearchDialogOpen}
        onClose={() => setIsSearchDialogOpen(false)}
        onSearch={handleSearch}
        onReplace={handleReplace}
        mode="search"
        sessionId={activeSessionId || ""}
        workingDirectory={workingDirectory}
      />

      <ClipboardHistoryDialog
        isOpen={isClipboardDialogOpen}
        onClose={() => setIsClipboardDialogOpen(false)}
        onSelect={handleClipboardSelect}
      />
    </>
  );
}

/**
 * Example: How to use in your main app component
 */
export function MainAppExample() {
  return (
    <div>
      {/* Your existing UI */}
      <CommandPaletteExample />

      {/* Keyboard shortcut listener */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
            document.addEventListener('keydown', (e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                // Command palette is opened automatically by useCommandPalette hook
              }
            });
          `,
        }}
      />
    </div>
  );
}

/**
 * Example: How to wire up session management with Prisma
 */
export async function exampleSessionManagement() {
  // Create a new session
  const { sessionId, tmuxSessionName } = await createSessionInPrisma(
    "project-id-here",
    "My Session"
  );

  console.log("Created session:", sessionId, tmuxSessionName);

  // Activate a session
  await activateSession(sessionId);

  // Close a session
  await closePrismaSession(sessionId);

  // Get working directory for file operations
  const workingDir = await getSessionWorkingDirectory(sessionId);
  console.log("Working directory:", workingDir);

  // Execute a command in that session
  const result = await executeCommand({
    sessionId,
    command: "ls -la",
    workingDirectory: workingDir || undefined,
  });

  console.log("Command result:", result);
}

/**
 * Example: Git operations with actual agent execution
 */
export async function exampleGitOperations() {
  const sessionId = "session-id-here";
  const workingDir = "/path/to/project";

  // Get git status
  const status = await getGitStatus(workingDir, sessionId);
  console.log("Git status:", status);

  // Get branches
  const branches = await getGitBranches(workingDir, sessionId);
  console.log("Branches:", branches);

  // Commit changes
  await gitCommit("My commit message", workingDir, sessionId);

  // Push to remote
  await gitPush("main", workingDir, sessionId);

  // Switch branch
  await switchBranch("develop", workingDir, sessionId);
}

/**
 * Example: Search operations with actual agent execution
 */
export async function exampleSearchOperations() {
  const sessionId = "session-id-here";
  const directory = "/path/to/project";

  // Search in a file
  const results = await searchInFile("TODO", "/path/to/file.txt", sessionId);
  console.log("Search results:", results);

  // Search across all files
  const fileResults = await searchAllFiles("function", directory, sessionId);
  console.log("File search results:", fileResults);

  // Grep search with pattern
  const grepResults = await grepSearch("async", directory, sessionId);
  console.log("Grep results:", grepResults);

  // Replace in file
  const replaceResult = await replaceInFile("old", "new", "/path/to/file.txt", sessionId);
  console.log("Replace result:", replaceResult);
}

/**
 * Example: Clipboard history integration
 */
export async function exampleClipboardIntegration() {
  // Copy command output to clipboard
  await copyLastOutput("git status output");

  // Copy current line
  await copyCurrentLine("console.log('hello')");

  // Add to clipboard history
  await addToClipboardHistory("some text", "command", "terminal");

  // Copy to clipboard with type tracking
  await copyToClipboard("some text", "text", "terminal");
}

/**
 * Example: Window management
 */
export async function exampleWindowManagement() {
  // Focus terminal
  focusTerminal();

  // Toggle fullscreen
  toggleFullscreen();

  // Toggle sidebar
  toggleSidebar();

  // Focus specific elements
  focusFileExplorer();
  focusSidebar();
}
