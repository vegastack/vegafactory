#!/usr/bin/env node
// skillify guard: deterministic family-level check over every authored skill's
// tests/fixtures/trigger-queries.json. Two skills claiming the same normalised
// query as should_trigger:true without naming each other in ambiguous_with is a
// contradiction the behavioral eval would only find by re-running the whole
// family; this script finds it mechanically. Shape errors block; fixture
// hygiene (unknown neighbour names, one-sided references, missing or short
// fixtures) warns.
//
// Exit codes: 0 pass · 1 warnings under --strict · 2 blocked or usage error.
// Usage: node trigger-check.mjs [--dir <repo-root>] [--strict] [--json]
// Self-contained on purpose apart from the repo's skill-discovery lib: skillify
// is repo-only, so the relative import to packages/cli is always present.
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSkills } from '../../../../packages/cli/scripts/lib/skills.mjs';

const MIN_ENTRIES = 8;
const FIXTURE = join('tests', 'fixtures', 'trigger-queries.json');

const at = (where, message) => `${where}: ${message}`;
const quoted = (text) => `"${text}"`;

// lowercase → collapse whitespace → trim → strip trailing sentence punctuation.
export function normalizeQuery(query) {
  return query.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?,;:]+$/, '');
}

function isNameArray(value) {
  return Array.isArray(value) && value.every((name) => typeof name === 'string' && name.length > 0);
}

// Shape-checks one fixture's entries. Returns the valid entries; every bad
// entry becomes a block naming the file and index.
function readEntries(file, data, blocks) {
  const entries = [];
  data.forEach((entry, index) => {
    const where = file + '[' + index + ']';
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      blocks.push(at(where, 'entry must be an object'));
      return;
    }
    if (typeof entry.query !== 'string' || entry.query.trim().length === 0) {
      blocks.push(at(where, 'query must be a non-empty string'));
      return;
    }
    if (typeof entry.should_trigger !== 'boolean') {
      blocks.push(at(where, 'should_trigger must be true or false'));
      return;
    }
    if ('ambiguous_with' in entry && !isNameArray(entry.ambiguous_with)) {
      blocks.push(at(where, 'ambiguous_with must be an array of skill-name strings'));
      return;
    }
    entries.push({
      where,
      query: entry.query.trim(),
      norm: normalizeQuery(entry.query),
      positive: entry.should_trigger,
      names: entry.ambiguous_with ?? [],
    });
  });
  return entries;
}

