---
"@vegastack/vegafactory": minor
---

Sessions now leave lessons behind. At the end of a session that committed something, the Stop hook asks once — through each harness's own documented Stop continuation — for the general lessons it taught, the ones that would have saved time on any issue in the repository. A chat-only session is never asked. Answers queue one per line in `.vegastack/.tmp/learnings.md`; the next SessionStart lists them and tells the agent to propose each as one `.vegastack/dev.md` line, folded into an existing line where it fits, which lands only on the operator's explicit yes. New `vegafactory learning list|accept|decline` reads the queue and drops a lesson once it is settled; it never edits dev.md itself, and it covers the repository's own dev.md only — org and group control-room lines stay manual.
