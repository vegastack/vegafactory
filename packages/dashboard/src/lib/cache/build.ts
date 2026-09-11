import { randomUUID } from 'node:crypto'
import { acquireClaim, inspectClaim, processIdentity, releaseClaim, type Claim } from '../../../../cli/src/claims'
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { readRecords, type StatsRecord } from '../stats/record'
import { readEventBatch, destinationKey, canonicalJson, hashBytes, type ExportReader, type ExportedEvent } from '../../../../cli/src/stats/types'
import { CACHE_SCHEMA_VERSION, SCHEMA_SQL } from './schema'
import { readExport as strictReadExport, validateExport } from '../stats/record'
import type { TaskActivityCollection } from '../../../../cli/src/stats/timeline'
import { parseActivityCollection, subscriptionFee, type SubscriptionFee } from '../../../../cli/src/stats/metrics'

export { CACHE_SCHEMA_VERSION } from './schema'

// The slice of bun:sqlite's Database this package uses, declared structurally so nothing here
// imports Bun's types at build time — `next build` runs under Node and would not resolve them.
export interface Statement<T> {
  all(...params: unknown[]): T[]
  get(...params: unknown[]): T | null
  run(...params: unknown[]): unknown
}
export interface Db {
  query<T>(sql: string): Statement<T>
  run(sql: string, ...params: unknown[]): unknown
  close(): void
}

interface SqliteModule {
  Database: new (file: string, options?: { create?: boolean; readwrite?: boolean; readonly?: boolean }) => Db
}

// The specifier is computed and carries both bundlers' ignore comments, so neither Turbopack nor
// webpack tries to resolve a Bun built-in that has no npm counterpart. Under Node this import
// simply fails, and the message says the one thing worth saying about it.
const SQLITE = ['bun', 'sqlite'].join(':')

async function loadSqlite(): Promise<SqliteModule> {
  try {
    return (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ SQLITE)) as unknown as SqliteModule
  } catch {
    throw new Error('the dashboard server runs under Bun; bun:sqlite is unavailable')
  }
}

function initialise(db: Db): void {
  db.run(SCHEMA_SQL)
  db.run(`pragma user_version = ${CACHE_SCHEMA_VERSION}`)
}

// Existing generations are evidence for active readers. Opening never repairs or deletes one.
export async function openCache(file: string): Promise<Db> {
  const { Database } = await loadSqlite()
  await mkdir(dirname(file), { recursive: true })
  const existing = await stat(file).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  const db = new Database(file, { create: !existing, readwrite: true })
  try {
    if (!existing) initialise(db)
    else if (db.query<{ user_version: number }>('pragma user_version').get()?.user_version !== CACHE_SCHEMA_VERSION)
      throw new Error('cache-schema-mismatch: preserve the existing generation and rebuild separately')
    return db
  } catch (error) { db.close(); throw error }
}

export interface Source {
  path: string
  relative: string
  size: number
  mtimeMs: number
}

// Walks <controlRoom>/stats for JSONL files. Symlinks are skipped in both directions — a linked
// directory could walk out of the clone, and a linked file could read anything on the machine.
export async function discoverSources(controlRoom: string): Promise<Source[]> {
  const root = join(controlRoom, 'stats')
  const found: Source[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && (entry.name.endsWith('.jsonl') || dir.endsWith('/events') && entry.name.endsWith('.json'))) {
        const info = await stat(path)
        found.push({ path, relative: relative(controlRoom, path).split(sep).join('/'), size: info.size, mtimeMs: info.mtimeMs })
      }
    }
  }
  await walk(root)
  return found.sort((a, b) => a.relative.localeCompare(b.relative))
}

const RUN_COLUMNS = [
  'source', 'ts', 'month', 'repo', 'issue', 'parent', 'stage', 'harness', 'model', 'effort', 'mode',
  'human', 'session_id', 'worktree', 'duration_s', 'turns', 'tool_calls', 'subagents', 'tokens_in',
  'tokens_out', 'cache_read', 'cache_write', 'cost_usd', 'outcome', 'review_rounds', 'fix_rounds', 'handbacks',
] as const

const runValues = (record: StatsRecord, source: string): unknown[] => [
  source, record.ts, record.month, record.repo, record.issue, record.parent, record.stage, record.harness,
  record.model, record.effort, record.mode, record.human, record.sessionId, record.worktree, record.durationS,
  record.turns, record.toolCalls, record.subagents, record.tokensIn, record.tokensOut, record.cacheRead,
  record.cacheWrite, record.costUsd, record.outcome, record.reviewRounds, record.fixRounds, record.handbacks,
]

