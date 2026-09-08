import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

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
  Database: new (file: string, options?: { create?: boolean }) => Db
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

// A cache whose schema version differs, or that will not open or read at all, is deleted and
// rebuilt rather than repaired. Every row in it is reproducible from the control-room clone, so
// throwing the file away costs one re-ingest and never any data.
export async function openCache(file: string): Promise<Db> {
  const { Database } = await loadSqlite()
  // The cache path is the server's to own: `vegafactory dashboard` names ~/.vegastack/cache/stats.db
  // and nothing creates that directory, because the file is derived and may be deleted at any time.
  await mkdir(dirname(file), { recursive: true })
  const fresh = async (): Promise<Db> => {
    await rm(file, { force: true })
    const db = new Database(file, { create: true })
    initialise(db)
    return db
  }
  let db: Db
  try {
    db = new Database(file, { create: true })
  } catch {
    return fresh()
  }
  try {
    const version = db.query<{ user_version: number }>('pragma user_version').get()?.user_version ?? 0
    if (version !== CACHE_SCHEMA_VERSION) {
      db.close()
      return fresh()
    }
    db.run(SCHEMA_SQL)
    return db
  } catch {
    try {
      db.close()
    } catch {
      // an unopenable file has nothing to close cleanly; the delete below is the recovery
    }
    return fresh()
  }
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
    } catch {
      return
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
