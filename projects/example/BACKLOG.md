# example — BACKLOG (raw ungroomed inventory, triaged)

> **Fictional sample.** Ungroomed options for "Pagelet." Items here are NOT ready — the clarity gate applies
> only when one is groomed into a `plans/<id>.md` + a QUEUE line.

Triage tags: **MECH** (mechanical, no product decision) · **JUDGMENT** (needs an operator call) ·
**ATTENDED** (touches a money/sensitive path — never headless).

## Fleet-safe (groomable → QUEUE)
- **[MECH]** Word-count indicator in the editor. → groomed into `plans/example-001.md`, queued.
- **[MECH]** Autosave the draft to localStorage every few seconds; restore on reload.
- **[MECH]** Keyboard shortcut (Cmd/Ctrl-S) to trigger a manual save; show a "saved" toast.
- **[MECH]** Replace the hand-rolled date formatter with the platform `Intl.DateTimeFormat`.

## Needs an operator decision first
- **[JUDGMENT]** Slug scheme for published notes (random id vs. title-derived). Gates the whole publish
  pipeline — do not author publish items until this is answered.
- **[JUDGMENT]** Empty-state copy + illustration for a brand-new, note-less account.

## Attended (never headless)
- **[ATTENDED]** Anything under `src/billing/` (in `deny_dirs`) — the metered-usage + checkout path. Worked
  by hand, attended, with the review gauntlet for value-moving changes.

## Notes
- Seed date: sample. Keep this file to raw inventory; grooming (scope_dirs + runnable verify + concrete
  steps) happens when an item is promoted into `plans/` and `QUEUE.md`.