export interface RefreshResult {
  /** Control-room-relative paths re-read on this pass. */
  ingested: string[]
  /** Paths whose file has vanished; their rows are gone from the cache. */
  removed: string[]
  /** Lines this pass could not parse as records. */
  skippedLines: number
  /** Runs the cache holds after the pass — its size, not this pass's delta. */
  total: number
  eventTotal: number
  invalidEvents: number
  duplicateEvents: number
  metricVersion: 2
  sourceDigest: string
  organization: string | null
}

export interface RefreshOptions {
  readExport?:ExportReader
  projectEvent?:(event:ExportedEvent)=>ExportedEvent|null
  legacyRecord?:(record:StatsRecord)=>StatsRecord|null
  /** Production callers supply their current authorized scope before any cache write. */
  allowedRepos?:string[]|null
  org?:string
  activityCollections?:Array<{repo:string;period:string;collection:TaskActivityCollection}>
  subscriptionFee?:SubscriptionFee|null
}
// Read and validate before opening the synchronous transaction. Source associations,
// legacy rows, event identities and derived metadata all commit or roll back together.
export async function refreshCache(db:Db,controlRoom:string,options:RefreshOptions={}):Promise<RefreshResult>{
  const allowed=options.allowedRepos===undefined?null:options.allowedRepos
  const permitted=(repo:string)=>allowed===null||allowed.includes(repo)
  const sources=(await discoverSources(controlRoom)).filter(source=>{
    if(allowed===null)return true
    const segment=source.relative.split('/')[1]
    return allowed.some(repo=>{const name=repo.replaceAll('/','__');return segment===name||segment===name+'-'+hashBytes(repo).slice(0,12)})
  })
  const known=new Map(db.query<{path:string;size:number;mtime_ms:number}>('select path,size,mtime_ms from sources').all().map(row=>[row.path,row]))
  const hashes=new Map(db.query<{path:string;content_sha256:string}>('select path,content_sha256 from metric_sources').all().map(row=>[row.path,row.content_sha256]))
  const inputs:Array<{source:string;bytes:string}>=[],legacy:Array<{source:Source;records:StatsRecord[]}>=[],prepared:Array<{source:Source;digest:string}>=[]
  let skippedLines=0
  const reader=options.readExport??strictReadExport
  for(const source of sources){
    if(source.size>8*1024*1024)throw Error('metric-source-too-large')
    const bytes=await readFile(source.path,'utf8'),digest=hashBytes(bytes)
    if(source.path.endsWith('.json')){
      const read=reader(bytes),event=options.projectEvent?options.projectEvent(read):read
      if(!event)continue
      if(!permitted(event.destination.repo)||options.org&&event.destination.org!==options.org)continue
      // Cache only the currently permitted wire projection, never historical
      // attributed bytes that a stricter reader has deliberately removed.
      const {historicalNonAttributed:_historical,...payload}=event.payload as unknown as Record<string,unknown>
      const wire=validateExport({...payload,schemaVersion:2,metricVersion:2,eventId:event.eventId,destination:event.destination})
      inputs.push({source:source.relative,bytes:canonicalJson(wire)})
    }else{
      const parsed=readRecords(bytes,source.relative);skippedLines+=parsed.skipped
      legacy.push({source,records:parsed.records.filter(row=>permitted(row.repo)&&(!options.org||row.repo.split('/')[0]===options.org)).map(row=>options.legacyRecord?options.legacyRecord(row):row).filter((row):row is StatsRecord=>row!==null)})
    }
    prepared.push({source,digest})
  }
  const batch=readEventBatch(inputs,strictReadExport)
  if(batch.invalid.length)throw Error('metric-invalid-events')
  const collections=(options.activityCollections??[]).map(row=>{
    if(!permitted(row.repo)||options.org&&row.repo.split('/')[0]!==options.org)throw Error('metric-activity-scope-refused')
    return {...row,collection:parseActivityCollection(row.collection,row.repo)}
  })
  const fee=subscriptionFee(options.subscriptionFee),sourceDigest=hashBytes(canonicalJson(prepared.map(row=>[row.source.relative,row.digest])))
  const ingested=prepared.filter(row=>hashes.get(row.source.relative)!==row.digest).map(row=>row.source.relative)
  const seen=new Set(prepared.map(row=>row.source.relative)),removed=[...known.keys()].filter(path=>!seen.has(path))
  db.run('begin immediate')
  try{
    db.run('delete from skill_invocations');db.run('delete from runs');db.run('delete from event_sources');db.run('delete from events');db.run('delete from invalid_events');db.run('delete from sources');db.run('delete from metric_sources')
    const insertRun=db.query<{id:number}>(`insert into runs (${RUN_COLUMNS.join(',')}) values (${RUN_COLUMNS.map(()=>'?').join(',')}) returning id`)
    const insertSkill=db.query('insert into skill_invocations(run_id,name,trigger,harness) values(?,?,?,?)')
    for(const row of legacy)for(const record of row.records){const inserted=insertRun.get(...runValues(record,row.source.relative));if(!inserted)throw Error('metric-run-ingestion-failed');for(const hit of record.skills)insertSkill.run(inserted.id,hit.name,hit.trigger,hit.harness)}
    const insertSource=db.query('insert into sources(path,size,mtime_ms,ingested_at) values(?,?,?,?)'),insertHash=db.query('insert into metric_sources(path,content_sha256) values(?,?)')
    const at=new Date().toISOString()
    for(const row of prepared){insertSource.run(row.source.relative,row.source.size,row.source.mtimeMs,at);insertHash.run(row.source.relative,row.digest)}
    const insertInput=db.query('insert into event_sources(source,bytes) values(?,?)')
    for(const row of inputs)insertInput.run(row.source,row.bytes)
    const insertEvent=db.query('insert into events(destination,event_id,payload_sha256,payload_json) values(?,?,?,?)')
    for(const row of batch.events)insertEvent.run(destinationKey(row.event.destination),row.event.eventId,row.payloadSha256,canonicalJson(row.event.payload))
    if(allowed!==null){const old=db.query<{repo:string}>('select distinct repo from activity_collections').all();for(const row of old)if(!allowed.includes(row.repo))db.query('delete from activity_collections where repo=?').run(row.repo)}
    const insertCollection=db.query('insert into activity_collections(repo,period,payload_json) values(?,?,?) on conflict(repo,period) do update set payload_json=excluded.payload_json')
    for(const row of collections){
      let collection=row.collection
      if(!collection.complete){
        const old=db.query<{payload_json:string}>('select payload_json from activity_collections where repo=? and period=?').get(row.repo,row.period)
        if(old){const prior=parseActivityCollection(JSON.parse(old.payload_json),row.repo);collection={...prior,complete:false,reason:collection.reason}}
      }
      insertCollection.run(row.repo,row.period,canonicalJson(collection))
    }
    const metadata=db.query('insert into metric_metadata(key,value_json) values(?,?) on conflict(key) do update set value_json=excluded.value_json')
    for(const [key,value] of Object.entries({metricVersion:2,sourceDigest,organization:options.org??null,allowedRepos:allowed,subscriptionFee:fee,observedAt:at}))metadata.run(key,canonicalJson(value))
    db.run('commit')
  }catch(error){db.run('rollback');throw error}
  const total=db.query<{n:number}>('select count(*) as n from runs').get()?.n??0
  return {ingested,removed,skippedLines,total,eventTotal:batch.events.length,invalidEvents:0,duplicateEvents:batch.duplicates,metricVersion:2,sourceDigest,organization:options.org??null}
}

