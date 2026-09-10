---
project: terminalz
status: production
status_description: "Self-hosted cloud access to local Herdr and tmux terminals through a low-footprint Rust agent and a mobile-capable Next.js client."
last_updated: 2026-08-05
last_updated_by:
  - agent: codex
wiki_schema_version: 1
---

# AGENTS.md — Terminalz

## Purpose

Terminalz is a remote view of terminal organization that already exists on a machine. A small outbound
Rust daemon connects every machine to one authenticated Next.js broker. Herdr remains an independent,
authoritative local application; Terminalz does not fork, patch, launch, configure, or embed it.

When Herdr is running, the hierarchy is machine → Herdr session → space → tab → pane. Native ids,
names, order, focus, split layout, statuses, and dot/symbol iconography are mirrored exactly. Typed
cloud mutations go through Herdr and return in its next snapshot. tmux is discovered independently;
it works with or without Herdr and is the fallback runtime when Herdr is absent.

There is no menu-bar app, Node device agent, broker-side SSH transport, arbitrary command channel,
cloud-only project organizer, persisted terminal scrollback, Redis, Sentry, OpenTelemetry, Prometheus,
or Winston layer.

## Repository

```text
apps/web/       Next.js UI, route handlers, Prisma/SQLite, PWA, and custom WebSocket broker
apps/agent-rs/  protocol-v2 Rust daemon plus bootstrap/list/attach CLI
apps/ios/       SwiftUI iPhone/iPad client; native navigation with a WebKit terminal surface
infra/          Docker Compose, Caddy, staging, and Homebrew packaging
scripts/        database and deployment helpers
docs/           protocol, environment, troubleshooting, and ADRs
```

The production web process must run `apps/web/server.js`; `next start` alone does not own WebSocket
upgrades. `server/broker.js` routes agent/browser sockets, `server/broker-rpc.js` allowlists typed
operations, and `server/terminal-checkpoint-store.js` owns bounded in-memory replay state.

## Runtime and persistence

`AgentToken` is the durable machine identity. SQLite stores the token hash, capabilities, and one
bounded normalized `inventorySnapshot` JSON value. Herdr/tmux spaces, tabs, panes, and terminal
sessions are not copied into relational rows. `lib/runtime-projects.ts` projects the current snapshot
into the existing UI shape and creates signed-in-user-scoped virtual ids (`rp_`, `rt_`, `rs_`).

The broker validates every terminal id against the connected agent's current inventory before attach.
Terminal checkpoints and short ANSI tails are memory-only, sequence-checked, capped at 16 MiB across
the broker, and discarded when no viewer remains. The browser uses bounded xterm scrollback.

## Local agent

The Rust agent uses a current-thread Tokio runtime. It subscribes to Herdr events, polls tmux with an
idle backoff up to 60 seconds, and starts terminal helpers only while viewers exist. Release builds use
LTO, one codegen unit, stripping, `opt-level = "s"`, and `panic = "abort"`.

Configuration lives at `~/.terminalz/config.json` unless `TERMINALZ_CONFIG` overrides it. Legacy
`~/.termag/config.json` and `TERMAG_*` values are read only for migration. Environment values
win. With no explicit roots or allowlist, the user's home directory is exposed and writable by
default. Every browse, create, and git path is canonicalized and checked locally. Set
`allowAllDirectories`/`TERMINALZ_ALLOW_ALL_DIRECTORIES=true` only as an explicit opt-out.

Supported commands:

```text
terminalz
terminalz bootstrap URL
terminalz config show
terminalz config set roots JSON
terminalz list
terminalz attach TARGET
```

## Protocol invariants

1. Protocol v2 is the only supported protocol. Do not add v1 names or aliases.
2. Never add arbitrary command or shell-string execution. Runtime, power, and git requests are named,
   broker-allowlisted operations with agent-side validation. See ADR 0001.
3. Never trust a browser absolute path. Send `rootKey` plus `relativePath`; the local policy is final.
4. Preserve native runtime ids and display values. Unknown status values become `unknown`.
5. A cloud-created Herdr object must be created through Herdr, then arrive in the next snapshot. Do
   not synthesize a parallel tmux or database object.
6. Terminal output must remain binary-safe, bounded, and absent from logs, databases, service-worker
   caches, analytics, and error telemetry.
7. A continuity gap must force a checkpoint/resync. Never present a truncated stream as contiguous.

## Security

- Agent sockets use bearer tokens. Raw tokens are displayed once and stored hashed server-side.
- Non-loopback agents require `wss://`; plaintext is allowed only for exact loopback hosts.
- Browser WebSocket origins must match `NEXTAUTH_URL` or `TERMINALZ_ALLOWED_ORIGINS`.
- Cookie-authenticated mutations use Origin/Sec-Fetch-Site checks. Auth callbacks and one-use bootstrap
  claims are the explicit exemptions.
- `TERMINALZ_TRUSTED_NETWORK=true` is private-network mode. Production refuses a non-loopback bind
  unless `TERMINALZ_PASSWORD` is also set.
- Forwarded client IPs are honored only with `TERMINALZ_TRUSTED_PROXY=true` behind a normalizing proxy.

## Mobile and memory

- The viewport is device-width and `ClientRuntime` sizes the app from `visualViewport`, including the
  soft keyboard and safe-area insets.
- Refit terminals on visual viewport, orientation, and element resize; reconnect eagerly on `online`
  and `visibilitychange` with jittered exponential backoff.
- Primary touch targets are at least 44×44 CSS pixels.
- Only active terminal panes are mounted. Hidden pages dispose xterm/WebSocket instances after 90
  seconds. Phone/constrained scrollback is 500 lines; desktop is 2,000.
- Phone, touch-portable, Save-Data, and slow-network clients request low-data terminal mode: live
  writes coalesce for 64 ms, replay frames batch for compression, and fresh tmux checkpoints are
  limited to 300 lines / 256 KiB (desktop: 2,000 lines / 1 MiB). Visible output remains lossless.
- Inventory status/focus changes use compact id-based WebSocket patches; structural changes alone
  trigger a full project reload. Health ticks contain only health fields. Constrained clients close
  the status socket while hidden and reconcile once when foregrounded.
- The service worker bypasses `/api`, auth, WebSockets, and navigation documents.
- Keep optional dialogs lazy-loaded and delete unreachable feature scaffolding.

## Verification

```bash
npm ci
npm run typecheck
npm run lint
npx jest --runInBand
npm run build

cd apps/agent-rs
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --release --locked
```

Rust 1.82.0 is pinned in `rust-toolchain.toml` and `Cargo.toml`. `npm run typecheck` must regenerate
Prisma and Next route types; stale generated clients once hid real failures.

Test keyboard appearance, rotation, reconnect after network handoff, background/foreground recovery,
and installed-PWA behavior on real iOS Safari and Android Chrome. Desktop responsive emulation does
not reproduce mobile visual-keyboard behavior.
