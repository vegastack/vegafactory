import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { verifyArtifactBytes, assertPairVersions, assertScanEvidence, readPackageArchive, dashboardDescriptor, verifyDashboardDescriptor, materializeTree, smokePair } from './release-artifacts.mjs'
import { mkdtemp, mkdir, writeFile, symlink, readFile, chmod, rm, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
function archive(entries: {path:string, data?:string, type?:string, mode?:number}[]) {
 const chunks: Buffer[]=[]
 for(const e of entries){const b=Buffer.from(e.data??'');const h=Buffer.alloc(512);h.write((e.mode??0o644).toString(8).padStart(7,'0')+'\0',100);h.write(e.path,0,100);h.write(b.length.toString(8).padStart(11,'0')+'\0',124);h.fill(32,148,156);h.write(e.type??'0',156);h.write([...h].reduce((a,v)=>a+v,0).toString(8).padStart(6,'0')+'\0 ',148);chunks.push(h,b,Buffer.alloc((512-b.length%512)%512))}
 return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]))
}
const packed=()=>archive([{path:'package/package.json',data:JSON.stringify({name:'@vegastack/vegafactory-dashboard',version:'1.0.0'})},{path:'package/dist-standalone/server.js',data:'server'}])
test('changing packed bytes invalidates identity',()=>{const b=Buffer.from('reviewed');const sha256=createHash('sha256').update(b).digest('hex');expect(verifyArtifactBytes(b,{sha256})).toBe(true);expect(verifyArtifactBytes(Buffer.from('rebuilt'),{sha256})).toBe(false)})
test('pair and tag versions must match',()=>{expect(()=>assertPairVersions({cli:'1.0.0',dashboard:'1.0.1',tag:'v1.0.0'})).toThrow();expect(()=>assertPairVersions({cli:'1.0.0',dashboard:'1.0.0',tag:'v1.0.0'})).not.toThrow()})
const scanWith=(completeness:any)=>({ok:true,skipped:false,blocks:[],skills:[{name:'a',completeness}]})
test('scanner unavailable, skipped, blocked or with mismatched skills is refused',()=>{
 const healthy=scanWith({status:'complete',limitations:[]})
 for(const x of [{...healthy,ok:false},{...healthy,ok:'true'},{...healthy,skipped:true},{...healthy,skipped:undefined},{...healthy,blocks:['blocked']},{...healthy,blocks:undefined},{...healthy,skills:[]}])expect(()=>assertScanEvidence(x,['a'])).toThrow()
 expect(()=>assertScanEvidence({...scanWith({status:'complete',limitations:[]}),skills:[{name:'a',completeness:{status:'complete',limitations:[]}},{name:'b',completeness:{status:'complete',limitations:[]}}]},['a'])).toThrow()
 expect(()=>assertScanEvidence({...healthy,skills:[healthy.skills[0],healthy.skills[0]]},['a','a'])).toThrow()
})
test('healthy label-only partial scanner status passes in normalized and raw field forms',()=>{
 expect(()=>assertScanEvidence(scanWith({status:'partial',limitations:[],entirelyUninspected:0,partiallyInspected:0,coveragePercent:100}),['a'])).not.toThrow()
 expect(()=>assertScanEvidence(scanWith({status:'partial',limitations:[],entirely_uninspected_files:0,partially_inspected_files:0,coverage_percent:100}),['a'])).not.toThrow()
})
test('unknown, missing or genuinely incomplete partial scanner evidence is refused',()=>{
 const partial={status:'partial',limitations:[],entirelyUninspected:0,partiallyInspected:0,coveragePercent:100}
 const missing=(field:string)=>{const value={...partial};delete value[field as keyof typeof value];return value}
 for(const completeness of [
  undefined,{...partial,status:'unknown'},{...partial,limitations:['analyzer stopped']},
  missing('entirelyUninspected'),missing('partiallyInspected'),missing('coveragePercent'),
  {...partial,entirelyUninspected:1},{...partial,partiallyInspected:1},{...partial,coveragePercent:99.9},
  {...partial,entirely_uninspected_files:1},{...partial,partially_inspected_files:1},{...partial,coverage_percent:99.9},
 ])expect(()=>assertScanEvidence(scanWith(completeness),['a'])).toThrow()
})
test('descriptor binds bytes, identity and every file',()=>{const b=packed();const d=dashboardDescriptor(b,'1.0.0');expect(verifyDashboardDescriptor(d,b,'1.0.0')).toBe(true);for(const bad of [undefined,{...d,version:'0.9.0'},{...d,files:[]},{...d,files:d.files.map((f:any)=>({...f,sha256:'0'.repeat(64)}))}])expect(()=>verifyDashboardDescriptor(bad,b,'1.0.0')).toThrow();expect(()=>verifyDashboardDescriptor(d,Buffer.concat([b,Buffer.from('changed')]),'1.0.0')).toThrow()})
test('tar rejects traversal, absolute, duplicate, links and devices before extraction',()=>{for(const e of [[{path:'/package/a'}],[{path:'package/../a'}],[{path:'package/a'},{path:'package/a'}],[{path:'package/a',type:'2'}],[{path:'package/a',type:'1'}],[{path:'package/a',type:'3'}],[{path:'package/a//b'}]])expect(()=>readPackageArchive(archive(e))).toThrow()})
test('assembly materializes internal links and rejects escapes',async()=>{const root=await mkdtemp(join(tmpdir(),'release-links-'));const src=join(root,'src');await mkdir(src);await writeFile(join(src,'a'),'actual');await symlink('a',join(src,'b'));await materializeTree(src,join(root,'out'));expect(await readFile(join(root,'out/b'),'utf8')).toBe('actual');await symlink('../outside',join(src,'escape'));await writeFile(join(root,'outside'),'secret');await expect(materializeTree(src,join(root,'bad'))).rejects.toThrow()})

