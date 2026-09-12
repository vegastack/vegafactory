#!/usr/bin/env node
// The skill-scan guard: scans the project's agent skills with NVIDIA SkillSpector and
// blocks on any unsuppressed HIGH/CRITICAL finding. Facts block; heuristics warn.
// The scanner's own exit code (0 for score <= 50) is never the verdict — an
// aggregate score is distorted by meta-content, individual findings are not.
// Self-contained (ships with skill-scan; no cross-skill imports, no dependencies).
//
// Exit codes: 0 pass (or skipped) · 1 pass-with-warnings · 2 blocked.
// Usage: node skill-scan.mjs [--root <path>] [--dev-md <path>] [--baseline <path>]
//        [--llm] [--json]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultRun,
  latestRelease,
  locateSkillspector,
  provisionSkillspector,
  readVersion,
} from './lib/skillspector.mjs';

// The clause every suppression must carry, mirroring the "Still flag if:"
// requirement on .vegastack/review-known-patterns.md entries: a suppression
// without a stated re-trigger condition is a blind spot, not a decision.
const CLAUSE = /still flag if:/i;
// stdio mode for a discarded fd, hoisted out of quote-adjacency: SkillSpector reads the
// bare word beside its own closing quote as a removal cue and fails closed on the whole
// file (skill-maintainer's standards.md, known behaviours). Same value, same behaviour.
const DISCARD = 'ignore';

// SkillSpector's exact default when `skillspector baseline` writes a file
// without --reason. Committing one of those suppresses every current finding at
// once. Exact equality is a FACT and blocks; the looser phrase match below is a
// heuristic and only warns — conventions' guard doctrine is that regex judgement
// never blocks.
const PLACEHOLDER_EXACT = 'Accepted finding (auto-generated baseline)';
const PLACEHOLDER_LIKE = /auto-generated baseline/i;

function reasonErrors(entry, label, requireClause) {
  const errors = [];
  const warns = [];
  const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
  if (!reason) {
    errors.push(`${label}: missing reason — every suppression states why the pattern is structural here`);
    return { errors, warns };
  }
  if (reason === PLACEHOLDER_EXACT) {
    errors.push(`${label}: the scanner's default reason, unedited — write why this pattern is structural here`);
  } else if (PLACEHOLDER_LIKE.test(reason)) {
    warns.push(`${label}: reason mentions an auto-generated baseline ("${reason}") — check it was actually written, not adapted from the default`);
  }
  if (requireClause && !CLAUSE.test(reason)) {
    errors.push(`${label}: reason has no "Still flag if:" clause — a suppression without a re-trigger condition is a blind spot`);
  }
  return { errors, warns };
}

