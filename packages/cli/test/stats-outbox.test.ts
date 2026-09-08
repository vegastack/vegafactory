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

test('continued terminal segments keep one logical reporting identity and immutable independent captures',async()=>{
  const {enqueueEvent,inspectSpool,spoolEventFile}=await import('../src/stats/outbox.ts')
  const {canonicalJson,destinationId,hashBytes}=await import('../src/stats/types.ts')
  const {reportingExecutionRef}=await import('../src/stats/privacy.ts')
  const root=join(home,'segments'),runId=crypto.randomUUID(),sequence=crypto.randomUUID()
  const destination={host:'github.com' as const,org:'o',repo:'o/r',controlRoom:'o/room'}
  const event=(segment:string)=>({schemaVersion:2 as const,eventId:crypto.randomUUID(),destination,captureKey:`${runId}:terminal:${segment}`,payload:{schemaVersion:2 as const,recordKind:'execution' as const,utcDay:'2026-09-08',stage:'implement',outcome:segment==='0'?'interrupted':'succeeded',localRunId:runId}})
  // A continuation can reach the spool before the retained initial segment does.
  const continued=event(sequence),initial=event('0')
  const results=await Promise.all([enqueueEvent(root,continued),enqueueEvent(root,initial),enqueueEvent(root,{...continued,eventId:crypto.randomUUID()}),reportingExecutionRef(root,runId,destination)])
  expect(results[2]).toEqual(results[0])
  const before=(await inspectSpool(root)).events
  expect(before).toHaveLength(2)
  const refs=before.map(e=>e.payload.recordKind==='execution'?e.payload.executionRef:null)
  expect(new Set(refs).size).toBe(1);expect(refs[0]).toBe(results[3] as string);expect(refs[0]).not.toBe(runId)
  const files=before.flatMap(e=>[spoolEventFile(root,e),join(root,'captures',hashBytes(canonicalJson([destinationId(destination),e.captureKey]))+'.json')])
  const bytes=await Promise.all(files.map(file=>readFile(file,'utf8')))
  for(const input of [initial,continued])await enqueueEvent(root,{...input,eventId:crypto.randomUUID()})
  expect(await Promise.all(files.map(file=>readFile(file,'utf8')))).toEqual(bytes)
  await expect(enqueueEvent(root,{...continued,payload:{...continued.payload,outcome:'failed'}})).rejects.toThrow('capture-payload-conflict')
  await expect(enqueueEvent(root,{...continued,payload:{...continued.payload,executionRef:crypto.randomUUID()}})).rejects.toThrow('privacy-reporting-identity-rebound')
  await expect(enqueueEvent(root,{...continued,captureKey:`${runId}:terminal:not-a-segment`})).rejects.toThrow('privacy-reporting-identity-unavailable')
  expect(await Promise.all(files.map(file=>readFile(file,'utf8')))).toEqual(bytes)
})

test('spool claim refuses abandoned guards immediately and preserves their evidence',async()=>{
  const {withSpoolClaim}=await import('../src/stats/outbox.ts'),{hashBytes}=await import('../src/stats/types.ts')
  const root=join(home,'refused'),guard=join(root,'claims',hashBytes('orphan')+'.guard')
  await mkdir(guard,{recursive:true,mode:0o700})
  const {processIdentity}=await import('../src/claims.ts')
  const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdout:'ignore',stderr:'ignore'})
  let identity
  try{identity=await processIdentity(child.pid)}finally{child.kill('SIGTERM');await child.exited}
  await writeFile(join(guard,'owner.json'),JSON.stringify({schemaVersion:1,token:crypto.randomUUID(),identity}),{mode:0o600})
  // Verified dead owner is the137 offline-recovery fence. Missing owner publication
  // has separate bounded busy semantics; this fixture must not confuse the two.
  let called=false
  const started=performance.now()
  await expect(withSpoolClaim(root,'orphan',async()=>{called=true},2000)).rejects.toThrow('spool-claim-refused: abandoned mutation guard')
  expect(performance.now()-started).toBeLessThan(1000) // The configured busy retry allowance is2000ms.
  expect(called).toBe(false);expect(existsSync(guard)).toBe(true)
})

test('two processes capture different terminal segments without splitting the logical execution identity',async()=>{
  const {inspectSpool}=await import('../src/stats/outbox.ts'),{pathToFileURL}=await import('node:url'),{resolve}=await import('node:path')
  const root=join(home,'process-segments'),runId=crypto.randomUUID(),sequence=crypto.randomUUID(),script=join(home,'capture-segment.ts')
  const destination={host:'github.com' as const,org:'o',repo:'o/r',controlRoom:'o/room'}
  await writeFile(script,`import {enqueueEvent} from ${JSON.stringify(pathToFileURL(resolve('packages/cli/src/stats/outbox.ts')).href)};
const [root,runId,sequence]=process.argv.slice(2);await enqueueEvent(root!,{schemaVersion:2,eventId:crypto.randomUUID(),destination:${JSON.stringify(destination)},captureKey:runId+':terminal:'+sequence,payload:{schemaVersion:2,recordKind:'execution',utcDay:'2026-09-08',stage:'implement',outcome:'succeeded',localRunId:runId}});`)
  const run=async(segment:string)=>{
    const child=Bun.spawn([process.execPath,script,root,runId,segment],{stdout:'pipe',stderr:'pipe'})
    const [code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()])
    expect({code,stderr}).toEqual({code:0,stderr:''})
  }
  await Promise.all([run('0'),run(sequence)])
  const events=(await inspectSpool(root)).events
  expect(events).toHaveLength(2)
  expect(new Set(events.map(e=>e.payload.recordKind==='execution'?e.payload.executionRef:null)).size).toBe(1)
  await Promise.all([run(sequence),run('0')])
  expect((await inspectSpool(root)).events).toEqual(events)
},10000)

