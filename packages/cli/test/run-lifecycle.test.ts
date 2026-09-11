import {test,expect} from 'bun:test'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {executeRun} from '../src/dispatch.ts'
import {parseFactoryConfig} from '../src/config.ts'
import {createRun,readRun,readRuns,runsRoot,transitionRun} from '../src/runs.ts'
async function fixture(code:string,timeoutMs?:number|null){const home=await mkdtemp(join(tmpdir(),'owned-run-'));try{const result=await executeRun({repo:'o/r',issue:1,title:'fixture',stage:'implement',commentId:null,reactionId:null},{command:process.execPath,args:['-e',code],cwd:home,env:{},prompt:''},parseFactoryConfig({repos:[{repo:'o/r',org:'o',path:home}]},home),{operator:null},{timeoutMs,wrapperPath:resolve('packages/cli/src/run-wrapper.ts')});return{result,runs:await readRuns(runsRoot(home))}}finally{await rm(home,{recursive:true,force:true})}}
test('actual wrapper records successful execution without implicit delivery',async()=>{const {result,runs}=await fixture('process.exit(0)');expect(result.terminationCause).toBe('succeeded');expect(result.pushed).toBe(false);expect(runs[0]?.state).toBe('terminal');expect(runs[0]?.processIdentity?.pid).toBeGreaterThan(0)},10000)
test('timeout remains failure when vendor TERM handler exits zero',async()=>{const {result}=await fixture("process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},100)",200);expect(result.timedOut).toBe(true);expect(result.terminationCause).toBe('timed-out');expect(result.exitCode).toBe(0)},15000)
test('owned process ignoring TERM is killed within cancellation bound',async()=>{const start=performance.now();const {result}=await fixture("process.on('SIGTERM',()=>{});setInterval(()=>{},100)",200);expect(result.terminationCause).toBe('timed-out');expect(performance.now()-start).toBeLessThan(9000)},12000)
test('cancellation removes the owned nondetached descendant too',async()=>{const {result}=await fixture("const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},100)\"],{stdio:'ignore'});console.log(c.pid);process.on('SIGTERM',()=>{});setInterval(()=>{},100)",200);expect(result.terminationCause).toBe('timed-out');const pid=Number(result.stdout?.trim());expect(pid).toBeGreaterThan(0);expect(()=>process.kill(pid,0)).toThrow()},12000)

test('wrapper leader loss still terminates its authenticated nondetached process tree',async()=>{
  const probe=await mkdtemp(join(tmpdir(),'leader-loss-probe-')),pidFile=join(probe,'pids.json')
  const code=`const {spawn}=require('node:child_process'),{writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},100)"],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({vendor:process.pid,child:c.pid}));process.kill(process.ppid,'SIGKILL');process.exit(0)`
  const {result,runs}=await fixture(code),pids=JSON.parse(await readFile(pidFile,'utf8')) as {vendor?:number;child?:number}
  try{
    expect(pids.vendor).toBeGreaterThan(0);expect(pids.child).toBeGreaterThan(0)
    expect(()=>process.kill(pids.vendor!,0)).toThrow()
    const {spawnSync}=await import('node:child_process'),state=spawnSync('/bin/ps',['-p',String(pids.child),'-o','stat='],{encoding:'utf8'}).stdout.trim()
    expect(state===''||state.startsWith('Z'),JSON.stringify({state,result,group:runs[0]?.processGroupId})).toBe(true)
    expect((await import('../src/run-wrapper.ts').then(owner=>owner.inspectOwnedGroup(runs[0]!.processIdentity!))).kind).toBe('absent')
    expect(result.terminationCause).toBe('interrupted')
  }finally{
    if(runs[0]?.processGroupId)try{process.kill(-runs[0].processGroupId,'SIGKILL')}catch{}
    await rm(probe,{recursive:true,force:true})
  }
},12000)

test('an already-aborted launch is durably cancelled rather than classified as spawn failure',async()=>{
  const home=await mkdtemp(join(tmpdir(),'cancel-before-launch-')),controller=new AbortController();controller.abort()
  try{
    const result=await executeRun({repo:'o/r',issue:1,title:'fixture',stage:'implement',commentId:null,reactionId:null},{command:process.execPath,args:['-e','process.exit(0)'],cwd:home,env:{},prompt:''},parseFactoryConfig({repos:[{repo:'o/r',org:'o',path:home}]},home),{operator:null,signal:controller.signal},{wrapperPath:resolve('packages/cli/src/run-wrapper.ts')})
    const [saved]=await readRuns(runsRoot(home));expect(result.terminationCause).toBe('cancelled');expect(saved?.terminationCause).toBe('cancelled');expect(saved?.cancelRequestedAt).toBeString();expect(saved?.terminationRequest?.cause).toBe('cancelled')
  }finally{await rm(home,{recursive:true,force:true})}
})

