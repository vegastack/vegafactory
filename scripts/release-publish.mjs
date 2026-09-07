// Registry mutations are explicit. A failed publication is reconciled by readback,
// never by treating an unavailable registry as an empty one.
import { readFile, writeFile, rename } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLI, DASHBOARD, verifyArtifactBytes, verifyPair, smokePair, command } from './release-artifacts.mjs'
export function classifyRegistry(expected, observed) {
  if(observed?.status===200)return observed.integrity===expected.integrity?'matching':'conflict'
  if(observed?.status===404 && observed.definitive===true)return 'absent'
  return 'unavailable'
}
export async function publishPair(manifest, registry, {publish=false,promote=false,onState=async()=>{}}={}) {
  const artifacts=[DASHBOARD,CLI].map(name=>manifest.artifacts.find(a=>a.name===name))
  if(artifacts.some(a=>!a)||manifest.artifacts.length!==2)throw new Error('expected exactly dashboard and CLI')
  let state='prepared';await onState({state,version:manifest.version,artifacts})
  const check=async a=>{
    const observed=await registry.read(a,manifest.version);const status=classifyRegistry(a,observed)
    if(status==='matching' && (!observed.bytes || !verifyArtifactBytes(observed.bytes,a) || observed.bytes.length!==a.bytes))throw new Error(`registry payload mismatch: ${a.name}`)
    if(status==='conflict'||status==='unavailable')throw new Error(`registry ${status}: ${a.name}`)
    return status
  }
  // Inspect both before either write so a CLI conflict cannot strand a new dashboard.
  const initial=[];for(const a of artifacts)initial.push(await check(a))
  for(let i=0;i<artifacts.length;i++) {
    const a=artifacts[i]
    if(initial[i]==='absent') {
      if(!publish)throw new Error('publication requires explicit --publish authorization')
      let failure;try{await registry.publish(a,manifest.version)}catch(e){failure=e}
      const after=await check(a)
      if(after!=='matching')throw new Error(`publication not confirmed; preserve pair and resume after diagnosis: ${failure?.message??a.name}`)
    }
    state=i===0?'dashboard-present':'pair-present';await onState({state,version:manifest.version,artifacts})
  }
  // Downloaded payloads have been checked against local bytes; repeat first use on them.
  await registry.smoke(manifest);state='smoked';await onState({state,version:manifest.version,artifacts})
  if(promote) {
    for(const a of artifacts)await registry.promote(a,manifest.version)
    state='promoted';await onState({state,version:manifest.version,artifacts})
  }
  return {state,version:manifest.version}
}
export function compareVersions(a,b) {
  const parse=v=>{const m=/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);if(!m)throw new Error('invalid registry version');return {n:m.slice(1,4).map(Number),pre:m[4]?.split('.')}}
  const x=parse(a),y=parse(b)
  for(let i=0;i<3;i++)if(x.n[i]!==y.n[i])return x.n[i]>y.n[i]?1:-1
  if(!x.pre||!y.pre)return x.pre?-1:y.pre?1:0
  for(let i=0;i<Math.max(x.pre.length,y.pre.length);i++) {const p=x.pre[i],q=y.pre[i];if(p===q)continue;if(p===undefined)return -1;if(q===undefined)return 1;const pn=/^\d+$/.test(p),qn=/^\d+$/.test(q);if(pn&&qn)return Number(p)>Number(q)?1:-1;if(pn!==qn)return pn?-1:1;return p>q?1:-1}
  return 0
}
export function registryClient({directory,base='https://registry.npmjs.org',candidateTag='candidate',fetcher=fetch,run=command,smoke=smokePair}={}) {
  const origin=new URL(base)
  if(origin.protocol!=='https:' && !(origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname)))throw new Error('registry requires HTTPS (loopback fixtures excepted)')
  if(!/^[a-z][a-z0-9-]*$/.test(candidateTag)||candidateTag==='latest')throw new Error('candidate tag must be non-latest')
  async function get(url,binary=false) {
    for(let attempt=0;attempt<3;attempt++) {
      try {
        const r=await fetcher(url,{signal:AbortSignal.timeout(10000),redirect:'error'})
        if(r.status>=500||r.status===429){if(attempt<2)continue;return {status:r.status}}
        if(r.status!==200)return {status:r.status,definitive:r.status===404}
        return {status:200,...(binary?{bytes:Buffer.from(await r.arrayBuffer())}:{data:await r.json()})}
      }catch(e){if(attempt===2)return {status:0,error:e.message}}
    }
  }
  return {
    async read(a,version) {
      const result=await get(new URL(`${encodeURIComponent(a.name)}/${encodeURIComponent(version)}`,origin.href.endsWith('/')?origin.href:origin.href+'/'))
      if(result.status!==200)return result
      const d=result.data?.dist
      if(result.data?.name!==a.name || result.data?.version!==version || !d?.tarball)return {status:200,integrity:null}
      const url=new URL(d.tarball)
      // Registry metadata cannot redirect a read to credentials or an arbitrary host.
      if(url.origin!==origin.origin||url.username||url.password)return {status:0,error:'tarball origin differs from registry'}
      const downloaded=await get(url,true)
      return downloaded.status===200?{status:200,integrity:d.integrity,bytes:downloaded.bytes}:{status:0,error:'version exists but payload download failed'}
    },
    async publish(a) {run(['npm','publish',join(directory,a.file),'--ignore-scripts','--access','public','--no-provenance','--tag',candidateTag,'--registry',base],{timeout:120000})},
    async smoke(manifest) {
      // Isolate actual readback bytes from the retained candidate files.
      const {mkdtemp}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const dir=await mkdtemp(join(tmpdir(),'registry-pair-'))
      for(const a of manifest.artifacts){const r=await this.read(a,manifest.version);if(classifyRegistry(a,r)!=='matching'||!r.bytes||!verifyArtifactBytes(r.bytes,a))throw new Error('registry changed before smoke');await writeFile(join(dir,a.file),r.bytes)}
      await smoke(manifest,dir)
    },
    async promote(a,version) {
      const current=await get(new URL(`${encodeURIComponent(a.name)}/latest`,origin.href.endsWith('/')?origin.href:origin.href+'/'))
      if(current.status!==200 && !(current.status===404 && current.definitive))throw new Error('latest lookup unavailable')
      if(current.status===200 && compareVersions(current.data?.version,version)>0)throw new Error('refusing to move latest backward')
      run(['npm','dist-tag','add',`${a.name}@${version}`,'latest','--registry',base],{timeout:120000})
      const r=await get(new URL(`${encodeURIComponent(a.name)}/latest`,origin.href.endsWith('/')?origin.href:origin.href+'/'))
      if(r.status!==200||r.data?.version!==version||r.data?.dist?.integrity!==a.integrity)throw new Error(`promotion readback failed: ${a.name}`)
    },
  }
}
async function main() {
  const args=process.argv.slice(2);const path=resolve(args[0]??'work/release/release-manifest.json');const directory=dirname(path)
  const manifest=JSON.parse(await readFile(path,'utf8'));await verifyPair(manifest,directory)
  if(!manifest.checkEvidence?.ok||!manifest.scanEvidence?.ok||!manifest.platformMatrix?.length)throw new Error('release verification evidence missing')
  for(const e of [manifest.checkEvidence,manifest.scanEvidence])if(!verifyArtifactBytes(await readFile(join(directory,e.file)),e))throw new Error('release evidence changed')
  try {const previous=JSON.parse(await readFile(join(directory,'release-state.json'),'utf8'));if(previous.version!==manifest.version||JSON.stringify(previous.artifacts)!==JSON.stringify([DASHBOARD,CLI].map(name=>manifest.artifacts.find(a=>a.name===name))))throw new Error('existing release state belongs to another immutable pair')}catch(e){if(e.code!=='ENOENT')throw e}
  const registry=registryClient({directory,candidateTag:`candidate-${manifest.version.replaceAll('.','-')}`})
  return publishPair(manifest,registry,{publish:args.includes('--publish'),promote:args.includes('--promote'),onState:async state=>{const target=join(directory,'release-state.json');await writeFile(target+'.tmp',JSON.stringify({...state,sourceSha:manifest.sourceSha,treeSha:manifest.treeSha},null,2)+'\n');await rename(target+'.tmp',target)}})
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=2})
