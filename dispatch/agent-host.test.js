#!/usr/bin/env node
// agent-host.test — offline tests for the host and its schema layer (helm-005 / helm-006).
//
//   node --test dispatch/agent-host.test.js
//
// No model, no network, no hermes: agents are served by a fake binary (below) that replays REAL
// model output. The narration cases are transcribed from probe runs on this box, not invented —
// these models answer correctly and then talk around the answer, and that is precisely what the
// extractor exists for. An invented "model says clean JSON" fixture would test nothing.

'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { extractJson, validate, schemaInstruction, retryInstruction } = require('./agent-schema')
const { loadEngine, makeGlobals } = require('./agent-host')

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    item: { type: 'string' },
    status: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    failure_class: { type: 'string', enum: ['transient', 'real'] },
    pr_url: { type: 'string' },
    branch: { type: 'string' },
    verify_summary: { type: 'string' },
    block_question: { type: 'string' },
    ledger_line: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['item', 'status'],
}

const NESTED_SCHEMA = {
  type: 'object',
  properties: {
    observation: { type: 'string' },
    verdict: { type: 'string', enum: ['confirmed', 'not-reproduced', 'unclear'] },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: { where: { type: 'string' }, what: { type: 'string' } },
        required: ['where', 'what'],
      },
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['observation', 'verdict', 'evidence', 'confidence'],
}

// ---------------------------------------------------------------------------- extraction

test('prose, then the object, then MORE prose — the observed worker shape', () => {
  const reply = [
    'I read the plan and the harness first, then created the worktree off main.',
    '',
    '```json',
    '{"item":"example-006","status":"done","branch":"example/006","verify_summary":"pytest 14 passed"}',
    '```',
    '',
    'Note that "verified" here means the scoped tests only — I did not run the full suite.',
  ].join('\n')
  const r = extractJson(reply)
  assert.equal(r.rule, 'fenced-json')
  assert.equal(r.value.status, 'done')
  assert.match(r.trailing, /^Note that/)          // trailing prose is a signal, never an error
  assert.deepEqual(validate(r.value, WORKER_SCHEMA), [])
})

test('a thinking block before the answer does not win — extraction reads from the end', () => {
  const reply = [
    '<think>The caller wants JSON. Maybe {"status": "guessing"} would do? No — check the plan first.</think>',
    'Done.',
    '```json',
    '{"item":"example-007","status":"blocked","block_question":"Which discount base?"}',
    '```',
  ].join('\n')
  const r = extractJson(reply)
  assert.equal(r.value.item, 'example-007')
  assert.equal(r.value.status, 'blocked')
})

test('an unlabelled fence still parses', () => {
  const r = extractJson('here:\n```\n{"item":"x","status":"failed"}\n```\n')
  assert.equal(r.rule, 'fenced-any')
  assert.equal(r.value.status, 'failed')
})

test('no fence at all — the balanced-brace scan finds the object', () => {
  const r = extractJson('The result object is {"item":"x","status":"done","notes":"has a } brace in a string"} and that is all.')
  assert.equal(r.rule, 'balanced-braces')
  assert.equal(r.value.notes, 'has a } brace in a string')
})

test('a bare object with no prose at all (the attempt-3 shape)', () => {
  const r = extractJson('{"item":"x","status":"done"}')
  assert.equal(r.value.status, 'done')
})

test('prose only — no object anywhere — is an extraction error, not a crash', () => {
  const r = extractJson('I fixed the bug and the tests pass. Let me know if you want the diff.')
  assert.ok(r.error)
  assert.equal(r.rule, 'none')
})

test('a JSON array is not an object', () => {
  const r = extractJson('```json\n[{"item":"x"}]\n```')
  assert.ok(r.error)
})

// ---------------------------------------------------------------------------- validation

test('an enum near-miss FAILS — the engines branch on the exact string', () => {
  const errs = validate({ item: 'x', status: 'complete' }, WORKER_SCHEMA)
  assert.equal(errs.length, 1)
  assert.match(errs[0], /\$\.status: "complete" is not one of "done", "blocked", "failed"/)
})

