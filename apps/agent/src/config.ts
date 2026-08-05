import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type AgentConfig = {
  url?: string;
  agentToken?: string;
  agentRoots?: Record<string, string>;
};

export type ResolvedCredentials = {
  url?: string;
  token?: string;
  roots: Record<string, string>;
};

export function configPath(): string {
  const raw = process.env.TERMAG_CONFIG || path.join(os.homedir(), ".termag", "config.json");
  return path.resolve(expandHome(raw));
}

export function loadConfig(): AgentConfig {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return (parsed && typeof parsed === "object" ? parsed : {}) as AgentConfig;
  } catch {
    return {};
  }
}

export function saveConfig(updates: Partial<AgentConfig>): string {
  const p = configPath();
  const current = loadConfig();
  const merged = { ...current, ...updates };
  mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  return p;
}

/**
 * Move credentials out of process env into ~/.termag/config.json on first
 * run. Only writes the file when it doesn't already exist — repeat
 * invocations are a no-op. Returns the list of env var names that were
 * captured so the caller can tell the user which lines to remove from
 * their shell rc.
 */
export function migrateEnvToConfig(): { migrated: boolean; path: string; fields: string[] } {
  const p = configPath();
  if (existsSync(p)) return { migrated: false, path: p, fields: [] };

  const updates: AgentConfig = {};
  const fields: string[] = [];

  const url = process.env.TERMAG_URL;
  if (url && url.trim()) {
    updates.url = url.trim();
    fields.push("TERMAG_URL");
  }
  const token = process.env.TERMAG_AGENT_TOKEN;
  if (token && token.trim()) {
    updates.agentToken = token.trim();
    fields.push("TERMAG_AGENT_TOKEN");
  }
  const roots = parseRootsString(process.env.TERMAG_AGENT_ROOTS);
  if (roots) {
    updates.agentRoots = roots;
    fields.push("TERMAG_AGENT_ROOTS");
  }

  if (fields.length === 0) return { migrated: false, path: p, fields: [] };

  saveConfig(updates);
  return { migrated: true, path: p, fields };
}

/**
 * Env wins when set (explicit per-invocation overrides), file is the
 * persistent default.
 */
export function resolveCredentials(): ResolvedCredentials {
  const cfg = loadConfig();
  const url = process.env.TERMAG_URL?.trim() || cfg.url?.trim() || undefined;
  const token = process.env.TERMAG_AGENT_TOKEN?.trim() || cfg.agentToken?.trim() || undefined;
  const envRoots = parseRootsString(process.env.TERMAG_AGENT_ROOTS);
  const fileRoots = cfg.agentRoots && typeof cfg.agentRoots === "object" ? cfg.agentRoots : null;
  const raw = envRoots || fileRoots || {};
  const roots: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") continue;
    roots[key] = expandRoot(value);
  }
  return { url, token, roots };
}

function expandRoot(v: string): string {
  if (v === "~") return os.homedir();
  if (v.startsWith("~/")) return path.join(os.homedir(), v.slice(2));
  if (v === "$HOME") return os.homedir();
  if (v.startsWith("$HOME/")) return path.join(os.homedir(), v.slice(6));
  return v;
}

export function maskToken(token: string | undefined): string {
  if (!token) return "(unset)";
  if (token.length <= 13) return `${token}…`;
  return `${token.slice(0, 13)}…`;
}

function expandHome(v: string): string {
  if (v === "~") return os.homedir();
  if (v.startsWith("~/")) return path.join(os.homedir(), v.slice(2));
  return v;
}

function parseRootsString(raw: string | undefined): Record<string, string> | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].trim().length > 0
    );
    return entries.length ? Object.fromEntries(entries) : null;
  } catch {
    return null;
  }
}
