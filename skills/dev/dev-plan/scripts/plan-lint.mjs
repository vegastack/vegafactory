#!/usr/bin/env node
// dev-plan guard: deterministic checks on a drafted plan comment. Placeholders
// and structural gaps block; nothing here warns. The banned-placeholder list's
// single home is this file — brief-lint defers inline-plan checks to it.
//
// Exit codes: 0 pass · 2 blocked (this guard has no warn class).
// Usage: node plan-lint.mjs --file <plan.md> --json
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Self-contained on purpose: plan-lint ships with dev-plan and must run on a
// standalone install, so it carries its own tiny flag/result helpers instead of
// importing dev-implement's lib.

export const bannedPlaceholders = [
  /\bTBD\b/,
  /\bTODO\b/,
  /implement later/i,
  /fill in details/i,
  /add appropriate error handling/i,
  /\badd validation\b/i,
  /handle edge cases/i,
  /write tests for the above/i,
  /similar to task \d+/i,
];

// Independent groups: the optional block that declares which work may run at the
// same time, and the disjoint file set that bounds each group. The grammar's
// single home is here — dev-implement reads `--groups` JSON rather than the
// markdown, so exactly one parser exists in the family.
const GROUPS_HEADING = '**Independent groups:**';
const GROUP_LINE = /^- `([^`]+)` — (.*)$/;

// Files nearly every change in a repo edits. Two children that both touch one of
// these are not independent whatever the plan claims, and the join is the worst
// place to find that out — a lockfile three-way merge most of all. Measured on the
// 18 Epic B plans: 5 of 153 child pairs were disjoint, and these files are why.
const NEVER_PARALLEL = [
  'bun.lock',
  'package.json',
  'packages/cli/packaging.json',
  '.vegastack/dev.md',
  '.vegastack/chronicle.md',
  '.vegastack/skillspector-baseline.json',
];

const FLEET_HEADING = '**Fleet parallel:**';
const FLEET_RESOURCE = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;
const TASK_ID = /^[1-9]\d*-T[1-9]\d*$/;

function structuralLines(text) {
  let fence = null;
  return String(text).split('\n').map((line, index) => {
    const opening = /^ {0,3}(`{3,}|~{3,})(.*?)$/.exec(line);
    const structural = fence === null && opening === null && !/^(?: {4}|\t)/.test(line);
    if (opening) {
      if (fence === null) fence = opening[1];
      else if (opening[1][0] === fence[0] && opening[1].length >= fence.length && opening[2].trim() === '') fence = null;
    }
    return { line, index, structural };
  });
}

function parseClosedJson(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 8192) throw new Error('fleet declaration exceeds 8 KiB');
  const value = JSON.parse(raw);
  const tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? [];
  let cursor = 0;
  function visit(depth = 0) {
    if (depth > 16) throw new Error('fleet declaration nesting is too deep');
    const token = tokens[cursor++];
    if (token === '{') {
      const seen = new Set();
      while (tokens[cursor] !== '}') {
        const key = JSON.parse(tokens[cursor++]);
        if (seen.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('duplicate or unsafe fleet declaration key');
        seen.add(key); cursor++; visit(depth + 1);
        if (tokens[cursor] === ',') cursor++;
      }
      cursor++;
    } else if (token === '[') {
      while (tokens[cursor] !== ']') {
        visit(depth + 1);
        if (tokens[cursor] === ',') cursor++;
      }
      cursor++;
    }
  }
  visit();
  if (cursor !== tokens.length) throw new Error('invalid fleet declaration JSON');
  return value;
}

