// When an issue was in which state. Time per stage is only true if a turn is credited to the stage
// the issue was in *then*, so the answer can never be "whatever label it carries now".
//
// Two sources, both local. The CLI appends a line whenever it sets an issue's labels itself — the
// line reads "this issue was in this state at this time", so writing it again for an unchanged
// state costs nothing — and the status comment saves the label spans it already reads from GitHub.
// When neither can answer for a moment, the answer is null: a turn with no stage, rather than a
// turn in the wrong one.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertRepo } from './issue-cache.ts'

export interface StageChange { at: string; state: string | null }

export const stageLogPath = (root: string, repo: string) =>
  join(root, '.vegastack', '.tmp', 'issues', assertRepo(repo).replace('/', '__'), 'stages.jsonl')

export const stageSpansPath = (dir: string) => join(dir, 'stages.json')

// Written as the labels are set, so the time is the change's own.
export function recordStage(root: string, repo: string, issue: number, state: string, at = new Date()) {
  try {
    const path = stageLogPath(root, repo)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify({ at: at.toISOString(), issue, state }) + '\n')
  } catch { /* a missing stage line costs a stage, never a command */ }
}

// The spans the status comment already read from GitHub's label timeline, kept beside the issue.
export function saveSpans(dir: string, spans: Array<{ stage: string; start: string; end: string | null }>) {
  try {
    const path = stageSpansPath(dir)
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(spans) + '\n')
    renameSync(temp, path)
  } catch { /* the spans are a cache, never the point of the call */ }
}

function fromLog(root: string, repo: string, issue: number): StageChange[] {
  try {
    return readFileSync(stageLogPath(root, repo), 'utf8').split('\n').flatMap((line) => {
      if (!line.trim()) return []
      const entry = JSON.parse(line) as { at?: unknown; issue?: unknown; state?: unknown }
      if (entry.issue !== issue || typeof entry.at !== 'string' || typeof entry.state !== 'string') return []
      return Number.isFinite(Date.parse(entry.at)) ? [{ at: entry.at, state: entry.state }] : []
    })
  } catch { return [] }
}

function fromSpans(dir: string): StageChange[] {
  try {
    const spans = JSON.parse(readFileSync(stageSpansPath(dir), 'utf8')) as Array<{ stage?: unknown; start?: unknown; end?: unknown }>
    if (!Array.isArray(spans)) return []
    const changes: StageChange[] = []
    for (const span of spans) {
      if (typeof span?.stage !== 'string' || typeof span.start !== 'string' || !Number.isFinite(Date.parse(span.start))) continue
      changes.push({ at: span.start, state: span.stage })
      // A span that ended with nothing after it means the issue carried no state label from there.
      if (typeof span.end === 'string' && Number.isFinite(Date.parse(span.end))) changes.push({ at: span.end, state: null })
    }
    return changes
  } catch { return [] }
}

// Everything known about one issue's stages, oldest first. At one instant the end of a span is
// read before what replaced it, and a line this CLI wrote wins over a span that reads the same
// moment: the line is the change itself, not a later reading of it.
export function stageHistory(root: string, repo: string, issue: number, dir: string): StageChange[] {
  const log = fromLog(root, repo, issue).map((change) => ({ ...change, local: true }))
  const spans = fromSpans(dir).map((change) => ({ ...change, local: false }))
  return [...log, ...spans]
    .sort((a, b) =>
      Date.parse(a.at) - Date.parse(b.at)
      || Number(a.state !== null) - Number(b.state !== null)
      || Number(b.local) - Number(a.local))
    .map(({ at, state }) => ({ at, state }))
}

// The state in force at that instant; null when nothing recorded covers it.
export function stageOn(history: StageChange[], at: number): string | null {
  let state: string | null = null
  let known = false
  for (const change of history) {
    const changed = Date.parse(change.at)
    if (!Number.isFinite(changed) || changed > at) break
    state = change.state
    known = true
  }
  return known ? state : null
}
