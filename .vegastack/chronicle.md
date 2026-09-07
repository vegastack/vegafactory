# Chronicle — vegafactory

The project's story, newest first: what got built, why, and how it went — for the operator's future recall. Format home: the dev-chronicle skill.

## 07-09-2026 — Policy has one authority model ([#145](https://github.com/vegastack/vegafactory/issues/145))

- **What:** Organization locks, group defaults and repository choices now resolve through one helper, alongside explicit admin/read scopes and registered-machine settings. Consumers keep the source and reason when a requested override is refused.
- **Why:** Separate parsers let a group unlock mandatory org reporting and omitted org stage defaults. Descriptive lead rows could also grant broad people views without an explicit admin assignment.
- **How it went:** Focused failures exposed those contradictions before their adapters changed. Real Git fixtures cover separate repo/group snapshots, changed local policy, wrong origins and expired validation. Shared evaluation and final candidate review remain separate acceptance gates.
- **Changed:** Effective policy resolver · administration/fleet contracts · runtime/stats/guard adapters · scoped people reads · migration and source diagnostics.
- **Decisions:** none.

— approved by (kmanojkumar) · built by codex · branch codex/productionization-133

## 07-09-2026 — Approval follows the work that was actually approved ([#135](https://github.com/vegastack/vegafactory/issues/135))

- **What:** Scoped approval records now bind the operator’s quoted intent to current brief and plan identities. Task progress keeps its approval; changed requirements require fresh intent. Parent selections distinguish code, preparation and research permissions.
- **Why:** The old preflight accepted a bare approval marker even after the brief changed. That could start work whose actual scope had never been approved.
- **How it went:** Subprocess tests reproduced both failures. The shared parser and launch gate reject them; preparation and research adapters retain their separate evidence requirements. Final acceptance still needs the recorded scope, evaluation and review gates.
- **Changed:** Current-scope preflight · dispatcher admission · inspectable legacy reconfirmation · frozen-manifest retrieval · counted research reservations.
- **Decisions:** none.

— approved by (kmanojkumar) · built by codex · branch codex/productionization-133

## 03-09-2026 — vegastack-skills became VegaFactory: a runtime around the skills, and a dashboard to watch it ([#104](https://github.com/vegastack/vegastack-skills/issues/104))

