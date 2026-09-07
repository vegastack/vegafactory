---
name: dev-plan
description: Write the implementation plan for an approved issue before any code exists. Use when asked to "plan issue 12", "write the plan for" a feature or issue, "plan this before building", when picking up an issue labeled needs-plan, when an approved brief needs its technical approach worked out, or when dev-intake requests the inline plan for a quick-build issue. Not for writing or approving the brief itself (dev-intake), not for executing an approved plan (dev-implement), not for architecture stack advice (dev-architect — this skill consults it while planning).
---

# dev-plan

Advise: turn the approved brief into the plan the operator approves and dev-implement executes, against the repo as it is now.

The planning stage: an approved brief goes in, an operator-approved plan comes out, and only then does code exist. A `full-plan` issue is planned in a separate session from intake, because code drifts between brief approval and build.

Nearest neighbors: `dev-intake` owns the brief and its approval mechanics — this skill owns the how; `dev-implement` executes what this produces, task by task.

## Every run

1. Read `.vegastack/dev.md` and the issue: brief (description), current schema-v2 brief approval (bundled `scripts/lib/approval.mjs`’s `evaluateApprovals`, complete history and current operator policy), scope label. Full-plan issues arrive labeled `needs-plan`; anything else at this door is either intake's inline request (below) or a misroute — say so.
2. **Re-ground before planning** — open the brief's touch points in the current code and verify the flow, names and shapes the plan builds on, because code drifts between approval and build. A claim that no longer matches reality goes back to the operator (`handback` comment, `needs-operator`).
3. Stack-bearing choices (schema, hosting, services, jobs, auth) check `dev-architect` — its verify protocol governs platform claims, and no plan re-proposes a recorded rejection.

## The questionnaire

Numbered rounds over the full frontier (every open question whose prerequisites are settled), each question carrying a recommended answer so the operator can reply "all recommended":

1. **Approaches** — two or three candidates with the trade-off that matters and one recommendation, because a single option is a decision dressed as a question.
2. **System design** — schema, interfaces, migration shape, failure modes; what breaks at the edges.
3. **Risk** — blast radius, what a rollback looks like, what should stop a dark run beyond the standing stop-list.
4. **Brief challenge** — anything planning revealed the brief missed or got wrong goes back to the operator as a question, because a brief gap absorbed into the plan is a decision the operator did not make.

Rounds go out by the ask route (`references/ask-route.md`); an issue-routed round stops the session at `needs-operator` and the next run parses the reply before re-asking anything. A vague or self-contradicting answer gets pushback with concrete options — simple words, a mermaid or ASCII sketch in the issue when a picture beats prose (conventions' collaboration rule).

## The plan

Give every task its stable `<issue>-T<n>` identity before approval. Post one comment per [plan-format](references/plan-format.md): Goal · Approach (alternatives named) · Constraints · ordered `- [ ]` tasks, each with exact Files, an Interfaces block (consumes/produces with exact signatures), and Steps that put the failing test before the code. Before posting:

- Walk the brief section by section per plan-format's self-review — every requirement points at a task, names match across tasks, no banned placeholder.
- Work that can run at the same time gets plan-format's independent-group block, because a declared file set is what lets dev-implement run children in parallel and prove afterwards that none of them wandered.
- Run this skill's plan-lint: `node <path-to-this-skill>/scripts/plan-lint.mjs --file <draft> --json`; exit 2 = fix before posting (placeholders and structural gaps block).

Checkboxes belong to the implement session and post empty, because dev-status reads a ticked box as progress.

## Labels and approval

Post the plan → flip to `needs-operator`, assigned to the issue's operator (conventions' Labels table). On the operator's "plan approved": record the schema-v2 event per conventions with `scope=plan`, exact source quotation and current canonical `ArtifactRef`; evaluate it together with current brief approval, then flip to `ready` and unassign — an unassigned `ready` issue is what tells the next agent it is free — stop; building is dev-implement's.

## The ratchet — one home, this file

- **Upgrade (any time, no permission needed to propose):** planning reveals the work is bigger than its scope label — a quick-build that needs real design, an issue that is actually several deliverables. Stop, post one `handback` comment proposing the reclassification or the epic split (parent map + sub-issues, each classified fresh), `needs-operator`, assigned to the operator. A plan runs about one screen per task — Files, Interfaces, Steps — and a plan approaching GitHub's ~65,536-character comment cap is the slicing telling you it wants to be an epic.
- **Downgrade (operator's yes only):** planning reveals the work is trivial — propose skipping to `ready` with the brief's inline approach, and wait for the yes.

## Quick-build inline mode

Invoked from inside dev-intake's conversation, after the brief has consensus: same format, proportionally small (a four-item task list is a fine plan), posted as the plan comment alongside the brief. The operator's single approval covers both (`scope=brief+plan`) — no `needs-plan` stop, no second exchange. The re-grounding step collapses to what intake already read; the ratchet still applies.
