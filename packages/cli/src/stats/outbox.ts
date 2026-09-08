// Immutable schema2 capture, delivery tombstones and explicit legacy migration.
// Legacy JSONL helpers remain local compatibility inputs; they cannot publish or delete
// their originals. Managed run/hook capture uses enqueueEvent below.

import { appendFile, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve, parse, relative, isAbsolute } from 'node:path'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { acquireClaim, releaseClaim, processIdentity } from '../claims.ts'
import { canonicalJson, destinationId, hashBytes, validateEnvelope, semanticCaptureKey, terminalCaptureKey, parseTerminalCaptureKey, UUID, type SpoolEnvelope, type Destination } from './types.ts'
import {
  monthToken, recordProblems, repoSegment, serializeRecord,
  type SkillInvocation, type StatsRecord,
} from './record.ts'

export class OutboxRefusal extends Error {}

export function outboxRoot(home: string): string {
  return join(home, '.vegastack', 'stats', 'outbox')
}

function sessionRoot(home: string): string {
  return join(home, '.vegastack', 'stats', 'sessions')
}

// A hostname is a filename here, so it is reduced to one lowercase segment. The domain suffix goes
// because `mini.local` and `mini.lan` are the same machine on two networks, and one machine that
// writes two files a month is one machine the rollup counts twice.
export function sanitizeHostname(raw: string): string {
  const base = String(raw ?? '').split('.')[0] ?? ''
  const cleaned = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'unknown-host' : cleaned
}

function safeSegment(raw: string, fallback: string): string {
  const cleaned = String(raw ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '')
  return cleaned === '' ? fallback : cleaned
}

export function outboxFile(home: string, repo: string, month: string, hostname: string): string {
  return join(outboxRoot(home), repoSegment(repo), month, `${sanitizeHostname(hostname)}.jsonl`)
}

export interface OutboxBatch {
  file: string
  repo: string
  month: string
  hostname: string
  records: StatsRecord[]
}

async function refuseIrregular(path: string): Promise<void> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
    return
  }
  if (!stats.isFile()) throw new OutboxRefusal(`refusing to write ${path} — it is not a regular file`)
}

export async function appendRecord(home: string, record: StatsRecord, hostname: string): Promise<string> {
  const problems = recordProblems(record)
  if (problems.length > 0) throw new OutboxRefusal(`refusing to write an unusable record: ${problems.join('; ')}`)
  const file = outboxFile(home, record.repo, monthToken(new Date(record.ts)), hostname)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await refuseIrregular(file)
  await appendFile(file, `${serializeRecord(record)}\n`, {mode:0o600})
  return file
}

async function readdirSafe(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort()
  } catch {
    return []
  }
}

// A corrupt line is skipped, never fatal: a half-written record from a machine that lost power is
// one lost run, while a parser that throws on it strands every good record behind it forever.
export async function listOutbox(home: string): Promise<OutboxBatch[]> {
  const root = outboxRoot(home)
  const batches: OutboxBatch[] = []
  for (const repoDir of await readdirSafe(root)) {
    for (const month of await readdirSafe(join(root, repoDir))) {
      for (const entry of await readdirSafe(join(root, repoDir, month))) {
        if (!entry.endsWith('.jsonl')) continue
        const file = join(root, repoDir, month, entry)
        let text: string
        try {
          text = await readFile(file, 'utf8')
        } catch {
          continue
        }
        const records: StatsRecord[] = []
        for (const line of text.split('\n')) {
          if (line.trim() === '') continue
          try {
            records.push(JSON.parse(line) as StatsRecord)
          } catch {
            // skipped on purpose — see the comment above
          }
        }
        batches.push({
          file,
          // The record's own `repo` is the authority; the directory name is a filename-safe
          // rendering of it and cannot always be turned back into `owner/name`.
          repo: records[0]?.repo ?? repoDir.replace('__', '/'),
          month,
          hostname: entry.replace(/\.jsonl$/, ''),
          records,
        })
      }
    }
  }
  return batches
}