export interface GenerationMetadata {
  schemaVersion: number
  metricVersion: 2
  generation: string
  compatibilityKey: string
  org: string
  sourceDigest: string
  sourceObservedAt: string | null
  dataState: 'ready' | 'empty' | 'unavailable'
}
const generationName = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

// Incomplete live reads retain #148's last safely served activity rows. Generation identity and
// age therefore come from those persisted rows, never from the failed attempt's fresh timestamp
// or placeholder digest.
export function retainedGenerationProvenance(db: Db, metricSourceDigest: string, policyObservedAt: string | null): {
  sourceDigest: string
  sourceObservedAt: string | null
  activityTotal: number
  activityUnavailable: boolean
} {
  const persisted = db.query<{repo:string;period:string;payload_json:string}>('select repo,period,payload_json from activity_collections order by repo,period').all()
    .map(row => ({ repo: row.repo, period: row.period, collection: parseActivityCollection(JSON.parse(row.payload_json), row.repo) }))
  const available = persisted.filter(row => row.collection.complete || row.collection.sourceDigest !== '0'.repeat(64) || row.collection.activities.length + row.collection.snapshots.length > 0)
  const observations = [policyObservedAt, ...available.map(row => row.collection.observedAt)]
    .filter((at): at is string => !!at && Number.isFinite(Date.parse(at)))
  return {
    sourceDigest: hashBytes(canonicalJson({ metrics: metricSourceDigest, activity: available.map(row => ({ repo: row.repo, period: row.period, sourceDigest: row.collection.sourceDigest })) })),
    sourceObservedAt: observations.length ? new Date(Math.min(...observations.map(Date.parse))).toISOString() : null,
    activityTotal: available.reduce((count, row) => count + row.collection.activities.length + row.collection.snapshots.length, 0),
    activityUnavailable: persisted.some(row => !row.collection.complete) && available.length === 0,
  }
}

