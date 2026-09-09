import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createRun, readRuns, runsRoot, type RunInput } from '../src/runs.ts'
import { validateChildResult } from '../src/children.ts'

const source = resolve('packages/cli/src'), helper = resolve('skills/dev/dev-implement/scripts/worktree.mjs')
function git(cwd: string, ...args: string[]) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (out.status !== 0) throw Error(out.stderr)
  return out.stdout.trim()
}
function diagnostic(root: string, checkout: string, issue: number, head: string): RunInput {
  return { root, repo: 'fixture/repo', issue, parent: null, checkout, branch: 'feat/parent', baseSha: head, headSha: head, stage: 'implement',
    harness: 'controlled-process', model: 'none', effort: 'none', execution: null, approvalBindings: [], recordBinding: null, approvalRefs: [], policyDigest: '',
    claimToken: randomUUID(), startedAt: new Date().toISOString(), taskKey: { repo: 'fixture/repo', issue, taskId: issue + '-T1', scopeDigest: createHash('sha256').update(String(issue)).digest('hex') },
    approvedTaskIds: [issue + '-T1'], activeElapsedMs: null, taskOwner: null, agentAccountOwner: null, accountRef: null, waitReason: null, machine: null, sharedClaim: null,
    checkpoint: null, remoteEffectCoverage: { kind: 'unmanaged-possible', reasonCode: 'controlled-local-test' } }
}
// This external controller is a local fixture, not a subscription qualification.
// The actual CLI parser, persisted scheduler, Git checkout, executeApprovedRun,
// wrapper, executed acceptance, and join remain production implementations.
const gateway = `
import {runChildrenCli} from ${JSON.stringify(join(source, 'children.ts'))};
import {createRun,readRun,runsRoot} from ${JSON.stringify(join(source, 'runs.ts'))};
import {parseFactoryConfig} from ${JSON.stringify(join(source, 'config.ts'))};
import {buildLaunchPlan} from ${JSON.stringify(join(source, 'launch.ts'))};
import {createChildWorktree} from ${JSON.stringify(helper)};
import {readFile,appendFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
const config=parseFactoryConfig({repos:[{repo:'fixture/repo',org:'fixture',path:input.tree}],subagents:{concurrent:input.concurrent??3}},input.home);
const root=runsRoot(input.home),parent=await readRun(root,input.parent),groups=JSON.parse(await readFile(input.groups,'utf8'));
const binding={taskKey:'a'.repeat(64),runId:parent.runId,generation:1,ownerToken:parent.claimToken,machineId:'controlled-fixture',installationId:parent.claimToken,sessionId:parent.claimToken};
const target={};const claim={...binding,stateCommit:'b'.repeat(40),target};
const execution={groups:async()=>groups.groups,parentClaim:async()=>claim,issue:async(_repo,issue)=>({number:issue,title:'child-'+issue}),verifyParent:async()=>{if(existsSync(input.home+'/owner-lost'))throw Error('original parent owner lost')},verifyChild:async()=>{},acquire:async()=>null,finish:async()=>{},processDeps:{wrapperPath:${JSON.stringify(join(source, 'run-wrapper.ts'))}},
 prepare:async(child,record)=>{
   const checkout=createChildWorktree({repoRoot:input.tree,issue:child.issue,slug:child.title,type:child.type,baseSha:record.baseSha,devMd:await readFile(join(input.tree,'.vegastack/dev.md'),'utf8'),home:input.home,write:true});
   if(checkout.blocks.length)throw Error(checkout.blocks.join(';'));
   const original=JSON.parse(await readFile(input.runInput,'utf8'));
   const run=await createRun({...original,parent:parent.issue,issue:child.issue,checkout:child.path,branch:child.branch,taskKey:{...original.taskKey,issue:child.issue,taskId:child.issue+'-T1'},approvedTaskIds:[child.issue+'-T1']});
   const plan=buildLaunchPlan({harness:'codex',model:'fixture',effort:'high',stage:'implement',worktree:child.path,issue:{number:child.issue,title:child.title},operator:'fixture',outcome:'controlled local child',stopList:[],resume:false,skillPath:null,subagents:config.subagents});
   const code=input.code??'const fs=require("node:fs"),cp=require("node:child_process");fs.writeFileSync(process.argv.at(-1),"accepted"+String.fromCharCode(10));cp.execFileSync("git",["add",process.argv.at(-1)]);cp.execFileSync("git",["commit","-m","controlled child"]);';
   return{run,localClaim:null,plan:{...plan,command:input.command??process.execPath,args:['-e',code,child.files[0]],env:{...plan.env,CHILD_EVENTS:input.events??''}}};
 }};
const integration={verifyParent:async()=>{},verifyAuthority:async()=>{},parentClaim:async()=>claim,verifyChild:async()=>{},processDeps:execution.processDeps,persistChild:async(c)=>c,persistJoin:async(c,r,check)=>{if(input.crashAfterFirstJoin&&check&&r.issue===8&&!existsSync(input.home+'/join-crashed')){await writeFile(input.home+'/join-crashed','once');process.kill(process.pid,'SIGKILL');await new Promise(()=>{})}return({claim:c,reference:{operationId:r.operationId,childRunId:r.runId,generation:r.generation,fromSha:r.fromSha,parentBefore:r.parentBefore,parentAfter:check?r.parentAfter:null,state:check?'accepted':'prepared',acceptance:null,evidence:{kind:'state-receipt',operationId:r.operationId,commitSha:'b'.repeat(40),blobSha256:'c'.repeat(64)}}})}};
process.exitCode=await runChildrenCli(process.argv.slice(3),input.home,{config,parent:async()=>parent,execution,integration});
`
async function fixture(options: { count?: number; check?: string; setup?: string; code?: string; command?: string } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'children-execution-'))), tree = join(home, 'repo')
  await mkdir(join(tree, '.vegastack'), { recursive: true })
  git(tree, 'init', '-b', 'feat/parent'); git(tree, 'config', 'user.name', 'Fixture'); git(tree, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(tree, '.gitignore'), '.vegastack/.worktrees/\n')
  await writeFile(join(tree, '.vegastack/dev.md'), 'commands: check `' + (options.check ?? "test \"$(cat requested.txt)\" = accepted") + '`' + (options.setup ? ' · setup `' + options.setup + '`' : '') + '\n')
  git(tree, 'add', '.'); git(tree, 'commit', '-m', 'fixture base')
  const head = git(tree, 'rev-parse', 'HEAD'), input = diagnostic(runsRoot(home), tree, 1, head), parent = await createRun(input)
  const groups = { guard: 'plan-lint', ok: true, groups: Array.from({ length: options.count ?? 1 }, (_, i) => ({ id: 'g' + i, members: ['#' + (8 + i)], files: [i === 0 ? 'requested.txt' : 'requested-' + i + '.txt'] })) }
  const groupsFile = join(home, 'groups.json'), runInput = join(home, 'run-input.json'), runner = join(home, 'gateway.ts'), descriptor = join(home, 'input.json'), events = join(home, 'events')
  await writeFile(groupsFile, JSON.stringify(groups)); await writeFile(runInput, JSON.stringify(input)); await writeFile(runner, gateway)
  await writeFile(descriptor, JSON.stringify({ home, tree, groups: groupsFile, runInput, parent: parent.runId, code: options.code, command: options.command, events }))
  const argv = (verb: string, write = true) => [runner, descriptor, verb, '--parent', '1', '--repo', 'fixture/repo', '--groups', groupsFile, ...(write ? ['--write'] : []), '--json']
  const cli = async (verb: string, write = true) => {
    const child = Bun.spawn([process.execPath, ...argv(verb, write)], { stdout: 'pipe', stderr: 'pipe' })
    const stdout = await new Response(child.stdout).text(), stderr = await new Response(child.stderr).text(), exit = await child.exited
    let result; try { result = JSON.parse(stdout.trim().split('\n').at(-1)!) } catch { throw Error(stdout + stderr) }
    return { exit, result, stderr }
  }
  return { home, tree, head, parent, groups, groupsFile, runner, descriptor, events, argv, cli }
}

