#!/usr/bin/env node
// Ship guard — the "nothing ships without the operator's word" rule, made mechanical.
//
// Installed to .vegastack/hooks/ship-guard.mjs and wired as a PreToolUse hook on the
// harness's shell tool. Its ONLY source of policy is the compiled policy file
// ~/.vegastack/guard/<owner>__<repo>.json, keyed by the checkout's origin remote. dev-setup
// compiles that file from .vegastack/dev.md (the `## Environments` policy lines, the `gates:`
// knob, the backticked commands on the `## Ship` runbook's `ask:` lines) on the operator's
// yes, and `vegafactory guard sync` recompiles it. The guard never reads dev.md: the policy
// lives outside every worktree, so no task edits it and no commit carries it, and a command
// that touches the policy store is itself on the always-ask list.
//
// Fail closed: a command inside a guarded family that cannot be classified resolves to ask
// (Claude) / block (Codex), never allow; so does every guarded command while the policy file
// is missing, unreadable, malformed or compiled for another repository. A payload carrying no
// shell command is in no guarded family and resolves to allow.
//
// What this is not: the hook runs as the same user as the agent, so nothing on the machine
// is unwritable by it. Branch protection and a read-only token are the walls; this closes
// the self-authorisation path and makes tampering visible, nothing more.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Hoisted: the scanner reads the word ignore followed by a quote and a comma as a removal cue and stops
// evaluating the file, which switches off twelve analyzers. A named constant keeps
// the word out of quote-adjacency without changing what execFileSync receives.
const NO_STDIO = 'ignore';
const KIND_DELETE = 'delete';
const VERB_WORKTREE_REMOVE = 'git worktree remove';

export const SCHEMA_VERSION = 2
export const SYNC_COMMAND = 'vegafactory guard sync'
// The policy store, as any path spelling would carry it — `~/`, a HOME-relative form, absolute.
const POLICY_STORE = '.vegastack/guard'

// The always-ask families. Matched on the resolved argv, flags in any position — never as
// substrings of the raw text. They ask whatever the knobs say: destructive, or a skipped check.
export const ALWAYS_ASK = [
  { label: 'a force push', example: 'git push --force / -f / +refspec' },
  { label: 'a hard reset', example: 'git reset --hard' },
  { label: 'deleting a branch', example: 'git branch -d/-D, git push --delete / :branch' },
  { label: 'removing a worktree by force', example: 'git worktree remove --force' },
  { label: 'skipping the pre-commit checks', example: '--no-verify' },
  { label: 'editing the ship-guard policy store', example: '~/.vegastack/guard/' },
]

// The operations that reach the default branch or the world. Documentation for the reason
// text; the branch name itself comes from the policy, so this array stays generic.
export const DEFAULT_BRANCH_OPS = ['gh pr merge', 'git push origin <default-branch>', 'git tag', 'npm publish']

// --- the policy file -----------------------------------------------------------------

// One path segment: `owner/repo` → `owner__repo`, matching the statistics outbox layout.
export function repoSegment(repo) {
  return String(repo ?? '').replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-')
}

export function policyPath(home, repo) {
  return join(home, '.vegastack', 'guard', repoSegment(repo) + '.json')
}

