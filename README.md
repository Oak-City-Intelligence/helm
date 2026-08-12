# helm

The captain's chair — command doctrine + machinery for steering a fleet of autonomous coding agents.

helm is how one operator commands a fleet of autonomous coding agents across several projects without
babysitting each one — by relocating attention from *supervising execution* to *authoring tightly-scoped
specs* (the front door) and *reviewing PRs* (the back door).

## Status

**Actively used, pre-1.0. The harness is still evolving — APIs, file layout, and doctrine are still
moving.** This is a working methodology and a small execution engine, published as an honest breadcrumb for
others building agent fleets, not as a finished product. Expect sharp edges; expect things to change. See
`ROADMAP.md` for what's proven vs. built-but-unexercised vs. missing, and `ARCHITECTURE.md §C` for the
component inventory with per-piece status.

### From the log

Running total across the fleet's two busiest lanes, since the first dispatch: **309 items merged** (12 of
them since deployed), 21 done and awaiting merge, and **97 worker blocks**. Six lighter lanes run alongside
them. That block rate — roughly one dispatch in four stopping to ask instead of guessing — is not a defect
count. It is the system working: DOCTRINE §2 says a worker that hits an undetermined decision stops, and the
cost of a block is seconds while the cost of a confident guess is a bad merge. Zero bad merges across one
34-PR batch is the number that pairs with it.

What the last stretch actually taught, and what changed because of it:

- **Execution got mechanically solid faster than authoring did.** Verify, gate, isolate, block — that side
  holds. The recurring error rate lives in **grooming**: nearly every block in one wave was a captain-side
  spec miss that a worker caught. `IMPROVEMENTS.md` is the open backlog for that, published unflatteringly.
- **The board rots, quietly.** Status claims on the board decay with nothing to catch them: one item sat
  `ready` in three consecutive handovers *after it had merged*, because its ledger row was malformed and no
  tool could see it. That produced DOCTRINE §18 and `dispatch/board-audit.js` — the board is now checked,
  not trusted, at every seat start and every handover.
- **An audit is a snapshot; a guard is the invariant.** DOCTRINE §17: an item that fixes what an audit found
  also ships the check that keeps it fixed. The tedious pass/fail walk is the fleet's job precisely because
  no human will re-run it after every change.
- **A green board is not a winning campaign.** Queue status says nothing about whether the *right* work is
  moving. DOCTRINE §19 gives a multi-wave campaign a living document that outlives the seat that wrote it.
- **Nothing swept up after itself.** Dispatch creates a worktree per item and removed none — 139 trees and
  21G on one project before anyone looked. Hence `dispatch/reap-worktrees.sh`, and a general suspicion of
  anything the loop creates but never collects.

The update log lives in this repo's commit history rather than a separate changelog; each published update
carries what changed and what earned it.

## Read these first
- `DOCTRINE.md` — the operating principles (why the system is shaped the way it is). **Start here.**
- `ARCHITECTURE.md` — the target machine + full component inventory (proven / built / partial / missing).
- `DECISIONS.md` — the design decisions and earned lessons behind the doctrine.
- `ROADMAP.md` — the ranked backlog that closes the architecture's gaps.

## Layout
```
helm/
  DOCTRINE.md            principles
  ARCHITECTURE.md        target machine + component inventory
  DECISIONS.md           design decisions + earned lessons
  ROADMAP.md             gap-closing backlog
  STARTUP.md             manual-start procedure for the services
  DEPLOYMENT.md          where helm ends and the operator's deploy begins
  dispatch/
    helm-dispatch.js     the burst-mode execution engine
    helm-dispatch-gauntlet.js  attended dispatcher w/ a two-reviewer gauntlet for high-stakes items
    helm-intake.js       observations → adversarially-checked draft specs
    helm-audit.js        read-only audit lanes: multi-lens auditor + independent skeptic who refutes
    ci-audit.js          validates each baseline_check against the repo's real CI
    board-audit.js       the anti-board-rot check (§18) — read-only, no model, never edits a board
    board-stamp.js       its writing half: transcribes GitHub-confirmed merges onto the board, nothing else
    scope-preflight.js   checks every ready plan's scope_dirs against origin/<base> BEFORE dispatch
    ledgertool.js        ledger lint / true-state / queue-drift — the ledger is the source of truth
    ledger-normalize.js  one-shot repairs for historical ledgers (lossless: originals kept in the note)
    reap-worktrees.sh    sweeps worktrees that are provably recoverable; keeps branches
    identity-guard.sh    blocks a cross-realm identity leak before the push, not after
    night-run.sh         the drain-only nightly entry point (kill switch, reap, skip-if-empty, bounded)
    night-prompt.md      the hard rules the unattended run operates under — drain only, never merge
    usage-today.js       token usage across every local agent session, for a budget breaker
    README.md            how to run a wave + run-mode status
    RUNMODE.md           the three run modes (burst / nightly / loop) + the drain-only invariant
    RUNTIME.md           the runtime contract the engines assume (injected globals, run surface, model tiers)
    KNOWN-ISSUES.md      live traps + their resolutions
  templates/
    item.md              the spec template every queue item is modeled on (+ authoring guards)
    worker-prompt.md     the fixed instructions a worker runs (never-guess protocol, no AI attribution)
  console/               a zero-dependency live dashboard over the control-plane docs
  tools/                 efficiency integrations (bounded search, terse output)
  projects/
    <name>/
      config.yml         where the repo is, done_via, identity, carve-outs
      DOSSIER.md         strategic state-of-the-project (mission, roadmap, threads, decisions)
      BACKLOG.md         raw ungroomed inventory (every TODO/thread, triaged)
      QUEUE.md           hand-authored, pre-approved, ordered work items (the sacred list)
      LEDGER.md          append-only heartbeat — the observability spine
      BLOCKED.md         items a worker stopped on, awaiting your decision
      REVIEW.md          provisional decisions shipped as-proposed, awaiting confirm
      plans/             per-item detailed specs (referenced from QUEUE)
```

`projects/example/` is a fictional sample project included so the layout and queue lifecycle read end-to-end.

The **product repos never hold helm state** — only the code changes helm produces (branches/PRs).
All queues, ledgers, and configs live here in the control-plane repo, versioned in one place.

## Three schedulers, one queue
The same `QUEUE.md` is drained by whichever scheduler fits the moment (see `DOCTRINE.md` §9, §12b):
- **Attended burst** — the dispatcher; N items in parallel, live progress tree.
- **Semi-attended** — a thin `/loop` dispatcher; 1 item/wake; writes LEDGER + a push notification.
- **Overnight** — a burner on a **systemd user timer**.

## Quickstart
1. Read `DOCTRINE.md`, then `dispatch/RUNMODE.md`.
2. Look at `projects/example/` — its `config.yml`, `QUEUE.md`, `LEDGER.md`, and `projects/example/plans/example-001.md`
   show a full item lifecycle.
3. Copy `templates/item.md` into `projects/<your-project>/plans/<id>.md` and author an item, honoring the
   authoring guards at the top of that template.
4. Point a project `config.yml` at your repo (model it on `projects/example/config.yml`).
5. Run the live dashboard: `node console/server.js` (see `console/README.md`), then open the printed URL.
6. Dispatch a burst: see `dispatch/README.md`.

> Note on the name: "helm" collides with the Kubernetes package manager in search. This project is
> unrelated; it's an agent-fleet command harness.
