# Agent Bootstrap

This file is the repo entrypoint for local coding agents.

## Canonical Policy Source

Use `.ai-local/` as the canonical source for repo-specific agent policy.

## High-Value Repo Rules

- This is a Windows workspace; prefer PowerShell syntax when suggesting commands.
- The workspace uses Nx and `npm`.
- In PowerShell, prefer `npx.cmd nx ...` or `.\node_modules\.bin\nx.cmd ...` over plain `npx nx ...` or `nx ...`.
- Prefer minimal, targeted edits that preserve existing style and public APIs unless the task requires change.
- Use single quotes for strings unless a template literal is needed.
- Prefer `+=` and `-=` over postfix increment and decrement operators.
- Document intentionally empty functions with a brief inline comment.
- The canonical unit test location is `<projectRoot>/src/unit-tests/`.

## Additional Guidance

- Prefer existing canonical docs under `.docs/` when deeper procedural detail is needed.
- Use current workspace reality over stale generated instructions.
