---
name: vegafactory-setup
description: Bootstrap and maintain the org control room — the org, group, people, repos, boards, rules, onboarding, and template files whose defaults every repo's dev profile layers on. Use when asked to "set up the control room", "bootstrap the org for the factory", "register this repo in the control room", "onboard a teammate", "add someone to the org", or "what are the org defaults here", and when a repo's control-room knob names a control room that does not exist yet. Not for a single repo's profile, labels, or knobs (dev-setup), not for architecture advice (dev-architect), not for writing or approving issues (dev-intake), and not for refreshing the local control-room clone (the `vegafactory sync` command).
---

# vegafactory-setup

Act: give the org one control room, so every repo inherits the answers it would otherwise be asked for.

The control room is `<org>/vegafactory-control-room` — the org profile, the department groups, the people, the repo and board registries, the org-wide rules, the onboarding checklists, and the templates. `dev-setup` reads it before its interview and states an inherited knob instead of asking for it. The layout, the precedence rule, the read path, and what each file may carry live in [control-room](references/control-room.md); this file is the procedure.

Nearest neighbor: `dev-setup` owns one repo's profile — its knobs, labels, runbooks, and AGENTS.md section. This skill owns the defaults that profile layers on. When the question is "what should this repo do", that is dev-setup; when it is "what should every repo do", it is this one.

## Bootstrap — the org questionnaire, then the files, then a stop

1. **Ask the questionnaire.** Only what `org.md` holds and nothing a department owns: the org name, the goals in one paragraph, and what applies to everyone — the language, the date format (DD-MM-YYYY across the workflow), the "nothing ships without the operator's explicit instruction" stance, and the three statistics lines `stats:`, `stats-people:`, `stats-override:`. A knob a department decides — review, gates, merge, the harness policy — is never asked here, because two departments reading one org answer would each need the other's to be wrong.
2. **Render every template** in `assets/control-room/` into a working directory the operator can read before anything is pushed: `org.md`, `people.csv`, `decisions.md`, `groups/dev/{group.md,people.csv,decisions.md}`, `repos.md`, `boards.md`, `rules/`, `onboarding/`, `templates/`. `people.csv` is seeded from `gh api orgs/<org>/members -q '.[].login'` — the logins come from the API, every `role` is asked for, and a role nobody answered stays unrecorded. Rendering is otherwise substitution only: a template is a default, and a default nobody has confirmed is still a default.
3. **Stop before the repository exists.** Creating the org repository, granting anyone access, and recording anyone's role are the operator's own account actions. Name the exact commands, say what each one does, and let the operator run them. The skill positions the operator; it does not reach for the credential.

**Nothing secret goes in any file — names of secrets only.** A control room is readable by everyone the org onboards, so `NPM_TOKEN` is the entry and the value stays in the store that name points at.

## Round — automation identity

The org's automated writes go out as the public GitHub App, not as a person's token. This round records the App by name and stops at every step that needs the operator's own account.

1. **Hand the operator the creation walk** in dev-setup's `references/github-app.md` — the permission table, the "Any account" setting, the webhook left off, and the private-key step — rather than restating it here, so the App's contract has one home and one place to update.
2. **Detect an existing installation:** `gh api orgs/<org>/installations --jq '.installations[] | select(.app_slug == "vegafactory") | .id'`. Write the returned id onto `org.md`'s `app-install:` line.
3. **Leave the line as an unconfirmed placeholder when the call answers 403 or returns nothing, and say which happened** — the endpoint answers organization owners only, so a 403 means "not an owner", never "no App". An unconfirmed line is a question the next run asks again.
4. **Never create the App, never ask for the PEM, never write a secret value into any control-room file.** Generating the private key is a browser download GitHub delivers once, to whoever pressed the button; an automated session's download never reaches the operator. Record the two names, `VEGAFACTORY_APP_ID` and `VEGAFACTORY_APP_PRIVATE_KEY`, and leave the values in GitHub org settings.

## Round — the board

A board mirrors the state labels; it never drives them. This round records the board and hands the operator every command that touches a project.

