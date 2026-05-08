# termag-next

termag-next is a browser-based tmux workspace for coding agents on remote machines.

It is a Next.js fork and rebuild of the original [termag](https://github.com/yeutterg/termag) project. The idea is simple: run one web app somewhere reachable, run a small outbound agent on each machine that has projects, then use one browser to open the tmux sessions from all of those machines.

That browser can be on your laptop, a tablet, or a phone on a cellular connection. Your real work still happens inside tmux on the remote device, but the UI follows you.

![termag-next dark-mode browser UI with projects, tabs, and code visible in split tmux panes](docs/images/termag-ui.png)

## How It Works

```mermaid
flowchart LR
  subgraph Client["Where you are"]
    Browser["Browser UI<br/>laptop, tablet, or phone"]
  end

  subgraph Web["termag-next web app"]
    Next["Next.js UI + API"]
    Broker["WebSocket broker"]
    DB[("SQLite")]
    Next <--> Broker
    Next <--> DB
  end

  subgraph Machines["Remote machines"]
    direction TB
    AgentA["termag-agent<br/>MacBook"] --> TmuxA["tmux<br/>project tabs + ctrl shell"]
    AgentB["termag-agent<br/>homelab"] --> TmuxB["tmux<br/>project tabs + ctrl shell"]
    AgentC["termag-agent<br/>VPS"] --> TmuxC["tmux<br/>project tabs + ctrl shell"]
  end

  Browser <-->|HTTPS + WebSocket| Next
  Broker <-->|outbound WSS| AgentA
  Broker <-->|outbound WSS| AgentB
  Broker <-->|outbound WSS| AgentC
```

The agent always dials out to the web app. You do not need to expose tmux, SSH, or a laptop port to the internet.

## Components

- `apps/web`: the Next.js app. It includes the browser UI, route handlers, WebSocket broker, Prisma, and SQLite database.
- `apps/agent`: the small daemon that runs beside tmux on each remote device and bridges terminal I/O back to the browser.
- `infra`: Docker Compose and Caddy files for running the web app on a small VPS.

The user-facing shape is:

- Device: a machine running `termag-agent`. Create one device token per machine.
- Project: a folder on that device.
- Agent: one tmux-backed terminal window inside a project, running Claude Code, Codex, a YOLO variant, or another CLI command.
- Ctrl shell: a regular project shell for git, tests, and quick commands.

## Security Model

There is no shared termag-next service. Each user runs their own broker, and agents only ever talk to it.

```mermaid
graph LR
    Agent[termag-agent<br/>your laptop] -- wss + token --> Broker[your broker<br/>apps/web]
    Browser[browser<br/>your login] -- wss --> Broker
    Broker -. token check .-> DB[(SQLite<br/>AgentToken)]
```

Three things tie your agents to your broker:

1. **`TERMAG_URL` is on your laptop.** The agent only ever talks to the URL you set. Random brokers don't know your laptop exists.
2. **The agent token is minted by your broker.** It's stored hashed in your broker's SQLite. The agent presents the raw value on connect; if the hash isn't in the table, the connection is rejected.
3. **The agent rejects bare `ws://` for non-localhost.** Even if DNS got poisoned to point your `TERMAG_URL` somewhere hostile, the token can't leak in plaintext. The agent fails closed unless the URL is `wss://` or localhost.

Trust boundary: the device holding `TERMAG_AGENT_TOKEN` can connect; the broker that minted the token is what it connects to; the browser logged in to that broker sees the sessions. Three things, all yours.

## Quick Setup

### 1. Run The Web App

Pick the path that matches how the broker will be reached. Both use Docker Compose; only the env vars differ. Agent connections are unaffected by either choice — they always require a bearer token minted in the web UI.

#### Path A — Private network (Tailscale, WireGuard, ssh tunnel, LAN)

The default. Auth-less: no login screen, no OAuth setup. Anyone who can reach the URL gets a session, which is exactly what you want when the URL is already gated by your VPN.

Clone, then prep your env file:

```bash
git clone https://github.com/yeutterg/termag-next.git
cd termag-next
cp infra/.env.example infra/.env
```

Generate the NextAuth secret (NextAuth needs one even when there's no login screen):

```bash
openssl rand -hex 32
```

Edit `infra/.env`. Pick the shape that matches where the broker will actually live:

```bash
# Local testing on your own machine:
TERMAG_HOST=localhost
NEXTAUTH_URL=http://localhost

# Or — Tailscale / WireGuard / LAN:
# TERMAG_HOST=termag.tailnet
# NEXTAUTH_URL=https://termag.tailnet

NEXTAUTH_SECRET=<paste output of openssl above>
TERMAG_ROOTS={"MacBook Pro":"~/Code"}
# leave TERMAG_TRUSTED_NETWORK=true (the default)
```

`NEXTAUTH_URL` must be exactly what the browser types — same scheme, host, and port. A mismatch breaks OAuth callbacks and session cookies.

Start the stack:

```bash
cd infra
docker compose up -d --build
```

Open the URL you set in `NEXTAUTH_URL` — you're in. With the local Docker stack, Caddy publishes the app on host ports `80` and `443`; the Next.js container's port `3000` stays internal to Docker. `http://localhost` redirects to `https://localhost`, and Safari may show a "not private" warning for that local Caddy certificate.

**Optional shared-password gate** as a thin "oops I leaked the URL" safety net (useful for a homelab but NOT a substitute for OAuth on the open internet):

```bash
# add to infra/.env
TERMAG_PASSWORD=pick-a-long-random-string
```

#### Path B — Public hostname (Google OAuth)

Use this when the broker is reachable over the open internet. Adds a Google login with a single-email allowlist.

First create OAuth credentials at https://console.cloud.google.com/apis/credentials → **Create OAuth Client ID** → **Web application**, with authorized redirect URI `https://termag.example.com/api/auth/callback/google`.

Clone and prep:

```bash
git clone https://github.com/yeutterg/termag-next.git
cd termag-next
cp infra/.env.example infra/.env
openssl rand -hex 32
```

Edit `infra/.env`:

```bash
TERMAG_HOST=termag.example.com
NEXTAUTH_URL=https://termag.example.com
NEXTAUTH_SECRET=<paste output of openssl above>
TERMAG_ROOTS={"MacBook Pro":"~/Code"}

TERMAG_TRUSTED_NETWORK=false
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
TERMAG_ALLOWED_EMAIL=you@example.com    # only this address gets past signIn
```

Start the stack:

```bash
cd infra
docker compose up -d --build
```

Caddy auto-issues a Let's Encrypt cert for `TERMAG_HOST`. Open `https://termag.example.com` and sign in with Google.

Put these variables in `infra/.env` for Docker Compose, or in `apps/web/.env.local` for local development.

### 2. Create One Token Per Device

In the web UI, click `+` → **New Device**. Name the physical device, for example `MacBook Pro`, `Mac Mini`, `Hetzner VPS`, or `homelab`, then create the token. The raw token is shown once and includes a copy button.

### 3. Install An Agent On Each Device

The agent needs Node.js and tmux. Homebrew is preferred on macOS:

```bash
brew install yeutterg/tap/termag-agent
```

npm works anywhere Node.js and tmux are available:

```bash
npm install -g termag-agent
```

Configure the agent:

```bash
export TERMAG_URL=wss://termag.example.com/api/ws/agent   # your broker URL — see below for localhost
export TERMAG_AGENT_TOKEN=tmag_...
export TERMAG_AGENT_ROOTS='{"MacBook Pro":"~/Code"}'
```

Run it:

```bash
termag-agent
```

`TERMAG_URL` always includes the port unless you're using a default-port reverse proxy. Common shapes:

```bash
# Public hostname behind Caddy/nginx on TLS (no explicit port — 443 implied):
TERMAG_URL=wss://termag.example.com/api/ws/agent

# Tailscale or LAN with TLS terminator on port 443:
TERMAG_URL=wss://termag.tailnet/api/ws/agent

# Local development against `npm run dev` (default port 3000):
TERMAG_URL=ws://localhost:3000/api/ws/agent

# Local Docker stack with Caddy on port 443:
TERMAG_URL=wss://localhost/api/ws/agent
```

`ws://` (no TLS) is only accepted when the hostname is `localhost`, `127.0.0.1`, or `::1`. Anything else must be `wss://` or the agent refuses to connect.

Add more devices by creating one token per device, installing the agent on that device, and giving it a named root. The root key is the device label in the sidebar.

### 4. Create Projects And Agents

Click `+` → **New Project**. Select the device, enter the project directory, for example `~/Code/termag-next`, then choose agents. The built-in checkboxes include **Claude Code**, **Claude Code YOLO**, **Codex**, and **Codex YOLO**. Add any other agent command in the text box, one command per line. Termag-next creates one terminal window per selected or typed agent.

## Local Development

For working on termag-next itself:

```bash
npm install
cp .env.example apps/web/.env.local
npm run db:generate
npm run db:migrate
npm run dev
```

Configure a local agent in another shell:

```bash
export TERMAG_URL=ws://localhost:3000/api/ws/agent
export TERMAG_AGENT_TOKEN=tmag_...
export TERMAG_AGENT_ROOTS='{"Local device":"~/Code"}'
```

Run it:

```bash
npm run agent
```

Preview the UI without tmux:

```bash
DATABASE_URL='file:./dev.db' npm run preview:seed -w apps/web
npm run dev
```

Then configure the fake agent in another shell:

```bash
export TERMAG_URL='ws://localhost:3000/api/ws/agent'
export TERMAG_AGENT_TOKEN='tmag_preview_local_agent_token'
```

Run it:

```bash
npm run fake -w apps/agent
```

## Useful Commands

```bash
npm run typecheck
npm run build
npm run dev
npm run agent
```