export async function dropOutboxFiles(files: string[]): Promise<void> {
  if(files.length)throw new OutboxRefusal('legacy-spool-deletion-refused: migration preserves original bytes')
}

// --- the per-session skill sidecar --------------------------------------------------------
//
// Skill invocations are captured by hooks that fire long before the session's own record exists,
// so they accumulate in a per-session file that the session-end capture folds in and deletes.

export function sessionSidecar(home: string, sessionId: string): string {
  return join(sessionRoot(home), `${safeSegment(sessionId, 'unknown-session')}.skills.jsonl`)
}

export async function appendSkillInvocations(home: string, sessionId: string, invocations: SkillInvocation[]): Promise<void> {
  if (invocations.length === 0) return
  const file = sessionSidecar(home, sessionId)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await refuseIrregular(file)
  await appendFile(file, `${invocations.map(entry => JSON.stringify(entry)).join('\n')}\n`,{mode:0o600})
}

export async function takeSkillInvocations(home: string, sessionId: string): Promise<SkillInvocation[]> {
  const file = sessionSidecar(home, sessionId)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const invocations: SkillInvocation[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      invocations.push(JSON.parse(line) as SkillInvocation)
    } catch {
      // one unreadable invocation must not cost the session its whole skill list
    }
  }
  await rm(file, { force: true })
  return invocations
}

// schema2 never mutates legacy JSONL. Migration is explicit and preserves originals.
export const spoolRoot = (home: string): string => join(home, '.vegastack', 'stats', 'events-v2')
export async function safeSpoolDirectory(path: string): Promise<void> {
  const absolute = resolve(path), root = parse(absolute).root
  let at = root
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    at = join(at, part)
    let info
    try { info = await lstat(at) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { await mkdir(at, { mode: 0o700 }) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
      info = await lstat(at)
    }
    // Root-owned OS aliases (/var on macOS) are trusted; user-controlled links never are.
    if (info.isSymbolicLink() ? info.uid !== 0 : !info.isDirectory()) throw Error('unsafe-spool-ancestor')
  }
  const info = await lstat(absolute)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw Error('unsafe-private-spool')
}
export async function readSpoolJson<T>(path: string, maxBytes = 2 * 1024 * 1024): Promise<T | null> {
  let info
  try { info = await lstat(path) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > maxBytes) throw Error('unsafe-spool-file')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const actual = await handle.stat(); if (actual.ino !== info.ino || actual.dev !== info.dev) throw Error('spool-file-changed'); return JSON.parse(await handle.readFile('utf8')) as T } finally { await handle.close() }
}
export async function writeSpoolJson(path: string, value: unknown, maxBytes = 2 * 1024 * 1024): Promise<void> {
  await safeSpoolDirectory(dirname(path))
  const bytes=canonicalJson(value)+'\n'
  if(Buffer.byteLength(bytes)>maxBytes)throw Error('spool-record-too-large')
  await readSpoolJson(path,maxBytes) // refuse irregular/unknown existing state, never overwrite a link
  const temporary = path + '.' + randomUUID() + '.tmp'
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
  const directory = await open(dirname(path), 'r'); try { await directory.sync() } finally { await directory.close() }
}
const localClaims = new Map<string, Promise<void>>()
export async function withSpoolClaim<T>(root: string, key: string, work: () => Promise<T>, timeoutMs = 400): Promise<T> {
  const localKey = resolve(root) + ':' + key
  const preceding = localClaims.get(localKey) ?? Promise.resolve()
  let unlock!: () => void
  const current = new Promise<void>(resolveLock => { unlock = resolveLock })
  localClaims.set(localKey, current)
  await preceding
  try {
    await safeSpoolDirectory(root)
    const claims = join(root,'claims'); await safeSpoolDirectory(claims)
    const identity = await processIdentity(), until = Date.now() + timeoutMs
    for (;;) {
      const held = await acquireClaim(join(claims, hashBytes(key)), identity)
      if (held.kind === 'owned') {
        try { return await work() } finally {
          const releaseUntil = Date.now() + timeoutMs
          for (;;) { try { await releaseClaim(held.claim); break } catch (error) { if(Date.now() >= releaseUntil) throw error; await new Promise(r => setTimeout(r,10)) } }
        }
      }
      if (held.kind === 'refused') throw Error('spool-claim-refused: ' + held.reason)
      if (Date.now() >= until) throw Error('spool-claim-unavailable: ' + held.reason)
      await new Promise(resolveWait => setTimeout(resolveWait, 10))
    }
  } finally { unlock(); if(localClaims.get(localKey) === current) localClaims.delete(localKey) }
}

