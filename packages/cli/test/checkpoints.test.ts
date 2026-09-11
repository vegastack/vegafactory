import {test,expect} from 'bun:test'
import {mkdtemp,rm,writeFile,unlink,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createRun,readRun,parseRun} from '../src/runs.ts'
import {prepareCheckpoint,publishCheckpoint,flushRunCheckpoint,type CheckpointIntent} from '../src/checkpoints.ts'
async function fixture(change:(cwd:string,git:(...args:string[])=>string)=>Promise<void>){const home=await mkdtemp(join(tmpdir(),'checkpoint-')),cwd=join(home,'writer'),remote=join(home,'remote.git'),root=join(home,'runs');await mkdir(cwd);const g=(...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();g('init','-b','main');g('config','user.email','fixture@example.test');g('config','user.name','Fixture');await writeFile(join(cwd,'allowed.txt'),'base');g('add','.');g('commit','-m','base');const base=g('rev-parse','HEAD');g('init','--bare',remote);g('--git-dir',remote,'symbolic-ref','HEAD','refs/heads/main');g('remote','add','origin',remote);g('push','origin','HEAD:main');g('checkout','-b','feat/1-work');await change(cwd,g);const head=g('rev-parse','HEAD');const authorities=[{approvalId:'approved',source:{kind:'github-comment' as const,repositoryId:'R_repo',issueNodeId:'I_parent',commentId:'12',bodySha256:'a'.repeat(64)}}];const run=await createRun({root,repo:'o/r',issue:1,parent:null,checkout:cwd,branch:'feat/1-work',baseSha:base,headSha:head,stage:'implement',harness:'fixture',model:'fixture',effort:'high',execution:null,approvalBindings:authorities,recordBinding:null,approvalRefs:[],policyDigest:'b'.repeat(64),claimToken:crypto.randomUUID(),startedAt:new Date().toISOString(),taskKey:{repo:'o/r',issue:1,taskId:'1-T1',scopeDigest:'c'.repeat(64)},activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:null,waitReason:null,machine:null,sharedClaim:null,checkpoint:null,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'fixture'}});const intent:CheckpointIntent={id:'approved-task-backup',repo:'o/r',repositoryId:'R_repo',remote:'origin',remoteUrl:remote,branch:run.branch,baseRef:'refs/heads/main',baseSha:base,scopeDigest:run.taskKey.scopeDigest,paths:['allowed.txt'],approvalBindings:authorities};return{home,cwd,root,run,intent,base,head,g,remote}}
test('child execution and checkpoint requests retain separate exact authority',async()=>{const f=await fixture(async()=>{});try{const parentRequest={kind:'consolidated' as const,parentRepo:'o/r',parentIssue:10,approvalBinding:{commentId:12,bodySha256:'a'.repeat(64)},requested:{repo:'o/r',issue:1,taskIds:['1-T1'],actionId:'local-child',branch:'feat/10-parent',baseSha:f.run.baseSha,paths:['allowed.txt'],operation:'edit' as const}},checkpointRequest={parentRepo:'o/r',parentIssue:10,approvalBinding:{commentId:12,bodySha256:'a'.repeat(64)},requested:{repo:'o/r',issue:1,taskIds:['1-T1'],actionId:'checkpoint-child-1',branch:f.run.branch,ref:`refs/heads/${f.run.branch}`,baseSha:f.run.baseSha,paths:['allowed.txt'],operation:'checkpoint' as const}},intent={...f.intent,id:checkpointRequest.requested.actionId,baseRef:checkpointRequest.requested.ref,approvalRequest:checkpointRequest};const parsed=parseRun({...f.run,parent:10,approvedTaskIds:['1-T1'],authorityRequest:parentRequest,checkpointIntent:intent});expect(parsed.authorityRequest).toEqual(parentRequest);expect(parsed.checkpointIntent).toEqual(intent);expect(()=>parseRun({...f.run,parent:10,authorityRequest:{...parentRequest,requested:{...parentRequest.requested,operation:'checkpoint'}}})).toThrow('execution action kind differs')}finally{await rm(f.home,{recursive:true,force:true})}})
test('child checkpoint proof binds its source base and ref, not the parent execution tuple',async()=>{const f=await fixture(async(cwd,g)=>{await writeFile(join(cwd,'allowed.txt'),'child change');g('add','.');g('commit','-m','child progress')});try{const parentRequest={kind:'consolidated' as const,parentRepo:'o/r',parentIssue:10,approvalBinding:{commentId:12,bodySha256:'a'.repeat(64)},requested:{repo:'o/r',issue:1,taskIds:['1-T1'],actionId:'local-child',branch:'feat/10-parent',baseSha:'d'.repeat(40),paths:['allowed.txt'],operation:'edit' as const}},checkpointRequest={parentRepo:'o/r',parentIssue:10,approvalBinding:{commentId:12,bodySha256:'a'.repeat(64)},requested:{repo:'o/r',issue:1,taskIds:['1-T1'],actionId:'checkpoint-child-1',branch:f.run.branch,ref:`refs/heads/${f.run.branch}`,baseSha:f.intent.baseSha,paths:['allowed.txt'],operation:'checkpoint' as const}},intent={...f.intent,id:checkpointRequest.requested.actionId,baseRef:checkpointRequest.requested.ref,approvalRequest:checkpointRequest},run=parseRun({...f.run,parent:10,baseSha:parentRequest.requested.baseSha,approvedTaskIds:['1-T1'],authorityRequest:parentRequest,checkpointIntent:intent});let validations=0;const candidate=await prepareCheckpoint({run,approvedIntent:intent,headSha:f.head},{root:f.root,verifyAuthority:async()=>{validations++}});expect(validations).toBe(1);expect(candidate.exportProof.remoteRef).toBe(checkpointRequest.requested.ref);expect(candidate.exportProof.approvedBaseSha).toBe(f.intent.baseSha);expect(parseRun({...run,pendingDelivery:[{id:crypto.randomUUID(),kind:'feature-push',target:{repo:run.repo,remote:intent.remote,branch:intent.branch,sha:f.head},intentRef:intent.id,exportProof:candidate.exportProof,approvalBindings:run.approvalBindings,status:'pending',attempts:0,lastError:null}]}).pendingDelivery).toHaveLength(1);expect(()=>parseRun({...run,checkpointIntent:{...intent,approvalRequest:{...checkpointRequest,requested:{...checkpointRequest.requested,paths:['other.txt']}}}})).toThrow('child checkpoint authority differs');const legacy=parseRun({...f.run,parent:10,approvedTaskIds:['1-T1'],authorityRequest:parentRequest});await expect(flushRunCheckpoint(legacy,{} as never)).rejects.toThrow('checkpoint child intent unavailable');expect(f.g('ls-remote','origin',checkpointRequest.requested.ref)).toBe('')}finally{await rm(f.home,{recursive:true,force:true})}},15000)
test('allowed committed history reaches only approved exact task ref and readback persists',async()=>{const f=await fixture(async(cwd,g)=>{await writeFile(join(cwd,'allowed.txt'),'changed');g('add','.');g('commit','-m','safe progress')});try{let validations=0;const controller={root:f.root,verifyAuthority:async()=>{validations++}};const candidate=await prepareCheckpoint({run:f.run,approvedIntent:f.intent,headSha:f.head},controller);const result=await publishCheckpoint(candidate,controller);expect(result.kind).toBe('acknowledged');expect(validations).toBe(3);expect(f.g('ls-remote','origin','refs/heads/feat/1-work').split(/\s/)[0]).toBe(f.head);const stored=await readRun(f.root,f.run.runId);expect(stored.pendingDelivery[0]?.exportProof?.closureDigest).toBe(candidate.exportProof.closureDigest);expect(stored.checkpoint?.headSha).toBe(f.head)}finally{await rm(f.home,{recursive:true,force:true})}},15000)
test('fresh authority or source drift immediately before send refuses without changing the remote ref',async()=>{const f=await fixture(async(cwd,g)=>{await writeFile(join(cwd,'allowed.txt'),'changed');g('add','.');g('commit','-m','safe progress')});try{let validations=0;const controller={root:f.root,verifyAuthority:async()=>{if(++validations===3)throw Error('checkpoint-action-revoked')}};const candidate=await prepareCheckpoint({run:f.run,approvedIntent:f.intent,headSha:f.head},controller),result=await publishCheckpoint(candidate,controller);expect(result).toMatchObject({kind:'refused',reason:'checkpoint-action-revoked'});expect(f.g('ls-remote','origin','refs/heads/feat/1-work')).toBe('')}finally{await rm(f.home,{recursive:true,force:true})}},15000)
for(const kind of ['secret','outside'] as const)test(`removed ${kind} history refuses before exporting any object`,async()=>{let forbidden='';const f=await fixture(async(cwd,g)=>{const path=kind==='secret'?'allowed.txt':'forbidden.txt';await writeFile(join(cwd,path),kind==='secret'?'credential-canary-DO-NOT-EXPORT':'outside');g('add','.');g('commit','-m','intermediate');forbidden=g('rev-parse','HEAD');if(kind==='secret')await writeFile(join(cwd,path),'clean');else await unlink(join(cwd,path));g('add','-A');g('commit','-m','clean final')});try{await expect(prepareCheckpoint({run:f.run,approvedIntent:f.intent,headSha:f.head},{root:f.root,verifyAuthority:async()=>{}})).rejects.toThrow();expect(f.g('ls-remote','origin','refs/heads/feat/1-work')).toBe('');expect(()=>f.g('--git-dir',f.remote,'cat-file','-e',forbidden)).toThrow()}finally{await rm(f.home,{recursive:true,force:true})}},15000)

