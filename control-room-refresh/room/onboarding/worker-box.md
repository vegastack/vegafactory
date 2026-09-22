# Provisioning the worker box for vegastack/vegafactory

The always-on Mac mini runs the GitHub Actions runner for trusted jobs (pull request CI runs on GitHub-hosted runners), and a second account runs the worker. Every step below is a human's own action on the box or on the org's settings; the skill positions the operator, it never reaches for the credential.

## Accounts

Two macOS accounts, neither an admin of the other:

- `vf-runner` — runs the Actions runner and nothing else.
- `vf-worker` — owns the `gh`, Claude, and Codex credentials, the GitHub App key, and the worker.

The split is the whole point: a CI job runs as `vf-runner` and so **cannot read** the tokens in `vf-worker`'s home — a workflow edited in a pull request gets a repository token and no more. The App's private key is one of those files: `~/.vegafactory/worker/app.pem` in `vf-worker`'s home, `chmod 600`, the same PEM as the org secret `VEGAFACTORY_APP_PRIVATE_KEY` and readable by nobody else on this box.

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
gh api -X POST orgs/vegastack/actions/runner-groups -f name=vsk-runners -f visibility=selected
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
  --runnergroup vsk-runners --name patrick-mac-mini --unattended --replace
./svc.sh install && ./svc.sh start && ./svc.sh status
```

## Turn the worker on

As `vf-worker`, once that account is signed in to Claude Code and Codex and the App key is in place — with no human `gh` login or SSH key under this account:

1. Add this machine to the control room's `nodes.md` — one row under that file's header, `| vf-worker@patrick-mac-mini | kmanojkumar | yes | vegastack/vegafactory,vegastack/another-repo | | |` — in a control-room PR. The `repos` cell is a comma-separated list of explicit `OWNER/NAME` repositories; an empty cell grants nothing, and `*` or `all` is refused rather than expanded. The header names the columns, so cells are read by what their column is called and not by where they sit. `vf-worker@patrick-mac-mini` is `<os-user>@<hostname>`, and the os-user is **`vf-worker`** — the account these steps run as, not the person's own login, because `worker enable` derives the node from whoever is running it and refuses a row that names anybody else. The hostname is cut to its first label and lowercased. `worker` must say `yes`: that cell is the only thing that grants unattended work. Leave `caps` empty for the shipped defaults, or set it (`runs 10 · step 72h · poll 1m · retry 15m · park 3`, every field optional).
2. In a configured repository checkout, run `vegafactory worker enable`. Global checks cover the row and real `claude -p` and `codex exec` answers; each listed repository then gets its own App identity and token, policy, hooks and push-readiness check. At least one repository must be healthy. A board-level FAIL names the repository to fix without preventing a healthy board from being enabled.
3. A listed repository is cloned on first use into `~/.vegafactory/worker/repos/<owner>__<repo>/repo`. The clone is accepted atomically only after its origin, Git shape, standard Claude and Codex hooks and an App-token HTTPS dry-run push pass; an existing ambiguous path is reported and left untouched.
4. `vegafactory worker status` covers every board, lists unavailable repositories, and names runs as `owner/repo#issue`. `vegafactory worker disable` takes the one machine service away and stops every run it started. Removing one repository from the row hands back only that board's runs without consuming their triggers, then stops polling it; its checkout stays in place for attended reclamation. Removing the whole row stands the machine down at its next poll without deleting any checkout.

Everything this box writes to GitHub goes out as the VegaFactory App — the worker's own bookkeeping and everything the agent runs post. Each board separately mints an hour-long token narrowed to that repository, and only that board's runs receive it in their environment; its identity, policy, issue cache, checkout, readiness and push check are never reused for another board. The App authors the factory's work, and only that: its claims, its status comments and the reviews a worker run posts all count, because each is checked by its own shape. What it can never author is a word of consent — an ack, an acceptance of open findings, a "ship it" and a correction are read only from a person with write access, which is what stops a run approving its own work.

Three things that follow, and one of them will bite on the first run if the box is not set up for it:

