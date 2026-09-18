---
"@vegastack/vegafactory": patch
---

`vegafactory dispatch enable` can now pass its readiness check. The Codex probe ran `codex exec --sandbox read-only -a never "say ok"`, but `codex exec` has no approval flag, so every machine got `codex did not answer ok: For more information, try '--help'` and the dispatcher refused to install anywhere. Probes also inherited stdin, and both harnesses read a prompt from an open stdin, so a probe could wait for input nobody was there to give; stdin is closed now.
