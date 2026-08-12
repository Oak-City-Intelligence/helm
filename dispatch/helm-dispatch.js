// helm-dispatch — the burst-mode dispatcher (DOCTRINE §12b).
//
// Drains a set of clarity-gated queue items: one isolated fleet worker per item, in parallel.
// Each worker reads the fixed harness + project config + its own plan, runs the clarity pass,
// blocks-rather-than-guesses, isolates in a worktree of the TARGET repo, executes within scope,
// verifies, commits (NO AI attribution), pushes, and opens a PR. Returns structured results only.
//
// RUN IT via your agent runtime's workflow/script surface:
//   run({ scriptPath: "<this file>", args: { items: [ ... ] } })
//
// args.items[]: { id, project, github, base, branch, plan, config, model }
//   id      — item id, e.g. "example-006"
//   github  — target repo "owner/name" for `gh pr create --repo`
//   base    — base branch to branch off + PR into
//   branch  — the work branch name
//   plan    — absolute path to plans/<id>.md
//   config  — absolute path to the project config.yml
//   model   — model tier per DOCTRINE §11 task-weighting
//
// NOTE (DOCTRINE §12b): the runtime `args` may arrive JSON-encoded — parse defensively, or the run
// silently no-ops on empty inputs. A [] / 0-agent result means "did nothing", never "success".
//
// PATHS: the harness path is derived from each item's config path (which is
// <HELM_ROOT>/projects/<project>/config.yml), so this script carries no absolute machine paths.

export const meta = {
  name: 'helm-dispatch',
  description: 'Drain a set of clarity-gated helm queue items: one isolated fleet worker per item, execute→verify→PR',
  phases: [{ title: 'Dispatch', detail: 'one fleet worker per ready item (isolated worktree, verify, PR)' }],
}

// HELM_ROOT derived from a config path: <root>/projects/<p>/config.yml → <root>
const helmRoot = (cfg) => cfg.split('/projects/')[0]

const _args = typeof args === 'string' ? JSON.parse(args) : (args || {})
const items = _args.items || []
if (!items.length) { log('no items passed — nothing to dispatch'); return [] }

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    item: { type: 'string' },
    status: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    failure_class: { type: 'string', enum: ['transient', 'real'] }, // only meaningful when status=failed
    pr_url: { type: 'string' },
    branch: { type: 'string' },
    verify_summary: { type: 'string' },
    block_question: { type: 'string' },
    ledger_line: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['item', 'status'],
}

// Bounded retry for TRANSIENT (env/infra) failures only — a hung npm install or a worktree lock is not a
// block. A fresh re-dispatch gets a new worktree + warm cache. Real failures and decision-blocks are never
// auto-retried.
const MAX_TRANSIENT_RETRIES = 2

