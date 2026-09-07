import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { verifyArtifactBytes, assertPairVersions, assertScanEvidence, readPackageArchive, dashboardDescriptor, verifyDashboardDescriptor, materializeTree } from './release-artifacts.mjs'
import { mkdtemp, mkdir, writeFile, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
function archive(entries: {path:string, data?:string, type?:string}[]) {
 const chunks: Buffer[]=[]
 for(const e of entries){const b=Buffer.from(e.data??'');const h=Buffer.alloc(512);h.write(e.path,0,100);h.write('0000644\0',100);h.write(b.length.toString(8).padStart(11,'0')+'\0',124);h.fill(32,148,156);h.write(e.type??'0',156);h.write([...h].reduce((a,v)=>a+v,0).toString(8).padStart(6,'0')+'\0 ',148);chunks.push(h,b,Buffer.alloc((512-b.length%512)%512))}
 return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]))
}
const packed=()=>archive([{path:'package/package.json',data:JSON.stringify({name:'@vegastack/vegafactory-dashboard',version:'1.0.0'})},{path:'package/dist-standalone/server.js',data:'server'}])
test('changing packed bytes invalidates identity',()=>{const b=Buffer.from('reviewed');const sha256=createHash('sha256').update(b).digest('hex');expect(verifyArtifactBytes(b,{sha256})).toBe(true);expect(verifyArtifactBytes(Buffer.from('rebuilt'),{sha256})).toBe(false)})
test('pair and tag versions must match',()=>{expect(()=>assertPairVersions({cli:'1.0.0',dashboard:'1.0.1',tag:'v1.0.0'})).toThrow();expect(()=>assertPairVersions({cli:'1.0.0',dashboard:'1.0.0',tag:'v1.0.0'})).not.toThrow()})
test('scanner unavailable, skipped or partial coverage blocks',()=>{for(const x of [{ok:false},{ok:true,skipped:true},{ok:true,skills:[]},{ok:true,skills:[{name:'a',completeness:{limitations:['unread']}}]}])expect(()=>assertScanEvidence(x,['a'])).toThrow()})
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
 expect(()=>assertScanEvidence({ok:true,skills:[{name:'a',completeness:{status:'complete',limitations:[],entirelyUninspected:0,partiallyInspected:0,coveragePercent:100}}]},['a'])).not.toThrow()
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
 await writeFile(join(root,'skills/skills-tooling/skill-scan/scripts/skill-scan.mjs'),`if(process.env.FIXTURE_FAILURE==='unavailable'){console.error('fixture scanner unavailable');process.exit(2)};console.log(JSON.stringify({ok:process.env.FIXTURE_FAILURE!=='blocked',skills:[{name:'fixture',completeness:{status:'partial',limitations:['fixture coverage gap']}}]}))`)
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
