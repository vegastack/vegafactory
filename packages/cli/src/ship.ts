// `vegafactory ship check <n>` — the facts that must hold before an issue's PR is merged:
// the issue passes `issue check --for ship`, its branch is clean and pushed, the latest evidence
// names that commit, no [DEBUG-…] log line is added, and the branch's PR is open on it with
// every check green, and that PR targets the repository's default branch.
//
// `vegafactory ship release <n>` — the step after that merge: it re-reads issue n's recorded
// "ship it", checks the version and its changelog entry, and creates and pushes the tag itself,
// so the guard can allow this one verb while raw `git tag` and tag pushes keep asking. It never
// publishes: the tag-triggered workflow does that.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { trustedAuthors, trustedFactory } from './claim.ts'
import { defaultRunner, ghRequest, type GhRunner } from './gh.ts'
import { defaultBranch } from './guard-rules.ts'
import { issueFromBranch } from './hook.ts'
import { checkIssue, currentHashes, detectRepo, evidenceChangedAt, findValidAck, latestOfType, markerKeys, permissionLookup, repoRoot, snapshot } from './issue.ts'
import { syncIssue } from './issue-cache.ts'
import { acceptedReview, MAX_ROUNDS, trustedReview } from './review.ts'

export interface ShipCheck { ok: boolean; blocks: string[]; warns: string[]; branch: string | null; pr: number | null }

export function shipUsage(): string {
  return `Usage: vegafactory ship check <n> [--branch NAME] [--repo OWNER/NAME] [--json]
       vegafactory ship release <n> [--version X.Y.Z] [--dry-run] [--json]

  check <n>     exit 0 when issue n may merge: a "ship it" after the latest evidence, the evidence
                on the pushed head, the branch clean, its PR open on that commit against the default
                branch, and every check passed or skipped.
                Exit 2 when blocked.

  release <n>   tag the merged release on issue n's recorded "ship it" — issue n of the repository
                this checkout is, which is why there is no --repo. The word is re-read against the
                current evidence, the version and its changelog entry must agree, and the default
                branch must be checked out, clean and level with origin. Then it creates v<version>
                and pushes it, and stops — the tag-triggered workflow publishes. Exit 2 when refused.
`
}

