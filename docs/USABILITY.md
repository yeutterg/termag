# Usability status

Only features reachable from the live application count here.

## Shipped

- Mobile device viewport, safe areas, visual-keyboard resizing, and 44 px primary touch targets.
- Reachable terminal soft keys for Esc, Tab, arrows, control keys, paging, and F1–F12.
- Jittered reconnect with immediate online/foreground recovery and a manual reconnect control.
- Machine → Herdr session → space → tab/pane organization with native order and iconography.
- Herdr split-layout rendering and direct tmux pane rendering.
- Keyboard shortcut help, tab swipes, theme switching, and a lazy-loaded command palette.
- Typed git operations with a visible bounded result dialog.
- Installable PWA whose worker bypasses APIs, auth, sockets, navigation, and terminal data.

## Deliberately absent

- Cloud-only project/tab reordering; local runtime order is authoritative.
- Database scrollback search or terminal-output retention.
- Broker-side SSH hosts and public share links.
- Arbitrary command execution, snippets, templates, toasts, and future-feature scaffolding.
- A second local desktop/menu-bar UI.

When changing this area, test on real iOS Safari and Android Chrome. Desktop narrow-width emulation
does not reproduce visual-keyboard occlusion, background timer suspension, or network handoff.
