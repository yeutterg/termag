# VPS Deployment

The target deployment is one Hetzner CX22 running Docker Compose.

1. Point `TERMAG_HOST` at the future public hostname. For local testing, leave it as `localhost`.
2. Create an env file beside `infra/docker-compose.yml`:

```bash
TERMAG_HOST=termag.example.com
NEXTAUTH_URL=https://termag.example.com
NEXTAUTH_SECRET=...
TERMAG_TRUSTED_NETWORK=false
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
TERMAG_ALLOWED_EMAIL=...
TERMAG_ROOTS={"laptop":"~/Projects"}
```

3. Start the stack:

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d --build
```

4. In the web UI, create an agent token. On the laptop:

```bash
TERMAG_URL=wss://termag.example.com/api/ws/agent \
TERMAG_AGENT_TOKEN=tmag_... \
TERMAG_AGENT_ROOTS='{"laptop":"~/Projects"}' \
termag
```

The laptop agent dials out to the VPS. No inbound laptop port or tunnel is required.
