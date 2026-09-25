#!/usr/bin/env node
// One feature, one worktree. This script owns the whole worktree scenario
// matrix for a VegaFactory project: naming, lifecycle classification, the
// safe-to-remove test, retention, and the git-calling verbs the skills and
// `vegafactory worktree ...` both drive. The main checkout never leaves the
// default branch; issue branches keep their descriptive <type>/<n>-<slug>
// names while their directories use the stable issue number only. Attended
// roots use .vegastack/.worktrees/<n>; worker roots use sibling issues/<n>.
//
// State is DERIVED from git plus GitHub on every read and never stored — a
// second source of truth is exactly what drifts.
//
// Exit codes: 0 pass · 1 pass with warnings · 2 blocked (reasons printed).
// Anything destructive is dry-run until --write, and a symlinked worktree
// parent or ~/.codex/config.toml is refused outright.
//
// Usage: node worktree.mjs create|restore|remove|list|prune|status [flags] [--json]
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMarkerComment, ghJson, parseFlags, renderResult } from './lib/gh.mjs';

const WORKTREES_DIR = '.vegastack/.worktrees';
const SLUG_MAX = 40;
const at = (where, message) => `${where}: ${message}`;

// An issue title comes from GitHub and reaches an operator's terminal through
// a block message. Two kinds of character in it are dangerous and neither is
// visible: the C0/C1 controls, which move the cursor and repaint the line, and
// the Unicode format controls — the bidirectional overrides and isolates most
// of all — which reorder what is printed, so a title can appear to end where
// it does not and hide the words that follow it. Both go. A long title is cut
// rather than allowed to fill the screen.
const printable = (text) => [...String(text ?? '')]
  .map((character) => {
    const point = character.codePointAt(0);
    const control = point <= 31 || (point >= 127 && point <= 159);
    return control || /\p{Cf}/u.test(character) ? ' ' : character;
  })
  .join('')
  .trim()
  .slice(0, 120);

// --- naming ---------------------------------------------------------------

// A directory- and branch-safe slug: lowercase, every run of non-alphanumerics
// collapsed to one dash, no leading or trailing dash, capped so paths stay sane.
export function slugify(title) {
  const collapsed = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return collapsed.slice(0, SLUG_MAX).replace(/-+$/g, '');
}

// The worktree directory name. An issue number is its stable identity; title
// slugs remain branch presentation and cannot move the checkout after rename.
export function worktreeName(issue, slug) {
  if ((issue === null || issue === undefined) && issueOfWorktree(slug) !== null) {
    throw new Error('a no-issue worktree slug cannot start with an issue number — choose a slug beginning with a letter');
  }
  return issue === null || issue === undefined ? String(slug) : String(issue);
}

// Attended checkouts stay project-local. A worker's repository checkout is one
// child of its repository holder; issue checkouts are its other child, so one
// repository never shares issue numbers or filesystem state with another.
export function worktreeRoot(repoRoot, workerLayout = false) {
  if (!workerLayout) return join(repoRoot, WORKTREES_DIR);
  if (basename(repoRoot) !== 'repo') throw new Error('worker worktree layout requires a repository checkout ending in /repo');
  return join(dirname(repoRoot), 'issues');
}

export function worktreePath(repoRoot, name, workerLayout = false) {
  return join(worktreeRoot(repoRoot, workerLayout), name);
}

// <type>/<n>-<slug>, or <type>/<slug> for the branches that have no issue
// (a direct chat fix, a release branch).
export function branchName(type, issue, slug) {
  const tail = issue === null || issue === undefined ? String(slug) : String(issue) + '-' + slug;
  return type + '/' + tail;
}

// The branch type and slug an issue title carries: a `<type>:` prefix from the
// branch: knob's list is the type, the rest is the slug. The worker
// predicts a run's worktree the same way, so a title names one path.
const DEFAULT_BRANCH_TYPES = ['feat', 'fix', 'docs', 'chore', 'refactor'];

// A leading `<word>:` is the title's prefix whether or not the project's list
// names it. Only a listed one becomes the type; either way it leaves the slug,
// because a slug beginning `research-` reads like a type that lost its slash.
export function titleParts(title, types = DEFAULT_BRANCH_TYPES) {
  const text = String(title ?? '');
  const [prefix, ...rest] = text.split(':');
  const hasPrefix = rest.length > 0 && /^[a-z][a-z0-9-]*$/i.test(prefix.trim());
  const type = hasPrefix && types.includes(prefix.trim()) ? prefix.trim() : null;
  return { type, slug: slugify(hasPrefix ? rest.join(':') : text) };
}

// The type and slug of the one local branch that carries this issue — or, for
// the branches that have no issue, this slug. Read from git rather than
// GitHub, because the branch is the fact restore acts on: it is also where the
// type comes from, so `restore` never has to be told one it could look up.
// Several matches need --slug to pick one.
export function branchPartsForIssue(repoRoot, issue, slug = null) {
  const listed = git(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  if (!listed.ok) return { error: 'cannot list branches: ' + listed.out };
  const lead = issue === null || issue === undefined ? '' : String(issue) + '-';
  const what = lead ? '#' + issue : lead + slug;
  const tail = (name) => name.slice(name.indexOf('/') + 1);
  const named = listed.out.split('\n').filter((name) => {
    if (!name.includes('/') || !tail(name).startsWith(lead)) return false;
    if (issue === null || issue === undefined) return true;
    const recorded = git(repoRoot, ['config', '--get', 'branch.' + name + '.vegafactoryIssue']);
    return recorded.ok && recorded.out === String(issue);
  });
  // --slug is how the caller picks among several, so it narrows before the
  // ambiguity is declared rather than after it.
  const matches = slug ? named.filter((name) => tail(name) === lead + slug) : named;
  if (matches.length === 0 && slug) return { error: 'no branch named ' + lead + slug + (named.length ? ' (there is ' + named.join(', ') + ')' : '') };
  if (matches.length === 0) return { error: 'no branch for ' + what + ' — nothing to restore; create it instead' };
  if (matches.length > 1) return { error: 'several branches match ' + what + ' (' + matches.join(', ') + ') — pass --slug and --type' };
  const slash = matches[0].indexOf('/');
  return { type: matches[0].slice(0, slash), slug: matches[0].slice(slash + 1 + lead.length) };
}

// --- porcelain ------------------------------------------------------------

// Parse `git worktree list --porcelain`. Records are blank-line separated;
// within a record the keys are `worktree`, `HEAD`, `branch` or `detached`,
// `locked` and `prunable` (the last three valueless or reason-carrying).
export function parseWorktreeList(porcelain) {
  const entries = [];
  let current = null;
  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };
  for (const raw of String(porcelain ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flush();
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      flush();
      current = { path: value, head: null, branch: null, locked: false, prunable: false, detached: false };
      continue;
    }
    if (!current) continue;
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
  }
  flush();
  return entries;
}

// --- lifecycle ------------------------------------------------------------

// The six lifecycle states, derived from git and GitHub facts. Precedence is
// fixed: a broken pairing (orphan-dir, branch-only) is reported before any
// judgement about the work, a held worktree is `active` whatever else is true,
// and `parked` is the residue. Callers only build facts for something that
// exists, so dirExists=false with branchExists=false does not arise.
export function classifyWorktree({ dirExists, branchExists, locked, issueState, mergedIntoDefault }) {
  if (dirExists && !branchExists) return 'orphan-dir';
  if (!dirExists) return 'branch-only';
  if (locked) return 'active';
  if (mergedIntoDefault) return 'merged';
  if (issueState === 'closed') return 'abandoned';
  return 'parked';
}

// --- filesystem safety ----------------------------------------------------

// A symlinked worktree parent lets Git write outside the repository during
// checkout deletion. Refuse the path rather than resolving it.
export function symlinkBlock(path) {
  try {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return at(path, 'is a symlink — refusing to write through it');
  } catch {
    return null;
  }
  return null;
}

// --- the safe-to-remove test ----------------------------------------------

const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_MS = 14 * DAY_MS;
const DEFAULT_DEPS_RETENTION_MS = 3 * DAY_MS;

