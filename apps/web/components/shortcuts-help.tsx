'use client';

import { Shortcut, type ChordKey } from './shortcut';

type Item = { keys: ChordKey[]; label: string };
type Group = { heading: string; items: Item[] };

const GROUPS: Group[] = [
  {
    heading: 'Navigate',
    items: [
      { keys: ['mod', 'K'], label: 'Open command palette' },
      { keys: ['mod', '1'], label: 'Jump to session 1 (also ⌘2 … ⌘9)' },
      { keys: ['ctrl', 'tab'], label: 'Cycle most-recent tab' },
      { keys: ['ctrl', 'shift', 'tab'], label: 'Cycle most-recent tab (reverse)' },
      { keys: ['mod', 'shift', 'F'], label: 'Search scrollback' }
    ]
  },
  {
    heading: 'Sessions',
    items: [
      { keys: ['mod', 'enter'], label: 'New session in current project' },
      { keys: ['mod', 'W'], label: 'Close current session (browser may intercept)' }
    ]
  },
  {
    heading: 'Projects & app',
    items: [
      { keys: ['mod', 'shift', 'P'], label: 'New project' },
      { keys: ['mod', ';'], label: 'Open settings' }
    ]
  },
  {
    heading: 'View',
    items: [
      { keys: ['mod', 'B'], label: 'Toggle sidebar' },
      { keys: ['mod', '.'], label: 'Cycle theme (system → dark → light)' }
    ]
  },
  {
    heading: 'Help',
    items: [
      { keys: ['?'], label: 'Show this cheat sheet' }
    ]
  }
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
        className="mx-auto mt-[10vh] flex max-h-[80vh] max-w-2xl flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl"
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
                      <span className="text-text">{item.label}</span>
                      <Shortcut keys={item.keys} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
