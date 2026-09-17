// `vegafactory ship check <n>` — the facts that must hold before an issue's PR is merged:
// the issue passes `issue check --for ship`, its branch is clean and pushed, and the branch's
// PR is open on that commit with every check green.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultRunner, type GhRunner } from './gh.ts'
import { issueFromBranch } from './hook.ts'
import { checkIssue, detectRepo, permissionLookup, repoRoot, snapshot } from './issue.ts'
import { syncIssue } from './issue-cache.ts'

export interface ShipCheck { ok: boolean; blocks: string[]; warns: string[]; branch: string | null; pr: number | null }

export function shipUsage(): string {
  return `Usage: vegafactory ship check <n> [--branch NAME] [--repo OWNER/NAME] [--json]

  check <n>   exit 0 when issue n may merge: a "ship it" after the latest evidence, the branch
              clean and pushed, its PR open on that commit and every check green. Exit 2 when blocked.
`
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 })
  return result.status === 0 ? result.stdout.trim() : null
}

// The issue's branch: the current one when it names the issue, else the one origin has.
function findBranch(cwd: string, number: number): string | null {
  const current = git(cwd, ['branch', '--show-current'])
  if (current && issueFromBranch(current) === number) return current
  const remote = (git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']) ?? '').split('\n')
    .map((ref) => ref.replace(/^origin\//, '')).filter((ref) => issueFromBranch(ref) === number)
  return remote.length === 1 ? remote[0]! : null
}

interface Pr { number: number; state: string; headRefOid: string; url: string }
interface Check { name: string; bucket: string }

export function shipCheck(input: { cwd: string; root: string; repo: string; number: number; branch?: string; runner: GhRunner }): ShipCheck {
  const { cwd, root, repo, number, runner } = input
  const blocks: string[] = []
  const warns: string[] = []
  const { dir } = syncIssue({ root, repo, number, runner })
  const devMd = join(root, '.vegastack', 'dev.md')
  const devMdRepo = existsSync(devMd) ? /^repo:\s*(\S+)/m.exec(readFileSync(devMd, 'utf8'))?.[1] ?? null : null
  const issue = checkIssue(snapshot(dir), 'ship', permissionLookup(repo, runner), { repo, devMdRepo })
  blocks.push(...issue.blocks)
  warns.push(...issue.warns)

  const branch = input.branch ?? findBranch(cwd, number)
  if (!branch) return { ok: false, blocks: [...blocks, `no single branch names #${number} — pass --branch`], warns, branch: null, pr: null }
  if (git(cwd, ['branch', '--show-current']) === branch && git(cwd, ['status', '--porcelain'])) blocks.push(`${branch} has uncommitted changes`)
  git(cwd, ['fetch', '--quiet', 'origin', branch])
  const local = git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  const pushed = git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
  if (!pushed) blocks.push(`${branch} is not on origin`)
  else if (local && local !== pushed) blocks.push(`${branch} differs from origin/${branch} — push it`)

  const view = runner(['pr', 'view', branch, '--repo', repo, '--json', 'number,state,headRefOid,url'])
  let pr: Pr | null = null
  try { pr = view.code === 0 ? JSON.parse(view.stdout) as Pr : null } catch { pr = null }
  if (!pr) {
    blocks.push(`no PR for ${branch}`)
    return { ok: false, blocks, warns, branch, pr: null }
  }
  if (pr.state !== 'OPEN') blocks.push(`PR #${pr.number} is ${pr.state.toLowerCase()}`)
  if (pushed && pr.headRefOid !== pushed) blocks.push(`PR #${pr.number} is not on origin/${branch} yet`)

  // gh exits non-zero while checks fail or wait, so read the JSON whatever the exit code.
  const checks = runner(['pr', 'checks', String(pr.number), '--repo', repo, '--json', 'name,bucket'])
  let list: Check[] | null = null
  try { list = JSON.parse(checks.stdout) as Check[] } catch { list = null }
  if (!list) warns.push(`PR #${pr.number} reports no checks`)
  else {
    const failing = list.filter((check) => check.bucket === 'fail' || check.bucket === 'cancel')
    const pending = list.filter((check) => check.bucket === 'pending')
    if (failing.length) blocks.push(`failing checks: ${failing.map((check) => check.name).join(', ')}`)
    if (pending.length) blocks.push(`checks still running: ${pending.map((check) => check.name).join(', ')}`)
  }
  return { ok: blocks.length === 0, blocks, warns, branch, pr: pr.number }
}

export function runShip(argv: string[], { runner = defaultRunner, cwd = process.cwd(), out = console.log } = {}): number {
  const [verb, raw, ...rest] = argv
  if (!verb || ['help', '--help', '-h'].includes(verb)) { out(shipUsage()); return 0 }
  if (verb !== 'check') throw new Error(`unknown ship verb: ${verb} — run vegafactory ship --help`)
  const number = Number(raw)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('ship check needs an issue number')
  const flag = (name: string) => {
    const at = rest.indexOf(name)
    return at === -1 ? undefined : rest[at + 1]
  }
  const root = repoRoot(cwd)
  const repo = flag('--repo') ?? detectRepo(root)
  const result = shipCheck({ cwd, root, repo, number, branch: flag('--branch'), runner })
  if (rest.includes('--json')) out(JSON.stringify(result, null, 2))
  else out([result.ok ? 'ok' : 'blocked', ...result.blocks.map((b) => `block: ${b}`), ...result.warns.map((w) => `warn: ${w}`)].join('\n'))
  return result.ok ? 0 : 2
}