// Returns { rules, fingerprints, errors }. Never throws: unreadable content comes
// back as an error so the caller can block on it like any other fact.
export function parseBaseline(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { rules: [], fingerprints: [], errors: [`baseline is not valid JSON: ${error.message}`], warns: [] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { rules: [], fingerprints: [], errors: ['baseline must be a JSON object'], warns: [] };
  }

  const errors = [];
  const warns = [];
  const rawRules = Array.isArray(data.rules) ? data.rules : [];
  const rawFingerprints = Array.isArray(data.fingerprints) ? data.fingerprints : [];
  if (data.rules !== undefined && !Array.isArray(data.rules)) errors.push('baseline "rules" must be an array');
  if (data.fingerprints !== undefined && !Array.isArray(data.fingerprints)) errors.push('baseline "fingerprints" must be an array');

  const rules = [];
  rawRules.forEach((raw, index) => {
    const label = `rule ${index + 1}`;
    if (!raw || typeof raw !== 'object') {
      errors.push(`${label}: not an object`);
      return;
    }
    // SkillSpector normalizes `id`/`rule_id` and `path`/`file` to one field each
    // (`path=raw.get("path") or raw.get("file")`). Missing the `file` alias would
    // both reject a valid baseline AND let `{"file": "*"}` past the wildcard
    // check below into a scanner that honours it.
    const id = raw.id ?? raw.rule_id;
    const path = raw.path ?? raw.file;
    const matchers = { id, path, message: raw.message };
    const present = Object.entries(matchers).filter(([, value]) => value !== undefined);
    if (present.length === 0) {
      errors.push(`${label}: no matcher (id, path, or message) — a rule with no matcher suppresses every finding`);
    }
    // Matchers must be LITERAL. Chasing wildcard shapes is an arms race that
    // was lost at the first attempt: `*` was rejected and `?*` silenced every
    // finding just the same, as do `*.md`, `[a-z]*` and `*SKILL*`. The rule
    // this project already states — "scope a rule as narrowly as its cause" —
    // is mechanically checkable only as "name the thing". A project that wants
    // two files writes two rules, which is the more reviewable artifact anyway.
    for (const [field, value] of present) {
      if (typeof value !== 'string' || !value.trim()) {
        errors.push(`${label}: "${field}" must be a non-empty string, got ${JSON.stringify(value)}`);
        continue;
      }
      const glob = value.match(/[*?[\]]/);
      if (glob) {
        errors.push(`${label}: "${field}" contains the glob character "${glob[0]}" ("${value}") — matchers must be literal so a rule cannot silence more than the cause it names; write one rule per file`);
      }
    }
    const reasoned = reasonErrors(raw, label, true);
    errors.push(...reasoned.errors);
    warns.push(...reasoned.warns);
    rules.push({ id, path, message: raw.message, reason: raw.reason });
  });

  // The scanner rejects a v2 baseline that carries fingerprints without pinning
  // the version they were computed against, and it does so per invocation — so
  // catching it here turns twelve confusing "no readable report" failures into
  // one sentence naming the actual problem.
  if (rawFingerprints.length > 0 && !data.scanner_version) {
    errors.push('a v2 baseline with fingerprints must set "scanner_version" (the scanner rejects it otherwise)');
  }

  // Fingerprints get the same reason discipline minus the clause: they are
  // content-hashed, so editing the surrounding file re-triggers the finding on
  // its own — the re-trigger condition a rule has to state in prose. This check
  // catches the common accident, committing `skillspector baseline` output
  // verbatim, since that writes every finding as a fingerprint carrying the
  // default reason. It does NOT stop someone passing `--reason` with a clause
  // in it: a deliberate mass-suppression is caught by review of the diff and by
  // the suppression counts in the report, not by this guard.
  rawFingerprints.forEach((raw, index) => {
    const label = `fingerprint ${index + 1}`;
    if (!raw || typeof raw !== 'object') {
      errors.push(`${label}: not an object`);
      return;
    }
    const reasoned = reasonErrors(raw, label, false);
    errors.push(...reasoned.errors);
    warns.push(...reasoned.warns);
  });

  // `coverage:` accepts a COMPLETENESS signal, not a finding. The scanner's own
  // baseline cannot express this: it suppresses findings only. Without it, a
  // skill shipping ordinary JavaScript blocks forever — SkillSpector's shell
  // parser reads a template literal in assignment position as backtick command
  // substitution and degrades. Same discipline as a rule: name the skill AND the
  // file, say why, and say what would make it a real signal again.
  const rawCoverage = Array.isArray(data.coverage) ? data.coverage : [];
  if (data.coverage !== undefined && !Array.isArray(data.coverage)) {
    errors.push('baseline "coverage" must be an array');
  }
  const coverage = [];
  rawCoverage.forEach((raw, index) => {
    const label = `coverage ${index + 1}`;
    if (!raw || typeof raw !== 'object') {
      errors.push(`${label}: not an object`);
      return;
    }
    // Content-bound, like a fingerprint. Without this an acceptance outlives the
    // file it was written about: the reason stays on the page while the content
    // it describes changes underneath, and every "Still flag if:" clause becomes
    // decorative because nothing re-triggers the adjudication.
    if (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256.trim())) {
      errors.push(`${label}: "sha256" must be the 64-hex digest of the accepted file — an acceptance that is not content-bound never expires`);
    }
    for (const field of ['skill', 'file']) {
      const value = raw[field];
      if (typeof value !== 'string' || !value.trim()) {
        errors.push(`${label}: "${field}" must be a non-empty string — a coverage acceptance names exactly one file in one skill`);
      } else if (/[*?[\]]/.test(value)) {
        errors.push(`${label}: "${field}" contains a glob character ("${value}") — coverage acceptances are literal, like rules`);
      }
    }
    const reasoned = reasonErrors(raw, label, true);
    errors.push(...reasoned.errors);
    warns.push(...reasoned.warns);
    coverage.push({ skill: raw.skill, file: raw.file, sha256: raw.sha256, reason: raw.reason });
  });

  return { rules, fingerprints: rawFingerprints, coverage, errors, warns, scannerVersion: data.scanner_version ?? null };
}

// Absolute paths, sorted, of the skill directories under `root`. A directory is
// a skill iff it holds a SKILL.md. The root itself counts when it holds one;
// otherwise children AND grandchildren are examined — two levels, matching the
// authored layout's own cap (`skills/<name>/` and `skills/<group>/<name>/`), so
// pointing the knob at a grouped tree scans it instead of silently finding
// nothing. Dot-prefixed entries are skipped: a crashed scaffolder's
// `.name.scaffold-XXXX` leftover must never read as a skill. Symlinked
// directories are not followed — a scanner that traverses out of its root scans
// something other than what it reports on.
function childDirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

export function discoverSkills(root) {
  if (!root || !existsSync(root)) return [];
  const absolute = resolve(root);
  if (existsSync(join(absolute, 'SKILL.md'))) return [absolute];

  const found = [];
  for (const child of childDirectories(absolute)) {
    if (existsSync(join(child, 'SKILL.md'))) {
      found.push(child);
      continue;
    }
    // One level deeper, for the grouped authored layout (`<root>/<group>/<skill>/`).
    // Without this a grouped tree scans as ZERO skills while reporting success on
    // whatever else it found — coverage silently lost, which is the whole defect
    // class this guard exists to stop.
    for (const grandchild of childDirectories(child)) {
      if (existsSync(join(grandchild, 'SKILL.md'))) found.push(grandchild);
    }
  }
  return found.sort();
}

// Anything that LOOKS like a skill but discovery did not scan. Defined as the
// difference between a full walk and `discoverSkills`, rather than as a list of
// known-bad shapes — so it stays correct by construction when discovery changes.
// It catches skills nested deeper than the layout allows, dot-prefixed
// directories, and symlinked directories that are or contain a skill.
//
// The walk is NOT depth-capped. A cap is a cliff: an earlier version stopped at
// depth 4, and a deliberately malicious skill at depth 5 was then scanned by
// nobody and flagged by nobody — the exact silent-coverage-loss this function
// exists to prevent, reintroduced one level down. Real directories cannot cycle
// and symlinks are never descended, so the walk terminates. TWO things can stop it early, and BOTH are reported rather than
// swallowed: the visit budget, and a directory it cannot read (EACCES, or a
// path past PATH_MAX). An earlier version caught the read failure and gave up
// silently, so a skill hidden behind a `chmod 000` directory was flagged by
// nobody while the run reported success — the same quiet give-up this whole
// function exists to prevent, one level down.
const WALK_BUDGET = 50_000;

