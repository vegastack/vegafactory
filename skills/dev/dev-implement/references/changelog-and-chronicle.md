# Changelog and chronicle

The mechanics behind dev-implement's hand-back rule: every behavior-changing branch carries its changelog entry and, when dev.md says `chronicle: on`, its story entry — both on the branch, so they land atomically with the merge. The body owns the rule; this file owns how each knob value is satisfied.

## Per knob

dev.md's `changelog:` knob names the convention; the entry is always written directly, never through an interactive tool.

| `changelog:` value | What to write |
|---|---|
| `changesets` | `.changeset/<slug>.md`, written as a file — never the interactive CLI |
| `keep-a-changelog` / `pubspec+changelog` | one bullet under `## [Unreleased]` in CHANGELOG.md; when the file is absent, create it in the same branch with the `# Changelog` + `## [Unreleased]` skeleton |
| `none` | nothing — the project keeps no changelog |

## The first line

A changeset entry's first line is **one plain sentence** naming the change in behavior terms; detail follows after a blank line as sub-bullets, one line each. The published changelog and the release notes that lead with it reproduce the entry verbatim, so a single 1,000-character sentence ships as a wall of text.

## Chronicle

When dev.md says `chronicle: on`, the story entry is prepended to `.vegastack/chronicle.md` in the format the `dev-status` skill owns (title, what, why, how it went, what changed, decisions; voice per dev.md's `chronicle-style:` and `emoji:` knobs). It is written on the branch alongside the changelog entry, so the merge carries both or neither.
