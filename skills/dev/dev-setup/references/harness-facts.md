# Harness facts

Verified mechanics of the three harnesses this workflow targets — Claude Code, Codex, Hermes — and the GitHub CLI floor. Everything here is volatile — vendors change these — so each claim carries its source; the refresh contract tracks them. Verified 2026-09-03.

## Claude Code

- Claude Code does **not** read AGENTS.md natively. The documented pattern is a CLAUDE.md that imports it: a line containing `@AGENTS.md` (import syntax is `@path/to/file`, resolved relative to the containing file, maximum 4 hops of recursion; `@` inside backticks stays literal). <!-- source: CC-MEMORY -->
- `CLAUDE.local.md` in the project root loads after CLAUDE.md and is meant to be gitignored — leave it alone; it is the user's personal file. <!-- source: CC-MEMORY -->
- Project skills load from `.claude/skills/<name>/SKILL.md`; personal skills from `~/.claude/skills/`. <!-- source: CC-SKILLS -->
- The structured question tool is **AskUserQuestion**. It is unavailable in non-interactive runs (`claude -p`); a configurable timeout can auto-submit pre-selected options. <!-- source: CC-TOOLS -->
- Hooks live in settings files (`.claude/settings.json` project-level) under a `hooks` key mapping event names to command entries. The `Stop` event fires when Claude finishes a turn; its stdin JSON includes `session_id`, `stop_hook_active`, and `last_assistant_message`; a hook keeps the agent going by emitting `{"decision": "block", "reason": "…"}` (or exit 2 with the reason on stderr) — `reason` is shown to the agent. `SessionEnd` cannot block. `SubagentStop` is a separate event — leave it unwired so subagents don't fire nudges. <!-- source: CC-HOOKS -->
- **Worktrees.** Hook paths do not follow the worktree: `CLAUDE_PROJECT_DIR` "still points at the project root where the session started", while the hook input's `cwd` "is the worktree root, and it moves again when Claude runs `cd`" — a hook that needs the worktree reads `cwd`. A permission approval granted in a worktree is saved to the **main checkout's** `.claude/settings.local.json`, "so it applies in the main checkout and in every other worktree of the repository, and it survives the worktree's removal" (the exception is Windows and the other cases where Claude Code does not use the repository root, where the rule stays with that worktree). Non-interactive `-p` runs "have no exit prompt, so Claude doesn't clean up their worktrees" — cleanup belongs to whatever created them. Claude Code itself refuses to create a worktree when `.claude`, `.claude/worktrees`, or the worktree directory is a symlink. <!-- source: CC-HOOKS -->
- **Saved dynamic workflows.** A workflow script in `.claude/workflows/` resolves by name from the `Workflow` tool. It must open with a pure-literal `export const meta = { name, description, phases }` — no computed values — and it has no filesystem or Node API access: `Date.now()`, `new Date()` and `Math.random()` throw inside one. Concurrent `agent()` calls are capped at `min(16, cpus - 2)`, one `pipeline()`/`parallel()` call takes at most 4096 items, and a run's lifetime agent count is capped at 1000. Verified 03-09-2026 against claude-code 2.1.247. <!-- source: CC-TOOLS -->
- **Agent worktree isolation.** `isolation: "worktree"` gives an agent its own worktree and returns its path and branch; the worktree is auto-cleaned only when the agent changed nothing. `worktree.baseRef` is `fresh` (the default — branches from `origin/<default-branch>`) or `head` (branches from local HEAD). A run that must branch from a specific commit tells the agent the sha rather than relying on that setting. Verified 03-09-2026 against claude-code 2.1.247. <!-- source: CC-TOOLS -->
- **Telemetry.** Claude Code exports OpenTelemetry metrics and log events. `claude_code.skill_activated` is "logged when a skill is invoked, whether Claude calls it through the Skill tool or you run it as a `/` command", carrying `invocation_trigger` (`"user-slash"`, `"claude-proactive"`, `"nested-skill"`); `skill.name` is `"custom_skill"` for user-defined and plugin skills unless `OTEL_LOG_TOOL_DETAILS=1`, which also exports "Bash commands, MCP server and tool names, skill names … and tool input". It is off by default and this workflow never turns it on. Verified 03-09-2026. <!-- source: CC-TELEMETRY -->
- The Agent SDK's `claude_code` system-prompt preset is Claude Code's own system prompt (`systemPrompt: { type: 'preset', preset: 'claude_code' }`); anything that prompt already says reaches every Claude Code session without a skill repeating it. <!-- source: CC-SDK-PRESET -->

