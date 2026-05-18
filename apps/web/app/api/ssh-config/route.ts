import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withAuth } from '@/lib/auth';

// Reads the BROKER process's ~/.ssh/config and lists Host entries the
// user can import as termag SSH hosts. Returns minimal parsed shape;
// the user still confirms each field before saving. We intentionally
// don't recurse into Include directives or follow `Match` — too easy to
// surface secrets the user didn't expect. Wildcards and proxy-only
// stanzas (no HostName) are filtered out.

type ParsedHostEntry = {
  name: string;        // the Host alias
  hostname: string;    // HostName or fallback to the alias
  user?: string;
  port?: number;
};

function parseSshConfig(text: string): ParsedHostEntry[] {
  const entries: ParsedHostEntry[] = [];
  let current: ParsedHostEntry | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const space = line.search(/\s/);
    if (space < 0) continue;
    const keyword = line.slice(0, space).toLowerCase();
    const value = line.slice(space + 1).trim();
    if (keyword === 'host') {
      // ssh config allows multiple aliases per Host line ("Host foo bar"),
      // but importing wildcards or comma-aliased groups isn't useful here.
      // Take the first token only; skip wildcards.
      const first = value.split(/\s+/)[0];
      if (current && current.hostname) entries.push(current);
      current = first && !first.includes('*') && !first.includes('?')
        ? { name: first, hostname: '' }
        : null;
      continue;
    }
    if (!current) continue;
    if (keyword === 'hostname') current.hostname = value;
    else if (keyword === 'user') current.user = value;
    else if (keyword === 'port') {
      const port = Number(value);
      if (Number.isFinite(port)) current.port = port;
    }
  }
  if (current && current.hostname) entries.push(current);
  return entries
    // Default hostname to the alias if the entry omits it (common pattern
    // for `Host my-server` with implicit hostname = my-server).
    .map((e) => ({ ...e, hostname: e.hostname || e.name }))
    .filter((e) => e.hostname);
}

export const GET = withAuth(async (_user) => {
  const path = join(homedir(), '.ssh', 'config');
  try {
    const text = await readFile(path, 'utf8');
    const entries = parseSshConfig(text);
    return NextResponse.json({ ok: true, entries });
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
    if (code === 'ENOENT') {
      return NextResponse.json({ ok: true, entries: [], note: 'No ~/.ssh/config on the broker.' });
    }
    return NextResponse.json(
      { ok: false, error: 'Could not read broker\'s ~/.ssh/config', entries: [] },
      { status: 500 }
    );
  }
});
