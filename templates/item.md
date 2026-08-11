# Item spec template

Copy this into `projects/<name>/plans/<id>.md` and fill EVERY field. The clarity gate rejects an item
that leaves any required field vague. Hand-authored only — no field is "figure it out."

> **Authoring guards (each one earned by a real block — check these BEFORE queuing):**
> 1. **Verify every path is git-TRACKED, not just present on disk.** Use `git ls-files <path>` / `git
>    check-ignore <path>` — not `[ -e ]` / `ls`. A worker isolates in a fresh worktree, where git-ignored or
>    de-tracked files don't exist. Items authored against disk-only files block every time.
> 2. **A dossier/synthesis claim is a LEAD to verify, not a fact to author from.** Synthesizers conflate
>    things — a spec doc mistaken for a different one. Open the actual file/code and confirm the premise
>    before writing it into a step. **Verify EVERY claim a step depends on — including tooling and data
>    sources, not just the API surface.** (One pair of items verified the API signatures but not that the app
>    had the client library, nor that a config table held the assumed entries — both false, both blocked.)
> 3. **Base off `origin/<base>`, and confirm the baseline is green THERE.** The operator's local base branch
>    can be stale or `skip-worktree`-polluted; a worker once built off a frozen local `main`.
> 4. **A `verify` must be able to pass — and be consistent with the plan's own exceptions.** If a step says
>    "leave X", the verify must not then assert X is gone. Scope every grep/assertion to `scope_dirs` (not a
>    whole tree) so a pre-existing, out-of-scope hit can't false-fail the item.
> 5. **A new capability needs its stores IN THE DEPS RING — and scope must name the ACTUAL construction
>    site.** Before queuing an item that adds a method/dep, `git grep "new <TheClass>("` and scope THAT
>    file for exactly those dep lines — do not assume the entry file. In one codebase some services are
>    constructed in `src/index.ts` and others in a container module; an item that guessed the entry file
>    blocked for that reason alone. Earned four times in one day, then again a week later.
> 6. **A new test only counts if the gate actually RUNS it.** Check how the project's test script selects
>    files — a "hermetic" test script is often an EXPLICIT file list, not a glob. If the item adds a test
>    outside a globbed dir, the plan MUST scope `package.json` (bounded: "ONLY the test list line") or name
>    an already-globbed home — else the worker blocks on it every time. (Earned 3× in one day.)
> 7. **READ every test file a `verify` names before queuing.** A verify that runs an existing test you
>    haven't read can be asserting the exact behavior your item removes. One item to delete a fabricated
>    response named a suite that carried a regression test FOR the fabrication — instant block.
> 8. **Verify the DATA that drives the code path, not just the path.** Reading the function is half the
>    premise; the config/catalog/registry that decides whether it is ever reached is the other half. One plan
>    asserted that an exhausted slot hit the runner's degrade arm — true of the code, false in fact, because
>    the catalog declared that slot optional rather than required. The real failure was quieter and worse: a
>    silent complete-and-confirm on unverified input. This is guard 2 applied to declarative data — grep the
>    catalog/spec table for the slot, route, flag or key your premise names.
> 9. **The captain assigns migration numbers at authoring time.** Workers on parallel branches can't see
>    each other's new files — two items both minted `070_` in one day (caught post-hoc, renumbered). Check
>    the migrations dir AND in-flight branches.
> 10. **A verify grep must match the VALUE shape, not the word.** `grep "token"` on logger lines
>     false-positives on benign message text ("token exchange failed"), and an item blocked on exactly that.
>     Gate on interpolated secrets or, better, a log-capture test assertion.
> 11. **An item adding a plugin/tool/handler must scope the REGISTRATION site, not just the module.** A
>     capability wired only into its schema — never into the registry the runtime reads — builds green, tests
>     green, and throws "not found" the first time it is called. The passes-verify-fails-in-reality class.
> 12. **After a plan amendment, re-read the WHOLE plan for contradictions.** Cutting a site from scope while
>     its requirement and a "do not shrink" clause survive in prose = guaranteed block. Self-inflicted
>     round-trip, and the cheapest one to prevent.
> 13. **A NEW source file needs its BUILD REGISTRATION scoped too.** If the repo's build uses an explicit
>     file list (a `tsconfig` naming every route file, no glob), a new file out-of-scope-blocks on TS6307.
>     Check how siblings are wired into the build before fixing `scope_dirs`.
> 14. **Dry-run every verify command's FORM on the host before dispatch.** A syntactically-plausible command
>     can be environment-false: `node --test <dir>/` MODULE_NOT_FOUNDs on newer Node (the dir arg resolves as
>     a CJS main, not test discovery), and an item blocked on the verify line itself with the deliverable 100%
>     green. Cheap check: run the command shape against a trivial fixture.
> 15. **Enumerate every EXISTING test your change falsifies — and scope it.** Guard 6 covers a NEW test
>     needing a home and guard 7 covers reading a test your `verify` names; neither catches the common
>     case: an existing test, in a suite your `verify` runs, that asserts the exact behavior you are
>     changing. It is not in `scope_dirs`, so the worker cannot touch it; it is in the gate, so the item
>     cannot go green. Guaranteed block. **The sweep:** for every symbol, field name, error string, or
>     rendered output your item changes, grep the test tree for it and scope what you find — the search is
>     on the OLD name, which is exactly what a search-for-the-new-thing misses. Earned twice in one hour on
>     a single item: first three UI test files (one driving fields the change removes, one asserting a
>     validator error it deletes, one keying an exemption map on the renamed fields), then three more tests
>     the same item made structurally impossible. **Corollary: never write "mechanical" about a test file
>     you have not opened.** That word was doing the work of a premise check, and the file behind it needed
>     two design rulings.
> 16. **A `verify` must run the project's FULL CI gate set, never a subset.** Mirror `config.baseline_check`
>     (which mirrors the repo's real CI). Do NOT drop a whole gate because one sub-check has pre-existing
>     noise — if the linter is noisy, scope around *that check*, but keep `format:check`, `typecheck`,
>     `build`, `test`. One pair of items omitted the formatter check from `verify`; CI's formatting gate then
>     red-lit main post-merge. A gate you skip in verify is a gate CI enforces behind your back.

```yaml
id: <name>-NNN            # e.g. example-001
title: <one concrete line — a verb and an object>
status: ready            # ready | claimed | in-progress | done | blocked
scope_dirs:              # ALLOWLIST — the worker may touch ONLY these paths
  # LOOK EVERY PATH UP. NEVER INFER ONE FROM THE SOURCE LAYOUT. (Three items once blocked back-to-back on
  # scope_dirs naming test dirs that do not exist — scope was authored from a src/ sweep with the test
  # locations guessed. A test tree rarely mirrors src/: sibling modules in one src/ dir routinely have
  # their suites in three unrelated test dirs, and some have none at all.)
  #   git ls-tree -r --name-only origin/<base> | grep -i <subject>      # for EVERY file, tests included
  # Then confirm the item's `verify` actually RUNS the tests you scoped: if the repo enumerates test files
  # individually, a test you add or change may execute in NO suite the verify runs — scope package.json and
  # enrol it, or the change ships ungated.
  # A guard whose test runs nowhere is not a guard.
  - path/one
  - path/two
blocked_by: []           # ids that must be done first (leave [] if none)
base_branch: <branch>    # what to branch from (per project config default if omitted)
branch: <name>-NNN-slug  # the work branch name
model: sonnet            # top-tier | mid-tier — weight to task complexity (DOCTRINE §11). The lightest tier is FORBIDDEN for work items (investigation spikes only). Omit → project default.
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
`main:src/editor/WordCountBadge.tsx`".>

## Out of scope / do NOT touch
<Anything adjacent the worker might be tempted to change. Reinforces `deny_dirs`.>

## Done means
<The human-readable definition of done, consistent with `verify` and the project's `done_via`.>
```
