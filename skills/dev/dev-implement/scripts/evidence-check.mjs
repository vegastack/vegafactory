#!/usr/bin/env node
// dev-implement guard: the evidence comment's required shape. Structure blocks;
// nothing here warns.
//
// Exit codes: 0 pass · 2 blocked (this guard has no warn class).
// Usage: node evidence-check.mjs --file <evidence.md> --json
import { compareTaskIds } from './recovery.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GhUnavailable, findMarkerComment, ghJson, parseFlags, parseMarker, renderResult } from './lib/gh.mjs';

const REQUIRED_SECTIONS = [
  [/\*\*Done:\*\*/, '**Done:** section'],
  [/\*\*Tests:\*\*/, '**Tests:** section (command → fresh result)'],
  [/\*\*Review:\*\*/, '**Review:** section (mode + verdict/adjudications)'],
  [/\*\*Changelog:\*\*/, '**Changelog:** section (entry, or none with a holding reason)'],
  [/\*\*Docs:\*\*/, '**Docs:** section (brief/plan revisions in sync, or unchanged)'],
  [/\*\*Not done/, '**Not done / limits:** section (the honest list)'],
];

export function checkEvidence(text) {
  const blocks = [];

  const marker = parseMarker(text);
  if (!marker || marker.keys.type !== 'evidence') {
    blocks.push('missing evidence marker (<!-- vsk:v1 type=evidence rev=n branch=... sha=... -->)');
  } else {
    if (!marker.keys.branch) blocks.push('evidence marker missing branch=');
    if (!/^[0-9a-f]{7,}$/.test(marker.keys.sha ?? '')) blocks.push('evidence marker missing a real sha=');
  }

  for (const [pattern, label] of REQUIRED_SECTIONS) {
    if (!pattern.test(text)) blocks.push(`missing ${label}`);
  }

  if (!/Branch:\s*\S+\s*@\s*[0-9a-f]{7,}/.test(text)) blocks.push('missing "Branch: <name> @ <sha7>" tail line');

  return { blocks, warns: [] };
}

// The plan comment's checkboxes and the ledger's completed tasks are two records
// of the same fact, and the checkbox — a second write, to a different comment
// than the ledger the session already maintains — is the one that silently rots.
// At hand-back the ledger's completed tasks must be reflected in the plan's
// checkboxes, or the operator reads a false x/y. Distinct task numbers with a
// `complete` line in the ledger, versus `[x]` boxes in the plan.
export function checkTaskConsistency(comments) {
  const blocks = [];
  const warns = [];
  const plan = findMarkerComment(comments, 'plan')?.comment?.body;
  const ledger = findMarkerComment(comments, 'ledger')?.comment?.body;

  // No plan comment, or a plan with no checkboxes (e.g. a research issue), is
  // nothing to reconcile — not a violation. No ledger yet is the same.
  if (!plan || !ledger) return { blocks, warns };
  const rows = [...plan.matchAll(/^-\s*\[([ x])\].*$/gim)];
  if (!rows.length) return { blocks, warns };
  const ids = rows.map(row => /<!--\s*task-id:([1-9]\d*-T[1-9]\d*)\s*-->/.exec(row[0])?.[1]);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
    blocks.push('plan task identities missing or duplicate; regenerate only from newly approved scope');
    return { blocks, warns };
  }
  const planDone = rows.flatMap((row, i) => row[1].toLowerCase() === 'x' ? [ids[i]] : []);
  const completed = [...ledger.matchAll(/^-\s*(?:Task\s+)?([1-9]\d*-T[1-9]\d*):\s*complete\b/gim)].map(row => row[1]);
  if (/^-\s*Task\s+\d+:\s*complete\b/im.test(ledger)) blocks.push('legacy numeric ledger completion lacks approved task identity');
  const difference = compareTaskIds(planDone, completed);
  if (difference.missing.length || difference.unknown.length) blocks.push('task identity mismatch: plan-only [' + difference.missing.join(', ') + ']; ledger-only [' + difference.unknown.join(', ') + ']');
  return { blocks, warns };
}

// Fetch the issue's comments and reconcile plan checkboxes against the ledger.
// Fails closed: an unreachable gh blocks rather than passing silently.
function taskConsistencyFromIssue({ issue, repo: repoFlag }) {
  const repo = repoFlag || ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
  const comments = ghJson(['api', 'repos/' + repo + '/issues/' + issue + '/comments', '--paginate']);
  return checkTaskConsistency(comments);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const flags = parseFlags(process.argv.slice(2));
  let outcome;
  if (!flags.file) {
    outcome = { blocks: ['usage: evidence-check.mjs --file <evidence.md> [--issue <n> --repo <o/r>] [--json]'], warns: [] };
  } else {
    try {
      outcome = checkEvidence(readFileSync(flags.file, 'utf8'));
    } catch (error) {
      outcome = { blocks: [`cannot read evidence: ${error.message}`], warns: [] };
    }
    // Consistency check only when an issue is named — keeps the file-shape check
    // network-free by default. A gh failure fails closed onto the block list.
    if (flags.issue) {
      try {
        const consistency = taskConsistencyFromIssue(flags);
        outcome.blocks.push(...consistency.blocks);
        outcome.warns.push(...consistency.warns);
      } catch (error) {
        outcome.blocks.push(error instanceof GhUnavailable ? `cannot verify plan/ledger consistency: ${error.message}` : `consistency check error: ${error.message}`);
      }
    }
  }
  const { exitCode, text } = renderResult('evidence-check', outcome, { json: Boolean(flags.json) });
  console.log(text);
  process.exit(exitCode);
}