const workerPrompt = (it) => `You are a helm FLEET WORKER executing ONE pre-authored, clarity-gated queue item end-to-end and AUTONOMOUSLY. You are the labor that multiplies the operator's effort — he authored the spec; you execute it without him in the loop. Follow the fixed harness EXACTLY.

FIRST, read these THREE files in full (use the Read tool):
1. HARNESS (your operating rules, non-negotiable): ${helmRoot(it.config)}/templates/worker-prompt.md
2. PROJECT CONFIG (repo_path, base_branch, worktree_root, identity, done_via, baseline_check): ${it.config}
3. YOUR ITEM SPEC (scope_dirs, steps, verify, block conditions): ${it.plan}

ITEM: ${it.id} → target repo ${it.github || '(local-only — no hosted repo)'}, base branch ${it.base}, work branch ${it.branch}.

PROCEDURE (from the harness — obey it):
1. CLARITY PASS — read-only, FIRST, touch nothing. Read the plan and the relevant repo code. Restate in your own words what you will do; list every assumption; list anything undetermined. If ANY undetermined decision the repo itself cannot answer → STOP and return status "blocked" with a crisp block_question. You've spent almost nothing. Do NOT guess.
2. ISOLATE — create a git worktree in the TARGET repo (repo_path from the config, NOT the control-plane repo) on branch ${it.branch} off ${it.base}, under the config's worktree_root. If \`git worktree add\` hits a lock (parallel workers), wait a moment and retry. THEN PROVISION: if the config has a non-empty \`worktree_provision\` list, run each command verbatim, substituting \`{repo_path}\` with the config's repo_path and \`{worktree}\` with the absolute path of the worktree you just created — do this BEFORE any build/verify. It mirrors gitignored/floating deps the fresh worktree lacks; skipping it phantom-reds builds that depend on them (dispatch/KNOWN-ISSUES.md #1). Absent/empty list → skip.
3. EXECUTE the plan steps EXACTLY, staying strictly within scope_dirs. Needing to touch anything outside scope_dirs or inside deny_dirs → block.
4. VERIFY — run the item's verify command(s); they must exit 0. If a failure is in-scope and unambiguous, fix and re-run. If it implies an undetermined decision → block. Capture a short verify_summary (what ran, what passed).
5. DISCLOSURE CHECK before you write ANY commit message, PR title/body, runbook, or test fixture (harness rule 6). Assume everything you push is PUBLIC and PERMANENT unless the config's \`disclosure.repo_visibility\` says otherwise — and a force-push does not un-publish. NEVER carry into pushed prose or committed files: customer/user names or their named assets, production record ids, production db names/hosts/URIs, production counts or balances, or any credential. The PLAN IS PRIVATE and may hand you exactly that detail — translate it structurally ("a migrated record carrying X and no Y"), never republish it. Measured production numbers go in the LEDGER line, not the repo. Name fixtures neutrally. If you cannot describe the work without disclosing → block.
6. TONE — commit messages and PR bodies are public product record, not an incident post-mortem (harness rule 7). Accurate and complete, but NEVER self-indicting: state what changed and why, mechanically and forward-looking. Describe the DEFECT, not our failure to catch it. No editorializing ("meaningless", "silently broken since go-live", "nobody noticed for months"), no counting how long something was wrong, no narrating our own process failures, no judgment on prior code (it is "the earlier implementation"). This governs FRAMING ONLY — never soften a security implication, drop a caveat, or overstate what was verified. The blunt forensic version goes in your returned LEDGER line, which is private.
7. COMMIT under the project identity. **NO AI ATTRIBUTION** — no \`Co-Authored-By: Claude\`, no "Generated with Claude Code", no 🤖 footer (harness §5). Commit = subject + body + the config's trailer, nothing else — read \`commit_trailer\` from the config: absent or the literal \`none\` → NO trailer, which is the default; any other value is used verbatim with \`<id>\` substituted (\`${it.id}\`).
8. TERMINATE per the config's \`done_via\`:
${it.github ? `   PUSH branch ${it.branch}, then open the PR:
   \`gh pr create --repo ${it.github} --base ${it.base} --head ${it.branch} --title "<the item title>" --body "<what changed + verify summary — NO AI attribution>"\`
   ALWAYS pass --repo (the default gh account may differ from the project's identity). Capture the PR URL.` : `   BRANCH MODE (\`done_via: branch\` — a repo on a self-hosted forge, or one with no PR surface). Never touch \`gh\`. Strictly AFTER the identity guard exits clean: push the branch to the config's origin, then open the PR through that forge's own API, reading its token from the path the config names. Capture the returned URL as pr_url.
   If the token is missing, the push is rejected, or the API errors: the item is STILL done via the local branch — report pr_url "" and say exactly what failed in notes. NEVER retry-push past an identity-guard failure; a guard hit is a hard block, not a push obstacle.`}
   Leave the worktree in place for the operator's review — \`dispatch/reap-worktrees.sh\` sweeps it once the branch lands in the base and the tree is 3+ days old, so never clean up after yourself.
