# Harness facts

Verified mechanics of the two harnesses this workflow targets — Claude Code and Codex — and the GitHub CLI floor. One fact per line: what is true, what to do about it, the version it became true, the date someone last read it against its link, and that link. Vendors move all of this, so re-verify any line older than 60 days against its link before leaning on it.

## Claude Code

- **Claude Code does not read AGENTS.md natively** · the documented pattern is a CLAUDE.md holding a line that reads `@AGENTS.md` · since — · checked 03-09-2026 · https://code.claude.com/docs/en/memory
- **CLAUDE.md imports are written `@path/to/file`** · the path resolves relative to the containing file, recursion stops after 4 hops, and an `@` inside backticks stays literal · since — · checked 03-09-2026 · https://code.claude.com/docs/en/memory
- **`CLAUDE.local.md` loads after CLAUDE.md and is meant to be gitignored** · it is the user's personal file, so leave it alone · since — · checked 03-09-2026 · https://code.claude.com/docs/en/memory
- **Project skills load from `.claude/skills/` by name** · each skill is its own folder with a SKILL.md inside, and personal skills come from `~/.claude/skills/` · since — · checked 03-09-2026 · https://code.claude.com/docs/en/skills
- **The structured question tool is AskUserQuestion** · it is unavailable in non-interactive runs started with `claude -p`, and a configurable timeout can auto-submit the pre-selected options · since — · checked 03-09-2026 · https://code.claude.com/docs/en/overview
- **Hooks live in settings files under a `hooks` key** · project-level wiring goes in `.claude/settings.json`, mapping event names to command entries · since — · checked 17-09-2026 · https://code.claude.com/docs/en/hooks
- **Hook wiring nests twice** · each event holds matcher groups and each group holds its own `hooks` array, on Claude Code and Codex alike · since — · checked 17-09-2026 · https://code.claude.com/docs/en/hooks
- **The `Stop` event fires when Claude finishes a turn** · its stdin JSON carries `session_id`, `stop_hook_active` and `last_assistant_message` · since — · checked 17-09-2026 · https://code.claude.com/docs/en/hooks
- **A hook keeps the agent going by blocking** · emit `{"decision": "block", "reason": "…"}` or exit 2 with the reason on stderr, and the reason is shown to the agent · since — · checked 17-09-2026 · https://code.claude.com/docs/en/hooks
- **A Stop hook working as designed sends `hookSpecificOutput.additionalContext` instead** · it keeps the conversation going through the same loop protections, the `stop_hook_active` input and the 8-consecutive-continuation cap, but the transcript labels it Stop hook feedback and no hook error notification is shown · since — · checked 17-09-2026 · https://code.claude.com/docs/en/hooks
- **`SessionEnd` cannot block** · never put a gate on that event · since — · checked 17-09-2026 · https://code.claude.com/docs/en/hooks
- **`SubagentStop` is a separate event from `Stop`** · wire it separately when subagent turns matter · since — · checked 17-09-2026 · https://code.claude.com/docs/en/hooks
- **`SessionStart` and `UserPromptSubmit` add context** · answer with `hookSpecificOutput` carrying `hookEventName` and `additionalContext` · since — · checked 17-09-2026 · https://code.claude.com/docs/en/hooks
- **`PreToolUse` answers with `hookSpecificOutput.permissionDecision`** · the values are `allow`, `deny`, `ask` and `defer`, each paired with a `permissionDecisionReason` · since — · checked 17-09-2026 · https://code.claude.com/docs/en/hooks
- **Claude Code's file tools are `Write`, `Edit`, `MultiEdit` and `NotebookEdit`** · the shell tool is `Bash`, and a hook matcher names these · since — · checked 17-09-2026 · https://code.claude.com/docs/en/hooks
- **Command hooks time out after 600 s by default** · `UserPromptSubmit` hooks get 30 s, and `SessionEnd` hooks share a 1.5 s budget unless a hook sets a longer `timeout` · since — · checked 17-09-2026 · https://code.claude.com/docs/en/hooks
- **`CLAUDE_PROJECT_DIR` does not follow the worktree** · it still points at the project root where the session started, so a hook that needs the worktree reads the hook input's `cwd` instead · since — · checked 03-09-2026 · https://code.claude.com/docs/en/hooks
- **A hook input's `cwd` is the worktree root** · it moves again when Claude runs a directory change, so read it on every call rather than caching it · since — · checked 03-09-2026 · https://code.claude.com/docs/en/hooks
- **A permission approval granted in a worktree is saved to the main checkout** · it lands in the main checkout's `.claude/settings.local.json`, so it applies in the main checkout and in every other worktree of the repository, and it survives the worktree's removal · since — · checked 03-09-2026 · https://code.claude.com/docs/en/hooks
- **The main-checkout approval rule has exceptions** · on Windows and in the other cases where Claude Code does not use the repository root, the approval stays with that worktree · since — · checked 03-09-2026 · https://code.claude.com/docs/en/hooks
- **Non-interactive runs do not clean up their worktrees** · a `-p` run has no exit prompt, so cleanup belongs to whatever created the worktree · since — · checked 03-09-2026 · https://code.claude.com/docs/en/hooks
- **Claude Code refuses to create a worktree behind a symlink** · it stops when `.claude`, `.claude/worktrees` or the worktree directory is a symlink · since — · checked 03-09-2026 · https://code.claude.com/docs/en/hooks
- **A workflow script in `.claude/workflows/` resolves by name from the `Workflow` tool** · put the script there and call it by its name · since 2.1.247 · checked 03-09-2026 · https://code.claude.com/docs/en/overview
- **A workflow script must open with a pure-literal `export const meta`** · it carries `name`, `description` and `phases` and no computed values · since 2.1.247 · checked 03-09-2026 · https://code.claude.com/docs/en/overview
- **A workflow script has no filesystem or Node API access** · `Date.now()`, `new Date()` and `Math.random()` throw inside one · since 2.1.247 · checked 03-09-2026 · https://code.claude.com/docs/en/overview
- **Concurrent `agent()` calls in a workflow are capped** · the cap is `min(16, cpus - 2)`, so size a fan-out against the machine · since 2.1.247 · checked 03-09-2026 · https://code.claude.com/docs/en/overview
- **One `pipeline()` or `parallel()` call takes at most 4096 items** · chunk anything larger · since 2.1.247 · checked 03-09-2026 · https://code.claude.com/docs/en/overview
- **A workflow run's lifetime agent count is capped at 1000** · a long sweep splits across runs · since 2.1.247 · checked 03-09-2026 · https://code.claude.com/docs/en/overview
- **Worktree isolation gives an agent its own worktree** · ask for `isolation` as `"worktree"` and the call returns the worktree's path and branch · since 2.1.247 · checked 03-09-2026 · https://code.claude.com/docs/en/sub-agents
- **An agent's worktree is auto-cleaned only when the agent changed nothing** · anything else is left for the caller to remove · since 2.1.247 · checked 03-09-2026 · https://code.claude.com/docs/en/sub-agents
- **`worktree.baseRef` is `fresh` or `head`** · `fresh` is the default and branches from the default branch on the origin, `head` branches from local HEAD, and a run that must branch from a specific commit tells the agent the sha instead of relying on the setting · since 2.1.247 · checked 03-09-2026 · https://code.claude.com/docs/en/sub-agents
- **Claude Code exports OpenTelemetry metrics and log events** · a collector is optional and nothing in this workflow requires one · since — · checked 03-09-2026 · https://code.claude.com/docs/en/monitoring-usage
- **`claude_code.skill_activated` is logged whenever a skill is invoked** · it fires whether Claude calls the skill through the Skill tool or the user runs it as a slash command, and it carries `invocation_trigger` as `"user-slash"`, `"claude-proactive"` or `"nested-skill"` · since — · checked 03-09-2026 · https://code.claude.com/docs/en/monitoring-usage
- **`skill.name` reads `"custom_skill"` for user-defined and plugin skills** · only `OTEL_LOG_TOOL_DETAILS=1` puts the real name in the event · since — · checked 03-09-2026 · https://code.claude.com/docs/en/monitoring-usage
- **`OTEL_LOG_TOOL_DETAILS=1` exports tool arguments** · it adds Bash commands, MCP server and tool names, skill names and tool input; it is off by default and this workflow never turns it on · since — · checked 03-09-2026 · https://code.claude.com/docs/en/monitoring-usage
- **The Agent SDK's `claude_code` preset is Claude Code's own system prompt** · select it as a preset system prompt named `claude_code`, and anything that prompt already says reaches every Claude Code session without a skill repeating it · since — · checked 03-09-2026 · https://code.claude.com/docs/en/overview

