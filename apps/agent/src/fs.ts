import { readdir, stat } from 'node:fs/promises';
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
  if (!root) throw new Error(`Unknown root ${rootKey}`);

  const resolvedRoot = path.resolve(root);
  const normalizedRelative = normalizeRelative(relativePath);
  const absolutePath = path.resolve(resolvedRoot, normalizedRelative);
  if (
    absolutePath !== resolvedRoot
    && !absolutePath.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
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
        const target = await stat(path.join(absolutePath, dirent.name));
        if (target.isDirectory()) isDir = true;
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
  return value
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function parentRelative(value: string): string {
  const idx = value.lastIndexOf('/');
  return idx >= 0 ? value.slice(0, idx) : '';
}
