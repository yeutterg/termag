---
project: termag
status: rebuild
wiki_schema_version: 1
---

# AGENTS.md - termag

## Direction

This repository is a clean rebuild of termag around a single-user, single-VPS architecture:

- Next.js app with a custom WebSocket server.
- SQLite through Prisma.
- Google OAuth allowlisted to one email through environment config.
- A thin laptop agent that owns tmux and `node-pty`.
- No Slack, Discord, project sharing, Chrome relay, or Postgres in v1.

## Repo Layout

```text
apps/web/     Next.js UI, API routes, Prisma, custom WS broker
apps/agent/   laptop daemon for tmux and PTY operations
infra/        Docker Compose and Caddy config
```

## Operational Notes

- Do not commit personal emails, OAuth secrets, or agent tokens.
- Project paths use named roots. Store `rootKey` plus `relativePath`; the laptop agent expands the absolute path.
- Each project has one agent type and one shared `ctrl` session. Project tabs are parallel sessions of that agent type.
- Tmux sessions are deterministic: `termag-{projectId}-{tabId}` for agent tabs and `termag-{projectId}-ctrl` for the project ctrl session.
