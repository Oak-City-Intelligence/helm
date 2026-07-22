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
- **`ci-audit.js`** — validates each `config.yml` `baseline_check` against the repo's real CI workflow YAMLs.

The dispatchers and intake engine are not plain Node — they need a workflow-script host. See
[`RUNTIME.md`](RUNTIME.md) for the runtime contract (injected globals, the `run` surface, model tiers, and
what a host must provide). `ci-audit.js` is the one script here that runs under bare `node`.

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
