---
"@vegastack/vegafactory": patch
---

A self-hosted factory now trusts the GitHub App identity that writes its coordination artifacts.

- `VEGAFACTORY_APP_ID` and `VEGAFACTORY_APP_ACTOR` select the App together; setting only one refuses `worker enable` and `worker run` by name instead of minting as one identity and trusting another.
- A worker's child runs inherit the two non-secret identity values while the private-key path remains stripped, and `worker enable` writes them, with `VEGAFACTORY_APP_PRIVATE_KEY_FILE`, into the launchd or systemd unit it installs, quoted so a path with a space or a `%` in it survives systemd's own parsing, then reloads the service onto that unit. launchd keeps the job definition it was bootstrapped with, and systemd leaves an active service alone on `enable --now`, so re-enabling after an upgrade or an identity change used to report success while the running worker kept the old one. Enabling now unloads first; a machine enabling for the first time has nothing to unload, and only that failure is tolerated — a permission error leaves the old definition loaded and must not be reported as enabled. A user service does not inherit the shell that installed it, so without that the worker restarted as VegaStack's own App — minting with a self-hosted key against the wrong id, then distrusting everything that App wrote, with `enable` having reported success.
- Every command checks the pair once, before it reads anything, and refuses by name when only one is set. It used to throw an uncaught error — the hook included, and the hook carries the ship guard. Carrying on as though no App were configured would have been worse than either: an App-authored claim would read as absent, so a second machine would be told an issue is free while another is already working it.
- The shipped App guide distinguishes VegaStack's values from examples a company must replace.
