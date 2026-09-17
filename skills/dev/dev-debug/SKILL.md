---
name: dev-debug
description: Reproduce-first bug work. Use when given a bug to fix — "debug this", "this is broken and I don't know why", "users report X fails", "login intermittently 500s", implementing a fix-type issue whose brief carries a Reproduction section, or when a fix keeps not fixing the symptom. Not for writing the bug up as an issue (dev-intake), building planned features (dev-implement — this skill governs the diagnosis inside its dark mode), or reviewing a finished fix (dev-review).
---

# dev-debug

Act: reproduce first, then shrink, suspect, test, prove and clean, in that order, because a fix without a red command fixes a guess.

The failure this skill prevents: reading code, forming one theory, and "fixing" something that was not the cause. The discipline is a hard order — **reproduce, shrink, suspect, test, prove, clean** — and each phase has a completion criterion you can check, not vibe. It runs inside dev-implement's dark mode: no operator questions; missing-artifact stops are one `handback` comment; every phase result is a ledger checkpoint.

Nearest neighbors: `dev-intake`'s bug variant writes the brief this skill executes; `dev-implement` owns the surrounding build ceremony; `dev-review` judges the finished fix.

## Phase 1 — the red command comes before any theory

Build **one named command** that demonstrates the bug: it fails right now *because of this bug's exact symptom*, and will pass once it's truly fixed. The completion criterion, all four checkable:

- **Red-capable** — it asserts the reported symptom, not "runs without erroring"; you have run it at least once and its invocation + failing output (redacted) go in the ledger.
- **Deterministic** — same verdict every run; a flaky bug substitutes a pinned, stated reproduction rate ("~1 in 12 across 50 runs").
- **Fast** — seconds, not minutes; a tight loop is the whole superpower here.
- **Agent-runnable** — no human in the loop.

Pick the cheapest rung that reaches the bug from the [loop ladder](references/loop-ladder.md). Can't build one after walking the ladder → stop: one `handback` comment, `waiting-on-operator`. A handback lists what was tried, one line per ladder rung, and asks for the artifacts by name (logs, HAR, recording, environment access). Proceeding to theories without a red command is the exact failure this skill exists to prevent.

## Phase 2 — shrink until everything left is load-bearing

Run the loop, watch it go red on the *reported* symptom (the wrong bug means the wrong fix). Then minimise: cut inputs, callers, config, and steps **one at a time**, re-running after each cut, keeping only what the failure needs. Done when removing any remaining element turns the loop green. The minimal repro shrinks the suspect space and becomes Phase 5's regression test.

## Phase 3 — suspects: 3–5, ranked, falsifiable, posted, then GO

List 3–5 candidate causes ranked most-likely first — a single hypothesis anchors on the first plausible idea. Each must be **falsifiable**: "if X is the cause, then changing Y makes the bug disappear / Z makes it worse." A suspect whose prediction you can't state is a vibe — discard or sharpen it. Post the ranked list to the ledger and proceed, because dark mode holds and the operator's re-rank arrives asynchronously whenever it comes.

## Phase 4 — test suspects one variable at a time

Every probe maps to one suspect's prediction. Prefer a debugger/REPL breakpoint over logs; when logging, target the boundaries that separate suspects, because a blanket log buries the signal. **Every debug log carries a `[DEBUG-<4hex>]` tag** (one random tag per session): cleanup becomes a single grep, and `vegafactory ship check` blocks any tag that survives into the diff. Performance bugs: logs lie — measure a baseline first (timing harness, profiler, query plan), then bisect.

## Phase 5 — regression test before the fix

Write the failing test before touching the fix, at a correct seam: one where the test exercises the real bug pattern as it occurs at the call site. If the only reachable seam is too shallow to replicate the trigger, that is itself a finding — record it in the ledger and evidence; a false-confidence test is worse than a named gap. With a correct seam: minimal repro → failing test → watch it fail → fix → watch it pass → re-run the original un-minimised Phase 1 loop green.

## Phase 6 — clean up and teach

Before hand-back, all checkable: the original repro re-runs green · `git diff <base>... | grep -F '[DEBUG-'` comes back empty (fixed-string grep; `vegafactory ship check` backstops the added lines) · throwaway harnesses deleted · the winning suspect and its evidence named in the evidence comment and the commit message — the next debugger learns what it actually was, not just that it went away.
