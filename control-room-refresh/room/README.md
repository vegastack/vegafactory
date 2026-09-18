# vegafactory-control-room

The org control room for **vegastack**. Every repo's `.vegastack/dev.md` layers on the files here, so a repo inherits the answers another repo already gave.

| File | Holds |
|---|---|
| `org.md` | what applies to everyone: the org name, the goals, the org-wide knobs |
| `groups/<g>/group.md` | department defaults — one line per knob a repo's dev.md can hold |
| `repos.md` · `boards.md` · `dispatchers.md` | the repo, board and dispatcher registries |
| `onboarding/` | the new-repo and new-teammate checklists |
| `stats/` | the usage records machines append, one file per operator, per machine, per day |

**Precedence, nearest wins:** a repo's `.vegastack/dev.md` beats `groups/<g>/group.md`, which beats `org.md`, which beats the skill defaults. The exception is a line `org.md` marks `# locked`: no group and no repo may change it.

**Nothing secret goes in any file here — names of secrets only.** This repository is readable by everyone the org onboards.

Seeded and maintained by the `vegafactory-setup` skill. Lines nobody has confirmed are listed under `## Unconfirmed` in `org.md`, so the next run asks again instead of assuming.
