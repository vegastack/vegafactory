---
"@vegastack/vegafactory": patch
---

Checks now run once each before merge: a pre-commit hook runs the fast checks, `bun run test:affected` runs only the tests a change can reach, and the merge queue runs the full suite, pack smoke and skill scan. The plan format and skill-authoring guidance name these commands.
