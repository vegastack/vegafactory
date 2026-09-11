---
"@vegastack/vegafactory": patch
---

dev-setup's `factory-board.yml.template` checks the profile out into its own `path: profile` instead of the runner's shared work directory: the sparse checkout of one file left git in sparse mode, and on a self-hosted runner the next job at that path started from an almost-empty tree. Re-run `dev-setup` to refresh a rendered board workflow.
