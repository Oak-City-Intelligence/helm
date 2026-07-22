#!/usr/bin/env node
// ci-audit — the CI-mirror validator (DOCTRINE §10 hardening).
//
// PROBLEM it kills: each project's `config.yml` `baseline_check` is a HAND-TRANSCRIBED copy of the repo's
// real CI gate. Copies drift. Every drift has bitten — a dropped format check reddened the base; a missing
// formatting gate blocked a worker on pre-existing diffs. This tool reads the repo's ACTUAL workflow YAMLs,
// extracts the gate-ish `run:` commands, and reports any that `baseline_check` does not cover. Run it at
// session start and before authoring items that touch a new surface.
//
// USAGE:
//   node dispatch/ci-audit.js                       # audit every projects/<p>/config.yml
//   node dispatch/ci-audit.js projects/example/config.yml [more configs...]
//
// Exit code: 0 = all baselines cover their CI gate; 1 = at least one MISSING command (drift found).
//
// Dependency-free (no YAML lib): a tolerant line scanner, not a full parser. It OVER-reports rather than
// miss — a false flag costs a glance; a missed drift costs a red main. Verify flags by eye before acting.

const fs = require('fs')
const path = require('path')

const HELM_ROOT = path.resolve(__dirname, '..')

// A command is "gate-ish" if it looks like verification, not setup/install/checkout/deploy.
const GATE_HINT = /\b(typecheck|tsc|lint|fmt|format|prettier|test|build|check|coverage|forge|vitest|jest|mocha|audit|slither|no-legacy)\b/i
const NOISE = /\b(checkout|actions\/|setup-|install|ci\b|cache|upload|download|codecov|npm ci\b|npm install\b|pnpm install\b|apt-get|curl|wget|echo|cd \b|foundry-toolchain|node-version|fetch-depth|persist-credentials)\b/i
// Individual verification verbs we care about matching against the baseline, extracted from a run: line.
const VERB = /(?:pnpm(?:\s+run)?|npm\s+run|yarn|npx\s+tsx|forge|npx)\s+[^\n&|;]+/gi

