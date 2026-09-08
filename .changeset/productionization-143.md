---
"@vegastack/vegafactory": major
"@vegastack/vegafactory-dashboard": major
---
Keep captured telemetry durable, bound to its organization, and counted once across delivery retries.

- Store immutable events and stable capture identities; managed hooks resolve private owned sessions before capture.
- Preserve one reporting execution identity across separate immutable terminal segments after recovery; replay older pending segments only from their exact retained snapshots, and keep quota retries in their current segment.
- Stop promptly on refused spool claims and preserve abandoned guards for offline recovery; retry only live-owner contention.
- Reconcile exact remote bytes against retained sanitized attempts, including after a crash or policy change, and preserve unrelated writer work.
- Require explicit legacy migration, preserve original records, and expose corrupt or conflicting data for inspection.
- Deduplicate event identities and semantic activity before CLI and SQLite ingestion; protect undelivered records during retention.
- Route production export and typed reading through the current privacy serializer and reader; preserve pending reporting independently of task success.