// All of these must hold before a worktree directory is removed. Each failure
// gets its own sentence so the caller can print exactly why the work is being
// kept. `force` is the operator's word and lifts ONE thing — the not-merged
// block. Uncommitted, unpushed and locked are never lifted: those are the
// three ways real work disappears.
export function evaluateRemoval({ state, dirty, unpushed, remoteKnown = true, remoteMissing, mergedIntoDefault, locked, headReachable = true, force = false }) {
  const blocks = [];
  const warns = [];
  const branchGone = state === 'orphan-dir';
  if (dirty) blocks.push('uncommitted changes in the worktree — commit or discard them first');
  if (branchGone && !headReachable) blocks.push('the detached HEAD contains a unique commit — attach it to a branch before removing this worktree');
  if (!branchGone && !remoteKnown) blocks.push('the remote branch state could not be verified — keeping the worktree');
  if (!branchGone && (unpushed || (remoteMissing && !mergedIntoDefault))) {
    blocks.push('commits not on the remote — push the branch first, then re-check');
  }
  if (!branchGone && !mergedIntoDefault && !force) {
    blocks.push('not merged into the default branch — merge it, or pass --force with the operator\'s word');
  }
  if (locked) blocks.push('the worktree is locked — a session is holding it; unlock it first');
  if (state === 'abandoned') warns.push('the issue is closed and the branch never merged — this is the only checkout of that work');
  return { blocks, warns };
}

// --- retention and the dev.md knobs ---------------------------------------

// "14d" / "48h" / "90m" → milliseconds. Anything else is null, and every
// caller treats null as "use the default" rather than guessing.
export function parseDuration(text) {
  const match = /^(\d+)\s*([dhm])$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const units = { d: DAY_MS, h: 3_600_000, m: 60_000 };
  return Number(match[1]) * units[match[2]];
}

const knobLine = (devMd, knob) => {
  const match = new RegExp('^' + knob + ':[ \\t]*(.*)$', 'm').exec(String(devMd ?? ''));
  if (!match) return null;
  return match[1].split('#')[0].trim();
};

// worktree-retention: how long a parked worktree survives with no session.
// Absent or unparseable falls back to 14 days — a guard never invents a
// shorter window than the documented default.
export function parseRetentionKnob(devMd) {
  return parseDuration(knobLine(devMd, 'worktree-retention')) ?? DEFAULT_RETENTION_MS;
}

export function parseDepsRetentionKnob(devMd) {
  const named = parseDuration(knobLine(devMd, 'worktree-deps-retention'));
  return Math.min(named ?? DEFAULT_DEPS_RETENTION_MS, parseRetentionKnob(devMd));
}

// The owner-controlled root is the repository for an attended checkout and the
// per-repository holder for a worker checkout. Nothing below it is trusted by
// name: every existing component is checked before a destructive operation.
function managedRoot(repoRoot, workerLayout) {
  return workerLayout ? dirname(repoRoot) : repoRoot;
}

function markerRoot(repoRoot, workerLayout) {
  return workerLayout
    ? join(dirname(repoRoot), 'deps-dropped')
    : join(repoRoot, '.vegastack', '.tmp', 'deps-dropped');
}

export const trustedAncestorOwner = (ownerUid, currentUid = process.getuid?.()) => currentUid === undefined || ownerUid === 0 || ownerUid === currentUid;

export function verifyOwnedPath(root, target, { allowMissingLeaf = false } = {}) {
  const owned = resolve(root);
  const lexicalTarget = resolve(target);
  const rel = relative(owned, lexicalTarget);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return { ok: false, reason: lexicalTarget + ' is outside ' + owned };
  let canonical;
  try {
    const leaf = lstatSync(owned);
    if (leaf.isSymbolicLink() || !leaf.isDirectory()) return { ok: false, reason: owned + ' is not an ordinary managed root' };
    canonical = realpathSync(owned);
  } catch (error) { return { ok: false, reason: owned + ' could not be anchored: ' + error.message }; }
  // A checked root can still be renamed by somebody who controls its parent. Canonicalize away
  // trusted system aliases (macOS /var -> /private/var), then require every ancestor to be an
  // ordinary directory that is not group/other writable. A sticky directory such as /tmp is
  // safe for an entry owned by this uid: another uid cannot rename that entry.
  let anchor = parse(canonical).root;
  for (const part of canonical.slice(anchor.length).split(sep).filter(Boolean)) {
    anchor = join(anchor, part);
    let info;
    try { info = lstatSync(anchor); }
    catch (error) { return { ok: false, reason: anchor + ' could not be inspected: ' + error.message }; }
    if (info.isSymbolicLink() || !info.isDirectory()) return { ok: false, reason: anchor + ' is not an ordinary directory' };
    const currentUid = process.getuid?.();
    if (!trustedAncestorOwner(info.uid, currentUid)) return { ok: false, reason: anchor + ' is controlled by untrusted uid ' + info.uid };
    if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) return { ok: false, reason: anchor + ' is unsafe because other users can rename entries in it' };
  }
  const wanted = join(canonical, rel);
  const uid = process.getuid?.();
  let cursor = canonical;
  const parts = rel ? rel.split(sep).filter(Boolean) : [];
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) cursor = join(cursor, parts[index]);
    if (!existsSync(cursor)) {
      if (allowMissingLeaf) return { ok: true, reason: null };
      return { ok: false, reason: cursor + ' does not exist' };
    }
    let info;
    try { info = lstatSync(cursor); }
    catch (error) { return { ok: false, reason: cursor + ' could not be inspected: ' + error.message }; }
    if (info.isSymbolicLink() || !info.isDirectory()) return { ok: false, reason: cursor + ' is not an ordinary directory (symlinks are refused)' };
    if (uid !== undefined && info.uid !== uid) return { ok: false, reason: cursor + ' is owned by uid ' + info.uid + ', not the current user' };
    if ((info.mode & 0o022) !== 0) return { ok: false, reason: cursor + ' is unsafe because other users can write it' };
  }
  return { ok: true, reason: null };
}

function ensureMarkerRoot(repoRoot, workerLayout) {
  const owner = managedRoot(repoRoot, workerLayout);
  const root = markerRoot(repoRoot, workerLayout);
  const ownerSafety = verifyOwnedPath(owner, owner);
  if (!ownerSafety.ok) throw new Error(ownerSafety.reason);
  let cursor = owner;
  for (const part of relative(owner, root).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
    const safety = verifyOwnedPath(owner, cursor);
    if (!safety.ok) throw new Error(safety.reason);
  }
  chmodSync(root, 0o700);
  return root;
}

const markerFile = (repoRoot, workerLayout, name) => join(markerRoot(repoRoot, workerLayout), encodeURIComponent(name) + '.json');

function validMarkerRecord(value, { repoRoot, workerLayout, name }) {
  if (!value || value.schema !== 1 || value.name !== name || value.repoRoot !== resolve(repoRoot)) return false;
  if (value.path !== worktreePath(repoRoot, name, workerLayout)) return false;
  if (!Array.isArray(value.deps) || value.deps.length !== 1 || value.deps[0] !== 'node_modules') return false;
  if (typeof value.droppedAt !== 'string') return false;
  try { return new Date(value.droppedAt).toISOString() === value.droppedAt; }
  catch { return false; }
}

const validSlug = (name) => name.length <= SLUG_MAX && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
const validWorktreeIdentity = (name) => {
  if (/^[1-9]\d*$/.test(name)) return true;
  const legacy = /^([1-9]\d*)-(.+)$/.exec(name);
  return legacy ? validSlug(legacy[2]) : validSlug(name);
};

export function readDroppedDeps({ repoRoot, workerLayout = false }) {
  const records = new Map();
  const owner = managedRoot(repoRoot, workerLayout);
  const root = markerRoot(repoRoot, workerLayout);
  const safety = verifyOwnedPath(owner, root, { allowMissingLeaf: true });
  if (!safety.ok) return { records, unreadable: safety.reason };
  if (!existsSync(root)) return { records, unreadable: null };
  const rootInfo = lstatSync(root);
  if ((rootInfo.mode & 0o777) !== 0o700) return { records, unreadable: root + ' is not owner-only 0700' };
  let entries;
  try { entries = readdirSync(root); }
  catch (error) { return { records, unreadable: 'the dependency marker root could not be read: ' + error.message }; }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) return { records, unreadable: 'a record of dropped dependencies has an unreadable name' };
    let name;
    try {
      name = decodeURIComponent(entry.slice(0, -5));
      if (encodeURIComponent(name) + '.json' !== entry || !validWorktreeIdentity(name)) throw new Error('invalid name');
    } catch { return { records, unreadable: 'a record of dropped dependencies has an unreadable name' }; }
    const path = join(root, entry);
    let info;
    try { info = lstatSync(path); }
    catch (error) { return { records, unreadable: path + ' could not be inspected: ' + error.message }; }
    if (info.isSymbolicLink() || !info.isFile()) return { records, unreadable: path + ' is not an ordinary marker file' };
    if (process.getuid && info.uid !== process.getuid()) return { records, unreadable: path + ' is owned by another user' };
    if ((info.mode & 0o777) !== 0o600) return { records, unreadable: path + ' is not owner-only 0600' };
    if (info.size > 16_384) return { records, unreadable: path + ' is too large to be a dependency marker' };
    let record;
    try { record = JSON.parse(readFileSync(path, 'utf8')); }
    catch { return { records, unreadable: path + ' is not valid JSON' }; }
    if (!validMarkerRecord(record, { repoRoot, workerLayout, name })) return { records, unreadable: 'unreadable marker ' + path + ' does not match this worktree' };
    records.set(name, record);
  }
  return { records, unreadable: null };
}

