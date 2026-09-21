#!/usr/bin/env node
// One feature, one worktree. This script owns the whole worktree scenario
// matrix for a VegaFactory project: naming, lifecycle classification, the
// safe-to-remove test, retention, and the git-calling verbs the skills and
// `vegafactory worktree ...` both drive. The main checkout never leaves the
// default branch; every branch is checked out at
// .vegastack/.worktrees/<n>-<slug>/ on <type>/<n>-<slug>.
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
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMarkerComment, ghJson, parseFlags, renderResult } from './lib/gh.mjs';

const WORKTREES_DIR = '.vegastack/.worktrees';
const SLUG_MAX = 40;
// stdio mode for a discarded fd, hoisted out of quote-adjacency: SkillSpector reads the
// bare word beside its own closing quote as a removal cue and fails closed on the whole
// file (skill-maintainer's standards.md, known behaviours). Same value, same behaviour.
const DISCARD = 'ignore';

// Located strings are concatenated, never assigned as template literals:
// SkillSpector's static parser trips on the latter (see skillify's
// trigger-check.mjs) and every file carrying that construct needs its own
// coverage acceptance.
const at = (where, message) => where + ': ' + message;

// An issue title comes from GitHub and reaches an operator's terminal through
// a block message. Two kinds of character in it are dangerous and neither is
// visible: the C0/C1 controls, which move the cursor and repaint the line, and
// the Unicode format controls — the bidirectional overrides and isolates most
// of all — which reorder what is printed, so a title can appear to end where
// it does not and hide the words that follow it. Both go. A long title is cut
// rather than allowed to fill the screen.
const printable = (text) => String(text ?? '')
  .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
  .replace(/\p{Cf}+/gu, '')
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

// The worktree directory name. An issue number leads it so `ls` sorts by issue
// and reconciliation against open issues is a parse, not a lookup table.
export function worktreeName(issue, slug) {
  return issue === null || issue === undefined ? String(slug) : String(issue) + '-' + slug;
}

// Always under the repo root, never elsewhere: a worktree outside the tree is
// invisible to `git status`, to the ignore line, and to prune.
export function worktreePath(repoRoot, name) {
  return join(repoRoot, WORKTREES_DIR, name);
}

