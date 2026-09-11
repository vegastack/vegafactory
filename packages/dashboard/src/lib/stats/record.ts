import { RECORD_FIELDS } from '../../../../cli/src/stats/record.ts'
import { projectLegacyStats } from '../../../../cli/src/stats/privacy.ts'
// Production event validation is shared with transport and survives the dashboard bundle.
export { readExport, validateExport } from '../../../../cli/src/stats/privacy.ts'
export type { ExportMeasurement } from '../../../../cli/src/stats/types.js'
import { monthToken } from './month.ts'

// The run record #121 writes, re-declared here rather than imported: the dashboard is fetched
// as its own tarball onto machines that have no CLI source tree. Every field but `ts`, `repo`
// and the derived `month` is nullable. This explicit legacy adapter refuses unknown keys;
// schema2 events use the shared strict validator and retain their separate discriminant.
export interface SkillHit {
  name: string
  trigger: string | null
  harness: string | null
}

export interface StatsRecord {
  ts: string
  month: string
  repo: string
  issue: number | null
  parent: number | null
  stage: string | null
  harness: string | null
  model: string | null
  effort: string | null
  mode: string | null
  human: string | null
  sessionId: string | null
  worktree: string | null
  durationS: number | null
  turns: number | null
  toolCalls: number | null
  subagents: number | null
  tokensIn: number | null
  tokensOut: number | null
  cacheRead: number | null
  cacheWrite: number | null
  costUsd: number | null
  outcome: string | null
  reviewRounds: number | null
  fixRounds: number | null
  handbacks: number | null
  skills: SkillHit[]
}

const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

// A line is only a record when it carries a parseable timestamp and an `owner/name` repo — the
// two fields every query groups by. Anything else is counted as skipped rather than guessed at,
// so a half-written line at the tail of a JSONL file costs one row and never a whole file.
export function parseRecordLine(line: string): StatsRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const row = parsed as Record<string, unknown>
  if(Object.keys(row).some(key=>!RECORD_FIELDS.includes(key as typeof RECORD_FIELDS[number])))return null
  for(const key of ['issue','parent','duration_s','turns','tool_calls','subagents','cost_usd','review_rounds','fix_rounds','handbacks']){const value=row[key];if(value!==undefined&&value!==null&&(typeof value!=='number'||!Number.isFinite(value)||value<0))return null}
  if(row.tokens!==undefined&&(!row.tokens||typeof row.tokens!=='object'||Array.isArray(row.tokens)||Object.entries(row.tokens).some(([key,value])=>!['in','out','cache_read','cache_write'].includes(key)||value!==null&&(typeof value!=='number'||!Number.isFinite(value)||value<0))))return null
  if(row.skills!==undefined&&(!Array.isArray(row.skills)||row.skills.length>128||row.skills.some(raw=>!raw||typeof raw!=='object'||Object.keys(raw).some(key=>!['name','trigger','harness'].includes(key)))))return null

  let retained:ReturnType<typeof projectLegacyStats>
  try {
    const skills=Array.isArray(row.skills)?row.skills.map(raw=>{
      if(!raw||typeof raw!=='object'||Array.isArray(raw))return raw
      const skill=raw as Record<string,unknown>
      return {name:skill.name??null,trigger:skill.trigger??null,harness:skill.harness??null}
    }):row.skills??[]
    retained=projectLegacyStats({ts:row.ts??null,repo:row.repo??null,stage:row.stage??null,harness:row.harness??null,model:row.model??null,effort:row.effort??null,mode:row.mode??null,human:row.human??null,outcome:row.outcome??null,skills})
  } catch {
    return null
  }
  const at = new Date(retained.ts)

  const tokens = (row.tokens && typeof row.tokens === 'object' ? row.tokens : {}) as Record<string, unknown>

  return {
    ts: retained.ts,
    month: monthToken(at),
    repo: retained.repo,
    issue: asNumber(row.issue),
    parent: asNumber(row.parent),
    stage: retained.stage,
    harness: retained.harness,
    model: retained.model,
    effort: retained.effort,
    mode: retained.mode,
    human: retained.human,
    sessionId: null,
    worktree: null,
    durationS: asNumber(row.duration_s),
    turns: asNumber(row.turns),
    toolCalls: asNumber(row.tool_calls),
    subagents: asNumber(row.subagents),
    tokensIn: asNumber(tokens.in),
    tokensOut: asNumber(tokens.out),
    cacheRead: asNumber(tokens.cache_read),
    cacheWrite: asNumber(tokens.cache_write),
    costUsd: asNumber(row.cost_usd),
    outcome: retained.outcome,
    reviewRounds: asNumber(row.review_rounds),
    fixRounds: asNumber(row.fix_rounds),
    handbacks: asNumber(row.handbacks),
    skills: retained.skills,
  }
}

// `source` is the control-room-relative path of the file these lines came from; it is carried
// so a caller can name the file in a skipped-line count, and stored on the cache's `runs.source`
// column by the ingest in Task 3.
export function readRecords(body: string, source: string): { records: StatsRecord[]; skipped: number; source: string } {
  const records: StatsRecord[] = []
  let skipped = 0
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue
    const record = parseRecordLine(line)
    if (record) records.push(record)
    else skipped += 1
  }
  return { records, skipped, source }
}

// Both package consumers use the same versioned definitions; release packaging
// verifies this shared code is bundled rather than requiring a sibling checkout.
export { METRIC_DICTIONARY, summarizeMeasured, summarizeExecutions } from '../../../../cli/src/stats/metrics.ts'