test('spool claim still retries genuine live-owner contention',async()=>{
  const {withSpoolClaim}=await import('../src/stats/outbox.ts'),{hashBytes}=await import('../src/stats/types.ts')
  const {acquireClaim,releaseClaim,processIdentity}=await import('../src/claims.ts')
  const root=join(home,'busy'),path=join(root,'claims',hashBytes('shared'))
  await mkdir(join(root,'claims'),{recursive:true,mode:0o700})
  const held=await acquireClaim(path,await processIdentity())
  expect(held.kind).toBe('owned');if(held.kind!=='owned')throw Error(held.reason)
  let called=0
  const releasing=new Promise<void>((resolve,reject)=>setTimeout(()=>{releaseClaim(held.claim).then(resolve,reject)},25))
  const [value]=await Promise.all([withSpoolClaim(root,'shared',async()=>{called++;return'captured'}),releasing])
  expect(value).toBe('captured');expect(called).toBe(1)
})

test('interrupted continuation enqueue retains its map and the earlier segment unchanged',async()=>{
  const fs=await import('node:fs/promises'),{dirname}=await import('node:path')
  const {enqueueEvent,inspectSpool,spoolEventFile}=await import('../src/stats/outbox.ts')
  const {canonicalJson,hashBytes,destinationId}=await import('../src/stats/types.ts')
  const root=join(home,'segment-retry'),runId=crypto.randomUUID(),sequence=crypto.randomUUID()
  const destination={host:'github.com' as const,org:'o',repo:'o/r',controlRoom:'o/room'}
  const first={schemaVersion:2 as const,eventId:crypto.randomUUID(),captureKey:`${runId}:terminal:0`,destination,payload:{schemaVersion:2 as const,recordKind:'execution' as const,utcDay:'2026-09-08',stage:'implement',outcome:'interrupted',localRunId:runId}}
  await enqueueEvent(root,first)
  const original=(await inspectSpool(root)).events[0]!,originalFile=spoolEventFile(root,original),bytes=await readFile(originalFile,'utf8')
  const continued={...first,eventId:crypto.randomUUID(),captureKey:`${runId}:terminal:${sequence}`,payload:{...first.payload,outcome:'succeeded'}}
  await fs.chmod(dirname(originalFile),0o500)
  try{await expect(enqueueEvent(root,continued)).rejects.toMatchObject({code:'EACCES'})}finally{await fs.chmod(dirname(originalFile),0o700)}
  const mappingFile=join(root,'captures',hashBytes(canonicalJson([destinationId(destination),continued.captureKey]))+'.json')
  const mappingBytes=await readFile(mappingFile,'utf8'),mapping=JSON.parse(mappingBytes)
  expect(mapping.eventId).toBe(continued.eventId)
  expect(mapping.executionRef).toBe(original.payload.recordKind==='execution'?original.payload.executionRef:null)
  expect(await readFile(originalFile,'utf8')).toBe(bytes)
  expect((await inspectSpool(root)).events).toHaveLength(1)
  expect((await enqueueEvent(root,{...continued,eventId:crypto.randomUUID()})).eventId).toBe(continued.eventId)
  expect(await readFile(mappingFile,'utf8')).toBe(mappingBytes)
  expect((await inspectSpool(root)).events).toHaveLength(2)
})

test('terminal capture keys preserve legacy zero and accept only private UUID continuation sequences',async()=>{
  const {terminalCaptureKey,parseTerminalCaptureKey,semanticCaptureKey}=await import('../src/stats/types.ts')
  const runId=crypto.randomUUID(),sequence=crypto.randomUUID()
  expect(terminalCaptureKey(runId)).toBe(`${runId}:terminal:0`)
  expect(parseTerminalCaptureKey(terminalCaptureKey(runId,sequence))).toEqual({runId,sequence})
  for(const key of [`${runId}:terminal:1`,`${runId}:terminal:`,`${runId}:terminal:${sequence}:extra`,`foreign:terminal:${sequence}`,`${runId}:start:${sequence}`])expect(parseTerminalCaptureKey(key)).toBeNull()
  expect(()=>terminalCaptureKey(runId,'1')).toThrow('run-identity-unavailable')
  const destination={host:'github.com' as const,org:'o',repo:'o/r',controlRoom:'o/room'}
  expect(semanticCaptureKey(destination,{schemaVersion:2,recordKind:'execution',utcDay:'2026-09-08',stage:'implement',outcome:'succeeded'},runId,sequence)).toBe(terminalCaptureKey(runId,sequence))
})