## Codex

- **Codex reads AGENTS.md natively** · it starts at `~/.codex/`, where `AGENTS.override.md` wins over `AGENTS.md` · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs/config-file/config-reference
- **Codex layers AGENTS.md by directory** · one file per directory from the repo root down to the working directory, concatenated root-first so closer files override · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs/config-file/config-reference
- **Combined AGENTS.md size is capped by `project_doc_max_bytes`** · the default is 32 KiB across everything the layering pulls in · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs/config-file/config-reference
- **Codex has no `@file` import mechanism** · layering is directory-based only, so shared text must sit in a directory Codex already reads · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs/config-file/config-reference
- **Codex skills load from `.agents/skills/`** · every directory from the working directory up to the repo root is read, plus `~/.agents/skills/` for the user · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs
- **Codex skill frontmatter requires only `name` and `description`** · an optional `agents/openai.yaml` adds display metadata and invocation policy · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs
- **The structured question tool is `request_user_input`** · it is collaboration-mode-gated, available in Plan mode, failing fast with a clear error elsewhere, and unavailable to subagents · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs
- **There is no shipped ask_user_question or clarify tool on Codex** · community posts describe a proposal, not a shipped tool, so do not design against it · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs
- **Non-interactive mode is `codex exec`** · it runs fully unattended with human-input tools unavailable and AGENTS.md discovery unchanged · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs
- **Codex hooks are stable** · they live in `~/.codex/hooks.json` or the repo's `.codex/hooks.json`, and inline `[hooks]` tables in config.toml also work · since — · checked 17-09-2026 · https://learn.chatgpt.com/docs
- **Codex hook events cover the whole session** · `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Stop`, and now `Interrupt` · since — · checked 17-09-2026 · https://learn.chatgpt.com/docs
- **Codex uses the same stdin-JSON hook contract as Claude Code** · a `decision` of `block` with a `reason`, or exit 2, blocks; `Stop` carries `stop_hook_active` and `last_assistant_message`; `SubagentStop` is separate · since — · checked 17-09-2026 · https://learn.chatgpt.com/docs
- **Codex parses `permissionDecision` as `ask` but does not support it** · a hook that needs a human answer denies instead, sending `permissionDecision` as `deny` with a reason, and the legacy block decision also works · since — · checked 17-09-2026 · https://learn.chatgpt.com/docs
- **Every Codex hook payload carries `session_id`, `cwd`, `hook_event_name`, `model` and `permission_mode`** · tool events add `tool_name`, which is `Bash`, `apply_patch` or an MCP name, and `tool_input` · since — · checked 17-09-2026 · https://learn.chatgpt.com/docs
- **`SessionStart` and `UserPromptSubmit` add developer context on Codex** · plain stdout and `additionalContext` both work · since — · checked 17-09-2026 · https://learn.chatgpt.com/docs
- **A Codex `Stop` hook must print JSON or nothing** · `additionalContext` is not among its documented fields · since — · checked 17-09-2026 · https://learn.chatgpt.com/docs
- **Blocking on Codex `Stop` does not reject the turn** · it tells Codex to continue and automatically creates a new continuation prompt that acts as a new user prompt, using the reason as that prompt text · since — · checked 17-09-2026 · https://learn.chatgpt.com/docs
- **`PostToolUse` on Codex ignores plain stdout** · answer with JSON wherever the hook has something to say · since — · checked 17-09-2026 · https://learn.chatgpt.com/docs
- **Codex hooks time out after 600 s by default** · `SessionEnd` defaults to 1 s and allows up to 3 s · since — · checked 17-09-2026 · https://learn.chatgpt.com/docs
- **Non-managed Codex hooks run only once the user trusts their exact definition** · project-local hooks also need the repo's `.codex/` layer trusted · since — · checked 17-09-2026 · https://learn.chatgpt.com/docs
- **A bypass flag runs enabled Codex hooks headless** · pass `--dangerously-bypass-hook-trust` to `codex exec` for automation that vets its own hook sources · since — · checked 17-09-2026 · https://learn.chatgpt.com/docs
- **Codex project trust is per-path in `~/.codex/config.toml`** · a `[projects]` table keyed by the absolute path carries `trust_level` set to `trusted` · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs/config-file/config-reference
- **An untrusted project skips every project-scoped `.codex/` layer** · project-local config, hooks and rules are all skipped, while user- and system-level config keep working · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs/config-file/config-reference
- **A new worktree is a new path for Codex trust** · it needs its own project entry before any run there can see the repo's `.codex/` layer · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs/config-file/config-reference
- **Codex multi-agent is stable** · the built-in agents are `default`, `worker` for implementation and `explorer` for read-only exploration · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs
- **Custom Codex agents are TOML files under `.codex/agents/`** · one file per agent name, and a custom name overrides a built-in of the same name · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs
- **`agents.max_concurrent_threads_per_session` caps parallel threads** · set it in config.toml; it counts concurrently open spawned-agent threads and excludes the primary, and leaving it unset means Codex picks the default · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs/config-file/config-reference
- **The Codex multi-agent tools are `spawn_agent`, `wait_agent`, `close_agent` and `list_agents`** · they open, await and close child threads inside one session · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs
- **`spawn_agent` has no cwd parameter** · a spawned agent shares the parent's cwd and its `workspace-write` writable root, so it cannot write to a sibling worktree · since 0.149.1 · checked 03-09-2026 · https://learn.chatgpt.com/docs
- **Per-child isolation on Codex is one process per worktree** · give each child its own `codex exec` run pointed at that worktree instead of spawning an agent · since 0.149.1 · checked 03-09-2026 · https://learn.chatgpt.com/docs
- **Codex OTel log export is off by default** · opt in with an `[otel]` table in config.toml whose `exporter` is `none`, `otlp-http` or `otlp-grpc`, and with `none` Codex records events but sends nothing · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs/config-file/config-reference
- **The Codex OTel stream names no skill-activation event** · it covers API requests, SSE and events, prompts, and tool approvals and results, which is why skill capture on Codex is a prompt-mention proxy — the skill's name after a dollar sign, recorded as one · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs/config-file/config-reference

