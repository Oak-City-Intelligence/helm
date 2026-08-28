// helm-intake — observations forged into fully-fledged DRAFT specs (DOCTRINE §16).
//
// The operator rattles off bugs/observations (from a walk through the repos, a phone note, a verbal
// aside). Per observation, a three-stage READ-ONLY pipeline:
//   1. INVESTIGATE — a scout with a whole fresh context for ONE observation: locate the code, find the
//                    root cause, gather file:line evidence, propose scope/verify.
//   2. SKEPTIC     — an adversary tries to REFUTE the investigator: wrong root cause, unverified premise,
//                    missed construction site. Runs the item-template authoring guards as premise checks.
//   3. FORGE       — writes the full draft spec (templates/item.md shape) WITH the repo philosophy in
//                    context: DOCTRINE.md, the authoring guards, KNOWN-ISSUES.md, the project config.
//                    Every spec is born already knowing the earned lessons.
//
// Output: projects/<project>/intake/<id>.md — a DRAFT. It never enters QUEUE.md/plans/ by itself.
// Promotion is the operator act: review, edit, rename into plans/, add the QUEUE line. The clarity
// gate applies at promotion exactly as for a hand-authored item (DOCTRINE §1 preserved: the operator
// authors the intent and approves the spec; agents supply evidence and scaffold, never decide work).
//
// READ-ONLY INVARIANT: no stage edits the target repo, creates worktrees/branches, commits, or pushes.
// The only write in the whole pipeline is the forge writing the draft file inside the control-plane repo.
//
// RUN IT — from a shell, through the agent host (dispatch/RUNTIME.md):
//   node dispatch/agent-host.js dispatch/helm-intake.js --args-file args.json
// where args.json is { "observations": [ ... ] }. Under a workflow-script runtime that injects the
// globals itself, the equivalent is run({ scriptPath: "<this file>", args: { observations: [ ... ] } }).
//
// args.observations[]: { id, project, config, note, hints, model }
//   id      — intake id, e.g. "example-intake-editor-lag" (becomes the draft filename)
//   project — project name (draft lands in projects/<project>/intake/)
//   config  — absolute path to the project config.yml
//   note    — the operator's observation, VERBATIM (this is the authored intent — do not paraphrase)
//   hints   — optional: suspected surface, repro notes, anything the operator added
//   model   — optional tier override (DOCTRINE §11). Irreversible-blast-radius surfaces: top-tier — the
//             scout-tier hard rule applies when the output will author a plan for that code.
//
// NOTE (DOCTRINE §12b): the runtime `args` may arrive JSON-encoded — parse defensively.
//
// PATHS: the control-plane root is derived from each observation's config path, so this script carries no
// absolute machine paths.

export const meta = {
  name: 'helm-intake',
  description: 'Forge operator observations into adversarially-checked draft specs (investigate → skeptic → forge)',
  phases: [
    { title: 'Investigate', detail: 'one read-only scout per observation: root cause + file:line evidence' },
    { title: 'Skeptic', detail: 'adversary tries to refute the root cause; runs authoring-guard premise checks' },
    { title: 'Forge', detail: 'write the full draft spec with doctrine + earned lessons in context' },
  ],
}

// HELM_ROOT derived from a config path: <root>/projects/<p>/config.yml → <root>
// lastIndexOf, not first: a checkout that itself lives under a directory called projects is the
// normal case, and the FIRST match would stop one level too early (helm-104).
const helmRoot = (cfg) => cfg.slice(0, cfg.lastIndexOf('/projects/'))

const _args = typeof args === 'string' ? JSON.parse(args) : (args || {})
const observations = _args.observations || []
if (!observations.length) { log('no observations passed — nothing to forge'); return [] }

// Guard (DOCTRINE §17): every stage prompt names files under helmRoot — the doctrine, the item
// template and its authoring guards. A wrong derivation makes each of those unreadable without
// throwing, and the forge then writes a draft that satisfied no guard at all. Assert it up front.
for (const o of observations) {
  const templatePath = `${helmRoot(o.config)}/templates/item.md`
  if (!exists(templatePath)) {
    throw new Error(`helm root derived from ${o.config} does not exist: ${templatePath}`)
  }
}

