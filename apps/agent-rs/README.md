# Termag Rust agent

This is the Protocol v2 replacement for the Node laptop agent. It is an outbound-only daemon and does not modify or embed HerdR.

There is no menu-bar process or desktop UI. Terminal helpers are spawned only while a cloud viewer is attached; idle inventory uses a single current-thread async runtime.

It mirrors every local tmux session and every running HerdR session. HerdR metadata comes from its documented local socket API; terminal viewing/control stays behind HerdR's public `herdr terminal session observe/control` process boundary. One helper is shared by all cloud viewers of a pane and exists only while that pane is open. Termag does not copy, patch, launch, or own HerdR. When HerdR is absent, tmux remains fully available.

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

Power modes are `off`, `terminals-awake` (`caffeinate -i`), `display-awake` (`caffeinate -d -i`), and `ac-awake` (`caffeinate -s`). Protocol-v2 clients use renewable machine-scoped leases, so one browser cannot cancel another browser's lease and abandoned leases expire. The daemon only signals the child process it created.

## Footprint targets

- stripped release binary: at most 15 MiB (1.0 MiB measured on Apple Silicon)
- idle RSS: at most 20 MiB (6.8 MiB measured while connected with a live HerdR session)
- idle CPU: below 0.5% when runtimes are quiet; active HerdR event mirroring scales with real state changes

CI builds and tests on macOS and Linux and enforces the binary-size ceiling.
