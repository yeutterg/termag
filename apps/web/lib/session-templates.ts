export interface SessionTemplate {
  id: string;
  name: string;
  description?: string;
  category: "dev" | "ops" | "testing" | "custom";
  agentType: "shell" | "codex" | "claude";
  rootKey: string;
  relativePath: string;
  agentSpawnCommand?: string;
  ctrlSpawnCommand?: string;
  color?: string;
  createdAt: string;
  updatedAt: string;
  isDefault?: boolean;
}

export interface CreateSessionTemplateInput {
  name: string;
  description?: string;
  category: SessionTemplate["category"];
  agentType: SessionTemplate["agentType"];
  rootKey: string;
  relativePath: string;
  agentSpawnCommand?: string;
  ctrlSpawnCommand?: string;
  color?: string;
}

const STORAGE_KEY = "termag-session-templates";

/**
 * Get all session templates from localStorage
 */
export function getSessionTemplates(): SessionTemplate[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : getDefaultTemplates();
  } catch (error) {
    console.error("Failed to load session templates:", error);
    return getDefaultTemplates();
  }
}

/**
 * Save session templates to localStorage
 */
export function saveSessionTemplates(templates: SessionTemplate[]): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch (error) {
    console.error("Failed to save session templates:", error);
  }
}

/**
 * Get a session template by ID
 */
export function getSessionTemplate(id: string): SessionTemplate | null {
  const templates = getSessionTemplates();
  return templates.find(t => t.id === id) || null;
}

/**
 * Create a new session template
 */
export function createSessionTemplate(input: CreateSessionTemplateInput): SessionTemplate {
  const templates = getSessionTemplates();
  const newTemplate: SessionTemplate = {
    id: `template-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    ...input,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  templates.push(newTemplate);
  saveSessionTemplates(templates);
  return newTemplate;
}

/**
 * Update a session template
 */
export function updateSessionTemplate(
  id: string,
  updates: Partial<Omit<SessionTemplate, "id" | "createdAt">>
): SessionTemplate | null {
  const templates = getSessionTemplates();
  const index = templates.findIndex(t => t.id === id);

  if (index === -1) {
    return null;
  }

  templates[index] = {
    ...templates[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  saveSessionTemplates(templates);
  return templates[index];
}

/**
 * Delete a session template
 */
export function deleteSessionTemplate(id: string): boolean {
  const templates = getSessionTemplates();
  const filtered = templates.filter(t => t.id !== id);

  if (filtered.length === templates.length) {
    return false;
  }

  saveSessionTemplates(filtered);
  return true;
}

/**
 * Get default session templates
 */
function getDefaultTemplates(): SessionTemplate[] {
  return [
    {
      id: "template-default-dev",
      name: "Default Development",
      description: "Standard development environment with shell agent",
      category: "dev",
      agentType: "shell",
      rootKey: "workstation",
      relativePath: "~/Projects",
      agentSpawnCommand: "/bin/bash",
      ctrlSpawnCommand: "/bin/zsh",
      color: "#3B82F6",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDefault: true,
    },
    {
      id: "template-ops",
      name: "Operations",
      description: "Operations environment for deployment and monitoring",
      category: "ops",
      agentType: "shell",
      rootKey: "workstation",
      relativePath: "~/ops",
      agentSpawnCommand: "/bin/bash",
      ctrlSpawnCommand: "/bin/zsh",
      color: "#EF4444",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "template-testing",
      name: "Testing",
      description: "Isolated testing environment",
      category: "testing",
      agentType: "shell",
      rootKey: "workstation",
      relativePath: "~/testing",
      agentSpawnCommand: "/bin/bash",
      ctrlSpawnCommand: "/bin/zsh",
      color: "#22C55E",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
}

/**
 * Apply a template to create a project
 */
export function applyTemplate(template: SessionTemplate) {
  return {
    name: template.name,
    agentType: template.agentType,
    rootKey: template.rootKey,
    relativePath: template.relativePath,
    agentSpawnCommand: template.agentSpawnCommand,
    ctrlSpawnCommand: template.ctrlSpawnCommand,
    color: template.color,
  };
}

/**
 * Create a template from an existing project
 */
export function createTemplateFromProject(project: {
  name: string;
  agentType: string;
  rootKey: string;
  relativePath: string;
  agentSpawnCommand?: string;
  ctrlSpawnCommand?: string;
  color?: string;
}): CreateSessionTemplateInput {
  return {
    name: `${project.name} Template`,
    category: "custom",
    agentType: project.agentType as SessionTemplate["agentType"],
    rootKey: project.rootKey,
    relativePath: project.relativePath,
    agentSpawnCommand: project.agentSpawnCommand,
    ctrlSpawnCommand: project.ctrlSpawnCommand,
    color: project.color,
  };
}
