# vegastack — org profile

The org's global answers. Everything here applies to everyone, in every group and every repo. Group defaults live in `groups/<g>/group.md` — layout, precedence, and the read path are the vegafactory-setup skill's `references/control-room.md`.

org: vegastack

## Goals

VegaStack builds agent-native developer tooling: the skills that run an issue-driven workflow, the VegaFactory CLI that installs them, and the runtime — worktrees, hooks, workers, boards, and statistics — that turns an approved issue into finished, reviewed work with every gate that matters left in a human hand.

## What applies to everyone

- language: English — the language every artifact is written in.
- dates: DD-MM-YYYY — the date format in every register, approval, and revision line.
- Nothing ships without the operator's explicit instruction — no push to a default branch, merge, tag, publish, or deploy on green checks, schedules, or standing approvals alone. Per issue the operator gives two words: an ack to build and "ship it" to land it.
- Secrets are named here, never written here. A runbook names `NPM_TOKEN`; the value lives in the secret store that name points at.

## Knobs

A line marked `# locked` is the org's to change. Every other line here is a default a group or a repo may answer differently.

provider-mode: subscription-only   # locked — runs bill to the operator's subscription, never an API key
stats: on                          # a run is recorded
stats-people: off                  # no per-person fields

## Automation identity

The names of the org's automation identity. Values live in GitHub org settings; nothing here is a secret.

app: VegaFactory   # the public GitHub App every automated write uses; humans still own issues
app-slug: vegafactory   # GitHub's slug for the App name — a bot edit shows the actor vegafactory[bot]
app-install: 158664419   # the installation id, on all repositories, current and future
app-secrets: variable VEGAFACTORY_APP_ID · secret VEGAFACTORY_APP_PRIVATE_KEY   # names only
app-permissions: Issues read/write · Projects (organization) read/write · Metadata read · Pull requests read/write · Contents read/write · Workflows none   # widening any of these is a register line

## Unconfirmed

Lines the operator has not confirmed yet. Each is a question the next run asks again rather than an answer anyone may assume.

- 18-09-2026 — the two macOS account names, the runner group and the runner name in `onboarding/worker-box.md`: the checklist carries proposals, and the operator confirms them on the box.
