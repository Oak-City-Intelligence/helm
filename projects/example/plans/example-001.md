# example-001 — Add a live word-count indicator to the editor

> **Fictional sample item.** Modeled on `../../../templates/item.md` to show a clarity-gated spec a
> fresh-context worker could execute with no conversation. "Pagelet" is invented.

```yaml
id: example-001
title: Add a live word-count indicator to the note editor
status: ready
scope_dirs:
  - src/editor/          # the editor component + its unit tests live here
blocked_by: []
base_branch: main
branch: example-001-word-count
model: sonnet
effort: medium
verify: |
  npm ci && npm run typecheck && npx vitest run src/editor/wordCount.test.ts
```

## Goal
The editor should show a live word count that updates as the user types, so a writer can see how long a note
is without leaving the page. This is contained, mechanically verifiable UI plumbing — the kind of work the
unattended queue is for. No product decision is involved (the count is a plain visible number).

## Steps
1. Find the editor component in `src/editor/` (discover the file that renders the `<textarea>`/content-editable
   and holds the note text in state — do not assume the filename).
2. Add a pure helper `countWords(text: string): number` in a new `src/editor/wordCount.ts`. Define a word as a
   maximal run of non-whitespace; the empty string and whitespace-only strings count as 0. Trim leading/trailing
   whitespace before splitting.
3. Render the count in the editor's footer/status area as `{n} words` (use `1 word` for the singular), wired to
   the same state the editor already tracks — do not add a second source of truth for the text.
4. Add `src/editor/wordCount.test.ts` (Vitest) asserting: `""` → 0, `"hello"` → 1, `"  hello   world  "` → 2,
   a multi-line string counts across newlines, and punctuation attached to a word does not split it
   (`"it's fine."` → 2).

## Known-good reference (if any)
None — this is new code, not a recovery.

## Out of scope / do NOT touch
- No changes outside `src/editor/`. In particular, nothing in `src/billing/` (denied) and no API changes.
- Do not add a formatting/i18n dependency for the number; a plain template string is enough for v1.

## Done means
The editor shows a live, correct word count that updates as the user types; `countWords` is covered by unit
tests; and the `verify` command passes (typecheck + the new Vitest file), introducing no new failures vs
`origin/main`. Terminates as a PR into `main` (`done_via: pr`).
