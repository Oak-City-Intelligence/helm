#!/usr/bin/env node
// usage-today — sum ALL Claude Code TOKEN usage across every local session (interactive + headless daemon +
// subagents + other projects) for a day (or a rolling window). On a Max subscription the constraint is a
// weekly TOKEN budget (Anthropic meters tokens, not dollars — there is NO API key and no per-token bill).
// This reports raw tokens. The review-watch breaker reads it so its cap governs COMBINED work, not just the
// daemon's own runs.
//
// Headline metric = COMPUTE tokens (input + output + cache_write): the "new work" tokens. cache_read (re-reading
// the same long context each turn) is reported SEPARATELY — it's huge in raw count but the cheap/near-free part
// of the budget, so it shouldn't dominate a quota. (We can't read the actual weekly ceiling — it isn't exposed
// locally; anchor it once from the app's weekly % bar.)
//
// USAGE:
//   node dispatch/usage-today.js              # today (local), human summary
//   node dispatch/usage-today.js --days 7     # rolling N-day window
//   node dispatch/usage-today.js --json       # machine output: {compute_tokens, cache_read_tokens, ...}

const fs = require('fs')
const path = require('path')
const readline = require('readline')

const ROOT = `${process.env.HOME}/.claude/projects`

function parseArgs() {
  const a = process.argv.slice(2)
  const out = { days: null, json: false } // days=null → calendar TODAY (since local midnight)
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--days') out.days = parseInt(a[++i], 10) || 1
    else if (a[i] === '--json') out.json = true
  }
  return out
}
// Window cutoff: default = local midnight (calendar "today"); --days N = rolling N×24h.
function cutoffFor(days) {
  if (days == null) { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }
  return Date.now() - days * 24 * 60 * 60 * 1000
}

function* walk(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.isFile() && p.endsWith('.jsonl')) yield p
  }
}

// day cutoff: include messages with timestamp >= (now - days*24h), local.
function main() {
  const { days, json } = parseArgs()
  const cutoffMs = cutoffFor(days)
  const label = days == null ? 'today (since local midnight)' : `last ${days} day(s) rolling`
  const files = [...walk(ROOT)]
  const acc = { input: 0, output: 0, cache_read: 0, cache_write: 0, messages: 0 }
  const byModel = {}
  let pending = files.length
  if (!pending) return finish()

  function addLine(line) {
    let d
    try { d = JSON.parse(line) } catch { return }
    const ts = d.timestamp || (d.message && d.message.timestamp)
    if (ts) { const t = Date.parse(ts); if (!isNaN(t) && t < cutoffMs) return }
    const msg = d.message || d
    const u = msg && msg.usage
    if (!u) return
    const model = msg.model || d.model || 'unknown'
    const inp = (u.input_tokens || 0)
    const outp = (u.output_tokens || 0)
    const cr = (u.cache_read_input_tokens || 0)
    const cw = (u.cache_creation_input_tokens || 0)
    acc.input += inp; acc.output += outp; acc.cache_read += cr; acc.cache_write += cw; acc.messages++
    const bm = (byModel[model] = byModel[model] || { compute: 0, cache_read: 0 })
    bm.compute += inp + outp + cw; bm.cache_read += cr
  }

  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity })
    rl.on('line', addLine)
    rl.on('close', () => { if (--pending === 0) finish() })
    rl.on('error', () => { if (--pending === 0) finish() })
  }

  function finish() {
    const compute = acc.input + acc.output + acc.cache_write // "new work" tokens
    const total = compute + acc.cache_read
    if (json) {
      console.log(JSON.stringify({
        window: label,
        compute_tokens: compute,            // ← the quota metric (input + output + cache_write)
        cache_read_tokens: acc.cache_read,   // context re-reads — near-free, reported separately
        total_tokens: total,
        breakdown: { input: acc.input, output: acc.output, cache_write: acc.cache_write, cache_read: acc.cache_read },
        messages: acc.messages,
        by_model_compute: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, v.compute])),
      }))
      return
    }
    const T = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : (n / 1e3).toFixed(0) + 'k')
    console.log(`token usage — ${label}, ALL Claude Code sessions combined`)
    console.log(`  COMPUTE tokens: ${T(compute)}   ← the budget metric (in ${T(acc.input)} + out ${T(acc.output)} + cache-write ${T(acc.cache_write)})`)
    console.log(`  cache-read:     ${T(acc.cache_read)}   (context re-reads — near-free, not counted in the quota)`)
    console.log(`  messages: ${acc.messages}`)
    const rows = Object.entries(byModel).sort((a, b) => b[1].compute - a[1].compute)
    for (const [m, v] of rows) console.log(`    ${m}: ${T(v.compute)} compute`)
  }
}

main()
