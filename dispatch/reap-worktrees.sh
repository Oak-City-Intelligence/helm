#!/usr/bin/env bash
# helm — worktree REAPER. Dispatch creates one worktree per item and nothing ever removed them:
# one project held 139 trees / 21G and another 153, going back to item 001. The worker prompt
# the worker harness says "Leave the worktree in place for the operator's review" — correct, but
# review ends at merge and nobody swept after. This is the sweep.
#
# SAFETY MODEL — reap ONLY what is provably recoverable. A tree is reaped when ALL hold:
#   1. its branch is an ancestor of origin/<base_branch>  (i.e. actually merged; squash-merges FAIL
#      this check and are deliberately kept — see KEPT reasons in the report)
#   2. no modified/staged TRACKED files
#   3. no untracked files, except paths this project's `worktree_provision` creates (contracts/lib
#      and friends — rsynced deps, regenerated on next provision)
#   4. it is older than --min-age-days (default 3), so a tree still under operator review survives
# Branches are NEVER deleted. Every reaped tree is recreatable with `git worktree add <path> <branch>`.
#
# DRY-RUN BY DEFAULT. Pass --apply to actually remove.
#
#   ./reap-worktrees.sh                          # report across all projects, remove nothing
#   ./reap-worktrees.sh --apply                  # reap everything eligible
#   ./reap-worktrees.sh --project example --apply # one project
#   ./reap-worktrees.sh --min-age-days 0 --apply # ignore the age guard
set -uo pipefail

HELM="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLY=0
MIN_AGE_DAYS=3
ONLY_PROJECT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --project) ONLY_PROJECT="${2:-}"; shift 2 ;;
    --min-age-days) MIN_AGE_DAYS="${2:-3}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Scalar out of a flat YAML config. Tolerates trailing '# comments' and quotes.
cfg() {
  sed -n "s/^$2:[[:space:]]*//p" "$1" | head -1 | sed 's/[[:space:]]*#.*$//' | tr -d "\"'" | sed 's/[[:space:]]*$//'
}

# Relative paths a `worktree_provision` command writes into the tree: every {worktree}/<path>
# occurrence, normalised to its top directory (…/{worktree}/contracts/lib/ -> contracts/lib).
provision_paths() {
  grep -o '{worktree}/[^ ]*' "$1" 2>/dev/null \
    | sed 's|{worktree}/||; s|/*$||' \
    | awk -F/ 'NF>=2 {print $1"/"$2; next} {print $1}' \
    | sort -u
}

total_reaped=0; total_kept=0; total_failed=0

for config in "$HELM"/projects/*/config.yml; do
  project="$(basename "$(dirname "$config")")"
  [ -n "$ONLY_PROJECT" ] && [ "$project" != "$ONLY_PROJECT" ] && continue

  repo="$(cfg "$config" repo_path)"
  root="$(cfg "$config" worktree_root)"
  base="$(cfg "$config" base_branch)"
  base="${base:-main}"

  [ -z "$root" ] || [ "$root" = "null" ] && continue          # done_via: direct — no worktrees
  [ -d "$root" ] || continue
  # NOT `[ -d $repo/.git ]` — a checkout that is itself a worktree has .git as a FILE, which
  # silently skipped whole projects when this guard was a directory test.
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || continue

  mapfile -t provision < <(provision_paths "$config")

  echo "══ $project  ($repo, base $base)"
  git -C "$repo" fetch origin "$base" --quiet 2>/dev/null

  # Enumerate this repo's worktrees, skipping the primary checkout (first record).
  mapfile -t trees < <(git -C "$repo" worktree list --porcelain \
    | awk '/^worktree /{w=substr($0,10); b=""} /^branch /{b=substr($0,8)} /^detached/{b="DETACHED"} /^$/{if(w!="")print w"\t"b; w=""}')

  for rec in "${trees[@]}"; do
    wt="${rec%%$'\t'*}"; br="${rec##*$'\t'}"
    br="${br#refs/heads/}"
    case "$wt" in "$root"/*) ;; *) continue ;; esac   # only trees under THIS project's root
    name="$(basename "$wt")"

    # --- guard 4: age
    if [ "$MIN_AGE_DAYS" -gt 0 ] && [ -n "$(find "$wt" -maxdepth 0 -mtime "-$MIN_AGE_DAYS" 2>/dev/null)" ]; then
      echo "  KEEP  $name — younger than ${MIN_AGE_DAYS}d (may be under review)"; total_kept=$((total_kept+1)); continue
    fi

    # --- guard 1: merged into origin/base
    ref="$br"; [ "$br" = "DETACHED" ] && ref="$(git -C "$wt" rev-parse HEAD 2>/dev/null)"
    if ! git -C "$repo" merge-base --is-ancestor "$ref" "origin/$base" 2>/dev/null; then
      ahead="$(git -C "$repo" rev-list --count "origin/$base..$ref" 2>/dev/null)"
      echo "  KEEP  $name — not an ancestor of origin/$base (+${ahead:-?} commits; squash-merge or real work)"
      total_kept=$((total_kept+1)); continue
    fi

    # --- guards 2+3: tracked changes block; untracked block unless provision-owned
    blocked=""
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      path="${line:3}"
      if [ "${line:0:2}" = "??" ]; then
        keep_it=1
        for p in "${provision[@]}"; do
          [ -n "$p" ] && case "${path%/}" in "$p"|"$p"/*) keep_it=0 ;; esac
        done
        [ "$keep_it" = 1 ] && blocked="${blocked}untracked:${path} "
      else
        blocked="${blocked}modified:${path} "
      fi
    done < <(git -C "$wt" status --porcelain 2>/dev/null)

    if [ -n "$blocked" ]; then
      echo "  KEEP  $name — uncommitted work: $(echo "$blocked" | cut -c1-90)"
      total_kept=$((total_kept+1)); continue
    fi

    if [ "$APPLY" = 0 ]; then
      echo "  REAP  $name  [$br]  (dry-run)"; total_reaped=$((total_reaped+1)); continue
    fi

    # Drop provision-owned deps first so plain `remove` (no --force) suffices.
    for p in "${provision[@]}"; do
      [ -n "$p" ] && [ -e "$wt/$p" ] && rm -rf "${wt:?}/${p:?}"
    done

    if git -C "$repo" worktree remove "$wt" 2>/dev/null; then
      echo "  REAP  $name  [$br]"; total_reaped=$((total_reaped+1))
    elif rm -rf "${wt:?}" && git -C "$repo" worktree prune; then
      # `git worktree remove` refuses trees containing submodules ("working trees containing
      # submodules cannot be moved or removed"). Safe here: the merged+clean guards already passed.
      echo "  REAP  $name  [$br]  (submodule path: rm -rf + prune)"; total_reaped=$((total_reaped+1))
    else
      echo "  FAIL  $name — could not remove"; total_failed=$((total_failed+1))
    fi
  done
done

echo
if [ "$APPLY" = 0 ]; then
  echo "DRY RUN — reapable: $total_reaped · kept: $total_kept. Re-run with --apply to remove."
else
  echo "reaped: $total_reaped · kept: $total_kept · failed: $total_failed"
fi
