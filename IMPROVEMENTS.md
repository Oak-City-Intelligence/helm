# helm — process improvements (grooming-side hardening)

The open backlog for the loop's *machinery*, not for any one project. It is published for the same reason
`ROADMAP.md` is: the honest state of a system includes what it still gets wrong.

**The theme, and it has held for months:** the build/verify/gate side is mechanically solid; the **grooming
side is still done by captain judgment**, and that is where the recurring error rate lives. In one wave,
~10 of 12 worker blocks were captain-authoring misses that the workers caught — the plan's own claims, not
the code, were the false surface. The workers keep covering for the front door. That is the block discipline
working (DOCTRINE §2), and it is also a bill that should not have to be paid twice.

Entries are ordered by value, and each one was earned by a concrete failure. Entries that shipped are
marked; a few project-specific plumbing items from our own lanes are omitted as untransferable.

---

## 1. Mechanical consumer-scan before dispatch (HIGHEST VALUE)
**Problem:** the most common block class is a scope miss on *ripple*. An item changes a signature, a
validation, or an interface, and out-of-scope callers or test-doubles break the gate. Evidence, all from one
project: dropping a URL scheme reddened two out-of-scope consumer tests; a mutability change touched ~100
call sites; two items missed the mock implementers of the interface they changed. `templates/item.md` has
prose guards for exactly this, and a hand-filled checklist has a known error rate of about one miss per wave.
**Fix:** the dispatcher (or a pre-flight step) auto-runs `git grep` on every symbol an item's diff touches —
function names, changed validation, interface methods — across the WHOLE repo, and dumps the caller and
implementer list into the plan before dispatch. Turn template-guard prose into a script. This alone kills the
recurring re-dispatch cycle.

## 2. Feedback loop back to the spec author (missing loop)
**Problem:** specs drafted by a scouting agent arrive overconfident, and roughly three in four carry a
load-bearing FALSE claim ("one-line swap", "zero callers", drifted line references). The captain pays the
full adversarial-triage cost to re-catch it every wave, and the findings die in captain context — the author
never learns. In one wave, three of four drafted specs were falsified at triage.
**Fix:** route triage verdicts back to the spec author — append the corrected facts to the spec, or keep a
running claim-accuracy note per author. Close the open loop so the next drop arrives cleaner and triage cost
falls.

## 3. Audit debt as a first-class object (not a string)
**Problem:** "flag a re-audit before deploy" lives only in PR bodies and LEDGER lines. The outstanding-audit
set is reconstructable only by archaeology, and a mid-stream context compaction loses it. At one point six
money-path merges rode on it being remembered.
**Fix:** a tracked `projects/<name>/AUDIT-DEBT.md` — one line per unaudited money-path or
validation-surface merge (id, PR, what to re-check), cleared explicitly when audited. Makes "end of the rope"
a concrete checklist instead of a vibe.

