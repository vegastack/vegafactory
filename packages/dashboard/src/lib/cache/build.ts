import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

import { readRecords, type StatsRecord } from '../stats/record'
import { readEventBatch, destinationKey, canonicalJson, type ExportReader } from '../../../../cli/src/stats/types'
import { CACHE_SCHEMA_VERSION, SCHEMA_SQL } from './schema'

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
}

// The rebuild rule: a source whose size and mtime match what the cache recorded is left alone; a
// changed one has its rows deleted and re-inserted; a vanished one has its rows deleted. One
// stat per file is the whole cost of a warm start.
export async function refreshCache(db: Db, controlRoom: string, options: {readExport?:ExportReader} = {}): Promise<RefreshResult> {
  const sources = await discoverSources(controlRoom)
  const known = new Map(
    db.query<{ path: string; size: number; mtime_ms: number }>('select path, size, mtime_ms from sources')
      .all()
      .map((row) => [row.path, row]),
  )

  const insertRun = db.query<{ id: number }>(
    `insert into runs (${RUN_COLUMNS.join(', ')}) values (${RUN_COLUMNS.map(() => '?').join(', ')}) returning id`,
  )
  const insertSkill = db.query('insert into skill_invocations (run_id, name, trigger, harness) values (?, ?, ?, ?)')
  const dropRuns = db.query('delete from runs where source = ?')
  const dropSkills = db.query('delete from skill_invocations where run_id in (select id from runs where source = ?)')
  const upsertSource = db.query(
    'insert into sources (path, size, mtime_ms, ingested_at) values (?, ?, ?, ?) on conflict(path) do update set size = excluded.size, mtime_ms = excluded.mtime_ms, ingested_at = excluded.ingested_at',
  )
  const dropSource = db.query('delete from sources where path = ?')

  const ingested: string[] = []
  let skippedLines = 0
  const seen = new Set<string>()

  for (const source of sources) {
    seen.add(source.relative)
    const previous = known.get(source.relative)
    if (previous && previous.size === source.size && previous.mtime_ms === source.mtimeMs) continue

    const body = await readFile(source.path, 'utf8')
    if(source.path.endsWith('.json')) {
      db.query('insert into event_sources(source,bytes) values(?,?) on conflict(source) do update set bytes=excluded.bytes').run(source.relative,body)
      upsertSource.run(source.relative,source.size,source.mtimeMs,new Date().toISOString())
      ingested.push(source.relative)
      continue
    }
    const { records, skipped } = readRecords(body, source.relative)
    skippedLines += skipped

    dropSkills.run(source.relative)
    dropRuns.run(source.relative)
    for (const record of records) {
      const row = insertRun.get(...runValues(record, source.relative))
      if (!row) continue
      for (const hit of record.skills) insertSkill.run(row.id, hit.name, hit.trigger, hit.harness)
    }
    upsertSource.run(source.relative, source.size, source.mtimeMs, new Date().toISOString())
    ingested.push(source.relative)
  }

  const removed: string[] = []
  for (const path of known.keys()) {
    if (seen.has(path)) continue
    dropSkills.run(path)
    dropRuns.run(path)
    dropSource.run(path)
    db.query('delete from event_sources where source=?').run(path)
    removed.push(path)
  }

  // Rebuild the small identity index atomically from retained source associations. Removing
  // one duplicate file never removes the event still supplied by another source.
  const batch=readEventBatch(db.query<{source:string;bytes:string}>('select source,bytes from event_sources order by source').all(),options.readExport)
  db.run('begin immediate')
  try {
    db.run('delete from events');db.run('delete from invalid_events')
    const insert=db.query('insert into events(destination,event_id,payload_sha256,payload_json) values(?,?,?,?)')
    for(const row of batch.events)insert.run(destinationKey(row.event.destination),row.event.eventId,row.payloadSha256,canonicalJson(row.event.payload))
    const invalid=db.query('insert or replace into invalid_events(source,reason,bytes) values(?,?,?)')
    for(const row of batch.invalid)invalid.run(row.source,row.reason,row.bytes)
    db.run('commit')
  }catch(error){db.run('rollback');throw error}
  const total = db.query<{ n: number }>('select count(*) as n from runs').get()?.n ?? 0
  return { ingested, removed, skippedLines, total, eventTotal:batch.events.length, invalidEvents:batch.invalid.length, duplicateEvents:batch.duplicates }
}
