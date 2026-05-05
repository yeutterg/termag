# termag

termag is a personal coding-agent dashboard. The browser UI can run from a VPS, while the laptop runs a thin outbound agent that owns tmux and `node-pty`. This keeps the laptop private: no inbound port, no tunnel, and no public tmux surface.

The rebuild target is a single-user tool for parallel Claude Code, Codex, and future agent sessions.

## Components

### `apps/web`

The web app is both frontend and backend.

- **Frontend:** Next.js 15 App Router, Tailwind, shadcn-style dense UI, `cmdk`, xterm.js.
- **Backend:** Next.js route handlers for auth, projects, tabs, tokens, theme, and scrollback search.
- **Custom server:** [apps/web/server.js](apps/web/server.js) wraps Next.js and handles WebSocket upgrades.
- **Broker:** the custom server keeps the in-process maps for connected laptop agents and browser terminal streams.
- **Database:** Prisma + SQLite. The schema is in [apps/web/prisma/schema.prisma](apps/web/prisma/schema.prisma).

Important WebSocket paths:

| Path | Client | Purpose |
| --- | --- | --- |
| `/api/ws/agent` | laptop agent | Authenticates with an agent token and receives tmux/PTY commands. |
| `/api/ws/terminal?sessionId=...` | browser | Streams xterm input/output for one `Session`. |
| `/api/ws/status` | browser | Pushes agent connected/sleeping state and refresh hints. |

### `apps/agent`

The laptop agent is intentionally small.

- Connects outbound to `/api/ws/agent`.
- Expands named roots, for example `WIP -> /Users/greg/WIP`.
- Creates or attaches deterministic tmux sessions.
- Spawns the configured agent command inside tmux.
- Bridges `node-pty` output back through the VPS broker.
- Reconnects automatically when the VPS or network drops.

The main entry point is [apps/agent/src/index.ts](apps/agent/src/index.ts).

### `infra`

Deployment files for one Hetzner CX22 or similar VPS:

- [infra/docker-compose.yml](infra/docker-compose.yml): web app plus Caddy.
- [infra/Caddyfile](infra/Caddyfile): TLS reverse proxy.
- [infra/README.md](infra/README.md): VPS setup notes.

## Data Model

The SQLite schema is deliberately flat for v1.

| Model | Purpose |
| --- | --- |
| `User` | Google identity, display preferences. Single allowlisted account in practice. |
| `Project` | One working directory, one agent type, one spawn command. Stores `rootKey` and `relativePath`, not laptop absolute-path assumptions. |
| `Tab` | A parallel agent session within a project. |
| `Session` | A tmux-backed terminal. Agent tabs use `kind = agent`; the shared project terminal uses `kind = ctrl`. |
| `ScrollbackChunk` | Browser-side replay buffer, capped by the broker to roughly 10K lines per session. |
| `AgentToken` | Hashed bearer token for the laptop agent. Raw token is shown once. |

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

Create local web config:

```bash
cp .env.example apps/web/.env.local
```

Set at least:

```bash
DATABASE_URL="file:./dev.db"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="replace-with-openssl-rand-hex-32"
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
TERMAG_ALLOWED_EMAIL="your-email@example.com"
TERMAG_ROOTS='{"WIP":"/Users/greg/WIP"}'
```

Do not commit real emails, OAuth secrets, or agent tokens.

Initialize SQLite:

```bash
npm run db:generate
npm run db:migrate
```

Run the web app:

```bash
npm run dev
```

Create an agent token in the UI, then run the laptop agent:

```bash
TERMAG_URL=ws://localhost:3000/api/ws/agent \
TERMAG_AGENT_TOKEN=tmag_... \
TERMAG_AGENT_ROOTS='{"WIP":"/Users/greg/WIP"}' \
npm run agent
```

## UX Surface

- Sidebar project creation and grouped project list.
- Project tab strip for parallel agent sessions.
- Shared `ctrl` terminal beside the active agent tab.
- Cmd+K omni palette for project jumps and core commands.
- Cmd+Shift+F scrollback search.
- Tri-state theme: system, dark, light.
- Mobile terminal helper row for Esc, Tab, arrows, Ctrl-C, and Ctrl-D.
- Sleeping state when the laptop agent is offline.

## Verification

```bash
npm run typecheck
npm run build
```

The web production build needs environment placeholders for auth:

```bash
DATABASE_URL='file:./dev.db' \
NEXTAUTH_SECRET='dev-secret' \
NEXTAUTH_URL='http://localhost:3000' \
TERMAG_ALLOWED_EMAIL='local@example.com' \
npm run build -w apps/web
```

## Deployment

For the VPS path, use Docker Compose in `infra/`. The domain can be filled in later; local or staging can use `localhost`.

```bash
docker compose --env-file infra/.env -f infra/docker-compose.yml up -d --build
```

The laptop agent connects to the deployed hostname:

```bash
TERMAG_URL=wss://termag.example.com/api/ws/agent \
TERMAG_AGENT_TOKEN=tmag_... \
TERMAG_AGENT_ROOTS='{"WIP":"/Users/greg/WIP"}' \
npx @termag/agent
```

## Deferred From v1

The old codebase had Slack, Discord, Chrome relay, project sharing, Postgres, and multi-user Unix-account mapping. Those are intentionally removed from the active rebuild and can be reintroduced later against the simpler project/tab/session model.
