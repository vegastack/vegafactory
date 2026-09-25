---
"@vegastack/vegafactory": patch
---

Worker record corruption now refuses service changes, and attended enablement safely privatizes and rotates worker state and logs.

- Runtime acted, child, run, and lock records accept only absent or complete schema-valid private files.
- Disable validates current and legacy child authority before unloading and preserves the unit, records, and processes on refusal.
- Enable stops first, migrates valid legacy state, replaces append targets with fresh `0600` inodes, and resumes interrupted log migration without duplication.
- Malformed or unsafe legacy evidence is quarantined under the owner-only worker home and reported for inspection.
