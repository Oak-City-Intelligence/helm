# helm — Decision Log

The design decisions and the forks behind them, plus the lessons earned in practice. This is the "how and
why the system is shaped this way" breadcrumb — curated to the decisions and lessons that generalize.

---

## Founding decisions

### Origin: "too in the loop" + "can't see when work is happening"
The system was born from two failures of running per-project interactive coding agents by hand:

- A dynamic **monitoring** loop (wake, assess, sleep) was being misused as a **build engine**. It self-paces
  silently → the visibility gap is inherent, not a driving error. A monitoring primitive is not an execution
  primitive.
- One context was both **manager and worker** — no separation, and state lived in a compacting conversation
  instead of on disk.
- Visibility was **pull-only via scrollback** — the worst of both: autonomous *and* opaque.

### Decision: manager/worker split + disk-backed queue/ledger
Adopted the three-role model (Planner / Dispatcher / Worker) and file-based continuity. State lives on disk,
not in a conversation that compacts away.

### Decision: one framework, three schedulers
Chosen over building one tier. An attended burst, a semi-attended `/loop`, and an overnight burner differ
**only in who turns the crank and how many times** — the item contract, done-definition, and ledger are
identical. Same QUEUE, three schedulers.

### Decision: hand-authored items ONLY — no groomer-that-decides
The fork: let a groomer agent propose the queue from rough intent (cheap authoring) vs. hand-author
everything (total control). The call: hand-author. *If you are totally handing off the build, you must be
damn sure the instructions are clear and tightly defined.* A clarity gate is permitted only as a **linter that
rejects under-specification**, never as a decider. (Doctrine §1.)

### Decision: never-guess, calibrated (discover vs decide) + clarity-pass-first
The never-guess rule is the deliberate inversion of an agent's normal "use a sensible default" disposition.
Calibrated so it isn't useless: *discover* facts from the repo, *block* only on decisions/genuine ambiguity.
A worker's first action is a read-only clarity pass so blocking happens before any wasted work. (Doctrine §2.)

### Decision: verifiable-only in the queue; judgment is an attended carve-out
Every item needs a runnable `verify` or the operator is back to reviewing everything by hand. Judgment work
(product feel, UX taste) stays manual — workable later only via a *deep-groom, attended-only* item. Large
verifiable surfaces (platform wiring to parity) are good queue fodder. (Doctrine §4.)

### Decision: per-project done-contract (`done_via`)
Some repos have no PR surface → "PR-only" can't be universal. Made done-definition a per-project field: `pr`
vs `branch`. Framework stays uniform; only the terminal step differs. (Doctrine §5.)

### Decision: identity-isolated projects are deferred until their own account exists
Some projects must be *genuinely* unlinkable from an operator's other identities. Org ownership does NOT
isolate — org ownership/collaborator/push account all correlate, and the git *commit author* is the hard link;
git history is permanent, so one slip welds the link forever. True isolation needs a **separate account +
dedicated git author + separate SSH key + no content cross-refs** (OSINT-grade, since all commits still
originate from one machine). Until that account exists, an identity-isolated project is **excluded from the
fleet** and worked hands-on; then it joins as a normal project with an `identity` config. (Doctrine §5.)

### Decision: control-plane lives centrally, NOT in each repo's `.something/`
A product repo may be a **linked git worktree** on a feature branch, with multiple worktrees live. Putting
QUEUE/LEDGER inside the product repo would couple them to a branch and pollute it. So all queues/ledgers/
configs live centrally in the control-plane repo; product repos receive only code changes (branches/PRs).

### Decision: overnight tier uses systemd user timers, NOT cron
On the reference box, cron is disabled (crontab never fires). The overnight burner must be a systemd user
timer from the start. (Match this to your own environment — the point is: pick the scheduler that actually
fires, and confirm it fires.)

### First proof: recovery-of-known-good code is the lowest-ambiguity first rep
The first item candidate was recovering a known-good component that had survived on another branch — the
lowest-ambiguity, highest-verifiability first rep, and the reference spec every future item is modeled on.

