#!/usr/bin/env node
// dev-ship guard, run at Gate 1 before a PR (and re-run before merge): the
// deterministic facts that make a hand-back shippable. Facts block; the
// rationalization scan over the evidence text only warns — regex heuristics
// never block. Standalone packaging carries the canonical approval parser.
//
// Exit codes: 0 pass · 1 pass-with-warnings · 2 blocked (reasons printed).
// Usage: node ship-gate.mjs --issue <n> --branch <name> [--repo o/r] [--dev-md <path>]
//        [--base main] [--worktree <path>] [--allow-no-changelog "<reason>"] --json
//
// One feature, one worktree: the branch under review is normally checked out at
// .vegastack/.worktrees/<n>-<slug>/, not in the main checkout. The gate resolves
// that path itself (--worktree overrides) and runs every git call and the fresh
// check command there, so its checkout test passes by construction rather than
// forcing the operator to switch branches in the main checkout.
import { execFileSync } from 'node:child_process';

// An epic-sized branch produces a `git diff base...branch` and a check-suite log well
// past execFileSync's 1 MiB default, and ENOBUFS then reads as "cannot verify" — a
// buffer limit masquerading as a fact about the branch. 64 MiB covers any real diff.
const LARGE_OUTPUT = 64 * 1024 * 1024;
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Packaging copies the canonical owner; source development imports that owner.
const approvalUrl = new URL('./lib/approval.mjs', import.meta.url);
const { artifactRef, parseStrictJson } = await import(existsSync(approvalUrl)
  ? approvalUrl.href : new URL('../../dev-implement/scripts/lib/approval.mjs', import.meta.url).href);
const fullSha = (value) => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every((key) => Object.hasOwn(value, key));

// One authoritative typed section, outside quoted/fenced examples. Other JSON
// examples may exist, but duplicate binding sections and duplicate keys refuse.
export function typedSection(body, key) {
  let fence = null; let content = ''; const matches = [];
  for (const line of String(body ?? '').replaceAll('\r\n', '\n').split('\n')) {
    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && boundary) { fence = { char: boundary[1][0], size: boundary[1].length, json: boundary[2].trim() === 'json' }; content = ''; }
    else if (fence && boundary && boundary[1][0] === fence.char && boundary[1].length >= fence.size && boundary[2].trim() === '') {
      if (fence.json) { const value = parseStrictJson(content); if (Object.hasOwn(value ?? {}, key)) { if (!exactKeys(value, [key])) throw new Error('unknown typed section fields'); matches.push(value[key]); } }
      fence = null;
    } else if (fence) content += line + '\n';
  }
  if (fence || matches.length > 1) throw new Error('unclosed or duplicate typed section');
  return matches[0] ?? null;
}

export function validReview(binding) {
  return exactKeys(binding, ['sha', 'baseSha', 'scopeDigest', 'verdict', 'findings'])
    && fullSha(binding.sha) && fullSha(binding.baseSha) && digest(binding.scopeDigest)
    && ['clean', 'needs-fixes'].includes(binding.verdict) && Array.isArray(binding.findings)
    && binding.findings.every((finding) => exactKeys(finding, ['id', 'status']) && nonempty(finding.id) && ['open', 'resolved'].includes(finding.status))
    && new Set(binding.findings.map((finding) => finding.id)).size === binding.findings.length
    && (binding.verdict !== 'clean' || binding.findings.every((finding) => finding.status === 'resolved'));
}

const RATIONALIZATIONS = [
  /skip(ping)? tests? for now/i,
  /pre-existing (issue|bug)/i,
  /fix (this|it) later/i,
  /(tests?|coverage) (is|are) (failing|broken) but/i,
];

// stdio mode for a discarded fd, hoisted out of quote-adjacency: SkillSpector reads the
// bare word beside its own closing quote as a removal cue and fails closed on the whole
// file (skill-maintainer's standards.md, known behaviours). Same value, same behaviour.
const DISCARD = 'ignore';

