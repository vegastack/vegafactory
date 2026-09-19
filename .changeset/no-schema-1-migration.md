---
"@vegastack/vegafactory": minor
---

`factory.json` is read at schema 2 and nothing else — the schema 1 reader and its migration are gone.

- A document at any other `schemaVersion` is refused by name rather than migrated, and the file is left exactly as it was. It holds the operator's own settings, so rewriting it on the strength of a version number would lose whatever the writer meant by them.
- Nothing is written to `factory.json.schema1.bak` any more, because nothing is converted. A file already at schema 2 — which is every file this project has — is unaffected.
- `revision` is now always present and always checked, instead of only on schema 2.
