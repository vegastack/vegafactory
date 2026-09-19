# Provisioning the worker box for vegastack/vegafactory

The always-on Mac mini runs the GitHub Actions runner for trusted jobs (pull request CI runs on GitHub-hosted runners). A second account is kept for the worker, which is being rebuilt (#218). Every step below is a human's own action on the box or on the org's settings; the skill positions the operator, it never reaches for the credential.

The account names, the runner group and the runner name below are proposals, recorded as unconfirmed in `org.md` until the operator confirms them on the box.

## Accounts

Two macOS accounts, neither an admin of the other:

- `vf-runner` — runs the Actions runner and nothing else.
- `vf-worker` — owns the `gh`, Claude, and Codex credentials, and will run the worker.

The split is the whole point: a CI job runs as `vf-runner` and so **cannot read** the tokens in `vf-worker`'s home — a workflow edited in a pull request gets a repository token and no more. The GitHub App private key is never on this box; it lives in org settings as the secret `VEGAFACTORY_APP_PRIVATE_KEY`.

## Toolchain

Installed system-wide so both accounts see the same versions:

- git and the Xcode command line tools — `xcode-select --install`.
- bun 1.3.14 — `bun --version` prints exactly `1.3.14`, matching the workspace `packageManager` pin.
- Node 24 — `node --version` prints a `v24.` line.
- gh 2.97 or newer — `gh --version`, first line; the board mirror needs that floor.

CI jobs get their own bun and Node from `setup-bun` and `setup-node`, so these copies serve `vf-worker` and stand as the fallback.

## Power and login

- `sudo systemsetup -setcomputersleep Never`
- `sudo pmset -a sleep 0 disksleep 0 womp 1`

On macOS a per-user LaunchAgent loads only inside that account's GUI session, so exactly one account may rely on auto-login. Give it to `vf-runner`. Whatever runs as `vf-worker` must pass the same reboot drill in `## Verify`.

## Grant the group

Org-admin commands, run in an admin's own session (`vf-worker`'s, or any admin's machine) — never as `vf-runner`, whose account holds no `gh` credential by design. The group must exist before the runner registers into it (`config.sh` exits non-zero on an unknown group), and the repository must be granted to it before a job can land. Look the group up first; create it only when the lookup prints no such row:

```sh
gh api orgs/vegastack/actions/runner-groups -q '.runner_groups[] | "\(.id) \(.name) \(.visibility)"'
gh api -X POST orgs/vegastack/actions/runner-groups -f name=vegastack-macs -f visibility=selected
gh api -X PUT orgs/vegastack/actions/runner-groups/<GROUP_ID>/repositories/$(gh api repos/vegastack/vegafactory -q .id)
gh api -X POST orgs/vegastack/actions/runners/registration-token -q .token   # the registration token for the block below; it expires in an hour
```

An ungranted group **queues jobs forever with `runner: null` rather than failing** — that is how the 01-09-2026 probe presented, and it is indistinguishable from a slow runner until you read the group. A missing group is the louder failure: registration refuses it on the spot.

## Register the runner

As `vf-runner`, with the registration token from the block above pasted into `RUNNER_TOKEN` — nothing here calls `gh`, because this account is the one that must never hold a credential:

```sh
set -e
RUNNER_TOKEN=<paste the registration token here>
RUNNER_VERSION=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')
test -n "$RUNNER_VERSION"
mkdir -p "$HOME/actions-runner" && cd "$HOME/actions-runner"
curl -fsSL -o runner.tar.gz \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"
tar xzf runner.tar.gz && rm runner.tar.gz
./config.sh --url "https://github.com/vegastack" --token "$RUNNER_TOKEN" \
  --runnergroup vegastack-macs --name mac-mini-1 --unattended --replace
./svc.sh install && ./svc.sh start && ./svc.sh status
```

## Verify

```sh
gh api orgs/vegastack/actions/runner-groups/<GROUP_ID>/runners -q '.runners[] | "\(.name) \(.status)"'
ps -axo user,command | grep '[R]unner.Listener'
```

The first prints `mac-mini-1 online` — the org endpoint is the one that lists a group's runners, while `repos/vegastack/vegafactory/actions/runners` lists repository-level runners. The second prints `vf-runner` and never `vf-worker`.

Then the reboot drill: `sudo reboot`, wait for the box, and run both checks again **without logging anything in by hand**. A box that needs a human at the keyboard after a power cut is not always-on.
