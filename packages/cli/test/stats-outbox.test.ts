import { expect, test, beforeEach } from 'bun:test'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeRecord } from '../src/stats/record.ts'
import {
  OutboxRefusal, outboxFile, sanitizeHostname, appendRecord, listOutbox,
  dropOutboxFiles, appendSkillInvocations, takeSkillInvocations,
} from '../src/stats/outbox.ts'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'vsk-outbox-')) })
const record = (issue: number) => normalizeRecord({
  repo: 'vegastack/vegafactory', ts: '2026-09-03T10:00:00.000Z', issue, stage: 'implement',
})

test('hostnames are sanitised and the outbox path is one segment per repo, month and host', () => {
  expect(sanitizeHostname('MK-Mac-mini.local')).toBe('mk-mac-mini')
  expect(sanitizeHostname('box 01/prod')).toBe('box-01-prod')
  expect(outboxFile(home, 'vegastack/vegafactory', 'SEP-2026', 'mini'))
    .toBe(join(home, '.vegastack/stats/outbox/vegastack__vegafactory/SEP-2026/mini.jsonl'))
})

test('appendRecord creates the tree and appends one line per record', async () => {
  const file = await appendRecord(home, record(121), 'mini')
  await appendRecord(home, record(122), 'mini')
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
  expect(lines).toHaveLength(2)
  expect(JSON.parse(lines[1]!).issue).toBe(122)
})

test('a record with problems is refused, not written', async () => {
  const broken = { ...record(121), repo: '' }
  await expect(appendRecord(home, broken, 'mini')).rejects.toBeInstanceOf(OutboxRefusal)
})

test('a symlinked outbox file is refused and named', async () => {
  const file = outboxFile(home, 'vegastack/vegafactory', 'SEP-2026', 'mini')
  await mkdir(join(home, '.vegastack/stats/outbox/vegastack__vegafactory/SEP-2026'), { recursive: true })
  await writeFile(join(home, 'elsewhere.jsonl'), '')
  await symlink(join(home, 'elsewhere.jsonl'), file)
  await expect(appendRecord(home, record(121), 'mini')).rejects.toThrow(file)
})

test('listOutbox replays every pending batch after a failed push', async () => {
  await appendRecord(home, record(121), 'mini')
  await appendRecord(home, { ...record(130), ts: '2026-10-01T00:00:00.000Z' }, 'mini')
  const batches = await listOutbox(home)
  expect(batches.map((b) => b.month).sort()).toEqual(['OCT-2026', 'SEP-2026'])
  expect(batches.every((b) => b.repo === 'vegastack/vegafactory')).toBe(true)
  await expect(dropOutboxFiles(batches.map((b) => b.file))).rejects.toThrow('legacy-spool-deletion-refused')
  expect(await listOutbox(home)).toHaveLength(2)
})

test('a corrupt line is skipped and reported, never fatal', async () => {
  const file = await appendRecord(home, record(121), 'mini')
  await writeFile(file, (await readFile(file, 'utf8')) + 'not json\n')
  const batches = await listOutbox(home)
  expect(batches[0]!.records).toHaveLength(1)
})

test('skill invocations accumulate per session and are taken exactly once', async () => {
  await appendSkillInvocations(home, 'sess-1', [{ name: 'dev-implement', trigger: 'typed', harness: 'claude' }])
  await appendSkillInvocations(home, 'sess-1', [{ name: 'dev-architect', trigger: 'model', harness: 'claude' }])
  expect(await takeSkillInvocations(home, 'sess-1')).toEqual([
    { name: 'dev-implement', trigger: 'typed', harness: 'claude' },
    { name: 'dev-architect', trigger: 'model', harness: 'claude' },
  ])
  expect(await takeSkillInvocations(home, 'sess-1')).toEqual([])
  expect(existsSync(join(home, '.vegastack/stats/sessions/sess-1.skills.jsonl'))).toBe(false)
})

// Immutable transport regression: a retry must preserve identity and never delete a producer.
test('immutable capture maps concurrent producer retries to one opaque event', async () => {
  const { enqueueEvent, inspectSpool } = await import('../src/stats/outbox.ts')
  const destination = { host: 'github.com' as const, org: 'o', repo: 'o/r', controlRoom: 'o/room' }
  const payload = { schemaVersion: 2 as const, recordKind: 'execution' as const, utcDay: '2026-09-08', stage: 'implement', outcome: 'succeeded' }
  const root = join(home, 'spool')
  const results = await Promise.all(Array.from({ length: 8 }, () => enqueueEvent(root, { schemaVersion: 2, eventId: crypto.randomUUID(), captureKey: 'local-run:terminal:0', destination, payload })))
  expect(new Set(results.map(r => r.eventId)).size).toBe(1)
  expect((await inspectSpool(root)).events).toHaveLength(1)
  await expect(enqueueEvent(root, { schemaVersion: 2, eventId: crypto.randomUUID(), captureKey: 'local-run:terminal:0', destination, payload: { ...payload, outcome: 'failed' } })).rejects.toThrow('capture-payload-conflict')
  expect((await inspectSpool(root)).quarantine).toHaveLength(1)
})

