/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-console */

export interface CustomCommand {
  id: string;
  name: string;
  command: string;
  description?: string;
  category?: string;
  createdAt: string;
  lastRun?: string;
  runCount: number;
}

export interface RecentProject {
  id: string;
  name: string;
  rootKey: string;
  relativePath: string;
  lastAccessed: string;
  accessCount: number;
}

export interface SessionExport {
  version: string;
  exportedAt: string;
  tabs: any[];
  settings: any;
  clipboardHistory: any[];
  commandHistory: any[];
}

const CUSTOM_COMMANDS_KEY = "termag-custom-commands";
const RECENT_PROJECTS_KEY = "termag-recent-projects";
const MAX_RECENT_PROJECTS = 20;

/**
 * Get custom commands
 */
export function getCustomCommands(): CustomCommand[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const stored = localStorage.getItem(CUSTOM_COMMANDS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error("Failed to load custom commands:", error);
    return [];
  }
}

/**
 * Save custom commands
 */
export function saveCustomCommands(commands: CustomCommand[]): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(CUSTOM_COMMANDS_KEY, JSON.stringify(commands));
  } catch (error) {
    console.error("Failed to save custom commands:", error);
  }
}

/**
 * Create custom command
 */
export function createCustomCommand(
  name: string,
  command: string,
  description?: string,
  category?: string
): CustomCommand {
  const commands = getCustomCommands();

  const newCommand: CustomCommand = {
    id: `cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    name,
    command,
    description,
    category,
    createdAt: new Date().toISOString(),
    runCount: 0,
  };

  commands.push(newCommand);
  saveCustomCommands(commands);

  return newCommand;
}

/**
 * Update custom command
 */
export function updateCustomCommand(
  id: string,
  updates: Partial<Omit<CustomCommand, "id" | "createdAt" | "runCount">>
): CustomCommand | null {
  const commands = getCustomCommands();
  const index = commands.findIndex(c => c.id === id);

  if (index === -1) {
    return null;
  }

  commands[index] = { ...commands[index], ...updates };
  saveCustomCommands(commands);

  return commands[index];
}

/**
 * Delete custom command
 */
export function deleteCustomCommand(id: string): boolean {
  const commands = getCustomCommands();
  const filtered = commands.filter(c => c.id !== id);

  if (filtered.length === commands.length) {
    return false;
  }

  saveCustomCommands(filtered);
  return true;
}

/**
 * Run custom command
 */
export function runCustomCommand(id: string): CustomCommand | null {
  const commands = getCustomCommands();
  const command = commands.find(c => c.id === id);

  if (!command) {
    return null;
  }

  // Update run statistics
  command.lastRun = new Date().toISOString();
  command.runCount += 1;

  updateCustomCommand(id, {
    lastRun: command.lastRun,
    runCount: command.runCount,
  });

  // Execute the command (this would integrate with terminal)
  console.log(`Executing custom command: ${command.name}`);
  console.log(`Command: ${command.command}`);

  return command;
}

/**
 * Get recent projects
 */
export function getRecentProjects(): RecentProject[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const stored = localStorage.getItem(RECENT_PROJECTS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error("Failed to load recent projects:", error);
    return [];
  }
}

/**
 * Save recent projects
 */
export function saveRecentProjects(projects: RecentProject[]): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const trimmed = projects.slice(0, MAX_RECENT_PROJECTS);
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(trimmed));
  } catch (error) {
    console.error("Failed to save recent projects:", error);
  }
}

/**
 * Add project to recent
 */
export function addToRecentProjects(
  id: string,
  name: string,
  rootKey: string,
  relativePath: string
): RecentProject {
  const projects = getRecentProjects();

  // Remove if already exists
  const filtered = projects.filter(p => p.id !== id);

  const recentProject: RecentProject = {
    id,
    name,
    rootKey,
    relativePath,
    lastAccessed: new Date().toISOString(),
    accessCount: 1,
  };

  // Add to beginning
  filtered.unshift(recentProject);
  saveRecentProjects(filtered);

  return recentProject;
}

/**
 * Update project access
 */
export function updateProjectAccess(id: string): RecentProject | null {
  const projects = getRecentProjects();
  const project = projects.find(p => p.id === id);

  if (!project) {
    return null;
  }

  project.lastAccessed = new Date().toISOString();
  project.accessCount += 1;

  // Move to beginning
  const filtered = projects.filter(p => p.id !== id);
  filtered.unshift(project);

  saveRecentProjects(filtered);

  return project;
}

/**
 * Remove from recent projects
 */
export function removeFromRecentProjects(id: string): boolean {
  const projects = getRecentProjects();
  const filtered = projects.filter(p => p.id !== id);

  if (filtered.length === projects.length) {
    return false;
  }

  saveRecentProjects(filtered);
  return true;
}

/**
 * Clear recent projects
 */
export function clearRecentProjects(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.removeItem(RECENT_PROJECTS_KEY);
  } catch (error) {
    console.error("Failed to clear recent projects:", error);
  }
}

/**
 * Export session state
 */
export function exportSessionState(): SessionExport | null {
  try {
    const exportData: SessionExport = {
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      tabs: [], // Would load from session manager
      settings: {}, // Would load from user preferences
      clipboardHistory: [], // Would load from clipboard history
      commandHistory: [], // Would load from command history
    };

    return exportData;
  } catch (error) {
    console.error("Failed to export session state:", error);
    return null;
  }
}

/**
 * Export session to file
 */
export async function exportSessionToFile(): Promise<boolean> {
  const exportData = exportSessionState();
  if (!exportData) {
    return false;
  }

  try {
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `termag-session-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  } catch (error) {
    console.error("Failed to export session to file:", error);
    return false;
  }
}

/**
 * Import session state
 */
export function importSessionState(data: SessionExport): boolean {
  try {
    // Validate version
    if (data.version !== "1.0.0") {
      console.warn("Session export version mismatch");
    }

    // Import data to respective stores
    // This would integrate with session manager, user preferences, etc.
    console.log("Importing session state:", data);

    return true;
  } catch (error) {
    console.error("Failed to import session state:", error);
    return false;
  }
}

/**
 * Import session from file
 */
export async function importSessionFromFile(): Promise<boolean> {
  try {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";

    return new Promise(resolve => {
      input.onchange = async e => {
        const target = e.target as HTMLInputElement;
        const file = target.files?.[0];

        if (!file) {
          resolve(false);
          return;
        }

        try {
          const content = await file.text();
          const data = JSON.parse(content) as SessionExport;
          const success = importSessionState(data);
          resolve(success);
        } catch (error) {
          console.error("Failed to parse session file:", error);
          resolve(false);
        }
      };

      input.click();
    });
  } catch (error) {
    console.error("Failed to import session from file:", error);
    return false;
  }
}
