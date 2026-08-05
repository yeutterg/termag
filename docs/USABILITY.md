# Usability features

Replaces `USABILITY_IMPROVEMENTS.md` and `USABILITY_IMPLEMENTATION_SUMMARY.md`.
The latter claimed "ALL FEATURES COMPLETED (22 out of 21)" in one section and
"Remaining Implementations (9 out of 21)" in another, so neither could be
trusted as a status record.

Status below is by a reachable path from the live app. Merely having a module
on disk is not counted as a feature.

## Shipped and wired

| Feature                         | Where                                                    |
| ------------------------------- | -------------------------------------------------------- |
| Keyboard shortcut help          | `components/termag-app.tsx`                              |
| Project and tab reordering      | `components/termag-app.tsx`                              |
| Theme and font controls         | `app/globals.css`, `tailwind.config.ts`                  |
| Terminal touch/swipe navigation | `components/terminal/terminal-pane.tsx`                  |
| Accessible labels and dialogs   | live components under `components/`                      |
| Runtime-safe command palette    | `components/command-palette.tsx`, navigation + typed git |

## Retired scaffolding

The old example command-palette execution tree, arbitrary shell-command
facade, unmounted toast/dialog tree, duplicate touch hook, and standalone
observability experiments were deleted. The same cleanup removed the unused
snippet, bookmark, template, history, and clipboard-storage modules after
their last placeholder palette references disappeared. They had no importer
from the live application and several referenced database fields that no
longer exist. Future git or filesystem actions must use typed Protocol v2
operations rather than reviving the arbitrary `execute-command` channel.

## Not implemented

- Split panes in the browser. The agent mirrors HerdR and tmux pane layout
  (`RuntimeTab.layout`), so the data is available; the renderer shows one pane
  per tab.
- Multi-select operations across tabs or projects.

## Working on this area

Prefer driving the app on a phone over adding modules. The two defects that
most affected real use were both invisible from the code and obvious in a
minute of handling: background timers freezing the power lease, and a shared
rate-limit bucket returning 429 to everyone. Neither would have surfaced from
another read of the module list.
