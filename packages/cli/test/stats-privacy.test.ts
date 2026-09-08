import { expect,test } from 'bun:test'
import { planRetention, diskPressure, exportMode } from '../src/stats/privacy.ts'
test('retention clamps calendar month ends and holds unsent and recovery identity',()=>{
 const files=[
 {path:'old-log',kind:'basic-diagnostic',createdAt:'2026-08-23T00:00:00Z',bytes:10,active:false,delivered:true},
 {path:'boundary-log',kind:'basic-diagnostic',createdAt:'2026-08-24T00:00:00Z',bytes:11,active:false,delivered:true},
 {path:'old-event',kind:'delivered-report',createdAt:'2025-09-06T00:00:00Z',bytes:12,active:false,delivered:true},
 {path:'unsent',kind:'spool',createdAt:'2020-01-01T00:00:00Z',bytes:13,active:false,delivered:false},
 {path:'recovery',kind:'delivered-report',createdAt:'2020-01-01T00:00:00Z',bytes:14,active:false,delivered:true,recovery:true},
 {path:'checkpoint',kind:'source-checkpoint',createdAt:'2020-01-01T00:00:00Z',bytes:15,active:false,delivered:true},
 ]
 const r=planRetention({now:'2026-09-06T00:00:00Z',files,policy:{diagnosticDays:14,sharedMonths:12}})
 expect(r.deleteCandidates.map(r=>r.path)).toEqual(['old-log','old-event'])
 expect(r.held).toHaveLength(4);expect(r.bytes).toBe(22)
 const leap=planRetention({now:'2025-02-28T00:00:00Z',files:[{path:'leap',kind:'delivered-report',createdAt:'2024-02-29T00:00:00Z',bytes:1,active:false,delivered:true}],policy:{diagnosticDays:14,sharedMonths:12}})
 expect(leap.deleteCandidates).toHaveLength(1)
})
test('pressure pauses below 1GiB, resumes at 2GiB and queue alone only warns',()=>{
 const GiB=1024**3
 expect(diskPressure(GiB-1,false,0)).toMatchObject({paused:true,reason:'disk-low'})
 expect(diskPressure(GiB,true,0)).toMatchObject({paused:true})
 expect(diskPressure(2*GiB,true,0)).toMatchObject({paused:false})
 expect(diskPressure(10*GiB,false,GiB)).toMatchObject({paused:false,queueWarning:true})
 expect(diskPressure(null,false,0)).toMatchObject({paused:true,reason:'disk-probe-unavailable'})
})
test('repository cannot self-authorize attributed reporting',()=>{
 expect(()=>exportMode({org:{'stats-export':'non-attributed'},repo:{'stats-export':'attributed'},delegations:[]})).toThrow()
})

import { mkdtemp,rm,readFile,stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probePressure,basicDiagnostic,privacyReason } from '../src/stats/privacy.ts'
test('real statfs and persisted pressure hysteresis fail closed across restarts',async()=>{
 const home=await mkdtemp(join(tmpdir(),'pressure-149-'))
 try{
  expect((await probePressure(home,0)).freeBytes).toBeGreaterThan(0)
  expect((await probePressure(home,0,async()=>100)).paused).toBe(true)
  expect((await probePressure(home,0,async()=>1024**3)).paused).toBe(true)
  expect((await probePressure(home,0,async()=>2*1024**3)).paused).toBe(false)
  expect((await probePressure(home,0,async()=>{throw Object.assign(Error('PRIVATE_CANARY'),{code:'EACCES'})})).reason).toBe('disk-probe-unavailable')
  const file=join(home,'.vegastack','stats','events-v2','disk-pressure.json')
  expect((await stat(file)).mode&0o777).toBe(0o600)
  expect(await readFile(file,'utf8')).not.toContain('CANARY')
 }finally{await rm(home,{recursive:true,force:true})}
})
test('basic diagnostics discard arbitrary fields and outward errors never quote filesystem text',()=>{
 expect(basicDiagnostic('2026-09-06T00:00:00Z','exit',{exitCode:1,stdout:'CANARY',args:['CANARY'],path:'/Users/CANARY'})).toEqual({at:'2026-09-06T00:00:00Z',event:'exit',exitCode:1})
 expect(privacyReason(Object.assign(Error('/Users/CANARY'),{code:'ENOSPC'}))).toBe('storage-full')
 expect(privacyReason(Object.assign(Error('/Users/CANARY'),{code:'EACCES'}))).toBe('storage-permission-denied')
 expect(privacyReason(Error('/Users/CANARY'))).toBe('operation-unavailable')
 expect(privacyReason(Error('privacy-arbitrary-sensitive-content'))).toBe('operation-unavailable')
})