- **The App is this account's only GitHub identity.** The App has Contents read/write and Workflows denied. Each run uses its board's repository-scoped token for API calls and HTTPS Git through `gh auth git-credential`; inherited helpers and SSH agents are removed, and readiness proves a nonce-ref dry-run push without creating it. Do not run `gh auth login` or install a human SSH key under `vf-worker`.
- **The key outlives the token.** A run under `vf-worker` can read the key file whatever its mode. That same-user access is accepted for this dedicated App-only account, which is why it has no human credentials and runs nothing else.
- **The caps are per machine, and this row sets them.** `runs 10 · step 72h · poll 1m` in the caps cell, re-read every pass so a change needs no restart. The `runs` cap is one shared budget across every board on this machine; shipping serializes within a repository, while two different repositories may each use their own ship slot. Each machine still has its own retry and subscription-reset deadlines. A step longer than an hour outlives the installation token a run is handed, so its later GitHub writes fail — the worker says so when it starts. Two boxes listed for the same repository can each run three, and one can start work the other is waiting out; a fleet-wide lease is not in place yet.

## Verify

```sh
gh api orgs/vegastack/actions/runner-groups/<GROUP_ID>/runners -q '.runners[] | "\(.name) \(.status)"'
ps -axo user,command | grep '[R]unner.Listener'
launchctl print gui/$(id -u vf-worker)/com.vegastack.vegafactory.worker | head -3
```

The first prints `patrick-mac-mini online` — the org endpoint is the one that lists a group's runners, while `repos/vegastack/vegafactory/actions/runners` lists repository-level runners. The second prints `vf-runner` and never `vf-worker`.

On Linux the third line is `systemctl --user status vegafactory-worker.service` instead, and one more check belongs beside it:

```sh
loginctl show-user vf-worker --property=Linger
```

It must print `Linger=yes`. A `--user` service lives inside a login session and systemd ends that session with the last login, so without linger the worker dies the moment vf-worker logs out — quietly, and hours later. `worker enable` sets it and stops with the failing command if the account may not grant it to itself, which on a locked-down box needs an administrator: `sudo loginctl enable-linger vf-worker`.

**Where state and logs are.** The one machine service keeps `boards.json`, `run.lock`, run/child/acted records, `worker.log` and `worker.err.log` under `~/.vegafactory/worker/`; repositories never get separate worker state or log roots. On Linux the two log files are the whole of the worker's output: the unit redirects its streams, so `journalctl --user -u vegafactory-worker.service` shows systemd's own messages about the service starting and stopping, and nothing the worker itself printed.

Then the reboot drill: `sudo reboot`, wait for the box, and run every check above again **without logging anything in by hand**. A box that needs a human at the keyboard after a power cut is not always-on.

On Linux, the logout drill is separate and the order matters. Log out every session for vf-worker and check from **another** account — logging back in first would start the service again and hide exactly the failure this is looking for:

Log out every session for vf-worker, then check from **another** account — logging back in
would start the service again and hide the very failure this looks for:

```sh
loginctl list-sessions | grep vf-worker || echo 'no sessions, which is the point'
usec=$(busctl get-property org.freedesktop.login1 /org/freedesktop/login1 \
  org.freedesktop.login1.Manager UserStopDelayUSec | awk '{print $2}')
case "$usec" in ''|*[!0-9]*) echo 'cannot read UserStopDelayUSec — do not guess it'; exit 1;; esac
sleep $(( usec / 1000000 + 30 ))
sudo -u vf-worker XDG_RUNTIME_DIR=/run/user/$(id -u vf-worker) \
  systemctl --user is-active vegafactory-worker.service
```

The wait is read from the box rather than guessed. logind keeps a user's manager alive for
`UserStopDelayUSec` after the last session ends — ten seconds by default, settable, and named in
microseconds — so a worker with no linger at all still answers `active` inside that window. The
`busctl` line asks logind's own manager for the value and the `sleep` clears it with thirty seconds
to spare. A value that cannot be read stops the drill rather than standing in for it: assuming the
ten-second default on a box that had been given a longer one is how a worker with no linger passes
this check inside its own grace period.

After that wait it must print `active` while vf-worker has no session. That holds for an idle
worker as much as a busy one, which is why it is the thing to check rather than the log: a pass
with nothing to do writes nothing, and a worker that is merely quiet is not a worker that is dead.
Without linger it prints `inactive`, or cannot reach that user's systemd at all.