const INVESTIGATE_SCHEMA = {
  type: 'object',
  properties: {
    observation: { type: 'string' }, // the intake id
    verdict: { type: 'string', enum: ['confirmed', 'not-reproduced', 'unclear'] },
    root_cause: { type: 'string' },  // concrete: the defective mechanism, not a restatement of the symptom
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          where: { type: 'string' },  // file:line (repo-relative)
          what: { type: 'string' },   // the decisive fact at that location
        },
        required: ['where', 'what'],
      },
    },
    blast_radius: { type: 'string' },        // what else this touches / what a fix could break
    repro: { type: 'string' },               // how to observe the defect, if observable
    proposed_scope_dirs: { type: 'array', items: { type: 'string' } },
    proposed_verify: { type: 'string' },     // runnable proof-of-fix candidate
    open_questions: { type: 'array', items: { type: 'string' } }, // genuine DECISIONS only, not lookups
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' },
  },
  required: ['observation', 'verdict', 'root_cause', 'evidence', 'confidence'],
}

const SKEPTIC_SCHEMA = {
  type: 'object',
  properties: {
    observation: { type: 'string' },
    verdict: { type: 'string', enum: ['confirmed', 'revised', 'refuted'] },
    challenges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },     // the investigator claim challenged
          finding: { type: 'string' },   // what the skeptic actually found (with file:line)
          outcome: { type: 'string', enum: ['holds', 'corrected', 'demolished'] },
        },
        required: ['claim', 'finding', 'outcome'],
      },
    },
    revised_root_cause: { type: 'string' }, // only when verdict=revised
    premise_checks: {
      type: 'array', // the authoring guards, run as checks against THIS proposed spec
      items: {
        type: 'object',
        properties: {
          guard: { type: 'string' },   // e.g. "paths git-tracked", "test actually runs in gate", "construction site named"
          result: { type: 'string', enum: ['pass', 'fail', 'n/a'] },
          detail: { type: 'string' },
        },
        required: ['guard', 'result'],
      },
    },
    open_questions: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['observation', 'verdict', 'challenges', 'premise_checks'],
}

