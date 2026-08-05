# termag CLI

> Protocol v1 transition client. New daemon deployments should use the lightweight Rust agent on `port/rust-agent`; this package remains for CLI compatibility during the rollout. The macOS menu-bar helper has been removed.

Outbound laptop agent for [termag-next](https://github.com/yeutterg/termag-next). Bridges tmux sessions and windows on your machine to the termag broker over a single WebSocket. No inbound port, no public tmux surface.

The agent is intentionally tiny: it owns Termag-created tmux sessions on the local box, runs a real tmux client in a PTY so browser rendering matches a local terminal, and forwards terminal I/O over WebSocket. It reconnects on its own, supervises a heartbeat, reports existing tmux sessions for attach workflows, and never creates new project windows outside the named roots you configure.

In the web app, a project maps to a tmux session and each terminal tab maps to a tmux window. When you attach an existing tmux session, the broker treats the imported windows as external so closing Termag detaches from them instead of killing your existing tmux work.

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
termag                           # foreground; wrap in systemd for production
```

### Windows

Use WSL. tmux doesn't run on native Windows; the agent assumes a Unix tmux.

## Configure

```bash
export TERMAG_URL=wss://termag.example.com/api/ws/agent
export TERMAG_AGENT_TOKEN=tmag_...
export TERMAG_AGENT_ROOTS='{"laptop":"~/Projects","homelab":"~/homelab"}'
```

Generate `TERMAG_AGENT_TOKEN` in the web app from `+` → **New Device**.

`TERMAG_URL` must be `wss://` for any non-localhost host. The agent rejects `ws://` to anything else than 127.0.0.1 / ::1. A misconfigured URL or DNS poisoning would otherwise leak the agent token to whoever's at the other end.

For local Docker previews at `wss://localhost`, Caddy serves a local certificate that Node may not trust. You can opt out of certificate verification for localhost only:

```bash
export TERMAG_TLS_INSECURE_SKIP_VERIFY=true
```

| Variable                          | Purpose                                        | Default                    |
| --------------------------------- | ---------------------------------------------- | -------------------------- |
| `TERMAG_URL`                      | Broker WebSocket URL                           | (required)                 |
| `TERMAG_AGENT_TOKEN`              | Bearer token from the web New Device dialog    | (required)                 |
| `TERMAG_AGENT_ROOTS`              | JSON map of device labels to root paths        | none; configure explicitly |
| `TERMAG_TLS_INSECURE_SKIP_VERIFY` | Allow self-signed `wss://localhost` certs only | `false`                    |
| `TERMAG_RECONNECT_MS`             | Initial reconnect delay (ms)                   | `1000`                     |
| `TERMAG_RECONNECT_MAX_MS`         | Max reconnect delay (ms)                       | `30000`                    |
| `TERMAG_CONFIG`                   | Local config file path.                        | `~/.termag/config.json`    |
| `TERMAG_AGENT_FAKE`               | Run a no-tmux fake stream for UI preview       | `false`                    |

## Subcommands

```bash
termag              # connect to the broker (default)
termag new          # create/publish a tmux-backed shell here
termag adopt        # publish every window in the current tmux session
termag connect      # infer project from git/cwd and publish this shell
termag connect --project Restful-ESP32 --tab codex
termag -p Restful-ESP32 -t codex
termag connect --project Restful-ESP32 --session
termag update       # auto-detects brew vs npm and upgrades in place
termag --version
termag --help
```

`termag new` is the shortest path to a fresh tmux-backed shell at the current directory. `connect` publishes the current workspace. With no flags it infers the project from the current git repo or directory name. Run it from inside tmux to make the current window appear as a Termag terminal tab, or use `termag adopt` / `--session` to publish every window in the current tmux session. If you run it outside tmux, the agent creates or reuses a detached tmux session named after the project and a window named after `--tab`, starts the background websocket agent, and attaches this terminal to the tmux session. `termag -p <project> -t <tab>` is shorthand for the same connect flow. Use `--no-attach` to publish without attaching locally, or `--no-agent` to skip starting the background websocket agent.

## Requirements

- Node.js 18+
- tmux 2.7+ (for `resize-window`)

## License

MIT. See [LICENSE](./LICENSE).
