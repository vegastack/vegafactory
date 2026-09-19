---
"@vegastack/vegafactory": minor
---

The control room's machine roster is `nodes.md`, and being in it no longer authorises anything.

- Every machine that runs vegafactory gets a row: `node | owner | worker | repos | caps`. That is what makes "which machines do we have" and, later, "everything this person did" answerable — and it is why presence alone cannot mean consent.
- **`worker` is the gate.** Only `yes` lets a machine work a board with nobody watching. `no`, an empty cell, and anything that is not an answer — `y`, `true`, `TODO confirm` — all refuse, and the machine is named in the refusal rather than left looking unlisted.
- **An empty `repos` cell now authorises nothing.** It used to mean every repository in the org, which on a roster that lists every machine would hand the whole board to the laptop written down precisely to say it is not a worker. `*` and `all` still mean everything, said out loud.
- A roster with **no** `worker` column grants nothing either. There are no rosters written before the gate — the only control room that exists is being written now — so there is no older shape to be compatible with and get wrong.
- `owner` says who is responsible for the **machine**. That is deliberately not the owner on a statistics record, which is whoever did that piece of work — on a shared box the two differ, and the roster says so.
- A machine looks itself up by its node id, `<os-user>@<hostname>`, and by nothing else. The lookup used `machineName`, which maps every non-alphanumeric to a dash, so it would have turned `mk@patrick-mac-mini` into `mk-patrick-mac-mini` and never matched a row. One spelling, so two rows cannot name one machine.
- A heading that is trying to be the gate and missing it — `workers`, `worker?` — grants nothing. Read as "no gate at all" it would have granted every row in the file.
- The row an unlisted machine is told to add says `yes` in the gate, because a row pasted from a refusal is one somebody is adding so that machine can work a board.
- The App's private key belongs only on a machine whose row says `worker: yes`. `nodes.md` now names every machine, most of which only report what they did, and possession of that key is by itself enough to mint installation tokens.
- A node name is exactly one name: `mk@box@anything` and a name with an empty half authorise nobody, rather than being cut down to a real node's name and matching it.
- A dash in a notes cell no longer deletes the row. Only a line that is entirely separators is the one under a header, and a row that vanishes is a machine that looks unlisted.
