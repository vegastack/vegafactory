# Refreshing vegastack/vegafactory-control-room

The lean control room is seven things: `org.md`, `groups/<g>/group.md`, `repos.md`, `dispatchers.md`, `boards.md`, `onboarding/`, `stats/`. The live room still carries the old model. `room/` here is the room as it should be, laid out exactly as it lands at the repository root.

**The operator opens this pull request.** Nothing here was pushed or cloned: the room is private, and only a person's own account should write to it.

## What the pull request would change

Added

- `dispatchers.md` — the dispatcher registry, empty, with the rule that a repo reaches a dispatcher only through its group.
- `stats/README.md` — creates `stats/`, the one tree automation writes, and says what a record may and may not carry.

Changed

- `org.md` — a `## Knobs` section replaces `## Statistics policy`: `provider-mode: subscription-only` marked locked, plus `stats: on` and `stats-people: off`. The retired `stats-override:` line goes. `## Unconfirmed` clears: its three entries were the CODEOWNERS team, the dispatcher host and board cells, and Slack handles — the first and last live in files the lean room no longer has, and the other two now have registries.
- `groups/dev/group.md` — the six `harness:` lines become one `harness-policy:` line. The retired `review:` knob and the `dispatcher: TODO confirm` line go. `labels:` moves to the current names (`waiting-on-operator planning queued in-progress ready-to-ship`, sizes `small medium large`); the old list would refuse to resolve. `stats: inherit` goes — a group with no opinion writes no line. The lines the workflow does not read (architect, evidence-repo, ship-environments, design-system, secrets, gh-floor) move under `## Notes` as prose.
- `boards.md` — the stale `vegastack-skills` row goes; that repository is not in this org's registry, and the board it named never existed. The table stays, empty.
- `repos.md` — the `repository-id` column goes; nothing reads it now.
- `README.md` — the file table matches the lean room.
- `onboarding/new-repo.md`, `onboarding/new-teammate.md` — steps that pointed at `rules/`, `templates/` and `people.csv` now point at what is left; a person is recorded on the group's `operators:` line.

Removed

- `people.csv`, `groups/dev/people.csv` — `operators:` in `group.md` is the one place a person is recorded.
- `decisions.md`, `groups/dev/decisions.md` — a decision register lives in the repo whose dev.md names it.
- `rules/` (`CODEOWNERS`, `README.md`) and `templates/` — a repo carries its own CODEOWNERS and its own workflow files.

## Applying it

From a clone of the control room, on a branch:

```sh
git rm -r people.csv decisions.md groups/dev/people.csv groups/dev/decisions.md rules templates
cp -R /path/to/vegafactory/control-room-refresh/room/. .
git add -A
git commit -m "feat: lean control room"
```

Then open the pull request and read the diff before merging. `vegafactory sync` picks the change up on its next refresh.