export interface QuarantineEntry { reason: string; source: string; bytes: number; recordedAt: string; action: string }
export async function quarantineSpool(root: string, source: string, reason: string, bytes: number, action = 'inspect the original record; reconcile identity before retry'): Promise<void> {
  await writeSpoolJson(join(root,'quarantine',hashBytes(source + '\n' + reason) + '.json'), { reason, source, bytes, recordedAt: new Date().toISOString(), action })
}
export function spoolEventFile(root: string, event: Pick<SpoolEnvelope,'destination'|'eventId'>): string {
  if (!UUID.test(event.eventId)) throw Error('invalid-event-id')
  return join(root,'events',destinationId(event.destination),event.eventId + '.json')
}
export async function enqueueEvent(root: string, input: SpoolEnvelope): Promise<{eventId: string; persisted: boolean}> {
  let supplied = validateEnvelope({...input,captureKey:input.payload.recordKind==='execution'?input.captureKey:semanticCaptureKey(input.destination,input.payload)})
  const capture = hashBytes(canonicalJson([destinationId(supplied.destination), supplied.captureKey]))
  const runId=supplied.payload.recordKind==='execution'?supplied.payload.localRunId:undefined
  const segment=runId!==undefined?parseTerminalCaptureKey(supplied.captureKey):null
  if(runId!==undefined&&(!segment||segment.runId!==runId))throw Error('privacy-reporting-identity-unavailable')
  const logical=runId!==undefined?hashBytes(canonicalJson([destinationId(supplied.destination),terminalCaptureKey(runId)])):capture
  // Lock order: logical execution's legacy :0 capture claim, then event claim. All
  // terminal segments share the former; no nested segment claim can invert this order.
  //149's pre-capture reportingExecutionRef uses this same stable logical claim.
  return withSpoolClaim(root,'capture:' + logical, async () => {
    type Mapping={eventId:string;payloadDigest:string;destination:string;captureKey:string;executionRef?:string}
    const mappingPath = join(root,'captures',capture + '.json')
    const previous = await readSpoolJson<Mapping>(mappingPath)
    if(runId!==undefined&&supplied.payload.recordKind==='execution'){
      const original=logical===capture?previous:await readSpoolJson<Mapping>(join(root,'captures',logical+'.json'))
      const preparedPath=join(root,'reporting-identities',logical+'.json')
      const prepared=await readSpoolJson<{executionRef:string}>(preparedPath)
      if(prepared&&(Object.keys(prepared).join(',')!=='executionRef'||!UUID.test(prepared.executionRef)))throw Error('privacy-reporting-identity-rebound')
      if(original&&(!original.executionRef||original.destination!==destinationId(supplied.destination)||original.captureKey!==terminalCaptureKey(runId)||!UUID.test(original.eventId)))throw Error('privacy-reporting-identity-unavailable')
      if(previous&&!previous.executionRef)throw Error('privacy-reporting-identity-unavailable')
      const saved=original?.executionRef??prepared?.executionRef
      if(saved&&(!UUID.test(saved)||saved===runId)||original?.executionRef&&prepared?.executionRef&&original.executionRef!==prepared.executionRef||previous?.executionRef&&previous.executionRef!==saved||supplied.payload.executionRef&&supplied.payload.executionRef!==saved)throw Error('privacy-reporting-identity-rebound')
      const executionRef=saved??randomUUID()
      // A continuation may arrive before :0. Persist its logical identity before its
      // own map/event, without inventing or rewriting an earlier terminal capture.
      if(!saved&&logical!==capture)await writeSpoolJson(preparedPath,{executionRef})
      supplied={...supplied,payload:{...supplied.payload,executionRef}}
    }
    const digest = hashBytes(canonicalJson(supplied.payload))
    if (previous && (previous.payloadDigest !== digest || previous.destination !== destinationId(supplied.destination) || previous.captureKey !== supplied.captureKey || !UUID.test(previous.eventId))) {
      await quarantineSpool(root, capture, 'capture-payload-conflict', Buffer.byteLength(canonicalJson(input)))
      throw Error('capture-payload-conflict')
    }
    const event = { ...supplied, eventId: previous?.eventId ?? supplied.eventId }
    // Mapping becomes durable BEFORE the event, so an interrupted enqueue reuses its ID.
    if (!previous) await writeSpoolJson(mappingPath, { eventId:event.eventId,payloadDigest:digest,destination:destinationId(event.destination),captureKey:event.captureKey,...(event.payload.recordKind==='execution'&&event.payload.executionRef?{executionRef:event.payload.executionRef}:{}) })
    return withSpoolClaim(root,'event:' + event.eventId, async () => {
      const identityFile = join(root,'identities',event.eventId+'.json')
      const identity={destination:destinationId(event.destination),captureKey:event.captureKey,payloadDigest:digest}
      const assigned=await readSpoolJson(identityFile)
      if(assigned&&canonicalJson(assigned)!==canonicalJson(identity)){await quarantineSpool(root,event.eventId,'event-destination-conflict',Buffer.byteLength(canonicalJson(input)));throw Error('event-destination-conflict')}
      if(!assigned)await writeSpoolJson(identityFile,identity)
      // Durable receipts/dispositions are tombstones: retention must not turn a retry into a new event.
      if(await(await import('./push.ts')).readDeliveryReceipt(root,event))return{eventId:event.eventId,persisted:true}
      const suppressed=await readSpoolJson<{eventId:string;localPayloadDigest:string;disposition:string;recordedAt:string}>(join(root,'suppressed',destinationId(event.destination),event.eventId+'.json'))
      if(suppressed){if(suppressed.eventId!==event.eventId||suppressed.disposition!=='policy-suppressed'||suppressed.localPayloadDigest!==digest||!Number.isFinite(Date.parse(suppressed.recordedAt)))throw Error('suppressed-payload-conflict');return{eventId:event.eventId,persisted:true}}
      const file = spoolEventFile(root,event)
      const old = await readSpoolJson<SpoolEnvelope>(file)
      if (old && canonicalJson(old) !== canonicalJson(event)) {
        await quarantineSpool(root,event.eventId,'event-payload-conflict',Buffer.byteLength(canonicalJson(input)))
        throw Error('event-payload-conflict')
      }
      if (!old) await writeSpoolJson(file,event)
      return {eventId:event.eventId,persisted:true}
    })
  })
}
export interface SpoolInspection { events: SpoolEnvelope[]; quarantine: QuarantineEntry[]; pendingBytes: number; oldestAgeMs: number; delivered: number; suppressed: number; quarantineBytes:number; quarantineOldestAgeMs:number }
export async function inspectSpool(root: string): Promise<SpoolInspection> {
  const result: SpoolInspection = {events:[],quarantine:[],pendingBytes:0,oldestAgeMs:0,delivered:0,suppressed:0,quarantineBytes:0,quarantineOldestAgeMs:0}
  let info
  try { info=await lstat(root) } catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')return result;throw e}
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077))throw Error('unsafe-spool-root')
  const walk = async (dir:string,kind:'events'|'quarantine'):Promise<void> => {
    let entries;try{entries=await readdir(dir,{withFileTypes:true})}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}
    for(const entry of entries){const file=join(dir,entry.name)
      if(entry.isDirectory()){await walk(file,kind);continue}
      const stat=await lstat(file)
      if(entry.isSymbolicLink()||!entry.isFile()||!entry.name.endsWith('.json')){result.quarantine.push({source:file,reason:'partial-or-unsafe-spool-file',bytes:stat.size,recordedAt:stat.mtime.toISOString(),action:'inspect and recover the original temporary file'});continue}
      try { const value=await readSpoolJson<SpoolEnvelope|QuarantineEntry>(file)
        if(kind==='events'){
          const event=validateEnvelope(value);if(file!==spoolEventFile(root,event))throw Error('event-path-mismatch');result.events.push(event)
          const receipt=await(await import('./push.ts')).readDeliveryReceipt(root,event)
          const suppressed=await readSpoolJson(join(root,'suppressed',destinationId(event.destination),event.eventId+'.json'))
          if(receipt)result.delivered++;else if(suppressed)result.suppressed++;else{result.pendingBytes+=stat.size;result.oldestAgeMs=Math.max(result.oldestAgeMs,Date.now()-stat.mtimeMs)}
        }
        else result.quarantine.push(value as QuarantineEntry)
      } catch {result.quarantine.push({source:file,reason:'invalid-spool-file',bytes:stat.size,recordedAt:stat.mtime.toISOString(),action:'inspect original bytes; do not delete undelivered data'})}
    }
  }
  await walk(join(root,'events'),'events');await walk(join(root,'quarantine'),'quarantine')
  const temporary=async(dir:string):Promise<void>=>{
    let entries;try{entries=await readdir(dir,{withFileTypes:true})}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}
    for(const entry of entries){const file=join(dir,entry.name);if(entry.isDirectory())await temporary(file);else if(entry.isFile()&&entry.name.endsWith('.tmp')){const info=await lstat(file);result.quarantine.push({source:file,reason:'partial-spool-write',bytes:info.size,recordedAt:info.mtime.toISOString(),action:'inspect and reconcile this interrupted write; original capture mapping is retained'})}}
  }
  for(const dir of ['captures','identities','attempts','receipts','suppressed','batches','legacy-snapshots','retention','reporting-identities'])await temporary(join(root,dir))
  result.quarantineBytes=result.quarantine.reduce((total,row)=>total+row.bytes,0)
  result.quarantineOldestAgeMs=result.quarantine.reduce((oldest,row)=>Math.max(oldest,Date.now()-Date.parse(row.recordedAt)),0)
  return result
}