test('cancelling subscription wait replaces failed state with a durable cancelled terminal',async()=>{
  const {execFileSync}=await import('node:child_process'),crypto=await import('node:crypto'),dispatch=await import('../src/dispatch.ts')
  const home=await mkdtemp(join(tmpdir(),'cancel-quota-wait-')),root=runsRoot(home);execFileSync('git',['init','-q','-b','feat/1-work'],{cwd:home})
  try{
    const source={kind:'github-comment' as const,repositoryId:'R_repo',issueNodeId:'I_issue',commentId:'12',bodySha256:'a'.repeat(64)};execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-qm','base'],{cwd:home})
    const head=execFileSync('git',['rev-parse','HEAD'],{cwd:home,encoding:'utf8'}).trim(),run=await createRun({root,repo:'o/r',issue:1,parent:null,checkout:home,branch:'feat/1-work',baseSha:head,headSha:head,stage:'implement',harness:'codex',model:'fixture',effort:'high',execution:{providerMode:'subscription',harness:'codex',harnessVersion:'fixture',model:'fixture',effort:'high',accountRef:'fixture',qualification:source},approvalBindings:[{approvalId:'approved',source}],recordBinding:null,approvalRefs:[],policyDigest:'b'.repeat(64),claimToken:crypto.randomUUID(),startedAt:new Date().toISOString(),taskKey:{repo:'o/r',issue:1,taskId:'1-T1',scopeDigest:'c'.repeat(64)},approvedTaskIds:['1-T1'],activeElapsedMs:0,taskOwner:null,agentAccountOwner:null,accountRef:'fixture',waitReason:null,machine:null,sharedClaim:null,checkpoint:null,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'fixture'}})
    const waiting=await transitionRun(run.runId,run.generation,{state:'terminal',terminationCause:'failed',finishedAt:new Date().toISOString(),waitReason:'subscription-quota',quotaWait:{checks:0,nextCheckAt:new Date(Date.now()+60_000).toISOString()}},root)
    const controller=new AbortController();controller.abort()
    const outcome=await dispatch.executeApprovedRun({repo:'o/r',issue:1,title:'fixture',stage:'implement',commentId:null,reactionId:null},{command:'codex',args:[],cwd:home,env:{},prompt:''},parseFactoryConfig({repos:[{repo:'o/r',org:'o',path:home}]},home),{operator:null,signal:controller.signal},{preparedRun:waiting,runInput:{...waiting,root}})
    const saved=await readRun(root,run.runId);expect(outcome.terminationCause).toBe('cancelled');expect(saved.terminationCause).toBe('cancelled');expect(saved.waitReason).toBeNull();expect(saved.cancelRequestedAt).toBeString();expect(dispatch.durableRecoverySummary(saved)?.reason).toContain('cancelled')
  }finally{await rm(home,{recursive:true,force:true})}
})

