#!/usr/bin/env node
// Shared plumbing for the workflow guard scripts: gh invocation, vsk:v1 comment
// marker parsing, and the block/warn result contract (facts block, heuristics
// warn — exit 0 pass · 1 warn-only · 2 block; unverifiable state fails closed).
import { execFileSync } from 'node:child_process';

export class GhUnavailable extends Error {
  constructor(message, httpStatus = null) {
    super(message);
    this.httpStatus = httpStatus; // parsed from gh's "HTTP <code>" stderr, when present
  }
}

// Run gh with explicit args (never a shell) and parse JSON output. Any failure
// to reach GitHub is a GhUnavailable — callers treat it as "cannot verify",
// which blocks (fail closed), never as a pass. stdin is fed only when `input`
// is a string (a request body that must stay off argv); otherwise it is
// closed. VSK_GH is a TEST SEAM only (points unit tests at a stub binary);
// guards are enforcement infrastructure, so never set it in real runs.
export function ghJson(args, { gh = process.env.VSK_GH || 'gh', input } = {}) {
  let out;
  try {
    // env is passed explicitly: Bun's execFileSync does not see process.env
    // mutations made after startup unless told to, and the test seam relies on them.
    out = execFileSync(gh, args, {
      encoding: 'utf8',
      env: process.env,
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error.stderr?.toString().trim() || '';
    const status = /HTTP (\d{3})/.exec(stderr)?.[1];
    throw new GhUnavailable(`gh ${args.join(' ')} failed: ${stderr || error.message}`, status ? Number(status) : null);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new GhUnavailable(`gh ${args.join(' ')} returned unparseable JSON`);
  }
}

// Parse a `<!-- vsk:v1 key=value ... -->` marker from a comment/body's first
// marker line. Returns { keys } or null when no marker exists — and per
// conventions, no marker means the artifact does not exist (no fallback).
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

// Find the last comment carrying a marker of the given type (last wins: for
// edited-in-place singletons there is one; for repeated types the newest is
// the operative one).
export function findMarkerComment(comments, type) {
  let found = null;
  for (const comment of comments ?? []) {
    const marker = parseMarker(comment.body);
    if (marker && marker.keys.type === type) found = { comment, keys: marker.keys };
  }
  return found;
}

// Render the guard result and compute the exit code. blocks/warns are arrays of
// human sentences; the caller passes process.argv-derived json flag.
export function renderResult(name, { blocks = [], warns = [], ...receipt }, { json = false } = {}) {
  const ok = blocks.length === 0;
  const exitCode = blocks.length > 0 ? 2 : warns.length > 0 ? 1 : 0;
  let text;
  if (json) {
    text = JSON.stringify({ ...receipt, guard: name, ok, blocks, warns }, null, 2);
  } else {
    const lines = [`${name}: ${ok ? (warns.length ? 'pass with warnings' : 'pass') : 'BLOCKED'}`];
    for (const b of blocks) lines.push(`  block: ${b}`);
    for (const w of warns) lines.push(`  warn: ${w}`);
    text = lines.join('\n');
  }
  return { exitCode, text };
}

// Minimal flag parser shared by the guards: --key value and boolean --flags.
export function parseFlags(argv, booleans = ['json']) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (booleans.includes(key)) {
      flags[key] = true;
    } else {
      flags[key] = argv[i + 1];
      i += 1;
    }
  }
  return flags;
}
