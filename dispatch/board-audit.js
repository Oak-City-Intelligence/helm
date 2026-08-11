#!/usr/bin/env node
// board-audit — the guard against BOARD ROT (DOCTRINE §17 applied to the board, not the repo).
//
// Board rot = a board file asserting something that stopped being true, with nothing to catch it.
// Six instances were found by hand across two seats; every one cost a worker
// run or a wrong decision, and every one was silent. This is the mechanical check that makes the tedious
// pass/fail walk unnecessary.
//
// POSTURE — read this before changing anything:
//   * READ-ONLY. It NEVER edits a board file. A wrong auto-correction looks authoritative and is worse
//     than a stale line. It prints a diff between what the board asserts and what is true; the captain
//     reads the finding and writes the fix.
//   * CAPTAIN-INVOKED. Not a daemon, not a systemd unit. Whether any helm service runs unattended is a
//     standing operator call; this tool exists so that decision never has to be reopened to get the check.
//   * NO MODEL IN THE LOOP. Every check is `gh`, `git`, or `curl`. Cheap enough to run at every seat start
//     and every seat close.
//   * NEVER READS A WORKING TREE. Primary checkouts drift (one of ours sat on a stale detached HEAD for
//     weeks); a tool that reads them produces confident garbage. All source truth is `origin/<base>`.
//
//   node dispatch/board-audit.js                        # every project, every check
//   node dispatch/board-audit.js --project example     # one project
//   node dispatch/board-audit.js --checks pr,prod       # subset: pr,ready,blocked,paths,prod
//   node dispatch/board-audit.js --json                 # machine output
//   node dispatch/board-audit.js --no-fetch             # skip `git fetch` (offline / already fresh)
//
// Exit 0 = board agrees with reality. Exit 1 = findings printed. Exit 2 = the tool itself failed.
// No deps.

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const HELM = path.resolve(__dirname, '..')
const PROJECTS = path.join(HELM, 'projects')
const CHECKS = ['pr', 'ready', 'blocked', 'paths', 'prod', 'schema']

// ---------- args ----------
const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? dflt : (argv[i + 1] || dflt)
}
const flag = (name) => argv.includes(`--${name}`)
const ONLY_PROJECT = opt('project', null)
const ONLY_CHECKS = new Set((opt('checks', CHECKS.join(',')) || '').split(',').map(s => s.trim()).filter(Boolean))
const AS_JSON = flag('json')
const NO_FETCH = flag('no-fetch')
const PR_LIMIT = parseInt(opt('pr-limit', '500'), 10)

const findings = []
const notes = []
// severity: STALE = the board asserts something false. GAP = the board is silent about something true.
const add = (project, severity, check, where, msg) => findings.push({ project, severity, check, where, msg })

// ---------- small shells ----------
function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}
function trySh(cmd, args, cwd) {
  try { return sh(cmd, args, cwd) } catch (e) { return null }
}

