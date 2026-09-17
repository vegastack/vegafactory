// `vegafactory review <n>` — cross-tool review. The other tool (Codex for Claude's work, Claude
// for Codex's) reads the worktree read-only and returns findings as JSON; this command posts the
// one review comment. Fix rounds resume the same reviewer session with only the fix diff.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { machineName } from './claim.ts'
import { childEnvironment } from './env.ts'
import { defaultRunner, ghRequest, type GhRunner } from './gh.ts'
import { defaultBranch } from './guard-rules.ts'
import { assertRepo, readBody, syncIssue } from './issue-cache.ts'
import { detectRepo, latestOfType, markerKeys, repoRoot, runIssue, snapshot, type Snapshot } from './issue.ts'

export type Reviewer = 'claude' | 'codex'
export const AXES = ['spec', 'bugs', 'security', 'style'] as const
export const SEVERITIES = ['must-fix', 'should-fix', 'nit'] as const
export interface Finding { id: string; axis: typeof AXES[number]; severity: typeof SEVERITIES[number]; file: string; line: number; issue: string; fix: string }
export interface ReviewResult { verdict: 'clean' | 'needs-fixes'; findings: Finding[] }
interface Group { key: string; axes: string[]; prefix: string }
interface Session { group: Group; id: string | null }
export interface ReviewState {
  schema: 1
  repo: string
  issue: number
  reviewer: Reviewer
  machine: string
  round: number
  base: string
  head: string
  sessions: Session[]
  open: string[]
  verdict: ReviewResult['verdict']
  findings: Finding[]
}

export const MAX_ROUNDS = 3
export const REVIEW_TIMEOUT_MS = 60 * 60_000
const BIG_LINES = 800
const BIG_FILES = 15

export const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['clean', 'needs-fixes'] },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'axis', 'severity', 'file', 'line', 'issue', 'fix'],
        properties: {
          id: { type: 'string' }, axis: { type: 'string', enum: [...AXES] }, severity: { type: 'string', enum: [...SEVERITIES] },
          file: { type: 'string' }, line: { type: 'integer' }, issue: { type: 'string' }, fix: { type: 'string' },
        },
      },
    },
  },
}

export function reviewUsage(): string {
  return `Usage: vegafactory review <n> [--base REF] [--reviewer claude|codex] [--resume] [--json] [--dry-run]

Runs the other tool read-only in this worktree on issue n's diff and posts one review comment.
  --base REF           diff base (default: origin/<default branch>; later rounds keep the first base)
  --reviewer TOOL      claude or codex (default: the tool this command is not running inside)
  --resume             require resuming this machine's reviewer session (automatic when one exists)
  --dry-run            print the packet and the exact command without running anything
  --json               machine-readable result

A fix round sends only the fix diff and the open finding ids. At most ${MAX_ROUNDS} rounds.
Exit 0 clean · 2 needs fixes or hand-back · 1 error.`
}

// ---------------------------------------------------------------------------------------------
// Facts from the environment, git and dev.md

// The implementer's tool, read from the markers each harness sets for the commands it runs.
export function detectReviewer(env: NodeJS.ProcessEnv): Reviewer | null {
  const inClaude = Boolean(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT)
  const inCodex = Boolean(env.CODEX_THREAD_ID || env.CODEX_SANDBOX)
  if (inClaude === inCodex) return null
  return inClaude ? 'codex' : 'claude'
}

