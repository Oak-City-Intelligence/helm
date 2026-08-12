// helm-dispatch-gauntlet — attended dispatcher for HIGH-STAKES items (DOCTRINE §12b + the review-gauntlet rule).
//
// Same isolation model as helm-dispatch.js, but every item passes a TWO-REVIEWER GAUNTLET before its PR
// opens — the control a direct-to-main commit once skipped on a high-blast-radius change. Use it for changes
// whose blast radius a mechanical `verify` cannot fully see (e.g. on-chain smart contracts, auth/payment
// paths, anything irreversible). Per item, independently and concurrently:
//   1. BUILD      — worker isolates off origin/<base>, executes the plan, verifies, commits+pushes the branch
//                   (NO PR yet). Returns the worktree path + branch + diff stat.
//   2. REVIEW x2  — two adversarial reviewers read the branch diff + plan + spec, in parallel:
//                     • scope-fidelity  — does the change match the spec Decision Record? any scope creep?
//                     • security        — the per-item security focus named in the plan's gauntlet section.
//   3. FIX (≤1)   — if either reviewer returns findings, a fix-agent addresses them on the SAME branch,
//                   re-verifies, re-pushes; then ONE re-review. Still-open findings → blocked for the operator
//                   (never loop, never ship past an unresolved finding).
//   4. PR         — only when BOTH reviewers are clean; the PR body records that the gauntlet ran + its focus.
//
// RUN IT via your agent runtime:  run({ scriptPath: "<this file>", args: { items: [ ... ] } })
// args.items[]: { id, project, github, base, branch, plan, config, model, spec }  (same as helm-dispatch, plus
//   spec — optional absolute path to the LOCKED spec the scope reviewer judges fidelity against.)
//
// This is the ATTENDED tier: high-stakes, top model tier. NOT for the drain loop — never put gauntlet items
// in QUEUE.json.

export const meta = {
  name: 'helm-dispatch-gauntlet',
  description: 'Dispatch high-stakes items through a build → two-reviewer gauntlet → fix → PR pipeline',
  phases: [
    { title: 'Build', detail: 'one worker per item: isolate, execute, verify, push branch (no PR)' },
    { title: 'Review', detail: 'two adversarial reviewers per item: scope-fidelity + security' },
    { title: 'Fix', detail: 'one fix round on findings, then re-review' },
    { title: 'PR', detail: 'open the PR only when both reviewers are clean' },
  ],
}

// HELM_ROOT derived from a config path: <root>/projects/<p>/config.yml → <root>
const helmRoot = (cfg) => cfg.split('/projects/')[0]

