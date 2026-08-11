#!/usr/bin/env node
// scope-preflight — check every ready plan's `scope_dirs` against the target repo's origin/main
// BEFORE dispatch, instead of paying a full worker round-trip to find out.
//
// Why this exists: four consecutive worker blocks were spec-authoring misses, and three of those were
// `scope_dirs`. One named a test directory that has never existed in the repo. That is a string
// comparison, and a string comparison should not cost a full dispatch round-trip to discover.
//
// Read-only. No model in the loop. Exit 1 = findings, matching board-audit's contract.
//
//   node dispatch/scope-preflight.js [project ...]      (default: every project with a config.yml)
//
// What it CANNOT tell you, and you still have to think about (see DOCTRINE §1):
//   - whether the item's inputs are REACHABLE from the scoped files (one block: a needed input was
//     not derivable from anything in scope)
//   - whether a signature / struct / storage change compiles against consumers OUTSIDE the scope
//     (a whole-project compiler — one that builds src + test + script together — makes every caller
//     mandatory, not optional)
// A clean run here means the paths are real. It does not mean the scope is sufficient.

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const HELM = path.resolve(__dirname, '..')
const PROJECTS = path.join(HELM, 'projects')

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// Minimal front-matter reader: plans open with a ```yaml fence holding id/status/scope_dirs.
function readPlan(file) {
  const text = fs.readFileSync(file, 'utf8')
  const fence = text.match(/^```yaml\n([\s\S]*?)\n```/)
  if (!fence) return null
  const body = fence[1]
  const status = (body.match(/^status:\s*(.+)$/m) || [])[1]?.trim()
  const blockedBy = (body.match(/^blocked_by:\s*(.+)$/m) || [])[1]?.trim()
  const list = (key) => {
    const m = body.match(new RegExp(`^${key}:\\n((?:\\s*-\\s.+\\n?)+)`, 'm'))
    if (!m) return []
    // Strip any inline `# note` — authors routinely annotate scope entries, and comparing the
    // annotated string against the tree made EVERY commented path report as "not tracked yet".
    // A path checker that silently passes on its own input format is worse than no checker.
    return m[1].split('\n')
      .map((l) => (l.match(/^\s*-\s+(.+?)\s*$/) || [])[1])
      .map((v) => v && v.replace(/\s+#.*$/, '').trim())
      .filter(Boolean)
  }
  // `impact_symbols` is the author's declaration that this item changes a signature, struct or
  // storage layout. Declaring it turns on consumer enumeration — see the block comment at the top.
  return { status, blockedBy, scope: list('scope_dirs'), symbols: list('impact_symbols') }
}

function projectsToCheck(argv) {
  if (argv.length) return argv
  return fs.readdirSync(PROJECTS).filter((d) => fs.existsSync(path.join(PROJECTS, d, 'config.yml')))
}

let findings = 0
let checked = 0
const notes = []

for (const project of projectsToCheck(process.argv.slice(2))) {
  const cfgPath = path.join(PROJECTS, project, 'config.yml')
  if (!fs.existsSync(cfgPath)) { notes.push(`${project}: no config.yml`); continue }
  const cfg = fs.readFileSync(cfgPath, 'utf8')
  // Strip trailing `# comment` the way board-audit does — a config that documents its own
  // fields inline would otherwise yield a repo_path with the comment glued on and read as missing.
  const scalar = (k) => (cfg.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1]?.replace(/\s+#.*$/, '').trim()
  const repo = scalar('repo_path')
  const base = scalar('base_branch') || 'main'
  if (!repo || !fs.existsSync(repo)) { notes.push(`${project}: repo_path missing or unreadable (${repo})`); continue }

  let tree
  try {
    tree = new Set(git(repo, ['ls-tree', '-r', '--name-only', `origin/${base}`]).split('\n').filter(Boolean))
  } catch (e) {
    notes.push(`${project}: cannot read origin/${base} in ${repo} — checks skipped`)
    continue
  }
  // Directory prefixes, so a scope entry ending in / can be matched.
  const dirs = new Set()
  for (const f of tree) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/')
  }

  const plansDir = path.join(PROJECTS, project, 'plans')
  if (!fs.existsSync(plansDir)) continue
  const out = []

  for (const f of fs.readdirSync(plansDir).filter((x) => x.endsWith('.md')).sort()) {
    const plan = readPlan(path.join(plansDir, f))
    if (!plan) continue
    // Only gate what is dispatchable. A spike/report/done item's scope is not going to a worker.
    if (!/^ready\b/.test(plan.status || '')) continue
    checked++

    const missing = []
    for (const s of plan.scope) {
      const entry = s.replace(/^\.\//, '')
      const hit = entry.endsWith('/') ? dirs.has(entry) : (tree.has(entry) || dirs.has(entry + '/'))
      // A scoped path may legitimately not exist yet — the item CREATES it. The question that
      // actually matters is whether git would let it ride a PR at all: a path under a gitignore
      // rule can be written, pass every local gate, and silently never reach the branch. That is
      // the gitignored-doc-target trap, and it has bitten us twice.
      if (!hit) {
        let ignored = false
        try {
          execFileSync('git', ['-C', repo, 'check-ignore', '-q', '--no-index', entry], { stdio: 'ignore' })
          ignored = true
        } catch { /* exit 1 = not ignored, which is the good case */ }
        missing.push({ entry, ignored })
      }
    }
    // Consumer enumeration. A signature/struct/storage change must scope every file that names the
    // symbol, or the tree does not compile — a whole-project compiler builds source, tests and
    // scripts together, and generated bindings drift on top of that. Three consecutive respins of
    // one item were this exact gap, each found by a worker at full dispatch cost. It is a grep;
    // it should cost a grep.
    const uncovered = []
    if (plan.symbols.length) {
      const covered = (f) => plan.scope.some((s) => {
        const e = s.replace(/^\.\//, '')
        return e.endsWith('/') ? f.startsWith(e) : f === e
      })
      let hits = new Set()
      for (const sym of plan.symbols) {
        let out = ''
        // Only trees that COMPILE or TYPECHECK can break the build. Prose that names a symbol is doc
        // drift — a real thing, but a different item.
        //
        // ADAPT THIS TO YOUR REPO: the globs below are the source types a build actually consumes, and
        // the exclusions are directories that compile to nothing — a retired stack kept for reference,
        // build output, vendored dependencies, generated type declarations. Getting the exclusions wrong
        // costs precision, not safety: a false hit trains the reader to skim, which is how a real one
        // gets missed.
        try {
          out = execFileSync(
            'git',
            ['-C', repo, 'grep', '-l', '-F', '--', sym, `origin/${base}`, '--',
              '*.sol', '*.ts', '*.tsx',
              ':(exclude)legacy/**', ':(exclude)**/out/**', ':(exclude)**/lib/**', ':(exclude)**/*.d.ts'],
            { encoding: 'utf8' },
          )
        } catch { /* exit 1 = no match; a symbol with zero hits is reported below */ }
        const files = out.split('\n').filter(Boolean).map((l) => l.replace(new RegExp(`^origin/${base}:`), ''))
        if (!files.length) uncovered.push({ sym, none: true })
        for (const f of files) hits.add(f)
      }
      // A file that only NAMES the symbol in a comment cannot break the build. In a codebase where
      // sibling modules cross-reference each other in doc comments, that is most of the hits — and
      // flagging them all is how the signal drowns.
      const commentOnly = (f) => {
        let lines = ''
        try {
          lines = execFileSync('git', ['-C', repo, 'grep', '-h', '-F', '--', [...plan.symbols][0], `origin/${base}`, '--', f], { encoding: 'utf8' })
        } catch { return false }
        for (const sym of plan.symbols) {
          let l = ''
          try {
            l = execFileSync('git', ['-C', repo, 'grep', '-h', '-F', '--', sym, `origin/${base}`, '--', f], { encoding: 'utf8' })
          } catch { continue }
          for (const line of l.split('\n').filter(Boolean)) {
            if (!/^\s*(\/\/|\/\*|\*|#)/.test(line)) return false
          }
        }
        return true
      }
      for (const f of [...hits].sort()) {
        if (covered(f)) continue
        uncovered.push({ file: f, commentOnly: commentOnly(f) })
      }
    }

    if (missing.length || uncovered.length) {
      out.push(`  ${f}  (status: ${plan.status}${plan.blockedBy && plan.blockedBy !== '[]' ? `, blocked_by ${plan.blockedBy}` : ''})`)
      for (const m of missing) {
        out.push(
          m.ignored
            ? `    ✗ ${m.entry} — GITIGNORED. A worker can write it, every gate can pass, and it will NEVER reach the branch`
            : `    · ${m.entry} — not tracked yet, but writable (fine if this item CREATES it; wrong if you meant an existing file)`,
        )
        if (m.ignored) findings++
      }
      for (const u of uncovered) {
        if (u.none) {
          out.push(`    ? impact_symbols: "${u.sym}" matches nothing on origin/${base} — stale symbol, or a typo`)
        } else if (u.commentOnly) {
          out.push(`    · ${u.file} — names an impact_symbol in COMMENTS only, unscoped (no build impact; doc drift if the symbol is renamed)`)
        } else {
          out.push(`    ✗ ${u.file} — names a declared impact_symbol in CODE and is NOT in scope_dirs — the tree will not compile`)
          findings++
        }
      }
    }
  }

  if (out.length) {
    console.log(`\n── ${project} · scope_dirs vs origin/${base} ──`)
    console.log(out.join('\n'))
  }
}

console.log(
  findings
    ? `\nscope-preflight: ${findings} bad path(s) across ${checked} ready plan(s) — fix the plan, do not dispatch`
    : `\nscope-preflight: CLEAN — ${checked} ready plan(s), every scope_dirs path resolves`,
)
if (notes.length) {
  console.log('\nnotes (checks that could not run — not a clean bill):')
  for (const n of notes) console.log(`  · ${n}`)
}
console.log(
  '\nreminder: this proves the paths EXIST. It cannot prove the scope is SUFFICIENT —\n' +
    'for any signature/struct/storage change, enumerate consumers across every tree the\n' +
    'build compiles (source, tests, scripts) plus any generated bindings, yourself.',
)
process.exit(findings ? 1 : 0)