export function noteDroppedDeps({ repoRoot, workerLayout = false, name, path, deps = ['node_modules'], droppedAt }) {
  if (path !== worktreePath(repoRoot, name, workerLayout) || deps.length !== 1 || deps[0] !== 'node_modules') throw new Error('the dependency marker does not match the managed worktree');
  const existing = readDroppedDeps({ repoRoot, workerLayout });
  if (existing.unreadable) throw new Error(existing.unreadable);
  const checkout = verifyOwnedPath(managedRoot(repoRoot, workerLayout), path);
  if (!checkout.ok) throw new Error(checkout.reason);
  const root = ensureMarkerRoot(repoRoot, workerLayout);
  const target = markerFile(repoRoot, workerLayout, name);
  if (existsSync(target)) {
    const info = lstatSync(target);
    if (info.isSymbolicLink() || !info.isFile() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o777) !== 0o600) {
      throw new Error(target + ' is not a safe existing marker');
    }
  }
  const record = { schema: 1, name, repoRoot: resolve(repoRoot), path, deps: ['node_modules'], droppedAt };
  const temporary = join(root, '.' + encodeURIComponent(name) + '.' + randomUUID() + '.tmp');
  try {
    writeFileSync(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* retain the original failure */ }
    throw error;
  }
}

export function clearDroppedDeps({ repoRoot, workerLayout = false, name, path }) {
  const state = readDroppedDeps({ repoRoot, workerLayout });
  if (state.unreadable) return false;
  const record = state.records.get(name);
  if (!record) return true;
  if (record.path !== path) return false;
  const target = markerFile(repoRoot, workerLayout, name);
  try {
    const info = lstatSync(target);
    if (info.isSymbolicLink() || !info.isFile() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o777) !== 0o600) return false;
    rmSync(target);
    return true;
  } catch (error) { return error.code === 'ENOENT'; }
}

// branch: the type list, which lives in the comment on that knob's own line —
// `branch: <type>/<slug>   # type: feat | fix | docs | chore | refactor — …`.
// knobLine() cannot read it, because it drops everything after the `#`, and
// that is where the list is. A project that edits the knob changes which
// prefixes name a branch here; an unreadable dev.md keeps the five defaults,
// so a guard never widens the list by failing to read it.
export function parseBranchTypes(devMd) {
  const line = new RegExp('^branch:[ \\t]*(.*)$', 'm').exec(String(devMd ?? ''))?.[1] ?? '';
  // Stop at the prose that follows the list — an em-dash, or a hyphen with
  // space on both sides. Never at a bare hyphen: `hot-fix` is one type name.
  const listed = (/#[ \t]*type:[ \t]*(.*)$/.exec(line)?.[1] ?? '').split(/\s—|\s-\s/)[0];
  const types = listed.split('|').map((one) => one.trim()).filter(Boolean);
  return types.length ? types : [...DEFAULT_BRANCH_TYPES];
}

// worktree-include: gitignored files a fresh checkout lacks (.env, .dev.vars).
// `none` is the explicit empty list, so a missing knob and "nothing to copy"
// are not confused.
export function parseIncludeKnob(devMd) {
  const value = knobLine(devMd, 'worktree-include');
  if (!value || value === 'none') return [];
  return value.split(/\s+/).filter(Boolean);
}

// The `setup \`...\`` field of dev.md's `commands:` line — what a fresh
// checkout has to run before it can build (bun install, and friends).

// Age is measured from the LATER of the last commit and the last ledger edit:
// a branch that has not moved may still be an issue someone is actively
// working, and the ledger is where that shows.
export function isPastRetention({ lastCommitAt, ledgerUpdatedAt, now, retentionMs }) {
  const stamps = [lastCommitAt, ledgerUpdatedAt]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  if (stamps.length === 0) return false;
  return now - Math.max(...stamps) >= retentionMs;
}

// --- git plumbing ---------------------------------------------------------

// Every git call goes through execFileSync with an explicit argv: no shell, no
// interpolation, and a failure surfaces as { ok: false, out } for the caller
// to turn into a block or a warn rather than an unhandled throw.
// `input` feeds stdin (the patch-id calls below); `raw` keeps the output
// untrimmed, because a diff's last line may be a lone space that a trim would
// eat and a patch-id would then miss.
export function git(cwd, args, { input, raw = false } = {}) {
  try {
    const out = execFileSync('git', args, {
      cwd, encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(Number(process.env.VSK_WORKTREE_GIT_TIMEOUT_MS) > 0
        ? { timeout: Number(process.env.VSK_WORKTREE_GIT_TIMEOUT_MS), killSignal: 'SIGKILL' }
        : {}),
    });
    return { ok: true, out: raw ? out : out.trim() };
  } catch (error) {
    const stderr = error.stderr?.toString().trim() || error.message;
    return { ok: false, out: stderr };
  }
}

// git reports worktree paths through realpath (on macOS /var is a symlink to
// /private/var), so a path off porcelain and a path composed from repoRoot do
// not compare equal. Re-express a porcelain path under the caller's own root
// whenever it names one of our worktrees; otherwise hand it back untouched.
export function rebaseUnderRoot(repoRoot, absPath, workerLayout = false) {
  if (!absPath) return absPath;
  const root = worktreeRoot(repoRoot, workerLayout);
  const prefix = root + sep;
  const named = absPath.startsWith(prefix) ? absPath.slice(prefix.length) : basename(absPath);
  if (!named || named.includes(sep)) return absPath;
  const composed = worktreePath(repoRoot, named, workerLayout);
  try {
    // Only claim the path as ours when it really is the same directory —
    // otherwise a worktree belonging to a different checkout (or the caller
    // pointing repoRoot at a worktree) would be rewritten into a path that
    // does not exist.
    return realpathSync(composed) === realpathSync(absPath) ? composed : absPath;
  } catch {
    return absPath;
  }
}

// The MAIN checkout of the repository the cwd belongs to. Inside either layout,
// `rev-parse --show-toplevel` answers with the worktree; the common git dir is
// what points back at the checkout that owns the worktree relationship.
export function mainCheckout(cwd) {
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.ok && common.out) return dirname(common.out);
  return git(cwd, ['rev-parse', '--show-toplevel']).out;
}

const hasRemote = (repoRoot, remote) => git(repoRoot, ['remote', 'get-url', remote]).ok;
const branchExistsIn = (repoRoot, branch, gitRunner = git) => gitRunner(repoRoot, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]).ok;

// The path of the worktree currently holding a branch, straight off porcelain.
export function worktreeHoldingBranch(repoRoot, branch, gitRunner = git, workerLayout = false) {
  const listed = gitRunner(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return null;
  const found = parseWorktreeList(listed.out).find((entry) => entry.branch === branch)?.path ?? null;
  return rebaseUnderRoot(repoRoot, found, workerLayout);
}

// --- Codex trust ----------------------------------------------------------

// Codex skips .codex/ hooks, rules and project config for an untrusted path,
// so a fresh worktree has to be added to ~/.codex/config.toml before any run
// there. Idempotent by header match: the entry is appended exactly once.
export function codexTrustToml(configText, absPath) {
  const text = String(configText ?? '');
  const header = '[projects."' + absPath + '"]';
  if (text.includes(header)) return { changed: false, text };
  const prefix = text.length === 0 || text.endsWith('\n') ? text : text + '\n';
  const separator = prefix.length === 0 ? '' : '\n';
  return { changed: true, text: prefix + separator + header + '\n' + 'trust_level = "trusted"\n' };
}

function applyCodexTrust({ home, absPath, write, actions, warns, blocks }) {
  const onPath = (process.env.PATH ?? '')
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, 'codex')));
  if (!onPath) {
    warns.push('codex is not on PATH — skipped the ' + absPath + ' trust entry in ~/.codex/config.toml');
    return;
  }
  const configPath = join(home, '.codex', 'config.toml');
  const symlink = symlinkBlock(configPath);
  if (symlink) {
    blocks.push(symlink);
    return;
  }
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const next = codexTrustToml(existing, absPath);
  if (!next.changed) return;
  actions.push(at(configPath, 'add [projects."' + absPath + '"] trust_level = "trusted"'));
  if (!write) return;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, next.text);
}

