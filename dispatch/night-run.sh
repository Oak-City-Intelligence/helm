#!/usr/bin/env bash
# helm — nightly DRAIN-ONLY autonomous run. Fired by a systemd user timer (this box has no cron).
# Drains helm/dispatch/QUEUE.json via one headless Claude: dispatch → PR → LEDGER → NIGHT-REPORT.
# NEVER authors, merges, or deploys (see night-prompt.md HARD RULES). Bounded; stops itself.
set -uo pipefail

# Adapt these three to your box; a systemd user unit starts with an empty environment.
export HOME="${HOME:?set HOME}"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"
INFRA="$HOME/projects/infra"          # the control-plane repo that holds helm/
HELM="$INFRA/helm"
DISPATCH="$HELM/dispatch"
LOG="$DISPATCH/night.log"

cd "$INFRA" || { echo "$(date -Is) cannot cd to $INFRA" >>"$LOG"; exit 1; }

# Kill switch — operator drops this file to pause the fleet, no matter what's queued.
if [ -f "$DISPATCH/STOP" ]; then
  echo "$(date -Is) STOP file present — skipping night run" >>"$LOG"
  exit 0
fi

# Reap merged worktrees BEFORE the queue-empty exit — sweeping is worth doing on a quiet night too,
# and dispatch only ever creates these (nothing removed them for a month: 139 trees / 21G on one project,
# 153 on another). Guards are in the script: merged-into-base + clean + older than 3d, branches kept.
# Non-fatal: a reap failure must never block a drain.
"$DISPATCH/reap-worktrees.sh" --apply >>"$LOG" 2>&1 \
  || echo "$(date -Is) worktree reap failed (non-fatal, continuing)" >>"$LOG"

# No fuel, no burn. If the queue is empty (`[]` / whitespace), do NOT spin up Claude for nothing.
if ! grep -q '"' "$DISPATCH/QUEUE.json" 2>/dev/null; then
  echo "$(date -Is) QUEUE.json empty — nothing to drain, skipping" >>"$LOG"
  exit 0
fi

echo "$(date -Is) ===== night run START (queue non-empty) =====" >>"$LOG"

# Wall-clock ceiling: a drain is short (dispatch + collect). 2h is generous headroom.
timeout 2h claude -p "$(cat "$DISPATCH/night-prompt.md")" \
  --dangerously-skip-permissions >>"$LOG" 2>&1
rc=$?

echo "$(date -Is) ===== night run END (exit $rc) =====" >>"$LOG"
exit 0
