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
