import { expect, test } from 'bun:test'
import { classifyRegistry, publishPair } from './release-publish.mjs'
import { createHash } from 'node:crypto'
const artifact=(name:string)=>{const bytes=Buffer.from(name);return {name,file:name.replaceAll('/','-').replace('@','')+'.tgz',sha256:createHash('sha256').update(bytes).digest('hex'),integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64'),bytes:bytes.length}}
const manifest={version:'1.0.0',artifacts:[artifact('@vegastack/vegafactory-dashboard'),artifact('@vegastack/vegafactory')]}
function registry(){const existing=new Map<string,any>();const calls:string[]=[];return {existing,calls,read:async(a:any)=>existing.has(a.name)?{status:200,integrity:existing.get(a.name).integrity,bytes:Buffer.from(a.name)}:{status:404,definitive:true},publish:async(a:any)=>{calls.push(a.name);existing.set(a.name,a)},smoke:async()=>{calls.push('smoke')},promote:async(a:any)=>{calls.push('promote '+a.name)}}}
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
 const r=registryClient({fetcher:async()=>Response.json({version:'2.0.0'}),run:()=>{mutations++;return ''}})
 await expect(r.promote(manifest.artifacts[0],'1.0.0')).rejects.toThrow('backward');expect(mutations).toBe(0)
})

test('loopback HTTP registry and subprocess publication recover a lost response',async()=>{
 const {createServer}=await import('node:http');const {registryClient}=await import('./release-publish.mjs');const {spawnSync}=await import('node:child_process')
 const stored=new Map<string,any>();let origin='';const calls:string[][]=[]
 const server=createServer((req,res)=>{
   const path=decodeURIComponent(req.url!);const a=manifest.artifacts.find(a=>path===`/${a.name}/1.0.0`||path===`/${a.name}/file.tgz`)
   if(!a||!stored.has(a.name)){res.writeHead(404).end();return}
   if(path.endsWith('/file.tgz')){res.end(Buffer.from(a.name));return}
   res.setHeader('content-type','application/json');res.end(JSON.stringify({name:a.name,version:'1.0.0',dist:{integrity:a.integrity,tarball:`${origin}/${a.name}/file.tgz`}}))
 })
 await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));origin=`http://127.0.0.1:${(server.address() as any).port}`
 try {
   const client=registryClient({base:origin,directory:'/fixture',smoke:async()=>({ok:true}),run:(args:string[],options:any)=>{
     calls.push(args);expect(options.timeout).toBe(120000);expect(args).toContain('--ignore-scripts');expect(args).toContain('--tag');expect(args).not.toContain('latest')
     const result=spawnSync(process.execPath,['-e','process.stdout.write("fixture publish")']);expect(result.status).toBe(0)
     const a=manifest.artifacts.find(a=>args.includes('/fixture/'+a.file))!;stored.set(a.name,a);throw new Error('response lost')
   }})
   expect((await publishPair(manifest,client,{publish:true})).state).toBe('smoked');expect(calls).toHaveLength(2)
 }finally{await new Promise<void>(ok=>server.close(()=>ok()))}
})
