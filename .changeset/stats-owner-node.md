---
"@vegastack/vegafactory": minor
---

Stats now identify each turn by owner and node, including two OS users who share a host and GitHub login.

- New records write `owner` and `node`; existing `operator` and `machine` records remain readable and are rewritten in the current shape when pushed.
- Collected nodes use `nodeId()`, and control-room files use the portable, separately bounded `<owner>-<node>.jsonl` form.
- Summaries, the CLI, and the offline dashboard expose owners and a nodes bucket.
- Harness model and outcome labels are restricted to 64 safe characters before storage.
- Checkouts without a profile or GitHub origin remain unnamed instead of exposing their local folder name.