test('an unexecuted branch is not a child result', () => {
  const result = validateChildResult({ issue: 8, branch: 'feat/8', baseSha: 'a'.repeat(40), headSha: 'a'.repeat(40) }, { issue: 8, scopeDigest: 's', run: null })
  expect(result.ok).toBe(false); expect(result.reason).toMatch(/run|result|acceptance/)
})
test('actual CLI refuses immediate join; executes a real child and source check before exact ordered join', async () => {
  const f = await fixture()
  try {
    const early = await f.cli('join'); expect(early.exit).toBe(2); expect(git(f.tree, 'rev-parse', 'HEAD')).toBe(f.head)
    const preview = await f.cli('run', false); expect(preview.exit).toBe(0); expect(preview.result.wrote).toBe(false)
    const execution = await f.cli('run'); expect(execution.result.blocked, JSON.stringify(execution.result)).toEqual([]); expect(execution.exit).toBe(0)
    const result = execution.result.results[0]; expect(result.runId).toBeString(); expect(result.headSha).not.toBe(f.head)
    expect(spawnSync('git', ['show', result.headSha + ':requested.txt'], { cwd: f.tree, encoding: 'utf8' }).stdout).toBe('accepted\n')
    const runs = await readRuns(runsRoot(f.home)); expect(runs.find(run => run.runId === result.runId)?.processIdentity?.pid).toBeGreaterThan(0)
    expect(runs.filter(run => run.stage === 'acceptance' && run.terminationCause === 'succeeded')).toHaveLength(1)
    const resumed = await f.cli('run'); expect(resumed.exit).toBe(0); expect(resumed.result.results).toEqual(execution.result.results)
    expect((await readRuns(runsRoot(f.home))).filter(run => run.stage === 'implement' && run.parent === 1)).toHaveLength(1)
    const joined = await f.cli('join'); expect(joined.result.blocked, JSON.stringify(joined.result)).toEqual([]); expect(joined.exit).toBe(0)
    expect(joined.result.acceptedDeliveries).toEqual([]) // Diagnostic checks do not manufacture reviewed code delivery.
    expect(joined.result.receipts[0].fromSha).toBe(result.headSha); expect(joined.result.receipts[0].accepted).toBe(true)
    const after = git(f.tree, 'rev-parse', 'HEAD'); expect(after).not.toBe(f.head)
    expect(git(f.tree, 'show', 'HEAD:requested.txt')).toBe('accepted')
    const replay = await f.cli('join'); expect(replay.exit).toBe(0); expect(git(f.tree, 'rev-parse', 'HEAD')).toBe(after)
  } finally { await rm(f.home, { recursive: true, force: true }) }
}, 30000)
test('actual child failing acceptance never joins', async () => {
  const f = await fixture({ check: 'exit 9' })
  try { const run = await f.cli('run'); expect(run.exit).toBe(2); expect(run.result.results).toEqual([]); expect(run.result.blocked[0].reason).toContain('acceptance'); expect((await f.cli('join')).exit).toBe(2); expect(git(f.tree, 'rev-parse', 'HEAD')).toBe(f.head) }
  finally { await rm(f.home, { recursive: true, force: true }) }
}, 15000)
test('failed required setup preserves checkout and never spawns child', async () => {
  const f = await fixture({ setup: 'exit 7' })
  try { const run = await f.cli('run'); expect(run.exit).toBe(2); expect(run.result.blocked[0].reason).toContain('setup'); expect((await readRuns(runsRoot(f.home))).filter(run => run.parent === 1)).toHaveLength(0) }
  finally { await rm(f.home, { recursive: true, force: true }) }
}, 15000)

