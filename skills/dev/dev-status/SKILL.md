---
name: dev-status
description: The operator's board and the project's story. Use when asked "status", "what needs me", "where are we", "what's in flight", "anything stale?", "what should I look at next", for a board overview of waiting-on-operator / planning / queued / in-progress / ready-to-ship issues, and equally for "catch me up on this project", "what did we build here", "tell me the story so far", or when a chronicle entry needs writing for finished work. Not for the consumer-facing changelog (dev-implement writes those per the changelog knob), release notes (dev-ship), implementing or reviewing anything, or repo bootstrap (dev-setup).
---

# dev-status

Act: answer whose move it is from the script's data, or tell the project's story from the chronicle — and label everything else as judgment.

Two questions, one skill, because they are asked in the same breath and answered from the same repo. **Board mode** answers "whose move is it now" from deterministic data. **Chronicle mode** answers "how did we get here" from `.vegastack/chronicle.md` and the decision register. An unverifiable board is reported as exactly that, because a rendered guess reads as a fact; a story is told only from what the file holds, because a reconstructed chapter is one nobody can trust.

## Routing

| Need | Read |
|---|---|
| the chronicle entry format and the digest | [chronicle](references/chronicle.md) |
| the voice each `chronicle-style:` asks for | [styles](references/styles.md) |

## Gather — board mode

```
node <path-to-this-skill>/scripts/status.mjs --orphan-hours 6 --json
node <path-to-this-skill>/scripts/status.mjs --orphan-hours 6 --all --json   # the whole team's board
```

Read-only; it returns the board (open issues per state label with age, scope, risky), task progress `x/y` from plan-comment checkboxes, ledger movement for `in-progress` issues in hours (`possiblyOrphaned` = the ledger and the claim comments have been silent past `--orphan-hours`, default 6, or has not been written yet — the claim's heartbeat has stopped), open PRs with check state, pending unrecorded `Decision:` proposals, and the last chronicle entry. It also returns who you are (`viewer`), the `operators:` list, each issue's `assignees` and its resolved `operator`, and two derived arrays — `needsYou` (the human-state issues assigned to you; every one of them under `--all`) and `unowned` (human-state issues nobody is assigned). Exit 2 = cannot verify (offline, unauthenticated) — report the gap plainly and stop, because a guessed board sends the operator to the wrong issue.

## Render — names, with numbers inside the links

```markdown
## Status — <repo> · DD-MM

Needs you (N):
- <linked title> — <state> <age>d: <one line: what it waits for and the word needed>
Unowned (N): - <linked title> — <state> <age>d, nobody assigned → assign <operator>
Waiting on plan (N): - <linked title> — planning <age>d
Ready to build (N): - <linked title> — <scope>
In flight (N): - <linked title> — in-progress, task <x>/<y>, ledger moved <n>h ago
Possibly orphaned (N): - <linked title> — in-progress <age>d, ledger silent <n>h → heartbeat stopped; check, resume, or take back (`vegafactory issue claim <n> --harness <h> --model <id> --take-back-by <login>`)
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
- **Next** is one line, chosen not computed-looking: the action that unblocks the most (a plan approval blocking several queued issues beats a lone review).
- **Possibly orphaned** is the ledger heartbeat gone silent past the orphan window (or not yet started) — likely a dead session, not certainly one. Surface it with the take-back command inline; the operator decides (check the session, hand it to a resume, or take the claim back). A long-running task whose hooks keep committing stays out of this section, because its heartbeat is alive.
- <linked title> means a markdown link this report builds around the issue/PR title and its URL; numbers ride inside the link, because a bare number means nothing in a terminal. That governs the references the board itself makes.
- **Control room** is a proposal, never an edit: dev.md hand edits outrank the org and group defaults, so a differing knob is shown with both values and the operator decides; no clone yet, or a sync that failed, is reported as "control room not synced — run `vegafactory sync`" rather than as agreement
- `<title-plain>` / `<gist-plain>` are the script's `titlePlain` / `gistPlain` fields — text quoted from elsewhere (a chronicle title, a decision gist) may arrive carrying markdown links, and raw bracket-and-parenthesis markup means nothing in a terminal, so it is quoted with the markup removed rather than relinked.

The board is one screen: one line per issue, one Next line.

## Chronicle mode — the project's story

`.vegastack/chronicle.md` is the project's story, newest first — the answer to "what did I build here and what happened?" months later, when the operator remembers nothing. Entries are **story language for a human**, because the changelog already tells consumers what changed. dev-implement writes them at hand-back; dev-ship checks entry presence before the PR when dev.md says `chronicle: on`; this skill owns the format and the digest.

The entry format, the "catch me up" digest's three parts, and the `chronicle:` / `chronicle-style:` / `emoji:` knobs live in [chronicle](references/chronicle.md); the voice each style asks for, with a worked example, lives in [styles](references/styles.md). Read the first before writing an entry or a digest, and the second when the style knob is anything but `plain`.

## Honesty rules

**Board data comes only from the script** — ordering, the wait-reason one-liners and Next are the skill's judgment, labelled as judgment, because a judgment dressed as data is the one the operator cannot question; assignment and the operator resolution are data from the script, never inferred from who spoke last in the thread. A possibly-orphaned `in-progress` issue is a fact to surface, not an accusation — the ledger heartbeat went silent, which is likely but not certainly a dead session: "check, resume, or take back" is the operator's call (a take-back names their login, per dev-implement). **Story content comes only from the chronicle and the register** — an event neither file records is not in the digest. Standalone, the report is the closing recap; add one only when invoked inside a larger run.
