#!/usr/bin/env node
// dev-implement preflight guard: the deterministic facts that must hold before
// an agent may claim an issue. Facts block (exit 2 with reasons); nothing here
// warns — judgment checks stay in the skill prose.
//
// Exit codes: 0 pass · 1 pass-with-warnings · 2 blocked (reasons printed).
// Usage: node preflight.mjs --issue <n> [--repo owner/name] [--me <login>] [--dev-md <path>] --json
// --stage plan requires brief intent; implementation requires brief+plan.
// --consolidated-request <json> reads an exact pinned parent selection.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { preparationTaskContracts } from './recovery.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GhUnavailable, ghJson, parseFlags, renderResult } from './lib/gh.mjs';
import { evaluateApprovals, readApprovalSources, gatherConsolidatedApproval, parseStrictJson, readPages, scopeDigest } from './lib/approval.mjs';
const policyUrl = new URL('./effective-policy.mjs', import.meta.url);
const { resolveState, readWorkflowLabels, loadConfiguredPolicy, DEFAULT_LABELS } = await import(existsSync(policyUrl) ? policyUrl.href : new URL('../../dev-setup/scripts/effective-policy.mjs', import.meta.url).href);

export function evaluatePreflight({ issue, comments, devMd, me, expect = 'ready', stage = 'implement', sourceComments = [], configuredPolicy = null }) {
  const blocks = [];
  const warns = [];
  const labels = (issue.labels ?? []).map((l) => l.name);

  if (issue.state && issue.state !== 'open') blocks.push(`issue is ${issue.state} — only open issues are workable`);
  let labelMap;
  try { labelMap = configuredPolicy?.policy.values['workflow-labels'] ?? readWorkflowLabels(devMd ?? ''); }
  catch (error) { blocks.push(error.message); }
  if (configuredPolicy) blocks.push(...configuredPolicy.blocks);
  const resolvedState = resolveState(labels, labelMap);
  blocks.push(...resolvedState.blocks);
  const expectedState = Object.entries(DEFAULT_LABELS).find(([key, name]) => key === expect || name === expect)?.[0];
  if (!expectedState || resolvedState.state !== expectedState) blocks.push('issue state label is ' + (resolvedState.state ?? 'unresolved') + ', expected ' + expect);


  const scope = ['research', 'quick-build', 'full-plan'].filter((s) => labels.includes(s));
  if (scope.length !== 1) blocks.push(`issue needs exactly one scope label (research | quick-build | full-plan), found: ${scope.join(', ') || 'none'}`);
  const operators = (/^operators:\s*([^#\n]+)/m.exec(devMd ?? '')?.[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  const approval = evaluateApprovals({ repo: issue.repo, issue: issue.number, brief: issue, comments, operators,
    sourceComments, requiredScope: stage === 'plan' || scope[0] === 'research' ? 'brief' : 'brief+plan' });
  blocks.push(...approval.blocks);
  if (scope[0] === 'research' && stage !== 'plan') blocks.push('research execution requires consolidated protocol, candidate and shared allowance admission');

  // Resolved entries and explicitly later live requirements are retained as
  // context. Unclassified assumptions still require reconciliation.
  const assumptions = /^##\s+Assumptions\b[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(issue.body ?? '')?.[1];
  if (assumptions?.split('\n').some(line => /^\s*-\s+/.test(line) && !/^\s*-\s+\[x\]/i.test(line) && !/\b(?:resolved|verified):/i.test(line))) {
    blocks.push('unresolved execution-scope Assumptions require reconciliation before full execution');
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
  const operatorPlanning = stage === 'plan' && expect === 'needs-plan' && others.every((login) => operators.includes(login));
  if (others.length > 0 && expect !== 'for-operator' && !operatorPlanning) {
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

  return { state: resolvedState.state, labelMap, blocks, warns, bindings: approval.bindings, approvalIds: approval.approvalIds, approvalBindings: approval.approvalBindings };
}

// Both CLI and dispatcher use this owner reader and evaluator. The injected
// reader is transport only, never an approval verdict or policy override.
export async function gatherAndEvaluate(flags, { readJson = async (args) => ghJson(args), devMd: suppliedDevMd, configuredPolicy, preparationAdapter } = {}) {
  const pages = (args) => readPages(readJson, args);
  const repo = flags.repo || (await readJson(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
  if (flags['consolidated-request']) {
    const request = parseStrictJson(readFileSync(flags['consolidated-request'], 'utf8'));
    if (Object.keys(request).some((key) => !['parentRepo', 'parentIssue', 'approvalBinding', 'requested', 'admissionEvidence'].includes(key))) throw new Error('unknown consolidated request field');
    const devMd = suppliedDevMd ?? readFileSync(flags['dev-md'] || '.vegastack/dev.md', 'utf8');
    const policyRepo = /^repo:\s*(\S+)/m.exec(devMd)?.[1];
    if (policyRepo !== repo || request.parentRepo !== repo || request.requested?.repo !== repo) throw new Error('consolidated request and current policy repository differ');
    const operators = (/^operators:\s*([^#\n]+)/m.exec(devMd)?.[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean);
    return { ...(await gatherConsolidatedApproval({ ...request, operators, readJson, preparationAdapter: preparationAdapter ?? packagedPreparationAdapter({ readJson }) })), warns: [] };
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
  return evaluatePreflight({ issue: { ...raw, repo, blockedBy }, comments, devMd, me, sourceComments, configuredPolicy: configuredPolicy ?? loadConfiguredPolicy({ home: homedir(), repo, devMd }),
    expect: flags.expect || 'ready', stage: flags.stage || 'implement' });
}

export function packagedPreparationAdapter({readJson, inspectAcceptedIntegration} = {}) {
  return {
    async readTaskPrerequisites(request) {
      const {parent,plan,taskIds,approvalBinding}=request;
      const source=await readJson(['api','repos/'+parent.repo+'/issues/comments/'+approvalBinding.commentId]);
      if(source.id!==approvalBinding.commentId || createHash('sha256').update(source.body).digest('hex')!==approvalBinding.bodySha256 || source.issue_url!=='https://api.github.com/repos/'+parent.repo+'/issues/'+parent.issue) throw Error('canonical preparation source changed');
      const comments=await readPages(readJson,['api','repos/'+plan.repo+'/issues/'+plan.issue+'/comments']);
      const matching=comments.filter(row=>row.node_id===plan.artifactId);
      if(matching.length!==1||scopeDigest(matching[0].body,'plan')!==plan.digest)throw Error('canonical preparation plan changed');
      // canonicalScope is intentionally opaque to consumers. Its parser exposes
      // exact files through the validated source task declarations below.
      const selectedFiles=(body,ids)=>{
        const starts=[...body.matchAll(/^-\s*\[[ x]\].*<!--\s*task-id:([1-9]\d*-T[1-9]\d*)\s*-->.*$/gim)];
        return starts.flatMap((row,index)=>ids.includes(row[1])?[...body.slice(row.index,starts[index+1]?.index??body.length).split('\n').find(line=>/^\s*- Files\s/.test(line)).matchAll(/`([^`]+)`/g)].map(match=>match[1]):[]);
      };
      return {parent,plan,tasks:preparationTaskContracts(matching[0].body,taskIds,selectedFiles),approvalBinding};
    },
    async inspectAcceptedIntegration(contract) {
      if(inspectAcceptedIntegration)return inspectAcceptedIntegration(contract);
      const cli=fileURLToPath(new URL('../../../dist/index.js',import.meta.url));
      if(!existsSync(cli))throw Error('installed preparation integration owner unavailable');
      const result=spawnSync(process.execPath,[cli,'children','inspect-preparation','--json'],{input:JSON.stringify(contract),encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
      if(result.status!==0||result.error||result.signal)throw Error('accepted preparation integration unavailable');
      return parseStrictJson(result.stdout);
    },
  };
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
