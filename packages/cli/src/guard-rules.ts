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
export interface Policy { defaultBranch: string | null; shipAsk: string[] }
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
  return { defaultBranch: branch, shipAsk: devMd ? shipAskCommands(devMd) : [] }
}

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
        if (text[j] === '\\' && j + 1 < text.length && '"\\$`\n'.includes(text[j + 1]!)) {
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
  'unpack-objects', 'update-index', 'update-ref', 'update-server-info', 'var', 'verify-commit', 'verify-pack', 'verify-tag',
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
export function resolveWords(input: string[]): { words: string[]; script: string | null } {
  let rest = input.filter((word) => typeof word === 'string')
  let head = ''
  for (let guard = 0; guard < 16 && rest.length > 0; guard += 1) {
    while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!)) rest = rest.slice(1)
    if (rest.length === 0) break
    head = basename(rest[0]!)
    if (SHELLS.has(head)) return { words: [head, ...rest.slice(1)], script: shellScript(rest) }
    if (!Object.hasOwn(WRAPPERS, head)) break
    rest = stripWrapper(rest, WRAPPERS[head]!)
    head = ''
  }
  if (rest.length === 0) return { words: [], script: null }
  rest = [head, ...rest.slice(1)]
  if (head === 'git') {
    const aliases: Record<string, string> = {}
    let tail = rest.slice(1)
    while (tail.length > 0 && tail[0]!.startsWith('-')) {
      const option = tail[0]!
      const name = option.includes('=') ? option.slice(0, option.indexOf('=')) : option
      const value = option.includes('=') ? option.slice(option.indexOf('=') + 1) : tail[1]
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
      tail = GH_GLOBAL_WITH_VALUE.has(name) && !option.includes('=') ? tail.slice(2) : tail.slice(1)
    }
    rest = ['gh', ...tail]
  }
  return { words: rest, script: null }
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
  if (branch === '' || branch === 'HEAD' || branch === '@' || /[~^]/.test(branch) || branch.startsWith('refs/')) return { kind: 'unreadable', branch }
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

function classifyResolved(segment: Segment, words: string[], policy: Policy, mergeCheck?: MergeCheck): Decision {
  if (words.length === 0) return ALLOW
  const text = words.join(' ')
  const asWritten = [segment.words[0] ?? '', ...words.slice(1)].join(' ')

  // Always ask, with the flag in any position.
  if (words.includes('--no-verify')) return ask(`skipping the commit checks ${WORD}`, 'always-ask')
  if (words[0] === 'git') {
    const sub = words[1]
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
      if (mergeCheck?.(words, segment.words)) return { decision: 'allow', reason: null, rule: 'ship-it-recorded' }
      return ask(`merging to the default branch ${WORD}`, 'default-branch')
    }
    if (words[1] === 'api' && words.some((word) => /pulls\/\d+\/merge(\/|$)/.test(word))) return ask(`merging to the default branch ${WORD}`, 'default-branch')
    if (words[1] === 'release' && !READ_ONLY_RELEASE.has(words[2] ?? '')) return ask(`changing a release ${WORD}`, 'always-ask')
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(words[0]!) && words[1] === 'publish') return ask(`publishing ${WORD}`, 'always-ask')

  if (words[0] === 'git') {
    const sub = words[1]
    if (sub === 'push') {
      const { flags, positionals } = pushArguments(words)
      if (flags.includes('--all') || flags.includes('--mirror')) return ask(`pushing every branch reaches ${policy.defaultBranch ?? 'the default branch'}, which ${WORD}`, 'default-branch')
      if (flags.includes('--tags')) return ask(`pushing tags publishes a release, which ${WORD}`, 'always-ask')
      const destinations = positionals.slice(1).map(pushDestination)
      if (destinations.some((d) => d.kind === 'tag')) return ask(`pushing a tag publishes a release, which ${WORD}`, 'always-ask')
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

export function classifySegment(segment: Segment, policy: Policy, mergeCheck?: MergeCheck): Decision {
  if (segment.words.length === 0) return ALLOW
  const resolved = resolveWords(segment.words)
  if (resolved.script !== null) return classifyCommand(resolved.script, policy, mergeCheck)
  const result = classifyResolved(segment, resolved.words, policy, mergeCheck)
  if (result.decision === 'ask' || (resolved.words[0] === 'git' && resolved.words[1] === 'commit')) return result
  for (const string of segment.strings) {
    const verb = familyProbe(string, policy.shipAsk)
    if (verb) return ask(`text handed to another program carries \`${verb}\`, which the guard cannot classify, so it ${WORD}`, 'unclassified')
  }
  return result
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

// Claude puts the shell command at tool_input.command; Codex may send the argv array or the
// string itself. Any other shape is a tool that runs no shell command.
export function extractCommand(payload: unknown): string | null {
  const input = payload && typeof payload === 'object' ? (payload as { tool_input?: unknown }).tool_input : null
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return null
  const command = (input as { command?: unknown }).command
  if (typeof command === 'string') return command
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) return command.map(shellQuote).join(' ')
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
