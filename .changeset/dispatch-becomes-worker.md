---
"@vegastack/vegafactory": minor
---

`vegafactory dispatch` is `vegafactory worker`. A machine that works a board with nobody watching is a worker, which is what its `nodes.md` row already calls it.

- The verb, the module, the service unit, the claim kind, the `--kind` flag, the on-disk paths and the prose all move together, with nothing left behind to be compatible with. Nothing is deployed and no claim of the old kind exists, so there is no older spelling to carry and get wrong.
- `GhRunner` does not move: "runner" there is the thing that shells out to `gh`, and `worker` was chosen over `runner` precisely so that name — and the Actions runner the onboarding document describes — could stay put.
- A claim whose kind this release does not recognise is read as a session, which is the longer-lived and so the safer answer: read as a worker's, it would be taken over after thirty minutes.
