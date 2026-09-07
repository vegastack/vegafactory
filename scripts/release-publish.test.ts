import { expect, test } from 'bun:test'
import { classifyRegistry, publishPair } from './release-publish.mjs'
import { createHash } from 'node:crypto'
const artifact=(name:string)=>{const bytes=Buffer.from(name);return {name,file:name.replaceAll('/','-').replace('@','')+'.tgz',sha256:createHash('sha256').update(bytes).digest('hex'),integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64'),bytes:bytes.length}}
const manifest={version:'1.0.0',artifacts:[artifact('@vegastack/vegafactory-dashboard'),artifact('@vegastack/vegafactory')]}
function registry(){const existing=new Map<string,any>();const calls:string[]=[];return {existing,calls,read:async(a:any)=>existing.has(a.name)?{status:200,integrity:existing.get(a.name).integrity,bytes:Buffer.from(a.name)}:{status:404,definitive:true},publish:async(a:any)=>{calls.push(a.name);existing.set(a.name,a)},smoke:async()=>{calls.push('smoke')},latest:async(a:any)=>({matching:calls.includes('promote '+a.name)}),promote:async(a:any)=>{calls.push('promote '+a.name)}}}
test('errors never mean absent',()=>{for(const status of [401,403,429,500,0])expect(classifyRegistry({integrity:'a'},{status})).toBe('unavailable');expect(classifyRegistry({integrity:'a'},{status:404})).toBe('unavailable');expect(classifyRegistry({integrity:'a'},{status:404,definitive:true})).toBe('absent');expect(classifyRegistry({integrity:'a'},{status:200,integrity:'b'})).toBe('conflict')})
test('dashboard first; CLI failure resumes matching dashboard without re-publication',async()=>{const r=registry();const publish=r.publish;r.publish=async a=>{if(a.name===manifest.artifacts[1].name)throw new Error('failed');await publish(a)};await expect(publishPair(manifest,r,{publish:true})).rejects.toThrow();expect(r.calls).toEqual([manifest.artifacts[0].name]);r.publish=publish;expect((await publishPair(manifest,r,{publish:true,promote:true})).state).toBe('promoted');expect(r.calls.filter(x=>x===manifest.artifacts[0].name)).toHaveLength(1)})
test('lost publish response reads back and does not blindly retry',async()=>{const r=registry();const publish=r.publish;r.publish=async a=>{await publish(a);throw new Error('timeout')};expect((await publishPair(manifest,r,{publish:true})).state).toBe('smoked');expect(r.calls.filter(x=>x.includes('@'))).toHaveLength(2)})
test('matching rerun only smokes; altered bytes and integrity conflict refuse',async()=>{const r=registry();for(const a of manifest.artifacts)r.existing.set(a.name,a);await publishPair(manifest,r,{publish:true});expect(r.calls).toEqual(['smoke']);r.existing.set(manifest.artifacts[0].name,{integrity:'changed'});await expect(publishPair(manifest,r,{publish:true})).rejects.toThrow()})
test('smoke failure never promotes; no explicit grant never publishes',async()=>{const r=registry();await expect(publishPair(manifest,r,{})).rejects.toThrow();expect(r.calls).toEqual([]);r.smoke=async()=>{throw new Error('smoke failed')};await expect(publishPair(manifest,r,{publish:true,promote:true})).rejects.toThrow();expect(r.calls.some(c=>c.startsWith('promote'))).toBe(false)})

test('HTTP adapter bounds retries and never classifies missing payload as absent',async()=>{
 const {registryClient}=await import('./release-publish.mjs');let calls=0
 const unavailable=registryClient({fetcher:async()=>{calls++;return new Response('',{status:503})}})
 expect(classifyRegistry(manifest.artifacts[0],await unavailable.read(manifest.artifacts[0],'1.0.0'))).toBe('unavailable');expect(calls).toBe(3)
 const missingPayload=registryClient({fetcher:async(url:any)=>String(url).endsWith('/file.tgz')?new Response('',{status:404}):Response.json({name:manifest.artifacts[0].name,version:'1.0.0',dist:{integrity:manifest.artifacts[0].integrity,tarball:'https://registry.npmjs.org/file.tgz'}})})
 expect(classifyRegistry(manifest.artifacts[0],await missingPayload.read(manifest.artifacts[0],'1.0.0'))).toBe('unavailable')
})
test('promotion refuses backward latest before npm mutation',async()=>{
 const {registryClient}=await import('./release-publish.mjs');let mutations=0
 const r=registryClient({fetcher:async()=>Response.json({name:manifest.artifacts[0]!.name,version:'2.0.0'}),run:()=>{mutations++;return ''}})
 await expect(r.promote(manifest.artifacts[0],'1.0.0')).rejects.toThrow('backward');expect(mutations).toBe(0)
})

test('known integrity conflicts do not download payloads',async()=>{
 const {registryClient}=await import('./release-publish.mjs');let downloads=0
 const a=manifest.artifacts[0]!
 const r=registryClient({fetcher:async(url:any)=>{if(String(url).endsWith('.tgz')){downloads++;return new Response('oversized')};return Response.json({name:a.name,version:'1.0.0',dist:{integrity:'conflict',tarball:'https://registry.npmjs.org/file.tgz'}})}})
 expect(classifyRegistry(a,await r.read(a,'1.0.0'))).toBe('conflict');expect(downloads).toBe(0)
})
test('oversized tarball streams are cancelled at the trusted byte limit',async()=>{
 const {registryClient}=await import('./release-publish.mjs');let cancelled=false
 const a=manifest.artifacts[0]!
 const r=registryClient({fetcher:async(url:any)=>String(url).endsWith('.tgz')?new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(a.bytes+1))},cancel(){cancelled=true}})):Response.json({name:a.name,version:'1.0.0',dist:{integrity:a.integrity,tarball:'https://registry.npmjs.org/file.tgz'}})})
 expect(classifyRegistry(a,await r.read(a,'1.0.0'))).toBe('unavailable');expect(cancelled).toBe(true)
})

