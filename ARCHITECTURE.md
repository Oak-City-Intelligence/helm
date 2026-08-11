# helm — Architecture (target machine + full piece-list)

This is the master plan. `DOCTRINE.md` says *why*; this says *what the whole machine is* and *which parts
exist yet*. It exists so helm stops being invented as-we-go: every piece a mature version needs is named
here once, mapped to the framework that proves it's load-bearing, and marked **proven / built / partial /
MISSING**. The inventory (§C) is the heart — "all the pieces we need, not just the ones we thought of."

## A. Thesis

helm is a **pull-based, drain-only work system wrapped around a durable ledger and two disciplined gates**
(front door = authoring, back door = review). The Captain authors clarity-gated items; a thin orchestrator
(First Mate) fans out one isolated fleet worker per item; each worker runs off `origin/<base>`, verifies as a
delta against a green baseline, and terminates at a PR the Captain merges. A back-door reconciler watches PR
state and routes every piece of review signal back into the plans, the harness, or the backlog. Everything
proven today is the *attended burst* path. The whole unattended half — overnight drain, automated back-door
reconcile, and the meta-monitoring that would make hands-off safe — is built-but-unexercised or missing. This
doc closes that gap on paper before we close it in code.

## B. The target machine

**Components (the stable furniture):**
- **DOCTRINE.md / DECISIONS.md / ARCHITECTURE.md** — principles, design log, master plan. (control-plane docs)
- **Front door** — Captain sweeps `BACKLOG.md` → grooms → authors `plans/<id>.md` through the **clarity
  gate** → lists in `QUEUE.md` (+ `QUEUE.json` if drain-safe). Deliberately un-automated (§1).
- **Dispatcher** — `dispatch/helm-dispatch.js` (burst) / `helm-dispatch-gauntlet.js` (high-stakes review).
  Thin, context-free, spawns isolated workers, collects structured returns.
- **Fleet worker** — fresh context, own git worktree in the *target* repo, runs the harness
  (`templates/worker-prompt.md`), clarity-passes, executes in `scope_dirs`, verifies delta vs baseline,
  commits (no AI attribution), pushes, opens PR, returns a structured result — never prose.
- **Baseline gate (§10)** — `config.baseline_check` on the base commit before any dispatch; red → dispatch
  nothing; `baseline_fix` items are the escape hatch.
- **Back-door reconciler** — `review-watch.sh` + `.watch-prompt.md`: polls GitHub PR state, hash-skips when
  unchanged, and routes each delta (merged → ledger + `on-merge.json` auto-dispatch; closed → rejection
  intake; comment → the §13 triage).
- **Schedulers** — burst (attended, proven), nightly `systemd` timer (drain-only, built-untested),
  review-watch timer (built-untested), `/loop` (doc-only).
- **Ledger spine** — `projects/*/LEDGER.md`, append-only, one line per transition. The source of truth.
- **Kill switch** — `touch dispatch/STOP` makes every unattended run a no-op.

**The four control loops:**
1. **Author loop** (Captain, manual): backlog → groom → clarity-gate → queue. The identified system
   constraint (every block this era was an authoring error, not a fleet failure).
2. **Dispatch loop** (proven): ready items → parallel isolated workers → clarity-pass/block-not-guess →
   worktree off `origin/base` → verify delta → PR → structured return → orchestrator appends LEDGER.
3. **Review-reconcile loop** (back door §13, built-untested headless): observe PR state → diff vs
   `pr-state.json` → route delta → LEDGER intake + auto-dispatch dependents. This is helm's GitOps
   reconciliation half — and it has never run headless.
4. **Schedule loop**: which tier drains when, under the drain-only invariant and the one-scheduler lock.

**Data flow:** `BACKLOG.md` (options pool) → clarity gate → `plans/<id>.md` + `QUEUE.json` (desired state)
→ dispatcher → worker → PR (actual state) → `LEDGER.md` (event log) → review-watch diff → back to plans /
harness / backlog. `on-merge.json` is the edge that lets a merged blocker auto-dispatch its dependents with
no human. `config.yml` is the per-project contract every stage reads.

## C. Component inventory

