# Decision register

One dated line per directional decision (see `## Decisions` in dev.md for what qualifies); append-only. Format: `- DD-MM-YYYY (github-username) — the decision`. The register is never rewritten.

- 27-08-2026 (kmanojkumar) — Adopted the dev workflow skills for this repo itself (dev.md handbook, operator labels, Ship runbook = the changesets release flow).
- 28-08-2026 (kmanojkumar) — .vegastack/dev.md is each project's single canonical process doc: policy docs fold into it as Ship bullets, the decision register lives beside it at .vegastack/decisions.md, and every rule that can be a deterministic check becomes a guard (local first, CI backstop).
- 28-08-2026 (kmanojkumar) — Dev-skills v2 profile-format changes ship as a minor release: pre-1.0, zero deployed consumers, and the only existing profile (this repo's) is rewritten in the same release.
- 28-08-2026 (kmanojkumar) — architect → dev-architect; arch.md folded into dev.md as ## Architecture; ADRs retired — decisions.md is the only decision record.
- 28-08-2026 (kmanojkumar) — Renaming a skill ships minor by default; major only on the operator's explicit call (removal stays major).
- 30-08-2026 (kmanojkumar) — Authored skills may be grouped one level deep under skills/<group>/ with a GROUP.md; packaging keys and the published bundle stay flat, so install commands never carry a group.
- 31-08-2026 (kmanojkumar) — Skill scanning is a first-class workflow stage: a deterministic SkillSpector guard at the Verify gate blocking on unsuppressed HIGH/CRITICAL findings (never on the aggregate score), triaged by dev-review's Security axis, with suppressions as a justified, reviewed baseline whose matchers are literal.
- 01-09-2026 (kmanojkumar) — The skill scanner provisions and updates itself through the machine's own channel, defaulting to on: freshness rides on the guard's own runs, never a scheduled job or a version-check throttle, and the guard resolves the binary rather than trusting PATH.
- 03-09-2026 (kmanojkumar) — One feature is one worktree at `.vegastack/.worktrees/<n>-<slug>`; an epic's children stack on the parent branch inside it and merge into that branch, and the feature ships as one PR.
- 03-09-2026 (kmanojkumar) — Labels stay the workflow's machine state; a GitHub Projects board is a read-mostly mirror synced from labels, and org issue fields are the noted future replacement.
- 03-09-2026 (kmanojkumar) — Humans own issues; a GitHub App token is used only by automation (board mirror, Actions, the token broker), never as an agent's identity.
- 03-09-2026 (kmanojkumar) — Factory configuration layers org to group to repo in a control-room repository, nearest wins for a knob and registers concatenate.
- 03-09-2026 (kmanojkumar) — The product is VegaFactory: repository `vegastack/vegafactory`, package `@vegastack/vegafactory`, binary `vegafactory`, with a direct cutoff and no compatibility shims.
- 03-09-2026 (kmanojkumar) — Skill prose follows the current Anthropic model-prompting guidance: positive rules carrying their reason, no restated harness behaviour, removal preferred to rewriting, proven by eval.
- 04-09-2026 (kmanojkumar) — The hosted token broker is a customer path and vegastack dogfoods it: other orgs install the public App and mint one-repository tokens through `factory-token.vegastack.com`, and vegastack's own Actions do the same rather than using the org secret directly; installing one's own App with `actions/create-github-app-token` stays the documented fallback
- 04-09-2026 (kmanojkumar) — The broker persists nothing: no storage binding of any kind, the App key in a Cloudflare Secrets Store secret, rate limiting through the platform binding, and `config-check.mjs` blocking any KV, D1, R2 or Durable Object binding that appears
- 04-09-2026 (kmanojkumar) — The ship guard enforces a compiled local policy: `vegafactory guard sync` writes `~/.vegastack/guard/<owner>__<repo>.json` from dev.md, the hook reads only that file and never dev.md, it fails closed when the policy is missing or stale, and the policy path itself is always-ask