test('extracted content, modes and links remain bound to the descriptor',async()=>{
 const {extractPackage,verifyExtractedDashboard}=await import('./release-artifacts.mjs')
 const home=await mkdtemp(join(tmpdir(),'extracted-pair-'));const root=join(home,'package');const b=packed();const d=dashboardDescriptor(b,'1.0.0')
 await extractPackage(b,root);expect(await verifyExtractedDashboard(root,d)).toBe(true)
 await writeFile(join(root,'dist-standalone/server.js'),'altered');await expect(verifyExtractedDashboard(root,d)).rejects.toThrow()
})

test('complete exact scanner coverage passes while a copied previous dashboard descriptor fails',()=>{
 expect(()=>assertScanEvidence(scanWith({status:'complete',limitations:[],entirelyUninspected:0,partiallyInspected:0,coveragePercent:100}),['a'])).not.toThrow()
 const old=dashboardDescriptor(packed(),'1.0.0')
 const changed=archive([{path:'package/package.json',data:JSON.stringify({name:'@vegastack/vegafactory-dashboard',version:'1.0.0'})},{path:'package/dist-standalone/server.js',data:'new build same version'}])
 expect(()=>verifyDashboardDescriptor(old,changed,'1.0.0')).toThrow()
})

test('materialized package symlink retains its traced sibling resolution context',async()=>{
 const root=await mkdtemp(join(tmpdir(),'package-links-'));const src=join(root,'src');const store=join(src,'store/node_modules')
 await mkdir(join(store,'a'),{recursive:true});await mkdir(join(store,'b'),{recursive:true});await mkdir(join(src,'app/node_modules'),{recursive:true})
 await writeFile(join(store,'a/index.js'),"module.exports=require('b')");await writeFile(join(store,'b/index.js'),"module.exports='traced dependency'")
 await symlink('../../store/node_modules/a',join(src,'app/node_modules/a'))
 const output=join(root,'out');await materializeTree(src,output)
 const {createRequire}=await import('node:module');expect(createRequire(join(output,'app/app.js'))('a')).toBe('traced dependency')
})