Every piece a mature version needs, mapped to the framework that proves it load-bearing and its status.
**Status: proven** = has actually run repeatedly · **built** = code/units exist, never exercised ·
**partial** = doc-only or half-wired · **MISSING** = absent.

### Orchestration & durable execution
| Piece | Source | helm today | Status |
|---|---|---|---|
| Lead orchestrator / dispatcher | Orch-Worker | helm-dispatch.js | proven |
| Explicit plan artifact (task graph) | Orch-Worker | plans/`<id>`.md + QUEUE | proven |
| Worker pool, role specialization | Orch-Worker | fleet workers + gauntlet reviewers | proven |
| Structured task-handoff schema | Orch-Worker | WORKER_SCHEMA return | proven |
| Context isolation per worker | Orch-Worker | fresh ctx + worktree | proven |
| Result compression before return | Orch-Worker | structured return, no transcript | proven |
| Shared blackboard store | Orch-Worker | LEDGER + plans + files | proven |
| Fan-out / fan-in join coordinator | Durable-Exec | parallel() in dispatch | proven |
| Append-only event log per instance | Durable-Exec | LEDGER.md | proven |
| Task queue + worker pool | Durable-Exec | QUEUE.json | built (queue empty) |
| Durable scheduler (cron + timers) | Durable-Exec | systemd timers x2 | built |
| Human-in-loop approval gate | Durable-Exec | BLOCKED/REVIEW + operator merge | proven |
| Termination / stopping criteria | Orch-Worker | done_via + verify | proven |
| Escalation path | Orch-Worker | BLOCKED.md | proven |
| **Idempotency-key registry (side-effect dedupe)** | Durable-Exec | prose idempotency-guard only | **MISSING (code)** |
| **Bounded retry + backoff/jitter** | Durable-Exec | manual re-dispatch (an install hang burned an item) | **MISSING** |
| **Transient-vs-real failure classifier** | CI/CD (flaky) | none — a hang reads as a block | **MISSING** |
| **Dead-letter queue + replay tooling** | Durable-Exec | blocked items just sit | **MISSING** |
| **Per-item timeout + heartbeat** | Durable-Exec | night-run has one 2h wrapper timeout | partial |
| **Poison-pill / infinite-loop guard** | Durable-Exec | none | **MISSING** |
| Checkpoint / resume mid-item | Durable-Exec | crash = re-run whole item | partial |
| **Approval timeout + escalation** | Durable-Exec | BLOCKED items age silently | **MISSING** |
| Workflow/harness versioning | Durable-Exec | two inlined copies of worker rules (drift) | partial |
| Cost / token budget manager + kill | Orch-Worker | usage meter + review-watch breaker | built |
| Concurrency cap / rate limit per resource | Durable-Exec | runner-internal only; §9 lock doctrinal | partial |
| Circuit breaker per dependency (gh, npm) | Durable-Exec | gh-poll fail just skips a tick, no alert | **MISSING** |

### Reconciliation & control-loop (the GitOps half)
| Piece | Source | helm today | Status |
|---|---|---|---|
| Desired-state store | Reconcile/GitOps | QUEUE.json + plans | built |
| Observed-state collector | Reconcile | review-watch gh poll | built |
| Diff engine | Reconcile | review-watch vs pr-state.json | built |
| Actuator / executor | Reconcile | dispatcher | proven |
| Level-triggered reconcile | Reconcile | review-watch design | built |
| Convergence / change-detection | Reconcile | .pr-state.hash skip | built |
| Immutable audit log of actions | Reconcile/DORA | LEDGER.md | proven |
| Global kill switch | Reconcile | dispatch/STOP | built |
| Self-unblock edge (blocker→dependent) | Reconcile | on-merge.json | built (never fired) |
| **Loop heartbeat / dead-man's-switch** | Reconcile | none — silent death is invisible | **MISSING** |
| **Liveness + readiness probe on the loop** | Reconcile | none | **MISSING** |
| **Drift detection (declared vs actual)** | GitOps | queue views already drifted, undetected | **MISSING** |
| **Max-actions-per-interval limiter (actuator brake)** | Reconcile | review-watch only; dispatchers uncapped | partial |
| **Requeue with backoff + jitter** | Reconcile | none | **MISSING** |
| **Flapping detection** | Reconcile | none | **MISSING** |
| **Escalate-after-N-failed-attempts** | Reconcile | none | **MISSING** |
| Leader election / concurrency lock (impl) | Reconcile | §9 lock is prose, no flock | **MISSING** |
| Scoped kill switch (per project/action) | Reconcile | STOP is all-or-nothing | **MISSING** |
| Dry-run / plan-before-apply | Reconcile | baseline_check is pre-flight only | partial |
| Manual pause/override annotation | Reconcile | deny_dirs + STOP | partial |
| Postmortem → new gate/test feedback | Reconcile/DORA | back door §13 + DECISIONS | proven |