export async function directoryWithoutLinks(path: string): Promise<void> {
  const absolute = resolve(path)
  let current: string = sep
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = join(current, part)
    await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('cache namespace contains a link or non-directory')
  }
}
async function generationMetadata(path: string, org: string, key: string): Promise<GenerationMetadata | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as GenerationMetadata
    return raw && typeof raw === 'object' && Object.keys(raw).sort().join(',') === 'compatibilityKey,dataState,generation,metricVersion,org,schemaVersion,sourceDigest,sourceObservedAt' &&
      raw.schemaVersion === CACHE_SCHEMA_VERSION && raw.metricVersion === 2 && raw.org === org && raw.compatibilityKey === key &&
      generationName.test(raw.generation) && /^[a-f0-9]{64}$/.test(raw.sourceDigest) &&
      ['ready', 'empty', 'unavailable'].includes(raw.dataState) &&
      (raw.sourceObservedAt === null || Number.isFinite(Date.parse(raw.sourceObservedAt))) ? raw : null
  } catch { return null }
}
async function cacheClaim(namespace: string): Promise<Claim> {
  const identity = await processIdentity(), deadline = Date.now() + 10_000
  for (;;) {
    const result = await acquireClaim(join(namespace, 'writer.claim'), identity)
    if (result.kind === 'owned') return result.claim
    if (result.kind === 'refused' || Date.now() >= deadline) throw Error(`cache-writer-unavailable: ${result.reason}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
// Manifest publication, reader pin acquisition and reclamation share the same process-identity
// claim. Time is only a contention bound: a pin of unknown liveness always retains its generation.
async function reclaimGenerations(namespace: string): Promise<void> {
  const selected = new Set<string>()
  for (const entry of await readdir(namespace)) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue
    try { const m = JSON.parse(await readFile(join(namespace, entry), 'utf8')); if (generationName.test(m.generation)) selected.add(m.generation) } catch { return }
  }
  const root = join(namespace, 'generations')
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !generationName.test(entry.name) || selected.has(entry.name)) continue
    const dir = join(root, entry.name)
    let retained = false
    const pins = await readdir(join(dir, 'pins')).catch(() => null)
    if (!pins) continue
    for (const pin of pins) {
      if (!generationName.test(pin.replace(/\.claim$/, ''))) { retained = true; break }
      const state = await inspectClaim(join(dir, 'pins', pin))
      if (state.kind !== 'stopped' && state.kind !== 'absent') { retained = true; break }
    }
    if (!retained) await rm(dir, { recursive: true })
  }
}

export async function withCacheGeneration<T>(input: {
  namespace: string
  org: string
  compatibility: unknown
  refresh(db: Db): Promise<{ sourceDigest: string; sourceObservedAt: string | null; total: number; dataState?: 'ready' | 'empty' | 'unavailable' }>
}, consume: (db: Db, metadata: GenerationMetadata, stale: boolean) => Promise<T>): Promise<T> {
  await directoryWithoutLinks(input.namespace)
  await directoryWithoutLinks(join(input.namespace, 'generations'))
  const compatibilityKey = hashBytes(canonicalJson(input.compatibility))
  const manifest = join(input.namespace, `${compatibilityKey}.json`)
  const lock = await cacheClaim(input.namespace)
  let db: Db | null = null, pin: Claim | null = null
  let metadata: GenerationMetadata | null = null, stale = false
  try {
    const previous = await generationMetadata(manifest, input.org, compatibilityKey)
    const generation = randomUUID(), dir = join(input.namespace, 'generations', generation)
    await mkdir(dir, { mode: 0o700 }); await mkdir(join(dir, 'pins'), { mode: 0o700 })
    const file = join(dir, 'stats.db')
    try {
      if (previous) {
        const priorCheck = await openGeneration(input.namespace, previous)
        priorCheck.close()
        const prior = join(input.namespace, 'generations', previous.generation, 'stats.db')
        const info = await lstat(prior)
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw Error('cache-generation-not-regular')
        await copyFile(prior, file)
      }
      db = await openCache(file)
      const refreshed = await input.refresh(db)
      metadata = { schemaVersion: CACHE_SCHEMA_VERSION, metricVersion: 2, generation, compatibilityKey, org: input.org,
        sourceDigest: refreshed.sourceDigest, sourceObservedAt: refreshed.sourceObservedAt,
        dataState: refreshed.dataState ?? (refreshed.total > 0 ? 'ready' : 'empty') }
      db.run('insert or replace into metric_metadata(key,value_json) values (?,?)', 'generation', canonicalJson(metadata))
      if (db.query<{integrity_check:string}>('pragma integrity_check').get()?.integrity_check !== 'ok') throw Error('cache-integrity-check-failed')
      db.close(); db = null
      await writeFile(join(dir, 'metadata.json'), JSON.stringify(metadata), { flag: 'wx' })
      const temp = `${manifest}.${generation}.tmp`
      await writeFile(temp, JSON.stringify(metadata), { flag: 'wx' })
      await rename(temp, manifest)
    } catch (error) {
      db?.close(); db = null
      await rm(dir, { recursive: true, force: true })
      if (!previous) {
        // A failed first refresh still yields an identity-safe, empty read-only shell.
        await mkdir(dir, { mode: 0o700 }); await mkdir(join(dir, 'pins'), { mode: 0o700 })
        db = await openCache(file)
        metadata = { schemaVersion: CACHE_SCHEMA_VERSION, metricVersion: 2, generation, compatibilityKey, org: input.org, sourceDigest: '0'.repeat(64), sourceObservedAt: null, dataState: 'unavailable' }
        db.run('insert or replace into metric_metadata(key,value_json) values (?,?)', 'generation', canonicalJson(metadata))
        db.close(); db = null
        await writeFile(join(dir, 'metadata.json'), JSON.stringify(metadata), { flag: 'wx' })
      } else metadata = previous
      stale = true
    }
    const chosen = join(input.namespace, 'generations', metadata.generation)
    const acquired = await acquireClaim(join(chosen, 'pins', `${randomUUID()}.claim`), lock.identity)
    if (acquired.kind !== 'owned') throw Error(`cache-reader-pin-unavailable: ${acquired.reason}`)
    pin = acquired.claim
    db = await openGeneration(input.namespace, metadata)
    await reclaimGenerations(input.namespace)
  } catch (error) { db?.close(); if (pin) await releaseClaim(pin); throw error }
  finally { await releaseClaim(lock) }
  readiness.set(input.namespace, metadata!)
  try { return await consume(db!, metadata!, stale) }
  finally { db?.close(); if (pin) await releaseClaim(pin) }
}

async function openGeneration(namespace: string, metadata: GenerationMetadata): Promise<Db> {
  const directory = join(namespace, 'generations', metadata.generation)
  for (const path of [directory, join(directory, 'stats.db'), join(directory, 'metadata.json')]) {
    const info = await lstat(path)
    if (info.isSymbolicLink() || path !== directory && (!info.isFile() || info.nlink !== 1) || path === directory && !info.isDirectory()) throw Error('cache-generation-link-refused')
  }
  const disk = await generationMetadata(join(directory, 'metadata.json'), metadata.org, metadata.compatibilityKey)
  if (!disk || canonicalJson(disk) !== canonicalJson(metadata)) throw Error('cache-generation-identity-mismatch')
  const { Database } = await loadSqlite()
  const db = new Database(join(directory, 'stats.db'), { readonly: true })
  try {
    if (db.query<{user_version:number}>('pragma user_version').get()?.user_version !== CACHE_SCHEMA_VERSION ||
      db.query<{value_json:string}>('select value_json from metric_metadata where key = ?').get('generation')?.value_json !== canonicalJson(metadata) ||
      db.query<{integrity_check:string}>('pragma integrity_check').get()?.integrity_check !== 'ok') throw Error('cache-generation-identity-mismatch')
    return db
  } catch (error) { db.close(); throw error }
}

const readiness = new Map<string, GenerationMetadata>()
export function cacheReadiness(namespace: string, org: string): {dataState: 'ready'|'empty'|'unavailable'; sourceAgeSeconds: number|null} {
  const current = readiness.get(namespace)
  if (!current || current.org !== org) return {dataState: 'unavailable', sourceAgeSeconds: null}
  return {dataState: current.dataState, sourceAgeSeconds: current.sourceObservedAt === null ? null : Math.max(0, Math.floor((Date.now() - Date.parse(current.sourceObservedAt)) / 1000))}
}
