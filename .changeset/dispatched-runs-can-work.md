---
"@vegastack/vegafactory": patch
---

A dispatched run can now do the work it was started for, and stops holding its slot after it finishes.

- `claude -p` was spawned with no permission mode, so every write was denied: the first dispatched run read the repository, changed nothing and handed the issue back untouched. Claude runs get `--dangerously-skip-permissions` and Codex runs `--dangerously-bypass-approvals-and-sandbox`, because nobody is at the keyboard to answer a prompt.
- The step watchdog leaked its `sleep`: killing the subshell left the sleep running, and an orphan holding the job's stdout meant the dispatcher never saw the run end. Work that took twelve seconds held a run slot for the full twenty-minute limit. The backstop now sleeps with its own stdio and is killed by name, and it still ends a job that runs past the limit.
