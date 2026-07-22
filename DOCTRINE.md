# helm — Doctrine

The principles that shape the system. If a proposed change violates one of these, it's probably
wrong — or the principle needs an explicit, logged revision in `DECISIONS.md`.

## 0. The thesis: relocate attention, don't abdicate it

The goal is not "agents work unsupervised." The goal is **more return on the operator's attention.**
Today attention is spent *supervising execution* — watching a chat build, nudging it along. helm moves
that attention to the two places where it actually compounds:

- **Front door — authoring specs.** A tightly-scoped, unambiguous item is the whole point.
- **Back door — reviewing PRs.** A mechanically-verified change is fast to review and safe to trust.

Execution in the middle becomes hands-off *because* the two doors are disciplined. If either door is
sloppy, autonomy produces slop faster — it does not save attention. Everything below serves the two doors.

## 1. Hand-authored items only

Every queue item is authored by the operator. There is **no groomer agent that decides** what the work
is or how to scope it — that would hand the steering wheel back to the model.

A **clarity gate** (a linter, not a decider) MAY enforce the operator's own standard: refuse an item into
the queue unless it has `scope_dirs`, a runnable `verify`, and concrete steps with no hand-waves
("handle errors appropriately" is a rejection). The gate never *proposes* a decision; it only *rejects
under-specification*. This is what makes hand-authoring sustainable rather than exhausting: it catches
ambiguity at the desk (cheap) instead of at runtime (a blocked worker).

## 2. Never guess — the discover-vs-decide line

A worker that hits a question does not guess, does not assume, does not pick "the reasonable default."
This is the deliberate **inversion** of an agent's normal disposition. But it is calibrated so the system
isn't useless:

- If the answer is **knowable by reading the repo** → find it. That's *discovery*, expected.
- If it requires a **decision, a preference, or is genuinely undetermined** by the plan → **stop**, write
  the question to `BLOCKED.md` with full context, and end.

**Clarity-pass-first:** a worker's first action is read-only — restate what it's about to do, list every
assumption, flag anything undetermined — *before touching a file*. If it flags, it blocks having spent
almost nothing. Ambiguity dies before code is written.

## 3. Two-gate enforcement

The "clear instructions" guarantee has two enforcement points, and the first makes the second rare:
1. **Authoring-time** — the clarity gate (principle 1).
2. **Run-time** — the block protocol (principle 2).

## 4. Verifiable-only in the queue; judgment stays manual

Every item carries a **runnable `verify`** — the mechanical proof it worked. If "done" can't be checked
by a command, the operator must review it by hand, and attention isn't saved. Therefore:

- Verifiable work (wiring, ports, refactors, migrations) → queue fodder.
- Judgment work (UX, design taste, product direction — e.g. how a chat surface should *feel*) → does
  **not** go in the unattended queue. It stays interactive, or runs as a **high-groom, attended-only**
  item (a burst the operator watches). The carve-out is a tier, not a wall.

## 5. Per-project contract: done_via, identity, carve-outs

Projects differ; the framework stays uniform by pushing the differences into `config.yml`:
- **`done_via`** — how an item terminates: `pr` (branch → verify → PR) or `branch` (branch → verify →
  operator diffs/merges locally, for repos without a PR surface).
- **identity** — the git author + SSH alias a worker commits under. Enables identity-isolated projects
  (a project published under a separate account) without changing any machinery.
- **`deny_dirs`** — carve-outs a worker may never touch (belt); each item's `scope_dirs` is the allowlist
  (suspenders). Touching a denied path is an automatic block.

## 6. Isolation & safety of the worker

- **Fresh context per item.** No accumulated state; the plan file + repo are the only inputs.
- **Git worktree per item** so parallel projects/items never collide.
- **Branch-only. Never main. Never push beyond the item's own branch. Never auto-merge.** The queue drains
  into a PR/diff pile the operator reviews. (Auto-merge for a whitelisted low-risk category is a *future*
  possibility gated on earned trust — not a starting default.)

## 7. Observability is a spine, not chatter

The fix for "I can't see when work is happening" is not a talkative agent — it's a durable, glanceable
trail checked on the operator's schedule:
- **`LEDGER.md`** — append-only, one line per state transition, machine-parseable. The source of truth,
  survives context compaction. This is *the* answer to "what's happening."
- **Push on state-change** (a phone notification) for the three events that matter: item done / PR opened /
  blocked-needs-you. Event-driven, not a firehose.