// --- create and restore ---------------------------------------------------

function prepareCheckout({ repoRoot, path, devMd, home, write, actions, warns, blocks, required = false }) {
  for (const file of parseIncludeKnob(devMd)) {
    const source = join(repoRoot, file);
    if (!existsSync(source)) {
      (required ? blocks : warns).push(at(file, 'listed in worktree-include: but absent from the main checkout — not copied'));
      continue;
    }
    if (symlinkBlock(source)) {
      (required ? blocks : warns).push(at(file, 'is a symlink in the main checkout — not copied'));
      continue;
    }
    actions.push(at(file, 'copy into the worktree'));
    if (!write) continue;
    const target = join(path, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  // Dependencies are not installed here: a step that needs them runs the setup command itself,
  // so a docs-only issue costs a few megabytes instead of a full install.
  applyCodexTrust({ home, absPath: path, write, actions, warns, blocks });
}

// Create the checkout for a branch: a fresh worktree cut from origin/<base>. Every issue —
// sub-issues of an epic included — gets its own branch, worktree and PR.
export function createWorktree({ repoRoot, issue, slug, type, title, base, devMd, home, write = false, workerLayout = false }) {
  const blocks = [];
  const warns = [];
  const actions = [];
  // The branch is named before anything is cut, so an unlisted type is refused
  // here rather than becoming a branch nobody's conventions expect. `feat` was
  // the silent answer for a title that named no type; naming the list instead
  // tells the caller what this project actually has.
  const types = parseBranchTypes(devMd);
  if (!type) {
    const named = title ? '"' + printable(title) + '"' : '#' + issue;
    return { blocks: [at('branch type', named + ' names no type — pass --type <one of: ' + types.join(', ') + '>')], warns, actions };
  }
  if (!types.includes(type)) return { blocks: [at('branch type', type + ' is not one this project has — dev.md lists ' + types.join(', '))], warns, actions };
  if ((issue === null || issue === undefined) && issueOfWorktree(slug) !== null) {
    return { blocks: [at('worktree slug', 'a no-issue worktree cannot start with an issue number — choose a slug beginning with a letter')], warns, actions };
  }
  const branch = branchName(type, issue, slug);
  const name = worktreeName(issue, slug);

  const root = worktreeRoot(repoRoot, workerLayout);
  const path = worktreePath(repoRoot, name, workerLayout);
  for (const candidate of [workerLayout ? dirname(root) : join(repoRoot, '.vegastack'), root, path]) {
    const symlink = symlinkBlock(candidate);
    if (symlink) blocks.push(symlink);
  }
  if (blocks.length > 0) return { blocks, warns, actions, path, branch };

  if (issue !== null && issue !== undefined) {
    const existing = inventory(repoRoot, workerLayout).find((entry) => issueOfWorktree(entry.name) === issue);
    if (existing) {
      blocks.push(at('#' + issue, 'already has a worktree at ' + existing.path + ' — reuse or remove it before creating another'));
      return { blocks, warns, actions, path, branch };
    }
  }

  if (branchExistsIn(repoRoot, branch)) {
    blocks.push(at(branch, 'the branch already exists — use restore to re-add its worktree'));
    return { blocks, warns, actions, path, branch };
  }
  if (existsSync(path)) {
    blocks.push(at(path, 'a worktree directory already exists for #' + issue + ' — inspect or remove it before creating another'));
    return { blocks, warns, actions, path, branch };
  }

  let startPoint = base;
  if (hasRemote(repoRoot, 'origin')) {
    actions.push(at('origin', 'git fetch origin ' + base));
    if (write) {
      const fetched = git(repoRoot, ['fetch', 'origin', base]);
      if (!fetched.ok) warns.push(at('origin', 'fetch of ' + base + ' failed, cutting from the local ref instead: ' + fetched.out));
      else startPoint = 'origin/' + base;
    } else {
      startPoint = 'origin/' + base;
    }
  } else {
    warns.push('no origin remote — cutting the branch from the local ' + base);
  }

  actions.push(at(path, 'git worktree add -b ' + branch + ' from ' + startPoint));
  if (write) {
    const added = git(repoRoot, ['worktree', 'add', path, '-b', branch, startPoint]);
    if (!added.ok) {
      blocks.push(at(path, 'git worktree add failed: ' + added.out));
      return { blocks, warns, actions, path, branch };
    }
    if (issue !== null && issue !== undefined) {
      const recorded = git(repoRoot, ['config', 'branch.' + branch + '.vegafactoryIssue', String(issue)]);
      if (!recorded.ok) {
        blocks.push(at(branch, 'could not record its issue identity: ' + recorded.out));
        return { blocks, warns, actions, path, branch };
      }
    }
    prepareCheckout({ repoRoot, path, devMd, home, write, actions, warns, blocks });
    if (!clearDroppedDeps({ repoRoot, workerLayout, name, path })) blocks.push(at(name, 'the stale dependency marker could not be cleared'));
  } else {
    prepareCheckout({ repoRoot, path, devMd, home, write: false, actions, warns, blocks });
  }
  return { blocks, warns, actions, path, branch };
}

// Re-add the checkout for a branch that still exists but whose directory is
// gone — the corrections and reclaim path. It never creates a branch: a
// missing branch means the work is somewhere else, and guessing would be worse
// than stopping.
export function restoreWorktree({ repoRoot, issue, slug, type, devMd, home, write = false, gitRunner = git, workerLayout = false }) {
  const blocks = [];
  const warns = [];
  const actions = [];
  if ((issue === null || issue === undefined) && issueOfWorktree(slug) !== null) {
    return { blocks: [at('worktree slug', 'a no-issue worktree cannot start with an issue number — choose a slug beginning with a letter')], warns, actions };
  }
  const branch = branchName(type, issue, slug);
  const name = worktreeName(issue, slug);
  const root = worktreeRoot(repoRoot, workerLayout);
  const path = worktreePath(repoRoot, name, workerLayout);

  for (const candidate of [workerLayout ? dirname(root) : join(repoRoot, '.vegastack'), root, path]) {
    const symlink = symlinkBlock(candidate);
    if (symlink) blocks.push(symlink);
  }
  if (blocks.length > 0) return { blocks, warns, actions, path, branch };

  if (!branchExistsIn(repoRoot, branch, gitRunner)) {
    blocks.push(at(branch, 'no branch of that name — nothing to restore; create it instead'));
    return { blocks, warns, actions, path, branch };
  }
  const held = worktreeHoldingBranch(repoRoot, branch, gitRunner, workerLayout);
  if (held) {
    warns.push(at(held, 'already holds ' + branch + ' — nothing to restore'));
    return { blocks, warns, actions, path: held, branch };
  }

  actions.push(at(path, 'git worktree add ' + branch));
  if (write) {
    const added = gitRunner(repoRoot, ['worktree', 'add', path, branch]);
    if (!added.ok) {
      blocks.push(at(path, 'git worktree add failed: ' + added.out));
      return { blocks, warns, actions, path, branch };
    }
  }
  prepareCheckout({ repoRoot, path, devMd, home, write, actions, warns, blocks });
  if (write && !clearDroppedDeps({ repoRoot, workerLayout, name, path })) blocks.push(at(name, 'the stale dependency marker could not be cleared'));
  return { blocks, warns, actions, path, branch };
}

// --- remove and prune -----------------------------------------------------

// Read the git facts the safe-to-remove test needs. Every unverifiable fact
// fails closed: a status call that errors reports dirty, a merge check that
// errors reports not-merged.
function remoteHead(repoRoot, remote, branch) {
  if (!hasRemote(repoRoot, remote)) return { known: true, sha: null };
  const answer = git(repoRoot, ['ls-remote', '--heads', remote, 'refs/heads/' + branch]);
  if (!answer.ok) return { known: false, sha: null };
  if (!answer.out) return { known: true, sha: null };
  const rows = answer.out.split('\n').filter(Boolean);
  if (rows.length !== 1) return { known: false, sha: null };
  const [sha, ref, extra] = rows[0].split(/\s+/);
  return !extra && ref === 'refs/heads/' + branch && /^[0-9a-f]{40}$/i.test(sha)
    ? { known: true, sha }
    : { known: false, sha: null };
}

export function gatherRemovalFacts({ repoRoot, path, branch, base, remote, locked, baseReady = true }) {
  // Status normally refreshes index stat data. Preview is byte-pure, so disable Git's optional
  // locks/writes while still reading every tracked, staged, unstaged and untracked change.
  const status = git(path, ['--no-optional-locks', 'status', '--porcelain']);
  const dirty = !status.ok || status.out !== '';
  const headResult = git(path, ['rev-parse', '--verify', 'HEAD']);
  const head = headResult.ok && /^[0-9a-f]{40}$/i.test(headResult.out) ? headResult.out : null;
  if (branch === null) {
    const containing = head === null ? { ok: false, out: '' } : git(repoRoot, [
      'for-each-ref', '--contains', head, '--format=%(refname)', 'refs/heads', 'refs/remotes',
    ]);
    const headReachable = containing.ok && containing.out.split('\n').some(Boolean);
    return {
      dirty, head, headReachable, everPushed: false, unpushed: false,
      remoteKnown: true, remoteMissing: false, deletedAfterPush: false, mergedIntoDefault: false, locked,
    };
  }
  const authoritative = remoteHead(repoRoot, remote, branch);
  const remoteKnown = authoritative.known;
  const remoteMissing = remoteKnown && authoritative.sha === null;
  const ahead = !remoteKnown || remoteMissing ? null : git(repoRoot, ['rev-list', authoritative.sha + '..' + branch]);
  const everPushed = git(repoRoot, ['config', '--get', 'branch.' + branch + '.merge']).out.trim() === 'refs/heads/' + branch;
  const unpushed = !remoteKnown || (remoteMissing ? !everPushed : !ahead.ok || ahead.out !== '');
  const baseRef = git(repoRoot, ['rev-parse', '--verify', '--quiet', 'refs/remotes/' + remote + '/' + base]).ok
    ? remote + '/' + base
    : base;
  // A branch that has never reached the remote cannot have been merged: main is
  // reached through a PR, so "ancestor of the default branch" alone would call a
  // brand-new branch cut from origin/main 'merged' and prune it on day one.
  const isAncestor = git(repoRoot, ['merge-base', '--is-ancestor', branch, baseRef]).ok;
  // A squash merge deletes the remote branch (delete-on-merge), so content decides then.
  const mergedIntoDefault = baseReady && remoteKnown && (((!remoteMissing || everPushed) && isAncestor) || mergedByContent(repoRoot, branch, baseRef));
  const deletedAfterPush = remoteMissing && everPushed;
  return { dirty, head, headReachable: true, everPushed, unpushed, remoteKnown, remoteMissing, deletedAfterPush, mergedIntoDefault, locked };
}

// Squash and rebase merges rewrite the commits, so by ancestry a merged branch
// stays unmerged forever — and both are ordinary `merge:` knob values. Content
// is the second test: the branch counts as merged when its whole diff against
// the merge base (a squash) or every one of its commits (a rebase) carries a
// patch-id already on the default branch. A merge whose conflicts were resolved
// by hand changes the patch and stays unmerged here; --force remains the word.
const PATCH_LOG = ['log', '-p', '--no-color', '--no-ext-diff', '--format=commit %H'];

function patchIds(repoRoot, text) {
  if (!text) return [];
  const ids = git(repoRoot, ['patch-id', '--stable'], { input: text });
  if (!ids.ok) return [];
  return ids.out.split('\n').map((line) => line.split(' ')[0]).filter(Boolean);
}

export function mergedByContent(repoRoot, branch, baseRef) {
  const mergeBase = git(repoRoot, ['merge-base', branch, baseRef]);
  if (!mergeBase.ok || !mergeBase.out) return false;
  const landed = git(repoRoot, [...PATCH_LOG, mergeBase.out + '..' + baseRef], { raw: true });
  if (!landed.ok) return false;
  const known = new Set(patchIds(repoRoot, landed.out));
  if (known.size === 0) return false;
  const squashed = git(repoRoot, ['diff', '--no-color', '--no-ext-diff', mergeBase.out, branch], { raw: true });
  if (squashed.ok && patchIds(repoRoot, squashed.out).some((id) => known.has(id))) return true;
  const own = git(repoRoot, [...PATCH_LOG, mergeBase.out + '..' + branch], { raw: true });
  if (!own.ok) return false;
  const ownIds = patchIds(repoRoot, own.out);
  return ownIds.length > 0 && ownIds.every((id) => known.has(id));
}

// The merge lands on the server, so the local origin/<base> is only as fresh as
// the last fetch. Preview compares it with read-only ls-remote and refuses stale
// facts without writing; an explicit write may fetch before it judges.
function refreshBase({ repoRoot, base, remote, actions, warns, write }) {
  if (!hasRemote(repoRoot, remote)) return true;
  const authoritative = remoteHead(repoRoot, remote, base);
  if (!authoritative.known || !authoritative.sha) {
    warns.push(at(remote, 'could not verify the remote ' + base + ' ref — remote merge facts are unavailable'));
    return false;
  }
  if (!write) {
    const local = git(repoRoot, ['rev-parse', '--verify', '--quiet', 'refs/remotes/' + remote + '/' + base]);
    if (!local.ok || local.out !== authoritative.sha) {
      warns.push(at(remote, 'preview did not fetch; local ' + remote + '/' + base + ' is not current, so merge facts are unavailable'));
      return false;
    }
    return true;
  }
  actions.push(at(remote, 'git fetch ' + remote + ' ' + base));
  const fetched = git(repoRoot, ['fetch', remote, base]);
  if (!fetched.ok) {
    warns.push(at(remote, 'fetch of ' + base + ' failed, so merge facts are unavailable: ' + fetched.out));
    return false;
  }
  const local = git(repoRoot, ['rev-parse', '--verify', '--quiet', 'refs/remotes/' + remote + '/' + base]);
  return local.ok && local.out === authoritative.sha;
}

// Remove one worktree directory — and only the directory. The local branch and
// the remote branch are never touched here: deleting either is on the ship
// guard's always-ask list and takes the operator's own word.
export function removeWorktree({ repoRoot, name, base, force = false, push = false, write = false, remote = 'origin', workerLayout = false }) {
  const blocks = [];
  const warns = [];
  const actions = [];
  const path = worktreePath(repoRoot, name, workerLayout);
  const safety = verifyOwnedPath(managedRoot(repoRoot, workerLayout), path);
  if (!safety.ok) return { blocks: [safety.reason], warns, actions };

  const listed = git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return { blocks: [at(repoRoot, 'cannot read the worktree list: ' + listed.out)], warns, actions };
  const entry = parseWorktreeList(listed.out).find((item) => rebaseUnderRoot(repoRoot, item.path, workerLayout) === path);
  if (!entry) return { blocks: [at(name, 'no worktree at ' + path + ' — nothing to remove')], warns, actions };

  const branch = entry.branch;
  const baseReady = refreshBase({ repoRoot, base, remote, actions, warns, write });
  let facts = gatherRemovalFacts({ repoRoot, path, branch, base, remote, locked: entry.locked, baseReady });
  if (push && branch && (facts.unpushed || (facts.remoteMissing && !facts.deletedAfterPush))) {
    actions.push(at(branch, 'git push -u ' + remote + ' ' + branch + ' before removing'));
    if (write) {
      const pushed = git(path, ['push', '-u', remote, branch]);
      if (!pushed.ok) warns.push(at(branch, 'push failed: ' + pushed.out));
      facts = gatherRemovalFacts({ repoRoot, path, branch, base, remote, locked: entry.locked, baseReady });
    } else {
      facts = { ...facts, remoteMissing: false, unpushed: false };
    }
  }

  const state = classifyWorktree({
    dirExists: true,
    branchExists: branch !== null,
    locked: entry.locked,
    issueState: null,
    mergedIntoDefault: facts.mergedIntoDefault,
  });
  const verdict = evaluateRemoval({ state, ...facts, locked: entry.locked, force });
  blocks.push(...verdict.blocks);
  warns.push(...verdict.warns);
  if (blocks.length > 0) return { blocks, warns, actions, path, branch, state };

  if (write) {
    const markers = readDroppedDeps({ repoRoot, workerLayout });
    if (markers.unreadable) {
      blocks.push(at(name, 'the dependency marker state is unreadable: ' + markers.unreadable));
      return { blocks, warns, actions, path, branch, state };
    }
    const marker = markers.records.get(name);
    if (marker && marker.path !== path) {
      blocks.push(at(name, 'the dependency marker names a different checkout'));
      return { blocks, warns, actions, path, branch, state };
    }
  }

  actions.push(at(path, 'git worktree remove (the branch and its remote are left alone)'));
  if (write) {
    const removed = git(repoRoot, ['worktree', 'remove', path]);
    if (!removed.ok) blocks.push(at(path, 'git worktree remove failed: ' + removed.out));
    else if (!clearDroppedDeps({ repoRoot, workerLayout, name, path })) warns.push(at(name, 'the dependency marker could not be cleared after removal'));
  }
  return { blocks, warns, actions, path, branch, state };
}

// Every worktree directory under the selected attended/worker root, with its
// branch and lock flag straight off porcelain. The main checkout is never one.
export function inventory(repoRoot, workerLayout = false) {
  const listed = git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return [];
  const prefix = worktreeRoot(repoRoot, workerLayout) + sep;
  return parseWorktreeList(listed.out)
    .map((entry) => ({ ...entry, path: rebaseUnderRoot(repoRoot, entry.path, workerLayout) }))
    .filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, name: entry.path.slice(prefix.length) }));
}