// `review <agent> <model> <effort>` from dev.md's harness-policy line, used only when it names the reviewer.
export function reviewPolicy(devMd: string, reviewer: Reviewer): { model: string; effort: string } | null {
  const line = /^harness-policy:\s*(.*)$/m.exec(devMd)?.[1]?.replace(/\s+#.*$/, '') ?? ''
  for (const segment of line.split('·')) {
    const [stage, agent, model, effort] = segment.trim().split(/\s+/)
    if (stage === 'review' && agent === reviewer && model && effort) return { model, effort }
  }
  return null
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim().split('\n')[0]}`)
  return result.stdout
}

export interface DiffFacts { stat: string; files: string[]; diff: string; lines: number }

export function diffFacts(cwd: string, range: string): DiffFacts {
  const numstat = git(cwd, ['diff', '--numstat', '--no-color', range]).split('\n').filter(Boolean)
  const lines = numstat.reduce((sum, row) => sum + row.split('\t').slice(0, 2).reduce((n, v) => n + (Number(v) || 0), 0), 0)
  return {
    stat: git(cwd, ['diff', '--stat', '--no-color', range]).trimEnd(),
    files: git(cwd, ['diff', '--name-only', '--no-color', range]).split('\n').filter(Boolean),
    diff: git(cwd, ['diff', '-U5', '--no-color', '--no-ext-diff', range]).trimEnd(),
    lines,
  }
}

// The section under a heading whose title matches, up to the next heading of the same or higher level.
export function section(markdown: string, title: RegExp): string | null {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => /^#{2,4}\s/.test(line) && title.test(line.replace(/^#+\s+/, '')))
  if (start === -1) return null
  const level = /^#+/.exec(lines[start]!)![0].length
  const end = lines.findIndex((line, i) => i > start && /^#+\s/.test(line) && /^#+/.exec(line)![0].length <= level)
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim()
}

const ACCEPTANCE = /^(done when|acceptance|tests and acceptance)\b/i
const TASKS = /^tasks\b/i

export function acceptanceCriteria(brief: string): string {
  return section(brief, ACCEPTANCE) ?? `(the brief has no Done when / acceptance section — the whole brief follows)\n\n${brief.trim()}`
}

export function taskList(snap: Snapshot, brief: string): string {
  const plan = latestOfType(snap, 'plan')
  const text = plan ? snap.body(plan) : brief
  return section(text, TASKS) ?? (plan ? text.trim() : '(no plan tasks found)')
}

// ---------------------------------------------------------------------------------------------
// The packet and the command lines

const AXIS_TEXT: Record<string, string> = {
  spec: 'spec — the diff against the acceptance criteria and plan tasks: missing, wrong, or unasked-for behaviour; tests that cannot fail',
  bugs: 'bugs — correctness, edge cases, error handling, races, leaks',
  security: 'security — untrusted input, injection, auth, secrets, unsafe file or process use; judge exploitability before severity',
  style: 'style — only where a documented project rule (AGENTS.md, CONTRIBUTING.md, .vegastack/dev.md, known patterns) says so',
}

function rules(group: Group, knownPatterns: string | null): string {
  return [
    '## Rules',
    '- Read-only: never edit files, never run commands that write, commit, push or touch GitHub. The CLI posts your review.',
    '- No read limit: read any file in this worktree you need, whole files where a hunk needs context.',
    `- Axes for this run:\n${group.axes.map((axis) => `  - ${AXIS_TEXT[axis]}`).join('\n')}`,
    '- Verify each finding in the code before you report it. Report every verified finding; no praise.',
    '- Severity: must-fix (wrong, broken, insecure, or contradicts the acceptance criteria) · should-fix · nit.',
    `- Return ONLY JSON matching the given schema. verdict is "clean" when no must-fix finding remains, else "needs-fixes". Finding ids are ${group.prefix}1, ${group.prefix}2, …; file is repo-relative; line is 0 when the finding has no single line.`,
    ...(knownPatterns ? ['', '## Known patterns (never flag these unless their "Still flag if" applies)', knownPatterns.trim()] : []),
  ].join('\n')
}

export interface PacketInput {
  number: number
  title: string
  repo: string
  branch: string
  base: string
  head: string
  acceptance: string
  tasks: string
  facts: DiffFacts
  previous: Finding[] | null
  knownPatterns: string | null
}

export function freshPrompt(input: PacketInput, group: Group): string {
  const { facts } = input
  return [
    `You are reviewing finished work on issue #${input.number} (${input.title}) in ${input.repo}, branch ${input.branch}, range ${input.base}...${input.head.slice(0, 7)}. Another tool wrote it; you share no memory with it.`,
    '',
    rules(group, input.knownPatterns),
    '',
    '## Acceptance criteria', input.acceptance,
    '',
    '## Plan tasks', input.tasks,
    ...(input.previous ? ['', '## Findings from the previous round (another session) — re-check each; keep the id of any that remains', '```json', JSON.stringify(input.previous, null, 2), '```'] : []),
    '',
    '## Diff stat', '```', facts.stat, '```',
    '',
    '## Changed files', ...facts.files.map((file) => `- ${file}`),
    '',
    `## Diff (git diff -U5 ${input.base}...HEAD)`, '```diff', facts.diff, '```',
  ].join('\n')
}