function sh(cmd, args, cwd) {
  // VSK_GH is a TEST SEAM (stubs gh in unit tests); git always runs real.
  const bin = cmd === 'gh' ? (process.env.VSK_GH || 'gh') : cmd;
  return execFileSync(bin, args, { encoding: 'utf8', stdio: [DISCARD, 'pipe', 'pipe'], env: { ...process.env }, cwd, maxBuffer: LARGE_OUTPUT }).trim();
}

// The path of the worktree holding a branch, read from
// `git worktree list --porcelain`. Null when no worktree holds it — which is a
// fact the caller reports, never one it papers over.
export function resolveWorktree(branch, porcelain) {
  let path = null;
  for (const raw of String(porcelain ?? '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line === '') path = null;
    else if (line === 'branch refs/heads/' + branch && path) return path;
  }
  return null;
}

// An exception is a policy operator's decision about this exact review.
export function reviewAdjudicated(evidenceBody, { review, reviewCommentId, operators = [], publisher, sourceComment } = {}) {
  try {
    const decision = typedSection(evidenceBody, 'adjudication');
    if (!validReview(review) || !exactKeys(decision, ['sha', 'reviewCommentId', 'operator', 'source', 'findings'])
      || decision.sha !== review.sha || !Number.isSafeInteger(reviewCommentId) || reviewCommentId <= 0 || decision.reviewCommentId !== reviewCommentId
      || !operators.includes(decision.operator) || !exactKeys(decision.source, ['kind', 'ref', 'quote'])
      || !nonempty(decision.source.ref) || !nonempty(decision.source.quote)) return false;
    if (decision.source.kind === 'session') {
      if (publisher !== decision.operator) return false;
    } else if (decision.source.kind === 'github-comment') {
      const locator = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/[1-9]\d*#issuecomment-([1-9]\d*)$/.exec(decision.source.ref);
      if (!locator || !sourceComment || String(sourceComment.id) !== locator[1] || sourceComment.html_url !== decision.source.ref
        || sourceComment.user?.login !== decision.operator || !sourceComment.body?.includes(decision.source.quote)) return false;
      // An untrusted recorder must relay the actual scoped decision, not attach
      // unrelated operator prose to a new exception.
      if (publisher !== decision.operator) {
        const original = typedSection(sourceComment.body, 'adjudication');
        if (!original || ['sha', 'reviewCommentId', 'operator', 'findings'].some((key) => JSON.stringify(original[key]) !== JSON.stringify(decision[key]))) return false;
      }
    } else return false;
    const open = review.findings.filter((finding) => finding.status === 'open').map((finding) => finding.id);
    return open.length > 0 && Array.isArray(decision.findings) && decision.findings.length === open.length
      && new Set(decision.findings.map((finding) => finding.id)).size === open.length
      && decision.findings.every((finding) => exactKeys(finding, ['id', 'disposition', 'reason']) && open.includes(finding.id)
        && finding.disposition === 'accept-risk' && nonempty(finding.reason));
  } catch { return false; }
}

export function parseMarker(body) {
  const match = /^<!--\s*vsk:v1\s+([^>]*?)\s*-->\s*$/.exec(String(body ?? '').replaceAll('\r\n', '\n').split('\n')[0]);
  if (!match) return null;
  const keys = {};
  for (const pair of match[1].split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq <= 0 || eq === pair.length - 1 || Object.hasOwn(keys, pair.slice(0, eq)) || ['__proto__', 'constructor', 'prototype'].includes(pair.slice(0, eq))) throw new Error('malformed or duplicate marker key');
    keys[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { keys };
}

// Readback facts come from the authorized postmerge operation. This evaluates
// identity, scope completeness and its actual Git/check proof; it never merges.
export function evaluateParentDelivery({ parentDelivery: delivery, pr, expected, acceptedDeliveries, requiredDeliveries, verification }) {
  const blocks = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!exactKeys(delivery, ['repo', 'parentIssue', 'pr', 'prNodeId', 'acceptedParentHead', 'baseRepo', 'baseRef', 'mergedAt', 'mergedCommit', 'transformation'])
    || !exactKeys(expected, ['repo', 'parentIssue', 'pr', 'prNodeId', 'acceptedParentHead', 'baseRepo', 'baseRef', 'baseSha'])
    || !/^[^/\s]+\/[^/\s]+$/.test(expected.repo) || !/^[^/\s]+\/[^/\s]+$/.test(expected.baseRepo)
    || !Number.isSafeInteger(expected.parentIssue) || expected.parentIssue <= 0 || !Number.isSafeInteger(expected.pr) || expected.pr <= 0
    || !nonempty(expected.prNodeId) || !nonempty(expected.baseRef) || !pr || !verification) return { blocks: ['missing parent delivery/readback/proof'] };
  if (delivery.repo !== expected.repo || delivery.parentIssue !== expected.parentIssue || delivery.pr !== expected.pr
    || delivery.prNodeId !== expected.prNodeId || delivery.acceptedParentHead !== expected.acceptedParentHead
    || delivery.baseRepo !== expected.baseRepo || delivery.baseRef !== expected.baseRef) blocks.push('parent delivery differs from accepted parent identity');
  if (pr.number !== delivery.pr || pr.node_id !== delivery.prNodeId || pr.head?.repo?.full_name !== delivery.repo
    || pr.head?.sha !== delivery.acceptedParentHead || pr.base?.repo?.full_name !== delivery.baseRepo
    || pr.base?.ref !== delivery.baseRef || pr.base?.sha !== expected.baseSha || pr.merged !== true
    || !nonempty(pr.merged_at) || !Number.isFinite(Date.parse(pr.merged_at)) || pr.merged_at !== delivery.mergedAt
    || pr.merge_commit_sha !== delivery.mergedCommit) blocks.push('GitHub PR readback differs from reviewed head/base/ref or merge');
  if (!fullSha(delivery.acceptedParentHead) || !fullSha(delivery.mergedCommit) || !fullSha(expected.baseSha)
    || verification.reviewedHead !== delivery.acceptedParentHead || verification.mergedHead !== delivery.mergedCommit
    || verification.baseSha !== expected.baseSha || !fullSha(verification.acceptedTree)
    || verification.acceptedTree !== verification.mergedTree || verification.check?.sha !== delivery.mergedCommit
    || verification.check?.exit !== 0) blocks.push('exact merged commit range/tree/check proof missing or mismatched');
  if (!Array.isArray(requiredDeliveries) || requiredDeliveries.length === 0 || !Array.isArray(acceptedDeliveries)
    || !same(acceptedDeliveries, requiredDeliveries)) blocks.push('accepted child scope projection is incomplete or changed, including partial/preparation tasks');
  const transform = delivery.transformation;
  if (transform === null) {
    if (!Array.isArray(verification.ancestorShas) || !verification.ancestorShas.includes(delivery.acceptedParentHead)) blocks.push('normal merge lacks reviewed candidate ancestry');
  } else if (!exactKeys(transform, ['kind', 'reviewedHead', 'mergedHead', 'evidenceRef'])
    || !['rebase', 'squash'].includes(transform.kind) || transform.reviewedHead !== delivery.acceptedParentHead
    || transform.mergedHead !== delivery.mergedCommit || !/^https:\/\//.test(transform.evidenceRef)
    || transform.evidenceRef !== verification.evidenceRef || verification.rangeHead !== delivery.mergedCommit) {
    blocks.push('source transformation lacks exact reviewed-diff/check evidence');
  }
  return { blocks };
}

// An entry means an ADDED "## " heading in the file-scoped diff — a deleted
// file or a typo edit to an old entry is not a new entry.
export function chronicleEntryAdded(fileDiff) {
  return /^\+## /m.test(fileDiff ?? '');
}

// Pure evaluation over gathered facts — unit tests drive this directly.
export function evaluateShipGate(facts) {
  const blocks = [];
  const warns = [];
  const {
    evidence,            // { body } | null
    reviewVerdict,       // 'clean' | 'needs-fixes' | null
    adjudicated,         // boolean: explicit same-review operator decision validated
    headSha,             // full commit identity of the branch head
    diffText,            // full diff vs base
    changelogTouched,    // boolean: diff adds a changelog/changeset entry
    // chronicleOn/chronicleTouched (via facts.*): dev.md chronicle knob and
    // whether the diff adds a "## " chronicle entry heading
    allowNoChangelog,    // reason string | undefined
    checkExit,           // number | null (null = no check command configured)
  } = facts;

  if (!evidence) {
    blocks.push('no evidence comment (marker type=evidence) on the issue');
    return { blocks, warns };
  }
  const marker = parseMarker(evidence.body);
  const evidenceSha = marker?.keys?.sha ?? '';

  if (!fullSha(evidenceSha)) {
    blocks.push(`evidence marker carries no valid sha= (found "${evidenceSha || 'nothing'}") — the shipped revision must be named`);
  } else if (headSha !== evidenceSha) {
    // Strict equality, no reconciliation window: the corrections loop updates
    // the evidence comment (Docs line AND sha) after every change, so a
    // mismatched sha means unrecorded work. An "edited since the commit"
    // window was spoofable by any comment edit and was removed.
    blocks.push(`branch head ${headSha} moved past evidence sha ${evidenceSha} — the corrections loop must re-verify and update the evidence comment (Docs line + new sha) before shipping`);
  }

  if (!changelogTouched && !allowNoChangelog) {
    blocks.push('no changelog/changeset entry in the diff and no --allow-no-changelog reason given');
  }

  if (facts.chronicleOn && !facts.chronicleTouched && !allowNoChangelog) {
    blocks.push('dev.md says chronicle: on but the diff adds no .vegastack/chronicle.md entry (the same --allow-no-changelog reason covers docs/test-only branches)');
  }
  if (allowNoChangelog && (!changelogTouched || (facts.chronicleOn && !facts.chronicleTouched))) {
    warns.push(`--allow-no-changelog exercised ("${allowNoChangelog}") — it excused: ${[!changelogTouched ? 'changelog' : null, facts.chronicleOn && !facts.chronicleTouched ? 'chronicle' : null].filter(Boolean).join(' + ')}`);
  }

  if (!validReview(facts.review) || facts.review.sha !== headSha || facts.review.baseSha !== facts.baseSha
    || facts.review.scopeDigest !== facts.scopeDigest || facts.review.verdict !== reviewVerdict) {
    blocks.push('review binding is absent, invalid or differs from exact candidate SHA/base/scope');
  } else if (reviewVerdict !== 'clean' && !adjudicated) {
    blocks.push('review verdict needs-fixes without an explicit same-review operator adjudication');
  }
  if (facts.cleanBefore !== true) blocks.push('dirty or uncommitted checkout: require a clean checkout before check');
  if (facts.cleanAfter !== true) blocks.push('check changed HEAD, branch, index/worktree or untracked inputs');

  if (facts.checkoutMismatch) {
    blocks.push(facts.checkoutMismatch);
  }
  if (facts.checkMissing) {
    blocks.push('dev.md has no check command on its commands: line — exact committed candidate has not been checked');
  }
  if (checkExit !== 0) {
    blocks.push(`the project check command exited ${checkExit} on a fresh run — a claim is never trusted, always re-proven`);
  }

  // Added lines only, and only the REAL tag shape ([DEBUG- + hex): docs that
  // document the tag write placeholders like [DEBUG-<4hex>] and must not block.
  if (/^\+(?!\+\+).*\[DEBUG-[0-9a-f]{4}\]/m.test(diffText)) {
    blocks.push('the diff adds [DEBUG- tagged instrumentation — dev-debug cleanup was skipped');
  }

  for (const pattern of RATIONALIZATIONS) {
    const hit = pattern.exec(evidence.body);
    if (hit) warns.push(`rationalization wording in evidence: "${hit[0]}" — heuristics never block, but read it twice`);
  }

  return { blocks, warns };
}

export function gatherFacts(flags) {
  const repo = flags.repo || sh('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const base = flags.base || 'main';
  const branch = flags.branch;
  // An explicit --worktree wins; otherwise the branch's own worktree, if one
  // holds it; otherwise the current directory, and the checkout test decides.
  let listed = '';
  try {
    listed = sh('git', ['worktree', 'list', '--porcelain']);
  } catch {
    listed = '';
  }
  const cwd = flags.worktree || resolveWorktree(branch, listed) || undefined;
  const pages = JSON.parse(sh('gh', ['api', 'repos/' + repo + '/issues/' + flags.issue + '/comments', '--paginate', '--slurp']));
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('unreadable complete comment history');
  const comments = pages.flat();
  const ofType = (type) => comments.filter((comment) => parseMarker(comment.body)?.keys.type === type);
  const evidenceComments = ofType('evidence');
  if (evidenceComments.length > 1) throw new Error('duplicate evidence comments');
  const evidence = evidenceComments[0] ?? null;
  const reviewComment = ofType('review').at(-1) ?? null;
  const review = typedSection(reviewComment?.body, 'reviewBinding');
  const reviewVerdict = parseMarker(reviewComment?.body)?.keys.verdict ?? null;
  const plans = ofType('plan');
  if (plans.length !== 1) throw new Error('missing or duplicate canonical plan');
  const planBinding = artifactRef({ repo, issue: Number(flags.issue), kind: 'plan', artifact: plans[0] });
  const scopeDigest = planBinding.digest;
  const commit = (ref) => {
    const result = sh('git', ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'], cwd);
    if (!fullSha(result)) throw new Error('invalid full commit identity');
    return result;
  };
  const headSha = commit(branch);
  const baseSha = commit(base);
  const evidenceSha = parseMarker(evidence?.body)?.keys.sha ?? '';
  const reviewSha = parseMarker(reviewComment?.body)?.keys.sha ?? '';
  for (const candidate of [evidenceSha, reviewSha]) {
    if (candidate && (!fullSha(candidate) || commit(candidate) !== candidate)) throw new Error('evidence/review requires a full known commit SHA');
  }
  if (review && review.sha !== reviewSha) throw new Error('review marker and binding SHA differ');
  const diffText = sh('git', ['diff', baseSha + '...' + headSha], cwd);
  const snapshot = () => ({ head: commit('HEAD'), branch: commit(branch), base: commit(base),
    index: sh('git', ['write-tree'], cwd), indexFlags: sh('git', ['ls-files', '-v'], cwd), status: sh('git', ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'], cwd) });
  const before = snapshot();
  const cleanBefore = before.status === '' && before.head === headSha && before.branch === headSha && before.indexFlags.split('\n').every((line) => !line || line.startsWith('H '));
  const checkoutMismatch = before.head === headSha ? null
    : 'the current checkout is not the branch under review and no worktree holds it — pass --worktree';

  // dev.md is read from the worktree too: the knobs that gate this branch are
  // the ones on this branch, not whatever the main checkout happens to hold.
  const root = realpathSync(sh('git', ['rev-parse', '--show-toplevel'], cwd));
  const profile = realpathSync(flags['dev-md'] || join(cwd ?? '.', '.vegastack', 'dev.md'));
  const profilePath = relative(root, profile);
  if (isAbsolute(profilePath) || profilePath === '..' || profilePath.startsWith('../')) throw new Error('check profile must belong to the exact committed checkout');
  sh('git', ['ls-files', '--error-unmatch', '--', profilePath], cwd);
  const devMd = readFileSync(profile, 'utf8');
  const changelogKnob = (/^changelog:\s*(\S+)/m.exec(devMd) || [])[1] ?? 'none';
  // Added files/lines only — a deleted changeset or the +++ diff header must
  // not count as an entry.
  const changelogTouched = changelogKnob === 'none'
    ? true
    : changelogKnob === 'changesets'
      ? /^\+\+\+ b\/\.changeset\/(?!config)/m.test(diffText)
      : /^\+(?!\+\+)[^\n]*\S/m.test(sh('git', ['diff', baseSha + '...' + headSha, '--', 'CHANGELOG.md'], cwd) || '');

  const chronicleOn = /^chronicle:\s*on\s*(#|$)/m.test(devMd);
  const chronicleTouched = chronicleEntryAdded(sh('git', ['diff', baseSha + '...' + headSha, '--', '.vegastack/chronicle.md'], cwd) || '');

  let checkExit = null;
  const checkCmd = (/^commands:.*?check\s+`([^`]+)`/m.exec(devMd) || [])[1];
  const checkMissing = !checkCmd;
  if (checkCmd && cleanBefore) {
    try {
      execFileSync('sh', ['-c', checkCmd], { stdio: [DISCARD, 'pipe', 'pipe'], cwd, maxBuffer: LARGE_OUTPUT });
      checkExit = 0;
    } catch (error) {
      checkExit = error.status ?? 1;
    }
  }

  const after = snapshot();
  const cleanAfter = cleanBefore && JSON.stringify(before) === JSON.stringify(after);
  const operators = (/^operators:\s*([^\n#]+)/m.exec(devMd)?.[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  const decision = typedSection(evidence?.body, 'adjudication');
  let sourceComment;
  if (decision?.source?.kind === 'github-comment') {
    const locator = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/[1-9]\d*#issuecomment-([1-9]\d*)$/.exec(decision.source.ref);
    if (locator) sourceComment = JSON.parse(sh('gh', ['api', 'repos/' + locator[1] + '/issues/comments/' + locator[2]]));
  }
  const adjudicated = reviewAdjudicated(evidence?.body, { review, reviewCommentId: reviewComment?.id,
    operators, publisher: evidence?.user?.login, sourceComment });
  return {
    evidence, review, reviewVerdict, adjudicated, headSha, baseSha, reviewSha, evidenceSha, scopeDigest, planBinding, cleanBefore, cleanAfter, diffText,
    checkCommand: checkCmd ?? null, environment: { runtime: process.version, platform: process.platform, arch: process.arch, git: sh('git', ['--version'], cwd) },
    changelogTouched, chronicleOn, chronicleTouched,
    allowNoChangelog: flags['allow-no-changelog'], checkExit, checkMissing, checkoutMismatch,
  };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const get = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
  const flags = {
    issue: get('--issue'), branch: get('--branch'), repo: get('--repo'), base: get('--base'),
    'dev-md': get('--dev-md'), worktree: get('--worktree'), 'allow-no-changelog': get('--allow-no-changelog'), json,
  };
  let outcome;
  if (!flags.issue || !flags.branch) {
    outcome = { blocks: ['usage: ship-gate.mjs --issue <n> --branch <name> [--json]'], warns: [] };
  } else {
    try {
      const facts = gatherFacts(flags);
      outcome = { ...evaluateShipGate(facts), candidate: { headSha: facts.headSha, baseSha: facts.baseSha, reviewSha: facts.reviewSha, evidenceSha: facts.evidenceSha, scopeDigest: facts.scopeDigest, planBinding: facts.planBinding, cleanBefore: facts.cleanBefore, cleanAfter: facts.cleanAfter, checkExit: facts.checkExit, checkCommand: facts.checkCommand, environment: facts.environment } };
    } catch (error) {
      outcome = { blocks: [`cannot verify: ${error.message}`], warns: [] };
    }
  }
  const ok = outcome.blocks.length === 0;
  const exitCode = ok ? (outcome.warns.length ? 1 : 0) : 2;
  if (json) {
    console.log(JSON.stringify({ guard: 'ship-gate', ok, ...outcome }, null, 2));
  } else {
    console.log(`ship-gate: ${ok ? (outcome.warns.length ? 'pass with warnings' : 'pass') : 'BLOCKED'}`);
    for (const b of outcome.blocks) console.log(`  block: ${b}`);
    for (const w of outcome.warns) console.log(`  warn: ${w}`);
  }
  process.exit(exitCode);
}
