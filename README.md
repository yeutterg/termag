# termag

Personal coding-agent dashboard for running parallel Claude Code, Codex, and future agent sessions from any browser while tmux and `node-pty` stay on the laptop.

## Current architecture

- `apps/web`: Next.js 15 App Router, shadcn-style components, custom `server.js`, WebSocket broker, Prisma + SQLite.
- `apps/agent`: laptop daemon. It dials out to the web app, owns tmux and PTY streams, and expands named project roots.
- `infra`: Docker Compose and Caddy for a single Hetzner VPS deployment.

The public surface is the VPS web app. The laptop agent only makes an outbound WSS connection.

## Local setup

```bash
npm install
cp .env.example apps/web/.env.local
npm run db:generate
npm run db:migrate
npm run dev
```

In another shell, create an agent token in the UI and run:

```bash
TERMAG_URL=ws://localhost:3000/api/ws/agent \
TERMAG_AGENT_TOKEN=tmag_... \
TERMAG_AGENT_ROOTS='{"WIP":"/Users/greg/WIP"}' \
npm run agent
```

`TERMAG_ALLOWED_EMAIL` should be set in local or deployment environment, not committed.
