# The ask route

Where a round of questions goes when a skill needs the user. Two surfaces: the harness's question tool, or the issue itself. This file is the one home for the route, the comment shape and the reply grammar; `scripts/questions.mjs` is the deterministic method behind them, and the marker row lives in [conventions](conventions.md).

## The route

Three steps, in this order, first match wins:

1. `VSK_ASK_ROUTE` is set to `issue` or `tool` — the dispatcher and CI set it; any other non-empty value is refused rather than guessed.
2. This harness and this run have no question tool → `issue`.
3. The asker is not the issue's operator → `issue`. An unresolved asker or operator is also `issue`.

Otherwise the tool. The issue route needs an issue: where none exists yet — dev-intake's interview runs before its issue is created — the skill creates the issue first, at `waiting-on-operator` with the operator assigned and the request as its body, and posts the round to it; the brief is written into that issue once the round is answered. On the tool route the issue is created after approval, as before. Settle it deterministically rather than by judgement:

```sh
node <path-to-this-skill>/scripts/questions.mjs route --tool <name|none> --asker <login> --operator <login> --json
```

Which tool each harness has — and the Codex Plan-mode gating on `request_user_input` — is recorded in dev-setup's `references/harness-facts.md` (a backticked path, not a link: this file ships into dev-intake, dev-plan and dev-implement, which do not carry that reference) and not restated here. The operator identity comes from the caller under dev.md's `operators:` knob; the script takes both logins as inputs and never resolves them itself.

The bias is deliberate: a round in a comment is always readable by whoever owns the issue, and a round put to the wrong person is not.

## The comment

One comment per round, marker first, the whole round wrapped in `<questions>` tags so the parser and the model both find it inside a comment that may carry prose around it:

```markdown
<!-- vsk:v1 type=questions rev=1 -->
## Questions (v1)

<questions>
**Q1.** Where does the reminder queue live?
- a) A Postgres table
- b) A Redis list (recommended — Redis is already a dependency)

**Q2.** How late may a reminder fire?
- a) Within the hour (recommended — matches the existing cron cadence)
- b) Same day

Reply with `1: a` per question, or `all recommended`.
</questions>
```

No question, option or reason may carry an HTML comment delimiter or a `questions` block tag: a round can be read back out of a comment anyone may have written, so text that could close the block or forge a marker is refused in both directions. Every question carries at least two options and exactly one recommendation, and every recommendation carries its one-line reason — a round that cannot say which way it leans is a round that has not been thought through, and the renderer refuses it. Options run `a` through `h`. After posting, the label moves to `waiting-on-operator` and the session ends.

## Replying

Anyone on the issue may answer, in an ordinary comment, one line per question:

- `1: b`
- `2: a — the cron already runs` (trailing prose after the dash is kept)
- `3: other — a third way` (`other` is accepted for any question)
- `all recommended` on its own line fills every question not answered explicitly

An explicit line always beats `all recommended`. Bulleted lines, a `.` instead of `:`, and upper-case letters all parse. Surrounding prose is ignored; the first answer to a question stands and a repeat is reported. A numbered line whose letter runs straight into prose with no dash (`1: a is wrong, go with b`) is malformed, not an answer of `a` — the parser reports it and the question is re-asked.

## Re-asks

Parse before asking anything. A later session has no `round.json` on disk, so it reads the round back out of the posted comment — that is what the `<questions>` wrapper is for, and `--round <comment.md>` takes it in place of `--spec`. What comes back is answered questions, still-open questions, and malformed lines. If nothing is open, continue — never re-ask an answered question. If something is open, post a second comment at `rev=<n+1>` carrying only the open questions **at their original numbers**, so `**Q3.**` stays Q3. Earlier `questions` comments are left in place as record. A reply with no answer line at all is malformed, not empty: it gets one re-ask naming the expected shape.

## What it is not

An answer is not an ack. Anyone may answer a round; an ack comes from a person with write access and is recorded with `vegafactory issue ack` ([conventions](conventions.md)). A round that is fully answered unblocks the work; it does not move the issue to `queued`.

Assignment is not this route's job either — the label moving to `waiting-on-operator` is what puts the issue on the operator.

## Commands

Save the reply comment to `.vegastack/.tmp/<issue>-<slug>/reply.md` first; the parser reads a file, never a network.

```sh
node <path-to-this-skill>/scripts/questions.mjs render --spec round.json --rev 1 --json
node <path-to-this-skill>/scripts/questions.mjs parse  --comment reply.md --round asked.md --json
node <path-to-this-skill>/scripts/questions.mjs re-ask --round asked.md --comment reply.md --rev 2 --json
node <path-to-this-skill>/scripts/questions.mjs route  --tool none --asker <login> --operator <login> --json
```

`asked.md` is the posted `questions` comment; `--spec round.json` takes the same round as JSON instead, where the rendering session still has it. A spec is `{ "questions": [ { "text": "…", "options": [ { "letter": "a", "text": "…" }, { "letter": "b", "text": "…", "recommended": true, "reason": "…" } ] } ] }`.

Exit codes: 0 pass · 1 answers still open or malformed, and for `re-ask` nothing left to ask · 2 refusal or usage error.