// fixtures: Map<skillName, { file, data?, error? } | null>. A key is a skill
// authored here; null means the skill ships no fixture file.
export function checkTriggers(fixtures) {
  const blocks = [];
  const warns = [];
  const valid = new Map();

  for (const [skill, input] of fixtures) {
    if (input === null) {
      warns.push(at(skill, 'no tests/fixtures/trigger-queries.json — every skill ships one (skillify item 2)'));
      continue;
    }
    if (input.error) {
      blocks.push(at(input.file, input.error));
      continue;
    }
    if (!Array.isArray(input.data)) {
      blocks.push(at(input.file, 'fixture must be a JSON array of entries'));
      continue;
    }
    const entries = readEntries(input.file, input.data, blocks);
    if (entries.length < MIN_ENTRIES) warns.push(at(skill, entries.length + ' fixture entries, fewer than ' + MIN_ENTRIES));
    valid.set(skill, entries);
  }

  // Per-entry hygiene: neighbour names must be authored here, and a negative
  // that hands a query to a neighbour needs that neighbour to hold the query.
  for (const [, entries] of valid) {
    for (const entry of entries) {
      for (const name of entry.names) {
        if (!fixtures.has(name)) {
          warns.push(at(entry.where, 'ambiguous_with names ' + quoted(name) + ', which is no skill authored here — a typo is invisible to this guard, so confirm the name by hand'));
          continue;
        }
        if (entry.positive) continue;
        const theirs = valid.get(name);
        if (theirs && !theirs.some((other) => other.norm === entry.norm)) {
          warns.push(at(entry.where, 'should_trigger:false hands ' + quoted(entry.query) + ' to ' + name + ', whose fixture has no entry for it — add it there so the family-level eval walks both sides'));
        }
      }
    }
  }

  // Collisions: index positives by normalised query, then compare each pair of
  // claiming skills. A skill's claim on a query carries the union of the
  // neighbour names its positive entries for that query list.
  const claims = new Map();
  for (const [skill, entries] of valid) {
    for (const entry of entries) {
      if (!entry.positive) continue;
      const bySkill = claims.get(entry.norm) ?? new Map();
      const names = bySkill.get(skill) ?? new Set();
      for (const name of entry.names) names.add(name);
      bySkill.set(skill, names);
      claims.set(entry.norm, bySkill);
    }
  }
  for (const [norm, bySkill] of claims) {
    const skills = [...bySkill.keys()].sort();
    for (let i = 0; i < skills.length; i += 1) {
      for (let j = i + 1; j < skills.length; j += 1) {
        const [x, y] = [skills[i], skills[j]];
        const xNamesY = bySkill.get(x).has(y);
        const yNamesX = bySkill.get(y).has(x);
        if (xNamesY && yNamesX) continue;
        if (!xNamesY && !yNamesX) {
          blocks.push(quoted(norm) + ` is should_trigger:true in ${x} and ${y} without a mutual ambiguous_with — merge the trigger or have each fixture name the other`);
          continue;
        }
        const [namer, silent] = xNamesY ? [x, y] : [y, x];
        warns.push(quoted(norm) + ` is should_trigger:true in ${x} and ${y}; ${namer} names ${silent} in ambiguous_with but ${silent} does not name ${namer} — add the reciprocal entry`);
      }
    }
  }

  blocks.sort();
  warns.sort();
  return { blocks, warns };
}

// One key per discovered skill. ENOENT → null (no fixture); any other read
// error or a JSON.parse failure → { file, error }; a discovery error throws.
export async function loadFixtures(repoRoot) {
  const skills = discoverSkills(join(repoRoot, 'skills'));
  const fixtures = new Map();
  for (const [name, skill] of skills) {
    const path = join(skill.path, FIXTURE);
    const file = relative(repoRoot, path).split(sep).join('/');
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      fixtures.set(name, error.code === 'ENOENT' ? null : { file, error: error.message });
      continue;
    }
    try {
      fixtures.set(name, { file, data: JSON.parse(text) });
    } catch (error) {
      fixtures.set(name, { file, error: error.message });
    }
  }
  return fixtures;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const usage = 'usage: trigger-check.mjs [--dir <repo-root>] [--strict] [--json]';
  let json = false;
  let strict = false;
  let dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  let outcome = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') json = true;
    else if (argv[i] === '--strict') strict = true;
    else if (argv[i] === '--dir' && argv[i + 1] && !argv[i + 1].startsWith('--')) dir = resolve(argv[(i += 1)]);
    else outcome = { blocks: [usage], warns: [] };
  }
  if (!outcome) {
    try {
      outcome = checkTriggers(await loadFixtures(dir));
    } catch (error) {
      outcome = { blocks: [`cannot discover skills under ${dir}: ${error.message}`], warns: [] };
    }
  }
  const ok = outcome.blocks.length === 0;
  if (json) {
    console.log(JSON.stringify({ guard: 'trigger-check', ok, ...outcome }, null, 2));
  } else {
    console.log(`trigger-check: ${ok ? (outcome.warns.length ? 'pass with warnings' : 'pass') : 'BLOCKED'}`);
    for (const b of outcome.blocks) console.log(`  block: ${b}`);
    for (const w of outcome.warns) console.log(`  warn: ${w}`);
  }
  process.exit(ok ? (outcome.warns.length && strict ? 1 : 0) : 2);
}
