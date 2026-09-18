# Workflow conventions

GitHub issues are the record. Agents read them through `vegafactory issue sync` (a local copy under `.vegastack/.tmp/issues/`) and write them through the `vegafactory issue` verbs. Settings resolve repo `dev.md`, then group, then org; a line the org marks `locked` cannot be overridden.

## Reading and writing issues

- `vegafactory issue sync <n> [--since CURSOR]` refreshes the local copy (a cheap "changed?" check first) and prints only the files that changed since CURSOR, plus the new cursor. Read those files; keep the cursor.
- Folder: `.vegastack/.tmp/issues/<owner>__<repo>/<n>/` — `issue.md` (labels, assignees, parent, sub-issues, open blockers, then the body) and `comments/<time>-<type>-<id>.md`.
- Writes: `issue comment <n> --file F`, `issue edit-comment <n> <id> --file F --since CURSOR`, `issue body <n> --file F --since CURSOR`, `issue label <n> --state S [--add a] [--remove b]`. An edit to something that changed after your cursor is refused: read it again, merge, retry.
- Never call `gh issue` or `gh api` for issue content directly; the cache would go stale.

## Comment markers

Machine-read comments open with one marker line:

```markdown
<!-- vsk:v1 type=<type> [key=value ...] -->
## <Human title>
```

| type | keys | instances |
|---|---|---|
| `plan` | `rev` | one, edited in place |
| `questions` | `rev` | one per ask round |
| `ack` | `stage by brief [plan] source` | one per ack — written by `vegafactory issue ack` |
| `ledger` | `branch` | one status comment, edited in place |
| `evidence` | `branch sha` | one, edited in place |
| `review` | `round sha agent=<claude\|codex> verdict=<clean\|needs-fixes>` | one per review cycle |
| `handback` | — | one per stop |
| `decision` | — | one per decision proposal |

A comment without a marker is a person's comment (`human`). Find artifacts by marker, never by heading.

## Acks — the operator's two words

An operator gives two words per issue: an **ack** on the brief/plan, and **"ship it"**. Anyone with write access to the repository may give them, in an issue comment or in a Claude Code / Codex session. Anything else they say is input: fold it in, update the brief or plan, and ask again.

- When a person's reply is an ack, record it: `vegafactory issue ack <n> --stage brief|plan|ship --by <login> --quote "<their words>" --source comment:<id>` (their GitHub comment) or `--source session` (said in this session; run it with that person's own `gh` login).
- The record binds short hashes of the current brief and plan. Editing either afterwards invalidates the ack; ticking plan checkboxes does not.
- An app or bot may record an ack only by citing the person's own comment. Its own comments never count.
- `vegafactory issue check <n> --for plan|implement|ship` verifies the facts before acting: open issue, one state label, one size label, no open blockers, and a valid ack (for `ship`, a "ship it" newer than the latest evidence).

## Labels

One state label at a time (`issue label <n> --state …` swaps it):

| label | meaning | assignee |
|---|---|---|
| `waiting-on-operator` | a person must ack or give input (brief, plan, handback) | the operator |
| `planning` | brief acked; a plan is being written (medium / large) | the operator |
| `queued` | approved; waiting to be built | nobody |
| `in-progress` | held by a session or the dispatcher (see the status comment) | the holder |
| `ready-to-ship` | built and reviewed; comment changes or say "ship it" | the operator |

Size, one per issue: `small` (brief and plan together, one ack) · `medium` (brief ack, separate planning session, plan ack) · `large` (planning splits it into small/medium sub-issues; the parent becomes an `epic`). `research` replaces the size for an inquiry: code is throwaway and never merged, and the evidence comment holds findings and a recommendation. Flags: `risky`, `epic`. Boards mirror states one way.

## Titles, types, hierarchy

- Issue titles use dev.md's `branch:` types, plus `research:` for an inquiry. A branch uses those types and nothing else, so a `research:` issue that does write code takes a listed type — `worktree create` refuses rather than choosing one, and naming the list is the knob's job. The PR title is the issue title.
- Native issue types: Feature (feat) · Bug (fix) · Task (docs/chore/refactor/research).
- An epic is a map only (Destination · Decisions so far · Not clear yet · Out of scope) with native sub-issues. Tasks are checkboxes in the plan comment only. Blockers use GitHub dependencies.
- Tasks inside one issue run in order, and so do sibling sub-issues. The plan records which siblings' files do not overlap and so may run at the same time; the dispatcher (#218) is what will run them.

## Revisions

A scope edit bumps the plan's `rev` and appends `Revisions: v2 — DD-MM-YYYY: <change>, per (<username>)`, then asks for a fresh ack. Register lines read `- DD-MM-YYYY (<username>) — <decision>`.

## The ledger

One status comment per issue (`type=ledger`), edited in place:

```markdown
<!-- vsk:v1 type=ledger branch=<branch> -->
## Ledger — <branch>
- <issue>-T<N>: complete (commits <base7>..<head7>[, review clean | K parked])
- <issue>-T<N>: fix round <R>/3 (<X> addressed, <Y> open — <one-liners>)
- Ruling: <what> — <why> — cost if wrong: <cost>
- Deferred minor: <one-liner>
```

Resume: the status comment and `git log` on the issue branch recover the position; brief and plan confirm the scope; keep completed work.

## Workspaces

Drafts and reports: `.vegastack/.tmp/<issue>-<slug>/` (pre-issue: `intake-<slug>`). Branch checkouts: `.vegastack/.worktrees/<issue>-<slug>/`; the main checkout stays on the default branch. `.vegastack/.tmp/` and `.vegastack/.worktrees/` are git-ignored. Subagents save full reports and return a short status. `<path-to-this-skill>` means SKILL.md's directory.

## Verification

Prove claims with fresh command output and exit codes; report failures and skips. Never delegate your own verification. Checks block on machine-verifiable facts (exit 2) and fail closed when a fact cannot be read; judgment stays in prose.

## The review comment

`vegafactory review` writes it: one comment per issue, edited each round, the marker always current. Findings render as `Finding [id]` with severity and `path:line`; a `Findings JSON` block at the bottom carries the machine copy. Every must-fix finding still open at hand-back needs the operator's word.

Say what you are doing plainly; name paths and remaining checks. When something is ambiguous, offer options — never guess silently.