// `merge-base --is-ancestor` answers with its exit code and no output.
function isAncestor(cwd: string, commit: string, ref: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', commit, ref], { cwd, encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: 30_000 }).status === 0
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

interface Pr { number: number; state: string; headRefOid: string; baseRefName: string; url: string }
interface Check { name: string; bucket: string }

export function shipCheck(input: { cwd: string; root: string; repo: string; number: number; branch?: string; runner: GhRunner }): ShipCheck {
  const { cwd, root, repo, number, runner } = input
  const blocks: string[] = []
  const warns: string[] = []
  const { dir } = syncIssue({ root, repo, number, runner })
  const devMd = join(root, '.vegastack', 'dev.md')
  const devMdRepo = existsSync(devMd) ? /^repo:\s*(\S+)/m.exec(readFileSync(devMd, 'utf8'))?.[1] ?? null : null
  const snap = snapshot(dir)
  const issue = checkIssue(snap, 'ship', permissionLookup(repo, runner), { repo, devMdRepo })
  blocks.push(...issue.blocks)
  warns.push(...issue.warns)

  const branch = input.branch ?? findBranch(cwd, number)
  if (!branch) return { ok: false, blocks: [...blocks, `no single branch names #${number} — pass --branch`], warns, branch: null, pr: null }
  if (issueFromBranch(branch) !== number) return { ok: false, blocks: [...blocks, `${branch} does not name #${number} (<type>/${number}-…)`], warns, branch, pr: null }
  if (git(cwd, ['branch', '--show-current']) === branch && git(cwd, ['status', '--porcelain'])) blocks.push(`${branch} has uncommitted changes`)
  git(cwd, ['fetch', '--quiet', 'origin', branch])
  const local = git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  const pushed = git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
  if (!pushed) blocks.push(`${branch} is not on origin`)
  else if (local && local !== pushed) blocks.push(`${branch} differs from origin/${branch} — push it`)
  // The evidence must describe the commit that merges.
  const evidence = latestOfType(snap, 'evidence')
  const keys = evidence ? markerKeys(snap.body(evidence)) : null
  if (keys?.branch !== undefined && keys.branch !== branch) blocks.push(`the evidence is for branch ${keys.branch}, not ${branch}`)
  const sha = keys ? keys.sha ?? '' : null
  if (sha === '') blocks.push('the evidence comment names no sha=')
  else if (sha !== null && !/^[0-9a-f]{7,40}$/i.test(sha)) blocks.push(`the evidence sha=${sha} is not a commit id of at least 7 hex characters`)
  else if (sha && pushed) {
    // A short id must name exactly one commit, and that commit must be the pushed head.
    const resolved = git(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])
    if (resolved !== pushed) blocks.push(`the evidence is for ${sha}, but origin/${branch} is at ${pushed.slice(0, 12)} — post fresh evidence`)
  }

  // GitHub's own answer, not the local origin/HEAD guess: the review's base is judged against the
  // branch this PR would merge into, and a fact that cannot be read blocks rather than passes.
  let defaultName: string | null = null
  try { defaultName = ghRequest<{ default_branch?: string }>(`repos/${repo}`, { runner }).body.default_branch ?? null } catch { defaultName = null }
  if (!defaultName) blocks.push(`cannot read the default branch of ${repo}`)
  const defaultRef = defaultName ? git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${defaultName}`]) : null
  if (defaultName && !defaultRef) blocks.push(`origin/${defaultName} is not in this checkout — fetch it, so the review's base can be checked against it`)

  // Review is never skipped: the commit that would merge carries a clean review covering the whole
  // candidate, or the operator's own written acceptance of what that review left open. The review
  // may come from a reviewer with write access or from the App a dispatched run posts as; the
  // acceptance may not — that word is the operator's own.
  const reviewer = trustedFactory({ repo, runner, root })
  const person = trustedAuthors({ repo, runner, root })
  let review: Awaited<ReturnType<typeof trustedReview>> = null
  try {
    review = trustedReview(snap, reviewer, pushed ?? undefined)
  } catch (error) {
    blocks.push((error as Error).message)
    review = null
  }
  if (!review) {
    if (!blocks.some((block) => block.startsWith('two review comments disagree'))) blocks.push('no review comment from a reviewer with write access or from the factory App — run vegafactory review')
  } else if (pushed && review.data.sha !== pushed) {
    blocks.push(`the review is for ${review.data.sha.slice(0, 7)}, but origin/${branch} is at ${pushed.slice(0, 12)} — review the head that would merge`)
  } else {
    // A review of a narrow range judges only part of what merges. Its base must already be in the
    // default branch, so <review base>...<head> is the whole candidate; an unreadable base or
    // branch blocks, because an unproven claim is not a proven one.
    if (defaultName && defaultRef) {
      if (!git(cwd, ['cat-file', '-e', `${review.data.base}^{commit}`]) && git(cwd, ['cat-file', '-t', review.data.base]) === null) {
        blocks.push(`the review's base ${review.data.base.slice(0, 7)} is not a commit in this checkout — fetch the branch it was reviewed from`)
      } else if (!isAncestor(cwd, review.data.base, defaultRef)) {
        blocks.push(`the review's base ${review.data.base.slice(0, 7)} is not in origin/${defaultName}, so it covered only part of what would merge — re-run the review against the default branch`)
      }
    }
    // F25: the review is about the brief and plan it read.
    const now = currentHashes(snap)
    if (review.data.brief !== now.brief) blocks.push(`the brief changed after review round ${review.data.round} — re-run the review`)
    else if (review.data.plan !== now.plan) blocks.push(`the plan changed after review round ${review.data.round} — re-run the review`)
    if (review.data.verdict !== 'clean' && !acceptedReview(snap, person, review)) {
      const open = review.data.findings.filter((finding) => finding.severity === 'must-fix').map((finding) => finding.id)
      const accept = review.data.round >= MAX_ROUNDS
        ? ` or, now the loop is spent, the operator accepts them in a line of their own: "accept review round ${review.data.round} @ ${review.data.sha.slice(0, 7)}"`
        : ''
      blocks.push(`review round ${review.data.round} is needs-fixes (${open.join(', ') || 'see the comment'}) — fix and re-review${accept}`)
    }
  }

  // dev-debug's tagged debug logs must not ship.
  const base = defaultRef ?? (defaultBranch(cwd) ? `origin/${defaultBranch(cwd)}` : null)
  const diff = base && pushed ? git(cwd, ['diff', '--no-color', '--no-ext-diff', `${base}...${pushed}`]) ?? '' : ''
  const tagged = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++') && line.includes('[DEBUG-'))
  if (tagged.length) blocks.push(`${tagged.length} added line(s) still carry a [DEBUG-…] tag`)

  const view = runner(['pr', 'view', branch, '--repo', repo, '--json', 'number,state,headRefOid,baseRefName,url'])
  let pr: Pr | null = null
  try { pr = view.code === 0 ? JSON.parse(view.stdout) as Pr : null } catch { pr = null }
  if (!pr) {
    blocks.push(`no PR for ${branch}`)
    return { ok: false, blocks, warns, branch, pr: null }
  }
  if (pr.state !== 'OPEN') blocks.push(`PR #${pr.number} is ${String(pr.state).toLowerCase()}`)
  if (pushed && pr.headRefOid !== pushed) blocks.push(`PR #${pr.number} is not on origin/${branch} yet`)
  if (defaultName && pr.baseRefName !== defaultName) blocks.push(`PR #${pr.number} targets ${pr.baseRefName || 'an unknown branch'}, not the default branch ${defaultName}`)

  // gh exits non-zero while checks fail or wait, so read the JSON whatever the exit code.
  // Only an explicit pass or skip counts; anything else, or no readable answer, blocks.
  const checks = runner(['pr', 'checks', String(pr.number), '--repo', repo, '--json', 'name,bucket'])
  let list: Check[] | null = null
  try {
    const parsed: unknown = JSON.parse(checks.stdout)
    list = Array.isArray(parsed) && parsed.every((c) => c && typeof c.name === 'string' && typeof c.bucket === 'string') ? parsed as Check[] : null
  } catch { list = null }
  if (!list) blocks.push(`the checks of PR #${pr.number} could not be read${checks.stderr.trim() ? ` (${checks.stderr.trim().split('\n')[0]})` : ''}`)
  else {
    const failing = list.filter((check) => check.bucket === 'fail' || check.bucket === 'cancel')
    const pending = list.filter((check) => check.bucket === 'pending')
    const unknown = list.filter((check) => !['pass', 'skipping', 'fail', 'cancel', 'pending'].includes(check.bucket))
    if (failing.length) blocks.push(`failing checks: ${failing.map((check) => check.name).join(', ')}`)
    if (pending.length) blocks.push(`checks still running: ${pending.map((check) => check.name).join(', ')}`)
    if (unknown.length) blocks.push(`checks in an unknown state: ${unknown.map((check) => `${check.name} (${check.bucket})`).join(', ')}`)
    if (!list.length) blocks.push(`PR #${pr.number} reports no checks`)
  }
  return { ok: blocks.length === 0, blocks, warns, branch, pr: pr.number }
}

// ---------------------------------------------------------------------------------------------
// `ship release <n>` — the tag, and nothing else

export interface PackageVersion { version: string; dir: string }

// The packages a release could tag: this repository's own package.json and each one under
// packages/, minus the private ones and the workspace placeholder nobody bumps.
export function versionCandidates(root: string): PackageVersion[] {
  const workspace = join(root, 'packages')
  const dirs = [root, ...(existsSync(workspace) ? readdirSync(workspace).sort().map((name) => join(workspace, name)) : [])]
  const found: PackageVersion[] = []
  for (const dir of dirs) {
    let pkg: { version?: unknown; private?: unknown }
    try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as typeof pkg } catch { continue }
    if (pkg.private === true || typeof pkg.version !== 'string') continue
    if (!/^\d+\.\d+\.\d+/.test(pkg.version) || pkg.version.startsWith('0.0.0')) continue
    found.push({ version: pkg.version, dir })
  }
  return found
}