const _args = typeof args === 'string' ? JSON.parse(args) : (args || {})
const items = _args.items || []
if (!items.length) { log('no items passed — nothing to dispatch'); return [] }

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    item: { type: 'string' },
    status: { type: 'string', enum: ['built', 'blocked', 'failed'] },
    worktree_path: { type: 'string' },
    branch: { type: 'string' },
    diff_stat: { type: 'string' },
    verify_summary: { type: 'string' },
    block_question: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['item', 'status'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'findings'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          where: { type: 'string' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'problem'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['lens', 'verdict'],
}

const PR_SCHEMA = {
  type: 'object',
  properties: {
    item: { type: 'string' },
    status: { type: 'string', enum: ['done', 'failed'] },
    pr_url: { type: 'string' },
    branch: { type: 'string' },
    ledger_line: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['item', 'status'],
}

// Only blocker/major findings gate the PR; minors are noted in the PR body, not blocking.
const gating = (reviews) =>
  reviews.flatMap((r) => (r && r.verdict === 'findings' ? (r.findings || []) : []))
    .filter((f) => f.severity === 'blocker' || f.severity === 'major')

const buildPrompt = (it) => [
  'You are a helm GAUNTLET BUILDER executing ONE pre-authored, clarity-gated HIGH-STAKES item. Same rules as a fleet worker, with ONE difference: you do NOT open a PR — you build, verify, and push the branch, then STOP. Two adversarial reviewers gate your work before any PR.',
  '',
  'FIRST read these in full (Read tool):',
  '1. HARNESS: ' + helmRoot(it.config) + '/templates/worker-prompt.md',
  '2. PROJECT CONFIG: ' + it.config,
  '3. YOUR ITEM SPEC (esp. its "Two-reviewer gauntlet" done-condition): ' + it.plan,
  '',
  'ITEM: ' + it.id + ' → target repo ' + it.github + ', base ' + it.base + ', work branch ' + it.branch + '.',
  '',
  'PROCEDURE:',
  '1. CLARITY PASS (read-only, first, touch nothing). Restate the plan; list assumptions + anything undetermined. Any decision the repo itself cannot answer → STOP, status "blocked", crisp block_question. Do NOT guess — this is high-stakes code.',
  '2. ISOLATE — git worktree in the TARGET repo (repo_path from config, NOT the control-plane repo) on branch ' + it.branch + ' off origin/' + it.base + ', under the config worktree_root. Retry on lock.',
  '3. EXECUTE the plan steps EXACTLY, strictly within scope_dirs. Outside scope_dirs / inside deny_dirs → block.',
  '4. VERIFY — run the item verify command(s); they must exit 0. In-scope unambiguous failure → fix + re-run. Undetermined → block. Capture a short verify_summary.',
  '5. COMMIT under the project identity. NO AI ATTRIBUTION (harness §5) — subject + body + the config trailer only (read `commit_trailer`: absent or `none` → no trailer, the default; any other value used verbatim with `<id>` = ' + it.id + '). PUSH the branch. Do NOT open a PR.',
  '6. Capture the diff for the reviewers: run `git diff --stat origin/' + it.base + '...' + it.branch + '` and put it in diff_stat.',
  '',
  'Return the structured result: status "built" only if verify passed and the branch is pushed; include worktree_path (absolute) and branch so the reviewers and any fix step operate on the SAME place. status "blocked"/"failed" otherwise. The structured return IS your report.',
].join('\n')

const reviewPrompt = (it, build, lens) => {
  const focus = lens === 'scope'
    ? [
        'You are the SCOPE-FIDELITY reviewer. Judge ONLY whether the change faithfully implements the item spec and (if present) the LOCKED spec Decision Record — no scope creep, no missing requirement, no drift from the settled design.',
        it.spec ? ('LOCKED spec to judge fidelity against: ' + it.spec) : 'No separate spec path passed — judge against the item plan.',
        'Check: every step in the plan is done; nothing OUTSIDE scope_dirs changed; no adjacent feature was touched; the plan\'s "Out of scope" list was respected; any size/blast-radius constraint the plan names (e.g. a byte-size limit, an untouched-component invariant) is honored.',
      ]
    : [
        'You are the SECURITY reviewer. Adversarially hunt for value-loss and access-control defects. Default to skepticism — a finding you are unsure about is still a finding.',
        'Use the per-item security focus named in the plan\'s "Two-reviewer gauntlet" section as your checklist. Generally: access control on sensitive/value-moving functions, value conservation (no leak/double-count), reentrancy on new external calls / transfers, double-spend / double-refund reverts, that any "lever-off"/default path is behaviorally identical to before, and that new reverts/guards actually fire.',
      ]
  return [
    'You are a helm ADVERSARIAL REVIEWER in the two-reviewer gauntlet. READ-ONLY — do NOT edit, commit, or open anything.',
    ...focus,
    '',
    'ITEM: ' + it.id + '. Plan: ' + it.plan + '. Target repo: ' + it.github + '.',
    'The build is on branch ' + build.branch + ', worktree at ' + (build.worktree_path || '(see config worktree_root)') + '.',
    'Review the diff: cd into the worktree and read `git diff origin/' + it.base + '...' + build.branch + '` in full, and open the changed files for context. Re-run the item verify if useful, but your job is judgment, not just green checks.',
    '',
    'Return REVIEW_SCHEMA: lens="' + lens + '"; verdict "pass" if you would let this merge, "findings" otherwise. Each finding: severity (blocker|major|minor), where (file:line), problem (concrete failure scenario), fix (the minimal change). blocker/major gate the PR; minor is advisory. Be specific and correct — a false blocker wastes a fix round, a missed blocker ships a bug.',
  ].join('\n')
}

const fixPrompt = (it, build, findings) => [
  'You are a helm GAUNTLET FIX agent. Two adversarial reviewers found issues in the high-stakes change on branch ' + build.branch + '. Address ALL blocker/major findings on the SAME branch, re-verify, and re-push. Do NOT open a PR.',
  '',
  'ITEM: ' + it.id + '. Plan: ' + it.plan + '. Worktree: ' + (build.worktree_path || '(from config worktree_root)') + '. Target repo: ' + it.github + '.',
  '',
  'FINDINGS to resolve (JSON):',
  JSON.stringify(findings, null, 2),
  '',
  'PROCEDURE: re-enter the existing worktree on branch ' + build.branch + '. Fix each finding, staying strictly within scope_dirs. Re-run the item verify (must exit 0). Commit the fixes (NO AI attribution; the config trailer — `commit_trailer`, absent or `none` → no trailer, the default; any other value used verbatim with `<id>` = ' + it.id + ') and push. If a finding demands a decision the repo/plan cannot answer, do NOT guess — return status "blocked" with the block_question.',
  '',
  'Return BUILD_SCHEMA: status "built" if all blocker/major findings are fixed and verify is green; "blocked"/"failed" otherwise. Keep worktree_path + branch.',
].join('\n')

const prPrompt = (it, build, reviews) => [
  'You are a helm GAUNTLET PR agent. The change on branch ' + build.branch + ' has PASSED the two-reviewer gauntlet (scope-fidelity + security). Open its PR.',
  '',
  'ITEM: ' + it.id + '. Target repo: ' + it.github + '. Base: ' + it.base + '. Branch: ' + build.branch + '.',
  'Gauntlet review summaries (fold a one-line-per-lens note into the PR body so the operator sees the gauntlet ran):',
  JSON.stringify(reviews.map((r) => ({ lens: r && r.lens, verdict: r && r.verdict, summary: r && r.summary })), null, 2),
  '',
  'Open the PR (ALWAYS pass --repo; the default gh account may differ from the project identity):',
  '  gh pr create --repo ' + it.github + ' --base ' + it.base + ' --head ' + build.branch + ' --title "<the item title>" --body "<what changed + verify summary + a GAUNTLET line: both reviewers passed, with their focus — NO AI attribution>"',
  'NOTE: if this is a security fix on a PUBLIC repo, the PR body states WHAT was hardened, NOT the exploit mechanics (DECISIONS.md earned lesson). Capture the PR URL. Build the one-line LEDGER entry in the harness format (<ISO-ts> | ' + it.id + ' | done | <note, incl. \'gauntlet: 2 reviewers passed\'> | <pr-url>). Return it in ledger_line — do not write it to disk.',
  '',
  'Return PR_SCHEMA: status "done" only if the PR is open; else "failed" with notes.',
].join('\n')

const results = await parallel(items.map((it) => async () => {
  // 1. BUILD
  // model tiers: 'haiku'=light, 'sonnet'=mid, 'opus'=top (DOCTRINE §11). A host on other models remaps.
  const build = await agent(buildPrompt(it), {
    label: 'build:' + it.id, phase: 'Build', model: it.model || 'opus', effort: 'high', schema: BUILD_SCHEMA,
  })
  if (!build) return { item: it.id, status: 'failed', notes: 'build agent returned null' }
  if (build.status !== 'built') {
    return { item: it.id, status: build.status, block_question: build.block_question, notes: build.notes }
  }

  // 2. REVIEW x2 (parallel, adversarial)
  const review = () => parallel([
    () => agent(reviewPrompt(it, build, 'scope'), { label: 'review-scope:' + it.id, phase: 'Review', model: 'opus', effort: 'high', schema: REVIEW_SCHEMA }),
    () => agent(reviewPrompt(it, build, 'security'), { label: 'review-sec:' + it.id, phase: 'Review', model: 'opus', effort: 'high', schema: REVIEW_SCHEMA }),
  ]).then((rs) => rs.filter(Boolean))

  let reviews = await review()
  let blockers = gating(reviews)

  // 3. FIX (≤1 round) then re-review once
  if (blockers.length) {
    const fix = await agent(fixPrompt(it, build, blockers), {
      label: 'fix:' + it.id, phase: 'Fix', model: 'opus', effort: 'high', schema: BUILD_SCHEMA,
    })
    if (!fix || fix.status !== 'built') {
      return { item: it.id, status: 'blocked',
        block_question: 'gauntlet findings could not be auto-fixed — operator review needed. ' + (fix && fix.block_question ? fix.block_question : ''),
        notes: JSON.stringify(blockers) }
    }
    reviews = await review()
    blockers = gating(reviews)
    if (blockers.length) {
      return { item: it.id, status: 'blocked',
        block_question: 'gauntlet findings persist after one fix round — operator review needed before this high-stakes change can ship.',
        notes: JSON.stringify(blockers) }
    }
  }

  // 4. PR (both reviewers clean)
  const pr = await agent(prPrompt(it, build, reviews), {
    label: 'pr:' + it.id, phase: 'PR', model: 'sonnet', effort: 'medium', schema: PR_SCHEMA,
  })
  if (!pr) return { item: it.id, status: 'failed', notes: 'PR stage returned null', branch: build.branch }
  return pr
}))

return results.filter(Boolean)
