import { expect, test, beforeEach } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listOutbox, appendSkillInvocations } from '../src/stats/outbox.ts'
import { recordRun, flushStats } from '../src/dispatch.ts'

const policy = { enabled: true, people: true, source: 'org' as const, refusal: null }
let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'vsk-dispatch-')) })

const input = {
  harness: 'claude' as const,
  stdout: JSON.stringify({ session_id: 'sess-1', duration_ms: 60_000, num_turns: 9, total_cost_usd: 0.9, is_error: false, usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 10 } }),
  exitCode: 0,
  startedAt: '2026-09-03T10:00:00.000Z',
  finishedAt: '2026-09-03T10:01:00.000Z',
  repo: 'vegastack/vegafactory', issue: 121, parent: 104, stage: 'implement',
  model: 'fable-5.1', effort: 'high', human: 'kmanojkumar',
  worktree: '/repo/.vegastack/.worktrees/121-statistics',
}

test('a finished run appends exactly one record carrying the run context', async () => {
  await recordRun(input, { home, hostname: 'mini', policy })
  const batches = await listOutbox(home)
  expect(batches).toHaveLength(1)
  const record = batches[0]!.records[0]!
  expect(record).toMatchObject({
    issue: 121, parent: 104, stage: 'implement', harness: 'claude', model: 'fable-5.1',
    effort: 'high', mode: 'headless', human: 'kmanojkumar', session_id: 'sess-1', outcome: 'complete',
  })
})

test('skills invoked during the run are folded in from the session sidecar', async () => {
  await appendSkillInvocations(home, 'sess-1', [{ name: 'dev-architect', trigger: 'model', harness: 'claude' }])
  await recordRun(input, { home, hostname: 'mini', policy })
  expect((await listOutbox(home))[0]!.records[0]!.skills)
    .toEqual([{ name: 'dev-architect', trigger: 'model', harness: 'claude' }])
})

test('a non-zero exit is recorded as failed, and unparseable stdout still yields a record', async () => {
  await recordRun({ ...input, exitCode: 1, stdout: 'crashed' }, { home, hostname: 'mini', policy })
  const record = (await listOutbox(home))[0]!.records[0]!
  expect(record.outcome).toBe('failed')
  expect(record.duration_s).toBe(60)
  expect(record.tokens.in).toBeNull()
})

test('with the policy off the run writes nothing', async () => {
  await recordRun(input, { home, hostname: 'mini', policy: { enabled: false, people: false, source: 'org', refusal: null } })
  expect(await listOutbox(home)).toEqual([])
})

test('a failed flush never throws into the tick', async () => {
  await recordRun(input, { home, hostname: 'mini', policy })
  const result = await flushStats({
    home, cloneRoot: await mkdtemp(join(tmpdir(), 'vsk-dispatch-clone-')),
    ghUser: 'kmanojkumar', hostname: 'mini',
    git: async () => { throw new Error('git missing') },
  })
  expect(result.ok).toBe(false)
  expect(await listOutbox(home)).toHaveLength(1)
})

test('the run record carries the issue\'s rework when the comments can be read, and null when they cannot', async () => {
  await recordRun(input, {
    home, hostname: 'mini', policy,
    rework: async () => ({ review_rounds: 2, fix_rounds: 1, handbacks: 0 }),
  })
  expect((await listOutbox(home))[0]!.records[0]).toMatchObject({ review_rounds: 2, fix_rounds: 1, handbacks: 0 })
  const blind = await mkdtemp(join(tmpdir(), 'vsk-dispatch-'))
  await recordRun(input, { home: blind, hostname: 'mini', policy, rework: async () => { throw new Error('HTTP 403') } })
  expect((await listOutbox(blind))[0]!.records[0]).toMatchObject({ review_rounds: null, fix_rounds: null, handbacks: null })
})

test('terminal timeout overrides vendor success in capture',async()=>{
  const {fromClaudeHeadless,fromCodexExec}=await import('../src/stats/capture.ts')
  const context={repo:'acme/app',ts:'2026-09-08T08:00:00Z',terminationCause:'timed-out' as const}
  expect(fromClaudeHeadless({is_error:false},context).outcome).toBe('failed')
  expect(fromCodexExec([{type:'turn.completed',usage:{input_tokens:1}}],context).outcome).toBe('failed')
})

