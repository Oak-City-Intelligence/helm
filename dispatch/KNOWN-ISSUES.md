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
