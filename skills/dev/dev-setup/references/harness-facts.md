# Harness facts

Verified mechanics of the two harnesses this workflow targets — Claude Code and Codex — and the GitHub CLI floor. Everything here is volatile — vendors change these — so each claim carries its source and is re-checked there when older than 60 days. Verified 2026-09-03.

## Claude Code

- Claude Code does **not** read AGENTS.md natively. The documented pattern is a CLAUDE.md that imports it: a line containing `@AGENTS.md` (import syntax is `@path/to/file`, resolved relative to the containing file, maximum 4 hops of recursion; `@` inside backticks stays literal). <!-- source: CC-MEMORY -->
- `CLAUDE.local.md` in the project root loads after CLAUDE.md and is meant to be gitignored — leave it alone; it is the user's personal file. <!-- source: CC-MEMORY -->
- Project skills load from `.claude/skills/<name>/SKILL.md`; personal skills from `~/.claude/skills/`. <!-- source: CC-SKILLS -->
- The structured question tool is **AskUserQuestion**. It is unavailable in non-interactive runs (`claude -p`); a configurable timeout can auto-submit pre-selected options. <!-- source: CC-TOOLS -->
- Hooks live in settings files (`.claude/settings.json` project-level) under a `hooks` key mapping event names to command entries. The `Stop` event fires when Claude finishes a turn; its stdin JSON includes `session_id`, `stop_hook_active`, and `last_assistant_message`; a hook keeps the agent going by emitting `{"decision": "block", "reason": "…"}` (or exit 2 with the reason on stderr) — `reason` is shown to the agent. `SessionEnd` cannot block. `SubagentStop` is a separate event. `SessionStart` and `UserPromptSubmit` add context with `{"hookSpecificOutput": {"hookEventName": "…", "additionalContext": "…"}}`; `PreToolUse` answers with `hookSpecificOutput.permissionDecision` `allow` · `deny` · `ask` · `defer` plus `permissionDecisionReason`. File tools are `Write`, `Edit`, `MultiEdit` and `NotebookEdit`; the shell tool is `Bash`. Command hooks time out after 600 s by default (30 s on `UserPromptSubmit`); `SessionEnd` hooks share a 1.5 s budget unless a hook sets a longer `timeout`. Verified 17-09-2026. <!-- source: CC-HOOKS -->
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
- Codex hooks are stable: `~/.codex/hooks.json` or `<repo>/.codex/hooks.json` (inline `[hooks]` tables in config.toml also work); events `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Stop`; the same stdin-JSON contract as Claude Code — `{"decision": "block", "reason": "…"}` or exit 2 blocks, `Stop` carries `stop_hook_active` and `last_assistant_message`, `SubagentStop` is separate — with one gap: `permissionDecision: "ask"` is parsed but unsupported, so a hook that needs a human answer denies instead (`hookSpecificOutput.permissionDecision: "deny"` with a reason; the legacy `{"decision": "block"}` also works). Every payload carries `session_id`, `cwd`, `hook_event_name`, `model` and `permission_mode`; tool events add `tool_name` (`Bash`, `apply_patch`, MCP names) and `tool_input`. `SessionStart` and `UserPromptSubmit` add plain stdout or `additionalContext` as developer context; `Stop` must print JSON or nothing; `PostToolUse` ignores plain stdout. Hooks time out after 600 s by default; `SessionEnd` defaults to 1 s and allows up to 3 s. Verified 17-09-2026. Non-managed hooks run only after the user trusts their exact definition, project-local hooks only when the repo's `.codex/` layer is trusted; `codex exec --dangerously-bypass-hook-trust` runs enabled hooks headless for automation that vets hook sources itself. Events now also include `Interrupt`. <!-- source: CODEX-HOOKS -->
- Project trust is per-path in `~/.codex/config.toml`: a `[projects."<abs path>"]` table with `trust_level = "trusted"`. "If you mark a project as untrusted, Codex skips project-scoped `.codex/` layers, including project-local config, hooks, and rules" — user- and system-level config keep working. A new worktree is a new path, so it needs its own entry before any run there can see the repo's `.codex/` layer. <!-- source: CODEX-CONFIG -->
- Codex multi-agent is stable: built-in agents `default`, `worker` (implementation) and `explorer` (read-only exploration); custom agents are `.codex/agents/<name>.toml` files, a custom name overriding a built-in of the same name; `agents.max_concurrent_threads_per_session` in config.toml caps parallel threads. <!-- source: CODEX-AGENTS-MULTI -->
- The multi-agent tools are `spawn_agent`, `wait_agent`, `close_agent` and `list_agents`. **`spawn_agent` has no cwd parameter**, so a spawned agent shares the parent's cwd and its `workspace-write` writable root and cannot write to a sibling worktree. Per-child isolation on Codex is therefore one `codex exec -C <worktree>` process per child, not a spawned agent. Verified 03-09-2026 against Codex CLI 0.149.1. <!-- source: CODEX-AGENTS-MULTI -->