- A **dashboard** renders the ledgers into one cross-project glance.

## 8. Roles are separated

- **Planner** (operator) — turns intent into pre-approved, scoped items in `QUEUE.md`.
- **Dispatcher** (thin) — picks the next unblocked item, spawns a worker, records the result, pings,
  advances. Holds almost no context so it can't rot.
- **Worker** (fresh, isolated) — does ONE item end-to-end, terminates per `done_via`, writes its result.

## 9. One scheduler per project at a time

The three tiers (attended burst / semi-attended loop / overnight burner) run at different *times*, not
concurrently on the same project. A single project-level lock enforces this. This deliberately avoids
cross-runtime per-item leasing — an over-engineered race waiting to happen. (Parallelism *within* a
burst is fine; the burst dispatcher manages its own worker concurrency.)

## 10. Baseline health gate — helm's own CI

helm must not ship work onto a broken base. Every project config carries a `baseline_check` (its real
CI gate: typecheck + test + build). Before dispatching ANY item, the dispatcher runs `baseline_check` on
the **base commit**:
- **Green** → proceed.
- **Red** → dispatch nothing; flag "baseline red" (ledger + push). A worker's `verify` cannot be trusted
  as a delta when the base doesn't pass — you'd either block on unrelated failures (best case, wasteful)
  or, worse, rubber-stamp red as green.

**Implemented in the burst dispatcher** (`helm-dispatch.js`): since the dispatcher itself is sandboxed (no
fs/exec), it spawns ONE **baseline agent** per distinct `(config, base)` before the worker fan-out; that agent
runs `baseline_check` on `origin/<base>` in a throwaway worktree and returns green/red. Red → those items are
NOT dispatched; each returns a `blocked` result ("base red — fix baseline first"), so a red base is one clear
signal, not N confusing per-worker blocks. Bypass a whole run with `args.skip_baseline:true`.

**The baseline MUST mirror real CI — and drift is the recurring bug.** Multiple incidents (a dropped
`format:check` reddened the base; a never-gated formatting check let a worker block on ~200 pre-existing diffs)
all traced to `baseline_check` being a hand-copy of CI that silently drifted. `dispatch/ci-audit.js` kills the
class: it parses the repo's actual workflow YAMLs, extracts the gate commands, and flags any not covered by
`baseline_check`. **Run it at session start and before authoring an item that touches a new surface.**
Intentional non-gate CI jobs (a live-DB integration job, a heavy security scan) are declared per-config in
`baseline_excludes:` so they don't false-flag.

**Baseline-repair escape hatch.** An item whose *purpose* is to make a red baseline green cannot itself
pass the baseline gate. Flag it `baseline_fix: true` (on the dispatch item): the dispatcher **bypasses the
pre-flight for that item's group** — it runs against the red base by design, and its `verify` IS the
baseline turning green (`baseline_check` exits 0). Only one `baseline_fix` item runs at a time, and it must
terminate the moment `baseline_check` passes. (Earned when a tracked deployment-placeholder file had drifted
from its generated counterpart, so a clean checkout was red; and again on a formatting baseline-fix that would
deadlock on the very red base it exists to green unless flagged.)

Corollary — **`verify` is delta-based**: an item passes if it introduces **no NEW failures vs the base
commit**, not merely if the base happens to be all-green. (Earned early: a committed base was CI-red, masked
by uncommitted local bindings; a clean worktree surfaced it only at verify time. With a baseline gate it would
have surfaced *before* dispatch.) Note: helm is often the *only* CI these repos get — when the operator is the
sole contributor, nothing else enforces green, so helm enforcing it is load-bearing.

## 11. Task-weighted model tier

Match model + effort to the *judgment* a task requires, not its importance. Cost concentrates in the wrong
places otherwise (e.g. codebase-scouting and mechanical edits do not need the top tier). Each item carries
`model` (top-tier | mid-tier | light) and `effort` (low|medium|high); the project sets defaults; the
dispatcher passes them through.

Rough rubric:
- **light / low** — READ-ONLY investigation spikes ONLY: codebase scouting, mapping, "where does X live",
  premise-checking before authoring a plan. See hard rule below.
- **mid-tier / medium** — normal contained work AND everything mechanical that edits files: scoped refactors,
  wiring against a clear spec, renames, dependency bumps, doc fixes, most queue items. **Default.**
- **top-tier / high** — genuine ambiguity or high blast radius: cross-cutting migrations, security-sensitive
  changes, verify-heavy debugging, deep grooms. Reserve for where judgment actually pays.