1. **Offer the board on the operator's yes**, one plain sentence: labels drive the workflow and the board follows, one way — a card dragged on the board is cosmetic until the next label change.
2. **Run nothing that mutates a project.** Creating a board, replacing its Status field, linking a repo and switching on the built-in automations all need the `project` scope on the operator's own token. Hand them the sequence in [control-room](references/control-room.md)'s `## Boards` section verbatim, starting with `gh auth refresh -s project`.
3. **Write the `boards.md` row** from `assets/control-room/boards.md.template` — board title, number, the repos mirroring onto it, and a notes cell — once the operator reports the number.
4. **Set `board: <n>`** in each linked repo's `.vegastack/dev.md`, and leave it at `none` for a repo with no board; the workflow reads that line and does nothing when it says `none`.
5. **Record a blocked repo rather than working around it:** where the org plan's auto-add cap refuses another board workflow, the row in `boards.md` says so with its date and the request goes back to the operator.

## Seeding `groups/<g>/group.md`

A group file carries one default for every knob a group can decide for a repo's `.vegastack/dev.md` — per-repo facts such as `repo:`, `skill-scan:`, `board:` and `control-room:` stay in the repo — so a repo that answers nothing else still gets a complete profile. Seed it from an existing repo's dev.md: confirmed knob lines transfer verbatim, including `harness-policy:`, because a group file uses the same parser. When no confirmed policy exists, use dev-setup's refresh-tracked harness selection and flag mapping in `references/harness-facts.md`; this skill does not freeze vendor model/version defaults. <!-- mirrored -->

A knob whose value differs between two repos in the group is a question, not an average: ask which one is the group's default, and let the other repo keep its hand edit — the precedence rule already protects it.

## `register <repo>`

1. Confirm which group the repo belongs to.
2. Run `dev-setup` in the repo. It reads the control room first, so every inherited knob is stated rather than asked, and only what no layer answers reaches the interview.
3. Append the repo's row to `repos.md` — repo, group, board, owner.
4. Link the board when `boards.md` names one for the group, and copy the board-mirror workflow and the CODEOWNERS pattern from `templates/` and `rules/`.
5. Confirm the repo's `control-room:` knob names this control room and this group.

The full checklist ships as `onboarding/new-repo.md`, so the org can edit the procedure without editing this skill.

The org's third onboarding path is a machine rather than a repo or a person: `onboarding/dispatcher-box.md` provisions the always-on box that runs the Actions runner and the dispatcher, under two accounts so a CI job cannot read the dispatcher's tokens.

## `onboard <login>`

Walk `onboarding/new-teammate.md` with the person: `gh auth login` at or above the group's `gh-floor:`, the harnesses the group's `harness-policy:` line names, `vegafactory skills add --group dev --global`, control-room read access, and the Slack subscription through the official GitHub Slack app. Then add their `people.csv` row — `login,name,role,slack,timezone,groups`.

**A person's `role` is descriptive and recorded only on the operator's word**, never inferred from org membership. It grants no people-level read authority. Cross-person visibility comes only from the resolved organization/group administration capability and repository read scope in [control-room](references/control-room.md). A group-level row overrides descriptive membership for the same `login`; it cannot override an organization lock or create administration authority without the exact organization delegation.

## The declined step

Every step here can be declined, and a declined step is recorded, not skipped: write it into `org.md`'s `## Unconfirmed` section as one line, in the same form `dev-setup` writes for a knob it could not confirm. The next run asks again. An unrecorded decline becomes an assumption, and an assumption in a file every repo inherits is the most expensive kind.

A control room that does not exist yet, or that the caller cannot read, is not an error either: say which answers could not be inherited and let `dev-setup` ask them.

## Routing

| Need | Read |
|---|---|
| the file tree, precedence, read path, `people.csv` rules | [control-room](references/control-room.md) |
| comment markers, operator identity, register line format, labels | dev-setup's `references/conventions.md`, installed beside this file |
| the seed text of any control-room file | `assets/control-room/<file>.template` |
