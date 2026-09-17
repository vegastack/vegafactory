---
"@vegastack/vegafactory": minor
---

New: `vegafactory init` sets up a machine in one command; `skills update` brings installed skills up to date and keeps locally edited copies; installs are global by default. New `vegafactory issue` commands keep a local copy of each issue under `.vegastack/.tmp/issues/`, report only what changed, write back through GitHub, record acks, and check an issue before planning, building or shipping. Workflow labels are now `waiting-on-operator`, `planning`, `queued`, `in-progress` and `ready-to-ship`, with sizes `small`, `medium`, `large` and `research`. Headless agent runs refuse API-key billing and name the variable to unset.
