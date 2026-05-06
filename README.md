# termag-next

termag-next is a web interface to remote tmux sessions on remote machines. Forked from [termag](https://github.com/yeutterg/termag), this is re-implemented in Next.js with a responsive shadcn UI.

The browser UI runs from anywhere — your laptop, a homelab box, a VPS — while a thin outbound agent on each remote machine owns tmux and `node-pty`. The remote stays private: no inbound port, no public tmux surface.

> ⚠️ **Auth is off by default.** termag-next assumes it's reachable only through a private network — Tailscale, WireGuard, ssh tunnel, or a LAN. Anyone who can hit the URL gets a session. See [Authentication](#authentication) for the three available modes.

## Components

### `apps/web`

The web app is both frontend and backend.

- **Frontend:** Next.js 15 App Router, Tailwind, shadcn-style dense UI, `cmdk`, xterm.js, lazy-loaded dialogs, `next/font` for Inter / JetBrains Mono.
- **Backend:** Next.js route handlers for projects, tabs, tokens, theme, and scrollback search.
- **Custom server:** [apps/web/server.js](apps/web/server.js) wraps Next.js and handles WebSocket upgrades.
- **Broker:** [apps/web/server/broker.js](apps/web/server/broker.js) keeps the in-process maps for connected laptop agents and browser terminal streams.
- **Database:** Prisma + SQLite. Schema in [apps/web/prisma/schema.prisma](apps/web/prisma/schema.prisma).

WebSocket paths:

| Path | Client | Purpose |
| --- | --- | --- |
| `/api/ws/agent` | laptop agent | Authenticates with an agent token and receives tmux/PTY commands. |
| `/api/ws/terminal?sessionId=...` | browser | Streams xterm input/output for one `Session`. |
| `/api/ws/status` | browser | Pushes agent connected/sleeping state and refresh hints. |

### `apps/agent`

The laptop agent is intentionally small.

- Connects outbound to `/api/ws/agent`.
- Expands named roots, e.g. `WIP -> ~/WIP`.
- Creates or attaches deterministic tmux sessions.
- Spawns the configured agent command inside tmux.
- Bridges `node-pty` output back through the broker.
- Reconnects with exponential backoff (1s → 30s ceiling) on drop.
- Has a fake mode (`TERMAG_AGENT_FAKE=true`) for UI preview without `node-pty`.

The main entry point is [apps/agent/src/index.ts](apps/agent/src/index.ts).

### `infra`

Deployment files for one Hetzner CX22 or similar VPS:

- [infra/docker-compose.yml](infra/docker-compose.yml): web app plus Caddy.
- [infra/Caddyfile](infra/Caddyfile): TLS reverse proxy.
- [infra/README.md](infra/README.md): VPS setup notes.

## Authentication

termag-next has three browser auth modes. Pick the one that matches how the URL is reachable. The laptop-agent WebSocket (`/api/ws/agent`) is unaffected — it always requires a hashed bearer token created in the **Settings** dialog.

| Mode | Env vars | When to use |
| --- | --- | --- |
| 1. **Trusted (default)** | *none* | URL is reachable **only** through a private network (Tailscale, WireGuard, ssh tunnel, LAN). |
| 2. **Trusted + password** | `TERMAG_PASSWORD=…` | Same as above, but you want a thin safety net in case the URL leaks. |
| 3. **OAuth (Google)** | `TERMAG_TRUSTED_NETWORK=false` + `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_*`, `TERMAG_ALLOWED_EMAIL` | **Recommended for any public hostname.** Single allowlisted Google account. |

### 1. Trusted (default)

No login screen, no auth check. The first request auto-creates a single user keyed by `TERMAG_TRUSTED_USER_EMAIL` (defaults to `trusted@termag.local`). Open the URL, you're in.

```bash
TERMAG_TRUSTED_USER_EMAIL="me@local"   # optional, only affects the DB key
```

**Only safe behind a private-network ACL.** No second factor; whoever reaches the URL gets full session access. Don't expose this on a public hostname.

### 2. Trusted + password

Layers a single shared password on top of trusted mode. Useful as an "oops I leaked the URL into Slack" safety net. Not a substitute for OAuth on the open internet.

```bash
TERMAG_PASSWORD="pick-a-long-random-string"
```

How it works: `/login` shows a password form; on success the server sets a `httpOnly` cookie (`termag-auth`) holding `sha256(password)` for 30 days. The constant-time comparison happens server-side on every request and on the browser WebSocket. The command palette gains a Sign out item that clears the cookie.

### 3. OAuth (Google)

Full Google sign-in with a single-address allowlist. This turns trusted mode off and goes through NextAuth.

```bash
TERMAG_TRUSTED_NETWORK="false"
NEXTAUTH_URL="https://termag.example.com"
NEXTAUTH_SECRET="$(openssl rand -hex 32)"
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
TERMAG_ALLOWED_EMAIL="you@example.com"
```

Only the address in `TERMAG_ALLOWED_EMAIL` is allowed past the `signIn` callback. Everyone else gets bounced back to `/login`.

## Data Model

The hierarchy users see is **device → project → tab**:

- A **device** is a physical machine (your laptop, a homelab box, a VPS) running the `termag-agent` daemon. Devices appear as group labels in the sidebar (e.g. `laptop`, `homelab`) and are derived from `Project.rootKey` — each rootKey represents one device root.
- A **project** is a specific folder on one device (e.g. `~/WIP/api/termag-next`). Stored as `rootKey` + `relativePath` so termag-next never assumes an absolute path that's only valid on one machine.
- A **tab** is one coding agent running inside that folder (Claude Code, Codex, etc.). A project can host many tabs running in parallel — each is its own tmux session, its own context window, its own task. Tabs default to the agent's name (`Claude Code`, `Codex`) and are renameable.

Plus each project has one shared `ctrl` shell (a regular `$SHELL`, not an agent) for git, tests, and ad-hoc inspection — that's the right-hand pane in the main view.

The SQLite schema is deliberately flat for v1.

| Model | Purpose |
| --- | --- |
| `User` | Identity + display preferences. Auto-created in trusted-network mode. |
| `Project` | A folder on a device. Stores `rootKey` (device root, e.g. `laptop`) + `relativePath` (folder under that root). Never absolute paths — those only make sense on one machine. |
| `Tab` | One coding agent running inside a project. Default name = the agent's name (`Claude Code`, `Codex`); user-renameable. |
| `Session` | The tmux process behind a tab or `ctrl` shell. `kind = agent` for tabs; `kind = ctrl` for the project's shared shell. |
| `ScrollbackChunk` | Browser-side replay buffer, capped to ~10K lines per session. |
| `AgentToken` | Hashed bearer token for the `termag-agent` daemon — one per device. Raw token shown once. |

Tmux names are deterministic:

```text
termag-{projectId}-{tabId}
termag-{projectId}-ctrl
```

## Local Development

Install dependencies:

```bash
npm install
```

Create local config:

```bash
cp .env.example apps/web/.env.local
```

The defaults are auth-less and ready to run. Set at minimum:

```bash
DATABASE_URL="file:./dev.db"
NEXTAUTH_URL="http://localhost:3000"
TERMAG_TRUSTED_USER_EMAIL="me@local"
TERMAG_ROOTS='{"WIP":"~/WIP"}'
```

Initialize SQLite:

```bash
npm run db:generate
npm run db:migrate
```

Run the web app:

```bash
npm run dev
```

Open `http://localhost:3000` — you're in. Create an agent token in **Settings**, then on each machine you want to run agents on:

```bash
TERMAG_URL=ws://localhost:3000/api/ws/agent \
TERMAG_AGENT_TOKEN=tmag_... \
TERMAG_AGENT_ROOTS='{"WIP":"~/WIP"}' \
npm run agent
```

To layer on a password gate or switch to OAuth, see [Authentication](#authentication).

## Local UI Preview

To preview the UI with seeded fake data and a fake agent (no `node-pty`):

```bash
DATABASE_URL='file:./dev.db' npm run preview:seed -w apps/web
npm run dev
```

In a second shell:

```bash
TERMAG_URL='ws://localhost:3000/api/ws/agent' \
TERMAG_AGENT_TOKEN='tmag_preview_local_agent_token' \
npm run fake -w apps/agent
```

Open `http://localhost:3000`. The seeded preview user has sample projects, tabs, scrollback, and a fake connected agent that streams terminal output.

## UX Surface

- Sidebar project creation, grouped project list with nested tabs and inline `+` to add a session.
- Project tab strip for parallel agent sessions; tab labels mirror live xterm titles (OSC 0/2).
- Shared `ctrl` terminal beside the active agent tab.
- Cmd+K (Ctrl+K) command palette for project jumps and core commands.
- Cmd+Shift+F (Ctrl+Shift+F) scrollback search.
- Ctrl+Tab / Ctrl+Shift+Tab cycle most-recent tab order.
- Tri-state theme: system, dark, light. No flash on first paint (server-rendered class + inline boot script).
- Mobile-aware: keyboard hints hidden on phones; on-screen helper row for Esc, Tab, arrows, Ctrl-C, Ctrl-D.
- Sleeping state when the laptop agent is offline; auto-reattach on reconnect.

## Verification

```bash
npm run typecheck
npm run build
```

The production build needs at least:

```bash
DATABASE_URL='file:./dev.db' \
NEXTAUTH_URL='http://localhost:3000' \
npm run build -w apps/web
```

## Deployment

For the VPS path, use Docker Compose in `infra/`:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.yml up -d --build
```

The laptop agent connects to the deployed hostname:

```bash
TERMAG_URL=wss://termag.example.com/api/ws/agent \
TERMAG_AGENT_TOKEN=tmag_... \
TERMAG_AGENT_ROOTS='{"WIP":"~/WIP"}' \
npx @termag/agent
```

## Deferred From v1

The original termag had Slack, Discord, Chrome relay, project sharing, Postgres, and multi-user Unix-account mapping. Those are intentionally out of scope for the rebuild and can be reintroduced later against the simpler project/tab/session model.
