# Agent protocol v2

Protocol v2 makes the local daemon an inventory and terminal transport, not a desktop UI.

## Inventory

The agent pushes a normalized tree whenever local state changes:

```text
Machine
├── Herdr runtime
│   └── Herdr session → space → tab → pane/terminal
└── tmux runtime
    └── tmux session → window → pane/terminal
```

Each snapshot includes a monotonic revision, named directory roots, runtime availability, stable native
ids, exact display names, order, focus, status, and optional Herdr split layout/icon style. The broker
bounds and normalizes the untrusted tree, keeps the current copy in memory, and stores one latest JSON
snapshot on `AgentToken`. UI ids encode the token id plus exact runtime path; there are no relational
Project/Tab/Session mirrors and no archive reconciliation.

After the initial tree, status/focus-only revisions are sent to browsers as compact patches keyed by
those stable UI ids. Names, order, layout, cwd, runtime availability, roots, or other structural
changes still cause one full project refresh. Agent health heartbeats are separate small messages and
do not resend the runtime/session list.

## Herdr coexistence

Terminalz does not patch, fork, launch, own, or configure Herdr. It discovers running sessions with the
Herdr CLI, reads the public session socket, subscribes to events, and invokes typed public mutations.
Terminal bytes use Herdr's observe/control process interface. Helpers exist only while viewers are
attached. When Herdr is unavailable, tmux discovery and streaming continue independently.

## Terminal transport

The browser opens `/api/ws/terminal?sessionId=rs_…`. The broker decodes the virtual id and verifies
every component against the connected agent's current inventory before sending `terminal-attach`.

Agent output uses binary `TMG2` frames:

```text
magic[4] flags[1] sequence[u32be] stream-id-length[u16be] stream-id payload
```

Flags mark checkpoint start, continuation, and end. Sequence gaps discard cached replay state and force
a resync. The broker fans one target's bytes to its browser viewers, coalesces short writes, pauses
hidden/backpressured clients, and caps replay/checkpoint memory. Terminal output never enters SQLite.
Browser clients advertise `dataMode=low` on phone/touch-portable, Save-Data, and slow connections.
That mode coalesces live output for 64 ms and batches replay messages so WebSocket compression works
across small writes. Fresh tmux checkpoints use 300 history lines and a 256 KiB cap instead of the
desktop 2,000-line / 1 MiB policy; all output produced while the terminal is visible remains lossless.

tmux uses control mode with a stable pane id and `ignore-size`, so a browser does not select or reflow
the window visible on the physical machine. Herdr output also stays observer-only: its frames trigger
a bounded `pane.read` of recent unwrapped ANSI lines, which each browser xterm wraps at its own width
and follows at the bottom. Input uses Herdr's typed `pane.send_input` API. Terminalz therefore never
takes over, resizes, or inherits the scroll position of the native Herdr client. Browser viewers still
use a renewable driver lease to choose the latest input source; programmatic initial focus does not
claim it, and hiding or blurring Terminalz releases it.

## Typed requests

The broker and agent both allowlist request names.

- Runtime: `runtime.create-session`, `runtime.create-space`, `runtime.create-tab`, rename/close
  variants for sessions, spaces, tabs, and panes.
- Filesystem: `list-directory` and bounded `file.upload-chunk` writes with `rootKey` plus a relative
  directory. Browser drops are capped at five files and 16 MiB each, stored under the canonicalized
  session directory's `.terminalz-uploads`, and the resulting local path is inserted as input.
- Git: `git.status`, `git.stage`, `git.branch`, `git.commit`, `git.pull`, `git.push`.
- Power: `power.acquire`, `power.renew`, `power.release`, `power.get`.
- Terminal events: attach, input, resize, claim-drive, release-drive, close.

There are no protocol-v1 aliases and no arbitrary command or shell-string request.

## Directory policy

Existing sessions are discoverable regardless of cwd. New sessions/tabs, directory browsing, and git
operations are restricted to configured roots and canonicalized allowlisted paths. Defaults are the
current user's home directory. `allowAllDirectories: true` is an explicit opt-out. Absolute escapes,
`..`, control bytes, and symlink escapes are rejected agent-side.

## Power policy (macOS)

- `terminals-awake`: `caffeinate -i` (display sleep and lock remain available)
- `display-awake`: `caffeinate -d -i`
- `ac-awake`: `caffeinate -s`

Power is machine-scoped but client-leased. The strongest live lease determines one daemon-owned child;
expired leases are reaped automatically, and daemon shutdown stops its child. This cannot keep a Mac
awake with its lid physically closed.

## Bounds

- WebSocket messages: 1 MiB
- Terminal payload frame: 256 KiB broker-side / 240 KiB agent-side
- Browser input message: 256 KiB; frontend pastes are chunked
- Fresh tmux checkpoint: 1 MiB / 2,000 history lines; low-data clients: 256 KiB / 300 lines
- Inventory persistence: 16 MiB hard check (wire size is already lower)
- Broker terminal checkpoint cache: 16 MiB total, 4 MiB per full checkpoint, 512 KiB tail
- Agent WebSocket buffers: 8 KiB read, 32 KiB write, 1 MiB maximum write queue
