---
name: skill-scan
description: Scan agent skills for prompt-injection, rogue-agent, and supply-chain findings with NVIDIA SkillSpector, and hold the suppression baseline that records which findings are accepted and why. Use when asked to scan or vet skills, to judge whether a third-party or downloaded skill is safe to install, when a scan blocks and its findings need triage, when a file edit expires a coverage acceptance and it needs re-adjudicating, or when dev-implement's Verify gate or a project's Ship guard runs the scan. Not for reviewing a code diff against its brief and plan (dev-review, whose security axis consumes this scan's report), authoring or auditing a skill (skillify), or repo release standards (skill-maintainer).
---

# skill-scan

An installed skill runs with your agent's authority, so a skill you did not read is a program you did not read. This guard scans skills — yours and strangers' — with NVIDIA SkillSpector, and holds the record of every finding anyone decided to accept.

Nearest neighbors: `dev-implement` runs this at its Verify gate and a project's `## Ship` runbook runs it before publishing; `dev-review`'s Security axis consumes the report this produces and triages what sits below the blocking bar; `skillify` audits a skill's completeness, which is a different question entirely.

## Running it

Run from the project root, with `<path-to-skill-scan>` standing for wherever this skill is installed:

```sh
node <path-to-skill-scan>/scripts/skill-scan.mjs --json           # the gate: reads the knobs and the project baseline
node <path-to-skill-scan>/scripts/skill-scan.mjs --root ~/Downloads/some-skill   # vet a skill you did not write
node <path-to-skill-scan>/scripts/skill-scan.mjs --no-provision   # this run installs and upgrades nothing
```

**Exit codes are the contract: 0 pass (or skipped) · 1 pass-with-warnings · 2 blocked.** Exit 2 stops the hand-back — fix the finding, or take it to the operator for a justified baseline entry. Widening a rule to reach green is the one move this guard exists to prevent. The scan is always the deterministic pass; there is no semantic mode, because a report no check gates on is a network call nobody reads.

## The two knobs, both in `.vegastack/dev.md`

- `skill-scan:` names the root to scan — in a repo that builds a bundle, the **built** one, because that is what the world installs. `none` (or no line) turns the scan off and the guard says plainly that it skipped. A profile it cannot *read* is a different answer and blocks, so the gate can never disable itself by being run from the wrong directory.
- `skillspector-update:` takes `off | notify | auto`, and an absent line reads as `auto`: `auto` installs SkillSpector when absent and upgrades it before every scan (any failure falls back to the installed copy and the scan continues), `notify` reports the newest release and changes nothing, `off` makes no network call. The mode is read from the profile on **every** run, `--root` included — `--root` chooses what to scan, never whether this machine may be written to. `--no-provision` opts a single run out.

The guard finds the CLI through whatever channel installed it — uv, Homebrew, or pipx — and runs it by absolute path, so it works when the agent's shell `PATH` differs from the operator's. Only a scanner no channel reports *and* that is not on `PATH` refuses, and that message names every remedy.

Discovery reads exactly two levels: a skill sitting directly under the scan root, and a skill one group deep. Anything else holding a skill manifest blocks rather than being skipped — buried deeper, dot-prefixed, or behind a symlink, which is never followed. An unscanned skill nobody mentions looks exactly like a clean one.

## The baseline — three sections, and the discipline behind them

`.vegastack/skillspector-baseline.json` is applied by convention when no `--root` is given. An explicit `--root` never inherits it: a rule written for your own content should not silence a finding in someone else's skill.

| Section | Accepts | Keyed by |
|---|---|---|
| `rules` | a finding class this project has judged and accepted | literal `id` and `path` |
| `fingerprints` | one specific occurrence | content hash |
| `coverage` | a file the scanner could not finish reading | `skill` + `file` + `sha256` |

`coverage` is ours rather than SkillSpector's, whose baseline suppresses findings only and cannot express "I could not finish reading this" — which any skill shipping ordinary JavaScript will hit. An acceptance covers exactly the file it names and exactly the bytes it names: **editing the file expires its acceptance**, and the fix is to re-adjudicate — confirm the reason code and degraded-analyzer count still hold, record the fresh digest, and append one sentence saying what changed — never to widen the entry.

Two rules the guard enforces rather than trusts:

- **Matchers are literal.** `*`, `?`, `[` and `]` are rejected. A single `{"id": "*"}` once silenced every finding while the run reported success, and a fix that rejected `*` was bypassed by `?*` immediately. Naming the file is the only "as narrow as its cause" a guard can check.
- **Every entry carries a `reason` with a "Still flag if:" clause** — the same discipline as `dev-review`'s known-patterns file. A suppression with no exception clause is a blind spot, and a rule scoped `id:` with no `path:` is a repo-wide one.

It blocks on any unsuppressed HIGH or CRITICAL finding and never on the aggregate risk score, which is inflated by documentation of the very mechanics being scanned and deflated by unrelated suppressions. A degraded scan blocks too: a run whose analyzer failed reports a *higher* score with fewer filtered findings, so its silence proves nothing. An upgrade that changed anything is reported before the findings, because a new finding after an upgrade is the tool having learned something.

## Findings that have nowhere to land

Point `--root` at a stranger's skill before it reaches your agent; treat a hit as a candidate finding, never a verdict, and never downgrade an unexplained HIGH or CRITICAL on the strength of who published it. A scan run outside a review — a standalone vetting run, or the pre-publish guard in a project's `## Ship` runbook — has no review comment to land in, so its findings go to `dev-intake` as one `risky` issue carrying the findings, their locations and what is known about each cause. A finding posted somewhere convenient is a finding nobody owns.