// These exercise the shipped command, persisted files, actual subprocess npm seam,
// and real smokePair installs/launches against synthetic packages. No real publisher
// is reachable: the explicit fixture executable rejects every unrecognized command.
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { dashboardDescriptor, CLI, DASHBOARD } from './release-artifacts.mjs'
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
function tar(files:Record<string,string>) {
 const chunks:Buffer[]=[]
 for(const [path,data] of Object.entries(files)){const b=Buffer.from(data),h=Buffer.alloc(512);h.write('package/'+path,0,100);h.write('0000644\0',100);h.write(b.length.toString(8).padStart(11,'0')+'\0',124);h.fill(32,148,156);h.write('0',156);h.write([...h].reduce((a,v)=>a+v,0).toString(8).padStart(6,'0')+'\0 ',148);chunks.push(h,b,Buffer.alloc((512-b.length%512)%512))}
 return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]))
}
async function pairFixture(version='1.0.0',badSmoke=false) {
 const dir=await mkdtemp(join(tmpdir(),'release-command-'))
 const dashboard=tar({'package.json':JSON.stringify({name:DASHBOARD,version}),'dist-standalone/packages/dashboard/server.js':`require('node:http').createServer((q,r)=>{r.statusCode=${badSmoke?500:200};r.end('fixture route')}).listen(Number(process.env.PORT),'127.0.0.1')`})
 const descriptor=dashboardDescriptor(dashboard,version)
 const cli=tar({'package.json':JSON.stringify({name:CLI,version}),'dist/dashboard-artifact.json':JSON.stringify(descriptor),'dist/index.js':`const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2);if(a[0]==='--version')console.log('${version}');else if(a[1]==='list')console.log('dev-implement');else if(a[1]==='add'){const d=p.join(a[a.indexOf('--dir')+1],'.agents/skills/dev-implement/scripts');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'preflight.mjs'),'fixture helper')}else if(a[1]==='verify'){if(!fs.existsSync(p.join(a[a.indexOf('--dir')+1],'.agents/skills/dev-implement/scripts/preflight.mjs')))process.exit(1)}else process.exit(2)`})
 const artifacts=[]
 for(const [name,bytes,file] of [[DASHBOARD,dashboard,'dashboard.tgz'],[CLI,cli,'cli.tgz']] as const){await writeFile(join(dir,file),bytes);artifacts.push({name,file,sha256:sha(bytes),integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64'),bytes:bytes.length})}
 const sbomFiles=[]
 for(const [file,scope] of [['build-sbom.json','build'],['cli-runtime-sbom.json',CLI],['dashboard-runtime-sbom.json',DASHBOARD]]){const b=Buffer.from(JSON.stringify({bomFormat:'CycloneDX',components:[],metadata:{component:{name:scope,version}}}));await writeFile(join(dir,file!),b);sbomFiles.push({file,scope,sha256:sha(b)})}
 const log=Buffer.from('synthetic release fixture evidence, not candidate qualification');await writeFile(join(dir,'check.log'),log);await writeFile(join(dir,'scan.json'),log)
 const m={schemaVersion:1,sourceSha:'a'.repeat(40),treeSha:'b'.repeat(40),version,artifacts,sbomFiles,platformMatrix:[{platform:'synthetic-fixture'}],checkEvidence:{ok:true,file:'check.log',sha256:sha(log)},scanEvidence:{ok:true,file:'scan.json',sha256:sha(log)}}
 await writeFile(join(dir,'release-manifest.json'),JSON.stringify(m));return {dir,manifest:m}
}
async function processRegistry() {
 const dir=await mkdtemp(join(tmpdir(),'fake-publisher-')),publisher=join(dir,'publisher.mjs')
 await writeFile(publisher,`#!/usr/bin/env node
const fs=await import('node:fs/promises');const a=process.argv.slice(2);const base=a[a.indexOf('--registry')+1];if(new URL(base).protocol!=='http:'||new URL(base).hostname!=='127.0.0.1')throw Error('fixture refuses nonloopback');let body;if(a[0]==='publish'){if(!a.includes('--ignore-scripts')||a[a.indexOf('--tag')+1]==='latest')throw Error('unsafe fixture publish');body={operation:'publish',bytes:(await fs.readFile(a[1])).toString('base64')}}else if(a[0]==='dist-tag'&&a[1]==='add'&&a[3]==='latest')body={operation:'promote',identity:a[2]};else throw Error('unsupported fixture command');const r=await fetch(base+'/mutation',{method:'POST',body:JSON.stringify(body)});if(!r.ok)throw Error('fixture mutation response '+r.status)
`,{mode:0o755})
 const versions=new Map<string,any>(),tags=new Map<string,string>(),writes:string[]=[]
 const control:any={failCLI:false,failPromoteCLI:false,lostPublish:false,lostPromote:false,status:0,conflict:false,onPublish:null}
 let base=''
 const server=createServer(async(req,res)=>{
  if(req.method==='POST'){
   let text='';for await(const b of req)text+=b;const op=JSON.parse(text)
   if(op.operation==='publish'){
    const bytes=Buffer.from(op.bytes,'base64');const {readPackageArchive}=await import('./release-artifacts.mjs');const m=JSON.parse(readPackageArchive(bytes).find((f:any)=>f.path==='package.json')!.data.toString());writes.push('publish '+m.name)
    if(control.failCLI&&m.name===CLI){res.writeHead(503).end();return}
    versions.set(m.name+'@'+m.version,{name:m.name,version:m.version,bytes,integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')});control.onPublish?.(m)
    if(control.lostPublish){res.destroy();return}
   }else{writes.push('promote '+op.identity);const i=op.identity.lastIndexOf('@'),name=op.identity.slice(0,i),version=op.identity.slice(i+1);if(control.failPromoteCLI&&name===CLI){res.writeHead(503).end();return};tags.set(name,version);if(control.lostPromote){res.destroy();return}}
   res.end('ok');return
  }
  if(control.status){res.writeHead(control.status).end();return}
  const path=decodeURIComponent(req.url!).slice(1),last=path.lastIndexOf('/'),name=path.slice(0,last),part=path.slice(last+1)
  const version=part==='latest'?tags.get(name):part.replace(/\.tgz$/,'');const stored=versions.get(name+'@'+version)
  if(!stored){res.writeHead(404).end();return}
  if(part.endsWith('.tgz')){res.end(stored.bytes);return}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({name,version,dist:{integrity:control.conflict?'changed':stored.integrity,tarball:base+'/'+encodeURIComponent(name)+'/'+version+'.tgz'}}))
 })
 await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));base=`http://127.0.0.1:${(server.address() as any).port}`
 return {base,publisher,versions,tags,writes,control,close:()=>new Promise<void>(ok=>server.close(()=>ok()))}
}
function launchPair(p:{dir:string},r:{base:string,publisher:string},extra:string[]=['--publish','--promote']) {
 const child=spawn('node',[resolve('scripts/release-publish.mjs'),join(p.dir,'release-manifest.json'),'--rehearsal-registry',r.base,'--rehearsal-publisher',r.publisher,...extra],{env:process.env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b)
 return {child,result:new Promise<{code:number|null,output:string}>(ok=>child.on('close',code=>ok({code,output})))}
}
test('real publisher CLI persists dashboard-only and half-promotion, then resumes without republishing',async()=>{
 const p=await pairFixture(),r=await processRegistry()
 try {
  r.control.failCLI=true
  expect((await launchPair(p,r).result).code).toBe(2)
  let state=JSON.parse(await readFile(join(p.dir,'release-state.json'),'utf8'));expect(state.state).toBe('dashboard-present');expect(state.pending.name).toBe(CLI)
  r.control.failCLI=false;r.control.failPromoteCLI=true
  const half=await launchPair(p,r).result;expect(half.code).toBe(2)
  state=JSON.parse(await readFile(join(p.dir,'release-state.json'),'utf8'));expect(state.promotions[DASHBOARD].matching).toBe(true);expect(state.pending.name).toBe(CLI);expect(r.tags.get(DASHBOARD)).toBe('1.0.0');expect(r.tags.has(CLI)).toBe(false)
  r.control.failPromoteCLI=false;r.control.lostPromote=true
  const resumed=await launchPair(p,r).result;expect(resumed.code).toBe(0)
  expect(r.tags.get(CLI)).toBe('1.0.0');expect(r.writes.filter(x=>x==='publish '+DASHBOARD)).toHaveLength(1)
  state=JSON.parse(await readFile(join(p.dir,'release-state.json'),'utf8'));expect(state.state).toBe('promoted');expect(state.promotions[CLI].matching).toBe(true)
 }finally{await r.close()}
},30000)
test('real process interruption after first write reconciles exact bytes on restart',async()=>{
 const p=await pairFixture(),r=await processRegistry()
 try {
  const first=launchPair(p,r);r.control.onPublish=()=>first.child.kill('SIGKILL');await first.result
  expect(JSON.parse(await readFile(join(p.dir,'release-state.json'),'utf8')).pending.operation).toBe('publish')
  r.control.onPublish=null;r.control.lostPublish=true
  expect((await launchPair(p,r).result).code).toBe(0);expect(r.writes.filter(x=>x==='publish '+DASHBOARD)).toHaveLength(1)
 }finally{await r.close()}
},30000)
test('real CLI refuses missing or altered SBOM before registry writes and refuses local live mutation',async()=>{
 const p=await pairFixture(),r=await processRegistry()
 try {
  await writeFile(join(p.dir,'build-sbom.json'),'changed');expect((await launchPair(p,r).result).code).toBe(2);expect(r.writes).toEqual([])
  const good=await pairFixture();const {unlink}=await import('node:fs/promises');await unlink(join(good.dir,'cli-runtime-sbom.json'));expect((await launchPair(good,r).result).code).toBe(2);expect(r.writes).toEqual([])
  const {assertLivePublisher}=await import('./release-publish.mjs');expect(()=>assertLivePublisher({})).toThrow('serialized')
 }finally{await r.close()}
})
test('real CLI registry auth, outage and integrity conflict never create an absent version',async()=>{
 const p=await pairFixture(),r=await processRegistry()
 try {
  for(const status of [401,403,503]){r.control.status=status;expect((await launchPair(p,r).result).code).toBe(2)}expect(r.writes).toEqual([])
  r.control.status=0;r.control.failCLI=true;await launchPair(p,r).result;r.control.conflict=true
  const n=r.writes.length;expect((await launchPair(p,r).result).code).toBe(2);expect(r.writes).toHaveLength(n)
 }finally{await r.close()}
},30000)
test('actual fixture server failure stops first-use smoke before promotion',async()=>{
 const p=await pairFixture('1.0.0',true),r=await processRegistry()
 try{const result=await launchPair(p,r).result;expect(result.code).toBe(2);expect(result.output).toContain('readiness timeout');expect(r.tags.size).toBe(0);expect(JSON.parse(await readFile(join(p.dir,'release-state.json'),'utf8')).state).toBe('pair-present')}finally{await r.close()}
},30000)

test('one workflow queue covers interleaved version requests and the queued older CLI cannot roll latest backward',async()=>{
 const workflow=await readFile('.github/workflows/release.yml','utf8')
 // GitHub's external scheduler is represented by a single queue. The actual
 // workflow must select that same static key for EVERY version and retry.
 const group=/^  group: (.+)$/m.exec(workflow)?.[1];expect(group).toBe('vegafactory-paired-release');expect(workflow).toContain('  cancel-in-progress: false')
 const newer=await pairFixture('1.2.0'),older=await pairFixture('1.1.0'),r=await processRegistry()
 try {
  const active=launchPair(newer,r)
  // The older request arrives while the newer process is running; the workflow
  // scheduler queues it. Only the registry/npm boundary is a local fixture.
  const queued=active.result.then(()=>launchPair(older,r).result)
  expect((await active.result).code).toBe(0)
  const result=await queued;expect(result.code).toBe(2);expect(result.output).toContain('backward')
  expect(r.tags.get(CLI)).toBe('1.2.0');expect(r.tags.get(DASHBOARD)).toBe('1.2.0')
  expect(r.writes.some(x=>x.startsWith('promote ')&&x.endsWith('@1.1.0'))).toBe(false)
 }finally{await r.close()}
},30000)

test('metadata streams have an independent cap and live mutations cannot bypass the workflow through the default adapter',async()=>{
 const {registryClient}=await import('./release-publish.mjs');let cancelled=false
 const r=registryClient({fetcher:async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(1024*1024+1))},cancel(){cancelled=true}}))})
 expect(classifyRegistry(manifest.artifacts[0],await r.read(manifest.artifacts[0],'1.0.0'))).toBe('unavailable');expect(cancelled).toBe(true)
 await expect(registryClient({directory:'/fixture'}).publish(manifest.artifacts[0])).rejects.toThrow('serialized')
})
