---
"@vegastack/vegafactory": minor
---

One machine-global worker can now serve multiple explicitly listed repositories without sharing their board context.

- Repositories are provisioned atomically under `~/.vegafactory/worker/repos/`, with separate App tokens, policies, issue caches, hook wiring and push checks.
- A dedicated worker account needs no human GitHub or SSH identity: its selected repository's App token now handles both API calls and HTTPS Git, with Workflows still denied.
- One run cap spans the machine, while ship and file-overlap exclusion remain local to each repository.
- Board failures and roster removal are isolated; removal hands work back without consuming its trigger and leaves checkout reclamation to the attended cleanup command.
- Worker state, locks and service logs now have one machine-global home under `~/.vegafactory/worker/`, and status identifies work as `repo#issue`.