The clarity pass (read-only, cheap) can even run a tier below the execution, escalating only if it doesn't
block. Reserve the expensive tier for ambiguity; spend the cheap tier on everything mechanical.

### HARD RULE — the lightest tier never dispatches WORK
**No queue item that edits files, opens a PR, or otherwise produces a work product is ever dispatched at the
lightest model tier. The light tier is for investigation spikes only** — read-only scouts, clarity passes,
premise checks whose output feeds a plan. "It's just a one-line CSS fix" is not an exception; a work item's
floor is the mid tier. This overrides the rubric's old light-tier work examples.

### HARD RULE — irreversible-blast-radius code is always top-tier
**Any item whose diff touches code with irreversible or high blast radius (e.g. on-chain smart contracts —
contracts, tests, mocks, scripts, interfaces) is `model: top-tier`. No exceptions, including "trivial" ones**
(an interface param, a mock, a one-line change). This OVERRIDES the rubric above: the rubric weighs judgment,
but such code carries blast radius that a "contained" label cannot see. A mechanical-looking edit to it is the
exact shape of the bug that ships. This applies to the scout/clarity tier too when its output will be used to
author a plan for that code. Frontend/docs/infra items still follow the rubric normally.

## 12. Never `git clean`. Never discard untracked work.

**No agent, dispatcher, or worker ever runs `git clean` (in any flag combination), `git reset --hard`, or
`git checkout -- .` in a project repo or worktree.**

Untracked is not the same as unimportant in these repos:
- `git clean -fd` destroys untracked files — which in some repos is live hand-written work (components and
  modules that sat untracked for weeks).
- `git clean -fdx` additionally destroys **ignored** files — and a repo may ignore its `docs/*`, which is
  exactly where hand-authored specs live. Plans are deliberately not committed (repo size). **The heap is
  unrecoverable if wiped — it exists on one disk, untracked and ignored.**

If a worktree is dirty in a way that blocks work: STOP and report. Do not "clean up." Reverting a change an
agent itself made with a targeted `git checkout -- <specific-file>` is fine; blanket discards are never fine.

## 12b. The dispatcher, made real (burst mode)

The Dispatcher of §8 is no longer a person hand-flying items — it is `dispatch/helm-dispatch.js`. Given a list
of ready items (id, plan path, config path, target repo, base, branch, model), it spawns **one isolated fleet
worker per item, in parallel**, each of which:
- reads the fixed harness (`templates/worker-prompt.md`), the project `config.yml`, and its `plans/<id>.md`;
- runs the clarity pass and **blocks rather than guesses** if anything is undetermined;
- creates its own git worktree in the **target** repo (not the control-plane repo) off `origin/<base>`,
  executes within `scope_dirs`, verifies, commits under the project identity **with no AI attribution**,
  pushes, and opens the PR;
- returns a structured result (`status: done|blocked|failed`, `pr_url`, `verify_summary`, `block_question`,
  `ledger_line`) — never prose. The orchestrator appends the LEDGER lines and reports.

