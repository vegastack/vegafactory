# Stats

The one tree automation writes. `vegafactory stats push` appends `stats/YYYY/MM/DD/<operator>-<machine>.jsonl` — one record per assistant turn: time, operator, repo, issue, harness, model, skill, tokens, duration and outcome, and nothing else. Never prompt text, assistant text, tool arguments, file contents, or which subscription paid for the turn.

One file per operator, per machine, per day means two machines never touch the same file, so a concurrent push is a non-fast-forward and never a content conflict a human has to settle. Nothing here is summarised in the repository: totals are computed when they are read, with `vegafactory stats show` or the local page `vegafactory dashboard` builds.