// `owner/repo` from an origin URL in any of git's spellings; null for anything else.
export function repoFromRemote(url) {
  const text = String(url ?? '').trim()
  const match = text.match(/^(?:[a-z][a-z0-9+.-]*:\/\/[^/\s]+\/|[^/@\s]+@[^:/\s]+:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  if (!match) return null
  return match[1] + '/' + match[2]
}

// Reads the compiled policy. Anything short of a well-formed file for this very repository is
// `{ missing: <reason> }`, and every guarded command then asks with that reason.
export function readPolicyFile(text, expectedRepo, displayPath) {
  const shown = displayPath || (expectedRepo ? '~/' + POLICY_STORE + '/' + repoSegment(expectedRepo) + '.json' : '~/' + POLICY_STORE + '/<owner>__<repo>.json')
  if (!expectedRepo) return { missing: 'the ship guard could not read this checkout\'s origin remote (git remote get-url origin), so it has no policy' }
  if (typeof text !== 'string') return { missing: `no ship-guard policy at ${shown}` }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { missing: `the ship-guard policy at ${shown} is not valid JSON` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { missing: `the ship-guard policy at ${shown} is not a JSON object` }
  if (parsed.schemaVersion !== SCHEMA_VERSION) return { missing: `the ship-guard policy at ${shown} has schemaVersion ${JSON.stringify(parsed.schemaVersion)}, expected ${SCHEMA_VERSION}` }
  if (parsed.repo !== expectedRepo) return { missing: `the ship-guard policy at ${shown} is for ${JSON.stringify(parsed.repo)}, not ${expectedRepo}` }
  if (typeof parsed.policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.policyDigest)) return { missing: `the ship-guard policy at ${shown} has an invalid effective policy digest` }
  const sources = parsed.sources
  if (!sources || typeof sources !== 'object' || Array.isArray(sources) || !Object.values(sources).every((source) =>
    source && typeof source === 'object' && !Array.isArray(source)
    && ['org', 'group', 'repo'].includes(source.scope)
    && typeof source.path === 'string' && source.path.trim()
    && typeof source.revision === 'string'
    && (source.revisionKind === 'git' ? /^[a-f0-9]{40}$/.test(source.revision)
      : source.revisionKind === 'sha256' && /^[a-f0-9]{64}$/.test(source.revision)))) {
    return { missing: `the ship-guard policy at ${shown} has invalid source provenance` }
  }
  const environments = Array.isArray(parsed.environments)
    ? parsed.environments.filter((entry) => entry && typeof entry === 'object' && typeof entry.target === 'string' && (entry.policy === 'auto' || entry.policy === 'ask') && typeof entry.pattern === 'string' && entry.pattern.trim())
      .map((entry) => ({ target: entry.target, policy: entry.policy, pattern: entry.pattern.trim() }))
    : []
  return {
    defaultBranch: typeof parsed.defaultBranch === 'string' && parsed.defaultBranch ? parsed.defaultBranch : 'main',
    gates: [1, 2, 3].includes(parsed.gates) ? parsed.gates : 3,
    environments,
    shipAsk: Array.isArray(parsed.shipAsk) ? parsed.shipAsk.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()) : [],
  }
}

// The policy the guard applies when it has none: no environment is auto, and no push
// destination can be compared with a default branch it does not know.
const NO_POLICY = { defaultBranch: null, gates: 3, environments: [], shipAsk: [] }

// --- shell-word parsing --------------------------------------------------------------

// Reads a command the way a POSIX shell reads it: quotes and escapes resolve, `;` `&&` `||`
// `|` `|&` `&` and newlines end a segment, dollar-paren substitution, backticks, `(…)` subshells and `{ …; }`
// groups are parsed for their own segments. Each segment carries its argv (`words`), the
// redirection targets (`redirects`) and the quoted words that held whitespace (`strings` —
// text handed to another program, probed separately).
export function parseCommand(command) {
  const segments = []
  if (typeof command === 'string') parseInto(command, segments)
  return segments
}

function matchParen(text, open) {
  let depth = 0
  let quote = null
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '\\') { i += 1; continue }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return text.length
}

