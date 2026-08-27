#!/usr/bin/env node
// agent-host — run a helm engine outside the workflow runtime it was written for (helm-005).
//
// The three engines (helm-dispatch, helm-intake, helm-dispatch-gauntlet) are plain scripts that call
// six globals — agent, log, parallel, phase, pipeline, args — and today only one runtime supplies
// them. This host supplies them from a shell, so an engine can drive local models on one box with no
// hosted API in the loop.
//
// WHAT MAKES IT WORK: `hermes -z` IS the agent() contract, near enough to verbatim. Its own help:
// "One-shot mode: send a single prompt and print ONLY the final response text to stdout. No banner,
// no spinner, no tool previews... approvals are auto-bypassed. Intended for scripts / pipes." That is
// agent(prompt) -> string with no adapter. Everything else here is plumbing.
//
//   node dispatch/agent-host.js <engine.js> --args-file args.json
//   node dispatch/agent-host.js dispatch/helm-intake.js --args '{"observations":[...]}'
//
//   --args JSON | --args-file PATH   the engine's `args` object (never double-encoded — see below)
//   --model TIER=TAG                 override one tier mapping, repeatable
//   --toolsets file,terminal         hermes toolsets granted to every agent (default file,terminal)
//   --timeout SECONDS                per-agent wall clock before the process is killed (default 1800)
//   --cwd PATH                       working directory for every agent (default: this process's)
//   --usage-dir PATH                 keep the per-agent usage JSON instead of a temp dir
//   --dry-run                        print the prompts that would be sent; spawn nothing
//
// EXIT CODES: 0 = the engine returned a non-empty result. 3 = it returned [] or null. That is not a
// pedantic distinction — helm-dispatch's own header says a []/0-agent result means "did nothing,
// never success", and a host that exits 0 on it teaches an operator to trust an empty drain.
// 1 = the host or the engine threw.
//
// CONCURRENCY IS THE POINT, so this host does NOT queue. parallel() fires every thunk at once and
// lets the model broker be the thing that serialises — the deferred swaps and evictions in its log
// are the real behaviour, and a host that hides them behind its own queue would report a clean run
// that never happened.

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { schemaInstruction, extractJson, validate, retryInstruction } = require('./agent-schema')

// Tier is the contract; the string is not (RUNTIME.md: "A host on different models remaps them at
// its `agent` boundary"). The defaults below are open-weight tags any operator can pull; a box that
// serves different ones remaps a tier with HELM_AGENT_MODEL_<TIER> or `--model TIER=TAG`, which is
// the supported way to point a tier at a local runtime this file does not name.
//
// HARD CONSTRAINT: hermes refuses any model under a 64K context window, which rules out the 4K and
// 16K variants of otherwise-fine tags. A tier table that ignores that produces a refusal mid-run,
// after the expensive part.
const DEFAULT_TIERS = {
  haiku: process.env.HELM_AGENT_MODEL_HAIKU || 'qwen3.5:9b-96k',
  sonnet: process.env.HELM_AGENT_MODEL_SONNET || 'qwen3.8:27b',
  opus: process.env.HELM_AGENT_MODEL_OPUS || 'qwen3.8:27b',
}
const HERMES_BIN = process.env.HELM_AGENT_HERMES || 'hermes'
const MAX_SCHEMA_ATTEMPTS = 3

// ---------------------------------------------------------------------------- argv

function parseArgv (argv) {
  const out = { tiers: { ...DEFAULT_TIERS }, toolsets: 'file,terminal', timeout: 1800, dryRun: false, heartbeat: 30 }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) die(`${a} needs a value`)
      return argv[++i]
    }
    if (a === '--args') out.argsJson = next()
    else if (a === '--args-file') out.argsFile = next()
    else if (a === '--model') {
      const v = next()
      const eq = v.indexOf('=')
      if (eq < 1) die(`--model wants TIER=TAG, got "${v}"`)
      out.tiers[v.slice(0, eq)] = v.slice(eq + 1)
    } else if (a === '--toolsets') out.toolsets = next()
    else if (a === '--timeout') out.timeout = Number(next())
    else if (a === '--cwd') out.cwd = next()
    else if (a === '--usage-dir') out.usageDir = next()
    else if (a === '--heartbeat') out.heartbeat = Number(next())
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0) }
    else if (a.startsWith('-')) die(`unknown flag ${a}`)
    else rest.push(a)
  }
  if (rest.length !== 1) die('want exactly one engine path')
  out.engine = rest[0]
  return out
}