test('durable terminal payload survives capture retry and shares exactly one identity', async () => {
  const {createRun,transitionRun,prepareTerminalCapture,readRun,runsRoot}=await import('../src/runs.ts')
  const {captureTerminalRun,normalizeRecord}=await import('../src/stats/record.ts')
  const {inspectSpool,spoolRoot}=await import('../src/stats/outbox.ts')
  const source={kind:'github-comment' as const,repositoryId:'R_repo',issueNodeId:'I_parent',commentId:'12',bodySha256:'a'.repeat(64)}
  const root=runsRoot(home)
  let run=await createRun({root,repo:'o/r',issue:1,parent:null,checkout:home,branch:'feat/1-work',baseSha:'a'.repeat(40),headSha:null,stage:'implement',harness:'codex',model:'same-model',effort:'high',execution:{providerMode:'subscription',harness:'codex',harnessVersion:'fixture',model:'same-model',effort:'high',accountRef:'same-account',qualification:source},approvalBindings:[{approvalId:'original',source}],recordBinding:null,approvalRefs:[],policyDigest:'b'.repeat(64),claimToken:crypto.randomUUID(),startedAt:new Date().toISOString(),taskKey:{repo:'o/r',issue:1,taskId:'1-T1',scopeDigest:'c'.repeat(64)},activeElapsedMs:10,taskOwner:null,agentAccountOwner:null,accountRef:'same-account',waitReason:null,machine:null,sharedClaim:null,checkpoint:null,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'fixture'}})
  run=await transitionRun(run.runId,run.generation,{state:'terminal',terminationCause:'succeeded',finishedAt:'2026-09-08T10:00:00.000Z'},root)
  await prepareTerminalCapture(root,run.runId,normalizeRecord({repo:'o/r',issue:1,ts:run.finishedAt!,stage:'implement',outcome:'complete'}))
  const destination={host:'github.com' as const,org:'o',repo:'o/r',controlRoom:'o/room'}
  expect(await captureTerminalRun(home,run.runId,destination,{...policy,enabled:false})).toBeNull()
  expect((await readRun(root,run.runId)).pendingDelivery[0]?.status).toBe('pending')
  const first=await captureTerminalRun(home,run.runId,destination,policy)
  const retry=await captureTerminalRun(home,run.runId,destination,policy)
  expect(first).toBe(retry)
  expect(first).not.toBe(run.runId)
  expect((await inspectSpool(spoolRoot(home))).events).toHaveLength(1)
  expect((await readRun(root,run.runId)).pendingDelivery[0]?.status).toBe('acknowledged')
  const {atomicRunFile,parseRun}=await import('../src/runs.ts'),{readFile}=await import('node:fs/promises')
  const {spoolEventFile}=await import('../src/stats/outbox.ts')
  const initialEvent=(await inspectSpool(spoolRoot(home))).events[0]!
  const initialBytes=await readFile(spoolEventFile(spoolRoot(home),initialEvent),'utf8')
  const saved=await readRun(root,run.runId),sequence=crypto.randomUUID()
  //138 separately proves continuation admission. This transport fixture supplies its exact
  // admitted private shape and checks that143 never substitutes the earlier segment payload.
  const continued=parseRun({...saved,attemptId:sequence,terminalSegment:{sequence,firstAttemptId:sequence},startedAt:'2026-09-08T10:01:00.000Z',finishedAt:'2026-09-08T10:02:00.000Z',attempts:[{id:saved.attemptId!,startedAt:saved.startedAt,finishedAt:saved.finishedAt,processIdentity:null,processGroupId:null,terminationCause:saved.terminationCause,exitCode:null,activeElapsedMs:10,terminalSequence:'0'}]})
  await atomicRunFile(join(root,run.runId,'run.json'),continued)
  await prepareTerminalCapture(root,run.runId,normalizeRecord({repo:'o/r',issue:1,ts:continued.finishedAt!,stage:'implement',outcome:'complete',duration_s:60}))
  const second=await captureTerminalRun(home,run.runId,destination,policy)
  expect(second).not.toBe(first);expect(await captureTerminalRun(home,run.runId,destination,policy)).toBe(second)
  const events=(await inspectSpool(spoolRoot(home))).events
  expect(events).toHaveLength(2)
  const next=events.find(e=>e.eventId===second)!
  expect(next.captureKey).toBe(`${run.runId}:terminal:${sequence}`)
  expect(next.payload).toMatchObject({executionRef:initialEvent.payload.recordKind==='execution'?initialEvent.payload.executionRef:null,startedAt:continued.startedAt,values:{duration_s:60}})
  expect(await readFile(spoolEventFile(spoolRoot(home),initialEvent),'utf8')).toBe(initialBytes)
  expect((await readRun(root,run.runId)).pendingDelivery.filter(p=>p.kind==='telemetry-capture').map(p=>p.status)).toEqual(['acknowledged','acknowledged'])
})