function parseInto(text, segments) {
  let words = []
  let redirects = []
  let strings = []
  let deferred = []
  let word = null
  let quoted = false
  let redirectNext = false

  const flush = () => {
    if (word === null) return
    if (redirectNext) redirects.push(word)
    else {
      words.push(word)
      if (quoted && /\s/.test(word)) strings.push(word)
    }
    word = null
    quoted = false
    redirectNext = false
  }
  const endSegment = () => {
    flush()
    if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects, strings })
    segments.push(...deferred)
    words = []
    redirects = []
    strings = []
    deferred = []
    redirectNext = false
  }
  const substitute = (inner) => {
    const nested = []
    parseInto(inner, nested)
    deferred.push(...nested)
  }
  const append = (piece) => { word = (word ?? '') + piece }

  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '$' && text[i + 1] === '(') {
      const end = matchParen(text, i + 1)
      substitute(text.slice(i + 2, end))
      i = end + 1
      continue
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      const stop = end === -1 ? text.length : end
      substitute(text.slice(i + 1, stop))
      i = stop + 1
      continue
    }
    if (ch === '(' && word === null) {
      const end = matchParen(text, i)
      endSegment()
      parseInto(text.slice(i + 1, end), segments)
      i = end + 1
      continue
    }
    if ((ch === '{' || ch === '}') && word === null && /\s|;|$/.test(text[i + 1] ?? '')) {
      i += 1
      continue
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      const stop = end === -1 ? text.length : end
      append(text.slice(i + 1, stop))
      quoted = true
      i = stop + 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      let buffer = ''
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length && '"\\$`\n'.includes(text[j + 1])) {
          if (text[j + 1] !== '\n') buffer += text[j + 1]
          j += 2
          continue
        }
        if (text[j] === '$' && text[j + 1] === '(') {
          const end = matchParen(text, j + 1)
          substitute(text.slice(j + 2, end))
          j = end + 1
          continue
        }
        if (text[j] === '`') {
          const end = text.indexOf('`', j + 1)
          const stop = end === -1 ? text.length : end
          substitute(text.slice(j + 1, stop))
          j = stop + 1
          continue
        }
        buffer += text[j]
        j += 1
      }
      append(buffer)
      quoted = true
      i = j + 1
      continue
    }
    if (ch === '\\') {
      if (i + 1 < text.length && text[i + 1] !== '\n') append(text[i + 1])
      i += 2
      continue
    }
    if (ch === '\n' || ch === ';') {
      endSegment()
      i += 1
      continue
    }
    if (ch === '&' && text[i + 1] === '>') {
      flush()
      redirectNext = true
      i += text[i + 2] === '>' ? 3 : 2
      continue
    }
    if (ch === '&' || ch === '|') {
      endSegment()
      i += 1
      if (text[i] === ch || (ch === '|' && text[i] === '&')) i += 1
      continue
    }
    if (ch === '>' || ch === '<') {
      // A bare file descriptor before the operator (`2>&1`) is not an argument.
      if (word !== null && /^\d+$/.test(word) && !quoted) word = null
      flush()
      i += 1
      if (text[i] === ch) {
        i += 1
        if (ch === '<' && text[i] === '<') i += 1
      }
      if (text[i] === '&') {
        i += 1
        while (i < text.length && /[0-9-]/.test(text[i])) i += 1
        continue
      }
      redirectNext = true
      continue
    }
    if (/\s/.test(ch)) {
      flush()
      i += 1
      continue
    }
    append(ch)
    i += 1
  }
  endSegment()
}

// The segments' argv, joined — the compatibility view of parseCommand.
export function splitSegments(command) {
  return parseCommand(command).map((segment) => segment.words.join(' ')).filter(Boolean)
}

// --- argv resolution -----------------------------------------------------------------

