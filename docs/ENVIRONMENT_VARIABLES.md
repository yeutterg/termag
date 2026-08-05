# Environment variables

Environment variables override defaults and, for the Rust agent, values in `~/.termag/config.json`.
Never commit OAuth secrets, session secrets, passwords, or raw agent tokens.

## Web application

| Variable          | Default       | Purpose                                                                                                  |
| ----------------- | ------------- | -------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`    | none          | Prisma SQLite URL, for example `file:./dev.db` or `file:/data/termag.db`. Required.                      |
| `NEXTAUTH_URL`    | none          | Canonical browser origin, including scheme and port. Also seeds the browser WebSocket-origin allowlist.  |
| `NEXTAUTH_SECRET` | none          | NextAuth JWT/session secret. Required outside trusted mode; recommended everywhere.                      |
| `HOSTNAME`        | `0.0.0.0`     | Custom server bind address.                                                                              |
| `PORT`            | `3000`        | Custom server port.                                                                                      |
| `NODE_ENV`        | `development` | `development` or `production`. Controls Next.js and security behavior.                                   |
| `TERMAG_ROOTS`    | `{}`          | JSON map of device labels to default paths used by web forms. Local agent policy is still authoritative. |

### Authentication and request security

| Variable                    | Default                                 | Purpose                                                                                                         |
| --------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`          | empty                                   | Google OAuth client id.                                                                                         |
| `GOOGLE_CLIENT_SECRET`      | empty                                   | Google OAuth client secret.                                                                                     |
| `TERMAG_ALLOWED_EMAIL`      | empty                                   | Single email allowed through Google OAuth.                                                                      |
| `TERMAG_TRUSTED_NETWORK`    | `false`                                 | Bypass OAuth and map every request to one trusted user. Use only behind a private-network ACL.                  |
| `TERMAG_TRUSTED_USER_EMAIL` | allowed email or `trusted@termag.local` | Database identity used in trusted mode.                                                                         |
| `TERMAG_PASSWORD`           | empty                                   | Optional password gate in trusted mode. Required by the production server when trusted mode binds non-loopback. |
| `TERMAG_ALLOWED_ORIGINS`    | empty                                   | Comma-separated extra browser origins/hosts allowed to upgrade WebSockets. `NEXTAUTH_URL` is always included.   |
| `TERMAG_BROKER_ORIGIN`      | empty                                   | Extra CSP `connect-src` value for an intentionally split browser/broker deployment. Include the scheme.         |
| `TERMAG_TRUSTED_PROXY`      | `false`                                 | Trust normalized forwarded-IP headers for rate-limit and audit identity. Enable only behind a known proxy.      |

### Terminal status and scrollback

| Variable                        |   Default |                               Range/cap | Purpose                                                                                   |
| ------------------------------- | --------: | --------------------------------------: | ----------------------------------------------------------------------------------------- |
| `TERMAG_WORKING_THRESHOLD_SEC`  |       `8` |                         positive number | tmux output younger than this is classified as working.                                   |
| `TERMAG_PTY_FRESH_MS`           |    `5000` |                         positive number | How long a live PTY status can override polled tmux facts while a viewer is attached.     |
| `TERMAG_SCROLLBACK_MAX_LINES`   |    `2500` |                            max `100000` | Maximum retained lines per session.                                                       |
| `TERMAG_SCROLLBACK_MAX_BYTES`   | `4194304` |                          max `67108864` | Maximum retained UTF-8 bytes per session.                                                 |
| `TERMAG_SCROLLBACK_BATCH_BYTES` |   `65536` | max `1048576` and never above max bytes | Flush threshold for persisted chunks.                                                     |
| `TERMAG_SCROLLBACK_BATCH_MS`    |     `100` |                              max `2000` | Maximum batch delay before persistence.                                                   |
| `TERMAG_SCROLLBACK_TTL_DAYS`    |       `7` |                               max `365` | Retention before the six-hour prune removes chunks. Terminal history may contain secrets. |

