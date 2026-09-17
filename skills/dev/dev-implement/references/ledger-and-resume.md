# Using the ledger

`references/conventions.md`, authored by `dev-setup` and shipped with every dev skill, defines the ledger format and resume order: brief → plan → ledger → `git log` → targeted source reconciliation. This file defines how dev-implement uses that recovery map and live progress view.

## When to checkpoint

Create the ledger comment as the session's **first write after claiming** — before any code — with the marker, the heading, and the branch's worktree path, so a resuming session reads brief → plan → ledger → `git log` in the right checkout rather than the main one. Then checkpoint, editing in place:

- **After each plan task completes** — and tick the matching `[x]` in the plan comment in the same pass. That box is a second write, to a different comment, that your own resume path never reads — so it is the one that silently lags reality, while the operator's progress view depends on it. The hand-back guard (`evidence-check --issue`) compares immutable task IDs in both directions; equal counts do not prove agreement. Record the task's base sha *before* starting it, so the `complete` line's commit range is exact.
- **After each review fix round**, with the addressed/open counts.
- **At every dark-mode judgment call.** A ruling is any decision the brief/plan didn't make for you that a reviewer or the operator could reasonably question. Rulings are cheap; unrecorded decisions are debt.
- **On findings deferred or parked at review**, per dev-review's adjudication lines.

Never batch checkpoints "for later" — the ledger's value is exactly that a crash between checkpoints loses one task, not the map. Edit it with `vegafactory issue edit-comment <n> <id> --file F --since <cursor>`; a refused edit means someone else changed it — read it again and merge.

A checkpoint retains what a compaction summary must retain: difficulties and their resolutions; options tried or set aside, and why; anything decided, ruled out, or established as a constraint, stated exactly; where things stand; what is open; exact names, numbers, links — the operator's words near-verbatim, the agent's reasoning condensed.

The ledger's edit time is also this claim's **heartbeat** — the only liveness signal an agent session exposes. dev-status reads a ledger silent past the orphan threshold (6h) as a *possibly-orphaned* claim: the session likely died before hand-back. A session that runs for days but keeps checkpointing never trips it; a dead one's ledger freezes. A single long task can legitimately go quiet — so checkpoint at rulings within it too, keeping the pulse alive — and the flag is always the operator's to act on (check, resume, or reclaim), never an automatic reset.

## Resuming

A resuming session reads brief → plan → ledger (`vegafactory issue sync <n>`) → `git log` on the issue branch in its worktree (`vegafactory worktree restore <n>` when the folder is gone), then continues from the first task the ledger does not mark complete.

- Resume only unfinished work within the acked brief and plan; `vegafactory issue check <n> --for implement --resume true` confirms the ack still matches.
- An edited brief or plan since the ack stops the resume: one `handback` comment, `waiting-on-operator`.
- Completed tasks stay as they are; re-run their checks only when the code they touched changed since.
- A stale heartbeat is a reason to look, never proof the other session stopped: only the operator abandons a claim (`reclaim.mjs`).
