---
"@vegastack/vegafactory": minor
---

VegaFactory can now keep its global CLI current without asking an agent to perform the update.

- `vegafactory update` compares the installed and published versions, runs `npm install -g @vegastack/vegafactory@latest` when needed, and reports the version before and after. `--dry-run` reports what it would do and installs nothing, like every other command that takes the flag.
- The registry is npm's own, or whatever `npm_config_registry` names, so a machine behind a mirror or a private registry is asked the same question its `npm install` would be.
- A version with a prerelease tag is correctly behind the release of the same number, so a machine on `1.0.0-rc.1` is told `1.0.0` is newer instead of being left there.
- A `.vegastack/dev.md` that exists and cannot be read stops the update rather than falling back to the shipped `auto`: the file that could not be read may be the one saying `off`. A profile that is simply absent still gets the default.
- Attended session starts check from every repository and carry the result in session context; automatic installs are detached with their own five-minute bound and never re-enter the file being replaced.
- Unattended workers update only between passes with no agent running, then restart on the newly installed copy.
- `vegafactory-update: off | notify | auto` controls the behavior, defaults to `auto`, and ships in new dev profiles.
- npm is asked at most once an hour and the answer is remembered in `~/.vegafactory/update.json`. An idle worker polls every couple of minutes; asking each pass was hundreds of calls a day for a version that changes weekly. A registry that cannot be reached is never remembered, so a moment of npm being down does not hold a machine on a stale version for the rest of the hour.
- A background install outlives the session that started it, so the next session says how it went — `updated X → Y`, or that it did not finish and the machine is still on the old version. Either is said once and then forgotten rather than repeated at every session.
