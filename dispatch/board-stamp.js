#!/usr/bin/env node
// board-stamp — the CURE that board-audit is the guard for: stamp merged PRs onto the board mechanically.
//
// board-audit PRINTS the divergence and never writes (a wrong auto-correction looks authoritative).
// This is its deliberately-separate sibling: it writes ONLY the one correction that is pure transcription
// of GitHub truth — "PR #N merged at T, commit C" — and nothing else. It invents no prose, changes no
// status other than done/gate → merged, and touches no row whose PR is not MERGED on GitHub right now.
//
// Everything that needs judgment (a stale BLOCKED entry, a moved path, a `ready` row that already shipped)
// is NOT handled here on purpose. Those are captain writes (DOCTRINE §18, resolve-don't-delete).
//
//   node dispatch/board-stamp.js --project example           # DRY RUN (default): print the exact edits
//   node dispatch/board-stamp.js --project example --apply   # write them
//   node dispatch/board-stamp.js --apply                     # every project with a github remote
//
// After --apply, always: `node dispatch/ledgertool.js lint projects/*/LEDGER.md` then re-run board-audit.
// No deps.

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const HELM = path.resolve(__dirname, '..')
const PROJECTS = path.join(HELM, 'projects')

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1] || d) }
const APPLY = argv.includes('--apply')
const ONLY = opt('project', null)
const PR_LIMIT = parseInt(opt('pr-limit', '500'), 10)
// Ledger rows are timestamped when the transition is RECORDED (house convention: see any `merged` row —
// the ts is the captain's stamp time, the note carries the real mergedAt + merge commit). One batch ts
// keeps the ledger monotonic; the truth lives in the note. Hand-authored rows sometimes run ahead of the
// wall clock, so the batch ts is max(now, last ledger ts + 1s) — never introduce a backwards step.
const NOW_MS = Date.now()
const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

