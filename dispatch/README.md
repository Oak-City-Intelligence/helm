# helm/dispatch — the execution engine

This is where a queue becomes running workers. See DOCTRINE §12b (the dispatcher) and §8 (roles).

## What's here
- **`helm-dispatch.js`** — the burst-mode dispatcher. One isolated fleet worker per item, in parallel;
  each runs the fixed harness (`../templates/worker-prompt.md`), blocks rather than guesses, isolates in a
  worktree of the **target** repo off `origin/<base>`, verifies, commits (no AI attribution), pushes, and
  opens a PR. Returns structured results only; the orchestrator writes the LEDGER.
- **`helm-dispatch-gauntlet.js`** — attended dispatcher for high-stakes items: build → two adversarial
  reviewers (scope-fidelity + security) → ≤1 fix round → PR only when both clean. NOT for the drain loop.
- **`helm-intake.js`** — observations → adversarially-checked draft specs (investigate → skeptic → forge).
- **`helm-audit.js`** — the read-only AUDIT dispatcher. An audit lane produces findings, not code: no branch,
  no push, no PR. Per lane, a multi-lens auditor reads a PINNED tree and returns candidates only; then an
  independent skeptic whose explicit job is to REFUTE writes the lane report. In the run that made this the
  house standard, the skeptic killed nine of nine candidates.

**Checks — read-only, no model in the loop, cheap enough to run every seat:**
- **`ci-audit.js`** — validates each `config.yml` `baseline_check` against the repo's real CI workflow YAMLs.
- **`board-audit.js`** — the anti-board-rot check (DOCTRINE §18). Asks GitHub about every `done → PR #N`
  claim, the ledger about every `ready` row and every live `BLOCKED.md` entry, `origin/<base>` about every
  `path:line` a board cites, and the deployed health endpoint about the version the board claims is in prod.
  Prints the divergence, exits 1, **never edits a board**. Run at seat start and before every handover.
- **`scope-preflight.js`** — checks every ready plan's `scope_dirs` against the target repo's `origin/<base>`
  BEFORE dispatch: paths that don't exist, and scoped targets that are gitignored (a worker can write those,
  every gate passes, and the file never reaches the branch).
- **`ledgertool.js`** — `lint` (5-field schema, status enum, ISO timestamps, monotonic), `state` (each item's
  true current status), `drift` (queue rows the ledger says already shipped). The ledger is the source of
  truth; every other view is derived.

**Writers and sweepers:**
- **`board-stamp.js`** — the writing half of `board-audit`, deliberately separate. Transcribes
  GitHub-confirmed merges onto QUEUE rows and LEDGER transitions and nothing else; refuses any PR whose
  branch or title doesn't name the item (printed as SKIPPED-AMBIGUOUS for a captain to adjudicate). Dry run
  by default; `--apply` writes.
- **`ledger-normalize.js` / `ledger-refield.js`** — one-shot repairs for historical ledgers: freeform
  statuses mapped to the enum and malformed rows repaired to 5 fields, **without losing a word** (the
  original text is prepended to the note). Dry run by default.
- **`reap-worktrees.sh`** — the worktree sweep. Dispatch creates one worktree per item and nothing ever
  removed them; ours reached 139 trees / 21G on one project. Reaps only what is provably recoverable: branch
  merged into `origin/<base>`, no modified tracked files, no untracked files beyond what `worktree_provision`
  creates. Branches are kept.
- **`identity-guard.sh`** — cross-realm identity leak check for identity-isolated projects. Run by the worker
  after it commits and before it pushes; a hit is a hard block, because a leaked identity is not retractable.
- **`night-run.sh`** — the drain-only nightly entry point (see `RUNMODE.md`): kill-switch file, reap, skip if
  the queue is empty, one bounded headless run, log, exit.
- **`usage-today.js`** — sums token usage across every local agent session for a day or a rolling window, so
  a budget breaker can govern combined work rather than one daemon's own runs.

The dispatchers, intake, and audit engines are not plain Node — they need a workflow-script host. See
[`RUNTIME.md`](RUNTIME.md) for the runtime contract (injected globals, the `run` surface, model tiers, and
what a host must provide). Everything under "Checks", "Writers and sweepers", and `ci-audit.js` runs under
bare `node` or `bash`.

## How to run a burst
Invoke your agent runtime's workflow/script surface with this script and a list of ready items:

```
run({
  scriptPath: "<abs path>/dispatch/helm-dispatch.js",
  args: { items: [
    { id, project, github: "owner/repo", base, branch, plan: "<abs path>", config: "<abs path>", model }
  ]}
})
```

`items` come from a project's `QUEUE.md` (only rows that are `ready` and pass the clarity gate). Each row's
`plan`/`config` are absolute paths; `model` follows DOCTRINE §11 task-weighting. The harness path the workers
read is derived from each item's `config` path, so no absolute machine path is baked into the script.

## Run-mode status (DOCTRINE §12b)
| Mode | Trigger | State |
|------|---------|-------|
| **Burst** (attended) | operator-initiated | **BUILT** — this script |
| Semi-attended | `/loop` dispatcher on an interval | doc-only |
| Overnight | `systemd` user timer | BUILT (see RUNMODE.md), unexercised |

All reuse the same worker harness — only the trigger differs. Build the unattended tiers only after burst
mode has earned trust over several clean cycles.

## Gotchas the hard way
- **`args` may arrive JSON-encoded.** Parse defensively: `typeof args === 'string' ? JSON.parse(args) : args`.
  A `[]` / 0-agent / ~10ms result means the run **no-opped on empty input** — never read it as success.
- **Branch off `origin/<base>`, not local.** The operator's long-lived checkout can be stale or
  `skip-worktree`-polluted; the remote base is what CI sees. (Harness rule 3.)
- **Author against git-tracked reality.** Git-ignored / de-tracked files don't exist in a worker's worktree;
  a spec that targets them will (correctly) block. Check `git ls-files` when authoring.

## What the first wave taught
Four items dispatched, **all four blocked — correctly**, zero bad commits. Three blocks were authoring
errors (disk-not-git targets ×2, a dossier conflation ×1); one was the stale-local-base bug. The workers
were trustworthy; the authoring was the weak link. Every block routed back through the **back door**
(DOCTRINE §13) into a plan amendment, a drop, or a harness/doctrine fix. That loop — cheap block → cheap
fix → re-dispatch — is what makes aggressive dispatch safe.
