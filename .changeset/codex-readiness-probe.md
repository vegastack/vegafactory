---
"@vegastack/vegafactory": patch
---

`vegafactory dispatch enable` can now pass its readiness check.

- The Codex probe passed `-a never`, which `codex exec` does not accept, so every machine was told `codex did not answer ok` and the dispatcher installed nowhere.
- Probes no longer inherit stdin, which both harnesses read a prompt from when it is open.
- A test pins each probe's arguments, because the failure mode is a tool changing its flags under a check nothing runs.