const FORGE_SCHEMA = {
  type: 'object',
  properties: {
    observation: { type: 'string' },
    status: { type: 'string', enum: ['drafted', 'needs-decision', 'dropped'] },
    spec_path: { type: 'string' },   // absolute path of the written draft
    title: { type: 'string' },       // the spec's one-line title
    open_questions: { type: 'array', items: { type: 'string' } },
    ledger_line: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['observation', 'status'],
}

const investigatePrompt = (o) => `You are a helm INTAKE INVESTIGATOR. The operator made ONE observation while walking a project repo; your whole job is to run it to ground. You are READ-ONLY: never edit files, never create worktrees or branches, never commit, never push. The repo's primary checkout may be dirty with live untracked work — that is normal and none of your business; you only read.

FIRST read the project config (Read tool): ${o.config} — it gives you repo_path (where to investigate), base_branch, baseline_check.

THE OBSERVATION (operator's words, verbatim — this is the intent you serve):
"${o.note}"
${o.hints ? `\nOPERATOR HINTS: ${o.hints}` : ''}

PROCEDURE:
1. Locate the code the observation is about. Prefer bounded searches (contextmink grep/files/slice/outline if available; else git grep) — don't read whole files when a slice answers.
2. Find the ROOT CAUSE — the defective mechanism, not a restatement of the symptom. Read the decisive lines yourself; a plausible story you didn't verify against the code is worthless downstream.
3. Gather EVIDENCE: file:line + the decisive fact, enough that a skeptic can re-check every claim without redoing your search.
4. Map BLAST RADIUS: who calls this, what shares the code path, what a fix could plausibly break.
5. Propose scope_dirs (the minimal allowlist a fix worker would need) and a verify candidate (a runnable command that would prove the fix — think delta-vs-base, and mirror the config's baseline_check gates).
6. NEVER GUESS on decisions. If the fix requires a genuine decision or preference the repo cannot answer (two plausible designs, a product call), put it in open_questions — do NOT pick one. Lookups answerable from the repo are YOUR job, not open questions.

Verdict: "confirmed" if you found the defect in the code; "not-reproduced" if the code contradicts the observation (say exactly what you found instead — the operator may have seen a different issue); "unclear" if you could not run it to ground (say what's missing).

Return the structured result. It is data, not prose — no filler.`

const skepticPrompt = (o, inv) => `You are a helm INTAKE SKEPTIC — the adversarial gate between an investigator's story and a spec the operator will trust. Your job is to REFUTE the investigation if it can be refuted. Default to suspicion: a scout summary is a lead, not ground truth (this rule is earned — see DECISIONS.md "a scout/audit summary is a lead"). READ-ONLY: never edit, never create worktrees/branches, never commit or push.

FIRST read the project config (Read tool): ${o.config} — repo_path, base_branch, baseline_check.

THE OPERATOR'S OBSERVATION (verbatim): "${o.note}"

THE INVESTIGATION TO ATTACK (JSON):
${JSON.stringify(inv, null, 2)}

PROCEDURE:
1. RE-VERIFY every load-bearing claim against the actual code. Open the cited file:line evidence yourself. Is the root cause the real mechanism, or a plausible narrative? Actively look for the alternative explanation the investigator would have missed.
2. RUN THE AUTHORING-GUARD PREMISE CHECKS against the proposed spec ingredients (these are the earned guards from ${helmRoot(o.config)}/templates/item.md — read that file's guard list first):
   - every proposed path is git-TRACKED on origin/<base_branch> (git ls-files / git check-ignore — NOT just present on disk);
   - the proposed verify could actually pass AND mirrors the config's full baseline_check gate set (no dropped gates);
   - if a new test is implied: the project's test gate would actually RUN it (check how the test script selects files — explicit list vs glob);
   - if a new dependency/method is implied: the ACTUAL construction site is named (git grep "new <TheClass>(" — do not assume src/index.ts);
   - proposed scope_dirs cover every file the fix must touch, and nothing in the config's deny_dirs.
3. Judge the open_questions: are they genuine decisions (keep), answerable-from-repo lookups (answer them yourself and strike them), or is there a MISSING question the investigator glossed over with an implicit choice (add it)?

Verdict: "confirmed" — root cause holds, premises pass. "revised" — the mechanism is real but the investigator got a load-bearing detail wrong; give revised_root_cause. "refuted" — the story does not survive contact with the code; say exactly why in challenges.

Return the structured result. Data, not prose.`

const forgePrompt = (o, inv, sk) => `You are the helm INTAKE FORGE. An observation has been investigated and adversarially checked; you now write the fully-fledged DRAFT spec. This is the front door of the whole system (DOCTRINE §0) — the spec's quality IS the leverage. You write ONE file inside the control-plane repo and nothing else: no target-repo edits, no worktrees, no commits, no QUEUE/plans writes.

FIRST read ALL of these in full (Read tool) — this is the gate where the repo philosophy and earned lessons enter the spec:
1. ${helmRoot(o.config)}/DOCTRINE.md — the principles (esp. §1 hand-authored, §2 discover-vs-decide, §4 verifiable-only, §10 delta verify, §11 model tier + hard rules).
2. ${helmRoot(o.config)}/templates/item.md — the EXACT spec template AND its authoring guards; every guard must be satisfied or explicitly addressed in the draft.
3. ${helmRoot(o.config)}/dispatch/KNOWN-ISSUES.md — live traps (e.g. worktree_provision).
4. The project config: ${o.config} — base_branch, baseline_check, deny_dirs, default model/effort.

THE OPERATOR'S OBSERVATION (verbatim — quote it in the draft, it is the authored intent): "${o.note}"

INVESTIGATION (JSON):
${JSON.stringify(inv, null, 2)}

SKEPTIC'S VERDICT (JSON) — where the skeptic corrected the investigator, the SKEPTIC wins:
${JSON.stringify(sk, null, 2)}

WRITE the draft to: ${helmRoot(o.config)}/projects/${o.project}/intake/${o.id}.md (Write tool creates the dir).

DRAFT FORMAT — exactly the templates/item.md shape (yaml block + Goal/Steps/Known-good reference/Out of scope/Done means), with these intake additions:
- TOP of file, before everything:
  > **STATUS: DRAFT — intake-forged, NOT operator-approved.** Do not queue or dispatch. Promotion =
  > operator reviews, edits, renames into plans/<real-id>.md and adds the QUEUE line; the clarity gate
  > applies there exactly as for a hand-authored item.
- yaml \`id:\` = a placeholder (\`${o.project}-NNN\`) — the operator assigns the real number at promotion. \`status: draft\`.
- \`model:\` per DOCTRINE §11 and its HARD RULES (irreversible-blast-radius diff → top-tier, no exceptions; work-item floor is the mid tier).
- \`verify:\` runnable, delta-based, mirrors the FULL baseline_check gate set. Scope greps/assertions to scope_dirs.
- After "Done means", add:
  ## Evidence (intake)
  <the confirmed file:line evidence table — what a clarity-pass worker can re-check>
  ## Adversarial check
  <skeptic verdict + which claims were corrected/demolished; premise-check results one per line>
  ## Open questions (operator decisions)
  <ONLY genuine decisions. If any exists that gates the steps, the steps must say "GATED ON Q1" at the gated step.
   Phrase each question OPEN-ENDEDLY: state the decision to be made, then offer repo-derived options as
   CANDIDATES only — never frame the question as a choice among existing structures. The operator's answer
   may be different in kind from anything the repo suggests (earned on the first intake run: the draft framed
   a grouping as "map the existing sections"; the operator's actual answer was a different taxonomy entirely,
   with items dropped from the surface altogether).>
  ## Provenance
  <operator observation verbatim; investigator + skeptic model tiers; date>

STATUS RULES:
- Skeptic verdict "refuted" → do NOT write a spec. Return status "dropped" with notes = why (the operator learns the observation was a mirage — that is a valid, useful outcome).
- Genuine open questions that gate the steps → still write the draft (steps marked GATED), return status "needs-decision".
- Otherwise → status "drafted".
- NEVER pad a vague observation into confident steps. A step must be executable by a fresh-context worker with no conversation; "handle errors appropriately"-grade hand-waves are forbidden (clarity gate rejects them anyway).

Return the structured result, with ledger_line in the harness format using status "intake":
<ts> | ${o.id} | intake | <verdict → drafted|needs-decision|dropped + one-clause why> | <draft path or ->
(ts is a placeholder — the orchestrator stamps real time.)`

const results = await pipeline(
  observations,
  // model tiers: 'haiku'=light, 'sonnet'=mid, 'opus'=top (DOCTRINE §11). A host on other models remaps.
  (o) => agent(investigatePrompt(o), {
    label: `investigate:${o.id}`, phase: 'Investigate',
    model: o.model || 'sonnet', effort: 'medium', schema: INVESTIGATE_SCHEMA,
  }),
  (inv, o) => {
    if (!inv) return null
    return agent(skepticPrompt(o, inv), {
      label: `skeptic:${o.id}`, phase: 'Skeptic',
      model: o.model || 'sonnet', effort: 'high', schema: SKEPTIC_SCHEMA,
    }).then((sk) => ({ inv, sk }))
  },
  (prev, o) => {
    if (!prev || !prev.sk) return prev ? { observation: o.id, status: 'failed', notes: 'skeptic returned null', inv: prev.inv } : null
    const { inv, sk } = prev
    if (sk.verdict === 'refuted') {
      // No spec from a demolished story — but the refutation itself is the deliverable.
      return {
        observation: o.id, status: 'dropped', spec_path: '',
        open_questions: sk.open_questions || [],
        notes: `REFUTED by skeptic: ${(sk.challenges || []).filter((c) => c.outcome === 'demolished').map((c) => c.finding).join(' | ') || sk.notes || 'see challenges'}`,
        ledger_line: `<ts> | ${o.id} | intake | refuted by skeptic — no spec forged | -`,
      }
    }
    return agent(forgePrompt(o, inv, sk), {
      label: `forge:${o.id}`, phase: 'Forge',
      model: o.model || 'sonnet', effort: 'high', schema: FORGE_SCHEMA,
    })
  },
)

return results.filter(Boolean)