This maps cleanly onto §8: **Planner** = operator (authors `QUEUE.md`); **Dispatcher** = the burst runner
(spawns + collects, holds no domain context, can't rot); **Worker** = each agent (fresh, isolated, one item).

**Run-mode status.** Burst (attended) — **BUILT.** Overnight `systemd` burner (**drain-only**) — **BUILT**
(`dispatch/{night-run.sh, .night-prompt.md, helm-nightly.service, QUEUE.json, RUNMODE.md}`); awaiting the
operator's one-time timer install + a stocked `QUEUE.json` before its first real run. Semi-attended live
`/loop` — convenience only, dies with the session. See `dispatch/RUNMODE.md` for all three.

**The drain-only invariant.** Every unattended tier may ONLY dispatch pre-authored, clarity-gated items from
`QUEUE.json` and open PRs. It may **never author, groom, merge, deploy, or touch a primary checkout.**
Authoring stays the operator-gated front door (it's the proven weak link — every block this era traced to
ungroomed authoring, never the fleet); merge/deploy stay the operator's back-door gate. Widening this
authority is an explicit, logged doctrine change — not a default. Only **drain-safe** work is eligible for the
queue: attended/top-tier work (money contracts, review-gauntlet items, anything with an open operator
decision) is dispatched live, never queued for the night.

Two lessons already earned (both are trust-preserving, keep them):
- **A no-op is legible.** The first dispatch returned `[]` with 0 agents in 10ms — an unmistakable "that did
  nothing," not a silent false success. Empty/zero-agent results are a signal to diagnose, never to assume.
- **`args` arrives as a string.** The runtime `args` may reach the script JSON-encoded; parse defensively
  (`typeof args === 'string' ? JSON.parse(args) : args`) or the run silently no-ops on empty inputs.

## 13. The back door — review closes the loop

Three gates move work *toward* the operator: `BLOCKED.md` (a worker stopped, awaiting a decision) and
`REVIEW.md` (helm shipped something provisionally, awaiting confirm) are the forward gates. The **back door**
is the return path — **operator review flowing back into helm as new work or learning.** Without it, the
insight you generate while reviewing a PR evaporates, and the fleet repeats the mistake. This is the primitive
that makes being *trigger-happy* safe: cheap dispatch is only safe if mistakes bubble back cheaply.

**Surfaces** (where operator signal originates): a PR review comment; a PR closed-unmerged (rejection); a PR
merged-with-manual-edits (you fixed something inline — that fix is a spec correction); or a verbal insight.

**Capture — AUTOMATED, not operator-narrated.** The operator must NEVER have to say "I merged that" or "I
left a comment." The **review-watch** (`dispatch/review-watch.sh` + `.watch-prompt.md`, on a systemd timer, plus
an in-session poller) reconciles GitHub PR state against the ledgers every ~13–15 min and routes each delta
itself: **merged** → ledger `merged` line (+ auto-dispatch any `on-merge.json` dependents — this is how
`blocked_by` unblocks with no human in the loop); **closed-unmerged** → rejection intake; **new comments/
reviews** → the triage below. The operator just reviews on GitHub; the loop notices and acts. (You *can* still
volunteer a verbal insight (a fourth surface), but silence is no longer a dropped signal.) See
`dispatch/RUNMODE.md` for the watch tier. Same drain-only invariant: the watcher reconciles + routes +
dispatches pre-authored dependents; it never merges, deploys, or authors from scratch.

**Triage — every piece of review feedback routes to exactly one destination:**
1. **Item-specific follow-up** → a new `BACKLOG.md` line, tagged `origin: review PR#N`.
2. **The spec was wrong/incomplete** → amend the item's `plans/<id>.md` so a re-dispatch is correct, then
   re-run. (The plan is the durable artifact; fix it, don't just patch the branch.)
3. **A systemic lesson** → amend `templates/worker-prompt.md` or this doctrine. (The no-AI-attribution rule,
   §5 of the harness, came through this exact door — one annoyance became a permanent fleet-wide rule.)
4. **A provisional decision to confirm/revise** → resolve it in `REVIEW.md`.

**Loop-closing invariant:** nothing the operator flags is lost. Every reviewed PR either merges clean,
spawns a backlog line, or amends a spec/harness — and a one-line `LEDGER.md` entry records the intake
(`<ts> | <item-id> | intake | <what the review said → where it routed> | <pr-url>`). That ledger trail is how
we later see which specs the fleet kept getting wrong.

## 14. Greedy for work — idle is a smell

The orchestrator (First Mate) is **greedy for new work and agitated when it can't find any.** An empty pipe
is not a resting state to report and sit in ("nothing needs you, holding") — it is a *problem to solve.* The
Captain's attention is the scarce resource; the orchestrator's job is to keep the pipe full of real,
clarity-gated work so the Captain is never the reason the fleet is idle.

**The disposition.** When work lands, don't stop — look for the next thing *before* being asked. Keep a **WIP
floor**, not just a ceiling: a target number of items in flight, and when the count drops below it, refill.
Ending a turn with the fleet idle while groomable work exists is the failure this principle names — the same
complacency as a worker guessing, pointed the other way.

**Where the greed points (in priority order), when the pipe runs low:**
1. **Drain the ready queue** — anything drain-safe in `QUEUE.json`, dispatch it now, don't hoard it.
2. **Groom the next candidate** — pull the highest-impact item from `BACKLOG.md` / `ROADMAP.md` / a
   dossier's open threads, scout its premises, and drive it to the clarity gate → queue or dispatch.
3. **Advance helm itself** — a `ROADMAP.md` item (helm is a project too); self-improvement is always available.
4. **Surface the binding constraint** — if the *only* thing left genuinely needs a Captain decision, that is
   not "nothing to do": the greedy act is to surface that ONE decision, sharply and ranked, so a click unblocks
   a body of work. Escalating the constraint *is* work.

**The guardrail — greedy, never desperate.** Greed is for *legitimate* work, and it never overrides the other
principles: never invent busywork or a make-work item to look busy; never lower the clarity-gate bar or guess
to manufacture a dispatch; never widen drain-only authority to keep moving. If genuine, in-scope, clarity-gated
work cannot be found and no decision can be surfaced, *that* is the rare true idle — and even then the honest
move is to say "the constraint is X, here's the one thing that unblocks the next N items," not to go quiet.
Restlessness is the default; fabrication is still forbidden. The fleet is cheap; the Captain's idle pipe is the
waste.

## 15. Two altitudes of the orchestrator — First Mate (pit) and Navigator (bridge)

The orchestrator is one entity wearing **two hats at two altitudes**:

- **First Mate — the pit (tactical).** Runs the fleet: grooms, authors, dispatches, verifies, reconciles PRs.
  Optimizes *throughput of clarity-gated work.* §14 greed lives here.
- **Navigator — the bridge (strategic).** Sits with the Captain at *his* altitude and keeps the whole
  enterprise **on heading toward the long-term goals.** Optimizes that the throughput is aimed at the right
  destination.

**The Navigator's job** (distinct from the First Mate's):
1. **Hold the north star.** Each project's *real* milestone and the critical path to it — kept explicit, not
   implicit in a scatter of dossiers.