test('managed hook refuses unknown identities, malformed IDs and reentered Stop without storage', async () => {
  const {parseManagedHook,consumeManagedHook}=await import('../src/stats/record.ts')
  const {readdir}=await import('node:fs/promises')
  const hook={harness:'codex',event:'SessionStart',sessionId:'known',cwd:home,stopHookActive:false}
  expect(parseManagedHook(JSON.stringify(hook))).not.toBeNull()
  expect(parseManagedHook(JSON.stringify({...hook,sessionId:undefined}))).toBeNull()
  expect(parseManagedHook(JSON.stringify({...hook,event:'Stop',stopHookActive:true}))).toBeNull()
  expect(parseManagedHook(JSON.stringify({...hook,transcript_path:'/private/data'}))).toBeNull()
  let callbacks=0
  expect(await consumeManagedHook(home,JSON.stringify(hook),async()=>{callbacks++})).toBeNull()
  expect(callbacks).toBe(0)
  expect(await readdir(home)).toEqual([])
})

async function managedHookFixtureProof(route:'source'|'bundled'|'callback'):Promise<void>{
  const fs=await import('node:fs/promises'),{execFileSync,spawn}=await import('node:child_process'),{resolve}=await import('node:path'),{pathToFileURL}=await import('node:url')
  const runtime=await import('../src/runs.ts'),recordOwner=await import('../src/stats/record.ts'),{processIdentity}=await import('../src/claims.ts'),policyOwner=await import('../../../skills/dev/dev-setup/scripts/effective-policy.mjs')
  const canonicalHome=await fs.realpath(home),repo=join(canonicalHome,'repo'),room=join(canonicalHome,'room'),installed=join(canonicalHome,'installed'),hooks=join(repo,'.vegastack','hooks'),sourceHooks=resolve('skills/dev/dev-setup/assets/hooks')
  const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}}).trim()
  await fs.mkdir(hooks,{recursive:true});await fs.mkdir(join(room,'groups','dev'),{recursive:true});await fs.mkdir(join(canonicalHome,'.vegastack'),{mode:0o700});await fs.mkdir(join(installed,'dist'),{recursive:true});await fs.mkdir(join(installed,'skill','dev-setup','assets','hooks'),{recursive:true})
  const devMd='repo: a/r\ncontrol-room: a/room#dev\nsync-max-age: 2h\n'
  await fs.writeFile(join(repo,'.vegastack','dev.md'),devMd)
  await fs.writeFile(join(room,'org.md'),'stats: on\nsync-max-age: 2h\n');await fs.writeFile(join(room,'groups','dev','group.md'),'review: subagent\n')
  await fs.writeFile(join(room,'repos.md'),'| repo | group | owner | repository-id |\n|---|---|---|---|\n| a/r | dev | robot | R_app |\n')
  await fs.writeFile(join(room,'people.csv'),'login,name,role,slack,timezone,groups\nrobot,Robot,member,,UTC,dev\n')
  git(room,'init','-b','main');git(room,'remote','add','origin','https://github.com/a/room.git');git(room,'add','.');git(room,'commit','-m','fixture policy')
  const snapshot={schemaVersion:2,org:'a',group:'dev',repository:'a/room',origin:'https://github.com/a/room.git',sourceCommit:git(room,'rev-parse','HEAD'),policyDigest:'0'.repeat(64),validatedAt:new Date().toISOString(),contentPath:room}
  snapshot.policyDigest=policyOwner.loadSnapshotPolicy({snapshot,repo:'a/r',devMd}).policy.policyDigest
  expect(policyOwner.loadSnapshotPolicy({snapshot,repo:'a/r',devMd}).ok).toBe(true)
  await fs.writeFile(join(canonicalHome,'.vegastack','factory.json'),JSON.stringify({schemaVersion:2,revision:1,repos:[{repo:'a/r',path:repo,org:'a'}],controlRooms:{a:{repo:'a/room',path:room,branch:'main',remote:snapshot.origin,lastSyncedAt:snapshot.validatedAt,sha:snapshot.sourceCommit,snapshots:{'a/r':snapshot}}}}),{mode:0o600})
  const source={kind:'github-comment' as const,repositoryId:'R_app',issueNodeId:'I_1',commentId:'12',bodySha256:'a'.repeat(64)}
  let run=await runtime.createRun({root:runtime.runsRoot(canonicalHome),repo:'a/r',issue:1,parent:null,checkout:repo,branch:'feat/1-work',baseSha:'a'.repeat(40),headSha:null,stage:'implement',harness:'codex',model:'fixture',effort:'high',execution:{providerMode:'subscription',harness:'codex',harnessVersion:'fixture',model:'fixture',effort:'high',accountRef:'fixture',qualification:source},approvalBindings:[{approvalId:'fixture',source}],recordBinding:null,approvalRefs:[],policyDigest:snapshot.policyDigest,claimToken:crypto.randomUUID(),startedAt:new Date().toISOString(),taskKey:{repo:'a/r',issue:1,taskId:'1-T1',scopeDigest:'c'.repeat(64)},activeElapsedMs:10,taskOwner:null,agentAccountOwner:null,accountRef:'fixture',waitReason:null,machine:null,sharedClaim:null,checkpoint:null,hostBindingDigest:(await(await import('../src/machine-identity.ts')).readHostBinding()).digest,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'controlled-source-fixture'}})
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})
  const identity=await processIdentity(child.pid!)
  const exited=new Promise<void>(done=>child.once('exit',()=>done()));child.kill('SIGTERM');await exited
  run=await runtime.transitionRun(run.runId,run.generation,{state:'terminal',terminationCause:'succeeded',finishedAt:new Date().toISOString(),pid:identity.pid,processStartId:identity.startId,processGroupId:identity.pid,processIdentity:identity,vendorSessionId:'owned-vendor-session'},runtime.runsRoot(canonicalHome))
  await runtime.prepareTerminalCapture(runtime.runsRoot(canonicalHome),run.runId,recordOwner.normalizeRecord({repo:'a/r',issue:1,ts:run.finishedAt!,session_id:'owned-vendor-session',stage:'implement',outcome:'complete'}))
  expect(await runtime.findOwnedRunSession(runtime.runsRoot(canonicalHome),{sessionId:'owned-vendor-session',cwd:repo})).not.toBeNull()
  expect(await recordOwner.registeredCaptureContext(canonicalHome,'a/r',repo)).not.toBeNull()
  if(route==='callback'){
    const raw=(event:string)=>JSON.stringify({harness:'codex',event,sessionId:'owned-vendor-session',cwd:repo,stopHookActive:false})
    let callbacks=0
    expect(await recordOwner.consumeManagedHook(canonicalHome,raw('SessionStart'),async value=>{
      callbacks++;expect(value.context.effectivePolicy.ok).toBe(true)
      expect(value.context.effectivePolicy.policy.policyDigest).toBe(snapshot.policyDigest)
    })).toBeNull() // A callback cannot turn SessionStart into terminal capture success.
    const {inspectSpool,spoolRoot}=await import('../src/stats/outbox.ts')
    expect((await inspectSpool(spoolRoot(canonicalHome))).events).toHaveLength(0)
    expect(await recordOwner.consumeManagedHook(canonicalHome,raw('Stop'),async value=>{
      callbacks++;expect(value.input.sessionId).toBe('owned-vendor-session')
      expect((await inspectSpool(spoolRoot(canonicalHome))).events).toHaveLength(1)
      expect((await runtime.readRun(runtime.runsRoot(canonicalHome),value.run.runId)).pendingDelivery[0]?.status).toBe('acknowledged')
    })).toEqual({ok:true})
    expect(callbacks).toBe(2)
    expect(await recordOwner.consumeManagedHook(canonicalHome,raw('Stop'),async()=>{throw Error('lesson refused')})).toBeNull()
    expect((await inspectSpool(spoolRoot(canonicalHome))).events).toHaveLength(1)
    return
  }
  const shared=await fs.readFile(join(sourceHooks,'session-start.mjs')),{hashBytes}=await import('../src/stats/types.ts')
  for(const name of ['session-start.mjs','stop-heartbeat.mjs','session-end.mjs'])await fs.copyFile(join(sourceHooks,name),join(hooks,name))
  await fs.writeFile(join(installed,'skill','dev-setup','assets','hooks','session-start.mjs'),shared)
  await fs.writeFile(join(installed,'package.json'),JSON.stringify({name:'@vegastack/vegafactory',type:'module',bin:{vegafactory:'dist/index.js'}}))
  await fs.writeFile(join(installed,'skill-integrity.json'),JSON.stringify({schemaVersion:2,skills:{'dev-setup':{files:{'assets/hooks/session-start.mjs':hashBytes(shared)}}}}))
  // Exercise both the actual source index and its bundled command router. Runtime scripts
  // come from authored packaging entries, never the possibly stale generated skill tree.
  // Release packing and actual vendor qualification remain #158.
  if(route === 'source') {
    await fs.writeFile(join(installed,'dist','index.js'),`await import(${JSON.stringify(pathToFileURL(resolve('packages/cli/src/index.ts')).href)});`)
  } else {
    const packaging=JSON.parse(await fs.readFile(resolve('packages/cli/packaging.json'),'utf8')) as Record<string,string[]>
    const skillPaths=new Map<string,string>()
    for(const group of await fs.readdir(resolve('skills'),{withFileTypes:true}))if(group.isDirectory()){
      for(const skill of await fs.readdir(resolve('skills',group.name),{withFileTypes:true}))if(skill.isDirectory())skillPaths.set(skill.name,resolve('skills',group.name,skill.name))
    }
    for(const [name,entries] of Object.entries(packaging))for(const entry of entries){
      const [relative,owner]=entry.split('@')
      if(!relative!.startsWith('scripts/'))continue
      const target=join(installed,'skill',name,relative!)
      await fs.mkdir((await import('node:path')).dirname(target),{recursive:true})
      await fs.copyFile(join(skillPaths.get(owner??name)!,relative!),target)
    }
    const build=await Bun.build({entrypoints:[resolve('packages/cli/src/index.ts')],target:'node',outdir:join(installed,'dist'),naming:'index.js'})
    expect(build.success).toBe(true)
  }
  // Keep the adapter's silent outward behavior, but retain its actual child result in this
  // controlled fixture so a timeout or module-load error cannot masquerade as capture success.
  const probe=join(canonicalHome,'hook-child-probe.cjs'),childResults=join(canonicalHome,'hook-child-results.jsonl')
  await fs.writeFile(probe,`const cp=require('node:child_process'),fs=require('node:fs'),mod=require('node:module'),originalSync=cp.spawnSync,originalSpawn=cp.spawn;
const record=value=>fs.appendFileSync(${JSON.stringify(childResults)},JSON.stringify(value)+'\\n');
cp.spawnSync=function(command,args,options){if(!args?.includes('managed-hook'))return originalSync.call(this,command,args,options);
const start=performance.now(),result=originalSync.call(this,command,args,{...options,stdio:['pipe','pipe','pipe']});
record({status:result.status,signal:result.signal,error:result.error?.code??null,stderr:result.stderr,elapsedMs:performance.now()-start,timeoutMs:options.timeout});return result;};
cp.spawn=function(command,args,options){if(!args?.includes('managed-hook'))return originalSpawn.call(this,command,args,options);
const start=performance.now(),stdio=[...options.stdio];stdio[2]='pipe';const child=originalSpawn.call(this,command,args,{...options,stdio});let error=null,stderr='',phaseStart=null,phaseFinish=null;
child.stderr?.on('data',data=>{stderr=(stderr+data).slice(0,4096)});child.on('error',value=>{error=value.code});
const send=child.send?.bind(child);if(send)child.send=function(message,...rest){if(message?.vskManagedHook===1&&message.phase==='start')phaseStart=performance.now();return send(message,...rest)};
child.on('message',message=>{if(message?.vskManagedHook===1&&message.phase==='finish')phaseFinish=performance.now()});
child.once('close',(status,signal)=>record({status,signal,error,stderr,elapsedMs:performance.now()-start,finished:phaseFinish!==null,phaseMs:phaseStart===null?null:(phaseFinish??performance.now())-phaseStart}));return child;};mod.syncBuiltinESMExports();`)
  const assertChildSucceeded=async()=>{
    const results=(await fs.readFile(childResults,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
    const last=results.at(-1)
    expect(last).toMatchObject({status:0,signal:null,error:null,stderr:''})
    if(Object.hasOwn(last,'finished')){expect(last.finished).toBe(true);expect(last.phaseMs).toBeLessThanOrEqual(500)}
  }
  const node=Bun.which('node')!,invoke=(name:string,event:string,session='owned-vendor-session',cwd=repo)=>execFileSync(node,[join(hooks,name),'--harness','codex'],{cwd:repo,encoding:'utf8',input:JSON.stringify({hook_event_name:event,session_id:session,cwd,transcript_path:'/never/read/private-transcript'}),env:{...process.env,HOME:canonicalHome,NODE_OPTIONS:`--require=${probe}`,VSK_VEGAFACTORY:join(installed,'dist','index.js')},timeout:2000})
  const before=(await runtime.readRun(runtime.runsRoot(canonicalHome),run.runId)).generation
  expect(invoke('session-start.mjs','SessionStart','unknown-session')).toBe('')
  expect(invoke('stop-heartbeat.mjs','Stop','owned-vendor-session','/foreign/cwd')).toBe('')
  expect((await runtime.readRun(runtime.runsRoot(canonicalHome),run.runId)).generation).toBe(before)
  const {inspectSpool,spoolRoot}=await import('../src/stats/outbox.ts')
  for(const [hook,event] of [['stop-heartbeat.mjs','Stop'],['session-end.mjs','SessionEnd']] as const){
    expect(invoke(hook,event)).toBe('')
    await assertChildSucceeded()
    expect((await inspectSpool(spoolRoot(canonicalHome))).events).toHaveLength(1)
    expect((await runtime.readRun(runtime.runsRoot(canonicalHome),run.runId)).pendingDelivery[0]?.status).toBe('acknowledged')
  }
  let validatedCalls=0
  const normalized=JSON.stringify({harness:'codex',event:'Stop',sessionId:'owned-vendor-session',cwd:repo,stopHookActive:false})
  expect(await recordOwner.consumeManagedHook(canonicalHome,normalized,async value=>{
    validatedCalls++
    expect(value.input.sessionId).toBe('owned-vendor-session')
    expect(value.context.effectivePolicy.ok).toBe(true)
    expect(value.context.effectivePolicy.policy.policyDigest).toBe(snapshot.policyDigest)
    expect((await runtime.readRun(runtime.runsRoot(canonicalHome),value.run.runId)).pendingDelivery[0]?.status).toBe('acknowledged')
  })).toEqual({ok:true})
  expect(validatedCalls).toBe(1)
  expect(await recordOwner.consumeManagedHook(canonicalHome,normalized,async()=>{throw Error('lesson refused')})).toBeNull()
  await fs.writeFile(join(room,'org.md'),'stats: on\nlearning: off\nsync-max-age: 2h\n');git(room,'add','.');git(room,'commit','-m','disable learning')
  snapshot.sourceCommit=git(room,'rev-parse','HEAD');snapshot.policyDigest='0'.repeat(64)
  snapshot.policyDigest=policyOwner.loadSnapshotPolicy({snapshot,repo:'a/r',devMd}).policy.policyDigest
  const settings=JSON.parse(await fs.readFile(join(canonicalHome,'.vegastack','factory.json'),'utf8'));settings.controlRooms.a.snapshots['a/r']=snapshot
  await fs.writeFile(join(canonicalHome,'.vegastack','factory.json'),JSON.stringify(settings))
  const disabledGeneration=(await runtime.readRun(runtime.runsRoot(canonicalHome),run.runId)).generation
  expect(invoke('stop-heartbeat.mjs','Stop')).toBe('')
  expect((await runtime.readRun(runtime.runsRoot(canonicalHome),run.runId)).generation).toBe(disabledGeneration)
  expect(await recordOwner.consumeManagedHook(canonicalHome,normalized,async()=>{validatedCalls++})).toBeNull()
  expect(validatedCalls).toBe(1)
}
test.each(['source','bundled'] as const)('installed managed hook (%s) resolves owned terminal session and Stop/SessionEnd share one durable capture',managedHookFixtureProof,10000)
test('managed hook callback receives fresh private authority only after durable capture',()=>managedHookFixtureProof('callback'),10000)

test('actual failed child argv and stdout never enter basic diagnostic files',async()=>{
 const {executeRun}=await import('../src/dispatch.ts'),{parseFactoryConfig}=await import('../src/config.ts')
 const {readFile,stat}=await import('node:fs/promises'),{resolve}=await import('node:path')
 const secret='ghp_PRIVATE_STDOUT_CANARY',native='NATIVE_MEMORY_CANARY'
 const code=`process.stdout.write(${JSON.stringify(secret)});process.stderr.write(${JSON.stringify(native)});process.exit(1)`
 const result=await executeRun({repo:'o/r',issue:1,title:'fixture',stage:'implement',commentId:null,reactionId:null},{command:process.execPath,args:['-e',code],cwd:home,env:{},prompt:''},parseFactoryConfig({repos:[{repo:'o/r',org:'o',path:home}]},home),{operator:null},{wrapperPath:resolve('packages/cli/src/run-wrapper.ts')})
 expect(result.terminationCause).toBe('failed')
 expect(result.stdout).toContain(secret) // transient structured-capture input only
 const log=await readFile(result.logFile,'utf8')
 expect(log).not.toContain('CANARY');expect(log).not.toContain(code);expect(log).not.toContain(home)
 expect((await stat(result.logFile)).mode&0o777).toBe(0o600)
 const {basicDiagnostic}=await import('../src/stats/privacy.ts')
 for(const line of log.trim().split('\n')){const row=JSON.parse(line);expect(row).toEqual(basicDiagnostic(row.at,row.event,row))}
 expect(result.handedBack).toBe(false)
},10000)

test('CLI legacy hooks do not read a supplied transcript or native-memory path',async()=>{
 const {parseStatsArgs,runStats}=await import('../src/stats/cli.ts')
 let reads=0
 const code=await runStats(parseStatsArgs(['record','--source','claude-session-end']),{home,hostname:'fixture',ghUser:'alice',login:'alice',isLead:false,policy,repo:'o/r',cloneRoot:home,git:async()=>({code:0,stdout:'',stderr:''}),gh:async()=>[],readStdin:async()=>JSON.stringify({session_id:'fixture',transcript_path:'/Users/private/.claude/NATIVE_MEMORY_CANARY'}),readTranscript:async()=>{reads++;throw Error('native-memory-read')},now:()=>new Date(),log:()=>{}})
 expect(code).toBe(0);expect(reads).toBe(0)
})

test('an older pending terminal segment replays only its immutable snapshot after continuation',async()=>{
  const runtime=await import('../src/runs.ts'),{captureTerminalRun,normalizeRecord}=await import('../src/stats/record.ts')
  const {inspectSpool,spoolRoot,spoolEventFile}=await import('../src/stats/outbox.ts')
  const {hashBytes}=await import('../src/stats/types.ts'),fs=await import('node:fs/promises')
  const source={kind:'github-comment' as const,repositoryId:'R_repo',issueNodeId:'I_parent',commentId:'12',bodySha256:'a'.repeat(64)},root=runtime.runsRoot(home)
  const destination={host:'github.com' as const,org:'o',repo:'o/r',controlRoom:'o/room'}
  let prior=await runtime.createRun({root,repo:'o/r',issue:1,parent:null,checkout:home,branch:'feat/1-work',baseSha:'a'.repeat(40),headSha:null,stage:'implement',harness:'codex',model:'fixture',effort:'high',execution:{providerMode:'subscription',harness:'codex',harnessVersion:'fixture',model:'fixture',effort:'high',accountRef:'fixture',qualification:source},approvalBindings:[{approvalId:'original',source}],recordBinding:null,approvalRefs:[],policyDigest:'b'.repeat(64),claimToken:crypto.randomUUID(),startedAt:'2026-09-08T09:59:00.000Z',taskKey:{repo:'o/r',issue:1,taskId:'1-T1',scopeDigest:'c'.repeat(64)},activeElapsedMs:10,taskOwner:null,agentAccountOwner:null,accountRef:'fixture',waitReason:null,machine:null,sharedClaim:null,checkpoint:null,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'fixture'}})
  prior=await runtime.transitionRun(prior.runId,prior.generation,{state:'terminal',terminationCause:'interrupted',finishedAt:'2026-09-08T10:00:00.000Z'},root)
  await runtime.prepareTerminalCapture(root,prior.runId,normalizeRecord({repo:'o/r',issue:1,ts:prior.finishedAt!,duration_s:10,outcome:'failed'}))
  prior=await runtime.readRun(root,prior.runId)
  const runFile=join(root,prior.runId,'run.json'),priorBytes=await fs.readFile(runFile,'utf8'),snapshotDigest=hashBytes(priorBytes),history=join(root,prior.runId,'history')
  await fs.mkdir(history,{mode:0o700})
  const snapshotFile=join(history,`${prior.attemptId}.${snapshotDigest}.json`)
  await fs.writeFile(snapshotFile,priorBytes,{mode:0o600})
  const sequence=crypto.randomUUID(),previous={id:prior.attemptId!,startedAt:prior.startedAt,finishedAt:prior.finishedAt,processIdentity:null,processGroupId:null,terminationCause:prior.terminationCause,exitCode:null,activeElapsedMs:10,terminalSequence:'0',snapshotDigest}
  // Exact138 continuation output shape, with the original pending bytes and digest-bound
  // snapshot intact.138 tests the admission constructor; this case tests143 replay selection.
  const current=runtime.parseRun({...prior,generation:prior.generation+1,attemptId:sequence,terminalSegment:{sequence,firstAttemptId:sequence},attempts:[previous],startedAt:'2026-09-08T10:01:00.000Z',finishedAt:'2026-09-08T10:02:00.000Z',terminationCause:'succeeded'})
  await runtime.atomicRunFile(runFile,current)
  await runtime.prepareTerminalCapture(root,current.runId,normalizeRecord({repo:'o/r',issue:1,ts:current.finishedAt!,duration_s:60,outcome:'complete'}))
  const laterId=await captureTerminalRun(home,current.runId,destination,policy)
  expect((await runtime.readRun(root,current.runId)).pendingDelivery.map(p=>p.status)).toEqual(['pending','acknowledged'])
  const later=(await inspectSpool(spoolRoot(home))).events[0]!,laterBytes=await fs.readFile(spoolEventFile(spoolRoot(home),later),'utf8')
  const oldKey=runtime.terminalCaptureDescriptor(prior).captureKey
  await fs.rename(snapshotFile,snapshotFile+'.held')
  try{await expect(captureTerminalRun(home,current.runId,destination,policy,oldKey)).rejects.toThrow('terminal-capture-history-unavailable')}
  finally{await fs.rename(snapshotFile+'.held',snapshotFile)}
  expect((await runtime.readRun(root,current.runId)).pendingDelivery[0]?.status).toBe('pending')
  await expect(captureTerminalRun(home,current.runId,destination,policy,`${crypto.randomUUID()}:terminal:0`)).rejects.toThrow('terminal-capture-key-unavailable')
  const oldId=await captureTerminalRun(home,current.runId,destination,policy,oldKey)
  expect(oldId).not.toBe(laterId);expect(await captureTerminalRun(home,current.runId,destination,policy,oldKey)).toBe(oldId)
  const events=(await inspectSpool(spoolRoot(home))).events,old=events.find(e=>e.eventId===oldId)!
  expect(events).toHaveLength(2)
  expect(old.payload).toMatchObject({outcome:'interrupted',startedAt:prior.startedAt,endedAt:prior.finishedAt,executionRef:later.payload.recordKind==='execution'?later.payload.executionRef:null,values:{duration_s:10}})
  expect((await runtime.readRun(root,current.runId)).pendingDelivery.map(p=>p.status)).toEqual(['acknowledged','acknowledged'])
  expect(await fs.readFile(snapshotFile,'utf8')).toBe(priorBytes)
  expect(await fs.readFile(spoolEventFile(spoolRoot(home),later),'utf8')).toBe(laterBytes)
})