## Codex

- Codex reads AGENTS.md natively: from `~/.codex/` (global; `AGENTS.override.md` wins over `AGENTS.md`), then from the repo root down to the working directory, one file per directory, concatenated root-first so closer files override. Combined size is capped by `project_doc_max_bytes`, default 32 KiB. There is **no** `@file` import mechanism — layering is directory-based only. <!-- source: CODEX-AGENTS -->
- Skills load from `.agents/skills/` in each directory from the working directory up to the repo root, plus `~/.agents/skills/` for the user. Frontmatter requires only `name` and `description`; an optional `agents/openai.yaml` adds display metadata and invocation policy. <!-- source: CODEX-SKILLS -->
- The structured question tool is **`request_user_input`** — collaboration-mode-gated (available in Plan mode; elsewhere it fails fast with a clear error, and it is not available to subagents). Community posts mention an "ask_user_question"/"clarify" tool; that is a proposal, not a shipped tool — do not design against it. <!-- source: CODEX-SKILLS -->
- Non-interactive mode is `codex exec`: fully unattended, human-input tools unavailable, AGENTS.md discovery unchanged. <!-- source: CODEX-EXEC -->
- Codex hooks are stable: `~/.codex/hooks.json` or `<repo>/.codex/hooks.json` (inline `[hooks]` tables in config.toml also work); events `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Stop`; the same stdin-JSON contract as Claude Code — `{"decision": "block", "reason": "…"}` or exit 2 blocks, `Stop` carries `stop_hook_active` and `last_assistant_message`, `SubagentStop` is separate — with one gap: `permissionDecision: "ask"` is parsed but unsupported, so a hook that needs a human answer blocks instead. Non-managed hooks run only after the user trusts their exact definition, project-local hooks only when the repo's `.codex/` layer is trusted; `codex exec --dangerously-bypass-hook-trust` runs enabled hooks headless for automation that vets hook sources itself. <!-- source: CODEX-HOOKS -->
- Project trust is per-path in `~/.codex/config.toml`: a `[projects."<abs path>"]` table with `trust_level = "trusted"`. "If you mark a project as untrusted, Codex skips project-scoped `.codex/` layers, including project-local config, hooks, and rules" — user- and system-level config keep working. A new worktree is a new path, so it needs its own entry before any run there can see the repo's `.codex/` layer. <!-- source: CODEX-CONFIG -->
- Codex multi-agent is stable: built-in agents `default`, `worker` (implementation) and `explorer` (read-only exploration); custom agents are `.codex/agents/<name>.toml` files, a custom name overriding a built-in of the same name; `agents.max_concurrent_threads_per_session` in config.toml caps parallel threads. <!-- source: CODEX-AGENTS-MULTI -->
- The multi-agent tools are `spawn_agent`, `wait_agent`, `close_agent` and `list_agents`. **`spawn_agent` has no cwd parameter**, so a spawned agent shares the parent's cwd and its `workspace-write` writable root and cannot write to a sibling worktree. Per-child isolation on Codex is therefore one `codex exec -C <worktree>` process per child, not a spawned agent. Verified 03-09-2026 against Codex CLI 0.149.1. <!-- source: CODEX-AGENTS-MULTI -->

