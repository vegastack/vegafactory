---
name: dev-status
description: The operator's board — whose move is it, across every issue in the dev workflow. Use when asked "status", "what needs me", "where are we", "what's in flight", "anything stale?", "what should I look at next", or for a board overview of waiting-on-operator / planning / ready / working / ready-to-ship issues. Not for the project's history ("catch me up" is dev-chronicle), implementing or reviewing anything, or repo bootstrap (dev-setup).
---

# dev-status

Act: answer whose move it is from the script's data, and label everything else as judgment.

One question, answered from deterministic data: whose move is it? The bundled script gathers; this skill orders and narrates, and an unverifiable board is reported as exactly that, because a rendered guess reads as a fact.

Nearest neighbors: `dev-chronicle` answers "how did we get here"; this skill answers "what needs whom right now".

## Gather

```
node <path-to-this-skill>/scripts/status.mjs --orphan-hours 6 --json
node <path-to-this-skill>/scripts/status.mjs --orphan-hours 6 --all --json   # the whole team's board
```

Read-only; it returns the board (open issues per state label with age, scope, risky), task progress `x/y` from plan-comment checkboxes, ledger movement for `in-progress` issues in hours (`possiblyOrphaned` = the ledger has been silent past `--orphan-hours`, default 6, or has not been written yet — the claim's heartbeat has stopped), open PRs with check state, pending unrecorded `Decision:` proposals, and the last chronicle entry. It also returns who you are (`viewer`), the `operators:` list, each issue's `assignees` and its resolved `operator`, and two derived arrays — `needsYou` (the human-state issues assigned to you; every one of them under `--all`) and `unowned` (human-state issues nobody is assigned). Exit 2 = cannot verify (offline, unauthenticated) — report the gap plainly and stop, because a guessed board sends the operator to the wrong issue.

## Render — names, with numbers inside the links

```markdown
## Status — <repo> · DD-MM

Needs you (N):
- <linked title> — <state> <age>d: <one line: what it waits for and the word needed>
Unowned (N): - <linked title> — <state> <age>d, nobody assigned → assign <operator>
Waiting on plan (N): - <linked title> — planning <age>d
Ready to build (N): - <linked title> — <scope>
In flight (N): - <linked title> — working, task <x>/<y>, ledger moved <n>h ago
Possibly orphaned (N): - <linked title> — working <age>d, ledger silent <n>h → heartbeat stopped; check, resume, or reclaim (`reclaim.mjs --issue <n>`)
Open PRs (N): - <linked title> — checks <green|pending-or-red|no-checks>
Control room: <n> knob(s) moved since this profile was drafted (<sha7> → <sha7>): <knob> <repo value> → <control-room value> — propose the edit, never make it
Pending decisions (N): "<gist-plain>" (<linked issue>) — records at that issue's merge
Last chronicle chapter: <date> — <title-plain>
Next: <the single most valuable operator action, and why>
```

- **Needs you** first (the script's `needsYou`, oldest first) — it's your queue by assignment, not by guesswork; everything else is context. `--all` widens it to every human-state issue and is what a second operator asks for.
- **Unowned** is a human-state issue with no assignee — a flip that lost its assignment or an issue filed outside the workflow. Name the `operator` the script resolved and the one-line `gh issue edit <n> --add-assignee <operator>` that fixes it; the assignment is the operator's to make.
- Sections with zero entries are omitted, not rendered empty. A completely quiet board is one line: "Nothing needs you — <n> issues ready for agents, nothing in flight."
- `risky` issues get their flag shown inline wherever they appear.
- **Next** is one line, chosen not computed-looking: the action that unblocks the most (a plan approval blocking several ready issues beats a lone review).
- **Possibly orphaned** is the ledger heartbeat gone silent past the orphan window (or not yet started) — likely a dead session, not certainly one. Surface it with the `reclaim.mjs` command inline; the operator decides (check the session, hand it to a resume, or release the claim). A long-running task that keeps checkpointing stays out of this section, because its heartbeat is alive.
- <linked title> means a markdown link this report builds around the issue/PR title and its URL; numbers ride inside the link, because a bare number means nothing in a terminal. That governs the references the board itself makes.
- **Control room** is a proposal, never an edit: dev.md hand edits outrank the org and group defaults, so a differing knob is shown with both values and the operator decides; no clone yet, or a sync that failed, is reported as "control room not synced — run `vegafactory sync`" rather than as agreement
- `<title-plain>` / `<gist-plain>` are the script's `titlePlain` / `gistPlain` fields — text quoted from elsewhere (a chronicle title, a decision gist) may arrive carrying markdown links, and raw bracket-and-parenthesis markup means nothing in a terminal, so it is quoted with the markup removed rather than relinked.

The board is one screen: one line per issue, one Next line.

## Honesty rules

**Data comes only from the script** — ordering, the wait-reason one-liners and Next are the skill's judgment, labelled as judgment, because a judgment dressed as data is the one the operator cannot question; assignment and the operator resolution are data from the script, never inferred from who spoke last in the thread. A possibly-orphaned `in-progress` issue is a fact to surface, not an accusation — the ledger heartbeat went silent, which is likely but not certainly a dead session: "check, resume, or reclaim" is the operator's call (a takeover still needs their explicit handover, and `reclaim.mjs` is theirs to run, per dev-implement). Standalone, the report is the closing recap; add one only when invoked inside a larger run.
