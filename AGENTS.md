---
project: termag-next
status: production
status_description: "Self-hosted cloud access to local HerdR and tmux workspaces through a low-footprint Rust agent and a mobile-capable Next.js client."
last_updated: 2026-08-04
last_updated_by:
  - agent: codex
wiki_schema_version: 1
---

# AGENTS.md — termag-next

## What This Is

Termag is a self-hosted remote terminal workspace. A small outbound Rust daemon runs on each machine;
one Next.js broker exposes its live HerdR and tmux organization to authenticated browsers. HerdR stays
independent and authoritative. Termag neither forks, patches, launches, nor embeds HerdR.

When HerdR is present, the cloud hierarchy mirrors machine → HerdR session → space → tab → pane,
including order, focus, layouts, status vocabulary, and HerdR's dot/symbol icon style. Cloud-created
spaces and tabs go back through HerdR's local API. tmux is discovered independently and remains the
fallback when HerdR is absent. HerdR does not require tmux, and Termag attaches to HerdR terminals
through HerdR's own observe/control process interface.

## Repository Layout

```text
apps/web/       Next.js UI, API routes, Prisma/SQLite, PWA, and custom WebSocket broker
apps/agent-rs/  Protocol-v2 Rust daemon and the termag CLI
infra/          Docker Compose, Caddy, staging, and Homebrew packaging
scripts/        database, preview, and deployment helpers
docs/           operational docs and architecture decisions
```

There is no supported Node device agent and no menu-bar application. `apps/web` still uses
`@lydell/node-pty` for optional broker-side SSH-host streams; that is separate from the local device
agent.

## Architecture

```text
Browser ── HTTPS/WSS ──> Next.js custom server + broker ──> SQLite
                                  ▲
                                  │ one outbound authenticated WSS
                                  │
                            Rust device agent
                            ├─ HerdR CLI + Unix socket API
                            ├─ tmux CLI/control mode
                            ├─ typed git operations
                            └─ macOS caffeinate leases
```

The custom server in `apps/web/server.js` owns the HTTP server and WebSocket upgrades. The broker is
split by concern:

- `server/broker.js` — agent/browser routing and terminal-stream coordination.
- `server/terminal-checkpoint-store.js` — contiguous checkpoint + ANSI-tail replay with byte caps.
- `server/tmux-status.js` — pure tmux status classification.
- `server/ssh-host-lifecycle.js` and `ssh-session-stream.js` — optional broker-side SSH hosts.
- `server/broker-rpc.js` — typed request facade and operation allowlists.

Protocol v2 sends binary terminal frames and JSON control messages over one agent socket. Terminal
helpers exist only while viewers are attached. Multiple viewers share one local helper per terminal;
one driver can send input while observers remain read-only. Browser backpressure becomes an explicit
resync instead of unbounded buffering.

## Runtime and Data Model

- **AgentToken** identifies a physical device. The raw `tmag_…` token is shown once; SQLite stores its
  hash. `Project.rootKey` remains the human-facing device name for compatibility and `deviceId` is the
  stable identity.
- **Project** represents a mirrored space/workspace or a managed tmux session. `runtime` is `herdr` or
  `tmux`; runtime ids and ordinals map cloud rows back to native state.
- **Tab** represents a runtime tab/pane projection. HerdR tabs with multiple panes can produce multiple
  rows sharing `runtimeTabId` and distinct `runtimePaneId` values.
- **Session** is the browser-addressable terminal stream. Its target is a stable HerdR terminal/pane id
  or tmux pane/window target.
- **ScrollbackChunk** stores bounded terminal history. Default retention is seven days because terminal
  output can contain credentials.

`apps/web/server/inventory-v2.js` reconciles agent snapshots into SQLite. Native runtime inventory is
the source of truth for mirrored rows; do not invent a second local organization model.

## Local Agent

`apps/agent-rs` uses a single-thread Tokio runtime and dynamically starts local helpers only when
needed. Idle tmux polling backs off to 60 seconds; HerdR events trigger targeted refreshes. The release
profile uses LTO, one codegen unit, stripping, and `panic = "abort"`. Current targets are under 15 MiB
for the binary, under 20 MiB idle RSS, and under 0.5% idle CPU.

The agent reads `~/.termag/config.json` (override with `TERMAG_CONFIG`) and environment variables.
Environment values win over the file. With no explicit roots or allowlist, the home directory is the
default root and allowed directory. Creation, browsing, and git paths are canonicalized and checked
locally even if the web layer already validated them.

