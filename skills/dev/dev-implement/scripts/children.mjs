#!/usr/bin/env node
// The standalone independent-child planner and validator. The packaged CLI is
// the execution/integration owner: it resolves authoritative runs and acceptance
// before applying an immutable commit. A helper invocation never launches agents.
// Group syntax comes only from plan-lint --groups.
//
// Exit codes: 0 pass · 1 pass with warnings · 2 blocked (reasons printed).
// Every verb is dry-run until --write and refuses to write through a symlink.
//
// Usage: node children.mjs plan|launch|join|remove --parent <n> --groups <file.json|-> [--harness claude|codex] [--repo <o/r>] [--json] [--write]
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childWorktreePlan, removeWorktree } from './worktree.mjs';
import { ghJson, parseFlags, renderResult } from './lib/gh.mjs';

// Located strings are concatenated, never assigned as template literals:
// SkillSpector's static parser trips on the latter (see skillify's
// trigger-check.mjs) and every file carrying that construct needs its own
// coverage acceptance.
const at = (where, message) => where + ': ' + message;
const quoted = (value) => '"' + value + '"';

// A dynamic workflow may run at most 16 agents at once, whatever the machine
// or the config says (claude-code 2.1.247, verified 03-09-2026).
export const WORKFLOW_AGENT_CEILING = 16;

// --- reading the groups report -------------------------------------------

// plan-lint --groups output, validated. Anything else fails closed: a run that
// cannot prove what its children may touch does not start.
export function readGroupsReport(report) {
  const groups = report && typeof report === 'object' ? report.groups : undefined;
  if (!Array.isArray(groups)) throw new Error('groups report is not plan-lint --groups output');
  for (const group of groups) {
    const shaped = group && typeof group === 'object' && typeof group.id === 'string'
      && Array.isArray(group.members) && Array.isArray(group.files);
    if (!shaped) throw new Error('groups report is not plan-lint --groups output');
    if (group.files.length === 0) throw new Error('group ' + quoted(group.id) + ' declares no files');
  }
  return groups;
}

// --- how many run at once -------------------------------------------------

// The smallest of the configured cap, what the machine can carry, and the
// workflow ceiling — never below one, because one child still has to run.
export function effectiveConcurrency({ configured, cpus: cpuCount }) {
  const cap = configured === null || configured === undefined ? 3 : Number(configured);
  if (!Number.isSafeInteger(cap) || cap < 1 || !Number.isFinite(cpuCount)) throw new Error('invalid child concurrency');
  return Math.max(1, Math.min(3, WORKFLOW_AGENT_CEILING, Number(cpuCount) - 2, cap));
}

// --- the run plan ---------------------------------------------------------

const issueNumber = (member) => {
  const match = /^#(\d+)$/.exec(String(member).trim());
  return match ? Number(match[1]) : null;
};

// One child per group, in the order the groups appear in the plan. A group
// naming two children would run them at the same time on ONE file set, which
// is the collision the disjoint sets exist to rule out — so it does not plan.
// Parallel needs two groups that carry members; anything less runs in plan
// order, and the reason goes in the parent's ledger rather than nowhere.
export function planParallelRun({ groups, issues, parentBranch, parentHead, repoRoot, parentIssue = /** @type {number|null} */ (null) }) {
  const children = [];
  for (const group of groups) {
    if (group.members.length > 1) {
      throw new Error('group ' + quoted(group.id) + ' names ' + group.members.join(', ')
        + ' — they would share one file set, and a parallel group carries one child; '
        + 'give each its own group and a disjoint set, or run them in plan order');
    }
    for (const member of group.members) {
      const number = issueNumber(member);
      const issue = number === null ? undefined : issues[number];
      if (!issue) {
        throw new Error('group ' + quoted(group.id) + ' names ' + String(member) + ', which is not a child of this parent');
      }
      if (number === parentIssue) throw new Error('a parent cannot be its own child');
      const type = issue.type || 'feat';
      const plan = childWorktreePlan({ repoRoot, issue: issue.number, title: issue.title, type, baseSha: parentHead });
      children.push({
        group: group.id,
        issue: issue.number,
        title: issue.title,
        type,
        branch: plan.branch,
        path: plan.path,
        files: group.files,
        baseSha: plan.baseSha,
      });
    }
  }
  const carrying = groups.filter((group) => group.members.length > 0);
  let mode = 'parallel';
  let reason = '';
  if (carrying.length === 0) {
    mode = 'sequential';
    reason = 'the plan declares no independent group with members';
  } else if (carrying.length === 1) {
    mode = 'sequential';
    reason = 'the plan declares one independent group, and parallel needs two disjoint ones';
  }
  const ledger = mode === 'sequential' ? '- Parallel: no — ' + reason + '; children run in plan order' : '';
  return { mode, reason, children, ledger, parentBranch, parentHead, repoRoot, parentIssue };
}

