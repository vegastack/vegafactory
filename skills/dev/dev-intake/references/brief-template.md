# Issue brief template

The issue body a workable issue must have. Write the sections that apply, delete the rest. The test for every section: would a fresh agent have to guess or ask without it?

```markdown
<!-- vsk:v1 type=brief rev=1 size=small|medium|large|research -->
**Size:** small | medium | large | research — the announced reason for the call, one line.
**Priority:** <one of the org's Priority options> — the answer from the interview. Delete this line where dev.md's `issue-fields:` knob is `none`.
**Effort:** <one of the org's Effort options> — the answer from the interview. Delete this line where the knob is `none`.

## Outcome

What exists when this is done, in observable terms — what the user can do, what the
system produces. One paragraph.

Research issues replace Outcome and the build sections with two headings brief-lint
expects verbatim in spirit: `## The question` (what this issue resolves) and
`## What answered looks like` (the evidence that closes it). Risks/stop conditions
and Assumptions still apply.

## Out of scope

The nearby things this issue deliberately does NOT do. This is what stops scope creep
in dark mode — name the tempting adjacent work.

## Rules and edge cases

The behavior that isn't obvious: validations, permissions, limits, empty/error/concurrent
cases, what happens on failure. Bullet list, one behavior per line.

## Reproduction            <!-- fix: issues only -->

The exact steps (or attached artifacts — logs, HAR, recording) that demonstrate the
bug today, and the observed vs expected behavior. A bug without this is a `research`
issue, not a fix. The implement path is dev-debug.

## UI states            <!-- only when there is UI -->

Loading, empty, error, success, disabled. Which design-system components. Copy for
user-facing text. Responsive and keyboard behavior when it matters.

## Approach and touch points

The chosen technical approach in a few lines: which parts of the codebase change,
new/changed interfaces or schemas, data migrations. Routine choices stay the
implementer's — don't specify them. Name the docs and changelog surfaces this change
must update. Task-level detail belongs to the plan (dev-plan), not here.
**Version impact:** patch | minor | major, one-line reason — only when the project
versions releases (dev.md `changelog:` knob).

## Tests and acceptance

What proves it works: the cases tests must cover (success, boundary, failure,
authorization where relevant), the commands to run, and the **seams** — the public
boundaries tests live at (dark mode can't negotiate seams later; they're settled
here). Acceptance = the Outcome plus these passing.

## Risks and stop conditions

What could go wrong and what should make the agent stop and ask instead of pushing
through — beyond the standing stop-list in .vegastack/dev.md.

## Assumptions — confirm or correct

Anything material the grounding investigation could not verify, one per line, each
awaiting the operator's confirm/correct. The issue cannot leave waiting-on-operator while
one is unconfirmed. Verified facts never appear here — they live in their section
with their evidence. Delete the whole section once every entry is resolved (`vegafactory issue check`
warns while it is present).
```

## Writing rules

- Inline over linked: the material details live in the issue itself. A link supports; it never substitutes.
- Concrete over abstract: "rejects amounts over 10,000 with error E402" beats "validates input".
- Evidence over confidence: touch points name real file paths; a dependency capability claim carries the doc check and its date; what couldn't be verified goes to Assumptions, never stated as fact.
- The brief binds the agent, so ambiguity is a bug in the brief — if two readings exist, the interview wasn't done.
- Edits after the ack follow the revision-marker rule in dev-setup's `references/conventions.md` (heading `(v2)`, marker `rev=2`, a `Revisions:` line).
- A `Decision:` comment exists only for a choice that passes the Decisions test in `.vegastack/dev.md` — feature requests and implementation details never qualify; they are brief content, not register lines.

### Summarising an SOW

The brief restates the SOW in the agent's own words and quotes only the terms the client owns — dates, amounts, defined deliverables — so a reader can tell our reading from their commitment:

<example>
SOW excerpt: "Vendor shall deliver a customer portal supporting invoice download (PDF), payment status, and dispute submission within 60 days of kickoff."

Outcome, in the brief: A signed-in customer opens their portal, downloads any invoice as a PDF, sees whether it is paid, and files a dispute against it. The SOW commits to delivery "within 60 days of kickoff" — quoted, because the date is the client's term and not ours to soften. "Dispute submission" is quoted because the SOW does not say what a dispute contains; that gap is the first line under Assumptions — confirm or correct.
</example>
