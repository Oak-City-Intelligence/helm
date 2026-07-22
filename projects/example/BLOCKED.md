# example — BLOCKED (items a worker stopped on, awaiting your decision)

> **Fictional sample.** A worker stops here whenever the plan leaves something undetermined, rather than
> guessing (`../../DOCTRINE.md` §2). It returns the block; the orchestrator writes the entry — item id, the
> exact question, the context gathered, and what's needed to proceed. The worker never edits this file.

No open blocks. Pagelet's queued work is either merged (`example-000`), ready (`example-001`), or still an
ungroomed draft (`example-002`).

An entry, when there is one, reads like this (illustrative):

> **example-014** — publish-pipeline: render a note to a static page.
> Question: which slug scheme, random id or title-derived? The plan doesn't say, and both stubs exist in
> `src/publish/slug.ts`, so the code can't decide it either. Context: this is the open product decision in
> `DOSSIER.md`, not a repo fact. Needed: the operator's slug call, then the item can be re-dispatched.
