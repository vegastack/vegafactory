---
"@vegastack/vegafactory": patch
---

`dispatch enable`'s hooks check now recognises the CLI however this machine spells it.

- It matched the literal `vegafactory hook`, so a machine running the CLI from source — `bun .../src/index.ts hook stop --harness claude` — was called unwired while running the very code it was checking.
- What identifies the hook is the verb and the harness it names, not the word in front, so a wrapper script or a pinned path counts too.