test('explicit positive acceptance permits no-change; a bare zero exit does not', async () => {
  const positive = await fixture({ code: 'process.exit(0)', check: 'test -f .vegastack/dev.md' })
  const negative = await fixture({ code: 'process.exit(0)' })
  try {
    const yes = await positive.cli('run'); expect(yes.exit).toBe(0); expect(yes.result.results[0].noChange).toBe(true); expect(yes.result.results[0].headSha).toBe(positive.head)
    const no = await negative.cli('run'); expect(no.exit).toBe(2); expect(no.result.results).toEqual([])
  } finally { await rm(positive.home, { recursive: true, force: true }); await rm(negative.home, { recursive: true, force: true }) }
}, 15000)
test('scope escape including removed intermediate files is refused', async () => {
  const f = await fixture({ check: 'true', code: `const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync('outside.txt','x');cp.execFileSync('git',['add','outside.txt']);cp.execFileSync('git',['commit','-m','outside']);fs.unlinkSync('outside.txt');cp.execFileSync('git',['add','outside.txt']);cp.execFileSync('git',['commit','-m','remove']);` })
  try { const result = await f.cli('run'); expect(result.exit).toBe(2); expect(result.result.blocked[0].reason).toContain('outside.txt'); expect(git(f.tree, 'rev-parse', 'HEAD')).toBe(f.head) }
  finally { await rm(f.home, { recursive: true, force: true }) }
}, 15000)
test('spawn failure and nonzero child exit are terminal and never replayed', async () => {
  for (const options of [{ command: '/nonexistent-child-executable' }, { code: 'process.exit(17)' }]) {
    const f = await fixture(options)
    try {
      expect((await f.cli('run')).exit).toBe(2); expect((await f.cli('run')).exit).toBe(2)
      expect((await readRuns(runsRoot(f.home))).filter(run => run.parent === 1 && run.stage === 'implement')).toHaveLength(1)
      expect((await f.cli('join')).exit).toBe(2)
    } finally { await rm(f.home, { recursive: true, force: true }) }
  }
}, 15000)
test('a stale source branch and a moved parent cannot be integrated', async () => {
  const f = await fixture()
  try {
    const executed = await f.cli('run'); expect(executed.exit).toBe(0)
    const child = executed.result.plan.children[0]
    await writeFile(join(child.path, 'requested.txt'), 'changed\n'); git(child.path, 'add', 'requested.txt'); git(child.path, 'commit', '-m', 'later source')
    const rejected = await f.cli('join'); expect(rejected.exit).toBe(2); expect(rejected.result.blocked[0].reason).toContain('source moved')
    expect(git(f.tree, 'rev-parse', 'HEAD')).toBe(f.head)
  } finally { await rm(f.home, { recursive: true, force: true }) }
}, 15000)
test('overlapping groups are refused before checkout preparation', async () => {
  const f = await fixture({ count: 2 })
  try {
    f.groups.groups[1]!.files = ['requested.txt']; await writeFile(f.groupsFile, JSON.stringify(f.groups))
    const result = await f.cli('run'); expect(result.exit).toBe(2); expect(result.result.blocked[0].reason).toContain('overlapping')
    expect((await readRuns(runsRoot(f.home))).filter(run => run.parent === 1)).toHaveLength(0)
  } finally { await rm(f.home, { recursive: true, force: true }) }
})
test('four independent child processes use only three local slots and the fourth follows an ended slot', async () => {
  const code = `const fs=require('node:fs'),cp=require('node:child_process');const file=process.argv.at(-1);fs.appendFileSync(process.env.CHILD_EVENTS,JSON.stringify({kind:'start',file,at:Date.now()})+'\\n');setTimeout(()=>{fs.writeFileSync(file,'accepted\\n');cp.execFileSync('git',['add',file]);cp.execFileSync('git',['commit','-m',file]);fs.appendFileSync(process.env.CHILD_EVENTS,JSON.stringify({kind:'end',file,at:Date.now()})+'\\n');},700);`
  const f = await fixture({ count: 4, code, check: 'true' })
  try {
    const result = await f.cli('run'); expect(result.result.blocked, JSON.stringify(result.result)).toEqual([]); expect(result.result.results).toHaveLength(4)
    const events = (await readFile(f.events, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    let active = 0, high = 0
    for (const event of events) { active += event.kind === 'start' ? 1 : -1; high = Math.max(high, active) }
    expect(high).toBe(3); expect(active).toBe(0)
    expect(events.findIndex(event => event.kind === 'start' && event.file === 'requested-3.txt')).toBeGreaterThan(events.findIndex(event => event.kind === 'end'))
  } finally { await rm(f.home, { recursive: true, force: true }) }
}, 20000)
test('CLI cancellation stops only its owned TERM-resistant child and descendants', async () => {
  const code = `const fs=require('node:fs'),cp=require('node:child_process');process.on('SIGTERM',()=>{});const child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},100)"],{stdio:'ignore'});fs.writeFileSync(process.env.CHILD_EVENTS,JSON.stringify({pid:process.pid,descendant:child.pid}));setInterval(()=>{},100);`
  const f = await fixture({ code, check: 'true' })
  const foreign = Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},100)'], { stdout: 'ignore', stderr: 'ignore' })
  try {
    const processRun = Bun.spawn([process.execPath, ...f.argv('run')], { stdout: 'pipe', stderr: 'pipe' })
    for (let i = 0; i < 100; i++) { try { await readFile(f.events); break } catch { await Bun.sleep(50) } }
    const owned = JSON.parse(await readFile(f.events, 'utf8'))
    processRun.kill('SIGTERM'); const stdout = await new Response(processRun.stdout).text(); expect(await processRun.exited).toBe(2)
    const result = JSON.parse(stdout.trim()); expect(result.results).toEqual([])
    expect(() => process.kill(foreign.pid, 0)).not.toThrow()
    for (const pid of [owned.pid, owned.descendant]) expect(() => process.kill(pid, 0)).toThrow()
    const child = (await readRuns(runsRoot(f.home))).find(run => run.parent === 1 && run.stage === 'implement')!
    expect(child.terminationCause).toBe('cancelled')
  } finally { foreign.kill(); await foreign.exited; await rm(f.home, { recursive: true, force: true }) }
}, 18000)

test('loss of the original parent authority cancels active owned execution', async () => {
  const f = await fixture({ check: 'true', code: `require('node:fs').writeFileSync(process.env.CHILD_EVENTS,String(process.pid));setInterval(()=>{},100)` })
  try {
    const child = Bun.spawn([process.execPath, ...f.argv('run')], { stdout: 'pipe', stderr: 'pipe' })
    for (let i = 0; i < 100; i++) { try { await readFile(f.events); break } catch { await Bun.sleep(50) } }
    const pid = Number(await readFile(f.events, 'utf8')); await writeFile(join(f.home, 'owner-lost'), 'lost')
    const output = JSON.parse(await new Response(child.stdout).text()); expect(await child.exited).toBe(2); expect(output.results).toEqual([])
    expect(() => process.kill(pid, 0)).toThrow()
  } finally { await rm(f.home, { recursive: true, force: true }) }
}, 15000)
test('killed parent gateway leaves no duplicate child on restart', async () => {
  const f = await fixture({ check: 'true', code: `require('node:fs').writeFileSync(process.env.CHILD_EVENTS,String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100)` })
  try {
    const child = Bun.spawn([process.execPath, ...f.argv('run')], { stdout: 'pipe', stderr: 'pipe' })
    for (let i = 0; i < 100; i++) { try { await readFile(f.events); break } catch { await Bun.sleep(50) } }
    const pid = Number(await readFile(f.events, 'utf8')); child.kill('SIGKILL'); await child.exited
    for (let i = 0; i < 160; i++) { try { process.kill(pid, 0); await Bun.sleep(50) } catch { break } }
    expect(() => process.kill(pid, 0)).toThrow()
    const restarted = await f.cli('run'); expect(restarted.exit).toBe(2); expect(restarted.result.blocked[0].reason).toContain('recovery')
    expect((await readRuns(runsRoot(f.home))).filter(run => run.parent === 1 && run.stage === 'implement')).toHaveLength(1)
  } finally { await rm(f.home, { recursive: true, force: true }) }
}, 15000)
test('real prepared checkout without required hooks refuses either managed harness', async () => {
  const f = await fixture(), { shipGuardWired } = await import('../src/dispatch.ts')
  try {
    for (const harness of ['claude', 'codex'] as const) expect((await shipGuardWired(f.tree, harness, { home: f.home, repo: 'fixture/repo' })).wired).toBe(false)
  } finally { await rm(f.home, { recursive: true, force: true }) }
})
test('exact checkpoint fetch works in a separate repository and rejects changed tree identity', async () => {
  const f = await fixture(), { fetchChildCheckpoint } = await import('../src/children.ts'), { parseFactoryConfig } = await import('../src/config.ts')
  try {
    const executed = await f.cli('run'); expect(executed.exit).toBe(0)
    const result = executed.result.results[0], run = (await readRuns(runsRoot(f.home))).find(row => row.runId === result.runId)!
    const remote = join(f.home, 'remote.git'), consumer = join(f.home, 'consumer')
    git(f.home, 'clone', '--bare', f.tree, remote); git(f.home, 'clone', remote, consumer)
    run.checkpoint = { schemaVersion: 1, id: randomUUID(), repo: run.repo, repositoryId: 'R_fixture', branch: run.branch, baseSha: run.baseSha, headSha: run.headSha!, treeSha: git(f.tree, 'rev-parse', result.headSha + '^{tree}'), scopeDigest: run.taskKey.scopeDigest, runId: run.runId, publishedAt: new Date().toISOString() }
    const transport = { repository: async () => ({ node_id: 'R_fixture' }), fetch: async (checkout: string, _repo: string, head: string) => { git(checkout, 'fetch', '--no-tags', remote, head) } }
    const config = parseFactoryConfig({ repos: [{ repo: run.repo, org: 'fixture', path: consumer }] }, f.home)
    await fetchChildCheckpoint({ checkout: consumer, run, config }, transport)
    expect(spawnSync('git', ['show', result.headSha + ':requested.txt'], { cwd: consumer, encoding: 'utf8' }).stdout).toBe('accepted\n')
    await expect(fetchChildCheckpoint({ checkout: consumer, run: { ...run, checkpoint: { ...run.checkpoint, treeSha: 'f'.repeat(40) } }, config }, transport)).rejects.toThrow('source identity')
  } finally { await rm(f.home, { recursive: true, force: true }) }
}, 15000)

