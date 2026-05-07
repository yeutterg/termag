'use client';

import { Shortcut, type ChordKey } from './shortcut';
import { cn, statusDot, statusLabel } from '@/lib/utils';

type Item = { keys: ChordKey[]; label: string; note?: string };
type Group = { heading: string; items: Item[] };

// Only shortcuts that actually fire under preventDefault in major browsers.
// Browser hard-binds (⌘W close-tab, ⌃Tab cycle-tab) are intentionally absent
// — preventDefault doesn't override them in any modern browser.
const GROUPS: Group[] = [
  {
    heading: 'Navigate',
    items: [
      { keys: ['mod', 'K'], label: 'Open command palette' },
      { keys: ['ctrl', '1'], label: 'Jump to project 1 — also ⌃2 … ⌃9' },
      { keys: ['mod', 'shift', 'F'], label: 'Search scrollback', note: 'Safari: collides with fullscreen' }
    ]
  },
  {
    heading: 'Sessions',
    items: [
      { keys: ['mod', 'enter'], label: 'New session in current project' }
    ]
  },
  {
    heading: 'Projects & app',
    items: [
      { keys: ['mod', 'shift', 'P'], label: 'New project', note: 'Firefox: collides with print preview' },
      { keys: ['mod', ';'], label: 'Open settings' }
    ]
  },
  {
    heading: 'View',
    items: [
      { keys: ['mod', 'B'], label: 'Toggle sidebar', note: 'Firefox: collides with bookmarks library' },
      { keys: ['mod', '.'], label: 'Cycle theme — system → dark → light' }
    ]
  }
];

const STATUS_LEGEND: Array<{ status: string; label: string; meaning: string }> = [
  { status: 'idle', label: statusLabel('idle'), meaning: 'Session attached and waiting' },
  { status: 'working', label: statusLabel('working'), meaning: 'Agent is actively producing output' },
  { status: 'waiting', label: statusLabel('waiting'), meaning: 'Agent is paused for human input' },
  { status: 'error', label: statusLabel('error'), meaning: 'Session crashed or hit a hard error' },
  { status: 'sleeping', label: statusLabel('sleeping'), meaning: 'Agent offline, or session detached' }
];

interface ShortcutsHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShortcutsHelp({ open, onOpenChange }: ShortcutsHelpProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 p-4 sm:p-6" onClick={() => onOpenChange(false)}>
      <section
        className="mx-auto mt-[8vh] flex max-h-[84vh] max-w-2xl flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Keyboard shortcuts</h2>
            <p className="mt-0.5 text-xs text-muted">Press <span className="font-mono">?</span> any time to open this list.</p>
          </div>
          <span className="font-mono text-[10px] text-muted">esc</span>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
          <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
            {GROUPS.map((group) => (
              <div key={group.heading}>
                <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted">{group.heading}</div>
                <ul className="space-y-1.5">
                  {group.items.map((item) => (
                    <li key={item.label} className="flex items-center justify-between gap-3 py-0.5 text-[13px]">
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-text">{item.label}</span>
                        {item.note && <span className="truncate text-[11px] text-muted">{item.note}</span>}
                      </span>
                      <Shortcut keys={item.keys} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-7 border-t border-line/60 pt-5">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted">Status colors</div>
            <ul className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2">
              {STATUS_LEGEND.map(({ status, label, meaning }) => (
                <li key={status} className="flex items-center gap-2.5 py-0.5 text-[13px]">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', statusDot(status))} />
                  <span className="font-medium text-text">{label}</span>
                  <span className="truncate text-[11px] text-muted">{meaning}</span>
                </li>
              ))}
            </ul>
          </div>

        </div>
      </section>
    </div>
  );
}