export interface LegacySnapshot { path:string; sha256:string; bytes:number; modifiedAt:string }
export interface MigrationCandidate {snapshot:string;offset:number;lineSha256:string;record:StatsRecord}
export interface MigrationReport {schemaVersion:1;sourceRoot:string;snapshots:LegacySnapshot[];candidates:MigrationCandidate[];invalid:QuarantineEntry[];pendingBytes:number;oldestAgeMs:number;reportDigest:string}
export async function inspectLegacySpool(root:string):Promise<MigrationReport>{
  const {parseLocalRecord}=await import('./record.ts')
  const report:MigrationReport={schemaVersion:1,sourceRoot:resolve(root),snapshots:[],candidates:[],invalid:[],pendingBytes:0,oldestAgeMs:0,reportDigest:''}
  const walk=async(dir:string):Promise<void>=>{
    let entries;try{entries=await readdir(dir,{withFileTypes:true})}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}
    for(const entry of entries){
      const file=join(dir,entry.name),path=relative(report.sourceRoot,file)
      if(entry.isSymbolicLink()){report.invalid.push({source:path,reason:'legacy-symlink-refused',bytes:0,recordedAt:new Date().toISOString(),action:'inspect source mapping; links are never migrated'});continue}
      if(entry.isDirectory()){await walk(file);continue}
      if(!entry.isFile()||!entry.name.endsWith('.jsonl'))continue
      const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
      let bytes:Buffer,info
      try{info=await handle.stat();if(!info.isFile()||info.size>64*1024*1024)throw Error('legacy-source-too-large');bytes=await handle.readFile();const after=await handle.stat();if(after.size!==info.size||after.mtimeMs!==info.mtimeMs)throw Error('legacy-source-changing')}finally{await handle.close()}
      const snapshot:LegacySnapshot={path,sha256:hashBytes(bytes!),bytes:bytes!.length,modifiedAt:info!.mtime.toISOString()}
      report.snapshots.push(snapshot);report.pendingBytes+=snapshot.bytes;report.oldestAgeMs=Math.max(report.oldestAgeMs,Date.now()-info!.mtimeMs)
      let offset=0
      while(offset<bytes!.length){
        const newline=bytes!.indexOf(10,offset),end=newline<0?bytes!.length:newline,line=bytes!.subarray(offset,end)
        if(line.length){try{
          if(newline<0)throw Error('interrupted-final-line')
          const text=new TextDecoder('utf-8',{fatal:true}).decode(line),record=parseLocalRecord(JSON.parse(text))
          report.candidates.push({snapshot:snapshot.sha256,offset,lineSha256:hashBytes(line),record})
        }catch(error){report.invalid.push({source:path+':'+offset,reason:(error as Error).message==='interrupted-final-line'?'interrupted-final-line':'invalid-legacy-record',bytes:line.length,recordedAt:snapshot.modifiedAt,action:'inspect original bytes; originals remain unchanged'})}}
        offset=end+1
      }
    }
  }
  let rootInfo;try{rootInfo=await lstat(root)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
  if(rootInfo?.isSymbolicLink()||rootInfo&&!rootInfo.isDirectory())throw Error('unsafe-legacy-root')
  await walk(report.sourceRoot)
  report.reportDigest=hashBytes(canonicalJson({...report,reportDigest:''}))
  return report
}
export async function migrateLegacySpool(report:MigrationReport,mapping:Record<string,Destination>,options:{root:string;apply?:boolean}):Promise<{migrated:number;invalid:number}>{
  if(options.apply!==true)throw Error('migration-apply-required')
  if(report.schemaVersion!==1||!isAbsolute(report.sourceRoot)||report.reportDigest!==hashBytes(canonicalJson({...report,reportDigest:''})))throw Error('migration-report-changed')
  const {validateDestination}=await import('./types.ts'),{parseLocalRecord}=await import('./record.ts')
  for(const candidate of report.candidates){const destination=mapping[candidate.record.repo];if(!destination||validateDestination(destination).repo!==candidate.record.repo)throw Error('migration-destination-mapping-required')}
  return withSpoolClaim(options.root,'legacy-migration',async()=>{
    // Verify all snapshots before the first enqueue. A changing legacy producer never licenses deletion.
    for(const snapshot of report.snapshots){
      const path=resolve(report.sourceRoot,snapshot.path)
      if(!snapshot.path||isAbsolute(snapshot.path)||path===report.sourceRoot||!path.startsWith(report.sourceRoot+'/'))throw Error('migration-source-escaped-root')
      let ancestor=path
      while(ancestor!==report.sourceRoot){const info=await lstat(ancestor);if(info.isSymbolicLink())throw Error('migration-symlink-refused');ancestor=dirname(ancestor)}
      const bytes=await readFile(path)
      if(hashBytes(bytes)!==snapshot.sha256||bytes.length!==snapshot.bytes)throw Error('migration-source-snapshot-changed')
      const tracked=join(options.root,'legacy-sources',hashBytes(path)+'.json')
      const old=await readSpoolJson<LegacySourceState>(tracked)
      if(old&&old.sha256!==snapshot.sha256){
        const previous=await readSpoolJson<{bytes:string}>(join(options.root,'legacy-snapshots',old.sha256+'.json'),96*1024*1024)
        if(!previous||!bytes.subarray(0,old.bytes).equals(Buffer.from(previous.bytes,'base64')))throw Error('migration-source-history-changed: inspect changed original bytes')
      }
      await writeSpoolJson(tracked,{...snapshot,migrated:false,lines:old?.lines??{}})
      // Preserve exact immutable bytes privately, separately from untouched originals.
      const saved=join(options.root,'legacy-snapshots',snapshot.sha256+'.json')
      if(!await readSpoolJson(saved,96*1024*1024))await writeSpoolJson(saved,{sha256:snapshot.sha256,bytes:bytes.toString('base64')},96*1024*1024)
    }
    let migrated=0
    for(const candidate of report.candidates){
      const snapshot=report.snapshots.find(s=>s.sha256===candidate.snapshot)
      if(!snapshot||!Number.isSafeInteger(candidate.offset)||candidate.offset<0)throw Error('migration-candidate-source-unavailable')
      const saved=await readSpoolJson<{bytes:string}>(join(options.root,'legacy-snapshots',snapshot.sha256+'.json'),96*1024*1024)
      const bytes=Buffer.from(saved!.bytes,'base64'),end=bytes.indexOf(10,candidate.offset)
      if(end<0||hashBytes(bytes.subarray(candidate.offset,end))!==candidate.lineSha256)throw Error('migration-line-changed')
      const record=parseLocalRecord(JSON.parse(bytes.subarray(candidate.offset,end).toString('utf8')))
      if(canonicalJson(record)!==canonicalJson(candidate.record))throw Error('migration-record-changed')
      const tracked=join(options.root,'legacy-sources',hashBytes(resolve(report.sourceRoot,snapshot.path))+'.json')
      const state=(await readSpoolJson<LegacySourceState>(tracked))!
      const previous=state.lines[String(candidate.offset)]
      if(previous&&previous.lineSha256!==candidate.lineSha256)throw Error('migration-line-history-changed')
      const captureKey=previous?.captureKey??'legacy:'+hashBytes(canonicalJson([snapshot.sha256,candidate.offset]))
      if(!previous)await writeSpoolJson(tracked,{...state,lines:{...state.lines,[candidate.offset]:{lineSha256:candidate.lineSha256,captureKey}}})
      await enqueueEvent(options.root,{schemaVersion:2,eventId:randomUUID(),captureKey,destination:mapping[record.repo]!,payload:{schemaVersion:2,recordKind:'execution',utcDay:new Date(record.ts).toISOString().slice(0,10),stage:record.stage??'unknown',outcome:record.outcome??'unknown',historicalNonAttributed:true,values:JSON.parse(serializeRecord(record))}})
      migrated++
    }
    for(const invalid of report.invalid)await quarantineSpool(options.root,'legacy:'+invalid.source,invalid.reason,invalid.bytes,invalid.action)
    for(const snapshot of report.snapshots){const tracked=join(options.root,'legacy-sources',hashBytes(resolve(report.sourceRoot,snapshot.path))+'.json');const state=(await readSpoolJson<LegacySourceState>(tracked))!;await writeSpoolJson(tracked,{...state,migrated:true})}
    return{migrated,invalid:report.invalid.length}
  },2000)
}

interface LegacySourceState extends LegacySnapshot {migrated:boolean;lines:Record<string,{lineSha256:string;captureKey:string}>}
export async function legacyMigrationComplete(root:string,file:string):Promise<boolean>{
  const state=await readSpoolJson<LegacySourceState>(join(root,'legacy-sources',hashBytes(resolve(file))+'.json'))
  return state?.migrated===true&&state.sha256===hashBytes(await readFile(file))
}