function trySh(cmd, args, cwd) {
  try { return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch { return null }
}

function loadConfig(dir) {
  const f = path.join(dir, 'config.yml')
  if (!fs.existsSync(f)) return null
  const txt = fs.readFileSync(f, 'utf8')
  const scalar = (k) => {
    const m = txt.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm'))
    if (!m) return null
    const v = m[1].replace(/#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
    return v === '' || v === 'null' || v === '~' ? null : v
  }
  return { name: scalar('name') || path.basename(dir), dir, github: scalar('github') }
}

const configs = fs.readdirSync(PROJECTS)
  .map(n => path.join(PROJECTS, n))
  .filter(p => fs.statSync(p).isDirectory())
  .map(loadConfig).filter(Boolean)
  .filter(c => c.github && (!ONLY || c.name === ONLY))

if (!configs.length) { console.error('no project with a github remote matched'); process.exit(2) }

let totalQueue = 0, totalLedger = 0

for (const cfg of configs) {
  const raw = trySh('gh', ['pr', 'list', '--repo', cfg.github, '--state', 'all', '--limit', String(PR_LIMIT),
    '--json', 'number,state,mergedAt,mergeCommit,headRefName,title'])
  if (!raw) { console.error(`${cfg.name}: gh pr list failed — skipped`); continue }
  const prs = new Map()
  for (const pr of JSON.parse(raw)) prs.set(pr.number, pr)
  const mergedInfo = (n) => {
    const pr = prs.get(n)
    if (!pr || pr.state !== 'MERGED') return null
    return { n, at: pr.mergedAt, sha: (pr.mergeCommit?.oid || '').slice(0, 8), head: pr.headRefName, title: pr.title }
  }
  // A ledger row can mention a PR it does not OWN (a sibling, a base branch, a number in prose). Stamping
  // the wrong PR onto an item is worse than leaving it unstamped, so the ledger backfill demands the PR
  // carry the item id in its branch or title. Anything else is printed for the captain, never written.
  const ownsId = (m, id) => (m.head || '').includes(id) || (m.title || '').includes(id)

  // ---------- QUEUE.md: append the merged stamp to the status cell ----------
  const qPath = path.join(cfg.dir, 'QUEUE.md')
  if (fs.existsSync(qPath)) {
    const lines = fs.readFileSync(qPath, 'utf8').split('\n')
    let statusCol = -1
    let changed = 0
    lines.forEach((line, i) => {
      if (!/^\s*\|/.test(line)) return
      const cells = line.split('|')
      cells.shift()
      if (/^\s*$/.test(cells[cells.length - 1])) cells.pop()
      const trimmed = cells.map(c => c.trim())
      const hdr = trimmed.findIndex(c => c.toLowerCase().replace(/\*/g, '') === 'status')
      if (hdr !== -1) { statusCol = hdr; return }          // header row — remember the column, edit nothing
      if (statusCol === -1 || cells[statusCol] === undefined) return
      const cell = cells[statusCol]
      if (/merged/i.test(cell)) return                      // already stamped — never restamp
      const nums = [...cell.matchAll(/\/pull\/(\d+)|\bPR #(\d+)/g)].map(m => parseInt(m[1] || m[2], 10))
      const merged = [...new Set(nums)].map(mergedInfo).filter(Boolean)
      if (!merged.length) return
      const stamp = merged.map(m => `#${m.n} ${m.at}${m.sha ? ` \`${m.sha}\`` : ''}`).join(', ')
      cells[statusCol] = `${cell.replace(/\s+$/, '')} merged ✅ (gh-verified ${stamp}) `
      lines[i] = '|' + cells.join('|') + '|'
      changed++
      if (!APPLY) console.log(`  QUEUE:${i + 1}  + merged ✅ (gh-verified ${stamp})`)
    })
    if (changed) {
      console.log(`${cfg.name}: QUEUE.md — ${changed} row(s) to stamp${APPLY ? ' … writing' : ' (dry run)'}`)
      if (APPLY) fs.writeFileSync(qPath, lines.join('\n'))
      totalQueue += changed
    }
  }

  // ---------- LEDGER.md: append the missing `merged` transitions ----------
  const lPath = path.join(cfg.dir, 'LEDGER.md')
  if (fs.existsSync(lPath)) {
    const txt = fs.readFileSync(lPath, 'utf8')
    const lines = txt.split('\n')
    const TRANSITIONS = new Set(['queued', 'dispatched', 'done', 'merged', 'deployed', 'blocked', 'failed'])
    const cur = new Map()      // id -> last TRANSITION status
    const prsOf = new Map()    // id -> Set(pr numbers seen anywhere in its rows)
    let lastTs = 0
    for (const line of lines) {
      if (!/^\d{4}-\d{2}-\d{2}T/.test(line)) continue
      const parts = line.split(' | ')
      if (parts.length < 3) continue
      const id = parts[1].trim(), status = parts[2].trim()
      const t = Date.parse(parts[0].trim())
      if (!Number.isNaN(t)) lastTs = Math.max(lastTs, t)
      if (!prsOf.has(id)) prsOf.set(id, new Set())
      for (const m of line.matchAll(/\/pull\/(\d+)|\bPR #(\d+)/g)) {
        prsOf.get(id).add(parseInt(m[1] || m[2], 10))
      }
      if (TRANSITIONS.has(status)) cur.set(id, status)
    }
    const stampTs = isoSec(Math.max(NOW_MS, lastTs + 1000))
    const rows = []
    const ambiguous = []
    for (const [id, status] of cur) {
      if (status !== 'done') continue                       // only done → merged; never skip a state
      const merged = [...prsOf.get(id)].map(mergedInfo).filter(Boolean)
      if (!merged.length) continue
      const owned = merged.filter(m => ownsId(m, id)).sort((a, b) => b.n - a.n)
      if (!owned.length) {
        ambiguous.push(`${id}: cites merged PR(s) ${merged.map(m => '#' + m.n).join(', ')} but none names ${id} in its branch/title — NOT stamped, look yourself`)
        continue
      }
      const m = owned[0]
      rows.push(`${stampTs} | ${id} | merged | board-stamp backfill: gh-verified PR #${m.n} MERGED ${m.at}, merge commit ${m.sha}, branch ${m.head}. Transcribed from GitHub state, not re-adjudicated — the item's own done-row carries the substance. | https://github.com/${cfg.github}/pull/${m.n}`)
    }
    if (ambiguous.length) {
      console.log(`${cfg.name}: ${ambiguous.length} item(s) SKIPPED-AMBIGUOUS (captain call, never auto-stamped):`)
      for (const a of ambiguous) console.log(`  ? ${a}`)
    }
    if (rows.length) {
      console.log(`${cfg.name}: LEDGER.md — ${rows.length} \`merged\` transition(s) to append${APPLY ? ' … writing' : ' (dry run)'}`)
      if (!APPLY) rows.slice(0, 5).forEach(r => console.log(`  + ${r.slice(0, 150)}…`))
      if (APPLY) {
        const block = `${txt.replace(/\n+$/, '')}\n${rows.join('\n')}\n`
        fs.writeFileSync(lPath, block)
      }
      totalLedger += rows.length
    }
  }
}

console.log(`\nboard-stamp: ${totalQueue} queue row(s), ${totalLedger} ledger transition(s)${APPLY ? ' WRITTEN' : ' — dry run, re-run with --apply'}`)
if (APPLY) console.log('now run: node dispatch/ledgertool.js lint projects/*/LEDGER.md && node dispatch/board-audit.js')