- **What:** epic B, eighteen children stacked on one branch, turned a skills installer into a factory. The package is `@vegastack/vegafactory` and the bin is `vegafactory`; the authored groups are `dev`, `factory`, `skills-tooling` and `repo-tooling`. Around the skills there is now a runtime: one feature = one worktree with `worktree` verbs and a retention policy, an `operators:` roster so assignment follows the state label, a hooks package whose ship guard reads dev.md per environment, the issue itself as the interview surface when no question tool exists, an org control room cloned locally and refreshed by `vegafactory sync`, a dispatcher that turns labels and 🚀 reactions into headless runs, parallel children where a plan declares disjoint file sets, a public GitHub App with a board mirror, and statistics recorded per run into the control room. The last child is the one that makes all of it legible: `vegafactory dashboard` starts a local, read-only Next.js view — org, repo, people, skills, board, dispatcher — over those statistics and the live board. Alongside it, a hosted token broker ([#117](https://github.com/vegastack/vegastack-skills/issues/117)) — a Cloudflare Worker at `packages/broker` that trades a GitHub Actions OIDC token for a one-repository, issues-and-projects token — lets any org that installs the public App drive the factory without ever holding a private key of its own.
- **Why:** the skills were good and the machinery around them was a human. Every gate that mattered ran through the operator's own terminal and memory: which branch belonged to which issue, who owned an issue as it moved, whether a run had been started, what a month of agent work had cost. The epic's premise was that the gates worth keeping human should stay human and everything else should become mechanical — and that you cannot decide which is which until you can see where the time and money actually go.
- **How it went:** the dashboard child is the one this entry can speak to first-hand, and its shape is the epic's shape. The data layer was built as plain TypeScript under `src/lib/**` that the pages render as thin server components, so every deterministic branch is a `bun test` unit against fixture files and no test needs React, a browser, or a network — thirteen tests over eleven modules, red before green, and not one of them renders a page. The cache is deliberately disposable: it holds nothing the control room does not, so a schema change is a `PRAGMA user_version` bump and a delete, and deleting the file by hand is always safe. Two decisions were made against the obvious: the filter set resolves a group name to a concrete repo list at parse time rather than threading the control room's `repos.md` into six query signatures, and a value the option list does not contain falls back before it can reach SQL at all — the queries bind parameters too, but a filter that cannot hold an arbitrary string cannot carry one. The people gate lives in exactly one function and is applied per row, so the list and the detail page cannot disagree about who is visible, and a refused person page assembles no data at all rather than hiding markup.
- **What is unfinished:** the design-system copy-in. The ten registry components need `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` service tokens that only the operator holds, so the pages render semantic markup over the design system's own tokens — no literal colour or size is declared — and the copy-in is one command waiting on the credentials. The dashboard package's first publish is a bootstrap `npm publish` under a short-lived token, because trusted publishing cannot be configured for a package that does not exist yet.
- **Changed:** a new `packages/dashboard` (Next.js App Router, `output: 'standalone'`, assembled into `dist-standalone/` by `scripts/assemble.mjs`) · `packages/cli/src/dashboard.ts` and the `dashboard` verb, which leaves the reserved list · the root `typecheck` and `lint.mjs` now cover every workspace package, not just the CLI · `.github/workflows/release.yml` verifies both manifests carry the tag version and publishes the dashboard beside the CLI · dev.md gains that guard in `## Ship` and the both-keys clause on the changeset rule · both READMEs.
- **Decisions:** none new in this child — the epic's own decision record (#104's "Decisions so far") already carries the rename, the worktree model, the control-room layering, the dispatcher and the dashboard's own architecture, each settled with the operator in the 02–03 Sep scoping interview.

— approved by (kmanojkumar) · built by claude · branch feat/122-dashboard

## 03-09-2026 — The dev skills now read like guidance, and a chat request lands on the right skill ([#103](https://github.com/vegastack/vegastack-skills/issues/103))

- **What:** the ten dev skills were rewritten as one feature — epic [#93](https://github.com/vegastack/vegastack-skills/issues/93), ten children [#94](https://github.com/vegastack/vegastack-skills/issues/94) to [#103](https://github.com/vegastack/vegastack-skills/issues/103) on one stacked branch. A request typed in chat now routes by a six-row table in the AGENTS.md dev block, with a short harness-neutral conduct paragraph beside it; every description is a calm "Use when … Not for …" conditional, and a deterministic trigger check blocks two skills claiming one query. The three sentences every skill repeated live in one place each, operational detail moved out of bodies into references and scripts (an evidence-upload script, a changelog-and-chronicle reference), README file tables are generated from `packaging.json`, dev.md gained `architect:`, `chronicle-style:` and `emoji:` knobs, the harness facts are current for Claude Code, Codex, Hermes and the gh floors, skill-maintainer and skillify were sharpened against each other, every skill carries agentskills.io eval cases, and finally every dev body was rewritten to the prose standard: one stance sentence, positive rules with their reason, at most two emphasised non-negotiables, no caps-emphasis, no instruction the model already follows.
- **Why:** Codex routed "add support for mermaid and latex" to dev-implement, because nothing always-loaded said a new capability typed in chat is intake, and dev-implement's description invited it. The scoping interview found the same cause everywhere: the skills were written for earlier models — emphatic triggers that now over-trigger, 103 "never"s, instructions to re-verify and double-check that the model already follows, and bodies past 1,800 words.
- **How it went:** the routing, description, fixture and knob children landed cleanly, one per branch, stacked. The one-home sweep ran into SkillSpector's static parse limit on `conventions.md` — one added sentence degraded ten skills — so that file was rewritten word-neutral and every later child kept its net words at zero. The eval runner (`claude plugin eval`) stayed gated behind early access on every probe, so the subagent procedure remained the proof; on the prose pass it could not run at all, because the harness had no subagent tool and headless `claude -p` had no login, so the before/after eval is the one piece handed back open. Four bodies stayed over 1,200 words with a named exception rather than a cut rule: dev-implement (1,629), dev-setup (1,705), dev-intake (1,223) and dev-review (1,212).
- **Changed:** AGENTS.md dev block (routing table, conduct paragraph, reversibility list) · every dev-skill description and its trigger fixtures · `skillify/scripts/trigger-check.mjs` in `bun run check` · `packages/cli/scripts/readme-sync.mjs` and the structure check that enforces it · `conventions.md` rewritten word-neutral · `harness-facts.md` refreshed with five new refresh sources · `dev-implement/scripts/evidence-upload.mjs` and `references/changelog-and-chronicle.md` · the `architect:`, `chronicle-style:` and `emoji:` knobs, `dev-chronicle/references/styles.md` · skill-maintainer and skillify bodies and fixtures · `evals/evals.json` per skill and the eval playbook · all ten dev SKILL.md bodies, `dev-review/references/dispatch-prompts.md` (data-first preamble, recall-first briefs), `dev-intake/references/brief-template.md` (SOW example), `dev-architect/references/ai-agents.md` (append-only history, no prefill).
- **Decisions:** none — the placement rule, the description standard and the body standard are written into the AGENTS.md block, the trigger check and skill-maintainer's rules, and dev.md says write the rule rather than record a decision when a rule can carry it.

— approved by (kmanojkumar) · built by claude · branch docs/103-prose-pass

## 02-09-2026 — The workflow learned to notice a dead session, and to tick its own boxes ([#90](https://github.com/vegastack/vegastack-skills/issues/90))

- **What:** two live-state artifacts stopped drifting from reality. `dev-status` now reads a `working` claim's ledger edit-time in **hours** and flags it *possibly-orphaned* once the ledger has been silent past six hours or was never written — the claim's heartbeat has stopped. A new operator-run `reclaim.mjs` releases such a claim (`working` → `ready`, unassign) behind a read-verify that refuses a ledger still fresh under the threshold unless `--force`. And `evidence-check.mjs --issue` now blocks a hand-back when the ledger's completed tasks outnumber the plan comment's checked boxes, so the progress view the operator reads can no longer silently lag the work.
- **Why:** a session claimed #4, committed three tasks, then went dark mid-task and never released `working` — the issue advertised itself in-progress for roughly thirteen hours until a human noticed and handed it to a fresh session. The label was a lease with no expiry and no liveness signal; the only safety net flagged staleness at three whole days and could not even represent a sub-day orphan. The checkbox rot was the same disease pointed the other way: a second write, to a different comment than the ledger, that the resume path never reads and nothing verified — so it was the one that rotted.
- **How it went:** the diagnosis did most of the work, and the key move was refusing the obvious fix. The postmortem asked for a heartbeat; the right answer was that the ledger already *is* the heartbeat — `status.mjs` had read its edit-time for staleness all along — so a separate liveness timestamp would only have added a third drift-prone source of truth competing with the ledger. The threshold was chosen aggressive (six hours) on the reasoning that the signal is silence *between checkpoints*, not session length: a session running for days that keeps checkpointing never trips it, and the flag never auto-acts, so a false positive on a long single task costs a glance, not a killed session. Two guards that could have lived in one place stayed separate on purpose — the checkbox check fetches issue comments and so could not fold into `evidence-check`'s pure file-shape linter without a network seam, so it became a second exported function the CLI runs only when handed `--issue`. The `status.mjs` interface changed (`--stale-days` → `--orphan-hours`, `stale` → `possiblyOrphaned`), tolerable only because the sole consumers are this repo's own skill and its tests.
- **Changed:** `dev-status`'s `status.mjs` (hour granularity, the possibly-orphaned band) and its render + honesty prose · `dev-implement`'s `evidence-check.mjs` (the consistency guard) and a new `reclaim.mjs` with its read-verify · `dev-implement`'s SKILL, `ledger-and-resume.md`, and README naming one-session-one-issue, promoting the checkbox tick from a parenthetical to a first-class checkpoint, and framing the ledger as the heartbeat · `packaging.json` for the new script · three new test seams (orphan bands, checkbox consistency, reclaim read-verify) · three re-adjudicated skill-scan coverage acceptances.
- **The scanner detour:** the build passed `check` but the skill-scan gate blocked 34 ways. A one-line liveness note added to the shared `conventions.md` tipped that file past SkillSpector's `static_parse_limit`, degrading every skill that bundles it — so the note was dropped back to `ledger-and-resume.md`, its real home, rather than buy 10 suppressions for one sentence. The three guard scripts hit the same parse limit already accepted repo-wide (preflight, ship-gate, status), re-adjudicated per-file on the operator's word; and one self-inflicted AE1 came from referencing `scripts/reclaim.mjs` bare instead of through the `<path-to-this-skill>/` placeholder every other reference uses.
- **Decisions:** none — the heartbeat-is-the-ledger principle is written as a rule in `conventions.md`, and dev.md says write the rule rather than record a decision when a rule can carry it.

— approved by (kmanojkumar) · built by claude · branch fix/state-drift-guards

## 02-09-2026 — The guard stopped trusting PATH, and learned to install its own scanner ([#83](https://github.com/vegastack/vegastack-skills/issues/83))

- **What:** `skill-scan` now finds SkillSpector through whichever channel installed it — uv, Homebrew, or pipx — and runs it by absolute path, so a working install is never reported as missing. A new `skillspector-update:` knob (`off | notify | auto`, absent reading as `auto`) installs the CLI when it is absent and upgrades it before every scan; any failure falls back to the copy already installed and the scan continues. Only a scanner that no channel reports *and* that is not on `PATH` still refuses, and that message finally names all three remedies including `VSK_SKILLSPECTOR`.
- **Why:** the operator had installed SkillSpector correctly and the guard still exited 2 telling them to install it again. The cause was not their machine — `~/.zshenv` exported the directory and every fresh shell resolved the binary. Only the agent's long-running session shell carried a stale `PATH`. A guard that trusts `PATH` is trusting the environment of whatever shell launched it, which for an agent is routinely not the operator's. The obvious repair does not repair it either: `uv tool update-shell` exits 2 with "not in PATH, but the Zsh configuration files are already up-to-date", because it inspects the running process.
- **How it went:** the intake was longer than the build, and worth it — four designs were drafted and thrown away before the right one appeared. A weekly refresh job was proposed and rejected on evidence: upstream ships roughly every two days, so the job would fire every week always finding something, and a PR that always needs security judgement gets rubber-stamped, corroding the baseline discipline it existed to protect. A version-floor check was rejected because it would have overturned `dev-review`'s evergreen refresh waiver. A throttled version check died when a measurement killed it: `uv tool upgrade` moved `botocore`, `langsmith` and `boto3` while `--version` held at 2.11.0 — the version string is not a freshness signal, so checking before upgrading would have been theatre. And the whole per-OS install ranking, brew on macOS and uv on Linux, evaporated when someone finally read upstream's README: it documents uv and never mentions Homebrew at all. Two bugs were caught before they shipped. `brew --prefix skillspector` exits 0 and prints a path for any formula homebrew/core *knows*, installed or not — the planned detection would have claimed a binary that was not there; detection moved to `brew list --versions` and every channel's path is now checked on disk. And the first attempt made the outside-`PATH` note a *warning*, which pinned the exit code at 1 forever for exactly the setup the feature existed to serve; the Spec reviewer caught it. All three review axes independently found that `--root` bypassed the update knob — the single invocation `dev-review` documents for vetting a stranger's skill was the one with no consent gate.
- **Changed:** a new `dev-review/scripts/lib/skillspector.mjs` carrying locate/install/upgrade/version behind injected runners · `skill-scan.mjs`'s binary resolution, the new knob, an extracted `provisionForRun()` and a warning when an upgrade outdates a fingerprint-pinned baseline · `dev-setup`'s detection row and profile template, so every downstream project inherits the knob · `dev-review`'s README and SKILL.md, `CONTRIBUTING.md`, and this repo's own `dev.md` · **`dev-review`'s evergreen refresh waiver retired and six sources registered**, because the skill now parses third-party command output for the first time and every one of those parsers fails silently · a new `.vegastack/review-known-patterns.md` holding two operator dismissals with their "Still flag if:" clauses · two re-adjudicated coverage acceptances in the skill-scan baseline.
- **Decisions:** one — the scanner provisions and updates itself through the machine's own channel, defaulting to on, with freshness riding on the guard's own runs rather than a schedule.

— approved by (kmanojkumar) · built by claude · branch feat/skill-scan-self-provisioning

## 01-09-2026 — The recommended install moved to the home directory ([#80](https://github.com/vegastack/vegastack-skills/pull/80))

- **What:** `add --group dev-skills --global` is now the headline command in the root README, the installer README, and all ten dev-skill walkthroughs. Project-local stays documented for repos that should carry their own copy, and `skill-maintainer` and `skillify` are named as the deliberate exception — repo-only skills that a global install would make trigger everywhere.
- **Why:** one command, once per machine, available in every project; and it is the only mode that can target all three runtimes, because Hermes has no project-level discovery at all. The docs had been recommending the one install shape that cannot cover the full matrix.
- **How it went:** the install flag was the small half. Writing the precedence sentence produced the correction that mattered — the first draft said a project copy overrides a global one, which is backwards: Claude Code ranks enterprise > personal > project, so installing both leaves the *project* copy unused. The repo's own `standards.md` had the sourced fact and the READMEs had never carried it. Two more gaps surfaced from actually running what the docs promised, all nineteen commands: there was no upgrade command anywhere, and `add` refuses a differing installed copy, so the missing command also needed the missing `--force` explanation. The skill-scan invocation hardcoded `.claude/skills/dev-review/…`, a project-local path a global install does not have. Fences that mixed a command with its alternative meant pasting a block ran something you had not asked for. The scaffolder had to follow or every future skill would regress to the old shape — and that edit expired `scaffold-skill.mjs`'s coverage acceptance exactly as designed, forcing a re-adjudication that a scan of the pre-change build settled: same reason code, same single degraded analyzer, identical finding set, one RP1 two lines lower.
- **Changed:** the root README, restructured with badges, a table of contents, a requirements table, a numbered quick start and a contributing section · the installer README's header, surfaces table and a new upgrading section · ten dev-skill install blocks and two repo-only exception notes · `skillify`'s scaffolded-README template, its `groupInstallBlock` substitution and the tests asserting both shapes · `CODE_OF_CONDUCT.md`, linked from `CONTRIBUTING.md`, with enforcement routed to the repo's private reporting form so no address needs maintaining · a refreshed sha256 in the skill-scan baseline.
- **Decisions:** none — the `skillify` template now enforces the install shape, and `dev.md`'s rule says write the rule rather than record a decision when a rule can carry it.

— approved by (kmanojkumar) · built by claude · branch docs/readme-global-install

## 01-09-2026 — The scaffolder stopped saying "done" to a job it had not done ([#59](https://github.com/vegastack/vegastack-skills/issues/59))

- **What:** `skillify`'s scaffolder now refuses, before writing anything, when the repo it is pointed at has no `README.md` or no `packages/cli/packaging.json`. It exits 1 and names the missing path and what it was needed for. Until now it built the whole seven-file tree, printed `Created …`, exited 0, and listed the two missing wiring steps as `skipped:` — leaving a skill that `structure.mjs check` blocks on the very next run.
- **Why:** it is the twelfth instance of this repo's signature defect — a command reporting success while leaving state its own checker rejects. An adversarial reviewer found it during #58 and it was deliberately left alone there, because fixing it changes a documented, tested contract that #58's brief did not authorise. So it got its own issue rather than a quiet fix.
- **How it went:** straightforwardly, and the interesting part was what did *not* change. Three things stay permissive on purpose, and each now has a test saying why: `wireSkill` called on its own is a wiring primitive rather than a tree creator; `.changeset/` still degrades to `skipped:`, because a missing changeset is not a state any checker rejects and refusing on it would be tightening for its own sake; and the refusal fires in dry-run too, matching the Skills-table refusal that already threw before the write branch. The other discovery was that skillify's README had been *ahead* of its code: it already claimed "no README … is a pre-flight refusal", which was simply untrue. The fix made the documentation honest rather than the other way round.
- **Changed:** two pre-flight refusals in `scaffold-skill.mjs` · the stale comment that described the old contract as deliberate · four new tests (README-absent, packaging-absent, dry-run, and the `.changeset/` case that must keep working) · the existing bare-repo test split so its `wireSkill` half survives intact · the README sentence, now true in both halves · a refreshed sha256 in the skill-scan baseline, because the edit expired the file's coverage acceptance exactly as designed.
- **Decisions:** none — a bug fix against an existing rule.

— approved by (kmanojkumar) · built by claude · branch fix/59-scaffold-refuse

## 01-09-2026 — The word "operator" left the artifacts that name one ([#55](https://github.com/vegastack/vegastack-skills/issues/55))

- **What:** every workflow artifact that names a human now writes `(<github-username>)` on its own. Approval markers read `Approved by (kmanojkumar) on DD-MM-YYYY: "…"`, register lines `- DD-MM-YYYY (kmanojkumar) — …`, revision lines `per (kmanojkumar) correction`, and a chronicle footer `— approved by (kmanojkumar) · …`. The rule is stated once, in `conventions.md`, which all ten dev-family skills ship.
- **Why:** the spec and the register had drifted apart and nobody noticed for four days. `conventions.md` and `dev.md` both prescribed the long form while every line written into `.vegastack/decisions.md` used the short one — including entries dated after the register's own header claimed the format had changed. A spec its own reference implementation ignores is not a spec.
- **How it went:** quietly, once a scope question was answered. The investigation was the useful part: the register turned out to be the *only* artifact that deviated — 22 chronicle entries and every approval marker posted on an issue already used the long form correctly and consistently. The recommendation put to the operator was therefore register-only, three files. The operator chose the broader scope, five files, with that evidence and an exact-format preview in front of them; the two forms are now one at the cost of `Approved by (kmanojkumar)` reading a little bare. The other finding that made this safe: no script anywhere parses the identity string. `preflight.mjs` and `ship-gate.mjs` locate approvals strictly by the `vsk:v1` marker and `status.mjs` matches register lines on the decision text, so a format the whole family writes turned out to have no deterministic branch behind it at all. The self-review then caught the miss that mattered: the first sweep used `--include="*.md"` and so skipped `dev-profile.md.template`, the file `dev-setup` writes into every new project's `dev.md` — which would have seeded this exact mismatch into every project bootstrapped after the fix that was supposed to end it.
- **Changed:** `conventions.md`'s `## Operator identity` and `## Revision markers` · the `## Decisions` format line in `dev.md` · the register header, whose parenthetical about "the older `(github-username)` form" became self-contradicting once the short form *was* the prescribed one · `dev-chronicle`'s attribution line · `dev-intake`'s prose reference · `dev-setup`'s profile template and `dev-review`'s known-patterns template · two test fixtures that modelled the retired format. Existing markers, entries and register lines keep the form they were written in — append-only stands, and the prose simply no longer describes them.
- **Decisions:** none — this reconciles an existing rule with practice rather than steering anything new.

— approved by (kmanojkumar) · built by claude · branch docs/55-operator-identity

## 31-08-2026 — Every finding the scanner had on us, answered one at a time ([#62](https://github.com/vegastack/vegastack-skills/issues/62))

- **What:** the 31 things blocking the skill-scan guard were adjudicated individually and the guard now passes. Seven literal rules cover the HTML-comment markers this repo uses as machine-readable metadata; one fingerprint accepts skillify's refresh contract, which really does instruct an agent to rewrite its own files; and a new `coverage` section accepts seven files the scanner could not finish reading. Every entry carries a written reason and a "Still flag if:" clause the guard enforces.
- **Why:** the release was held at the pre-publish guard. Shipping over a red security gate would have made the gate decorative on the day it was introduced.
- **How it went:** the useful discovery was that the 31 blocks were not 31 problems. Twelve of them had one root cause, isolated by experiment rather than argument: a JavaScript template literal in assignment position — ``const at = `${a.file}:${a.line}`;`` — reads to SkillSpector's bounded shell parser as backtick command substitution and degrades every static analyzer for that skill. String concatenation scans clean; forty template literals inside function calls do not degrade at all. It is the shape, not the volume, and it meant any skill shipping ordinary JavaScript would block forever. That needed a mechanism the scanner does not have: its baseline suppresses findings, and cannot express "I could not finish reading this file". Hence `coverage`, scoped to skill + file, which still blocks if a second unread file is unaccounted for. `AE1` turned out to belong in the same category despite arriving as a HIGH finding — the scanner's own words for it are "Referenced artifact was not completely inspected". Two attempts at narrower instruments were tried and abandoned on evidence: a rule keyed on `SKILL.md` silences every skill's entry point, and the scanner's own baseline generator deduplicates eight occurrences into two hashes that then suppress two. One weakness surfaced while writing the evidence: each coverage block ended in a `continue`, so a degraded skill had its real findings hidden — the honest count was 25 findings, not the 15 being reported.
- **Changed:** a `coverage` section in the baseline format with its own validation and six tests · `AE1` accepted through it · coverage blocks no longer suppressing the findings a scan did produce · seven adjudicated rules, one fingerprint, seven coverage entries, each with its reasoning written down · the triage decision order and the SkillSpector behaviours already traced on this repo recorded in `skill-maintainer`, so the next finding is adjudicated rather than re-derived.
- **Decisions:** none — the suppression discipline recorded on 31-08-2026 governed this, and `coverage` was built to satisfy it rather than to work around it.

— approved by operator (kmanojkumar) · built by claude · branch chore/skillspector-triage

## 31-08-2026 — The skills repo pointed a scanner at itself ([#61](https://github.com/vegastack/vegastack-skills/issues/61))

- **What:** A `skill-scan:` knob in `.vegastack/dev.md` makes NVIDIA SkillSpector a normal stage of the workflow. `dev-review` ships the guard; `dev-implement` runs it at the Verify gate before anything is pushed; a blocking guard re-runs it before publish, because the bundle is what the world installs. It blocks on unsuppressed HIGH/CRITICAL findings, and suppressions live in a JSON baseline whose every rule must say what would make the pattern a real finding again. Downstream projects that author their own skills get all of it from the knob.
- **Why:** the operator asked for skill scanning at ship time. Ship in this workflow means *after merge*, and the useful moment is before the push — so it landed in two places for two different reasons: a deterministic guard at Verify, and triage in the Security axis that already owns findings, severities, and the fix loop.
- **How it went:** badly, in the most useful way. Measuring first killed three tempting designs: the aggregate risk score is unusable as a gate here (`skill-maintainer` scores 80 HIGH purely because its SKILL.md cites repo-root paths that cannot resolve inside a skill directory, so a score gate would block every push forever on a non-finding); the built bundle must be scanned rather than the authored tree, whose unpackaged `tests/` fixtures are deliberately adversarial; and the LLM pass must stay out of the gate, because a degraded semantic run reports a *higher* score than a clean one. Then review found **eleven** defects, all one shape — something reporting success while leaving state its own checker would reject — and three of the CRITICALs were introduced by the fix for the previous one. A wildcard baseline rule silenced all 39 findings at exit 1; the fix rejected `*`, and `?*` bypassed it on the first attempt; grouped layouts scanned as zero skills, and that fix created duplicate-basename report collisions; the symlink fix then capped the coverage walk at depth 4, so a malicious skill at depth 5 was scanned by nobody and flagged by nobody. Two rules came out of it worth keeping: matchers must be **literal**, because rejecting wildcard spellings one at a time is an arms race you lose; and **a cap is a cliff** — a bound that stops quietly is the same bug as no bound at all. The guard also caught a defect in its own author's diff mid-build, which is the most persuasive evidence it works.
- **Changed:** a new `skills/dev-skills/dev-review/scripts/skill-scan.mjs` with pure, unit-driven baseline parsing, two-level skill discovery, an unbounded coverage walk, and verdict functions, plus a fake-scanner fixture and 73 tests · the `skill-scan:` knob in the profile template and dev-setup's detection · the Verify-gate bullet in `dev-implement` · a "Scanner evidence" method in the Security axis and its dispatch brief · the suppression discipline in `skill-maintainer` · this repo's knob, seed baseline, Verify and Ship lines, and contributor install instructions.
- **Decisions:** one proposed, recorded in the register at merge on the operator's word — skill scanning is a first-class workflow stage: a deterministic guard at Verify blocking on unsuppressed HIGH/CRITICAL findings (never on the aggregate score), triaged by dev-review's Security axis, with suppressions as a justified, reviewed, literal-matcher baseline.

— approved by operator (kmanojkumar) · built by claude · branch feat/skill-scan

## 31-08-2026 — Installing a family stopped being a for-loop ([#58](https://github.com/vegastack/vegastack-skills/issues/58))

- **What:** `add`, `verify`, and `remove` each take one selector — a skill name, `--group <name>`, or `--all` — so the ten dev-workflow skills install with `npx @vegastack/skills add --group dev-skills` instead of ten invocations. A group or `--all` install is one transaction: everything is staged before anything is committed, so a single failure leaves the destination untouched. `--all` skips the two repo-only skills, which moved into a `repo-tooling` group and are marked in an explicit data file the build validates. `list` groups its output and says which skills `--all` will not give you. The root README was rewritten around getting started, for a person arriving cold and for an agent reading the repo.
- **Why:** the operator asked how to install all the dev skills the day after groups shipped, and the honest answer was a shell loop. Groups had been made a first-class authoring concept without the companion anyone would reach for first.
- **How it went:** the transaction was the part that could have been hard and wasn't — the install journal already carried a per-operation `skill` field and already rejected duplicate agent/skill pairs, so multi-skill installs used machinery that existed rather than new machinery. The design question that mattered was smaller and easy to get wrong: whether "which family is this in" and "should you install this" are the same axis. They are not, so a group says where a skill is authored and a separate `repoOnly` marker says who should install it, and neither is inferred from prose. Two mistakes were caught mid-build and are worth remembering: a blanket `sed` fixing import depth in the moved skills also rewrote two assertions about generated output, including the ungrouped case that must stay at three levels — it would have made a test assert the opposite of its own name; and two `../../` links in the moved READMEs broke, which the skill validator caught unprompted.
- **Changed:** `group` and `repoOnly` in the integrity manifest, sourced from a validated `repo-only.json` · a pure `src/selection.ts` resolver, unit-tested with no filesystem · `--group`/`--all` on three commands with all-or-nothing semantics · grouped `list` output · the meta skills moved to `repo-tooling` · the installer reference, twelve skill walkthroughs, the scaffolder template every future skill inherits, and a README rewritten to lead with first use.
- **Decisions:** none — the flat-install invariant recorded on 30-08-2026 governed this, and holding to it is why an install path still never carries a group.

— approved by operator (kmanojkumar) · built by claude · branch feat/group-install

## 30-08-2026 — Skills got families, and the install command never noticed ([#54](https://github.com/vegastack/vegastack-skills/issues/54))

- **What:** Authored skills may now live one level deep inside a named group, and the ten dev-workflow skills moved into `skills/dev-skills/`. Nothing a user types changed: the packaged bundle is still flat and still keyed by bare skill name, so `npx @vegastack/skills add dev-plan` is byte-for-byte the command it was and every existing installation is untouched. A group is a directory plus a `GROUP.md` — a display title and one blurb line — which the root README's per-group section mirrors. `skill-maintainer` owns the rules and the create-a-group workflow; `skillify`'s scaffolder gained `--group` and refuses to invent a group it doesn't find.
- **Why:** This is an org-level skills repo, and twelve peers in one flat directory had stopped saying which ones belong together.
- **How it went:** The shape of the fix was settled before any code, by moving the whole repo in a throwaway copy and rebuilding: the bundle came out byte-identical, which proved the authored layout and the shipped layout were already decoupled and that only three one-level directory scans stood in the way. That turned a scary-looking migration into a small one. The build, the validator, and the new structure checker were then pointed at a single discovery module, so the layout rule has one home instead of three. The genuinely dangerous surface was CI: the weekly refresh globbed `skills/*/refresh/sources.json`, which after the move would have covered two skills instead of twelve and reported nothing wrong — a failure with no error message. Its acceptance is a count, not an edit. The operator's standing instruction shaped the tests as much as the code: ungrouped skills are a first-class case, not a fallback, so every grouped rule has a named ungrouped counterpart, `skill-maintainer` and `skillify` deliberately stayed at the top level, and the structure checker was run green against the still-flat repo before a single directory moved.
- **Changed:** Shared depth-capped discovery in `packages/cli/scripts/lib/` · group-aware packaging sync and skill validator · a new `structure.mjs` with `check` and `create-group`, wired into `bun run check` · `--group` on the scaffolder with a depth-correct test-import template · the dev family moved · depth-agnostic refresh discovery in both workflows · group rules in `skill-maintainer`, paths throughout the repo docs.
- **Decisions:** Authored skills may be grouped one level deep; packaging keys and the published bundle stay flat, so install commands never carry a group.

— approved by operator (kmanojkumar) · built by claude · branch feat/skill-groups

## 29-08-2026 — A release step stopped promising something it never did ([#48](https://github.com/vegastack/vegastack-skills/issues/48))

- **What:** The release runbook said the `bun install` after a version bump keeps the lockfile fresh. It doesn't: with bun, the version recorded for the workspace inside the lockfile simply does not follow a version bump — ours sat ten releases behind — and the installs this release flow runs, the strict CI one included, pass anyway because nothing reads it. The runbook now says what the step is actually for (carrying dependency changes through), says the older recorded version is not a defect and must never be hand-edited, and — because the shipped playbook writes this line into every project the setup skill bootstraps — says it in a way that is true for other package managers too, since npm behaves the opposite way.
- **Why:** The pre-ship adversarial review of [#46](https://github.com/vegastack/vegastack-skills/issues/46) tested the claim instead of believing it, and found it false. A runbook that promises something untrue teaches the next reader to "fix" a healthy lockfile by hand — which the project rules forbid.
- **How it went:** The first four probes were not enough, and the adversarial review said so: they established *that* the recorded version lags but not *why*, and the explanation written from them — "bun rewrites the lockfile only when the dependency graph changes" — turned out to be false. Widening a dependency range so that nothing at all resolved differently still refreshed it. So the prose stopped explaining a mechanism and started reporting what is actually observable. The same pass caught the bigger mistake: bun's behavior had been stated as a general fact in the package-manager-agnostic playbook, where npm does the opposite — the exact error this issue exists to correct, one paragraph over.
- **Changed:** Corrected release step in dev-setup's npm playbook · a package-manager-neutral version-identity note · the observed bun behavior recorded in release ops, which is where the expanded release detail lives · this repo's own version-identity rule extended to cover it, with the Ship step left as a plain step.
- **Decisions:** none.

— approved by operator (kmanojkumar) · built by claude · branch docs/48-lockfile-claim

## 29-08-2026 — The cosmetic sweep's leftovers got fixed at their format homes ([#46](https://github.com/vegastack/vegastack-skills/issues/46))

- **What:** The rendering annoyances from the sweep are gone, and one real bug came out with them. A project's review known-patterns file now shows one line per field instead of a merged paragraph (the same bug [#44](https://github.com/vegastack/vegastack-skills/issues/44) fixed for the chronicle, in the template consuming repos inherit); changesets now have a stated shape, so future changelog entries and the release notes that lead with them stop being 1,200-character walls; the terminal status board no longer prints raw link markup, and — the bug — a decision already written into the register no longer sits on the board as "pending" forever just because its wording carried a link; both README skills tables read as one line per skill; and two archived plan documents lost their merged headers.
- **Why:** The 29-08 renderer sweep put every artifact class through GitHub's own markdown API and these were what it still found — renderer-confirmed, not eyeballed.
- **How it went:** The edits were straightforward; review was where the value was. The first pass caught the build's own bookkeeping — no task checkpoints in the ledger and every plan checkbox unticked, which would have made a resumed session redo finished work — plus a rule about scannable changelogs delivered in the least scannable sentence in the skill, and three copies of that rule where one home was the point. Then an adversarial pass before shipping killed one of the six fixes outright: linking the evidence comment's sha to its commit was built on a false premise. GitHub auto-links a bare sha perfectly well once the commit is pushed, and the explicit link, written before the branch ever leaves the machine, points at nothing. Reverted, with the reason recorded so nobody fixes it again. That same pass found the pending-decision bug and a fourth copy of the changeset rule that contradicted the other three.
- **Changed:** Known-patterns template bulleted · changeset shape convention (dev-implement's rule, cited by CONTRIBUTING, skillify, release-ops, and the setup playbook) · `titlePlain`/`gistPlain` from status.mjs and a register comparison that ignores link markup · one-line rows in both README tables · legacy plan headers · evidence-tail linking investigated and rejected.
- **Decisions:** none.

— approved by operator (kmanojkumar) · built by claude · branch chore/46-rendering-fixes

## 29-08-2026 — The chronicle became readable where it's actually read ([#44](https://github.com/vegastack/vegastack-skills/issues/44))

- **What:** Entries in this file now render properly on GitHub: each field on its own line instead of one merged paragraph, and every issue number a real link (bare #N only auto-links in issues and comments, never in file views — so the format now spells the links out). All sixteen existing chapters were migrated, wording untouched.
- **Why:** The operator opened the chronicle on github.com and got a wall of text with dead references — the one place this file is meant to be read.
- **How it went:** Smooth; the fix went into the format's home (the dev-chronicle skill) first, then a mechanical migration — and this very entry is written in the new shape.
- **Changed:** Bulleted fields + linked issue refs in the binding template · live file migrated · a never-bare-#N rule.
- **Decisions:** none.

— approved by operator (kmanojkumar) · built by claude · branch fix/44-chronicle-rendering

## 29-08-2026 — The advisor's facts caught up with the world ([#42](https://github.com/vegastack/vegastack-skills/issues/42))

- **What:** The architecture advisor's pinned facts now reflect this week's vendor reality, each re-verified against live docs: Better Auth 1.7 is stable (the old "hold at 1.6.x" guidance retired, the MCP-plugin move and SAML default-off recorded as landed, plus a real catch — the apiKey plugin now lives in its own package, so the old import advice was wrong), and EVE sits at 0.47.3, still beta and shipping several times a day.
- **Why:** The weekly refresh PR adopted new baselines; version numbers alone never change advice — the facts behind them had to be re-checked.
- **How it went:** Review demanded the full verification record live on disk, not just a summary — fair, and now it does.
- **Changed:** Better Auth section rewritten at 1.7.2 with five verified bullets · EVE bullet at 0.47.3 with a pin-behavior-not-versions note.
- **Decisions:** none.

— approved by operator (kmanojkumar) · built by claude · branch chore/42-adopt-baselines

## 29-08-2026 — The freshness checker stopped believing its own cache ([#40](https://github.com/vegastack/vegastack-skills/issues/40))

- **What:** In pure verification runs, drift is now always judged against the reviewed registry baseline. Before, the first run to spot a changed page would also memorize the changed page in its local cache — and the second run, comparing against that cache, would declare everything fine while the reviewed baseline still disagreed. A critical drifted source could vanish from the radar on any machine with a persistent cache.
- **Why:** Pre-existing hole spotted by [#37](https://github.com/vegastack/vegastack-skills/issues/37)'s reviewer and spun off as its own task; CI was safe (scratch caches) but local runs were not.
- **How it went:** Clean — one comparison expression, one no-etag test-server arm, exactly one red before green.
- **Changed:** verify-mode drift registry-anchored with a cache-disagreement annotation · two regression tests (warm-cache masking pinned; unchanged-source control).
- **Decisions:** none.

— approved by operator (kmanojkumar) · built by claude · branch fix/40-verify-cache-masking

## 29-08-2026 — The weekly refresh can no longer paint itself into a corner ([#37](https://github.com/vegastack/vegastack-skills/issues/37))

- **What:** The automated freshness checker used to lock up permanently if a "human must re-review this page" source went past its review window while the page itself never changed — and the only escape was a hand-edit the rules forbid. Now, when the checker cryptographically proves the page is byte-for-byte what a human last reviewed, the review clock refreshes itself; anything that actually changed still stops the line for human eyes.
- **Why:** Found live: the first post-release refresh run failed three-of-three attempts on a Cloudflare docs source that was 16 days "overdue" despite being provably unchanged.
- **How it went:** Textbook dev-debug — red command reproduced locally in one try; the harness fought back twice (macOS /var symlink guard, a required registry option). Review caught two real problems: the first repro run had quietly accepted six unreviewed baselines into the working tree (reverted — the weekly PR is where adoptions get human eyes), and the fix was widened to all sources when only manual-review ones need it (narrowed).
- **Changed:** verified-unchanged sources refresh their review clock under accepting runs · four regression tests incl. the read-only-mutates-nothing guarantee.
- **Decisions:** none.

— approved by operator (kmanojkumar) · built by claude · branch fix/37-refresh-deadlock

## 29-08-2026 — The system survived its own audit and got harder ([#35](https://github.com/vegastack/vegastack-skills/issues/35))

- **What:** The epic's closing sweep put four fresh adversarial reviewers over everything built this week — and their ~20 findings are now fixed: the ship gate can no longer be talked past by routine rulings, plans can't hide unfenced test steps or checkbox-less tasks, every standalone install carries the shared rulebook, bug issues actually route to the debugger, and the one rationalization a pressure test ever caught ("a PR is just preparation") is now a named excuse with its answer printed in the shipping skill.
- **Why:** The operator's bar: pressure-test and adversarially review every change before releasing. The sweep found real holes; shipping them would have been the old prose-only workflow all over again.
- **How it went:** The audit caught its own builders repeatedly (unticked checkboxes on eleven issues, a stale changeset sentence headed for the public changelog) — every catch fixed on the record.
- **Changed:** ship-gate/plan-lint/preflight/brief-lint spec conformance + fail-closed tests · @source shared packaging (conventions.md everywhere) · fix:-to-dev-debug routing · cross-agent handoff literals · resume-protocol exclusions · plan-template Revisions slot · truthful release notes.
- **Decisions:** none new.

— approved by operator (kmanojkumar) · built by claude · branch fix/35-v3-hardening

## 29-08-2026 — The skills stopped spoiling their own plots ([#21](https://github.com/vegastack/vegastack-skills/issues/21))

- **What:** Every skill's one-line description now says only when to use it and what it's not for — the step-by-step summaries are gone. That matters because agents sometimes follow the summary instead of opening the skill, skipping steps the summary didn't mention. The repo docs now also name all ten workflow skills in one place.
- **Why:** An empirically observed failure mode from the external research: a description that narrates process becomes a shortcut past the process.
- **How it went:** Three descriptions still carried summaries (setup, ship, architect). The family-wide trigger check (149 queries) caught one real contradiction — status and chronicle both claiming "what happened while I was away" as a must-win — resolved in chronicle's favor; and stripping setup's summary had silently removed its trigger nouns, restored as proper Use-when phrases.
- **Changed:** dev-setup, dev-ship, and dev-architect descriptions rewritten · one family order across CONTRIBUTING, the AGENTS.md template, and the README rows.
- **Decisions:** none new.

— approved by operator (kmanojkumar) · built by claude · branch chore/21-descriptions

## 29-08-2026 — Small honesty fixes in the advisor and the factory ([#20](https://github.com/vegastack/vegastack-skills/issues/20))

- **What:** Architecture guidance marked "(inferred)" can now actually graduate: confirming one proposes a dated register line and removes the tag — before, nothing ever flipped inferred to ratified. And the skill factory's testing playbook now says out loud what this epic learned by doing: trigger checks must re-run across the whole family when it changes, and workflow skills get their real proof from a sandbox drill, not single prompts.
- **Why:** Both were quiet drift risks found in the v3 assessment.
- **How it went:** Four surgical edits; nothing fought back.
- **Changed:** dev-architect ratification rule + count-free red-lines heading · skillify family-level trigger rule + workflow-skill eval note.
- **Decisions:** none new.

— approved by operator (kmanojkumar) · built by claude · branch feat/20-refinements

## 29-08-2026 — Bugs must be caught red-handed before they're "fixed" ([#19](https://github.com/vegastack/vegastack-skills/issues/19))

- **What:** Bug work now has a hard order: first build one command that provably fails because of the reported symptom — no theorizing allowed before it exists — then shrink it, list ranked suspects with testable predictions, probe one variable at a time with tagged logging, and write the failing regression test before the fix. If no command can be built, the agent asks for artifacts instead of guessing; if no honest seam exists for the test, that gap is recorded instead of papered over.
- **Why:** "Fixed" something that was never the cause is the most expensive kind of done.
- **How it went:** Smooth; the ship-gate tag check and intake's Reproduction requirement were already waiting for this skill to plug into.
- **Changed:** dev-debug skill (installable) · eight-rung loop ladder reference.
- **Decisions:** none new.

— approved by operator (kmanojkumar) · built by claude · branch feat/19-dev-debug

## 29-08-2026 — The operator got a front desk ([#18](https://github.com/vegastack/vegastack-skills/issues/18))

- **What:** Asking "status" or "what needs me" now produces the board: your queue first (things awaiting your word, oldest first), then what's waiting on plans, ready for agents, in flight with live task counts, gone quiet, and any decisions awaiting their merge — each line a named link, ending with the single most valuable thing to do next.
- **Why:** The operator's view was raw label-digging across issues; the workflow's whole state should be one ask away.
- **How it went:** Smooth; the marker conventions made every signal (ledger age, checkbox progress, pending decisions) mechanically readable.
- **Changed:** dev-status skill (installable) · status.mjs gatherer with unit tests.
- **Decisions:** none new.

— approved by operator (kmanojkumar) · built by claude · branch feat/18-dev-status

## 29-08-2026 — The project can now tell its own story ([#17](https://github.com/vegastack/vegastack-skills/issues/17))

- **What:** "Catch me up on this project" works: the chronicle you are reading has an owner skill that defines the entry format and renders the digest — the story so far, the recent chapters, the open threads — without digging through git. Every build already writes its chapter; now the reading side exists too.
- **Why:** The operator kept forgetting what a project contained and what had happened in it; changelogs answer what changed for consumers, not what happened for the builder.
- **How it went:** Smooth — the file and knob had been dogfooded since [#10](https://github.com/vegastack/vegastack-skills/issues/10), so the skill mostly wrote down rules already being lived.
- **Changed:** dev-chronicle skill (installable) · this file's header now points at it.
- **Decisions:** none new.

— approved by operator (kmanojkumar) · built by claude · branch feat/17-dev-chronicle

## 29-08-2026 — Shipping stopped taking anyone's word for it ([#16](https://github.com/vegastack/vegastack-skills/issues/16))

- **What:** Before any PR, the ship gate now re-runs the project's checks itself, verifies the docs still describe the code, requires the changelog AND the story entry, and refuses review verdicts that weren't clean or openly ruled on. A merge instruction older than a week (or following a behavior-touching rebase) gets one polite re-confirm instead of blind obedience, and every ship ends by asking "what one line would have prevented this issue's friction?"
- **Why:** Self-reported evidence was the last trust gap — claims are now re-proven at the moment they matter.
- **How it went:** Small, surgical; the preflight guard also caught the coordinator claiming an issue before running preflight — order corrected, lesson recorded.
- **Changed:** dev-ship v3 (ship-gate wiring, staleness bound, retro close, operator register format) · ship-gate gains the chronicle presence check.
- **Decisions:** none new.

— approved by operator (kmanojkumar) · built by claude · branch feat/16-dev-ship-v3

## 29-08-2026 — Dark builds got a black box recorder ([#15](https://github.com/vegastack/vegastack-skills/issues/15))

- **What:** While an agent builds unattended, it now keeps a live ledger on the issue — each finished task, each judgment call with its reasoning and what it costs if wrong, each review round. If the session dies or forgets (context limits), a fresh one reads brief → plan → ledger → git history — nothing else — and resumes at the exact right spot instead of redoing finished work. Tests are written before code at the boundaries the brief fixed, no status is ever claimed without a fresh command proving it, and when you correct something, the docs get corrected in the same breath as the code.
- **Why:** Session death used to mean starting over blind, and "tests pass" was sometimes a memory, not a fact.
- **How it went:** Clean rewrite on top of the merged guards and review system; the SKILL stayed within budget by moving ledger mechanics to a reference.
- **Changed:** dev-implement v3 (ledger + resume, TDD rules, verification gate, ratchet stop, doc-sync corrections, bounded direct path) · chronicle entries now written by the build itself.
- **Decisions:** none new.

— approved by operator (kmanojkumar) · built by claude · branch feat/15-dev-implement-v3

## 29-08-2026 — Review became the strongest link ([#14](https://github.com/vegastack/vegastack-skills/issues/14))

- **What:** Reviewing finished work is now its own skill with real machinery: three separate fresh-eyed reviewers (does it match the brief · does it follow the rules · is it secure, when it matters), findings with severities that either block or don't, one tidy review comment per cycle, a fix loop that can't spin forever (three rounds, then every leftover gets an open ruling), and the option to have the *other* AI (Codex) do the review on risky work — announced to you before and after, never silently.
- **Why:** The reviewer was the least-specified actor guarding dark-mode work — a two-line prompt deciding whether unattended code ships. Now it's the most-specified.
- **How it went:** Built on the merged conventions and guards; the preflight guard blocked this very issue's start over an unresolved assumption, which got resolved with evidence instead of a guess — the system policing its own construction.
- **Changed:** dev-review skill (installable) · dev-implement's review step now invokes it · per-project never-flag file with mandatory "Still flag if:" clauses.
- **Decisions:** none new.

— approved by operator (kmanojkumar) · built by claude · branch feat/14-dev-review-skill

## 29-08-2026 — Intake learned to size the work ([#13](https://github.com/vegastack/vegastack-skills/issues/13))

- **What:** When you bring an idea now, intake says out loud how heavy it is — research (a question), quick-build (small, plan drafted in the same sitting, one approval), or full-plan (a real planning stage before code) — and the label routes everything after. Bugs must arrive with reproduction steps or they become research first. Big features become a parent map with sub-issues instead of one monster.
- **Why:** Underestimation was invisible: everything looked the same at intake, then blew up mid-build. Now the size call is explicit, overridable, and mechanically routed.
- **How it went:** Clean rewrite; the brief template gained the marker, the bug section, and the seams rule so test placement is settled while questions are still allowed.
- **Changed:** dev-intake v3 (scope calls, epic maps, one-approval quick-builds, bug variant, marker approvals) · brief template v3.
- **Decisions:** none new.

— approved by operator (kmanojkumar) · built by claude · branch feat/13-dev-intake-v3

## 29-08-2026 — The rules grew teeth ([#11](https://github.com/vegastack/vegastack-skills/issues/11))

- **What:** Five small guard programs now enforce what used to be prose promises: an agent can't claim an issue without recorded approval, can't post a malformed brief/plan/evidence comment, and can't ship a branch whose tests weren't just re-run fresh — or whose docs fell behind the code. Machine-checkable facts hard-stop the agent; fuzzy signals (like "skipping tests for now" appearing in a report) only warn.
- **Why:** The v3 assessment's biggest finding: the workflow preached "every rule that can be a check becomes a guard" while enforcing almost everything with prose. Prose bends under pressure; exit codes don't.
- **How it went:** Two regex bugs caught by the unit tests before review ever saw them; the preflight guard passed its first live run against a real issue on the first try.
- **Changed:** preflight + evidence-check (dev-implement) · brief-lint (dev-intake) · plan-lint (dev-plan, home of the banned-placeholder list) · ship-gate (dev-ship) · 44 unit tests · all shipped to installs.
- **Decisions:** none new.

— approved by operator (kmanojkumar) · built by claude · branch feat/11-guard-scripts

## 29-08-2026 — Plans became a real stage, not a hope ([#12](https://github.com/vegastack/vegastack-skills/issues/12))

- **What:** There is now a dev-plan skill: big issues get a written, operator-approved plan before any code — exact files, what each task consumes and produces, the failing test written before the implementation, and a banned list for hand-wavy phrases like "handle edge cases". Small issues get the same plan shape inline at intake, so one approval still covers them.
- **Why:** Short vague plans were where agents drifted: surface-level work, missed steps, invented scope. The plan format makes the gaps visible before they cost a build.
- **How it went:** Smooth build; review caught the ratchet rule living in two files and some dead cross-skill links — both fixed. The behavioral eval showed the format clearly beats an unguided plan (the unguided one had no progress checkboxes, no interface contracts, and "write tests" without tests).
- **Changed:** New dev-plan skill (installable) · scope-ratchet rules single-homed in it · README tables list it in workflow order.
- **Decisions:** none new.

— approved by operator (kmanojkumar) · built by claude · branch feat/12-dev-plan-skill

## 28-08-2026 — The workflow got a shared rulebook ([#10](https://github.com/vegastack/vegastack-skills/issues/10))

- **What:** Every dev skill now reads one conventions file instead of each half-stating the rules. Issue comments carry hidden machine-readable markers, every artifact names the operator the same way, edited documents show visible version numbers, and issues carry scope labels (research / quick-build / full-plan) that say how heavy the process is at a glance.
- **Why:** The v3 overhaul needs every skill and script to agree on formats — one home per rule, so nothing drifts.
- **How it went:** Smooth; the one judgment call was switching this repo's release knob to on-request so the epic ships as a single version.
- **Changed:** New conventions reference in dev-setup · five new labels wired into templates and this repo · register format now names the operator · chronicle file started (this entry).
- **Decisions:** none new (executes the recorded v3 plan).

— approved by operator (kmanojkumar) · built by claude · branch feat/10-workflow-conventions