// The changelog entry for a version: `## 1.2.3`, however the generator spells the heading.
export function changelogEntry(root: string, dir: string, version: string): { file: string; found: boolean } | null {
  const escaped = version.replace(/\./g, '\\.')
  const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(\\s|$|\\])`, 'm')
  for (const file of [join(dir, 'CHANGELOG.md'), join(root, 'CHANGELOG.md')]) {
    if (!existsSync(file)) continue
    return { file, found: heading.test(readFileSync(file, 'utf8')) }
  }
  return null
}

export interface ReleaseCheck { ok: boolean; blocks: string[]; version: string | null; tag: string | null; pushed: boolean }

// A command that must have run, not merely returned nothing: `ls-remote` prints nothing both for
// "no such tag" and for a fetch it never managed, and those are opposite answers.
function gitRun(cwd: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() }
}

// The GitHub repository this checkout pushes to, or null when origin is not a GitHub remote.
export function originRepo(cwd: string): string | null {
  const remote = gitRun(cwd, ['remote', 'get-url', 'origin'])
  if (!remote.ok) return null
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote.out)?.[1] ?? null
}

// Everything that must hold before a tag exists. The word is the first fact and the release is
// the last: nothing here writes, so a refusal leaves the repository exactly as it was.
export function releaseCheck(input: { cwd: string; root: string; repo: string; number: number; runner: GhRunner; version?: string }): ReleaseCheck {
  const { cwd, root, repo, number, runner } = input
  const blocks: string[] = []
  // The issue that authorises the tag belongs to the repository this checkout pushes to. There is
  // no --repo on this verb, and an origin that names a different GitHub repository refuses.
  const origin = originRepo(cwd)
  if (origin && origin !== repo) blocks.push(`the word would be read from ${repo}, but this checkout pushes to ${origin} — release from the repository the issue belongs to`)
  const { dir } = syncIssue({ root, repo, number, runner })
  const snap = snapshot(dir)
  // The same rule `ship check` enforces: a "ship it" is spent by evidence posted or edited after it.
  const evidence = latestOfType(snap, 'evidence')
  if (!evidence) blocks.push(`no evidence comment on #${number} — there is nothing the word was given for`)
  const ack = findValidAck(snap, 'ship', permissionLookup(repo, runner), evidence ? evidenceChangedAt(evidence) : null)
  if (!ack.ok) blocks.push(`no "ship it" on #${number}: ${ack.reason}`)

  const candidates = versionCandidates(root)
  let version: string | null = null
  let dirOf = root
  if (input.version !== undefined) {
    const match = candidates.find((candidate) => candidate.version === input.version)
    if (!match) blocks.push(`no package in this repository is at ${input.version} — found ${candidates.map((c) => c.version).join(', ') || 'none'}`)
    else { version = match.version; dirOf = match.dir }
  } else if (candidates.length === 0) blocks.push('no package.json in this repository carries a release version')
  else if (new Set(candidates.map((c) => c.version)).size > 1) {
    blocks.push(`this repository holds more than one version (${candidates.map((c) => c.version).join(', ')}) — name the one to release with --version`)
  } else { version = candidates[0]!.version; dirOf = candidates[0]!.dir }

  if (version) {
    const changelog = changelogEntry(root, dirOf, version)
    if (!changelog) blocks.push(`no CHANGELOG.md beside the released package or at the repository root — ${version} has no record to release`)
    else if (!changelog.found) blocks.push(`${changelog.file.slice(root.length + 1)} has no entry for ${version} — run the version step before tagging`)
  }

  // The tag belongs on the merged release commit, so the default branch is checked out, clean,
  // and exactly what origin has.
  let defaultName: string | null = null
  try { defaultName = ghRequest<{ default_branch?: string }>(`repos/${repo}`, { runner }).body.default_branch ?? null } catch { defaultName = null }
  if (!defaultName) blocks.push(`cannot read the default branch of ${repo}`)
  else {
    const current = git(cwd, ['branch', '--show-current'])
    if (current !== defaultName) blocks.push(`a release is tagged on ${defaultName}, but ${current || 'a detached HEAD'} is checked out`)
    if (git(cwd, ['status', '--porcelain'])) blocks.push(`${defaultName} has uncommitted changes`)
    // A fetch that did not run leaves a stale ref that can look level with HEAD, so its failure
    // is a refusal rather than a silent fall back to what this checkout happens to hold.
    const fetched = gitRun(cwd, ['fetch', '--quiet', 'origin', defaultName])
    if (!fetched.ok) blocks.push(`cannot fetch origin/${defaultName} — a release is tagged on what origin has, not on a stale copy of it`)
    const head = git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    const remote = git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${defaultName}`])
    if (!remote) blocks.push(`origin/${defaultName} is not in this checkout — fetch it`)
    else if (fetched.ok && head !== remote) blocks.push(`HEAD is at ${(head ?? '').slice(0, 12)} but origin/${defaultName} is at ${remote.slice(0, 12)} — pull the merged release commit`)
  }

  const tag = version ? `v${version}` : null
  if (tag) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])) blocks.push(`${tag} already exists here — a released version is never re-tagged, fix forward with a new one`)
    else {
      // Empty output means "origin has no such tag" only when the lookup itself succeeded.
      const remoteTag = gitRun(cwd, ['ls-remote', '--tags', 'origin', tag])
      if (!remoteTag.ok) blocks.push(`cannot ask origin whether ${tag} already exists — refusing to tag on an unanswered question`)
      else if (remoteTag.out) blocks.push(`${tag} is already on origin — a released version is never re-tagged, fix forward with a new one`)
    }
  }
  return { ok: blocks.length === 0, blocks, version, tag, pushed: false }
}

function gitOrThrow(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim().split('\n').at(-1) ?? ''}`)
}

