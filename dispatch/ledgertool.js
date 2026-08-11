#!/usr/bin/env node
// ledgertool — enforce the LEDGER schema and derive the true per-item state from it.
// The ledger is the source of truth (ARCHITECTURE §A/§D); QUEUE.md/QUEUE.json are views that drift.
// This makes the ledger machine-checkable (unblocks all of §D metrics) and lets us GENERATE the queue view.
//
//   node ledgertool.js lint  [ledger.md ...]     # validate: 5-field, status enum, ISO ts, monotonic. exit 1 on error.
//   node ledgertool.js state <ledger.md>         # print each item's CURRENT status (last transition) — the true view.
//   node ledgertool.js drift <ledger.md> <queue.json>  # flag QUEUE.json items the ledger says are already done/merged.
//
// No deps. Run over all ledgers:  node ledgertool.js lint projects/*/LEDGER.md

const fs = require('fs')

// Canonical status enum — the ONLY allowed values (mirrors templates/worker-prompt.md).
const ENUM = new Set([
  'queued', 'dispatched', 'done', 'merged', 'deployed', 'blocked', 'failed',
  'intake', 'scout', 'groom', 'local-ops', 'note',
])

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

// A ledger data line STARTS with an ISO date. Prose/header/blank lines don't, and are ignored (not errored).
function parse(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const rows = []
  lines.forEach((raw, i) => {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(raw.trim())) return
    const parts = raw.split(' | ')
    rows.push({ lineNo: i + 1, raw, parts })
  })
  return rows
}

function lint(files) {
  let errors = 0
  for (const file of files) {
    let lastTs = null
    for (const { lineNo, raw, parts } of parse(file)) {
      const loc = `${file}:${lineNo}`
      if (parts.length !== 5) {
        console.error(`  ${loc}  BAD FORMAT (${parts.length} fields, want 5): ${raw.slice(0, 80)}`)
        errors++
        continue
      }
      const [ts, id, status, , ref] = parts.map((s) => s.trim())
      if (!ISO.test(ts)) { console.error(`  ${loc}  BAD TIMESTAMP: "${ts}"`); errors++ }
      if (!ENUM.has(status)) { console.error(`  ${loc}  BAD STATUS: "${status}" (not in enum)`); errors++ }
      if (!id) { console.error(`  ${loc}  EMPTY ID`); errors++ }
      if (!ref) { console.error(`  ${loc}  EMPTY REF (use "-" if none)`); errors++ }
      // Timestamp ordering is a soft signal (hand-authored history is lumpy) — WARN, don't fail. Schema
      // (format + enum) is the hard gate; going forward the orchestrator supplies monotonic real ts.
      if (ISO.test(ts)) {
        const t = Date.parse(ts)
        if (lastTs !== null && t < lastTs) console.warn(`  ${loc}  warn: non-monotonic ts (${ts})`)
        lastTs = Math.max(lastTs ?? -Infinity, t)
      }
    }
  }
  if (errors) { console.error(`\nledgertool lint: ${errors} schema error(s).`); process.exit(1) }
  console.log(`ledgertool lint: schema clean (${files.length} file(s)).`)
}

// Only these MOVE an item through the pipeline. The rest of the enum annotates without transitioning:
// `note`/`scout`/`groom`/`intake`/`local-ops` rows record evidence against an item (a gate result, a
// re-measure, a finding) and must NOT overwrite the item's real state. Before this distinction existed,
// appending a gate-green `note` to a merged item silently downgraded it to `note` in `state`, and `drift`
// shares this map — so a merged item left sitting in QUEUE.json would stop being flagged.
const TRANSITIONS = new Set(['queued', 'dispatched', 'done', 'merged', 'deployed', 'blocked', 'failed'])

// Current state = the LAST TRANSITION per item id, in ledger order. An item that has only ever been
// annotated (an intake/scout row with no dispatch yet) still reports its latest annotation, so nothing
// vanishes from the view — it just cannot outrank a transition.
function stateOf(file) {
  const cur = new Map()
  const annotated = new Map()
  for (const { parts } of parse(file)) {
    if (parts.length !== 5) continue
    const [ts, id, status, note, ref] = parts.map((s) => s.trim())
    const row = { status, ts, note, ref }
    if (TRANSITIONS.has(status)) cur.set(id, row)
    else annotated.set(id, row)
  }
  for (const [id, row] of annotated) if (!cur.has(id)) cur.set(id, row)
  return cur
}

function state(file) {
  const cur = stateOf(file)
  const rows = [...cur.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  for (const [id, s] of rows) {
    console.log(`${id.padEnd(22)} ${s.status.padEnd(11)} ${s.ts}  ${s.ref}`)
  }
  console.log(`\n${rows.length} item(s). status tally: ` +
    [...rows.reduce((m, [, s]) => m.set(s.status, (m.get(s.status) || 0) + 1), new Map())]
      .map(([k, v]) => `${k}:${v}`).join(' '))
}

// Drift = an item queued for dispatch that the ledger already considers finished.
function drift(ledgerFile, queueFile) {
  const cur = stateOf(ledgerFile)
  let q
  try { q = JSON.parse(fs.readFileSync(queueFile, 'utf8')) } catch { q = [] }
  const items = Array.isArray(q) ? q : (q.items || [])
  let drifted = 0
  for (const it of items) {
    const s = cur.get(it.id)
    if (s && (s.status === 'done' || s.status === 'merged' || s.status === 'deployed')) {
      console.error(`  DRIFT: ${it.id} is in ${queueFile} but ledger says "${s.status}" (${s.ref})`)
      drifted++
    }
  }
  if (drifted) { console.error(`\nledgertool drift: ${drifted} stale queue item(s).`); process.exit(1) }
  console.log(`ledgertool drift: ${queueFile} clean vs ledger.`)
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'lint') lint(rest.length ? rest : [])
else if (cmd === 'state') state(rest[0])
else if (cmd === 'drift') drift(rest[0], rest[1])
else { console.error('usage: ledgertool.js lint <ledger...> | state <ledger> | drift <ledger> <queue.json>'); process.exit(2) }
