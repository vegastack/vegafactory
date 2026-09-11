import { expect, test } from 'bun:test'
import { parseRecordLine, readRecords } from '../src/lib/stats/record'
import { compareMonths, monthToken, parseMonth } from '../src/lib/stats/month'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterOptions, parseFilters } from '../src/lib/cache/filters'
import { openCache, refreshCache } from '../src/lib/cache/build'
import { perSkill } from '../src/lib/cache/queries'

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

test('legacy adapter rejects retained credential and path variants without echoing skipped content',()=>{
 const safe={ts,repo,stage:'corrections',harness:'codex',model:'gpt-5.6',effort:'high',mode:'headless',human:'kmanojkumar',outcome:'complete',skills:[{name:'dev-implement',trigger:'typed',harness:'codex'}]}
 expect(parseRecordLine(JSON.stringify(safe))).toMatchObject({stage:'corrections',outcome:'complete'})
 expect(parseRecordLine(JSON.stringify({...safe,outcome:'for-operator'}))).toMatchObject({outcome:'handback'})
 expect(parseRecordLine(JSON.stringify({...safe,stage:'ship'}))).toMatchObject({stage:'ship'})
 const encode=(value:string)=>Buffer.from(value).toString('base64').replace(/=+$/,'')
 const encoded=(value:string)=>[encode(value),encode(encode(value)),encode(encode(encode(value)))]
 const canaries=['ghp_12345678901234567890','%67%68%70%5f12345678901234567890',...encoded('ghp_12345678901234567890'),'/Users/private/project','%2FUsers%2Fprivate%2Fproject',...encoded('/Users/private/project'),'C:\\Users\\private\\project','C%3A%5CUsers%5Cprivate%5Cproject',...encoded('C:\\Users\\private\\project'),'-----BEGIN PRIVATE KEY-----',...encoded('-----BEGIN PRIVATE KEY-----'),encode('private\ncontent-long'),encode('private\0content-long')]
 const lines:string[]=[]
 for(const canary of canaries){
  for(const field of ['ts','repo','stage','harness','model','effort','mode','human','outcome'] as const)lines.push(JSON.stringify({...safe,[field]:field==='repo'?`o/${canary}`:canary}))
  for(const field of ['name','trigger','harness'] as const)lines.push(JSON.stringify({...safe,skills:[{...safe.skills[0],[field]:canary}]}))
 }
 lines.push(JSON.stringify({...safe,harness:'x'.repeat(129)}),JSON.stringify({...safe,stage:'deploy'}),JSON.stringify({...safe,mode:'batch'}),JSON.stringify({...safe,outcome:'ready'}),JSON.stringify({...safe,skills:[{...safe.skills[0],trigger:'implicit'}]}),JSON.stringify({...safe,skills:Array.from({length:129},()=>safe.skills[0])}))
 const result=readRecords(lines.join('\n'),'stats/o__r/SEP-2026/canary.jsonl')
 expect(result).toEqual({records:[],skipped:lines.length,source:'stats/o__r/SEP-2026/canary.jsonl'})
 const summary=JSON.stringify(result)
 expect(summary).not.toContain('ghp_');expect(summary).not.toContain('/Users/');expect(summary).not.toContain('%67%68%70')
})

test('legacy privacy rejection precedes attributed and non-attributed cache, filter and skill sinks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'legacy-privacy-149-')),source=join(root,'stats','vegastack__vegafactory','SEP-2026','mini.jsonl')
 const safe={ts,repo,issue:149,stage:'ship',harness:'codex',model:'gpt-5.6',effort:'high',mode:'headless',human:'kmanojkumar',outcome:'complete',skills:[{name:'dev-implement',trigger:'typed',harness:'codex'}]}
 const canary='ghp_12345678901234567890',unsafe={...safe,model:canary,skills:[{name:canary,trigger:'typed',harness:'codex'}]}
 try{
  await mkdir(join(source,'..'),{recursive:true});await writeFile(source,[JSON.stringify(safe),JSON.stringify(unsafe)].join('\n')+'\n')
  const original=await readFile(source,'utf8')
  for(const attributed of [true,false]){
   const db=await openCache(join(root,attributed?'attributed.db':'non-attributed.db'))
   try{
    const result=await refreshCache(db,root,{org:'vegastack',allowedRepos:[repo],legacyRecord:record=>attributed?record:{...record,issue:null,parent:null,human:null,reviewRounds:null,fixRounds:null,handbacks:null}})
    expect(result).toMatchObject({total:1,skippedLines:1})
    expect(JSON.stringify(db.query('select * from runs').all())).not.toContain(canary)
    expect(JSON.stringify(db.query('select * from skill_invocations').all())).not.toContain(canary)
    const options=filterOptions(db,{[repo]:'dev'},[repo])
    expect(options).toMatchObject({harnesses:['codex'],models:['gpt-5.6']});expect(JSON.stringify(options)).not.toContain(canary)
    const filters={...parseFilters({month:'SEP-2026'},options,{[repo]:'dev'},[repo]),allowedRepos:[repo],attributedRepos:attributed?[repo]:[]}
    expect(perSkill(db,filters)).toMatchObject([{name:'dev-implement',invocations:1,triggers:{typed:1},outcomes:{complete:1}}])
    expect(JSON.stringify(perSkill(db,filters))).not.toContain(canary)
    const run=db.query<{human:string|null;issue:number|null}>('select human,issue from runs').get()
    expect(run).toEqual(attributed?{human:'kmanojkumar',issue:149}:{human:null,issue:null})
   }finally{db.close()}
  }
  expect(await readFile(source,'utf8')).toBe(original)
 }finally{await rm(root,{recursive:true,force:true})}
})

import { readExport, validateExport } from '../src/lib/stats/record'
import { serializeExport } from '../../cli/src/stats/privacy'
test('dashboard consumes the same strict three-variant production wire boundary',()=>{
 const wire=serializeExport({schemaVersion:2,recordKind:'execution',utcDay:'2026-09-06',stage:'implement',outcome:'succeeded',costUsd:null},{host:'github.com',org:'o',repo:'o/r',controlRoom:'o/room'},'9d31a521-53ea-4c39-bb58-213739ab6d47',{values:{'stats-export':'non-attributed'}})!
 expect(readExport(JSON.stringify(wire))).toMatchObject({eventId:wire.eventId,payload:{recordKind:'execution',costUsd:null,historicalNonAttributed:true}})
 expect(()=>validateExport({...wire,rawTranscript:'CANARY'})).toThrow()
 expect(()=>readExport(JSON.stringify({...wire,coverage:{costUsd:{known:1,unknown:0,raw:'CANARY'}}}))).toThrow()
})
