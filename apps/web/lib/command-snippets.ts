export interface CommandSnippet {
  id: string;
  name: string;
  description?: string;
  command: string;
  category: "general" | "git" | "docker" | "deployment" | "testing" | "custom";
  variables?: { [key: string]: string };
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  usageCount: number;
}

const SNIPPETS_KEY = "termag-command-snippets";

/**
 * Get all snippets from localStorage
 */
export function getSnippets(): CommandSnippet[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const stored = localStorage.getItem(SNIPPETS_KEY);
    return stored ? JSON.parse(stored) : getDefaultSnippets();
  } catch (error) {
    console.error("Failed to load snippets:", error);
    return getDefaultSnippets();
  }
}

/**
 * Save snippets to localStorage
 */
export function saveSnippets(snippets: CommandSnippet[]): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(SNIPPETS_KEY, JSON.stringify(snippets));
  } catch (error) {
    console.error("Failed to save snippets:", error);
  }
}

/**
 * Create a new snippet
 */
export function createSnippet(
  snippet: Omit<CommandSnippet, "id" | "createdAt" | "updatedAt" | "usageCount">
): CommandSnippet {
  const snippets = getSnippets();
  const newSnippet: CommandSnippet = {
    ...snippet,
    id: `snippet-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    usageCount: 0,
  };

  snippets.push(newSnippet);
  saveSnippets(snippets);
  return newSnippet;
}

/**
 * Update a snippet
 */
export function updateSnippet(
  id: string,
  updates: Partial<Omit<CommandSnippet, "id" | "createdAt" | "usageCount">>
): CommandSnippet | null {
  const snippets = getSnippets();
  const index = snippets.findIndex(s => s.id === id);

  if (index === -1) {
    return null;
  }

  snippets[index] = {
    ...snippets[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  saveSnippets(snippets);
  return snippets[index];
}

/**
 * Delete a snippet
 */
export function deleteSnippet(id: string): boolean {
  const snippets = getSnippets();
  const filtered = snippets.filter(s => s.id !== id);

  if (filtered.length === snippets.length) {
    return false;
  }

  saveSnippets(filtered);
  return true;
}

/**
 * Increment usage count for a snippet
 */
export function incrementSnippetUsage(id: string): void {
  const snippets = getSnippets();
  const index = snippets.findIndex(s => s.id === id);

  if (index !== -1) {
    snippets[index].usageCount += 1;
    saveSnippets(snippets);
  }
}

/**
 * Search snippets
 */
export function searchSnippets(
  query: string,
  category?: CommandSnippet["category"]
): CommandSnippet[] {
  const snippets = getSnippets();
  const queryLower = query.toLowerCase();

  return snippets.filter(snippet => {
    if (category && snippet.category !== category) {
      return false;
    }

    return (
      snippet.name.toLowerCase().includes(queryLower) ||
      snippet.description?.toLowerCase().includes(queryLower) ||
      snippet.command.toLowerCase().includes(queryLower) ||
      snippet.tags?.some(tag => tag.toLowerCase().includes(queryLower))
    );
  });
}

/**
 * Get default snippets
 */
function getDefaultSnippets(): CommandSnippet[] {
  return [
    {
      id: "snippet-git-status",
      name: "Git Status",
      description: "Show git repository status",
      command: "git status",
      category: "git",
      tags: ["git", "status"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usageCount: 0,
    },
    {
      id: "snippet-git-log",
      name: "Git Log",
      description: "Show git commit history",
      command: "git log --oneline -10",
      category: "git",
      tags: ["git", "log", "history"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usageCount: 0,
    },
    {
      id: "snippet-docker-ps",
      name: "Docker PS",
      description: "List running Docker containers",
      command: "docker ps",
      category: "docker",
      tags: ["docker", "containers"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usageCount: 0,
    },
    {
      id: "snippet-npm-install",
      name: "NPM Install",
      description: "Install npm dependencies",
      command: "npm install",
      category: "general",
      tags: ["npm", "install", "dependencies"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usageCount: 0,
    },
  ];
}
