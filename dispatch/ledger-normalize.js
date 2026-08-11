#!/usr/bin/env node
// ledger-normalize — one-shot cleanup that makes historical LEDGER rows machine-checkable WITHOUT
// losing a word of what they said.
//
//   node ledger-normalize.js            <files...>   # dry run: print the mapping table, write nothing
//   node ledger-normalize.js --apply    <files...>   # rewrite in place
//
// Two fixes:
//   1. BAD TIMESTAMP — `2026-07-13T09:57Z` has no seconds. Add `:00`. Purely mechanical.
//   2. BAD STATUS    — ~180 distinct freeform statuses ("deployed", "amended+re-dispatched",
//      "MERGE-VERIFIED on GitHub", whole sentences). Map to the enum, and PREPEND the original text to
//      the note so the record still says exactly what it said.
//
// The safety property that makes this non-destructive: `note` is the default for anything not confidently
// classifiable. ledgertool's stateOf only lets TRANSITIONS overwrite an item's derived state, so a row
// demoted to `note` can never regress an item to an earlier lifecycle stage — the worst case is that a
// row stops *contributing* to the derived state, which is already true today for a status the enum
// rejects. Guessing a transition wrong is the only way to corrupt state, so we only guess when sure.

const fs = require('fs')

const ISO_OK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const ISO_NO_SECS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/

const ENUM = new Set([
  'queued', 'dispatched', 'done', 'merged', 'deployed', 'blocked', 'failed',
  'intake', 'scout', 'groom', 'local-ops', 'note',
])

// Order matters — first match wins. Only classify as a TRANSITION when the wording is unambiguous;
// everything else falls through to `note`, which is always safe.
const RULES = [
  [/dispatch\s*refused|refused/i, 'blocked'],
  [/\bunblocked\b/i, 'queued'],
  // `deployed` outranks `merged`: a row saying "merged+deployed" is reporting the LATER state, and
  // classifying it as merged would understate it. "deploying" is deliberately NOT matched here — it
  // falls through to the merge rule, because in-flight is not deployed.
  [/\bdeployed\b/i, 'deployed'],
  [/merge-verified|merged|\bmerge\b/i, 'merged'],
  [/deploy/i, 'deployed'],
  [/dispatch/i, 'dispatched'],
  [/^\s*done\b|^\s*DONE\b|captain-(finished|pushed)|capstone/i, 'done'],
  [/\bfail(ed|ure)?\b/i, 'failed'],
  // `blocked_by` is a DEPENDENCY declaration, not a blocked state — an item can be authored-and-ready
  // while carrying blocked_by. Matching /block/i naively here classified three ready items as blocked.
  [/blocked_by/i, 'queued'],
  [/block/i, 'blocked'],
  [/^\s*(authored|queued|backlog|ready|promoted|reauthor)/i, 'queued'],
  [/^\s*groom/i, 'groom'],
  [/^\s*scout/i, 'scout'],
  [/^\s*intake/i, 'intake'],
  [/local-ops/i, 'local-ops'],
]

function classify(status) {
  for (const [re, mapped] of RULES) if (re.test(status)) return mapped
  return 'note'
}

// FIELD COUNT — the third fix, added when the lint was found sitting RED at 48 such rows and
// helm's own baseline_check runs that lint (so helm items could not dispatch at all).
//   4 fields → the row just never wrote a ref. Append `-`, the schema's own "none" value.
//   6+       → the NOTE contains a literal ` | `. Rejoin the middle back into the note; keep the last
//              field as the ref only if it still LOOKS like a ref (a URL or `-`), else it is prose too.
// Nothing is dropped in either direction: every original character survives inside the note.
const REF_LIKE = /^\s*(-|https?:\/\/\S+|[\w./-]+\.md)\s*$/
// Rejoining with a literal ` | ` would re-split on the next parse — the row reads fixed and lints broken
// forever. The separator is escaped (`\|`, the markdown convention) so the text survives verbatim to a
// reader while the parser sees four fields.
const rejoin = (segs) => segs.join(' \\| ')
function fixFields(parts) {
  if (parts.length === 4) return { parts: [...parts, ' -'], kind: '4 fields → appended ref `-`' }
  const last = parts[parts.length - 1]
  if (REF_LIKE.test(last)) {
    return { parts: [parts[0], parts[1], parts[2], rejoin(parts.slice(3, -1)), last], kind: `${parts.length} fields → note rejoined (escaped \\|), ref kept` }
  }
  return { parts: [parts[0], parts[1], parts[2], rejoin(parts.slice(3)), ' -'], kind: `${parts.length} fields → note rejoined (escaped \\|), ref \`-\`` }
}

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const files = args.filter((a) => a !== '--apply')
if (!files.length) { console.error('usage: ledger-normalize.js [--apply] <ledger.md ...>'); process.exit(2) }

const tally = new Map()
const fieldTally = new Map()
let tsFixed = 0, stFixed = 0, fdFixed = 0, rows = 0

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const out = lines.map((raw) => {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(raw.trim())) return raw
    let parts = raw.split(' | ')
    if (parts.length !== 5) {
      if (parts.length < 4) return raw   // too little structure to repair without guessing — leave it
      const f = fixFields(parts)
      parts = f.parts
      fieldTally.set(f.kind, (fieldTally.get(f.kind) || 0) + 1)
      fdFixed++
    }
    rows++
    let [ts, id, status, note, ref] = parts
    const tsT = ts.trim()

    if (!ISO_OK.test(tsT)) {
      const m = tsT.match(ISO_NO_SECS)
      if (m) { ts = `${m[1]}:00${m[2]}`; tsFixed++ }
    }

    const stT = status.trim()
    if (!ENUM.has(stT)) {
      const mapped = classify(stT)
      tally.set(`${stT}  ->  ${mapped}`, (tally.get(`${stT}  ->  ${mapped}`) || 0) + 1)
      // Prepend the original wording to the note. Nothing is lost; the row still reads as authored.
      const sep = /[.!?]$/.test(stT) ? ' ' : '. '
      note = ` ${stT}${sep}${note.trim()}`
      status = ` ${mapped}`
      stFixed++
    }
    return [ts, id, status, note, ref].join(' | ')
  })

  if (apply) fs.writeFileSync(file, out.join('\n'))
}

const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1])
for (const [k, v] of sorted) console.log(`${String(v).padStart(4)}  ${k}`)
for (const [k, v] of [...fieldTally.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(4)}  ${k}`)
console.log(`\n${apply ? 'APPLIED' : 'DRY RUN'}: ${rows} data rows · ${tsFixed} timestamps fixed · ${stFixed} statuses mapped · ${fdFixed} field-counts repaired · ${sorted.length} distinct mappings`)