// Real shared transaction/capacity code with a private in-memory transport. These
// diagnostic processes deliberately carry no vendor qualification or task-complete
// proof; confirmed process stop must free capacity while retaining task ownership.
test('shared queued fourth child follows verified stopped process without forged task completion', async () => {
  const f = await fixture({ count: 4, check: 'true' })
  const wire = await import('../src/shared-claims.ts'), runtime = await import('../src/runs.ts'), { processIdentity } = await import('../src/claims.ts')
  const { readHostBinding, readBootIdentityDigest } = await import('../src/machine-identity.ts')
  const { executeChildren, parentClaimBinding } = await import('../src/children.ts'), { parseFactoryConfig } = await import('../src/config.ts')
  const { createChildWorktree } = await import('../../../skills/dev/dev-implement/scripts/worktree.mjs')
  const host = (await readHostBinding()).digest, boot = await readBootIdentityDigest(), initial = '1'.repeat(40), installation = randomUUID()
  let head = initial, version = 1
  const versions = new Map([[head, { 'coordination/index.json': wire.canonical({ schemaVersion: 1, installationId: installation, revision: 0, active: [], machines: [] }) } as Record<string,string>]])
  const target: import('../src/shared-claims.ts').CoordinationTarget = {
    host: 'github.com', repository: 'fixture/control', repositoryId: 'R_state', branch: 'factory-state', rootCommit: initial, installationId: installation,
    localRoot: join(f.home, 'coordination'), random: () => 0,
    provider: {
      branch: async () => ({ id: 'REF', head, repositoryId: 'R_state', private: true, defaultBranch: 'main' }),
      read: async (_target, commit, path) => versions.get(commit)?.[path] ?? null,
      compare: async (_target, base, next) => base === next ? 'identical' : versions.has(base) && versions.has(next) && [...versions.keys()].indexOf(base) < [...versions.keys()].indexOf(next) ? 'ahead' : 'diverged',
      commit: async (_target, input) => { if (input.expectedHeadOid !== head) return { kind: 'conflict', reason: 'changed' }; head = (++version).toString(16).padStart(40,'0'); versions.set(head, { ...versions.get(input.expectedHeadOid), ...input.files }); return { kind: 'committed', head } },
    },
    verifyCandidate: async () => {},
    verifyChildRelationship: async ({ parent, child }) => { if (parent.runId !== f.parent.runId || child.parentBinding?.runId !== f.parent.runId || !f.groups.groups.some(group => group.members[0] === '#' + child.issue && wire.canonical(group.files) === wire.canonical(child.paths))) throw Error('fixture relationship differs'); return { maxChildren: 3 } },
    verifyTransition: async (task, transition) => {
      if ((transition.kind === 'stop' || transition.kind === 'block') && transition.stopProof) await runtime.verifySharedStopProof(transition.stopProof, task, target, await runtime.readRun(runsRoot(f.home),task.runId))
    },
    verifyEvidence: async (_ref, payload) => {
      if (payload?.kind !== 'effect-reconciliation') return
      const run = await runtime.readRun(runsRoot(f.home), payload.runId)
      // Physical termination is independent of unresolved effect coverage.
      if (payload.reasonCode !== 'owned-process-group-stopped' || !await runtime.verifyLocalRunStopped(run)) throw Error('physical stop unavailable')
    },
  }
  const machine: import('../src/shared-claims.ts').EffectiveMachine = { id: 'fixture-machine', installationId: randomUUID(), hostBindingDigest: host, executionLogin: 'fixture', group: 'dev', enabled: true,
    allowedRepositories: ['fixture/repo'], repositoryIds: { 'fixture/repo': 'R_repo' }, policyDigest: 'd'.repeat(64), coordination: { repository: target.repository, repositoryId: target.repositoryId, branch: target.branch, rootCommit: target.rootCommit, installationId: target.installationId }, defaults: { maxRuns: 1, childConcurrent: 3, recovery: 'verified-transfer' } }
  const session: import('../src/shared-claims.ts').MachineSession = { target, localRoot: target.localRoot, machineId: machine.id, installationId: machine.installationId, sessionId: randomUUID(), hostBindingDigest: host, bootIdDigest: boot, identity: await processIdentity() }
  const candidate: import('../src/shared-claims.ts').VerifiedCandidate = { host: 'github.com', repo: 'fixture/repo', issue: 1, repositoryNodeId: 'R_repo', issueNodeId: 'I_1', scopeDigest: f.parent.taskKey.scopeDigest, approvalDigest: 'd'.repeat(64), approvalBindings: [{ approvalId: 'fixture-only', source: { kind: 'github-comment', repositoryId: 'R_repo', issueNodeId: 'I_1', commentId: '1', bodySha256: 'd'.repeat(64) } }], runId: f.parent.runId, stage: 'implement', paths: [], resources: [], independent: false, parentTaskKey: null, approvedTaskIds: ['1-T1'] }
  const config = parseFactoryConfig({ repos: [{ repo: 'fixture/repo', org: 'fixture', path: f.tree }], subagents: { concurrent: 3 } }, f.home)
  try {
    const acquired = await wire.acquireSharedTask({ machine, session, candidate, operationId: randomUUID() }); if (acquired.kind !== 'owned') throw Error(acquired.reason)
    const started = await wire.transitionSharedTask({ claim: acquired.claim, operationId: randomUUID(), transition: { kind: 'start' } }); if (started.kind !== 'owned') throw Error(started.reason)
    const parent = started.claim
    const result = await executeChildren({ parent: f.parent, groups: f.groups, config, write: true }, {
      groups: async () => f.groups.groups, parentClaim: async () => parent, issue: async (_repo, issue) => ({ number: issue, title: 'child-' + issue }), verifyParent: async () => {}, verifyChild: async () => {}, processDeps: { wrapperPath: join(source,'run-wrapper.ts') },
      prepare: async (child, record) => {
        const prepared = createChildWorktree({ repoRoot:f.tree,issue:child.issue,slug:child.title,type:child.type,baseSha:record.baseSha,devMd:await readFile(join(f.tree,'.vegastack/dev.md'),'utf8'),home:f.home,write:true }); if(prepared.blocks.length)throw Error(prepared.blocks.join(';'))
        const original = diagnostic(runsRoot(f.home),child.path,child.issue,record.baseSha)
        const run = await createRun({ ...original, parent:1,branch:child.branch,hostBindingDigest:host,machine:{id:machine.id,installationId:machine.installationId,sessionId:session.sessionId,hostBindingDigest:host} })
        const code = `const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync(process.argv.at(-1),'accepted'+String.fromCharCode(10));cp.execFileSync('git',['add',process.argv.at(-1)]);cp.execFileSync('git',['commit','-m','child']);`
        return { run, localClaim:null, plan:{ command:process.execPath,args:['-e',code,child.files[0]!],env:{},cwd:child.path,prompt:'' } }
      },
      acquire: async (child, record, prepared) => {
        const acquired = await wire.acquireSharedTask({ machine, session, candidate: { ...candidate, issue:child.issue,issueNodeId:'I_'+child.issue,runId:prepared.run.runId,scopeDigest:prepared.run.taskKey.scopeDigest,paths:child.files,independent:true,parentTaskKey:parent.taskKey,parentBinding:record.parentBinding,approvedTaskIds:child.taskIds },operationId:prepared.run.claimOperationId! })
        if(acquired.kind!=='owned')throw Error(acquired.reason)
        const started = await wire.transitionSharedTask({ claim:acquired.claim,operationId:prepared.run.attemptOperationIds!.start,transition:{kind:'start'} });if(started.kind!=='owned')throw Error(started.reason)
        return started.claim
      },
      finish: async (claim, run) => {
        if(!claim)return
        expect(await runtime.verifyLocalRunStopped(run)).toBe(true)
        const payload: import('../src/shared-claims.ts').RecoveryEvidencePayload = {schemaVersion:2,kind:'effect-reconciliation',runId:run.runId,scopeDigest:run.taskKey.scopeDigest,approvalBindings:run.approvalBindings,allowedActionIds:[],checkedEffectIds:[],inspector:{kind:'qualified-adapter',identityRef:machine.id},result:'unresolved',reasonCode:'owned-process-group-stopped'}
        const receipt = await wire.publishRecoveryReceipt({claim,operationId:randomUUID(),payload})
        const stopProof: import('../src/shared-claims.ts').StopProof = {kind:'process-exit',machineId:machine.id,installationId:machine.installationId,sessionId:session.sessionId,hostBindingDigest:host,bootIdDigest:boot,runIds:[run.runId],generation:claim.generation,observedAt:run.finishedAt!,evidenceRef:receipt.reference}
        const stopped = await wire.transitionSharedTask({claim:receipt.claim,operationId:randomUUID(),transition:{kind:'stop',stopProof}})
        if(stopped.kind!=='owned')throw Error(stopped.reason)
      },
    })
    expect(result.blocked, JSON.stringify(result.blocked)).toEqual([])
    expect(result.results).toHaveLength(4)
    const snapshot = await wire.readCoordination(target)
    expect(snapshot.index.active).toHaveLength(5) // task/resource claims survive physical stop
    expect(Object.values(snapshot.tasks).filter(task=>task.parentTaskKey===parent.taskKey).every(task=>task.state==='stopped')).toBe(true)
  } finally { await rm(f.home,{recursive:true,force:true}) }
}, 30000)