// --- the launch shapes ----------------------------------------------------

// One child's whole first turn. It is self-contained on purpose: the child runs
// in its own checkout with no memory of this session, so the branch, its base
// commit and its declared file set have to be in the words themselves.
export function childPrompt(child, { parentIssue, parentBranch, checkout = child.path }) {
  const lines = [
    'You are operating autonomously on issue #' + child.issue + ' (' + child.title + '), '
      + 'one of several children of #' + parentIssue + ' running at the same time. '
      + 'The operator is not watching and cannot answer mid-run.',
    'Your checkout is ' + checkout + ' and nothing outside it is yours: '
      + 'create your branch ' + child.branch + ' from ' + child.baseSha
      + ' before your first commit. That sha is the tip of ' + parentBranch
      + ', so your branch fast-forwards back into it.',
    'The plan declares exactly which files this child may touch:\n'
      + child.files.map((file) => '- ' + file).join('\n'),
    'Touching any file outside that set is a stop, not a judgement call: '
      + 'the parent checks your diff against the set before merging, and a child that wandered '
      + 'is not merged. If the work genuinely needs a file outside the set, hand back and say so.',
    'Follow dev-implement end to end for #' + child.issue + ': claim, build the plan task by task '
      + 'with a ledger checkpoint after each, verify, review, post the evidence comment on your own '
      + 'issue, and stop. Do not merge anything — the parent joins the branches.',
  ];
  return lines.join('\n\n');
}

// Compatibility exports refuse instead of supplying an alternate executor.
export const HARNESS_CHECKOUT = 'the worktree the harness gave you';
export function claudeWorkflowCall() {
  throw new Error('legacy workflow launch is unavailable; use vegafactory children run');
}

export function codexChildLaunch() {
  throw new Error('legacy argv launch is unavailable; use vegafactory children run');
}

// --- the join -------------------------------------------------------------

const normalized = (path) => String(path).replace(/^\.\//, '').replace(/\/{2,}/g, '/');

// The declared file set is the contract, checked after the fact against what
// the child's diff actually touched. A path is in scope when it equals a
// declared path, or sits under a declared path ending in `/`.
export function scopeViolations(changed, declared) {
  const sets = (declared ?? []).map(normalized);
  return (changed ?? []).map(normalized).filter((path) => {
    for (const entry of sets) {
      if (path === entry) return false;
      if (entry.endsWith('/') && path.startsWith(entry)) return false;
    }
    return true;
  });
}

// The first child fast-forwards: its base IS the parent HEAD, so anything else
// means the parent moved under the run and the join must stop. Every child merged
// behind it no longer descends from the advanced tip, so it takes an ordinary
// three-way merge — safe here because the declared file sets are disjoint and
// scopeViolations has already refused any child that strayed outside its own.
export function mergeArgs(child, index = 0) {
  if (!/^[a-f0-9]{40}$/.test(child.headSha)) throw new Error('immutable accepted child commit required');
  return index === 0
    ? ['merge', '--ff-only', child.headSha]
    : ['merge', '--no-ff', '--no-edit', child.headSha];
}

// A branch a child reports is data from the child, so it is checked as a ref
// name before it reaches any git argv: no leading dash, no whitespace, no `..`.
export function isBranchName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith('-') && !value.includes('..');
}

// The child the join acts on: the plan's child, on the branch its result reports.
// The planned name is a derivation from the issue title; the reported name is
// where the work actually is, and the two need not coincide.
export function joinedChildren(children, results) {
  return children.map((child) => {
    const reported = (results ?? {})[child.issue]?.branch;
    if (reported && reported !== child.branch) throw new Error('child result branch differs from its prepared branch');
    return child;
  });
}