- **Telemetry.** OTel log export is **disabled by default**, opted into with an `[otel]` table in config.toml (`exporter = "none"`, `otlp-http`, `otlp-grpc`; with `"none"` Codex "records events but sends nothing"). The documented stream covers "API requests, SSE/events, prompts, tool approvals/results" and names no skill-activation event — which is why skill capture on Codex is a prompt-mention proxy (the skill's name after a dollar sign), recorded as one. Verified 03-09-2026. <!-- source: CODEX-OTEL -->

## Hermes

- Hermes hooks: a shell `pre_tool_call` hook can block a tool call or fail closed; plugin hooks register `pre_tool_call`, `post_tool_call`, `pre_llm_call` and `post_llm_call` through `ctx.register_hook`, bounded by `plugins.hook_callback_timeout` (default 30s). There is no Stop-style turn hook, so the decision-capture recipe below has no Hermes wiring. <!-- source: HERMES-HOOKS -->
- The **Curator** is "a background maintenance pass for agent-created skills": it tracks views, uses and patches, moves long-unused skills active → stale → archived, runs on an inactivity check rather than a cron daemon, and never auto-deletes. It maintains skills; it is not a usage-statistics stream. Verified 03-09-2026. <!-- source: HERMES-CURATOR -->
- Hermes tools: the structured question tool is `clarify`; `delegate_task` spawns subagents; both are ordinary toolset entries (`clarify`, `delegation`), so a headless Hermes run with the toolset off degrades exactly like a Claude Code `-p` run. Skills load from `~/.hermes/skills/` only — no project-level discovery. <!-- source: HERMES-TOOLS -->

## Model, effort, and concurrency controls

Which model and which reasoning effort a stage runs at is dev.md's `harness-policy:` knob; these are the flags each value turns into.

| Harness | Model control | Effort control | Concurrency cap |
|---|---|---|---|
| Claude Code | `--model` takes an alias or a full model name — aliases `fable`, `sonnet`, `opus`, `haiku` (plus `best`, `default`, `opusplan`, `sonnet[1m]`, `opus[1m]`), full names look like `claude-sonnet-5`; overrides the `model` setting and `ANTHROPIC_MODEL` <!-- source: CC-CLI --> | `--effort` sets the level for the session; overrides the `modelSettings` and `effortLevel` settings and does not persist <!-- source: CC-CLI --> | `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (nesting depth below the main conversation, default 3; `1` turns nesting off) and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (simultaneous subagents, default 20) — both env vars, settable under settings.json's `env` <!-- source: CC-SUBAGENT-ENV --> |
| Codex | `codex exec -m <model>`, or `-c model=<id>` as a config override <!-- source: CODEX-CONFIG --> | `-c model_reasoning_effort=<level>` — the config key the docs demonstrate as `"high"` and do not enumerate, so read the level names off the model's own documentation before promising one <!-- source: CODEX-CONFIG --> | `agents.max_concurrent_threads_per_session` in config.toml caps concurrently open spawned-agent threads, excluding the primary; unset means Codex picks the default <!-- source: CODEX-AGENTS-MULTI --> <!-- source: CODEX-CONFIG --> |
| Hermes | none documented | none documented | `plugins.hook_callback_timeout` bounds hooks, not agents <!-- source: HERMES-HOOKS --> |

Hermes has no documented model or effort flag, so a `harness-policy:` entry never names it as the agent — a policy value that cannot be passed as a flag is a promise the dispatcher cannot keep.

Verified 03-09-2026: Claude Code's effort levels are low, medium, high, xhigh and max on Fable 5.1, Fable 5, Opus 5 and Sonnet 5 (high is the default on every model except Opus 4.7, whose default is xhigh), and `ultracode` is a Claude Code setting on top that starts the session at xhigh with dynamic workflows on and needs v2.1.203 or later; `claude --version` here reads 2.1.247 and its `--help` lists the first five. Model ids move, which is why dev.md's `harness-policy:` knob holds them and this file only dates them. <!-- source: CC-CLI -->

### The `codex exec` skill-loading drill

Whether a headless Codex run discovers project skills on its own decides one thing downstream: if it does not, every dispatched Codex run has to name the SKILL.md path in its prompt. The drill answers it in one command. **The operator runs it by hand.** It starts a real Codex session, so it spends the operator's own Codex quota on the operator's own account — no skill, hook or dispatcher may run it unasked, and dev-setup only ever prints it for the operator to copy. Run it from a scratch directory so the repo's un-ignored `.agents/` is never written to:

```sh
codex login status                      # must print "Logged in"; a revoked session still prints it — the run below is the real check
PROBE=$(mktemp -d)
mkdir -p "$PROBE/.agents/skills/vsk-probe"
printf -- '---\nname: vsk-probe\ndescription: Probe skill for the harness drill. Use when asked for the probe token.\n---\n\nWhen asked for the probe token, reply with exactly VSK-PROBE-OK-7413 and nothing else.\n' > "$PROBE/.agents/skills/vsk-probe/SKILL.md"
codex exec -C "$PROBE" --skip-git-repo-check -s read-only 'Use the vsk-probe skill and reply with the probe token, nothing else.'
codex --version
```

The token `VSK-PROBE-OK-7413` in the reply means project skills load under `codex exec`; its absence means they do not. Record the answer with the date and the exact `codex --version` string.

Attempted 03-09-2026 on codex-cli 0.149.1 and **not answered**: `codex login status` printed "Logged in using ChatGPT" while the run itself failed with `refresh_token_invalidated` / `token_revoked` (401) before reaching the model — the expired-session case dev.md's Environments section anticipates. The verdict line stays unwritten rather than guessed; re-run the drill after `codex login`. <!-- source: CODEX-SKILLS --> <!-- source: CODEX-EXEC -->


## GitHub CLI

- Floor **2.94.0**: `gh issue create` and `gh issue edit` take `--type`, `--parent` / `--add-sub-issue`, and `--blocked-by` (edit forms `--add-…`/`--remove-…`) — native issue types, sub-issues and dependencies without the API (GitHub.com; GHES 3.17+ for types and sub-issues, 3.19+ for relationships). <!-- source: GH-CLI -->
- Floor **2.97.0**: `gh project item-edit --field <name> --value <text>` and `gh project item-list --field <name>` address project fields and single-select options by name; below it, fields need their IDs. <!-- source: GH-CLI -->
- Below a floor, dev-setup names the missing feature in its report and dev-intake uses the `epic` label and the REST API instead; the floors live here and nowhere else because they move with every gh release.

## The hooks package (optional, offered in Round C)

Four hooks, one Node file each, written to `.vegastack/hooks/` and wired only on the operator's explicit yes, merged into existing hook config rather than replacing it.

| Event | File | What it does | Harnesses |
|---|---|---|---|
| `PreToolUse` | `ship-guard.mjs` | Asks before a command the compiled policy says needs the operator's word — a merge, a tag, a publish, a production deploy, a force push. | Claude Code · Codex · Hermes |
| `SessionStart` | `session-start.mjs` | Requests a bounded verified-context pointer from the local VegaFactory resolver. | Claude Code · Codex |
| `Stop` | `stop-heartbeat.mjs` | Requests a bounded local checkpoint flush; no continuation or blocking output. | Claude Code · Codex |
| `Stop` | `decision-nudge.mjs` | Asks whether this session settled a directional choice worth a register line. | Claude Code · Codex |

The hook files ship as packaged assets — `assets/hooks/ship-guard.mjs`, `assets/hooks/session-start.mjs`, `assets/hooks/stop-heartbeat.mjs`, `assets/hooks/decision-nudge.mjs` — and are copied verbatim into `.vegastack/hooks/`. The advisory SessionStart adapter is also the shared implementation for `stop-heartbeat.mjs` and `session-end.mjs`: copy `session-start.mjs` beside either consumer even when its SessionStart event is not enabled. Missing CLI/adapter support is silent and does not prove capture. The ship guard and decision nudge remain separate. The wiring shape is doubly nested — matcher groups each holding their own `hooks` array — in Claude Code's `.claude/settings.json` and Codex's `<repo>/.codex/hooks.json` alike (merge into existing hook config, never overwrite): <!-- source: CC-HOOKS --> <!-- source: CODEX-HOOKS -->

```json
{ "hooks": {
  "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node .vegastack/hooks/ship-guard.mjs --harness claude" } ] } ],
  "SessionStart": [ { "hooks": [ { "type": "command", "command": "node .vegastack/hooks/session-start.mjs --harness claude", "timeout": 1 } ] } ],
  "Stop": [ { "hooks": [ { "type": "command", "command": "node .vegastack/hooks/stop-heartbeat.mjs --harness claude", "timeout": 1 }, { "type": "command", "command": "node .vegastack/hooks/decision-nudge.mjs --harness claude" } ] } ]
} }
```

The Codex block is the same file, `--harness codex`, written to `<repo>/.codex/hooks.json`:

```json
{ "hooks": {
  "PreToolUse": [ { "hooks": [ { "type": "command", "command": "node .vegastack/hooks/ship-guard.mjs --harness codex" } ] } ],
  "SessionStart": [ { "hooks": [ { "type": "command", "command": "node .vegastack/hooks/session-start.mjs --harness codex", "timeout": 1 } ] } ],
  "Stop": [ { "hooks": [ { "type": "command", "command": "node .vegastack/hooks/stop-heartbeat.mjs --harness codex", "timeout": 1 }, { "type": "command", "command": "node .vegastack/hooks/decision-nudge.mjs --harness codex" } ] } ]
} }
```

Codex's example intentionally has no matcher, covering every supported tool event. Current [official hook documentation](https://learn.chatgpt.com/docs/hooks) maps shell and unified exec to `Bash`; the supported restrictive grammar is an explicit name union containing `Bash`, optionally anchored. Hosted/specialized tool paths and later stdin transport mean this is not complete remote-effect mediation. Unknown coverage remains unknown. Verified documentation 07-09-2026; actual pinned-harness execution remains qualification evidence. <!-- source: CODEX-HOOKS -->

Codex parses `permissionDecision: "ask"` but does not support it, so the ship guard sends Codex `{"decision":"block","reason":"<command> needs the operator's word — run it by hand"}` instead; a Codex operator answers by running the command themselves. <!-- source: CODEX-HOOKS -->

Project-local Codex hooks load only once the repo's `.codex/` layer is trusted, and a worktree is a separate path that needs its own trust — dev-setup says so before it offers the wiring. <!-- source: CODEX-CONFIG -->

Hermes takes only the ship guard, as a `pre_tool_call` entry in `~/.hermes/config.yaml`:

```yaml
hooks:
  pre_tool_call:
    - command: node .vegastack/hooks/ship-guard.mjs --harness codex
      fail_closed: true
