---
"@vegastack/vegafactory": minor
---

The control room's machine roster is `nodes.md`, and being in it no longer authorises anything.

- Every machine that runs vegafactory gets a row: `node | owner | worker | repos | caps`. That is what makes "which machines do we have" and, later, "everything this person did" answerable — and it is why presence alone cannot mean consent.
- **`worker` is the gate.** Only `yes` lets a machine work a board with nobody watching. `no`, an empty cell, and anything that is not an answer — `y`, `true`, `TODO confirm` — all refuse, and the machine is named in the refusal rather than left looking unlisted.
- **An empty `repos` cell now authorises nothing.** It used to mean every repository in the org, which on a roster that lists every machine would hand the whole board to the laptop written down precisely to say it is not a worker. `*` and `all` still mean everything, said out loud.
- A roster with no `worker` column is one written before the column existed, and is read the way it was written: every row a worker, and an empty `repos` cell still meaning all.
- `owner` says who is responsible for the **machine**. That is deliberately not the owner on a statistics record, which is whoever did that piece of work — on a shared box the two differ, and the roster says so.