function printHelp () {
  const head = fs.readFileSync(__filename, 'utf8').split('\n')
  for (const line of head) {
    if (line.startsWith('#!')) continue
    if (!line.startsWith('//')) break
    console.log(line.replace(/^\/\/ ?/, ''))
  }
}

function die (msg) {
  process.stderr.write(`agent-host: ${msg}\n`)
  process.exit(1)
}

// ---------------------------------------------------------------------------- engine loading

// Two mechanical facts about the engines, both load-bearing:
//   1. `export const meta = {...}` is ESM and cannot live in a function body. The object is required
//      by convention to be a pure literal, so stripping the leading `export ` is enough — there is
//      nothing in it to evaluate.
//   2. They use top-level `return` (helm-dispatch returns [] on empty input). That is natural inside
//      a function body, which is exactly what this builds. Do NOT wrap them in a module.
function loadEngine (file) {
  const src = fs.readFileSync(file, 'utf8')
  if (/^\s*import\s/m.test(src)) die(`${file} has an ESM import — engines are expected to be self-contained`)
  const body = src.replace(/^export\s+(const|let|var|function|class)\s/gm, '$1 ')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  try {
    return new AsyncFunction('agent', 'log', 'parallel', 'phase', 'pipeline', 'args', body)
  } catch (e) {
    die(`${file} did not compile as an engine body: ${e.message}`)
  }
}

// ---------------------------------------------------------------------------- the globals