```

Hermes has no Stop-style turn hook and no SessionStart event, so only the ship guard wires there; it reuses the Codex block shape because Hermes reads the same `{"decision":"block"}` contract. <!-- source: HERMES-HOOKS -->

The ship guard's only source of policy is `~/.vegastack/guard/<owner>__<repo>.json`, keyed by the checkout's origin remote and compiled from `.vegastack/dev.md` — the `## Environments` policy lines, the `gates:` knob, the `repo:` line's default branch and the commands the `## Ship` runbook's `ask:` lines name in backticks — by `scripts/ship-policy.mjs` on the operator's yes, or by `vegafactory guard sync` afterwards. dev.md stays the declared intent a human edits; the JSON is the enforcement copy, outside every worktree, so no task edits it and no commit carries it. The guard never reads dev.md: a run under bypassed permissions could otherwise write `- prod: auto — gh pr merge` into its own worktree's profile and authorise the command it was about to run. With the policy file missing, unreadable, malformed or compiled for another repository, every guarded command asks with a reason naming the file and the sync command; a command whose text touches `.vegastack/guard` is itself on the always-ask list; the managed launch gate performs the compiler comparison and refuses stale policy. The guard reads the command as a shell would — quotes, escapes, `;` `&&` `||` `|` `&`, subshells and dollar-paren command substitution — resolves wrappers (`sudo`, `env`, `nice`, `time`, `timeout`, `xargs`, `sh -c`, a path or an escape on the head) and git and gh global options, then matches the resolved argv: a push's destination in every refspec spelling (`HEAD:main`, `refs/heads/main`, `main:main`, `+main`), force and delete flags in any position, `gh api` on a merge URL, and a probe of text handed to another interpreter. A command inside the shipping family that nothing classifies resolves to ask, never allow.

