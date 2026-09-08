import { currentPolicySerializer, configuredExportPolicy, privacyReason } from './privacy.ts'
// Immutable destination-bound transport. Only exact remote bytes prove delivery.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { canonicalJson, destinationId, destinationKey, eventPath, hashBytes, validateDestination, UUID, type Destination, type SpoolEnvelope, type ExportSerializer } from './types.ts'
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
  retention?: CleanupResult
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
  cleanupOnly?:boolean; dryRunRetention?:boolean; destination?:Destination; serialize?:ExportSerializer; effects?:TelemetryEffects; retention?:DeliveredRetentionController; wait?:(ms:number)=>Promise<void>; now?:()=>Date
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
  try{await lstat(pushLockPath(options.home));result.locked=true;throw Error('legacy-push-lock-requires-inspection')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT'){result.refusals.push(privacyReason(e));result.ok=false;return result}}
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
    for(const event of options.cleanupOnly?[]:selected){
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
          const serialized=await(options.serialize??currentPolicySerializer(options.home))(event)
          if(serialized===null){
            await writeSpoolJson(suppressionFile(root,event),{eventId:event.eventId,localPayloadDigest:hashBytes(canonicalJson(event.payload)),disposition:'policy-suppressed',recordedAt:now().toISOString()});continue
          }
          if(typeof serialized.bytes!=='string'||Buffer.byteLength(serialized.bytes)>1024*1024||!/^[a-f0-9]{64}$/.test(serialized.policyDigest))throw Error('invalid-serialized-export')
          JSON.parse(serialized.bytes)
          const attempt:DeliveryAttempt={batchId,operationId:randomUUID(),bytes:serialized.bytes,attemptHash:hashBytes(serialized.bytes),policyDigest:serialized.policyDigest,preparedAt:now().toISOString()}
          await writeSpoolJson(attemptFile(root,event),[...attempts,attempt])
          prepared.push({event,attempt});next.push(event)
        }catch(error){result.refusals.push(privacyReason(error));result.deferred.push(event.eventId)}
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
    const retention:DeliveredRetentionController=options.retention??{
      active:configuredRetentionActive(options.home),
      async removeActiveReport(event,receipt){
        const policy=await configuredExportPolicy(options.home,event.destination)
        if(!policy.policyDigest||!/^[a-f0-9]{64}$/.test(policy.policyDigest))throw Error('retention-policy-unavailable')
        const file=join(root,'retention',destinationId(event.destination),event.eventId+'.json')
        let operation=await readSpoolJson<RetentionRemoval>(file)
        if(operation)validateRetentionRemoval(operation,event,receipt)
        // Each changed policy starts a new intent only when no previous send is unresolved.
        if(operation?.state==='absent'){
          const observed=await refresh()
          if(await remoteBytes(observed,event)===null)return
          throw Error('retention-remote-report-reappeared')
        }
        for(let retry=0;retry<3;retry++){
          const remoteHead=await refresh(),bytes=await remoteBytes(remoteHead,event)
          if(bytes===null){
            if(!operation)operation={schemaVersion:1,eventId:event.eventId,destination:event.destination,path:eventPath(event),originalPayloadSha256:receipt.payloadSha256,policyDigest:policy.policyDigest,operationId:randomUUID(),batchId:randomUUID(),preparedAt:now().toISOString(),attemptedCommits:[],state:'prepared',observedCommit:null,observedAt:null}
            // This is an absence observation, never a DeliveryReceipt or proof that we
            // caused somebody else's removal. Retained attemptedCommits distinguish it.
            operation={...operation,state:'absent',observedCommit:remoteHead,observedAt:now().toISOString()}
            await writeSpoolJson(file,operation);return
          }
          if(hashBytes(bytes)!==receipt.payloadSha256||!(await history(root,event)).some(a=>a.bytes===bytes&&a.attemptHash===receipt.attemptHash))throw Error('retention-remote-payload-diverged')
          if(!operation){operation={schemaVersion:1,eventId:event.eventId,destination:event.destination,path:eventPath(event),originalPayloadSha256:receipt.payloadSha256,policyDigest:policy.policyDigest,operationId:randomUUID(),batchId:randomUUID(),preparedAt:now().toISOString(),attemptedCommits:[],state:'prepared',observedCommit:null,observedAt:null};await writeSpoolJson(file,operation)}
          if(operation.policyDigest!==policy.policyDigest)throw Error('retention-pending-policy-changed')
          const index=join(root,'git-index-'+randomUUID()),extra:GitOptions={env:{...telemetryIdentity,GIT_INDEX_FILE:index}}
          try{
            await run(['read-tree',remoteHead],extra)
            await run(['update-index','--force-remove','--',eventPath(event)],extra)
            const tree=(await run(['write-tree'],extra)).trim()
            const commit=(await run(['commit-tree',tree,'-p',remoteHead,'-m',`stats retention: ${operation.batchId} 1 event`],extra)).trim()
            if(!/^[a-f0-9]{40}$/.test(commit))throw Error('retention-commit-unavailable')
            operation={...operation,attemptedCommits:[...operation.attemptedCommits,commit]}
            await writeSpoolJson(file,operation) // durable exact intent before sending
            if(await retention.active(event))throw Error('retention-active-reference-held')
            const currentPolicy=await configuredExportPolicy(options.home,event.destination)
            if(currentPolicy.policyDigest!==operation.policyDigest)throw Error('retention-pending-policy-changed')
            await options.git(['-c','http.followRedirects=false','push','--no-follow-tags','--recurse-submodules=no',remote,`${commit}:${defaultRef}`],options.cloneRoot)
            const observed=await refresh()
            if(await remoteBytes(observed,event)===null){operation={...operation,state:'absent',observedCommit:observed,observedAt:now().toISOString()};await writeSpoolJson(file,operation);return}
          }finally{await rm(index,{force:true})}
          await wait([1000,2000,4000][retry]!)
        }
        throw Error('retention-removal-unconfirmed')
      },
    }
    result.retention=await cleanupDelivered(root,{now:now(),controller:retention,dryRun:options.dryRunRetention,destinations:selected.map(e=>e.destination)})
    const basic=await cleanupBasicLogs(options.home,now(),{dryRun:options.dryRunRetention})
    result.refusals.push(...result.retention.failures.map(f=>f.reason),...basic.failures.map(f=>f.reason))
    if(result.refusals.length)result.ok=false
    return result
  },0)}catch(error){
    result.refusals.push(privacyReason(error))
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
export interface CleanupResult {removed:number;protected:number;deleteCandidates:string[];held:Array<{eventId?:string;reason:string}>;failures:Array<{eventId?:string;reason:string}>}
export async function cleanupDelivered(root:string,options:{now?:Date;controller?:DeliveredRetentionController;dryRun?:boolean;destinations?:Destination[]}={}):Promise<CleanupResult>{
  const {planRetention}=await import('./privacy.ts'),now=options.now??new Date()
  const result:CleanupResult={removed:0,protected:0,deleteCandidates:[],held:[],failures:[]}
  for(const candidate of (await inspectSpool(root)).events.filter(e=>!options.destinations||options.destinations.some(d=>destinationKey(d)===destinationKey(e.destination)))){
    try{await withSpoolClaim(root,'event:'+candidate.eventId,async()=>{
      // Enumerate again inside the same event claim used by enqueue; stale caller objects
      // cannot authorize deleting a replacement file or a newly published capture.
      const event=(await inspectSpool(root)).events.find(e=>e.eventId===candidate.eventId&&destinationKey(e.destination)===destinationKey(candidate.destination))
      if(!event)return
      const receipt=await readDeliveryReceipt(root,event),file=spoolEventFile(root,event)
      const info=await lstat(file)
      const expired=planRetention({now:now.toISOString(),files:[{path:file,kind:'delivered-report',createdAt:event.payload.utcDay+'T00:00:00Z',bytes:info.size,active:false,delivered:receipt!==null}],policy:{diagnosticDays:14,sharedMonths:12}}).deleteCandidates.length>0
      const active=expired&&options.controller?await options.controller.active(event):!options.controller
      const plan=planRetention({now:now.toISOString(),files:[{path:file,kind:'delivered-report',createdAt:event.payload.utcDay+'T00:00:00Z',bytes:info.size,active,delivered:receipt!==null}],policy:{diagnosticDays:14,sharedMonths:12}})
      if(!plan.deleteCandidates.length||!receipt||!options.controller){result.protected++;result.held.push({eventId:event.eventId,reason:!options.controller?'retention-shared-removal-unavailable':plan.held[0]?.reason??'retention-receipt-unavailable'});return}
      const attempts=await history(root,event)
      if(!attempts.some(a=>a.attemptHash===receipt.attemptHash&&a.policyDigest===receipt.policyDigest)){result.protected++;result.held.push({eventId:event.eventId,reason:'retention-acknowledgment-unproven'});return}
      result.deleteCandidates.push(file)
      if(options.dryRun)return
      // The current authorized writer operation must complete first. A read-clone unlink
      // is never evidence of shared removal. Receipt and attempt tombstones remain local.
      await options.controller.removeActiveReport(event,receipt)
      if(await options.controller.active(event)){result.protected++;result.held.push({eventId:event.eventId,reason:'retention-active-after-shared-removal'});return}
      const current=await lstat(file)
      if(!current.isFile()||current.isSymbolicLink()||current.ino!==info.ino||current.dev!==info.dev||current.size!==info.size||current.mtimeMs!==info.mtimeMs)throw Error('retention-unsafe-event')
      await rm(file)
      const directory=await open(dirname(file),'r');try{await directory.sync()}finally{await directory.close()}
      result.removed++
    })}catch(error){const failure={eventId:candidate.eventId,reason:privacyReason(error)};result.protected++;result.held.push(failure);result.failures.push(failure)}
  }
  return result
}

export async function cleanupBasicLogs(home:string,now=new Date(),options:{dryRun?:boolean;targetForRun?:RetentionTargetResolver}={}):Promise<CleanupResult>{
  const runtime=await import('../runs.ts'),claims=await import('../claims.ts'),{planRetention}=await import('./privacy.ts'),root=spoolRoot(home)
  const result:CleanupResult={removed:0,protected:0,deleteCandidates:[],held:[],failures:[]}
  for(const candidate of await runtime.readRuns(runtime.runsRoot(home))){
    // This is exactly #138's mutation claim, backed by #137's existing local fence.
    const held=await claims.acquireClaim(join(runtime.runsRoot(home),candidate.runId,'mutation'),await claims.processIdentity())
    if(held.kind!=='owned'){result.protected++;result.held.push({reason:'retention-run-mutation-unavailable'});continue}
    try{
      const run=await runtime.readRun(runtime.runsRoot(home),candidate.runId)
      const file=join(runtime.runsRoot(home),run.runId,'events.jsonl')
      let info;try{info=await lstat(file)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e}
      if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)){result.protected++;result.held.push({reason:'retention-unsafe-diagnostic'});continue}
      const events=(await inspectSpool(root)).events.filter(e=>e.captureKey.startsWith(run.runId+':'))
      const receipts=await Promise.all(events.map(e=>readDeliveryReceipt(root,e)))
      if(run.sharedClaim){const state=await assessManagedRetention(home,run,options.targetForRun);if(state.held){result.protected++;result.held.push({reason:state.reason!});continue}}
      const active=run.state!=='terminal'||run.waitReason!==null||run.terminationCause==='termination-unconfirmed'||!run.finishedAt||run.execution!==null&&run.remoteEffectCoverage.kind==='unmanaged-possible'
      const delivered=!run.pendingDelivery.some(p=>p.status!=='acknowledged')&&!receipts.some(r=>r===null)
      const plan=planRetention({now:now.toISOString(),files:[{path:file,kind:'basic-diagnostic',createdAt:run.finishedAt??run.startedAt,bytes:info.size,active:!!active,delivered}],policy:{diagnosticDays:14,sharedMonths:12}})
      if(!plan.deleteCandidates.length){result.protected++;result.held.push({reason:plan.held[0]!.reason});continue}
      // Validate retained log lines as the basic class; legacy raw log files never qualify.
      const bytes=await runtime.readPrivateRunFile(file)
      const {basicDiagnostic}=await import('./privacy.ts')
      let basic=true
      for(const line of bytes.split('\n').filter(Boolean)){try{const row=JSON.parse(line);if(canonicalJson(row)!==canonicalJson(basicDiagnostic(row.at,row.event,row)))basic=false}catch{basic=false}}
      if(!basic){result.protected++;result.held.push({reason:'retention-nonbasic-diagnostic-held'});continue}
      result.deleteCandidates.push(file)
      if(options.dryRun)continue
      if(run.sharedClaim){const state=await assessManagedRetention(home,await runtime.readRun(runtime.runsRoot(home),run.runId),options.targetForRun);if(state.held){result.protected++;result.held.push({reason:state.reason!});continue}}
      const current=await lstat(file)
      if(current.ino!==info.ino||current.dev!==info.dev||current.size!==info.size||current.mtimeMs!==info.mtimeMs||!current.isFile()||current.isSymbolicLink())throw Error('retention-diagnostic-changed')
      await rm(file);const directory=await open(dirname(file),'r');try{await directory.sync()}finally{await directory.close()}
      result.removed++
    }catch(error){const failure={reason:privacyReason(error)};result.protected++;result.held.push(failure);result.failures.push(failure)}finally{await claims.releaseClaim(held.claim)}
  }
  return result
}