export function resumePrompt(input: { round: number; from: string; head: string; open: string[]; facts: DiffFacts }): string {
  return [
    `Fix round ${input.round}. The implementer committed fixes since your last review (${input.from.slice(0, 7)}..${input.head.slice(0, 7)}).`,
    `Open findings from your last round: ${input.open.length ? input.open.join(', ') : 'none'}.`,
    'Re-check each open finding against the current code: leave out the ones now fixed, keep the id of any that remains.',
    'Review the fix diff below for new problems on your axes; new ids continue after the highest id you used.',
    'Same rules as before: read-only, no read limit, verify each finding, return ONLY JSON matching the schema, listing every finding still open.',
    '',
    '## Fix diff stat', '```', input.facts.stat, '```',
    '',
    `## Fix diff (git diff -U5 ${input.from.slice(0, 7)}..HEAD)`, '```diff', input.facts.diff, '```',
  ].join('\n')
}

export function reviewerArgs(reviewer: Reviewer, options: { schemaPath: string; outPath: string; session: string | null; policy: { model: string; effort: string } | null }): string[] {
  const { schemaPath, outPath, session, policy } = options
  if (reviewer === 'codex') {
    const model = policy ? ['-c', `model=${policy.model}`, '-c', `model_reasoning_effort=${policy.effort}`] : []
    // `exec resume` has no --sandbox flag; the config key keeps the resumed run read-only.
    const head = session ? ['exec', 'resume', '-c', 'sandbox_mode=read-only'] : ['exec', '-s', 'read-only']
    return [...head, ...model, '--output-schema', schemaPath, '-o', outPath, ...(session ? [session] : []), '-']
  }
  // --tools takes a list, so the next flag must follow it; the prompt goes on stdin.
  return ['-p', ...(session ? ['--resume', session] : []), '--tools', 'Read,Grep,Glob', '--output-format', 'json',
    '--json-schema', JSON.stringify(REVIEW_SCHEMA), ...(policy ? ['--model', policy.model, '--effort', policy.effort] : [])]
}

// ---------------------------------------------------------------------------------------------
// Running the reviewer

export function validateReview(value: unknown): ReviewResult | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'the reply is not a JSON object'
  const { verdict, findings } = value as Record<string, unknown>
  if (verdict !== 'clean' && verdict !== 'needs-fixes') return 'verdict must be "clean" or "needs-fixes"'
  if (!Array.isArray(findings)) return 'findings must be a list'
  for (const [i, f] of findings.entries()) {
    const item = f as Record<string, unknown>
    if (!item || typeof item !== 'object') return `finding ${i} is not an object`
    for (const key of ['id', 'file', 'issue', 'fix']) if (typeof item[key] !== 'string') return `finding ${i} needs a string ${key}`
    if (!(item.id as string).trim()) return `finding ${i} has an empty id`
    if (!(AXES as readonly unknown[]).includes(item.axis)) return `finding ${i} has an unknown axis`
    if (!(SEVERITIES as readonly unknown[]).includes(item.severity)) return `finding ${i} has an unknown severity`
    if (!Number.isInteger(item.line) || (item.line as number) < 0) return `finding ${i} needs a whole-number line`
  }
  return { verdict, findings: findings as Finding[] }
}

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\n([\s\S]*)\n```$/, '$1')
  try { return JSON.parse(trimmed) } catch { return undefined }
}

interface RunOutcome { ok: true; result: ReviewResult; session: string | null }
interface RunFailure { ok: false; reason: string }

// Parses one finished run of either tool.
export function readRun(reviewer: Reviewer, stdout: string, stderr: string, outPath: string): RunOutcome | RunFailure {
  let reply: unknown
  let session: string | null
  if (reviewer === 'codex') {
    session = /session id:\s*([0-9a-z-]{8,})/i.exec(stderr + '\n' + stdout)?.[1] ?? null
    reply = parseJson(existsSync(outPath) ? readFileSync(outPath, 'utf8') : stdout)
  } else {
    const result = parseJson(stdout) as { session_id?: string; is_error?: boolean; structured_output?: unknown; result?: string } | undefined
    if (!result) return { ok: false, reason: 'claude printed no JSON result' }
    if (result.is_error) return { ok: false, reason: `claude reported an error: ${String(result.result ?? '').slice(0, 200)}` }
    session = result.session_id ?? null
    reply = result.structured_output ?? (typeof result.result === 'string' ? parseJson(result.result) : undefined)
  }
  const checked = validateReview(reply)
  if (typeof checked === 'string') return { ok: false, reason: `malformed review: ${checked}` }
  return { ok: true, result: checked, session }
}

interface Exec { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }

function execTool(tool: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number }): Promise<Exec> {
  return new Promise((resolve) => {
    // Its own process group, so a stuck run is killed with everything it started.
    const child = spawn(tool, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, options.timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdin.on('error', () => {})
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr, timedOut, error: error.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }) })
    child.stdin.end(options.input)
  })
}

const limit = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms} ms`)