test('real permission failure preserves terminal basic logs and dry-run never removes them',async()=>{
 const fs=await import('node:fs/promises'),runtime=await import('../src/runs.ts'),{cleanupBasicLogs}=await import('../src/stats/push.ts')
 const home=await mkdtemp(join(tmpdir(),'retention-permission-')),root=runtime.runsRoot(home)
 let directory=''
 try{
  let run=await runtime.createRun({root,repo:'o/r',issue:1,parent:null,checkout:home,branch:'feat/1-fixture',baseSha:'a'.repeat(40),headSha:null,stage:'implement',harness:'fixture',model:'fixture',effort:'high',execution:null,approvalBindings:[],recordBinding:null,approvalRefs:[],policyDigest:'b'.repeat(64),claimToken:crypto.randomUUID(),startedAt:'2020-01-01T00:00:00Z',taskKey:{repo:'o/r',issue:1,taskId:'1-T1',scopeDigest:'c'.repeat(64)},activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:null,waitReason:null,machine:null,sharedClaim:null,checkpoint:null,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'fixture'}})
  run=await runtime.transitionRun(run.runId,run.generation,{state:'terminal',terminationCause:'failed',finishedAt:'2020-01-01T00:00:00Z'},root)
  directory=join(root,run.runId);const file=join(directory,'events.jsonl'),bytes=JSON.stringify(basicDiagnostic('2020-01-01T00:00:00Z','exit',{exitCode:1}))+'\n'
  await fs.writeFile(file,bytes,{mode:0o600})
  const preview=await cleanupBasicLogs(home,new Date('2026-09-06'),{dryRun:true})
  expect(preview.removed).toBe(0);expect(preview.deleteCandidates).toEqual([file]);expect(await readFile(file,'utf8')).toBe(bytes)
  await fs.chmod(directory,0o500)
  try{const result=await cleanupBasicLogs(home,new Date('2026-09-06'));expect(result.removed).toBe(0)}catch(error){expect((error as NodeJS.ErrnoException).code).toBe('EACCES')}
  expect(await readFile(file,'utf8')).toBe(bytes)
  await fs.chmod(directory,0o700)
  expect((await cleanupBasicLogs(home,new Date('2026-09-06'))).removed).toBe(1)
 }finally{if(directory)await fs.chmod(directory,0o700).catch(()=>{});await rm(home,{recursive:true,force:true})}
})

test.each(['linear','merged-parent'])('checkpoint privacy rejects removed secret history through the actual owner: %s',async(kind)=>{
 const fs=await import('node:fs/promises'),{execFileSync}=await import('node:child_process')
 const {createRun}=await import('../src/runs.ts'),{prepareCheckpoint}=await import('../src/checkpoints.ts')
 const home=await mkdtemp(join(tmpdir(),'privacy-history-')),cwd=join(home,'source'),remote=join(home,'remote.git'),root=join(home,'runs')
 try{
  await fs.mkdir(cwd)
  const git=(...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}}).trim()
  git('init','-b','main');await fs.writeFile(join(cwd,'allowed.txt'),'base');git('add','.');git('commit','-m','base')
  const base=git('rev-parse','HEAD');git('init','--bare',remote);git('remote','add','origin',remote);git('push','origin','HEAD:main');git('checkout','-b','feat/1-work')
  if(kind==='merged-parent')git('checkout','-b','secret-side')
  await fs.writeFile(join(cwd,'allowed.txt'),'credential-canary-DO-NOT-EXPORT');git('add','.');git('commit','-m','intermediate fixture')
  const forbiddenCommit=git('rev-parse','HEAD'),forbiddenBlob=git('rev-parse','HEAD:allowed.txt')
  await fs.writeFile(join(cwd,'allowed.txt'),'base');git('add','.');git('commit','-m','clean final tree')
  if(kind==='merged-parent'){git('checkout','feat/1-work');git('commit','--allow-empty','-m','parent progress');git('merge','--no-ff','secret-side','-m','merge cleaned side')}
  const head=git('rev-parse','HEAD')
  expect(await fs.readFile(join(cwd,'allowed.txt'),'utf8')).toBe('base');expect(git('status','--porcelain')).toBe('')
  const approvalBindings=[{approvalId:'fixture',source:{kind:'github-comment' as const,repositoryId:'R_repo',issueNodeId:'I_parent',commentId:'12',bodySha256:'a'.repeat(64)}}]
  const run=await createRun({root,repo:'o/r',issue:1,parent:null,checkout:cwd,branch:'feat/1-work',baseSha:base,headSha:head,stage:'implement',harness:'fixture',model:'fixture',effort:'high',execution:null,approvalBindings,recordBinding:null,approvalRefs:[],policyDigest:'b'.repeat(64),claimToken:crypto.randomUUID(),startedAt:new Date().toISOString(),taskKey:{repo:'o/r',issue:1,taskId:'1-T1',scopeDigest:'c'.repeat(64)},activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:null,waitReason:null,machine:null,sharedClaim:null,checkpoint:null,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'fixture'}})
  const approvedIntent={id:'fixture-backup',repo:'o/r',repositoryId:'R_repo',remote:'origin',remoteUrl:remote,branch:run.branch,baseRef:'refs/heads/main',baseSha:base,scopeDigest:run.taskKey.scopeDigest,paths:['allowed.txt'],approvalBindings}
  await expect(prepareCheckpoint({run,approvedIntent,headSha:head},{root,verifyAuthority:async()=>{}})).rejects.toThrow()
  expect(git('ls-remote','origin','refs/heads/feat/1-work')).toBe('')
  for(const object of [forbiddenCommit,forbiddenBlob])expect(()=>git('--git-dir',remote,'cat-file','-e',object)).toThrow()
 }finally{await rm(home,{recursive:true,force:true})}
},15000)