test('production relationship callback revalidates canonical parent/child approval and original claim', async () => {
  const { spyOn } = await import('bun:test'), gh = await import('../src/gh.ts'), runtime = await import('../src/runs.ts')
  const { verifyChildRelationship } = await import('../src/children.ts'), wire = await import('../src/shared-claims.ts'), { processIdentity } = await import('../src/claims.ts')
  const { parseFactoryConfig } = await import('../src/config.ts'), { loadConfiguredPolicy } = await import('../src/control-room.ts')
  const approval = await import('../../../skills/dev/dev-implement/scripts/lib/approval.mjs')
  const f = await fixture(), previousScript = process.env.VSK_PREFLIGHT_SCRIPT
  process.env.VSK_PREFLIGHT_SCRIPT = resolve('skills/dev/dev-implement/scripts/preflight.mjs')
  const rows = new Map<number, { issue: any; comments: any[]; artifacts: any[]; authority: any }>()
  for (const issue of [1,8]) {
    const body = '<!-- vsk:v1 type=brief rev=1 scope=quick-build -->\n## Outcome\nComplete the controlled source.\n'
    const plan = '<!-- vsk:v1 type=plan rev=1 -->\n- [ ] **Task 1: controlled** <!-- task-id:' + issue + '-T1 -->\n  - Files — `requested.txt`\n  - Interfaces — existing source\n  - Steps: finish the declared source\n' + (issue === 1 ? '\n**Independent groups:**\n- `g0` — #8 · Files: `requested.txt`\n' : '')
    const artifacts = [{repo:'fixture/repo',issue,kind:'brief',artifactId:'I_'+issue,rev:1,digest:approval.scopeDigest(body,'brief')},{repo:'fixture/repo',issue,kind:'plan',artifactId:'PLAN_'+issue,rev:1,digest:approval.scopeDigest(plan,'plan')}]
    const event = {schemaVersion:2,id:'approved-'+issue,operator:'fixture',scope:'brief+plan',source:{kind:'session',ref:'session:fixture',quote:'I approve this exact fixture.'},artifacts,supersedes:[],revokes:[]}
    const commentBase = {issue_url:'https://api.github.com/repos/fixture/repo/issues/'+issue,user:{login:'fixture'}}
    const comments = [{...commentBase,id:issue*10+1,node_id:'PLAN_'+issue,body:plan,html_url:'https://github.com/fixture/repo/issues/'+issue+'#issuecomment-'+(issue*10+1)},
      {...commentBase,id:issue*10+2,node_id:'APPROVAL_'+issue,body:'<!-- vsk:v1 type=approval scope=brief+plan -->\n```json\n'+JSON.stringify(event)+'\n```\n',html_url:'https://github.com/fixture/repo/issues/'+issue+'#issuecomment-'+(issue*10+2)}]
    rows.set(issue,{issue:{id:issue,node_id:'I_'+issue,number:issue,title:'feat: controlled',body,state:'open',labels:[{name:'ready'},{name:'quick-build'}],assignees:[]},comments,artifacts,
      authority:{approvalId:event.id,source:{kind:'github-comment',repositoryId:'R_fixture',issueNodeId:'I_'+issue,commentId:String(issue*10+2),bodySha256:wire.sha256(comments[1]!.body)}}})
  }
  const reads: string[] = []
  const ghSpy = spyOn(gh,'ghText').mockImplementation(async args => {
    const endpoint = args.find(arg=>arg.startsWith('repos/')||arg==='user')?.split('?')[0] ?? ''; reads.push(endpoint)
    let value: unknown
    if(endpoint==='user')value={login:'fixture'}
    else if(endpoint==='repos/fixture/repo')value={node_id:'R_fixture'}
    else if(endpoint.endsWith('/dependencies/blocked_by'))value=[]
    else {
      const comment=/issues\/comments\/(\d+)$/.exec(endpoint), history=/issues\/(\d+)\/comments$/.exec(endpoint), issue=/issues\/(\d+)$/.exec(endpoint)
      if(comment)value=[...rows.values()].flatMap(row=>row.comments).find(row=>row.id===Number(comment[1]))
      else if(history)value=rows.get(Number(history[1]))?.comments
      else if(issue)value=rows.get(Number(issue[1]))?.issue
      else throw Error('unexpected source endpoint '+endpoint)
    }
    return (args.includes('--include')?'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n':'')+JSON.stringify(value)
  })
  try {
    const devMd='repo: fixture/repo · default branch main\noperators: fixture\ncommands: check `true`\n'
    await writeFile(join(f.tree,'.vegastack/dev.md'),devMd);git(f.tree,'add','.vegastack/dev.md');git(f.tree,'commit','-m','source policy')
    const head=git(f.tree,'rev-parse','HEAD'), config=parseFactoryConfig({repos:[{repo:'fixture/repo',org:'fixture',path:f.tree}]},f.home), policy=loadConfiguredPolicy({home:f.home,repo:'fixture/repo',devMd})
    const machine={id:'fixture-machine',installationId:randomUUID(),sessionId:randomUUID(),hostBindingDigest:'d'.repeat(64)}, originalOwner=randomUUID()
    // Structurally typed execution references only. No vendor runs or qualification
    // publication occurs in this authority-source test.
    const makeInput=(issue:number,checkout:string,branch:string):RunInput=>{const row=rows.get(issue)!;return{...diagnostic(runsRoot(f.home),checkout,issue,head),branch,harness:'codex',model:'fixture',effort:'high',accountRef:'fixture-subscription',execution:{providerMode:'subscription',harness:'codex',harnessVersion:'fixture',model:'fixture',effort:'high',accountRef:'fixture-subscription',qualification:row.authority.source},approvalBindings:[row.authority],approvalRefs:row.artifacts,policyDigest:policy.policy.policyDigest,machine,taskKey:{repo:'fixture/repo',issue,taskId:issue+'-T1',scopeDigest:wire.sha256(wire.canonical({artifacts:row.artifacts,taskIds:[issue+'-T1']}))}}}
    let parent=await createRun({...makeInput(1,f.tree,'feat/parent'),sharedClaim:{taskKey:'a'.repeat(64),generation:1,ownerToken:originalOwner,stateCommit:'1'.repeat(40)}})
    const identity=await processIdentity();parent=await runtime.transitionRun(parent.runId,parent.generation,{state:'running',processIdentity:identity,pid:identity.pid,processStartId:identity.startId,processGroupId:identity.pid},runsRoot(f.home))
    const childPath=join(f.tree,'.vegastack/.worktrees/8-child-8');git(f.tree,'worktree','add','-b','feat/8-child-8',childPath,head)
    const child=await createRun({...makeInput(8,childPath,'feat/8-child-8'),parent:1})
    const binding={taskKey:parent.sharedClaim!.taskKey,runId:parent.runId,generation:1,ownerToken:originalOwner,machineId:machine.id,installationId:machine.installationId,sessionId:machine.sessionId}
    const launch={schemaVersion:1,parentRunId:parent.runId,parentIssue:1,repo:parent.repo,parentBranch:parent.branch,baseSha:head,parentBinding:binding,concurrency:1,groups:f.groups.groups,children:[{group:'g0',issue:8,title:'child-8',type:'feat',branch:child.branch,path:childPath,files:['requested.txt'],resources:[],baseSha:head,runId:child.runId,scopeDigest:child.taskKey.scopeDigest,taskIds:['8-T1'],acceptanceCommand:'true'}]}
    await runtime.atomicRunFile(join(runsRoot(f.home),parent.runId,'children.json'),launch)
    const parentTask: import('../src/shared-claims.ts').TaskRecord = {schemaVersion:1,host:'github.com',repo:parent.repo,issue:parent.issue,repositoryNodeId:'R_fixture',issueNodeId:'I_1',scopeDigest:parent.taskKey.scopeDigest,approvalDigest:wire.sha256(wire.canonical(parent.approvalBindings)),approvalBindings:parent.approvalBindings,stage:'implement',state:'running',paths:[],resources:[],independent:false,parentTaskKey:null,parentBinding:null,approvedTaskIds:['1-T1'],checkpoint:null,stopProof:null,unresolvedEffects:[],recovery:null,acceptedScopes:[],taskKey:binding.taskKey,runId:parent.runId,generation:1,ownerToken:originalOwner,machineId:machine.id,installationId:machine.installationId,sessionId:machine.sessionId}
    const childTask: import('../src/shared-claims.ts').TaskRecord = {...parentTask,issueNodeId:'I_8',issue:8,repo:child.repo,runId:child.runId,parentTaskKey:binding.taskKey,parentBinding:binding,scopeDigest:child.taskKey.scopeDigest,paths:['requested.txt'],resources:[],independent:true,approvedTaskIds:['8-T1']}
    expect(await verifyChildRelationship({parent:parentTask,child:childTask},config)).toEqual({maxChildren:1})
    expect(reads).toContain('repos/fixture/repo/issues/1/comments');expect(reads).toContain('repos/fixture/repo/issues/8/comments')
    await expect(verifyChildRelationship({parent:{...parentTask,ownerToken:randomUUID()},child:childTask},config)).rejects.toThrow('original parent')
    await expect(verifyChildRelationship({parent:parentTask,child:{...childTask,paths:['outside.txt']}},config)).rejects.toThrow('exact approved parent group')
    rows.get(1)!.comments[0]!.body+='\nChanged scope\n'
    await expect(verifyChildRelationship({parent:parentTask,child:childTask},config)).rejects.toThrow()
  } finally { ghSpy.mockRestore(); if(previousScript===undefined)delete process.env.VSK_PREFLIGHT_SCRIPT;else process.env.VSK_PREFLIGHT_SCRIPT=previousScript;await rm(f.home,{recursive:true,force:true}) }
},30000)

