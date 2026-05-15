export const AGENT_DEFAULTS = {
  shell: {
    label: 'Shell',
    badge: 'SH',
    spawn: '$SHELL'
  },
  claude: {
    label: 'Claude Code',
    badge: 'CL',
    spawn: 'claude'
  },
  'claude-yolo': {
    label: 'Claude Code YOLO',
    badge: 'CY',
    spawn: 'claude --dangerously-skip-permissions'
  },
  codex: {
    label: 'Codex',
    badge: 'CX',
    spawn: 'codex'
  },
  'codex-yolo': {
    label: 'Codex YOLO',
    badge: 'XY',
    spawn: 'codex --dangerously-bypass-approvals-and-sandbox'
  }
} as const;

export type AgentType = keyof typeof AGENT_DEFAULTS;

// Keep in sync with NewProjectDialog's defaultChecked agent — direct API
// callers (e.g. `curl POST /api/projects` without agents) and the dialog
// both land on the same default so the experience is consistent.
export const DEFAULT_AGENT_TYPE: AgentType = 'shell';
const DEFAULT_ROOTS: Record<string, string> = {};

export function agentSpawnCommand(agentType: string): string {
  return AGENT_DEFAULTS[agentType as AgentType]?.spawn ?? AGENT_DEFAULTS[DEFAULT_AGENT_TYPE].spawn;
}

export function agentLabel(agentType: string): string | undefined {
  return AGENT_DEFAULTS[agentType as AgentType]?.label;
}

export function parseRoots(value = process.env.TERMAG_ROOTS): Record<string, string> {
  if (!value) return DEFAULT_ROOTS;
  try {
    const parsed = JSON.parse(value) as Record<string, string>;
    return Object.keys(parsed).length > 0 ? parsed : DEFAULT_ROOTS;
  } catch {
    return DEFAULT_ROOTS;
  }
}

export function normalizeRelativePath(input: string): string {
  return input
    .trim()
    .replace(/\\/g, '/')
    .replace(/^~/, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function normalizeDirectory(input: string): string {
  return input
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function pathParts(input: string): string[] {
  return normalizeDirectory(input)
    .replace(/^~(?=\/|$)/, '')
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..');
}

function findSubsequence(haystack: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    if (needle.every((part, offset) => haystack[i + offset] === part)) return i;
  }
  return -1;
}

export function resolveProjectDirectory(
  directory: string,
  roots: Record<string, string> = parseRoots()
): { rootKey: string; relativePath: string } | null {
  const input = normalizeDirectory(directory);
  if (!input) return null;
  const inputParts = pathParts(input);
  const candidates = Object.entries(roots)
    .map(([rootKey, rootPath]) => ({ rootKey, rootPath, rootParts: pathParts(rootPath) }))
    .sort((a, b) => b.rootParts.length - a.rootParts.length);

  for (const candidate of candidates) {
    const rootVariants = [normalizeDirectory(candidate.rootPath), candidate.rootKey]
      .filter(Boolean)
      .map((value) => value.replace(/\/$/, ''));
    for (const root of rootVariants) {
      if (input === root) return null;
      if (input.startsWith(`${root}/`)) {
        const relativePath = normalizeRelativePath(input.slice(root.length + 1));
        return relativePath ? { rootKey: candidate.rootKey, relativePath } : null;
      }
    }

    const rootIndex = findSubsequence(inputParts, candidate.rootParts);
    if (rootIndex >= 0) {
      const relativePath = normalizeRelativePath(inputParts.slice(rootIndex + candidate.rootParts.length).join('/'));
      return relativePath ? { rootKey: candidate.rootKey, relativePath } : null;
    }
  }

  if (candidates.length === 1 && !input.startsWith('/') && !input.startsWith('~')) {
    const relativePath = normalizeRelativePath(input);
    return relativePath ? { rootKey: candidates[0].rootKey, relativePath } : null;
  }

  return null;
}

export function tmuxSessionName(projectId: string): string {
  return `termag-${projectId}`;
}

export function tmuxWindowName(tabId: string | 'ctrl'): string {
  return tabId === 'ctrl' ? 'ctrl' : `tab-${tabId}`;
}

export function tmuxName(projectId: string, tabId: string | 'ctrl'): string {
  return `${tmuxSessionName(projectId)}:${tmuxWindowName(tabId)}`;
}
