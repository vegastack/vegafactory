---
"@vegastack/vegafactory": minor
---

VegaFactory can now keep its global CLI current without asking an agent to perform the update.

- `vegafactory update` compares the installed and published versions, runs `npm install -g @vegastack/vegafactory@latest` when needed, and reports the version before and after.
- Attended session starts check from every repository and carry the result in session context; automatic installs are detached with their own five-minute bound and never re-enter the file being replaced.
- Unattended dispatchers update only between passes with no agent running, then restart on the newly installed copy.
- `vegafactory-update: off | notify | auto` controls the behavior, defaults to `auto`, and ships in new dev profiles.
