# helm/dispatch — known issues

## 1. Fresh-worktree phantom-reds when a pinned dependency tree is gitignored — ✅ RESOLVED (config-driven)

**Symptom.** A dispatch pre-flight (or a worker's verify) reports the base as RED on a build/compile gate, but
the project's primary checkout builds green. The "error" is a real compiler/linker complaint, so it reads like
a genuine base break — but it is a **provisioning** artifact, not a code defect.

**Root cause — worktree dependency provisioning diverges from the pin.** Some repos keep a dependency tree
**gitignored** and pinned by a lockfile, with **no committed submodule gitlinks** (a `git ls-files -s` shows no
`160000` gitlink entries because the path is gitignored). So `git worktree add` produces a worktree with **no**
(or stale/floating) deps. If the gate command builds without a lock-respecting install step, a fresh worktree
resolves those deps to something *other* than the locked revision — and the build fails on the drift, exactly at
the symbol that moved between the locked and floating versions. Real CI doesn't hit this because it checks out
submodules / runs the intended install; helm's `baseline_check` was a hand-copy of the *build* command without
the *provisioning* step.

**Impact.** Every item that runs against such a base blocks on a phantom red until the worktree is provisioned
against the lock — even items that don't touch the affected surface, because the baseline runs the whole gate.

**Resolution (config-driven `worktree_provision`).** `projects/<p>/config.yml` may carry a `worktree_provision`
list; the dispatcher (both the pre-flight baseline checker AND the fleet worker) runs each command AFTER
`git worktree add`, BEFORE any gate/build, substituting `{repo_path}` (the primary checkout, already at the
locked revs) and `{worktree}` at runtime. The simplest exact provision is to copy the primary checkout's
already-locked dependency directory into the fresh worktree, e.g.:

```yaml
worktree_provision:
  - rsync -a --delete --exclude='.git' {repo_path}/path/to/deps/ {worktree}/path/to/deps/
```

`--exclude='.git'` gives plain source (no submodule resolution attempted); the primary is never mutated;
an absent/empty list is a no-op for projects without floating deps. The worker harness
(`templates/worker-prompt.md` §2) carries the same instruction, and a provision-command failure is classified as
a **transient** env failure (retry), not a red base.

**Not the fix:** "pin the dependency" — it is already pinned by the lock. The gap is *provisioning* a fresh
worktree to honor that pin, not the pin itself.

## 2. The clarity pass reads the PRIMARY checkout, which may not be on the base branch

Workers correctly branch off `origin/<base>` (worker-prompt rule 3), but the read-only CLARITY PASS runs
*before* the worktree exists — so its greps and `ls` hit `repo_path`, the operator's primary checkout. If
that checkout is parked on a long-lived feature branch, the pass produces false "stale premise" blocks: one
item blocked on "file X missing" when X was present on `origin/main` the whole time.

**Fix:** plans in a lane whose primary checkout is not kept on the base branch must tell the clarity pass to
check premises via `git show origin/<base>:<path>` and `git ls-tree origin/<base>`, never the working tree.
The same rule the audit tooling follows (`board-audit`, `scope-preflight`): read the remote, never a tree.

## 3. Config text is worker law — grep the configs before blaming the model

Twice, a worker finished green and then stopped at a local branch, citing a "local-only, no PRs" designation
that no current rule contains. It was not a hallucination: one worker QUOTED its lane's `config.yml`, which
still carried pre-ruling text — "`done_via: branch` — local branch; you diff/merge. No push, no PR." That
sentence had survived in FIVE lane configs after the ruling changed.

**Rule:** when a worker misbehaves *consistently and identically*, grep every `config.yml` and prompt
fragment before touching the model tier or the harness. Stale instruction text reads to a worker exactly like
policy, because it is policy — just an old copy of it.

## 4. A self-hosted forge's WAF rejects Python's default User-Agent

`urllib` requests to a self-hosted forge API behind a CDN/WAF return a bare `403` with a vendor error code
and no useful body. It reads as an auth failure and invites a retry loop. `curl` with a browser UA is
unaffected: `curl -A "Mozilla/5.0" -H "Authorization: token …"`.

**Rule:** use `curl` for forge API writes, not Python. One item lost a full round-trip discovering this.

## 5. A PR-API probe CREATES the PR — there is no dry run

A `POST` to `…/repos/<owner>/<repo>/pulls` with a valid body creates the pull request, whatever the intent.
A worker sent a probe carrying `title: "test"` to check its token and got a real PR with a placeholder title.
It recovered by `PATCH`ing the title and body in place before returning — but only because it noticed.

**Rule for the worker harness:** compose the final title and body FIRST and POST exactly once. To verify a
token, use a `GET`. This trap compounds with #4: the 403 reads as "not authenticated", the worker retries,
and each retry that gets through creates another PR.

## 6. A dependency added by a merged item breaks every later fresh-worktree baseline

If a lane's `worktree_provision` symlinks or copies `node_modules` from the primary checkout, a merged item
that adds a dependency breaks everything downstream: the primary — parked on another branch — never installs
it, so every later baseline or build in a fresh worktree goes red (`TS2307` and friends) on a dependency that
IS in the merged `package.json`.

**Fix after each dependency-adding merge:** install it into the primary's `node_modules` *without* touching
the parked branch's manifest — `npm install --no-save <dep>@<version>`. A pre-flight caught this correctly
once and refused to dispatch, which is the behavior you want.

## 7. Tracked `node_modules` SYMLINKS poison every checkout — silently

**Found** right after a `git switch main`: the repo-root `node_modules` and a nested workspace's
`node_modules` were both symlinks **pointing at themselves**. Every dependency unresolvable (`Too many levels of symbolic links`).

**Why it matters more than it looks.** The build did not hard-fail loudly — the output dir simply stayed at
its previous mtime. A deploy script building from that same tree would have rsynced a stale bundle and
reported success. Silent ship-the-wrong-bits, not just a broken dev tree.

**Root cause, two parts, both necessary:**
1. `.gitignore` used `node_modules/` — with a TRAILING SLASH, which matches directories only. A *symlink*
   named `node_modules` is not a directory to git, so it was NOT ignored.
2. Lanes provisioned worktrees with `ln -sfn {repo_path}/node_modules {worktree}/node_modules`. In the
   worktree that link is correct and, per (1), stageable — so a worker's `git add -A` swept it into a commit
   as a mode-120000 blob whose CONTENT is an absolute path to the primary checkout.

Checking that commit out in the primary makes each link point at itself; checking it out in a worktree makes
deps silently resolve to the primary instead of the worktree.

**Fixes, in order:** (1) `git rm --cached` the entries and commit the removal; (2) drop the trailing slashes
in `.gitignore` so the symlink form is ignored too; (3) dispatch-side, refuse to run any `worktree_provision`
command when `realpath {worktree}` == `realpath {repo_path}`, and refuse to stage a mode-120000 entry named
`node_modules`. **A provision artifact must never be committable** — the same principle an rsync-based
provision gets right with `--exclude='.git'`.

## 8. A location-less compiler assertion is a FLAKE, not a red base

A pre-flight blocked two items with a compiler assertion failure after several minutes of compiling. No
source location, no file name, no error code — that absence is the tell.

**The base was green**, verified two ways at the same commit: a COLD build on the primary with isolated
artifact dirs (a warm output dir proves nothing — it compiles zero files), and a fresh detached worktree plus
the config's `worktree_provision`, same file count, exit 0.

The pre-flight reports the failing command but discards the compiler output, so the block reads identical to
a genuine break. **Before authoring a baseline-fix item off an internal-compiler-error assertion, re-run the
build cold.** A nondeterministic assertion (parallel codegen under memory pressure) names nothing; a real
break names a file and an error code.

## 9. `node --test <bare-directory>` MODULE_NOT_FOUNDs on newer Node

Hit three times across two months. This is an ENVIRONMENT fact about the box, not a defect in any item: on
recent Node, `node --test tools/foo/test` resolves the directory argument `require()`-style instead of
recursing into it for test files, and dies with `MODULE_NOT_FOUND`. Reproduces on a clean checkout and in a
scratch dir unrelated to any repo.

**The cost, in order:** a plan whose `verify:` uses the bare-directory form is unrunnable as written, so the
worker must block or improvise — and an improvised verify is a verify the captain did not specify. READMEs
that document the broken invocation propagate it to anyone following them.

**House style:** write the glob form in plans — `node --test "tools/foo/test/*.mjs"`. A per-directory
`package.json` carrying a `"main"` pointer also works, but only for the directory that has it.