interface RetentionRemoval {
  schemaVersion:1;eventId:string;destination:Destination;path:string;originalPayloadSha256:string;policyDigest:string
  operationId:string;batchId:string;preparedAt:string;attemptedCommits:string[];state:'prepared'|'absent';observedCommit:string|null;observedAt:string|null
}
function validateRetentionRemoval(value:RetentionRemoval,event:SpoolEnvelope,receipt:DeliveryReceipt):void{
  if(!value||Object.keys(value).sort().join(',')!=='attemptedCommits,batchId,destination,eventId,observedAt,observedCommit,operationId,originalPayloadSha256,path,policyDigest,preparedAt,schemaVersion,state'||value.schemaVersion!==1||value.eventId!==event.eventId||destinationKey(value.destination)!==destinationKey(event.destination)||value.path!==eventPath(event)||value.originalPayloadSha256!==receipt.payloadSha256||!/^[a-f0-9]{64}$/.test(value.policyDigest)||!UUID.test(value.operationId)||!UUID.test(value.batchId)||!Number.isFinite(Date.parse(value.preparedAt))||!Array.isArray(value.attemptedCommits)||value.attemptedCommits.length>1000||value.attemptedCommits.some(c=>!/^[a-f0-9]{40}$/.test(c))||!['prepared','absent'].includes(value.state)||value.state==='prepared'&&(value.observedCommit!==null||value.observedAt!==null)||value.state==='absent'&&(!/^[a-f0-9]{40}$/.test(value.observedCommit??'')||!Number.isFinite(Date.parse(value.observedAt??''))))throw Error('retention-invalid-removal-receipt')
}
export function configuredRetentionActive(home:string):(event:SpoolEnvelope)=>Promise<boolean>{
  return async event=>{
    try{
      const policy=await configuredExportPolicy(home,event.destination)
      const runtime=await import('../runs.ts'),runs=await runtime.readRuns(runtime.runsRoot(home))
      const executionId=event.payload.recordKind==='execution'?event.payload.localRunId:undefined
      const related=runs.filter(run=>run.repo===event.destination.repo&&(executionId?run.runId===executionId:event.payload.recordKind!=='execution'&&typeof event.payload.taskRef==='object'?run.issue===event.payload.taskRef.issue:true))
      if(executionId&&!related.length)return true
      // An observation can be produced on another host. Consult the configured shared
      // active index even when this home has no matching local run.
      if((policy as typeof policy&{fleet?:unknown}).fleet){
        const {loadFactoryConfig}=await import('../config.ts'),config=await loadFactoryConfig(join(home,'.vegastack','factory.json'),home)
        const target=await(await import('../dispatch.ts')).verifiedSharedTarget(event.destination.repo,config,executionId)
        const current=await(await import('../shared-claims.ts')).readCoordination(target)
        const issue=event.payload.recordKind==='execution'?event.payload.taskRef?.issue:typeof event.payload.taskRef==='object'?event.payload.taskRef.issue:undefined
        if(Object.values(current.tasks).some(task=>task.repo===event.destination.repo&&(issue===undefined||task.issue===issue)||task.recovery?.effects.some(effect=>effect.target.kind==='telemetry'&&effect.target.eventId===event.eventId)))return true
      }
      for(const run of related){
        if(run.state!=='terminal'||run.waitReason||run.terminationCause==='termination-unconfirmed'||run.pendingDelivery.some(p=>p.status!=='acknowledged')||run.remoteEffectCoverage.kind==='unmanaged-possible')return true
        if(run.sharedClaim){const state=await assessManagedRetention(home,run);if(state.held){if(state.reason==='retention-task-absent'||state.reason==='retention-task-unverified')throw Error(state.reason);return true}}
      }
      return false
    }catch(error){throw Error(error instanceof Error&&['retention-task-absent','retention-task-unverified'].includes(error.message)?error.message:'retention-active-reference-unavailable')}
  }
}


