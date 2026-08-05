# Command palette

Replaces `COMMAND_PALETTE_IMPLEMENTATION.md`, `COMMAND_PALETTE_INTEGRATION.md`,
`COMMAND_PALETTE_COMPLETE_INTEGRATION.md` and `COMMAND_PALETTE_FULL_WIRING.md`,
which were four successive accounts of the same work and disagreed with each
other about what was finished.

## Status

**The execution layer does not work against the protocol-v2 agent.** Git,
search and file operations all route through `execute-command`, a request the
v2 Rust agent rejects by design:

```
"execute-command" => bail!("execute-command was removed in protocol v2; use a typed operation")
```

Only the protocol-v1 Node agent (`apps/agent`) still implements it, and that
package is retained for one transition release. Anything below that depends on
`executeCommand` is therefore v1-only.

Several modules in this feature also do not typecheck against the current
Prisma schema — `lib/git-operations.ts` and `lib/session-integration.ts`
account for the largest share of the repository's outstanding `tsc` errors,
mostly references to a `Session.isActive` field that no longer exists. See
`docs/adr` and the branch TODOs before extending this area.

## Layers

```
Command palette UI
  → lib/command-execution.ts        one entry point, executeCommand()
    → lib/broker.ts                 typed wrapper over the global broker
      → server/broker.js            sendToAgent(..., "execute-command", ...)
        → agent                     v1 only
```

Feature modules sit beside the execution layer and compose it:

| Module | Responsibility |
| --- | --- |
| `lib/session-manager.ts` | session lifecycle helpers |
| `lib/clipboard-history.ts` | recent clipboard entries |
| `lib/git-operations.ts` | status, branch, stage, commit, push/pull |
| `lib/search-operations.ts` | file and content search |
| `lib/window-management.ts` | tab and pane arrangement |
| `lib/advanced-features.ts` | snippets, bookmarks, templates |

## Porting to protocol v2

Protocol v2 deliberately has no arbitrary command channel: an authenticated
cloud request should not be able to run a shell string on the machine. Each
operation the palette needs must become a typed request the agent implements
explicitly, the way runtime mutations already work:

- The agent already exposes `runtime.*` operations validated against an
  allowlist in `server/broker.js` (`mutateRuntime`) and matched in
  `apps/agent-rs/src/main.rs` (`handle_runtime_request`).
- A git operation should follow the same shape — `git.status`, `git.commit` —
  with arguments parsed and validated agent-side, never interpolated into a
  shell.
- Anything that genuinely needs a shell should be typed into the terminal the
  user is already looking at, not executed out of band.

Until that work is done, treat the palette's git and search entries as
v1-only.
