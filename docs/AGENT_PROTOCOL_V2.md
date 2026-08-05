# Termag Agent Protocol v2

Protocol v2 makes the local daemon an inventory and terminal transport, not a desktop UI.

## Runtime model

A connected device publishes versioned inventory snapshots:

```
Device
├── HerdR runtime
│   └── HerdR session
│       └── space
│           └── tab
│               └── pane / terminal
└── tmux runtime
    └── tmux session (represented as one space)
        └── window
            └── pane / terminal
```

Stable runtime IDs (HerdR `w*/t*/p*`, tmux `$*/@*/%*`) are persisted separately from display names. Missing items are archived, not deleted, so scrollback and identity survive a runtime restart.

## HerdR coexistence

Termag does not patch, fork, launch, or own HerdR. It discovers running HerdR sessions with `herdr session list --json`, reads snapshots over each documented Unix socket, and uses the documented terminal observer/controller commands. Session discovery is cached for 30 seconds; live state comes directly from the socket.

The cloud mirrors HerdR spaces, tabs, panes, split rectangles, agent statuses, and the configured dot/symbol status style. Typed create, rename, close, and pane operations call HerdR's public API and are reflected back by the next inventory snapshot.

## Terminal ownership

One local stream is shared by every cloud viewer of the same runtime target. New viewers are observers. A writable driver is assigned only after an explicit `terminal-claim-drive`. When the HerdR driver disconnects, the controller is released and the shared stream returns to observer mode.

## Directory policy

Existing sessions are always discoverable. New sessions and tabs are restricted to configured roots and canonicalized allowlisted paths. The default root and allowlist are the current user's home directory. `allowAllDirectories: true` is an explicit opt-out. Absolute-root escapes, `..`, control bytes, and symlink escapes are rejected.

## Power policy (macOS)

- `terminals-awake`: `caffeinate -i` (display sleep and lock remain available)
- `display-awake`: `caffeinate -d -i`
- `ac-awake`: `caffeinate -s`
- `off`: stop only the child process owned by this daemon

Duration is optional. This cannot keep a Mac awake with the lid physically closed.

## Compatibility and limits

The Node agent remains protocol-v1 compatible for one transition release, but its menu-bar helper is removed. Protocol v2 deliberately has no arbitrary command-execution message; cloud mutations use an allowlisted operation vocabulary. HerdR is optional—when absent, all local tmux sessions still appear and can be managed independently.
