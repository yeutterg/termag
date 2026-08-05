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

Termag does not patch, fork, launch, or own HerdR. It discovers running HerdR sessions with `herdr session list --json`, reads snapshots and subscribes to organization/status events over each documented Unix socket, and refreshes only the changed runtime. Session discovery is cached for 30 seconds. Terminal bytes stay behind HerdR's public `herdr terminal session observe/control` process boundary; one helper is shared per open target and no helper remains while the cloud viewer is closed.

The cloud mirrors HerdR spaces, tabs, panes, split rectangles, and agent statuses, and renders HerdR's native dot/icon glyph vocabulary. Typed create, rename, close, and pane operations call HerdR's public API and are reflected back by the next inventory snapshot.

## Terminal ownership

One local stream is shared by every cloud viewer of the same runtime target. Terminal output is binary and is emitted once per target, then fanned out by the broker. Bounded full checkpoints make reconnects deterministic without an unbounded cloud ANSI log. If a bounded output queue ever fills, the agent sends an explicit continuity-gap event and the browser reconnects for a new checkpoint; bytes are never silently omitted from a supposedly valid replay. New viewers are observers. A writable driver is assigned only after an explicit `terminal-claim-drive`, and the lease expires after five minutes without input. When the HerdR driver disconnects, the controller is released and the shared stream returns to observer mode.

tmux viewers use a control-mode client with `ignore-size`, filter output to the stable pane ID, and inject input directly into that pane. They never select a tmux window or pane and never resize the shared window, so opening or resizing a browser terminal cannot move or reflow the terminal shown on the physical machine. Non-target panes are disabled on the control client to keep background traffic low.

## Directory policy

Existing sessions are always discoverable. New sessions and tabs are restricted to configured roots and canonicalized allowlisted paths. The default root and allowlist are the current user's home directory. `allowAllDirectories: true` is an explicit opt-out. Absolute-root escapes, `..`, control bytes, and symlink escapes are rejected.

## Power policy (macOS)

- `terminals-awake`: `caffeinate -i` (display sleep and lock remain available)
- `display-awake`: `caffeinate -d -i`
- `ac-awake`: `caffeinate -s`
- `off`: stop only the child process owned by this daemon

Protocol-v2 power requests are renewable, client-scoped leases. The strongest live lease determines the single owned `caffeinate` child; expired leases are reaped automatically. The child also watches the daemon PID, so a crash or forced service stop releases the assertion. Duration is optional on the legacy compatibility request. This cannot keep a Mac awake with the lid physically closed.

## Compatibility and limits

The Node agent remains protocol-v1 compatible for one transition release, but its menu-bar helper is removed. Protocol v2 deliberately has no arbitrary command-execution message; cloud mutations use an allowlisted operation vocabulary. HerdR is optional—when absent, all local tmux sessions still appear and can be managed independently.
