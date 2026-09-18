---
"@vegastack/vegafactory": patch
---

`vegafactory worktree create` now reads its branch types from dev.md's `branch:` knob, which that line already called the only place the list lives — a copy was frozen in the worktree script, so editing the knob changed nothing. A title prefix outside the list is no longer a type, and it no longer leaks into the slug either: `research: P12 — prove the lean factory works` gave the slug `research-p12-…`, which reads like a type that lost its slash. `create` refuses a title that names no listed type, and a `--type` outside the list, naming the types this project has instead of silently choosing `feat`.