import { cp, realpath } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { recoveryDecision } from './release-artifacts.mjs'
test('workflow recovery rebuilds only after affirmative skipped publication and reuses retained pair',()=>{
 const skipped={name:'publish',status:'completed',steps:[{name:'Publish retained pair and promote after registry first-use smoke',conclusion:'skipped'}]}
 expect(recoveryDecision({artifacts:[],attempts:{1:[skipped]},sourceSha:'a',runAttempt:2})).toEqual({prepare:true,artifact:''})
 for(const jobs of [undefined,[],[{...skipped,status:'in_progress'}],[{...skipped,steps:[]}],[{...skipped,steps:[{...skipped.steps[0],conclusion:'failure'}]}]])expect(()=>recoveryDecision({artifacts:[],attempts:{1:jobs},sourceSha:'a',runAttempt:2})).toThrow('uncertain')
 expect(recoveryDecision({artifacts:[{name:'release-pair-a-attempt-2',expired:false}],attempts:{},sourceSha:'a',runAttempt:3})).toEqual({prepare:false,artifact:'release-pair-a-attempt-2'})
 expect(()=>recoveryDecision({artifacts:[{name:'release-pair-a-attempt-2',expired:true}],attempts:{},sourceSha:'a',runAttempt:3})).toThrow('expired')
})
test('actual preparation CLI stops at dashboard build and scanner failures, leaving no finalized pair for guarded retry',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'prepare-command-'))),bin=join(root,'fixture-bin'),out=join(root,'work/release')
 for(const path of ['scripts','packages/cli','packages/dashboard','.vegastack','skills/skills-tooling/skill-scan/scripts','fixture-bin'])await mkdir(join(root,path),{recursive:true})
 await cp(resolve('scripts/release-artifacts.mjs'),join(root,'scripts/release-artifacts.mjs'))
 await writeFile(join(root,'.gitignore'),'work/\npackages/cli/skill/\n')
 for(const name of ['cli','dashboard'])await writeFile(join(root,'packages',name,'package.json'),JSON.stringify({name:name==='cli'?'@vegastack/vegafactory':'@vegastack/vegafactory-dashboard',version:'1.0.0'}))
 await writeFile(join(root,'.vegastack/skillspector-baseline.json'),JSON.stringify({scanner_version:'fixture-scanner'}))
 await writeFile(join(bin,'bun'),`#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2);fs.mkdirSync('work',{recursive:true});fs.appendFileSync('work/commands.jsonl',JSON.stringify(a)+'\\n');if(a[0]==='--version')console.log('1.3.14');else if(a.join(' ')==='run --cwd packages/dashboard build' && process.env.FIXTURE_FAILURE==='dashboard'){console.error('fixture dashboard build failed');process.exit(2)}else if(a.join(' ')==='run build')fs.mkdirSync('packages/cli/skill/fixture',{recursive:true});else if(a.join(' ')==='run check')console.log('fixture check');else if(!['install','run'].includes(a[0]))process.exit(91)
`,{mode:0o755})
 for(const [name,version] of [['python3.12','Python 3.12.0'],['skillspector','fixture-scanner']])await writeFile(join(bin,name!),`#!/usr/bin/env node\nif(process.argv[2]!=='--version')process.exit(92);console.log(${JSON.stringify(version)})\n`,{mode:0o755})
 await writeFile(join(root,'skills/skills-tooling/skill-scan/scripts/skill-scan.mjs'),`if(process.env.FIXTURE_FAILURE==='unavailable'){console.error('fixture scanner unavailable');process.exit(2)};console.log(JSON.stringify({ok:process.env.FIXTURE_FAILURE!=='blocked',skipped:false,blocks:[],skills:[{name:'fixture',completeness:{status:'partial',limitations:['fixture coverage gap']}}]}))`)
 const git=(a:string[])=>{const r=spawnSync('git',a,{cwd:root,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr)}
 git(['init','-q']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','synthetic preparation source'])
 for(const [failure,reason] of [['dashboard','fixture dashboard build failed'],['unavailable','fixture scanner unavailable'],['blocked','scanner unavailable or incomplete'],['partial','partial scanner coverage']]) {
  const result=spawnSync('node',[join(root,'scripts/release-artifacts.mjs'),'prepare',out,'v1.0.0'],{cwd:root,env:{...process.env,PATH:bin+':'+process.env.PATH,FIXTURE_FAILURE:failure},encoding:'utf8'})
  expect(result.status).toBe(2);expect(result.stderr).toContain(reason!);await expect(readFile(join(out,'release-manifest.json'))).rejects.toThrow()
 }
 const calls=(await readFile(join(root,'work/commands.jsonl'),'utf8')).trim().split('\n').map(x=>JSON.parse(x))
 expect(calls.filter(a=>a.join(' ')==='run --cwd packages/dashboard build')).toHaveLength(4)
 expect(spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).stdout).toBe('')
},15000)

