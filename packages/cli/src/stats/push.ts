// Immutable destination-bound transport. Only exact remote bytes prove delivery.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { canonicalJson, destinationId, destinationKey, eventPath, hashBytes, serializeExport, validateDestination, UUID, type Destination, type SpoolEnvelope, type ExportSerializer } from './types.ts'
import { open, rm, lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { listOutbox, inspectSpool, spoolRoot, readSpoolJson, writeSpoolJson, withSpoolClaim, quarantineSpool, spoolEventFile, legacyMigrationComplete, type OutboxBatch } from './outbox.ts'
import { repoSegment, type StatsRecord } from './record.ts'

export interface GitOptions { input?: string; env?: Record<string,string> }
export type GitRunner = (args: string[], cwd: string, options?: GitOptions) => Promise<{ code: number; stdout: string; stderr: string }>

// Legacy planning never authorizes export; metadata contains no local identity.
export function commitSubject(batches: OutboxBatch[], _options: {ghUser:string;hostname:string}): string { return `stats: ${crypto.randomUUID()} ${batches.reduce((n,b)=>n+b.records.length,0)} events` }
export function commitBody(_records: StatsRecord[]): string { return '' }

export interface PushPlan {
  copies: { from: string; to: string; lines: number }[]
  subject: string
  body: string
  refusals: string[]
}

// The stats working copy is deliberately NOT #120's read-only clone: `vegafactory sync` refreshes
// that one with `git reset --hard`, which would eat records that are committed but not yet pushed.
export function statsClonePath(home: string, org: string): string {
  return join(home, '.vegastack', 'stats', 'control-room', org)
}

export function controlRoomStatsPath(cloneRoot: string, repo: string, month: string, hostname: string): string {
  return join(cloneRoot, 'stats', repoSegment(repo), month, `${hostname}.jsonl`)
}

export function planPush(batches: OutboxBatch[], _cloneRoot: string, options: { ghUser: string; hostname: string }): PushPlan {
  return {copies:[],subject:commitSubject(batches,options),body:'',refusals:batches.length?['legacy-spool-requires-explicit-migration: stats migrate --json']:[]}
}

export interface PushResult {
  ok: boolean
  pushed: number
  retries: number
  deferred: string[]
  refusals: string[]
  // Another push on this machine held the lock; nothing was touched and the outbox will be
  // replayed by the next attempt.
  locked: boolean
}

// PID-only predecessor locks are preserved and refused; #137 owns every new claim.
export function pushLockPath(home: string): string { return join(home,'.vegastack','stats','push.lock') }

export interface DeliveryAttempt { batchId:string; operationId:string; bytes:string; attemptHash:string; policyDigest:string; preparedAt:string }
export interface DeliveryReceipt {eventId:string;destination:Destination;remoteCommit:string;payloadSha256:string;attemptHash:string;policyDigest:string;acknowledgedAt:string;localPayloadDigest:string}
export interface TelemetryEffects {
  beforeSend(event:SpoolEnvelope,attempt:DeliveryAttempt):Promise<void>
  afterReadback(event:SpoolEnvelope,attempt:DeliveryAttempt,remoteCommit:string):Promise<void>
}
export interface PushOptions {
  home:string; cloneRoot:string; ghUser:string; hostname:string; commit:boolean; git:GitRunner; maxRetries?:number
  destination?:Destination; serialize?:ExportSerializer; effects?:TelemetryEffects; retention?:DeliveredRetentionController; wait?:(ms:number)=>Promise<void>; now?:()=>Date
}
export function matchesDestination(destination: Destination, remote: string): boolean {
  try {
    validateDestination(destination)
    let repository: string | undefined
    const ssh = /^git@github\.com:([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+?)(?:\.git)?$/.exec(remote)
    const https = /^https:\/\/github\.com\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+?)(?:\.git)?$/.exec(remote)
    const sshUrl = /^ssh:\/\/git@github\.com\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+?)(?:\.git)?$/.exec(remote)
    repository = (ssh?.[1] ?? https?.[1] ?? sshUrl?.[1])?.toLowerCase()
    return repository === destination.controlRoom
  } catch { return false }
}
const attemptFile = (root:string,e:SpoolEnvelope):string => join(root,'attempts',destinationId(e.destination),e.eventId+'.json')
export const receiptFile = (root:string,e:Pick<SpoolEnvelope,'destination'|'eventId'>):string => join(root,'receipts',destinationId(e.destination),e.eventId+'.json')
const suppressionFile = (root:string,e:SpoolEnvelope):string => join(root,'suppressed',destinationId(e.destination),e.eventId+'.json')
async function history(root:string,event:SpoolEnvelope):Promise<DeliveryAttempt[]> {
  const attempts=await readSpoolJson<DeliveryAttempt[]>(attemptFile(root,event)) ?? []
  if(!Array.isArray(attempts)||attempts.length>1000||attempts.some(a=>!UUID.test(a.batchId)||!UUID.test(a.operationId)||typeof a.bytes!=='string'||Buffer.byteLength(a.bytes)>1024*1024||hashBytes(a.bytes)!==a.attemptHash||!/^[a-f0-9]{64}$/.test(a.policyDigest)||!Number.isFinite(Date.parse(a.preparedAt))))throw Error('invalid-attempt-history')
  return attempts
}
export async function readDeliveryReceipt(root:string,event:SpoolEnvelope):Promise<DeliveryReceipt|null> {
  const receipt=await readSpoolJson<DeliveryReceipt>(receiptFile(root,event))
  if(receipt&&(receipt.eventId!==event.eventId||destinationKey(receipt.destination)!==destinationKey(event.destination)||receipt.localPayloadDigest!==hashBytes(canonicalJson(event.payload))||!/^[a-f0-9]{40}$/.test(receipt.remoteCommit)||receipt.payloadSha256!==receipt.attemptHash||!/^[a-f0-9]{64}$/.test(receipt.attemptHash)||!/^[a-f0-9]{64}$/.test(receipt.policyDigest)||!Number.isFinite(Date.parse(receipt.acknowledgedAt))))throw Error('invalid-delivery-receipt')
  return receipt
}
const telemetryIdentity = {GIT_AUTHOR_NAME:'VegaFactory telemetry',GIT_AUTHOR_EMAIL:'telemetry@example.invalid',GIT_COMMITTER_NAME:'VegaFactory telemetry',GIT_COMMITTER_EMAIL:'telemetry@example.invalid'}
export async function pushOutbox(options:PushOptions):Promise<PushResult>{
  const root=spoolRoot(options.home),inspection=await inspectSpool(root),legacy=await listOutbox(options.home)
  const result:PushResult={ok:true,pushed:0,retries:0,deferred:[],refusals:[],locked:false}
  if((await Promise.all(legacy.map(batch=>legacyMigrationComplete(root,batch.file)))).some(done=>!done))result.refusals.push('legacy-spool-requires-explicit-migration: stats migrate --json')
  if(inspection.quarantine.length)result.refusals.push(`spool-quarantine:${inspection.quarantine.length}; stats inspect --json`)
  if(!options.commit){result.deferred=inspection.events.map(e=>e.eventId);result.ok=!result.refusals.length;return result}
  try{await lstat(pushLockPath(options.home));result.locked=true;throw Error('legacy-push-lock-requires-inspection')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT'){result.refusals.push((e as Error).message);result.ok=false;return result}}
  if(!inspection.events.length){result.ok=!result.refusals.length;return result}
  const now=options.now??(()=>new Date()),wait=options.wait??(ms=>new Promise(r=>setTimeout(r,ms))),effects=options.effects??configuredTelemetryEffects(options.home)
  const run=async(args:string[],extra?:GitOptions):Promise<string>=>{
    const value=await options.git(['-c','http.followRedirects=false','-c','commit.gpgSign=false',...args],options.cloneRoot,extra)
    if(value.code!==0)throw Error('telemetry-git-'+(args[0]??'operation')+'-failed')
    return value.stdout.trimEnd()
  }
  try{return await withSpoolClaim(root,'writer:'+resolve(options.cloneRoot),async()=>{
    // Never repair/reset a dirty or divergent checkout. Our private index does not alter it.
    if(await run(['status','--porcelain=v1','--untracked-files=all']))throw Error('writer-dirty-preserved: inspect the dedicated writer checkout')
    const rewrites=await options.git(['config','--get-regexp','^url\\..*\\.(insteadof|pushinsteadof)$'],options.cloneRoot)
    if(rewrites.code===0&&rewrites.stdout.trim())throw Error('writer-url-rewrite-refused')
    if(![0,1].includes(rewrites.code))throw Error('writer-url-policy-unavailable')
    const configuredRemote=(await run(['config','--get-all','remote.origin.url'])).trim()
    const selected=inspection.events.filter(e=>options.destination?destinationKey(e.destination)===destinationKey(options.destination):matchesDestination(e.destination,configuredRemote))
    if(options.destination&&!matchesDestination(options.destination,configuredRemote))throw Error('writer-destination-mismatch')
    if(!selected.length)throw Error('writer-has-no-matching-destination')
    for(const event of selected)if(!matchesDestination(event.destination,configuredRemote))throw Error('writer-destination-mismatch')
    // Transport always uses canonical HTTPS, so SSH HostName aliases cannot redirect delivery.
    const remote='https://github.com/'+selected[0]!.destination.controlRoom+'.git'
    const defaultRef=(await run(['ls-remote','--symref',remote,'HEAD'])).split('\n').map(line=>/^ref: (refs\/heads\/[A-Za-z0-9._/-]+)\tHEAD$/.exec(line)?.[1]).find(Boolean)
    if(!defaultRef||defaultRef.includes('..')||defaultRef.includes('//'))throw Error('writer-default-ref-unavailable')
    const tracking='refs/vegafactory/telemetry/'+hashBytes(remote).slice(0,32)
    const refresh=async():Promise<string>=>{
      await run(['fetch','--no-tags','--no-recurse-submodules',remote,`+${defaultRef}:${tracking}`])
      const head=(await run(['rev-parse',tracking])).trim()
      if(!/^[a-f0-9]{40}$/.test(head))throw Error('remote-commit-unavailable')
      await run(['merge-base','--is-ancestor','HEAD',head]).catch(()=>{throw Error('writer-diverged-preserved: inspect local HEAD and remote; no reset performed')})
      return head
    }
    const remoteBytes=async(commit:string,event:SpoolEnvelope):Promise<string|null>=>{
      const path=eventPath(event),entry=await run(['ls-tree','-z',commit,'--',path])
      if(entry==='')return null
      if(!/^100644 blob [a-f0-9]{40}\t/.test(entry)||entry.split('\0').filter(Boolean).length!==1)throw Error('remote-event-not-regular')
      // Keep bytes, including final newline, exactly as Git returned them.
      const read=await options.git(['show',`${commit}:${path}`],options.cloneRoot)
      if(read.code!==0||Buffer.byteLength(read.stdout)>1024*1024)throw Error('remote-event-read-unavailable')
      return read.stdout
    }
    const acknowledge=async(event:SpoolEnvelope,attempt:DeliveryAttempt,commit:string):Promise<void>=>{
      await effects.afterReadback(event,attempt,commit)
      const receipt:DeliveryReceipt={eventId:event.eventId,destination:event.destination,remoteCommit:commit,payloadSha256:attempt.attemptHash,attemptHash:attempt.attemptHash,policyDigest:attempt.policyDigest,acknowledgedAt:now().toISOString(),localPayloadDigest:hashBytes(canonicalJson(event.payload))}
      await writeSpoolJson(receiptFile(root,event),receipt)
      result.pushed++
    }
    let pending:SpoolEnvelope[]=[]
    for(const event of selected){
      if(await readDeliveryReceipt(root,event))continue
      const suppressed=await readSpoolJson<{localPayloadDigest:string}>(suppressionFile(root,event))
      if(suppressed){if(suppressed.localPayloadDigest!==hashBytes(canonicalJson(event.payload)))throw Error('suppressed-payload-conflict');if(!(await history(root,event)).length)continue}
      pending.push(event)
    }
    const max=Math.min(3,Math.max(1,options.maxRetries??3))
    for(let count=0;count<max&&pending.length;count++){
      const remoteHead=await refresh(),batchId=randomUUID(),prepared:Array<{event:SpoolEnvelope;attempt:DeliveryAttempt}>=[]
      const next:SpoolEnvelope[]=[]
      for(const event of pending){
        try{
          const attempts=await history(root,event),bytes=await remoteBytes(remoteHead,event)
          if(bytes!==null){
            const previous=attempts.find(a=>a.attemptHash===hashBytes(bytes)&&a.bytes===bytes)
            if(!previous){await quarantineSpool(root,event.eventId,'remote-event-payload-conflict',Buffer.byteLength(bytes),'inspect exact remote event and retained sanitized attempts; do not overwrite the published event');throw Error('remote-event-payload-conflict')}
            await acknowledge(event,previous,remoteHead);continue
          }
          // A suppressed variant with historical attempts still reconciles possible late delivery,
          // but never repeatedly serializes or invents a remote acknowledgment.
          if(await readSpoolJson(suppressionFile(root,event)))continue
          // The exact remote path is absent. Only now may current policy produce new bytes.
          const serialized=await(options.serialize??serializeExport)(event)
          if(serialized===null){
            if(event.payload.recordKind==='execution')throw Error('execution-suppression-requires-owner-disposition')
            await writeSpoolJson(suppressionFile(root,event),{eventId:event.eventId,localPayloadDigest:hashBytes(canonicalJson(event.payload)),disposition:'policy-suppressed',recordedAt:now().toISOString()});continue
          }
          if(typeof serialized.bytes!=='string'||Buffer.byteLength(serialized.bytes)>1024*1024||!/^[a-f0-9]{64}$/.test(serialized.policyDigest))throw Error('invalid-serialized-export')
          JSON.parse(serialized.bytes)
          const attempt:DeliveryAttempt={batchId,operationId:randomUUID(),bytes:serialized.bytes,attemptHash:hashBytes(serialized.bytes),policyDigest:serialized.policyDigest,preparedAt:now().toISOString()}
          await writeSpoolJson(attemptFile(root,event),[...attempts,attempt])
          prepared.push({event,attempt});next.push(event)
        }catch(error){result.refusals.push((error as Error).message);result.deferred.push(event.eventId)}
      }
      pending=next
      if(!prepared.length)break
      const index=join(root,'git-index-'+randomUUID())
      const gitOptions:GitOptions={env:{...telemetryIdentity,GIT_INDEX_FILE:index}}
      try{
        await run(['read-tree',remoteHead],gitOptions)
        for(const {event,attempt}of prepared){
          const blob=(await run(['hash-object','-w','--stdin'],{...gitOptions,input:attempt.bytes})).trim()
          if(!/^[a-f0-9]{40}$/.test(blob))throw Error('invalid-git-blob')
          await run(['update-index','--add','--cacheinfo',`100644,${blob},${eventPath(event)}`],gitOptions)
        }
        const tree=(await run(['write-tree'],gitOptions)).trim()
        const commit=(await run(['commit-tree',tree,'-p',remoteHead,'-m',`stats: ${batchId} ${prepared.length} events`],gitOptions)).trim()
        if(!/^[a-f0-9]{40}$/.test(commit))throw Error('invalid-git-commit')
        await writeSpoolJson(join(root,'batches',batchId+'.json'),{batchId,remote,base:remoteHead,commit,events:prepared.map(({event,attempt})=>({eventId:event.eventId,attemptHash:attempt.attemptHash}))})
        for(const {event,attempt}of prepared)await effects.beforeSend(event,attempt)
        // One exact non-force ref push; unknown response is reconciled below, never acknowledged.
        await options.git(['-c','http.followRedirects=false','push','--no-follow-tags','--recurse-submodules=no',remote,`${commit}:${defaultRef}`],options.cloneRoot)
        const observed=await refresh(),remaining:SpoolEnvelope[]=[]
        for(const {event,attempt}of prepared){const bytes=await remoteBytes(observed,event);if(bytes===attempt.bytes)await acknowledge(event,attempt,observed);else remaining.push(event)}
        pending=remaining
      }finally{await rm(index,{force:true})}
      if(pending.length){result.retries++;await wait([1000,2000,4000][count]!)}
    }
    result.deferred.push(...pending.map(e=>e.eventId))
    result.ok=!result.refusals.length&&!result.deferred.length
    await cleanupDelivered(root,{now:now(),controller:options.retention})
    await cleanupBasicLogs(options.home,now())
    return result
  },0)}catch(error){
    result.refusals.push((error as Error).message)
    result.locked=(error as Error).message.includes('spool-claim-unavailable')
    result.deferred.push(...inspection.events.filter(e=>!result.deferred.includes(e.eventId)).map(e=>e.eventId))
    result.ok=false;return result
  }
}

// Production controller consumes canonical #137/#138 records without inventing provenance.
// Fixtures may inject this interface to exercise Git transport without qualifying vendor effects.
export function configuredTelemetryEffects(home:string):TelemetryEffects {
  const context=async(event:SpoolEnvelope)=>{
    if(!event.captureKey.match(/^[a-f0-9-]{36}:terminal:0$/i))return null // migrated/activity records have no managed run
    const runtime=await import('../runs.ts'),runId=event.captureKey.slice(0,36)
    const run=await runtime.readRun(runtime.runsRoot(home),runId)
    if(run.repo!==event.destination.repo)throw Error('telemetry-run-destination-mismatch')
    if(!run.sharedClaim)return null
    const {loadFactoryConfig}=await import('../config.ts'),config=await loadFactoryConfig(join(home,'.vegastack','factory.json'),home)
    await runtime.verifyRunAuthority(run,config)
    const claim=await(await import('../dispatch.ts')).sharedClaimForRun(run,config)
    if(claim.target.repository!==event.destination.controlRoom)throw Error('telemetry-destination-proof-unavailable')
    return{runtime,run,claim}
  }
  return{
    async beforeSend(event,attempt){
      const c=await context(event);if(!c)return
      const effect:Omit<import('../shared-claims.ts').EffectRef,'intent'|'outcome'|'state'>={operationId:attempt.operationId,runId:c.run.runId,generation:c.claim.generation,kind:'telemetry-push',payloadDigest:attempt.attemptHash,target:{kind:'telemetry',destinationRepositoryId:c.claim.target.repositoryId,destinationPath:eventPath(event),eventId:event.eventId,batchId:attempt.batchId}}
      c.run=await c.runtime.updateRun(c.runtime.runsRoot(home),c.run.runId,r=>{
        const existing=r.pendingDelivery.find(p=>p.id===attempt.operationId)
        if(existing){if(existing.payload!==attempt.bytes||existing.payloadDigest!==attempt.attemptHash)throw Error('telemetry-attempt-rebound');return{}}
        return{pendingDelivery:[...r.pendingDelivery,{id:attempt.operationId,kind:'telemetry-capture',target:{captureKey:`${r.runId}:telemetry-export:${event.eventId}:${attempt.operationId}`},intentRef:null,status:'pending',attempts:0,lastError:null,payload:attempt.bytes,payloadDigest:attempt.attemptHash,approvalBindings:r.approvalBindings}]}
      })
      await c.runtime.prepareManagedRunEffect({claim:c.claim,run:c.run,effect})
    },
    async afterReadback(event,attempt,remoteCommit){
      const c=await context(event);if(!c)return
      await c.runtime.acknowledgeManagedRunEffect({claim:c.claim,run:c.run,effectId:attempt.operationId,observedRemoteId:remoteCommit,observedDigest:attempt.attemptHash})
      await c.runtime.updateRun(c.runtime.runsRoot(home),c.run.runId,r=>({pendingDelivery:r.pendingDelivery.map(p=>p.id===attempt.operationId?{...p,status:'acknowledged',lastError:null}:p)}))
    },
  }
}

export function boundedTelemetryGit(prefix: readonly string[] = []): GitRunner {
  return (args,cwd,options) => new Promise(resolveGit => {
    const env:NodeJS.ProcessEnv = {...process.env,...options?.env,GIT_TERMINAL_PROMPT:'0'}
    for(const name of ['GIT_DIR','GIT_WORK_TREE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS'])delete env[name]
    if(!options?.env?.GIT_INDEX_FILE)delete env.GIT_INDEX_FILE
    const child=spawn('git',[...prefix,...args],{cwd,env,stdio:['pipe','pipe','pipe'],timeout:30000,killSignal:'SIGKILL'})
    let stdout='',stderr='',overflow=false
    const collect=(value:string,chunk:Buffer)=>{const next=value+chunk.toString();if(Buffer.byteLength(next)>2*1024*1024){overflow=true;child.kill('SIGKILL');return value}return next}
    child.stdout.on('data',(chunk:Buffer)=>{stdout=collect(stdout,chunk)})
    child.stderr.on('data',(chunk:Buffer)=>{stderr=collect(stderr,chunk)})
    child.stdin.on('error',()=>{})
    child.stdin.end(options?.input??'')
    child.once('error',()=>resolveGit({code:1,stdout,stderr:'git-process-unavailable'}))
    child.once('close',code=>resolveGit({code:overflow?1:code??1,stdout,stderr}))
  })
}

export interface DeliveredRetentionController {
  // #149 supplies current disk/privacy policy and active-record protection. The callback
  // performs separately authorized active-file removal, never purports to erase Git history.
  active(event:SpoolEnvelope):Promise<boolean>
  removeActiveReport(event:SpoolEnvelope,receipt:DeliveryReceipt):Promise<void>
}
export async function cleanupDelivered(root:string,options:{now?:Date;controller?:DeliveredRetentionController}={}):Promise<{removed:number;protected:number}>{
  const now=options.now??new Date(),cutoff=new Date(now);cutoff.setUTCFullYear(cutoff.getUTCFullYear()-1)
  const result={removed:0,protected:0}
  for(const event of (await inspectSpool(root)).events){
    const receipt=await readDeliveryReceipt(root,event)
    if(!receipt||Math.max(Date.parse(receipt.acknowledgedAt),Date.parse(event.payload.utcDay))>cutoff.getTime()){result.protected++;continue}
    await withSpoolClaim(root,'event:'+event.eventId,async()=>{
      const current=await readDeliveryReceipt(root,event)
      if(!current||options.controller&&await options.controller.active(event)){result.protected++;return}
      // The proof must still correspond to an exact retained attempt. Undelivered queues never expire.
      const attempts=await history(root,event)
      if(!attempts.some(a=>a.attemptHash===current.attemptHash&&a.policyDigest===current.policyDigest))throw Error('retention-acknowledgment-unproven')
      await options.controller?.removeActiveReport(event,current)
      const file=spoolEventFile(root,event),info=await lstat(file)
      if(!info.isFile()||info.isSymbolicLink())throw Error('retention-unsafe-event')
      await rm(file)
      const directory=await open(dirname(file),'r');try{await directory.sync()}finally{await directory.close()}
      // Capture mapping, receipt and attempted hashes remain as private dedup/recovery tombstones.
      result.removed++
    })
  }
  return result
}

export async function cleanupBasicLogs(home:string,now=new Date()):Promise<{removed:number;protected:number}>{
  const runtime=await import('../runs.ts'),root=spoolRoot(home),events=(await inspectSpool(root)).events
  const result={removed:0,protected:0},cutoff=now.getTime()-14*24*60*60*1000
  for(const run of await runtime.readRuns(runtime.runsRoot(home))){
    if(run.state!=='terminal'||run.waitReason||run.terminationCause==='termination-unconfirmed'||!run.finishedAt||Date.parse(run.finishedAt)>cutoff||run.pendingDelivery.some(p=>p.status!=='acknowledged')){result.protected++;continue}
    const unsent=await Promise.all(events.filter(e=>e.captureKey.startsWith(run.runId+':')).map(e=>readDeliveryReceipt(root,e)))
    if(unsent.some(receipt=>!receipt)){result.protected++;continue}
    const file=join(runtime.runsRoot(home),run.runId,'events.jsonl')
    let info;try{info=await lstat(file)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e}
    if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)){result.protected++;continue}
    // Run truth, attempt captures and delivery receipts remain; only basic local log lines expire.
    await rm(file);const directory=await open(dirname(file),'r');try{await directory.sync()}finally{await directory.close()}
    result.removed++
  }
  return result
}
