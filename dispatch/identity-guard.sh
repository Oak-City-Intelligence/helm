#!/usr/bin/env bash
# identity-guard.sh — per-project realm hygiene for helm.
#
#   identity-guard.sh <config.yml> <base_ref> [worktree_dir]
#
# Some projects must stay unlinkable from others — work published under an org account that
# must never be traceable to the maintainer's personal account, or vice versa. A project's
# config.yml declares an `identity:` realm (a label you choose, e.g. `org` | `personal`) and a
# `forbid:` list — the OTHER realm's identity strings, which must never appear in this project's
# commits. This guard checks the branch's commits (authorship + added diff lines) against that
# list and exits non-zero on any hit. A hit is a cross-realm identity leak, and those are not
# retractable once pushed: the guard runs before the push, not after.
#
# Run by the worker after it commits, before it reports done. A non-zero exit is a BLOCK.
set -euo pipefail

config="${1:?usage: identity-guard.sh <config.yml> <base_ref> [worktree]}"
base="${2:?need base ref}"
work="${3:-.}"

# Pull the forbid list out of config.yml (the `- item` lines under `forbid:`).
mapfile -t forbid < <(awk '
	/^[[:space:]]*forbid:/ {f=1; next}
	f && /^[[:space:]]*-[[:space:]]/ {
		sub(/^[[:space:]]*-[[:space:]]*/,""); sub(/[[:space:]]*#.*/,"");
		gsub(/^["'\'']|["'\'']$/,""); if (length) print; next }
	f && !/^[[:space:]]*-/ {f=0}
' "$config")

[ "${#forbid[@]}" -gt 0 ] || { echo "identity-guard: no forbid list in $config — nothing to check"; exit 0; }

# Build one case-insensitive alternation. Escape regex-significant chars in each term.
pat=""
for t in "${forbid[@]}"; do
	esc=$(printf '%s' "$t" | sed 's/[.[\*^$()+?{|]/\\&/g')
	pat="${pat:+$pat|}$esc"
done

fail=0
# 1) authorship of the branch's commits (the identity that will be stamped)
authors=$(git -C "$work" log "$base"..HEAD --format='%an <%ae>%n%cn <%ce>' 2>/dev/null || true)
if printf '%s\n' "$authors" | grep -iEq "$pat"; then
	echo "identity-guard: BLOCK — a forbidden-realm identity is the AUTHOR/COMMITTER:" >&2
	printf '%s\n' "$authors" | grep -iE "$pat" | sort -u | sed 's/^/    /' >&2
	fail=1
fi
# 2) added content in the branch's diff (a string pasted into a file)
added=$(git -C "$work" diff "$base"...HEAD 2>/dev/null | grep '^+' || true)
if printf '%s\n' "$added" | grep -iEq "$pat"; then
	echo "identity-guard: BLOCK — a forbidden-realm string was ADDED to the diff:" >&2
	printf '%s\n' "$added" | grep -inE "$pat" | head -10 | sed 's/^/    /' >&2
	fail=1
fi

[ "$fail" = 0 ] && echo "identity-guard: clean (no cross-realm identity leak)"
exit "$fail"
