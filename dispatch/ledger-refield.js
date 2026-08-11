#!/usr/bin/env node
// ledger-refield — second cleanup pass: repair LEDGER rows whose FIELD COUNT is not 5.
// Run AFTER ledger-normalize.js (which fixes statuses/timestamps but deliberately skips these rows).
//
//   node ledger-refield.js          <files...>   # dry run
//   node ledger-refield.js --apply  <files...>   # rewrite in place
//
// Schema is `ts | id | status | note | ref`. Three repairable shapes, all lossless:
//
//   >5 fields  the NOTE contains a literal " | ". Rejoin fields 3..n-1 back into one note; last is ref.
//   4 fields   two sub-cases, told apart by whether field 3 is a valid enum status:
//                yes -> `ts|id|status|note`, the REF is missing        -> append "-"
//                no  -> `ts|id|note|ref`,    the STATUS is missing     -> insert "note"
//   3 fields   `ts|id|note` — wave/session summary rows (id reads like "merges", "BIG AUDIT — ...").
//              Both status and ref are missing -> insert "note", append "-".
//
// `note` is the status inserted whenever one must be invented, never a transition: these rows are
// summaries and annotations, and ledgertool's stateOf lets only TRANSITIONS set an item's derived state.
// Inventing `note` therefore cannot move any item's lifecycle — inventing `done` or `merged` could.

const fs = require('fs')

const ENUM = new Set([
  'queued', 'dispatched', 'done', 'merged', 'deployed', 'blocked', 'failed',
  'intake', 'scout', 'groom', 'local-ops', 'note',
])

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const files = args.filter((a) => a !== '--apply')
if (!files.length) { console.error('usage: ledger-refield.js [--apply] <ledger.md ...>'); process.exit(2) }

const counts = { rejoined: 0, refAdded: 0, statusInserted: 0, both: 0, untouched: 0 }

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const out = lines.map((raw) => {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(raw.trim())) return raw
    const p = raw.split(' | ')
    if (p.length === 5) return raw

    if (p.length > 5) {
      // The note contains a literal " | ", which is indistinguishable from the field delimiter — the
      // author used it as an inline separator ("done | PR #123 | tier-aware ..."). Rejoining with " | "
      // would rebuild the identical string and fix nothing, so the INNER separator becomes " · ".
      // This is the one edit in either pass that changes a character of authored prose; it changes a
      // separator glyph only, never a word.
      const merged = [p[0], p[1], p[2], p.slice(3, -1).join(' · '), p[p.length - 1]]
      counts.rejoined++
      return merged.join(' | ')
    }

    if (p.length === 4) {
      if (ENUM.has(p[2].trim())) { counts.refAdded++; return [...p, '-'].join(' | ') }
      counts.statusInserted++
      return [p[0], p[1], ' note', p[2], p[3]].join(' | ')
    }

    if (p.length === 3) {
      counts.both++
      return [p[0], p[1], ' note', p[2], '-'].join(' | ')
    }

    counts.untouched++
    return raw
  })
  if (apply) fs.writeFileSync(file, out.join('\n'))
}

console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: rejoined(>5)=${counts.rejoined} refAdded(4)=${counts.refAdded} statusInserted(4)=${counts.statusInserted} both(3)=${counts.both} untouched=${counts.untouched}`)