// Secrets never leave the machine in an automatic commit (the same list as the CLI's hook).
const SECRET_NAMES = [/^\.env(\..+)?$/, /\.(pem|key|p12)$/, /^id_rsa/];
const SECRET_TEXT = [
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{32,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /_auth(?:Token)?\s*=\s*(?!\$\{)\S/,
];

export function stagedSecrets(path) {
  const hits = new Set();
  const names = git(path, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']).out.split('\n').filter(Boolean);
  for (const file of names) {
    const name = file.split('/').pop();
    if (name !== '.env.example' && SECRET_NAMES.some((pattern) => pattern.test(name))) hits.add(file);
  }
  const diff = git(path, ['diff', '--cached', '--no-color', '--no-ext-diff', '-U0', '--diff-filter=ACMR'], { raw: true });
  if (!diff.ok) return ['(the staged changes could not be read)'];
  let file = '';
  for (const line of diff.out.split('\n')) {
    if (line.startsWith('+++ ')) { file = line.replace(/^\+\+\+ (b\/)?/, ''); continue; }
    if (line.startsWith('+') && SECRET_TEXT.some((pattern) => pattern.test(line))) hits.add(file);
  }
  return [...hits];
}

// Work nobody committed is saved, never thrown away: a `wip:` commit on the
// worktree's own branch, pushed normally. A rejected push (the remote moved)
// keeps the commit local; staged secrets keep the work uncommitted.
export function rescueWork({ path, branch, name, remote = 'origin' }) {
  // diff-index sees every index state, including deletions and intent-to-add entries that an
  // ACMR-filtered `git diff --cached` omits. Any selection belongs to the user and is left alone.
  const staged = git(path, ['diff-index', '--cached', '--name-only', 'HEAD', '--']);
  if (!staged.ok) return { ok: false, committed: false, reason: 'the staged selection could not be read: ' + staged.out };
  if (staged.out) return { ok: false, committed: false, reason: 'the staged selection is not empty — preserving it unchanged' };
  const index = git(path, ['rev-parse', '--git-path', 'index']);
  if (!index.ok || !index.out) return { ok: false, committed: false, reason: 'the git index path could not be read' };
  const indexPath = isAbsolute(index.out) ? index.out : resolve(path, index.out);
  let indexBytes;
  try { indexBytes = readFileSync(indexPath); }
  catch (error) { return { ok: false, committed: false, reason: 'the git index could not be snapshotted: ' + error.message }; }
  const restoreIndex = () => {
    try { writeFileSync(indexPath, indexBytes); return null; }
    catch (error) { return ' and the original index could not be restored: ' + error.message; }
  };
  const added = git(path, ['add', '--all']);
  if (!added.ok) return { ok: false, committed: false, reason: 'git add failed: ' + added.out + (restoreIndex() ?? '') };
  const secrets = stagedSecrets(path);
  if (secrets.length > 0) {
    const restore = restoreIndex();
    return { ok: false, committed: false, reason: 'possible secrets, so nothing was committed: ' + secrets.join(', ') + (restore ?? '') };
  }
  const commit = git(path, ['commit', '--quiet', '-m', 'wip: rescued uncommitted work from ' + name]);
  if (!commit.ok) return { ok: false, committed: false, reason: 'git commit failed: ' + commit.out + (restoreIndex() ?? '') };
  const push = git(path, ['push', '--quiet', '-u', remote, 'HEAD:refs/heads/' + branch]);
  if (!push.ok) return { ok: false, committed: true, reason: 'the commit stays local because the push was rejected: ' + push.out.split('\n')[0] };
  return { ok: true, committed: true, reason: null };
}

// Retention prune: propose (and only with --write, perform) removal for merged,
// closed, or retained-idle checkouts. A never-pushed or locally-ahead branch is
// kept; prune never creates a remote branch. Dirty work is rescued only when
// the remote branch already exists and the user's staged selection is empty.
// Every candidate then re-runs the same safe-to-remove test as explicit remove.
export function pruneWorktrees({ repoRoot, base, olderThan, devMd, ledgerTimes = {}, ledgerUnknown = new Set(), issueStates = {}, issueUnknown = new Set(), now = Date.now(), write = false, remote = 'origin', workerLayout = false, excludeIssues = new Set(), recordDroppedDeps = noteDroppedDeps }) {
  const blocks = [];
  const warns = [];
  const actions = [];
  const retentionMs = parseDuration(olderThan) ?? parseRetentionKnob(devMd);
  const depsRetentionMs = parseDepsRetentionKnob(devMd);
  const candidates = [];
  const freed = [];
  const droppable = [];
  const dropped = readDroppedDeps({ repoRoot, workerLayout });
  const baseReady = refreshBase({ repoRoot, base, remote, actions, warns, write });
  for (const entry of inventory(repoRoot, workerLayout)) {
    // The worker snapshots running and same-pass selected issues before asking for advice.
    // This check precedes dependency and checkout candidate publication alike.
    if (excludeIssues.has(issueOfWorktree(entry.name))) continue;
    const branch = entry.branch;
    const lastCommitAt = git(entry.path, ['log', '-1', '--format=%cI', 'HEAD']).out || null;
    const ledgerUpdatedAt = ledgerTimes[entry.name] ?? null;
    const facts = gatherRemovalFacts({ repoRoot, path: entry.path, branch, base, remote, locked: entry.locked, baseReady });
    const state = classifyWorktree({
      dirExists: true,
      branchExists: branch !== null,
      locked: entry.locked,
      issueState: issueStates[entry.name] ?? null,
      mergedIntoDefault: facts.mergedIntoDefault,
    });
    const stamps = [lastCommitAt, ledgerUpdatedAt].map((v) => (v ? Date.parse(v) : Number.NaN)).filter(Number.isFinite);
    const ageDays = stamps.length === 0 ? 0 : Math.floor((now - Math.max(...stamps)) / DAY_MS);
    const githubKnown = !ledgerUnknown.has(entry.name) && !issueUnknown.has(entry.name);
    const idle = githubKnown && isPastRetention({ lastCommitAt, ledgerUpdatedAt, now, retentionMs });
    const reasonCode = facts.mergedIntoDefault ? 'merged' : !issueUnknown.has(entry.name) && issueStates[entry.name] === 'closed' ? 'closed' : idle ? 'idle' : null;
    const depsWindowPassed = githubKnown && isPastRetention({ lastCommitAt, ledgerUpdatedAt, now, retentionMs: depsRetentionMs });
    const deps = join(entry.path, 'node_modules');
    // A whole-worktree candidate does not first delete one of its children. Dependency-only
    // reclamation is the shorter-window path for a checkout that is otherwise staying.
    if (reasonCode === null && depsWindowPassed && existsSync(deps)) {
      let keep = null;
      if (dropped.unreadable) keep = dropped.unreadable;
      const pathSafety = keep ? null : verifyOwnedPath(managedRoot(repoRoot, workerLayout), deps);
      if (!keep && !pathSafety.ok) keep = pathSafety.reason;
      if (!keep && entry.locked) keep = 'the worktree is locked';
      else if (!keep && facts.dirty) keep = 'uncommitted work here';
      else if (!keep && facts.unpushed) keep = 'commits not on the remote';
      else if (!keep && branch === null && !facts.headReachable) keep = 'the detached HEAD contains a unique commit';
      const tracked = keep ? '' : git(entry.path, ['ls-files', '--', 'node_modules']);
      if (!keep && (!tracked.ok || tracked.out)) keep = tracked.ok ? 'git tracks files under node_modules here' : 'git could not prove node_modules is untracked';
      if (keep) warns.push(at(entry.name, 'kept its dependencies: ' + keep));
      else {
        droppable.push(entry.name);
        actions.push(at(entry.name, 'drop untracked node_modules and keep the checkout'));
        if (write) {
          try {
            recordDroppedDeps({ repoRoot, workerLayout, name: entry.name, path: entry.path, deps: ['node_modules'], droppedAt: new Date(now).toISOString() });
            rmSync(deps, { recursive: true });
            freed.push(entry.name);
          } catch (error) {
            warns.push(at(entry.name, 'kept its dependencies: ' + error.message));
          }
        }
      }
    }
    if (reasonCode === null) continue;
    const verdict = evaluateRemoval({ state, ...facts, locked: entry.locked, force: reasonCode !== 'merged' });
    const checkoutSafety = verifyOwnedPath(managedRoot(repoRoot, workerLayout), entry.path);
    if (!checkoutSafety.ok) verdict.blocks.unshift(checkoutSafety.reason);
    // Reclamation never creates a remote branch. Dirty work can be rescued only when its named
    // remote branch still exists; never-pushed and delete-on-merge branches stay put.
    const rescuable = checkoutSafety.ok && facts.dirty && branch !== null && !entry.locked && facts.remoteKnown && !facts.remoteMissing;
    candidates.push({
      name: entry.name,
      path: entry.path,
      branch,
      state,
      reasonCode,
      ageDays,
      removable: verdict.blocks.length === 0,
      pushable: false,
      rescuable,
      reason: verdict.blocks[0] ?? null,
      reasons: verdict.blocks,
    });
  }
  for (const candidate of candidates) {
    if (!candidate.removable && !candidate.rescuable) continue;
    if (candidate.rescuable) {
      actions.push(at(candidate.name, 'commit uncommitted work as wip on ' + candidate.branch + ' and push it'));
      if (write) {
        const saved = rescueWork({ path: candidate.path, branch: candidate.branch, name: candidate.name, remote });
        if (!saved.ok) {
          warns.push(at(candidate.name, 'kept: could not save uncommitted work — ' + saved.reason));
          candidate.removable = false;
          candidate.reason = saved.reason;
          continue;
        }
        candidate.rescuedTo = candidate.branch;
      }
    }
    actions.push(at(candidate.name, 'remove because it is ' + candidate.reasonCode));
    if (!write) continue;
    const removed = removeWorktree({ repoRoot, name: candidate.name, base, force: true, push: false, write: true, remote, workerLayout });
    if (removed.blocks.length > 0) {
      warns.push(at(candidate.name, 'kept after all: ' + removed.blocks[0]));
      candidate.removable = false;
      candidate.reason = removed.blocks[0];
    } else {
      candidate.removable = true;
      candidate.reason = null;
    }
  }
  return { blocks, warns, actions, candidates, freed, droppable };
}

// --- list and status ------------------------------------------------------

const SIZE_BUDGET = 50_000;

// Bounded disk usage for one worktree. It never follows a symlink (a link into
// the user's home would report their whole disk) and stops at the entry budget,
// reporting approx: true rather than pretending to a number it did not finish.
export function directorySize(path, { maxEntries = SIZE_BUDGET } = {}) {
  let bytes = 0;
  let seen = 0;
  let approx = false;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen >= maxEntries) {
        approx = true;
        return { bytes, approx };
      }
      seen += 1;
      if (entry.isSymbolicLink()) continue;
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        bytes += statSync(child).size;
      } catch {
        approx = true;
      }
    }
  }
  return { bytes, approx };
}