interface RunSpec { group: Group; args: string[]; prompt: string; outPath: string; session: string | null }

// One reviewer run, retried once on a stuck, failed or malformed run.
async function runOnce(reviewer: Reviewer, spec: RunSpec, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<(RunOutcome | RunFailure) & { group: Group }> {
  let reason = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    rmSync(spec.outPath, { force: true })
    const run = await execTool(reviewer, spec.args, { ...options, input: spec.prompt })
    if (run.error) return { ok: false, reason: `could not start ${reviewer}: ${run.error} — is it installed and on PATH?`, group: spec.group }
    if (run.timedOut) reason = `${reviewer} ran past the ${limit(options.timeoutMs)} limit and was stopped`
    else if (run.code !== 0) reason = `${reviewer} exited ${run.code}: ${(run.stderr || run.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`
    else {
      const read = readRun(reviewer, run.stdout, run.stderr, spec.outPath)
      if (read.ok) return { ...read, session: read.session ?? spec.session, group: spec.group }
      reason = read.reason
    }
  }
  return { ok: false, reason: `${reason} (after one retry)`, group: spec.group }
}

// Ids stay unique across parallel runs: each run's ids carry its prefix.
export function mergeFindings(runs: Array<{ group: Group; result: ReviewResult }>): ReviewResult {
  const findings: Finding[] = []
  const seen = new Set<string>()
  for (const { group, result } of runs) {
    for (const finding of result.findings) {
      let id = finding.id.trim().replace(/^\[|\]$/g, '')
      if (!id.startsWith(group.prefix)) id = `${group.prefix}${id}`
      while (seen.has(id)) id = `${id}'`
      seen.add(id)
      findings.push({ ...finding, id })
    }
  }
  const needsFixes = runs.some(({ result }) => result.verdict === 'needs-fixes') || findings.some((f) => f.severity === 'must-fix')
  return { verdict: needsFixes ? 'needs-fixes' : 'clean', findings }
}

// ---------------------------------------------------------------------------------------------
// The review comment

const FINDINGS_BLOCK = /<summary>Findings JSON<\/summary>\s*```json\n([\s\S]*?)\n```/
const HISTORY_LINE = /^- Round \d+ @ .*$/gm
const safe = (text: string) => text.replace(/<!--/g, '&lt;!--').replace(/\r/g, '').trim()

export interface CommentData { round: number; sha: string; base: string; reviewer: Reviewer; verdict: ReviewResult['verdict']; findings: Finding[] }

export function readReviewComment(body: string): (CommentData & { history: string[] }) | null {
  const match = FINDINGS_BLOCK.exec(body)
  if (!match) return null
  try {
    const data = JSON.parse(match[1]!) as CommentData
    if (typeof validateReview(data) === 'string' || !Number.isInteger(data.round)) return null
    return { ...data, history: body.match(HISTORY_LINE) ?? [] }
  } catch { return null }
}

const summaryLine = (data: CommentData) => {
  const open = data.findings.filter((f) => f.severity === 'must-fix').map((f) => f.id)
  return `- Round ${data.round} @ ${data.sha.slice(0, 7)} — ${data.verdict}${open.length ? ` — must-fix: ${open.join(', ')}` : ''}`
}

