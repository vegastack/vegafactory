#!/usr/bin/env node
// dev-intake guard: deterministic checks on a drafted brief before posting.
// Missing structure blocks; quality smells only warn (heuristics never block).
// Inline small-issue plans are linted separately by dev-plan's plan-lint — the
// banned-placeholder list lives there, its single home.
//
// Exit codes: 0 pass · 1 pass-with-warnings · 2 blocked (reasons printed).
// Usage: node brief-lint.mjs --file <brief.md> --scope <small|medium|large|research> --json
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_HEADINGS = {
  research: [/^##\s+.*question/im, /^##\s+.*answered/im],
  small: [/^##\s+Outcome\b/m, /^##\s+Tests and acceptance\b/m, /^##\s+Approach/m],
  medium: [/^##\s+Outcome\b/m, /^##\s+Out of scope\b/m, /^##\s+Tests and acceptance\b/m, /^##\s+Approach/m],
  large: [/^##\s+Outcome\b/m, /^##\s+Out of scope\b/m, /^##\s+Tests and acceptance\b/m, /^##\s+Approach/m],
};

const VAGUE_SMELLS = [
  /\bworks (properly|correctly|as expected)\b/i,
  /\buser[- ]friendly\b/i,
  /\brobust(ly)?\b/i,
  /\betc\.?\b/i,
];

export function lintBrief(text, scope, { fix = false } = {}) {
  const blocks = [];
  const warns = [];

  if (!REQUIRED_HEADINGS[scope]) {
    return { blocks: [`unknown size "${scope}" (small | medium | large | research)`], warns };
  }
  if (!/<!--\s*vsk:v1\s+type=brief\b/.test(text)) blocks.push('missing brief marker (<!-- vsk:v1 type=brief rev=n size=... -->)');
  if (scope !== 'research' && !/^\*\*Size:\*\*/m.test(text)) {
    blocks.push('missing the **Size:** line — the announced reason must survive the conversation');
  }
  if (fix && !/^##\s+Reproduction\b/m.test(text)) {
    blocks.push('fix-type brief without a ## Reproduction section — an unreproducible bug is research first');
  }

  for (const heading of REQUIRED_HEADINGS[scope]) {
    if (!heading.test(text)) blocks.push(`missing required section for ${scope}: ${heading.source}`);
  }

  if (scope !== 'research') {
    const approach = text.split(/^(?=##\s)/m).find((chunk) => /^##\s+Approach/.test(chunk));
    if (approach && !/`[^`]*[/.][^`]*`/.test(approach)) {
      blocks.push('Approach and touch points names no real backticked paths — grounding was skipped or unrecorded');
    }
  }

  for (const smell of VAGUE_SMELLS) {
    const hit = smell.exec(text);
    if (hit) warns.push(`vague wording: "${hit[0]}" — name the observable behavior instead`);
  }

  return { blocks, warns };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const get = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
  let outcome;
  const file = get('--file');
  const scope = get('--scope');
  if (!file || !scope) {
    outcome = { blocks: ['usage: brief-lint.mjs --file <brief.md> --scope <class> [--fix] [--json]'], warns: [] };
  } else {
    try {
      outcome = lintBrief(readFileSync(file, 'utf8'), scope, { fix: argv.includes('--fix') });
    } catch (error) {
      outcome = { blocks: [`cannot read brief: ${error.message}`], warns: [] };
    }
  }
  const ok = outcome.blocks.length === 0;
  const exitCode = ok ? (outcome.warns.length ? 1 : 0) : 2;
  if (json) {
    console.log(JSON.stringify({ guard: 'brief-lint', ok, ...outcome }, null, 2));
  } else {
    console.log(`brief-lint: ${ok ? (outcome.warns.length ? 'pass with warnings' : 'pass') : 'BLOCKED'}`);
    for (const b of outcome.blocks) console.log(`  block: ${b}`);
    for (const w of outcome.warns) console.log(`  warn: ${w}`);
  }
  process.exit(exitCode);
}
