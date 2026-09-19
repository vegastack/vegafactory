---
"@vegastack/vegafactory": minor
---

Stats now identify each turn by owner and node, including two OS users who share a host and GitHub login.

- New records write `owner` and `node`; existing `operator` and `machine` records remain readable and are rewritten in the current shape when pushed.
- Collected nodes use `nodeId()`, and control-room files use the portable `<owner>-<node>-<digest>.jsonl` form, each identity bounded on its own.
- Summaries, the CLI, and the offline dashboard expose owners and a nodes bucket.
- Harness model and outcome labels are restricted to 64 safe characters before storage.
- Checkouts without a profile or GitHub origin remain unnamed instead of exposing their local folder name.
- The control room's own reference now says what the machine keeps for itself, including that `push/` is a lock directory rather than somewhere records queue — a listing that showed it beside `push.json` read as though they did.
- A control-room filename ends in twelve characters of the exact owner and node. The readable part rewrites `@` to `-` and is cut at 64, so `a-b@c` and `a@b-c` both read as `a-b-c` and two long nodes sharing a prefix read as each other; either one put two machines back on one file, which is the conflict this layout exists to prevent.
- An owner and a node read back from a shared room have terminal control characters removed, so a row written elsewhere cannot address the terminal `stats show` prints to. Letters, accents included, are kept — flattening those would change whose turn a record says it is.