## 4. Spike facts before spending operator attention
**Problem:** the captain sometimes bundles a *fact* into a *decision* and spends the operator's attention on
the discovery. One escalation handed the operator a research finding ("this dependency has no support for X,
so it's a bigger job") wrapped around the actual one-clause value judgment ("do we care about that use case
here").
**Fix:** grooming discipline — a read-only spike surfaces facts for free; escalate ONLY the genuine value
judgment, pre-stripped of discovery. This is §15's Navigator/First-Mate split applied to escalations.

## 5. Mechanical disjointness check before parallel fire
**Problem:** "these items are file-disjoint, so they're parallel-safe" is asserted by eyeballing `scope_dirs`.
A real overlap surfaces downstream as a rebase or merge conflict, not as a pre-flight error.
**Fix:** intersect the `scope_dirs` sets of a dispatch batch before firing; flag any overlap. A five-line
check that turns a judgment call into a guarantee.

## 6. Plan-linter preflight (the claim-verification twin of #1)
**Problem:** #1 scans the *diff's ripple*; nothing checks the PLAN's own assertions before dispatch. One
batch's misses were all claim-shaped: a `verify` naming a test file the captain never read; stale paths in
`verify`; an "these assets exist" claim that was false in the worker's fresh worktree; a "sibling validation
idiom" that does not exist in the repo; a missing registration site; post-amendment prose contradicting the
amended scope.
**Fix:** a cheap pre-dispatch agent (light tier, like the baseline preflight) that reads every file named in
`scope_dirs`/`verify`/steps; runs every grep or test-selector in `verify` against the base to confirm it CAN
pass and is not a no-op; and flags any plan sentence asserting a repo fact it cannot confirm with a
`file:line`. Wire it as a `plan_lint` phase before worker fan-out. It would have pre-caught roughly seven of
one batch's ten authoring blocks, at a few thousand tokens each.

## 7. `scope_dirs` preflight — ✅ SHIPPED (`dispatch/scope-preflight.js`)
A narrow slice of #6, shipped after four consecutive blocks were spec-authoring misses and three of those
were `scope_dirs` naming a directory that has never existed. Read-only, no model in the loop: it checks every
ready plan's `scope_dirs` against the target repo's `origin/main`, flags paths that do not exist, and flags
scoped targets that are gitignored (a worker can write those, every gate can pass, and the file never reaches
the branch). A string comparison should not cost a dispatch round-trip.

## 8. Migration-number allocator — ✅ SHIPPED
**Problem:** two same-day items both minted `070_*.sql`; parallel worktrees cannot see each other's new
files. Caught post-hoc and renumbered by hand.
**Fix:** template guard #9 (the captain assigns the number at authoring time) plus a helper that scans the
migrations dir on `origin/main` AND every unmerged branch's tree for the max number, then prints the next
free one. The plan then carries the literal filename. A one-line script that kills the class.

## 9. `skip_baseline` discipline (DOCTRINE §10 drift)
**Problem:** after the first green preflight, the captain rode `skip_baseline: true` for ~15 subsequent
dispatches. Each was individually justified (main was freshly merged and verified), but the habit is exactly
the drift §10 warns about — one bad merge and a whole burst fans out onto a red base with N confusing blocks.
**Fix:** make the dispatcher's default smarter rather than trusting captain discipline: cache the last green
`(base_sha, config)` pair per project, auto-skip only while base HEAD is unchanged since that green run, and
auto-run otherwise. Removes both the wasted preflights and the discretion.

## 10. Captain-commit wrapper — ✅ SHIPPED
**Problem:** captain-side fixup commits on worker branches (gate hardening, test upgrades, a renumber) each
hand-carry `-c user.name/user.email` plus a manual `identity-guard.sh` run. One forgotten flag is a
cross-realm author on an identity-isolated branch — and that is not retractable once pushed.
**Fix:** a wrapper that reads the lane's identity block from `config.yml`, commits with it, runs
`identity-guard.sh` automatically, and refuses on a dirty mismatch. Fail-closed, same posture as the
repo-side hook.

## 11. Deploy-source freshness guard
**Problem:** a deploy script ships whatever tree it runs from. The captain deployed from a primary checkout
while calling it "main-equivalent" — true the day before, false after 30 merges advanced main. The result
was a full deploy of stale code that reported "migrations complete" while two migrations never left the repo.
It was caught only by post-deploy verification. Second-order cause: the primary checkout sat on a long-lived
branch that silently aged.
**Fix:** a deploy preflight — `git fetch`, compare the deploying tree to the remote main tip, and refuse with
the delta if it is behind or diverged, unless explicitly forced. One guard, and it kills the whole
shipped-yesterday's-code class. (Post-deploy verification stays mandatory regardless — it is what caught
this one.)

## 12. Groom and triage MUST read `origin/main`, never the dirty primary checkout
**Problem:** three false premises in one session traced to grooming and triage reading the primary working
checkout — which was behind, and carrying untracked in-flight work — instead of committed `origin/main`. One
of them cited a component as approved-and-present when it existed only as an untracked local file; an entire
probe model was built on the phantom. Workers dispatch off a fresh `origin/main` worktree, so any premise
triaged against the dirty checkout can diverge from what the worker actually sees.
**Fix:** groom and triage agents must (a) `git fetch` and read committed `origin/main`, or a clean worktree;
(b) explicitly diff any cited file or symbol against `origin/main` and flag anything that exists only in the
working tree; (c) never trust a `grep` over the primary checkout to answer "does X exist / is X approved".
Now partly enforced by `board-audit` and `scope-preflight`, both of which read `origin/<base>` only.

## 13. Red-team the RUNNING system on a cadence, not just build and verify
**Problem:** an authorization defect — an unauthenticated global read of private user records — was live in
production and passed every existing gate. The route census listed it, unit tests were green, and a
first-wave unauthenticated probe sailed past it because the default code path returns only public data. It
surfaced only from an *authenticated functional* walk that thought to vary a visibility parameter. The
build/verify side is mechanically solid; what has no recurring gate is **"does the running system leak when a
real caller pokes it"**.
**Fix:** make the authenticated API walk a standing periodic pass, not a one-off. Keep a lightweight cadence —
an authenticated probe of the auth-required surface (function, authorization-parameter trust, schema drift)
each time the route surface changes materially, or on a fixed interval. Best end state: a headless
authenticated smoke test asserting the invariant class (no anonymous or foreign caller reaches private or
cross-tenant data), so a regression re-appears as a red check rather than as a future walk finding. The bug
class, not the instance, is the target — DOCTRINE §17 applied to a live surface.

---

### Meta

The common thread across every entry: the loop's human-judgment steps — scope, disjointness, audit tracking,
spec-author quality — are the weak link, and the workers keep covering for them by blocking instead of
guessing. Mechanizing #1, #3 and #6 removes the most cycle-costly ones; #2 and #4 are cheaper but structural.

One batch of ~30 dispatches and 34 PRs across six lanes produced zero bad merges and twelve blocks. That is
the block discipline scaling, and it is also the measurement that says the captain is now the dominant error
source. Everything above follows from that.