test('a missing required key is caught, an absent optional one is not', () => {
  assert.deepEqual(validate({ item: 'x', status: 'done' }, WORKER_SCHEMA), [])
  assert.match(validate({ status: 'done' }, WORKER_SCHEMA)[0], /\$\.item: required/)
})

test('wrong types are caught, including inside array items', () => {
  const errs = validate({
    observation: 'o', verdict: 'confirmed', confidence: 'high',
    evidence: [{ where: 'a.js:1', what: 'x' }, { where: 12, what: 'y' }],
  }, NESTED_SCHEMA)
  assert.equal(errs.length, 1)
  assert.match(errs[0], /evidence\[1\]\.where: expected string, got number/)
})

test('a required key nested inside an array item is enforced', () => {
  const errs = validate({
    observation: 'o', verdict: 'unclear', confidence: 'low', evidence: [{ where: 'a.js:1' }],
  }, NESTED_SCHEMA)
  assert.match(errs[0], /evidence\[0\]\.what: required/)
})

test('an array where an object belongs is caught', () => {
  assert.match(validate({ observation: 'o', verdict: 'confirmed', confidence: 'high', evidence: {} }, NESTED_SCHEMA)[0],
    /evidence: expected array, got object/)
})

test('the instruction carries the schema, a worked example, and the enum values verbatim', () => {
  const s = schemaInstruction(WORKER_SCHEMA)
  assert.match(s, /```json/)
  assert.match(s, /"status": "done"/)          // the worked example is built FROM the schema
  assert.match(s, /Nothing may come/)
  assert.match(retryInstruction(2, 'boom'), /boom/)
  assert.match(retryInstruction(3, 'boom'), /no prose/)
})

// ---------------------------------------------------------------------------- engine loading

test('an engine loads: export stripped, top-level return honoured, six globals bound', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-engine-'))
  const file = path.join(dir, 'toy.js')
  fs.writeFileSync(file, [
    "export const meta = { name: 'toy', description: 'd', phases: [{ title: 'P' }] }",
    'const _args = typeof args === "string" ? JSON.parse(args) : (args || {})',
    'if (!(_args.items || []).length) { log("nothing to do"); return [] }',
    'phase("P")',
    'const r = await parallel(_args.items.map((i) => () => agent("do " + i, { label: "w:" + i })))',
    'return r.filter(Boolean)',
  ].join('\n'))

  const fn = loadEngine(file)
  const calls = []
  const g = makeGlobals({ tiers: { sonnet: 'fake' }, toolsets: 'file', timeout: 5, dryRun: true })
  // dry-run returns '' for text agents; assert the wiring, not the model
  const spy = async (p, o) => { calls.push([p, o]); return 'ok:' + p }
  const out = await fn(spy, g.log, g.parallel, g.phase, g.pipeline, { items: ['a', 'b'] })
  assert.deepEqual(out, ['ok:do a', 'ok:do b'])
  assert.equal(calls[1][1].label, 'w:b')

  const empty = await fn(spy, g.log, g.parallel, g.phase, g.pipeline, {})
  assert.deepEqual(empty, [])   // "did nothing", which the host must never report as success
})

test('every shipped engine compiles under the host', () => {
  for (const f of ['helm-dispatch.js', 'helm-intake.js', 'helm-dispatch-gauntlet.js']) {
    assert.ok(loadEngine(path.join(__dirname, f)), f)
  }
})

// ---------------------------------------------------------------------------- failure semantics

test('parallel never rejects: a throwing thunk becomes null in place', async () => {
  const g = makeGlobals({ tiers: {}, toolsets: 'file', timeout: 5, dryRun: true })
  const r = await g.parallel([
    () => Promise.resolve(1),
    () => { throw new Error('sync boom') },
    () => Promise.reject(new Error('async boom')),
    () => Promise.resolve(4),
  ])
  assert.deepEqual(r, [1, null, null, 4])
})

test('pipeline drops a throwing item and skips its remaining stages', async () => {
  const g = makeGlobals({ tiers: {}, toolsets: 'file', timeout: 5, dryRun: true })
  const reached = []
  const r = await g.pipeline([1, 2, 3],
    (v) => { if (v === 2) throw new Error('stage 1 boom'); return v * 10 },
    (v, orig, i) => { reached.push([v, orig, i]); return v + 1 })
  assert.deepEqual(r, [11, null, 31])
  assert.deepEqual(reached, [[10, 1, 0], [30, 3, 2]])   // stages see (prev, originalItem, index)
})

// ---------------------------------------------------------------------------- agent(), against a fake hermes

function fakeHermes (script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-fake-'))
  const bin = path.join(dir, 'hermes')
  fs.writeFileSync(bin, script, { mode: 0o755 })
  return bin
}

// The fake replays a canned reply per attempt, and honours --usage-file exactly as hermes does.
function replayBin (replies) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'helm-replay-')), 'replies.json')
  fs.writeFileSync(file, JSON.stringify(replies))
  return fakeHermes([
    '#!/usr/bin/env node',
    'const fs = require("fs")',
    `const replies = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, "utf8"))`,
    `const countFile = ${JSON.stringify(file + '.count')}`,
    'let n = 0; try { n = Number(fs.readFileSync(countFile, "utf8")) } catch (_) {}',
    'fs.writeFileSync(countFile, String(n + 1))',
    'const i = process.argv.indexOf("--usage-file")',
    'if (i > -1) fs.writeFileSync(process.argv[i + 1], JSON.stringify({ estimated_cost_usd: 0.0, api_calls: 3, tokens: { total_tokens: 1234 } }))',
    'const r = replies[Math.min(n, replies.length - 1)]',
    'if (r.exit) { process.stderr.write(r.text || "died\\n"); process.exit(r.exit) }',
    'process.stdout.write(r.text)',
  ].join('\n'))
}

function hostWith (bin, over) {
  const prev = process.env.HELM_AGENT_HERMES
  process.env.HELM_AGENT_HERMES = bin
  // agent-host reads HELM_AGENT_HERMES at require time, so re-require it fresh.
  delete require.cache[require.resolve('./agent-host')]
  const mod = require('./agent-host')
  const g = mod.makeGlobals(Object.assign({ tiers: { sonnet: 'fake-tag' }, toolsets: 'file', timeout: 30 }, over))
  g.restore = () => { process.env.HELM_AGENT_HERMES = prev; delete require.cache[require.resolve('./agent-host')] }
  return g
}

test('a text agent returns trimmed stdout and books the usage', async () => {
  const g = hostWith(replayBin([{ text: '  PASS  \n' }]))
  assert.equal(await g.agent('probe'), 'PASS')
  assert.equal(g.ledger[0].outcome, 'ok')
  assert.equal(g.ledger[0].api_calls, 3)
  assert.equal(g.ledger[0].tokens, 1234)
  assert.equal(g.ledger[0].cost, 0)      // the number the whole exercise is about
  g.restore()
})

test('a schema agent survives the narration case in ONE attempt', async () => {
  const g = hostWith(replayBin([{ text: 'Worktree made, tests green.\n```json\n{"item":"i","status":"done"}\n```\nCaveat: scoped tests only.\n' }]))
  const r = await g.agent('work', { schema: WORKER_SCHEMA, label: 'worker:i' })
  assert.deepEqual(r, { item: 'i', status: 'done' })
  assert.equal(g.ledger[0].attempts, 1)
  assert.equal(g.ledger[0].extracted_by, 'fenced-json')
  g.restore()
})

test('an enum violation is RETRIED, not passed through', async () => {
  const g = hostWith(replayBin([
    { text: '```json\n{"item":"i","status":"complete"}\n```' },     // near-miss: not in the enum
    { text: '```json\n{"item":"i","status":"done"}\n```' },
  ]))
  const r = await g.agent('work', { schema: WORKER_SCHEMA, label: 'worker:i' })
  assert.equal(r.status, 'done')
  assert.equal(g.ledger[0].attempts, 2)
  g.restore()
})

test('three bad attempts return null — never a fabricated partial object', async () => {
  const g = hostWith(replayBin([{ text: 'I did the work. It went fine.' }]))
  const r = await g.agent('work', { schema: WORKER_SCHEMA, label: 'worker:i' })
  assert.equal(r, null)
  assert.equal(g.ledger[0].attempts, 3)
  assert.equal(g.ledger[0].outcome, 'schema-exhausted')
  g.restore()
})

test('a dead process is null immediately, and the run continues', async () => {
  const g = hostWith(replayBin([{ exit: 137, text: 'Killed\n' }]))
  const r = await g.parallel([
    () => g.agent('work', { schema: WORKER_SCHEMA, label: 'dies' }),
    () => Promise.resolve({ item: 'other', status: 'done' }),
  ])
  assert.equal(r[0], null)
  assert.equal(r[1].status, 'done')
  assert.equal(g.ledger[0].outcome, 'process-died')
  assert.equal(g.ledger[0].attempts, 1)   // a dead worker is not a schema retry
  g.restore()
})

test('a hung agent is killed at the timeout and yields null', async () => {
  const g = hostWith(fakeHermes('#!/bin/sh\nsleep 30\n'), { timeout: 1 })
  const r = await g.agent('work', { label: 'hangs' })
  assert.equal(r, null)
  assert.equal(g.ledger[0].outcome, 'timeout')
  g.restore()
})

test('the tier remap reaches hermes as -m, and effort passes straight through as --reasoning', async () => {
  const bin = fakeHermes([
    '#!/usr/bin/env node',
    'process.stdout.write(JSON.stringify(process.argv.slice(2)))',
  ].join('\n'))
  const g = hostWith(bin, { tiers: { haiku: 'small-tag', sonnet: 'mid-tag', opus: 'big-tag' } })
  const argv = JSON.parse(await g.agent('p', { model: 'opus', effort: 'high' }))
  assert.equal(argv[argv.indexOf('-m') + 1], 'big-tag')
  assert.equal(argv[argv.indexOf('--reasoning') + 1], 'high')
  assert.ok(argv.includes('--yolo'))
  assert.ok(argv.includes('--usage-file'))
  const passthrough = JSON.parse(await g.agent('p', { model: 'flashnext:125b' }))
  assert.equal(passthrough[passthrough.indexOf('-m') + 1], 'flashnext:125b')  // an explicit tag is not a tier
  g.restore()
})

// ---------------------------------------------------------------------------- narration (helm-105)

// Capture host stderr lines for the duration of fn. The fake hermes child writes to its own piped
// streams, never process.stderr, so only the host's log() lines are captured.
async function captureStderr (fn) {
  const orig = process.stderr.write
  const lines = []
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true }
  try {
    const result = await fn()
    return { lines, result }
  } finally {
    process.stderr.write = orig
  }
}

test('a per-agent phase emits its header once, not once per agent', async () => {
  const g = hostWith(replayBin([{ text: 'a' }, { text: 'b' }]))
  const { lines } = await captureStderr(async () => {
    await g.agent('x', { phase: 'P' })
    await g.agent('y', { phase: 'P' })
  })
  assert.equal(lines.filter((l) => l.includes('== P')).length, 1)
  g.restore()
})

test('start and finish lines bracket a successful agent, and the finish carries outcome + seconds', async () => {
  const g = hostWith(replayBin([{ text: 'done' }]))
  const { lines } = await captureStderr(async () => {
    await g.agent('probe', { label: 'w1' })
  })
  assert.ok(lines.some((l) => /w1 start .*model fake-tag/.test(l)))
  assert.ok(lines.some((l) => /w1 ok \d+s tok=1234/.test(l)))
  g.restore()
})

test('a dead agent still emits a finish line, not only successes', async () => {
  const g = hostWith(replayBin([{ exit: 137, text: 'Killed\n' }]))
  const { lines } = await captureStderr(async () => {
    await g.agent('probe', { label: 'dies' })
  })
  assert.ok(lines.some((l) => /dies process-died \d+s/.test(l)))
  g.restore()
})

test('heartbeatSeconds 0 emits no heartbeat line', async () => {
  const g = hostWith(replayBin([{ text: 'ok' }]), { heartbeat: 0 })
  const { lines } = await captureStderr(async () => {
    await g.agent('probe', { label: 'h' })
  })
  assert.ok(!lines.some((l) => l.includes('in flight')))
  g.restore()
})
