---
"@vegastack/vegafactory": patch
---

Enrolling a dispatcher no longer needs an SSH key when the machine is already logged in to GitHub.

- The App's token is for the API and cannot write code, and the gh credential helper prefers it over the machine's own login, so a run's git now asks with that token scrubbed out.
- `dispatch enable` asks the same way: an SSH remote passes, an https remote passes when the machine has a login of its own and names the account, and any other transport refuses because a run's git has no credential path for it.
- The boundary is attribution, not isolation: a child under the same account can read that login itself, which the separate dispatcher account is what closes.