## Model, effort, and concurrency controls

Which model and which reasoning effort a stage runs at is dev.md's `harness-policy:` knob; these are the flags each value turns into.

| Harness | Model control | Effort control | Concurrency cap | Checked |
|---|---|---|---|---|
| Claude Code | `--model` takes an alias or a full model name — aliases `fable`, `sonnet`, `opus`, `haiku` (plus `best`, `default`, `opusplan`, `sonnet[1m]`, `opus[1m]`), full names look like `claude-sonnet-5`; overrides the `model` setting and `ANTHROPIC_MODEL` https://code.claude.com/docs/en/cli-reference | `--effort` sets the level for the session; overrides the `modelSettings` and `effortLevel` settings and does not persist https://code.claude.com/docs/en/cli-reference | `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (nesting depth below the main conversation, default 3; `1` turns nesting off) and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (simultaneous subagents, default 20) — both env vars, settable under settings.json's `env` https://code.claude.com/docs/en/settings | 03-09-2026 |
| Codex | `codex exec` takes `-m` with the model name, or `-c` with a `model=` config override https://learn.chatgpt.com/docs/config-file/config-reference | `-c` with a `model_reasoning_effort=` override — the config key the docs demonstrate as `"high"` and do not enumerate, so read the level names off the model's own documentation before promising one https://learn.chatgpt.com/docs/config-file/config-reference | `agents.max_concurrent_threads_per_session` in config.toml caps concurrently open spawned-agent threads, excluding the primary; unset means Codex picks the default https://learn.chatgpt.com/docs/config-file/config-reference | 03-09-2026 |

