# Metric version 2

CLI and dashboard use the same definitions and producer-to-reader conformance fixture. Transport schema version 2 and metric definition version 2 describe different contracts. Legacy JSONL and historical summaries keep their original bytes and are labelled **legacy definitions**; their inferred zeros and cumulative counters are not promoted into measured v2 totals.

| Metric | Unit and denominator |
|---|---|
| Execution events | Terminal segment events, deduplicated by destination and event ID. A continued execution can have several terminal segments. |
| Logical executions | Distinct attributed `executionRef` values. Missing identities are reported separately; segment count is not a task count. |
| Outcomes | One terminal outcome per execution event. Activity and snapshot records never enter this denominator. |
| Runtime | Reported seconds per terminal segment, with known/unknown coverage. |
| Tokens | Reported input, output, cache-read and cache-write counts, each with independent coverage. Cache inclusion remains unknown until the harness is qualified; these columns must not be blindly added together. |
| Reported cost | USD as reported by the producer. A partial sum carries its measurement coverage. |
| API-equivalent estimate | A separately labelled nullable USD estimate, with supplied price URL, checked date, model, currency and price-version digest. Normal reporting never fetches prices per run. |
| Subscription fee | One nullable report-level `{amount,currency,period,source}` supplied by verified operator/account evidence. It retains its currency and billing month, is not allocated across tasks, and is not added to reported cost or estimates. Normal runtime has no fee until an evidence adapter supplies one. |
| Operator effort | Explicitly supplied minutes. Runtime, comments, reviews, fixes and handbacks do not measure human time. |
| Merged coding completion | Unique accepted issues and separately labelled accepted tasks whose verified delivery PR merged into `main` during the UTC month. Task subtotals are not added to issue totals. |
| Implemented | Accepted child source integrated into the parent. This is separate from merged completion. |
| Released | The task's first verified published non-draft release, using the pinned release tag's commit and verified merged-delivery ancestry. Later containing tags do not release the task again. |
| Monthly rework | Unique typed review, fix and handback activities in the UTC month. **Corrections means fixes**, not the sum of three process stages. |
| Lifetime rework | Latest authoritative retained as-of snapshot, with its date. It is not the sum of twelve monthly files. Expired/missing history is unavailable. |
| Skill association | Whole execution cost associated with every skill used. These values are nonadditive and do not establish marginal cost, savings or ROI. |

A numeric summary carries `{value,known,unknown,availability,definitionVersion:2}`. `[null,null]` has no known total; `[0,null,3]` has total 3, two known observations and one unknown. Zero is displayed only when measured or when the complete authorized source universe establishes zero. An empty execution stream has count zero and unknown usage totals.

Periods are `[UTC month start,next UTC month start)`. The default is the current UTC calendar month; `--since MON-YYYY` explicitly selects a multi-month window. Dotted repository names are supported. Event occurrence time determines an activity month; the file containing a run does not determine when its task merged or was released.

```sh
vegafactory stats --json
vegafactory stats --me --since SEP-2026 --json
vegafactory stats rollup --since SEP-2026 --json
vegafactory stats activity --org acme --repo acme/project.docs --month 2026-09 --json --config /absolute/path/factory.json
```

The activity command reads only. It uses the explicitly selected configuration and current verified viewer/repository policy. The rollup command stores sanitized derived discovery results beside local summaries; neither command authorizes a push. Normal reporting delivery retains its separate authorization and immutable transport.

Discovery enumerates all-state issues, comments, timelines and candidate PRs independently of execution months. It pins the private coordination branch, enumerates its complete nonrecursive task tree, and uses the shared owner's retained-task and historical receipt validators. A current edited brief does not replace an immutable accepted scope. A missing/tampered receipt, partial accepted task set, unverified child-to-parent relationship or preparation-only record cannot become a completed issue.

A PR's commits endpoint caps at 250 commits. Count mismatch or a larger PR requires independently verified exact parent delivery/range/tree evidence. Release metadata and tag references are pinned and reread; a mutable source changing during discovery refuses that generation. The collector shares a 60-second repository deadline, 10-second reads, 100 page/work limit and 8 MiB byte limit. The bridge permits three child processes and 65 seconds per child. Exhaustion is unavailable coverage, not a smaller complete universe.

Incomplete refreshes retain the last complete collection and its **original** observation time and source digest. Local ingestion time is separate metadata. Legacy mutable review/ledger/handback counters become dated unknown snapshots, not invented monthly events. Typed snapshot differences require matching task/counter epoch, complete history at both exact boundaries and monotone counters; missing endpoints, resets or expired history make the difference unavailable.

Task owner and agent-account owner are separate dimensions. Null ownership is an explicit aggregate bucket, never a synthetic person. Person metrics use only the corresponding ownership on attributed transport records; repository discovery has no ownership and is never assigned wholesale to a person. Account-owner lifetime is unavailable where the snapshot schema supplies no account owner. Non-attributed/off policy cannot supply task/person metrics, including after a failed cache refresh.

The dashboard resolves current authorization before cache ingestion, options, lists, details, totals and fallback summaries. `allowedRepos:[]` denies all rows; `null` is an explicitly authorized unbounded scope. Display filters cannot widen authorization. A person context carries its subject and ownership dimension; generic aggregate queries refuse that grant. Cache rebuilds include source associations, unique events and metric metadata in one transaction. The separately packaged dashboard must bundle the shared metric/validation code; installed packaging qualification remains a release check.