### Flow, WIP & metrics (Kanban / DORA)
| Piece | Source | helm today | Status |
|---|---|---|---|
| Backlog (options pool) | Kanban | BACKLOG.md | proven |
| Ready queue (committed, sized) | Kanban | QUEUE.md / QUEUE.json | proven |
| Definition of Ready | Kanban | clarity gate | proven |
| Definition of Done | Kanban/DORA | done_via + runnable verify | proven |
| Blocked-item flagging | Kanban | BLOCKED.md | proven |
| Explicit constraint identified | ToC | authoring named as the constraint | proven |
| Subordinate to the constraint | ToC | drain-only protects authoring capacity | partial |
| Class of service (drain-safe vs attended) | Kanban | implicit tier split | proven |
| Done drains to a real sink | Kanban | operator merge = real sink | proven |
| Traceability chain issue→PR→ledger | DORA | plan→branch→PR→ledger | proven |
| **Value-stream columns w/ enforced schema** | Kanban | LEDGER statuses now enum-enforced | proven |
| **WIP limits + enforcement policy** | Kanban | none | **MISSING** |
| **Blocked-item aging clock + escalation** | Kanban | none | **MISSING** |
| **Cycle time (dispatched→done)** | Kanban/DORA | ledger has ts; uncomputed | **MISSING** |
| **Lead time (queued→done)** | Kanban/DORA | uncomputed | **MISSING** |
| **Throughput (done/period)** | Kanban/DORA | countable, never counted | **MISSING** |
| **Block rate / rework (bounce-back)** | Kanban/DORA | uncomputed | **MISSING** |
| **Change-failure rate (consistent defn + tag)** | DORA | no failure tag on ledger lines | **MISSING** |
| **MTTR (block/baseline-red → resolved)** | DORA | uncomputed | **MISSING** |
| **Four-keys dashboard + review cadence** | DORA | console panel unbuilt | **MISSING** |
| Flow efficiency, CFD, aging chart | Kanban | none | **MISSING** |
| Single source for the 3 queue views | Kanban | ledgertool derives state; drift flagger built | proven |
| **Board-vs-reality reconcile (status rot)** | GitOps | `board-audit.js` at seat start + handover; `board-stamp.js` writes back GitHub-confirmed merges only | proven |
| **Pre-dispatch scope check** | Shift-left | `scope-preflight.js`: `scope_dirs` vs `origin/<base>`, gitignored-target trap, consumer enumeration on declared `impact_symbols` | proven |
| **Plan claim-linting (the other half)** | Shift-left | none — see `IMPROVEMENTS.md` #6 | **MISSING** |
| **Resource reclamation (worktrees)** | Ops hygiene | `reap-worktrees.sh`, merged+clean only, branches kept | proven |
| **Cross-realm identity leak guard** | Supply chain | `identity-guard.sh` pre-push; a hit is a hard block | proven |
| **Read-only audit lanes (findings, not code)** | Verification | `helm-audit.js`: multi-lens auditor + independent skeptic who refutes | proven |

\* Everything in the table above now ships in this repo. The remaining unbundled pieces are the
review-watch runner and the live runtime state files — see `dispatch/RUNMODE.md`.