- **Telemetry.** OTel log export is **disabled by default**, opted into with an `[otel]` table in config.toml (`exporter = "none"`, `otlp-http`, `otlp-grpc`; with `"none"` Codex "records events but sends nothing"). The documented stream covers "API requests, SSE/events, prompts, tool approvals/results" and names no skill-activation event — which is why skill capture on Codex is a prompt-mention proxy (the skill's name after a dollar sign), recorded as one. Verified 03-09-2026. <!-- source: CODEX-OTEL -->


## Model, effort, and concurrency controls

Which model and which reasoning effort a stage runs at is dev.md's `harness-policy:` knob; these are the flags each value turns into.

| Harness | Model control | Effort control | Concurrency cap |
|---|---|---|---|
| Claude Code | `--model` takes an alias or a full model name — aliases `fable`, `sonnet`, `opus`, `haiku` (plus `best`, `default`, `opusplan`, `sonnet[1m]`, `opus[1m]`), full names look like `claude-sonnet-5`; overrides the `model` setting and `ANTHROPIC_MODEL` <!-- source: CC-CLI --> | `--effort` sets the level for the session; overrides the `modelSettings` and `effortLevel` settings and does not persist <!-- source: CC-CLI --> | `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (nesting depth below the main conversation, default 3; `1` turns nesting off) and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (simultaneous subagents, default 20) — both env vars, settable under settings.json's `env` <!-- source: CC-SUBAGENT-ENV --> |
| Codex | `codex exec -m <model>`, or `-c model=<id>` as a config override <!-- source: CODEX-CONFIG --> | `-c model_reasoning_effort=<level>` — the config key the docs demonstrate as `"high"` and do not enumerate, so read the level names off the model's own documentation before promising one <!-- source: CODEX-CONFIG --> | `agents.max_concurrent_threads_per_session` in config.toml caps concurrently open spawned-agent threads, excluding the primary; unset means Codex picks the default <!-- source: CODEX-AGENTS-MULTI --> <!-- source: CODEX-CONFIG --> |


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

## The hooks (optional, offered in Round C)

One command handles every event: `vegafactory hook <event> --harness claude|codex`. It reads the hook payload on stdin (at most 64 KiB, waited for 350 ms) and finds the issue from the worktree folder (`.vegastack/.worktrees/<n>-…`) or the branch (`<type>/<n>-…`). Outside an issue only the ship guard runs.

| Harness event | `hook` event | What it does |
|---|---|---|
| `SessionStart` | `session-start` | Adds context: the issue, its state, who holds it and where its local copy lives. |
| `UserPromptSubmit` | `prompt` | Adds a warning with the take-back command when another session holds the issue. |
| `PreToolUse` | `pre-tool` | The ship guard; after the claim is taken back, denies file and shell tools and saves uncommitted work once as a `wip:` commit on the issue branch, pushed normally (a rejected push keeps the commit local and says so). |
| `PostToolUse`, `SubagentStop` | `post-tool` | The heartbeat: a local file on every call (`.vegastack/.tmp/claims/<n>.json`), a background `vegafactory issue heartbeat` at most every 5 minutes, one at a time, that writes a `vsk:claim` row on the holder's own claim comment. Background work is killed after 60 s and every `gh` call after 30 s. Only claims and releases from people with write access count. |
| `Stop` | `stop` | Commits a dirty worktree as `wip: #<n> turn checkpoint` and pushes the branch in the background, never forced; a rejected push keeps the commit local and is reported on the next prompt or stop. Staged files that look like secrets stop the commit and are named. |
| `SessionEnd` | `session-end` | A last heartbeat; the claim is kept because the session may resume. |

Only `pre-tool` can deny; every other event exits 0 and prints nothing on any error. Ownership is checked against the local file on each call and refreshed from GitHub (an ETag sync) at most once a minute; a failed refresh never blocks a tool. The wiring shape is doubly nested — matcher groups each holding their own `hooks` array — in Claude Code's `.claude/settings.json` and Codex's `<repo>/.codex/hooks.json` alike (merge into existing hook config, never overwrite; remove entries that still point at the old `.vegastack/hooks/` files): <!-- source: CC-HOOKS --> <!-- source: CODEX-HOOKS -->

```json
{ "hooks": {
  "SessionStart": [ { "hooks": [ { "type": "command", "command": "vegafactory hook session-start --harness claude", "timeout": 30 } ] } ],
  "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "vegafactory hook prompt --harness claude", "timeout": 30 } ] } ],
  "PreToolUse": [ { "hooks": [ { "type": "command", "command": "vegafactory hook pre-tool --harness claude", "timeout": 60 } ] } ],
  "PostToolUse": [ { "hooks": [ { "type": "command", "command": "vegafactory hook post-tool --harness claude", "timeout": 10 } ] } ],
  "SubagentStop": [ { "hooks": [ { "type": "command", "command": "vegafactory hook post-tool --harness claude", "timeout": 10 } ] } ],
  "Stop": [ { "hooks": [ { "type": "command", "command": "vegafactory hook stop --harness claude", "timeout": 30 } ] } ],
  "SessionEnd": [ { "hooks": [ { "type": "command", "command": "vegafactory hook session-end --harness claude", "timeout": 3 } ] } ]
} }
```

The Codex file is the same with `--harness codex`. `PreToolUse` has no matcher on either harness: the guard needs the shell tool and the ownership check needs the file tools too. `SessionEnd` keeps a 3 s timeout, the most Codex allows; the hook only writes a local file and starts a background heartbeat.

Codex parses `permissionDecision: "ask"` but does not support it, so the guard sends Codex `permissionDecision: "deny"` with the reason; a Codex operator answers by running the command themselves. <!-- source: CODEX-HOOKS -->

Project-local Codex hooks load only once the repo's `.codex/` layer is trusted, and a worktree is a separate path that needs its own trust — dev-setup says so before it offers the wiring. <!-- source: CODEX-CONFIG -->

The ship guard's policy is a fixed always-ask list plus the commands named in backticks on the `ask:` lines of the `## Ship` section of `.vegastack/dev.md`, read from the default branch as committed, so a task cannot loosen it by editing its own copy. The always-ask list covers anything that publishes, merges or pushes to the default branch, creates or pushes tags, rewrites or deletes shared history or refs, removes branches or worktrees by force, skips or moves the commit checks, changes GitHub state beyond opening a pull request or an issue, records "ship it", or takes back a claim. The one exception is `gh pr merge` for an issue with a valid "ship it" newer than its latest evidence. A command the guard cannot read with certainty — built by shell expansion, hidden behind an alias, wrapper or unusual option, or sent in an unreadable payload — asks rather than passes. The exact rules and their tests live in the CLI (`packages/cli/src/guard-rules.ts`); `vegafactory issue comment`, `edit-comment` and `body` refuse text whose top marker is `type=ack`, `type=claim` or `type=release`, which only the dedicated verbs write. An oversized payload from a file tool still gets the ownership check.

What the guard is not: same-user hooks are cooperative. The hook runs as the same user as the agent, with the same `gh` login, so a task that goes around the shell tool — a script that calls the GitHub API itself, a copied token, an edited hook config — can still post an ack or merge, and the guard cannot hide its policy from that user. The guard closes the obvious self-authorisation paths and refuses what it cannot read; branch protection (required reviews on the default branch) and a read-only App token for agents are the wall.

The prose instruction in the AGENTS.md dev section is the portable base on both harnesses; these hooks are deterministic checks on top, not a replacement.

## Cross-tool review invocations

Verified 17-09-2026 against `codex exec --help`, `codex exec resume --help` and `claude --help` on this machine (codex-cli 0.153.4, Claude Code 2.1.263) — the flags `vegafactory review` passes:

- Codex: `codex exec -s read-only --output-schema <file> -o <file> -` — `--output-schema` takes a **file path** holding the JSON Schema, `-o/--output-last-message` writes the final message to a file, and a trailing `-` reads the prompt from stdin. `-c model=<id>` and `-c model_reasoning_effort=<level>` set model and effort. <!-- source: CODEX-EXEC -->
- Codex resume: `codex exec resume [OPTIONS] <session-id> -` keeps the session's memory; it has **no `--sandbox`/`-s` flag**, so read-only comes from `-c sandbox_mode=read-only`. It accepts `--output-schema` and `-o` like `exec`. <!-- source: CODEX-EXEC -->
- Codex also ships `codex exec review [--base <branch>|--commit <sha>|--uncommitted]`, its own review mode with `--output-schema`; VegaFactory does not use it, because the packet and the finding schema are ours and `exec` takes both directly. <!-- source: CODEX-EXEC -->
- Claude Code: `claude -p --tools Read,Grep,Glob --output-format json --json-schema <inline JSON>` — `--json-schema` takes the schema **inline as a string**, not a path; `--tools` is variadic (a flag must follow it), the prompt goes on stdin, and the JSON result carries `session_id` plus `structured_output`. `--resume <session-id>` continues that session, `--model` and `--effort` set model and effort. <!-- source: CC-CLI -->
- Codex sets `CODEX_THREAD_ID` (and `CODEX_SANDBOX` inside its sandbox) for the commands it runs; Claude Code sets `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`. `vegafactory review` reads those to pick the other tool. Read off the shipped binaries on 17-09-2026, not from the published docs — pass `--reviewer` where a run cannot tell. <!-- source: CODEX-CONFIG --> <!-- source: CC-CLI -->

## Headless runs

What a dispatcher can rely on when it starts a run with no human at the keyboard.

- Hooks fire under `claude -p`: a headless Claude Code run gets the same hook events as an interactive one, which is what lets the ship guard bound a dark build. <!-- source: CC-HOOKS -->
- Codex refuses non-managed hooks in an unattended run unless the caller vets them: `codex exec --dangerously-bypass-hook-trust` runs the enabled hooks headless, and it is the only way a dispatched Codex run reaches the ship guard at all. <!-- source: CODEX-HOOKS -->
- Agent teams do not spawn under `-p`: a headless Claude Code run has subagents bounded by `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, and a run needing a team is a run that belongs in an interactive session. <!-- source: CC-SUBAGENT-ENV -->
- A headless run has no question tool at all, so `VSK_ASK_ROUTE=issue` is what the dispatcher sets: the round goes into the issue with its options and the recommendation, and the next run reads the answer there. <!-- source: CC-CLI -->

## What this means for the dev skills

- AGENTS.md is the shared instruction file; the one-line CLAUDE.md import makes it reach Claude Code. Keep the marked section small — it counts against Codex's 32 KiB budget along with everything else in AGENTS.md.
- Any skill that wants to ask the user degrades by `references/ask-route.md`: intake, plan and implement put the round in the issue and stop at `waiting-on-operator` (intake creates the issue first when the round comes before one exists); dev-setup, which can run before any issue exists, writes documented defaults marked `# TODO confirm` instead and says so.
- Observed 02-09-2026: the `claude_code` preset already carries the current model guidance on autonomy, delivering work, readability and parallel tool calls; Codex gets none of it. That is why the AGENTS.md conduct paragraph exists and why skill bodies never restate harness behaviour — a restated instruction competes with the harness's own wording.
- Tasks inside one issue run in order, and sibling sub-issues of an epic run one at a time for now; the plan's independent groups record which could run in parallel once the dispatcher (#218) does so.
- The OpenTelemetry stream is **optional and never required**: capture is deterministic without a collector — the dispatcher parses each harness's own run output, SessionEnd hooks cover interactive sessions, and skill invocations come from hook payloads. `OTEL_LOG_TOOL_DETAILS` stays off; it exports exactly the tool arguments a record must never hold.
- Every target harness spawns subagents (Claude Code's Task tool, Codex agents), so dev.md's `review:` knob means the same thing on each; only a headless run that cannot spawn falls back to a labeled self-review.


## Native-memory contract — 07-09-2026

Native memory is excluded only in VegaFactory-managed processes. Pinned metadata: Codex0.153.4 and Claude Code2.1.263. Unknown versions refuse managed execution pending qualification. Claude managed launch currently also refuses because version/help and a cached/raw settings cascade cannot establish effective managed-hook or memory applicability; no SDK dependency or CLI-session probe is implied. Codex overrides `memories.use_memories=false`, `memories.generate_memories=false`, disables memories/import and `features.context_management.experimental_mode`, and retains hooks/project trust for the exact checkout. The optional task-note/search facility is separate from ordinary project instructions. Claude uses `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and session `autoMemoryEnabled:false`, without bare/safe mode or disabling CLAUDE.md. No global setting or existing vendor store is changed/read. Controls are supported configuration, not runtime qualification: verify their actual pinned behavior before claiming support. Sources: [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [Codex context management](https://learn.chatgpt.com/docs/models), [Claude memory](https://code.claude.com/docs/en/memory). <!-- source: CODEX-CONFIG --> <!-- source: CC-MEMORY -->
