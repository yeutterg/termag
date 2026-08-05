# Command palette

The dashboard palette is lazy-loaded and provides session navigation, common Termag actions, and six
typed git operations for the active project.

## Git operations

The live palette exposes status, stage, switch branch, commit, pull, and push only when the selected
device is online and advertises the `gitOperations` protocol capability. Results appear in a bounded,
scrollable dialog. Pull is fast-forward-only, and all operations are non-interactive.

The execution path is:

```text
Command palette
  → POST /api/git
    → authenticated Project lookup (device + working directory)
      → broker git-operation allowlist
        → Rust agent directory policy + argument validation
          → git process (no shell, bounded output, 30-second timeout)
```

There is deliberately no `execute-command` fallback. If an action needs an interactive shell, it
belongs in the terminal the user is already viewing. See
[ADR 0001](adr/0001-typed-device-operations.md).

## Maintenance

`components/command-palette.tsx` contains the one live command mapping. The old generic command set,
snippet/template placeholders, and protocol-v1 execution helpers were removed; adding an inert menu
entry is not considered implementation.