test('repository Git helpers are refused before any checkout-selected program executes',async()=>{
  const f=await fixture(async(cwd,g)=>{await writeFile(join(cwd,'allowed.txt'),'changed');g('add','.');g('commit','-m','safe progress')})
  const marker=join(f.home,'git-helper-ran'),helper=join(f.home,'fsmonitor.mjs')
  try{
    await writeFile(helper,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write('2\\n')`)
    f.g('config','core.fsmonitor',`${process.execPath} ${helper}`)
    await expect(prepareCheckpoint({run:f.run,approvedIntent:f.intent,headSha:f.head},{root:f.root,verifyAuthority:async()=>{}})).rejects.toThrow('checkpoint-executable-git-config-refused')
    expect(await Bun.file(marker).exists()).toBe(false)
  }finally{await rm(f.home,{recursive:true,force:true})}
},15000)

for(const token of ['npm_abcdefghijklmnopqrstuvwxyz012345','sk-abcdefghijklmnopqrstuvwxyz012345'])test(`removed raw ${token.slice(0,3)} credential history never reaches the remote`,async()=>{
  let forbidden=''
  const f=await fixture(async(cwd,g)=>{await writeFile(join(cwd,'allowed.txt'),token);g('add','.');g('commit','-m','intermediate credential');forbidden=g('rev-parse','HEAD');await writeFile(join(cwd,'allowed.txt'),'clean');g('add','.');g('commit','-m','clean final')})
  try{
    await expect(prepareCheckpoint({run:f.run,approvedIntent:f.intent,headSha:f.head},{root:f.root,verifyAuthority:async()=>{}})).rejects.toThrow('checkpoint-sensitive-history')
    expect(f.g('ls-remote','origin','refs/heads/feat/1-work')).toBe('')
    expect(()=>f.g('--git-dir',f.remote,'cat-file','-e',forbidden)).toThrow()
  }finally{await rm(f.home,{recursive:true,force:true})}
},15000)

test('forbidden history on a merged parent is inspected before export',async()=>{
  let forbidden=''
  const f=await fixture(async(cwd,g)=>{
    g('checkout','-b','side');await writeFile(join(cwd,'allowed.txt'),'npm_abcdefghijklmnopqrstuvwxyz012345');g('add','.');g('commit','-m','side credential');forbidden=g('rev-parse','HEAD')
    await writeFile(join(cwd,'allowed.txt'),'base');g('add','.');g('commit','-m','restore side tree')
    g('checkout','feat/1-work');await writeFile(join(cwd,'allowed.txt'),'main change');g('add','.');g('commit','-m','main progress');g('merge','--no-ff','side','-m','merge side')
  })
  try{
    await expect(prepareCheckpoint({run:f.run,approvedIntent:f.intent,headSha:f.head},{root:f.root,verifyAuthority:async()=>{}})).rejects.toThrow('checkpoint-sensitive-history')
    expect(f.g('ls-remote','origin','refs/heads/feat/1-work')).toBe('')
    expect(()=>f.g('--git-dir',f.remote,'cat-file','-e',forbidden)).toThrow()
  }finally{await rm(f.home,{recursive:true,force:true})}
},15000)

test('a no-change checkpoint acknowledges without creating the task ref',async()=>{
  const f=await fixture(async()=>{})
  try{
    const candidate=await prepareCheckpoint({run:f.run,approvedIntent:f.intent,headSha:f.head},{root:f.root,verifyAuthority:async()=>{}})
    const result=await publishCheckpoint(candidate,{root:f.root,verifyAuthority:async()=>{}})
    expect(candidate.noChange).toBe(true);expect(result).toEqual({kind:'acknowledged',checkpoint:null,reason:'no-change'})
    expect(f.g('ls-remote','origin','refs/heads/feat/1-work')).toBe('')
  }finally{await rm(f.home,{recursive:true,force:true})}
},15000)

test('a divergent task ref refuses before push and preserves its remote tip',async()=>{
  const f=await fixture(async(cwd,g)=>{await writeFile(join(cwd,'allowed.txt'),'changed');g('add','.');g('commit','-m','local progress')})
  try{
    const competing=f.g('commit-tree',`${f.base}^{tree}`,'-m','unrelated remote tip')
    f.g('push',f.remote,`${competing}:refs/heads/feat/1-work`)
    await expect(prepareCheckpoint({run:f.run,approvedIntent:f.intent,headSha:f.head},{root:f.root,verifyAuthority:async()=>{}})).rejects.toThrow('checkpoint-git-refused')
    expect(f.g('ls-remote','origin','refs/heads/feat/1-work').split(/\s/)[0]).toBe(competing)
  }finally{await rm(f.home,{recursive:true,force:true})}
},15000)

test('source success with a lost private-pointer response resumes without a second push',async()=>{
  const f=await fixture(async(cwd,g)=>{await writeFile(join(cwd,'allowed.txt'),'changed');g('add','.');g('commit','-m','safe progress')})
  let pointerAttempts=0
  const controller={root:f.root,verifyAuthority:async()=>{},acknowledgeEffect:async()=>{if(++pointerAttempts===1)throw Error('lost private pointer response')}}
  try{
    const candidate=await prepareCheckpoint({run:f.run,approvedIntent:f.intent,headSha:f.head},controller)
    const first=await publishCheckpoint(candidate,controller),afterFirst=await readRun(f.root,f.run.runId)
    expect(first).toMatchObject({kind:'pending',reason:'checkpoint-pointer-pending'})
    expect(f.g('ls-remote','origin','refs/heads/feat/1-work').split(/\s/)[0]).toBe(f.head)
    expect(afterFirst.checkpoint?.headSha).toBe(f.head);expect(afterFirst.pendingDelivery[0]?.attempts).toBe(1)
    const second=await publishCheckpoint(candidate,controller),afterSecond=await readRun(f.root,f.run.runId)
    expect(second.kind).toBe('acknowledged');expect(pointerAttempts).toBe(2);expect(afterSecond.pendingDelivery[0]?.attempts).toBe(1)
  }finally{await rm(f.home,{recursive:true,force:true})}
},15000)

test('a candidate is revalidated and refused after the checkout head changes',async()=>{
  const f=await fixture(async(cwd,g)=>{await writeFile(join(cwd,'allowed.txt'),'first');g('add','.');g('commit','-m','first progress')})
  try{
    const controller={root:f.root,verifyAuthority:async()=>{}},candidate=await prepareCheckpoint({run:f.run,approvedIntent:f.intent,headSha:f.head},controller)
    await writeFile(join(f.cwd,'allowed.txt'),'second');f.g('add','.');f.g('commit','-m','later progress')
    const result=await publishCheckpoint(candidate,controller)
    expect(result).toMatchObject({kind:'refused',reason:'checkpoint-source-changed'})
    expect(f.g('ls-remote','origin','refs/heads/feat/1-work')).toBe('')
  }finally{await rm(f.home,{recursive:true,force:true})}
},15000)