function makeGlobals (opts) {
  const usageDir = opts.usageDir || fs.mkdtempSync(path.join(os.tmpdir(), 'helm-agent-'))
  if (opts.usageDir) fs.mkdirSync(usageDir, { recursive: true })
  const ledger = []           // one row per agent() call, whatever happened to it
  let currentPhase = null
  let seq = 0
  const hbSeconds = opts.heartbeat != null ? opts.heartbeat : 30
  let hbTimer = null
  const running = {}   // label -> start time, while an agent is in flight

  // Local time, deliberately: these lines are read side by side with the model broker's own log,
  // which is journald-local. Two clocks in one screenshot is a correlation the operator has to do
  // in their head at exactly the moment they are trying to see a swap.
  const stamp = () => new Date().toTimeString().slice(0, 8)
  const log = (msg) => process.stderr.write(`[${stamp()}] ${msg}\n`)
  const phase = (title) => { currentPhase = title; log(`== ${title}`) }

  // Heartbeat: one line per interval naming the agents still in flight. unref'd so it never
  // holds the process open, and it stops the moment the last agent finishes.
  const startHeartbeat = () => {
    if (hbSeconds <= 0 || hbTimer) return
    hbTimer = setInterval(() => {
      const parts = Object.entries(running).map(([l, t]) => `${l} (${Math.floor((Date.now() - t) / 1000)}s)`)
      if (parts.length) log(`in flight: ${parts.join(', ')}`)
    }, hbSeconds * 1000)
    hbTimer.unref()
  }
  const stopHeartbeat = () => { if (hbTimer) { clearInterval(hbTimer); hbTimer = null } }

  function tierToTag (tier) {
    if (!tier) return opts.tiers.sonnet
    if (opts.tiers[tier]) return opts.tiers[tier]
    return tier  // an explicit tag passed straight through
  }

  // One hermes -z run. Resolves { text, usage, code } — never rejects; a dead process is a result
  // with code !== 0 and whatever it managed to print.
  function runHermes (prompt, o, attempt) {
    const id = `${String(++seq).padStart(3, '0')}`
    const usageFile = path.join(usageDir, `${id}.json`)
    const argv = [
      '-z', prompt,
      '--usage-file', usageFile,
      '-m', tierToTag(o.model),
      '-t', opts.toolsets,
      '--yolo',
    ]
    if (o.effort) argv.push('--reasoning', o.effort)  // same vocabulary on both sides — pass through

    if (opts.dryRun) {
      process.stdout.write(`\n----- DRY RUN ${id} ${o.label || ''} (${tierToTag(o.model)})\n${prompt}\n`)
      return Promise.resolve({ text: '', usage: null, code: 0, dry: true })
    }

    return new Promise((resolve) => {
      const child = spawn(HERMES_BIN, argv, { cwd: opts.cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      let timedOut = false
      // SIGTERM first, SIGKILL only if it will not go. hermes writes its --usage-file even when the
      // run fails, but a SIGKILL denies it the chance — and a timed-out agent is exactly the one
      // whose spend you want on the receipt. Measured 2026-08-26: a worker killed at 30 minutes
      // booked calls=0 tok=0, which reads as "did nothing" when it had in fact run 19 model turns.
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        setTimeout(() => { try { child.kill('SIGKILL') } catch (_) {} }, 15000).unref()
      }, opts.timeout * 1000)
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ text: '', usage: null, code: -1, error: e.message })
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        let usage = null
        try { usage = JSON.parse(fs.readFileSync(usageFile, 'utf8')) } catch (_) { /* written on failure too, but not always */ }
        resolve({
          text: out,
          usage,
          code: code === null ? -1 : code,
          signal,
          timedOut,
          stderrTail: err.split('\n').filter(Boolean).slice(-3).join(' | '),
        })
      })
    })
  }

  // agent(prompt, opts) -> the model's text, or the validated object when opts.schema is given, or
  // null. null is a contract the engines already handle (`.filter(Boolean)`); a fabricated partial
  // object is not — it would write a false ledger line, which is far worse than a dropped item.
  async function agent (prompt, o) {
    o = o || {}
    const label = o.label || `agent-${seq + 1}`
    const started = Date.now()
    // (a) a per-agent phase narrates itself: adopt it and emit the header once per phase.
    if (o.phase && o.phase !== currentPhase) { currentPhase = o.phase; log(`== ${o.phase}`) }
    const row = { label, phase: o.phase || currentPhase, model: tierToTag(o.model), attempts: 0, cost: 0, api_calls: 0, tokens: 0 }
    ledger.push(row)

    // (b) one start line, carrying the label and the resolved model tag (tag, not tier).
    log(`${label} start · model ${row.model}`)
    running[label] = started
    startHeartbeat()

    const finish = (emit) => {
      if (emit) log(`${row.label} ${row.outcome} ${row.seconds}s tok=${row.tokens} cost=$${row.cost.toFixed(2)}`)
      delete running[label]
      if (!Object.keys(running).length) stopHeartbeat()
    }

    let failure = null
    const attempts = o.schema ? MAX_SCHEMA_ATTEMPTS : 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let full = prompt
      if (o.schema) {
        full += '\n' + schemaInstruction(o.schema)
        if (attempt > 1) full += '\n' + retryInstruction(attempt, failure)
      }
      row.attempts = attempt
      const r = await runHermes(full, o, attempt)
      accrue(row, r.usage)

       if (r.dry) { finish(false); return o.schema ? null : '' }
      if (r.code !== 0 || !r.text.trim()) {
        row.outcome = r.timedOut ? 'timeout' : 'process-died'
        log(`${label}: hermes exited ${r.code}${r.timedOut ? ' (timeout)' : ''}${r.stderrTail ? ` — ${r.stderrTail}` : ''}`)
        row.seconds = Math.round((Date.now() - started) / 1000)
        finish(true)
        return null   // a dead worker is null, not a retry — the engines decide what to do about it
      }
      if (!o.schema) {
        row.outcome = 'ok'
        row.seconds = Math.round((Date.now() - started) / 1000)
        finish(true)
        return r.text.trim()
      }

      const ex = extractJson(r.text)
      if (ex.error) {
        failure = `could not find a JSON object in the reply (${ex.error})`
        log(`${label}: attempt ${attempt} — ${failure}`)
        continue
      }
      const errors = validate(ex.value, o.schema)
      if (errors.length) {
        failure = `the JSON object failed validation:\n- ${errors.join('\n- ')}`
        log(`${label}: attempt ${attempt} — ${errors.length} schema violation(s): ${errors[0]}`)
        continue
      }
      if (ex.trailing) log(`${label}: ${ex.trailing.length} chars of prose after the JSON block (kept out of the object)`)
      row.outcome = 'ok'
      row.extracted_by = ex.rule
      row.seconds = Math.round((Date.now() - started) / 1000)
      finish(true)
      return ex.value
    }

    row.outcome = 'schema-exhausted'
    row.seconds = Math.round((Date.now() - started) / 1000)
    log(`${label}: ${attempts} attempts, no valid object — returning null`)
    finish(true)
    return null
  }

  function accrue (row, usage) {
    if (!usage) return
    row.cost += Number(usage.estimated_cost_usd || 0)
    row.api_calls += Number(usage.api_calls || 0)
    const t = usage.tokens || usage
    row.tokens += Number(t.total_tokens || ((t.input_tokens || 0) + (t.output_tokens || 0)) || 0)
  }

  // parallel: a barrier, and it NEVER rejects. A thunk that throws resolves to null in place, which
  // is what the engines' .filter(Boolean) is written against.
  const parallel = (thunks) => Promise.all(
    (thunks || []).map((t) => {
      try { return Promise.resolve(t()).catch(() => null) } catch (_) { return Promise.resolve(null) }
    }),
  )

  // pipeline: each item runs its whole chain independently — NO barrier between stages, so item A
  // can be in stage 3 while item B is still in stage 1. Every stage gets (prev, originalItem, index).
  // A throwing stage drops that item to null and skips its remaining stages.
  const pipeline = (items, ...stages) => Promise.all(
    (items || []).map(async (item, i) => {
      let acc = item
      for (const stage of stages) {
        try {
          acc = await stage(acc, item, i)
        } catch (e) {
          log(`pipeline item ${i}: stage threw — ${e.message}`)
          return null
        }
      }
      return acc
    }),
  )

  return { agent, log, parallel, phase, pipeline, ledger, usageDir }
}

