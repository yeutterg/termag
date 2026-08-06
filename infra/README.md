# Terminalz web deployment

The recommended deployment runs only the web control plane in Docker. Install the native `terminalz`
agent directly on every computer whose Herdr/tmux sessions should appear.

```bash
cp infra/.env.example infra/.env
$EDITOR infra/.env
docker compose --env-file infra/.env -f infra/docker-compose.yml up -d
```

The release Compose file pulls `ghcr.io/yeutterg/terminalz`. Pin `TERMINALZ_VERSION` for predictable
production upgrades. To build from a checkout instead:

```bash
docker compose --env-file infra/.env \
  -f infra/docker-compose.yml -f infra/docker-compose.build.yml up -d --build
```

Caddy terminates TLS on ports 80/443 and forwards HTTP and WebSocket traffic to the private web
container. The SQLite database is stored in the `terminalz-data` volume. Back that volume up before
upgrades.

Bootstrap each machine from the web UI, then:

```bash
terminalz bootstrap https://terminalz.example.com/api/bootstrap/claim/...
brew services start terminalz
```

Every uniquely named machine token can be connected concurrently under one account. Reconnecting the
same machine name replaces only its stale socket; it does not affect other computers.