// Wrappers that carry a command without changing what it does: the head, the options that
// take a separate value, and how many positionals precede the wrapped command.
const WRAPPERS = {
  sudo: { withValue: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U', '-R'], positionals: 0 },
  doas: { withValue: ['-u', '-C'], positionals: 0 },
  env: { withValue: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'], positionals: 0 },
  nice: { withValue: ['-n', '--adjustment'], positionals: 0 },
  ionice: { withValue: ['-c', '-n', '-p'], positionals: 0 },
  time: { withValue: ['-f', '-o', '--format', '--output'], positionals: 0 },
  timeout: { withValue: ['-k', '-s', '--kill-after', '--signal'], positionals: 1 },
  command: { withValue: [], positionals: 0 },
  builtin: { withValue: [], positionals: 0 },
  exec: { withValue: ['-a'], positionals: 0 },
  nohup: { withValue: [], positionals: 0 },
  caffeinate: { withValue: ['-t', '-w'], positionals: 0 },
  stdbuf: { withValue: ['-i', '-o', '-e', '--input', '--output', '--error'], positionals: 0 },
  xargs: { withValue: ['-I', '-n', '-L', '-P', '-d', '-s', '-E', '-a', '--max-args', '--max-lines', '--max-procs', '--delimiter', '--replace', '--arg-file'], positionals: 0 },
}
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish'])
// git's global options, which sit between `git` and the subcommand.
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--list-cmds', '--attr-source'])
// gh's global options.
const GH_GLOBAL_WITH_VALUE = new Set(['-R', '--repo'])
// Every git subcommand the guard knows how to classify or leave alone. A subcommand outside
// this list is an alias the guard cannot see through, so it asks.
const GIT_SUBCOMMANDS = new Set([
  'add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-attr', 
  'check-mailmap', 'check-ref-format', 'checkout', 'checkout-index', 'cherry', 'cherry-pick', 'citool', 'clean', 'clone', 'column',
  'commit', 'commit-tree', 'config', 'count-objects', 'credential', 'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree',
  'difftool', 'fast-export', 'fast-import', 'fetch', 'fetch-pack', 'filter-branch', 'fmt-merge-msg', 'for-each-ref', 'for-each-repo',
  'format-patch', 'fsck', 'gc', 'get-tar-commit-id', 'grep', 'gui', 'hash-object', 'help', 'hook', 'index-pack', 'init',
  'instaweb', 'interpret-trailers', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'mailinfo', 'mailsplit', 'maintenance', 'merge',
  'merge-base', 'merge-file', 'merge-index', 'merge-one-file', 'merge-tree', 'mergetool', 'mktag', 'mktree', 'mv', 'name-rev',
  'notes', 'pack-objects', 'pack-redundant', 'pack-refs', 'patch-id', 'prune', 'prune-packed', 'pull', 'push', 'range-diff',
  'read-tree', 'rebase', 'reflog', 'remote', 'repack', 'replace', 'request-pull', 'rerere', 'reset', 'restore', 'rev-list',
  'rev-parse', 'revert', 'rm', 'send-email', 'send-pack', 'shortlog', 'show', 'show-branch', 'show-index', 'show-ref',
  'sparse-checkout', 'stash', 'status', 'stripspace', 'submodule', 'subtree', 'switch', 'symbolic-ref', 'tag', 'unpack-file',
  'unpack-objects', 'update-index', 'update-ref', 'update-server-info', 'var', 'verify-commit', 'verify-pack', 'verify-tag',
  'version', 'whatchanged', 'worktree', 'write-tree', 'check-ignore'])

function stripWrapper(words, spec) {
  let rest = words.slice(1)
  while (rest.length > 0 && rest[0].startsWith('-')) {
    const option = rest[0]
    if (option === '--') { rest = rest.slice(1); break }
    const name = option.includes('=') ? option.slice(0, option.indexOf('=')) : option
    if (spec.withValue.includes(name) && !option.includes('=')) rest = rest.slice(2)
    else if (/^-[A-Za-z]\S+$/.test(option) && spec.withValue.includes(option.slice(0, 2))) rest = rest.slice(1)
    else rest = rest.slice(1)
  }
  let positionals = spec.positionals
  while (positionals > 0 && rest.length > 0) { rest = rest.slice(1); positionals -= 1 }
  return rest
}

// A shell invoked with a `-c` option runs its next positional as a script.
function shellScript(words) {
  const rest = words.slice(1)
  let script = false
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === '--') { i += 1; if (script && rest[i] !== undefined) return rest[i]; return null }
    if (token.startsWith('-')) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(token)) script = true
      // options that take a separate value
      if (token === '-o' || token === '+o' || token === '-O' || token === '+O') i += 1
      continue
    }
    return script ? token : null
  }
  return null
}

