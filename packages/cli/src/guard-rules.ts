// The ship guard: "nothing ships without the operator's word", made mechanical.
//
// Policy is a fixed always-ask list plus the commands named in backticks on the `ask:` lines of
// the `## Ship` section of .vegastack/dev.md, read from the committed default branch
// (`git show origin/<default>:.vegastack/dev.md`) so a task cannot loosen it by editing its own copy.
//
// Fail closed: a command inside a guarded family that cannot be classified asks, never allows.
// The hook runs as the same user as the agent, so this closes the self-authorisation path and
// nothing more; branch protection and a read-only token are the walls.
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'

export interface Segment { words: string[]; redirects: string[]; strings: string[] }
// Stands in for text the shell computes at run time ($VAR, $(…), backticks, $'…'), so a word
// built by expansion is never read as the literal it might become.
export const EXPANDED = '\u0000'
const expanded = (word: string | undefined) => word !== undefined && word.includes(EXPANDED)
// A `$` that starts an expansion rather than standing for itself.
const EXPANSION_START = /[A-Za-z0-9_{@*#?$!'"-]/
export interface Policy { defaultBranch: string | null; shipAsk: string[]; tags?: Set<string> }
export interface Decision { decision: 'allow' | 'ask'; reason: string | null; rule: string }
// Says whether `gh pr merge` with these (resolved) arguments is already covered by a recorded "ship it".
// `raw` is the argv as written, so the check can refuse a `--repo` the resolver stripped.
export type MergeCheck = (words: string[], raw: string[]) => boolean

// ---------------------------------------------------------------------------------------------
// Policy

// Backticked commands on `- ask:` lines of the `## Ship` section.
export function shipAskCommands(devMd: string): string[] {
  const commands: string[] = []
  let inShip = false
  for (const line of devMd.split('\n')) {
    if (/^## /.test(line)) inShip = /^## Ship\b/.test(line)
    const match = inShip ? /^- ask: (.+)$/.exec(line) : null
    if (!match) continue
    for (const span of match[1]!.matchAll(/`([^`]+)`/g)) {
      const command = span[1]!.trim()
      if (command && !commands.includes(command)) commands.push(command)
    }
  }
  return commands
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
  return result.status === 0 ? result.stdout.trim() : null
}

// The default branch from the remote's HEAD, then the usual names that exist on the remote.
export function defaultBranch(cwd: string): string | null {
  const head = git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (head?.startsWith('origin/')) return head.slice('origin/'.length)
  for (const name of ['main', 'master']) if (git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]) !== null) return name
  return null
}

export function loadPolicy(cwd: string): Policy {
  const branch = defaultBranch(cwd)
  const devMd = branch ? git(cwd, ['show', `origin/${branch}:.vegastack/dev.md`]) : null
  const tags = new Set((git(cwd, ['tag', '--list']) ?? '').split('\n').filter(Boolean))
  return { defaultBranch: branch, shipAsk: devMd ? shipAskCommands(devMd) : [], tags }
}

// A push destination is a tag when it is spelled as one, names a local tag, or looks like a version.
const isTag = (name: string, tags?: Set<string>) => name.startsWith('refs/tags/') || Boolean(tags?.has(name)) || /^v?\d+\.\d+/.test(name)

// ---------------------------------------------------------------------------------------------
// Shell-word parsing

// Reads a command the way a POSIX shell reads it: quotes and escapes resolve, `;` `&&` `||`
// `|` `|&` `&` and newlines end a segment, `$(…)`, backticks, `(…)` subshells and `{ …; }`
// groups are parsed for their own segments. `strings` holds quoted words with whitespace —
// text handed to another program, probed separately.
export function parseCommand(command: unknown): Segment[] {
  const segments: Segment[] = []
  if (typeof command === 'string') parseInto(command, segments)
  return segments
}

function matchParen(text: string, open: number): number {
  let depth = 0
  let quote: string | null = null
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

function parseInto(text: string, segments: Segment[]) {
  let words: string[] = []
  let redirects: string[] = []
  let strings: string[] = []
  let deferred: Segment[] = []
  let word: string | null = null
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
  const substitute = (inner: string) => {
    const nested: Segment[] = []
    parseInto(inner, nested)
    deferred.push(...nested)
  }
  const append = (piece: string) => { word = (word ?? '') + piece }

  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '$' && text[i + 1] === '(') {
      const end = matchParen(text, i + 1)
      substitute(text.slice(i + 2, end))
      append(EXPANDED)
      i = end + 1
      continue
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      const stop = end === -1 ? text.length : end
      substitute(text.slice(i + 1, stop))
      append(EXPANDED)
      i = stop + 1
      continue
    }
    if (ch === '$' && EXPANSION_START.test(text[i + 1] ?? '')) {
      append(EXPANDED)
      i += 1
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
        if (text[j] === '\\' && j + 1 < text.length && '"\\$`\n'.includes(text[j + 1]!)) {
          if (text[j + 1] !== '\n') buffer += text[j + 1]
          j += 2
          continue
        }
        if (text[j] === '$' && text[j + 1] === '(') {
          const end = matchParen(text, j + 1)
          substitute(text.slice(j + 2, end))
          buffer += EXPANDED
          j = end + 1
          continue
        }
        if (text[j] === '`') {
          const end = text.indexOf('`', j + 1)
          const stop = end === -1 ? text.length : end
          substitute(text.slice(j + 1, stop))
          buffer += EXPANDED
          j = stop + 1
          continue
        }
        if (text[j] === '$' && /[A-Za-z0-9_{@*#?$!-]/.test(text[j + 1] ?? '')) {
          buffer += EXPANDED
          j += 1
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
      if (i + 1 < text.length && text[i + 1] !== '\n') append(text[i + 1]!)
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
        while (i < text.length && /[0-9-]/.test(text[i]!)) i += 1
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

export function splitSegments(command: string): string[] {
  return parseCommand(command).map((segment) => segment.words.join(' ')).filter(Boolean)
}

// ---------------------------------------------------------------------------------------------
// argv resolution

// Wrappers that carry a command without changing what it does: the options that take a
// separate value, and how many positionals precede the wrapped command.
const WRAPPERS: Record<string, { withValue: string[]; positionals: number }> = {
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
// Shell words that only introduce the command after them.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'noglob', 'nocorrect'])
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--list-cmds', '--attr-source'])
const GH_GLOBAL_WITH_VALUE = new Set(['-R', '--repo'])
// Every git subcommand the guard knows. Anything else is an alias it cannot see through, so it asks.
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
  'unpack-objects', 'update-index', 'update-ref', 'update-server-info', 'var', 'verify-commit', 'verify-pack', 'verify-tag', 'filter-repo',
  'version', 'whatchanged', 'worktree', 'write-tree', 'check-ignore'])

function stripWrapper(words: string[], spec: { withValue: string[]; positionals: number }): string[] {
  let rest = words.slice(1)
  while (rest.length > 0 && rest[0]!.startsWith('-')) {
    const option = rest[0]!
    if (option === '--') { rest = rest.slice(1); break }
    const name = option.includes('=') ? option.slice(0, option.indexOf('=')) : option
    if (spec.withValue.includes(name) && !option.includes('=')) rest = rest.slice(2)
    else rest = rest.slice(1)
  }
  let positionals = spec.positionals
  while (positionals > 0 && rest.length > 0) { rest = rest.slice(1); positionals -= 1 }
  return rest
}

// A shell invoked with a `-c` option runs its next positional as a script.
function shellScript(words: string[]): string | null {
  const rest = words.slice(1)
  let script = false
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!
    if (token === '--') { i += 1; return script && rest[i] !== undefined ? rest[i]! : null }
    if (token.startsWith('-')) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(token)) script = true
      if (token === '-o' || token === '+o' || token === '-O' || token === '+O') i += 1
      continue
    }
    return script ? token : null
  }
  return null
}

// Reduces a segment's argv to the command it really runs: assignments and wrappers stripped,
// the head reduced to its basename, git and gh global options removed, inline git aliases
// expanded. `script` is set when the command is a shell running a script string.
// Inline config that can change which hooks run, what a push sends or what a command means.
const RISKY_CONFIG = /^(core\.hookspath|core\.sshcommand|include\.|includeif\.|alias\.|remote\.|push\.|branch\.|url\.)/i
// Environment that points git at other config, another repository or other programs.
const RISKY_ENV = /^(GIT_CONFIG\w*|GIT_DIR|GIT_COMMON_DIR|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY)=/

// env with only -i/-u and assignments before its command.
function plainEnv(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--') return true
    if (arg === '-i' || arg === '--ignore-environment' || arg === '-') continue
    if (arg === '-u' || arg === '--unset') { i += 1; continue }
    if (arg.startsWith('--unset=')) continue
    if (arg.startsWith('-')) return false
    return true
  }
  return true
}

export function resolveWords(input: string[]): { words: string[]; script: string | null; riskyConfig: boolean } {
  let rest = input.filter((word) => typeof word === 'string')
  let head = ''
  // xargs appends arguments nobody can see yet.
  let viaXargs = false
  let riskyConfig = false
  for (let guard = 0; guard < 16 && rest.length > 0; guard += 1) {
    while (rest.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!) || KEYWORDS.has(rest[0]!))) {
      if (RISKY_ENV.test(rest[0]!)) riskyConfig = true
      rest = rest.slice(1)
    }
    if (rest.length === 0) break
    head = basename(rest[0]!)
    if (SHELLS.has(head)) return { words: [head, ...rest.slice(1)], script: shellScript(rest), riskyConfig }
    if (head === 'eval') return { words: rest, script: rest.slice(1).join(' '), riskyConfig }
    // coproc may take a name before its command, and env has platform-specific options that
    // change what runs (-S, -P, -a): the guard cannot read these reliably, so they ask.
    if (head === 'coproc' || (head === 'env' && !plainEnv(rest.slice(1)))) return { words: [EXPANDED], script: null, riskyConfig }
    if (!Object.hasOwn(WRAPPERS, head)) break
    if (head === 'xargs') viaXargs = true
    rest = stripWrapper(rest, WRAPPERS[head]!)
    head = ''
  }
  if (rest.length === 0) return { words: [], script: null, riskyConfig }
  rest = [head, ...rest.slice(1)]
  if (viaXargs) rest.push(EXPANDED)
  if (head === 'git') {
    const aliases: Record<string, string> = {}
    let tail = rest.slice(1)
    while (tail.length > 0 && tail[0]!.startsWith('-')) {
      const option = tail[0]!
      const name = option.includes('=') ? option.slice(0, option.indexOf('=')) : option
      const value = option.includes('=') ? option.slice(option.indexOf('=') + 1) : tail[1]
      // A computed global option could be an alias or another repository: the subcommand is unknown.
      if (expanded(option) || (GIT_GLOBAL_WITH_VALUE.has(name) && !option.includes('=') && expanded(value))) return { words: ['git', EXPANDED], script: null, riskyConfig }
      if ((name === '-c' || name === '--config-env') && (typeof value !== 'string' || RISKY_CONFIG.test(value))) riskyConfig = true
      if (['--git-dir', '--exec-path', '--namespace', '--super-prefix'].includes(name)) riskyConfig = true
      if (name === '-c' && typeof value === 'string') {
        const alias = /^alias\.([^=]+)=(.*)$/.exec(value)
        if (alias) aliases[alias[1]!] = alias[2]!
      }
      tail = GIT_GLOBAL_WITH_VALUE.has(name) && !option.includes('=') ? tail.slice(2) : tail.slice(1)
    }
    if (tail.length > 0 && Object.hasOwn(aliases, tail[0]!)) {
      const expansion = aliases[tail[0]!]!
      tail = expansion.startsWith('!') ? ['!alias', ...tail.slice(1)] : [...expansion.split(/\s+/).filter(Boolean), ...tail.slice(1)]
    }
    rest = ['git', ...tail]
  }
  if (head === 'gh') {
    let tail = rest.slice(1)
    while (tail.length > 0 && tail[0]!.startsWith('-')) {
      const option = tail[0]!
      const name = option.includes('=') ? option.slice(0, option.indexOf('=')) : option
      if (expanded(option)) return { words: ['gh', EXPANDED], script: null, riskyConfig }
      tail = GH_GLOBAL_WITH_VALUE.has(name) && !option.includes('=') ? tail.slice(2) : tail.slice(1)
    }
    rest = ['gh', ...tail]
  }
  return { words: rest, script: null, riskyConfig }
}

