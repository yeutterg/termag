# Usability features

Replaces `USABILITY_IMPROVEMENTS.md` and `USABILITY_IMPLEMENTATION_SUMMARY.md`.
The latter claimed "ALL FEATURES COMPLETED (22 out of 21)" in one section and
"Remaining Implementations (9 out of 21)" in another, so neither could be
trusted as a status record.

Status below is by module presence in `apps/web`, not by any prior claim. A
module existing does not mean the feature is wired into the UI or that it
typechecks — see `docs/COMMAND_PALETTE.md` for the parts that do not.

## Shipped and wired

| Feature | Where |
| --- | --- |
| Toast notifications | `components/toast-provider.tsx`, `components/toast-container.tsx` |
| Keyboard shortcut help | `components/termag-app.tsx` |
| Drag-and-drop tabs | `components/draggable-tab.tsx` |
| Terminal search | `components/search-dialog.tsx` |
| Theme and font controls | `app/globals.css`, `tailwind.config.ts` |
| Touch gestures | `lib/use-touch-gestures.ts` |
| Offline handling | `lib/offline-manager.ts`, `public/sw.js` |
| Accessibility helpers | `lib/accessibility.ts`, `components/skip-links.tsx` |

## Present but not fully integrated

These have a module and no complete path from the UI, or depend on the v1-only
command channel:

| Feature | Where | Blocker |
| --- | --- | --- |
| Command snippets | `lib/command-snippets.ts` | not surfaced in the palette |
| Session bookmarks | `lib/session-bookmarks.ts` | not surfaced in the palette |
| Session templates | `lib/session-templates.ts` | creation path is v1-only |
| Session history/recovery | `lib/session-history.ts`, `components/session-recovery-dialog.tsx` | `lib/session-integration.ts` does not typecheck |
| Clipboard history | `lib/clipboard-history.ts` | no UI entry point |

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
