#!/usr/bin/env node
// dev-status data gatherer: everything the board report needs, deterministically,
// read-only, markers-only. The skill renders; this script never invents state.
//
// Usage: node status.mjs [--repo o/r] [--orphan-hours 6] [--dev-md <path>] [--viewer <login>] [--me | --all] --json
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const policyUrl = new URL('./effective-policy.mjs', import.meta.url);
const { resolveState, readWorkflowLabels } = await import(existsSync(policyUrl) ? policyUrl.href : new URL('../../dev-setup/scripts/effective-policy.mjs', import.meta.url).href);

export function readKnobs(devMdText) {
  const labelMap = readWorkflowLabels(devMdText ?? '');
  return {
    labelMap,
    states: Object.values(labelMap),
    risky: 'risky',
    scopes: ['research', 'quick-build', 'full-plan'],
    register: /^decisions:\s*(\S+)/m.exec(devMdText ?? '')?.[1] ?? '.vegastack/decisions.md',
    operators: (/^operators:\s*([^\n#]+)/m.exec(devMdText ?? '')?.[1] ?? '')
      .split(',').map((t) => t.trim()).filter(Boolean),
  };
}

// stdio mode for a discarded fd, hoisted out of quote-adjacency: SkillSpector reads the
// bare word beside its own closing quote as a removal cue and fails closed on the whole
// file (skill-maintainer's standards.md, known behaviours). Same value, same behaviour.
const DISCARD = 'ignore';

function gh(args) {
  // env spread at call time: some runtimes pass a startup env snapshot to
  // children, which would hide the VSK_GH/GH_STUB_DIR test seam.
  const out = execFileSync(process.env.VSK_GH || 'gh', args, { encoding: 'utf8', stdio: [DISCARD, 'pipe', 'pipe'], env: { ...process.env } });
  return JSON.parse(out);
}

// Link markup carries no meaning in a terminal, so the board renders link-free
// variants alongside the raw fields — and register comparison uses them, so a
// linked gist still matches its plain register line. URLs containing `)` are not
// a shape this workflow produces (issue and commit URLs never do).
const LINK = /\[([^\]]*)\]\((?:[^)]*)\)/g;

export function stripLinks(text) {
  if (typeof text !== 'string') return '';
  return text.replace(LINK, '$1');
}

export function ageDays(iso, now = Date.now()) {
  return Math.floor((now - Date.parse(iso)) / 86_400_000);
}

// Ledger liveness is measured in hours, not days: a session that hands back in
// hours can go dark for a fraction of a day, which whole-day granularity cannot
// even represent. The ledger's updated_at is the only liveness proxy an agent
// session exposes — a live session (even a multi-day one) checkpoints and keeps
// this small; a dead one freezes it.
export function ageHours(iso, now = Date.now()) {
  return Math.floor((now - Date.parse(iso)) / 3_600_000);
}

export function parseMarker(body) {
  const match = /<!--\s*vsk:v1\s+([^>]*?)\s*-->/.exec(body ?? '');
  if (!match) return null;
  const keys = {};
  for (const pair of match[1].split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq > 0) keys[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { keys };
}

// The approval-marker comment's author — the first tier of the operator rule.
// Last approval wins: a plan approval supersedes the brief's.
export function approvalAuthor(comments) {
  let author = null;
  for (const c of comments ?? []) {
    if (parseMarker(c.body)?.keys?.type === 'approval') author = c.user?.login ?? null;
  }
  return author;
}

// conventions' operator rule, deterministic: approval-marker author if listed,
// else the issue author if listed, else the first listed. An empty operators
// list has no operator — the project never filled the knob, and inventing one
// would assign work to a human who never agreed to it.
export function resolveOperator({ approvalAuthor: approver = null, issueAuthor = null, operators = [] } = {}) {
  if (operators.length === 0) return null;
  if (approver && operators.includes(approver)) return approver;
  if (issueAuthor && operators.includes(issueAuthor)) return issueAuthor;
  return operators[0];
}

// Count plan-comment checkboxes: [done, total]. No plan comment → null.
export function taskProgress(comments) {
  for (const c of comments ?? []) {
    if (parseMarker(c.body)?.keys?.type === 'plan') {
      const done = (c.body.match(/^- \[x\]/gim) ?? []).length;
      const total = done + (c.body.match(/^- \[ \]/gm) ?? []).length;
      return total > 0 ? [done, total] : null;
    }
  }
  return null;
}

// Latest ledger comment's updated_at → staleness signal for working issues.
export function ledgerMovedAt(comments) {
  let at = null;
  for (const c of comments ?? []) {
    if (parseMarker(c.body)?.keys?.type === 'ledger') at = c.updated_at;
  }
  return at;
}

// Register lines are written plain, proposals may carry links — compare link-free
// so a recorded decision does not stay "pending" forever on its markup alone.
function recorded(gist, registerText) {
  return stripLinks(registerText).includes(stripLinks(gist).slice(0, 60));
}

// Decision proposals not yet in the register: marker type=decision comments
// (and evidence **Decision:** lines) whose text isn't in the register file.
export function pendingDecisions(comments, registerText) {
  const pending = [];
  for (const c of comments ?? []) {
    const type = parseMarker(c.body)?.keys?.type;
    if (type === 'decision') {
      const gist = (c.body.split('\n').find((l) => l.trim() && !l.startsWith('<!--') && !l.startsWith('#')) ?? '').trim();
      if (gist && !recorded(gist, registerText)) pending.push(gist);
    }
    if (type === 'evidence') {
      const m = /\*\*Decision:\*\*\s*([^\n]+)/.exec(c.body);
      if (m && !/^none\b/i.test(m[1].trim()) && !recorded(m[1].trim(), registerText)) pending.push(m[1].trim());
    }
  }
  return pending;
}

// CheckRuns carry `conclusion`; StatusContexts carry `state`. An empty rollup
// is "no-checks", never green.
export function checksState(rollup) {
  if (!rollup || rollup.length === 0) return 'no-checks';
  const ok = (c) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? c.state ?? '');
  return rollup.every(ok) ? 'green' : 'pending-or-red';
}


// --- control-room drift ---------------------------------------------------------------
// This script ships standalone into consumer projects, so it carries its own copies of the
// knob grammar rather than importing packages/cli. Every function here is total: a control
// room nobody has synced is a reported fact, never an error, and never an edit to dev.md.

export function knobMap(text) {
  const map = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^([a-z][a-z0-9-]*):\s*(.+)$/.exec(line);
    if (!m) continue;
    map[m[1]] = m[2].split(/\s+#/)[0].trim();
  }
  return map;
}

export function controlRoomKnob(devMdText) {
  const value = knobMap(devMdText)['control-room'];
  if (!value || value === 'none') return null;
  const [repoPart, tail = ''] = value.split('#');
  if (!repoPart || !repoPart.includes('/')) return null;
  const [groupPart, shaPart] = tail.split('@');
  return { org: repoPart.split('/')[0], repo: repoPart, group: groupPart || null, sha: shaPart || null };
}

// Drift is only ever a proposal: a hand edit in dev.md outranks the org and group defaults, so
// a knob both sides name with different values is shown with both values and the operator decides.
export function controlRoomDrift({ devMdText, orgText, groupText, cloneSha }) {
  const knob = controlRoomKnob(devMdText);
  if (!knob) return null;
  const repoKnobs = knobMap(devMdText);
  const orgKnobs = knobMap(orgText);
  const groupKnobs = knobMap(groupText);
  const merged = { ...orgKnobs, ...groupKnobs };
  const knobs = Object.keys(merged)
    .filter((name) => name in repoKnobs && repoKnobs[name] !== merged[name])
    .sort()
    .map((name) => ({ knob: name, repo: repoKnobs[name], controlRoom: merged[name], source: name in groupKnobs ? 'group' : 'org' }));
  return {
    recordedSha: knob.sha,
    cloneSha: cloneSha ?? null,
    behind: Boolean(knob.sha && cloneSha && knob.sha !== cloneSha),
    knobs,
  };
}

function controlRoomState(devMdText, home) {
  const knob = controlRoomKnob(devMdText);
  if (!knob) return null;
  let path = join(home, '.vegastack/control-room', knob.org);
  let lastSyncedAt = null;
  try {
    const state = JSON.parse(readFileSync(join(home, '.vegastack/factory.json'), 'utf8'));
    const entry = state?.controlRooms?.[knob.org];
    if (entry && typeof entry === 'object') {
      if (typeof entry.path === 'string') path = entry.path;
      if (typeof entry.lastSyncedAt === 'string') lastSyncedAt = entry.lastSyncedAt;
    }
  } catch {
    // no state file, or one this machine cannot read: the default path still answers
  }
  if (!existsSync(path)) {
    return { available: false, reason: `no local control-room clone at ${path} — run \`vegafactory sync\``, recordedSha: knob.sha, lastSyncedAt };
  }
  const read = (relative) => { try { return readFileSync(join(path, relative), 'utf8'); } catch { return ''; } };
  let cloneSha = null;
  try {
    cloneSha = execFileSync('git', ['-C', path, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8', stdio: [DISCARD, 'pipe', DISCARD] }).trim();
  } catch {
    // a clone without a readable head still answers on its files
  }
  const drift = controlRoomDrift({
    devMdText,
    orgText: read('org.md'),
    groupText: knob.group ? read(join('groups', knob.group, 'group.md')) : '',
    cloneSha,
  });
  return { available: true, path, lastSyncedAt, recordedSha: drift.recordedSha, cloneSha: drift.cloneSha, behind: drift.behind, knobs: drift.knobs };
}

export function gatherStatus({ repo, orphanHours = 6, devMdPath = '.vegastack/dev.md', chroniclePath = '.vegastack/chronicle.md', me, view = 'me', now = Date.now(), home = homedir() } = {}) {
  const resolvedRepo = repo || gh(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
  // One caller lookup for the whole run; a gh failure propagates to the CLI's exit 2.
  const viewer = me || gh(['api', 'user']).login;
  const devMdText = existsSync(devMdPath) ? readFileSync(devMdPath, 'utf8') : '';
  const knobs = readKnobs(devMdText);
  const board = { unresolved: [] };
  const unresolvedSeen = new Set();
  for (const label of knobs.states) {
    board[label] = gh(['issue', 'list', '-R', resolvedRepo, '--label', label, '--state', 'open',
      '--json', 'number,title,url,updatedAt,labels,assignees,author']).filter((i) => {
        const state = resolveState((i.labels ?? []).map(l => l.name), knobs.labelMap);
        if (state.blocks.length) {
          if (!unresolvedSeen.has(i.number)) board.unresolved.push({ ...i, state: null, blocks: state.blocks });
          unresolvedSeen.add(i.number);
          return false;
        }
        return knobs.labelMap[state.state] === label;
      }).map((i) => ({
      number: i.number, title: i.title, url: i.url,
      ageDays: ageDays(i.updatedAt, now),
      scope: (i.labels ?? []).map((l) => l.name).find((n) => knobs.scopes.includes(n)) ?? null,
      risky: (i.labels ?? []).some((l) => l.name === knobs.risky),
      assignees: (i.assignees ?? []).map((a) => a.login),
      author: i.author?.login ?? null,
      operator: resolveOperator({ issueAuthor: i.author?.login ?? null, operators: knobs.operators }),
    }));
  }

  // Enrich working + for-operator issues with comment-derived signals.
  const registerText = existsSync(knobs.register) ? readFileSync(knobs.register, 'utf8') : '';
  const decisions = [];
  for (const bucket of [knobs.states[3], knobs.states[4]]) {
    for (const issue of board[bucket]) {
      const comments = gh(['api', 'repos/' + resolvedRepo + '/issues/' + issue.number + '/comments', '--paginate']);
      issue.tasks = taskProgress(comments);
      issue.operator = resolveOperator({ approvalAuthor: approvalAuthor(comments), issueAuthor: issue.author, operators: knobs.operators });
      const moved = ledgerMovedAt(comments);
      issue.ledgerAgeHours = moved ? ageHours(moved, now) : null;
      // possiblyOrphaned: a working issue whose ledger has been silent past the
      // orphan threshold — or which never got a ledger comment at all (claimed,
      // then died before its first write). A fact for the operator to act on,
      // never an automatic reclaim: the reset is theirs to run.
      issue.possiblyOrphaned = bucket === knobs.states[3] && (issue.ledgerAgeHours === null || issue.ledgerAgeHours >= orphanHours);
      decisions.push(...pendingDecisions(comments, registerText).map((d) => ({ issue: issue.number, gist: d, gistPlain: stripLinks(d) })));
    }
  }

  const prs = gh(['pr', 'list', '-R', resolvedRepo, '--json', 'number,title,url,statusCheckRollup'])
    .map((p) => ({
      number: p.number, title: p.title, url: p.url,
      checks: checksState(p.statusCheckRollup),
    }));

  let lastChronicle = null;
  if (existsSync(chroniclePath)) {
    const m = /^## (\d{2}-\d{2}-\d{4}) — (.+)$/m.exec(readFileSync(chroniclePath, 'utf8'));
    if (m) lastChronicle = { date: m[1], title: m[2], titlePlain: stripLinks(m[2]) };
  }

  // "Whose move is it" is the question this script exists to answer, so the
  // filter is data, not the skill's judgment. Human states only: `ready` and
  // `working` belong to agents, and an unassigned `ready` issue is correct.
  const humanStates = [knobs.states[0], knobs.states[4]];
  const human = humanStates.flatMap((s) => board[s].map((i) => ({ ...i, state: s })));
  const needsYou = human.filter((i) => view === 'all' || i.assignees.includes(viewer));
  const unowned = human.filter((i) => i.assignees.length === 0);

  return { repo: resolvedRepo, orphanHours, viewer, view, operators: knobs.operators, board, needsYou, unowned, prs, pendingDecisions: decisions, lastChronicle, controlRoom: controlRoomState(devMdText, home) };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const get = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };
  try {
    const orphanRaw = Number(get('--orphan-hours'));
    const data = gatherStatus({ repo: get('--repo'), orphanHours: Number.isFinite(orphanRaw) && orphanRaw >= 1 ? orphanRaw : 6, devMdPath: get('--dev-md'), me: get('--viewer'), view: argv.includes('--all') ? 'all' : 'me' });
    console.log(JSON.stringify(data, null, argv.includes('--json') ? 2 : 0));
  } catch (error) {
    console.error(`status: cannot verify — ${error.message}`);
    process.exit(2);
  }
}
