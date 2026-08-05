# ADR 0001: Typed device operations only

## Status

Accepted

## Context

Termag's former Node agent accepted an `execute-command` message and ran a shell string. Several
command-palette helpers built those strings with interpolated branch names, paths, and commit
messages. An authenticated broker or compromised browser could therefore turn a convenience API
into arbitrary code execution on the connected machine.

The Rust agent already uses a narrower protocol for runtime and power mutations. Git support needs
the same safety boundary without making routine repository work unavailable from the cloud UI.

## Decision

The device protocol will not expose an arbitrary command or shell-string operation. Features that
need local execution must use a named, allowlisted request with a validated payload.

Git initially supports exactly `git.status`, `git.branch`, `git.commit`, `git.push`, `git.pull`, and
`git.stage`. The authenticated web route derives the device and project path from the database. The
broker checks the operation allowlist. The Rust agent resolves the path through its directory policy,
validates operation-specific arguments, and invokes `git` directly with an argument vector.

## Rationale

Typed operations keep the remote control surface reviewable and testable. Passing arguments without
a shell prevents command interpolation, while server-derived paths and agent-side directory checks
preserve the local allowlist as the final authority. A 30-second timeout and bounded output also keep
one git process from consuming the lightweight agent indefinitely.

## Future Considerations

Additional operations require an explicit protocol addition, validation on both web and agent sides,
tests, and a review of whether they mutate external state. Interactive authentication remains a
terminal workflow; the git subprocess sets `GIT_TERMINAL_PROMPT=0` so a background RPC cannot hang on
a credential prompt.

## Implementation

- `POST /api/git` validates requests and resolves the owned project.
- `server/broker-rpc.js` allowlists the six operation names.
- `apps/agent-rs/src/git.rs` validates arguments and invokes `git` without a shell.
- The live command palette exposes only those operations when the connected agent advertises the
  `gitOperations` capability.

## Consequences

The remote API cannot run custom commands. New conveniences require a small amount of explicit code,
but each has bounded authority. Git push and pull are non-interactive; users perform credential setup
or conflict resolution in the visible terminal.

## References

- [Command palette](../COMMAND_PALETTE.md)
