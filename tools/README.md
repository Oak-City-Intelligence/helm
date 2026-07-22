# helm/tools — efficiency integrations

Helm-level, not codebase-level. These shape how the fleet + orchestrator *operate*, not what ships. Both are
optional and reversible; helm works without them.

## Terse output (fewer output tokens)
An agent-CLI plugin that drops filler while keeping code/commands/errors byte-for-byte. Reduces output-token
spend on every worker turn. Configure it at the CLI level (global to your agent runtime, not just helm).

## contextmink — bounded search (evidence, not flooded context)
A small CLI that caps grep/ls/read output and ends every run with a JSON receipt (truncation status, scan
scope) — cheaper, verifiable searches for the fleet.
- Common: `contextmink grep <re> <path>` · `files` · `dirs` · `slice <file> <start> <n>` · `outline <file>`.
- Config: `contextmink --config tools/contextmink.toml …` (repo excludes preset — see `contextmink.toml`).
- It can also ship a `hook-guard` (a pre-edit destructive-command block) — optional, wire it in if your
  runtime supports pre-tool hooks.

The worker harness (`../templates/worker-prompt.md`) *prefers* bounded search when available and falls back to
`grep`/`ls` otherwise, so these tools are a nice-to-have, not a dependency. Terseness as the default is a
deliberate choice: the structured return is data, not prose.