- **Claude Code's effort levels are low, medium, high, xhigh and max** · they apply on Fable 5.1, Fable 5, Opus 5 and Sonnet 5, and high is the default on every model except Opus 4.7, whose default is xhigh · since — · checked 03-09-2026 · https://code.claude.com/docs/en/cli-reference
- **`ultracode` is a Claude Code setting on top of the effort level** · it starts the session at xhigh with dynamic workflows on and needs v2.1.203 or later · since 2.1.203 · checked 03-09-2026 · https://code.claude.com/docs/en/cli-reference
- **The local Claude Code build reads 2.1.247 and lists the five effort levels in its help** · read the levels off the machine rather than a remembered list · since 2.1.247 · checked 03-09-2026 · https://code.claude.com/docs/en/cli-reference

Model ids move, which is why dev.md's `harness-policy:` knob holds them and this file only dates them.

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

- **The skill-loading drill is still unanswered** · a 03-09-2026 attempt on codex-cli 0.149.1 failed with `refresh_token_invalidated` and `token_revoked` (401) before reaching the model although `codex login status` printed "Logged in using ChatGPT", the expired-session case dev.md's Environments section anticipates, so the verdict line stays unwritten rather than guessed and the drill is re-run after a fresh login · since 0.149.1 · checked 03-09-2026 · https://learn.chatgpt.com/docs