### Verification, gates & safety
| Piece | Source | helm today | Status |
|---|---|---|---|
| Fast pre-merge gate (baseline + verify) | CI/CD | baseline_check + delta verify | proven |
| Independent verifier / adversarial critic | Orch-Worker | gauntlet 2 reviewers | built (1 run) |
| Evaluator-optimizer fix loop | Orch-Worker | gauntlet ≤1 fix round | built |
| Env parity via config-as-data | CI/CD | config.yml overlays | proven |
| Human merge/deploy approval gate | CI/CD/DORA | operator merge; helm ends at PR | proven |
| Short-lived branches, worktree isolation | CI/CD | worktree per item | proven |
| No-AI-attribution on commits/PRs | (helm) | harness §5 | proven |
| scope_dirs allowlist | Orch-Worker | per-item | proven |
| **deny_dirs denylist (belt)** | Orch-Worker | populated for self-host; product projects sparse | partial |
| **Code-enforced safety (not prompt-only)** | Orch-Worker | runs under skip-permissions; hook-guard unwired | **MISSING** |
| **Least-privilege / rotating credentials** | CI/CD | single gh token, expired twice | partial |
| Output-schema validation on handoff | Orch-Worker | fixed WORKER_SCHEMA, not asserted | partial |
| Sandboxed worker execution | Orch-Worker | worktree, not container | partial |
| Prompt/config versioning + eval harness | Orch-Worker | none; harness duplicated | **MISSING** |
| Backward-compatible / rollback-safe changes | CI/CD | operator territory (helm ends at PR) | non-goal |

### Observability & notification
| Piece | Source | helm today | Status |
|---|---|---|---|
| Append-only ledger (the spine) | all | LEDGER.md | proven |
| **Push on state-change (→phone)** | Reconcile | DOCTRINE §7 only, zero wiring | **MISSING** |
| **Metrics emission (counts, rates, cost, duration)** | Durable-Exec | usage meter only | partial |
| **Dashboard ledger-rendering panel** | (helm §7) | console renders docs; metrics fold unbuilt | partial |
| **Alerting on stuck/failed/backlogged** | Durable-Exec | none | **MISSING** |
| Per-worker structured trace + correlation ID | Orch-Worker | ledger line only, no trace file | partial |
| Deploy/PR markers into observability | DORA | none | **MISSING** |
| Runbook per alert | Reconcile | none | **MISSING** |

### Control-plane meta (helm hosting itself)
| Piece | Source | helm today | Status |
|---|---|---|---|
| **helm tree under version control** | CI/CD | local commit only, no remote | partial |
| **helm as a helm project (projects/helm/)** | (self-host) | stood up | proven |
| Chaos / game-day drill of the loop | Reconcile | none | **MISSING** |
| DEPLOYMENT.md verified vs real CI | DORA | per-project path marked (confirm) | partial |
| Local-ops mode (local artifact work, not a PR) | (helm) | concept only, 0 successes | partial |

## D. Metrics helm should track

All derivable from the ledger once its schema is enforced and timestamps are monotonic. Each line is
`<ISO-ts> | <id> | <status> | <note> | <ref>`; metrics are folds over it.

- **Cycle time** = `done.ts − dispatched.ts` per item. Fleet execution latency. (p50/p85 across items.)
- **Lead time** = `done.ts − queued.ts`. Includes time an item waits in QUEUE — the Captain-facing latency.
- **Throughput** = count of `done`/`merged` lines per day/session. The volume number.
- **Block rate** = `blocked` ÷ `dispatched`. Health of the front door — high = authoring is under-specifying.
  Split **failure-demand** (transient/env re-dispatch) from **real blocks** (needs a decision) so a flaky
  night doesn't masquerade as a design problem.
- **Change-failure rate** = (`closed-unmerged` + post-merge `intake`-fix) ÷ `merged`. Requires a consistent
  failure tag on the ledger line at review time — today uncomputable.
- **MTTR** = time from `blocked`/`baseline-red` to its resolving `done`/`green` line. Recovery latency.
- **Cost per item / per merged item** = tokens/$ per run — needs the budget manager to emit it per-item.

The blocker for *all* of these is the same two fixes: enforce the LEDGER status enum (done) + make timestamps
monotonic (orchestrator-supplied — done). Until the fold is built, every metric is hand-read prose.

## E. Invariants & non-goals

