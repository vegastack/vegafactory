# Onboarding a repo into vegastack

Run by `vegafactory-setup register <repo>`, then `dev-setup` inside the repo.

1. Confirm the repo's group. `groups/<g>/group.md` is the default set the repo layers on.
2. Run `dev-setup` in the repo. Every knob the control room already answers is stated as inherited, not asked.
3. Add the repo's row to `repos.md` — repo, group, board, owner.
4. Link the board if `boards.md` names one for this group, and add the board-mirror workflow.
5. Create the workflow labels and confirm branch protection on the default branch.
6. Confirm the repo's `control-room:` knob names this control room and the repo's group.

A step the operator declines is recorded as an unconfirmed line in `org.md`, never quietly skipped.
