# example — QUEUE

> **Fictional sample.** Hand-authored, pre-approved, ordered items for "Pagelet." Topmost not-done,
> not-blocked item is next. Each links to a full spec in `plans/<id>.md`. Nothing enters that fails the
> clarity gate (`../../DOCTRINE.md` §1): every item needs `scope_dirs`, a runnable `verify`, and concrete steps.

| # | id | title | status | plan | verify present | notes |
|---|----|-------|--------|------|----------------|-------|
| 1 | example-000 | Recover the note autosave util from `main` (pre-rewrite) | merged | (recovery) | ✅ | first rep — recovery of known-good code, lowest-ambiguity |
| 2 | example-001 | Add a live word-count indicator to the editor | ready | plans/example-001.md | ✅ | fleet-safe; scoped to `src/editor/` |
| 3 | example-002 | Autosave draft to localStorage + restore on reload | draft | — | — | not groomed yet — needs scope + a runnable verify before it can queue |

## Grooming notes
- `example-000` is shown as already merged to illustrate the full lifecycle in `LEDGER.md`
  (queued → dispatched → done → merged).
- `example-001` is the next ready item; its spec is in `plans/example-001.md`.
- The publish-pipeline items are NOT queued: they gate on the slug-scheme decision (see `DOSSIER.md`) — a
  genuine operator call, so they wait rather than getting guessed.
