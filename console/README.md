# helm console — live dashboard

Zero-dependency Node server. Reads QUEUE/BLOCKED/LEDGER/etc. **off disk on every request** — never stale,
no hand-refresh, no generation step. Read-only.

## Run

```
node console/server.js               # http://127.0.0.1:8090 (loopback only by default)
HOST=0.0.0.0 node console/server.js  # binds all interfaces (opt-in; trusted network only, no auth)
```

## Install as a service (systemd user unit)

```
cp console/helm-console.service ~/.config/systemd/user/   # edit the path inside first (see the unit)
systemctl --user daemon-reload
systemctl --user enable --now helm-console
```

## Routes

- `/` — the board: per-project QUEUE / BLOCKED / LEDGER tail. Auto-refreshes every 45s. Every panel title
  links to the full doc.
- `/doc/<path>` — any file under the repo, markdown rendered, relative links resolved so you can click from
  a queue into a plan into a ledger.
- `/raw/<path>` — raw bytes. `/dir/` — file browser.

The board iterates `projects/*/` and renders each project's QUEUE/BLOCKED/LEDGER — so the bundled
`projects/example/` shows up immediately. A future addition is the metrics fold (ROADMAP #15/#17) rendered
into this same server.
