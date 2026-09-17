# Tri-harness skill standards

The complete standards reference for skills in this repository, covering the two target harnesses — Claude Code and Codex — and the agentskills.io open standard they converge on. Verified 2026-08-08.

Volatile vendor facts here carry their checked date; the `skills-refresh` skill re-checks them against the official docs.

## agentskills.io open standard

Source: https://agentskills.io/specification. Reference validator: `skills-ref validate` from github.com/agentskills/agentskills. <!-- source: AGENTSKILLS-SPEC -->

- Directory layout: `skill-name/SKILL.md` required; optional `scripts/`, `references/`, `assets/`. <!-- source: AGENTSKILLS-SPEC -->
- Frontmatter — the spec defines exactly six fields: <!-- source: AGENTSKILLS-SPEC -->
  - `name` (required): 1–64 chars, `[a-z0-9-]` only, no leading/trailing hyphen, no consecutive hyphens, must match the parent directory name. <!-- source: AGENTSKILLS-SPEC -->
  - `description` (required): 1–1024 chars, what + when, keyword-rich. <!-- source: AGENTSKILLS-SPEC -->
  - `license` (optional): short string or bundled-file reference. <!-- source: AGENTSKILLS-SPEC -->
  - `compatibility` (optional): 1–500 chars, environment requirements only. <!-- source: AGENTSKILLS-SPEC -->
  - `metadata` (optional): string→string map. <!-- source: AGENTSKILLS-SPEC -->
  - `allowed-tools` (optional): space-separated string; experimental, support varies across harnesses. <!-- source: AGENTSKILLS-SPEC -->
- Progressive disclosure: metadata costs ~100 tokens at startup; SKILL.md body should stay under 5,000 tokens (under 500 lines); bundled resources load on demand; relative file references one level deep. <!-- source: AGENTSKILLS-SPEC -->
- The spec's own version identifier: **UNVERIFIED** — do not cite a spec version number.

## Claude Code

Source: https://code.claude.com/docs/en/skills. <!-- source: CLAUDE-CODE-SKILLS -->

