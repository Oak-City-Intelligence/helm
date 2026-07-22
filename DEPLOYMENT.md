# helm — Deployment boundary (operator in the loop)

**Where helm ends and you begin.** A helm item finishes at a **merged PR** on the project's base branch (or a
pushed branch, for `done_via: branch`). What happens *after* merge — promotion, container build, live deploy,
and your hands-on poke-around — is a separate, **human-gated pipeline that differs per project.** helm does
not deploy.

This doc exists so the boundary is explicit and a fresh context knows not to treat "merged" as "shipped."

## The rule this encodes

When authoring/dispatching, a runtime-affecting item's *definition of done* for the operator includes the
project's post-merge path, not just the PR. helm can only assert the mechanical gate (DOCTRINE §10) — it
cannot exercise a live deploy. So:

- helm **surfaces the PR**; the operator runs (or triggers) the deploy and does the live poke.
- "merged + CI-green" ≠ "verified." A human walkthrough on the running deploy is the real gate for any item
  that changes runtime behavior.
- If a project's path is automated end-to-end, note it in the table below and helm can point at the resulting
  URL; until then, the operator drives promotion + QA.

## Per-project post-merge path

Record each project's path here so the boundary is explicit. The repos' own CI workflows
(`.github/workflows/`) are the source of truth for the mechanics — reconcile this table against them
(ROADMAP #24) rather than trusting inferred lines.

| project | terminal (helm) | post-merge path (operator) | live gate |
|---|---|---|---|
| example | merged PR into `main` | CI builds + deploys the static site on merge to `main` | operator opens the deployed URL and clicks through |
| _<yours>_ | _merged PR / pushed branch_ | _promotion → build → deploy (fill in from the repo's CI)_ | _the human walkthrough that means "verified"_ |

> The `example` row describes the fictional sample project under `projects/example/`; replace/extend the
> table with your real projects.