test('actual workflow recovery command permits a failed preparation retry and refuses uncertain publication; pair upload gates mutation',async()=>{
 const text=await readFile('.github/workflows/release.yml','utf8')
 const workflow=Bun.YAML.parse(text) as any
 const steps=workflow.jobs.publish.steps
 const recovery=steps.find((s:any)=>s.id==='recovery')
 const retained=steps.findIndex((s:any)=>s.name==='Retain finalized immutable pair')
 const publish=steps.findIndex((s:any)=>s.name==='Publish retained pair and promote after registry first-use smoke')
 expect(retained).toBeGreaterThan(steps.findIndex((s:any)=>s.name==='Verify finalized immutable pair and evidence'))
 expect(publish).toBeGreaterThan(retained);expect(steps[publish].if).toBeUndefined();expect(steps[retained].with['if-no-files-found']).toBe('error')
 const fixture={artifacts:[],jobs:[{name:'publish',status:'completed',steps:[{name:steps[publish].name,conclusion:'skipped'}]}]}
 const script=`const fixture=JSON.parse(process.env.FIXTURE_HISTORY);const output={};const core={setOutput:(k,v)=>output[k]=v};const context={repo:{owner:'fixture',repo:'fixture'},runId:1,sha:'a'};const github={rest:{actions:{listWorkflowRunArtifacts:'artifacts'}},paginate:async(route)=>route==='artifacts'?fixture.artifacts:fixture.jobs};await (async()=>{${recovery.with.script}})();console.log(JSON.stringify(output))`
 const run=(history:any)=>spawnSync('node',['--input-type=module','-e',script],{env:{...process.env,GITHUB_WORKSPACE:process.cwd(),GITHUB_RUN_ATTEMPT:'2',FIXTURE_HISTORY:JSON.stringify(history)},encoding:'utf8'})
 const retry=run(fixture);expect(retry.status).toBe(0);expect(JSON.parse(retry.stdout).prepare).toBe('true')
 fixture.jobs[0]!.steps[0]!.conclusion='failure';const uncertain=run(fixture);expect(uncertain.status).not.toBe(0);expect(uncertain.stderr).toContain('uncertain')
 const reuse=run({...fixture,artifacts:[{name:'release-pair-a-attempt-1',id:42,expired:false}]});expect(reuse.status).toBe(0);expect(JSON.parse(reuse.stdout)).toMatchObject({prepare:'false','artifact-id':42})
})