## GitHub CLI

- **gh 2.94.0 is the floor for native issue types, sub-issues and dependencies** · `gh issue create` and `gh issue edit` take `--type`, `--parent`, `--add-sub-issue` and `--blocked-by`, with add and remove forms on edit, so none of it needs the API · since 2.94.0 · checked 03-09-2026 · https://github.com/cli/cli/releases
- **GitHub Enterprise Server needs 3.17 for issue types and sub-issues** · relationships need 3.19; GitHub.com has all of it · since GHES 3.17 · checked 03-09-2026 · https://github.com/cli/cli/releases
- **gh 2.97.0 is the floor for name-based project field edits** · `gh project item-edit` and `gh project item-list` address project fields and single-select options by name through `--field` and `--value`; below that floor fields need their IDs · since 2.97.0 · checked 03-09-2026 · https://github.com/cli/cli/releases
- Below a floor, dev-setup names the missing feature in its report and dev-intake uses the `epic` label and the REST API instead; the floors live here and nowhere else because they move with every gh release.

## The hooks (optional, offered in Round C)

One command handles every event: `vegafactory hook`, taking the event name and the harness. It reads the hook payload on stdin (at most 64 KiB, waited for 350 ms) and finds the issue from the worktree folder (`.vegastack/.worktrees/<n>-…`) or the branch (`<type>/<n>-…`). Outside an issue only the ship guard runs.

| Harness event | `hook` event | What it does |
|---|---|---|
| `SessionStart` | `session-start` | Adds context: the issue, its state, who holds it, where its local copy lives, and the lessons waiting for a dev.md line. |
| `UserPromptSubmit` | `prompt` | Adds a warning with the take-back command when another session holds the issue. |
| `PreToolUse` | `pre-tool` | The ship guard; after the claim is taken back, denies file and shell tools and saves uncommitted work once as a `wip:` commit on the issue branch, pushed normally (a rejected push keeps the commit local and says so). |
| `PostToolUse`, `SubagentStop` | `post-tool` | The heartbeat: a local file on every call (`.vegastack/.tmp/claims/<n>.json`), a background `vegafactory issue heartbeat` at most every 5 minutes, one at a time, that writes a `vsk:claim` row on the holder's own claim comment. Background work is killed after 60 s and every `gh` call after 30 s. Only claims and releases from people with write access count. |
| `Stop` | `stop` | Commits a dirty worktree as `wip: #<n> turn checkpoint` and pushes the branch in the background, never forced; a rejected push keeps the commit local and is reported on the next prompt or stop. Staged files that look like secrets stop the commit and are named. Asks a working session once for the general lessons it taught. |
| `SessionEnd` | `session-end` | A last heartbeat; the claim is kept because the session may resume. |