// The inventory with each entry's lifecycle state and disk footprint attached.
// issueStates maps a worktree name to the GitHub state of its issue; without it
// (offline, or no gh) nothing is ever classified 'abandoned'.
export function listWorktrees({ repoRoot, base, issueStates = {}, remote = 'origin', withSize = true, workerLayout = false }) {
  return inventory(repoRoot, workerLayout).map((entry) => {
    const facts = gatherRemovalFacts({ repoRoot, path: entry.path, branch: entry.branch, base, remote, locked: entry.locked });
    const state = classifyWorktree({
      dirExists: true,
      branchExists: entry.branch !== null,
      locked: entry.locked,
      issueState: issueStates[entry.name] ?? null,
      mergedIntoDefault: facts.mergedIntoDefault,
    });
    const size = withSize ? directorySize(entry.path) : { bytes: 0, approx: true };
    return { name: entry.name, path: entry.path, branch: entry.branch, state, bytes: size.bytes, approx: size.approx };
  });
}

// The issue number a worktree name carries, or null for the ones that have none
// (a release branch, a direct chat fix).
export function issueOfWorktree(name) {
  const match = /^(\d+)(?:-|$)/.exec(String(name ?? ''));
  return match ? Number(match[1]) : null;
}

// Only the new numeric leaf is authoritative for issue-bound operations. A
// legacy `<number>-<slug>` leaf remains inventory/removal input, but is
// indistinguishable from a digit-led no-issue slug and is therefore never
// allowed to select GitHub state, a ledger, a hook session, or `--issue`.
export function canonicalIssueOfWorktree(name) {
  return /^[1-9]\d*$/.test(String(name ?? '')) ? Number(name) : null;
}

