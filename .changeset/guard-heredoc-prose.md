---
"@vegastack/vegafactory": patch
---

The ship guard no longer asks permission to run commands somebody was only writing down. A heredoc body is data the command is fed, and with a quoted delimiter — `<<'EOF'` — a shell expands nothing in it, but the guard parsed backticks there as command substitution. Writing a changeset, a release note or a doc that mentioned a guarded command in backticks therefore asked for the operator's word: a file that says "we run `npm publish`" was read as running it. Quoted heredoc bodies are now dropped before the command is read. A bare `<<EOF` body really is expanded by the shell, so it still counts, and every real invocation asks exactly as before.