The lessons request rides each harness's own Stop continuation — `hookSpecificOutput.additionalContext` on Claude Code, a block decision with the reason on Codex — so it arrives as the turn's next instruction. It goes out at most once per session id and only to a session seen to do work, on one of two kinds of evidence: its own turn checkpoint made the commit, or a commit landed during one of its own shell tool calls whose command could have made it, with no other such call running that could have made it instead. Only a shell tool opens a window, and only a command the guard's parser reads as able to commit counts — a `sleep` is neither claimant nor rival, and a command the parser cannot see through is taken as able, so it contends rather than concede the credit. Each commit is ruled on once, by name, and two candidates over one commit credit nobody. A worktree's HEAD is shared, so a HEAD that merely moved proves nothing and buys nothing — a session that only talked, only read, or only edited files is never asked on that account, and unclear evidence leaves a session unasked rather than credited with a neighbour's commit. Each session's HEAD, work and answered state are kept per session id under a lock, and no event writes another session's mark. Each request names a scratch file in a folder of its own, created for that one request and refused if the name is already taken or is a link; the session writes its lessons there and records them with `learning add`, which reads that file and then removes the folder. Lesson text never travels on a command line, so a backtick or a dollar sign in a lesson stays text. A session with nothing to add runs nothing. The queue is `.vegastack/.tmp/learnings.md` at the repository root — git-ignored, so it never leaves the machine — and every read and write of it checks each path component before taking the lock, refuses any of them reached through a symbolic link, and replaces the queue through a random, exclusively created temporary name — as every file this hook writes now is, which is what keeps a settlement from ever rewriting the file a link points at. The next SessionStart lists what is waiting and the agent proposes each as one dev.md line, folded into an existing line where it fits, which lands only on the operator's explicit yes. `vegafactory learning` never edits dev.md itself, and it covers this repository's dev.md only — org and group control-room lines stay manual.

Only `pre-tool` can deny; every other event exits 0 and prints nothing on any error. Ownership is checked against the local file on each call and refreshed from GitHub (an ETag sync) at most once a minute; a failed refresh never blocks a tool. The wiring shape is doubly nested — matcher groups each holding their own `hooks` array — in Claude Code's `.claude/settings.json` and Codex's `<repo>/.codex/hooks.json` alike (merge into existing hook config, never overwrite; remove entries that still point at the old `.vegastack/hooks/` files):

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

The Codex file is the same with the Codex harness named instead. `PreToolUse` has no matcher on either harness: the guard needs the shell tool and the ownership check needs the file tools too. `SessionEnd` keeps a 3 s timeout, the most Codex allows; the hook only writes a local file and starts a background heartbeat.

Codex parses an ask permission decision but does not support it, so the guard sends Codex a deny with the reason; a Codex operator answers by running the command themselves.

Project-local Codex hooks load only once the repo's `.codex/` layer is trusted, and a worktree is a separate path that needs its own trust — dev-setup says so before it offers the wiring.

The ship guard's policy is a fixed always-ask list plus the commands named in backticks on the `ask:` lines of the `## Ship` section of `.vegastack/dev.md`, read from the default branch as committed, so a task cannot loosen it by editing its own copy. The always-ask list covers anything that publishes, merges or pushes to the default branch, creates or pushes tags, rewrites or deletes shared history or refs, removes branches or worktrees by force, skips or moves the commit checks, changes GitHub state beyond opening or editing a pull request or an issue and creating or editing labels, records "ship it", or takes back a claim. The one exception is `gh pr merge` for an issue with a valid "ship it" newer than its latest evidence. A command the guard cannot read with certainty — built by shell expansion, hidden behind an alias, wrapper or unusual option, or sent in an unreadable payload — asks rather than passes. The exact rules and their tests live in the CLI (`packages/cli/src/guard-rules.ts`); `vegafactory issue comment`, `edit-comment` and `body` refuse text whose top marker is `type=ack`, `type=claim` or `type=release`, which only the dedicated verbs write. An oversized payload from a file tool still gets the ownership check.

What the guard is not: same-user hooks are cooperative. The hook runs as the same user as the agent, with the same `gh` login, so a task that goes around the shell tool — a script that calls the GitHub API itself, a copied token, an edited hook config — can still post an ack or merge, and the guard cannot hide its policy from that user. The guard closes the obvious self-authorisation paths and refuses what it cannot read; branch protection (required reviews on the default branch) and a read-only App token for agents are the wall.

The prose instruction in the AGENTS.md dev section is the portable base on both harnesses; these hooks are deterministic checks on top, not a replacement.

## Headless runs

What a dispatcher can rely on when it starts a run with no human at the keyboard.

