# Troubleshooting

## Web app

Run the actual quality floor first:

```bash
npm ci
npm run typecheck
npm run lint
npx jest --runInBand
npm run build
```

`typecheck` regenerates Prisma and removes stale Next route types before `next typegen`; deleted routes
must not remain hidden by `.next/types`.

The production app must start through `apps/web/server.js` (`npm start`), not `next start`, because the
custom server handles WebSocket upgrades. For a port conflict, inspect the owner with `lsof -nP -iTCP:3000 -sTCP:LISTEN` before stopping anything.

## Agent cannot connect

- `TERMINALZ_URL` must end in `/api/ws/agent`.
- Non-loopback addresses require `wss://`.
- The Authorization bearer token must be the raw `tmag_…` value shown once by the broker.
- `NEXTAUTH_URL`/`TERMINALZ_ALLOWED_ORIGINS` must contain the browser origin; agents do not use Origin auth.
- Check foreground stderr or the Homebrew service log for the close reason.

```bash
terminalz config show
terminalz
```

## Machine is connected but empty

`terminalz list` should show the machine and current mirrored spaces. Herdr and tmux are independent:

- If Herdr is absent or stopped, its runtime is unavailable and tmux should still appear.
- If tmux is absent, Herdr terminals still work through Herdr's own observe/control interface.
- Confirm the agent process can find `herdr`/`tmux` in its service `PATH`, which may differ from an
  interactive shell.
- Restart the agent after rebuilding Rust code. Herdr itself does not need modification or restart.

## Create/browse/git path rejected

The local agent is the authority. Inspect `TERMINALZ_AGENT_ROOTS`, `TERMINALZ_ALLOW_DIRECTORIES`, and
`TERMINALZ_ALLOW_ALL_DIRECTORIES` with `terminalz config show`. Paths are canonicalized; `..`, control bytes,
and symlink escapes are rejected. The default policy allows the user's home directory.

## Terminal disconnects or redraws

The browser reconnects on network/visibility changes and requests a new checkpoint after sequence or
backpressure gaps. A visible **Reconnect** button handles fatal/stale inventory ids. If repeated:

- Check reverse-proxy WebSocket upgrade support and idle timeouts.
- Confirm browser and agent are both on protocol v2.
- Check whether the local Herdr/tmux pane still exists; runtime ids intentionally become invalid when
  the authoritative local item is gone.
- Verify a proxy is not buffering binary WebSocket frames.

No terminal output is recoverable from SQLite. Replay is intentionally memory-only and bounded.

## Mobile keyboard or controls are covered

Use real iOS Safari/Android Chrome, not only responsive emulation. Confirm the document has a
device-width viewport and that `--termag-viewport-height` changes with `visualViewport`. Installed PWA
mode often behaves better than a browser tab. Rotation and keyboard show/hide should trigger xterm fit
and a terminal resize message.

## Database and migrations

Back up production before deployment:

```bash
npm run db:backup
npm run db:deploy -w apps/web
```

SQLite now retains only auth/machine/bootstrap state and the latest machine inventory snapshot. If a
snapshot is corrupt or stale, reconnecting that machine replaces it; do not hand-edit virtual runtime
ids.

## Docker and TLS

```bash
docker compose -f infra/docker-compose.yml logs web
docker compose -f infra/docker-compose.yml logs caddy
```

`TERMINALZ_HOST` controls Caddy. `NEXTAUTH_URL` must exactly match the browser scheme, host, and port.
The trusted-network production server refuses a public bind without `TERMINALZ_PASSWORD` by design.
