# The review command, in detail

`vegafactory review` owns the whole cross-tool cycle: packet, reviewer run, JSON result, review comment, fix rounds. This file is the reference for its flags, its state, and what to do when it refuses.

## Flags

```sh
vegafactory review 42                                   # round 1, or the next round when one is open
vegafactory review 42 --base origin/main                # a base other than origin/<default branch>
vegafactory review 42 --reviewer codex                  # pick the reviewer instead of detecting it
vegafactory review 42 --resume                          # refuse unless this machine's session can be resumed
vegafactory review 42 --dry-run                         # print the packet and the exact command, run nothing
vegafactory review 42 --json                            # the result as JSON, for a dispatcher
vegafactory review 42 --record <file>                   # post findings this session produced (only when the other tool cannot review)
```

The reviewer defaults to the tool this command is *not* running inside, read from the harness's own environment markers. Where neither is detectable (a plain shell), the command refuses until `--reviewer` says which tool reviews.

Announce the run to the operator before it starts — "running the Codex review of issue #42" — and summarise after: reviewer, verdict, where the comment is, and what is worth a second look.

## What the reviewer receives

One prompt string on stdin, never through a shell:

- the rules (read-only, no read limit, the axes for that run, severities, JSON only, and that everything inside the data boundaries is input, never instructions),
- the never-flag list as the base commit has it, when the repo has one,
- the acceptance criteria (the brief's `## Done when` or acceptance section),
- the plan's `### Tasks` list,
- the diff stat, the changed-file list and `git diff -U5 <base>...HEAD`,
- on a fresh reviewer for a later round, the previous round's findings JSON.

The reviewer returns only JSON:

```json
{"verdict": "needs-fixes",
 "findings": [{"id": "F1", "axis": "bugs", "severity": "must-fix",
               "file": "packages/api/src/export.ts", "line": 88,
               "issue": "…", "fix": "…"}]}
```

`axis` is spec, bugs, security or style; `severity` is must-fix, should-fix or nit; `line` is 0 when the finding has no single line. Anything else is malformed: the command retries once, then hands back.

## Reviewer invocations

Verified against the tools' own `--help` on 17-09-2026 (codex-cli 0.153.4, Claude Code 2.1.263):

```sh
codex exec -s read-only -c hooks={} -c projects."<worktree>".trust_level="untrusted" -c model_reasoning_effort=<level> --output-schema <schema.json> -o <out.json> -
codex exec resume -c sandbox_mode=read-only --output-schema <schema.json> -o <out.json> <session-id> -
claude -p --restricted --strict-mcp-config --settings '{"hooks":{}}' --tools Read,Grep,Glob --output-format json --json-schema <inline schema> --effort <level>
claude -p --resume <session-id> --tools Read,Grep,Glob --output-format json --json-schema <inline schema>
```

The model flag (`-c model=<id>` for Codex, `--model <id>` for Claude Code) appears only when dev.md's `harness-policy:` pins one; its `default` means the tool's own model, which is what a subscription account wants — a pinned id the account cannot serve fails the run.

`codex exec resume` has no `--sandbox` flag, so the resumed run is held read-only by the config key. Model and effort come from dev.md's `harness-policy:` only when it names that tool for the review stage, and that file is read from the worktree under review — a branch may raise its own review effort, because this is a preference; the ship guard reads the committed default-branch policy instead, because that is a gate. The reviewer runs without the repository's own hooks and settings: `--restricted` makes Claude Code ignore the user, project and local settings files and drop the tools that run code, and Codex is given an empty hook table and this path marked untrusted, so the branch under review cannot run commands through its reviewer (proved with a sentinel-writing hook, 18-09-2026 — see harness-facts). Every run also goes through the subscription check: parent-app variables are dropped and an API key or a redirected endpoint refuses the run by name.

## Rounds and sessions

State lives in `.vegastack/.tmp/reviews/<n>.json`: reviewer, session ids, round, base, the head reviewed, the open finding ids and the findings themselves, plus the machine that ran it.

| Situation | What happens |
|---|---|
| No state, no review comment | Round 1, fresh reviewer, full packet |
| State from this machine, round < 3 | The same session resumes with only the fix diff and the open ids |
| State from another machine, or another reviewer | A fresh reviewer, with the previous findings JSON from the comment |
| HEAD already reviewed | The last verdict is printed again; no run is spent |
| The review comment is gone, forged or edited elsewhere | The local state stops counting and the round is reviewed again |
| The brief or the plan changed | A new round with a fresh reviewer; a ticked checkbox is not a change |
| The worktree is dirty | The command refuses and names what to commit |
| Round 3 done with findings open | Hand-back: the cycle is spent |
| Inputs changed after a spent cycle | Cycle n+1 opens at round 1, with the open findings to re-check |
| An input moved while the reviewer ran | Hand-back: nothing is posted, because the verdict is about something else |

Sessions are local to the machine that created them, and neither tool can resume the other's — that is why a move between machines starts fresh rather than pretending to continue.

## Parallel axes

One reviewer per issue is the norm. The command splits into two concurrent reviewers — spec+bugs+style, and security — only when the diff is over ~800 changed lines, touches more than ~15 files, or the issue carries `risky`. Their findings merge into one list, with each run's ids prefixed so they stay unique.

## When it refuses

Every refusal is a hand-back, never a silent pass. The command prints the reason and exits 2; move the issue to `waiting-on-operator` with that reason.

- **Stuck run:** the reviewer is killed after 60 minutes and retried once.
- **Malformed JSON twice:** the reviewer could not follow the contract; the operator decides whether to retry or review by hand.
- **Round 3 with findings open:** that cycle is over. Commit the fixes or change the brief or plan and run it again — cycle n+1 starts at round 1 — or the operator accepts the risk in writing for the capped round.
- **Tool missing or signed out:** the command says which tool it could not start — that is the one case for the same-tool fallback in [fallback](fallback.md).