### Development and operations

| Variable                         | Default                | Purpose                                                                            |
| -------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `TERMAG_DEV_AUTH`                | `false`                | Enable preview credentials auth outside production.                                |
| `TERMAG_DEV_AUTH_EMAIL`          | `preview@termag.local` | User created by development auth.                                                  |
| `TERMAG_PREVIEW_AGENT_TOKEN`     | generated/explicit     | Preview seed token.                                                                |
| `TERMAG_PREVIEW_DEVICE_NAME`     | preview default        | Device label used by the preview seed script.                                      |
| `TERMAG_ALLOW_BUILD_WITH_SERVER` | `false`                | Override the build guard when a local custom server is already running.            |
| `SSH_AUTH_SOCK`                  | inherited              | Enables optional broker-side SSH-host authentication through the user's ssh-agent. |
| `LOG_LEVEL`                      | `info`                 | Winston log level for the health route/server logging.                             |
| `TERMAG_HOST`                    | deployment-specific    | Hostname consumed by Caddy/Docker Compose. It is not read by application code.     |
| `NEXT_TELEMETRY_DISABLED`        | `1` in Docker          | Disable Next.js telemetry.                                                         |

## Rust device agent

The config file accepts camel-case equivalents: `url`, `agentToken`, `agentRoots`,
`allowDirectories`, `allowAllDirectories`, and `inventoryIntervalMs`.

| Variable                       | Default                      | Purpose                                                                                                                  |
| ------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `TERMAG_CONFIG`                | `~/.termag/config.json`      | Override the agent config path.                                                                                          |
| `TERMAG_URL`                   | config value                 | Broker agent WebSocket, normally `wss://host/api/ws/agent`. Required. Non-loopback plaintext is rejected.                |
| `TERMAG_AGENT_TOKEN`           | config value                 | Raw `tmag_…` device token. Required.                                                                                     |
| `TERMAG_AGENT_ROOTS`           | config or `{"home":"$HOME"}` | JSON map of root names to paths advertised to the browser.                                                               |
| `TERMAG_ALLOW_DIRECTORIES`     | config or `[$HOME]`          | JSON array of directory trees where create, browse, and git operations are allowed. Every configured root is also added. |
| `TERMAG_ALLOW_ALL_DIRECTORIES` | `false`                      | Explicitly disable directory allowlisting. This grants the broker path access as the local user.                         |
| `TERMAG_INVENTORY_INTERVAL_MS` | `5000`                       | Active tmux poll interval, clamped to `1000..60000`; unchanged inventories back off to 60 seconds.                       |

HerdR discovery also respects `HERDR_CONFIG_PATH` for its config and standard `XDG_CONFIG_HOME`/`HOME`
fallbacks. Termag reads the local status-indicator preference only to match dots versus symbols.

## Minimal examples

Local development web app:

```env
DATABASE_URL="file:./dev.db"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="replace-with-random-value"
TERMAG_TRUSTED_NETWORK="true"
HOSTNAME="127.0.0.1"
TERMAG_ROOTS='{"local":"~/Projects"}'
```

Public OAuth deployment:

```env
DATABASE_URL="file:/data/termag.db"
NEXTAUTH_URL="https://termag.example.com"
NEXTAUTH_SECRET="replace-with-random-value"
GOOGLE_CLIENT_ID="…"
GOOGLE_CLIENT_SECRET="…"
TERMAG_ALLOWED_EMAIL="you@example.com"
TERMAG_TRUSTED_NETWORK="false"
TERMAG_TRUSTED_PROXY="true"
```

Agent restricted to two trees:

```env
TERMAG_URL="wss://termag.example.com/api/ws/agent"
TERMAG_AGENT_TOKEN="tmag_…"
TERMAG_AGENT_ROOTS='{"projects":"~/Projects"}'
TERMAG_ALLOW_DIRECTORIES='["~/Projects","~/Services"]'
```