// The pure reconciliation behind `vegafactory worktree status`: which
// worktrees answer to an open issue, which do not, which open issues have no
// checkout, and which directories lost their branch.
export function reconcileWorktrees({ entries, openIssues }) {
  const open = new Set((openIssues ?? []).filter((issue) => issue.state === 'open').map((issue) => issue.number));
  const matched = [];
  const worktreesWithoutOpenIssue = [];
  const orphans = [];
  const claimed = new Set();
  for (const entry of entries ?? []) {
    if (entry.state === 'orphan-dir') orphans.push(entry.name);
    const issue = canonicalIssueOfWorktree(entry.name);
    if (issue !== null && open.has(issue) && entry.state !== 'orphan-dir') {
      matched.push({ name: entry.name, issue });
      claimed.add(issue);
      continue;
    }
    worktreesWithoutOpenIssue.push(entry.name);
  }
  const openIssuesWithoutWorktree = [...open].filter((number) => !claimed.has(number)).sort((a, b) => a - b);
  return { matched, worktreesWithoutOpenIssue, openIssuesWithoutWorktree, orphans };
}

// Open issues for the repo, and the last edit time of each issue's ledger
// comment (what retention measures against). gh being unreachable is a WARN,
// not a block: `list` has to work on a plane.
export function gatherGithubFacts({ repo, names = [], warns, read = ghJson }) {
  const issueStates = {};
  const unknown = new Set();
  let openIssues = [];
  try {
    const listed = read(['api', 'repos/' + repo + '/issues', '--paginate', '-X', 'GET', '-f', 'state=open']);
    if (!Array.isArray(listed) || listed.some((issue) => !issue || typeof issue !== 'object'
      || !Number.isSafeInteger(issue.number) || issue.number <= 0 || issue.state !== 'open')) {
      throw new Error('open issue facts have an invalid shape');
    }
    openIssues = listed.filter((issue) => !issue.pull_request).map((issue) => ({ number: issue.number, state: issue.state }));
  } catch (error) {
    warns.push(at('github', 'could not read open issues, reporting from git alone: ' + error.message));
    for (const name of names) unknown.add(name);
    return { openIssues, issueStates, unknown };
  }
  const open = new Set(openIssues.map((issue) => issue.number));
  for (const name of names) {
    const issue = canonicalIssueOfWorktree(name);
    if (issue === null) {
      if (issueOfWorktree(name) !== null) unknown.add(name);
      continue;
    }
    if (open.has(issue)) {
      issueStates[name] = 'open';
      continue;
    }
    try {
      const detail = read(['api', 'repos/' + repo + '/issues/' + issue]);
      if (!detail || typeof detail !== 'object' || detail.number !== issue || !['open', 'closed'].includes(detail.state)) {
        throw new Error('issue state has an invalid shape');
      }
      issueStates[name] = detail.state;
    } catch (error) {
      warns.push(at('github', 'could not read the state of #' + issue + ': ' + error.message));
      unknown.add(name);
    }
  }
  return { openIssues, issueStates, unknown };
}

// Ledger edit times for the named issues, one call each. Failures warn.
export function gatherLedgerTimes({ repo, names, warns, read = ghJson }) {
  const times = {};
  const unknown = new Set();
  for (const name of names) {
    const issue = canonicalIssueOfWorktree(name);
    if (issue === null) {
      if (issueOfWorktree(name) !== null) unknown.add(name);
      continue;
    }
    try {
      const comments = read(['api', 'repos/' + repo + '/issues/' + issue + '/comments', '--paginate']);
      if (!Array.isArray(comments) || comments.some((comment) => !comment || typeof comment !== 'object'
        || typeof comment.body !== 'string' || typeof comment.updated_at !== 'string'
        || !Number.isFinite(Date.parse(comment.updated_at)))) throw new Error('ledger comments have an invalid shape');
      const ledger = findMarkerComment(comments, 'ledger');
      if (ledger) times[name] = ledger.comment.updated_at;
    } catch (error) {
      warns.push(at('github', 'could not read the ledger of #' + issue + ': ' + error.message));
      unknown.add(name);
    }
  }
  return { times, unknown };
}