// ---------------------------------------------------------------------------- run

async function main () {
  const opts = parseArgv(process.argv.slice(2))
  let engineArgs = {}
  if (opts.argsFile) engineArgs = JSON.parse(fs.readFileSync(opts.argsFile, 'utf8'))
  else if (opts.argsJson) engineArgs = JSON.parse(opts.argsJson)
  // The engines parse `args` defensively (typeof args === 'string' ? JSON.parse(args) : args), so the
  // host must NOT double-encode. Pass the object.

  const fn = loadEngine(opts.engine)
  const g = makeGlobals(opts)
  g.log(`engine ${path.basename(opts.engine)} · tiers ${Object.entries(opts.tiers).map(([k, v]) => `${k}=${v}`).join(' ')}`)

  let result
  try {
    result = await fn(g.agent, g.log, g.parallel, g.phase, g.pipeline, engineArgs)
  } catch (e) {
    report(g)
    process.stderr.write(`agent-host: engine threw — ${e.stack || e.message}\n`)
    process.exit(1)
  }

  report(g)
  process.stdout.write(JSON.stringify(result === undefined ? null : result, null, 2) + '\n')
  const empty = result == null || (Array.isArray(result) && result.length === 0)
  process.exit(empty ? 3 : 0)
}

// The retry counts per call site are the measurement that says whether a tier is viable at all, so
// they print beside the spend rather than in a log nobody reads.
function report (g) {
  if (!g.ledger.length) { g.log('no agents ran'); return }
  const w = Math.max(...g.ledger.map((r) => r.label.length))
  process.stderr.write('\n--- agents\n')
  for (const r of g.ledger) {
    process.stderr.write(
      `  ${r.label.padEnd(w)}  ${String(r.model).padEnd(24)}  ${r.outcome || 'unknown'}` +
      `  attempts=${r.attempts}  calls=${r.api_calls}  tok=${r.tokens}  ${r.seconds != null ? `${r.seconds}s` : ''}\n`,
    )
  }
  const cost = g.ledger.reduce((a, r) => a + r.cost, 0)
  const retried = g.ledger.filter((r) => r.attempts > 1).length
  process.stderr.write(
    `--- ${g.ledger.length} agent(s), ${g.ledger.reduce((a, r) => a + r.api_calls, 0)} api call(s), ` +
    `${g.ledger.reduce((a, r) => a + r.tokens, 0)} token(s), ${retried} needed a schema retry\n`,
  )
  process.stderr.write(`--- total cost $${cost.toFixed(2)}\n`)
  process.stderr.write(`--- usage json: ${g.usageDir}\n`)
}

if (require.main === module) main().catch((e) => die(e.stack || e.message))
module.exports = { loadEngine, makeGlobals, parseArgv }