test('default qualified admission runs, waits for quota, resumes the same session and preserves terminal delivery',async()=>{
  const {spyOn}=await import('bun:test'),fs=await import('node:fs/promises'),{execFileSync,spawn}=await import('node:child_process'),crypto=await import('node:crypto')
  const runtime=await import('../src/runs.ts'),dispatch=await import('../src/dispatch.ts'),launch=await import('../src/launch.ts'),wire=await import('../src/shared-claims.ts'),policyOwner=await import('../../../skills/dev/dev-setup/scripts/effective-policy.mjs'),approvalOwner=await import('../../../skills/dev/dev-implement/scripts/lib/approval.mjs')
  const home=await fs.realpath(await mkdtemp(join(tmpdir(),'runtime-138-'))),repo=join(home,'app'),tree=join(repo,'.vegastack','.worktrees','1-fixture'),sourceRemote=join(home,'source.git'),room=join(home,'room'),installed=join(home,'installed'),bin=join(home,'bin'),phasePath=join(home,'vendor-phase.json')
  const sourceRoot=resolve('skills'),actualGit=Bun.which('git')!,oldEnv={PATH:process.env.PATH,HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,VSK_GH:process.env.VSK_GH,VSK_PREFLIGHT_SCRIPT:process.env.VSK_PREFLIGHT_SCRIPT,VSK_SHIP_POLICY_SCRIPT:process.env.VSK_SHIP_POLICY_SCRIPT}
  let server:ReturnType<typeof Bun.serve>|undefined,inventorySpy:ReturnType<typeof spyOn>|undefined
  const g=(cwd:string,...args:string[])=>execFileSync(actualGit,args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}}).trim()
  try{
    await fs.mkdir(join(repo,'.vegastack','hooks'),{recursive:true});await fs.mkdir(join(repo,'.codex'),{recursive:true});await fs.mkdir(join(room,'groups','dev'),{recursive:true});await fs.mkdir(join(installed,'dist'),{recursive:true});await fs.mkdir(bin);await fs.mkdir(join(home,'.codex'),{recursive:true});await fs.mkdir(join(home,'.vegastack'),{recursive:true,mode:0o700})
    const host=(await(await import('../src/machine-identity.ts')).readHostBinding()).digest,installation=crypto.randomUUID(),coordinationInstallation=crypto.randomUUID(),coordRoot='1'.repeat(40),qHead='2'.repeat(40),qualificationId=crypto.randomUUID(),qualificationRun=crypto.randomUUID()
    const devMd='repo: acme/app\ncontrol-room: acme/room#dev\nsync-max-age: 2h\ndispatch: local\noperators: robot\nplan: codex fixture-model high\nimplement: codex fixture-model high\n'
    await fs.writeFile(join(repo,'.vegastack','dev.md'),devMd)
    await fs.writeFile(join(repo,'.vegastack','hooks','ship-guard.mjs'),await fs.readFile(join(sourceRoot,'dev/dev-setup/assets/hooks/ship-guard.mjs')))
    await fs.writeFile(join(repo,'.codex','hooks.json'),JSON.stringify({hooks:{PreToolUse:[{hooks:[{type:'command',command:'node .vegastack/hooks/ship-guard.mjs --harness codex'}]}]}}))
    await fs.writeFile(join(repo,'.codex','config.toml'),'# features are enabled by the exact CLI overrides\n')
    await fs.writeFile(join(repo,'allowed.txt'),'base\n');g(repo,'init','-b','main');g(repo,'remote','add','origin','https://github.com/acme/app.git');g(repo,'add','.');g(repo,'commit','-m','base');execFileSync(actualGit,['init','--bare',sourceRemote]);execFileSync(actualGit,['--git-dir',sourceRemote,'symbolic-ref','HEAD','refs/heads/main']);execFileSync(actualGit,['push',sourceRemote,'HEAD:main'],{cwd:repo});g(repo,'worktree','add','-b','feat/1-fixture',tree)
    const sourceSha=g(repo,'rev-parse','HEAD'),treeSha=g(repo,'rev-parse','HEAD^{tree}')
    const fleet={schemaVersion:1,coordination:{repositoryId:'R_room',repository:'acme/room',branch:'factory-state',rootCommit:coordRoot,installationId:coordinationInstallation},defaults:{pollSeconds:120,maxRuns:1,childConcurrent:3,checkpoints:'task-branch',recovery:'verified-transfer'},groupDefaults:{},machines:{box:{installationId:installation,hostBindingDigest:host,executionLogin:'robot',group:'dev',repositories:['acme/app'],enabled:true,overrides:{}}}}
    await fs.writeFile(join(room,'org.md'),'sync-max-age: 2h\npolicy-schema: 2\n```vsk-policy\n'+JSON.stringify({schemaVersion:2,fleet})+'\n```\n')
    await fs.writeFile(join(room,'groups/dev/group.md'),'review: subagent\n');await fs.writeFile(join(room,'people.csv'),'login,name,role,slack,timezone,groups\nrobot,Robot,lead,,UTC,dev\n');await fs.writeFile(join(room,'repos.md'),'| repo | group | board | owner | repository-id |\n|---|---|---|---|---|\n| acme/app | dev | | robot | R_app |\n')
    g(room,'init','-b','main');g(room,'remote','add','origin','https://github.com/acme/room.git');g(room,'add','.');g(room,'commit','-m','policy')
    const snapshot={schemaVersion:2,org:'acme',group:'dev',repository:'acme/room',origin:'https://github.com/acme/room.git',sourceCommit:g(room,'rev-parse','HEAD'),policyDigest:'0'.repeat(64),validatedAt:new Date().toISOString(),contentPath:room}
    snapshot.policyDigest=policyOwner.loadSnapshotPolicy({snapshot,repo:'acme/app',devMd,expectedOrigin:snapshot.origin,now:Date.now()}).policy.policyDigest
    expect(policyOwner.loadSnapshotPolicy({snapshot,repo:'acme/app',devMd,expectedOrigin:snapshot.origin,now:Date.now()}).ok).toBe(true)
    const raw={schemaVersion:2,revision:0,repos:[{repo:'acme/app',org:'acme',path:repo}],machine:{id:'box',installationId:installation,hostBindingDigest:host,group:'dev',controlRoom:{repositoryId:'R_room',repo:'acme/room',remote:snapshot.origin,branch:'main'}},controlRooms:{acme:{repo:'acme/room',remote:snapshot.origin,path:join(home,'operator-room'),branch:'main',sha:snapshot.sourceCommit,lastSyncedAt:snapshot.validatedAt,repositoryId:'R_room',snapshots:{'acme/app':snapshot}}}}
    await fs.writeFile(join(home,'.vegastack','factory.json'),JSON.stringify(raw))
    const config=parseFactoryConfig(raw,home)
    const issueBody='<!-- vsk:v1 type=brief rev=1 scope=quick-build -->\n## Outcome\nFinish the controlled fixture.\n'
    const planBody='<!-- vsk:v1 type=plan rev=1 -->\n- [ ] **Task 1: fixture** <!-- task-id:1-T1 -->\n  - Files — `allowed.txt`\n  - Interfaces — existing CLI\n  - Steps: finish fixture\n'
    const artifacts:import('../src/shared-claims.ts').ArtifactRef[]=[{repo:'acme/app',issue:1,kind:'brief',artifactId:'I_1',rev:1,digest:approvalOwner.scopeDigest(issueBody,'brief')},{repo:'acme/app',issue:1,kind:'plan',artifactId:'PLAN_1',rev:1,digest:approvalOwner.scopeDigest(planBody,'plan')}]
    const event={schemaVersion:2,id:'approved-fixture',operator:'robot',scope:'brief+plan',source:{kind:'session',ref:'session:fixture',quote:'I approve this exact fixture.'},artifacts,supersedes:[],revokes:[]}
    const baseComment={issue_url:'https://api.github.com/repos/acme/app/issues/1',user:{login:'robot'},updated_at:'2026-09-08T12:14:45Z'}
    const comments=[{...baseComment,id:11,node_id:'PLAN_1',body:planBody,html_url:'https://github.com/acme/app/issues/1#issuecomment-11'},{...baseComment,id:12,node_id:'APPROVAL_1',body:'<!-- vsk:v1 type=approval scope=brief+plan -->\n```json\n'+JSON.stringify(event)+'\n```\n',html_url:'https://github.com/acme/app/issues/1#issuecomment-12'}]
    const issue={id:1,node_id:'I_1',number:1,title:'feat: fixture',body:issueBody,state:'open',labels:[{name:'ready'},{name:'quick-build'}],assignees:[],updated_at:new Date().toISOString()}
    const extraIssues=new Map<number,Record<string,unknown>>(),extraComments=new Map<number,Array<Record<string,unknown>>>()
    const versions=new Map<string,Record<string,string>>([[coordRoot,{'coordination/index.json':wire.canonical({schemaVersion:1,installationId:coordinationInstallation,revision:0,active:[],machines:[]})}]])
    let head=qHead,sequence=2,publicWrites=0
    versions.set(qHead,{...versions.get(coordRoot)!})
    const reply=(args:string[],input:string)=>{
      if(args[0]==='issue'&&args.includes('view'))return{body:issue.body}
      const endpoint=args.find(arg=>arg==='user'||arg==='graphql'||arg.startsWith('repos/'))??''
      if(endpoint==='graphql'){
        const request=JSON.parse(input),variables=request.variables??{},query=request.query as string
        if(query.includes('createCommitOnBranch')){
          if(variables.input.expectedHeadOid!==head)return{errors:[{type:'STALE_DATA'}]}
          const next={...versions.get(head)!};for(const addition of variables.input.fileChanges.additions)next[addition.path]=Buffer.from(addition.contents,'base64').toString('utf8')
          head=crypto.createHash('sha1').update(String(++sequence)).digest('hex');versions.set(head,next);return{data:{createCommitOnBranch:{commit:{oid:head}}}}
        }
        if(query.includes('object(expression:')){const index=variables.expression.indexOf(':'),commit=variables.expression.slice(0,index),path=variables.expression.slice(index+1),text=versions.get(commit)?.[path];return{data:{repository:{object:text===undefined?null:{byteSize:Buffer.byteLength(text),isBinary:false,text}}}}}
        return{data:{repository:{id:'R_room',isPrivate:true,defaultBranchRef:{name:'main'},ref:{id:'REF_state',target:{oid:head}}}}}
      }
      const path=endpoint.split('?')[0]!
      if(path==='user')return{login:'robot'}
      if(path==='repos/acme/room'||path==='repos/acme/app')return{node_id:path.endsWith('room')?'R_room':'R_app',full_name:path.slice(6),permissions:{pull:true},default_branch:'main',private:true}
      if(path.startsWith('repos/acme/room/compare/')){const [base,next]=path.split('/compare/')[1]!.split('...');const keys=[...versions.keys()];return{status:base===next?'identical':keys.indexOf(base!)>=0&&keys.indexOf(base!)<keys.indexOf(next!)?'ahead':'diverged'}}
      if(path==='repos/acme/app/issues')return[issue]
      if(path==='repos/acme/app/issues/1')return issue
      const extraIssue=/^repos\/acme\/app\/issues\/(\d+)$/.exec(path);if(extraIssue&&extraIssues.has(Number(extraIssue[1])))return extraIssues.get(Number(extraIssue[1]))
      const extraHistory=/^repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(path);if(extraHistory&&extraComments.has(Number(extraHistory[1])))return extraComments.get(Number(extraHistory[1]))
      if(path.endsWith('/dependencies/blocked_by'))return[]
      if(path==='repos/acme/app/issues/1/comments'){
        if(args.includes('POST')){publicWrites++;const row={...baseComment,id:100+publicWrites,node_id:'PUBLIC_'+publicWrites,body:JSON.parse(input).body,html_url:'https://github.com/acme/app/issues/1#issuecomment-'+(100+publicWrites)};comments.push(row);return row}
        return comments
      }
      const comment=/^repos\/acme\/app\/issues\/comments\/(\d+)$/.exec(path);if(comment)return[...comments,...[...extraComments.values()].flat()].find(c=>c.id===Number(comment[1]))
      throw Error('unexpected controlled GitHub endpoint '+endpoint)
    }
    server=Bun.serve({port:0,fetch:async request=>{const body=await request.json() as {args:string[];input:string};try{const data=reply(body.args,body.input);const text=JSON.stringify(data);return new Response(body.args.includes('--include')?'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n'+text:text)}catch(error){return new Response(String(error),{status:500})}}})
    await fs.writeFile(join(bin,'gh'),`#!${process.execPath}\nconst args=process.argv.slice(2);let input='';if(args.includes('--input'))for await(const c of process.stdin)input+=c;const response=await fetch('http://127.0.0.1:${server.port}',{method:'POST',body:JSON.stringify({args,input})});process.stdout.write(await response.text());process.exit(response.ok?0:1);\n`);await fs.chmod(join(bin,'gh'),0o755)
    await fs.writeFile(join(bin,'git'),`#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2).map(value=>value==='https://github.com/acme/app.git'?${JSON.stringify(sourceRemote)}:value);const result=spawnSync(${JSON.stringify(actualGit)},args,{stdio:'inherit',env:process.env});process.exit(result.status??1);\n`);await fs.chmod(join(bin,'git'),0o755)
    const codex=`#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2),cwd=process.cwd(),phasePath=${JSON.stringify(phasePath)};
const phase=()=>{try{return JSON.parse(fs.readFileSync(phasePath,'utf8'))}catch{return{starts:0,reset:0}}};
if(args.includes('--version')){console.log('codex-cli 0.153.4');process.exit(0)}
if(args.includes('app-server')){
 const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
 if(m.method==='hooks/list')result={data:[{cwd,errors:[],hooks:[{handlerType:'command',eventName:'preToolUse',enabled:true,async:false,isManaged:false,currentHash:'sha256:'+ 'a'.repeat(64),trustStatus:'trusted',sourcePath:cwd+'/.codex/hooks.json',source:'project',command:'node .vegastack/hooks/ship-guard.mjs --harness codex'}]}]};
 if(m.method==='configRequirements/read')result={requirements:null};
 if(m.method==='config/read')result={config:{model_provider:'openai',model_providers:{},features:{hooks:true,memories:false,external_agent_memory_import:false,context_management:{experimental_mode:false}},memories:{use_memories:false,generate_memories:false},projects:{[cwd]:{trust_level:'trusted'}}}};
 if(m.method==='account/read')result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:'fixture@example.test',planType:'pro'}};
 if(m.method==='account/rateLimits/read'){const p=phase();result={accountId:'fixture-account',rateLimits:{primary:{usedPercent:p.starts===1&&Date.now()<p.reset?100:0,resetsAt:p.reset?Math.ceil(p.reset/1000):null},secondary:null,rateLimitReachedType:null}}}
 console.log(JSON.stringify({id:m.id,result}));});lines.on('close',()=>process.exit(0));
}else{
 const p=phase();p.starts++;fs.writeFileSync(phasePath,JSON.stringify({...p,reset:p.starts===1?Date.now()+1200:p.reset}));
 console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
 if(p.starts===1){console.log(JSON.stringify({type:'turn.failed',error:{message:'controlled quota failure'}}));process.exit(1)}
 if(!args.includes('resume')||!args.includes('fixture-session')){console.log(JSON.stringify({type:'turn.failed',error:{message:'wrong resume'}}));process.exit(2)}
 fs.writeFileSync(cwd+'/allowed.txt','checkpointed source\\n');for(const gitArgs of [['add','allowed.txt'],['commit','-m','checkpoint safe progress']]){const result=spawnSync('git',gitArgs,{cwd,stdio:'inherit'});if(result.status!==0)process.exit(3)}
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:2}}));process.exit(0)
}
`
    await fs.writeFile(join(bin,'codex'),codex);await fs.chmod(join(bin,'codex'),0o755)
    process.env.PATH=bin+':'+oldEnv.PATH;process.env.HOME=home;process.env.CODEX_HOME=join(home,'.codex');process.env.VSK_GH=join(bin,'gh');process.env.VSK_PREFLIGHT_SCRIPT=join(sourceRoot,'dev/dev-implement/scripts/preflight.mjs');process.env.VSK_SHIP_POLICY_SCRIPT=join(sourceRoot,'dev/dev-setup/scripts/ship-policy.mjs')
    const compiled=Bun.spawnSync(['node',process.env.VSK_SHIP_POLICY_SCRIPT,'--write','--json'],{cwd:tree,env:process.env});expect(compiled.exitCode,compiled.stdout.toString()+compiled.stderr.toString()).toBe(0)
    const plan=launch.buildLaunchPlan({harness:'codex',model:'fixture-model',effort:'high',stage:'implement',worktree:tree,issue:{number:1,title:'feat: fixture'},operator:'robot',outcome:'Finish the controlled fixture.',stopList:[],resume:false,skillPath:null,subagents:config.subagents})
    const metadata=await dispatch.inspectManagedHarness(plan);expect(launch.validateManagedLaunch(plan,metadata)).toEqual({ok:true,problems:[]})
    await fs.writeFile(join(installed,'package.json'),JSON.stringify({name:'@vegastack/vegafactory',version:'1.0.0'}));await fs.writeFile(join(installed,'dist/index.js'),'// controlled installed entry\n');await fs.writeFile(join(installed,'dist/run-wrapper.js'),'// controlled installed wrapper\n')
    const entries=await Promise.all(['dist/index.js','dist/run-wrapper.js','package.json'].map(async path=>({path,mode:0o644,sha256:crypto.createHash('sha256').update(await fs.readFile(join(installed,path))).digest('hex')})))
    const binding={schemaVersion:1 as const,sourceSha,treeSha,packageName:'@vegastack/vegafactory' as const,version:'1.0.0',tarballSha256:'f'.repeat(64),inventoryDigest:crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex')}
    // Relocate only the external installed-package filesystem; the full inventory matcher
    // and all source/configuration/qualification/ownership validators remain active.
    const verifyInventory=runtime.verifyInstalledRuntimeBinding
    inventorySpy=spyOn(runtime,'verifyInstalledRuntimeBinding').mockImplementation(value=>verifyInventory(value,installed,join(installed,'dist/index.js')))
    const account=await launch.inspectSubscription(plan)
    const provisional={providerMode:'subscription' as const,harness:'codex' as const,harnessVersion:metadata.version,model:'fixture-model',effort:'high',accountRef:account.accountRef,qualification:{kind:'state-receipt' as const,operationId:qualificationId,commitSha:qHead,blobSha256:'0'.repeat(64)}}
    const configurationDigest=await runtime.executionConfigurationDigest({binding,execution:provisional,plan,metadata})
    const qualification={schemaVersion:2,kind:'execution-qualification',harness:'codex',harnessVersion:metadata.version,model:'fixture-model',effort:'high',accountRef:account.accountRef,configurationDigest,candidateSha:sourceSha,validationIds:['158-H1/check/'+ 'd'.repeat(64)],managedKinds:['checkpoint-push','handback','evidence','telemetry-push'],unmanagedDenied:true,result:'qualified'}
    const receipt=wire.canonical({schemaVersion:1,operationId:qualificationId,type:'receipt',taskKey:'b'.repeat(64),generation:1,previousHead:coordRoot,requestDigest:'c'.repeat(64),resultOwner:{ownerToken:crypto.randomUUID(),machineId:'box',installationId:installation,sessionId:crypto.randomUUID(),runId:qualificationRun},recoveryPayload:qualification})
    versions.get(qHead)!['coordination/operations/'+qualificationId+'.json']=receipt
    const execution={...provisional,qualification:{...provisional.qualification,blobSha256:wire.sha256(receipt)}}
    await fs.writeFile(join(installed,'dist/index.js'),'changed')
    await expect(dispatch.registerQualifiedExecution({config,repo:'acme/app',plan,execution,runtimeBinding:binding})).rejects.toThrow('inventory')
    await fs.writeFile(join(installed,'dist/index.js'),'// controlled installed entry\n')
    await expect(dispatch.registerQualifiedExecution({config,repo:'acme/app',plan,execution:{...execution,qualification:{...execution.qualification,blobSha256:'e'.repeat(64)}},runtimeBinding:binding})).rejects.toThrow('changed')
    const registrationFile=join(home,'.vegastack','registration.json');await fs.writeFile(registrationFile,JSON.stringify({schemaVersion:1,repo:'acme/app',checkout:tree,stage:'implement',execution,runtimeBinding:binding}),{mode:0o600})
    await dispatch.registerExecutionRequest(JSON.parse(await fs.readFile(registrationFile,'utf8')),config)
    expect(await(await import('../src/checkpoints.ts')).runCheckpointCli(['--register-execution',registrationFile,'--json'],home)).toBe(0)
    expect((await runtime.readQualifiedExecutions(runtime.runsRoot(home))).length).toBe(1)
    // Reproduce a crash after durable preparation/event publication but before
    // an attempt directory or wrapper exists, then rename the issue. The next
    // real runOnce must reuse this exact record and checkout.
    const approvalBody=String(comments[1]!.body),authorities=[{approvalId:event.id,source:{kind:'github-comment' as const,repositoryId:'R_app',issueNodeId:'I_1',commentId:'12',bodySha256:crypto.createHash('sha256').update(approvalBody).digest('hex')}}]
    const taskIds=['1-T1'],scopeDigest=wire.sha256(wire.canonical({artifacts,taskIds})),runRoot=runtime.runsRoot(home)
    let prepared=await runtime.createRun({root:runRoot,repo:'acme/app',issue:1,parent:null,checkout:tree,branch:'feat/1-fixture',baseSha:sourceSha,headSha:sourceSha,stage:'implement',harness:'codex',model:'fixture-model',effort:'high',execution,approvalBindings:authorities,recordBinding:null,approvalRefs:artifacts,policyDigest:snapshot.policyDigest,claimToken:crypto.randomUUID(),startedAt:new Date().toISOString(),taskKey:{repo:'acme/app',issue:1,taskId:'1-T1',scopeDigest},approvedTaskIds:taskIds,activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:execution.accountRef,waitReason:null,hostBindingDigest:host,machine:{id:'box',installationId:installation,sessionId:crypto.randomUUID(),hostBindingDigest:host},sharedClaim:null,checkpoint:null,remoteEffectCoverage:{kind:'qualified-managed-only',qualification:execution.qualification},runtimeBinding:binding,configurationDigest,authorityRequest:{kind:'native'},handbackIntent:{id:'run-handback',approvalBindings:authorities},dispatchRequest:{commentId:null,reactionId:null}})
    const checkpointOwner=await import('../src/checkpoints.ts'),checkpointIntent=await checkpointOwner.checkpointIntentFromApproval(prepared,config)
    prepared=runtime.parseRun({...prepared,checkpointIntent:checkpointIntent!});await runtime.atomicRunFile(join(runRoot,prepared.runId,'run.json'),prepared)
    await fs.writeFile(join(runRoot,prepared.runId,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),event:'prepared'})+'\n',{mode:0o600})
    issue.title='feat: renamed fixture'
    // Source execution uses the real wrapper implementation without broad package build work.
    try{
      const result=await dispatch.runOnce(config,{dryRun:false},{processDeps:{wrapperPath:resolve('packages/cli/src/run-wrapper.ts')}})
      expect(result.refusals,result.refusals.map(r=>r.reason).join('\n')).toEqual([])
      const records=await runtime.readRuns(runtime.runsRoot(home));expect(records).toHaveLength(1);expect(records[0]?.runId).toBe(prepared.runId);expect(records[0]?.checkout).toBe(tree)
      const saved=records[0]!
      expect(JSON.parse(await fs.readFile(phasePath,'utf8')).starts).toBe(2)
      expect(saved.terminationCause).toBe('succeeded');expect(saved.attempts).toHaveLength(1);expect(saved.vendorSessionId).toBe('fixture-session');expect(saved.waitReason).toBe(null)
      expect(saved.pendingDelivery.find(p=>p.kind==='telemetry-capture')?.target).toEqual({captureKey:saved.runId+':terminal:0'})
      expect(saved.approvedTaskIds).toEqual(['1-T1']);expect(saved.approvalBindings[0]?.source.issueNodeId).toBe('I_1');expect(saved.stopProof?.kind).toBe('process-exit')
      expect(saved.checkpointIntent?.nativeApproval?.action).toBe('task-branch');expect(saved.checkpointIntent?.paths).toEqual(['allowed.txt'])
      expect(saved.checkpoint?.headSha).toBe(g(tree,'rev-parse','HEAD'));expect(g(repo,'ls-remote',sourceRemote,'refs/heads/feat/1-fixture').split(/\s/)[0]).toBe(saved.checkpoint?.headSha)
      const intent=saved.checkpointIntent!
      const {nativeApproval:_,...absentAction}=intent
      await expect((await checkpointOwner.configuredCheckpointController({...saved,checkpointIntent:absentAction},config)).verifyAuthority(absentAction)).rejects.toThrow('native authority')
      expect(()=>runtime.validateCheckpointIntentShape({...intent,nativeApproval:{...intent.nativeApproval!,action:'feature-push'}})).toThrow('native checkpoint authority')
      expect(()=>runtime.validateCheckpointIntentShape({...intent,unexpected:true})).toThrow('schema refused')
      const changedPlan={...intent,nativeApproval:{...intent.nativeApproval!,plan:{...intent.nativeApproval!.plan,digest:'9'.repeat(64)}}}
      await expect((await checkpointOwner.configuredCheckpointController({...saved,checkpointIntent:changedPlan},config)).verifyAuthority(changedPlan)).rejects.toThrow('native authority')
      const changedRef={...intent,baseRef:'refs/heads/other'}
      await expect((await checkpointOwner.configuredCheckpointController({...saved,checkpointIntent:changedRef},config)).verifyAuthority(changedRef)).rejects.toThrow('repository identity')
      const changedFiles={...intent,paths:['other.txt']}
      await expect((await checkpointOwner.configuredCheckpointController({...saved,checkpointIntent:changedFiles},config)).verifyAuthority(changedFiles)).rejects.toThrow('native scope')
      await fs.writeFile(join(tree,'dirty-after-rename.txt'),'user edit')
      expect(()=>dispatch.defaultEnsureWorktree(repo,1,'feat: renamed again')).toThrow('verified takeover handover required')
      await fs.unlink(join(tree,'dirty-after-rename.txt'))
      expect(publicWrites).toBe(0)
      await dispatch.runOnce(config,{dryRun:false},{processDeps:{wrapperPath:resolve('packages/cli/src/run-wrapper.ts')}})
      expect(JSON.parse(await fs.readFile(phasePath,'utf8')).starts).toBe(2)
      // The default finisher must preserve physical stop independently of remote
      // reconciliation. These are real wrapper exits and controlled state receipts.
      const root=runtime.runsRoot(home),finish=dispatch.sharedRunAdapters(config).finishSharedRun!
      let shared=await dispatch.sharedClaimForRun(saved,config)
      const task=(await wire.readCoordination(shared.target)).tasks[shared.taskKey]!
      const originalStop=await wire.resolveEvidence(shared.target,saved.stopProof!.evidenceRef)
      expect(originalStop?.kind==='effect-reconciliation'&&originalStop.result).toBe('complete') // telemetry alone is nonblocking
      await expect(finish({...shared,generation:shared.generation+1},null)).rejects.toThrow('identity mismatch')
      const recovery=structuredClone(task.recovery!)
      recovery.remoteEffectCoverage={kind:'unmanaged-possible',reasonCode:'controlled-unknown-effects'}
      const changed=await wire.transitionSharedTask({claim:shared,operationId:crypto.randomUUID(),transition:{kind:'recovery',recovery}})
      if(changed.kind!=='owned')throw Error(changed.reason)
      shared=changed.claim
      await runtime.updateRun(root,saved.runId,()=>({stopProof:null,stopReceiptIds:undefined,stopReceiptPayload:undefined,acceptedScopeRef:execution.qualification}))
      const stopped=await finish(shared,null)
      expect(stopped.kind).toBe('stop')
      if(stopped.kind!=='stop'||!stopped.stopProof)throw Error('physical stop missing')
      const proof=stopped.stopProof,payload=await wire.resolveEvidence(shared.target,proof.evidenceRef)
      expect(payload?.kind==='effect-reconciliation'&&payload.result).toBe('unresolved')
      const retained=await runtime.readRun(root,saved.runId)
      expect(await finish(shared,null)).toEqual(stopped)
      expect((await runtime.readRun(root,saved.runId)).stopReceiptIds).toEqual(retained.stopReceiptIds)
      await runtime.verifySharedStopProof(proof,task,shared.target,retained)
      await expect(runtime.verifySharedStopProof({...proof,hostBindingDigest:'9'.repeat(64)},task,shared.target,retained)).rejects.toThrow()
      await expect(runtime.verifySharedStopProof({...proof,generation:proof.generation+1},task,shared.target,retained)).rejects.toThrow()
      await expect(runtime.verifySharedStopProof({...proof,bootIdDigest:'8'.repeat(64)},task,shared.target,retained)).rejects.toThrow('boot identity')
      if(proof.evidenceRef.kind!=='state-receipt')throw Error('state receipt missing')
      await expect(runtime.verifySharedStopProof({...proof,evidenceRef:{...proof.evidenceRef,blobSha256:'7'.repeat(64)}},task,shared.target,retained)).rejects.toThrow('changed')
      await expect(runtime.verifySharedStopProof(proof,{...task,ownerToken:crypto.randomUUID()},shared.target,retained)).rejects.toThrow()
      await expect(runtime.verifySharedStopProof(proof,task,shared.target,{...retained,processIdentity:null})).rejects.toThrow('unconfirmed')
      const live=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{detached:true,stdio:'ignore'}),exited=new Promise(resolve=>live.once('exit',resolve))
      await new Promise<void>((resolve,reject)=>live.once('spawn',resolve).once('error',reject))
      try{
        const liveIdentity=await(await import('../src/claims.ts')).processIdentity(live.pid!)
        await expect(runtime.verifySharedStopProof(proof,task,shared.target,{...retained,processIdentity:liveIdentity})).rejects.toThrow('unconfirmed')
      }finally{try{process.kill(-live.pid!,'SIGKILL')}catch{}await exited}
      // Pending code delivery also yields an unresolved stop, even with qualified
      // coverage. Lose the receipt acknowledgment, then retry after local delivery
      // changes: the original operation/payload must be reused, never rebound.
      const restored=await wire.transitionSharedTask({claim:await dispatch.sharedClaimForRun(retained,config),operationId:crypto.randomUUID(),transition:{kind:'recovery',recovery:task.recovery!}})
      if(restored.kind!=='owned')throw Error(restored.reason)
      const pending:import('../src/runs.ts').PendingDelivery={id:crypto.randomUUID(),kind:'evidence',target:{repo:saved.repo,issue:saved.issue,commentId:null},intentRef:null,status:'pending',attempts:0,lastError:null}
      await runtime.updateRun(root,saved.runId,()=>({stopProof:null,stopReceiptIds:undefined,stopReceiptPayload:undefined,pendingDelivery:[...saved.pendingDelivery,pending]}))
      const publish=wire.publishRecoveryReceipt
      const lost=spyOn(wire,'publishRecoveryReceipt').mockImplementation(async input=>{await publish(input);throw Error('controlled lost stop response')})
      try{await expect(finish(restored.claim,null)).rejects.toThrow('controlled lost stop response')}finally{lost.mockRestore()}
      const beforeRetry=await runtime.readRun(root,saved.runId)
      const stopReceiptCount=Object.values(versions.get(head)!).filter(raw=>{try{return JSON.parse(raw).recoveryPayload?.reasonCode==='owned-process-group-stopped'}catch{return false}}).length
      await runtime.updateRun(root,saved.runId,r=>({pendingDelivery:r.pendingDelivery.map(p=>p.id===pending.id?{...p,status:'acknowledged'}:p),acceptedScopeRef:null}))
      const retried=await finish(restored.claim,null)
      expect(retried.kind).toBe('stop')
      if(retried.kind!=='stop'||!retried.stopProof)throw Error('retry stop missing')
      expect((await runtime.readRun(root,saved.runId)).stopReceiptIds).toEqual(beforeRetry.stopReceiptIds)
      const retryPayload=await wire.resolveEvidence(restored.claim.target,retried.stopProof.evidenceRef)
      expect(retryPayload?.kind==='effect-reconciliation'&&retryPayload.result).toBe('unresolved')
      expect(Object.values(versions.get(head)!).filter(raw=>{try{return JSON.parse(raw).recoveryPayload?.reasonCode==='owned-process-group-stopped'}catch{return false}})).toHaveLength(stopReceiptCount)
      // The same installed default machinery prepares a consolidated scope with a
      // separate relay pin. Neither that pin nor JSON key order creates authority.
      const brief2={...issue,id:2,node_id:'I_2',number:2},plan2={...baseComment,id:21,node_id:'PLAN_2',body:planBody.replace('1-T1','2-T1'),issue_url:'https://api.github.com/repos/acme/app/issues/2',html_url:'https://github.com/acme/app/issues/2#issuecomment-21'}
      extraIssues.set(2,brief2);extraIssues.set(10,{...issue,id:10,node_id:'I_parent',number:10,body:'parent'});extraComments.set(2,[plan2])
      const refs2=[{...artifacts[0]!,issue:2,artifactId:'I_2'},{...artifacts[1]!,issue:2,artifactId:'PLAN_2',digest:approvalOwner.scopeDigest(plan2.body,'plan')}]
      const selection={repo:'acme/app',issue:2,mode:'code',artifacts:refs2,taskIds:['2-T1'],actionIds:['local','backup']},parent={repo:'acme/app',issue:10,branch:'feat/1-fixture',baseSha:sourceSha}
      const local={id:'local',kind:'local',repo:'acme/app',parentBranch:parent.branch,operations:['edit','check','review','integrate']},backup={id:'backup',kind:'checkpoint',repo:'acme/app',branch:parent.branch,sourceScopeDigest:wire.sha256(wire.canonical({parent,selections:[selection]}))}
      const manifest={schemaVersion:1,parent,codeIssues:[2],preparationTaskIds:[],candidateProtocols:[],excludedIssues:[],laterResearch:[],selections:[selection],actionBounds:{local,backup}},manifestBytes=JSON.stringify(manifest)
      const rootEvent={schemaVersion:2,kind:'consolidated',id:'root-qualified',operator:'robot',scope:'consolidated',source:{kind:'session',ref:'session:fixture',quote:'I approve this exact second scope.'},manifest:{sha256:wire.sha256(manifestBytes),source:{kind:'inline',utf8:manifestBytes}},items:[selection],actions:[local,backup],supersedes:[],revokes:[]}
      const rootComment={id:101,node_id:'ROOT_101',user:{login:'robot'},issue_url:'https://api.github.com/repos/acme/app/issues/10',html_url:'https://github.com/acme/app/issues/10#issuecomment-101',body:'<!-- vsk:v1 type=approval scope=consolidated -->\n```json\n'+JSON.stringify(rootEvent)+'\n```\n'}
      const relayEvent={...rootEvent,id:'relay-qualified',source:{kind:'github-comment',ref:rootComment.html_url,quote:rootEvent.source.quote}},relay={...rootComment,id:102,node_id:'RELAY_102',user:{login:'relay-bot'},html_url:'https://github.com/acme/app/issues/10#issuecomment-102',body:'<!-- vsk:v1 type=approval scope=consolidated -->\n```json\n'+JSON.stringify(relayEvent)+'\n```\n'}
      extraComments.set(10,[rootComment,relay])
      const request={kind:'consolidated' as const,parentRepo:'acme/app',parentIssue:10,approvalBinding:{commentId:102,bodySha256:wire.sha256(relay.body)},requested:{repo:'acme/app',issue:2,taskIds:['2-T1'],actionId:'local',branch:parent.branch,baseSha:sourceSha,paths:['allowed.txt'],operation:'edit' as const}}
      const claim=await dispatch.holdLock(dispatch.repoLockPath(config,'acme/app'),process.pid)
      try{
        const prepared=await dispatch.prepareConsolidatedRun({run:{repo:'acme/app',issue:2,title:'fixture',stage:'implement',commentId:null,reactionId:null},plan,config,request,claim})
        expect(prepared.recordBinding?.source.commentId).toBe('102');expect(prepared.approvalBindings[0]?.source.commentId).toBe('101');expect(prepared.checkpointIntent?.id).toBe('backup')
        await runtime.verifyRunAuthority(prepared,config)
        await expect(runtime.verifyRunAuthority({...prepared,recordBinding:prepared.approvalBindings[0]!},config)).rejects.toThrow('provenance changed')
        await expect(runtime.verifyRunAuthority({...prepared,approvalBindings:[]},config)).rejects.toThrow('authority context')
        relay.body+='changed relay'
        await expect(runtime.verifyRunAuthority(prepared,config)).rejects.toThrow()
        expect(JSON.parse(await fs.readFile(phasePath,'utf8')).starts).toBe(2)
      }finally{await dispatch.releaseLock(dispatch.repoLockPath(config,'acme/app'),claim)}
    }finally{}
  }finally{
    inventorySpy?.mockRestore();server?.stop(true)
    for(const [key,value]of Object.entries(oldEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value}
    await fs.rm(home,{recursive:true,force:true})
  }
},180000)