function deepSkillDirs(dir, state) {
  if (state.exhausted) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // Not silence: an unreadable directory is unverified coverage.
    state.unreadable.add(`${dir} (${error.code ?? error.message})`);
    return;
  }
  for (const entry of entries) {
    if (state.visited++ > WALK_BUDGET) {
      state.exhausted = true;
      return;
    }
    const child = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // Never descended — a scanner that walks out of its root reports on
      // something it was not pointed at. Flagged when the target is, or holds,
      // a skill, so it is refused rather than dropped.
      if (existsSync(join(child, 'SKILL.md'))) {
        state.seen.add(child);
        continue;
      }
      for (const nested of childDirectories(child)) {
        if (existsSync(join(nested, 'SKILL.md'))) {
          state.seen.add(child);
          break;
        }
      }
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (existsSync(join(child, 'SKILL.md'))) state.seen.add(child);
    deepSkillDirs(child, state);
  }
}

// Returns { unscannable, exhausted }. `exhausted` means the walk hit its budget
// and coverage could NOT be verified — the caller blocks on it.
export function findUnscannable(root) {
  if (!root || !existsSync(root)) return { unscannable: [], exhausted: false };
  const absolute = resolve(root);
  const scanned = new Set(discoverSkills(absolute));
  const state = { seen: new Set(), visited: 0, exhausted: false, unreadable: new Set() };
  deepSkillDirs(absolute, state);
  return {
    unscannable: [...state.seen].filter((dir) => !scanned.has(dir)).sort(),
    exhausted: state.exhausted,
    unreadable: [...state.unreadable].sort(),
  };
}

// The severities that stop a push. Deliberately NOT the aggregate risk score:
// a score is inflated by unresolvable-path artifacts in meta-content and
// deflated by suppressing unrelated findings, so it answers a question nobody
// asked. Individual findings are what a reviewer triages.
const BLOCKING = new Set(['HIGH', 'CRITICAL']);
// The one finding id that is a COMPLETENESS signal wearing a finding's clothes —
// the scanner's own text for it is "Referenced artifact was not completely
// inspected". A `coverage:` entry naming that file accepts it, because it is the
// same phenomenon the coverage section exists for; every other id must go
// through `rules` or `fingerprints`, which bind to content.
const COVERAGE_CLASS_RULE = 'AE1';
// Everything the scanner is known to emit. A severity outside this set is
// upstream drift, and drift must fail CLOSED: silently sorting an unrecognised
// severity under the blocking bar and then calling it "MEDIUM/LOW" would be a
// false success dressed as a summary line.
const KNOWN_SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);

const INSTALL_HINT = 'install it with `uv tool install git+https://github.com/NVIDIA/skillspector.git`';

