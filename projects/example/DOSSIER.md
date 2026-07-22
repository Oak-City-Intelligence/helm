# example — DOSSIER (strategic state-of-the-project)

> **Fictional sample.** "Pagelet" is an invented project included so the dossier/backlog/queue/ledger/plans
> layout reads end-to-end. Nothing here is real.

## Mission
Pagelet is a small web app: a markdown notes editor that publishes each note as a static shareable page.
The near-term milestone is a **share-ready v1** (write a note, get a clean public URL) with the editor
pleasant enough that people actually use it.

## Stack
TypeScript + Vite front end, a thin Node API, Vitest for unit tests. CI (`.github/workflows/ci.yml`) runs
typecheck → test → build on every PR into `main`; an e2e job runs separately (excluded from helm's
pre-flight baseline — see `config.yml`). helm ends at a merged PR; deploy is a static build published on
merge (see `../../DEPLOYMENT.md`).

## Roadmap (real milestone + critical path)
1. **Editor feels good** — word count, autosave, keyboard shortcuts. (In progress; `example-001` is the first.)
2. **Publish pipeline** — a note → a rendered static page at a stable slug.
3. **Share URL polish** — open-graph tags, a copy-link affordance.

The critical path to v1 runs through the publish pipeline (2); editor polish (1) is parallel, low-risk fleet
fodder — exactly the verifiable, contained work the queue is for.

## Live threads
- The editor is where most small, verifiable items live (fleet-safe).
- `src/billing/` is deliberately in `deny_dirs`: it's a judgment-heavy money path, worked attended-only.

## Open decisions needing the operator
- Slug scheme for published notes (random id vs. title-derived) — a genuine product decision; gates the
  publish-pipeline items, so those wait until it's answered (never guessed).