// --- dev.md defaults ------------------------------------------------------

// dev.md's `repo:` line carries the default branch after a middot. Absent or
// unparseable falls back to `main` rather than guessing from the checkout,
// which in a worktree is never the default branch by construction.
export function parseDefaultBranch(devMd) {
  const line = knobLine(devMd, 'repo');
  const match = line ? /default branch\s+(\S+)/.exec(line) : null;
  return match ? match[1] : 'main';
}

// --- CLI ------------------------------------------------------------------

function renderWorktree(result, { json }) {
  const { exitCode, text } = renderResult('worktree', result, { json });
  if (!json) {
    const lines = [text];
    for (const action of result.actions ?? []) lines.push('  action: ' + action);
    for (const candidate of result.candidates ?? []) {
      lines.push('  candidate: ' + candidate.name + ' (' + candidate.state + ', ' + candidate.ageDays + 'd) — '
        + (candidate.removable ? 'removable' : 'kept: ' + candidate.reason));
    }
    for (const entry of result.entries ?? []) {
      lines.push('  worktree: ' + entry.name + ' [' + entry.state + '] ' + (entry.branch ?? 'detached'));
    }
    return { exitCode, text: lines.join('\n') };
  }
  const payload = JSON.parse(text);
  for (const key of ['actions', 'path', 'branch', 'entries', 'candidates', 'reconciled']) {
    if (result[key] !== undefined) payload[key] = result[key];
  }
  return { exitCode, text: JSON.stringify(payload, null, 2) };
}

function runVerb(verb, flags) {
  const repoRoot = flags['repo-root'] || mainCheckout(process.cwd());
  const devMdPath = flags['dev-md'] || join(repoRoot, '.vegastack', 'dev.md');
  const devMd = existsSync(devMdPath) ? readFileSync(devMdPath, 'utf8') : '';
  const base = flags.base || parseDefaultBranch(devMd);
  const home = flags.home || homedir();
  let issue = null;
  if (flags.issue !== undefined) {
    issue = Number(flags.issue);
    if (!Number.isInteger(issue) || issue <= 0) return { blocks: [at('--issue', 'expected a positive issue number, got ' + flags.issue)], warns: [] };
  }
  const slug = flags.slug ? slugify(flags.slug) : null;
  const workerLayout = Boolean(flags['worker-layout']);
  const shared = { repoRoot, devMd, home, base, write: Boolean(flags.write), workerLayout };

  const repoOf = () => flags.repo || knobLine(devMd, 'repo')?.split('·')[0].trim() || null;

  if (verb === 'list' || verb === 'status') {
    const warns = [];
    const repo = repoOf();
    const names = inventory(repoRoot, workerLayout).map((entry) => entry.name);
    const github = repo ? gatherGithubFacts({ repo, names, warns }) : { openIssues: [], issueStates: {}, unknown: new Set(names) };
    const entries = listWorktrees({ repoRoot, base, issueStates: github.issueStates, workerLayout });
    if (verb === 'list') return { blocks: [], warns, entries };
    return { blocks: [], warns, entries, reconciled: reconcileWorktrees({ entries, openIssues: github.openIssues }) };
  }
  if (verb === 'remove') {
    // --name is exact; --issue resolves it from the inventory, which is what a
    // caller that only knows the issue number (the CLI, dev-ship) has.
    let name = flags.name;
    if (!name && issue !== null) {
      const matches = inventory(repoRoot, workerLayout).filter((entry) => canonicalIssueOfWorktree(entry.name) === issue);
      if (matches.length === 0) return { blocks: [at('#' + issue, 'no worktree for that issue')], warns: [] };
      if (matches.length > 1) {
        return { blocks: [at('#' + issue, 'several worktrees match (' + matches.map((m) => m.name).join(', ') + ') — pass --name')], warns: [] };
      }
      name = matches[0].name;
    }
    if (!name) return { blocks: ['--name <issue-or-slug> or --issue <n> is required for remove'], warns: [] };
    return removeWorktree({ repoRoot, name, base, force: Boolean(flags.force), push: Boolean(flags.push), write: shared.write, workerLayout });
  }
  if (verb === 'prune') {
    const warns = [];
    const excludedText = flags['exclude-issues'];
    const excluded = excludedText === undefined ? [] : String(excludedText).split(',').map(Number);
    if (excluded.some((number) => !Number.isSafeInteger(number) || number <= 0)) {
      return { blocks: ['--exclude-issues requires a comma-separated list of positive issue numbers'], warns };
    }
    // This is an internal preview selector, never a way to authorize deletion.
    if (excludedText !== undefined && shared.write) return { blocks: ['--exclude-issues is preview-only'], warns };
    const repo = flags.repo || knobLine(devMd, 'repo')?.split('·')[0].trim() || null;
    const names = inventory(repoRoot, workerLayout).map((entry) => entry.name);
    const github = repo ? gatherGithubFacts({ repo, names, warns }) : { openIssues: [], issueStates: {}, unknown: new Set(names) };
    const ledger = repo ? gatherLedgerTimes({ repo, names, warns }) : { times: {}, unknown: new Set(names) };
    const pruned = pruneWorktrees({
      repoRoot, base, olderThan: flags['older-than'], devMd,
      ledgerTimes: ledger.times, ledgerUnknown: ledger.unknown,
      issueStates: github.issueStates, issueUnknown: github.unknown,
      now: Date.now(), write: shared.write, workerLayout, excludeIssues: new Set(excluded),
    });
    return { ...pruned, warns: [...warns, ...pruned.warns] };
  }
  if (verb === 'create' || verb === 'restore') {
    let named = { type: flags.type || null, slug };
    // Type and slug are resolved independently: --slug says what to call it and
    // never says which type it is. restore reads the type off the branch that
    // already carries the number — the branch is the fact it acts on — and
    // create reads the issue title. Either may still come up empty, and then
    // createWorktree refuses and names the types rather than guessing `feat`.
    if (verb === 'restore' && (issue !== null || slug)) {
      if (!named.type || !slug) {
        const parts = branchPartsForIssue(repoRoot, issue, slug);
        if (parts.error) return { blocks: [at(issue === null ? slug : '#' + issue, parts.error)], warns: [] };
        named = { type: named.type || parts.type, slug: slug || parts.slug };
      }
    } else if (issue !== null && (!slug || !named.type)) {
      // What the title is still needed for: the slug, the type, or both.
      const wanted = slug ? '--type' : named.type ? '--slug' : '--slug and --type';
      const repo = repoOf();
      if (!repo) return { blocks: [at('#' + issue, 'no repo known to read the title from — pass --repo, or ' + wanted)], warns: [] };
      let title;
      try {
        title = ghJson(['api', 'repos/' + repo + '/issues/' + issue]).title;
      } catch (error) {
        return { blocks: [at('#' + issue, 'could not read the issue title (' + error.message + ') — pass ' + wanted)], warns: [] };
      }
      const parts = titleParts(title, parseBranchTypes(devMd));
      if (!slug && !parts.slug) return { blocks: [at('#' + issue, 'the title makes no slug — pass --slug')], warns: [] };
      named = { type: named.type || parts.type, slug: slug || parts.slug, title };
    }
    if (!named.slug) return { blocks: ['--slug is required for ' + verb + ' without --issue'], warns: [] };
    const options = { ...shared, issue, slug: named.slug, type: named.type, title: named.title };
    return verb === 'create' ? createWorktree(options) : restoreWorktree(options);
  }
  return { blocks: [at(verb, 'unknown verb — expected create|restore|remove|list|prune|status')], warns: [] };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const verb = argv.find((arg) => !arg.startsWith('--')) ?? '';
  const flags = parseFlags(argv, ['json', 'write', 'dry-run', 'force', 'push', 'all', 'worker-layout']);
  if (flags['dry-run']) flags.write = false;
  let outcome;
  try {
    outcome = runVerb(verb, flags);
  } catch (error) {
    outcome = { blocks: [at('worktree', error.message)], warns: [] };
  }
  const { exitCode, text } = renderWorktree(outcome, { json: Boolean(flags.json) });
  console.log(text);
  process.exit(exitCode);
}
