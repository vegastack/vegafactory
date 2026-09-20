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
- npm exiting zero says the command ran, not that the machine has the new copy. The version it reports afterwards is the evidence: the new one is an update, the old one is a failure however npm exited, and no usable answer is reported as unconfirmed rather than announced as a success nobody checked.
- One background install at a time. Two sessions opened a minute apart each started their own, over each other, and each reset the clock the failure report is measured from.
- A worker only updates on a pass that saw an idle board: everything read, nothing picked up, nothing still running. A pass that threw, could not read an issue, or started work that settled again before the check is not an idle pass.
- Each pass records the control-room commit it fast-forwarded to, so a clone that is merely up to date is not read as one that has been tampered with — which had every later policy question answer "cannot tell".
- Attended session starts check from every repository and carry the result in session context; automatic installs are detached with their own five-minute bound and never re-enter the file being replaced.
- Unattended workers update only between passes with no agent running, then restart on the newly installed copy.
- `vegafactory-update: off | notify | auto` controls the behavior, defaults to `auto`, and ships in new dev profiles.
- npm is asked at most once an hour and the attempt is remembered in `~/.vegafactory/update.json` — the attempt, not just a successful answer, so a registry that is down costs one call an hour rather than one every pass, and an install that failed is not retried until the next hour either. An idle worker polls every couple of minutes; asking each pass was hundreds of calls a day for a version that changes weekly. - A background install outlives the session that started it, so the next session says how it went — `updated X → Y`, or that it did not finish and the machine is still on the old version. Either is said once and then forgotten rather than repeated at every session.
