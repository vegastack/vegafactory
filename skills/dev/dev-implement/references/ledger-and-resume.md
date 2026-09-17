# Using the ledger

`references/conventions.md`, authored by `dev-setup` and shipped with every dev skill, defines the ledger format and resume order: brief → plan → ledger → `git log` → targeted source reconciliation. This file defines how dev-implement uses that recovery map and live progress view.

## When to checkpoint

Create the ledger comment as the session's **first write after claiming** — before any code — with the marker, the heading, and the branch's worktree path, so a resuming session reads brief → plan → ledger → `git log` in the right checkout rather than the main one. Then checkpoint, editing in place:

- **After each plan task completes** — and tick the matching `[x]` in the plan comment in the same pass. That box is a second write, to a different comment, that your own resume path never reads — so it is the one that silently lags reality, while the operator's progress view depends on it. The hand-back guard (`evidence-check --issue`) compares immutable task IDs in both directions; equal counts do not prove agreement. Record the task's base sha *before* starting it, so the `complete` line's commit range is exact.
- **After each review fix round**, with the addressed/open counts.
- **At every dark-mode judgment call.** A ruling is any decision the brief/plan didn't make for you that a reviewer or the operator could reasonably question. Rulings are cheap; unrecorded decisions are debt.
- **On findings deferred or parked at review**, per dev-review's adjudication lines.

Never batch checkpoints "for later" — the ledger's value is exactly that a crash between checkpoints loses one task, not the map. Under concurrent edits, last-writer-wins on one comment is accepted (single-operator workflow); note a clobber if you ever see one.

A checkpoint retains what a compaction summary must retain: difficulties and their resolutions; options tried or set aside, and why; anything decided, ruled out, or established as a constraint, stated exactly; where things stand; what is open; exact names, numbers, links — the operator's words near-verbatim, the agent's reasoning condensed.

The ledger's edit time is also this claim's **heartbeat** — the only liveness signal an agent session exposes. dev-status reads a ledger silent past the orphan threshold (6h) as a *possibly-orphaned* claim: the session likely died before hand-back. A session that runs for days but keeps checkpointing never trips it; a dead one's ledger freezes. A single long task can legitimately go quiet — so checkpoint at rulings within it too, keeping the pulse alive — and the flag is always the operator's to act on (check, resume, or reclaim), never an automatic reset.

## Resuming — dev-implement's additions to the protocol

- Resume only outstanding work inside the unchanged approved scope, with the ack still valid and the issue still yours.
- Re-read the brief, the plan, every comment on the issue (old ones can be edited, so age does not matter) and `git log`; any current operator correction wins over the ledger.
- Match tasks by their IDs, not by counts; a ticked task with a verified commit never reruns.
- Anything ambiguous — a moved scope, a missing commit, a claim held elsewhere — is a hand-back, not a guess.

## Surfacing — rulings never die in the dark

Every `Ruling:` line lands on the evidence comment's `**Review:**` line at hand-back, in the order made. The operator reads that list and reverses anything wrong — a ruling that only ever lived in the ledger was a decision made in secret.