test('packaged CLI entrypoint loads the authored helper owner and refuses an unregistered parent', async () => {
  const f = await fixture(), { cp } = await import('node:fs/promises')
  try {
    const packaged = join(f.home,'package'), dist = join(packaged,'dist')
    await mkdir(dist,{recursive:true})
    // Focused entrypoint assembly only. This is not the release build/scan gate.
    const built = await Bun.build({entrypoints:[join(source,'index.ts')],target:'node',outdir:dist})
    expect(built.success,built.logs.map(log=>log.message).join('\n')).toBe(true)
    await writeFile(join(packaged,'package.json'),JSON.stringify({type:'module',name:'@vegastack/vegafactory',version:'0.0.0-fixture'}))
    for(const name of ['dev-implement','dev-plan'])await cp(resolve('skills/dev',name),join(packaged,'skill',name),{recursive:true})
    const help=Bun.spawnSync(['node',join(dist,'index.js'),'children','--help'],{cwd:f.tree,env:{...process.env,HOME:f.home}})
    expect(help.exitCode,help.stderr.toString()).toBe(0);expect(help.stdout.toString()).toContain('children run|join')
    const config=join(f.home,'factory.json');await writeFile(config,JSON.stringify({repos:[{repo:'fixture/repo',org:'fixture',path:f.tree}]}))
    const refused=Bun.spawnSync(['node',join(dist,'index.js'),'children','run','--parent','1','--groups',f.groupsFile,'--repo','fixture/repo','--config',config,'--write','--json'],{cwd:f.tree,env:{...process.env,HOME:f.home}})
    expect(refused.exitCode).toBe(2);expect(refused.stdout.toString()).toContain('unique active owned parent run')
    expect(git(f.tree,'rev-parse','HEAD')).toBe(f.head)
  } finally { await rm(f.home,{recursive:true,force:true}) }
},15000)

