export const AGENT_DEFAULTS = {
  claude: {
    label: 'Claude Code',
    badge: 'CL',
    spawn: 'claude --dangerously-skip-permissions'
  },
  codex: {
    label: 'Codex',
    badge: 'CX',
    spawn: 'codex --dangerously-bypass-approvals-and-sandbox'
  }
} as const;

export type AgentType = keyof typeof AGENT_DEFAULTS;

export const DEFAULT_AGENT_TYPE: AgentType = 'codex';

export function agentSpawnCommand(agentType: string): string {
  return AGENT_DEFAULTS[agentType as AgentType]?.spawn ?? AGENT_DEFAULTS[DEFAULT_AGENT_TYPE].spawn;
}

export function parseRoots(value = process.env.TERMAG_ROOTS): Record<string, string> {
  if (!value) return { WIP: '/Users/greg/WIP' };
  try {
    const parsed = JSON.parse(value) as Record<string, string>;
    return Object.keys(parsed).length > 0 ? parsed : { WIP: '/Users/greg/WIP' };
  } catch {
    return { WIP: '/Users/greg/WIP' };
  }
}

export function normalizeRelativePath(input: string): string {
  return input
    .trim()
    .replace(/^~?\//, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/\.\./g, '')
    .replace(/\/$/, '');
}

export function tmuxName(projectId: string, tabId: string | 'ctrl'): string {
  return `termag-${projectId}-${tabId}`;
}
