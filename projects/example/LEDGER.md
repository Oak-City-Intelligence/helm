# example — LEDGER (append-only observability spine)

> **Fictional sample.** One line per state transition. Format:
> ```
> <ISO-8601-ts> | <item-id> | <status> | <note> | <pr-url-or-branch-or->
> ```
> Statuses: `queued | dispatched | done | merged | blocked | failed | intake | scout | groom | local-ops | note`.
> Timestamp is orchestrator-supplied. This sample shows a full item lifecycle end to end.

2025-01-06T09:00:00Z | example-000 | queued | recover note autosave util from main (pre-rewrite) | -
2025-01-06T09:12:00Z | example-000 | dispatched | fleet worker, worktree off origin/main | example-000-autosave
2025-01-06T09:31:00Z | example-000 | done | recovered util + unit test; verify green | https://github.com/example-org/pagelet/pull/41
2025-01-06T14:05:00Z | example-000 | merged | operator merged after review | https://github.com/example-org/pagelet/pull/41
2025-01-07T08:40:00Z | example-001 | groom | word-count item scoped to src/editor/, verify = vitest unit | -
2025-01-07T08:41:00Z | example-001 | queued | authored to plans/example-001.md; clarity gate passed | -
