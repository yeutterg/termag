# Terminalz native agent

This is the only supported Terminalz machine agent. It is an outbound-only protocol-v2 daemon and CLI
written in Rust. It has no menu-bar process or desktop UI and does not modify, launch, or embed Herdr.

The agent mirrors every local tmux session and every running Herdr session. Herdr metadata comes from
its documented local API; terminal viewing/control stays behind Herdr's public process boundary. One
helper is shared by all cloud viewers of a pane and exists only while that pane is open. When Herdr is
absent, tmux remains fully available.

## Install and run

```bash
brew install yeutterg/tap/terminalz
terminalz bootstrap https://terminalz.example.com/api/bootstrap/claim/...
brew services start terminalz
```

From source:

```bash
cargo build --release --locked --manifest-path apps/agent-rs/Cargo.toml
./apps/agent-rs/target/release/terminalz
```

The same binary runs the daemon and the `bootstrap`, `config`, `list`, and `attach` commands. It has no
connect/adopt mode or arbitrary command executor: protocol v2 discovers sessions continuously and all
mutations are typed.

Canonical configuration is `~/.terminalz/config.json`:

```json
{
  "url": "wss://terminalz.example.com/api/ws/agent",
  "agentToken": "tmag_…",
  "agentRoots": { "projects": "~/Projects" },
  "allowDirectories": ["~/Projects", "~/Services"],
  "allowAllDirectories": false
}
```

`TERMINALZ_URL`, `TERMINALZ_AGENT_TOKEN`, `TERMINALZ_AGENT_ROOTS`, and the other variables documented
in [the environment reference](../../docs/ENVIRONMENT_VARIABLES.md) override the file. Legacy
`~/.termag/config.json` and `TERMAG_*` values remain readable during migration.

Creation and browsing are restricted to the user's home directory by default. Every requested path is
canonicalized and checked locally. Set `allowAllDirectories: true` only as an explicit opt-out.

Files dropped into a browser terminal are transferred to the agent that owns that terminal and staged
under `.terminalz-uploads` in that terminal's working directory so workspace-sandboxed coding agents
can read them. The target-local path is bracketed-pasted only after the agent accepts the bytes.
Staged files expire after 24 hours; the daemon checks active staging directories hourly.
For a Herdr space whose `hermes` tab runs in a same-named Docker container, Terminalz resolves an
allowed writable bind mount and pastes the corresponding container-visible path. It never executes a
browser-provided container command or bypasses the local directory policy.

Power modes are `terminals-awake` (`caffeinate -i`), `display-awake` (`caffeinate -d -i`), and
`ac-awake` (`caffeinate -s`). Renewable machine-scoped leases prevent one browser from cancelling
another browser's lease and ensure abandoned leases expire.

## Footprint targets

- stripped release binary: at most 15 MiB (about 1.2 MiB measured on Apple Silicon)
- idle RSS: at most 20 MiB (under 7 MiB measured with a live Herdr session)
- idle CPU: below 0.5% while runtimes are quiet

Inventory, mutations, and power commands run outside the terminal-output loop. tmux polling backs off
geometrically to 60 seconds while nothing changes and immediately returns to the active interval after
a change.