import { CLI, DASHBOARD, extractPackage, packPair, verifyInstalledRuntime } from './release-artifacts.mjs'
import { verifyInstalledRuntimeBinding, type InstalledRuntimeBinding } from '../packages/cli/src/runs.ts'
const runtimeSha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const runtimeSource = 'a'.repeat(40), runtimeTree = 'b'.repeat(40)
async function runtimeFixture() {
 const home=await realpath(await mkdtemp(join(tmpdir(),'installed-runtime-'))), directory=join(home,'pair'), installedRoot=join(home,'installed')
 await mkdir(directory)
 const dashboard=packed(), descriptor=dashboardDescriptor(dashboard,'1.0.0')
 const cli=archive([
  {path:'package/package.json',data:JSON.stringify({name:CLI,version:'1.0.0'})},
  {path:'package/dist/index.js',data:'// CLI'}, {path:'package/dist/run-wrapper.js',data:'// wrapper'},
  {path:'package/dist/dashboard-artifact.json',data:JSON.stringify(descriptor)},
  {path:'package/skill/z/SKILL.md',data:'skill'}, {path:'package/README.md',data:'readme'},
  {path:'package/LICENSE',data:'license'}, {path:'package/skill-integrity.json',data:'{}'},
  {path:'package/dist/index.js.map',data:'{}'}, {path:'package/Z.txt',data:'Z'}, {path:'package/a.txt',data:'a'},
 ])
 const artifacts=[]
 for(const [name,file,bytes] of [[DASHBOARD,'dashboard.tgz',dashboard],[CLI,'cli.tgz',cli]] as const) {
  await writeFile(join(directory,file),bytes)
  artifacts.push({name,file,sha256:runtimeSha(bytes),integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64'),bytes:bytes.length})
 }
 await extractPackage(cli,installedRoot)
 return {home,cli,manifest:{schemaVersion:1,sourceSha:runtimeSource,treeSha:runtimeTree,version:'1.0.0',artifacts},directory,installedRoot,expectedSourceSha:runtimeSource,expectedTreeSha:runtimeTree}
}
test('installed runtime producer binds the full retained pair and matches the independent runtime consumer',async()=>{
 const f=await runtimeFixture(), binding=await verifyInstalledRuntime(f) as InstalledRuntimeBinding
 const entries=readPackageArchive(f.cli).map(({path,mode,sha256}:any)=>({path,mode,sha256}))
 expect(binding).toEqual({schemaVersion:1,sourceSha:runtimeSource,treeSha:runtimeTree,packageName:CLI,version:'1.0.0',tarballSha256:runtimeSha(f.cli),inventoryDigest:runtimeSha(JSON.stringify(entries))})
 await verifyInstalledRuntimeBinding(binding,f.installedRoot,join(f.installedRoot,'dist/index.js'))
 await expect(verifyInstalledRuntimeBinding(binding,f.installedRoot,join(f.installedRoot,'dist/run-wrapper.js'))).rejects.toThrow('outside')
})
test('installed runtime producer refuses missing, changed, extra files and directories, modes and links',async()=>{
 const f=await runtimeFixture()
 const reset=async()=>{await rm(f.installedRoot,{recursive:true,force:true});await extractPackage(f.cli,f.installedRoot)}
 const target=()=>join(f.installedRoot,'README.md')
 const mutations=[
  async()=>writeFile(target(),'changed'),async()=>rm(target()),async()=>writeFile(join(f.installedRoot,'extra'),'extra'),
  async()=>mkdir(join(f.installedRoot,'extra-empty-directory')),async()=>chmod(target(),0o755),async()=>chmod(target(),0o600),
  async()=>{await rm(target());await symlink('LICENSE',target())},
  async()=>{await rm(target());await link(join(f.installedRoot,'LICENSE'),target())},
  async()=>{await rm(join(f.installedRoot,'skill'),{recursive:true});await symlink('../pair',join(f.installedRoot,'skill'))},
  async()=>{await rm(f.installedRoot,{recursive:true});await symlink('pair',f.installedRoot)},
 ]
 for(const mutate of mutations){await mutate();await expect(verifyInstalledRuntime(f)).rejects.toThrow();await reset()}
 const alias=join(f.home,'alias');await symlink(f.home,alias)
 await expect(verifyInstalledRuntime({...f,installedRoot:join(alias,'installed')})).rejects.toThrow('link')
 if(process.platform!=='win32') {
  const fifo=spawnSync('mkfifo',[join(f.installedRoot,'fifo')],{encoding:'utf8'})
  expect(fifo.status).toBe(0);await expect(verifyInstalledRuntime(f)).rejects.toThrow()
 }
})
test('installed runtime producer requires trusted source/tree and refuses changed retained bytes or pair identity',async()=>{
 const f=await runtimeFixture()
 for(const change of [{expectedSourceSha:'c'.repeat(40)},{expectedTreeSha:'c'.repeat(40)},{expectedSourceSha:undefined},{expectedTreeSha:'invalid'},
  {manifest:{...f.manifest,sourceSha:'c'.repeat(40)}},{manifest:{...f.manifest,treeSha:'c'.repeat(40)}},
  {manifest:{...f.manifest,version:'2.0.0'}},{manifest:{...f.manifest,artifacts:f.manifest.artifacts.slice(1)}}]) {
  await expect(verifyInstalledRuntime({...f,...change})).rejects.toThrow()
 }
 const otherDashboard=archive([{path:'package/package.json',data:JSON.stringify({name:DASHBOARD,version:'1.0.0'})},{path:'package/dist-standalone/server.js',data:'other build'}])
 await writeFile(join(f.directory,'dashboard.tgz'),otherDashboard)
 const substituted={...f.manifest,artifacts:f.manifest.artifacts.map(a=>a.name===DASHBOARD?{...a,sha256:runtimeSha(otherDashboard),integrity:'sha512-'+createHash('sha512').update(otherDashboard).digest('base64'),bytes:otherDashboard.length}:a)}
 await expect(verifyInstalledRuntime({...f,manifest:substituted})).rejects.toThrow('descriptor')
 await writeFile(join(f.directory,'dashboard.tgz'),packed())
 await writeFile(join(f.directory,'cli.tgz'),Buffer.concat([f.cli,Buffer.from('changed')]))
 await expect(verifyInstalledRuntime(f)).rejects.toThrow('artifact bytes changed')
 await writeFile(join(f.directory,'cli.tgz'),f.cli)
 await writeFile(join(f.directory,'dashboard.tgz'),packed().subarray(0,20))
 await expect(verifyInstalledRuntime(f)).rejects.toThrow('artifact bytes changed')
})
test('installed runtime producer verifies a real npm packed and offline installed fixture without normalizing modes',async()=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),'npm-runtime-'))),directory=join(home,'pair'),consumer=join(home,'consumer')
 for(const folder of ['packages/cli/dist','packages/cli/skill/fixture','packages/dashboard'])await mkdir(join(home,folder),{recursive:true})
 await writeFile(join(home,'packages/dashboard/package.json'),JSON.stringify({name:DASHBOARD,version:'1.0.0'}))
 await writeFile(join(home,'packages/cli/package.json'),JSON.stringify({name:CLI,version:'1.0.0',bin:{vegafactory:'dist/index.js'},files:['dist','skill','skill-integrity.json','README.md','LICENSE']}))
 for(const [path,data,mode] of [['dist/index.js','#!/usr/bin/env node\nconsole.log("1.0.0")\n',0o755],['dist/run-wrapper.js','// wrapper',0o644],['dist/index.js.map','{}',0o644],['skill/fixture/SKILL.md','fixture',0o644],['skill-integrity.json','{}',0o644],['README.md','fixture',0o644],['LICENSE','fixture',0o644]] as const)await writeFile(join(home,'packages/cli',path),data,{mode})
 const manifest=await packPair(home,directory,{sourceSha:runtimeSource,treeSha:runtimeTree,version:'1.0.0',toolchain:{fixture:true},checkEvidence:{ok:false},scanEvidence:{ok:false}})
 const tarball=manifest.artifacts.find((a:any)=>a.name===CLI)!
 const result=spawnSync('npm',['install','--ignore-scripts','--offline','--no-audit','--no-fund','--prefix',consumer,join(directory,tarball.file)],{cwd:home,env:{...process.env,HOME:home,npm_config_cache:join(home,'cache')},encoding:'utf8',timeout:30000})
 expect({status:result.status,stderr:result.stderr}).toMatchObject({status:0})
 const installedRoot=join(consumer,'node_modules',CLI)
 const input={manifest,directory,installedRoot,expectedSourceSha:runtimeSource,expectedTreeSha:runtimeTree}
 const binding=await verifyInstalledRuntime(input) as InstalledRuntimeBinding
 await verifyInstalledRuntimeBinding(binding,installedRoot,join(installedRoot,'dist/index.js'))
 expect(spawnSync('node',[join(installedRoot,'dist/index.js')],{cwd:home,encoding:'utf8'}).stdout.trim()).toBe('1.0.0')
 await chmod(join(installedRoot,'dist/index.js'),0o644)
 await expect(verifyInstalledRuntime(input)).rejects.toThrow('inventory')
},30000)