// ---------- config ----------
// Deliberately a line-regex, not a YAML parser: helm configs are flat and a dep is not worth it here.
function loadConfig(dir) {
  const f = path.join(dir, 'config.yml')
  if (!fs.existsSync(f)) return null
  const txt = fs.readFileSync(f, 'utf8')
  const scalar = (key) => {
    const m = txt.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))
    if (!m) return null
    let v = m[1].replace(/#.*$/, '').trim()
    if (v === '' || v === 'null' || v === '~') return null
    return v.replace(/^['"]|['"]$/g, '')
  }
  return {
    name: scalar('name') || path.basename(dir),
    dir,
    repo_path: scalar('repo_path'),
    github: scalar('github'),
    base: scalar('base_branch') || scalar('default_branch') || 'main',
  }
}

function projects() {
  return fs.readdirSync(PROJECTS)
    .map(n => path.join(PROJECTS, n))
    .filter(p => fs.statSync(p).isDirectory())
    .map(loadConfig)
    .filter(Boolean)
    .filter(c => !ONLY_PROJECT || c.name === ONLY_PROJECT)
}

const board = (cfg, file) => {
  const f = path.join(cfg.dir, file)
  return fs.existsSync(f) ? { file, path: f, lines: fs.readFileSync(f, 'utf8').split('\n') } : null
}
const rel = (p) => path.relative(HELM, p)

// ---------- GitHub PR truth ----------
// ONE call per repo. 107 rows is not 107 gh invocations.
const prCache = new Map()
function prIndex(cfg) {
  if (!cfg.github) return null
  if (prCache.has(cfg.github)) return prCache.get(cfg.github)
  const raw = trySh('gh', ['pr', 'list', '--repo', cfg.github, '--state', 'all', '--limit', String(PR_LIMIT),
    '--json', 'number,state,mergedAt,mergeCommit,headRefName,headRefOid,title'])
  if (!raw) {
    notes.push(`${cfg.name}: gh pr list failed for ${cfg.github} — PR checks skipped (auth? network?)`)
    prCache.set(cfg.github, null)
    return null
  }
  const idx = new Map()
  for (const pr of JSON.parse(raw)) idx.set(pr.number, pr)
  prCache.set(cfg.github, idx)
  return idx
}

// ---------- ledger truth ----------
// LEDGER row: `<iso> | <id> | <status> | <note> | [url]`. Last transition wins (ledgertool.js `state`).
function ledgerState(cfg) {
  const b = board(cfg, 'LEDGER.md')
  const state = new Map() // id -> {status, lineNo, prs:Set}
  if (!b) return state
  b.lines.forEach((raw, i) => {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(raw)) return
    const parts = raw.split(' | ')
    if (parts.length < 3) return
    const id = parts[1].trim()
    const status = parts[2].trim()
    const prev = state.get(id) || { prs: new Set() }
    for (const m of raw.matchAll(/\/pull\/(\d+)|\bPR #(\d+)/g)) prev.prs.add(parseInt(m[1] || m[2], 10))
    state.set(id, { ...prev, status, lineNo: i + 1 })
  })
  return state
}

// ---------- markdown table helpers ----------
function tableCells(line) {
  if (!/^\s*\|/.test(line)) return null
  const cells = line.split('|')
  cells.shift()
  if (/^\s*$/.test(cells[cells.length - 1])) cells.pop()
  return cells.map(c => c.trim())
}
// Column index of a header (e.g. "status") in the nearest preceding header row.
function columnIndex(lines, upto, name) {
  for (let i = upto; i >= 0; i--) {
    const cells = tableCells(lines[i])
    if (!cells) continue
    const j = cells.findIndex(c => c.toLowerCase().replace(/\*/g, '') === name)
    if (j !== -1) return j
  }
  return -1
}

// ================= CHECK 1: every `done → PR #N` claim, asked of GitHub =================
// Covers the unstamped-merge class (row still says `ready`/`done`, the PR merged days ago) and its
// mirror, the stale stamp (row says merged, the PR is still open).
function checkPR(cfg) {
  const idx = prIndex(cfg)
  if (!idx) return

  const q = board(cfg, 'QUEUE.md')
  if (q) {
    q.lines.forEach((line, i) => {
      const cells = tableCells(line)
      if (!cells || cells.length < 3) return
      if (/^-+$/.test(cells[0].replace(/[:\s-]/g, '-'))) return   // separator row
      const si = columnIndex(q.lines, i, 'status')
      const statusCell = si >= 0 && cells[si] !== undefined ? cells[si] : line
      const prs = [...statusCell.matchAll(/\/pull\/(\d+)|\bPR #(\d+)/g)].map(m => parseInt(m[1] || m[2], 10))
      if (!prs.length) return
      const claimsMerged = /merged\s*✅|\bmerged\b/i.test(statusCell)
      for (const n of new Set(prs)) {
        const pr = idx.get(n)
        const where = `${rel(q.path)}:${i + 1}`
        if (!pr) { add(cfg.name, 'UNKNOWN', 'pr', where, `row cites PR #${n} — not found in ${cfg.github} (last ${PR_LIMIT})`); continue }
        const merged = pr.state === 'MERGED'
        if (claimsMerged && !merged) add(cfg.name, 'STALE', 'pr', where, `row says merged, PR #${n} is ${pr.state}`)
        if (!claimsMerged && merged) add(cfg.name, 'GAP', 'pr', where, `PR #${n} MERGED ${pr.mergedAt} (${(pr.mergeCommit?.oid || '').slice(0, 8)}) — row is not stamped merged`)
        // A CLOSED PR is not automatically abandoned work: early helm PRs were landed by hand and the PR
        // closed after the fact. If its head commit is an ancestor of the base, the work IS on
        // main and the row's `done` is true — say so instead of crying wolf.
        // ACK: a closed PR whose disposition a captain has already adjudicated in the row stays quiet.
        // Only the closed-PR case is ackable — a merged/stale mismatch is never suppressible, because that
        // is the check the whole tool exists for.
        const acked = /landed ✅|board-audit-ack/.test(line)
        if (!claimsMerged && pr.state === 'CLOSED' && !acked) {
          const landed = pr.headRefOid && cfg.repo_path && fs.existsSync(cfg.repo_path)
            ? trySh('git', ['merge-base', '--is-ancestor', pr.headRefOid, `origin/${cfg.base}`], cfg.repo_path) !== null
            : false
          add(cfg.name, landed ? 'UNKNOWN' : 'GAP', 'pr', where,
            landed
              ? `PR #${n} is CLOSED but its head commit ${pr.headRefOid.slice(0, 8)} IS on origin/${cfg.base} — landed outside the PR; the row should say so`
              : `PR #${n} CLOSED unmerged and its head is not on origin/${cfg.base} — row still reads as live work`)
        }
      }
    })
  }

  // The ledger is the source of truth (ARCHITECTURE §A); an item sitting at `done` whose PR is merged
  // is missing its `merged` transition, which is what QUEUE views drift from.
  const st = ledgerState(cfg)
  for (const [id, s] of st) {
    if (!['done', 'gate', 'dispatched'].includes(s.status)) continue
    for (const n of s.prs) {
      const pr = idx.get(n)
      if (pr && pr.state === 'MERGED') {
        add(cfg.name, 'GAP', 'pr', `${rel(path.join(cfg.dir, 'LEDGER.md'))}:${s.lineNo}`,
          `${id} latest ledger status is \`${s.status}\` but PR #${n} merged ${pr.mergedAt} — no \`merged\` transition recorded`)
      }
    }
  }
}

// ================= CHECK 2: every `ready` row — did it already ship? =================
// DOCTRINE §7 as a command instead of a rule humans are asked to remember. This is the exact check that
// caught the case below after three consecutive handovers had faithfully repeated it.
function checkReady(cfg) {
  const q = board(cfg, 'QUEUE.md')
  if (!q) return
  const idx = prIndex(cfg)
  const st = ledgerState(cfg)

  q.lines.forEach((line, i) => {
    const cells = tableCells(line)
    if (!cells || cells.length < 3) return
    const si = columnIndex(q.lines, i, 'status')
    const statusCell = si >= 0 && cells[si] !== undefined ? cells[si] : ''
    if (!/^\**\s*(ready|queued)\s*\**$/i.test(statusCell.trim())) return
    const ii = columnIndex(q.lines, i, 'id')
    const id = (ii >= 0 ? cells[ii] : cells[1] || '').replace(/[`*]/g, '').trim()
    const where = `${rel(q.path)}:${i + 1}`
    if (!id) return

    const s = st.get(id)
    if (s && ['done', 'merged', 'deployed'].includes(s.status)) {
      add(cfg.name, 'STALE', 'ready', where, `${id} is \`${statusCell.trim()}\` in QUEUE but the ledger's last transition is \`${s.status}\` (LEDGER:${s.lineNo})`)
    }
    if (idx) {
      for (const pr of idx.values()) {
        if (pr.state !== 'MERGED') continue
        if (pr.headRefName.includes(id) || pr.title.includes(id)) {
          add(cfg.name, 'STALE', 'ready', where, `${id} is \`${statusCell.trim()}\` but PR #${pr.number} (${pr.headRefName}) merged ${pr.mergedAt} — dispatching this spends a worker on shipped work`)
          break
        }
      }
    }
    // A ready row with no plan cannot pass the clarity gate (DOCTRINE §1) — it is not dispatchable.
    const pi = columnIndex(q.lines, i, 'plan')
    const planCell = pi >= 0 ? (cells[pi] || '') : ''
    const pm = planCell.match(/\(([^)]+\.md)\)/)
    if (pm && !fs.existsSync(path.join(cfg.dir, pm[1]))) {
      add(cfg.name, 'STALE', 'ready', where, `${id} is ready but its plan \`${pm[1]}\` does not exist`)
    }
  })
}

// ================= CHECK 3: every BLOCKED entry — is the blocker still blocking? =================
// The operator's decision inbox lied for days with four shipped entries in it.
function checkBlocked(cfg) {
  const b = board(cfg, 'BLOCKED.md')
  if (!b) return
  const idx = prIndex(cfg)
  const st = ledgerState(cfg)

  // `resolve, don't delete` (DOCTRINE §18) means the file KEEPS dispositioned entries: struck-through headings, and
  // the original block preserved inside a <details> under a RESOLVED wrapper. Those are the record, not the
  // inbox — an audit that re-reports them teaches the captain to ignore the audit.
  let depth = 0
  b.lines.forEach((line, i) => {
    if (/<details/.test(line)) depth++
    if (/<\/details>/.test(line)) depth = Math.max(0, depth - 1)
    if (depth > 0) return
    if (!/^#{2,4}\s/.test(line)) return
    if (/~~|RESOLVED|SHIPPED|OBSOLETE|DROPPED|UNBLOCKED|ANSWERED/i.test(line)) return
    const where = `${rel(b.path)}:${i + 1}`
    const ids = [...line.matchAll(/\b([a-z][a-z0-9-]*-\d{3})\b/g)].map(m => m[1])
    for (const id of new Set(ids)) {
      const s = st.get(id)
      if (s && ['done', 'merged', 'deployed'].includes(s.status)) {
        add(cfg.name, 'STALE', 'blocked', where, `${id} is still an open entry in the decision inbox but the ledger says \`${s.status}\` (LEDGER:${s.lineNo})`)
      }
    }
    if (!idx) return
    for (const m of line.matchAll(/\/pull\/(\d+)|\bPR #(\d+)/g)) {
      const n = parseInt(m[1] || m[2], 10)
      const pr = idx.get(n)
      if (pr && pr.state === 'MERGED') add(cfg.name, 'STALE', 'blocked', where, `entry blocks on PR #${n}, which merged ${pr.mergedAt}`)
    }
  })
}

// ================= CHECK 4: every path a board points at — does it exist on origin/<base>? =================
// The cheapest check in the set. It catches the commonest silent rot — a board line citing `file.ts:116-124`
// for code that has since moved — with no LLM in the loop.
const TREE_CACHE = new Map()
function repoTree(cfg) {
  if (!cfg.repo_path || !fs.existsSync(cfg.repo_path)) return null
  const key = cfg.repo_path + '#' + cfg.base
  if (TREE_CACHE.has(key)) return TREE_CACHE.get(key)
  if (!NO_FETCH) trySh('git', ['fetch', '--quiet', 'origin', cfg.base], cfg.repo_path)
  const out = trySh('git', ['ls-tree', '-r', '--name-only', `origin/${cfg.base}`], cfg.repo_path)
  if (!out) {
    notes.push(`${cfg.name}: cannot read origin/${cfg.base} in ${cfg.repo_path} — path checks skipped`)
    TREE_CACHE.set(key, null)
    return null
  }
  const set = new Set(out.split('\n').filter(Boolean))
  TREE_CACHE.set(key, set)
  return set
}

// LONGEST EXTENSION FIRST. With `ts|tsx`, `Card.tsx` matches as `Card.ts` and every .tsx citation in every
// board reports as a missing path — 9 confident false findings on the first run. The lookbehind keeps a
// leading dot (`.github/workflows/ci.yml`), which `\b` silently ate; the lookahead stops mid-extension hits.
const SRC_EXT = 'tsx|ts|jsx|mjs|cjs|js|sol|py|sh|scss|css|html|json|yaml|yml'
const PATH_RE = new RegExp(`(?<![\\w./-])(\\.?(?:[\\w.@-]+\\/)+[\\w.-]+\\.(?:${SRC_EXT}))(?![\\w])(?::(\\d+))?`, 'g')

function checkPaths(cfg) {
  const tree = repoTree(cfg)
  if (!tree) return
  // Suffix index: boards cite `src/foo/bar.ts` for a repo where the file is `packages/api/src/foo/bar.ts`.
  const bySuffix = new Set()
  for (const f of tree) {
    const parts = f.split('/')
    for (let i = 0; i < parts.length; i++) bySuffix.add(parts.slice(i).join('/'))
  }
  for (const file of ['BACKLOG.md', 'BLOCKED.md', 'CRIT.md', 'REVIEW.md']) {
    const b = board(cfg, file)
    if (!b) continue
    const seen = new Set()
    let fenced = false
    let detailsDepth = 0
    b.lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) { fenced = !fenced; return }
      // Inside a fence the text is QUOTED OUTPUT — a compiler error, an import specifier, a worker's stack.
      // Those paths are evidence of what a tool said, not claims about the repo's current layout.
      if (fenced) return
      // Same rule the `blocked` check applies: `resolve, don't delete` (DOCTRINE §18) preserves the ORIGINAL
      // block inside a <details> under a RESOLVED wrapper. That block is the historical record — its paths
      // were claims when it was written, not claims about today's tree. Re-reporting them punishes obeying it,
      // and it fires hardest on IN-FLIGHT work: an item whose files exist only on its branch cites paths
      // that legitimately are not on origin/<base> yet. Earned when resolving one block turned a CLEAN
      // board red on two files the item was in the middle of creating.
      if (/<details/.test(line)) detailsDepth++
      if (/<\/details>/.test(line)) { detailsDepth = Math.max(0, detailsDepth - 1); return }
      if (detailsDepth > 0) return
      if (/~~|RESOLVED|OBSOLETE|DROPPED|\[x\]/i.test(line)) return
      for (const m of line.matchAll(PATH_RE)) {
        const p = m[1]
        if (p.startsWith('http') || /^(node_modules|https?)/.test(p)) continue
        // Relative specifiers (`./x`, `../x`, `.../x`) are resolved against something the board does not
        // state, and build output (`dist/`) is not in the tree by design. Neither is a checkable claim.
        if (/^\.{1,3}\//.test(p) || /(^|\/)(dist|build|coverage)\//.test(p)) continue
        if (seen.has(p)) continue
        seen.add(p)
        // A board often cites helm's OWN files (a plan, a crit artifact, a dispatcher). Those live in this
        // repo, not the product repo, and are not rot.
        if (fs.existsSync(path.join(HELM, p)) || fs.existsSync(path.join(cfg.dir, p))) continue
        // ESM import specifiers in a TS repo end `.js` while the file on disk is `.ts`/`.tsx`. A board
        // quoting one (`await import('src/lib/bus.js')`) is not citing a missing path.
        const esmTwin = p.endsWith('.js') && ['.ts', '.tsx'].some(ext => {
          const q = p.slice(0, -3) + ext
          return tree.has(q) || bySuffix.has(q)
        })
        if (!tree.has(p) && !bySuffix.has(p) && !esmTwin) {
          add(cfg.name, 'STALE', 'paths', `${rel(b.path)}:${i + 1}`, `cites \`${p}\` — no such path on origin/${cfg.base} (moved or deleted; the claim above it is unverified)`)
        }
      }
    })
  }
}

// ================= CHECK 5: PENDING-PROD — is prod still on the version the file claims? =================
function checkProd(cfg) {
  const b = board(cfg, 'PENDING-PROD.md')
  if (!b) return
  const txt = b.lines.join('\n')
  const claim = txt.match(/\*\*Current prod:\*\*\s*`?v?([0-9]+\.[0-9]+\.[0-9]+)/)
  const url = txt.match(/https?:\/\/[^\s`)]+\/api\/health/)
  if (!claim || !url) { notes.push(`${cfg.name}: PENDING-PROD.md has no parseable "Current prod:" version + /api/health URL — prod check skipped`); return }
  const raw = trySh('curl', ['-s', '--max-time', '20', url[0]])
  if (!raw) { notes.push(`${cfg.name}: ${url[0]} unreachable — prod check skipped`); return }
  let live = null
  try { live = JSON.parse(raw).v } catch { /* non-JSON health body */ }
  if (!live) { notes.push(`${cfg.name}: ${url[0]} returned no version field — prod check skipped`); return }
  if (live !== claim[1]) {
    add(cfg.name, 'STALE', 'prod', rel(b.path), `file claims prod is v${claim[1]}, ${url[0]} says v${live} — deploy landed; run each row's probe and drain the drained rows`)
  }
}

// ================= CHECK 6: does the ledger still PARSE? =================
// The quietest failure in the system. `ledgertool` reads the ledger to answer "what state is item X in?",
// and every other view — including checks 1-3 above — is built on that answer. A row that is not exactly
// 5 ` | `-separated fields is SKIPPED, not errored: the event simply stops existing, and the item silently
// reverts to whatever its last well-formed row said. That is how one shipped item stayed `ready` for
// three handovers after it merged — its done-row was malformed, so no tool could see it.
//
// `lint` already existed, but it only ran inside helm's own `baseline_check` (i.e. when a helm-project item
// dispatches, which is rare). The real project ledgers, where the actual work is recorded, were linted
// by nothing. 48 broken rows accumulated over weeks before anyone noticed. Now it runs whenever the captain
// runs the audit — same day, while whoever wrote the row is still around to say what it meant.
function checkSchema(cfg) {
  const l = path.join(cfg.dir, 'LEDGER.md')
  if (!fs.existsSync(l)) return
  let out
  try {
    execFileSync('node', [path.join(__dirname, 'ledgertool.js'), 'lint', l], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return                                           // exit 0 = schema clean
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`
  }
  // Timestamp ordering is a WARN in ledgertool by design (hand-authored history is lumpy) — not a finding.
  for (const line of out.split('\n')) {
    const m = line.match(/LEDGER\.md:(\d+)\s+(BAD [A-Z]+|EMPTY [A-Z]+)[:\s]*(.*)$/)
    if (!m) continue
    add(cfg.name, 'STALE', 'schema', `${rel(l)}:${m[1]}`,
      `${m[2]} — this row is INVISIBLE to ledgertool, so the item it names reads as whatever its last well-formed row said. ${m[3].slice(0, 120)}`)
  }
}

// ---------- run ----------
const RUNNERS = { pr: checkPR, ready: checkReady, blocked: checkBlocked, paths: checkPaths, prod: checkProd, schema: checkSchema }

const list = projects()
if (!list.length) { console.error(`no projects matched${ONLY_PROJECT ? ` --project ${ONLY_PROJECT}` : ''}`); process.exit(2) }

for (const cfg of list) {
  for (const c of CHECKS) {
    if (!ONLY_CHECKS.has(c)) continue
    try { RUNNERS[c](cfg) } catch (e) { notes.push(`${cfg.name}/${c}: check threw — ${e.message}`) }
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ findings, notes, projects: list.map(p => p.name), checks: [...ONLY_CHECKS] }, null, 2))
  process.exit(findings.length ? 1 : 0)
}

const ORDER = { STALE: 0, GAP: 1, UNKNOWN: 2 }
findings.sort((a, b) => (ORDER[a.severity] - ORDER[b.severity]) || a.project.localeCompare(b.project) || a.check.localeCompare(b.check))

if (!findings.length) {
  console.log(`board-audit: CLEAN — ${list.length} project(s), checks [${[...ONLY_CHECKS].join(',')}]`)
} else {
  let cur = ''
  for (const f of findings) {
    const key = `${f.project} · ${f.check}`
    if (key !== cur) { cur = key; console.log(`\n── ${key} ──`) }
    console.log(`  [${f.severity}] ${f.where}\n      ${f.msg}`)
  }
  console.log(`\nboard-audit: ${findings.length} finding(s) — STALE ${findings.filter(f => f.severity === 'STALE').length} · GAP ${findings.filter(f => f.severity === 'GAP').length} · UNKNOWN ${findings.filter(f => f.severity === 'UNKNOWN').length}`)
  console.log('This tool never edits a board. Read each finding, then write the correction yourself —')
  console.log('and RESOLVE, do not delete: keep the line with `[RESOLVED — verified <date>]` + the residual.')
}
if (notes.length) {
  console.log('\nnotes (checks that could not run — not a clean bill):')
  for (const n of notes) console.log(`  · ${n}`)
}
process.exit(findings.length ? 1 : 0)