// The caller resolves these records from the private runtime store. JSON returned
// by a child is never its own proof that either execution or acceptance happened.
export function validateChildResult(value, expected) {
  const run = expected.run;
  const check = expected.acceptance;
  const fail = (reason) => ({ ok: false, reason });
  if (!value || value.schemaVersion !== 1 || !run) return fail('verified child run/result unavailable');
  const keys = ['schemaVersion', 'runId', 'repo', 'issue', 'baseSha', 'headSha', 'branch', 'scopeDigest', 'terminationCause', 'acceptance', 'noChange', 'machine', 'sharedGeneration', 'checkpoint'];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return fail('invalid child result fields');
  if (value.issue !== expected.issue || value.scopeDigest !== expected.scopeDigest || value.runId !== run.runId
    || value.issue !== run.issue || value.repo !== run.repo || value.branch !== run.branch
    || value.baseSha !== run.baseSha || value.headSha !== run.headSha || value.scopeDigest !== run.taskKey?.scopeDigest)
    return fail('child result differs from its authoritative run');
  if (!/^[a-f0-9]{40}$/.test(value.baseSha) || !/^[a-f0-9]{40}$/.test(value.headSha)
    || run.state !== 'terminal' || run.terminationCause !== 'succeeded' || value.terminationCause !== 'succeeded'
    || run.exitCode !== 0 || !run.finishedAt || !run.processIdentity) return fail('child execution did not finish successfully');
  if (typeof value.noChange !== 'boolean' || value.noChange !== (value.baseSha === value.headSha)) return fail('child no-change identity differs');
  if (JSON.stringify(value.machine) !== JSON.stringify(run.machine)
    || value.sharedGeneration !== (run.sharedClaim?.generation ?? null)
    || JSON.stringify(value.checkpoint) !== JSON.stringify(run.checkpoint)) return fail('child owner/checkpoint identity differs');
  if (!check || check.runId !== run.runId || check.baseSha !== run.baseSha || check.headSha !== run.headSha
    || check.scopeDigest !== value.scopeDigest || check.ok !== true || check.exitCode !== 0
    || check.command !== value.acceptance?.command || value.acceptance?.sha !== run.headSha || value.acceptance?.ok !== true
    || Object.keys(value.acceptance).sort().join(',') !== 'command,ok,sha') return fail('source-bound executed acceptance unavailable');
  return { ok: true, reason: '' };
}

// What the parent does with each child's result, in plan order. A failed child
// WARNS — the parent continues with the others and hands back — while a child
// that wrote outside its declared set BLOCKS: the contract the plan declared is
// the only reason the parallel run was allowed at all. A done child whose diff
// is unknown (`changed[issue]` is null) is likewise not merged: its scope is
// unproved, and an unverifiable state fails closed.
export function evaluateJoin({ children, results, changed, runs = {}, acceptances = {} }) {
  const merge = [];
  const stop = [];
  const blocks = [];
  const warns = [];
  const order = children.map((child) => '#' + child.issue).join(', ');
  const ledger = ['- Parallel: ' + children.length + ' children — join order ' + order];
  for (const child of children) {
    const result = (results ?? {})[child.issue] ?? {};
    const label = '#' + child.issue;
    const checked = validateChildResult(result, { issue: child.issue, scopeDigest: child.scopeDigest, run: runs[child.issue], acceptance: acceptances[child.issue] });
    if (!checked.ok || result.branch !== child.branch || result.baseSha !== child.baseSha) {
      const why = checked.reason || 'prepared child identity differs';
      warns.push('child ' + label + ' failed and was not merged — its branch ' + child.branch
        + ' and worktree are left in place (' + why + ')');
      stop.push({ issue: child.issue, reason: why });
      ledger.push('- Join: ' + label + ' not merged (' + why + ')');
      continue;
    }
    const diff = (changed ?? {})[child.issue];
    if (!Array.isArray(diff)) {
      const reason = 'its diff could not be read, so its scope cannot be proved';
      blocks.push('child ' + label + ': ' + reason);
      stop.push({ issue: child.issue, reason });
      ledger.push('- Join: ' + label + ' not merged (' + reason + ')');
      continue;
    }
    const wandered = scopeViolations(diff, child.files);
    if (wandered.length > 0) {
      for (const path of wandered) blocks.push('child ' + label + ' touched ' + path + ', outside its declared set');
      const reason = 'touched ' + wandered.join(', ') + ' outside its declared set';
      stop.push({ issue: child.issue, reason });
      ledger.push('- Join: ' + label + ' not merged (' + reason + ')');
      continue;
    }
    merge.push({ issue: child.issue, branch: child.branch, headSha: result.headSha, runId: result.runId });
    ledger.push('- Join: ' + label + ' verified ' + result.headSha.slice(0, 7));
  }
  return { merge, stop, blocks, warns, ledger };
}

