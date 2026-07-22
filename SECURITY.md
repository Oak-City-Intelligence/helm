# Security Policy

## Status

helm is pre-1.0 and evolving. It is a control-plane harness for running autonomous coding agents; take note
of the operational safety posture below before running it anywhere sensitive.

## Reporting a vulnerability

The org security mailbox is not monitored yet. Until it is, report a suspected vulnerability privately
through this repo's advisory feature (GitHub → Security → Report a vulnerability). That reaches the
maintainer without a public issue. The placeholder address **security@\<org-domain-pending\>** is reserved
for the org mailbox once it lands; do not rely on it before launch.

Do not open a public issue for a security report. We'll acknowledge and follow up; there is no
bug-bounty program at this stage.

## Operational safety notes (read before running)

helm dispatches autonomous agents that create branches and open PRs. Its safety model is **doctrine +
convention**, not yet fully code-enforced (see `ARCHITECTURE.md §C` — several safety pieces are marked
partial/MISSING). In particular:

- **Drain-only unattended authority.** Unattended tiers may only dispatch pre-authored, clarity-gated items
  and reconcile PRs — never author, merge, or deploy. This is largely prompt-enforced today; treat it as a
  policy you must uphold, not a guarantee the code makes for you.
- **Human merge/deploy gate.** helm ends at a PR. A human merges. Never wire auto-merge without an explicit,
  logged decision.
- **Least privilege.** Workers use a single git credential/token per project identity. Scope that token
  tightly and rotate it; there is no built-in rotation.
- **No secrets in the control-plane repo.** Keep credentials and secret material out of `projects/*/config.yml`
  and out of any file under version control.
- **Kill switch.** `touch dispatch/STOP` makes every unattended run a no-op.

If you find a way the drain-only or human-gate invariants can be bypassed, that is exactly the kind of report
we want.