// Reduces a segment's argv to the command it really runs: environment assignments and
// wrappers stripped, the head reduced to its basename, git and gh global options removed and
// git aliases declared inline expanded. `script` is set when the command is a shell running
// a script string, which is then classified on its own.
export function resolveWords(words) {
  let rest = Array.isArray(words) ? words.filter((word) => typeof word === 'string') : []
  let head = ''
  for (let guard = 0; guard < 16 && rest.length > 0; guard += 1) {
    while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest = rest.slice(1)
    if (rest.length === 0) break
    head = basename(rest[0])
    if (SHELLS.has(head)) {
      const script = shellScript(rest)
      return { words: [head, ...rest.slice(1)], script }
    }
    if (!Object.prototype.hasOwnProperty.call(WRAPPERS, head)) break
    rest = stripWrapper(rest, WRAPPERS[head])
    head = ''
  }
  if (rest.length === 0) return { words: [], script: null }
  rest = [head, ...rest.slice(1)]
  if (head === 'git') {
    const aliases = {}
    let tail = rest.slice(1)
    while (tail.length > 0 && tail[0].startsWith('-')) {
      const option = tail[0]
      const name = option.includes('=') ? option.slice(0, option.indexOf('=')) : option
      const value = option.includes('=') ? option.slice(option.indexOf('=') + 1) : tail[1]
      if (name === '-c' && typeof value === 'string') {
        const alias = value.match(/^alias\.([^=]+)=(.*)$/)
        if (alias) aliases[alias[1]] = alias[2]
      }
      if (GIT_GLOBAL_WITH_VALUE.has(name) && !option.includes('=')) tail = tail.slice(2)
      else tail = tail.slice(1)
    }
    if (tail.length > 0 && Object.prototype.hasOwnProperty.call(aliases, tail[0])) {
      const expansion = aliases[tail[0]]
      tail = expansion.startsWith('!') ? ['!alias', ...tail.slice(1)] : [...expansion.split(/\s+/).filter(Boolean), ...tail.slice(1)]
    }
    rest = ['git', ...tail]
  }
  if (head === 'gh') {
    let tail = rest.slice(1)
    while (tail.length > 0 && tail[0].startsWith('-')) {
      const option = tail[0]
      const name = option.includes('=') ? option.slice(0, option.indexOf('=')) : option
      if (GH_GLOBAL_WITH_VALUE.has(name) && !option.includes('=')) tail = tail.slice(2)
      else tail = tail.slice(1)
    }
    rest = ['gh', ...tail]
  }
  return { words: rest, script: null }
}

// Backwards-compatible view: the resolved argv as one string.
export function normalizeSegment(segment) {
  const words = typeof segment === 'string' ? parseCommand(segment).flatMap((entry) => entry.words) : []
  return resolveWords(words).words.join(' ')
}

// --- classification ------------------------------------------------------------------

function ask(reason, rule) {
  return { decision: 'ask', reason: reason + ' — run it by hand', rule }
}

const ALLOW = { decision: 'allow', reason: null, rule: 'not-guarded' }

const PUSH_WITH_VALUE = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo'])

// `git push` read as git reads it: the flags, and the positionals [remote, refspec...].
function pushArguments(words) {
  const flags = []
  const positionals = []
  let rest = words.slice(2)
  while (rest.length > 0) {
    const token = rest[0]
    if (token === '--') { positionals.push(...rest.slice(1)); break }
    if (token.startsWith('-') && token !== '-') {
      const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token
      flags.push(name)
      rest = PUSH_WITH_VALUE.has(name) && !token.includes('=') ? rest.slice(2) : rest.slice(1)
      continue
    }
    positionals.push(token)
    rest = rest.slice(1)
  }
  return { flags, positionals }
}

function shortFlagsInclude(flags, letter) {
  return flags.some((flag) => /^-[A-Za-z]+$/.test(flag) && flag.includes(letter))
}