- **Hooks fire under `claude -p`** · a headless Claude Code run gets the same hook events as an interactive one, which is what lets the ship guard bound a dark build · since — · checked 03-09-2026 · https://code.claude.com/docs/en/hooks
- **Codex refuses non-managed hooks in an unattended run unless the caller vets them** · the bypass flag on `codex exec` runs the enabled hooks headless, and it is the only way a dispatched Codex run reaches the ship guard at all · since — · checked 03-09-2026 · https://learn.chatgpt.com/docs
- **Agent teams do not spawn under `-p`** · a headless Claude Code run has subagents bounded by `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, and a run needing a team belongs in an interactive session · since — · checked 03-09-2026 · https://code.claude.com/docs/en/settings
- **A headless run has no question tool at all** · the dispatcher sets `VSK_ASK_ROUTE=issue`, the round goes into the issue with its options and the recommendation, and the next run reads the answer there · since — · checked 03-09-2026 · https://code.claude.com/docs/en/cli-reference

## What this means for the dev skills

- AGENTS.md is the shared instruction file; the one-line CLAUDE.md import makes it reach Claude Code. Keep the marked section small — it counts against Codex's 32 KiB budget along with everything else in AGENTS.md.
- Any skill that wants to ask the user degrades by `references/ask-route.md`: intake, plan and implement put the round in the issue and stop at `waiting-on-operator` (intake creates the issue first when the round comes before one exists); dev-setup, which can run before any issue exists, writes documented defaults marked `# TODO confirm` instead and says so.
- Observed 02-09-2026: the `claude_code` preset already carries the current model guidance on autonomy, delivering work, readability and parallel tool calls; Codex gets none of it. That is why the AGENTS.md conduct paragraph exists and why skill bodies never restate harness behaviour — a restated instruction competes with the harness's own wording.
- Tasks inside one issue run in order, and sibling sub-issues of an epic run one at a time for now; the plan's independent groups record which could run in parallel once the dispatcher (#218) does so.
- The OpenTelemetry stream is **optional and never required**: capture is deterministic without a collector — the dispatcher parses each harness's own run output, SessionEnd hooks cover interactive sessions, and skill invocations come from hook payloads. `OTEL_LOG_TOOL_DETAILS` stays off; it exports exactly the tool arguments a record must never hold.
- Every target harness spawns subagents (Claude Code's Task tool, Codex agents), so dev.md's `review:` knob means the same thing on each; only a headless run that cannot spawn falls back to a labeled self-review.

## Native-memory contract

- **Native memory is excluded only in VegaFactory-managed processes** · nothing outside a managed launch is touched · since — · checked 07-09-2026 · https://code.claude.com/docs/en/memory
- **Managed execution pins Codex 0.153.4 and Claude Code 2.1.263** · an unknown version refuses managed execution pending qualification · since — · checked 07-09-2026 · https://learn.chatgpt.com/docs/config-file/config-reference
- **Claude managed launch currently refuses** · version and help output plus a cached or raw settings cascade cannot establish effective managed-hook or memory applicability, and no SDK dependency or CLI-session probe is implied · since — · checked 07-09-2026 · https://code.claude.com/docs/en/memory
- **Codex managed launch overrides the memory settings** · it sets `memories.use_memories` and `memories.generate_memories` to false, disables memories and import and `features.context_management.experimental_mode`, and retains hooks and project trust for the exact checkout · since — · checked 07-09-2026 · https://learn.chatgpt.com/docs/config-file/config-reference
- **The optional task-note and search facility is separate from ordinary project instructions** · do not read one as the other · since — · checked 07-09-2026 · https://learn.chatgpt.com/docs/models
- **Claude managed launch sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`** · the session also carries `autoMemoryEnabled` as false, without bare or safe mode and without disabling CLAUDE.md · since — · checked 07-09-2026 · https://code.claude.com/docs/en/memory
- **No global setting or existing vendor store is changed or read** · a managed run leaves the user's own memory store alone · since — · checked 07-09-2026 · https://code.claude.com/docs/en/memory
- **These controls are supported configuration, not runtime qualification** · verify their actual pinned behavior before claiming support · since — · checked 07-09-2026 · https://learn.chatgpt.com/docs/config-file/config-reference
