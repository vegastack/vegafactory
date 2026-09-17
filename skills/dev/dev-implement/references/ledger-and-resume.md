# Using the status comment

`references/conventions.md`, authored by `dev-setup` and shipped with every dev skill, defines the resume order: brief → plan → status comment (the ledger) → `git log` → targeted source reconciliation. The status comment is written by `vegafactory issue status`, never by hand: it shows the state, who holds the issue, a stage timeline from GitHub's label history, and your progress list. This file defines how dev-implement uses it as recovery map and live progress view.

## When to checkpoint

Write the status comment as the session's **first write after claiming** — before any code — with `vegafactory issue status <n> --progress-file <file>`, the file's first line naming the branch's worktree path, so a resuming session reads brief → plan → status comment → `git log` in the right checkout rather than the main one. Keep the progress file in the worktree's `.vegastack/.tmp/` and re-run the command to checkpoint:

- **After each plan task completes** — and tick the matching `[x]` in the plan comment in the same pass. That box is a second write, to a different comment, that your own resume path never reads — so it is the one that silently lags reality, while the operator's progress view depends on it. The hand-back guard (`evidence-check --issue`) compares immutable task IDs in both directions; equal counts do not prove agreement. Record the task's base sha *before* starting it, so the `complete` line's commit range is exact.
- **After each review fix round**, with the addressed/open counts.
- **At every dark-mode judgment call.** A ruling is any decision the brief/plan didn't make for you that a reviewer or the operator could reasonably question. Rulings are cheap; unrecorded decisions are debt.
- **On findings deferred or parked at review**, per dev-review's adjudication lines.

Never batch checkpoints "for later" — the progress list's value is exactly that a crash between checkpoints loses one task, not the map. Code needs no checkpoint of its own: the Stop hook commits and pushes a `wip:` commit at the end of every turn.

A checkpoint retains what a compaction summary must retain: difficulties and their resolutions; options tried or set aside, and why; anything decided, ruled out, or established as a constraint, stated exactly; where things stand; what is open; exact names, numbers, links — the operator's words near-verbatim, the agent's reasoning condensed.

The claim's **heartbeat** is not yours to write: the hooks update it on your own claim comment (a `vsk:claim` row) at most every five minutes while tools run, and `vegafactory issue holder <n>` shows it. A claim with no heartbeat for 4 hours (30 minutes for a dispatched run) is stale, and the next `issue claim` releases it. A live claim is taken back only on the operator's word — the flag is theirs to act on (check, resume, or take back), never an automatic reset.

## Resuming

A resuming session claims the issue again (`vegafactory issue claim <n> …`), reads brief → plan → status comment (`vegafactory issue sync <n>`) → `git log` on the issue branch in its worktree (`vegafactory worktree restore <n>` when the folder is gone; `git pull` first after a take-back, since the last holder's final push may land late), then continues from the first task the progress list does not mark complete.

- Resume only unfinished work within the acked brief and plan; `vegafactory issue check <n> --for implement --resume true` confirms the ack still matches.
- An edited brief or plan since the ack stops the resume: one `handback` comment, `waiting-on-operator`.
- Completed tasks stay as they are; re-run their checks only when the code they touched changed since.
- A stale heartbeat is a reason to look, never proof the other session stopped: a live claim is taken back only on the operator's word (`vegafactory issue claim <n> --harness <h> --model <id> --take-back-by <their login>`).