**Invariants (violating one is a bug or an explicit logged doctrine change):**
- **Drain-only unattended authority.** Every headless tier may ONLY dispatch pre-authored, clarity-gated
  `QUEUE.json` items + auto-dispatch `on-merge.json` dependents + reconcile PRs. Never author, groom, merge,
  deploy, or touch a primary checkout. (Today prompt-enforced only — see the code-enforcement gap.)
- **Human merge & deploy gates.** helm ends at a PR (`DEPLOYMENT.md`). Merge is always the Captain; a
  project's own live/testnet gate is a hard human gate. Never auto-merge (§6).
- **Block, don't guess.** A worker discovers repo-knowable facts and *stops* on any decision/preference/
  ambiguity. "A blocked item that cost 30s is a success" (§2).
- **Hand-authored items only.** The clarity gate is a linter that rejects under-specification, never a
  proposer (§1). No groomer agent decides scope.
- **No AI attribution** on any commit or PR body (harness §5).
- **Isolation & branch-only.** Fresh context, worktree per item, off `origin/<base>`, never main, never
  push beyond own branch, never force-push shared refs (§6).
- **Baseline-green before dispatch; verify is delta** (§10).
- **One scheduler per project at a time** (§9).

**Non-goals (deliberately out of scope — the operator owns these downstream of the PR):**
- Progressive delivery, canary, blue/green, build-once-promote-many artifact promotion, admission-control
  signature verification, DB-migration rollback safety — all live *past* the merge, in the operator's live
  gate, not in helm.
- Deterministic replay of worker logic (agents are non-deterministic by nature — verification-before-trust
  replaces replay-determinism as the safety mechanism).
- Segregation of duties (author ≠ approver): single-operator by design; accepted risk, revisit if the fleet
  ever gains a second human.
- Saga/compensation rollback: helm's only external side effects are branch push + PR open, both reversible
  by discarding the branch — no multi-step real-world transaction to unwind.

## F. Self-hosting: helm as a helm project

helm should eat its own cooking. Stand up `projects/helm/` with the same furniture every project gets:
`config.yml`, `DOSSIER.md`, `BACKLOG.md` (seeded from `ROADMAP.md`), `QUEUE.md`, `LEDGER.md`, `plans/`.
Then helm's own gap-closing work flows through the exact author→dispatch→verify→review loop it runs for the
product projects — which is also the strongest possible test of the machine.

**Open question — if the control-plane repo is local-only (no remote), give it a private remote, or use
`done_via: branch`?**

**Recommendation: add a private remote and set `projects/helm/config.yml → done_via: pr`.** Reasons:
1. **It closes the single worst gap first.** A local-only control-plane tree has no off-box backup — one bad
   edit from unrecoverable. A remote gives version history + off-box backup *and* the review surface in one move.
2. **It keeps the machinery uniform.** `done_via: pr` is the proven, exercised path. `done_via: branch`
   exists in doctrine but self-hosting on the unproven terminator means debugging two things at once.
3. **It gives the back door a real surface.** review-watch reconciles *PRs*. With `done_via: branch` there's
   no PR to observe, so helm-on-helm work can't use the automated back-door reconcile loop — the very loop
   we're trying to prove. A PR gate on helm's own changes is also the right amount of friction for edits to
   load-bearing doctrine and dispatch code.

Guardrails on the remote: **private** (the control-plane repo holds the whole control plane); keep
identity-isolated projects' paths excluded until their separate accounts exist — scope the helm project's
`repo_path`/`scope_dirs` to the helm subtree and deny the rest. A local-only fallback (`git init` + a bare
remote on a local disk, `done_via: branch`) is acceptable *only* if a private hosted repo is undesirable; it
still fixes the no-history gap but forfeits the back-door reconcile test.

**Bootstrapping guardrail — a worker must never hot-patch the dispatcher it runs under.** helm-on-helm work
that touches `dispatch/` or `templates/` (the running engine and harness) is **attended-only, Captain by
hand** — never a headless drain item. Put `dispatch/` and `templates/` in the helm project's `deny_dirs`, and
only queue `QUEUE.json` items that touch docs, metrics, tooling, or `projects/`. Rationale: a headless worker
editing the harness while other workers run that harness is version-skew and self-modifying code at once — the
failure the workflow-versioning gap already warns about. Engine changes get the slow, watched path; everything
else can drain.
