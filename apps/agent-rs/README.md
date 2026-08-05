# Termag Rust agent

This is the Protocol v2 replacement for the Node laptop agent. It is an outbound-only daemon and does not modify or embed HerdR.

There is no menu-bar process or desktop UI. Terminal helpers are spawned only while a cloud viewer is attached; idle inventory uses a single current-thread async runtime.

It mirrors every local tmux session and every running HerdR session. HerdR metadata comes from its documented local socket API; terminal viewing/control uses the public `herdr terminal session observe/control` commands on demand. When HerdR is absent, tmux remains fully available.

## Build and run

```bash
cargo build --release --manifest-path apps/agent-rs/Cargo.toml
./apps/agent-rs/target/release/termag-agent
```

The agent reads the existing `~/.termag/config.json` keys (`url`, `agentToken`, and `agentRoots`) and the existing `TERMAG_URL`, `TERMAG_AGENT_TOKEN`, and `TERMAG_AGENT_ROOTS` overrides.

Creation and browsing are restricted to the user's home directory by default. Configure `allowDirectories` with absolute paths, or set `allowAllDirectories: true` explicitly:

```json
{
  "url": "wss://termag.example.com/api/ws/agent",
  "agentToken": "tmag_…",
  "agentRoots": { "projects": "~/Projects" },
  "allowDirectories": ["~/Projects", "~/Services"],
  "allowAllDirectories": false
}
```

Power modes are `off`, `terminals-awake` (`caffeinate -i`), `display-awake` (`caffeinate -d -i`), and `ac-awake` (`caffeinate -s`). The daemon only signals the child process it created.

## Footprint targets

- stripped release binary: at most 15 MiB (968 KiB measured on Apple Silicon)
- idle RSS: at most 20 MiB (7 MiB measured with a live HerdR session)
- idle CPU: below 0.5% (0.0% measured during the integration run)

CI builds and tests on macOS and Linux and enforces the binary-size ceiling.
