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

async function defaultPackagedFixture(options:{mode?:'code'|'preparation';dependencyDrift?:boolean}={}){
  const fs=await import('node:fs/promises'),crypto=await import('node:crypto'),runtime=await import('../src/runs.ts'),wire=await import('../src/shared-claims.ts'),dispatch=await import('../src/dispatch.ts'),launch=await import('../src/launch.ts')
  const policyOwner=await import('../../../skills/dev/dev-setup/scripts/effective-policy.mjs'),approval=await import('../../../skills/dev/dev-implement/scripts/lib/approval.mjs'),childrenHelper=await import('../../../skills/dev/dev-implement/scripts/children.mjs'),{parseFactoryConfig}=await import('../src/config.ts'),{processIdentity}=await import('../src/claims.ts')
  const home=await realpath(await mkdtemp(join(tmpdir(),'packaged-child-default-'))),tree=join(home,'app'),room=join(home,'room'),remote=join(home,'source.git'),packaged=join(home,'package'),bin=join(home,'bin'),vendor=join(home,'vendor.jsonl')
  const actualGit=Bun.which('git')!,sourceRoot=resolve('skills'),oldEnv={PATH:process.env.PATH,HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,VSK_GH:process.env.VSK_GH,VSK_SHIP_POLICY_SCRIPT:process.env.VSK_SHIP_POLICY_SCRIPT}
  let server:ReturnType<typeof Bun.serve>|undefined
  const g=(cwd:string,...args:string[])=>{const result=spawnSync(actualGit,args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}});if(result.status!==0)throw Error(result.stderr);return result.stdout.trim()}
  try{
    await fs.mkdir(join(tree,'.vegastack','hooks'),{recursive:true});await fs.mkdir(join(tree,'.codex'),{recursive:true});await fs.mkdir(join(room,'groups','dev'),{recursive:true});await fs.mkdir(join(packaged,'dist'),{recursive:true});await fs.mkdir(bin);await fs.mkdir(join(home,'.codex'),{recursive:true});await fs.mkdir(join(home,'.vegastack'),{recursive:true,mode:0o700})
    const host=(await(await import('../src/machine-identity.ts')).readHostBinding()).digest,machineInstallation=randomUUID(),coordinationInstallation=randomUUID(),coordRoot='1'.repeat(40),qHead='2'.repeat(40),qualificationId=randomUUID(),qualificationRun=randomUUID()
    const devMd='repo: acme/app · default branch main\ncontrol-room: acme/room#dev\nsync-max-age: 2h\ndispatch: local\noperators: robot\ncommands: check `test "$(cat requested.txt)" = accepted`\nimplement: codex fixture-model high\n'
    await fs.writeFile(join(tree,'.vegastack','dev.md'),devMd);await fs.writeFile(join(tree,'.vegastack','hooks','ship-guard.mjs'),await fs.readFile(join(sourceRoot,'dev/dev-setup/assets/hooks/ship-guard.mjs')));await fs.writeFile(join(tree,'.codex','hooks.json'),JSON.stringify({hooks:{PreToolUse:[{hooks:[{type:'command',command:'node .vegastack/hooks/ship-guard.mjs --harness codex'}]}]}}));await fs.writeFile(join(tree,'.codex','config.toml'),'# fixture\n');await fs.writeFile(join(tree,'.gitignore'),'.vegastack/.worktrees/\n');await fs.writeFile(join(tree,'base.txt'),'base\n')
    g(tree,'init','-b','main');g(tree,'add','.');g(tree,'commit','-m','base');spawnSync(actualGit,['init','--bare',remote]);spawnSync(actualGit,['--git-dir',remote,'symbolic-ref','HEAD','refs/heads/main']);spawnSync(actualGit,['push',remote,'HEAD:main'],{cwd:tree});g(tree,'checkout','-b','feat/1-parent');g(tree,'remote','add','origin','https://github.com/acme/app.git')
    const sourceSha=g(tree,'rev-parse','HEAD'),sourceTree=g(tree,'rev-parse','HEAD^{tree}')
    const buildIndex=await Bun.build({entrypoints:[resolve('packages/cli/src/index.ts')],target:'node',outdir:join(packaged,'dist')}),buildWrapper=await Bun.build({entrypoints:[resolve('packages/cli/src/run-wrapper.ts')],target:'node',outdir:join(packaged,'dist')});if(!buildIndex.success||!buildWrapper.success)throw Error('fixture package build failed')
    await fs.writeFile(join(packaged,'package.json'),JSON.stringify({type:'module',name:'@vegastack/vegafactory',version:'1.0.0'}));for(const name of ['dev-implement','dev-plan','dev-setup','dev-ship'])await fs.cp(resolve('skills/dev',name),join(packaged,'skill',name),{recursive:true});await fs.chmod(join(packaged,'dist','index.js'),0o755);await fs.chmod(join(packaged,'dist','run-wrapper.js'),0o755)
    const fleet={schemaVersion:1,coordination:{repositoryId:'R_room',repository:'acme/room',branch:'factory-state',rootCommit:coordRoot,installationId:coordinationInstallation},defaults:{pollSeconds:120,maxRuns:1,childConcurrent:1,checkpoints:'task-branch',recovery:'verified-transfer'},groupDefaults:{},machines:{box:{installationId:machineInstallation,hostBindingDigest:host,executionLogin:'robot',group:'dev',repositories:['acme/app'],enabled:true,overrides:{}}}}
    await fs.writeFile(join(room,'org.md'),'sync-max-age: 2h\npolicy-schema: 2\n```vsk-policy\n'+JSON.stringify({schemaVersion:2,fleet})+'\n```\n');await fs.writeFile(join(room,'groups/dev/group.md'),'review: subagent\n');await fs.writeFile(join(room,'people.csv'),'login,name,role,slack,timezone,groups\nrobot,Robot,lead,,UTC,dev\n');await fs.writeFile(join(room,'repos.md'),'| repo | group | board | owner | repository-id |\n|---|---|---|---|---|\n| acme/app | dev | | robot | R_app |\n');g(room,'init','-b','main');g(room,'remote','add','origin','https://github.com/acme/room.git');g(room,'add','.');g(room,'commit','-m','policy')
    const snapshot={schemaVersion:2,org:'acme',group:'dev',repository:'acme/room',origin:'https://github.com/acme/room.git',sourceCommit:g(room,'rev-parse','HEAD'),policyDigest:'0'.repeat(64),validatedAt:new Date().toISOString(),contentPath:room};snapshot.policyDigest=policyOwner.loadSnapshotPolicy({snapshot,repo:'acme/app',devMd,expectedOrigin:snapshot.origin,now:Date.now()}).policy.policyDigest
    const raw={schemaVersion:2,revision:0,repos:[{repo:'acme/app',org:'acme',path:tree}],machine:{id:'box',installationId:machineInstallation,hostBindingDigest:host,group:'dev',controlRoom:{repositoryId:'R_room',repo:'acme/room',remote:snapshot.origin,branch:'main'}},controlRooms:{acme:{repo:'acme/room',remote:snapshot.origin,path:join(home,'operator-room'),branch:'main',sha:snapshot.sourceCommit,lastSyncedAt:snapshot.validatedAt,repositoryId:'R_room',snapshots:{'acme/app':snapshot}}}},config=parseFactoryConfig(raw,home);await fs.writeFile(join(home,'.vegastack','factory.json'),JSON.stringify(raw))
    const parentBrief='<!-- vsk:v1 type=brief rev=1 scope=quick-build -->\n## Outcome\nRun the declared child.\n',childBrief='<!-- vsk:v1 type=brief rev=1 scope=quick-build -->\n## Outcome\nWrite requested.txt.\n'
    const parentPlan='<!-- vsk:v1 type=plan rev=1 -->\n- [ ] **Task 1: parent** <!-- task-id:1-T1 -->\n  - Files — `requested.txt`\n  - Interfaces — child gateway\n  - Steps: integrate child\n\n**Independent groups:**\n- `g0` — #8 · Files: `requested.txt`\n',childPlan='<!-- vsk:v1 type=plan rev=1 -->\n- [ ] **Task 1: child** <!-- task-id:8-T1 -->\n  - Files — `requested.txt`\n  - Interfaces — exact child\n  - Steps: write requested.txt\n'
    const parentIssue={id:1,node_id:'I_1',number:1,title:'feat: parent',body:parentBrief,state:'open',labels:[],assignees:[],updated_at:new Date().toISOString()},childIssue={id:8,node_id:'I_8',number:8,title:'feat: child',body:childBrief,state:'open',labels:[],assignees:[],updated_at:new Date().toISOString()}
    const baseComment={user:{login:'robot'},updated_at:new Date().toISOString()},parentPlanComment={...baseComment,id:11,node_id:'PLAN_1',issue_url:'https://api.github.com/repos/acme/app/issues/1',html_url:'https://github.com/acme/app/issues/1#issuecomment-11',body:parentPlan},childPlanComment={...baseComment,id:81,node_id:'PLAN_8',issue_url:'https://api.github.com/repos/acme/app/issues/8',html_url:'https://github.com/acme/app/issues/8#issuecomment-81',body:childPlan}
    const parentArtifacts=[approval.artifactRef({repo:'acme/app',issue:1,kind:'brief',artifact:parentIssue}),approval.artifactRef({repo:'acme/app',issue:1,kind:'plan',artifact:parentPlanComment})],childArtifacts=[approval.artifactRef({repo:'acme/app',issue:8,kind:'brief',artifact:childIssue}),approval.artifactRef({repo:'acme/app',issue:8,kind:'plan',artifact:childPlanComment})]
    const groups={guard:'plan-lint',ok:true,groups:[{id:'g0',members:['#8'],files:['requested.txt']}]},planned=childrenHelper.planParallelRun({groups:groups.groups,issues:{8:{number:8,title:'child',type:'feat'}},parentBranch:'feat/1-parent',parentHead:sourceSha,repoRoot:tree,parentIssue:1}),plannedChild=planned.children[0]!
    const local={id:'local',kind:'local',repo:'acme/app',parentBranch:'feat/1-parent',operations:['edit','check','review','integrate']},parentSelection={repo:'acme/app',issue:1,mode:'code',artifacts:parentArtifacts,taskIds:['1-T1'],actionIds:['local','parent-checkpoint']},childSelection={repo:'acme/app',issue:8,mode:options.mode??'code',artifacts:childArtifacts,taskIds:['8-T1'],actionIds:['local','child-checkpoint']},parentIdentity={repo:'acme/app',issue:1,branch:'feat/1-parent',baseSha:sourceSha}
    const selections=[parentSelection,childSelection],parentCheckpoint={id:'parent-checkpoint',kind:'checkpoint',repo:'acme/app',branch:'feat/1-parent',sourceScopeDigest:wire.sha256(wire.canonical({parent:parentIdentity,selections}))},childCheckpoint={id:'child-checkpoint',kind:'child-source-checkpoint',repo:'acme/app',parent:{issue:1,branch:'feat/1-parent',baseSha:sourceSha},child:{issue:8,branch:plannedChild.branch,ref:'refs/heads/'+plannedChild.branch,baseSha:sourceSha,taskIds:['8-T1'],paths:['requested.txt']}}
    const manifest={schemaVersion:1,parent:parentIdentity,codeIssues:options.mode==='preparation'?[1]:[1,8],preparationTaskIds:options.mode==='preparation'?['8-T1']:[],candidateProtocols:[],excludedIssues:[],laterResearch:[],selections,actionBounds:{local,'parent-checkpoint':parentCheckpoint,'child-checkpoint':childCheckpoint}},manifestBytes=JSON.stringify(manifest),event={schemaVersion:2,kind:'consolidated',id:'root-scope',operator:'robot',scope:'consolidated',source:{kind:'session',ref:'session:fixture',quote:'Approve exact packaged child fixture.'},manifest:{sha256:wire.sha256(manifestBytes),source:{kind:'inline',utf8:manifestBytes}},items:selections,actions:[local,parentCheckpoint,childCheckpoint],supersedes:[],revokes:[]}
    const approvalBody='<!-- vsk:v1 type=approval scope=consolidated -->\n```json\n'+JSON.stringify(event)+'\n```\n',approvalComment={...baseComment,id:12,node_id:'APPROVAL_1',issue_url:'https://api.github.com/repos/acme/app/issues/1',html_url:'https://github.com/acme/app/issues/1#issuecomment-12',body:approvalBody},parentComments=[parentPlanComment,approvalComment],childComments:Array<any>=[childPlanComment]
    const versions=new Map<string,Record<string,string>>([[coordRoot,{'coordination/index.json':wire.canonical({schemaVersion:1,installationId:coordinationInstallation,revision:0,active:[],machines:[]})}]]),stateHistory=[coordRoot];let stateHead=qHead,stateSequence=2,publicWrites=0,dependencyReads=0
    versions.set(qHead,{...versions.get(coordRoot)!});stateHistory.push(qHead)
    const reply=(args:string[],input:string)=>{const endpoint=args.find(arg=>arg==='user'||arg==='graphql'||arg.startsWith('repos/'))??'';if(endpoint==='graphql'){const request=JSON.parse(input),variables=request.variables??{},query=request.query as string;if(query.includes('createCommitOnBranch')){if(variables.input.expectedHeadOid!==stateHead)return{errors:[{type:'STALE_DATA'}]};const next={...versions.get(stateHead)!};for(const addition of variables.input.fileChanges.additions)next[addition.path]=Buffer.from(addition.contents,'base64').toString('utf8');stateHead=crypto.createHash('sha1').update(String(++stateSequence)).digest('hex');versions.set(stateHead,next);stateHistory.push(stateHead);return{data:{createCommitOnBranch:{commit:{oid:stateHead}}}}}if(query.includes('object(expression:')){const split=variables.expression.indexOf(':'),commit=variables.expression.slice(0,split),path=variables.expression.slice(split+1),text=versions.get(commit)?.[path];return{data:{repository:{object:text===undefined?null:{byteSize:Buffer.byteLength(text),isBinary:false,text}}}}}return{data:{repository:{id:'R_room',isPrivate:true,defaultBranchRef:{name:'main'},ref:{id:'REF_state',target:{oid:stateHead}}}}}}const path=endpoint.split('?')[0]!;if(path==='user')return{login:'robot'};if(path==='repos/acme/room'||path==='repos/acme/app')return{node_id:path.endsWith('room')?'R_room':'R_app',full_name:path.slice(6),permissions:{pull:true},default_branch:'main',private:true};if(path.startsWith('repos/acme/room/compare/')){const [base,next]=path.split('/compare/')[1]!.split('...');return{status:base===next?'identical':stateHistory.indexOf(base!)>=0&&stateHistory.indexOf(base!)<stateHistory.indexOf(next!)?'ahead':'diverged'}}if(path==='repos/acme/app/issues/1')return parentIssue;if(path==='repos/acme/app/issues/8')return childIssue;if(path==='repos/acme/app/issues/1/comments')return parentComments;if(path==='repos/acme/app/issues/8/comments')return childComments;if(path.endsWith('/dependencies/blocked_by')){dependencyReads++;return options.dependencyDrift&&path.includes('/8/')&&dependencyReads>2?[{id:99,state:'open'}]:[]}if(args.includes('POST')){publicWrites++;return{}}throw Error('unexpected controlled endpoint '+endpoint)}
    const controlledReply=(args:string[],input:string)=>{const endpoint=args.find(arg=>arg.startsWith('repos/'))?.split('?')[0];if(endpoint==='repos/acme/app/issues/comments/12')return approvalComment;if(endpoint==='repos/acme/app/issues/comments/82')return childComments.find(row=>row.id===82);return reply(args,input)}
    server=Bun.serve({port:0,fetch:async request=>{const body=await request.json() as {args:string[];input:string};try{const value=controlledReply(body.args,body.input),text=JSON.stringify(value);return new Response(body.args.includes('--include')?'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n'+text:text)}catch(error){return new Response(String(error),{status:500})}}})
    await fs.writeFile(join(bin,'gh'),`#!/bin/sh\ninput=$(cat)\njq -cn --arg input "$input" --args '$ARGS.positional as $args | {args:$args,input:$input}' -- "$@" | curl --fail-with-body -sS -X POST --data-binary @- http://127.0.0.1:${server.port}\n`);await fs.chmod(join(bin,'gh'),0o755)
    await fs.writeFile(join(bin,'git'),`#!${process.execPath}\nconst{spawnSync}=require('node:child_process');const args=process.argv.slice(2).map(v=>v==='https://github.com/acme/app.git'?${JSON.stringify(remote)}:v);const r=spawnSync(${JSON.stringify(actualGit)},args,{stdio:'inherit',env:process.env});process.exit(r.status??1);\n`);await fs.chmod(join(bin,'git'),0o755)
    await fs.writeFile(join(bin,'codex'),`#!${process.execPath}\nimport fs from'node:fs';import readline from'node:readline';import{spawnSync}from'node:child_process';const a=process.argv.slice(2),cwd=process.cwd();if(a.includes('--version')){console.log('codex-cli 0.153.4');process.exit(0)}if(a.includes('app-server')){const l=readline.createInterface({input:process.stdin});l.on('line',x=>{const m=JSON.parse(x);if(m.id===undefined)return;let result={};if(m.method==='hooks/list')result={data:[{cwd,errors:[],hooks:[{handlerType:'command',eventName:'preToolUse',enabled:true,async:false,isManaged:false,currentHash:'sha256:'+'a'.repeat(64),trustStatus:'trusted',sourcePath:cwd+'/.codex/hooks.json',source:'project',command:'node .vegastack/hooks/ship-guard.mjs --harness codex'}]}]};if(m.method==='configRequirements/read')result={requirements:null};if(m.method==='config/read')result={config:{model_provider:'openai',model_providers:{},features:{hooks:true,memories:false,external_agent_memory_import:false,context_management:{experimental_mode:false}},memories:{use_memories:false,generate_memories:false},projects:{[cwd]:{trust_level:'trusted'}}}};if(m.method==='account/read')result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:'fixture@example.test',planType:'pro'}};if(m.method==='account/rateLimits/read')result={accountId:'fixture-account',rateLimits:{primary:{usedPercent:0,resetsAt:null},secondary:null,rateLimitReachedType:null}};console.log(JSON.stringify({id:m.id,result}))});l.on('close',()=>process.exit(0))}else{fs.appendFileSync(${JSON.stringify(vendor)},JSON.stringify({cwd,args:a})+'\\n');fs.writeFileSync(cwd+'/requested.txt','accepted\\n');for(const x of [['add','requested.txt'],['commit','-m','controlled child']]){const r=spawnSync('git',x,{cwd,stdio:'inherit'});if(r.status!==0)process.exit(3)}console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-child'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:2}}))}\n`);await fs.chmod(join(bin,'codex'),0o755)
    const env={...process.env,PATH:bin+':'+oldEnv.PATH,HOME:home,CODEX_HOME:join(home,'.codex'),VSK_GH:join(bin,'gh'),VSK_SHIP_POLICY_SCRIPT:join(sourceRoot,'dev/dev-setup/scripts/ship-policy.mjs')};Object.assign(process.env,{PATH:env.PATH,HOME:env.HOME,CODEX_HOME:env.CODEX_HOME,VSK_GH:env.VSK_GH,VSK_SHIP_POLICY_SCRIPT:env.VSK_SHIP_POLICY_SCRIPT})
    const compiled=Bun.spawnSync(['node',env.VSK_SHIP_POLICY_SCRIPT!,'--write','--json'],{cwd:tree,env});if(compiled.exitCode!==0)throw Error(compiled.stdout.toString()+compiled.stderr.toString())
    await fs.mkdir(join(plannedChild.path,'.codex'),{recursive:true});await fs.mkdir(join(plannedChild.path,'.vegastack','hooks'),{recursive:true});await fs.copyFile(join(tree,'.codex','hooks.json'),join(plannedChild.path,'.codex','hooks.json'));await fs.copyFile(join(tree,'.codex','config.toml'),join(plannedChild.path,'.codex','config.toml'));await fs.copyFile(join(tree,'.vegastack','hooks','ship-guard.mjs'),join(plannedChild.path,'.vegastack','hooks','ship-guard.mjs'))
    const metadataPlan=launch.buildLaunchPlan({harness:'codex',model:'fixture-model',effort:'high',stage:'implement',worktree:plannedChild.path,issue:{number:8,title:'child'},operator:'robot',outcome:'Complete the approved child scope. Only these paths are owned: requested.txt. Commit the result and leave integration to the parent CLI.',stopList:[],resume:false,skillPath:null,subagents:config.subagents}),metadata=await dispatch.inspectManagedHarness(metadataPlan),account=await launch.inspectSubscription(metadataPlan)
    await fs.rm(plannedChild.path,{recursive:true,force:true})
    const inventory:Array<{path:string;mode:number;sha256:string}>=[];const walk=async(dir:string,prefix='')=>{for(const item of await fs.readdir(dir,{withFileTypes:true})){const path=join(dir,item.name),relative=prefix+item.name,stat=await fs.lstat(path);if(item.isDirectory())await walk(path,relative+'/');else inventory.push({path:relative,mode:stat.mode&0o777,sha256:crypto.createHash('sha256').update(await fs.readFile(path)).digest('hex')})}};await walk(packaged);inventory.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
    const binding={schemaVersion:1 as const,sourceSha,treeSha:sourceTree,packageName:'@vegastack/vegafactory' as const,version:'1.0.0',tarballSha256:'f'.repeat(64),inventoryDigest:crypto.createHash('sha256').update(JSON.stringify(inventory)).digest('hex')},provisional={providerMode:'subscription' as const,harness:'codex' as const,harnessVersion:metadata.version,model:'fixture-model',effort:'high',accountRef:account.accountRef,qualification:{kind:'state-receipt' as const,operationId:qualificationId,commitSha:qHead,blobSha256:'0'.repeat(64)}},nodeVersion=spawnSync('node',['-p','process.versions.node'],{env,encoding:'utf8'}).stdout.trim(),configurationDigest=await runtime.executionConfigurationDigest({binding,execution:provisional,plan:metadataPlan,metadata,nodeVersion})
    await runtime.verifyInstalledRuntimeBinding(binding,packaged,join(packaged,'dist','index.js'))
    const qualification={schemaVersion:2,kind:'execution-qualification',harness:'codex',harnessVersion:metadata.version,model:'fixture-model',effort:'high',accountRef:account.accountRef,configurationDigest,candidateSha:sourceSha,validationIds:['158-H1/check/'+'d'.repeat(64)],managedKinds:['checkpoint-push','handback','evidence','telemetry-push'],unmanagedDenied:true,result:'qualified'},qualificationReceipt=wire.canonical({schemaVersion:1,operationId:qualificationId,type:'receipt',taskKey:'b'.repeat(64),generation:1,previousHead:coordRoot,requestDigest:'c'.repeat(64),resultOwner:{ownerToken:randomUUID(),machineId:'box',installationId:machineInstallation,sessionId:randomUUID(),runId:qualificationRun},recoveryPayload:qualification});versions.get(qHead)!['coordination/operations/'+qualificationId+'.json']=qualificationReceipt
    const execution={...provisional,qualification:{...provisional.qualification,blobSha256:wire.sha256(qualificationReceipt)}};await runtime.storeQualifiedExecution(runsRoot(home),{schemaVersion:1,execution,runtimeBinding:binding,configurationDigest})
    const authority={approvalId:event.id,source:{kind:'github-comment' as const,repositoryId:'R_app',issueNodeId:'I_1',commentId:'12',bodySha256:wire.sha256(approvalBody)}},parentScope=wire.sha256(wire.canonical({artifacts:parentArtifacts,taskIds:['1-T1']})),parentRunId=randomUUID(),machine={id:'box',installationId:machineInstallation,sessionId:randomUUID(),hostBindingDigest:host}
    const parentRequest={kind:'consolidated' as const,parentRepo:'acme/app',parentIssue:1,approvalBinding:{commentId:12,bodySha256:wire.sha256(approvalBody)},requested:{repo:'acme/app',issue:1,taskIds:['1-T1'],actionId:'local',branch:'feat/1-parent',baseSha:sourceSha,paths:['requested.txt'],operation:'edit' as const}},checkpointRequest={parentRepo:'acme/app',parentIssue:1,approvalBinding:parentRequest.approvalBinding,requested:{repo:'acme/app',issue:1,taskIds:['1-T1'],actionId:'parent-checkpoint',branch:'feat/1-parent',baseSha:sourceSha,paths:['requested.txt'],operation:'checkpoint' as const}},parentIntent={id:'parent-checkpoint',repo:'acme/app',repositoryId:'R_app',remote:'origin',remoteUrl:'https://github.com/acme/app.git',branch:'feat/1-parent',baseRef:'refs/heads/main',baseSha:sourceSha,scopeDigest:parentScope,paths:['requested.txt'],approvalBindings:[authority],approvalRequest:checkpointRequest}
    let parent=await runtime.createRun({root:runsRoot(home),runId:parentRunId,repo:'acme/app',issue:1,parent:null,checkout:tree,branch:'feat/1-parent',baseSha:sourceSha,headSha:sourceSha,stage:'implement',harness:'codex',model:'fixture-model',effort:'high',execution,runtimeBinding:binding,configurationDigest,approvalBindings:[authority],recordBinding:authority,approvalRefs:parentArtifacts,policyDigest:snapshot.policyDigest,claimToken:randomUUID(),startedAt:new Date().toISOString(),taskKey:{repo:'acme/app',issue:1,taskId:'1-T1',scopeDigest:parentScope},approvedTaskIds:['1-T1'],activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:account.accountRef,waitReason:null,hostBindingDigest:host,machine,sharedClaim:null,checkpoint:null,checkpointIntent:parentIntent,remoteEffectCoverage:{kind:'qualified-managed-only',qualification:execution.qualification},authorityRequest:parentRequest,handbackIntent:{id:'run-handback',approvalBindings:[authority]},dispatchRequest:{commentId:null,reactionId:null}})
    const target:import('../src/shared-claims.ts').CoordinationTarget={host:'github.com',repository:'acme/room',repositoryId:'R_room',branch:'factory-state',rootCommit:coordRoot,installationId:coordinationInstallation,localRoot:join(home,'.vegastack','coordination'),provider:{branch:async()=>({id:'REF_state',head:stateHead,repositoryId:'R_room',private:true,defaultBranch:'main'}),read:async(_t,at,path)=>versions.get(at)?.[path]??null,compare:async(_t,base,next)=>base===next?'identical':stateHistory.indexOf(base)>=0&&stateHistory.indexOf(base)<stateHistory.indexOf(next)?'ahead':'diverged',commit:async(_t,input)=>{if(input.expectedHeadOid!==stateHead)return{kind:'conflict',reason:'changed'};const next={...versions.get(stateHead)!};for(const[path,body]of Object.entries(input.files))next[path]=body;stateHead=crypto.createHash('sha1').update(String(++stateSequence)).digest('hex');versions.set(stateHead,next);stateHistory.push(stateHead);return{kind:'committed',head:stateHead}}},verifyCandidate:async()=>{},verifyTransition:async()=>{},verifyEvidence:async()=>{},random:()=>0},effectiveMachine={id:'box',installationId:machineInstallation,hostBindingDigest:host,executionLogin:'robot',group:'dev',enabled:true,allowedRepositories:['acme/app'],repositoryIds:{'acme/app':'R_app'},policyDigest:snapshot.policyDigest,coordination:{repositoryId:'R_room',repository:'acme/room',branch:'factory-state',rootCommit:coordRoot,installationId:coordinationInstallation},defaults:{maxRuns:1,childConcurrent:1,checkpoints:'task-branch' as const,recovery:'verified-transfer' as const}},session={target,localRoot:target.localRoot,machineId:'box',installationId:machineInstallation,sessionId:machine.sessionId,hostBindingDigest:host,bootIdDigest:'d'.repeat(64),identity:await processIdentity()}
    const candidate={host:'github.com',repo:'acme/app',issue:1,repositoryNodeId:'R_app',issueNodeId:'I_1',scopeDigest:parentScope,approvalDigest:wire.sha256(wire.canonical([authority])),approvalBindings:[authority],runId:parent.runId,stage:'implement',paths:[],resources:[],independent:false,parentTaskKey:null,approvedTaskIds:['1-T1']},acquired=await wire.acquireSharedTask({machine:effectiveMachine,session,candidate,operationId:parent.claimOperationId!});if(acquired.kind!=='owned')throw Error(acquired.reason)
    const recovery={schemaVersion:2 as const,taskKey:acquired.claim.taskKey,runId:parent.runId,generation:acquired.claim.generation,approvalBindings:[authority],recordBinding:authority,scopeDigest:parentScope,approvalDigest:candidate.approvalDigest,execution,checkpoint:null,completed:[],children:[],joins:[],effects:[],remoteEffectCoverage:{kind:'qualified-managed-only' as const,qualification:execution.qualification}},linked=await wire.transitionSharedTask({claim:acquired.claim,operationId:parent.attemptOperationIds!.recovery,transition:{kind:'recovery',recovery}});if(linked.kind!=='owned')throw Error(linked.reason);const started=await wire.transitionSharedTask({claim:linked.claim,operationId:parent.attemptOperationIds!.start,transition:{kind:'start'}});if(started.kind!=='owned')throw Error(started.reason)
    parent=await runtime.updateRun(runsRoot(home),parent.runId,()=>({sharedClaim:{taskKey:started.claim.taskKey,generation:started.claim.generation,ownerToken:started.claim.ownerToken,stateCommit:started.claim.stateCommit}}));const identity=await processIdentity();parent=await runtime.transitionRun(parent.runId,parent.generation,{state:'running',processIdentity:identity,pid:identity.pid,processStartId:identity.startId,processGroupId:identity.pid},runsRoot(home))
    const groupsFile=join(home,'groups.json');await fs.writeFile(groupsFile,JSON.stringify(groups));const command=(verb:'run'|'join')=>['node',join(packaged,'dist','index.js'),'children',verb,'--parent','1','--groups',groupsFile,'--repo','acme/app','--config',join(home,'.vegastack','factory.json'),'--write','--json']
    const cli=async(verb:'run'|'join')=>{const child=Bun.spawn(command(verb),{cwd:tree,env:{...env,VSK_RUN_ID:parent.runId},stdout:'pipe',stderr:'pipe'}),stdout=await new Response(child.stdout).text(),stderr=await new Response(child.stderr).text(),exit=await child.exited;let result:any;try{result=JSON.parse(stdout.trim().split('\n').at(-1)!)}catch{throw Error(stdout+stderr)}return{exit,result,stderr}}
    const addReview=async(head:string)=>{childPlanComment.body=childPlan.replace('- [ ]','- [x]');childComments.push({...baseComment,id:82,node_id:'REVIEW_8',issue_url:'https://api.github.com/repos/acme/app/issues/8',body:`<!-- vsk:v1 type=review sha=${head} verdict=clean agent=codex -->\n\`\`\`json\n${JSON.stringify({reviewBinding:{sha:head,baseSha:sourceSha,scopeDigest:childArtifacts.find(row=>row.kind==='plan')!.digest,verdict:'clean',findings:[]}})}\n\`\`\`\n`})}
    const diagnose=async()=>{const plan=launch.buildLaunchPlan({harness:'codex',model:'fixture-model',effort:'high',stage:'implement',worktree:plannedChild.path,issue:{number:8,title:'child'},operator:'robot',outcome:'Complete the approved child scope. Only these paths are owned: requested.txt. Commit the result and leave integration to the parent CLI.',stopList:[],resume:false,skillPath:null,subagents:config.subagents}),actualMetadata=await dispatch.inspectManagedHarness(plan),actualAccount=await launch.inspectSubscription(plan);let evidence='ok';try{await runtime.verifyInstalledRuntimeBinding(binding,packaged,join(packaged,'dist','index.js'));const inspected=await dispatch.verifiedSharedTarget('acme/app',config),reader={...inspected,verifyEvidence:async(ref:any,payload:any)=>{if(wire.canonical(ref)!==wire.canonical(execution.qualification))throw Error('ref differs');runtime.verifyExecutionQualification(payload,execution,binding,configurationDigest)}};await wire.resolveEvidence(reader,execution.qualification)}catch(error){evidence=(error as Error).message}return{seed:configurationDigest,actual:await runtime.executionConfigurationDigest({binding,execution:{...execution,accountRef:actualAccount.accountRef},plan,metadata:actualMetadata,nodeVersion}),seedMetadata:metadata,actualMetadata,seedAccount:account.accountRef,actualAccount:actualAccount.accountRef,evidence,qualified:await runtime.readQualifiedExecutions(runsRoot(home))}}
    const cleanup=async()=>{server?.stop(true);for(const[key,value]of Object.entries(oldEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value}await rm(home,{recursive:true,force:true})}
    return{home,tree,remote,sourceSha,plannedChild,parent,cli,addReview,diagnose,cleanup,get vendorEntries(){try{return require('node:fs').readFileSync(vendor,'utf8').trim().split('\n').filter(Boolean)}catch{return[]}},get publicWrites(){return publicWrites}}
  }catch(error){server?.stop(true);for(const[key,value]of Object.entries(oldEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value}await rm(home,{recursive:true,force:true});throw error}
}

async function realProgressedSuccessionFixture(){
  const owner=await import('../src/shared-claims.ts'),{processIdentity}=await import('../src/claims.ts'),home=await realpath(await mkdtemp(join(tmpdir(),'child-succession-real-'))),repo=join(home,'repo'),digest='d'.repeat(64),installation=randomUUID()
  const checks=join(home,'checks'),vendors=join(home,'vendors')
  await mkdir(join(repo,'.vegastack'),{recursive:true});await writeFile(join(repo,'.vegastack','dev.md'),`repo: acme/app · default branch main\noperators: robot\ncommands: check \`echo check >> ${checks}\`\nimplement: codex fixture high\n`);await writeFile(join(repo,'base.txt'),'base\n');git(repo,'init','-b','task/1');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@example.invalid');git(repo,'add','.');git(repo,'commit','-m','base');const rootSha=git(repo,'rev-parse','HEAD'),rootTree=git(repo,'rev-parse','HEAD^{tree}')
  let head=rootSha,sequence=1;const versions=new Map([[head,{'coordination/index.json':owner.canonical({schemaVersion:1,installationId:installation,revision:0,active:[],machines:[]})} as Record<string,string>]]),order=[head]
  const target:import('../src/shared-claims.ts').CoordinationTarget={host:'github.com',repository:'acme/control',repositoryId:'R_state',branch:'factory-state',rootCommit:rootSha,installationId:installation,localRoot:join(home,'coordination'),provider:{branch:async()=>({id:'REF',head,repositoryId:'R_state',private:true,defaultBranch:'main'}),read:async(_t,at,path)=>versions.get(at)?.[path]??null,compare:async(_t,base,next)=>base===next?'identical':order.indexOf(base)>=0&&order.indexOf(base)<order.indexOf(next)?'ahead':'diverged',commit:async(_t,input)=>{if(input.expectedHeadOid!==head)return{kind:'conflict',reason:'changed'};head=(++sequence).toString(16).padStart(40,'0');versions.set(head,{...versions.get(input.expectedHeadOid),...input.files});order.push(head);return{kind:'committed',head}}},verifyCandidate:async()=>{},verifyTransition:async()=>{},verifyEvidence:async()=>{},verifyChildRelationship:async()=>({maxChildren:2}),verifyGroupSuccession:async()=>({maxChildren:2}),verifySession:async()=>{},random:()=>0}
  target.provider.history=async(_target,current)=>{const start=order.indexOf(current);return{commits:order.slice(0,start+1).reverse().map((oid,index)=>{const at=order.indexOf(oid),previous=at>0?versions.get(order[at-1]!):undefined,operation=Object.keys(versions.get(oid)??{}).find(path=>path.startsWith('coordination/operations/')&&!Object.hasOwn(previous??{},path))?.split('/').at(-1)?.replace('.json','');return{oid,parents:at>0?[order[at-1]!]:[],headline:operation?'factory coordination '+operation:'fixture root',committedAt:new Date(Date.now()-index).toISOString()}}),nextCursor:null}}
  const machine={id:'original',installationId:randomUUID(),hostBindingDigest:'a'.repeat(64),executionLogin:'robot',group:'dev',enabled:true,allowedRepositories:['acme/app'],repositoryIds:{'acme/app':'R_app'},policyDigest:digest,coordination:{repositoryId:'R_state',repository:'acme/control',branch:'factory-state',rootCommit:rootSha,installationId:installation},defaults:{maxRuns:1,childConcurrent:2,recovery:'verified-transfer' as const}},session={target,localRoot:join(home,'original'),machineId:machine.id,installationId:machine.installationId,sessionId:randomUUID(),hostBindingDigest:machine.hostBindingDigest,bootIdDigest:digest,identity:await processIdentity()}
  const approval=await import('../../../skills/dev/dev-implement/scripts/lib/approval.mjs'),parentBody='<!-- vsk:v1 type=brief rev=1 scope=quick-build -->\n## Outcome\nRecover children.\n',parentPlan='<!-- vsk:v1 type=plan rev=1 -->\n- [ ] **Task 1: parent** <!-- task-id:1-T1 -->\n  - Files — `src/child-0`, `src/child-1`\n  - Interfaces — children\n  - Steps: recover\n\n**Independent groups:**\n- `a` — #8 · Files: `src/child-0`\n- `b` — #9 · Files: `src/child-1`\n',issueRows=new Map<number,any>(),commentRows=new Map<number,any[]>()
  const parentIssue={number:1,node_id:'I_1',title:'feat: parent',body:parentBody,state:'open',labels:[],assignees:[]},parentPlanComment={id:11,node_id:'PLAN_1',body:parentPlan,user:{login:'robot'},updated_at:'2026-09-09T00:00:00Z',issue_url:'https://api.github.com/repos/acme/app/issues/1',html_url:'https://github.com/acme/app/issues/1#issuecomment-11'},parentArtifacts=[approval.artifactRef({repo:'acme/app',issue:1,kind:'brief',artifact:parentIssue}),approval.artifactRef({repo:'acme/app',issue:1,kind:'plan',artifact:parentPlanComment})]
  const childArtifacts=[8,9].map(issue=>{const body='<!-- vsk:v1 type=brief rev=1 scope=quick-build -->\n## Outcome\nChild.\n',plan='<!-- vsk:v1 type=plan rev=1 -->\n- [ ] **Task 1: child** <!-- task-id:'+issue+'-T1 -->\n  - Files — `src/child-'+(issue-8)+'`\n  - Interfaces — child\n  - Steps: finish\n',subject={number:issue,node_id:'I_'+issue,title:'feat: child '+issue,body,state:'open',labels:[],assignees:[]},comment={id:issue*10+1,node_id:'PLAN_'+issue,body:plan,user:{login:'robot'},updated_at:'2026-09-09T00:00:00Z',issue_url:'https://api.github.com/repos/acme/app/issues/'+issue,html_url:'https://github.com/acme/app/issues/'+issue+'#issuecomment-'+(issue*10+1)};issueRows.set(issue,subject);commentRows.set(issue,[comment]);return[approval.artifactRef({repo:'acme/app',issue,kind:'brief',artifact:subject}),approval.artifactRef({repo:'acme/app',issue,kind:'plan',artifact:comment})]})
  const parentIdentity={repo:'acme/app',issue:1,branch:'task/1',baseSha:rootSha},local={id:'local',kind:'local',repo:'acme/app',parentBranch:'task/1',operations:['edit','check','review','integrate']},selections=[{repo:'acme/app',issue:1,mode:'code',artifacts:parentArtifacts,taskIds:['1-T1'],actionIds:['local','parent-checkpoint']},...([8,9].map((issue,index)=>({repo:'acme/app',issue,mode:'code',artifacts:childArtifacts[index],taskIds:[issue+'-T1'],actionIds:['local','child-checkpoint-'+issue]})))],parentCheckpoint={id:'parent-checkpoint',kind:'checkpoint',repo:'acme/app',branch:'task/1',sourceScopeDigest:owner.sha256(owner.canonical({parent:parentIdentity,selections}))},childCheckpoints=[8,9].map((issue,index)=>({id:'child-checkpoint-'+issue,kind:'child-source-checkpoint',repo:'acme/app',parent:{issue:1,branch:'task/1',baseSha:rootSha},child:{issue,branch:'task/'+issue,ref:'refs/heads/task/'+issue,baseSha:rootSha,taskIds:[issue+'-T1'],paths:['src/child-'+index]}})),manifest={schemaVersion:1,parent:parentIdentity,codeIssues:[1,8,9],preparationTaskIds:[],candidateProtocols:[],excludedIssues:[],laterResearch:[],selections,actionBounds:{local,'parent-checkpoint':parentCheckpoint,...Object.fromEntries(childCheckpoints.map(row=>[row.id,row]))}},manifestBytes=JSON.stringify(manifest),event={schemaVersion:2,kind:'consolidated',id:'scope',operator:'robot',scope:'consolidated',source:{kind:'session',ref:'session:fixture',quote:'Approve exact recovery fixture.'},manifest:{},items:selections,actions:[local,parentCheckpoint,...childCheckpoints],supersedes:[],revokes:[]} as any
  event.manifest={sha256:owner.sha256(manifestBytes),source:{kind:'inline',utf8:manifestBytes}};const approvalBody='<!-- vsk:v1 type=approval scope=consolidated -->\n```json\n'+JSON.stringify(event)+'\n```\n',approvalComment={id:12,node_id:'APPROVAL_1',body:approvalBody,user:{login:'robot'},updated_at:'2026-09-09T00:00:00Z',issue_url:'https://api.github.com/repos/acme/app/issues/1',html_url:'https://github.com/acme/app/issues/1#issuecomment-12'};issueRows.set(1,parentIssue);commentRows.set(1,[parentPlanComment,approvalComment])
  const gh=async(args:string[])=>{const endpoint=(args.find(arg=>arg==='graphql'||arg.startsWith('repos/'))??'').split('?')[0]!;let value:unknown;if(endpoint==='graphql')value={data:{node:{id:'I_1',number:1,repository:{id:'R_app',nameWithOwner:'acme/app'}}}};else if(endpoint==='repos/acme/app')value={node_id:'R_app',full_name:'acme/app',private:true,default_branch:'main'};else if(endpoint==='repos/acme/app/issues/comments/12')value=approvalComment;else if(endpoint.endsWith('/dependencies/blocked_by'))value=[];else{const history=/issues\/(\d+)\/comments$/.exec(endpoint),subject=/issues\/(\d+)$/.exec(endpoint);if(history)value=commentRows.get(Number(history[1]));else if(subject)value=issueRows.get(Number(subject[1]));else throw Error('unexpected recovery endpoint '+endpoint)}if(value===undefined)throw Error('missing recovery endpoint '+endpoint);return (args.includes('--include')?'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n':'')+JSON.stringify(value)}
  const {parseFactoryConfig}=await import('../src/config.ts'),config=parseFactoryConfig({repos:[{repo:'acme/app',org:'acme',path:repo}]},home)
  const authority={approvalId:'scope',source:{kind:'github-comment' as const,repositoryId:'R_app',issueNodeId:'I_1',commentId:'12',bodySha256:owner.sha256(approvalBody)}},approvalDigest=owner.sha256(owner.canonical([authority])),parentCandidate={host:'github.com',repo:'acme/app',issue:1,repositoryNodeId:'R_app',issueNodeId:'I_1',scopeDigest:owner.sha256(owner.canonical({artifacts:parentArtifacts,taskIds:['1-T1']})),approvalDigest,approvalBindings:[authority],runId:randomUUID(),stage:'implement',paths:[],resources:[],independent:false,parentTaskKey:null,approvedTaskIds:['1-T1']}
  const parentOwned=await owner.acquireSharedTask({machine,session,candidate:parentCandidate,operationId:randomUUID()});if(parentOwned.kind!=='owned')throw Error(parentOwned.reason);const parentStarted=await owner.transitionSharedTask({claim:parentOwned.claim,operationId:randomUUID(),transition:{kind:'start'}});if(parentStarted.kind!=='owned')throw Error(parentStarted.reason);const originalParent={taskKey:parentStarted.claim.taskKey,runId:parentStarted.claim.runId,generation:parentStarted.claim.generation,ownerToken:parentStarted.claim.ownerToken,machineId:parentStarted.claim.machineId,installationId:parentStarted.claim.installationId,sessionId:parentStarted.claim.sessionId}
  const childCandidates=[8,9].map((issue,index)=>({...parentCandidate,issue,issueNodeId:'I_'+issue,scopeDigest:owner.sha256(owner.canonical({artifacts:childArtifacts[index],taskIds:[issue+'-T1']})),runId:randomUUID(),paths:['src/child-'+index],independent:true,parentTaskKey:originalParent.taskKey,parentBinding:originalParent,approvedTaskIds:[issue+'-T1']})),childClaims=[] as import('../src/shared-claims.ts').SharedClaim[]
  for(const candidate of childCandidates){const acquired=await owner.acquireSharedTask({machine,session,candidate,operationId:randomUUID()});if(acquired.kind!=='owned')throw Error(acquired.reason);childClaims.push(acquired.claim)}
  const prepared=[] as Array<{candidate:typeof childCandidates[number]|typeof parentCandidate;claim:import('../src/shared-claims.ts').SharedClaim;checkpoint:any;recovery:any}>
  for(const [candidate,claim] of [[parentCandidate,parentStarted.claim],...childCandidates.map((candidate,index)=>[candidate,childClaims[index]!] as const)] as const){const qualified=await owner.publishRecoveryReceipt({claim,operationId:randomUUID(),payload:{schemaVersion:2,kind:'execution-qualification',harness:'codex',harnessVersion:'fixture',model:'model',effort:'high',accountRef:'account',configurationDigest:digest,candidateSha:rootSha,validationIds:[candidate.approvedTaskIds[0]+'/check/'+digest],managedKinds:['checkpoint-push','handback','evidence','telemetry-push'],unmanagedDenied:true,result:'qualified'}}),checkpoint={schemaVersion:1 as const,id:randomUUID(),repo:'acme/app',repositoryId:'R_app',branch:'task/'+candidate.issue,baseSha:rootSha,headSha:rootSha,treeSha:rootTree,scopeDigest:candidate.scopeDigest,runId:claim.runId,publishedAt:new Date().toISOString()},recovery={schemaVersion:2 as const,taskKey:claim.taskKey,runId:claim.runId,generation:claim.generation,approvalBindings:[authority],recordBinding:null,scopeDigest:candidate.scopeDigest,approvalDigest,execution:{providerMode:'subscription' as const,harness:'codex' as const,harnessVersion:'fixture',model:'model',effort:'high',accountRef:'account',qualification:qualified.reference},checkpoint,completed:[],children:[],joins:[],effects:[],remoteEffectCoverage:{kind:'qualified-managed-only' as const,qualification:qualified.reference}};const saved=await owner.transitionSharedTask({claim,operationId:randomUUID(),transition:{kind:'checkpoint',checkpoint,recovery}});if(saved.kind!=='owned')throw Error(saved.reason);prepared.push({candidate,claim:saved.claim,checkpoint,recovery})}
  const childA=prepared[1]!,acceptancePayload={schemaVersion:2 as const,kind:'acceptance' as const,taskId:'8-T1',runId:childA.claim.runId,sourceSha:rootSha,scopeDigest:childA.candidate.scopeDigest,validationId:'8-T1/check/'+digest,commandDigest:digest,result:'passed' as const,acceptedScope:null},childAccepted=await owner.publishRecoveryReceipt({claim:prepared[0]!.claim,operationId:randomUUID(),payload:acceptancePayload}),joinOperation=randomUUID(),joinPayload={schemaVersion:2 as const,kind:'join' as const,childRunId:childA.claim.runId,generation:childA.claim.generation,fromSha:rootSha,parentBefore:rootSha,parentAfter:rootSha,state:'accepted' as const,validationId:'1-T1/check/'+digest,commandDigest:digest,result:'passed' as const},joinEvidence=await owner.publishRecoveryReceipt({claim:childAccepted.claim,operationId:randomUUID(),payload:joinPayload}),parentAccepted=await owner.publishRecoveryReceipt({claim:joinEvidence.claim,operationId:randomUUID(),payload:{...acceptancePayload,taskId:'1-T1',runId:parentStarted.claim.runId,scopeDigest:parentCandidate.scopeDigest,validationId:'1-T1/check/'+digest}})
  const parentRecovery={...prepared[0]!.recovery,children:[{childTaskKey:childA.claim.taskKey,childRunId:childA.claim.runId,generation:childA.claim.generation,baseSha:rootSha,headSha:rootSha,scopeDigest:childA.candidate.scopeDigest,machineId:childA.claim.machineId,installationId:childA.claim.installationId,sessionId:childA.claim.sessionId,terminationCause:'succeeded' as const,noChange:true,checkpoint:childA.checkpoint,acceptance:{sourceSha:rootSha,validationId:acceptancePayload.validationId,commandDigest:digest,evidence:childAccepted.reference}}],joins:[{operationId:joinOperation,childRunId:childA.claim.runId,generation:childA.claim.generation,fromSha:rootSha,parentBefore:rootSha,parentAfter:rootSha,state:'accepted' as const,acceptance:{sourceSha:rootSha,validationId:'1-T1/check/'+digest,commandDigest:digest,evidence:parentAccepted.reference},evidence:joinEvidence.reference}]} as import('../src/shared-claims.ts').RecoveryEnvelope,parentLinked=await owner.transitionSharedTask({claim:parentAccepted.claim,operationId:randomUUID(),transition:{kind:'recovery',recovery:parentRecovery}});if(parentLinked.kind!=='owned')throw Error(parentLinked.reason);prepared[0]!.claim=parentLinked.claim;prepared[0]!.recovery=parentRecovery
  for(const row of prepared){const attested=await owner.publishRecoveryReceipt({claim:row.claim,operationId:randomUUID(),payload:{schemaVersion:2,kind:'effect-reconciliation',runId:row.claim.runId,scopeDigest:row.candidate.scopeDigest,approvalBindings:[authority],allowedActionIds:[],checkedEffectIds:[],inspector:{kind:'qualified-adapter',identityRef:machine.id},result:'unresolved',reasonCode:'owned-process-group-stopped'}}),proof={kind:'operator-confirmed' as const,machineId:attested.claim.machineId,installationId:attested.claim.installationId,sessionId:attested.claim.sessionId,hostBindingDigest:machine.hostBindingDigest,bootIdDigest:digest,runIds:[attested.claim.runId],generation:attested.claim.generation,observedAt:new Date().toISOString(),evidenceRef:attested.reference},stopped=await owner.transitionSharedTask({claim:attested.claim,operationId:randomUUID(),transition:{kind:'stop',stopProof:proof}});if(stopped.kind!=='owned')throw Error(stopped.reason);row.claim=stopped.claim}
  const receiver={...machine,id:'receiver',installationId:randomUUID(),hostBindingDigest:'b'.repeat(64),defaults:{...machine.defaults,childConcurrent:1}},receiverSession={...session,machineId:receiver.id,installationId:receiver.installationId,sessionId:randomUUID(),hostBindingDigest:receiver.hostBindingDigest,localRoot:join(home,'receiver')},before=await owner.readCoordination(target),request={schemaVersion:1 as const,kind:'recover-stopped-group' as const,operationId:randomUUID(),expectedHead:before.head,parentTaskKey:parentStarted.claim.taskKey,groupPlan:{repo:'acme/app',issue:1,kind:'plan' as const,artifactId:'PLAN_1',rev:1,digest:parentArtifacts.find(row=>row.kind==='plan')!.digest},groupsDigest:'e'.repeat(64),members:prepared.map(row=>({expected:{taskKey:row.claim.taskKey,runId:row.claim.runId,generation:row.claim.generation,ownerToken:row.claim.ownerToken,machineId:row.claim.machineId,installationId:row.claim.installationId,sessionId:row.claim.sessionId},candidate:row.candidate})).sort((a,b)=>a.expected.taskKey.localeCompare(b.expected.taskKey))},recovered=await owner.recoverStoppedGroup({machine:receiver,session:receiverSession,request});if(recovered.kind!=='owned')throw Error(recovered.reason)
  const dispatch=await import('../src/dispatch.ts'),material=await dispatch.inspectRemoteRecovery({repo:'acme/app',taskKey:recovered.parent.taskKey,config},{target,gh,source:{repository:async()=>({node_id:'R_app'}),fetch:async()=>{}}});if(material.blocks.length)throw Error('fixture recovery blocked: '+material.blocks.join('; '));dispatch.assertRemoteRecoveryMaterial(material)
  const runningParent=await owner.transitionSharedTask({claim:recovered.parent,operationId:randomUUID(),transition:{kind:'start'}});if(runningParent.kind!=='owned')throw Error(runningParent.reason);const runningA=await owner.transitionSharedTask({claim:recovered.children.find(row=>row.runId===childA.claim.runId)!,operationId:randomUUID(),transition:{kind:'start'}});if(runningA.kind!=='owned')throw Error(runningA.reason);const stoppedAProof={kind:'operator-confirmed' as const,machineId:runningA.claim.machineId,installationId:runningA.claim.installationId,sessionId:runningA.claim.sessionId,hostBindingDigest:receiver.hostBindingDigest,bootIdDigest:digest,runIds:[runningA.claim.runId],generation:runningA.claim.generation,observedAt:new Date().toISOString(),evidenceRef:authority.source},stoppedA=await owner.transitionSharedTask({claim:runningA.claim,operationId:randomUUID(),transition:{kind:'stop',stopProof:stoppedAProof}});if(stoppedA.kind!=='owned')throw Error(stoppedA.reason)
  const later={...receiver,id:'later',installationId:randomUUID(),hostBindingDigest:'c'.repeat(64)},laterSession={...receiverSession,machineId:later.id,installationId:later.installationId,sessionId:randomUUID(),hostBindingDigest:later.hostBindingDigest,localRoot:join(home,'later')},handoff=await owner.transitionSharedTask({claim:stoppedA.claim,operationId:randomUUID(),transition:{kind:'handoff',machine:later,session:laterSession,candidate:childA.candidate,stopProof:stoppedAProof,recovery:{...childA.recovery,generation:stoppedA.claim.generation}}});if(handoff.kind!=='owned')throw Error(handoff.reason)
  const parentBinding={taskKey:runningParent.claim.taskKey,runId:runningParent.claim.runId,generation:runningParent.claim.generation,ownerToken:runningParent.claim.ownerToken,machineId:runningParent.claim.machineId,installationId:runningParent.claim.installationId,sessionId:runningParent.claim.sessionId},inspection=await owner.inspectGroupSuccession(target,{operationId:request.operationId,parent:parentBinding})
  const mutateCurrentTask=(taskKey:string,change:(task:any)=>any)=>{const path='coordination/tasks/'+taskKey+'.json',files=versions.get(head)!,before=files[path]!;files[path]=owner.canonical(change(JSON.parse(before)));return()=>{files[path]=before}}
  return{home,repo,checks,vendors,owner,target,gh,config,dispatch,material,runningParent:runningParent.claim,laterChild:handoff.claim,unfinishedChild:recovered.children.find(row=>row.runId===childClaims[1]!.runId)!,inspection,parentRecovery,acceptedRunId:childA.claim.runId,unfinishedRunId:childClaims[1]!.runId,rootSha,rootTree,receiver,later,childArtifacts,mutateCurrentTask,cleanup:()=>rm(home,{recursive:true,force:true})}
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

test('legacy v1 launch remains readable evidence but cannot authorize a new relationship without shared provenance', async () => {
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
    expect((await (await import('../src/children.ts')).readChildrenRecord(runsRoot(f.home),parent.runId)).schemaVersion).toBe(1)
    await expect(verifyChildRelationship({parent:parentTask,child:childTask},config)).rejects.toThrow('v1 child original shared parent facts unavailable')
  } finally { ghSpy.mockRestore(); if(previousScript===undefined)delete process.env.VSK_PREFLIGHT_SCRIPT;else process.env.VSK_PREFLIGHT_SCRIPT=previousScript;await rm(f.home,{recursive:true,force:true}) }
},30000)

test('verified v1 child launch preserves exact original bytes before atomic v2 upgrade',async()=>{
  const {spyOn}=await import('bun:test'),dispatch=await import('../src/dispatch.ts'),wire=await import('../src/shared-claims.ts'),runtime=await import('../src/runs.ts')
  const {readExecutableChildrenRecord}=await import('../src/children.ts'),{parseFactoryConfig}=await import('../src/config.ts')
  const home=await realpath(await mkdtemp(join(tmpdir(),'children-v1-upgrade-'))),tree=join(home,'repo');await mkdir(tree,{recursive:true})
  git(tree,'init','-b','feat/parent');git(tree,'config','user.name','Fixture');git(tree,'config','user.email','fixture@example.invalid');await writeFile(join(tree,'base.txt'),'base\n');git(tree,'add','.');git(tree,'commit','-m','base')
  const base=git(tree,'rev-parse','HEAD'),root=runsRoot(home),authority={approvalId:'scope',source:{kind:'github-comment' as const,repositoryId:'R_repo',issueNodeId:'I_8',commentId:'12',bodySha256:'a'.repeat(64)}}
  const parent=await createRun(diagnostic(root,tree,1,base)),machine={id:'machine',installationId:randomUUID(),sessionId:randomUUID(),hostBindingDigest:'b'.repeat(64)}
  const child=await createRun({...diagnostic(root,tree,8,base),parent:1,branch:'feat/8-child',harness:'codex',model:'fixture',effort:'high',execution:{providerMode:'subscription',harness:'codex',harnessVersion:'fixture',model:'fixture',effort:'high',accountRef:'fixture',qualification:authority.source},approvalBindings:[authority],recordBinding:authority,approvalRefs:[{repo:'fixture/repo',issue:8,kind:'brief',artifactId:'I_8',rev:1,digest:'c'.repeat(64)},{repo:'fixture/repo',issue:8,kind:'plan',artifactId:'P_8',rev:1,digest:'d'.repeat(64)}],policyDigest:'e'.repeat(64),accountRef:'fixture',machine,sharedClaim:{taskKey:'f'.repeat(64),generation:1,ownerToken:randomUUID(),stateCommit:'1'.repeat(40)}})
  const original={taskKey:'9'.repeat(64),runId:parent.runId,generation:1,ownerToken:randomUUID(),machineId:'old-parent',installationId:randomUUID(),sessionId:randomUUID()}
  const launch={schemaVersion:1,parentRunId:parent.runId,parentIssue:1,repo:'fixture/repo',parentBranch:'feat/parent',baseSha:base,parentBinding:original,concurrency:1,groups:[{id:'g',members:['#8'],files:['requested.txt']}],children:[{group:'g',issue:8,title:'child',type:'feat',branch:'feat/8-child',path:tree,files:['requested.txt'],resources:[],baseSha:base,runId:child.runId,scopeDigest:child.taskKey.scopeDigest,taskIds:['8-T1'],acceptanceCommand:'true'}]}
  await runtime.atomicRunFile(join(root,parent.runId,'children.json'),launch);const raw=await readFile(join(root,parent.runId,'children.json'),'utf8')
  const childBinding={...original,taskKey:original.taskKey},claim={taskKey:child.sharedClaim!.taskKey,generation:1,ownerToken:child.sharedClaim!.ownerToken,machineId:machine.id,installationId:machine.installationId,sessionId:machine.sessionId,runId:child.runId,stateCommit:'1'.repeat(40),target:{}}
  const task={schemaVersion:1,host:'github.com',repo:'fixture/repo',issue:8,repositoryNodeId:'R_repo',issueNodeId:'I_8',scopeDigest:child.taskKey.scopeDigest,approvalDigest:'a'.repeat(64),approvalBindings:[authority],generation:1,machineId:machine.id,installationId:machine.installationId,sessionId:machine.sessionId,ownerToken:claim.ownerToken,runId:child.runId,stage:'implement',state:'claimed',paths:['requested.txt'],resources:[],independent:true,parentTaskKey:original.taskKey,parentBinding:childBinding,approvedTaskIds:['8-T1'],checkpoint:null,stopProof:null,unresolvedEffects:[],recovery:null,acceptedScopes:[],taskKey:claim.taskKey} as import('../src/shared-claims.ts').TaskRecord
  const shared=spyOn(dispatch,'sharedClaimForRun').mockResolvedValue(claim as any),coordination=spyOn(wire,'readCoordination').mockResolvedValue({tasks:{[claim.taskKey]:task}} as any)
  try{
    const upgraded=await readExecutableChildrenRecord(parent,parseFactoryConfig({repos:[{repo:'fixture/repo',org:'fixture',path:tree}]},home))
    expect(upgraded.schemaVersion).toBe(2);expect(upgraded.children[0]!.parentBinding).toEqual(childBinding)
    const archived=JSON.parse(await readFile(join(root,parent.runId,'children-v1-'+createHash('sha256').update(raw).digest('hex')+'.json'),'utf8'))
    expect(archived).toEqual({schemaVersion:1,kind:'children-v1-original',sha256:createHash('sha256').update(raw).digest('hex'),bytes:raw})
  }finally{shared.mockRestore();coordination.mockRestore();await rm(home,{recursive:true,force:true})}
})

test('changed coordinator is accepted only through the exact current group succession receipt',async()=>{
  const {spyOn}=await import('bun:test'),dispatch=await import('../src/dispatch.ts'),wire=await import('../src/shared-claims.ts'),runtime=await import('../src/runs.ts')
  const {executeChildren}=await import('../src/children.ts'),{parseFactoryConfig}=await import('../src/config.ts')
  const home=await realpath(await mkdtemp(join(tmpdir(),'children-succession-'))),tree=join(home,'repo');await mkdir(tree,{recursive:true})
  git(tree,'init','-b','feat/parent');git(tree,'config','user.name','Fixture');git(tree,'config','user.email','fixture@example.invalid');await writeFile(join(tree,'base.txt'),'base\n');git(tree,'add','.');git(tree,'commit','-m','base')
  const base=git(tree,'rev-parse','HEAD'),parent=await createRun(diagnostic(runsRoot(home),tree,1,base)),groups={guard:'plan-lint',ok:true,groups:[{id:'g',members:['#8'],files:['requested.txt']}]}
  const original={taskKey:'a'.repeat(64),runId:parent.runId,generation:1,ownerToken:randomUUID(),machineId:'old',installationId:randomUUID(),sessionId:randomUUID()},current={...original,generation:2,ownerToken:randomUUID(),machineId:'new',installationId:randomUUID(),sessionId:randomUUID()}
  const operationId=randomUUID(),claim={...current,stateCommit:'2'.repeat(40),target:{}},task={schemaVersion:2,taskKey:current.taskKey,runId:current.runId,generation:current.generation,ownerToken:current.ownerToken,machineId:current.machineId,installationId:current.installationId,sessionId:current.sessionId,parentTaskKey:null,state:'running',stopProof:null,successionOperationId:operationId}
  const launch={schemaVersion:2,parentRunId:parent.runId,parentIssue:1,repo:'fixture/repo',parentBranch:'feat/parent',baseSha:base,parentBinding:original,concurrency:1,groups:groups.groups,children:[{group:'g',issue:8,title:'child',type:'feat',branch:'feat/8-child',path:join(tree,'.vegastack/.worktrees/8-child'),files:['requested.txt'],resources:[],baseSha:base,runId:null,scopeDigest:null,taskIds:[],acceptanceCommand:'true',parentBinding:null}]}
  await runtime.atomicRunFile(join(runsRoot(home),parent.runId,'children.json'),launch)
  const shared=spyOn(dispatch,'sharedClaimForRun').mockResolvedValue(claim as any),coordination=spyOn(wire,'readCoordination').mockResolvedValue({tasks:{[current.taskKey]:task},index:{active:[{taskKey:current.taskKey}]}} as any),succession=spyOn(wire,'inspectGroupSuccession').mockResolvedValue({kind:'verified',reference:{kind:'state-receipt',operationId,commitSha:'2'.repeat(40),blobSha256:'d'.repeat(64)},receipt:{members:[{before:original,after:current}]},currentMembers:[{initial:{...task,successionOperationId:operationId},current:task}]} as any)
  const config=parseFactoryConfig({repos:[{repo:'fixture/repo',org:'fixture',path:tree}]},home)
  try{
    const preview=await executeChildren({parent,groups,config},{groups:async()=>groups.groups})
    expect(preview.plan.parentBinding).toEqual(original);expect(succession).toHaveBeenCalled()
    succession.mockResolvedValue({kind:'invalid-or-unavailable',reason:'group succession could not be verified'})
    await expect(executeChildren({parent,groups,config},{groups:async()=>groups.groups})).rejects.toThrow('group succession')
  }finally{shared.mockRestore();coordination.mockRestore();succession.mockRestore();await rm(home,{recursive:true,force:true})}
})

test('real later child handoff preserves accepted join history and schedules only unfinished work',async()=>{
  const f=await realProgressedSuccessionFixture(),{spyOn}=await import('bun:test'),gateway=await import('../src/children.ts'),runtime=await import('../src/runs.ts'),ghOwner=await import('../src/gh.ts'),{loadConfiguredPolicy}=await import('../src/control-room.ts')
  const previousPath=process.env.PATH
  let targetSpy:ReturnType<typeof spyOn>|null=null,claimSpy:ReturnType<typeof spyOn>|null=null,ghSpy:ReturnType<typeof spyOn>|null=null
  try{
    expect(f.inspection.kind).toBe('verified')
    if(f.inspection.kind!=='verified')throw Error(f.inspection.reason)
    const progressed=f.inspection.currentMembers.find(row=>row.initial.runId===f.acceptedRunId)!
    expect(progressed.current.generation).toBeGreaterThan(progressed.initial.generation)
    const result=gateway.reconcileProgressedChildren(f.inspection,f.parentRecovery)
    expect(result.accepted.map((row:any)=>row.childRunId)).toEqual([f.acceptedRunId]);expect(result.unfinished.map((row:any)=>row.runId)).toEqual([f.unfinishedRunId]);expect(result.unfinished.some((row:any)=>row.runId===f.acceptedRunId)).toBe(false)
    const policy=loadConfiguredPolicy({home:f.home,repo:'acme/app',devMd:await readFile(join(f.repo,'.vegastack','dev.md'),'utf8')});if(!policy.ok)throw Error('fixture policy unavailable')
    const root=runsRoot(f.home),runInput=(task:import('../src/shared-claims.ts').TaskRecord,checkout:string,parent:number|null,claim:import('../src/shared-claims.ts').SharedClaim,artifacts:any[],hostBindingDigest:string,authorityRequest:import('../src/runs.ts').RunAuthorityRequest):RunInput=>({root,runId:task.runId,repo:task.repo,issue:task.issue,parent,checkout,branch:task.checkpoint!.branch,baseSha:task.checkpoint!.baseSha,headSha:task.checkpoint!.headSha,stage:task.stage,harness:task.recovery!.execution.harness,model:task.recovery!.execution.model,effort:task.recovery!.execution.effort,execution:task.recovery!.execution,approvalBindings:task.approvalBindings,recordBinding:task.recovery!.recordBinding,approvalRefs:artifacts,policyDigest:policy.policy.policyDigest,claimToken:randomUUID(),startedAt:new Date().toISOString(),taskKey:{repo:task.repo,issue:task.issue,taskId:task.approvedTaskIds[0]!,scopeDigest:task.scopeDigest},approvedTaskIds:task.approvedTaskIds,activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:task.recovery!.execution.accountRef,waitReason:null,hostBindingDigest,machine:{id:task.machineId,installationId:task.installationId,sessionId:task.sessionId,hostBindingDigest},sharedClaim:{taskKey:claim.taskKey,generation:claim.generation,ownerToken:claim.ownerToken,stateCommit:claim.stateCommit},checkpoint:task.checkpoint,remoteEffectCoverage:task.recovery!.remoteEffectCoverage,authorityRequest})
    let parent=await runtime.createRun(runInput(f.material.task,f.repo,null,f.runningParent,f.material.artifacts,f.receiver.hostBindingDigest,f.material.authorityRequest))
    const originalBytes=f.owner.canonical(f.material.task),attemptId=parent.attemptId!
    parent={...parent,terminalSegment:{sequence:attemptId,firstAttemptId:attemptId},remoteRecovery:{kind:'receiving-home',requestId:randomUUID(),requestDigest:'9'.repeat(64),handoff:f.inspection.reference,originalStateCommit:f.material.stateCommit,stopProof:f.material.task.stopProof!,originalTask:{bytes:originalBytes,sha256:f.owner.sha256(originalBytes)},priorHistory:'unavailable',reportingContext:'unavailable'}}
    await runtime.atomicRunFile(join(root,parent.runId,'run.json'),parent);parent=await runtime.readRun(root,parent.runId)
    const identity=await (await import('../src/claims.ts')).processIdentity();parent=await runtime.transitionRun(parent.runId,parent.generation,{state:'running',processIdentity:identity,pid:identity.pid,processStartId:identity.startId,processGroupId:identity.pid},root)
    const reconstructed=await gateway.reconstructChildrenContext({parent,material:f.material,config:f.config},{target:f.target,gh:f.gh})
    await mkdir(join(f.repo,'.vegastack','.worktrees'),{recursive:true})
    const currentByRun=new Map(f.inspection.currentMembers.map(row=>[row.current.runId,row.current]))
    const claimsByRun=new Map<string,import('../src/shared-claims.ts').SharedClaim>([[parent.runId,{...f.runningParent,target:f.target}],[f.acceptedRunId,{...f.laterChild,target:f.target}],[f.unfinishedRunId,{...f.unfinishedChild,stateCommit:f.inspection.reference.commitSha,target:f.target}]])
    for(const existing of reconstructed.existing){const child=reconstructed.record.children.find(row=>row.runId===existing.task.runId)!,task=currentByRun.get(existing.task.runId)!;git(f.repo,'worktree','add','-b',task.checkpoint!.branch,child.path,f.rootSha);const host=task.machineId===f.later.id?f.later.hostBindingDigest:f.receiver.hostBindingDigest;await runtime.createRun(runInput(task,await realpath(child.path),1,claimsByRun.get(task.runId)!,f.childArtifacts[task.issue-8]!,host,{kind:'native'}))}
    targetSpy=spyOn(f.dispatch,'verifiedSharedTarget').mockResolvedValue(f.target as any)
    claimSpy=spyOn(f.dispatch,'sharedClaimForRun').mockImplementation(async run=>{const claim=claimsByRun.get(run.runId);if(!claim)throw Error('unexpected fixture run claim '+run.runId);return claim})
    ghSpy=spyOn(ghOwner,'ghText').mockImplementation(f.gh)
    const installed=await gateway.installRecoveredChildrenContext({parent,material:f.material,config:f.config}),reinstalled=await gateway.installRecoveredChildrenContext({parent,material:f.material,config:f.config})
    expect(reinstalled.record).toEqual(installed.record);expect(installed.newPreparations).toEqual([]);expect(installed.existing.map(row=>row.task.runId).sort()).toEqual([f.acceptedRunId,f.unfinishedRunId].sort())
    const actualGit=Bun.which('git')!,bin=join(f.home,'counting-bin'),merges=join(f.home,'merges');await mkdir(bin);await writeFile(merges,'');const gitWrapper=join(bin,'git');await writeFile(gitWrapper,`#!${process.execPath}\nconst{appendFileSync}=require('node:fs'),{spawnSync}=require('node:child_process');const a=process.argv.slice(2);if(a[0]==='merge')appendFileSync(${JSON.stringify(merges)},'merge\\n');const r=spawnSync(${JSON.stringify(actualGit)},a,{stdio:'inherit',env:process.env});process.exit(r.status??1);\n`);await (await import('node:fs/promises')).chmod(gitWrapper,0o755);process.env.PATH=bin+':'+previousPath
    const groups={guard:'plan-lint',ok:true,groups:installed.record.groups},parentHead=git(f.repo,'rev-parse','HEAD'),joinDeps={verifyAuthority:async()=>{},verifyParent:async()=>{}}
    const joined=await gateway.joinChildren({parent,groups,config:f.config,write:true},joinDeps),joinReplay=await gateway.joinChildren({parent,groups,config:f.config,write:true},joinDeps)
    expect(joined.receipts.map(row=>row.runId)).toEqual([f.acceptedRunId]);expect(joined.blocked.map(row=>row.issue)).toEqual([9]);expect(joinReplay.receipts).toEqual(joined.receipts);expect(git(f.repo,'rev-parse','HEAD')).toBe(parentHead);expect(await readFile(merges,'utf8')).toBe('')
    let starts=0
    const executionDeps:import('../src/children.ts').ChildrenDependencies={groups:async()=>installed.record.groups,verifyParent:async()=>{},verifyChild:async()=>{},processDeps:{wrapperPath:join(source,'run-wrapper.ts')},prepare:async child=>{if(child.runId!==f.unfinishedRunId)throw Error('accepted child reached preparation');const run=await runtime.readRun(root,child.runId);return{run,localClaim:null,plan:{command:process.execPath,args:['-e',`require('node:fs').appendFileSync(${JSON.stringify(f.vendors)},'vendor\\n')`],env:{},cwd:run.checkout,prompt:''}}},acquire:async child=>{if(child.runId!==f.unfinishedRunId)throw Error('accepted child reached admission');starts++;const started=await f.owner.transitionSharedTask({claim:claimsByRun.get(child.runId)!,operationId:randomUUID(),transition:{kind:'start'}});if(started.kind!=='owned')throw Error(started.reason);claimsByRun.set(child.runId,{...started.claim,target:f.target});return started.claim},finish:async(claim,run)=>{if(!claim)throw Error('unfinished child claim unavailable');const attested=await f.owner.publishRecoveryReceipt({claim,operationId:randomUUID(),payload:{schemaVersion:2,kind:'effect-reconciliation',runId:run.runId,scopeDigest:run.taskKey.scopeDigest,approvalBindings:run.approvalBindings,allowedActionIds:[],checkedEffectIds:[],inspector:{kind:'qualified-adapter',identityRef:f.receiver.id},result:'unresolved',reasonCode:'owned-process-group-stopped'}}),proof={kind:'process-exit' as const,machineId:f.receiver.id,installationId:f.receiver.installationId,sessionId:claim.sessionId,hostBindingDigest:f.receiver.hostBindingDigest,bootIdDigest:'d'.repeat(64),runIds:[run.runId],generation:claim.generation,observedAt:run.finishedAt!,evidenceRef:attested.reference},stopped=await f.owner.transitionSharedTask({claim:attested.claim,operationId:randomUUID(),transition:{kind:'stop',stopProof:proof}});if(stopped.kind!=='owned')throw Error(stopped.reason);claimsByRun.set(run.runId,{...stopped.claim,target:f.target})}}
    const executed=await gateway.executeChildren({parent,groups,config:f.config,write:true},executionDeps)
    expect(executed.blocked,JSON.stringify(executed.blocked)).toEqual([]);expect(executed.results.map(row=>row.runId)).toEqual([f.acceptedRunId,f.unfinishedRunId]);expect(starts).toBe(1)
    const executionReplay=await gateway.executeChildren({parent,groups,config:f.config,write:true},executionDeps);expect(executionReplay.results).toEqual(executed.results);expect(executionReplay.blocked,JSON.stringify(executionReplay.blocked)).toEqual([]);expect(starts).toBe(1)
    expect((await readFile(f.vendors,'utf8')).trim().split('\n')).toEqual(['vendor']);expect((await readFile(f.checks,'utf8')).trim().split('\n')).toEqual(['check']);expect(git(f.repo,'rev-parse','HEAD')).toBe(parentHead)
    const acceptedPath=join(root,f.acceptedRunId,'child-result.json'),accepted=JSON.parse(await readFile(acceptedPath,'utf8'));await runtime.atomicRunFile(acceptedPath,{...accepted,headSha:'f'.repeat(40)});const alteredAcceptance=await gateway.executeChildren({parent,groups,config:f.config,write:true},executionDeps);expect(alteredAcceptance.blocked.find(row=>row.issue===8)?.reason).toContain('retained accepted child result differs');await runtime.atomicRunFile(acceptedPath,accepted)
    const joinPath=join(root,parent.runId,'join-'+f.acceptedRunId+'.json'),retainedJoin=JSON.parse(await readFile(joinPath,'utf8'));await runtime.atomicRunFile(joinPath,{...retainedJoin,issue:99});const alteredJoin=await gateway.joinChildren({parent,groups,config:f.config,write:true},joinDeps);expect(alteredJoin.blocked[0]?.reason).toContain('historical accepted join identity differs');await runtime.atomicRunFile(joinPath,retainedJoin)
    const restoreTask=f.mutateCurrentTask(progressed.current.taskKey,task=>({...task,machineId:'altered-member'}));await expect(gateway.executeChildren({parent,groups,config:f.config,write:true},executionDeps)).rejects.toThrow(/task\/index mismatch|group succession/);restoreTask()
    const alteredRecovery=structuredClone(f.parentRecovery);alteredRecovery.children[0]!.acceptance.sourceSha='f'.repeat(40);expect(()=>gateway.reconcileProgressedChildren(f.inspection,alteredRecovery)).toThrow('identity differs');const alteredJoinRecovery=structuredClone(f.parentRecovery);alteredJoinRecovery.joins[0]!.fromSha='f'.repeat(40);expect(()=>gateway.reconcileProgressedChildren(f.inspection,alteredJoinRecovery)).toThrow('identity differs')
    expect((await readFile(f.vendors,'utf8')).trim().split('\n')).toEqual(['vendor']);expect((await readFile(f.checks,'utf8')).trim().split('\n')).toEqual(['check']);expect(await readFile(merges,'utf8')).toBe('');expect(git(f.repo,'rev-parse','HEAD')).toBe(parentHead)
  }finally{process.env.PATH=previousPath;targetSpy?.mockRestore();claimSpy?.mockRestore();ghSpy?.mockRestore();await f.cleanup()}
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

test('default packaged child gateway derives separate exact execution and checkpoint authority', async () => {
  const gatewayOwner = await import('../src/children.ts'), approval = await import('../../../skills/dev/dev-implement/scripts/lib/approval.mjs')
  const { parseFactoryConfig } = await import('../src/config.ts')
  const home=await realpath(await mkdtemp(join(tmpdir(),'default-child-authority-'))),tree=join(home,'repo')
  await mkdir(join(tree,'.vegastack'),{recursive:true})
  await writeFile(join(tree,'.vegastack/dev.md'),'repo: fixture/repo · default branch main\noperators: fixture\ncommands: check `true`\n')
  git(tree,'init','-b','feat/parent');git(tree,'config','user.name','Fixture');git(tree,'config','user.email','fixture@example.invalid');git(tree,'add','.');git(tree,'commit','-m','base')
  const base=git(tree,'rev-parse','HEAD'),brief='<!-- vsk:v1 type=brief rev=1 scope=quick-build -->\n## Outcome\nEdit requested.txt.\n'
  const plan='<!-- vsk:v1 type=plan rev=1 -->\n- [ ] **Task 1: edit** <!-- task-id:8-T1 -->\n  - Files — `requested.txt`\n  - Interfaces — exact child\n  - Steps: edit it\n'
  const issue={id:8,node_id:'I_8',number:8,title:'feat: child',body:brief,state:'open'},planComment={id:81,node_id:'PLAN_8',body:plan,user:{login:'fixture'}}
  const artifacts=[approval.artifactRef({repo:'fixture/repo',issue:8,kind:'brief',artifact:issue}),approval.artifactRef({repo:'fixture/repo',issue:8,kind:'plan',artifact:planComment})]
  const local={id:'local-child',kind:'local',repo:'fixture/repo',parentBranch:'feat/parent',operations:['edit','integrate']}
  const checkpoint={id:'checkpoint-child',kind:'child-source-checkpoint',repo:'fixture/repo',parent:{issue:1,branch:'feat/parent',baseSha:base},child:{issue:8,branch:'feat/8-child',ref:'refs/heads/feat/8-child',baseSha:base,taskIds:['8-T1'],paths:['requested.txt']}}
  const selected={repo:'fixture/repo',issue:8,mode:'code',artifacts,taskIds:['8-T1'],actionIds:[local.id,checkpoint.id]}
  const manifest={schemaVersion:1,parent:{repo:'fixture/repo',issue:1,branch:'feat/parent',baseSha:base},codeIssues:[8],preparationTaskIds:[],candidateProtocols:[],excludedIssues:[],laterResearch:[],selections:[selected],actionBounds:{[local.id]:local,[checkpoint.id]:checkpoint}}
  const manifestBytes=JSON.stringify(manifest),record={schemaVersion:2,kind:'consolidated',id:'parent-scope',operator:'fixture',scope:'consolidated',source:{kind:'session',ref:'session:fixture',quote:'Approve exact child fixture.'},manifest:{sha256:createHash('sha256').update(manifestBytes).digest('hex'),source:{kind:'inline',utf8:manifestBytes}},items:[selected],actions:[local,checkpoint],supersedes:[],revokes:[]}
  const approvalBody='<!-- vsk:v1 type=approval scope=consolidated -->\n```json\n'+JSON.stringify(record)+'\n```\n',approvalComment={id:12,node_id:'APPROVAL_1',body:approvalBody,user:{login:'fixture'}}
  const pages=new Map<string,unknown[]>([['repos/fixture/repo/issues/1/comments',[approvalComment]],['repos/fixture/repo/issues/8/comments',[planComment]],['repos/fixture/repo/issues/8/dependencies/blocked_by',[]]])
  const gh=async(args:string[])=>{const endpoint=(args[1]??'').split('?')[0]!,value=endpoint==='repos/fixture/repo/issues/8'?issue:pages.get(endpoint);if(value===undefined)throw Error('unexpected endpoint '+endpoint);return args.includes('--include')?'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(value):JSON.stringify(value)}
  const parent={...diagnostic(runsRoot(home),tree,1,base),runId:randomUUID(),schemaVersion:2,generation:1,state:'running',terminationCause:null,exitCode:null,pid:null,processStartId:null,processGroupId:null,processIdentity:null,finishedAt:null,pendingDelivery:[],authorityRequest:{kind:'consolidated' as const,parentRepo:'fixture/repo',parentIssue:1,approvalBinding:{commentId:12,bodySha256:createHash('sha256').update(approvalBody).digest('hex')},requested:{repo:'fixture/repo',issue:1,taskIds:['1-T1'],actionId:'local-child',branch:'feat/parent',baseSha:base,paths:['requested.txt'],operation:'edit' as const}}}
  const binding={taskKey:'a'.repeat(64),runId:parent.runId,generation:1,ownerToken:randomUUID(),machineId:'fixture',installationId:randomUUID(),sessionId:randomUUID()}
  const child={group:'g',issue:8,title:'child',type:'feat',branch:'feat/8-child',path:join(tree,'.vegastack/.worktrees/8-child'),files:['requested.txt'],resources:[],baseSha:base,runId:null,scopeDigest:null,taskIds:[],acceptanceCommand:'true',parentBinding:null}
  const children={schemaVersion:2 as const,parentRunId:parent.runId,parentIssue:1,repo:'fixture/repo',parentBranch:'feat/parent',baseSha:base,parentBinding:binding,concurrency:1,groups:[{id:'g',members:['#8'],files:['requested.txt']}],children:[child]}
  try {
    const derived=await gatewayOwner.deriveConsolidatedChildRequests(parent as any,child,children,parseFactoryConfig({repos:[{repo:'fixture/repo',org:'fixture',path:tree}]},home),{gh})
    expect(derived.executionRequest.requested).toEqual({repo:'fixture/repo',issue:8,taskIds:['8-T1'],actionId:'local-child',branch:'feat/parent',baseSha:base,paths:['requested.txt'],operation:'edit'})
    expect(derived.checkpointRequest.requested).toEqual({repo:'fixture/repo',issue:8,taskIds:['8-T1'],actionId:'checkpoint-child',branch:'feat/8-child',ref:'refs/heads/feat/8-child',baseSha:base,paths:['requested.txt'],operation:'checkpoint'})
    expect(derived.checked.bindings).toEqual(artifacts)
    const badInputs=[
      ['child branch',{child:{...child,branch:'feat/wrong'}}],
      ['child base',{child:{...child,baseSha:'f'.repeat(40)}}],
      ['child path',{child:{...child,files:['other.txt']}}],
      ['parent branch',{children:{...children,parentBranch:'feat/wrong'}}],
      ['parent base',{children:{...children,baseSha:'f'.repeat(40)}}],
      ['parent issue',{children:{...children,parentIssue:2}}],
      ['parent locator',{parent:{...parent,authorityRequest:{...parent.authorityRequest,parentIssue:2}}}],
    ] as const
    for(const [name,change] of badInputs){
      let vendorEffects=0
      await expect(gatewayOwner.deriveConsolidatedChildRequests((change as any).parent??parent,(change as any).child??child,(change as any).children??children,parseFactoryConfig({repos:[{repo:'fixture/repo',org:'fixture',path:tree}]},home),{gh}),name).rejects.toThrow()
      expect(vendorEffects).toBe(0)
    }
    const changedRecord=structuredClone(record) as any
    changedRecord.items[0].mode='preparation'
    const changedBody='<!-- vsk:v1 type=approval scope=consolidated -->\n```json\n'+JSON.stringify(changedRecord)+'\n```\n',changedComment={...approvalComment,body:changedBody}
    const changedGh=async(args:string[])=>{const endpoint=(args[1]??'').split('?')[0]!,value=endpoint==='repos/fixture/repo/issues/1/comments'?[changedComment]:endpoint==='repos/fixture/repo/issues/8'?issue:pages.get(endpoint);if(value===undefined)throw Error('unexpected endpoint '+endpoint);return args.includes('--include')?'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(value):JSON.stringify(value)}
    const changedParent={...parent,authorityRequest:{...parent.authorityRequest,approvalBinding:{commentId:12,bodySha256:createHash('sha256').update(changedBody).digest('hex')}}}
    await expect(gatewayOwner.deriveConsolidatedChildRequests(changedParent as any,child,children,parseFactoryConfig({repos:[{repo:'fixture/repo',org:'fixture',path:tree}]},home),{gh:changedGh})).rejects.toThrow(/code child/)
    const variants:Array<[string,(value:any)=>void]>=[
      ['missing checkpoint',value=>{value.items[0].actionIds=value.items[0].actionIds.filter((id:string)=>id!=='checkpoint-child');value.actions=value.actions.filter((action:any)=>action.id!=='checkpoint-child')}],
      ['duplicate checkpoint',value=>{const copy=structuredClone(value.actions.find((action:any)=>action.id==='checkpoint-child'));copy.id='checkpoint-child-2';value.actions.push(copy);value.items[0].actionIds.push(copy.id)}],
      ['unselected checkpoint',value=>{value.items[0].actionIds=value.items[0].actionIds.filter((id:string)=>id!=='checkpoint-child')}],
      ['wrong checkpoint ref',value=>{value.actions.find((action:any)=>action.id==='checkpoint-child').child.ref='refs/heads/feat/wrong'}],
      ['wrong checkpoint parent',value=>{value.actions.find((action:any)=>action.id==='checkpoint-child').parent.issue=2}],
      ['wrong task superset',value=>{value.items[0].taskIds.push('8-T2');value.actions.find((action:any)=>action.id==='checkpoint-child').child.taskIds.push('8-T2')}],
      ['duplicate task',value=>{value.items[0].taskIds.push('8-T1')}],
      ['wrong action id',value=>{value.items[0].actionIds=value.items[0].actionIds.map((id:string)=>id==='checkpoint-child'?'different-checkpoint':id)}],
    ]
    for(const [name,mutate] of variants){
      const value=structuredClone(record);mutate(value)
      const body='<!-- vsk:v1 type=approval scope=consolidated -->\n```json\n'+JSON.stringify(value)+'\n```\n',comment={...approvalComment,body}
      const variantGh=async(args:string[])=>{const endpoint=(args[1]??'').split('?')[0]!,result=endpoint==='repos/fixture/repo/issues/1/comments'?[comment]:endpoint==='repos/fixture/repo/issues/8'?issue:pages.get(endpoint);if(result===undefined)throw Error('unexpected endpoint '+endpoint);return args.includes('--include')?'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(result):JSON.stringify(result)}
      const variantParent={...parent,authorityRequest:{...parent.authorityRequest,approvalBinding:{commentId:12,bodySha256:createHash('sha256').update(body).digest('hex')}}}
      await expect(gatewayOwner.deriveConsolidatedChildRequests(variantParent as any,child,children,parseFactoryConfig({repos:[{repo:'fixture/repo',org:'fixture',path:tree}]},home),{gh:variantGh}),name).rejects.toThrow()
    }
  } finally {await rm(home,{recursive:true,force:true})}
},15000)

test.serial('actual packaged default gateway executes, checkpoints and joins one exact consolidated child',async()=>{
  const f=await defaultPackagedFixture()
  try{
    const beforeMain=git(f.tree,'ls-remote',f.remote,'refs/heads/main').split(/\s/)[0],beforeParent=git(f.tree,'ls-remote',f.remote,'refs/heads/feat/1-parent')
    const executed=await f.cli('run')
    expect(executed.result.blocked,executed.stderr+JSON.stringify(executed.result)).toEqual([]);expect(executed.exit).toBe(0);expect(f.vendorEntries).toHaveLength(1)
    const result=executed.result.results[0],runs=await readRuns(runsRoot(f.home)),child=runs.find(run=>run.runId===result.runId)!
    expect(child.branch).toBe(f.plannedChild.branch);expect(child.authorityRequest?.kind).toBe('consolidated');expect(child.authorityRequest?.kind==='consolidated'&&child.authorityRequest.requested.branch).toBe('feat/1-parent')
    expect(child.checkpointIntent?.approvalRequest?.requested).toMatchObject({actionId:'child-checkpoint',branch:f.plannedChild.branch,ref:'refs/heads/'+f.plannedChild.branch,baseSha:f.sourceSha,taskIds:['8-T1'],paths:['requested.txt']})
    expect(child.checkpoint?.headSha).toBe(result.headSha);expect(git(f.tree,'show',result.headSha+':requested.txt')).toBe('accepted')
    expect(git(f.tree,'ls-remote',f.remote,'refs/heads/'+f.plannedChild.branch).split(/\s/)[0]).toBe(result.headSha);expect(git(f.tree,'ls-remote',f.remote,'refs/heads/main').split(/\s/)[0]).toBe(beforeMain);expect(git(f.tree,'ls-remote',f.remote,'refs/heads/feat/1-parent')).toBe(beforeParent);expect(f.publicWrites).toBe(0)
    await f.addReview(result.headSha)
    const joined=await f.cli('join');expect(joined.result.blocked,joined.stderr+JSON.stringify(joined.result)).toEqual([]);expect(joined.exit).toBe(0);expect(joined.result.receipts[0]).toMatchObject({fromSha:result.headSha,accepted:true,state:'accepted'})
    const parentHead=git(f.tree,'rev-parse','HEAD');expect(git(f.tree,'show','HEAD:requested.txt')).toBe('accepted')
    const replay=await f.cli('join');expect(replay.exit).toBe(0);expect(git(f.tree,'rev-parse','HEAD')).toBe(parentHead);expect(f.vendorEntries).toHaveLength(1)
  }finally{await f.cleanup()}
},360000)

test.serial('packaged default gateway refuses mode and dependency drift with no vendor or child-ref effect',async()=>{
  for(const options of [{mode:'preparation' as const},{dependencyDrift:true}]){
    const f=await defaultPackagedFixture(options)
    try{
      const result=await f.cli('run')
      expect(result.exit).toBe(2);expect(result.result.results??[]).toEqual([]);expect(f.vendorEntries).toEqual([]);expect(git(f.tree,'ls-remote',f.remote,'refs/heads/'+f.plannedChild.branch)).toBe('')
      expect(git(f.tree,'rev-parse','HEAD')).toBe(f.sourceSha)
    }finally{await f.cleanup()}
  }
},180000)

test('new child launch records bind immutable per-child parent provenance in schema v2', async () => {
  const f = await fixture()
  try {
    const executed = await f.cli('run')
    expect(executed.exit).toBe(0)
    expect(executed.result.plan.schemaVersion).toBe(2)
    expect(executed.result.plan.children[0].parentBinding).toEqual(executed.result.plan.parentBinding)
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
