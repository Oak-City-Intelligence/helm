# helm — for the agent sitting in this repo

You are in the control plane, not in a product repo. Nothing here ships to users. What this tree does
is **author specs and dispatch other agents** to execute them in *other* repos, which are checked out
elsewhere on this box and named by each lane's `config.yml`.

Read `DOCTRINE.md` for why the system is shaped this way. This file is the shortest path to operating it.

## The entrypoint, because it is the thing people get wrong

The engines in `dispatch/` (`helm-dispatch.js`, `helm-dispatch-gauntlet.js`, `helm-intake.js`,
`helm-audit.js`) are **not runnable with bare `node`.** They call six globals that no plain Node process
supplies, and they use top-level `return`, which is a syntax error outside a host. `node dispatch/helm-dispatch.js`
fails on line one.

The host ships in this tree. This is the command:

```
node dispatch/agent-host.js dispatch/helm-dispatch.js --args-file args.json
```

`args.json` is the engine's input payload — for `helm-dispatch.js`, `{ "items": [ ... ] }`, one object
per queue item. Every engine's header block states its own payload shape; `dispatch/RUNTIME.md` states
the full contract, including the six globals and how model tiers are remapped onto local models.

Useful flags: `--dry-run` prints the prompts and spawns nothing (use it first, always), `--model TIER=TAG`
repoints one tier, `--timeout SECONDS` bounds each agent, `--cwd PATH` sets every agent's working directory.
Exit `3` means the engine returned `[]` — it did nothing, which is never success. On a single-GPU box, pin
every tier before a real run, or expect a stage to starve — see *Single-GPU hosts: pin every tier* in
`dispatch/RUNTIME.md`.

## A seat opens on a front, not on a filename

`ROSTER.md` lists every front with its state, driver, and blocker. Pick ONE, say its name, and state its
scope in your own words before touching anything (DOCTRINE §23). If the roster is stale, fix the roster
first — a wrong roster is worse than none.

Everything a seat proposes is drawn from that one lane. Noticing something about another lane is useful;
*offering* it here is the defect — write it to that lane's board and move on.

## Check the board before you trust it

```
node dispatch/board-audit.js --project <lane>
```

Read-only, no model in the loop, exit 1 means findings. Run it before dispatching anything and before
writing a handover. It never edits a board — you do, and you RESOLVE lines rather than delete them
(DOCTRINE §18). Status claims on these boards rot silently; that is measured, not feared.

## Dispatch is not a question

An item that is specced and clarity-gated gets dispatched — don't ask, dispatch it and report that you
did (DOCTRINE §22). Still ask when the item touches money code, a writing data operation, a production
deploy, or a launch gate; when a stated ordering is unmet or a `blocked_by` is unresolved; or when the
spec itself is unapproved.

## What a worker is bound by

`templates/worker-prompt.md` is the fixed harness every dispatched worker reads first. It is
non-negotiable and it is the reason dispatch is safe to take greedily: a worker isolates in a worktree,
stays inside `scope_dirs`, runs the lane's `baseline_check`, and **blocks rather than guesses** when it
hits a decision the repo cannot answer. Roughly one dispatch in four blocks. That is the system working.

Commits carry no AI attribution — not a trailer, not a co-author line, not a "generated with" note.

## Layout

```
DOCTRINE.md          the operating principles — start here
ROSTER.md            every front; a seat opens on one of these
ARCHITECTURE.md      target machine + per-component status
IMPROVEMENTS.md      the open backlog of captain-side failures, published unflatteringly
dispatch/            the engines, the agent host, and the read-only guards
templates/           the fixed worker harness
projects/<lane>/     per-lane config.yml, QUEUE.md, LEDGER.md, BLOCKED.md, plans/
```
