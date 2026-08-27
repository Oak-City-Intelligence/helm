// helm-audit — the read-only audit dispatcher.
//
// Differs from helm-dispatch in the one way that matters: an audit lane produces FINDINGS, not code.
// No branch, no push, no PR. Each lane runs two agents in a pipeline:
//   1. AUDITOR  — multi-lens read over a PINNED read-only tree; returns candidate findings, nothing else.
//   2. SKEPTIC  — independent, never sees the auditor's reasoning as authority; its job is to REFUTE
//                 every candidate. It then writes the lane's report file (survivors + refuted section).
//
// The skeptic is not a formality. In the run that made this the house standard, the auditor raised nine
// candidates on a high-stakes protocol and the skeptic killed all nine — including the two that would
// have mattered most had they been real. An audit that only generates is an audit that inflates.
//
// RUN IT — from a shell, through the agent host (dispatch/RUNTIME.md):
//   node dispatch/agent-host.js dispatch/helm-audit.js --args-file args.json
// where args.json carries the payload below. Under a workflow-script runtime that injects the globals
// itself, the equivalent is:
//   run({ scriptPath: "<this file>", args: {
//     lanes: [ { id, lane, plan, report } ],  // plan = the lane's charter file; report = output filename
//     tree:  "<abs path>",                    // a PINNED, read-only checkout of the audited repo
//     sha:   "<commit>",                      // what that checkout is pinned to
//     charter: "<abs path>",                  // OPTIONAL: the charter set every lane reads first
//     priors: [ "<abs path>", ... ],          // OPTIONAL: previous reports — INPUT, never a boundary
//     report_dir: "<abs path>",               // where reports are written (helm state, NOT the tree)
//     blocking: "release",                    // what a finding can block; names the yes/no field
//   } })
//
// Requires the workflow-script runtime (see RUNTIME.md) — `agent`, `pipeline`, `phase`, `log`, `args`.

export const meta = {
  name: 'helm-audit',
  description: 'Run read-only audit charters: multi-lens auditor per lane, independent skeptic refutes, report written',
  phases: [
    { title: 'Audit', detail: 'one top-tier auditor per lane over the pinned tree — candidates only, no fixes' },
    { title: 'Skeptic', detail: 'independent refutation of every candidate; writes the lane report' },
  ],
}

const _args = typeof args === 'string' ? JSON.parse(args) : (args || {})
const lanes = _args.lanes || []
const TREE = _args.tree
const SHA = _args.sha || '(unpinned)'
const CHARTER = _args.charter || ''
const PRIORS = _args.priors || []
const REPORT_DIR = _args.report_dir || ''
const BLOCKING = _args.blocking || 'release'      // the gate a finding can block: release, deploy, launch…
const TOOLS = _args.search_tool || ''             // OPTIONAL: a bounded-output search tool invocation

if (!lanes.length) { log('no lanes passed — nothing to dispatch'); return [] }
if (!TREE) { log('no pinned tree passed — refusing to audit a moving target'); return [] }
if (!REPORT_DIR) { log('no report_dir passed — a report written into the audited tree is a rule violation'); return [] }

const CANDIDATES_SCHEMA = {
  type: 'object',
  properties: {
    lane: { type: 'string' },
    surface_summary: { type: 'string' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          site: { type: 'string' },            // file:line
          reach_sequence: { type: 'string' },  // the call sequence that gets there
          at_risk: { type: 'string' },
          blocking: { type: 'boolean' },       // does this block the gate named by args.blocking?
          lens: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['title', 'site', 'reach_sequence', 'at_risk', 'blocking'],
      },
    },
    vacuous_gate_sweep: { type: 'string' },   // mandatory in every lane
    coverage_notes: { type: 'string' },       // what was read, what was NOT reached and why
  },
  required: ['lane', 'candidates', 'vacuous_gate_sweep'],
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    lane: { type: 'string' },
    report_path: { type: 'string' },
    verdict: { type: 'string' },
    blocking: { type: 'boolean' },
    survived: { type: 'number' },
    refuted: { type: 'number' },
    headline_findings: { type: 'array', items: { type: 'string' } },
    ledger_line: { type: 'string' },
  },
  required: ['lane', 'report_path', 'verdict', 'blocking', 'survived', 'refuted'],
}

const READONLY = `HARD CONSTRAINT — THIS IS A READ-ONLY AUDIT.
You may NOT edit, create, or delete a single file under ${TREE}. No fixes, no "while I was there" cleanups,
no test additions, no formatting. You may run read-only commands (grep, build, test, inspect) but you may
not change the tree to make one pass. If you catch yourself reaching for Edit/Write on the target repo,
that is the finding — write it down instead.
A finding is NOT a work order. Every defect goes through the spec gate: audit intent, write a spec, the
operator approves, only then does anyone build. The operator decides what gets built; you do not.`

const readFirst = (it) => [
  CHARTER && `${CHARTER} — the charter set: method, prior coverage, and the systemic invariants that must hold at EVERY site.`,
  `${it.plan} — YOUR lane charter: its lenses, its scope, and its "Done means".`,
  ...PRIORS.map((p) => `${p} — a PRIOR report. It is INPUT, not a boundary. Re-verify its conclusions where they meet your lane; do not re-walk its ground blind.`),
].filter(Boolean).map((s, i) => `${i + 1}. ${s}`).join('\n')

