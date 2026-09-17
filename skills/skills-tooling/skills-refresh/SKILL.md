---
name: skills-refresh
description: Re-verify the dated platform and harness facts the dev skills pin, and file what changed as issues. Use when asked to "refresh the skills", "check the pinned facts", "are our platform facts still true", "run the facts sweep", "what changed in Cloudflare/Next.js/Claude Code since we last checked", when a fact is older than the 60-day window, or when a scheduled refresh run starts. Not for editing skill prose (dev-implement builds the issues this files), scanning skills for vulnerabilities (skill-scan), authoring or auditing a skill (skillify), or architecture advice from those facts (dev-architect).
---

# skills-refresh

Act: read the sources, report what moved, and file it. This skill never edits a skill.

Facts about other people's products go stale on their schedule, not ours. This skill re-reads the pinned ones against the vendor's own pages, writes one issue per real change, and posts a digest. The edits themselves are ordinary work: an issue, an ack, dev-implement. **Nothing here writes to `skills/`** — a sweep that edits what it also verifies is a sweep nobody can check.

Nearest neighbors: `dev-architect` and `dev-setup` own the facts files this reads; `skillify` judges whether a skill is complete; `skill-scan` judges whether one is safe.

## Routing

| Need | Read |
|---|---|
| the topics, their files, the fact-line format, the window | [watchlist](references/watchlist.md) |

## 1 — See what is due

```sh
node <path-to-this-skill>/scripts/facts-scan.mjs --root . --json
```

Read-only. It parses [the watchlist](references/watchlist.md) and every facts file it names, and returns each topic with its fact count, how many are past the 60-day window, and the oldest age — plus a `due` array naming each stale line by file, line number, capability and link. **Exit 0 nothing due · 1 something is due · 2 a file or a line could not be read.** Exit 2 is a malformed fact line or a missing file, and it is fixed before the sweep runs, because a line the scanner cannot read is a fact nobody is checking.

A hand run sweeps whatever came back `due`. A scheduled run does the same thing with no argument: the window is in the data, so the schedule only decides how often someone looks.

## 2 — Read each topic, one subagent per tool

One subagent per topic, never one for all of them: the vendors' pages have nothing to do with each other, and a single agent reading seven changelogs remembers the first one badly. Give each subagent the topic's rows and its official pages from the watchlist, and ask for exactly this back:

- **Unchanged** — the lines it read and confirmed, by capability. These get a new `checked` date and nothing else.
- **Changed** — each line whose claim is no longer what the page says, with the old text, what the page says now, the version or date it changed in, and the link that proves it.
- **New** — a capability the page documents that would change a decision here and no line covers.
- **Gone** — a line whose subject the vendor removed or deprecated.

The subagent reads the vendor's own pages and nothing else. A forum post, a model's recollection and a third-party summary are all the same thing: not a source. A page it could not reach is reported as unreachable, never as unchanged — silence is not confirmation.

Delta reading, not re-reading: the subagent is given the current lines and asked what moved. Asking "what does this page say" gets a summary of the page; asking "which of these seven claims is now wrong" gets an answer you can act on.

## 3 — File it

- **One issue per change.** Each Changed, New or Gone item is its own issue through `dev-intake`, because they are acked, built and reverted separately. The brief carries the old line, the new claim, the link and the version it changed in, and it says which file and line to edit. A change that touches a decision recorded in the register says so.
- **Unchanged lines are not an issue.** They are one `fix:` issue at the end of the sweep that moves their `checked` dates and nothing else — a date bump is not a fact change, and giving it its own ack per line is how a sweep becomes work nobody runs again.
- **The digest** is one comment on the pinned log issue: the date, how many facts were read per topic, how many changed, links to every issue filed, and every page that could not be reached. A sweep with no changes still posts one — "nothing moved" is the finding, and an absent digest looks exactly like a sweep that never ran.
- **The pinned log issue** is one open, pinned issue in the repo titled for this sweep, labeled `research`, holding every digest as comments, newest at the bottom. It never closes; it is the answer to "when did we last look at this".

## Example

The scan exits 1 with four Cloudflare lines and two Codex lines due. Two subagents run. Cloudflare comes back: five lines unchanged, one changed — Workflows' step ceiling moved from 25,000 to 50,000 in the 12-09-2026 changelog entry. Codex comes back: both lines unchanged. The sweep files one `fix:` issue for the Workflows line quoting the old text, the new ceiling and the changelog link; one `fix:` issue moving the remaining five Cloudflare and two Codex `checked` dates; and one digest comment on the log issue reading "18-09-2026 — Cloudflare 6 read, 1 changed · Codex 2 read, 0 changed · issues #241, #242 · every page reachable". No file under `skills/` is touched by this session.

## Honesty rules

A `checked` date moves only when someone actually read that line against its link — a date bumped because the sweep ran is a lie with a timestamp on it. An unreachable page keeps its old date and appears in the digest as unreachable. A fact the vendor states ambiguously is filed as an issue with the ambiguity quoted, not resolved by guessing. And the sweep reports its own gaps: a topic whose subagent failed is named in the digest, because a missing topic looks like a clean one.