test('immutable spool refuses an unsafe ancestor without writing through it', async () => {
  const { enqueueEvent } = await import('../src/stats/outbox.ts')
  const elsewhere = join(home, 'elsewhere'); await mkdir(elsewhere)
  await symlink(elsewhere, join(home, 'linked'))
  await expect(enqueueEvent(join(home, 'linked', 'spool'), { schemaVersion: 2, eventId: crypto.randomUUID(), captureKey: 'run:terminal:0', destination: {host:'github.com',org:'o',repo:'o/r',controlRoom:'o/room'},payload:{schemaVersion:2,recordKind:'execution',utcDay:'2026-09-08',stage:'implement',outcome:'succeeded'} })).rejects.toThrow('unsafe')
  expect(existsSync(join(elsewhere, 'spool'))).toBe(false)
})

test('migration dry-run names partial/corrupt lines and applying twice preserves originals and identities',async()=>{
  const {inspectLegacySpool,migrateLegacySpool,outboxRoot,spoolRoot,inspectSpool}=await import('../src/stats/outbox.ts')
  const file=await appendRecord(home,record(121),'mini')
  const bytes=(await readFile(file,'utf8'))+'not-json\n{"partial":'
  await writeFile(file,bytes)
  const report=await inspectLegacySpool(outboxRoot(home))
  expect(report.candidates).toHaveLength(1);expect(report.invalid).toHaveLength(2)
  const mapping={'vegastack/vegafactory':{host:'github.com' as const,org:'vegastack',repo:'vegastack/vegafactory',controlRoom:'vegastack/room'}}
  await expect(migrateLegacySpool(report,mapping,{root:spoolRoot(home)})).rejects.toThrow('migration-apply-required')
  await migrateLegacySpool(report,mapping,{root:spoolRoot(home),apply:true})
  const first=(await inspectSpool(spoolRoot(home))).events[0]!.eventId
  await migrateLegacySpool(report,mapping,{root:spoolRoot(home),apply:true})
  expect((await inspectSpool(spoolRoot(home))).events.map(e=>e.eventId)).toEqual([first])
  expect(await readFile(file,'utf8')).toBe(bytes)
})

test('ENOSPC after a partial event write preserves mapping and inspectable bytes for retry',async()=>{
  const {spyOn}=await import('bun:test'),fs=await import('node:fs/promises')
  const {enqueueEvent,inspectSpool}=await import('../src/stats/outbox.ts')
  const root=join(home,'disk-spool'),event={schemaVersion:2 as const,eventId:crypto.randomUUID(),captureKey:'original:terminal:0',destination:{host:'github.com' as const,org:'o',repo:'o/r',controlRoom:'o/room'},payload:{schemaVersion:2 as const,recordKind:'execution' as const,utcDay:'2026-09-08',stage:'implement',outcome:'succeeded'}}
  const realOpen=fs.open
  const fault=spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{
    const handle=await realOpen(...args)
    if(String(args[0]).includes('/events/')&&String(args[0]).endsWith('.tmp'))return new Proxy(handle,{get(target,key){if(key==='writeFile')return async(bytes:string)=>{await target.writeFile(bytes.slice(0,12));throw Object.assign(Error('disk full'),{code:'ENOSPC'})};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})
    return handle
  })
  try{await expect(enqueueEvent(root,event)).rejects.toMatchObject({code:'ENOSPC'})}finally{fault.mockRestore()}
  const interrupted=await inspectSpool(root);expect(interrupted.events).toHaveLength(0);expect(interrupted.quarantine[0]?.bytes).toBe(12)
  const retry=await enqueueEvent(root,{...event,eventId:crypto.randomUUID()});expect(retry.eventId).toBe(event.eventId)
  expect((await inspectSpool(root)).events).toHaveLength(1)
})