export function renderComment(data: CommentData, history: string[]): string {
  const count = (severity: string) => data.findings.filter((f) => f.severity === severity).length
  const main = data.findings.filter((f) => f.severity !== 'nit')
  const nits = data.findings.filter((f) => f.severity === 'nit')
  const render = (f: Finding) => [
    `**Finding [${f.id}]** — **[${f.severity.toUpperCase()}]** \`${safe(f.file)}${f.line ? `:${f.line}` : ''}\` · ${f.axis}`,
    safe(f.issue),
    `Fix: ${safe(f.fix)}`,
  ].join('\n')
  return [
    `<!-- vsk:v1 type=review round=${data.round} sha=${data.sha.slice(0, 7)} agent=${data.reviewer} verdict=${data.verdict} -->`,
    `## Review — round ${data.round} @ ${data.sha.slice(0, 7)}`,
    '',
    `**Verdict: ${data.verdict}** — must-fix ${count('must-fix')} · should-fix ${count('should-fix')} · nit ${count('nit')}`,
    '',
    ...(main.length ? main.map(render).flatMap((text) => [text, '']) : ['No findings.', '']),
    ...(nits.length ? [`<details><summary>Nits (${nits.length})</summary>`, '', ...nits.map(render).flatMap((text) => [text, '']), '</details>', ''] : []),
    ...(history.length ? ['### Earlier rounds', ...history, ''] : []),
    `Reviewed: ${data.base}...${data.sha.slice(0, 7)} · reviewer: ${data.reviewer} (vegafactory review)`,
    '',
    '<details><summary>Findings JSON</summary>',
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
    '</details>',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------
// CLI

interface Args { number: number; base?: string; reviewer?: Reviewer; resume: boolean; json: boolean; dryRun: boolean; repo?: string }

function parseArgs(argv: string[]): Args {
  const [raw, ...rest] = argv
  const number = Number(raw)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('review needs an issue number — run vegafactory review --help')
  const args: Args = { number, resume: false, json: false, dryRun: false }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!
    if (flag === '--resume') { args.resume = true; continue }
    if (flag === '--json') { args.json = true; continue }
    if (flag === '--dry-run') { args.dryRun = true; continue }
    const value = rest[i + 1]
    if (!['--base', '--reviewer', '--repo'].includes(flag)) throw new Error(`unknown review option: ${flag}`)
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    i++
    if (flag === '--base') args.base = value
    else if (flag === '--repo') args.repo = value
    else if (value === 'claude' || value === 'codex') args.reviewer = value
    else throw new Error('--reviewer must be claude or codex')
  }
  return args
}

export interface ReviewDeps { runner?: GhRunner; cwd?: string; env?: NodeJS.ProcessEnv; out?: (line: string) => void; timeoutMs?: number; machine?: string }

export async function runReview(argv: string[], deps: ReviewDeps = {}): Promise<number> {
  const { runner = defaultRunner, cwd = process.cwd(), env = process.env, out = console.log, machine = machineName() } = deps
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0]!)) { out(reviewUsage()); return 0 }
  const args = parseArgs(argv)
  const timeoutMs = deps.timeoutMs ?? (Number(env.VEGAFACTORY_REVIEW_TIMEOUT_MS) || REVIEW_TIMEOUT_MS)
  const root = repoRoot(cwd)
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim()
  const repo = assertRepo(args.repo ?? detectRepo(root))
  const reviewer = args.reviewer ?? detectReviewer(env)
  if (!reviewer) throw new Error('cannot tell which tool built this work — pass --reviewer claude or --reviewer codex (the other tool reviews)')
  const number = args.number
  const print = (value: unknown, text: string) => out(args.json ? JSON.stringify(value, null, 2) : text)
  const handBack = (reason: string, extra: Record<string, unknown> = {}) => {
    print({ issue: number, handBack: true, reason, ...extra }, `hand-back: ${reason}\nThe review is not skipped: tell the operator, move the issue to waiting-on-operator with that reason, and let them decide.`)
    return 2
  }

  const dir = join(root, '.vegastack', '.tmp', 'reviews')
  const statePath = join(dir, `${number}.json`)
  const saved = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as ReviewState : null
  const state = saved && saved.schema === 1 && saved.repo === repo ? saved : null

  const { dir: cache } = syncIssue({ root, repo, number, runner })
  const snap = snapshot(cache)
  const brief = readBody(cache, 'issue.md')
  const reviewEntry = latestOfType(snap, 'review')
  const reviewBody = reviewEntry ? snap.body(reviewEntry) : null
  const posted = reviewBody ? readReviewComment(reviewBody) : null
  const previousRound = state?.round ?? posted?.round ?? (reviewBody ? Number(markerKeys(reviewBody).round) || 0 : 0)
  const head = git(top, ['rev-parse', 'HEAD']).trim()
  const last = state ?? posted

  // Nothing new since the last round: report it again instead of spending a run.
  if (last && (state?.head ?? posted?.sha) === head && !args.dryRun) {
    const findings = last.findings
    print({ issue: number, round: previousRound, verdict: last.verdict, findings, unchanged: true },
      `HEAD ${head.slice(0, 7)} was already reviewed in round ${previousRound}: ${last.verdict}${findings.length ? ` (${findings.map((f) => f.id).join(', ')})` : ''}`)
    return last.verdict === 'clean' ? 0 : 2
  }
  if (previousRound >= MAX_ROUNDS) {
    const open = (last?.findings ?? []).filter((f) => f.severity === 'must-fix').map((f) => f.id)
    return handBack(`${MAX_ROUNDS} review rounds are done${open.length ? ` and must-fix findings remain open (${open.join(', ')})` : ''}; the operator decides what happens next`, { round: previousRound, open })
  }

  const round = previousRound + 1
  const resumable = Boolean(state && state.machine === machine && state.reviewer === reviewer && state.sessions.length && state.sessions.every((s) => s.id))
  if (args.resume && !resumable) throw new Error(`no ${reviewer} review session from this machine to resume for #${number} — run without --resume for a fresh reviewer`)
  const devMdPath = join(root, '.vegastack', 'dev.md')
  const policy = reviewPolicy(existsSync(devMdPath) ? readFileSync(devMdPath, 'utf8') : '', reviewer)
  const schemaPath = join(dir, 'schema.json')
  const outPath = (group: Group) => join(dir, `${number}-${group.key}.out.json`)

  let specs: RunSpec[]
  let base: string
  let facts: DiffFacts
  if (resumable) {
    base = args.base ?? state!.base
    facts = diffFacts(top, `${state!.head}..${head}`)
    const prompt = resumePrompt({ round, from: state!.head, head, open: state!.open, facts })
    specs = state!.sessions.map(({ group, id }) => ({ group, prompt, session: id, outPath: outPath(group), args: reviewerArgs(reviewer, { schemaPath, outPath: outPath(group), session: id, policy }) }))
  } else {
    base = args.base ?? state?.base ?? posted?.base ?? defaultBase(top, repo, runner)
    facts = diffFacts(top, `${base}...${head}`)
    const labels = snap.state.issue!.labels
    const parallel = facts.lines > BIG_LINES || facts.files.length > BIG_FILES || labels.includes('risky')
    const groups: Group[] = parallel
      ? [{ key: 'spec-bugs', axes: ['spec', 'bugs', 'style'], prefix: 'B' }, { key: 'security', axes: ['security'], prefix: 'S' }]
      : [{ key: 'all', axes: ['spec', 'bugs', 'security', 'style'], prefix: 'F' }]
    const knownPath = join(top, '.vegastack', 'review-known-patterns.md')
    const input: PacketInput = {
      number, title: snap.state.issue!.title, repo, branch: git(top, ['branch', '--show-current']).trim() || '(detached)', base, head,
      acceptance: acceptanceCriteria(brief), tasks: taskList(snap, brief), facts,
      previous: round > 1 ? last?.findings ?? null : null,
      knownPatterns: existsSync(knownPath) ? readFileSync(knownPath, 'utf8') : null,
    }
    specs = groups.map((group) => ({ group, session: null, prompt: freshPrompt(input, group), outPath: outPath(group), args: reviewerArgs(reviewer, { schemaPath, outPath: outPath(group), session: null, policy }) }))
  }
  if (!facts.files.length && !resumable) return handBack(`no changes between ${base} and HEAD — nothing to review`)

  if (args.dryRun) {
    const commands = specs.map((spec) => ({ group: spec.group.key, cwd: top, command: [reviewer, ...spec.args], stdin: `${spec.prompt.length} characters` }))
    if (args.json) out(JSON.stringify({ dryRun: true, issue: number, round, reviewer, resume: resumable, commands, prompts: specs.map((s) => s.prompt) }, null, 2))
    else {
      for (const spec of specs) {
        out(`# ${spec.group.key} — round ${round}, ${resumable ? 'resumed session' : 'fresh reviewer'}, cwd ${top}`)
        out(`argv: ${JSON.stringify([reviewer, ...spec.args])}`)
        out('stdin:')
        out(spec.prompt)
      }
    }
    return 0
  }

  mkdirSync(dir, { recursive: true })
  writeFileSync(schemaPath, JSON.stringify(REVIEW_SCHEMA, null, 2) + '\n')
  const childEnv = childEnvironment(env)
  const runs = await Promise.all(specs.map((spec) => runOnce(reviewer, spec, { cwd: top, env: childEnv, timeoutMs })))
  const failed = runs.filter((run): run is RunFailure & { group: Group } => !run.ok)
  if (failed.length) return handBack(`the ${reviewer} review of #${number} did not finish: ${failed.map((run) => `${run.group.key}: ${run.reason}`).join('; ')}`, { round })
  const done = runs as Array<RunOutcome & { group: Group }>
  const result = mergeFindings(done)

  const data: CommentData = { round, sha: head, base, reviewer, verdict: result.verdict, findings: result.findings }
  const previous = posted ? [...posted.history, summaryLine(posted)] : []
  const body = renderComment(data, previous)
  const bodyPath = join(dir, `${number}-comment.md`)
  writeFileSync(bodyPath, body)
  const quiet: string[] = []
  const issueArgs = reviewEntry
    ? ['edit-comment', String(number), String(reviewEntry.id), '--file', bodyPath, '--since', String(syncIssue({ root, repo, number, runner }).cursor), '--repo', repo]
    : ['comment', String(number), '--file', bodyPath, '--repo', repo]
  runIssue(issueArgs, { runner, cwd, out: (line) => quiet.push(line) })

  const next: ReviewState = {
    schema: 1, repo, issue: number, reviewer, machine, round, base, head,
    sessions: done.map((run) => ({ group: run.group, id: run.session })),
    open: result.findings.map((f) => f.id), verdict: result.verdict, findings: result.findings,
  }
  writeFileSync(statePath, JSON.stringify(next, null, 2) + '\n')

  const mustFix = result.findings.filter((f) => f.severity === 'must-fix')
  const summary = [
    `round ${round} (${reviewer}, ${resumable ? 'resumed' : 'fresh'}): ${result.verdict} — ${result.findings.length} finding(s)`,
    ...result.findings.map((f) => `  [${f.id}] ${f.severity} ${f.file}${f.line ? `:${f.line}` : ''} — ${f.issue.split('\n')[0]}`),
    quiet.find((line) => line.startsWith('posted') || line.startsWith('edited')) ?? '',
  ].filter(Boolean)
  if (result.verdict === 'needs-fixes' && round >= MAX_ROUNDS) {
    return handBack(`round ${MAX_ROUNDS} still has open findings (${(mustFix.length ? mustFix : result.findings).map((f) => f.id).join(', ')}); the operator decides what happens next`, { round, verdict: result.verdict, findings: result.findings })
  }
  if (result.verdict === 'needs-fixes') summary.push(`next: fix, commit, push, then run vegafactory review ${number} again (round ${round + 1} of ${MAX_ROUNDS})`)
  print({ issue: number, round, reviewer, resumed: resumable, verdict: result.verdict, findings: result.findings, sessions: next.sessions }, summary.join('\n'))
  return result.verdict === 'clean' ? 0 : 2
}

function defaultBase(cwd: string, repo: string, runner: GhRunner): string {
  const local = defaultBranch(cwd)
  if (local) return `origin/${local}`
  const name = ghRequest<{ default_branch?: string }>(`repos/${repo}`, { runner }).body.default_branch
  if (!name) throw new Error(`cannot tell the default branch of ${repo} — pass --base`)
  return `origin/${name}`
}
