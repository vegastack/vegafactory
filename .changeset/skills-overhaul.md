---
"@vegastack/vegafactory": minor
---

The skills now match the lean factory, with no stale content left in them.

One fixed label set: the five state labels, three sizes, `research`, `risky` and `epic` are the names themselves everywhere — the `workflow-labels` renaming knob and the old semantic vocabulary behind it are gone, and `readWorkflowStates` replaces `readWorkflowLabels`. On an existing repo dev-setup now lists the pre-lean labels it found, proposes what goes and what arrives, and deletes and creates only on the operator's yes; no old name is stored anywhere afterwards. The `gates:` knob is retired from the resolver, the profile templates and every skill's prose.

Two operator words per issue, an ack and "ship it", and dev-ship runs that one word through the whole landing: PR, merge queue, merge, the `## Ship` runbook's `auto:` steps including a release when one is due, and the worktree cleanup. Its runbook drops the child-into-parent merge machinery that the removed dispatcher needed.

`dev-chronicle` is now dev-status's chronicle mode — one skill, one description, one trigger fixture, the entry format and the "catch me up" digest kept as they were. dev-implement's resume leads with the status comment and the branch. dev-plan's plan format drops the fleet-parallel declaration. skill-scan keeps only the deterministic gate CI runs; its semantic pass is gone.

New skill `skills-refresh`: it re-verifies the dated platform and harness facts the dev skills pin. A watchlist names each topic, the facts-file section that holds it and the vendor pages to read; `facts-scan.mjs` reports which lines are past the 60-day window; one subagent reads each tool's pages and reports what moved; every change becomes its own issue, the confirmed lines become one date bump, and a digest lands on a pinned log issue. It never edits a skill itself. dev-architect's platform facts and dev-setup's harness facts are converted to that one-line format — capability, how, since, checked, official link — so every claim carries its own date and source.

Fixed: `skillify`'s scaffolder now refuses a `packaging.json` that is present but unreadable before it writes anything, instead of leaving a half-wired skill tree behind a raw parser error.