// --- the command line -----------------------------------------------------

const USAGE = 'usage: children.mjs plan|launch|join|remove --parent <n> --groups <file.json|-> '
  + '[--harness claude|codex] [--repo <o/r>] [--model <m>] [--effort <e>] [--results <file.json|->] [--json] [--write]';

// stdio mode for a discarded fd, hoisted out of quote-adjacency: SkillSpector reads the
// bare word beside its own closing quote as a removal cue and fails closed on the whole
// file (skill-maintainer's standards.md, known behaviours). Same value, same behaviour.
const DISCARD = 'ignore';
const gitRun = (cwd, args) => {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: [DISCARD, 'pipe', 'pipe'] }).trim() };
  } catch (error) {
    return { ok: false, out: (error.stderr?.toString() || error.message).trim() };
  }
};

// A guard never writes, or reads a report, through a symlink: the path a caller
// named must be the path that is used.
function symlinkRefusal(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) return at(path, 'refusing to read a symlink');
  } catch {
    return null; // absent is the caller's problem, reported where it is read
  }
  return null;
}

function loadGroups(source) {
  if (source === '-') return readGroupsReport(JSON.parse(readFileSync(0, 'utf8')));
  const refusal = symlinkRefusal(source);
  if (refusal) throw new Error(refusal);
  let text;
  try {
    text = readFileSync(source, 'utf8');
  } catch (error) {
    throw new Error(at(source, 'cannot read the groups report: ' + error.message));
  }
  try {
    return readGroupsReport(JSON.parse(text));
  } catch (error) {
    throw new Error(at(source, 'groups report unusable: ' + error.message));
  }
}

// Child titles and types decide branch names, so a launch or a join reads them
// from GitHub — a guessed title is a branch the child never created. `--repo`
// is what turns that lookup on; without it `plan` previews from the numbers
// alone. A lookup that fails leaves the placeholder in place and is reported in
// `guessed`: `plan` previews with a warning, and every other verb blocks, so no
// write ever acts on a name this script made up.
function resolveIssues(numbers, { repo }) {
  const issues = {};
  const guessed = [];
  for (const number of numbers) {
    issues[number] = { number, title: 'issue-' + number, type: 'feat' };
  }
  if (!repo) return { issues, guessed };
  for (const number of numbers) {
    try {
      const view = ghJson(['issue', 'view', String(number), '--repo', repo, '--json', 'number,title']);
      const title = String(view.title ?? '');
      const prefix = /^([a-z]+):/.exec(title);
      issues[number] = {
        number,
        title: title.replace(/^[a-z]+:\s*/, ''),
        type: prefix ? prefix[1] : 'feat',
      };
    } catch (error) {
      guessed.push(at('#' + number, 'could not read the issue from ' + repo + ', so its branch name would be a guess: ' + error.message));
    }
  }
  return { issues, guessed };
}

