# helm — STARTUP (manual-start procedure · the dock)

**helm services are started BY HAND by default.** No systemd units get enabled without an explicit
operator decision — a deliberate choice, not an oversight. Unit files are written and kept beside each
service so "cementing" into systemd is a two-command act *later*; until then, this file is the startup
checklist.

Throughout, `$HELM_ROOT` is the path to this repo (e.g. `export HELM_ROOT=/path/to/helm`).

> **This pre-1.0 cut bundles the console + the burst/gauntlet/intake dispatchers + `ci-audit.js`.** The
> nightly + review-watch runner scripts (`night-run.sh`, `review-watch.sh`) and the meter helpers
> (`ledgertool.js`, `usage-today.js`) referenced below are described for completeness but are **not included**
> in this release; the service unit files are templates for when you wire those tiers yourself.

## What runs, how to start it, how to check it

### 1. Console — live dashboard (read-only)
The Captain's seat: a board of per-project QUEUE/BLOCKED/LEDGER with click-through to every doc. Reads disk
per request; never stale.
```bash
# start (foreground; put it in a persistent session so the layout survives)
node "$HELM_ROOT/console/server.js"
# check
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8090/    # 200 = up
```
Open: http://localhost:8090
Binds loopback (127.0.0.1) only by default. All-interfaces variant (opt-in, trusted network only, no
auth): `HOST=0.0.0.0 node "$HELM_ROOT/console/server.js"`

### 2. Burst dispatch — drain the queue, live session
Proven path. Run from an orchestration session; drains `dispatch/QUEUE.json` drain-only (PRs, never
merges). See `dispatch/RUNMODE.md` §1 and `dispatch/README.md`.

### 3. Nightly drain — headless overnight run (NOT armed by default)
`night-run.sh` honors the `dispatch/STOP` kill switch and exits if the queue is empty. To run one night
MANUALLY (instead of the timer):
```bash
"$HELM_ROOT/dispatch/night-run.sh"            # one shot, writes NIGHT-REPORT.md
```

### 4. Review-watch — back-door PR reconciler (PARKED by default)
One tick by hand (never leave it looping without deciding to):
```bash
"$HELM_ROOT/dispatch/review-watch.sh"         # single pass; budget-capped
```

### 5. Meters / kill switch (on-demand, not services)
```bash
node "$HELM_ROOT/dispatch/usage-today.js"     # combined token spend today
node "$HELM_ROOT/dispatch/ledgertool.js" state <project>   # true per-item state
touch "$HELM_ROOT/dispatch/STOP"              # halt all autonomous paths
rm    "$HELM_ROOT/dispatch/STOP"              # resume
```

## Suggested session-start ritual (manual, ~30 seconds)

1. `node "$HELM_ROOT/console/server.js"` in a persistent session (if not already running) → open the board.
2. Glance: BLOCKED → PRs awaiting click.
3. Stock/verify `dispatch/QUEUE.json` if a burst is planned. STOP file absent?

## Cementing into systemd — LATER, deliberately (do not run these yet)

Service unit files already exist beside each service. When (if) the operator decides:
```bash
# console
cp "$HELM_ROOT/console/helm-console.service" ~/.config/systemd/user/
# nightly + review-watch services (pair each with a .timer unit you write for your cadence)
cp "$HELM_ROOT/dispatch/helm-nightly.service" ~/.config/systemd/user/
cp "$HELM_ROOT/dispatch/helm-review-watch.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now helm-console                 # each unit is a separate decision
loginctl enable-linger "$USER"                             # units run while logged out
# undo any of it
systemctl --user disable --now <unit> && rm ~/.config/systemd/user/<unit>*
```
> The service units in this repo have no paired `.timer` files — write a `.timer` per your own cadence
> (or run the scripts by hand / from your own scheduler). Arming nightly ≠ arming review-watch; each unit
> gets enabled separately.

Decision owner: the operator. Confirm your scheduler actually fires on your box before trusting it.
