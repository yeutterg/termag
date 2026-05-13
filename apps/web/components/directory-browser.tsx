'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, CornerLeftUp, Folder, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

type DirectoryEntry = { name: string; isDir: boolean };

type Listing = {
  rootKey: string;
  relativePath: string;
  absolutePath: string;
  parent: { rootKey: string; relativePath: string } | null;
  entries: DirectoryEntry[];
  truncated: boolean;
  roots?: Record<string, string>;
};

interface DirectoryBrowserProps {
  deviceName: string;
  roots: Record<string, string>;
  initialRootKey?: string | null;
  initialRelativePath?: string | null;
  onChange?: (rootKey: string, relativePath: string) => void;
  onSelect?: (rootKey: string, relativePath: string) => void;
  selectLabel?: string;
  disabled?: boolean;
  emptyHint?: string;
}

export function DirectoryBrowser({
  deviceName,
  roots,
  initialRootKey,
  initialRelativePath,
  onChange,
  onSelect,
  selectLabel = 'Use this folder',
  disabled,
  emptyHint
}: DirectoryBrowserProps) {
  const rootKeys = useMemo(() => Object.keys(roots).sort(), [roots]);
  const defaultRootKey = initialRootKey && roots[initialRootKey] ? initialRootKey : rootKeys[0] || '';
  const [rootKey, setRootKey] = useState(defaultRootKey);
  const [relativePath, setRelativePath] = useState(initialRelativePath ?? '');
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [typedMode, setTypedMode] = useState(false);
  const [typedPath, setTypedPath] = useState(() => composePath(roots, defaultRootKey, initialRelativePath ?? ''));
  const requestSeq = useRef(0);

  // Reset whenever the device flips out from under us.
  useEffect(() => {
    setRootKey(defaultRootKey);
    setRelativePath(initialRelativePath ?? '');
    setTypedPath(composePath(roots, defaultRootKey, initialRelativePath ?? ''));
    setError('');
    setListing(null);
    setTypedMode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceName]);

  const fetchListing = useCallback(async (nextRootKey: string, nextRelative: string) => {
    if (!nextRootKey) {
      setListing(null);
      setError('');
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    setError('');
    try {
      const url = new URL(`/api/devices/${encodeURIComponent(deviceName)}/browse`, window.location.origin);
      url.searchParams.set('rootKey', nextRootKey);
      if (nextRelative) url.searchParams.set('relativePath', nextRelative);
      const res = await fetch(url.toString());
      const body = await res.json().catch(() => ({}));
      if (seq !== requestSeq.current) return;
      if (!res.ok) {
        setListing(null);
        setError(typeof body?.error === 'string' ? body.error : 'Could not list directory');
        return;
      }
      setListing(body as Listing);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setListing(null);
      setError(err instanceof Error ? err.message : 'Could not list directory');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [deviceName]);

  useEffect(() => {
    if (typedMode) return;
    fetchListing(rootKey, relativePath);
  }, [rootKey, relativePath, typedMode, fetchListing]);

  useEffect(() => {
    if (typedMode) return;
    onChange?.(rootKey, relativePath);
  }, [rootKey, relativePath, typedMode, onChange]);

  function navigate(nextRootKey: string, nextRelative: string) {
    setRootKey(nextRootKey);
    setRelativePath(nextRelative);
  }

  function applyTypedPath() {
    const resolved = resolveTypedPath(roots, typedPath);
    if (!resolved) {
      setError(`Path must be inside one of the device roots (${rootKeys.join(', ') || 'none configured'}).`);
      return;
    }
    setError('');
    setRootKey(resolved.rootKey);
    setRelativePath(resolved.relativePath);
    setTypedMode(false);
  }

  const segments = relativePath ? relativePath.split('/').filter(Boolean) : [];
  const showRootPicker = rootKeys.length > 1 && !rootKey;
  const absolutePath = listing?.absolutePath || composePath(roots, rootKey, relativePath);

  return (
    <div className="rounded-md border border-line bg-bg">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 text-xs">
        <div className="min-w-0">
          <div className="truncate font-mono text-text">{absolutePath || '—'}</div>
          <div className="truncate text-[10px] text-muted">
            {deviceName}{rootKey && ` · root ${rootKey}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!typedMode && rootKey && (
            <button
              type="button"
              onClick={() => fetchListing(rootKey, relativePath)}
              className="grid h-7 w-7 place-items-center rounded text-muted hover:bg-panel2 hover:text-text disabled:opacity-50"
              title="Refresh"
              disabled={disabled || loading}
              aria-label="Refresh listing"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setTypedPath(composePath(roots, rootKey, relativePath));
              setTypedMode(!typedMode);
              setError('');
            }}
            className="rounded px-2 py-1 text-[11px] text-muted hover:bg-panel2 hover:text-text"
          >
            {typedMode ? 'Browse' : 'Type a path'}
          </button>
        </div>
      </div>

      {typedMode ? (
        <div className="space-y-2 px-3 py-3">
          <label className="block">
            <span className="mb-1 block text-[11px] text-muted">Absolute path</span>
            <input
              autoFocus
              value={typedPath}
              onChange={(event) => setTypedPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyTypedPath();
                }
              }}
              placeholder="/Users/you/Code/my-project"
              className="h-8 w-full rounded-md border border-line bg-panel px-2 font-mono text-xs outline-none focus:border-accent"
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted">
              Path must live under {rootKeys.length === 0 ? 'a configured root' : rootKeys.map((key) => roots[key]).join(' / ')}.
            </span>
            <button
              type="button"
              onClick={applyTypedPath}
              className="h-7 rounded-md border border-line bg-panel px-2 text-xs hover:bg-panel2"
              disabled={disabled}
            >
              Go
            </button>
          </div>
          {error && <div className="text-[11px] text-bad">{error}</div>}
        </div>
      ) : (
        <div>
          {(rootKeys.length > 1 || segments.length > 0) && (
            <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2 text-[11px] text-muted">
              {rootKeys.length > 1 ? (
                <select
                  value={rootKey}
                  onChange={(event) => navigate(event.target.value, '')}
                  className="h-6 rounded border border-line bg-panel px-1 text-[11px]"
                  disabled={disabled}
                >
                  {rootKeys.map((key) => (
                    <option key={key} value={key}>{key}</option>
                  ))}
                </select>
              ) : rootKey ? (
                <button
                  type="button"
                  onClick={() => navigate(rootKey, '')}
                  className="rounded px-1 text-text hover:bg-panel2"
                >
                  {rootKey}
                </button>
              ) : null}
              {segments.map((segment, index) => {
                const subPath = segments.slice(0, index + 1).join('/');
                const isLast = index === segments.length - 1;
                return (
                  <span key={subPath} className="flex items-center gap-1">
                    <ChevronRight className="h-3 w-3 opacity-50" />
                    {isLast ? (
                      <span className="text-text">{segment}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => navigate(rootKey, subPath)}
                        className="rounded px-1 text-text hover:bg-panel2"
                      >
                        {segment}
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          )}

          <div className="max-h-72 overflow-y-auto">
            {showRootPicker && (
              <div className="px-3 py-3 text-xs text-muted">Pick a root to start browsing.</div>
            )}
            {!showRootPicker && !rootKey && (
              <div className="px-3 py-3 text-xs text-muted">
                {emptyHint || 'No roots reported by this device. Set TERMAG_AGENT_ROOTS on the agent and reconnect.'}
              </div>
            )}
            {rootKey && listing?.parent && (
              <button
                type="button"
                onClick={() => navigate(listing.parent!.rootKey, listing.parent!.relativePath)}
                className="flex w-full items-center gap-2 border-b border-line/60 px-3 py-1.5 text-left text-xs text-muted hover:bg-panel2"
                disabled={disabled}
              >
                <CornerLeftUp className="h-3.5 w-3.5" />
                <span>Up to {listing.parent.relativePath || rootKey}</span>
              </button>
            )}
            {rootKey && !loading && listing && listing.entries.length === 0 && (
              <div className="px-3 py-3 text-xs text-muted">Empty folder.</div>
            )}
            {rootKey && listing?.entries.map((entry) => (
              <button
                key={entry.name}
                type="button"
                onClick={() => navigate(rootKey, [relativePath, entry.name].filter(Boolean).join('/'))}
                className="flex w-full items-center gap-2 border-b border-line/40 px-3 py-1.5 text-left text-xs hover:bg-panel2"
                disabled={disabled}
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-text">{entry.name}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />
              </button>
            ))}
            {rootKey && loading && !listing && (
              <div className="px-3 py-3 text-xs text-muted">Loading…</div>
            )}
            {rootKey && listing?.truncated && (
              <div className="px-3 py-1.5 text-[10px] text-muted">Folder has more than 500 entries — only the first 500 are shown.</div>
            )}
            {error && (
              <div className="px-3 py-2 text-[11px] text-bad">{error}</div>
            )}
          </div>
        </div>
      )}

      {onSelect && (
        <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
          <span className="truncate text-[11px] text-muted">
            {rootKey ? `Will create at ${absolutePath}` : 'Select a folder to continue.'}
          </span>
          <button
            type="button"
            onClick={() => onSelect(rootKey, relativePath)}
            disabled={disabled || !rootKey}
            className="h-7 shrink-0 rounded-md bg-text px-3 text-xs font-medium text-bg disabled:opacity-50"
          >
            {selectLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function composePath(roots: Record<string, string>, rootKey: string, relativePath: string) {
  const root = roots[rootKey];
  if (!root) return '';
  if (!relativePath) return root;
  return `${root.replace(/\/+$/, '')}/${relativePath.replace(/^\/+/, '')}`;
}

function resolveTypedPath(roots: Record<string, string>, typed: string): { rootKey: string; relativePath: string } | null {
  const cleaned = typed.trim().replace(/\/+$/, '');
  if (!cleaned) return null;
  const candidates = Object.entries(roots)
    .map(([rootKey, rootPath]) => ({ rootKey, rootPath: rootPath.replace(/\/+$/, '') }))
    .sort((a, b) => b.rootPath.length - a.rootPath.length);
  for (const candidate of candidates) {
    if (cleaned === candidate.rootPath) return { rootKey: candidate.rootKey, relativePath: '' };
    const prefix = `${candidate.rootPath}/`;
    if (cleaned.startsWith(prefix)) {
      return { rootKey: candidate.rootKey, relativePath: cleaned.slice(prefix.length).replace(/^\/+|\/+$/g, '') };
    }
  }
  return null;
}