function literalPlanPath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !/[\\\x00-\x1f*?\[\]{}]/.test(value)
    && !/^[a-z]:/i.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function selectedTaskFiles(text, selectedTaskIds) {
  const tasks = new Map();
  let current = null;
  for (const row of structuralLines(text)) {
    if (!row.structural) continue;
    const header = /^- \[[ xX]\] \*\*Task .*?<!-- task-id:([1-9]\d*-T[1-9]\d*) -->/.exec(row.line);
    if (header) {
      current = header[1];
      if (tasks.has(current)) throw new Error('duplicate structural task identity');
      tasks.set(current, []);
      continue;
    }
    if (/^#{1,6}\s/.test(row.line) || /^- \[[ xX]\] \*\*Task /.test(row.line)) current = null;
    if (current && /^\s*(?:- )?Files —/.test(row.line)) {
      if (row.line.includes('``')) throw new Error('selected task has an empty Files path');
      tasks.get(current).push([...row.line.matchAll(/`([^`]+)`/g)].map((match) => match[1]));
    }
  }
  const files = [];
  for (const id of selectedTaskIds) {
    const clauses = tasks.get(id);
    if (!clauses || clauses.length !== 1 || clauses[0].length === 0) throw new Error('selected task lacks one canonical Files clause');
    files.push(...clauses[0]);
  }
  if (!files.every(literalPlanPath)) throw new Error('selected task has a nonliteral repository path');
  const unique = [...new Set(files)];
  if (unique.length === 0 || unique.some(sharedByEveryChild)) throw new Error('selected task has repository-wide shared or empty file scope');
  return unique;
}

const exclusiveFleet = (reason) => ({ eligible: false, independent: false, taskIds: [], paths: [], resources: [], reason });

export function parseFleetParallelDeclaration(text, selectedTaskIds) {
  try {
    if (!Array.isArray(selectedTaskIds) || selectedTaskIds.length === 0 || selectedTaskIds.length > 64
      || !selectedTaskIds.every((id) => TASK_ID.test(id)) || new Set(selectedTaskIds).size !== selectedTaskIds.length) throw new Error('invalid selected task IDs');
    const rows = structuralLines(text);
    const declarations = rows.filter((row) => row.structural && row.line.startsWith(FLEET_HEADING));
    if (declarations.length === 0) return exclusiveFleet('fleet declaration absent');
    if (declarations.length !== 1) throw new Error('duplicate fleet declaration');
    const declaration = declarations[0];
    const constraints = rows.find((row) => row.structural && row.line.startsWith('**Constraints:**'));
    const boundary = rows.find((row) => row.structural && (row.line.startsWith(GROUPS_HEADING) || /^### Tasks\s*$/.test(row.line)));
    if (!constraints || !boundary || declaration.index <= constraints.index || declaration.index >= boundary.index) throw new Error('fleet declaration is outside its structural location');
    const raw = declaration.line.slice(FLEET_HEADING.length).trim();
    const value = parseClosedJson(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('fleet declaration must be an object');
    if (Object.keys(value).sort().join(',') !== 'eligible,resources,schemaVersion,taskIds') throw new Error('unknown or missing fleet declaration field');
    if (value.schemaVersion !== 1 || value.eligible !== true) throw new Error('unsupported fleet declaration');
    if (!Array.isArray(value.taskIds) || value.taskIds.length === 0 || value.taskIds.length > 64
      || !value.taskIds.every((id) => TASK_ID.test(id)) || new Set(value.taskIds).size !== value.taskIds.length) throw new Error('invalid fleet task IDs');
    if (JSON.stringify(value.taskIds) !== JSON.stringify(selectedTaskIds)) throw new Error('fleet task IDs differ from selected tasks');
    if (!Array.isArray(value.resources) || value.resources.length > 64 || !value.resources.every((resource) => FLEET_RESOURCE.test(resource))
      || new Set(value.resources).size !== value.resources.length) throw new Error('invalid fleet resources');
    return { eligible: true, independent: true, taskIds: value.taskIds, paths: selectedTaskFiles(text, value.taskIds), resources: value.resources, reason: null };
  } catch (error) {
    return exclusiveFleet(error instanceof Error ? error.message : 'invalid fleet declaration');
  }
}

export function sharedByEveryChild(path) {
  const normalized = normalizeGroupPath(path);
  return normalized.endsWith('README.md') || NEVER_PARALLEL.includes(normalized);
}

export function normalizeGroupPath(path) {
  return String(path).replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

export function parseIndependentGroups(text) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith(GROUPS_HEADING));
  if (start === -1) return [];
  const groups = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('- ')) break;
    const match = GROUP_LINE.exec(line);
    if (!match) {
      groups.push({ id: null, members: [], files: [], line });
      continue;
    }
    const rest = match[2];
    const cut = rest.indexOf(' · Files:');
    const membersPart = cut === -1 ? rest : rest.slice(0, cut);
    const filesPart = cut === -1 ? '' : rest.slice(cut + ' · Files:'.length);
    const members = membersPart.split(',').map((m) => m.trim()).filter(Boolean);
    const files = (filesPart.match(/`[^`]+`/g) || []).map((f) => normalizeGroupPath(f.slice(1, -1).trim()));
    groups.push({ id: match[1].trim(), members, files, line });
  }
  return groups;
}

export function groupOverlaps(groups) {
  const found = [];
  const named = groups.filter((g) => g.id);
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      for (const a of named[i].files) {
        for (const b of named[j].files) {
          if (a === b) found.push({ a: named[i].id, b: named[j].id, path: a });
          else if (a.endsWith('/') && b.startsWith(a)) found.push({ a: named[i].id, b: named[j].id, path: a });
          else if (b.endsWith('/') && a.startsWith(b)) found.push({ a: named[i].id, b: named[j].id, path: b });
        }
      }
    }
  }
  return found;
}

