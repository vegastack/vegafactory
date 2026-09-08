---
"@vegastack/vegafactory": major
"@vegastack/vegafactory-dashboard": major
---
Keep captured telemetry durable, bound to its organization, and counted once across delivery retries.

- Store immutable events and stable capture identities; managed hooks resolve private owned sessions before capture.
- Reconcile exact remote bytes against retained sanitized attempts, including after a crash or policy change, and preserve unrelated writer work.
- Require explicit legacy migration, preserve original records, and expose corrupt or conflicting data for inspection.
- Deduplicate event identities and semantic activity before CLI and SQLite ingestion; protect undelivered records during retention.
- Refuse production export and typed reading until the privacy serializer and reader are installed; preserve pending reporting independently of task success.
