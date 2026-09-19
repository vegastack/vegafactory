---
"@vegastack/vegafactory": minor
---

A node knows its own name: `<os-user>@<hostname>`, for example `mk@patrick-mac-mini`.

- Derived, never configured, so there is nothing to set up and nothing to drift. Two people sharing one machine are two nodes; one person with three machines is three nodes and one owner, which is what makes "everything this person did" answerable across machines.
- The hostname is cut to its first label, because that is the part that names the machine: `os.hostname()` answers `patrick-mac-mini.local` on macOS and a full domain name on many Linux hosts, and neither belongs in an identity somebody has to recognise in a table. `scutil --get LocalHostName` gives the clean name directly but exists only on macOS, and this has to be one rule on both.
- Both halves are normalised by the same rule, so an id cannot come out half-tidied, and a name that normalises to nothing still leaves something readable rather than a bare `@host`.
- Deliberately a new function rather than a change to `machineName`, which maps every non-alphanumeric to a dash — it would have turned this into `mk-patrick-mac-mini`, and it is what `ownerId` stamps on every session claim that exists right now.