export function lintPlan(text) {
  const blocks = [];

  if (!/<!--\s*vsk:v1\s+type=plan\b/.test(text)) blocks.push('missing plan marker (<!-- vsk:v1 type=plan rev=n -->)');

  for (const pattern of bannedPlaceholders) {
    const hit = pattern.exec(text);
    if (hit) blocks.push(`banned placeholder: "${hit[0]}" — plans carry the actual content`);
  }

  // A Task-header line not carried by a checkbox would otherwise be absorbed
  // into the previous task's chunk and inherit its sections — detect it.
  // Anchored to the line START so mid-line references ("consumes Task 2's
  // output") never false-block.
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^(\*\*|[-*]\s+\*\*)?Task \d+:/.test(t) && !/^- \[[ x]\]/.test(t)) {
      blocks.push(`task line without a checkbox: "${t.slice(0, 60)}"`);
    }
  }

  const tasks = text.split(/^- \[[ x]\] \*\*Task /m).slice(1);
  if (tasks.length === 0) blocks.push('no checkbox tasks found (- [ ] **Task N: ...**)');
  tasks.forEach((task, index) => {
    const n = index + 1;
    if (!/Files\s*—/.test(task)) blocks.push(`task ${n}: missing "Files —" line with exact paths`);
    if (!/Interfaces\s*—/.test(task)) blocks.push(`task ${n}: missing "Interfaces —" block (consumes/produces)`);
    if (!/Steps[:\s]/.test(task)) blocks.push(`task ${n}: missing "Steps" line`);
    if (/failing test/i.test(task) && !task.includes('```')) {
      blocks.push(`task ${n}: a failing-test step must carry the actual test code in a fenced block`);
    }
  });

  const groups = parseIndependentGroups(text);
  const seenIds = new Set();
  const seenMembers = new Map();
  for (const group of groups) {
    if (!group.id) {
      blocks.push(`independent group line not in the "- \`id\` — members · Files: \`path\`" shape: "${group.line}"`);
      continue;
    }
    if (seenIds.has(group.id)) blocks.push(`independent group id "${group.id}" appears twice`);
    seenIds.add(group.id);
    if (group.files.length === 0) blocks.push(`independent group "${group.id}": no file set declared`);
    for (const file of group.files.filter(sharedByEveryChild)) {
      blocks.push(`independent group "${group.id}" declares ${file}, which nearly every change edits — these children run in sequence`);
    }
    // A group is one child at a time: two issues in one group would run at once on
    // one file set, the exact collision the disjoint sets rule out.
    const children = group.members.filter((member) => /^#\d+$/.test(member));
    if (children.length > 1) {
      blocks.push(`independent group "${group.id}" names ${children.join(', ')} — they would share one file set, and a parallel group carries one child; give each its own group and a disjoint set, or run them in plan order`);
    }
    for (const member of group.members) {
      if (seenMembers.has(member) && seenMembers.get(member) !== group.id) {
        blocks.push(`independent group member "${member}" appears in more than one group`);
      } else seenMembers.set(member, group.id);
    }
  }
  for (const clash of groupOverlaps(groups)) {
    blocks.push(`independent groups "${clash.a}" and "${clash.b}" overlap on ${clash.path}`);
  }

  const fleetRows = structuralLines(text).filter((row) => row.structural && row.line.startsWith(FLEET_HEADING));
  if (fleetRows.length > 0) {
    const selected = [...String(text).matchAll(/^- \[[ xX]\] \*\*Task .*?<!-- task-id:([1-9]\d*-T[1-9]\d*) -->/gm)].map((match) => match[1]);
    const fleet = parseFleetParallelDeclaration(text, selected);
    if (!fleet.independent) blocks.push('invalid fleet declaration: ' + fleet.reason);
  }

  return { blocks, warns: [] };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const wantGroups = argv.includes('--groups');
  const fileIndex = argv.indexOf('--file');
  let outcome;
  let text = null;
  if (fileIndex === -1 || !argv[fileIndex + 1]) {
    outcome = { blocks: ['usage: plan-lint.mjs --file <plan.md> [--groups] [--json]'], warns: [] };
  } else {
    try {
      text = readFileSync(argv[fileIndex + 1], 'utf8');
      outcome = lintPlan(text);
    } catch (error) {
      outcome = { blocks: [`cannot read plan: ${error.message}`], warns: [] };
    }
  }
  const ok = outcome.blocks.length === 0;
  // --groups hands the validated groups to the rest of the family, so exactly one
  // parser for the grammar exists. Without the flag the shape is untouched:
  // dev-implement's evidence flow and the dev-plan body both read it.
  // The published contract is { id, members, files }; `line` is the parser's own
  // reporting aid and stays out of the JSON other skills consume.
  const groups = wantGroups
    ? (ok && text !== null ? parseIndependentGroups(text).map((g) => ({ id: g.id, members: g.members, files: g.files })) : [])
    : null;
  if (json) {
    const payload = { guard: 'plan-lint', ok, ...outcome };
    if (wantGroups) payload.groups = groups;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`plan-lint: ${ok ? 'pass' : 'BLOCKED'}`);
    for (const b of outcome.blocks) console.log(`  block: ${b}`);
    if (wantGroups) console.log(`  groups: ${groups.map((g) => g.id).join(', ') || 'none'}`);
  }
  process.exit(ok ? 0 : 2);
}