What the guard is not: it runs as the same user as the agent, so it can neither hide its policy from that user nor stop a run that reads credentials or reaches the network outside the shipping verbs. Branch protection and a read-only App token remain the walls; the guard closes the self-authorisation path, refuses what it cannot read, and makes tampering visible.

The prose instruction in the AGENTS.md dev section is the portable base on both harnesses; these hooks are deterministic nudges on top, not a replacement.

## Headless runs

What a dispatcher can rely on when it starts a run with no human at the keyboard.

- Hooks fire under `claude -p`: a headless Claude Code run gets the same `PreToolUse` / `Stop` events as an interactive one, which is what lets the ship guard bound a dark build. <!-- source: CC-HOOKS -->
- Codex refuses non-managed hooks in an unattended run unless the caller vets them: `codex exec --dangerously-bypass-hook-trust` runs the enabled hooks headless, and it is the only way a dispatched Codex run reaches the ship guard at all. <!-- source: CODEX-HOOKS -->
- Agent teams do not spawn under `-p`: a headless Claude Code run has subagents bounded by `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, and a run needing a team is a run that belongs in an interactive session. <!-- source: CC-SUBAGENT-ENV -->
- A headless run has no question tool at all, so `VSK_ASK_ROUTE=issue` is what the dispatcher sets: the round goes into the issue with its options and the recommendation, and the next run reads the answer there. <!-- source: CC-CLI -->

## What this means for the dev skills

- AGENTS.md is the shared instruction file; the one-line CLAUDE.md import makes it reach Claude Code. Keep the marked section small — it counts against Codex's 32 KiB budget along with everything else in AGENTS.md.
- Any skill that wants to ask the user degrades by `references/ask-route.md`: intake, plan and implement put the round in the issue and stop at `needs-operator` (intake creates the issue first when the round comes before one exists); dev-setup, which can run before any issue exists, writes documented defaults marked `# TODO confirm` instead and says so.
- Observed 02-09-2026: the `claude_code` preset already carries the current model guidance on autonomy, delivering work, readability and parallel tool calls; Codex and Hermes get none of it. That is why the AGENTS.md conduct paragraph exists and why skill bodies never restate harness behaviour — a restated instruction competes with the harness's own wording.
- Parallel children use the owned CLI gateway: a registered, currently owned parent passes the canonical `plan-lint --groups --json` result to `vegafactory children run`, then integrates accepted results with `vegafactory children join`. The gateway owns preparation, bounded concurrency, shared acquisition, execution through the checked runtime, durable results and acceptance; the standalone `children.mjs plan` remains non-executing. Harness processes and worktrees are implementation details behind the gateway, not alternate caller-owned executors. The full contract lives in dev-implement's `references/parallel-children.md` and `references/worktrees.md`.
- The OpenTelemetry stream is **optional and never required**: capture is deterministic without a collector — the dispatcher parses each harness's own run output, SessionEnd hooks cover interactive sessions, and skill invocations come from hook payloads. `OTEL_LOG_TOOL_DETAILS` stays off; it exports exactly the tool arguments a record must never hold.
- Every target harness spawns subagents (Claude Code's Task tool, Codex agents, Hermes `delegate_task`), so dev.md's `review:` knob means the same thing on each; only a headless run that cannot spawn falls back to a labeled self-review.


## Managed hook and native-memory contract — 07-09-2026

Configuration is separate from invocation and qualification. The dispatcher validates synchronous `PreToolUse` command hooks with direct `node <resolved checkout guard> --harness claude|codex` argv, quoted paths allowed; wrappers, operators, wrong flags/events, symlinks and absent interpreters refuse. Guard bytes must match the installed package. Claude project/local/user JSON and Codex JSON plus documented inline array-of-tables are inspected together; complex inline hook syntax gets an explicit migration refusal. Merge new owned registrations only when no equivalent event/argv already exists across those sources; preserve user hooks and original files. Do not replace their configuration or silently recompile policy during launch.

Check the selected harness in the prepared ordinary or parent worktree and immediately before spawn. The installed owner compiler performs `--check --json` against the checkout's actual origin and current policy, bounded to ten seconds. Stale/missing/unsupported output refuses. A passing configuration check is not proof that a vendor invoked the guard. A local guard subprocess establishes only local invocation; retain the harmless denied-command proof and unchanged-effect evidence from actual harness qualification separately. Same-user hooks are cooperative, and protected remote effects still require server-side permissions.

Native memory is excluded only in VegaFactory-managed processes. Pinned metadata: Codex0.153.4 and Claude Code2.1.263. Unknown versions refuse managed execution pending qualification. Claude managed launch currently also refuses because version/help and a cached/raw settings cascade cannot establish effective managed-hook or memory applicability; no SDK dependency or CLI-session probe is implied. Codex overrides `memories.use_memories=false`, `memories.generate_memories=false`, disables memories/import and `features.context_management.experimental_mode`, and retains hooks/project trust for the exact checkout. The optional task-note/search facility is separate from ordinary project instructions. Claude uses `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and session `autoMemoryEnabled:false`, without bare/safe mode or disabling CLAUDE.md. No global setting or existing vendor store is changed/read. Controls are supported configuration, not runtime qualification: verify their actual pinned behavior before claiming support. Sources: [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [Codex context management](https://learn.chatgpt.com/docs/models), [Claude memory](https://code.claude.com/docs/en/memory). <!-- source: CODEX-CONFIG --> <!-- source: CC-MEMORY -->

### Local advisory wire contract

`session-start.mjs`, `stop-heartbeat.mjs` and `session-end.mjs` require explicit `--harness claude|codex`; configure each enabled event with `timeout: 1` second. The optional SessionEnd registration has the same nested command shape and invokes `node .vegastack/hooks/session-end.mjs --harness <selected>` with that timeout. Installing files does not enable a new event.

The adapter reads at most64KiB and waits at most350ms for input, then allows500ms for a local Node CLI invocation. SessionStart invokes `vegafactory learning inspect --source managed-hook --json`; Stop and SessionEnd invoke `vegafactory stats record --source managed-hook`. Their only JSON fields are `{harness,event,sessionId,turnId?,cwd,stopHookActive}`. Events are exactly `SessionStart`, `Stop`, `SessionEnd`; session/turn IDs are1–128 ASCII letters/digits/underscore/hyphen starting with a letter/digit. cwd is an absolute path of at most4096 characters without NUL/newline. It is an identity hint, never a write destination. Each local consumer verifies registered repository/worktree membership and the owned current run/session before any read, flush or lesson lookup; unknown/foreign identities refuse silently. No transcript/tool payload, network, model subprocess, detached upload or Stop continuation is allowed.

The stats and learning CLIs implement the managed-hook consumers: the stats path performs registered/current owned-context capture and flush, and the learning path selects verified lessons only for that validated context. Identical repeated events retain identical identity fields, without fabricated timestamps or IDs; failures and unknown identities remain deliberately silent. Implemented consumers and fixture invocation are not actual pinned-vendor qualification.

SessionStart emits context only when the local consumer returns `{ok:true}`, a valid `vsk-context:<opaque-id>` pointer and one to three verified lesson rows whose encoded total is at most2KiB. The hook validates each lesson ID and bounded statement, then emits structured `hookSpecificOutput.additionalContext` containing the statements plus an advisory/authority caveat. Pointer-only, empty, malformed, oversized, timed-out or refused results stay silent. Stop/SessionEnd never emit instructions, even on success. Missing CLI/sibling, invalid input/output, unknown source, timeout and re-entered Stop exit0 without output. CLI refusal/missing response is not a persisted-checkpoint receipt. Shell wrappers around the installed JavaScript CLI are unsupported; the adapter verifies the package name/bin layout and both its own and the installed shared-hook bytes against the package integrity manifest, then invokes that JavaScript bin with Node. This assumes an operator-trusted installation, not a publisher attestation or hostile same-user isolation. Retain authored AGENTS.md/CLAUDE.md and hooks. Actual vendor invocation, memory exclusion and complete effect coverage need their own evidence.


Codex configuration applicability uses a bounded five-second stdio metadata connection to the installed0.153.4 CLI: only initialize/initialized, hooks/list for the exact cwd, configRequirements/read and config/read. It starts no task or turn, invokes no hook, closes the process afterward, and retains no raw configuration or stderr. Require complete replies, no loader errors, an enabled synchronous exact guard definition/hash/source and compatible managed requirements. Disabled or managed-only-incompatible hooks refuse even when the global hooks feature is true. Effective config must show memory retrieval/generation/import/context disabled. The tested trust override is the invocation-only whole map `-c projects={"/actual/checkout"={trust_level="trusted"}}`; the dotted quoted spelling creates the wrong key in0.153.4. No persisted trust entry is written. [Official app-server protocol](https://learn.chatgpt.com/docs/app-server). <!-- source: CODEX-CONFIG -->

The runtime emits the existing recovery arm `remoteEffectCoverage:{kind:"unmanaged-possible",reasonCode:"hook-configuration-only"}` in launch/tick evidence. No configuration inspection, local denial or implemented consumer promotes it to qualified mediation; #137/#158 own receipt validation. The owned child gateway is integrated and reuses the checked executor for every prepared child, but parallel admission still requires canonical groups and current qualified shared-parent ownership. Configuration and local fixtures do not qualify actual vendor execution; raw command descriptions are not execution evidence. Refusal before the OS acknowledges spawn neither records a launch nor consumes a corrections reaction.