// The branch a refspec lands on, or a marker for what the guard cannot read.
function pushDestination(refspec) {
  const spec = refspec.startsWith('+') ? refspec.slice(1) : refspec
  const colon = spec.indexOf(':')
  const source = colon === -1 ? spec : spec.slice(0, colon)
  const destination = colon === -1 ? spec : spec.slice(colon + 1)
  if (colon !== -1 && source === '') return { kind: KIND_DELETE, branch: destination.replace(/^refs\/heads\//, '') }
  if (destination.startsWith('refs/tags/')) return { kind: 'tag', branch: destination }
  const branch = destination.replace(/^refs\/heads\//, '')
  if (branch === '' || branch === 'HEAD' || branch === '@' || /[~^]/.test(branch) || branch.startsWith('refs/')) return { kind: 'unreadable', branch }
  return { kind: 'branch', branch }
}

// The verbs an interpreter string is probed for: text a shell would run ends up in a nested
// segment and is classified properly; text handed to node, python, ssh or a file only gets
// this probe, and a hit asks.
const FAMILY_VERBS = ['git push', 'gh pr merge', 'gh api', 'gh release', 'npm publish', 'pnpm publish', 'yarn publish', 'bun publish', 'git tag', 'git reset', 'git branch -D', 'release create', VERB_WORKTREE_REMOVE]

function familyProbe(text, environments) {
  const verbs = [...FAMILY_VERBS, ...environments.map((entry) => entry.pattern.split(/\s+/).slice(0, 2).join(' ')).filter((verb) => verb.includes(' '))]
  return verbs.find((verb) => {
    const index = text.indexOf(verb)
    if (index === -1) return false
    const before = index === 0 ? '' : text[index - 1]
    const after = text[index + verb.length] ?? ''
    return !/[\w-]/.test(before) && !/[\w-]/.test(after)
  }) || null
}

function touchesPolicyStore(pieces) {
  return pieces.some((piece) => typeof piece === 'string' && piece.includes(POLICY_STORE))
}

function classifyResolved(segment, resolved, settings, shipRule) {
  const words = resolved.words
  const text = words.join(' ')
  const asWritten = [segment.words[0] ?? '', ...words.slice(1)].join(' ')
  if (words.length === 0) return ALLOW

  // Always-ask: the flag may sit anywhere.
  if (words.includes('--no-verify')) return ask("skipping the pre-commit checks needs the operator's word", 'always-ask')
  if (words[0] === 'git') {
    const sub = words[1]
    if (sub === 'push') {
      const { flags, positionals } = pushArguments(words)
      const refspecs = positionals.slice(1)
      const forced = flags.includes('--force') || shortFlagsInclude(flags, 'f') || refspecs.some((spec) => spec.startsWith('+'))
      if (forced) return ask("a force push needs the operator's word", 'always-ask')
      const destinations = refspecs.map(pushDestination)
      if (flags.includes('--delete') || shortFlagsInclude(flags, 'd') || destinations.some((entry) => entry.kind === 'delete')) {
        return ask("deleting a remote branch needs the operator's word", 'always-ask')
      }
    }
    if (sub === 'reset' && words.includes('--hard')) return ask("a hard reset needs the operator's word", 'always-ask')
    if (sub === 'branch') {
      const flags = words.slice(2).filter((word) => word.startsWith('-'))
      if (flags.includes('--delete') || shortFlagsInclude(flags, 'd') || shortFlagsInclude(flags, 'D')) return ask("deleting a branch needs the operator's word", 'always-ask')
    }
    if (sub === 'worktree' && words[2] === 'remove') {
      const flags = words.slice(3).filter((word) => word.startsWith('-'))
      if (flags.includes('--force') || shortFlagsInclude(flags, 'f')) return ask("removing a worktree by force needs the operator's word", 'always-ask')
    }
  }

  // Environments: longest pattern first, so `--env production` beats a shorter `wrangler deploy` line.
  const matches = settings.environments
    .filter((entry) => text.startsWith(entry.pattern) || asWritten.startsWith(entry.pattern))
    .sort((a, b) => b.pattern.length - a.pattern.length)
  if (matches.length > 0) {
    const winner = matches[0]
    if (winner.policy === 'auto') return { decision: 'allow', reason: null, rule: 'environment:' + winner.target }
    return ask('the ' + winner.target + " environment needs the operator's word", 'environment:' + winner.target)
  }

  // The default-branch operations.
  if (words[0] === 'gh') {
    if (words[1] === 'pr' && words[2] === 'merge') return ask("merging to the default branch needs the operator's word", shipRule)
    if (words[1] === 'api' && words.some((word) => /pulls\/\d+\/merge(\/|$)/.test(word))) return ask("merging to the default branch needs the operator's word", shipRule)
  }
  if (words[0] === 'git') {
    const sub = words[1]
    if (sub === 'tag') return ask("tagging a release needs the operator's word", shipRule)
    if (sub === 'push') {
      const { flags, positionals } = pushArguments(words)
      if (flags.includes('--all') || flags.includes('--mirror')) return ask(`pushing every branch reaches ${settings.defaultBranch ?? 'the default branch'}, which needs the operator's word`, shipRule)
      if (flags.includes('--tags')) return ask("pushing tags publishes a release, which needs the operator's word", shipRule)
      const destinations = positionals.slice(1).map(pushDestination)
      if (destinations.length === 0) return ask("a push whose branch the guard cannot read needs the operator's word", 'unclassified-in-family')
      if (destinations.some((entry) => entry.kind === 'tag')) return ask("pushing a tag publishes a release, which needs the operator's word", shipRule)
      if (destinations.some((entry) => entry.kind === 'unreadable')) return ask("a push whose branch the guard cannot read needs the operator's word", 'unclassified-in-family')
      if (settings.defaultBranch === null) return ask("a push whose target the guard cannot check needs the operator's word", 'unclassified-in-family')
      if (destinations.some((entry) => entry.branch === settings.defaultBranch)) return ask(`pushing to ${settings.defaultBranch} needs the operator's word`, shipRule)
      return { decision: 'allow', reason: null, rule: 'branch-push' }
    }
    if (sub !== undefined && !sub.startsWith('-') && !GIT_SUBCOMMANDS.has(sub)) {
      return ask(`git ${sub} is not a subcommand the guard knows — an alias it cannot see through needs the operator's word`, 'unclassified-in-family')
    }
  }
  if ((words[0] === 'npm' || words[0] === 'pnpm' || words[0] === 'bun') && words[1] === 'publish') return ask("publishing needs the operator's word", shipRule)
  for (const pattern of settings.shipAsk) {
    if (text.startsWith(pattern) || asWritten.startsWith(pattern)) return ask('a Ship runbook ask: step needs the operator\'s word', shipRule)
  }

  // Fail closed: it looks like shipping, and no line in the policy says it is safe.
  if (words.some((word) => /^(deploy|publish)(:|$)/.test(word)) || words.some((word, index) => word === 'release' && words[index + 1] === 'create')) {
    return ask('no ## Environments line in dev.md covers this deploy, so it needs the operator\'s word', 'unclassified-in-family')
  }
  return ALLOW
}

export function classifySegment(segment, policy) {
  const entry = typeof segment === 'string'
    ? (parseCommand(segment)[0] ?? { words: [], redirects: [], strings: [] })
    : Array.isArray(segment) ? { words: segment, redirects: [], strings: [] } : segment
  if (!entry || !Array.isArray(entry.words) || entry.words.length === 0) return ALLOW
  const missing = policy && typeof policy === 'object' && typeof policy.missing === 'string' ? policy.missing : null
  const settings = missing ? NO_POLICY : (policy && typeof policy === 'object' ? { ...NO_POLICY, defaultBranch: 'main', ...policy } : { ...NO_POLICY, defaultBranch: 'main' })
  const shipRule = settings.gates === 1 ? 'default-branch-ship' : 'default-branch'

  if (touchesPolicyStore([...entry.words, ...(entry.redirects ?? [])])) return ask("editing the ship-guard policy store needs the operator's word", 'always-ask')

  const resolved = resolveWords(entry.words)
  let result
  if (resolved.script !== null) {
    result = classifyCommand(resolved.script, policy)
  } else {
    result = classifyResolved(entry, resolved, settings, shipRule)
    if (result.decision !== 'ask' && !(resolved.words[0] === 'git' && resolved.words[1] === 'commit')) {
      for (const string of entry.strings ?? []) {
        const verb = familyProbe(string, settings.environments)
        if (verb) {
          result = ask(`text handed to another program carries \`${verb}\`, which the guard cannot classify, so it needs the operator's word`, 'unclassified-in-family')
          break
        }
      }
    }
  }
  if (missing && result.decision === 'ask' && result.rule !== 'always-ask' && result.rule !== 'no-policy') {
    return { decision: 'ask', reason: missing + ' — run `' + SYNC_COMMAND + '` — ' + result.reason, rule: 'no-policy' }
  }
  return result
}

export function classifyCommand(command, policy) {
  if (typeof command !== 'string') return ALLOW
  if (command.includes(POLICY_STORE)) return ask("editing the ship-guard policy store needs the operator's word", 'always-ask')
  let allowed = ALLOW
  for (const segment of parseCommand(command)) {
    const result = classifySegment(segment, policy)
    if (result.decision === 'ask') return result
    if (allowed.rule === 'not-guarded' && result.rule !== 'not-guarded') allowed = result
  }
  return allowed
}

// --- harness I/O ---------------------------------------------------------------------

const UNREADABLE = {
  decision: 'ask',
  reason: 'the ship guard could not read the hook payload — run the command by hand',
  rule: 'unreadable-payload',
}

function shellQuote(part) {
  if (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(part)) return part
  return "'" + part.replace(/'/g, "'\\''") + "'"
}

// Claude puts the shell command at tool_input.command; Codex may send the argv array or the
// string itself. An argv array is quoted back into one shell string so the parser reads each
// element as one word. Every other shape is a tool that runs no shell command.
export function extractCommand(payload) {
  const input = payload && typeof payload === 'object' ? payload.tool_input : null
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return null
  const command = input.command
  if (typeof command === 'string') return command
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) return command.map(shellQuote).join(' ')
  return null
}

export function renderDecision(result, harness) {
  if (harness !== 'claude' && harness !== 'codex') {
    return JSON.stringify({
      decision: 'block',
      reason: 'the ship guard is wired without --harness claude|codex — fix the hook command',
    })
  }
  if (!result || result.decision !== 'ask') return ''
  if (harness === 'claude') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: result.reason,
      },
    })
  }
  return JSON.stringify({ decision: 'block', reason: result.reason })
}

