<!-- vsk:v1 type=evidence rev=1 branch=feat/27-json-flag sha=9b7d0e4 -->
## Result (v1)
**Done:** `scripts/check-links.mjs` accepts `--json` and prints `{ broken: [{ file, broken: [...] }] }` instead of one line per file; exit codes are unchanged (0 clean, 1 broken links, 2 usage). The script header documents the flag and the exit codes.
**Tests:** `bun test tests/check-links.test.ts` → 4 pass, 0 fail (fresh, 0.41s)
**Review:** subagent (Spec, Standards) — round 1 needs-fixes: Finding [1] MUST-FIX, `brokenLinks` renamed to `findBroken` against the brief's out-of-scope line, reverted in c3d4e5f; round 2 clean. Ruling: the JSON report keeps the file-first shape the text output already had, so the two modes stay one data structure — cost if wrong: one key rename.
**Changelog:** `.changeset/27-check-links-json.md` (minor) — "check-links can print its report as JSON with --json."
**Docs:** brief v1, plan v1 — unchanged since approval
**Decision:** none
**Not done / limits:** the flag prints only broken links; a `--all` listing was not asked for.
Branch: feat/27-json-flag @ 9b7d0e4
