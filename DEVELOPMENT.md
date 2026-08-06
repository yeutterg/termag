# Development

## Web

```bash
npm ci
cp .env.example apps/web/.env.local
npm run db:migrate
npm run dev
```

Use the custom development server; it owns both Next.js and the agent/browser WebSocket upgrades.
Create a machine token in the UI and run the Rust agent in another shell.

Next's development compiler is intentionally memory-capped, but it is still a compiler and should not
be used as the always-on server. For the lightweight local runtime, build once and run production mode:

```bash
npm run build
npm start
```

The production script defaults to a 192 MiB V8 old-space ceiling and a small young generation. An
explicit `NODE_OPTIONS` value overrides those defaults. Development keeps its incremental `.next`
cache between runs; delete `apps/web/.next` manually only when diagnosing a stale build artifact.
For the absolute lowest live footprint, a service manager should execute the server directly instead
of retaining npm as a parent process:

```bash
NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
  node --max-old-space-size=192 --max-semi-space-size=2 apps/web/server.js
```

## Rust agent

```bash
TERMINALZ_URL=ws://localhost:3000/api/ws/agent \
TERMINALZ_AGENT_TOKEN=tmag_... \
TERMINALZ_AGENT_ROOTS='{"local":"~/Projects"}' \
cargo run --manifest-path apps/agent-rs/Cargo.toml
```

Herdr is optional and must remain independent. tmux is optional when Herdr exists. Existing runtime
state is discovered; new cloud terminals are restricted to the roots/allowlist resolved by the agent.

## Before committing

```bash
npm run typecheck
npm run lint
npx jest --runInBand
npm run build

cd apps/agent-rs
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --release --locked
```

Avoid adding a package for behavior supported by the platform or a small local helper. The supported
architecture has no Node agent, menu-bar UI, SSH transport, database terminal history, generic command
executor, or third-party observability stack.
