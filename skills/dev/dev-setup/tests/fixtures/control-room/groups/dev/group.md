# dev — group defaults

One default for every knob a repo's `.vegastack/dev.md` can hold, so a repo that answers nothing still gets a complete profile. A hand edit in a repo's dev.md beats every line here; this file beats `org.md`, except a line `org.md` marks `# locked`. Precedence and the read path: the vegafactory-setup skill's `references/control-room.md`.

## Knobs

merge: rebase               # rebase | squash | merge
branch: <type>/<slug>       # type: feat | fix | docs | chore | refactor
labels: waiting-on-operator planning queued in-progress ready-to-ship small medium large research risky epic
tests: required             # required | logic-only | best-effort | none
changelog: changesets       # changesets | keep-a-changelog | pubspec+changelog | none
chronicle: on               # on | off
learning: normal-work       # normal-work | off
learning-adoption: scoped-reversible   # scoped-reversible | propose-only
vegafactory-update: auto    # off | notify | auto
operators: kmanojkumar      # the logins who own issues in this group

## Harness policy

One line, `<stage> <agent> <model> <effort>` per stage, separated by `·`. `default` as the model pins nothing and takes the tool's own.

harness-policy: intake claude default high · plan claude default high · implement claude default high · review codex default xhigh · status claude default medium · chronicle claude default medium

## Notes

Lines the workflow reads as prose, not knobs — a repo may say otherwise in its own dev.md.

- architect: kmanojkumar — the architecture owner dev-architect speaks to.
- evidence-repo: vegastack/dev-review-evidence — where UI screenshots and run evidence are pushed.
- ship-environments: preview auto · staging auto · production ask.
- design-system: @vegastack/design — the design layer a repo in this group consumes by default.
- secrets: NPM_TOKEN, CLOUDFLARE_API_TOKEN — NAMES only; the values live in the secret store.
- gh-floor: 2.97 — the minimum gh CLI version this group's automation assumes.
