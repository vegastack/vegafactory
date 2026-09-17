---
name: dev-status
description: The operator's board and the project's story. Use when asked "status", "what needs me", "where are we", "what's in flight", "anything stale?", "what should I look at next", for a board overview of waiting-on-operator / planning / queued / in-progress / ready-to-ship issues, and equally for "catch me up on this project", "what did we build here", "tell me the story so far", or when a chronicle entry needs writing for finished work. Not for the consumer-facing changelog (dev-implement writes those per the changelog knob), release notes (dev-ship), implementing or reviewing anything, or repo bootstrap (dev-setup).
---

# dev-status

Act: answer whose move it is from the script's data, or tell the project's story from the chronicle — and label everything else as judgment.

Two questions, one skill, because they are asked in the same breath and answered from the same repo. **Board mode** answers "whose move is it now" from deterministic data. **Chronicle mode** answers "how did we get here" from `.vegastack/chronicle.md` and the decision register. An unverifiable board is reported as exactly that, because a rendered guess reads as a fact; a story is told only from what the file holds, because a reconstructed chapter is one nobody can trust.

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

`.vegastack/chronicle.md` is the project's story, newest first — the answer to "what did I build here and what happened?" months later, when the operator remembers nothing. Entries are **story language for a human**, because the changelog already tells consumers what changed. dev-implement writes them at hand-back (the write rule lives there; the format lives here) and dev-ship checks entry presence before the PR when dev.md says `chronicle: on`.

### The entry — one per behavior-changing branch

```markdown
## DD-MM-YYYY — <title: the change as a human outcome — not a mechanism, not a commit subject> ([#<issue>](<issue url>))

- **What:** <2–4 plain sentences: what exists now that didn't, from the operator's point of view>
- **Why:** <the need that prompted it>
- **How it went:** <the honest one-liner: smooth / what fought back / what was cut>
- **Changed:** <the user-visible changes, simple words — sub-bullets or one ·-separated line>
- **Decisions:** <register lines it produced, or "none">

— approved by (<username>) · built by <agent> · branch <name>
```

- Titles name the outcome ("Invoice reminders now chase late payers"), because the mechanism ("add reminderAt column") is the commit subject's job. Issue references are full markdown links to `…/issues/<n>` (correct for PRs too — GitHub redirects), because file views don't auto-link a bare `#N`.
- The fields are list items and the footer sits after a blank line — single newlines soft-wrap into one paragraph in rendered markdown; bullets are what guarantee a line per field.
- Prepend — newest first. File missing → create it with a two-line header naming this skill as the format home.
- **How it went** is where honesty lives: what fought back, what was cut, what surprised. "Smooth" is a fine answer; silence is not.
- Research issues get an entry only when the findings changed direction; docs/test-only merges get none (the evidence comment's `**Changelog:**` reason covers both records at once).
- A notable ship event — rollback, failed release — becomes its own short entry on the next branch. Entries are append-only like the register — a typo is the one edit — because a rewritten chapter is a story nobody can trust.
- An entry runs 80–200 words; the digest scales with the ask.

dev.md's `chronicle-style:` knob (`plain` default · `story` · `witty`) sets the voice and `emoji:` (`none` default · `sparing`) the emoji budget; the rule every style follows, the boundary of `witty`, and one worked example per style live in [styles](references/styles.md). In every style, domain keywords stay exact and every factual field says what it means, because the operator searches the chronicle for the terms they remember.

### The digest — "catch me up"

On "catch me up on this project" (or any story-so-far ask), read only the chronicle and the decision register, because the digest is the story as told, not reconstructed, and render three parts, plain language throughout:

1. **The story so far** — 3–5 sentences: what this project is, the arc of what's been built, where it stands.
2. **Recent chapters** — the last 3–7 entries, one line each: date, the outcome title, and the one thing worth remembering from How-it-went.
3. **Open threads** — pending decisions the register hasn't recorded, entries whose How-it-went named unfinished business, and a one-line pointer to the board above for what needs the operator now.

Length scales with the ask: "catch me up quickly" is one paragraph; a returning-after-months operator gets all three parts. A young project with three entries gets three honest lines, because padding is the mannered prose the style rule excludes.

The `chronicle:` knob in dev.md (`on` default | `off`) governs whether dev-implement writes entries and dev-ship checks them; `dev-setup` writes it alongside `chronicle-style:` and `emoji:`. A project that turns it on mid-life starts from now — no retroactive backfill unless the operator asks, and then it's marked as reconstructed.

## Honesty rules

**Board data comes only from the script** — ordering, the wait-reason one-liners and Next are the skill's judgment, labelled as judgment, because a judgment dressed as data is the one the operator cannot question; assignment and the operator resolution are data from the script, never inferred from who spoke last in the thread. A possibly-orphaned `in-progress` issue is a fact to surface, not an accusation — the ledger heartbeat went silent, which is likely but not certainly a dead session: "check, resume, or take back" is the operator's call (a take-back names their login, per dev-implement). **Story content comes only from the chronicle and the register** — an event neither file records is not in the digest. Standalone, the report is the closing recap; add one only when invoked inside a larger run.