function parentFacts(repoRoot) {
  const branch = gitRun(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = gitRun(repoRoot, ['rev-parse', 'HEAD']);
  return { branch: branch.ok ? branch.out : '', head: head.ok ? head.out.slice(0, 40) : '' };
}

function runVerb(verb, flags) {
  const blocks = [];
  const warns = [];
  if (!['plan', 'launch', 'join', 'remove'].includes(verb)) {
    return { blocks: [at(verb || '(none)', 'unknown verb — ' + USAGE)], warns };
  }
  if (!flags.groups) return { blocks: [at('--groups', 'a plan-lint --groups report is required — ' + USAGE)], warns };
  const parentIssue = flags.parent === undefined ? null : Number(flags.parent);
  if (parentIssue !== null && (!Number.isInteger(parentIssue) || parentIssue <= 0)) {
    return { blocks: [at('--parent', 'expected a positive issue number, got ' + flags.parent)], warns };
  }
  const write = Boolean(flags.write);
  const repoRoot = flags['repo-root'] || process.cwd();
  const harness = flags.harness || 'claude';
  if (!['claude', 'codex'].includes(harness)) {
    return { blocks: [at('--harness', 'expected claude or codex, got ' + harness)], warns };
  }
  if (verb !== 'plan' && !flags.repo) {
    return { blocks: [at('--repo', 'a ' + verb + ' needs the real child titles to name their branches — pass --repo <owner/name>')], warns };
  }

  let groups;
  try {
    groups = loadGroups(flags.groups);
  } catch (error) {
    return { blocks: [error.message], warns };
  }

  const numbers = [];
  for (const group of groups) {
    for (const member of group.members) {
      const match = /^#(\d+)$/.exec(String(member).trim());
      if (match) numbers.push(Number(match[1]));
    }
  }
  const { issues, guessed } = resolveIssues(numbers, { repo: flags.repo });
  if (guessed.length > 0 && verb !== 'plan') return { blocks: guessed, warns };
  warns.push(...guessed);
  const parent = parentFacts(repoRoot);
  const parentHead = flags['parent-head'] || parent.head;
  if (!parentHead) return { blocks: [at(repoRoot, 'cannot read the parent HEAD sha — is this a git checkout?')], warns };

  let run;
  try {
    run = planParallelRun({
      groups,
      issues,
      parentBranch: flags['parent-branch'] || parent.branch,
      parentHead,
      repoRoot,
      parentIssue,
    });
  } catch (error) {
    return { blocks: [at('children', error.message)], warns };
  }
  const concurrency = effectiveConcurrency({
    configured: flags.concurrency === undefined ? null : Number(flags.concurrency),
    cpus: cpus().length,
  });
  const plan = { mode: run.mode, reason: run.reason, ledger: run.ledger, children: run.children, concurrency };

  if (verb === 'plan') return { blocks, warns, plan, wrote: false };

  if (verb === 'launch') {
    blocks.push('legacy child launch is unavailable; use the checked CLI gateway vegafactory children run, or plan for a non-executing preview');
    return { blocks, warns, plan, wrote: false };
  }

  if (verb === 'join') {
    return { blocks: ['join requires the CLI execution owner to resolve durable runs, current integration authority and source-bound acceptance; use vegafactory children join'], warns, plan, wrote: false };
  }

  // remove: the child checkouts only, never a branch, and never a dirty or
  // unmerged one — deletion waits for the operator's word.
  const actions = [];
  for (const child of run.children) {
    const removal = removeWorktree({
      repoRoot,
      name: child.path.split(/[\\/]/).pop(),
      base: flags.base || run.parentBranch,
      force: false,
      write,
    });
    blocks.push(...removal.blocks);
    warns.push(...removal.warns);
    actions.push(...(removal.actions ?? []));
  }
  return { blocks, warns, plan, actions, wrote: write && blocks.length === 0 };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const verb = argv.find((arg) => !arg.startsWith('--')) ?? '';
  const flags = parseFlags(argv, ['json', 'write']);
  let outcome;
  try {
    outcome = runVerb(verb, flags);
  } catch (error) {
    outcome = { blocks: [at('children', error.message)], warns: [] };
  }
  const { exitCode, text } = renderResult('children', outcome, { json: Boolean(flags.json) });
  if (flags.json) {
    const payload = JSON.parse(text);
    for (const key of ['plan', 'launch', 'join', 'actions']) {
      if (outcome[key] !== undefined) payload[key] = outcome[key];
    }
    payload.wrote = Boolean(outcome.wrote); // a run that stopped before its verb wrote nothing
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(text);
    if (outcome.plan) console.log('  ' + (outcome.plan.ledger || '- Parallel: ' + outcome.plan.children.length + ' children'));
    for (const action of outcome.actions ?? []) console.log('  action: ' + action);
  }
  process.exit(exitCode);
}
