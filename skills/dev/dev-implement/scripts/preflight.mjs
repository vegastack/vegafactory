#!/usr/bin/env node
// dev-implement preflight guard: the deterministic facts that must hold before
// an agent may claim an issue. Facts block (exit 2 with reasons); nothing here
// warns — judgment checks stay in the skill prose.
//
// Exit codes: 0 pass · 1 pass-with-warnings · 2 blocked (reasons printed).
// Usage: node preflight.mjs --issue <n> [--repo owner/name] [--me <login>] [--dev-md <path>] --json
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GhUnavailable, ghJson, parseFlags, renderResult } from './lib/gh.mjs';
import { evaluateApprovals, readApprovalSources, gatherConsolidatedApproval } from './lib/approval.mjs';

export function evaluatePreflight({ issue, comments, devMd, me, expect = 'ready', stage = 'implement', sourceComments = [] }) {
  const blocks = [];
  const warns = [];
  const labels = (issue.labels ?? []).map((l) => l.name);

  if (issue.state && issue.state !== 'open') blocks.push(`issue is ${issue.state} — only open issues are workable`);
  const STATE_LABELS = ['needs-operator', 'needs-plan', 'ready', 'working', 'for-operator'];
  const state = STATE_LABELS.filter((s) => labels.includes(s));
  if (!state.includes(expect)) {
    blocks.push(`issue state label is [${state.join(', ') || 'none'}], expected ${expect} (fresh start: ready · resume: working with the operator's handover · corrections: for-operator)`);
  }

  const scope = ['research', 'quick-build', 'full-plan'].filter((s) => labels.includes(s));
  if (scope.length !== 1) blocks.push(`issue needs exactly one scope label (research | quick-build | full-plan), found: ${scope.join(', ') || 'none'}`);
  const operators = (/^operators:\s*([^#\n]+)/m.exec(devMd ?? '')?.[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  const approval = evaluateApprovals({ repo: issue.repo, issue: issue.number, brief: issue, comments, operators,
    sourceComments, requiredScope: stage === 'plan' || scope[0] === 'research' ? 'brief' : 'brief+plan' });
  blocks.push(...approval.blocks);
  if (scope[0] === 'research' && stage !== 'plan') blocks.push('research execution requires consolidated protocol, candidate and shared allowance admission');

  // The brief-template rule: a resolved Assumptions section is deleted, so the
  // heading's presence at all means unresolved entries remain.
  if (/^##\s+Assumptions\b/m.test(issue.body ?? '')) {
    blocks.push('the brief still carries a "## Assumptions" section — resolve every entry (the section is deleted once resolved) before starting');
  }

  const openBlockers = issue.blockedBy ?? [];
  if (openBlockers.length > 0) blocks.push(`open blockers: ${openBlockers.map((b) => `#${b.number}`).join(', ')}`);

  // Who the assignee is depends on the state (conventions' Labels table): `ready`
  // is unassigned, `working` is the claimant, `for-operator` is the operator. So a
  // foreign assignee blocks on the first two — someone else's claim — and is the
  // expected shape on a corrections run, where the hand-back moved the assignee to
  // the operator and the runner's gh login need not be that person. On `ready`,
  // an assignee that is you is a fact worth naming, not a stop — a human may have
  // picked it up by hand, and a block would strand a claimable issue.
  const assigned = (issue.assignees ?? []).map((a) => a.login);
  const others = assigned.filter((l) => l !== me);
  if (others.length > 0 && expect !== 'for-operator') {
    const why = expect === 'working'
      ? 'a working issue belongs to its claimant'
      : "a ready issue is unassigned by convention, so another assignee is someone else's claim";
    blocks.push(`already assigned to ${others.join(', ')} — ${why}`);
  }
  if (expect === 'ready' && assigned.length > 0) {
    warns.push(`a ready issue is unassigned by convention; this one is assigned to ${assigned.join(', ')} — confirm nobody else is mid-claim before taking it`);
  }

  const repoLine = /^repo:\s*(\S+)/m.exec(devMd ?? '');
  if (!repoLine) {
    warns.push('dev.md has no repo: line — the issue-repo match could not be verified');
  } else if (issue.repo && repoLine[1] !== issue.repo) {
    blocks.push(`issue repo ${issue.repo} does not match dev.md repo ${repoLine[1]}`);
  }

  return { blocks, warns, bindings: approval.bindings, approvalIds: approval.approvalIds };
}

// Both CLI and dispatcher use this owner reader and evaluator. The injected
// reader is transport only, never an approval verdict or policy override.
export async function gatherAndEvaluate(flags, { readJson = async (args) => ghJson(args), devMd: suppliedDevMd } = {}) {
  const pages = async (args) => {
    const result = await readJson([...args, '--paginate', '--slurp']);
    if (!Array.isArray(result) || !result.every(Array.isArray)) throw new GhUnavailable('malformed paginated GitHub history');
    return result.flat();
  };
  const repo = flags.repo || (await readJson(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
  if (flags['consolidated-request']) {
    const request = JSON.parse(readFileSync(flags['consolidated-request'], 'utf8'));
    const devMd = suppliedDevMd ?? readFileSync(flags['dev-md'] || '.vegastack/dev.md', 'utf8');
    const operators = (/^operators:\s*([^#\n]+)/m.exec(devMd)?.[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean);
    return { ...(await gatherConsolidatedApproval({ ...request, operators, readJson })), warns: [] };
  }
  const issueNumber = flags.issue;
  const raw = await readJson(['api', 'repos/' + repo + '/issues/' + issueNumber]);
  const comments = await pages(['api', 'repos/' + repo + '/issues/' + issueNumber + '/comments']);
  // Missing dependency data cannot establish absence; do not treat a 404 as approval.
  const blockedBy = (await pages(['api', 'repos/' + repo + '/issues/' + issueNumber + '/dependencies/blocked_by']))
    .filter((entry) => entry.state !== 'closed');
  const devMd = suppliedDevMd ?? readFileSync(flags['dev-md'] || '.vegastack/dev.md', 'utf8');
  const sourceComments = await readApprovalSources(comments, readJson);
  const me = flags.me || (await readJson(['api', 'user'])).login;
  return evaluatePreflight({ issue: { ...raw, repo, blockedBy }, comments, devMd, me, sourceComments,
    expect: flags.expect || 'ready', stage: flags.stage || 'implement' });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const flags = parseFlags(process.argv.slice(2));
  let outcome;
  try {
    outcome = await gatherAndEvaluate(flags);
  } catch (error) {
    outcome = { blocks: [error instanceof GhUnavailable ? `cannot verify: ${error.message}` : `preflight error: ${error.message}`], warns: [] };
  }
  const { exitCode, text } = renderResult('preflight', outcome, { json: Boolean(flags.json) });
  console.log(text);
  process.exit(exitCode);
}