2. **Catch drift — busy ≠ winning.** The fleet can cheerfully ship 20 hygiene PRs while the actual mission
   stalls because it's gated on an un-made decision. The Navigator's core alarm: *"we are productive and not
   advancing."* Local optimization (throughput) without global progress (the goal) is the failure it exists to
   name — the strategic twin of §14's idle-is-a-smell.
3. **Translate activity into altitude.** Turn the ledger's tactical churn into the one answer the Captain
   actually wants: *are we on course, and what's the highest-impact move toward the destination* — not a PR
   count.
4. **Surface strategic decisions with consequence + timing.** Not "unblock this item" but "this decision gates
   N weeks of the critical path; here's the cost of deciding late." Rank by impact on the *goal*, not the queue.

**Cadence.** The bridge is periodic and stepped-back, NOT per-dispatch — a *strategic review* run on a cadence
(e.g. session start/end, a weekly beat, or when a milestone's critical path moves), complementary to the
tactical loops that run every merge. The First Mate reports "what shipped"; the Navigator reports "are we
winning, and should we change course." When those two disagree (lots shipping, mission not moving), the
Navigator's read wins the Captain's attention.

## 16. Intake — observations forged into specs (front-door assist)

The operator's raw material is often a **walk through a project**: a stream of bugs and observations, each
worth a spec, none yet investigated. Authoring those specs single-threaded in a chat starves each issue of
context — evidence for issue #3 evicts evidence for issue #1. **Intake mode** (`dispatch/helm-intake.js`)
fixes this: per observation, a read-only three-stage pipeline —

1. **Investigate** — a scout with a whole fresh context for ONE observation: root cause, file:line evidence,
   blast radius, proposed scope/verify.
2. **Skeptic** — an adversary tries to *refute* the investigation (a scout summary is a lead, not ground
   truth — earned rule), and runs the `templates/item.md` authoring guards as premise checks (paths tracked,
   verify mirrors full gate set, construction site named, test actually runs in gate).
3. **Forge** — writes the fully-fledged **draft** spec in the `item.md` shape, reading DOCTRINE, the
   authoring guards, and KNOWN-ISSUES first — **the gate where philosophy and earned lessons enter every
   spec at birth.** A refuted observation forges nothing; the refutation is the deliverable.

Drafts land in `projects/<p>/intake/<id>.md`, marked DRAFT, and **never enter QUEUE/plans by themselves.**
Promotion is the operator act: review, edit, rename into `plans/`, add the QUEUE line — the clarity gate
applies there exactly as for hand-authored work.

**§1 is preserved, not weakened:** the operator authors the *intent* (the observation, quoted verbatim into
the draft) and approves the *spec* (promotion). Agents supply evidence and scaffold; they never decide what
the work is. Genuine decisions surface as an "Open questions" section with gated steps — the never-guess
inversion (§2), applied to authoring. Read-only invariant: no stage touches a target repo's files, branches,
or history; the only write is the draft file inside helm itself. Model tier follows §11 including the hard
rules (an observation whose fix will touch irreversible-blast-radius code runs the whole pipeline at top-tier).