async function launcherSmokeFixture(earlyExit=false) {
 const home=await realpath(await mkdtemp(join(tmpdir(),'launcher-smoke-pair-'))),directory=join(home,'pair');await mkdir(directory)
 const dashboard=archive([
  {path:'package/package.json',data:JSON.stringify({name:DASHBOARD,version:'1.0.0'})},
  {path:'package/dist-standalone/packages/dashboard/server.js',data:'// retained exact dashboard fixture'},
 ])
 const descriptor=dashboardDescriptor(dashboard,'1.0.0')
 const child=`import {createServer} from 'node:http';
const [port,instanceId,org,version]=process.argv.slice(2);
const pages={
 '/':'Needs your decision Blocked or failed Running Recently merged',
 '/performance':'Performance report is unavailable. Unlinked terminal segments Unavailable',
 '/activity':'Activity report is unavailable. Task activity is unavailable',
 '/people':'People reporting is unavailable for the current policy and scope.',
 '/people/fixture-user':'This person report is unavailable for the current verified identity, policy, and repository scope.',
 '/skills':'No skill invocations recorded for this month.',
 '/repo/fixture/project':'This repository is outside the current verified reporting scope.',
 '/board':'Some data is incomplete or unavailable.',
 '/dispatcher':'Running Unavailable Last tick Unavailable',
};
const server=createServer((request,response)=>{const path=new URL(request.url,'http://fixture').pathname;if(path==='/api/health'){response.setHeader('content-type','application/json');response.end(JSON.stringify({ok:true,org,version,instanceId,cacheSchema:2,dataState:'unavailable',sourceAgeSeconds:null}));return}response.setHeader('content-type','text/html');response.statusCode=Object.hasOwn(pages,path)?200:404;response.end(pages[path]??'not found')});
server.listen(Number(port),'127.0.0.1',()=>console.log('ready'));const stop=()=>server.close(()=>process.exit(0));process.on('SIGTERM',stop);process.on('SIGINT',stop);`
 const cli=`#!/usr/bin/env node
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';import {join,isAbsolute} from 'node:path';import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';
const [verb,...rest]=process.argv.slice(2);const home=process.env.HOME;
if(verb==='--version'){console.log('vegafactory 1.0.0');process.exit(0)}
if(verb==='skills'){if(rest[0]==='list'){console.log('fixture skill');process.exit(0)}const root=rest[rest.indexOf('--dir')+1];if(rest[0]==='add'){mkdirSync(join(root,'.agents/skills/dev-implement/scripts'),{recursive:true});writeFileSync(join(root,'.agents/skills/dev-implement/scripts/preflight.mjs'),'fixture');process.exit(0)}if(rest[0]==='verify'){if(!existsSync(join(root,'.agents/skills/dev-implement/scripts/preflight.mjs')))process.exit(74);process.exit(0)}}
if(verb!=='dashboard'||rest.includes('--dir')||!rest.includes('--json'))process.exit(75);
${earlyExit?'process.exit(76);':''}
const config=JSON.parse(readFileSync(join(home,'.vegastack/factory.json'),'utf8'));const org=rest[rest.indexOf('--org')+1];const start=Number(rest[rest.indexOf('--port')+1]);const room=config.controlRooms?.[org];const repos=config.repos;
if(config.schemaVersion!==2||config.revision!==0||!room||!isAbsolute(room.path)||!Array.isArray(repos)||repos.length!==1||repos[0].org!==org||repos[0].repo!=='fixture/project'||!isAbsolute(repos[0].path))process.exit(77);
const retained=join(home,'.vegastack/dashboard/1.0.0/node_modules/@vegastack/vegafactory-dashboard/dist-standalone/packages/dashboard/server.js');if(!existsSync(retained))process.exit(78);
const instanceId=randomUUID();const child=spawn(process.execPath,[fileURLToPath(new URL('./fixture-dashboard-child.mjs',import.meta.url)),String(start+1),instanceId,org,'1.0.0'],{detached:true,stdio:['ignore','pipe','inherit']});
child.stdout.once('data',()=>console.log(JSON.stringify({command:'dashboard',ok:true,org,version:'1.0.0',instanceId,cacheSchema:2,url:'http://127.0.0.1:'+(start+1),dir:join(home,'.vegastack/dashboard/1.0.0'),entry:retained,fetched:false,pid:child.pid})));const stop=()=>{child.once('close',()=>process.exit(0));child.kill('SIGTERM')};process.on('SIGTERM',stop);process.on('SIGINT',stop);await new Promise(()=>{});`
 const cliBytes=archive([
  {path:'package/package.json',data:JSON.stringify({name:CLI,version:'1.0.0',type:'module',bin:{vegafactory:'dist/index.js'}})},
  {path:'package/dist/index.js',data:cli,mode:0o755},{path:'package/dist/run-wrapper.js',data:'// wrapper'},
  {path:'package/dist/fixture-dashboard-child.mjs',data:child},{path:'package/dist/dashboard-artifact.json',data:JSON.stringify(descriptor)},
  {path:'package/skill/dev-implement/SKILL.md',data:'name: dev-implement'},
 ])
 const artifacts=[]
 for(const [name,file,bytes] of [[DASHBOARD,'dashboard.tgz',dashboard],[CLI,'cli.tgz',cliBytes]] as const){await writeFile(join(directory,file),bytes);artifacts.push({name,file,sha256:runtimeSha(bytes),integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64'),bytes:bytes.length})}
 return {directory,manifest:{schemaVersion:1,sourceSha:runtimeSource,treeSha:runtimeTree,version:'1.0.0',artifacts}}
}

test('pair smoke uses the installed CLI launcher, rejects a stale listener, reaches all scoped routes, and proves owned cleanup',async()=>{
 const fixture=await launcherSmokeFixture();const result=await smokePair(fixture.manifest,fixture.directory)
 expect(result.launcher).toMatchObject({command:'dashboard',ok:true,org:'fixture',version:'1.0.0',cacheSchema:2})
 expect(result.readiness).toMatchObject({ok:true,org:'fixture',version:'1.0.0',cacheSchema:2,dataState:'unavailable',sourceAgeSeconds:null})
 expect(result.readiness.instanceId).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
 expect(result.routes.map((row:any)=>row.route)).toEqual(['/','/performance','/activity','/people','/people/fixture-user?dimension=task-owner','/skills','/repo/fixture/project','/board','/dispatcher'])
 expect(result).toMatchObject({installedCli:true,staleListenerRejected:true,ownedChildAlive:true,cleanup:{cliStopped:true,dashboardStopped:true,isolatedHomeRemoved:true}})
},30000)

test('pair smoke rejects an installed launcher that exits before owning a ready dashboard',async()=>{
 const fixture=await launcherSmokeFixture(true)
 await expect(smokePair(fixture.manifest,fixture.directory)).rejects.toThrow('installed CLI dashboard exited before readiness')
},30000)
