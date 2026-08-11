# helm — run modes (how the ball moves when you're not here)

helm has three run modes. Burst is proven; nightly is the autonomous tier; loop is a live-session
convenience. **All authority is drain-only** — the fleet dispatches pre-authored, clarity-gated items and
opens PRs. It never authors, never merges, never deploys. Those stay the operator's.

Throughout, `$HELM_ROOT` is the path to this repo.

> **What's bundled:** the burst dispatcher (`helm-dispatch.js`), the gauntlet dispatcher, the intake
> pipeline, the read-only audit dispatcher (`helm-audit.js`), the whole check family (`ci-audit.js`,
> `board-audit.js`, `scope-preflight.js`, `ledgertool.js`), the board writer (`board-stamp.js`), the ledger
> repair pair, the worktree reaper, the identity guard, the usage meter, and the nightly runner
> (`night-run.sh` + `night-prompt.md`).
>
> Described below for completeness but **not included**: the review-watch runner and its prompt
> (`review-watch.sh`, `.watch-prompt.md`), and the runtime state files the loop reads and writes
> (`QUEUE.json`, `on-merge.json`, `pr-state.json`) — those are live operator state, not code. The service
> unit files are provided as templates for when you wire your own nightly/review-watch tier; a
> `QUEUE.sample.json` ships as the shape for the queue you stock yourself.

## The fuel tank — `QUEUE.json`

`dispatch/QUEUE.json` is a JSON array of **dispatch-arg objects** — the exact shape `helm-dispatch.js`
consumes. It is the machine-readable fuel the autonomous loop drains. It is runtime state, so it is not
bundled; `dispatch/QUEUE.sample.json` ships as the shape to copy. One object per ready item:

```json
{ "id": "example-011", "project": "example", "github": "example-org/example",
  "base": "main", "branch": "example-011-slug",
  "plan": "/path/to/helm/projects/example/plans/example-011.md",
  "config": "/path/to/helm/projects/example/config.yml", "model": "sonnet" }
```

**Authoring convention:** when the orchestrator authors a clarity-gated item, it appends the item's
dispatch-args to `QUEUE.json`. That is how the queue gets stocked. The per-project `QUEUE.md` stays the
human-readable groomed list; `QUEUE.json` is the machine dispatch manifest. An item is drained (removed from
`QUEUE.json`) once dispatched — success or block — with its outcome written to the project `LEDGER.md`.

**Only drain-safe items belong in `QUEUE.json`.** Attended/top-tier work (anything needing a review gauntlet
or an operator decision) is NOT queued here — it runs in a live session with the operator.

## 1. Burst (proven) — live session, on demand
The orchestrator authors items and invokes `helm-dispatch.js`. One worker per item, isolated off
`origin/<base>`, verify, PR. This is the exercised path.

## 2. Nightly (the autonomous tier) — headless, unattended
A **systemd user timer** (on a box where cron is disabled) fires `night-run.sh` at a nightly hour. The wrapper:
- exits immediately if `dispatch/STOP` exists (kill switch) or `QUEUE.json` is empty (no work for no reason);
- otherwise runs one headless agent on `night-prompt.md`, which drains the queue drain-only and
  writes `NIGHT-REPORT.md` — the morning briefing.

### Install (one-time, operator)
```bash
cp "$HELM_ROOT/dispatch/helm-nightly.service" ~/.config/systemd/user/
cp "$HELM_ROOT/dispatch/helm-review-watch.service" ~/.config/systemd/user/
# write a .timer next to each .service for your cadence, then:
systemctl --user daemon-reload
systemctl --user enable --now helm-nightly.timer helm-review-watch.timer
systemctl --user list-timers 'helm-*'                # confirm next fires
loginctl enable-linger "$USER"                        # so the timers fire when you're not logged in
```
Prereqs: `gh auth` valid, git SSH working for the project's identity, the agent CLI on PATH.

## 2b. Review-watch (the back door, automated) — headless, on an interval
`review-watch.sh` (systemd) closes DOCTRINE §13 without the operator narrating it. Each tick: a **cheap** `gh`
poll hashes all helm PR states; only if the hash changed does it wake a headless agent on `.watch-prompt.md`,
which reconciles GitHub → ledgers and routes every delta — **merged** (ledger + auto-dispatch
`on-merge.json` dependents so `blocked_by` unblocks itself), **closed-unmerged** (rejection intake), **new
comments** (§13 triage → plan amendment / backlog / harness). State snapshot in `pr-state.json`;
blocker→dependent map in `on-merge.json`. While a live session is up, an in-session poller does the same so it
works before the timer is even installed. Never merges/deploys.

### Kill switch
```bash
touch "$HELM_ROOT/dispatch/STOP"     # pause: next run is a no-op
rm    "$HELM_ROOT/dispatch/STOP"     # resume
```

### The morning after
Read `dispatch/NIGHT-REPORT.md` and `dispatch/night.log`. PRs are waiting for your review — nothing was
merged or deployed. Blocks are appended to each project's `BLOCKED.md` with the worker's question.

## 3. Loop (live-session convenience) — `/loop` / a scheduled wakeup
Keeps *this* live session draining across idle gaps while you step away for minutes-to-an-hour. Dies when the
session ends — it is NOT cross-session autonomy. Use nightly for "closed the laptop."

## What each mode may NOT do (invariant across all three)
Author · groom · merge · deploy/promote · touch a primary checkout · edit `deny_dirs`.
The drain-only boundary is the operator's standing decision. Widening it is an explicit, logged doctrine
change — see `DOCTRINE.md` §12b.