// ---------------------------------------------------------------------------------------------
// Classification

const ask = (reason: string, rule: string): Decision => ({ decision: 'ask', reason: `${reason} — run it by hand`, rule })
const ALLOW: Decision = { decision: 'allow', reason: null, rule: 'not-guarded' }
const WORD = "needs the operator's word"

const PUSH_WITH_VALUE = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo'])

// `git push` read as git reads it: the flags, and the positionals [remote, refspec...].
function pushArguments(words: string[]): { flags: string[]; positionals: string[] } {
  const flags: string[] = []
  const positionals: string[] = []
  let rest = words.slice(2)
  while (rest.length > 0) {
    const token = rest[0]!
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

const shortFlag = (flags: string[], letter: string) => flags.some((flag) => /^-[A-Za-z]+$/.test(flag) && flag.includes(letter))

// git accepts any unambiguous prefix of a long option, so `--foll` is `--follow-tags`.
const PUSH_ASK = ['--force', '--force-with-lease', '--force-if-includes', '--follow-tags', '--prune', '--mirror', '--all', '--branches', '--tags', '--delete', '--receive-pack', '--exec']
const pushAsk = (flags: string[]) => flags.find((flag) => flag.startsWith('--') && flag.length > 3 && !flag.startsWith('--no-') && PUSH_ASK.some((name) => name.startsWith(flag))) ?? null

// A long option spelled as any prefix of `--no-verify` that git would accept.
const skipsHooks = (word: string) => word.startsWith('--no-veri') && '--no-verify'.startsWith(word.split('=')[0]!)

// `git commit` options that take the next word as their value.
const COMMIT_WITH_VALUE = new Set(['-m', '-F', '-C', '-c', '-t', '--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--cleanup', '--fixup', '--squash', '--trailer', '--pathspec-from-file'])

// The words of a `git commit` that are not option values (flags and pathspecs).
function commitOptions(words: string[]): string[] {
  const options: string[] = []
  for (let i = 2; i < words.length; i += 1) {
    const token = words[i]!
    options.push(token)
    if (COMMIT_WITH_VALUE.has(token)) { i += 1; continue }
    // A short cluster ending in a value letter (`-am`) takes the next word too.
    if (/^-[A-Za-z]+$/.test(token) && 'mFCct'.includes(token.at(-1)!) && !/[mFCctSu]/.test(token.slice(1, -1))) i += 1
  }
  return options
}

// `git commit -n` (alone or inside a cluster like `-anm`) skips the hooks.
function commitSkipsHooks(words: string[]): boolean {
  for (const token of commitOptions(words)) {
    if (token === '--') return false
    if (!/^-[A-Za-z]/.test(token)) continue
    for (const letter of token.slice(1)) {
      if (letter === 'n') return true
      if ('mFCctSu'.includes(letter)) break
    }
  }
  return false
}

// A fetch refspec with a destination writes that ref locally.
function fetchWritesRefs(words: string[]): boolean {
  let positional = 0
  for (let i = 2; i < words.length; i += 1) {
    const token = words[i]!
    if (token === '--refmap' || token.startsWith('--refmap=')) return true
    if (['--upload-pack', '--depth', '--deepen', '--shallow-since', '--shallow-exclude', '-j', '--jobs', '--negotiation-tip', '--server-option', '-o', '--filter', '--recurse-submodules-default', '--submodule-prefix'].includes(token)) { i += 1; continue }
    if (token.startsWith('-')) continue
    positional += 1
    if (positional === 1) continue
    const colon = token.indexOf(':')
    if (colon !== -1 && token.slice(colon + 1) !== '') return true
  }
  return false
}

// A known git subcommand that writes refs or rewrites history outside the normal verbs.
function refPlumbing(words: string[]): string | null {
  const sub = words[1]
  const args = words.slice(2)
  if (sub === 'update-ref' || sub === 'send-pack' || sub === 'filter-branch' || sub === 'filter-repo') return `git ${sub}`
  if (sub === 'symbolic-ref' && (args.some((arg) => arg === '-d' || arg === '--delete') || args.filter((arg) => !arg.startsWith('-')).length > 1)) return 'git symbolic-ref'
  // With no arguments, or -l, git replace only lists.
  if (sub === 'replace' && args.length > 0 && !args.some((arg) => arg === '-l' || arg === '--list')) return 'git replace'

  if ((sub === 'fetch' || sub === 'pull') && fetchWritesRefs(words)) return `git ${sub} into a named ref`
  return null
}

// gh commands that pass: reads, plus the routine, reversible writes the skills make — opening
// and editing PRs and issues, creating and editing labels (operator's call, 17-09-2026).
// `gh api`, `gh pr merge` and `gh release` have their own rules; closing, deleting,
// commenting and everything else still asks.
const GH_READ_ONLY: Record<string, string[]> = {
  auth: ['status'], pr: ['view', 'list', 'checks', 'diff', 'status', 'create', 'edit'], issue: ['view', 'list', 'status', 'create', 'edit'],
  run: ['view', 'list', 'watch'], repo: ['view'], label: ['list', 'create', 'edit'], project: ['item-list', 'view', 'field-list'],
  release: ['list', 'view', 'download', 'ls'],
}

type Destination = { kind: 'delete' | 'tag' | 'unreadable' | 'branch'; branch: string }

// The branch a refspec lands on, or a marker for what the guard cannot read.
function pushDestination(refspec: string): Destination {
  const spec = refspec.startsWith('+') ? refspec.slice(1) : refspec
  const colon = spec.indexOf(':')
  const source = colon === -1 ? spec : spec.slice(0, colon)
  const destination = colon === -1 ? spec : spec.slice(colon + 1)
  if (colon !== -1 && source === '') return { kind: 'delete', branch: destination.replace(/^refs\/heads\//, '') }
  if (destination.startsWith('refs/tags/')) return { kind: 'tag', branch: destination }
  const branch = destination.replace(/^refs\/heads\//, '')
  if (branch === '' || branch === 'HEAD' || branch === '@' || /[~^*?[\\]|@\{|\.\.|:/.test(branch) || branch.startsWith('refs/') || branch.startsWith('-')) return { kind: 'unreadable', branch }
  return { kind: 'branch', branch }
}

// Text handed to node, python, ssh or a file only gets this probe, and a hit asks.
const FAMILY_VERBS = ['git push', 'gh pr merge', 'gh api', 'gh release', 'npm publish', 'pnpm publish', 'yarn publish', 'bun publish', 'git tag', 'git reset', 'git branch -D', 'release create', 'git worktree remove']

function familyProbe(text: string, extra: string[]): string | null {
  const verbs = [...FAMILY_VERBS, ...extra.map((command) => command.split(/\s+/).slice(0, 2).join(' ')).filter((verb) => verb.includes(' '))]
  return verbs.find((verb) => {
    const index = text.indexOf(verb)
    if (index === -1) return false
    const before = index === 0 ? '' : text[index - 1]!
    const after = text[index + verb.length] ?? ''
    return !/[\w-]/.test(before) && !/[\w-]/.test(after)
  }) ?? null
}

const READ_ONLY_RELEASE = new Set(['list', 'view', 'download', 'ls'])
// Subcommands whose arguments decide whether something ships or is destroyed.
const GUARDED_GIT = new Set(['push', 'tag', 'reset', 'branch', 'worktree', 'update-ref', 'send-pack', 'symbolic-ref', 'fetch', 'pull', 'replace'])
const guardedGh = (words: string[]) => ['api', 'release'].includes(words[1]!) || (['pr', 'issue'].includes(words[1]!) && ['merge', 'comment'].includes(words[2]!))
const PUBLISHERS = ['npm', 'pnpm', 'yarn', 'bun']

// Shell expansion can spell a guarded command the parser never sees, so a computed command
// name, or a computed argument to a guarded command, asks.
function expansionRisk(words: string[]): Decision | null {
  const risky = ask(`a command built by shell expansion cannot be classified, so it ${WORD}`, 'unclassified')
  if (expanded(words[0])) return risky
  if (words[0] === 'git' && (expanded(words[1]) || (GUARDED_GIT.has(words[1]!) && words.slice(2).some(expanded)))) return risky
  // A computed commit message is fine; a computed option could be `-n`.
  if (words[0] === 'git' && words[1] === 'commit' && commitOptions(words).some(expanded)) return risky
  if (words[0] === 'gh' && (expanded(words[1]) || expanded(words[2]) || (guardedGh(words) && words.slice(2).some(expanded)))) return risky
  if (PUBLISHERS.includes(words[0]!) && expanded(words[1])) return risky
  return null
}

const GH_API_WITH_VALUE = new Set(['-q', '--jq', '-t', '--template', '--cache', '--hostname', '-p', '--preview'])
const GH_API_FIELDS = new Set(['-f', '-F', '--field', '--raw-field'])

// `gh api`: a GET is a read; any other method, a body, or a GraphQL mutation asks.
function ghApi(words: string[]): Decision | null {
  const args = words.slice(2)
  let method: string | null = null
  let endpoint: string | null = null
  let body = false
  let override = false
  const fields: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!
    const name = token.startsWith('--') && token.includes('=') ? token.slice(0, token.indexOf('=')) : token
    const inline = name !== token ? token.slice(name.length + 1) : null
    if (name === '-X' || name === '--method') method = inline ?? args[++i] ?? ''
    else if (/^-X./.test(token)) method = token.slice(2)
    else if (GH_API_FIELDS.has(name)) fields.push(inline ?? args[++i] ?? '')
    else if (/^-[fF]./.test(token)) fields.push(token.slice(2))
    else if (name === '--input') { body = true; if (inline === null) i += 1 }
    else if (name === '-H' || name === '--header') { if (/method-override/i.test(inline ?? args[++i] ?? '')) override = true }
    else if (GH_API_WITH_VALUE.has(name)) { if (inline === null) i += 1 }
    else if (token.startsWith('-')) continue
    else endpoint ??= token
  }
  const unreadable = ask(`a \`gh api\` call the guard cannot read ${WORD}`, 'unclassified')
  if (endpoint === null || expanded(endpoint) || (method !== null && expanded(method))) return unreadable
  const verb = (method ?? (fields.length || body ? 'POST' : 'GET')).toUpperCase()
  if (/(^|\/)graphql$/.test(endpoint)) {
    if (body || override || (method !== null && verb !== 'POST' && verb !== 'GET')) return unreadable
    if (fields.some((field) => expanded(field) || /^[^=]*=@/.test(field))) return unreadable
    if (fields.some((field) => /\bmutation\b/i.test(field))) return ask(`a GraphQL mutation can merge, release or delete, so it ${WORD}`, 'always-ask')
    return null
  }
  if (/pulls\/\d+\/merge(\/|$)/.test(endpoint) && (verb !== 'GET' || override)) return ask(`merging to the default branch ${WORD}`, 'default-branch')
  if (verb !== 'GET' || override) return ask(`a \`gh api\` ${verb} call changes GitHub, which ${WORD}`, 'always-ask')
  return null
}

const flagValue = (args: string[], flag: string): string | null => {
  let value: string | null = null
  for (let i = 0; i < args.length; i += 1) if (args[i] === flag) value = args[i + 1] ?? ''
  return value
}

// `vegafactory issue …`: the verbs that would let a session authorise itself.
function issueVerb(words: string[]): Decision | null {
  const at = words.findIndex((word, index) => index > 0 && word === 'issue')
  if (words[0] === 'gh' || at === -1) return null
  const verb = words[at + 1]
  const args = words.slice(at + 2)
  if (expanded(verb) || ((verb === 'ack' || verb === 'claim') && args.some(expanded))) return ask(`an issue command built by shell expansion ${WORD}`, 'unclassified')
  if (verb === 'ack') {
    if (args.some((arg) => /^--(stage|source)=/.test(arg))) return ask(`an ack the guard cannot read ${WORD}`, 'unclassified')
    const stage = flagValue(args, '--stage')
    const source = flagValue(args, '--source') ?? 'session'
    if (stage !== 'brief' && stage !== 'plan') return ask(`recording "ship it" ${WORD}`, 'always-ask')
    if (!/^comment:\d+$/.test(source)) return ask(`an ack recorded from this session ${WORD}`, 'always-ask')
  }
  if (verb === 'claim' && args.some((arg) => arg.startsWith('--take-back-by'))) return ask(`taking an issue back from another session ${WORD}`, 'always-ask')
  return null
}

// `vegafactory worktree`: remove refuses unmerged work itself; --force and prune need the word.
function worktreeVerb(words: string[]): Decision | null {
  const at = words.findIndex((word, index) => index > 0 && word === 'worktree')
  if (words[0] === 'git' || at === -1) return null
  const verb = words[at + 1]
  const args = words.slice(at + 2)
  if (expanded(verb) || ((verb === 'remove' || verb === 'prune') && args.some(expanded))) return ask(`a worktree command built by shell expansion ${WORD}`, 'unclassified')
  if (verb === 'remove' && args.some((arg) => arg.startsWith('--force') || arg === '-f')) return ask(`removing an unmerged worktree ${WORD}`, 'always-ask')
  if (verb === 'prune' && !args.includes('--dry-run')) return ask(`pruning worktrees ${WORD} — preview with --dry-run`, 'always-ask')
  return null
}

function classifyResolved(segment: Segment, words: string[], policy: Policy, mergeCheck?: MergeCheck, riskyConfig = false): Decision {
  if (words.length === 0) return ALLOW
  const risk = expansionRisk(words) ?? issueVerb(words) ?? worktreeVerb(words)
  if (risk) return risk
  const text = words.join(' ')
  const asWritten = [segment.words[0] ?? '', ...words.slice(1)].join(' ')

  // Always ask, with the flag in any position.
  if (words.some(skipsHooks)) return ask(`skipping the commit checks ${WORD}`, 'always-ask')
  if (words[0] === 'git') {
    const sub = words[1]
    if (sub === 'commit' && commitSkipsHooks(words)) return ask(`skipping the commit checks (\`-n\`) ${WORD}`, 'always-ask')
    if (riskyConfig && ['commit', 'merge', 'rebase', 'cherry-pick', 'am', 'pull', 'revert', 'push', 'fetch'].includes(sub!)) {
      return ask(`git ${sub} with inline config or environment that can change its hooks or target ${WORD}`, 'always-ask')
    }
    const plumbing = refPlumbing(words)
    if (plumbing) return ask(`${plumbing} writes refs directly, which ${WORD}`, 'always-ask')
    if (sub === 'push') {
      const { flags, positionals } = pushArguments(words)
      const refspecs = positionals.slice(1)
      if (flags.includes('--force') || shortFlag(flags, 'f') || refspecs.some((spec) => spec.startsWith('+'))) return ask(`a force push ${WORD}`, 'always-ask')
      if (flags.includes('--delete') || shortFlag(flags, 'd') || refspecs.map(pushDestination).some((d) => d.kind === 'delete')) {
        return ask(`deleting a remote branch ${WORD}`, 'always-ask')
      }
    }
    if (sub === 'reset' && words.includes('--hard')) return ask(`a hard reset ${WORD}`, 'always-ask')
    if (sub === 'branch') {
      const flags = words.slice(2).filter((word) => word.startsWith('-'))
      if (flags.includes('--delete') || shortFlag(flags, 'd') || shortFlag(flags, 'D')) return ask(`deleting a branch ${WORD}`, 'always-ask')
    }
    if (sub === 'worktree' && words[2] === 'remove') return ask(`removing a worktree ${WORD}`, 'always-ask')
    if (sub === 'tag') return ask(`tagging a release ${WORD}`, 'always-ask')
  }
  if (words[0] === 'gh') {
    if (words[1] === 'pr' && words[2] === 'merge') {
      // --admin in any spelling, or another repository, is never covered by a recorded "ship it".
      const unsafe = words.some((word) => /^--admin(=|$)/.test(word)) || segment.words.some((word) => /^(-R|--repo)(=|$)|^-R./.test(word))
      if (!unsafe && mergeCheck?.(words, segment.words)) return { decision: 'allow', reason: null, rule: 'ship-it-recorded' }
      return ask(`merging to the default branch ${WORD}`, 'default-branch')
    }
    if (words[1] === 'api') {
      const api = ghApi(words)
      if (api) return api
    }
    // A raw comment can carry a workflow marker (an ack, a claim); `vegafactory issue comment` refuses those.
    if ((words[1] === 'issue' || words[1] === 'pr') && words[2] === 'comment') return ask(`a raw GitHub comment ${WORD} — use vegafactory issue comment`, 'always-ask')
    if (words[1] === 'release' && !READ_ONLY_RELEASE.has(words[2] ?? '')) return ask(`changing a release ${WORD}`, 'always-ask')
    // Aliases and extensions can run anything, and most other commands write to GitHub.
    const verb = words[1] ?? ''
    const known = ['version', 'help', '--version', '--help', '-h', ''].includes(verb) || verb === 'api' || GH_READ_ONLY[verb]?.includes(words[2] ?? '')
    if (!known) return ask(`\`gh ${[verb, words[2]].filter(Boolean).join(' ')}\` is not on the guard's read-only list, so it ${WORD}`, 'unclassified')
  }
  if (PUBLISHERS.includes(words[0]!) && words[1] === 'publish') return ask(`publishing ${WORD}`, 'always-ask')

  if (words[0] === 'git') {
    const sub = words[1]
    if (sub === 'push') {
      const { flags, positionals } = pushArguments(words)
      if (flags.includes('--all') || flags.includes('--mirror')) return ask(`pushing every branch reaches ${policy.defaultBranch ?? 'the default branch'}, which ${WORD}`, 'default-branch')
      if (flags.includes('--tags')) return ask(`pushing tags publishes a release, which ${WORD}`, 'always-ask')
      const risky = pushAsk(flags)
      if (risky) return ask(`\`git push ${risky}\` ${WORD}`, 'always-ask')
      const refspecs = positionals.slice(1)
      const destinations = refspecs.map(pushDestination)
      // `git push origin v1.2.0` pushes the tag of that name: git resolves a bare source as a tag too.
      const sources = refspecs.map((spec) => spec.replace(/^\+/, '').split(':')[0]!)
      if (destinations.some((d) => d.kind === 'tag' || isTag(d.branch, policy.tags)) || sources.some((name) => isTag(name, policy.tags))) return ask(`pushing a tag publishes a release, which ${WORD}`, 'always-ask')
      if (destinations.length === 0 || destinations.some((d) => d.kind === 'unreadable')) return ask(`a push whose branch the guard cannot read ${WORD}`, 'unclassified')
      if (policy.defaultBranch === null) return ask(`a push whose target the guard cannot check (no default branch on origin) ${WORD}`, 'unclassified')
      if (destinations.some((d) => d.branch === policy.defaultBranch)) return ask(`pushing to ${policy.defaultBranch} ${WORD}`, 'default-branch')
      return { decision: 'allow', reason: null, rule: 'branch-push' }
    }
    if (sub !== undefined && !sub.startsWith('-') && !GIT_SUBCOMMANDS.has(sub)) {
      return ask(`git ${sub} is not a subcommand the guard knows — an alias it cannot see through ${WORD}`, 'unclassified')
    }
  }
  for (const pattern of policy.shipAsk) {
    if (text.startsWith(pattern) || asWritten.startsWith(pattern)) return ask(`\`${pattern}\` is an ask: step in dev.md's Ship section and ${WORD}`, 'ship-ask')
  }
  // Fail closed: it looks like publishing, and nothing above said what it is.
  if (words.some((word) => /^publish(:|$)/.test(word)) || words.some((word, index) => word === 'release' && words[index + 1] === 'create')) {
    return ask(`this looks like publishing, which ${WORD}`, 'unclassified')
  }
  return ALLOW
}

// The commands `find -exec` runs, with the found path standing in as an expansion.
function findCommands(words: string[]): string[][] {
  const commands: string[][] = []
  for (let i = 1; i < words.length; i += 1) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(words[i]!)) continue
    const end = words.findIndex((word, index) => index > i && (word === ';' || word === '+'))
    commands.push([...words.slice(i + 1, end === -1 ? words.length : end), EXPANDED])
    i = end === -1 ? words.length : end
  }
  return commands
}

export function classifySegment(segment: Segment, policy: Policy, mergeCheck?: MergeCheck): Decision {
  if (segment.words.length === 0) return ALLOW
  const resolved = resolveWords(segment.words)
  if (resolved.script !== null) return classifyCommand(resolved.script, policy, mergeCheck)
  if (['export', 'declare', 'typeset', 'setenv'].includes(resolved.words[0]!) && resolved.words.slice(1).some((word) => RISKY_ENV.test(word) || /^GIT_CONFIG\w*$/.test(word))) {
    return ask(`pointing git at other config or another repository ${WORD}`, 'always-ask')
  }
  if (resolved.words[0] === 'find') {
    for (const words of findCommands(resolved.words)) {
      const inner = classifySegment({ words, redirects: [], strings: [] }, policy)
      if (inner.decision === 'ask') return inner
    }
  }
  const result = classifyResolved(segment, resolved.words, policy, mergeCheck, resolved.riskyConfig)
  if (result.decision === 'ask' || (resolved.words[0] === 'git' && resolved.words[1] === 'commit')) return result
  for (const string of segment.strings) {
    const verb = familyProbe(string, policy.shipAsk)
    if (verb) return ask(`text handed to another program carries \`${verb}\`, which the guard cannot classify, so it ${WORD}`, 'unclassified')
  }
  return result
}

// ---------------------------------------------------------------------------------------------
// Commit capability — for attribution, never for permission

// Git subcommands that can leave a new commit at HEAD, including the ones that reach one by
// finishing a merge or replaying somebody else's work.
const GIT_COMMITTING = new Set(['commit', 'commit-tree', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'pull', 'citool',
  // These rewrite or import history, so they also leave HEAD on a commit this session made.
  'fast-import', 'filter-branch', 'filter-repo', 'subtree', 'quiltimport'])
// Commands that plainly cannot commit. Everything not named here is assumed able to, because a
// wrapper, a script or a task runner can commit without saying so anywhere the parser can read.
const INERT = new Set([
  'sleep', 'ls', 'cat', 'echo', 'printf', 'pwd', 'true', 'false', 'test', '[', ':', 'head', 'tail', 'wc',
  'which', 'type', 'date', 'whoami', 'hostname', 'uname', 'basename', 'dirname', 'realpath', 'readlink',
  'stat', 'file', 'grep', 'rg', 'ag', 'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'diff', 'cmp', 'du', 'df', 'tree', 'wait',
])

// Could this command have created the commit now at HEAD? Attribution only: it decides which
// session's tool window may own a commit, never whether a command may run. Unknown means yes, so
// an unreadable command contends for a commit rather than letting a neighbour take credit for it.
export function canCommit(command: unknown): boolean {
  if (typeof command !== 'string') return true
  return parseCommand(command).some(segmentCanCommit)
}

function segmentCanCommit(segment: Segment): boolean {
  if (segment.words.length === 0) return false
  const resolved = resolveWords(segment.words)
  if (resolved.script !== null) return canCommit(resolved.script)
  const words = resolved.words
  const head = words[0]
  if (head === undefined || head === '') return false
  if (expanded(head)) return true
  if (head === 'find') return findCommands(words).some((inner) => segmentCanCommit({ words: inner, redirects: [], strings: [] }))
  if (head !== 'git') return !INERT.has(head)
  const sub = words[1]
  // An alias or a computed subcommand is a subcommand the parser cannot read.
  if (sub === undefined || expanded(sub) || !GIT_SUBCOMMANDS.has(sub)) return true
  if (GIT_COMMITTING.has(sub)) return true
  // Restoring a stash can end in a merge, and a patch applied to the index is a commit away.
  if (sub === 'stash') return words.slice(2).some((word) => word === 'pop' || word === 'apply' || word === 'branch')
  if (sub === 'apply') return words.includes('--index') || words.includes('--cached')
  return false
}

export function classifyCommand(command: unknown, policy: Policy, mergeCheck?: MergeCheck): Decision {
  if (typeof command !== 'string') return ALLOW
  let allowed = ALLOW
  for (const segment of parseCommand(command)) {
    const result = classifySegment(segment, policy, mergeCheck)
    if (result.decision === 'ask') return result
    if (allowed.rule === 'not-guarded') allowed = result
  }
  return allowed
}

// ---------------------------------------------------------------------------------------------
// Harness payloads

const shellQuote = (part: string) => (/^[A-Za-z0-9_/.:=@%+,-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`)

// Tools that never run a shell command, whatever their payload holds (apply_patch carries the patch in `command`).
const NOT_SHELL = new Set(['apply_patch', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite'])

// A tool that may run a command; the guard asks when it cannot read one from its payload.
export function isShellTool(name: string): boolean {
  if (NOT_SHELL.has(name)) return false
  const last = name.split('__').at(-1) ?? name
  if (/^(read|list|get)_/.test(last)) return false
  return /bash|shell|terminal|(^|[_.])exec($|[_.])|command/i.test(last)
}

// Claude's Bash and Codex's shell tools put the command at tool_input.command; Codex's
// exec_command uses tool_input.cmd; either may be a string or an argv array.
export function extractCommand(payload: unknown): string | null {
  const record = payload && typeof payload === 'object' ? payload as { tool_name?: unknown; tool_input?: unknown } : {}
  if (typeof record.tool_name === 'string' && NOT_SHELL.has(record.tool_name)) return null
  const input = record.tool_input
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return null
  for (const key of ['command', 'cmd']) {
    const command = (input as Record<string, unknown>)[key]
    if (typeof command === 'string') return command
    if (Array.isArray(command) && command.length && command.every((part) => typeof part === 'string')) return command.map(shellQuote).join(' ')
  }
  return null
}

// The PR number or branch `gh pr merge` names; null when it names the current branch's PR.
export function mergeTarget(words: string[]): string | null {
  const WITH_VALUE = new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit'])
  const rest = words.slice(3)
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!
    if (token.startsWith('-')) { if (WITH_VALUE.has(token)) i++; continue }
    return token
  }
  return null
}
