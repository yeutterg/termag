# Distribution

Terminalz ships two runtime artifacts from one repository and one `vX.Y.Z` tag.

| Artifact           | Primary channel             | Why                                                                                                                     |
| ------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Native agent + CLI | Homebrew tap                | The agent must run as the local user beside Herdr, tmux, git credentials, filesystem roots, and macOS power controls.   |
| Web control plane  | GHCR image + Docker Compose | The server has a small, reproducible deployment surface and only needs SQLite persistence plus HTTPS/WebSocket ingress. |

GitHub Releases also contain native macOS/Linux binaries, SHA-256 checksums, SPDX SBOMs, Sigstore
bundles, the Compose file, and the fallback installer. npm remains a developer dependency manager; no
end-user npm package is published. uv is intentionally not used because Terminalz has no Python
runtime.

## Release process

1. Set the same version in the root package, web package, and `apps/agent-rs/Cargo.toml`.
2. Merge a green CI build.
3. Create and push an annotated `vX.Y.Z` tag.
4. `.github/workflows/release.yml` builds four native targets, publishes the multi-architecture GHCR
   image, creates the GitHub Release, and updates `yeutterg/homebrew-tap` when
   `HOMEBREW_TAP_TOKEN` is configured.

Before the first release, create `yeutterg/homebrew-tap`, add a `Formula/` directory, and store a
fine-grained token with contents write access as `HOMEBREW_TAP_TOKEN` in the Terminalz repository.
GitHub's built-in token publishes GHCR and GitHub Release assets; no Docker Hub credentials are
needed.

## Local packaging checks

```bash
docker build -f apps/web/Dockerfile -t terminalz:test .
docker compose -f infra/docker-compose.yml config

cargo build --release --locked --manifest-path apps/agent-rs/Cargo.toml
apps/agent-rs/target/release/terminalz --version
```

The release Homebrew formula installs prebuilt native archives. `infra/homebrew/terminalz.rb` remains
a source-building HEAD formula for development before the first tagged release.
