'use client';

import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Kbd } from './kbd';

type Result = { id: string; projectName: string; tabName: string; excerpt: string };

interface SearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SearchPalette({ open, onOpenChange }: SearchPaletteProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`)
        .then((res) => res.json())
        .then(setResults)
        .catch(() => setResults([]));
    }, 180);
    return () => clearTimeout(timer);
  }, [open, query]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4" onClick={() => onOpenChange(false)}>
      <div className="mx-auto mt-[12vh] max-w-2xl overflow-hidden rounded-lg border border-line bg-panel shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="h-4 w-4 text-muted" />
          <input className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none" autoFocus placeholder="Search terminal scrollback" value={query} onChange={(event) => setQuery(event.target.value)} />
          <Kbd>Esc</Kbd>
        </div>
        <div className="max-h-[440px] overflow-auto p-2">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-sm text-muted">No results.</div>
          ) : (
            results.map((result) => (
              <div key={result.id} className="rounded-md px-3 py-2 hover:bg-panel2">
                <div className="mb-1 text-xs text-muted">{result.projectName} / {result.tabName}</div>
                <pre className="whitespace-pre-wrap font-mono text-xs leading-5">{result.excerpt}</pre>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