export type RetentionTargetResolver=(run:import('../runs.ts').RunRecord)=>Promise<import('../shared-claims.ts').CoordinationTarget>
export interface ManagedRetentionDecision {held:boolean;reason:string|null;head:string|null}
// The137 reader owns archival schema, current-head consistency and expected identity.
// Retention additionally requires quiescent local and retained recovery state. It never
// removes the authority, effect, checkpoint, acceptance or dedup evidence it inspected.
export async function assessManagedRetention(home:string,run:import('../runs.ts').RunRecord,targetForRun?:RetentionTargetResolver):Promise<ManagedRetentionDecision>{
  const held=(reason:string,head:string|null=null):ManagedRetentionDecision=>({held:true,reason,head})
  if(!run.sharedClaim||!run.machine)return held('retention-task-unverified')
  try{
    const target=targetForRun?await targetForRun(run):await(async()=>{const {loadFactoryConfig}=await import('../config.ts');const config=await loadFactoryConfig(join(home,'.vegastack','factory.json'),home);return(await import('../dispatch.ts')).verifiedSharedTarget(run.repo,config,run.runId)})()
    const owner=await import('../shared-claims.ts')
    const expected={runId:run.runId,generation:run.sharedClaim.generation,ownerToken:run.sharedClaim.ownerToken,machineId:run.machine.id,installationId:run.machine.installationId,sessionId:run.machine.sessionId,scopeDigest:run.taskKey.scopeDigest}
    const inspection=await owner.inspectCoordinationTask(target,run.sharedClaim.taskKey,expected)
    if(inspection.kind==='absent')return held('retention-task-absent',inspection.head)
    if(inspection.kind==='invalid-or-unavailable')return held('retention-task-unverified')
    const {task,head}=inspection,recovery=task.recovery
    if(task.repo!==run.repo||task.issue!==run.issue||owner.canonical(task.approvalBindings)!==owner.canonical(run.approvalBindings))return held('retention-task-unverified',head)
    if(inspection.kind==='active'||run.state!=='terminal'||!run.finishedAt||run.waitReason||run.terminationCause==='termination-unconfirmed')return held('retention-active-or-unknown',head)
    if(!recovery||!task.stopProof||task.stopProof.machineId!==run.machine.id||task.stopProof.installationId!==run.machine.installationId||task.stopProof.sessionId!==run.machine.sessionId||task.stopProof.hostBindingDigest!==run.machine.hostBindingDigest||task.stopProof.generation!==run.sharedClaim.generation||!task.stopProof.runIds.includes(run.runId)||!task.acceptedScopes.some(scope=>scope.scopeDigest===run.taskKey.scopeDigest&&(!run.acceptedScopeRef||owner.canonical(scope.receipt)===owner.canonical(run.acceptedScopeRef)))||owner.canonical(recovery.recordBinding)!==owner.canonical(run.recordBinding)||owner.canonical(recovery.execution)!==owner.canonical(run.execution))return held('retention-recovery-held',head)
    if(run.pendingDelivery.some(p=>p.status!=='acknowledged')||task.unresolvedEffects.length||run.remoteEffectCoverage.kind==='unmanaged-possible'||recovery.remoteEffectCoverage.kind==='unmanaged-possible'||recovery.effects.some(e=>e.state!=='acknowledged'&&e.state!=='cancelled-before-send')||recovery.joins.some(j=>j.state==='prepared'))return held('retention-recovery-held',head)
    // Typed reference presence is not proof that the retained evidence is readable.
    // Resolve through137's immutable evidence reader; never manufacture a qualification,
    // acceptance, telemetry receipt or replacement authority during cleanup.
    const refs=new Map<string,import('../shared-claims.ts').EvidenceRef>()
    const collect=(value:unknown):void=>{if(!value||typeof value!=='object')return;const row=value as Record<string,unknown>;if(row.kind==='state-receipt'||row.kind==='github-comment'){const ref=owner.parseEvidenceRef(row);refs.set(owner.canonical(ref),ref);return}for(const child of Object.values(row))collect(child)}
    collect(recovery);collect(task.stopProof);collect(task.acceptedScopes)
    if(refs.size>256)return held('retention-task-unverified',head)
    const resolved=new Map<string,import('../shared-claims.ts').RecoveryEvidencePayload|null>()
    for(const [key,ref]of refs)resolved.set(key,await owner.resolveEvidence(target,ref))
    const qualification=resolved.get(owner.canonical(recovery.execution.qualification))
    if(!qualification||qualification.kind!=='execution-qualification'||qualification.result!=='qualified'||(['harness','harnessVersion','model','effort','accountRef'] as const).some(key=>qualification[key]!==recovery.execution[key]))return held('retention-recovery-held',head)
    for(const effect of recovery.effects){
      const intent=resolved.get(owner.canonical(effect.intent)),outcome=effect.outcome?resolved.get(owner.canonical(effect.outcome)):null
      if(!intent||intent.kind!=='effect-intent'||!outcome||outcome.kind!=='effect-outcome'||intent.result!=='prepared'||outcome.result!==effect.state||[intent,outcome].some(p=>p.effectId!==effect.operationId||p.runId!==run.runId||p.generation!==effect.generation||p.effectKind!==effect.kind||p.payloadDigest!==effect.payloadDigest||owner.canonical(p.target)!==owner.canonical(effect.target)||owner.canonical(p.approvalBindings)!==owner.canonical(run.approvalBindings)))return held('retention-recovery-held',head)
    }
    const coverage=recovery.remoteEffectCoverage
    if(coverage.kind==='qualified-managed-only'&&owner.canonical(resolved.get(owner.canonical(coverage.qualification)))!==owner.canonical(qualification))return held('retention-recovery-held',head)
    if(coverage.kind==='reconciled'){
      const proof=resolved.get(owner.canonical(coverage.evidence))
      if(!proof||proof.kind!=='effect-reconciliation'||proof.result!=='complete'||proof.runId!==run.runId||proof.scopeDigest!==run.taskKey.scopeDigest||owner.canonical(proof.approvalBindings)!==owner.canonical(run.approvalBindings)||recovery.effects.some(e=>e.kind!=='telemetry-push'&&!proof.checkedEffectIds.includes(e.operationId)))return held('retention-recovery-held',head)
    }
    const accepted=task.acceptedScopes.find(scope=>scope.scopeDigest===run.taskKey.scopeDigest&&(!run.acceptedScopeRef||owner.canonical(scope.receipt)===owner.canonical(run.acceptedScopeRef)))!
    const proof=resolved.get(owner.canonical(accepted.receipt))
    if(!proof||proof.kind!=='acceptance'||proof.result!=='passed'||proof.runId!==run.runId||proof.sourceSha!==run.headSha||proof.scopeDigest!==run.taskKey.scopeDigest||!proof.acceptedScope||proof.acceptedScope.repo!==run.repo||proof.acceptedScope.issue!==run.issue||owner.canonical(proof.acceptedScope.approvalBindings)!==owner.canonical(run.approvalBindings)||!run.approvedTaskIds?.every(id=>proof.acceptedScope!.completedTaskIds.includes(id)))return held('retention-recovery-held',head)
    // A head advance while resolving evidence requires a fresh assessment, not a
    // mixture of archival state at one head and authority/effects at another.
    const fresh=await owner.inspectCoordinationTask(target,run.sharedClaim.taskKey,expected)
    if(fresh.kind!=='completed'||fresh.head!==head||owner.canonical(fresh.task)!==owner.canonical(task))return held('retention-task-unverified',head)
    return{held:false,reason:null,head}
  }catch{return held('retention-task-unverified')}
}
