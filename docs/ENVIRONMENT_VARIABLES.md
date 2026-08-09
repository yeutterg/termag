# Environment variables

Never commit OAuth secrets, session secrets, passwords, or raw machine tokens.

## Web application

| Variable                            | Default                                    | Purpose                                                                         |
| ----------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| `DATABASE_URL`                      | none                                       | Prisma SQLite URL, such as `file:./dev.db` or `file:/data/terminalz.db`.        |
| `NEXTAUTH_URL`                      | none                                       | Canonical browser origin and primary WebSocket-origin allowlist entry.          |
| `NEXTAUTH_SECRET`                   | none                                       | NextAuth session/JWT secret.                                                    |
| `TERMINALZ_BIND_HOST`               | `HOSTNAME` or `0.0.0.0`                    | Explicit custom-server bind address; the image sets `0.0.0.0`.                  |
| `PORT`                              | `3000`                                     | Custom-server port.                                                             |
| `NODE_ENV`                          | `development`                              | Build/runtime security mode.                                                    |
| `GOOGLE_CLIENT_ID`                  | empty                                      | Google OAuth client id.                                                         |
| `GOOGLE_CLIENT_SECRET`              | empty                                      | Google OAuth client secret.                                                     |
| `TERMINALZ_ALLOWED_EMAIL`           | empty                                      | Single email admitted by Google OAuth.                                          |
| `TERMINALZ_TRUSTED_NETWORK`         | `false`                                    | Bypass OAuth for one trusted private-network user.                              |
| `TERMINALZ_TRUSTED_USER_EMAIL`      | allowed email or `trusted@terminalz.local` | SQLite identity used in trusted mode.                                           |
| `TERMINALZ_PASSWORD`                | empty                                      | Trusted-mode password; mandatory for production non-loopback binds.             |
| `TERMINALZ_ALLOWED_ORIGINS`         | empty                                      | Comma-separated additional browser origins/hosts allowed to upgrade WebSockets. |
| `TERMINALZ_BROKER_ORIGIN`           | empty                                      | CSP `connect-src` origin for an intentional split frontend/broker deployment.   |
| `TERMINALZ_TRUSTED_PROXY`           | `false`                                    | Honor normalized forwarded client IP headers for rate limits.                   |
| `TERMINALZ_DEV_AUTH`                | `false`                                    | Enable local credentials auth outside production.                               |
| `TERMINALZ_DEV_AUTH_EMAIL`          | `preview@terminalz.local`                  | Development-auth identity.                                                      |
| `TERMINALZ_ALLOW_BUILD_WITH_SERVER` | `false`                                    | Override the active-server production-build guard.                              |
| `TERMINALZ_HOST`                    | deployment-specific                        | Caddy hostname; application code does not read it.                              |
| `TERMINALZ_IMAGE`                   | `ghcr.io/yeutterg/terminalz`               | Compose web image.                                                              |
| `TERMINALZ_VERSION`                 | `latest`                                   | Compose image tag. Pin this in production.                                      |
| `NEXT_TELEMETRY_DISABLED`           | `1` in Docker                              | Disable Next.js telemetry.                                                      |
| `NODE_OPTIONS`                      | lean script defaults                       | Override the 384 MiB development or 192 MiB production old-space cap.           |

Legacy `TERMAG_*` web variables are mirrored to the canonical names by the custom server for one
migration window. New deployments should use only `TERMINALZ_*`.

## Rust agent

The canonical config file is `~/.terminalz/config.json`. It accepts `url`, `agentToken`, `agentRoots`,
`allowDirectories`, `allowAllDirectories`, and `inventoryIntervalMs`. Environment values override the
file.

| Variable                          | Default                      | Purpose                                                                           |
| --------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `TERMINALZ_CONFIG`                | `~/.terminalz/config.json`   | Override config path.                                                             |
| `TERMINALZ_URL`                   | config value                 | Broker agent WebSocket, normally `wss://host/api/ws/agent`. Required.             |
| `TERMINALZ_AGENT_TOKEN`           | config value                 | Raw `tmag_…` machine token. Required.                                             |
| `TERMINALZ_AGENT_ROOTS`           | config or `{"home":"$HOME"}` | Named roots available for create, browse, and git.                                |
| `TERMINALZ_ALLOW_DIRECTORIES`     | config or `[$HOME]`          | JSON array of allowed directory trees. Configured roots are also admitted.        |
| `TERMINALZ_ALLOW_ALL_DIRECTORIES` | `false`                      | Explicitly disable the local directory allowlist.                                 |
| `TERMINALZ_INVENTORY_INTERVAL_MS` | `5000`                       | Active tmux poll, clamped to `1000..60000`; idle polling backs off to 60 seconds. |

The agent reads `~/.termag/config.json` only when the canonical file is absent and accepts matching
legacy `TERMAG_*` variables. Its next config write migrates the complete file to `~/.terminalz`.

Herdr discovery respects Herdr's own `HERDR_CONFIG_PATH`, `XDG_CONFIG_HOME`, and `HOME` settings.
Terminalz reads Herdr's status-indicator preference only to match local iconography.

## Restricted-agent example

```env
TERMINALZ_URL="wss://terminalz.example.com/api/ws/agent"
TERMINALZ_AGENT_TOKEN="tmag_…"
TERMINALZ_AGENT_ROOTS='{"projects":"~/Projects"}'
TERMINALZ_ALLOW_DIRECTORIES='["~/Projects","~/Services"]'
```
