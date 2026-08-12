# helm — Roadmap (gap-closing backlog, highest-impact first)

The concrete, buildable items that close the MISSING/partial gaps in `ARCHITECTURE.md §C`. Ranked by impact
inside phases; Phase 1 = the foundations everything else leans on. This is helm's own BACKLOG — seed a
lane's `BACKLOG.md` from it once helm runs itself as one of its own projects.

Legend: **fleet** = drain-safe, could be a QUEUE.json item · **attended** = Captain-run / touches the running
engine · size ≈ S (hour) / M (session) / L (multi-session).

Note: `ledgertool.js` (#3, #8) and `usage-today.js` (#19) were built and exercised before this repo
existed and were held back from the first cut; **both now ship**, along with the board-audit family, the
scope preflight, the ledger repair pair, the worktree reaper, and the identity guard. DONE means the
capability exists and is in the tree.

## Phase 1 — foundations (unblock everything downstream)

1. ✅ **DONE** — **Put the helm tree under version control.** Committed local, scoped to the helm subtree, no
   AI attribution. Closes: control-plane-not-in-git (local half).
2. ⏸ **DEFERRED (operator)** — **Add a private remote + `projects/helm` `done_via: pr`.** Local-commit-only
   for now; remote later. Self-host prerequisite still open (see ARCHITECTURE §F).
3. ✅ **DONE** — **LEDGER status enum + validator.** Canonical enum in `templates/worker-prompt.md`;
   `dispatch/ledgertool.js lint` enforces format + enum (hard), flags non-monotonic ts (soft); ledgers
   normalized to the enum. Timestamp = orchestrator-supplied. Unblocks all of §D.
4. ⛔ **BLOCKED on a push channel** — **Loop heartbeat / dead-man's-switch.** Emit last-successful-run + alert
   on absence. Emission is buildable now; the alert half needs the notification channel (#5).
5. ⛔ **BLOCKED on operator** — **Wire push on done / PR / blocked.** Needs the operator's notification
   topic/endpoint (e.g. an ntfy topic, a webhook).
6. ◑ **PARTIAL (config half DONE)** — **Populate `deny_dirs` + a pre-edit hook-guard.**
   `projects/helm/config.yml` now denies `dispatch/`+`templates/` (done by the self-host stand-up).
   Still open: the product projects' judgment-heavy paths + a contextmink pre-edit hook-guard.
7. ✅ **DONE** — **Transient-vs-real failure classifier + bounded retry.** Harness rule in `worker-prompt.md`
   (retry env/infra hiccups before failing; `failure_class`); dispatcher auto-re-dispatches `failed+transient`.
   Kills the false-block class. *(TODO: mirror the retry wrapper into the gauntlet dispatcher — the
   classification rule already applies via the shared harness.)*
8. ✅ **DONE** — **Queue-from-ledger + drift validator.** `dispatch/ledgertool.js state` derives the true
   per-item view from the ledger (single source); `… drift <ledger> <queue.json>` flags stale queue items.

## Phase 2 — prove the unattended tiers (turn built→proven)

9. **Install the systemd timers + `enable-linger`, stock QUEUE.json, run one real night** — the headline
   capability has never fired once. Closes: nightly drain exercised. *attended one-time, then fleet.*
10. ◑ **PARTIAL** — **Add the actuator brake: max-actions-per-interval + scoped kill switch.**
    review-watch now has a per-day run-count cap (LATCHING STOP on runaway) + a soft daily token-budget yield
    + the manual STOP file. STILL OPEN: the same brake on the DISPATCHERS (a burst/gauntlet has no
    per-interval action cap yet), and a finer-grained scoped kill (per-project, not just all-or-nothing STOP).
11. **Implement the §9 concurrency lock (flock)** — "one scheduler per project" is prose with no mechanism;
    a night drain overlapping a burst can collide on the worktree. Closes: leader-election/lock. *attended, S.*
12. ◑ **PARTIAL** — **Rebuild `pr-state.json` from live gh + run review-watch headless once.**
    `pr-state.json` rebuilt from live gh and the daemon hash primed during a hand reconcile. STILL OPEN: the
    headless `review-watch.sh` has never actually executed — the systemd timer is installed but PARKED. Closes
    when the daemon runs one real tick.
13. **De-duplicate the harness — dispatchers read `templates/worker-prompt.md`** — both JS dispatchers inline
    their own copy; a §13 rule update wouldn't reach them. Closes: harness/workflow versioning. *attended, S.*
14. **Prove `on-merge.json` auto-dispatch end-to-end (+ confirm attended-gauntlet-unattended intent)** — the
    self-unblocking chain has never fired, and it could auto-run high-stakes gauntlet work off a merge: confirm
    that's intended. Closes: self-unblock edge + drain/attended boundary. *attended, M.*

## Phase 3 — measure the machine (make "how's the fleet doing" answerable)

15. **Build the metrics fold (cycle / lead / throughput / block-rate / CFR / MTTR from the ledger)** —
    depends on Phase 1 #3. Closes: all of §D. *fleet, M.*
16. **Tag change-failure on review-watch intake** — mark closed-unmerged + post-merge fix-intakes so CFR is
    computable at all. Closes: consistent change-failure definition. *attended (harness), S.*
17. **Extend the console with a ledger-metrics panel** — DOCTRINE §7's cross-project glance; render the folds
    from #15 into the live console (`console/server.js`). The console already renders QUEUE/BLOCKED/LEDGER off
    disk per request (read-only, no stale-by-neglect); this adds the metrics view. *attended (tool), M.*
18. **Add WIP limits + blocked-item aging clock + escalation ladder** — no cap on in-flight and blocked
    items age off-radar with no owner. Closes: WIP limits + blocked aging/escalation. *attended, M.*
19. ✅ **DONE** — **Emit per-run cost/token + a budget kill-switch.** `dispatch/usage-today.js` sums combined
    compute tokens across all sessions (interactive + daemon + subagents), calendar-day or rolling. The
    review-watch breaker trips on the combined daily cap — SOFT skip (auto-resume), plus a LATCHING run-count
    backstop and the manual STOP. Closes: cost/token budget manager. *attended, M.*

## Phase 4 — self-host & harden (compounding safety)

20. ✅ **DONE** — **Stand up `projects/helm/` (config/DOSSIER/BACKLOG/QUEUE/LEDGER/plans)** — helm eats its own
    cooking; BACKLOG seeded from this file. Closes: self-hosting. Also closed the config half of #6
    (`deny_dirs`). *attended, M.*
21. **Add an independent verifier to the burst path (not just the gauntlet)** — burst trusts a mechanical
    verify with no adversarial check; verification-before-trust is the forgotten orchestrator piece. Closes:
    independent critic in the common path. *attended, M.*
22. **Build a dead-letter queue + replay tooling for exhausted/blocked items** — blocked items just sit;
    give them a lane, an owner, and a re-inject path. Closes: DLQ + approval-timeout/escalation. *attended, M.*
23. **Run a chaos/game-day drill on nightly + review-watch** — kill the worker mid-item, drop a gh poll,
    trip STOP, and confirm heartbeat/retry/kill actually fire. Closes: chaos validation of the loop.
    *attended, S.*
24. **Verify `DEPLOYMENT.md` against each repo's real CI** — each project's post-merge path is marked
    `(confirm)` until reconciled against its `.github/workflows`. Closes: deploy-path inference. *attended, S.*
25. ◑ **PARTIAL** — **Build a drift-detection reconcile pass (declared plans/QUEUE vs actual PR/branch
    state).** `dispatch/board-audit.js` now reconciles the declared board against GitHub, the ledger, and
    `origin/<base>` on every seat, and `board-stamp.js` writes back the one correction that is pure
    transcription (DOCTRINE §18). STILL OPEN: the alerting half — divergence is surfaced when a captain runs
    the audit, not pushed when it appears (needs #5's channel). *attended, M.*
26. **Harden the single-credential path (token expiry alert + fallback identity)** — the gh token blocked
    PRs twice; one box, one user, no rotation. Closes: least-privilege/credential fragility. *attended, S.*
27. **Version prompts/config + a small eval harness** — behavior changes to the harness are currently
    vibes-based; regression-test before rollout. Closes: prompt/config versioning + eval. *attended, L.*
28. **Build local-ops machinery (dispatcher + verify contract for local artifact work)** — the second work
    mode (work that runs on the box and produces an artifact/fact, not a PR) has no machinery and no logged
    success. Closes: local-ops mode. *attended, L.*

## Phase 5 — close the grooming gap (the current dominant error source)

See `IMPROVEMENTS.md` for the full backlog and the evidence behind each. The execution side holds; the
front door is where the error rate lives, so these rank above most polish items.

29. ✅ **DONE** — **Sweep worktrees the loop creates and never collects.** `dispatch/reap-worktrees.sh` reaps
    only provably-recoverable trees (merged into `origin/<base>`, no modified tracked files, no untracked
    files beyond what `worktree_provision` creates) and keeps branches. Runs before the nightly drain, so a
    quiet night still sweeps. *fleet, S.*
30. ◑ **PARTIAL** — **Pre-dispatch plan checking (IMPROVEMENTS #1/#6/#7).** `dispatch/scope-preflight.js`
    ships the path half: every ready plan's `scope_dirs` checked against `origin/<base>` for paths that don't
    exist and for gitignored targets, plus consumer enumeration when the plan declares `impact_symbols`.
    STILL OPEN: the claim half — a `plan_lint` phase that reads every file the plan names, runs each `verify`
    selector against the base to prove it can pass and isn't a no-op, and flags any sentence asserting a repo
    fact it can't confirm with a `file:line`. *attended, M.*
31. **Feed triage verdicts back to the spec author (IMPROVEMENTS #2)** — drafted specs arrive with a
    load-bearing false claim about three times in four; the captain re-catches it every wave and the finding
    dies in captain context. Close the loop so the next drop arrives cleaner. *attended, M.*
32. **Track audit debt as an object, not a string (IMPROVEMENTS #3)** — `projects/<name>/AUDIT-DEBT.md`, one
    line per unaudited money-path or validation-surface merge, cleared explicitly when audited. Today the set
    is reconstructable only by archaeology, and a context compaction loses it. *fleet, S.*
33. **Red-team the running system on a cadence (IMPROVEMENTS #13)** — build/verify is mechanically solid; an
    authorization defect that is live in production can pass every existing gate. Make the authenticated
    probe standing, and land the invariant as a headless smoke so a regression re-appears as a red check.
    *attended, M.*
