// Registry mutations are explicit. A failed publication is reconciled by readback,
// never by treating an unavailable registry as an empty one.
import { readFile, writeFile, rename } from 'node:fs/promises'
import { resolve, dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLI, DASHBOARD, verifyArtifactBytes, verifyReleaseEvidence, smokePair, command } from './release-artifacts.mjs'
export function classifyRegistry(expected, observed) {
  if(observed?.status===200)return observed.integrity===expected.integrity?'matching':'conflict'
  if(observed?.status===404 && observed.definitive===true)return 'absent'
  return 'unavailable'
}
export async function publishPair(manifest, registry, {publish=false,promote=false,onState=async()=>{},previous}={}) {
  const artifacts=[DASHBOARD,CLI].map(name=>manifest.artifacts.find(a=>a.name===name))
  if(artifacts.some(a=>!a)||manifest.artifacts.length!==2)throw new Error('expected exactly dashboard and CLI')
  if(previous && (previous.version!==manifest.version || JSON.stringify(previous.artifacts)!==JSON.stringify(artifacts)))throw new Error('existing release state belongs to another immutable pair')
  const record={...previous,state:previous?.state??'prepared',version:manifest.version,artifacts,observations:{...previous?.observations},promotions:{...previous?.promotions}}
  const save=async patch=>{Object.assign(record,patch);await onState(structuredClone(record))}
  const check=async a=>{
    const observed=await registry.read(a,manifest.version);const status=classifyRegistry(a,observed)
    if(status==='matching' && (!observed.bytes || !verifyArtifactBytes(observed.bytes,a) || observed.bytes.length!==a.bytes))throw new Error(`registry payload mismatch: ${a.name}`)
    record.observations[a.name]=status
    if(status==='conflict'||status==='unavailable')throw new Error(`registry ${status}: ${a.name}`)
    return status
  }
  try {
    // Reconcile both immutable identities before replacing any previous progress.
    const initial=[];for(const a of artifacts)initial.push(await check(a))
    await save({error:null})
    for(let i=0;i<artifacts.length;i++) {
      const a=artifacts[i]
      if(initial[i]==='absent') {
        if(!publish)throw new Error('publication requires explicit --publish authorization')
        await save({pending:{operation:'publish',name:a.name}})
        let failure;try{await registry.publish(a,manifest.version)}catch(e){failure=e}
        if(await check(a)!=='matching')throw new Error(`publication not confirmed; preserve pair and resume after diagnosis: ${failure?.message??a.name}`)
      }
      await save({state:i===0?'dashboard-present':'pair-present',pending:null,lastCompleted:{operation:'publish-readback',name:a.name}})
    }
    await registry.smoke(manifest);await save({state:'smoked',lastCompleted:{operation:'smoke'}})
    if(promote) {
      for(const a of artifacts) {
        const observed=await registry.latest(a,manifest.version)
        record.promotions[a.name]=observed
        await save({pending:observed.matching?null:{operation:'promote',name:a.name}})
        if(!observed.matching) await registry.promote(a,manifest.version)
        const confirmed=await registry.latest(a,manifest.version)
        record.promotions[a.name]=confirmed
        if(!confirmed.matching)throw new Error(`promotion readback failed: ${a.name}`)
        await save({pending:null,lastCompleted:{operation:'promotion-readback',name:a.name}})
      }
      await save({state:'promoted'})
    }
    return {state:record.state,version:manifest.version}
  }catch(e){await save({error:e.message});throw e}
}
// Live operations have one supported entry point: the repository-wide serialized
// release job. Local recovery must rerun that job, retaining its immutable pair.
export function assertLivePublisher(env=process.env) {
  if(env.GITHUB_ACTIONS!=='true' || env.GITHUB_REPOSITORY!=='vegastack/vegafactory' ||
     env.GITHUB_JOB!=='publish' || env.GITHUB_WORKFLOW!=='Release' ||
     !env.GITHUB_WORKFLOW_REF?.startsWith('vegastack/vegafactory/.github/workflows/release.yml@refs/tags/v') ||
     !/^\d+$/.test(env.VEGAFACTORY_RETAINED_PAIR_ID??''))throw new Error('live publication requires the serialized Release workflow and retained pair; rerun that job for recovery')
}
export function compareVersions(a,b) {
  const parse=v=>{const m=/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);if(!m)throw new Error('invalid registry version');return {n:m.slice(1,4).map(Number),pre:m[4]?.split('.')}}
  const x=parse(a),y=parse(b)
  for(let i=0;i<3;i++)if(x.n[i]!==y.n[i])return x.n[i]>y.n[i]?1:-1
  if(!x.pre||!y.pre)return x.pre?-1:y.pre?1:0
  for(let i=0;i<Math.max(x.pre.length,y.pre.length);i++) {const p=x.pre[i],q=y.pre[i];if(p===q)continue;if(p===undefined)return -1;if(q===undefined)return 1;const pn=/^\d+$/.test(p),qn=/^\d+$/.test(q);if(pn&&qn)return p.length!==q.length?p.length>q.length?1:-1:p>q?1:-1;if(pn!==qn)return pn?-1:1;return p>q?1:-1}
  return 0
}
export function registryClient({directory,base='https://registry.npmjs.org',candidateTag='candidate',fetcher=fetch,run=command,smoke=smokePair,publisher}={}) {
  const origin=new URL(base)
  if(origin.username||origin.password)throw new Error('registry URL must not contain credentials')
  if(origin.protocol!=='https:' && !(origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname)))throw new Error('registry requires HTTPS (loopback fixtures excepted)')
  if(!/^[a-z][a-z0-9-]*$/.test(candidateTag)||candidateTag==='latest')throw new Error('candidate tag must be non-latest')
  if(publisher && (origin.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(origin.hostname) || !isAbsolute(publisher)))throw new Error('rehearsal publisher requires loopback HTTP and an absolute executable')
  const mutate=argv=>{if(!publisher && run===command)assertLivePublisher();return run([publisher??'npm',...argv],{timeout:120000})}
  async function get(url,limit=1024*1024,binary=false) {
    for(let attempt=0;attempt<3;attempt++) {
      let reader
      try {
        const r=await fetcher(url,{signal:AbortSignal.timeout(10000),redirect:'error'})
        if(r.status!==200){await r.body?.cancel();if((r.status>=500||r.status===429)&&attempt<2)continue;return {status:r.status,definitive:r.status===404}}
        const declared=r.headers.get('content-length')
        if(declared!==null && (!/^\d+$/.test(declared)||Number(declared)>limit)){await r.body?.cancel();return {status:0,error:'registry body exceeds limit'}}
        reader=r.body?.getReader();if(!reader)return {status:0,error:'missing registry body'}
        const chunks=[];let size=0
        for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();return {status:0,error:'registry body exceeds limit'}};chunks.push(value)}
        const bytes=Buffer.concat(chunks,size)
        return {status:200,...(binary?{bytes}:{data:JSON.parse(bytes.toString('utf8'))})}
      }catch(e){await reader?.cancel().catch(()=>{});if(attempt===2)return {status:0,error:e.message}}
      finally{reader?.releaseLock()}
    }
  }
  const latest=async(a,version)=>{
    const r=await get(new URL(`${encodeURIComponent(a.name)}/latest`,origin.href.endsWith('/')?origin.href:origin.href+'/'))
    if(r.status===404&&r.definitive)return {status:404,matching:false}
    if(r.status!==200 || r.data?.name!==a.name)throw new Error('latest lookup unavailable')
    if(compareVersions(r.data?.version,version)>0)throw new Error('refusing to move latest backward')
    if(r.data.version===version && r.data.dist?.integrity!==a.integrity)throw new Error('latest integrity conflict')
    return {status:200,version:r.data.version,integrity:r.data.dist?.integrity,matching:r.data.version===version}
  }
  return {
    async read(a,version) {
      const result=await get(new URL(`${encodeURIComponent(a.name)}/${encodeURIComponent(version)}`,origin.href.endsWith('/')?origin.href:origin.href+'/'))
      if(result.status!==200)return result
      const d=result.data?.dist
      if(result.data?.name!==a.name || result.data?.version!==version || !d?.tarball)return {status:200,integrity:null}
      if(d.integrity!==a.integrity)return {status:200,integrity:d.integrity}
      if(!Number.isSafeInteger(a.bytes)||a.bytes<1)throw new Error('invalid expected artifact size')
      const url=new URL(d.tarball)
      // Registry metadata cannot redirect a read to credentials or an arbitrary host.
      if(url.origin!==origin.origin||url.username||url.password)return {status:0,error:'tarball origin differs from registry'}
      const downloaded=await get(url,a.bytes,true)
      return downloaded.status===200?{status:200,integrity:d.integrity,bytes:downloaded.bytes}:{status:0,error:'version exists but payload download failed'}
    },
    async publish(a) {mutate(['publish',join(directory,a.file),'--ignore-scripts','--access','public','--no-provenance','--tag',candidateTag,'--registry',base])},
    async smoke(manifest) {
      // Isolate actual readback bytes from the retained candidate files.
      const {mkdtemp}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const dir=await mkdtemp(join(tmpdir(),'registry-pair-'))
      for(const a of manifest.artifacts){const r=await this.read(a,manifest.version);if(classifyRegistry(a,r)!=='matching'||!r.bytes||!verifyArtifactBytes(r.bytes,a))throw new Error('registry changed before smoke');await writeFile(join(dir,a.file),r.bytes)}
      await smoke(manifest,dir)
    },
    latest,
    async promote(a,version) {
      if((await latest(a,version)).matching)return
      let failure
      try{mutate(['dist-tag','add',`${a.name}@${version}`,'latest','--registry',base])}catch(e){failure=e}
      // A lost subprocess response may have changed the tag. Always read it back.
      if(!(await latest(a,version)).matching)throw new Error(`promotion readback failed: ${a.name}: ${failure?.message??'not observed'}`)
    },
  }
}
async function main() {
  const args=process.argv.slice(2);const path=resolve(args[0]??'work/release/release-manifest.json');const directory=dirname(path)
  const manifest=JSON.parse(await readFile(path,'utf8'));await verifyReleaseEvidence(manifest,directory)
  let previous
  try {previous=JSON.parse(await readFile(join(directory,'release-state.json'),'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
  const option=name=>{const i=args.indexOf(name);if(i<0)return undefined;if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`missing ${name}`);return args[i+1]}
  const base=option('--rehearsal-registry'),publisher=option('--rehearsal-publisher')
  if(Boolean(base)!==Boolean(publisher))throw new Error('rehearsal requires both loopback registry and explicit publisher executable')
  if(!base && (args.includes('--publish')||args.includes('--promote'))) {
    assertLivePublisher()
    if(manifest.sourceSha!==process.env.GITHUB_SHA || `v${manifest.version}`!==process.env.GITHUB_REF_NAME)throw new Error('retained pair differs from authorized workflow source/tag')
  }
  if(previous && (previous.sourceSha!==manifest.sourceSha || previous.treeSha!==manifest.treeSha))throw new Error('previous release observations belong to another source')
  const registry=registryClient({directory,...(base?{base,publisher}:{}),candidateTag:`candidate-${manifest.version.replaceAll('.','-')}`})
  return publishPair(manifest,registry,{previous,publish:args.includes('--publish'),promote:args.includes('--promote'),onState:async state=>{const target=join(directory,'release-state.json');await writeFile(target+'.tmp',JSON.stringify({...state,sourceSha:manifest.sourceSha,treeSha:manifest.treeSha},null,2)+'\n');await rename(target+'.tmp',target)}})
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=2})