// Creates the tag and pushes it — the one write in this file, reached only through a clean check.
// A failed push is cleaned up locally on a best effort; whether origin took the tag is origin's
// answer to give, so the error says to look there before trying again.
export function releaseRun(input: { cwd: string; root: string; repo: string; number: number; runner: GhRunner; version?: string; dryRun?: boolean }): ReleaseCheck {
  const result = releaseCheck(input)
  if (!result.ok || input.dryRun) return result
  gitOrThrow(input.cwd, ['tag', '-a', result.tag!, '-m', result.tag!])
  try {
    gitOrThrow(input.cwd, ['push', 'origin', `refs/tags/${result.tag!}`])
  } catch (error) {
    const removed = gitRun(input.cwd, ['tag', '-d', result.tag!])
    const local = removed.ok ? `the local ${result.tag!} was removed` : `the local ${result.tag!} is still here and could not be removed`
    throw new Error(`${(error as Error).message}\n${local}; check whether origin has ${result.tag!} (git ls-remote --tags origin ${result.tag!}) before running this again`)
  }
  return { ...result, pushed: true }
}

export function runShip(argv: string[], { runner = defaultRunner, cwd = process.cwd(), out = console.log } = {}): number {
  const [verb, raw, ...rest] = argv
  if (!verb || ['help', '--help', '-h'].includes(verb)) { out(shipUsage()); return 0 }
  if (verb !== 'check' && verb !== 'release') throw new Error(`unknown ship verb: ${verb} — run vegafactory ship --help`)
  const number = Number(raw)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`ship ${verb} needs an issue number`)
  const flag = (name: string) => {
    const at = rest.indexOf(name)
    return at === -1 ? undefined : rest[at + 1]
  }
  const root = repoRoot(cwd)
  if (verb === 'release') {
    // No --repo here: the repository whose word authorises the tag is the one this checkout is.
    if (rest.some((arg) => arg === '--repo' || arg.startsWith('--repo='))) {
      throw new Error('ship release takes no --repo — it releases the repository this checkout is, and reads the word from that repository')
    }
    const dryRun = rest.includes('--dry-run')
    const result = releaseRun({ cwd, root, repo: detectRepo(root), number, version: flag('--version'), dryRun, runner })
    if (rest.includes('--json')) out(JSON.stringify(result, null, 2))
    else if (!result.ok) out(['refused', ...result.blocks.map((b) => `block: ${b}`)].join('\n'))
    else if (dryRun) out(`would tag ${result.tag} on the merged release commit and push it to origin`)
    else out(`${result.tag} tagged and pushed — the tag-triggered workflow publishes; watch it before reporting the release`)
    return result.ok ? 0 : 2
  }
  const result = shipCheck({ cwd, root, repo: flag('--repo') ?? detectRepo(root), number, branch: flag('--branch'), runner })
  if (rest.includes('--json')) out(JSON.stringify(result, null, 2))
  else out([result.ok ? 'ok' : 'blocked', ...result.blocks.map((b) => `block: ${b}`), ...result.warns.map((w) => `warn: ${w}`)].join('\n'))
  return result.ok ? 0 : 2
}
