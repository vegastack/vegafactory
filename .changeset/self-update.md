---
"@vegastack/vegafactory": minor
---

VegaFactory can now keep its global CLI current without asking an agent to perform the update.

- `vegafactory update` compares the installed and published versions, runs `npm install -g @vegastack/vegafactory@latest` when needed, and reports the version before and after. `--dry-run` reports what it would do and installs nothing, like every other command that takes the flag.
- The registry is npm's own over TLS and is not configurable. That answer decides whether a global install of executable code runs unattended, so a redirectable base would let whoever set it choose what the machine installs and then runs as its own user.
- A version with a prerelease tag is correctly behind the release of the same number, so a machine on `1.0.0-rc.1` is told `1.0.0` is newer instead of being left there.
- A `.vegastack/dev.md` that exists and cannot be read stops the update rather than falling back to the shipped `auto`, on both the session and the worker path: the file that could not be read may be the one saying `off`. A profile that is simply absent still gets the default.
- An explicit `vegafactory update` always asks npm rather than reusing the hourly answer, because typing the command is asking for the state now.
- The value that applies is the resolved one — org, then group, then repo — so a locked `vegafactory-update: off` in `org.md` is honoured. Reading only the repo's own file made every inherited value look like a missing one, which meant the shipped `auto`. A profile that cannot be resolved refuses rather than defaulting.
- The install is pinned to the registry the check used and the exact version it returned, on both the foreground and the background path. `npm install -g <name>@latest` otherwise resolves through whatever registry npm is configured with — an `.npmrc`, an `@vegastack:` scope mapping, an inherited variable — so an official registry saying "newer" could install something else entirely and run it as this user.
- npm exiting zero says the command ran, not that the machine has the new copy. The version it reports afterwards is the evidence: the new one is an update, the old one is a failure however npm exited, and no usable answer is reported as unconfirmed rather than announced as a success nobody checked.
- One background install at a time. Two sessions opened a minute apart each started their own, over each other, and each reset the clock the failure report is measured from.
- A worker only updates after a pass that read the whole board. A pass that threw, or that could not read an issue, never learned whether work was waiting.
- Attended session starts check from every repository and carry the result in session context; automatic installs are detached with their own five-minute bound and never re-enter the file being replaced.
- Unattended workers update only between passes with no agent running, then restart on the newly installed copy.
- `vegafactory-update: off | notify | auto` controls the behavior, defaults to `auto`, and ships in new dev profiles.
- npm is asked at most once an hour and the answer is remembered in `~/.vegafactory/update.json`. An idle worker polls every couple of minutes; asking each pass was hundreds of calls a day for a version that changes weekly. A registry that cannot be reached is never remembered, so a moment of npm being down does not hold a machine on a stale version for the rest of the hour.
- A background install outlives the session that started it, so the next session says how it went — `updated X → Y`, or that it did not finish and the machine is still on the old version. Either is said once and then forgotten rather than repeated at every session.