const auditorPrompt = (it) => `You are a helm AUDITOR running ONE read-only audit lane.

READ FIRST, in full:
${readFirst(it)}

TARGET: ${TREE} — a PINNED, read-only checkout at ${SHA}. If the repo vendors its dependencies, the pinned
library sources under it are readable and are the AUTHORITY on library behavior. Never guess what a
dependency does — open it.

${READONLY}

METHOD — the charter's, non-negotiable:
- **Run your lenses as SEPARATE reads**, not one pass. The charter names them. One sweep per lens.
- **A candidate must carry: file:line, the exact sequence that REACHES it, what is actually at risk, and a
  ${BLOCKING}-blocking yes/no.** "Looks wrong" is not a finding and will be thrown out by the skeptic.
- **The vacuous-gate sweep is MANDATORY.** For each guard/test in your scope ask: would this still pass if
  the thing it guards were deleted? Three gates in one repo were found green-but-asserting-nothing this way.
- **Comment/behavior drift COUNTS as a finding class.** In the precedent run the only two survivors were
  exactly this: a docstring naming the wrong error selector, and a comment promising a CI gate never wired.
- **Report what you could NOT reach and why** in coverage_notes. An honest gap beats a confident guess.
${TOOLS ? `\nSearch with \`${TOOLS}\` rather than raw grep/cat where it fits — it caps output. Unbounded reads are\nre-charged on every later turn.\n` : ''}
DO NOT self-censor candidates to look decisive, and do NOT pad the list to look thorough. An independent
skeptic reads every candidate next and its explicit job is to refute them. Give it your honest set with the
evidence it needs to check you. Precision over volume: on high-stakes code, a buried real finding is a failure.

Return the structured object. Your text output IS the return value — no human-facing preamble.`

const skepticPrompt = (it, cand) => `You are an INDEPENDENT SKEPTIC. An auditor just swept lane ${it.lane} and
produced the candidate findings below. **Your job is to REFUTE them.** In the precedent run the skeptic killed
nine of nine candidates, including the two that would have mattered most had they been real. Assume the same
is likely here. Default to REFUTED when you cannot prove reach.

TARGET: ${TREE} — pinned read-only checkout at ${SHA}. Vendored dependency source, if present, is the
authority on dependency behavior. ${READONLY}

You did not do the auditor's read and you must not inherit its confidence. For EACH candidate:
1. Open the cited file:line yourself. Does the code say what the candidate claims?
2. Walk the claimed reach sequence yourself. Is there a guard, a modifier, a caller-side check, a counter,
   or a library behavior that makes it unreachable? A candidate that cannot be REACHED is refuted, however
   ugly the code is.
3. Check whether an existing test already pins the behavior — and whether that test is itself vacuous.
4. If it survives: is the "at risk" claim honest, and is ${BLOCKING}-blocking right? Downgrade freely.

A candidate survives ONLY if you personally verified the site, the reach, and the consequence.

CANDIDATES (auditor's words — evidence, not authority):
${JSON.stringify(cand?.candidates ?? [], null, 2)}

AUDITOR'S VACUOUS-GATE SWEEP: ${cand?.vacuous_gate_sweep ?? '(none returned)'}
AUDITOR'S COVERAGE NOTES: ${cand?.coverage_notes ?? '(none returned)'}
AUDITOR'S SURFACE SUMMARY: ${cand?.surface_summary ?? '(none returned)'}

THEN WRITE THE LANE REPORT — this is the deliverable, and the ONLY file you may write:
  ${REPORT_DIR}/${it.report}
(That path is helm control-plane state, NOT the audited tree. Writing anything under ${TREE} is forbidden.)

Structure it exactly so:
- **One-line verdict**, then an explicit **${BLOCKING}-blocking: yes/no**.
- The lane and the pinned sha ${SHA}.
- **Surviving findings only** — each with file:line, reach sequence, what is at risk, ${BLOCKING}-blocking,
  and what YOU did to verify it. If nothing survived, say so plainly; that is a real and useful result.
- The **vacuous-gate sweep** result for the lane.
- **Coverage**: what was read, and what was not reached and why.
- A closing **"Refuted candidates"** section naming each killed candidate and the one-line reason it died,
  so the next reader does not re-raise it.
Read the lane charter's "Done means" (${it.plan}) and satisfy it literally.

Tone: forensic and plain. Be blunt about mechanism, but never overstate what you verified. This report is
written for the operator, not for publication: if the audited repo is public, a defect that is not yet fixed
must not be described in anything pushed to it (see \`templates/worker-prompt.md\` rules 6-7 — the full
mechanism goes in the operator's private record, never in a public PR body).

Return the structured object; the report file is the real artifact.`

phase('Audit')
const results = await pipeline(
  lanes,
  (it) => agent(auditorPrompt(it), {
    label: `audit:${it.lane}:${it.id}`, phase: 'Audit', model: 'opus', effort: 'high', schema: CANDIDATES_SCHEMA,
  }),
  (cand, it) => agent(skepticPrompt(it, cand), {
    label: `skeptic:${it.lane}:${it.id}`, phase: 'Skeptic', model: 'opus', effort: 'high', schema: REPORT_SCHEMA,
  }).then((r) => ({ ...r, id: it.id, lane: it.lane, candidates_raised: (cand?.candidates ?? []).length })),
)

const done = results.filter(Boolean)
log(`${done.length}/${lanes.length} lanes reported · ${done.filter((r) => r.blocking).length} ${BLOCKING}-blocking`)
return { sha: SHA, tree: TREE, lanes: done, missing: lanes.filter((l) => !done.some((d) => d.id === l.id)).map((l) => l.id) }
