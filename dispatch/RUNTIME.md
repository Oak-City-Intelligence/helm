# helm — the runtime contract

The engines in this folder (`helm-dispatch.js`, `helm-dispatch-gauntlet.js`, `helm-intake.js`) are not
plain Node scripts. They target a **workflow-script runtime** — an agent-orchestration host that injects a
handful of globals and runs the script with top-level `await` and top-level `return`. Run one with bare
`node dispatch/helm-dispatch.js` and it fails immediately: the globals are undefined and the top-level
`return` is a syntax error outside that host. `ci-audit.js` is the exception — it is ordinary Node and runs
standalone.

This file states what a host must provide so someone can port the engines onto their own runner.
**If you only want to RUN one, you do not need to build anything** — `dispatch/agent-host.js` is a
host that ships in this tree and drives the engines from a shell against models on your own box:
`node dispatch/agent-host.js dispatch/helm-dispatch.js --args-file args.json`. See *The agent host*
at the bottom of this file.

## The run surface

A host starts a script by calling:

```
run({ scriptPath: "<abs path>/dispatch/helm-dispatch.js", args: { items: [ ... ] } })
```

`scriptPath` is the engine file; `args` is its input payload. The engine reads `args`, does its work by
spawning sub-agents, and returns an array of structured results.

## Injected globals

The host makes these available to the script without an import:

- `args` — the input payload passed to `run`. It may arrive JSON-encoded as a string, so every engine
  parses defensively: `typeof args === 'string' ? JSON.parse(args) : args`. An empty payload means the run
  no-ops and returns `[]` — that is "did nothing", never success.
- `log(message)` — write one progress line to the run's output.
- `phase(title)` — mark the current phase, for the host's progress display.
- `agent(prompt, opts)` — spawn ONE sub-agent and await its result. `opts` = `{ label, phase, model,
  effort, schema }`. When `schema` is given the result is validated against it and returned as an object.
  This is where an LLM actually runs.
- `parallel(fns)` — take an array of zero-arg async functions, run them concurrently, await them all.
- `pipeline(items, ...stages)` — run a staged per-item pipeline (the intake engine uses it for
  investigate → skeptic → forge).
- `exists(path)` — answer one filesystem question before an engine spends a worker: returns
  `true` if `path` exists and `false` if it does not. It is the host's `fs.existsSync` and nothing
  more — no globbing, no reads, no writes. Filesystem reading stays the agents' job; this only lets an
  engine check that a derived path (such as a harness file) is present before it proceeds.

Scripts also `export const meta = { name, description, phases }` for the host to display, and may use
top-level `await` and top-level `return`.

## Model-tier strings

`opts.model` is one of `haiku` · `sonnet` · `opus`. These map to DOCTRINE §11's tiers:

| string   | §11 tier | used for                                              |
|----------|----------|-------------------------------------------------------|
| `haiku`  | light    | read-only spikes — the baseline check, scouting       |
| `sonnet` | mid      | the default worker tier; most execution               |
| `opus`   | top      | gauntlet build/review, high-ambiguity or high-blast   |

The strings are the concrete model ids this codebase happened to target. A host on different models remaps
them at its `agent` boundary; the doctrine tier is the stable contract, the string is not.

### Single-GPU hosts: pin every tier

On a host where the tier models cannot be co-resident — one GPU holding one model at a time — remapping is a
correctness requirement, not a naming convenience. Pin **all three** tiers to co-resident models, or to the
same model, because the pre-flight baseline agent runs on `haiku` (`dispatch/helm-dispatch.js:130`): a run
that pins only `sonnet` restarts the model-swap fight at pre-flight.

Both remap forms apply, one per tier: `HELM_AGENT_MODEL_<TIER>` (environment, e.g. `HELM_AGENT_MODEL_SONNET=<tag>`)
and `--model TIER=TAG` (a host flag, e.g. `--model sonnet=<tag>`). Tier names are lowercase; the host refuses an
unknown name rather than storing it.

The failure signature without pinning: a stage that exhausts its timeout with **zero completed calls**.
`calls=0` after the full ceiling is eviction, not slowness — no `--timeout` value fixes it.

## What a host must provide to run the engines

- The globals above, plus top-level `await`/`return` support.
- An LLM backend behind `agent`, reachable at all three tiers.
- On the box: `git`, `gh` authenticated for each project identity, and the target repos checked out on
  disk — the workers create worktrees, push branches, and open PRs against real repos.
- Network for the push/PR steps.

Node alone will not run these engines. If you are porting helm, the runner is the part you build; the
engines, doctrine, and templates are what you carry over.

## The agent host

`dispatch/agent-host.js` is a host that closes that gap from a shell. It loads an engine, supplies the
six globals, and drives each `agent()` call through a local agent binary, so the engines run against
models on the box with no hosted API in the loop. It is exercised by an offline test suite
(`dispatch/agent-host.test.js` — 24 tests, no model, no network), the first executable check in this
tree.

The one-line invocation:

```
node dispatch/agent-host.js dispatch/helm-dispatch.js --args-file args.json
```

It requires a local agent binary that the reader must supply — the host does not bundle one. The
`haiku`/`sonnet`/`opus` tier strings map to default open-weight model tags that ship in the file; a box
that serves different models remaps any tier with `HELM_AGENT_MODEL_<TIER>` or `--model TIER=TAG`. This
does not make the engines dependency-free: it moves the dependency from a hosted runtime to a local one.