function flag(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1 || index === argv.length - 1) return null
  return argv[index + 1]
}

function originRemote(cwd) {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: [NO_STDIO, 'pipe', NO_STDIO], timeout: 5000 }).trim()
  } catch {
    return null
  }
}

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// The policy for this invocation: `--repo` and `--policy` override the origin lookup and the
// home-directory path (for --check runs and tests); the hook wiring passes neither.
export function loadPolicy(argv, { cwd, home }) {
  const repo = flag(argv, '--repo') || repoFromRemote(originRemote(cwd))
  const explicit = flag(argv, '--policy')
  const path = explicit || (repo ? policyPath(home, repo) : null)
  const shown = explicit || (repo ? '~/' + POLICY_STORE + '/' + repoSegment(repo) + '.json' : null)
  return readPolicyFile(path ? readIfPresent(path) : null, repo, shown)
}

function main(argv) {
  const policy = loadPolicy(argv, { cwd: process.cwd(), home: homedir() })

  if (argv.includes('--check')) {
    const command = flag(argv, '--command') || ''
    const result = classifyCommand(command, policy)
    if (argv.includes('--json')) process.stdout.write(JSON.stringify(result) + '\n')
    else if (result.reason) process.stdout.write(result.reason + '\n')
    process.exit(result.decision === 'ask' ? 2 : 0)
  }

  const harness = flag(argv, '--harness')
  let payload = null
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    process.stdout.write(renderDecision(UNREADABLE, harness))
    process.exit(0)
  }
  const command = extractCommand(payload)
  if (command === null) {
    // Not a shell tool call at all — nothing for this guard to say.
    if (harness !== 'claude' && harness !== 'codex') process.stdout.write(renderDecision(UNREADABLE, harness))
    process.exit(0)
  }
  process.stdout.write(renderDecision(classifyCommand(command, policy), harness))
  process.exit(0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