// Pure evaluation over gathered facts — unit tests drive this directly.
export function evaluateScan(facts) {
  const blocks = [];
  const warns = [];
  const {
    binaryMissing,
    rootMissing,
    baselineMissing,
    baselineErrors = [],
    skills = [],
    scanErrors = [],
    skillspector = {},
    baselinePin = {},
  } = facts;

  // Environment failures first: when the scanner never ran, a finding list is
  // not evidence of anything, and the real cause must read before the noise.
  if (binaryMissing) {
    blocks.push(
      `the \`skillspector\` binary could not be found — no install channel (uv, brew, pipx) reports it and it is not on PATH — ${INSTALL_HINT}; or, if it runs through a wrapper or container, point VSK_SKILLSPECTOR at that executable; or set skill-scan: none if this project has no skills`,
    );
  }
  // An update that could not happen is a note, never a block: the scan ran on
  // the copy that was already installed, which is exactly the documented
  // fallback. Sanitized — this text comes from a package manager.
  if (skillspector.action === 'failed' && skillspector.message) {
    warns.push(`skillspector update failed, scanned with the installed copy instead — ${safe(skillspector.message)}`);
  }
  // A fingerprint is a content hash tied to the scanner that produced it, so a
  // version change can stop it matching and quietly un-suppress its finding.
  // Warn, never block: the finding coming back IS the loud outcome, and the pin
  // is never moved automatically — that would assert a suppression still holds
  // for a scanner nobody has run.
  if (baselinePin.fingerprints > 0 && baselinePin.scannerVersion && skillspector.version && baselinePin.scannerVersion !== skillspector.version) {
    warns.push(
      `baseline pins scanner_version ${safe(baselinePin.scannerVersion)} for ${baselinePin.fingerprints} fingerprint(s) but skillspector ${safe(skillspector.version)} ran — re-verify those suppressions and move the pin deliberately, never automatically`,
    );
  }

  if (rootMissing) {
    blocks.push(`scan root "${rootMissing}" does not exist — build it first if it is a build output, or correct dev.md's skill-scan: knob`);
  }
  for (const error of baselineErrors) {
    blocks.push(`baseline: ${error}`);
  }
  for (const { skill, message } of scanErrors) {
    blocks.push(`${skill}: the scan did not produce a readable report (${message}) — an unscanned skill is not a clean skill`);
  }
  for (const dir of facts.unreadableDirs ?? []) {
    blocks.push(`${dir} could not be read, so coverage under it is unverified — a skill hidden there would be reported by nobody`);
  }
  if (facts.coverageExhausted) {
    blocks.push('the scan root is too large to verify coverage — the walk hit its budget, so an unscanned skill could be hiding in it; point --root at a narrower directory');
  }
  for (const path of facts.unscannable ?? []) {
    blocks.push(`${path} holds a SKILL.md but was not scanned — nested deeper than the layout allows, dot-prefixed, or behind a symlink discovery will not follow out of the scan root. Move it into place, or scan it directly with --root`);
  }

  if (blocks.length > 0) return { blocks, warns };

  if (skills.length === 0) {
    blocks.push('no skills found under the scan root — a root with nothing in it is a misconfigured knob, not a clean result');
    return { blocks, warns };
  }

  for (const entry of skills) {
    // The ONLY short-circuit: a failed execution means no field of this report
    // can be trusted. Every other coverage problem still yields real findings,
    // and suppressing them behind the coverage block would tell the operator
    // less than the guard actually knows.
    if (!entry.executionSuccessful) {
      blocks.push(`${entry.name}: the scan did not complete (execution_successful: false) — a partial score is not a verdict`);
      continue;
    }
    // A degraded run reports a HIGHER score than a clean one (a failed analyzer
    // leaves its findings unfiltered), so "no blocking finding" from a degraded
    // scan proves nothing. But `status: "partial"` on its own is the NORMAL
    // result for documentation-heavy skills — it is what unresolved path-like
    // references produce — so blocking on it would block every scan forever,
    // the same trap as gating on the aggregate score. Block only on the signals
    // that mean work did not happen.
    const { status, limitations, entirelyUninspected, partiallyInspected } = entry.completeness ?? {};

    // A coverage acceptance clears the degraded/partly-read signals for a skill
    // ONLY when it names every file the scanner said it could not finish. Accept
    // one file and leave another unread, and the skill still blocks — otherwise
    // an acceptance written for a known cause would silently cover an unknown one.
    const forThisSkill = (facts.coverageAccepted ?? []).filter((c) => c.skill === entry.name);
    for (const c of forThisSkill) {
      if (c.actualSha256 && c.actualSha256 !== c.sha256) {
        blocks.push(`${entry.name}: ${c.file} changed since its coverage acceptance was written (baseline ${c.sha256.slice(0, 12)}…, on disk ${c.actualSha256.slice(0, 12)}…) — re-adjudicate it rather than carrying the old reasoning forward`);
      } else if (!c.actualSha256) {
        blocks.push(`${entry.name}: ${c.file} has a coverage acceptance but could not be read to verify it — an acceptance for a file that is not there accepts nothing`);
      }
    }
    const acceptedFiles = new Set(
      forThisSkill.filter((c) => c.actualSha256 && c.actualSha256 === c.sha256).map((c) => c.file),
    );
    const unaccounted = (entry.partialPaths ?? []).filter((path) => !acceptedFiles.has(path));
    const coverageClassAccepted = new Set();
    const coverageAccepted =
      acceptedFiles.size > 0 && (entry.partialPaths ?? []).length > 0 && unaccounted.length === 0;
    if (status && status !== 'complete' && status !== 'partial') {
      blocks.push(`${entry.name}: the scan reported completeness "${status}" — only "complete" or "partial" is a result you can act on`);
      continue;
    }
    if (limitations?.length && !coverageAccepted) {
      const detail = unaccounted.length ? ` in ${unaccounted.join(', ')}` : '';
      blocks.push(`${entry.name}: an analyzer did not finish${detail} (${limitations.join('; ')}) — a degraded scan scores HIGHER than a clean one, so its silence proves nothing`);
    }
    if (entirelyUninspected > 0) {
      blocks.push(`${entry.name}: ${entirelyUninspected} file(s) were never inspected — an unread file is not a clean file`);
    }
    // Distinct from `status: "partial"`, which every healthy scan here reports.
    // Measured across all twelve skills, `partially_inspected_files` is 0 on a
    // healthy run, so this blocks only genuinely truncated coverage.
    if (partiallyInspected > 0 && !coverageAccepted) {
      const where = unaccounted.length ? `: ${unaccounted.join(', ')}` : '';
      blocks.push(`${entry.name}: ${partiallyInspected} file(s) were only partly inspected${where} — the unread remainder is exactly where something would hide`);
    }
    // A scan that read nothing reports "complete" with zero findings, which is
    // indistinguishable from a clean skill. Reachable with a symlinked or
    // unreadable SKILL.md: the scanner sees no bytes and says so by counting
    // them, which is the only place this shows up.
    if (entry.completeness?.fullyInspected === 0) {
      blocks.push(`${entry.name}: the scanner inspected 0 files — an empty read is not a clean result (unreadable or symlinked content?)`);
    }
    for (const issue of entry.issues ?? []) {
      const severity = String(issue.severity).toUpperCase();
      const at = issue.line == null ? issue.file : `${issue.file}:${issue.line}`;
      if (!KNOWN_SEVERITIES.has(severity)) {
        blocks.push(`${entry.name}: unrecognised severity "${issue.severity}" for ${issue.id} at ${at} — refusing to rank an unknown severity below the bar`);
        continue;
      }
      if (!BLOCKING.has(severity)) continue;
      if (issue.id === COVERAGE_CLASS_RULE && acceptedFiles.has(issue.file)) {
        coverageClassAccepted.add(issue.file);
        continue;
      }
      blocks.push(`${entry.name}: ${issue.severity} ${issue.id} at ${at} — fix it, or add a justified baseline rule on the operator's word`);
    }

    // AFTER the issue loop: an accepted AE1 is only known here. Emitting this
    // earlier meant an accepted HIGH finding vanished with no block and no
    // warning — a suppression nobody could see is indistinguishable from a
    // finding that never existed.
    if (coverageAccepted || coverageClassAccepted.size > 0) {
      const files = [...new Set([...(coverageAccepted ? acceptedFiles : []), ...coverageClassAccepted])].sort();
      const suppressedHigh = coverageClassAccepted.size > 0 ? ` — including HIGH ${COVERAGE_CLASS_RULE} finding(s)` : '';
      warns.push(`${entry.name}: reduced coverage accepted by the baseline for ${files.join(', ')}${suppressedHigh} — the scan of those files is incomplete by acknowledged cause`);
    }
  }

  for (const warning of facts.baselineWarns ?? []) warns.push(`baseline: ${warning}`);
  if (baselineMissing) {
    warns.push('no baseline file — every finding counts, including ones previously adjudicated as structural');
  }
  const suppressed = skills.reduce((total, entry) => total + (entry.suppressedCount ?? 0), 0);
  if (suppressed > 0) {
    // A bare count hides what was silenced. Ten LOW suppressions and ten HIGH
    // ones are very different facts about a baseline, and the second is the one
    // worth reading before trusting a green run.
    const bySeverity = {};
    for (const entry of skills) {
      for (const item of entry.suppressed ?? []) {
        const key = String(item?.severity ?? 'UNKNOWN').toUpperCase();
        bySeverity[key] = (bySeverity[key] ?? 0) + 1;
      }
    }
    const breakdown = Object.entries(bySeverity)
      .sort()
      .map(([severity, count]) => `${count} ${severity}`)
      .join(', ');
    warns.push(
      `${suppressed} finding(s) suppressed by the baseline${breakdown ? ` (${breakdown})` : ''} — read it when a result surprises you`,
    );
  }
  const belowBar = skills.reduce(
    (total, entry) =>
      total +
      (entry.issues ?? []).filter((i) => {
        const severity = String(i.severity).toUpperCase();
        return KNOWN_SEVERITIES.has(severity) && !BLOCKING.has(severity);
      }).length,
    0,
  );
  if (belowBar > 0) {
    warns.push(`${belowBar} MEDIUM/LOW finding(s) below the blocking bar — the security axis triages these`);
  }

  return { blocks, warns };
}

