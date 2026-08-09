# Contributing to Terminalz

Terminalz is intentionally small: a Next.js control plane and one native Rust agent. Changes should
preserve the low-memory, low-bandwidth, multi-machine design rather than adding parallel abstractions.

## Setup

```bash
git clone https://github.com/yeutterg/terminalz.git
cd terminalz
npm ci
cp .env.example apps/web/.env.local
npm run db:migrate
```

Rust 1.82 is pinned by `rust-toolchain.toml`. Herdr and tmux are optional for unit tests but useful for
end-to-end terminal testing.

## Before opening a pull request

```bash
npm run typecheck
npm run lint
npm run format:check
npm test -- --runInBand
npm run build

cd apps/agent-rs
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --release --locked
```

For packaging changes, also run:

```bash
docker build -f apps/web/Dockerfile -t terminalz:test .
docker compose --env-file infra/.env.example -f infra/docker-compose.yml config
```

## Design constraints

- One web account must support multiple concurrently connected, uniquely named machine agents.
- Herdr remains independent and authoritative. Use its public local interfaces; do not patch or embed
  it.
- Keep tmux usable when Herdr is absent.
- Do not add arbitrary shell-string execution. Runtime, git, filesystem, and power operations are
  typed and validated locally.
- Terminal bytes, checkpoints, and scrollback must remain bounded and out of SQLite/logs/telemetry.
- Keep hidden mobile viewers paused and reconnect checkpoints bounded.
- The agent must run as the local user and remain viable under the documented 20 MiB RSS target.

Use conventional commit subjects when practical (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
`chore:`). Include tests for behavior changes and update the relevant documentation/config example.

Report security issues privately to the repository owner rather than opening a public issue.