test('CLI migration requires explicit apply and legacy push names the refusal',async()=>{
  const {parseStatsArgs,runStatsMaintenance,runStats}=await import('../src/stats/cli.ts')
  const {outboxRoot,inspectLegacySpool,spoolRoot,inspectSpool}=await import('../src/stats/outbox.ts')
  await appendRecord(home,record(121),'mini');const report=await inspectLegacySpool(outboxRoot(home)),reportFile=join(home,'report.json'),mappingFile=join(home,'mapping.json'),lines:string[]=[]
  await writeFile(reportFile,JSON.stringify(report));await writeFile(mappingFile,JSON.stringify({'vegastack/vegafactory':{host:'github.com',org:'vegastack',repo:'vegastack/vegafactory',controlRoom:'vegastack/room'}}))
  expect(await runStatsMaintenance(parseStatsArgs(['migrate']),home,line=>lines.push(line))).toBe(0)
  expect((await inspectSpool(spoolRoot(home))).events).toHaveLength(0)
  expect(await runStatsMaintenance(parseStatsArgs(['migrate','--apply','--report',reportFile,'--mapping',mappingFile]),home,line=>lines.push(line))).toBe(0)
  expect((await inspectSpool(spoolRoot(home))).events).toHaveLength(1)
  const deps:import('../src/stats/cli.ts').StatsDeps={home,cloneRoot:home,hostname:'fixture',ghUser:'fixture',login:'fixture',isLead:false,repo:'vegastack/vegafactory',policy:{enabled:true,people:false,source:'org',refusal:null},git:async()=>{throw Error('dry-run network forbidden')},gh:async()=>{throw Error('no network')},readStdin:async()=>'',readTranscript:async()=>[],now:()=>new Date(),log:line=>lines.push(line)}
  expect(await runStats(parseStatsArgs(['push']),deps)).toBe(0)
  await appendRecord(home,record(122),'mini')
  expect(await runStats(parseStatsArgs(['push']),deps)).toBe(2)
  expect(lines.join('\n')).toContain('legacy-spool-requires-explicit-migration')
})

test('migration of an appended legacy snapshot reuses prior line identity and imports only its new event',async()=>{
  const {inspectLegacySpool,migrateLegacySpool,outboxRoot,spoolRoot,inspectSpool}=await import('../src/stats/outbox.ts')
  const mapping={'vegastack/vegafactory':{host:'github.com' as const,org:'vegastack',repo:'vegastack/vegafactory',controlRoom:'vegastack/room'}}
  await appendRecord(home,record(121),'mini')
  await migrateLegacySpool(await inspectLegacySpool(outboxRoot(home)),mapping,{root:spoolRoot(home),apply:true})
  const first=(await inspectSpool(spoolRoot(home))).events[0]!.eventId
  await appendRecord(home,record(122),'mini')
  await migrateLegacySpool(await inspectLegacySpool(outboxRoot(home)),mapping,{root:spoolRoot(home),apply:true})
  const events=(await inspectSpool(spoolRoot(home))).events
  expect(events).toHaveLength(2);expect(events.map(e=>e.eventId)).toContain(first)
})

test('an unwritable event directory preserves pending bytes and retries using its durable identity',async()=>{
  const fs=await import('node:fs/promises'),{enqueueEvent,spoolEventFile,inspectSpool}=await import('../src/stats/outbox.ts')
  const root=join(home,'permission-spool'),first={schemaVersion:2 as const,eventId:crypto.randomUUID(),captureKey:'first:terminal:0',destination:{host:'github.com' as const,org:'o',repo:'o/r',controlRoom:'o/room'},payload:{schemaVersion:2 as const,recordKind:'execution' as const,utcDay:'2026-09-08',stage:'implement',outcome:'succeeded'}}
  await enqueueEvent(root,first)
  const before=(await inspectSpool(root)).pendingBytes,second={...first,eventId:crypto.randomUUID(),captureKey:'second:terminal:0'},dir=(await import('node:path')).dirname(spoolEventFile(root,first))
  await fs.chmod(dir,0o500)
  try{await expect(enqueueEvent(root,second)).rejects.toMatchObject({code:'EACCES'})}finally{await fs.chmod(dir,0o700)}
  expect((await inspectSpool(root)).pendingBytes).toBe(before)
  expect((await enqueueEvent(root,{...second,eventId:crypto.randomUUID()})).eventId).toBe(second.eventId)
})

test('activity and snapshot scans derive durable semantic capture keys instead of caller-random identities',async()=>{
  const {enqueueEvent,inspectSpool}=await import('../src/stats/outbox.ts'),root=join(home,'semantic-spool')
  const destination={host:'github.com' as const,org:'o',repo:'o/r',controlRoom:'o/room'}
  for(const payload of [{schemaVersion:2 as const,recordKind:'activity' as const,utcDay:'2026-09-08',taskRef:'task',activityId:'activity'}, {schemaVersion:2 as const,recordKind:'rework-snapshot' as const,utcDay:'2026-09-08',taskRef:'task',counterEpoch:'one',asOf:'2026-09-08',sourceRef:'source'}]){
    const first=await enqueueEvent(root,{schemaVersion:2,eventId:crypto.randomUUID(),captureKey:'caller-one',destination,payload})
    const retry=await enqueueEvent(root,{schemaVersion:2,eventId:crypto.randomUUID(),captureKey:'caller-two',destination,payload})
    expect(retry.eventId).toBe(first.eventId)
  }
  expect((await inspectSpool(root)).events).toHaveLength(2)
})
