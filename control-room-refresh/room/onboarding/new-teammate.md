# Onboarding a teammate into vegastack

Run by `vegafactory-setup onboard <login>`. Every step below is the person's own action on their own machine; the skill positions them and verifies the result, it never reaches for their credentials.

1. `gh auth login` — GitHub CLI, at or above the group's gh-floor.
2. Install the harnesses the group's `harness-policy:` line names, and sign each one in.
3. Install the skills: `vegafactory skills add --group dev --global`.
4. Control-room read access — the operator grants it; confirm with `gh repo view vegastack/vegafactory-control-room`.
5. Subscribe to the org's Slack channel through the official GitHub Slack app; notifications are GitHub assignment plus Slack, nothing else.
6. Add the login to the group's `operators:` line if they will own issues in that group.

`operators:` is the one place a person is recorded, and only on the operator's word — never inferred from org membership.