9. Build the one-line LEDGER entry in the EXACT format from the harness (\`<ISO-ts> | <item-id> | <status> | <note> | <pr-url-or-branch>\`). Get the real timestamp via Bash \`date -u +%Y-%m-%dT%H:%M:%SZ\` — never a placeholder. Do not write it to disk — return it.

Return the structured result. status "done" only if verify passed AND the deliverable exists (${it.github ? 'the PR is open' : `the commit is on branch ${it.branch}`}). If you blocked, status "blocked" + block_question (pr_url empty). If verify failed unrecoverably, status "failed" + notes. The structured return IS your report — write no prose elsewhere.`

// --- Pre-flight baseline gate (DOCTRINE §10 made real) ---
// The dispatcher runs in a sandbox (no fs/exec), so the baseline can't run inline — it runs as ONE agent per
// distinct (config, base) BEFORE the worker fan-out. If the base is red, we do NOT dispatch onto it: N workers
// would each block on a defect that isn't theirs. A red base becomes a single, clear "fix the baseline first"
// signal instead of N wasted, confusing blocks.
// Pass args.skip_baseline:true to bypass (e.g. a re-dispatch where the base is known-green).
const SKIP_BASELINE = !!_args.skip_baseline
const BASELINE_SCHEMA = {
  type: 'object',
  properties: {
    green: { type: 'boolean' },
    failing_command: { type: 'string' }, // the first gate step that failed (empty if green)
    summary: { type: 'string' },         // what ran / what failed — short
  },
  required: ['green', 'summary'],
}

const baselinePrompt = (config, github, base) => `You are a helm PRE-FLIGHT BASELINE checker. Verify the BASE is green BEFORE any worker is dispatched onto it. Read-only w.r.t. the repo's tracked state — you create a throwaway worktree, run the gate, report, and clean up. Do NOT edit code, commit, or push.

STEPS:
1. Read the project config: ${config}. Extract \`repo_path\`, \`worktree_root\`, the \`baseline_check\` block (the exact gate command(s) — it MUST mirror the repo's real CI; ci-audit.js enforces that), and the OPTIONAL \`worktree_provision\` list.
2. In repo_path: \`git fetch origin ${base}\`. Create a throwaway worktree off \`origin/${base}\` (NOT the local base — the local checkout can be stale/polluted) under worktree_root, e.g. branch name \`_baseline-preflight\`.
2b. PROVISION (if \`worktree_provision\` is present and non-empty): run each command verbatim, substituting \`{repo_path}\` with the config's repo_path and \`{worktree}\` with the absolute path of the worktree you just created. These provision gitignored/floating deps that a fresh worktree lacks — WITHOUT them the gate phantom-reds (see dispatch/KNOWN-ISSUES.md #1). A provision command failing is a TRANSIENT env failure (retry up to 2×), not a red base. If the list is absent or empty, skip this step.
3. Run the \`baseline_check\` command(s) verbatim in that worktree. Classify like a worker: a hung/timed-out install or a registry/network blip is TRANSIENT — retry up to 2× before calling it; a genuine gate failure (typecheck/lint/fmt/test/build non-zero) is REAL and means the base is RED.
4. Clean up: remove the throwaway worktree (\`git worktree remove --force\`).

Return {green, failing_command, summary}. green=true ONLY if every baseline_check step exited 0. If a REAL gate step failed, green=false and failing_command = the exact step (e.g. "npm run build"), summary = the shortest decisive error line. This is data, not prose.`

phase('Baseline')
async function checkBaseline(it) {
  const r = await agent(baselinePrompt(it.config, it.github, it.base), {
    label: `baseline:${it.github.split('/')[1]}@${it.base}`,
    phase: 'Baseline',
    // model tiers: 'haiku'=light, 'sonnet'=mid, 'opus'=top (DOCTRINE §11). A host on other models remaps.
    model: 'haiku',
    effort: 'low',
    schema: BASELINE_SCHEMA,
  })
  return r
}

// Group items by (config, base) so the baseline runs once per distinct base, not once per item.
const groups = {}
for (const it of items) {
  const key = `${it.config}::${it.base}`
  ;(groups[key] = groups[key] || []).push(it)
}
const greenItems = []
const abortedResults = []
// A group is exempt from the pre-flight if it carries a baseline_fix item (DOCTRINE §10 escape hatch): such an
// item exists to make a RED base green, so it MUST run against the red base — its own verify IS the baseline
// turning green. Gating it would deadlock (it can never pass the gate it's meant to fix).
const isFixGroup = (grp) => grp.some((it) => it.baseline_fix)
if (SKIP_BASELINE) {
  log('skip_baseline set — dispatching without pre-flight')
  greenItems.push(...items)
} else {
  const keys = Object.keys(groups)
  const gated = keys.filter((k) => !isFixGroup(groups[k]))
  for (const k of keys) {
    if (isFixGroup(groups[k])) { log(`baseline_fix group ${k} — bypassing pre-flight (runs against red by design)`); greenItems.push(...groups[k]) }
  }
  const checks = await parallel(gated.map((k) => () => checkBaseline(groups[k][0]).then((r) => ({ k, r }))))
  for (const { k, r } of checks.filter(Boolean)) {
    const grp = groups[k]
    if (r && r.green) {
      greenItems.push(...grp)
    } else {
      const why = r ? `${r.failing_command || 'baseline'} — ${r.summary}` : 'baseline check errored'
      log(`RED BASE for ${k} — NOT dispatching ${grp.length} item(s): ${why}`)
      for (const it of grp) {
        abortedResults.push({
          item: it.id,
          status: 'blocked',
          block_question: `Base ${it.github}@${it.base} is RED (pre-flight baseline failed: ${why}). Fix the baseline first (author a baseline-fix item), then re-dispatch. Not dispatched — no worker effort spent.`,
          ledger_line: `<ts> | ${it.id} | blocked | pre-flight: base red (${why}); not dispatched | -`,
        })
      }
    }
  }
}
// Any key whose baseline agent died entirely (filtered out above) — surface rather than silently drop.
for (const k of Object.keys(groups)) {
  const seen = greenItems.some((it) => `${it.config}::${it.base}` === k) ||
    abortedResults.some((a) => groups[k].some((it) => it.id === a.item))
  if (!seen && !SKIP_BASELINE) {
    for (const it of groups[k]) {
      abortedResults.push({ item: it.id, status: 'blocked', block_question: `Pre-flight baseline agent did not return for ${k}; not dispatched (fail-safe). Re-run.`, ledger_line: `<ts> | ${it.id} | blocked | pre-flight baseline no-result; not dispatched | -` })
    }
  }
}

phase('Dispatch')
async function dispatchOne(it, attempt = 1) {
  const suffix = attempt > 1 ? ` (retry ${attempt - 1})` : ''
  const r = await agent(workerPrompt(it), {
    label: `worker:${it.id}${suffix}`,
    phase: 'Dispatch',
    model: it.model || 'sonnet',
    effort: 'medium',
    schema: WORKER_SCHEMA,
  })
  if (r && r.status === 'failed' && r.failure_class === 'transient' && attempt <= MAX_TRANSIENT_RETRIES) {
    log(`transient failure on ${it.id} (attempt ${attempt}) — re-dispatching fresh`)
    return dispatchOne(it, attempt + 1)
  }
  return r
}

if (!greenItems.length) {
  log('no green base to dispatch onto — all items blocked on pre-flight')
  return abortedResults
}
const results = await parallel(greenItems.map((it) => () => dispatchOne(it)))
return [...results.filter(Boolean), ...abortedResults]