// The dev.md knob naming the directory to scan. `none` or absent means this
// project authors no skills — the guard skips rather than erroring, so callers
// run one unconditional command instead of honouring a rule written in prose.
// Conventional home for the project's suppressions, beside dev.md — one fewer
// knob, and it means the documented one-command invocation actually applies them.
export const DEFAULT_BASELINE = '.vegastack/skillspector-baseline.json';

// Tolerates the shapes a hand-edited profile actually takes — indented under a
// heading, or written as a list item. A knob the guard cannot see reads as
// absent, and absent silently disables the gate, so the match is deliberately
// forgiving about layout and strict about the value.
const KNOB_LINE = /^[ \t]*(?:[-*+][ \t]+)?skill-scan:[ \t]*(\S+)/gm;

// Every `skill-scan:` value the profile declares. Tolerating indentation and
// list bullets means a prose EXAMPLE can also match — and with first-match-wins
// an example of `skill-scan: none` sitting above the real knob silently
// disabled the gate. The caller blocks when these disagree rather than picking
// one; guessing which line the author meant is exactly the judgement a guard
// must not make.
export function scanRootDeclarations(devMdText) {
  return [...String(devMdText ?? '').matchAll(KNOB_LINE)].map((match) => match[1]);
}

// The sibling knob governing SkillSpector itself: off | notify | auto, absent
// reading as `auto` so an existing profile inherits the default without an
// edit. Same tolerant layout matching and same conflict discipline as
// `skill-scan:` — a knob the guard cannot see reads as absent, and absent must
// not silently mean something different from what the author wrote.
//
// Named for the tool, not for our guard: `skill-scan:` is our machinery,
// `skillspector-update:` is the third-party binary (operator's rule, 01-09-2026).
const UPDATE_KNOB_LINE = /^[ \t]*(?:[-*+][ \t]+)?skillspector-update:[ \t]*(\S+)/gm;

export const UPDATE_MODES = new Set(['off', 'notify', 'auto']);

// Every declared value, unvalidated. The caller refuses a conflict or an
// unrecognised value rather than picking one: guessing which mode the author
// meant is exactly the judgement a guard must not make.
export function updateModeDeclarations(devMdText) {
  return [...String(devMdText ?? '').matchAll(UPDATE_KNOB_LINE)].map((match) => match[1]);
}

export function resolveUpdateMode(devMdText) {
  return updateModeDeclarations(devMdText)[0] ?? 'auto';
}

export function resolveScanRoot(devMdText) {
  const value = scanRootDeclarations(devMdText)[0];
  if (!value || value === 'none') return null;
  return value;
}

