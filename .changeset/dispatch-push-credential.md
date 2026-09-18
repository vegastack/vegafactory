---
"@vegastack/vegafactory": patch
---

A dispatched run pushes over HTTPS with the machine's own GitHub login, so enrolling a dispatcher no longer means adding an SSH key. The App's token is for the API and cannot write code, and `gh auth git-credential` prefers it over the login the machine already has — so a run's Git now asks for a credential with that token scrubbed from the environment, and gets the machine's own back. `dispatch enable` checks the same way: an SSH remote passes outright, and an HTTPS remote passes when the machine has a login of its own, naming the account it would push as. It refuses when the only credential available is the App's, because a run would otherwise finish its work and fail at the push.