test('second merge failure preserves first accepted join and pending Git state', async () => {
  const f=await fixture({count:2,check:'true'}),{chmod}=await import('node:fs/promises')
  try {
    expect((await f.cli('run')).exit).toBe(0)
    const hook=join(f.tree,'.git/hooks/pre-merge-commit'),counter=join(f.home,'merge-count')
    await writeFile(hook,'#!/bin/sh\nif test -f '+JSON.stringify(counter)+'; then exit 1; fi\ntouch '+JSON.stringify(counter)+'\n');await chmod(hook,0o755)
    const result=await f.cli('join');expect(result.exit).toBe(2);expect(result.result.receipts).toHaveLength(1);expect(result.result.receipts[0].accepted).toBe(true)
    expect(git(f.tree,'show','HEAD:requested.txt')).toBe('accepted')
    expect(git(f.tree,'rev-parse','MERGE_HEAD')).toMatch(/^[a-f0-9]{40}$/)
    const head=git(f.tree,'rev-parse','HEAD');expect((await f.cli('join')).exit).toBe(2);expect(git(f.tree,'rev-parse','HEAD')).toBe(head)
  } finally {await rm(f.home,{recursive:true,force:true})}
},20000)
test('crash after first applied join reconciles Git and never repeats that merge or check', async () => {
  const f=await fixture({count:2,check:'true'})
  try {
    expect((await f.cli('run')).exit).toBe(0)
    const descriptor=JSON.parse(await readFile(f.descriptor,'utf8'));descriptor.crashAfterFirstJoin=true;await writeFile(f.descriptor,JSON.stringify(descriptor))
    const crashed=Bun.spawn([process.execPath,...f.argv('join')],{stdout:'pipe',stderr:'pipe'});expect(await crashed.exited).not.toBe(0)
    const first=git(f.tree,'rev-parse','HEAD');expect(first).not.toBe(f.head)
    const checksBefore=(await readRuns(runsRoot(f.home))).filter(run=>run.stage==='acceptance').length
    const resumed=await f.cli('join');expect(resumed.result.blocked,JSON.stringify(resumed.result)).toEqual([]);expect(resumed.result.receipts).toHaveLength(2)
    expect(resumed.result.receipts[0].parentAfter).toBe(first)
    expect((await readRuns(runsRoot(f.home))).filter(run=>run.stage==='acceptance')).toHaveLength(checksBefore+1)
    expect(git(f.tree,'show','HEAD:requested-1.txt')).toBe('accepted')
  } finally {await rm(f.home,{recursive:true,force:true})}
},20000)
test('remote accepted join verifier refuses absent parent checkpoint after actual local acceptance', async () => {
  const f=await fixture(),{spyOn}=await import('bun:test'),runtime=await import('../src/runs.ts'),{verifyChildrenEvidence}=await import('../src/children.ts')
  let authority: ReturnType<typeof spyOn> | undefined
  try {
    expect((await f.cli('run')).exit).toBe(0);const joined=await f.cli('join');expect(joined.exit).toBe(0)
    const receipt=joined.result.receipts[0],parent=await runtime.readRun(runsRoot(f.home),f.parent.runId)
    const check=JSON.parse(await readFile(join(runsRoot(f.home),parent.runId,'join-'+receipt.runId+'-acceptance.json'),'utf8'))
    authority=spyOn(runtime,'verifyRunAuthority').mockResolvedValue(undefined)
    parent.authorityRequest={kind:'consolidated',parentRepo:parent.repo,parentIssue:parent.issue,approvalBinding:{commentId:1,bodySha256:'d'.repeat(64)},requested:{repo:parent.repo,issue:parent.issue,taskIds:['1-T1'],actionId:'integration',branch:parent.branch,baseSha:parent.baseSha,paths:['requested.txt'],operation:'integrate'}}
    await expect(verifyChildrenEvidence({run:parent,publishing:true,payload:{schemaVersion:2,kind:'join',childRunId:receipt.runId,generation:receipt.generation,fromSha:receipt.fromSha,parentBefore:receipt.parentBefore,parentAfter:receipt.parentAfter,state:'accepted',validationId:check.validationId,commandDigest:createHash('sha256').update(check.command).digest('hex'),result:'passed'}},(await import('../src/config.ts')).parseFactoryConfig({repos:[{repo:parent.repo,org:'fixture',path:f.tree}]},f.home))).rejects.toThrow('parent checkpoint unavailable')
  } finally {authority?.mockRestore();await rm(f.home,{recursive:true,force:true})}
},15000)

