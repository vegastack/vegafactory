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