### The gate worked on item #1 — a false premise, caught
The first authored item's premise ("copy the component back from `main`") turned out **false**: the live
frontend had been rewritten, the old component + its backend were deleted, and the placeholder it was meant to
replace was a *deliberate* stance, not an unfinished stub. → The item was a **decision-dense epic**, not a
recovery; it failed the clarity gate, correctly. The forks were answered immediately by the operator, so
nothing went to `BLOCKED.md` (that's for worker-time questions); the remaining gate was an upstream design
dependency, recorded in the plan's `blocked_by`.

### First machinery proof — ran end-to-end, correctly BLOCKED
An early deletion item ran attended, in a worktree, as the first proof. Every layer fired: clarity pass
(green), worktree isolation off committed `main`, delete, `verify`. Tests passed, but `typecheck` and `build`
**failed** — in a file the item never touched. Root cause: **committed `main` was CI-red**, masked by
uncommitted local regenerated bindings; a clean worktree surfaced exactly the breakage the local tree hid.
Correct outcome: **block** — do NOT commit the in-progress local work, do NOT hack a green. The system proved
its worth by catching a real repo-health problem instead of rubber-stamping.

**Doctrine earned:** the authoring/clarity gate must confirm a **green baseline** before an item is admitted,
OR `verify` must be **delta-based** ("no NEW failures vs the base commit"). Both landed. (Doctrine §10.)

## Machinery, proven and hardened

- **Burst dispatcher built** (`dispatch/helm-dispatch.js`, DOCTRINE §12b): one isolated fleet worker per ready
  item. Replaced the operator hand-flying items. Two gotchas earned: the runtime `args` may arrive JSON-encoded
  (parse defensively); a `[]`/0-agent result = no-op, never success.
- **Back door defined + automated** (DOCTRINE §13): operator PR review (comment/close/inline-fix) routes back
  to a plan amendment, a BACKLOG line, or a harness/doctrine fix, logged as a ledger `intake`. `review-watch.sh`
  + `.watch-prompt.md` reconcile GitHub PR state → ledgers on a timer + an in-session poller; the operator no
  longer narrates "I merged/commented" — the loop notices. Drain-only (never merges/deploys/authors-fresh).
- **Gauntlet dispatcher** (`helm-dispatch-gauntlet.js`): an attended dispatcher for high-stakes items. Per item,
  concurrently: BUILD (branch, verify, push — no PR) → 2 adversarial reviewers (scope-fidelity + a security
  lens) → ≤1 fix round + re-review → PR only when both clean; unresolved blocker/major findings → blocked for
  the operator. Encodes the review gauntlet that a direct-to-main commit once skipped. Top-tier, attended; NOT
  for the drain loop.
- **LEDGER schema + validator**: a canonical status enum (`queued/dispatched/done/merged/blocked/failed/intake/
  scout/groom/local-ops/note`) in `worker-prompt.md`; `dispatch/ledgertool.js lint` enforces format+enum (hard)
  and warns on non-monotonic timestamps (soft). Unblocks all of the metrics fold.
- **Transient-vs-real failure classifier + bounded retry**: the harness classifies env/infra hiccups (install
  hang, worktree lock, flaky/OOM, transient API 401) and retries them before returning `failed+transient`; the
  dispatcher auto-re-dispatches those fresh. Kills the false-block class where pure infra latency read as a block.
- **Queue-from-ledger + drift**: `ledgertool.js state` derives the true per-item view from the ledger (one
  source, not several hand-synced views); `… drift` flags stale queue items. (`ledgertool.js` and
  `usage-today.js` are built and exercised but **not bundled in this pre-1.0 cut** — see `dispatch/RUNMODE.md`.)
- **CI-mirror validator** (`dispatch/ci-audit.js`): `baseline_check` is a hand-transcribed copy of the repo's
  real CI gate, and copies drift — every drift has bitten (a dropped format check reddened the base; a missing
  formatting gate blocked a worker on pre-existing diffs). The tool parses the repo's actual workflow YAMLs,
  extracts the gate commands, and reports any that `baseline_check` does not cover. Run it at session start and
  before authoring items that touch a new surface.
- **Self-hosting** (`projects/helm/`): helm eats its own cooking; its groundwork backlog (seeded from ROADMAP)
  runs through the same author→gate→verify→record loop. Also closes the config half of `deny_dirs` — the engine
  (`dispatch/`, `templates/`) is attended-only, and a self-host worker is hard-blocked from touching it.

## Earned lessons (anonymized war-stories, kept because each one is a rule now)

### The fleet is trustworthy; ungroomed authoring is the weak link
The first dispatch wave: four items, all four blocked — correctly, zero bad commits. Three blocks were
authoring errors (specs targeting disk-only/untracked files ×2, a dossier conflation ×1); one was a
stale-local-base bug. The workers did exactly right. Every block routed back through the back door into a plan
amendment, a drop, or a harness/doctrine fix. That loop — cheap block → cheap fix → re-dispatch — is what makes
aggressive dispatch safe. It also produced the **authoring guards** in `templates/item.md`.

### Author against git-tracked reality, off the remote base
A worker isolates in a fresh worktree, where git-ignored / de-tracked files don't exist. A spec that
targets them will (correctly) block — check `git ls-files` when authoring. And branch off `origin/<base>`: the
operator's long-lived local checkout can be stale or `skip-worktree`-polluted; the remote base is what CI sees.
(A worker once built off a frozen local `main` and hit a placeholder bug already fixed on the remote.)

### A scout/audit summary is a LEAD, not ground truth — verify the decisive lines yourself
Repeatedly, a scout/audit summary was wrong on code specifics and work was built on it (invented numbers for a
pressure-test; a "keystone" claim that a factory was never wired in production — false, the audit read only the
entry file and missed the default in the container). For high-stakes/lifecycle code, verify the specific claim
against the code (read the construction site, not just the referenced file) BEFORE authoring a fix or telling
the Captain a narrative. The adversarial gauntlet/skeptic is the real gate; lean on it. This is why the intake
pipeline (DOCTRINE §16) has a mandatory **skeptic** stage between investigate and forge.

### When auditing a change-delta, include the validators the changed code calls into
An audit bundle scoped to only the changed files couldn't see the registry/validator those files call one hop
out of the diff → two false/misdirected findings (a "no validation" false positive where the validating call
lived out of bundle; a fix naming the wrong registry). Trace one hop out of the diff, or scope the audit to
whole subsystems, not just the diff. A diff-only audit false-positives on anything guarded by an unbundled
dependency.

### Security-fix PRs on PUBLIC repos must not disclose the exploit
A gauntlet PR body once spelled out both vulnerabilities and how to exploit them — on a public repo, while the
fix was un-merged. That publishes an attack map for code still live on `main`. **Rule:** for a security fix on a
public repo, the PR body states WHAT was hardened (component + control added) and the verify, NOT the exploit
mechanics — findings stay in the internal ledger/audit. Sanitize before open; prefer prompt merge so the window
of exposure is minimal.

### Parallel-burst shared-manifest conflict
A burst of test items each enrolled its new test file in the SAME hand-listed array (a `package.json` test
list, not a glob), all branched off the same base. As siblings merged, the base's list line moved and the
still-open siblings went CONFLICTING on that one line. Test files themselves never conflict (additive new
files); only the shared manifest does. Resolution (orchestration-layer, not a worker failure): merge base into
the branch, take base's fully-enrolled list, re-insert the branch's own one-line enrollment (union), re-run the
gate, push — no force-push. **Going forward:** if ≥2 items in a burst edit the same shared manifest, either
SERIALIZE them (dispatch one, let it merge, rebase the next via `on-merge.json`) or budget for
orchestrator-side conflict resolution. Prefer globs where the repo allows (removes the shared line entirely),
but that's a repo change, not helm's to make unilaterally.

### Don't burn a transient into a false block
A ~15-minute dependency-install hang was once returned as a block; it was pure infra latency and cleared on a
warm-cache re-dispatch. Classify env/infra hiccups as **transient** and retry (bounded) before ever blocking.
(This is now the harness rule + the dispatcher's auto-re-dispatch.)

### Never blanket-discard a dirty worktree
An early worker modified files in the primary checkout "temporarily." The primary checkout holds irreplaceable
untracked/dirty operator work; a blanket `git checkout -- .` / `git clean` there is catastrophic. Isolation
comes BEFORE any edit; if you catch yourself having edited the primary, port the diff to the worktree and revert
ONLY your own edits file-by-file. (Doctrine §12.)

### Worktree dependency provisioning can diverge from the pin
When a dependency tree is gitignored and pinned by a lockfile (with no committed submodule gitlinks), a fresh
worktree resolves those deps to something other than the locked revision → the gate phantom-reds on a "break"
that isn't real. The fix is a per-project `worktree_provision` step that mirrors the pinned deps into the fresh
worktree before any build. See `dispatch/KNOWN-ISSUES.md #1`.

### Sibling items sharing a projection must cross-reference at promotion
Two intake drafts promoted in parallel both planned to add a field to the same projection; one shipped it, the
other's spec still told its worker to add its own — and correctly clarity-blocked. Lessons: (1) at promotion
time, items touching the SAME schema/projection must be cross-referenced — one owns the field, the rest consume;
(2) any item scoping a generated contract file MUST also scope its regenerated artifacts and run the regen, or
the drift test fails the gate every time. The spec, not the worker, was the defect.

### Intake mode: agents draft specs, the operator still authors
The operator rattles off observations from a repo walk; per observation a read-only investigate → skeptic →
forge pipeline produces a fully-fledged DRAFT spec. This brushes against §1 ("no groomer agent decides what the
work is"), so the framing is explicit: **the operator authors the intent (observation, quoted verbatim) and
approves the spec (manual promotion into plans/ + QUEUE, clarity gate applied); agents supply evidence and
scaffold only.** Genuine decisions become "Open questions" with GATED steps — never a guess. The skeptic stage
is load-bearing (a scout summary is a lead, not ground truth). Drafts never auto-queue; widening that is a
doctrine change, not a default. (Earned on the first intake run: a draft framed a grouping question as "map the
existing sections"; the operator's actual answer was a different taxonomy entirely — so intake questions must be
phrased open-endedly, offering repo-derived options as candidates only.)
