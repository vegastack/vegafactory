import { expect, test } from 'bun:test'
import { parseRecordLine, readRecords } from '../src/lib/stats/record'
import { compareMonths, monthToken, parseMonth } from '../src/lib/stats/month'

const ts = '2026-09-02T10:00:00.000Z'
const repo = 'vegastack/vegafactory'

test('a full line maps to the view shape; absent fields are null; bad lines are counted', () => {
  const record = parseRecordLine(JSON.stringify({
    ts, repo, issue: 122, stage: 'implement', harness: 'claude', human: 'kmanojkumar',
    tokens: { in: 1000, out: 200, cache_read: 50, cache_write: 10 }, cost_usd: 0.42,
    skills: [{ name: 'dev-implement', trigger: 'model' }],
  }))!
  expect(record.month).toBe('SEP-2026')
  expect(record.tokensIn).toBe(1000)
  expect(record.cacheWrite).toBe(10)
  expect(record.skills[0]!.name).toBe('dev-implement')
  expect(parseRecordLine(JSON.stringify({ ts, repo }))!.costUsd).toBeNull()
  expect(parseRecordLine(JSON.stringify({ ts, repo: 'nope' }))).toBeNull()
  expect(readRecords(['{bad', JSON.stringify({ ts, repo })].join('\n'), 'stats/x/SEP-2026/m.jsonl'))
    .toMatchObject({ skipped: 1 })
  expect(monthToken(new Date(ts))).toBe('SEP-2026')
  expect(parseMonth('sep-2026')).toBeNull()
  expect(['SEP-2026', 'AUG-2026'].sort(compareMonths)).toEqual(['AUG-2026', 'SEP-2026'])
})

test('legacy adapter refuses nested unknown fields and never returns session or local paths',()=>{
 expect(parseRecordLine(JSON.stringify({ts,repo,extra:'CANARY'}))).toBeNull()
 expect(parseRecordLine(JSON.stringify({ts,repo,tokens:{in:0,raw:'CANARY'}}))).toBeNull()
 expect(parseRecordLine(JSON.stringify({ts,repo,cost_usd:-1}))).toBeNull()
 expect(parseRecordLine(JSON.stringify({ts,repo,session_id:'CANARY',worktree:'/Users/CANARY'}))).toMatchObject({sessionId:null,worktree:null})
})

import { readExport, validateExport } from '../src/lib/stats/record'
import { serializeExport } from '../../cli/src/stats/privacy'
test('dashboard consumes the same strict three-variant production wire boundary',()=>{
 const wire=serializeExport({schemaVersion:2,recordKind:'execution',utcDay:'2026-09-06',stage:'implement',outcome:'succeeded',costUsd:null},{host:'github.com',org:'o',repo:'o/r',controlRoom:'o/room'},'9d31a521-53ea-4c39-bb58-213739ab6d47',{values:{'stats-export':'non-attributed'}})!
 expect(readExport(JSON.stringify(wire))).toMatchObject({eventId:wire.eventId,payload:{recordKind:'execution',costUsd:null,historicalNonAttributed:true}})
 expect(()=>validateExport({...wire,rawTranscript:'CANARY'})).toThrow()
 expect(()=>readExport(JSON.stringify({...wire,coverage:{costUsd:{known:1,unknown:0,raw:'CANARY'}}}))).toThrow()
})
