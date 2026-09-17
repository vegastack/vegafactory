---
name: dev-chronicle
description: The project's narrative record — what got built, why, and how it went, in plain language for the operator's future recall. Use when asked to "catch me up on this project", "what did we build here", "what happened in this repo", "tell me the story so far", "what's the project story", when a chronicle entry needs writing for finished work, or when dev-implement's hand-back cites the chronicle format. Not for the consumer-facing changelog (dev-implement writes those per the changelog knob), release notes (dev-ship), or current board state ("what needs me" is dev-status).
---

# dev-chronicle

Act: write the project's story for the operator who returns months later — exact terms, plain language, one honest line on how it went.

`.vegastack/chronicle.md` is the project's story, newest first — the answer to "what did I build here and what happened?" months later, when the operator remembers nothing. Entries are **story language for a human**, because the changelog already tells consumers what changed and the chronicle is for the operator who wants to know what happened.

Nearest neighbors: `dev-implement` writes the entries at hand-back (the write rule lives there; the format lives here); `dev-status` answers "what needs me now" — this skill answers "how did we get here". `dev-ship` checks entry presence before the PR when dev.md says `chronicle: on`.

## The entry — one per behavior-changing branch

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

## Style — tone, not length

dev.md's `chronicle-style:` knob (`plain` default · `story` · `witty`) sets the voice and `emoji:` (`none` default · `sparing`) the emoji budget; the rule every style follows, the boundary of `witty`, and one worked example per style live in [styles](references/styles.md). In every style, domain keywords stay exact and every factual field says what it means, because the operator searches the chronicle for the terms they remember.

## The digest — "catch me up"

On "catch me up on this project" (or any story-so-far ask), read only the chronicle and the decision register, because the digest is the story as told, not reconstructed, and render three parts, plain language throughout:

1. **The story so far** — 3–5 sentences: what this project is, the arc of what's been built, where it stands.
2. **Recent chapters** — the last 3–7 entries, one line each: date, the outcome title, and the one thing worth remembering from How-it-went.
3. **Open threads** — pending decisions the register hasn't recorded, entries whose How-it-went named unfinished business, and (when `dev-status` is installed) a one-line pointer to run it for the live board.

Length scales with the ask: "catch me up quickly" is one paragraph; a returning-after-months operator gets all three parts. A young project with three entries gets three honest lines, because padding is the mannered prose the style rule excludes.

## Setup

The `chronicle:` knob in dev.md (`on` default | `off`) governs whether dev-implement writes entries and dev-ship checks them; `chronicle-style:` and `emoji:` govern how they read; `dev-setup` writes all three. A project that turns it on mid-life starts from now — no retroactive backfill unless the operator asks, and then it's marked as reconstructed.
