# Refreshing vegastack/vegafactory-control-room

The lean control room is seven things: `org.md`, `groups/<g>/group.md`, `repos.md`, `nodes.md`, `boards.md`, `onboarding/`, `stats/`. The live room still carries the old model. `room/` here is those seven, laid out exactly as they land at the repository root.

Seven entries are the whole layout, so the live `README.md` goes with the rest of the old model: an eighth top-level entry is one more place for the room's shape to be described, and to drift. What the README said now lives in the skill's `references/control-room.md`, which is the file that has to be right anyway.

**The operator opens this pull request.** Nothing here was pushed or cloned: the room is private, and only a person's own account should write to it.

## What the pull request would change

Added

- `nodes.md` — every machine that runs vegafactory, one row each, with a `worker` column that is the only thing granting unattended work.
- `stats/README.md` — creates `stats/`, the one tree automation writes, and says what a record may and may not carry.
- `onboarding/worker-box.md` — the third onboarding path, which `nodes.md` and the skill both route through: two macOS accounts so a CI job cannot read the worker's tokens, the toolchain, the runner registration and the reboot drill. The account names, the runner group and the runner name in it are proposals; `org.md`'s `## Unconfirmed` says so until the operator confirms them on the box.
- `org.md`'s `## Automation identity` block — the App name, slug, installation id (`158664419`, from dev-setup's `references/github-app.md`), the two secret **names** and the granted permissions. The live `org.md` never carried this block although the skill and its template both require it; nothing in it is a secret.

Changed

- `org.md` — a `## Knobs` section replaces `## Statistics policy`: `provider-mode: subscription-only` marked locked, plus `stats: on` and `stats-people: off`. The retired `stats-override:` line goes. `## Unconfirmed` clears: its three entries were the CODEOWNERS team, the dispatcher host and board cells, and Slack handles — the first and last live in files the lean room no longer has, and the other two now have registries.
- `groups/dev/group.md` — the six `harness:` lines become one `harness-policy:` line, with `default` in every model position: `default` takes each tool's own current model, and the ids the old lines pinned are not ones this subscription can be relied on to have. Each stage keeps its agent and its effort. The retired `review:` knob and the `dispatcher: TODO confirm` line go. `labels:` moves to the current names (`waiting-on-operator planning queued in-progress ready-to-ship`, sizes `small medium large`); the old list would refuse to resolve. `stats: inherit` goes — a group with no opinion writes no line. The lines the workflow does not read (architect, evidence-repo, ship-environments, design-system, secrets, gh-floor) move under `## Notes` as prose.
- `boards.md` — the stale `vegastack-skills` row goes; that repository is not in this org's registry, and the board it named never existed. The table stays, empty.
- `repos.md` — the `repository-id` column goes; nothing reads it now.
- `onboarding/new-repo.md`, `onboarding/new-teammate.md` — steps that pointed at `rules/`, `templates/` and `people.csv` now point at what is left; a person is recorded on the group's `operators:` line.

Removed

- `people.csv`, `groups/dev/people.csv` — `operators:` in `group.md` is the one place a person is recorded.
- `decisions.md`, `groups/dev/decisions.md` — a decision register lives in the repo whose dev.md names it.
- `rules/` (`CODEOWNERS`, `README.md`) and `templates/` — a repo carries its own CODEOWNERS and its own workflow files.
- `README.md` — the layout is seven entries and this was the eighth. It described the room; `vegafactory-setup`'s `references/control-room.md` describes it now, in the one place that also has to be right for every other org.

## Applying it

From a clone of the control room, on a branch:

```sh
git rm -r README.md people.csv decisions.md groups/dev/people.csv groups/dev/decisions.md rules templates
cp -R /path/to/vegafactory/control-room-refresh/room/. .
git add -A
git commit -m "feat: lean control room"
```

The tree that leaves is exactly `org.md`, `groups/`, `repos.md`, `nodes.md`, `boards.md`, `onboarding/` and `stats/`. Then open the pull request and read the diff before merging. `vegafactory sync` picks the change up on its next refresh.