// Findings carry file names and rule ids that originate in SCANNED content, and
// this guard's output is read in a terminal. Strip C0/C1 controls (ANSI escapes
// included) so a crafted path cannot repaint or forge lines of the report.
function safe(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

function normalizeIssue(raw) {
  const location = raw.location ?? {};
  return {
    id: safe(raw.id ?? raw.rule_id ?? raw.finding_id ?? 'UNKNOWN'),
    severity: safe(raw.severity ?? 'UNKNOWN'),
    file: safe(location.file ?? raw.file ?? '(unknown file)'),
    line: location.start_line ?? null,
  };
}

// Impure: shells out to the scanner, once per skill. `--baseline` is rejected
// together with `--recursive` ("scan each sub-skill with its own baseline"), so
// the loop is the supported path, not an optimization we passed up.
export function gatherFacts({ root, baselinePath, llm, binary: binaryOverride }) {
  // VSK_SKILLSPECTOR is a TEST SEAM (stubs the scanner in unit tests), mirroring
  // ship-gate.mjs's VSK_GH. `binaryOverride` is the absolute path the CLI
  // resolved through the tool's own install channel; a bare PATH lookup is the
  // last resort, not the first.
  //
  // Locating deliberately happens in the CLI and NOT here: gatherFacts is
  // driven directly by unit tests, and probing uv/brew/pipx from inside it
  // would make the suite shell out to whatever is installed on the machine.
  const binary = process.env.VSK_SKILLSPECTOR || binaryOverride || 'skillspector';
  const base = {
    binaryMissing: false,
    rootMissing: null,
    baselineMissing: !baselinePath,
    baselineErrors: [],
    skills: [],
    scanErrors: [],
  };

  if (!root || !existsSync(root)) return { ...base, rootMissing: root ?? '(unset)' };

  const baselineUsable = Boolean(baselinePath) && existsSync(baselinePath);
  if (baselinePath && !baselineUsable) base.baselineMissing = true;
  if (baselineUsable) {
    const parsed = parseBaseline(readFileSync(baselinePath, 'utf8'));
    base.baselineErrors = parsed.errors;
    base.baselineWarns = parsed.warns;
    base.coverageAccepted = parsed.coverage;
    // Only fingerprints are version-coupled: they are content hashes the
    // scanner computed, so a different scanner may stop matching them. Rules
    // bind to id+path and survive an upgrade untouched.
    base.baselinePin = { scannerVersion: parsed.scannerVersion, fingerprints: parsed.fingerprints.length };
  }
  // Short-circuit: with a bad baseline nothing the scan reports is trustworthy —
  // suppressions may not apply — and the scanner would reject the file once per
  // skill anyway. Block on the real reason instead of after N wasted invocations.
  if (base.baselineErrors.length > 0) return base;

  // Paths here are attacker-chosen directory names in a third-party tree, and
  // they are printed verbatim in block lines.
  // Hash each accepted file as it is on disk now, so a changed file drops its
  // acceptance and blocks until it is re-adjudicated.
  base.coverageAccepted = (base.coverageAccepted ?? []).map((entry) => {
    const skillDir = discoverSkills(root).find((dir) => basename(dir) === entry.skill);
    let actual = null;
    if (skillDir) {
      try {
        actual = createHash('sha256').update(readFileSync(join(skillDir, entry.file))).digest('hex');
      } catch {
        actual = null;
      }
    }
    return { ...entry, actualSha256: actual };
  });

  const coverage = findUnscannable(root);
  base.unscannable = coverage.unscannable.map(safe);
  base.coverageExhausted = coverage.exhausted;
  base.unreadableDirs = coverage.unreadable.map(safe);

  const outDir = mkdtempSync(join(tmpdir(), 'vsk-skill-scan-'));
  const discovered = discoverSkills(root);
  // Two skills can share a basename across groups; the report must say which is
  // which, so an ambiguous name is qualified with its parent directory.
  const basenameCounts = {};
  for (const dir of discovered) basenameCounts[basename(dir)] = (basenameCounts[basename(dir)] ?? 0) + 1;

  for (const [index, dir] of discovered.entries()) {
    const bare = basename(dir);
    // Sanitized: this comes from a DIRECTORY NAME on disk, which in a
    // third-party skill tree is attacker-chosen, and it is printed to a terminal
    // and embedded in every block line.
    const name = safe(basenameCounts[bare] > 1 ? `${basename(resolve(dir, '..'))}/${bare}` : bare);
    // Indexed, not named: two-level discovery makes duplicate basenames possible
    // (`<root>/a/foo/` and `<root>/b/foo/`), and a shared report path would let
    // one skill's result stand in for another's — a wrong verdict that looks
    // exactly like a right one. `index` is unique per run by construction.
    const reportPath = join(outDir, `${index}.json`);
    const args = ['scan', dir, '--format', 'json', '--output', reportPath];
    if (!llm) args.push('--no-llm');
    if (baselineUsable) args.push('--baseline', baselinePath);

    try {
      // `env` is passed explicitly, as ship-gate.mjs does: under Bun a mutated
      // process.env is NOT inherited by execFileSync children, so the seam and
      // any scanner configuration (SKILLSPECTOR_PROVIDER, etc.) would be lost.
      execFileSync(binary, args, {
        stdio: [DISCARD, 'pipe', 'pipe'],
        env: { ...process.env },
        // A hung or runaway scanner must fail the gate, not hold it open forever.
        timeout: Number(process.env.VSK_SKILLSPECTOR_TIMEOUT_MS) || 300_000,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      // ENOENT means the binary itself is absent — a fact about the environment,
      // not about any skill, and it stops the whole run.
      if (error.code === 'ENOENT') return { ...base, binaryMissing: true };
      // Any other non-zero exit is expected: the scanner exits 1 whenever the
      // score exceeds 50, which says nothing about whether a finding blocks.
      // The report is the evidence; only its absence is a failure.
    }

    let report;
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'));
    } catch (error) {
      base.scanErrors.push({ skill: name, message: safe(error.message) });
      continue;
    }
    // A report whose shape we do not recognise must fail loudly. Reading a
    // missing `issues` key as "no findings" is the exact false-success this
    // guard exists to prevent, and the scanner is upstream software on a fast
    // cadence — a renamed key would otherwise turn every skill green.
    if (!report || typeof report !== 'object' || Array.isArray(report) || !Array.isArray(report.issues)) {
      base.scanErrors.push({
        skill: name,
        message: 'report has no "issues" array — unrecognised shape, refusing to read it as "no findings"',
      });
      continue;
    }

    const assessment = report.risk_assessment ?? {};
    const completeness = report.analysis_completeness ?? {};
    base.skills.push({
      name,
      score: assessment.score ?? null,
      severity: assessment.severity ?? 'UNKNOWN',
      executionSuccessful: report.execution_successful !== false,
      suppressedCount: report.suppressed_count ?? 0,
      // The scanner derives status from: "failed" when a ledger exception was
      // fatal, else "partial" when anything was left uninspected or an analyzer
      // reported a limitation, else "complete". `limitations` is the signal that
      // an ANALYZER did not finish — distinct from the reference-resolution
      // exceptions that make a healthy scan of documentation-heavy skills
      // "partial". See the degradation rules in evaluateScan.
      // The files the scanner itself says it could not finish reading, excluding
      // `reference_unresolved` — that one is a path citation, not lost coverage,
      // and it is already reported as an AE1 finding.
      partialPaths: [
        ...new Set(
          (completeness.ledger_exceptions ?? [])
            .filter((e) => e?.outcome === 'partial' && e?.reason_code !== 'reference_unresolved' && e?.path)
            .map((e) => safe(e.path)),
        ),
      ].sort(),
      completeness: {
        status: completeness.status ?? 'unknown',
        // Sanitized: analyzer messages are printed in block lines and can carry
        // text derived from the scanned content.
        limitations: (Array.isArray(completeness.limitations) ? completeness.limitations : []).map(safe),
        entirelyUninspected: completeness.entirely_uninspected_files ?? 0,
        partiallyInspected: completeness.partially_inspected_files ?? 0,
        fullyInspected: completeness.fully_inspected_files ?? 0,
        coveragePercent: completeness.coverage_percent ?? null,
      },
      // The scanner's own list of what the baseline silenced. The Security axis
      // is told to judge whether each suppression was scoped to its cause, which
      // it cannot do from a count — and this evidence is right here in the report.
      suppressed: Array.isArray(report.suppressed) ? report.suppressed : [],
      issues: (report.issues ?? []).map(normalizeIssue),
    });
  }

  return base;
}

// The provisioning sequence, extracted so it is testable: the CLI passes the
// real commands, unit tests pass fakes. Returns the `skillspector` report block.
//
// `mode` is a MACHINE policy, never a per-scan-root one — see the CLI, which
// reads it from the profile even when --root chose what to scan.
export async function provisionForRun({
  mode,
  locate,
  provision,
  versionOf,
  pathVisible,
  fetchLatest,
}) {
  const state = {
    mode,
    channel: null,
    path: null,
    version: null,
    action: 'none',
    before: null,
    after: null,
    changed: [],
    message: '',
    available: null,
    resolvedOutsidePath: false,
  };

  let located = locate();
  const result = provision({ mode, located });
  state.action = result.action;
  state.changed = result.changed;
  state.message = result.message;
  state.before = result.before;
  state.after = result.after;
  // An install lands somewhere only a fresh probe knows about.
  if (result.action === 'installed') located = locate();

  if (located) {
    state.channel = located.channel;
    state.path = located.path;
    state.version = versionOf(located.path);
    // A fresh install has no "before", so its "after" is simply the version now
    // installed — otherwise the report says "(unchanged)" about a tool that was
    // not there a moment ago.
    if (state.action === 'installed') state.after = state.version;
    // Located through its channel while a bare PATH lookup cannot see it. This
    // is reported, never warned about: it is the ordinary case this feature
    // exists to serve, and making it a warn would pin the exit code at 1
    // forever for exactly the setup that motivated the work.
    state.resolvedOutsidePath = !pathVisible();
  }

  if (mode === 'notify') state.available = await fetchLatest();
  return state;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const get = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const json = argv.includes('--json');
  // Forces this one run to leave the machine untouched, whatever the knob says.
  const noProvision = argv.includes('--no-provision');
  const devMdPath = get('--dev-md') || '.vegastack/dev.md';

  let root = get('--root');
  const explicitRoot = Boolean(root);
  let skipped = false;
  let outcome = { blocks: [], warns: [] };
  let facts = { skills: [] };
  let baselinePath = get('--baseline') ?? null;
  let updateMode = 'auto';
  let binary;
  // Warns raised before the scan runs. `outcome` is REASSIGNED by evaluateScan,
  // so anything pushed onto it beforehand would be silently discarded.
  const preWarns = [];
  const skillspector = {
    mode: 'auto',
    channel: null,
    path: null,
    version: null,
    action: 'none',
    before: null,
    after: null,
    changed: [],
    message: '',
    available: null,
    resolvedOutsidePath: false,
  };

  // The update mode is read from the profile ALWAYS, including for --root runs.
  // --root chooses what to scan; it never decides whether this machine may be
  // written to. Skipping this is how `skillspector-update: off` got ignored on
  // exactly the invocation this skill's README documents for vetting a stranger's skill.
  {
    let profileForMode = null;
    try {
      profileForMode = readFileSync(devMdPath, 'utf8');
    } catch {
      // An explicit --root may legitimately run outside any project.
    }
    if (profileForMode !== null) {
      const declared = [...new Set(updateModeDeclarations(profileForMode))];
      const unusable = declared.length > 1 || declared.some((value) => !UPDATE_MODES.has(value));
      // A profile we cannot read unambiguously must not authorise writing to
      // the machine. The non---root path below turns the same conditions into
      // blocks; here the run continues, but touching nothing.
      updateMode = unusable ? 'off' : resolveUpdateMode(profileForMode);
      if (unusable && explicitRoot) {
        preWarns.push(
          `${devMdPath} does not give skillspector-update a single recognised value — this run left the machine untouched`,
        );
      }
    }
  }

  if (!explicitRoot) {
    // "Could not read the profile" and "the profile says none" are different
    // answers. Collapsing them let the guard report a clean skip from any
    // directory that simply has no dev.md — a gate that silently disables
    // itself when run from the wrong cwd.
    let devMd = null;
    try {
      devMd = readFileSync(devMdPath, 'utf8');
    } catch (error) {
      outcome.blocks.push(`cannot read ${devMdPath} (${error.code ?? error.message}) — pass --dev-md <path>, or --root to scan a directory directly`);
    }
    if (devMd !== null) {
      const declared = [...new Set(scanRootDeclarations(devMd))];
      if (declared.length > 1) {
        outcome.blocks.push(
          `${devMdPath} gives skill-scan conflicting values (${declared.join(', ')}) — an example line above the real knob would otherwise silently decide the gate; leave exactly one`,
        );
      }
      const updateDeclared = [...new Set(updateModeDeclarations(devMd))];
      if (updateDeclared.length > 1) {
        outcome.blocks.push(
          `${devMdPath} gives skillspector-update conflicting values (${updateDeclared.join(', ')}) — leave exactly one`,
        );
      }
      const unknown = updateDeclared.filter((value) => !UPDATE_MODES.has(value));
      if (unknown.length > 0) {
        // Defaulting an unrecognised value to `auto` would silently install
        // software because of a typo. The guard refuses instead.
        outcome.blocks.push(
          `${devMdPath} sets skillspector-update to ${unknown.join(', ')} — expected one of off, notify, auto`,
        );
      }
      updateMode = resolveUpdateMode(devMd);

      root = resolveScanRoot(devMd);
      skipped = root === null && declared.length <= 1;
      // The project's own suppressions apply to the project's own skills. They
      // are NOT inherited by an ad-hoc `--root` scan of someone else's skill,
      // where a rule written for our content could silence a real finding in
      // theirs.
      if (!skipped && !baselinePath && existsSync(DEFAULT_BASELINE)) baselinePath = DEFAULT_BASELINE;
    }
  }

  if (!skipped && outcome.blocks.length === 0) {
    skillspector.mode = noProvision ? 'off' : updateMode;

    // VSK_SKILLSPECTOR is the test seam, and it means "this exact binary" — so
    // it suppresses locating AND provisioning. Without that, every CLI test
    // would shell out to whatever uv/brew happen to hold on the machine running
    // the suite, and a unit suite that installs software is not a unit suite.
    if (!process.env.VSK_SKILLSPECTOR) {
      Object.assign(
        skillspector,
        await provisionForRun({
          mode: skillspector.mode,
          locate: () => locateSkillspector(),
          provision: ({ mode, located }) => provisionSkillspector({ mode, located }),
          versionOf: (path) => readVersion({ path }),
          pathVisible: () => defaultRun('skillspector', ['--version']).ok,
          fetchLatest: () => latestRelease(),
        }),
      );
      binary = skillspector.path ?? undefined;
    }

    // An uncaught throw would leave node exiting 1 — which in this guard's own
    // scheme reads as "pass with warnings". A crash is not a pass.
    try {
      facts = gatherFacts({ root, baselinePath, llm: argv.includes('--llm'), binary });
      facts.skillspector = skillspector;
      outcome = evaluateScan(facts);
    } catch (error) {
      facts = { skills: [], skillspector };
      outcome = { blocks: [`the scan failed unexpectedly: ${error.message}`], warns: [] };
    }
  }

  outcome = { ...outcome, warns: [...preWarns, ...outcome.warns] };
  const ok = outcome.blocks.length === 0;
  if (json) {
    const envelope = JSON.stringify({
      guard: 'skill-scan',
      ok,
      skipped,
      skillspector,
      ...outcome,
      // The full normalized issue list, not a count: dev-review's Security axis
      // is told to read the source at each finding's file:line and to judge
      // whether a suppression was scoped to its cause. A count makes both
      // impossible, and this report is the axis's input.
      skills: facts.skills.map(({ name, score, severity, suppressedCount, suppressed, completeness, issues }) => ({
        name, score, severity, suppressedCount, suppressed, completeness, findings: issues.length, issues,
      })),
    }, null, 2);
    // console.log writes asynchronously when stdout is a pipe. A warning-status
    // process can otherwise exit after the platform pipe buffer (64 KiB on macOS)
    // accepts only a prefix, leaving machine consumers with truncated JSON.
    writeFileSync(1, `${envelope}\n`);
  } else if (skipped) {
    console.log(`skill-scan: skipped — ${devMdPath} names no scan root (skill-scan: none or absent)`);
  } else if (facts.skills.length === 0 && outcome.blocks.length > 0) {
    console.log('skill-scan: BLOCKED');
    for (const b of outcome.blocks) console.log(`  block: ${b}`);
  } else {
    // The version/dependency change reads BEFORE the findings: after an
    // upgrade, new findings are the tool having learned something, not the diff
    // having broken something, and an operator who cannot see that debugs the
    // wrong thing.
    if (skillspector.action === 'installed' || skillspector.action === 'upgraded') {
      const span = skillspector.before === skillspector.after
        ? `version ${skillspector.version ?? 'unknown'} (unchanged)`
        : `version ${skillspector.before ?? 'none'} → ${skillspector.after ?? skillspector.version ?? 'unknown'}`;
      console.log(`skill-scan: skillspector ${skillspector.action} via ${skillspector.channel ?? 'uv'} — ${span}`);
      for (const line of skillspector.changed) console.log(`    ${line}`);
    }
    if (skillspector.action === 'failed') {
      console.log(`skill-scan: skillspector update failed, continuing with the installed copy — ${skillspector.message}`);
    }
    if (skillspector.available && skillspector.available !== skillspector.version) {
      console.log(`skill-scan: skillspector ${skillspector.available} is available (installed: ${skillspector.version ?? 'unknown'})`);
    }
    console.log(`skill-scan: ${ok ? (outcome.warns.length ? 'pass with warnings' : 'pass') : 'BLOCKED'}`);
    for (const entry of facts.skills) {
      console.log(`  ${entry.name}: score ${entry.score} ${entry.severity} — ${entry.issues.length} finding(s)`);
    }
    for (const b of outcome.blocks) console.log(`  block: ${b}`);
    for (const w of outcome.warns) console.log(`  warn: ${w}`);
  }
  process.exit(ok ? (outcome.warns.length > 0 ? 1 : 0) : 2);
}