The installed binary supports:

```text
termag-agent                run the daemon
termag bootstrap URL        claim and store a one-time device token
termag config show
termag config set roots JSON
termag list
termag attach TARGET
```

## Security Invariants

1. Never add an arbitrary command or shell-string protocol message. Runtime, power, and git requests
   are named operations allowlisted by the broker and matched/validated agent-side. See ADR 0001.
2. Never trust an absolute path from a browser. Store/send `rootKey` plus `relativePath`; the agent
   canonicalizes it and enforces `allowDirectories`/`allowAllDirectories`.
3. Non-loopback agents require `wss://`. Plain `ws://` is accepted only for exact loopback hosts.
4. Browser WebSocket origins must match `NEXTAUTH_URL` or `TERMAG_ALLOWED_ORIGINS`. Agent sockets use
   bearer tokens and do not use browser-origin auth.
5. `TERMAG_TRUSTED_NETWORK=true` is for private networks. A production non-loopback bind also requires
   `TERMAG_PASSWORD`; otherwise the custom server refuses to start.
6. Honor forwarded IP headers only when `TERMAG_TRUSTED_PROXY=true` and the deployment really has a
   trusted normalizing proxy.
7. Keep terminal data out of logs, audit payloads, service-worker caches, and error telemetry. Sentry
   is intentionally not installed.

## HerdR Integration Rules

- Discover with `herdr session list --json`; read snapshots and mutations through each running
  session's local socket/API.
- Do not modify HerdR source or configuration. Reading its status-indicator preference is allowed so
  cloud iconography matches local UI.
- Preserve native ids, ordering, focus, layouts, and statuses. Unknown statuses should degrade to
  `unknown`, not be guessed into a different semantic state.
- A cloud-created HerdR tab/space must be created through HerdR, then appear through the next
  authoritative inventory snapshot. Do not create a parallel tmux object for it.
- If HerdR is missing or stopped, continue publishing tmux inventory normally.

## Web and Mobile Rules

- The viewport is device-width and the app sizes itself from `visualViewport` so iOS/Android keyboards
  do not cover the terminal or soft keys.
- Terminal resize and reconnect logic must react to viewport resize, `online`, and
  `visibilitychange`; background mobile timers are not reliable.
- Keep primary touch targets at least 44×44 CSS pixels and account for safe-area insets.
- The service worker may cache only versioned/static public assets. Never cache `/api`, auth,
  WebSocket, terminal, share, or HTML navigation responses.
- Heavy dialogs remain lazy-loaded. Verify a new client feature is reachable before adding a helper
  module; orphaned “future feature” trees are deleted, not retained as scaffolding.

## Git Operations

The palette supports `git.status`, `git.stage`, `git.branch`, `git.commit`, `git.pull`, and `git.push`.
`POST /api/git` resolves an authenticated owned project; the broker allowlists the operation; the Rust
agent re-resolves the path and invokes `git` directly without a shell. Output is bounded, commands time
out after 30 seconds, pull is fast-forward-only, and credential prompts are disabled. Interactive auth
and conflict resolution belong in the visible terminal.

## Build and Verification

```bash
npm ci
npm run typecheck          # prisma generate + next typegen + tsc --noEmit
npm run lint
npx jest --runInBand
npm run build

cd apps/agent-rs
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --release --locked
```

The Rust toolchain is pinned by `rust-toolchain.toml` to 1.82.0. Do not remove `prisma generate` from
the typecheck command; stale generated clients previously hid dozens of real errors.

Mobile keyboard/rotation, cellular↔Wi-Fi reconnect, background/foreground recovery, and installed-PWA
behavior require real iOS and Android hardware verification. Desktop narrow-width emulation is not a
substitute for visual-keyboard behavior.

## Operations

- Web logs: Docker logs or the process manager around `apps/web/server.js`.
- Health: `GET /api/health`.
- Prometheus metrics: `GET /api/metrics`.
- Agent: foreground stderr or Homebrew service logs.
- Database: SQLite at the path in `DATABASE_URL`; use `npm run db:backup` before destructive schema or
  data work.

The agent needs no restart for changes to the independent HerdR app, but it must be rebuilt/restarted
after Rust changes. The web app must run through its custom server in production; `next start` alone
does not provide the broker upgrades.
