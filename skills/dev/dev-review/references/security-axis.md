# The security axis

The security axis runs on every review; on a big or `risky` diff it runs as its own reviewer. This file is its method — how a suspicion becomes a finding, and how severity is earned. `vegafactory review` puts the short form in the packet; a same-tool fallback subagent gets this file's steps in full.

## Scanner evidence — a finding's start, never its end

A scanner report (skill-scan in the merge queue, or whatever the project runs) is an **input to this axis**, on the same footing as the diff. It is evidence, not a verdict:

- **A scanner hit is a candidate finding.** It arrives with a rule ID and a `file:line` and nothing else — no data flow, no attacker, no exploitability. Promote it to a finding only after the Method below fills those in; a hit you cannot trace is a nit like any other untraced hunch.
- **Read the source at the location before judging it.** The scanner matched text; whether that text is a vulnerability is your call, made against the file, not the summary.
- **Severity is yours, not the scanner's.** Map its finding onto the ladder below by exploitability. A scanner HIGH that cannot be exploited is not must-fix; a scanner MEDIUM with a traced path to a real sink is.
- **Never downgrade an unexplained HIGH or CRITICAL** on reputation, score, or "it's our own code". Either the trace shows why it does not hold, or it stands.
- **The aggregate risk score is not a finding.** It is distorted upward by documentation of the very mechanics being scanned and downward by unrelated suppressions. Quote it for context; never rank on it.
- **Suppressions are in scope for this axis.** A finding silenced by a baseline rule rather than fixed is reviewable: check the rule is scoped as narrowly as its cause and that its stated re-trigger condition is one that would actually fire.
- **A degraded or partial scan is not a clean scan.** If the report says the run did not complete, say so in the verdict line rather than reporting its numbers.

## Method — evidence before severity

1. **Trace the data flow** for every candidate finding: origin → transformations → sink. Is the value attacker-controlled at the point of use? A finding without a traced flow is a hunch, not a finding.
2. **Check defense in depth before flagging a gap.** A missing check at one layer is not a vulnerability if another layer enforces it on every path — name the enforcing layer instead. Flag it only when no layer holds, or the only holding layer is UX (client-side, middleware-as-convenience).
3. **Verify library defaults** before "missing configuration" findings — frameworks ship safe defaults more often than training-data memory suggests; check the current docs per `dev-architect`'s verify protocol.
4. **Assess exploitability**: what does the attacker need (auth level, network position, timing, knowledge)? What mitigating controls exist? Severity follows exploitability, never vibes.

## Finding format — three extra lines

Every security finding's `issue` text opens with:

```
Data flow: <origin> → <transformations> → <sink>
Attack prerequisites: <what the attacker needs>
Mitigating controls: <existing defenses that reduce but don't eliminate>
```

A finding that cannot fill the Data flow line is a nit, not a must-fix.

## Severity

- **must-fix** — exploitable now (auth bypass at the enforcement layer, injection with a traced user-input path, secret exposure, unprotected sensitive mutation), or a real weakness whose prerequisites an attacker can plausibly meet. Say which of the two it is.
- **should-fix** — hardening: rate limits, PII in logs, missing timeouts, defense-in-depth gaps with a holding layer.
- **nit** — untraced suspicion worth a second pair of eyes.
- Never round up to look thorough; judge against the project's Architecture facts — platform-scale concerns are not defects on a small internal tool.

## Standing red lines (summary — `dev-architect` remains their home)

Middleware/proxy is never the authorization boundary; authorization lives server-side per resource. No secret in plaintext anywhere — code, config, logs, events, agent state. Permission checks fail closed, and the deny is still audited.