// <type>/<n>-<slug>, or <type>/<slug> for the branches that have no issue
// (a direct chat fix, a release branch).
export function branchName(type, issue, slug) {
  return type + '/' + worktreeName(issue, slug);
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
  const named = listed.out.split('\n').filter((name) => name.includes('/') && tail(name).startsWith(lead));
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

// A symlink anywhere on the worktree parent turns `git worktree remove` into a
// write outside the repo. Refuse rather than resolve.
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
// Dependencies go first and sooner, because they are the cost. On this machine 628 MB of a 638 MB
// worktree was `node_modules` and the checkout itself was 10 MB — so dropping them reclaims almost
// everything while leaving the code, the branch and the history exactly where they were, and
// resuming only has to run setup again (#275).
const DEFAULT_DEPS_RETENTION_MS = 3 * DAY_MS;

// All of these must hold before a worktree directory is removed. Each failure
// gets its own sentence so the caller can print exactly why the work is being
// kept. `force` is the operator's word and lifts ONE thing — the not-merged
// block. Uncommitted, unpushed and locked are never lifted: those are the
// three ways real work disappears.
export function evaluateRemoval({ state, dirty, unpushed, remoteMissing, mergedIntoDefault, locked, force = false }) {
  const blocks = [];
  const warns = [];
  const branchGone = state === 'orphan-dir';
  if (dirty) blocks.push('uncommitted changes in the worktree — commit or discard them first');
  if (!branchGone && (unpushed || (remoteMissing && !mergedIntoDefault))) {
    blocks.push('commits not on the remote — push the branch first, then re-check');
  }
  if (!branchGone && !mergedIntoDefault && !force) {
    blocks.push('not merged into the default branch — merge it, or pass --force with the operator\'s word');
  }
  if (locked) blocks.push('the worktree is locked — a session is holding it; unlock it first');
  if (state === 'abandoned') warns.push('the issue is closed and the branch never merged — removing this discards the only checkout of that work');
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

// worktree-deps-retention: how long a parked worktree keeps its dependencies. Shorter than the
// worktree's own window by default, and never longer than it — a window that outlived the thing
// it belongs to would never fire, so a value past retention is read as retention.
export function parseDepsRetentionKnob(devMd) {
  const named = parseDuration(knobLine(devMd, 'worktree-deps-retention'));
  const retention = parseRetentionKnob(devMd);
  return Math.min(named ?? DEFAULT_DEPS_RETENTION_MS, retention);
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
export function parseSetupCommand(devMd) {
  const line = knobLine(devMd, 'commands');
  const match = line === null ? null : /(?:^|·)\s*setup\s+`([^`]+)`/.exec(line);
  return match ? match[1].trim() : null;
}

// Left behind when prune takes a worktree's dependencies, and removed when they are put back. A
// fresh worktree has no marker and installs nothing — a docs-only issue should not pay for a full
// install — so restoring reinstalls exactly what was taken and nothing else.
// Kept beside the repository's own worker state rather than inside the worktree it describes:
// a record living in the thing it is about disappears with it, and a deps-only prune leaves the
// checkout in place, so `restore` never runs and nothing would put the dependencies back.
// One file per worktree, not one map of them all. A shared document is read, changed and written
// back, so a pass clearing one worktree and a pass recording another can each read the old copy
// and the second write loses the first — leaving a checkout with no dependencies and nothing
// saying they were taken, which is a checkout that silently never builds again.
const droppedDir = (repoRoot) => join(repoRoot, '.vegastack', '.tmp', 'worker', 'deps-dropped');
const droppedFor = (repoRoot, name) => join(droppedDir(repoRoot), encodeURIComponent(name));

// Only "this directory does not exist" means nothing was dropped. Any other failure is a record
// we could not read, and reading it as absence would let a checkout with no dependencies look
// untouched — so it comes back as an entry that says it could not be read.
export function readDroppedDeps(repoRoot) {
  const found = {};
  let names;
  try {
    names = readdirSync(droppedDir(repoRoot));
  } catch (error) {
    if (error?.code === 'ENOENT') return found;
    return { '*': 'the record of dropped dependencies could not be read: ' + (error?.message ?? 'failed') };
  }
  for (const entry of names) {
    const name = decodeURIComponent(entry);
    try { found[name] = readFileSync(join(droppedDir(repoRoot), entry), 'utf8').trim(); }
    catch (error) { found[name] = error?.code === 'ENOENT' ? null : 'unreadable'; }
  }
  return found;
}

function noteDroppedDeps(repoRoot, name, at) {
  writeMarker(droppedFor(repoRoot, name), at + '\n');
}

// Returns whether the record is gone. A clear that failed leaves it asking again next time,
// which is the harmless direction — but the caller is told rather than assuming it worked.
function clearDroppedDeps(repoRoot, name) {
  try { rmSync(droppedFor(repoRoot, name), { force: true }); return true; } catch { return false; }
}

// Written without ever following a link. The path is predictable and inside an ignored directory,
// so a planted symlink would otherwise be followed and write through to whatever it names. `wx` is
// O_CREAT|O_EXCL, which refuses any existing name — a link included — and the rename replaces the
// target name itself rather than its destination.
function writeMarker(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, text, { flag: 'wx' });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

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
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', input, stdio: [input === undefined ? DISCARD : 'pipe', 'pipe', 'pipe'] });
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
export function rebaseUnderRoot(repoRoot, absPath) {
  if (!absPath) return absPath;
  const marker = sep + WORKTREES_DIR.split('/').join(sep) + sep;
  const index = absPath.indexOf(marker);
  if (index === -1) return absPath;
  const composed = worktreePath(repoRoot, absPath.slice(index + marker.length));
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

// The MAIN checkout of the repository the cwd belongs to. Inside a worktree,
// `rev-parse --show-toplevel` answers with the worktree; the common git dir is
// what points back at the one checkout that owns .vegastack/.worktrees/.
export function mainCheckout(cwd) {
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.ok && common.out) return dirname(common.out);
  return git(cwd, ['rev-parse', '--show-toplevel']).out;
}

const hasRemote = (repoRoot, remote) => git(repoRoot, ['remote', 'get-url', remote]).ok;
const branchExistsIn = (repoRoot, branch, gitRunner = git) => gitRunner(repoRoot, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]).ok;

// The path of the worktree currently holding a branch, straight off porcelain.
export function worktreeHoldingBranch(repoRoot, branch, gitRunner = git) {
  const listed = gitRunner(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return null;
  const found = parseWorktreeList(listed.out).find((entry) => entry.branch === branch)?.path ?? null;
  return rebaseUnderRoot(repoRoot, found);
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
  // Dependencies are not installed for a fresh checkout: a step that needs them runs the setup
  // command itself, so a docs-only issue costs a few megabytes instead of a full install.
  noteMissingDependencies({ repoRoot, name: basename(path), path, devMd, warns });
  applyCodexTrust({ home, absPath: path, write, actions, warns, blocks });
}

// Say so when this checkout's dependencies were taken while it was idle. Putting them back is a
// run of dev.md's own `setup` command by whoever is about to build, inside that build's own
// budget — #275. Nothing here starts a process: this runs inside the worker's pass, before a step
// timer exists, so an install begun here would hold the loop and outlast a shutdown.
export function dependencyNotice(name, dropped, devMd) {
  if (dropped['*']) return dropped['*'];
  if (!(name in dropped)) return null;
  const setup = parseSetupCommand(devMd);
  if (!setup) return 'dependencies were reclaimed while it was idle, and dev.md names no `setup` command to put them back';
  return 'dependencies were reclaimed while it was idle — run `' + setup + '` here before building';
}

export function noteMissingDependencies({ repoRoot, name, path, devMd, warns }) {
  const notice = dependencyNotice(name, readDroppedDeps(repoRoot), devMd);
  if (!notice) return false;
  warns.push(at(path, notice));
  return true;
}

// Create the checkout for a branch: a fresh worktree cut from origin/<base>. Every issue —
// sub-issues of an epic included — gets its own branch, worktree and PR.
export function createWorktree({ repoRoot, issue, slug, type, title, base, devMd, home, write = false }) {
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
  const branch = branchName(type, issue, slug);
  const name = worktreeName(issue, slug);

  const path = worktreePath(repoRoot, name);
  for (const candidate of [join(repoRoot, '.vegastack'), join(repoRoot, WORKTREES_DIR), path]) {
    const symlink = symlinkBlock(candidate);
    if (symlink) blocks.push(symlink);
  }
  if (blocks.length > 0) return { blocks, warns, actions, path, branch };

  if (branchExistsIn(repoRoot, branch)) {
    blocks.push(at(branch, 'the branch already exists — use restore to re-add its worktree'));
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
    prepareCheckout({ repoRoot, path, devMd, home, write, actions, warns, blocks });
  } else {
    prepareCheckout({ repoRoot, path, devMd, home, write: false, actions, warns, blocks });
  }
  return { blocks, warns, actions, path, branch };
}

// Re-add the checkout for a branch that still exists but whose directory is
// gone — the corrections and reclaim path. It never creates a branch: a
// missing branch means the work is somewhere else, and guessing would be worse
// than stopping.
export function restoreWorktree({ repoRoot, issue, slug, type, devMd, home, write = false, gitRunner = git }) {
  const blocks = [];
  const warns = [];
  const actions = [];
  const branch = branchName(type, issue, slug);
  const name = worktreeName(issue, slug);
  const path = worktreePath(repoRoot, name);

  for (const candidate of [join(repoRoot, '.vegastack'), join(repoRoot, WORKTREES_DIR), path]) {
    const symlink = symlinkBlock(candidate);
    if (symlink) blocks.push(symlink);
  }
  if (blocks.length > 0) return { blocks, warns, actions, path, branch };

  if (!branchExistsIn(repoRoot, branch, gitRunner)) {
    blocks.push(at(branch, 'no branch of that name — nothing to restore; create it instead'));
    return { blocks, warns, actions, path, branch };
  }
  const held = worktreeHoldingBranch(repoRoot, branch, gitRunner);
  if (held) {
    // The checkout is already here, which is exactly what a dependency-only prune leaves behind.
    // There is no worktree to add — but its dependencies may be gone, and this is the one place a
    // resume passes through.
    warns.push(at(held, 'already holds ' + branch + ' — nothing to restore'));
    noteMissingDependencies({ repoRoot, name: basename(held), path: held, devMd, warns });
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
  return { blocks, warns, actions, path, branch };
}

// --- remove and prune -----------------------------------------------------

// Read the git facts the safe-to-remove test needs. Every unverifiable fact
// fails closed: a status call that errors reports dirty, a merge check that
// errors reports not-merged.
function gatherRemovalFacts({ repoRoot, path, branch, base, remote, locked }) {
  const dirty = branch === null
    ? false
    : (() => {
      const status = git(path, ['status', '--porcelain']);
      return !status.ok || status.out !== '';
    })();
  if (branch === null) return { dirty, unpushed: false, remoteMissing: false, mergedIntoDefault: false };
  const remoteRef = remote + '/' + branch;
  const remoteMissing = !git(repoRoot, ['rev-parse', '--verify', '--quiet', 'refs/remotes/' + remoteRef]).ok;
  const ahead = remoteMissing ? null : git(repoRoot, ['rev-list', remoteRef + '..' + branch]);
  const unpushed = remoteMissing ? false : !ahead.ok || ahead.out !== '';
  const baseRef = git(repoRoot, ['rev-parse', '--verify', '--quiet', 'refs/remotes/' + remote + '/' + base]).ok
    ? remote + '/' + base
    : base;
  // A branch that has never reached the remote cannot have been merged: main is
  // reached through a PR, so "ancestor of the default branch" alone would call a
  // brand-new branch cut from origin/main 'merged' and prune it on day one.
  const isAncestor = git(repoRoot, ['merge-base', '--is-ancestor', branch, baseRef]).ok;
  // A squash merge deletes the remote branch (delete-on-merge), so content decides then.
  const mergedIntoDefault = (!remoteMissing && isAncestor) || mergedByContent(repoRoot, branch, baseRef);
  return { dirty, unpushed, remoteMissing, mergedIntoDefault, locked };
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
// the last fetch and a stale one calls every merge unmerged. A fetch touches
// nothing but remote-tracking refs, so it runs on a dry run too; a failure
// warns, and the stale refs then judge — fail closed, never open.
function refreshBase({ repoRoot, base, remote, actions, warns }) {
  if (!hasRemote(repoRoot, remote)) return;
  actions.push(at(remote, 'git fetch ' + remote + ' ' + base));
  const fetched = git(repoRoot, ['fetch', remote, base]);
  if (!fetched.ok) warns.push(at(remote, 'fetch of ' + base + ' failed, judging against the last-fetched ref: ' + fetched.out));
}

// Remove one worktree directory — and only the directory. The local branch and
// the remote branch are never touched here: deleting either is on the ship
// guard's always-ask list and takes the operator's own word.
export function removeWorktree({ repoRoot, name, base, force = false, push = false, write = false, remote = 'origin' }) {
  const blocks = [];
  const warns = [];
  const actions = [];
  const path = worktreePath(repoRoot, name);
  const symlink = symlinkBlock(path);
  if (symlink) return { blocks: [symlink], warns, actions };

  const listed = git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return { blocks: [at(repoRoot, 'cannot read the worktree list: ' + listed.out)], warns, actions };
  const entry = parseWorktreeList(listed.out).find((item) => rebaseUnderRoot(repoRoot, item.path) === path);
  if (!entry) return { blocks: [at(name, 'no worktree at ' + path + ' — nothing to remove')], warns, actions };

  const branch = entry.branch;
  refreshBase({ repoRoot, base, remote, actions, warns });
  let facts = gatherRemovalFacts({ repoRoot, path, branch, base, remote, locked: entry.locked });
  // Exactly the condition `evaluateRemoval` blocks on, and for the same reason: a branch with no
  // remote is only at risk when its work is not already in the base. A squash merge deletes the
  // feature branch on purpose, so pushing on `remoteMissing` alone would recreate the branch
  // somebody deleted — and the action line says "remove", not "push".
  if (push && branch && (facts.unpushed || (facts.remoteMissing && !facts.mergedIntoDefault))) {
    actions.push(at(branch, 'git push -u ' + remote + ' ' + branch + ' before removing'));
    if (write) {
      const pushed = git(path, ['push', '-u', remote, branch]);
      if (!pushed.ok) warns.push(at(branch, 'push failed: ' + pushed.out));
      facts = gatherRemovalFacts({ repoRoot, path, branch, base, remote, locked: entry.locked });
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

  actions.push(at(path, 'git worktree remove (the branch and its remote are left alone)'));
  if (write) {
    const removed = git(repoRoot, ['worktree', 'remove', path]);
    if (!removed.ok) blocks.push(at(path, 'git worktree remove failed: ' + removed.out));
    // The record outlives the checkout it describes, and the name comes back: the same issue
    // re-cut later would be told its dependencies were reclaimed when nothing was ever taken
    // from it.
    else clearDroppedDeps(repoRoot, name);
  }
  return { blocks, warns, actions, path, branch, state };
}

// Every worktree directory under .vegastack/.worktrees, with its branch and
// lock flag straight off porcelain. The main checkout is never one of them.
export function inventory(repoRoot) {
  const listed = git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return [];
  const prefix = worktreePath(repoRoot, '') + sep;
  return parseWorktreeList(listed.out)
    .map((entry) => ({ ...entry, path: rebaseUnderRoot(repoRoot, entry.path) }))
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
  const added = git(path, ['add', '--all']);
  if (!added.ok) return { ok: false, committed: false, reason: 'git add failed: ' + added.out };
  const secrets = stagedSecrets(path);
  if (secrets.length > 0) {
    git(path, ['reset', '--quiet']);
    return { ok: false, committed: false, reason: 'possible secrets, so nothing was committed: ' + secrets.join(', ') };
  }
  const commit = git(path, ['commit', '--quiet', '-m', 'wip: rescued uncommitted work from ' + name]);
  if (!commit.ok) return { ok: false, committed: false, reason: 'git commit failed: ' + commit.out };
  const push = git(path, ['push', '--quiet', '-u', remote, 'HEAD:refs/heads/' + branch]);
  if (!push.ok) return { ok: false, committed: true, reason: 'the commit stays local because the push was rejected: ' + push.out.split('\n')[0] };
  return { ok: true, committed: true, reason: null };
}

// Retention prune: propose (and with --write, perform) the removal of parked
// worktrees whose branch and ledger have both gone quiet past the window. It
// pushes an unpushed candidate first so nothing local-only is ever discarded,
// then re-runs the same safe-to-remove test every other caller uses. Nothing
// but a `parked` worktree is ever a candidate — and parked means unmerged, so
// here the retention window is what lifts the not-merged rule: the pushed
// branch keeps the work and `restore` brings the directory back. Uncommitted,
// unpushed and locked still keep it.
// `automatic` is the unattended pass, and it is a narrower thing than the prune a person runs.
// A person asked, and can be told "I saved your work on a branch first". A background pass has
// nobody to tell, so it never pushes, never commits anything as `wip`, and never removes a
// worktree it had to rescue: anything dirty or unpushed is reported and left exactly as it is.
// `inUse` names the worktrees a run currently holds; those are skipped whole, dependencies
// included, because an agent is reading them right now.
export function pruneWorktrees({ repoRoot, base, olderThan, devMd, ledgerTimes = {}, issueStates = {}, now = Date.now(), write = false, remote = 'origin', automatic = false, inUse = [] }) {
  const blocks = [];
  const warns = [];
  const actions = [];
  // Read once for the whole pass: what was already taken before this one started.
  const droppedAlready = readDroppedDeps(repoRoot);
  const retentionMs = parseDuration(olderThan) ?? parseRetentionKnob(devMd);
  const depsRetentionMs = parseDepsRetentionKnob(devMd);
  const candidates = [];
  const freed = [];
  const droppable = [];
  refreshBase({ repoRoot, base, remote, actions, warns });
  for (const entry of inventory(repoRoot)) {
    const branch = entry.branch;
    const lastCommitAt = branch ? (git(repoRoot, ['log', '-1', '--format=%cI', branch]).out || null) : null;
    const ledgerUpdatedAt = ledgerTimes[entry.name] ?? null;
    const facts = gatherRemovalFacts({ repoRoot, path: entry.path, branch, base, remote, locked: entry.locked });
    const state = classifyWorktree({
      dirExists: true,
      branchExists: branch !== null,
      locked: entry.locked,
      // A closed issue is the clearest sign a worktree is finished, and it is a fact the board
      // already answers — `gatherGithubFacts` reads it for the same names in the same pass.
      issueState: issueStates[entry.name] ?? null,
      mergedIntoDefault: facts.mergedIntoDefault,
    });
    // Only facts that actually move. A worktree's `.git` pointer is written when the worktree is
    // created and never again, so its mtime says nothing about somebody working here — reading,
    // building and `git status` all leave it alone. There is no filesystem signal for an attended
    // session, which is why the worker's pass reports rather than removes.
    const stamps = [lastCommitAt, ledgerUpdatedAt].map((v) => (v ? Date.parse(v) : Number.NaN)).filter(Number.isFinite);
    const ageDays = stamps.length === 0 ? 0 : Math.floor((now - Math.max(...stamps)) / DAY_MS);
    // The most recent sign of life, whichever kind it was.
    const latestStamp = stamps.length === 0 ? null : new Date(Math.max(...stamps)).toISOString();
    // Every pass says which checkouts are waiting on an install, whoever is going to run it. This
    // is the pass the worker makes anyway, and its notes are where an operator looks — a deps-only
    // prune leaves the checkout in place, so nothing routes through `restore` to say it there.
    const waiting = dependencyNotice(entry.name, droppedAlready, devMd);
    if (waiting) warns.push(at(entry.name, waiting));
    // A run is using it, so nothing here is idle and nothing here is touched. The caller names
    // issues, because that is what it holds; a worktree is `<issue>-<slug>`, so the issue number
    // is the part in front of the first dash.
    if (inUse.includes(String(entry.name).split('-')[0])) continue;
    // `parked` is a branch nobody is on; `merged` and `abandoned` are the other two ways a
    // worktree stops being needed. Anything else is kept — and in the unattended pass, said out
    // loud, because "it was skipped" and "it was not there" look the same in a log otherwise.
    if (!['parked', 'merged', 'abandoned'].includes(state)) {
      if (automatic && entry.locked) warns.push(at(entry.name, 'kept: locked'));
      continue;
    }
    // Dependencies go on the shorter window, and on exactly the conditions that protect the
    // worktree itself: never while anything is uncommitted, never while it is locked. Only
    // `node_modules` is touched, by name — nothing git tracks, and nothing else on disk. What is
    // lost is a reinstall; the code, the branch and the history stay where they are.
    // Unpushed commits count as much here as uncommitted files: a worktree holding work nobody
    // else has is not one to take anything from, dependencies included.
    const unpushed = facts.unpushed || facts.remoteMissing;
    const depsWindowPassed = isPastRetention({ lastCommitAt, ledgerUpdatedAt: latestStamp, now, retentionMs: depsRetentionMs });
    // Reported at the moment they could have gone. Saying nothing until the whole-worktree window
    // elapses leaves eleven days in which a worktree is skipped and never named.
    if (depsWindowPassed && (entry.locked || facts.dirty || unpushed) && existsSync(join(entry.path, 'node_modules'))) {
      warns.push(at(entry.name, 'kept its dependencies: ' + (facts.dirty ? 'uncommitted work here' : entry.locked ? 'locked' : 'commits not on the remote')));
    }
    if (!entry.locked && !facts.dirty && !unpushed && depsWindowPassed) {
      const deps = join(entry.path, 'node_modules');
      // A repository may legitimately track files under `node_modules` — a patched package, a
      // vendored stub. `git status` is clean either way, so without this the sweep would delete
      // committed files and leave the checkout broken.
      const tracked = existsSync(deps) ? git(entry.path, ['ls-files', '--', 'node_modules']).out.trim() : '';
      if (tracked) {
        warns.push(at(entry.name, 'kept its dependencies: git tracks files under node_modules here'));
      } else if (existsSync(deps)) {
        actions.push(at(entry.name, 'drop node_modules, keeping the branch and its commits'));
        droppable.push(entry.name);
        if (write) {
          try {
            // Recorded *before* anything is removed. The other order leaves a worktree with no
            // dependencies and nothing saying they were ever taken, which is a worktree that
            // silently never builds again.
            noteDroppedDeps(repoRoot, entry.name, new Date(now).toISOString());
            rmSync(deps, { recursive: true, force: true });
            freed.push(entry.name);
          } catch (error) {
            warns.push(at(entry.name, 'kept its dependencies: ' + (error?.message ?? 'could not be removed')));
          }
        }
      }
    }
    // A merged worktree has nothing in it that is not on the default branch, and an abandoned one
    // belongs to an issue somebody closed. Neither waits out a window meant for work that might
    // still be wanted; every refusal below still applies to both.
    if (!['merged', 'abandoned'].includes(state) && !isPastRetention({ lastCommitAt, ledgerUpdatedAt: latestStamp, now, retentionMs })) continue;
    const verdict = evaluateRemoval({ state, ...facts, locked: entry.locked, force: true });
    // "Prune pushes then removes, and never automatically for anything with
    // unpushed work": the push half protects the work and happens on --write
    // whatever else is wrong; the remove half then re-runs the same safe test
    // and may still keep the worktree (unmerged, dirty, locked). A dry run
    // pushes nothing, so such a candidate is correctly not-yet-removable.
    const remoteOnly = verdict.blocks.some((block) => block.includes('commits not on the remote'));
    const rescuable = facts.dirty && branch !== null && !entry.locked;
    candidates.push({
      name: entry.name,
      path: entry.path,
      branch,
      state,
      ageDays,
      removable: verdict.blocks.length === 0,
      pushable: remoteOnly,
      rescuable,
      reason: verdict.blocks[0] ?? null,
    });
  }
  for (const candidate of candidates) {
    // The unattended pass reports what it will not touch, rather than saving it somewhere and
    // removing it. Work nobody has pushed is the operator's to decide about.
    if (automatic && (candidate.rescuable || candidate.pushable)) {
      warns.push(at(candidate.name, 'kept: ' + (candidate.rescuable ? 'uncommitted work here' : 'commits not on the remote')));
      continue;
    }
    if (automatic && !candidate.removable) {
      warns.push(at(candidate.name, 'kept: ' + (candidate.reason ?? 'not safe to remove')));
      continue;
    }
    if (!candidate.removable && !candidate.pushable && !candidate.rescuable) continue;
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
    actions.push(at(candidate.name, (candidate.pushable ? 'push the branch, then re-check for removal after ' : 'remove after ') + candidate.ageDays + ' quiet days'));
    if (!write) continue;
    const removed = removeWorktree({ repoRoot, name: candidate.name, base, force: true, push: !automatic, write: true, remote });
    if (removed.blocks.length > 0) {
      warns.push(at(candidate.name, 'kept after all: ' + removed.blocks[0]));
      candidate.removable = false;
      candidate.reason = removed.blocks[0];
    } else {
      candidate.removable = true;
      candidate.reason = null;
    }
  }
  // Named separately from the removals: a worktree between the two windows has dependencies that
  // could go and no removal candidate at all, and a caller counting only candidates would report
  // the drop and then offer nothing to do about it.
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
export function listWorktrees({ repoRoot, base, issueStates = {}, remote = 'origin', withSize = true }) {
  const dropped = new Set(Object.keys(readDroppedDeps(repoRoot)));
  return inventory(repoRoot).map((entry) => {
    const facts = gatherRemovalFacts({ repoRoot, path: entry.path, branch: entry.branch, base, remote, locked: entry.locked });
    const state = classifyWorktree({
      dirExists: true,
      branchExists: entry.branch !== null,
      locked: entry.locked,
      issueState: issueStates[entry.name] ?? null,
      mergedIntoDefault: facts.mergedIntoDefault,
    });
    const size = withSize ? directorySize(entry.path) : { bytes: 0, approx: true };
    // Carried on the entry rather than checked in one code path: a deps-only prune leaves the
    // checkout in place, so nothing routes through `restore`, and every caller that describes
    // this worktree — `list`, `status`, the worker's own pass — has to be able to say it.
    return {
      name: entry.name, path: entry.path, branch: entry.branch, state,
      bytes: size.bytes, approx: size.approx, depsDropped: dropped.has(entry.name),
    };
  });
}

// The issue number a worktree name carries, or null for the ones that have none
// (a release branch, a direct chat fix).
export function issueOfWorktree(name) {
  const match = /^(\d+)-/.exec(String(name ?? ''));
  return match ? Number(match[1]) : null;
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
    const issue = issueOfWorktree(entry.name);
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
export function gatherGithubFacts({ repo, names = [], warns }) {
  const issueStates = {};
  let openIssues = [];
  try {
    openIssues = ghJson(['api', 'repos/' + repo + '/issues', '--paginate', '-X', 'GET', '-f', 'state=open'])
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({ number: issue.number, state: issue.state }));
  } catch (error) {
    warns.push(at('github', 'could not read open issues, reporting from git alone: ' + error.message));
    return { openIssues, issueStates };
  }
  const open = new Set(openIssues.map((issue) => issue.number));
  for (const name of names) {
    const issue = issueOfWorktree(name);
    if (issue === null) continue;
    if (open.has(issue)) {
      issueStates[name] = 'open';
      continue;
    }
    try {
      issueStates[name] = ghJson(['api', 'repos/' + repo + '/issues/' + issue]).state;
    } catch (error) {
      warns.push(at('github', 'could not read the state of #' + issue + ': ' + error.message));
    }
  }
  return { openIssues, issueStates };
}

// Ledger edit times for the named issues, one call each. Failures warn.
export function gatherLedgerTimes({ repo, names, warns }) {
  const times = {};
  for (const name of names) {
    const issue = issueOfWorktree(name);
    if (issue === null) continue;
    try {
      const comments = ghJson(['api', 'repos/' + repo + '/issues/' + issue + '/comments', '--paginate']);
      const ledger = findMarkerComment(comments, 'ledger');
      if (ledger) times[name] = ledger.comment.updated_at;
    } catch (error) {
      warns.push(at('github', 'could not read the ledger of #' + issue + ': ' + error.message));
    }
  }
  return times;
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
  const shared = { repoRoot, devMd, home, base, write: Boolean(flags.write) };

  const repoOf = () => flags.repo || knobLine(devMd, 'repo')?.split('·')[0].trim() || null;

  if (verb === 'list' || verb === 'status') {
    const warns = [];
    const repo = repoOf();
    const names = inventory(repoRoot).map((entry) => entry.name);
    const github = repo ? gatherGithubFacts({ repo, names, warns }) : { openIssues: [], issueStates: {} };
    const entries = listWorktrees({ repoRoot, base, issueStates: github.issueStates });
    // A checkout whose dependencies were taken cannot build, and this is where a person looks.
    const dropped = readDroppedDeps(repoRoot);
    for (const entry of entries) {
      const notice = dependencyNotice(entry.name, dropped, devMd);
      if (notice) warns.push(at(entry.name, notice));
    }
    if (verb === 'list') return { blocks: [], warns, entries };
    return { blocks: [], warns, entries, reconciled: reconcileWorktrees({ entries, openIssues: github.openIssues }) };
  }
  if (verb === 'remove') {
    // --name is exact; --issue resolves it from the inventory, which is what a
    // caller that only knows the issue number (the CLI, dev-ship) has.
    let name = flags.name;
    if (!name && issue !== null) {
      const matches = inventory(repoRoot).filter((entry) => issueOfWorktree(entry.name) === issue);
      if (matches.length === 0) return { blocks: [at('#' + issue, 'no worktree for that issue')], warns: [] };
      if (matches.length > 1) {
        return { blocks: [at('#' + issue, 'several worktrees match (' + matches.map((m) => m.name).join(', ') + ') — pass --name')], warns: [] };
      }
      name = matches[0].name;
    }
    if (!name) return { blocks: ['--name <n>-<slug> or --issue <n> is required for remove'], warns: [] };
    return removeWorktree({ repoRoot, name, base, force: Boolean(flags.force), push: Boolean(flags.push), write: shared.write });
  }
  if (verb === 'prune') {
    const warns = [];
    const repo = flags.repo || knobLine(devMd, 'repo')?.split('·')[0].trim() || null;
    const names = inventory(repoRoot).map((entry) => entry.name);
    const ledgerTimes = repo ? gatherLedgerTimes({ repo, names, warns }) : {};
    // The board already knows which issues are closed, and `list` reads it for these same names.
    // A worktree whose issue is closed is finished, whatever its dates say.
    const issueStates = repo ? gatherGithubFacts({ repo, names, warns }).issueStates : {};
    const pruned = pruneWorktrees({
      repoRoot, base, olderThan: flags['older-than'], devMd, ledgerTimes, issueStates, now: Date.now(), write: shared.write,
      automatic: flags.automatic === true,
      inUse: String(flags['in-use'] ?? '').split(',').map((name) => name.trim()).filter(Boolean),
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
  const flags = parseFlags(argv, ['json', 'write', 'force', 'push', 'all', 'automatic', 'plan', 'mark']);
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