import { ownedLaunchEnvironment } from '../src/launch.ts'
test('owned child runtime replaces inherited parent run and attempt identity', async () => {
  const plan = (await import('../src/launch.ts')).buildLaunchPlan({harness:'codex',model:'fixture',effort:'high',stage:'implement',worktree:'/fixture',issue:{number:1,title:'fixture'},operator:'fixture',outcome:'fixture',stopList:[],resume:false,skillPath:null,subagents:{spawnDepth:1,concurrent:3}})
  plan.env.VSK_RUN_ID = 'untrusted-plan'
  const env = ownedLaunchEnvironment(plan, {runId:'actual-child',accountRef:'subscription-account'}, 'actual-attempt', {VSK_RUN_ID:'parent',VSK_ATTEMPT_ID:'parent-attempt',VSK_ACCOUNT_REF:'parent-account'})
  expect(env.VSK_RUN_ID).toBe('actual-child')
  expect(env.VSK_ATTEMPT_ID).toBe('actual-attempt')
  expect(env.VSK_ACCOUNT_REF).toBe('subscription-account')
})

test('failed independent child preserves its branch while a verified sibling still joins', async () => {
  const f=await fixture({count:2,check:'true',code:`if(process.argv.at(-1)==='requested.txt')process.exit(7);const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync(process.argv.at(-1),'accepted'+String.fromCharCode(10));cp.execFileSync('git',['add',process.argv.at(-1)]);cp.execFileSync('git',['commit','-m','sibling']);`})
  try {
    const executed=await f.cli('run');expect(executed.exit).toBe(2);expect(executed.result.results).toHaveLength(1)
    const joined=await f.cli('join');expect(joined.exit).toBe(2);expect(joined.result.receipts).toHaveLength(1);expect(joined.result.receipts[0].issue).toBe(9)
    expect(git(f.tree,'show','HEAD:requested-1.txt')).toBe('accepted')
    expect(git(f.tree,'show-ref','--verify','refs/heads/feat/8-child-8')).toContain(f.head)
  } finally {await rm(f.home,{recursive:true,force:true})}
},15000)


test('accepted task projection binds exact immutable scope and source identities',async()=>{
 const {acceptedDeliveryProjection}=await import('../src/children.ts'),{validateAcceptedDeliveries}=await import('../../../skills/dev/dev-implement/scripts/children.mjs')
 const snapshot={schemaVersion:2 as const,repo:'a/r',issue:144,artifacts:[{repo:'a/r',issue:144,kind:'brief' as const,artifactId:'I_144',rev:1,digest:'a'.repeat(64)},{repo:'a/r',issue:144,kind:'plan' as const,artifactId:'IC_144',rev:1,digest:'b'.repeat(64)}],approvalBindings:[{approvalId:'scope',source:{kind:'github-comment' as const,repositoryId:'R_app',issueNodeId:'I_133',commentId:'12',bodySha256:'c'.repeat(64)}}],approvedTaskIds:['144-T1','144-T2'],completedTaskIds:['144-T1','144-T2'],parentRepo:'a/r',parentIssue:133,parentBefore:'a'.repeat(40),parentAfter:'b'.repeat(40),acceptedAt:new Date().toISOString()}
 const rows=acceptedDeliveryProjection(snapshot,'c'.repeat(40),'d'.repeat(64))
 expect(rows.map(row=>row.taskRef.taskId)).toEqual(['144-T1','144-T2'])
 const expected={repo:'a/r',issue:144,scopeDigest:'d'.repeat(64),approvedTaskIds:snapshot.approvedTaskIds,childHead:'c'.repeat(40),parentRepo:'a/r',parentIssue:133,parentHead:'b'.repeat(40)}
 expect(validateAcceptedDeliveries(rows,expected).ok).toBe(true)
 expect(validateAcceptedDeliveries(rows,{...expected,parentHead:'e'.repeat(40)}).ok).toBe(false)
 expect(validateAcceptedDeliveries([...rows,rows[0]],expected).ok).toBe(false)
 expect(()=>acceptedDeliveryProjection({...snapshot,completedTaskIds:['144-T3']},'c'.repeat(40),'d'.repeat(64))).toThrow()
})

test('accepted-scope consumer trusts exactly one current operator review',async()=>{
  const {spyOn}=await import('bun:test'),gh=await import('../src/gh.ts'),runtime=await import('../src/runs.ts')
  const {exactReviewedChild}=await import('../src/children.ts'),{parseFactoryConfig}=await import('../src/config.ts')
  const home=await realpath(await mkdtemp(join(tmpdir(),'child-review-consumer-'))),tree=join(home,'repo')
  await mkdir(join(tree,'.vegastack'),{recursive:true})
  await writeFile(join(tree,'.vegastack/dev.md'),'repo: fixture/repo · default branch main\noperators: operator\n')
  const base='a'.repeat(40),head='b'.repeat(40),scope='c'.repeat(64)
  const run=await createRun({...diagnostic(runsRoot(home),tree,8,head),baseSha:base,headSha:head,
    approvalRefs:[{repo:'fixture/repo',issue:8,kind:'plan' as const,artifactId:'PLAN_8',rev:1,digest:scope}]})
  const review=(verdict:'clean'|'needs-fixes'='clean',findings:Array<{id:string;status:'open'|'resolved'}>=[])=>
    `<!-- vsk:v1 type=review sha=${head} verdict=${verdict} agent=codex -->\n\`\`\`json\n${JSON.stringify({reviewBinding:{sha:head,baseSha:base,scopeDigest:scope,verdict,findings}})}\n\`\`\`\n`
  let comments:Array<{id:number;body:string;user?:{login:string}}> = []
  const ghSpy=spyOn(gh,'ghText').mockImplementation(async()=>`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(comments)}`)
  const authority=spyOn(runtime,'verifyRunAuthority').mockResolvedValue(undefined)
  const config=parseFactoryConfig({repos:[{repo:'fixture/repo',org:'fixture',path:tree}]},home)
  try {
    comments=[{id:41,user:{login:'operator'},body:review('needs-fixes',[{id:'X1',status:'open'}])},{id:42,user:{login:'outsider'},body:review()}]
    await expect(exactReviewedChild(run,config)).rejects.toThrow(/X1/)
    expect(authority).not.toHaveBeenCalled()
    comments=[{id:41,user:{login:'operator'},body:review()}]
    await expect(exactReviewedChild(run,config)).resolves.toBeUndefined()
    expect(authority).toHaveBeenCalledTimes(1)
    comments=[{id:41,user:{login:'operator'},body:review()},{id:42,user:{login:'operator'},body:review()}]
    await expect(exactReviewedChild(run,config)).rejects.toThrow(/multiple|ambiguous/i)
    comments=[{id:41,body:review()}]
    await expect(exactReviewedChild(run,config)).rejects.toThrow(/source|publisher|metadata/i)
    comments=[{id:41,user:{login:'operator'},body:review()+review()}]
    await expect(exactReviewedChild(run,config)).rejects.toThrow(/duplicate|typed section|review/i)
  } finally {authority.mockRestore();ghSpy.mockRestore();await rm(home,{recursive:true,force:true})}
})
