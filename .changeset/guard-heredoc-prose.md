---
"@vegastack/vegafactory": patch
---

The ship guard no longer asks permission to run commands somebody was only writing down.

- A heredoc body is data the command is fed, and a quoted delimiter stops the shell expanding it, so backticks in a changeset or a release note were being read as command substitution.
- A body is dropped only when every command on that line reads its stdin as data; `sh`, an interpreter, a pipe into one, or a command the guard does not recognise all keep it, because they run it.
- An unquoted delimiter is expanded by the shell, so those bodies still count.