- Discovery: project `.claude/skills/<name>/SKILL.md`, loaded from the start directory and every parent up to the repo root; personal `~/.claude/skills/`; enterprise via managed settings; nested `<subdir>/.claude/skills/` lazy-loaded; plugin `<plugin>/skills/`. Precedence: enterprise > personal > project. Symlinks are followed; skill changes are detected live mid-session. <!-- source: CLAUDE-CODE-SKILLS -->
- Frontmatter: all fields optional in Claude Code itself (directory name is the command name; description recommended). It accepts an extended set beyond the spec six — `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context` (fork), `agent`, `background`, `hooks`, `paths`, `shell`, plus `license`/`compatibility`/`metadata` (accepted but not acted on). <!-- source: CLAUDE-CODE-SKILLS -->
- **Packaging trap:** claude.ai uploads, the Skills API, and `package_skill.py` hard-error on any key outside the spec six (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`) — a skill that works in Claude Code can still be unpackageable. <!-- source: CLAUDE-CODE-SKILLS -->
- Context budgets: each skill's `description` (+`when_to_use`) is always in context, truncated at 1,536 chars combined per skill; the body loads on invocation and persists — the first 5,000 tokens are re-attached after compaction, within a 25,000-token budget shared across skills. <!-- source: CLAUDE-CODE-SKILLS -->
- Invocation: implicit matching on description, or direct `/skill-name`. `allowed-tools` is a per-turn permission pre-grant only, not a sandbox. <!-- source: CLAUDE-CODE-SKILLS -->
- Claude-only body features — **never use in this repo's skills** (broken or dead weight elsewhere): <!-- source: CLAUDE-CODE-SKILLS -->
  - `` !`cmd` `` dynamic command-output injection
  - the `ARGUMENTS`, `0` and `name` argument placeholders, each written after a dollar sign
  - the `CLAUDE_SKILL_DIR` and `CLAUDE_PROJECT_DIR` environment paths in their dollar-brace form
- 2026 changes: commands and skills merged; `context: fork` subagents; skill-level hooks; `paths` glob gating; `skillOverrides`; skills-dir plugins; bundled skills. <!-- source: CLAUDE-CODE-SKILLS -->

## Codex (OpenAI)

Source: https://developers.openai.com/codex/skills (canonical content at learn.chatgpt.com/docs/build-skills.md). <!-- source: CODEX-SKILLS -->

- Discovery order: `<cwd>/.agents/skills` → parent directories' `.agents/skills` within a git repo → `<repo root>/.agents/skills` → `~/.agents/skills` → `/etc/codex/skills` → bundled. Symlinks followed. <!-- source: CODEX-SKILLS -->
- Legacy `~/.codex/skills` discovery: **UNVERIFIED** — no longer documented; do not rely on it.
- Frontmatter: `name` + `description` required; same SKILL.md format as the spec. <!-- source: CODEX-SKILLS -->
- Unknown frontmatter keys: officially undocumented; community evidence says ignored — **UNVERIFIED** officially.
- Optional per-skill `agents/openai.yaml`: <!-- source: CODEX-SKILLS -->
  - `interface`: `display_name`, `short_description`, `icon_small`, `icon_large`, `brand_color`, `default_prompt`
  - `policy`: `allow_implicit_invocation: false` (default true)
  - `dependencies`: `tools: [{type: "mcp", value: "..."}]`
- Invocation: `$` mention, `/skills` list, implicit matching on description. The skill list is capped at 2% of the context window / 8,000 chars — descriptions are shortened first, so front-load trigger words. <!-- source: CODEX-SKILLS -->


## Install surfaces

| Harness | Project install | Global install | Notes |
|---|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` | parents scanned to repo root; nested dirs lazy-loaded <!-- source: CLAUDE-CODE-SKILLS --> |
| Codex | `.agents/skills/` | `~/.agents/skills/` | also `/etc/codex/skills` and bundled <!-- source: CODEX-SKILLS --> |


These paths are the harnesses' own discovery rules and are unaffected by how skills are selected. The installer's `--group` and `--all` flags choose *which* skills to act on; an installed skill is always `<surface>/<bare-name>/`, never `<surface>/<group>/<name>/`.

## Portability rules (this repo's policy)

One authored tree, three harnesses. Every skill in `skills/` follows all seven:

1. **Frontmatter:** only `name` + `description` (spec also allows `license`, `compatibility`, `metadata` — off by default here). Never depend on `allowed-tools`. No Claude-only keys: they break claude.ai packaging and are dead weight elsewhere.
2. **Name:** equals the directory name; grammar intersection across harnesses: starts with a lowercase letter, then `[a-z0-9-]`, no consecutive hyphens, no underscores, ≤ 64 chars.
3. **Description:** ≤ 1024 chars, trigger words front-loaded (Codex 2%/8,000-char list budget; Claude Code 1,536-char per-skill listing truncation).
4. **Body syntax:** no Claude-only tokens (list above); scripts referenced as plain relative paths runnable from the skill directory; relative links one level deep.
5. **Size:** SKILL.md under 500 lines / under 5k tokens; detail in `references/`, executables in `scripts/`, templates in `assets/`.
6. **Extra files:** `agents/openai.yaml` is safe to ship — Claude Code ignores unknown files.
7. **Per-harness metadata** that must survive claude.ai packaging goes under `metadata:` with namespaced keys.

Repo enforcement: `packages/cli/scripts/validate-skill.mjs` (run by `bun run check`) accepts exactly the spec six (`name`, `description`, `license`, `compatibility`, `allowed-tools`, `metadata`) and rejects everything else, enforces the full name grammar (lowercase-letter start, no consecutive hyphens, ≤64 chars, name equals the skill directory name), and rejects empty or over-length descriptions and angle brackets. Policy (rule 1) is stricter than the validator; the minimal two keys are the default.

## Skill scanning and the suppression baseline

Every skill this repo ships is scanned by [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) through the `skill-scan` skill's `scripts/skill-scan.mjs`, at the Verify gate before a push and again as a blocking `guard:` before publish. The guard blocks on any unsuppressed **HIGH or CRITICAL** finding and ignores the aggregate risk score: a skills repo documents the very mechanics the scanner matches on, so the score reflects our subject matter more than our risk.

Suppressions live in `.vegastack/skillspector-baseline.json` — a real SkillSpector baseline, passed with `--baseline`, so nothing here forks the scanner's own matching and upstream changes to it arrive for free. The rules this repo adds on top:

- **A suppression needs the operator's word.** It is a security decision on the record, the same as an operator dismissal appended to `.vegastack/review-known-patterns.md` — never a step taken to get a guard green.
- **Matchers must be LITERAL — the guard rejects `*`, `?`, `[` and `]` outright.** This is not a style preference: a rule of `{"id": "*"}` silenced all 39 findings while the guard reported "pass with warnings", and a first fix that rejected `*` and `**` was bypassed by `?*` on the next attempt. Matching wildcard *spellings* is an arms race; "name the thing" is the only mechanically checkable form of "scope a rule as narrowly as its cause". Two files means two rules, which reads better in a diff anyway. (Consequence worth knowing: a filename that literally contains `[` or `]` cannot be suppressed by a rule — the scanner would glob-interpret it too. Use a fingerprint.)
- **Scope a rule as narrowly as its cause.** `{"id": "P2"}` alone silences prompt injection across every skill forever; `{"id": "P2", "path": "references/conventions.md"}` silences one documented protocol in one file. A rule with no `path` needs a reason that explains why the whole repo is the cause.
- **`path` and `file` are the same matcher, `id` and `rule_id` likewise** — SkillSpector resolves `path = raw.get("path") or raw.get("file")`. Both spellings are accepted and both go through the literal check.
- **A baseline carrying `fingerprints:` must also set `scanner_version`** — the scanner refuses it otherwise, once per skill, and the guard catches that up front so one misconfiguration does not surface as a dozen unreadable-report failures.
- **Every `reason` carries a "Still flag if:" clause**, naming the condition that makes the pattern a real finding again. The guard blocks on a missing, empty, scanner-placeholder, or clause-less reason — this is enforced, not trusted.
- **`fingerprints:` are for one-off accepted findings only.** They are content-hashed, so any edit to the surrounding file re-triggers them — which is their re-trigger condition, and why they need a real reason but not the clause. A structural pattern suppressed by fingerprint will reappear at the worst possible moment; use a rule.
- **Never `--use-shipped-baseline`.** A baseline discovered inside a scanned skill was written by whoever wrote that skill.
- **The scan reads the built bundle** (`packages/cli/skill/`), not `skills/`: the authored tree carries unpackaged `tests/` fixtures that are deliberately adversarial and score higher than anything that ships. Build before scanning.
- **The semantic pass (`--llm`) is advisory and never a gate.** It is non-deterministic, and a run whose LLM calls partially fail reports a higher score than a clean one.
### Triaging a scan finding — the decision order

Work down this list; stop at the first that fits. Every acceptance needs the operator's word and a `reason` carrying its "Still flag if:" clause.

1. **Is it real?** Trace it before anything else. A real finding gets fixed, not accepted. Two on this repo turned out real and were fixed at source — a detection row whose wording introduced an `AE1`, and a template placeholder that shipped a literal `<group>`.
2. **Is the cause one file, shared by many skills?** Use a **rule** with a literal `id` + `path`. One cause, one entry, however many skills report it — the `references/conventions.md` marker protocol produces ten findings from one rule.
3. **Is it a one-off in specific content?** Use a **fingerprint**. Content-hashed, so it re-triggers the moment that content changes. Beware: the scanner's own `skillspector baseline` **deduplicates** what it emits, so a group of occurrences can come back as fewer hashes than the matcher needs — check the count actually drops before trusting it.
4. **Is it a completeness signal rather than a behaviour?** Use a **`coverage:`** entry, naming the skill, the file, and the file's `sha256`. This is ours, not the scanner's — SkillSpector's baseline suppresses findings only, and has no way to accept "I could not finish reading this". `AE1` belongs here despite arriving as a HIGH finding: its own text is *"Referenced artifact was not completely inspected."* Two things to know when writing one:
   - **It is content-bound and expires.** Edit the accepted file and the acceptance stops applying, and the skill blocks until you re-adjudicate. That is the point: an acceptance that outlives the file it describes is a reason with nothing behind it. Refresh the digest **after** the final `bun run build`, since the bundle is what gets scanned — and note that editing the guard's own script invalidates its own entry.
   - **Say what it hides.** A coverage entry accepts every `AE1` on that file and the degradation of every analyzer for that skill. Name the reason code and the number of degraded analyzers in the reason, so the next reader can tell whether the cause is still the one that was accepted.

5. **Write the "Still flag if:" clause so it can actually fire.** A clause naming something already true is decoration. Check it against the file before committing: "still flag if it gains a shell invocation" is worthless on a file that already shells out. Good clauses name a *change* — a different reason code, more degraded analyzers, a rule id the entry does not cover.
6. **None of the above?** Park it with a written ruling. Do not widen an entry to make a guard green — that is the failure this whole system exists to prevent.

### Known SkillSpector behaviours on this repo

Recorded so nobody re-derives them. All traced in issue 62.

- **`static_parse_limit`: a backtick at a shell-word start whose first inner token carries an expansion degrades `static_patterns_tool_misuse` for the whole skill.** The bounded shell parser reads a backtick preceded by whitespace or one of `;|&()<>/` as a command substitution, and gives up when the first whitespace-delimited token inside it holds a dollar-sign expansion — a JavaScript template literal opening on its interpolation (an API path built from a variable, a message that leads with a value), or a Markdown code span opening on a shell variable. Statement position is irrelevant: call arguments and assignments trip it alike, and a literal that opens with a plain word scans complete wherever it sits. Bisected against the scanner's own predicate in issue 104 (skillify's `trigger-check.mjs` carries the rule); it replaces an earlier note that blamed "assignment position", which was neither necessary nor sufficient. Fix: concatenate, or lead with a literal word; it clears only when every site in the file is fixed. Same code, different construct: a shell command substitution whose first word is printf and whose body the scanner cannot evaluate statically (a pipe inside it) is refused by design, so lead the substitution with another command or accept it.
- **`obfuscated_instruction_text` degrades every analyzer without a bounded-parse hook (twelve).** The cause is a removal-cue verb — `ignore`, `strip`, `drop`, `remove`, `omit` … — directly beside its own closing quote, which the reconstruction pass reads as an unsupported "ignore the literal …" directive and fails closed on once any later quoted string in the file activates it. In this repo that is Node's `stdio` mode word for a discarded fd; hoisting the word into a named constant clears it while the same bytes reach the child. Which files trip it depends on their other string literals, so the fix is applied at every site, not only the reporting one.
- **`AE1` on a `SKILL.md` usually means its references, not its behaviour** — either repo-root paths that cannot resolve relative to a skill directory (correct for a repo-scoped meta-skill), or a file it links to that the parser could not finish. Check which before accepting.
- **`P2` fires on every HTML comment**, because a hidden instruction is a genuine injection vector. This repo uses HTML comments as machine-readable markers — `vsk:v1`, `vsk-dev:start`, `<!-- source: … -->`, `<!-- mirrored -->` — so the finding is the documentation of a mechanism, not an instance of one. Scope the rule to the file, never to the id alone.
- **The aggregate risk score is not a gate.** It is inflated by unresolvable-path artifacts in meta-content and deflated by unrelated suppressions.

- **A skill authored elsewhere is scanned the same way, before it reaches an agent** — `--root <path to the skill>`. This repo does not yet redistribute anyone else's skill; when it does, the curation, audit, upstream-drift, release, and retirement rules are this skill's to own, and a curated skill is never hand-edited locally (a local fix is overwritten by the next upstream sync and forks us from its author). Scanning a third-party skill you are evaluating works today and needs none of that.

## UNVERIFIED register

Do not assert any of these; if one becomes load-bearing, verify against the live source first and move it into a marked sentence:

- agentskills.io spec version identifier.
- Codex official unknown-frontmatter-key behavior (community: ignored).
- Codex legacy `~/.codex/skills` discovery.
