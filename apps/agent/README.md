# termag-agent

Outbound laptop agent for [termag-next](https://github.com/yeutterg/termag-next). Bridges tmux sessions on your machine to the termag broker over a single WebSocket. No native deps, no inbound port, no public tmux surface.

The agent is intentionally tiny: it owns tmux on the local box, streams pane output through `tmux pipe-pane`, and forwards your keystrokes through `tmux send-keys`. It reconnects on its own, supervises a heartbeat, and never touches anything outside the named roots you configure.

## Install

### macOS

```bash
brew install yeutterg/tap/termag-agent
brew services start termag-agent
```

### Linux / WSL

```bash
sudo apt install tmux            # or dnf/pacman/...
npm install -g termag-agent
termag-agent                     # foreground; wrap in systemd for production
```

### Windows

Use WSL. tmux doesn't run on native Windows; the agent assumes a Unix tmux.

## Configure

```bash
export TERMAG_URL=wss://termag.example.com/api/ws/agent
export TERMAG_AGENT_TOKEN=tmag_...
export TERMAG_AGENT_ROOTS='{"MacBook Pro":"~/Code","homelab":"~/homelab"}'
```

Generate `TERMAG_AGENT_TOKEN` in the web app from `+` → **New Device**.

`TERMAG_URL` must be `wss://` for any non-localhost host. The agent rejects `ws://` to anything else than 127.0.0.1 / ::1. A misconfigured URL or DNS poisoning would otherwise leak the agent token to whoever's at the other end.

For local Docker previews at `wss://localhost`, Caddy serves a local certificate that Node may not trust. You can opt out of certificate verification for localhost only:

```bash
export TERMAG_TLS_INSECURE_SKIP_VERIFY=true
```

| Variable | Purpose | Default |
| --- | --- | --- |
| `TERMAG_URL` | Broker WebSocket URL | (required) |
| `TERMAG_AGENT_TOKEN` | Bearer token from the web New Device dialog | (required) |
| `TERMAG_AGENT_ROOTS` | JSON map of device labels to root paths | `{"Local device":"~/Code"}` |
| `TERMAG_TLS_INSECURE_SKIP_VERIFY` | Allow self-signed `wss://localhost` certs only | `false` |
| `TERMAG_RECONNECT_MS` | Initial reconnect delay (ms) | `1000` |
| `TERMAG_RECONNECT_MAX_MS` | Max reconnect delay (ms) | `30000` |
| `TERMAG_AGENT_FAKE` | Run a no-tmux fake stream for UI preview | `false` |

## Subcommands

```bash
termag-agent              # connect to the broker (default)
termag-agent update       # auto-detects brew vs npm and upgrades in place
termag-agent --version
termag-agent --help
```

## Requirements

- Node.js 18+
- tmux 2.7+ (for `resize-window`)

## License

MIT. See [LICENSE](./LICENSE).