function stripQuotes(s) { return s.replace(/^['"]|['"]$/g, '').trim() }
// Drop a trailing ` # comment` (YAML/shell inline comment). Conservative: only when ' #' has a leading space.
function stripComment(s) { return s.replace(/\s+#.*$/, '').trim() }

// Pull `run:` payloads (single-line and block scalar) out of a workflow YAML text.
function extractRunCommands(yamlText) {
  const lines = yamlText.split('\n')
  const cmds = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-?\s*run:\s*(.*)$/)
    if (!m) continue
    const indent = m[1].length
    const inline = m[2]
    if (inline && inline.trim() !== '|' && inline.trim() !== '>' && !inline.trim().startsWith('|') && !inline.trim().startsWith('>')) {
      cmds.push(stripComment(stripQuotes(inline)))
      continue
    }
    // block scalar: gather deeper-indented lines
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') { continue }
      const li = lines[j].match(/^(\s*)/)[1].length
      if (li <= indent) break
      cmds.push(stripComment(lines[j].trim()))
    }
  }
  return cmds
}

// From a raw run: payload, pull the individual verification sub-commands.
function gateCommandsFrom(raw) {
  if (!GATE_HINT.test(raw) || NOISE.test(raw)) {
    // still may contain a gate verb amid noise (e.g. `&& pnpm test`); scan verbs regardless
  }
  const out = []
  const found = raw.match(VERB) || []
  for (let f of found) {
    f = f.trim().replace(/\s+/g, ' ')
    // drop trailing shell operators / flags noise
    f = f.replace(/\s*(--frozen-lockfile|--legacy-peer-deps|--gas-report|--build-info|--force|--check)?\s*$/,
      (mm) => (mm.trim() ? ' ' + mm.trim() : ''))
    if (!GATE_HINT.test(f)) continue
    if (/^(pnpm|npm|yarn)\s+(run\s+)?(install|ci)\b/i.test(f)) continue
    out.push(f.trim())
  }
  return out
}

function findWorkflowFiles(repoPath) {
  const roots = [
    path.join(repoPath, '.github', 'workflows'),
    // one level of nested surface (e.g. contracts/.github/workflows)
    ...safeSubdirs(repoPath).map((d) => path.join(repoPath, d, '.github', 'workflows')),
  ]
  const files = []
  for (const r of roots) {
    if (!fs.existsSync(r)) continue
    for (const f of fs.readdirSync(r)) {
      if (/\.ya?ml$/.test(f)) files.push(path.join(r, f))
    }
  }
  return files
}

function safeSubdirs(repoPath) {
  try {
    return fs.readdirSync(repoPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
  } catch { return [] }
}

// Read the `baseline_check: |` block scalar out of a config.yml (crude, dependency-free).
function readConfig(configPath) {
  const text = fs.readFileSync(configPath, 'utf8')
  const get = (key) => {
    const m = text.match(new RegExp('^' + key + ':\\s*(.*)$', 'm'))
    return m ? stripComment(stripQuotes(m[1])) : null
  }
  let baseline = ''
  // Capture the block scalar up to the next top-level key (`^\S`) or end of input. JS has no `\Z`;
  // `$(?![\s\S])` is the true end-of-string anchor under the /m flag (plain `$` would match every line end).
  const bm = text.match(/^baseline_check:\s*\|[^\n]*\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)
  if (bm) baseline = bm[1]
  // baseline_excludes: CI commands intentionally NOT in the pre-flight gate (e.g. a live-DB or slither job).
  // Supports inline `[a, b]` or a `- item` block list. Each entry is a substring matched against CI commands.
  const excludes = []
  const inlineEx = text.match(/^baseline_excludes:\s*\[([^\]]*)\]/m)
  if (inlineEx) inlineEx[1].split(',').forEach((s) => { const v = stripComment(stripQuotes(s)); if (v) excludes.push(v) })
  const blockEx = text.match(/^baseline_excludes:\s*\n((?:\s*-\s*.*\n?)+)/m)
  if (blockEx) blockEx[1].split('\n').forEach((l) => { const m = l.match(/^\s*-\s*(.*)$/); if (m) { const v = stripComment(stripQuotes(m[1])); if (v) excludes.push(v) } })
  return {
    name: get('name'),
    repo_path: get('repo_path'),
    base_branch: get('base_branch'),
    baseline_check: baseline,
    baseline_excludes: excludes,
  }
}

// Does the baseline cover this CI command? Tolerant: compare the significant tokens (verb + subcommand),
// treating `npm run X` ≡ `pnpm X` ≡ `pnpm run X`.
function normalize(cmd) {
  return cmd
    .toLowerCase()
    .replace(/\b(npm run|pnpm run|pnpm|yarn|npx tsx --test|npx)\b/g, '')
    .replace(/['"]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !t.startsWith('-'))   // drop flags (--gas-report, --force, --skip …) so `forge test --gas-report` ≡ `forge test`
    .join(' ')
    .trim()
}
function baselineCovers(baseline, ciCmd) {
  const nb = normalize(baseline)
  const nc = normalize(ciCmd)
  if (!nc) return true
  const toks = nc.split(' ').filter(Boolean)
  // core = leading verb + subcommand (e.g. "forge build", "forge test"); or the lone script token
  // (e.g. "typecheck", "test:hermetic", "format:check") once the npm/pnpm prefix is normalized away.
  const core = toks.length >= 2 ? toks.slice(0, 2).join(' ') : toks[0]
  if (core && nb.includes(core)) return true
  return nb.includes(nc)
}

function auditOne(configPath) {
  const cfg = readConfig(configPath)
  if (!cfg.repo_path) return { configPath, error: 'no repo_path' }
  if (!fs.existsSync(cfg.repo_path)) return { configPath, name: cfg.name, error: 'repo_path missing on disk: ' + cfg.repo_path }
  const wfFiles = findWorkflowFiles(cfg.repo_path)
  const ciCmds = new Set()
  for (const f of wfFiles) {
    for (const raw of extractRunCommands(fs.readFileSync(f, 'utf8'))) {
      for (const g of gateCommandsFrom(raw)) ciCmds.add(g)
    }
  }
  const missing = []
  const excluded = []
  for (const c of ciCmds) {
    if (baselineCovers(cfg.baseline_check, c)) continue
    if (cfg.baseline_excludes.some((ex) => c.toLowerCase().includes(ex.toLowerCase()))) { excluded.push(c); continue }
    missing.push(c)
  }
  return {
    configPath,
    name: cfg.name,
    base_branch: cfg.base_branch,
    workflows: wfFiles.map((f) => path.relative(cfg.repo_path, f)),
    ci_gate_commands: [...ciCmds].sort(),
    missing: missing.sort(),
    excluded: excluded.sort(),
  }
}

function main() {
  let configs = process.argv.slice(2)
  if (!configs.length) {
    const projRoot = path.join(HELM_ROOT, 'projects')
    configs = fs.readdirSync(projRoot)
      .map((p) => path.join(projRoot, p, 'config.yml'))
      .filter((p) => fs.existsSync(p))
  }
  let anyMissing = false
  console.log('ci-audit — baseline_check vs real CI gate\n')
  for (const c of configs) {
    const r = auditOne(c)
    if (r.error) { console.log(`  ⚠ ${r.name || c}: ${r.error}\n`); continue }
    console.log(`● ${r.name}  (base ${r.base_branch})`)
    console.log(`  workflows: ${r.workflows.join(', ') || '(none found)'}`)
    console.log(`  CI gate commands detected: ${r.ci_gate_commands.length}`)
    if (r.excluded.length) {
      console.log(`  ⊘ intentionally excluded (baseline_excludes): ${r.excluded.join(' · ')}`)
    }
    if (r.missing.length) {
      anyMissing = true
      console.log(`  ✗ MISSING from baseline_check (${r.missing.length}):`)
      for (const m of r.missing) console.log(`      - ${m}`)
    } else {
      console.log(`  ✓ baseline_check covers every detected CI gate command`)
    }
    console.log('')
  }
  if (anyMissing) {
    console.log('DRIFT FOUND — a CI gate command is not in baseline_check. Fix the config (and/or author a')
    console.log('baseline-fix item) before dispatching, or work will red-main / block on the uncovered gate.')
    process.exit(1)
  }
  console.log('All baselines mirror their CI gate. No drift.')
}

main()
