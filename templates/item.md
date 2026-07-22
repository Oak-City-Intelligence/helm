# Item spec template

Copy this into `projects/<name>/plans/<id>.md` and fill EVERY field. The clarity gate rejects an item
that leaves any required field vague. Hand-authored only — no field is "figure it out."

> **Authoring guards (earned from real dispatch waves — check these BEFORE queuing):**
> 1. **Verify every path is git-TRACKED, not just present on disk.** Use `git ls-files <path>` / `git
>    check-ignore <path>` — not `[ -e ]` / `ls`. A worker isolates in a fresh worktree, where git-ignored or
>    de-tracked files don't exist. (Items authored against disk-only files block every time.)
> 2. **A dossier/synthesis claim is a LEAD to verify, not a fact to author from.** Synthesizers conflate
>    things (a spec doc mistaken for a different one). Open the actual file/code and confirm the premise
>    before writing it into a step. **Verify EVERY claim a step depends on — including tooling and data
>    sources, not just the API surface.** (Items verified the contract sigs but not that the app had the web3
>    lib, or that a config table held the assumed values — both false, both blocked.)
> 3. **Base off `origin/<base>`, and confirm the baseline is green THERE.** The operator's local base branch
>    can be stale or `skip-worktree`-polluted (a worker once built off a frozen local `main`).
> 4. **A `verify` must be able to pass — and be consistent with the plan's own exceptions.** If a step says
>    "leave X", the verify must not then assert X is gone. Scope every grep/assertion to `scope_dirs` (not a
>    whole tree) so a pre-existing, out-of-scope hit can't false-fail the item.
> 5. **A new capability needs its stores IN THE DEPS RING — and scope must name the ACTUAL construction
>    site.** Before queuing an item that adds a method/dep, `git grep "new <TheClass>("` and scope THAT
>    file for exactly those dep lines — do not assume `src/index.ts`. (Earned repeatedly: an item pointed at
>    the entry file while the real constructor lived in a container/factory module → blocked.)
> 6. **A new test only counts if the gate actually RUNS it.** Check how the project's test script selects
>    files (an explicit hand-listed file array is NOT a glob — only globbed dirs auto-include new files). If
>    the item adds a test outside a globbed dir, the plan MUST scope the test-manifest file (bounded: "ONLY
>    the test list line") or name an already-globbed home — else the worker blocks on it every time.
> 7. **A `verify` must run the project's FULL CI gate set, never a subset.** Mirror `config.baseline_check`
>    (which mirrors the repo's real CI). Do NOT drop a whole gate because one sub-check has pre-existing noise —
>    if one linter is noisy, scope around *that check*, but keep format/typecheck/build/test. (A gate you skip
>    in verify is a gate CI enforces behind your back — it red-lights the base post-merge.)

```yaml
id: <name>-NNN            # e.g. example-001
title: <one concrete line — a verb and an object>
status: ready            # ready | claimed | in-progress | done | blocked
scope_dirs:              # ALLOWLIST — the worker may touch ONLY these paths
  - path/one
  - path/two
blocked_by: []           # ids that must be done first (leave [] if none)
base_branch: <branch>    # what to branch from (per project config default if omitted)
branch: <name>-NNN-slug  # the work branch name
model: sonnet            # top-tier | mid-tier — weight to task complexity (DOCTRINE §11). The lightest tier is
                         # FORBIDDEN for work items (investigation spikes only). Omit → project default.
effort: medium           # low | medium | high — reasoning effort. Omit → project default.
verify: |                # REQUIRED — the runnable proof of success. Must exit non-zero on failure.
  <command(s) that mechanically prove the item is done>
```

## Goal
<2–4 sentences. What outcome, and why. Enough that a fresh-context worker with no prior conversation
understands the intent — not just the mechanics.>

## Steps
<Concrete, ordered, no hand-waves. "Handle errors appropriately" is a rejection — say HOW. If a step's
answer is knowable by reading the repo, say "find X in the repo" (discovery is allowed); if it needs a
decision, the decision must already be made here, or the item isn't ready.>

1. …
2. …

## Known-good reference (if any)
<For recoveries/ports: the exact source paths/commits the worker should read. E.g. "port from
`main:src/.../OldComponent.js`".>

## Out of scope / do NOT touch
<Anything adjacent the worker might be tempted to change. Reinforces `deny_dirs`.>

## Done means
<The human-readable definition of done, consistent with `verify` and the project's `done_via`.>
