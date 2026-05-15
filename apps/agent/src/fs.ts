import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export type DirectoryEntry = {
  name: string;
  isDir: boolean;
};

export type DirectoryListing = {
  rootKey: string;
  relativePath: string;
  absolutePath: string;
  parent: { rootKey: string; relativePath: string } | null;
  entries: DirectoryEntry[];
  truncated: boolean;
};

const MAX_ENTRIES = 500;

export async function listDirectory(
  roots: Record<string, string>,
  rootKey: string,
  relativePath: string,
  options: { includeHidden?: boolean; includeFiles?: boolean } = {}
): Promise<DirectoryListing> {
  const root = roots[rootKey];
  if (!root) {
    if (Object.keys(roots).length === 0) {
      throw new Error('No agent roots configured. Set TERMAG_AGENT_ROOTS or add agentRoots to ~/.termag/config.json.');
    }
    throw new Error(`Unknown root "${rootKey}". Available roots: ${Object.keys(roots).map((k) => `"${k}"`).join(', ')}.`);
  }

  const resolvedRoot = path.resolve(root);
  const normalizedRelative = normalizeRelative(relativePath);
  const absolutePath = path.resolve(resolvedRoot, normalizedRelative);
  if (
    absolutePath !== resolvedRoot
    && !absolutePath.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`Path escapes root ${rootKey}`);
  }

  const [realRoot, realDirectory] = await Promise.all([
    realpath(resolvedRoot),
    realpath(absolutePath)
  ]);
  if (!pathIsInside(realDirectory, realRoot)) {
    throw new Error(`Path escapes root ${rootKey}`);
  }

  const dirents = await readdir(absolutePath, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const entries: DirectoryEntry[] = [];
  let truncated = false;
  const includeHidden = options.includeHidden === true;
  const includeFiles = options.includeFiles === true;

  for (const dirent of dirents) {
    if (!includeHidden && dirent.name.startsWith('.')) continue;
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }

    let isDir = dirent.isDirectory();
    if (!isDir && dirent.isSymbolicLink()) {
      try {
        const entryPath = path.join(absolutePath, dirent.name);
        const [target, realTarget] = await Promise.all([stat(entryPath), realpath(entryPath)]);
        if (target.isDirectory() && pathIsInside(realTarget, realRoot)) isDir = true;
      } catch {
        continue;
      }
    }
    if (!isDir && !includeFiles) continue;

    entries.push({ name: dirent.name, isDir });
  }

  const parent = normalizedRelative
    ? { rootKey, relativePath: parentRelative(normalizedRelative) }
    : null;

  return {
    rootKey,
    relativePath: normalizedRelative,
    absolutePath,
    parent,
    entries,
    truncated
  };
}

function normalizeRelative(value: string): string {
  const parts = value
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new Error('Path escapes root');
  }
  return parts.filter((part) => part !== '.').join('/');
}

function parentRelative(value: string): string {
  const idx = value.lastIndexOf('/');
  return idx >= 0 ? value.slice(0, idx) : '';
}

function pathIsInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
