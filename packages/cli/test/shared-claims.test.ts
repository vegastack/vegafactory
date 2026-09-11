import { test, expect } from 'bun:test';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { processIdentity } from '../src/claims.ts';
import { GhUnavailable } from '../src/gh.ts';
import { acquireSharedTask, transitionSharedTask, recoverStoppedGroup, inspectGroupSuccession, linkAcceptedScope, inspectHandoffCoordinationTask, inspectHistoricalCoordinationTask, inspectCoordinationTask, readCoordination, readSharedStatus, taskKey, parseRecoveryEnvelope, parseRecoveryPayload, parseTaskRecordBytes, parseOperationReceiptBytes, publishRecoveryReceipt, resolveEvidence, beginManagedEffect, verifyManagedEffect, canonical, sha256, githubCoordinationProvider, type CoordinationTarget, type CoordinationProvider, type VerifiedCandidate, type EffectiveMachine, type MachineSession, type GroupSuccessionRequest, type RecoveryEvidencePayload, type RecoveryEnvelope } from '../src/shared-claims.ts';
const d = 'd'.repeat(64), root = '1'.repeat(40), installation = '11111111-1111-4111-8111-111111111111';
async function fixture() {
    let head = root, version = 1, ambiguous = false, conflicts = 0, mutations = 0;
    const versions = new Map([[head, { 'coordination/index.json': canonical({ schemaVersion: 1, installationId: installation, revision: 0, active: [], machines: [] }) } as Record<string, string>]]);
    const provider: CoordinationProvider = {
        branch: async () => ({ id: 'REF_state', head, repositoryId: 'R_state', private: true, defaultBranch: 'main' }),
        read: async (_t, commit, path) => versions.get(commit)?.[path] ?? null,
        compare: async (_t, base, next) => base === next ? 'identical' : versions.has(base) && versions.has(next) && [...versions.keys()].indexOf(base) < [...versions.keys()].indexOf(next) ? 'ahead' : 'diverged',
        commit: async (_t, input) => { mutations++; if (conflicts-- > 0 || input.expectedHeadOid !== head)
            return { kind: 'conflict', reason: 'head changed' }; head = (++version).toString(16).padStart(40, '0'); versions.set(head, { ...versions.get(input.expectedHeadOid), ...input.files }); return ambiguous ? { kind: 'ambiguous', reason: 'response lost' } : { kind: 'committed', head }; },
    };
    const localRoot = await mkdtemp(join(tmpdir(), 'vf-shared-'));
    const target: CoordinationTarget = { host: 'github.com', repository: 'acme/control', repositoryId: 'R_state', branch: 'factory-state', rootCommit: root, installationId: installation, localRoot, provider, verifyCandidate: async () => { }, verifyTransition: async () => { }, verifyEvidence: async () => { }, random: () => 0 };
    const machine: EffectiveMachine = { id: 'mac-one', installationId: randomUUID(), hostBindingDigest: d, executionLogin: 'robot', group: 'dev', enabled: true, allowedRepositories: ['acme/app'], repositoryIds: { 'acme/app': 'R_app' }, policyDigest: d, coordination: { repositoryId: target.repositoryId, repository: target.repository, branch: target.branch, rootCommit: target.rootCommit, installationId: target.installationId }, defaults: { maxRuns: 2, childConcurrent: 3, recovery: 'verified-transfer' } };
    const session: MachineSession = { machineId: machine.id, installationId: machine.installationId, sessionId: randomUUID(), hostBindingDigest: d, bootIdDigest: d, identity: await processIdentity(), localRoot, target };
    const candidate: VerifiedCandidate = { host: 'github.com', repo: 'acme/app', issue: 137, repositoryNodeId: 'R_app', issueNodeId: 'I_137', scopeDigest: d, approvalDigest: d, approvalBindings: [{ approvalId: 'approved', source: { kind: 'github-comment', repositoryId: 'R_app', issueNodeId: 'I_parent', commentId: '123', bodySha256: d } }], runId: randomUUID(), stage: 'implement', paths: ['src/a'], resources: [], independent: true, parentTaskKey: null, approvedTaskIds: ['137-T1'] };
    return { target, machine, session, candidate, versions, get head() { return head; }, get mutations() { return mutations; }, setAmbiguous: () => { ambiguous = true; }, setConflicts: (n: number) => { conflicts = n; }, rewrite: () => { head = 'f'.repeat(40); } };
}
test('stopped-group succession exposes one atomic owner operation and its dedicated inspector', () => {
    expect(typeof recoverStoppedGroup).toBe('function');
    expect(typeof inspectGroupSuccession).toBe('function');
});
test('shared acquisition binds one task independent of scope/machine, receipts reconcile lost responses', async () => {
    const f = await fixture();
    f.setAmbiguous();
    const operationId = randomUUID(), result = await acquireSharedTask({ ...f, operationId });
    expect(result.kind).toBe('owned');
    expect((await acquireSharedTask({ ...f, operationId })).kind).toBe('owned');
    expect(f.mutations).toBe(1);
    const competitor = await acquireSharedTask({ ...f, candidate: { ...f.candidate, scopeDigest: 'a'.repeat(64) }, operationId: randomUUID() });
    expect(competitor.kind).not.toBe('owned');
    if (result.kind !== 'owned')
        throw Error('claim');
    expect((await transitionSharedTask({ claim: { ...result.claim, ownerToken: randomUUID() }, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('refused');
    expect((await readCoordination(f.target)).tasks[result.claim.taskKey]!.state).toBe('claimed');
    const started = await transitionSharedTask({ claim: result.claim, operationId: randomUUID(), transition: { kind: 'start' } });
    expect(started.kind).toBe('owned');
    const stopped = await transitionSharedTask({ claim: result.claim, operationId: randomUUID(), transition: { kind: 'stop', stopProof: null } });
    expect(stopped.kind).toBe('refused');
    expect((await readSharedStatus(f.target, [])).tasks).toEqual([]);
});
test('approved independent scopes overlap, unknown or overlapping scopes and capacity refuse', async () => {
    const f = await fixture();
    expect((await acquireSharedTask({ ...f, operationId: randomUUID() })).kind).toBe('owned');
    const second = { ...f.candidate, issue: 138, issueNodeId: 'I_138', runId: randomUUID(), paths: ['src/b'] };
    expect((await acquireSharedTask({ ...f, candidate: second, operationId: randomUUID() })).kind).toBe('owned');
    for (const paths of [['src/a/child'], [], ['src/*'], ['src/c']])
        expect((await acquireSharedTask({ ...f, candidate: { ...second, issue: 139, issueNodeId: 'I_139', paths, runId: randomUUID() }, operationId: randomUUID() })).kind).not.toBe('owned');
    expect(f.mutations).toBe(2);
});
test('conditional retry recomputes; changed policy, malformed state and rewritten history preserve state', async () => {
    const f = await fixture();
    f.setConflicts(1);
    expect((await acquireSharedTask({ ...f, operationId: randomUUID() })).kind).toBe('owned');
    expect(f.mutations).toBe(2);
    f.target.verifyCandidate = async () => { throw Error('policy revoked'); };
    expect((await acquireSharedTask({ ...f, operationId: randomUUID() })).kind).toBe('refused');
    expect(f.mutations).toBe(2);
    f.versions.get(f.head)!['coordination/index.json'] = '{}';
    await expect(readCoordination(f.target)).rejects.toThrow('schema');
    f.rewrite();
    await expect(readCoordination(f.target)).rejects.toThrow('ancestry');
});
test('closed wire rejects recursion, unknown keys, provenance omission and false qualification', () => {
    for (const value of [{ schemaVersion: 1 }, { schemaVersion: 2, remoteEffectCoverage: { kind: 'unmanaged-possible' } }, { schemaVersion: 2, extra: 'token' }])
        expect(() => parseRecoveryEnvelope(value)).toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => parseRecoveryPayload(circular)).toThrow('recursive');
    expect(() => parseRecoveryPayload({ schemaVersion: 2, kind: 'execution-qualification', harness: 'codex', harnessVersion: '1', model: 'm', effort: 'high', accountRef: 'acct', configurationDigest: d, candidateSha: root, validationIds: [], managedKinds: [], unmanagedDenied: false, result: 'qualified' })).toThrow('incomplete');
    const invalid = { schemaVersion: 2, kind: 'effect-intent', effectId: randomUUID(), runId: randomUUID(), generation: 1, approvalBindings: [], effectKind: 'handback', target: { kind: 'issue-comment', repositoryId: 'R_app', issueNodeId: 'I_137', commentId: null, markerId: 'handback' }, payloadDigest: d, result: 'acknowledged', observedRemoteId: null, observedDigest: null, reasonCode: null };
    expect(() => parseRecoveryPayload(invalid)).toThrow('prepared');
});
test('closed task and receipt byte owners reject unknown and malformed recovered provider data', async () => {
    const f = await fixture(), operationId = randomUUID(), acquired = await acquireSharedTask({ ...f, operationId });
    if (acquired.kind !== 'owned') throw Error(acquired.reason);
    const task = (await readCoordination(f.target)).tasks[acquired.claim.taskKey]!, files = f.versions.get(f.head)!, receiptRaw = files[`coordination/operations/${operationId}.json`]!, receipt = parseOperationReceiptBytes(receiptRaw);
    expect(parseTaskRecordBytes(canonical(task))).toEqual(task); expect(receipt.operationId).toBe(operationId);
    expect(() => parseTaskRecordBytes(canonical({ ...task, extra: true }))).toThrow('closed schema');
    expect(() => parseOperationReceiptBytes(canonical({ ...receipt, extra: true }))).toThrow('closed schema');
    expect(() => parseOperationReceiptBytes(canonical({ ...receipt, recoveryPayload: { schemaVersion: 2, kind: 'acceptance', extra: true } }))).toThrow('closed schema');
    expect(() => parseOperationReceiptBytes(JSON.stringify(receipt, null, 2))).toThrow('noncanonical');
});
test('immutable receipt publication returns actual commit before any envelope link; edit/unavailable refuses', async () => {
    const f = await fixture(), acquired = await acquireSharedTask({ ...f, operationId: randomUUID() });
    if (acquired.kind !== 'owned')
        throw Error('claim');
    const payload: RecoveryEvidencePayload = { schemaVersion: 2, kind: 'acceptance', taskId: '137-T1', runId: f.candidate.runId, sourceSha: root, scopeDigest: d, validationId: '137-T1/check/' + d, commandDigest: d, result: 'passed', acceptedScope: null };
    const published = await publishRecoveryReceipt({ claim: acquired.claim, operationId: randomUUID(), payload });
    expect(published.reference.commitSha).toBe(f.head);
    expect(await resolveEvidence(f.target, published.reference)).toEqual(payload);
    expect((await readCoordination(f.target)).tasks[acquired.claim.taskKey]!.recovery).toBeNull();
    await expect(resolveEvidence(f.target, { ...published.reference, blobSha256: 'e'.repeat(64) })).rejects.toThrow('changed');
});
test('copied machine identity and second session cannot enter', async () => {
    const f = await fixture();
    await acquireSharedTask({ ...f, operationId: randomUUID() });
    const machine = { ...f.machine, id: 'copied', installationId: randomUUID() };
    const session = { ...f.session, machineId: machine.id, installationId: machine.installationId, sessionId: randomUUID() };
    expect((await acquireSharedTask({ ...f, machine, session, candidate: { ...f.candidate, issue: 138, issueNodeId: 'I_138', paths: ['src/b'] }, operationId: randomUUID() })).kind).toBe('refused');
    expect((await acquireSharedTask({ ...f, session: { ...f.session, sessionId: randomUUID() }, candidate: { ...f.candidate, issue: 138, issueNodeId: 'I_138', paths: ['src/b'] }, operationId: randomUUID() })).kind).toBe('busy');
});
test('GitHub provider sends expected head in GraphQL and inspects HTTP200 errors', async () => {
    let request: Record<string, unknown> | null = null, args: string[] = [];
    const f = await fixture(), p = githubCoordinationProvider(async (actual, options) => { args = actual; request = JSON.parse(options!.input!); return 'HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n' + JSON.stringify({ errors: [{ type: 'STALE_DATA' }] }); });
    const result = await p.commit(f.target, { branchId: 'REF_state', expectedHeadOid: root, files: { 'coordination/index.json': '{}' }, operationId: randomUUID() });
    expect(result.kind).toBe('conflict');
    expect(args).toContain('--include');
    expect((request as any).variables.input.expectedHeadOid).toBe(root);
});
test('GitHub provider retains server rate-limit timing for bounded transaction retry', async () => {
    const f = await fixture(), input = { branchId: 'REF_state', expectedHeadOid: root, files: { 'coordination/index.json': '{}' }, operationId: randomUUID() };
    const after = githubCoordinationProvider(async () => { throw new GhUnavailable('rate limited', 429, new Headers({ 'retry-after': '300' })); });
    expect(await after.commit(f.target, input)).toEqual({ kind: 'conflict', reason: 'provider rate limited', retryAfterMs: 300_000 });
    const now = Date.now(), reset = githubCoordinationProvider(async () => { throw new GhUnavailable('rate limited', 403, new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil((now + 60_000) / 1000)) })); });
    const result = await reset.commit(f.target, input);
    expect(result).toMatchObject({ kind: 'conflict', reason: 'provider rate limited' });
    if (result.kind === 'conflict') expect(result.retryAfterMs).toBeGreaterThanOrEqual(59_000);
    const forbidden = githubCoordinationProvider(async () => { throw new GhUnavailable('forbidden', 403); });
    expect(await forbidden.commit(f.target, input)).toEqual({ kind: 'refused', reason: 'provider refused conditional mutation' });
});
test('receipt retry rejects changed payload under the same immutable operation ID', async () => {
    const f = await fixture(), result = await acquireSharedTask({ ...f, operationId: randomUUID() });
    if (result.kind !== 'owned')
        throw Error('claim');
    const operationId = randomUUID(), payload: RecoveryEvidencePayload = { schemaVersion: 2, kind: 'acceptance', taskId: '137-T1', runId: f.candidate.runId, sourceSha: root, scopeDigest: d, validationId: '137-T1/check/' + d, commandDigest: d, result: 'passed', acceptedScope: null };
    await publishRecoveryReceipt({ claim: result.claim, operationId, payload });
    await expect(publishRecoveryReceipt({ claim: result.claim, operationId, payload: { ...payload, result: 'failed' } })).rejects.toThrow('different request');
});
test.each(['qualified', 'unqualified'] as const)('two-phase remote-only recovery with %s evidence fences sends and preserves unlinked outcomes', async (result) => {
    const f = await fixture(), owned = await acquireSharedTask({ ...f, operationId: randomUUID() });
    if (owned.kind !== 'owned')
        throw Error('claim');
    let claim = owned.claim;
    const qualification = await publishRecoveryReceipt({ claim, operationId: randomUUID(), payload: { schemaVersion: 2, kind: 'execution-qualification', harness: 'codex', harnessVersion: 'test-fixture', model: 'model', effort: 'high', accountRef: 'account', configurationDigest: d, candidateSha: root, validationIds: ['137-T4/check/' + d], managedKinds: ['checkpoint-push', 'handback', 'evidence', 'telemetry-push'], unmanagedDenied: result === 'qualified', result } });
    claim = qualification.claim;
    const effectId = randomUUID(), target = { kind: 'issue-comment' as const, repositoryId: 'R_app', issueNodeId: 'I_137', commentId: null, markerId: 'handback' };
    const intent: RecoveryEvidencePayload = { schemaVersion: 2, kind: 'effect-intent', effectId, runId: claim.runId, generation: 1, approvalBindings: f.candidate.approvalBindings, effectKind: 'handback', target, payloadDigest: d, result: 'prepared', observedRemoteId: null, observedDigest: null, reasonCode: null };
    const prepared = await publishRecoveryReceipt({ claim, operationId: randomUUID(), payload: intent });
    claim = prepared.claim;
    await expect(verifyManagedEffect(claim, effectId)).rejects.toThrow('acknowledged intent');
    const envelope: RecoveryEnvelope = { schemaVersion: 2, taskKey: claim.taskKey, runId: claim.runId, generation: 1, approvalBindings: f.candidate.approvalBindings, recordBinding: null, scopeDigest: d, approvalDigest: d, execution: { providerMode: 'subscription', harness: 'codex', harnessVersion: 'test-fixture', model: 'model', effort: 'high', accountRef: 'account', qualification: qualification.reference }, checkpoint: null, completed: [], children: [], joins: [], effects: [{ operationId: effectId, runId: claim.runId, generation: 1, kind: 'handback', target, payloadDigest: d, state: 'prepared', intent: prepared.reference, outcome: null }], remoteEffectCoverage: { kind: 'unmanaged-possible', reasonCode: 'not-qualified' } };
    let linked = await transitionSharedTask({ claim, operationId: randomUUID(), transition: { kind: 'recovery', recovery: envelope } });
    expect(linked.kind).toBe('owned');
    if (linked.kind !== 'owned')
        throw Error('link');
    claim = linked.claim;
    const stopProof = { kind: 'operator-confirmed' as const, machineId: f.machine.id, installationId: f.machine.installationId, sessionId: f.session.sessionId, hostBindingDigest: d, bootIdDigest: d, runIds: [claim.runId], generation: 1, observedAt: new Date().toISOString(), evidenceRef: f.candidate.approvalBindings[0]!.source };
    const completion = await transitionSharedTask({ claim, operationId: randomUUID(), transition: { kind: 'complete', stopProof, acceptedScope: qualification.reference } });
    expect(completion).toMatchObject({ kind: 'refused', reason: 'unmanaged remote effects possible; recovery blocked' });
    const checkpoint = { schemaVersion: 1 as const, id: randomUUID(), repo: 'acme/app', repositoryId: 'R_app', branch: 'task/137', baseSha: root, headSha: root, treeSha: root, scopeDigest: d, runId: claim.runId, publishedAt: new Date().toISOString() };
    envelope.checkpoint = checkpoint;
    expect((await transitionSharedTask({ claim, operationId: randomUUID(), transition: { kind: 'checkpoint', checkpoint, recovery: envelope } })).kind).toBe('owned');
    const handoff = await transitionSharedTask({ claim, operationId: randomUUID(), transition: { kind: 'handoff', machine: f.machine, session: f.session, candidate: f.candidate, stopProof, recovery: envelope } });
    expect(handoff).toMatchObject({ kind: 'refused', reason: 'unmanaged remote effects possible; recovery blocked' });
    for (const wrong of [{ ...claim, ownerToken: randomUUID() }, { ...claim, generation: 2 }]) {
        await expect(verifyManagedEffect(wrong, effectId)).rejects.toThrow('current owner');
        expect((await transitionSharedTask({ claim: wrong, operationId: randomUUID(), transition: { kind: 'effect-send', effectId } })).kind).toBe('refused');
    }
    expect((await transitionSharedTask({ claim, operationId: randomUUID(), transition: { kind: 'recovery', recovery: { ...envelope, execution: { ...envelope.execution, accountRef: 'other' } } } })).kind).toBe('refused');
    expect((await transitionSharedTask({ claim, operationId: randomUUID(), transition: { kind: 'recovery', recovery: { ...envelope, effects: [{ ...envelope.effects[0]!, payloadDigest: 'e'.repeat(64) }] } } })).kind).toBe('refused');
    if (result === 'unqualified') {
        const mislabeled = await transitionSharedTask({ claim, operationId: randomUUID(), transition: { kind: 'recovery', recovery: { ...envelope, remoteEffectCoverage: { kind: 'qualified-managed-only', qualification: qualification.reference } } } });
        expect(mislabeled).toMatchObject({ kind: 'refused', reason: 'managed coverage qualification mismatch' });
    } else {
        envelope.remoteEffectCoverage = { kind: 'qualified-managed-only', qualification: qualification.reference };
    }
    f.setAmbiguous();
    linked = await transitionSharedTask({ claim, operationId: randomUUID(), transition: { kind: 'recovery', recovery: envelope } });
    expect(linked.kind).toBe('owned');
    if (linked.kind !== 'owned') throw Error('link');
    claim = linked.claim;
    const mutationsBeforeRefusal = f.mutations;
    f.target.verifyTransition = async () => { throw Error('current authority revoked'); };
    await expect(beginManagedEffect({ claim, effectId, operationId: randomUUID() })).rejects.toThrow('authority revoked');
    expect(f.mutations).toBe(mutationsBeforeRefusal);
    f.target.verifyTransition = async () => {};
    // A new local root proves the evidence path does not need the old machine's files.
    claim = { ...claim, target: { ...claim.target, localRoot: await mkdtemp(join(tmpdir(), 'vf-remote-only-')) } };
    const sending = await beginManagedEffect({ claim, effectId, operationId: randomUUID() });
    claim = sending.claim;
    expect((await readCoordination(claim.target)).tasks[claim.taskKey]!.recovery!.remoteEffectCoverage).toEqual(envelope.remoteEffectCoverage);
    await expect(beginManagedEffect({ claim, effectId, operationId: randomUUID() })).rejects.toThrow('already sent');
    expect((await transitionSharedTask({ claim, operationId: randomUUID(), transition: { kind: 'recovery', recovery: envelope } })).kind).toBe('refused');
    const outcome = await publishRecoveryReceipt({ claim, operationId: randomUUID(), payload: { ...intent, kind: 'effect-outcome', result: 'acknowledged', observedRemoteId: '1234', observedDigest: d } });
    expect((await readCoordination(claim.target)).tasks[claim.taskKey]!.recovery!.effects[0]!.state).toBe('ambiguous');
    envelope.effects[0] = { ...envelope.effects[0]!, state: 'acknowledged', outcome: outcome.reference };
    const finished = await transitionSharedTask({ claim, operationId: randomUUID(), transition: { kind: 'recovery', recovery: envelope } });
    expect(finished.kind).toBe('owned');
    await expect(beginManagedEffect({ claim, effectId, operationId: randomUUID() })).rejects.toThrow('already sent');
});

test('verified transfer keeps remote recovery, one takeover wins and old owner cannot return', async () => {
 const f=await fixture(), owned=await acquireSharedTask({...f,operationId:randomUUID()});if(owned.kind!=='owned')throw Error('claim')
 const q=await publishRecoveryReceipt({claim:owned.claim,operationId:randomUUID(),payload:{schemaVersion:2,kind:'execution-qualification',harness:'codex',harnessVersion:'fixture',model:'model',effort:'high',accountRef:'account',configurationDigest:d,candidateSha:root,validationIds:['137-T4/check/'+d],managedKinds:['checkpoint-push','handback','evidence','telemetry-push'],unmanagedDenied:true,result:'qualified'}})
 const checkpoint={schemaVersion:1 as const,id:randomUUID(),repo:'acme/app',repositoryId:'R_app',branch:'task/137',baseSha:root,headSha:root,treeSha:root,scopeDigest:d,runId:owned.claim.runId,publishedAt:new Date().toISOString()}
 const recovery:RecoveryEnvelope={schemaVersion:2,taskKey:owned.claim.taskKey,runId:owned.claim.runId,generation:1,scopeDigest:d,approvalDigest:d,approvalBindings:f.candidate.approvalBindings,recordBinding:null,execution:{providerMode:'subscription',harness:'codex',harnessVersion:'fixture',model:'model',effort:'high',accountRef:'account',qualification:q.reference},checkpoint,completed:[],children:[],joins:[],effects:[],remoteEffectCoverage:{kind:'qualified-managed-only',qualification:q.reference}}
 expect((await transitionSharedTask({claim:q.claim,operationId:randomUUID(),transition:{kind:'checkpoint',checkpoint,recovery}})).kind).toBe('owned')
 const stopProof={kind:'operator-confirmed' as const,machineId:f.machine.id,installationId:f.machine.installationId,sessionId:f.session.sessionId,hostBindingDigest:f.machine.hostBindingDigest,bootIdDigest:f.session.bootIdDigest,runIds:[owned.claim.runId],generation:1,observedAt:new Date().toISOString(),evidenceRef:f.candidate.approvalBindings[0]!.source}
 const machine={...f.machine,id:'other',installationId:randomUUID(),hostBindingDigest:'a'.repeat(64)},session={...f.session,machineId:'other',installationId:machine.installationId,hostBindingDigest:machine.hostBindingDigest,sessionId:randomUUID()}
 const missing=await transitionSharedTask({claim:q.claim,operationId:randomUUID(),transition:{kind:'handoff',machine,session,candidate:f.candidate,stopProof:{...stopProof,generation:2},recovery}})
 expect(missing.kind).toBe('refused')
 const results=await Promise.all([0,1].map(()=>transitionSharedTask({claim:q.claim,operationId:randomUUID(),transition:{kind:'handoff',machine,session,candidate:f.candidate,stopProof,recovery}})))
 expect(results.filter(x=>x.kind==='owned'), JSON.stringify(results.map(x=>({kind:x.kind,reason:'reason' in x?x.reason:null})))).toHaveLength(1)
 const current=await readCoordination(f.target),task=current.tasks[owned.claim.taskKey]!
 expect(task.generation).toBe(2);expect(task.recovery?.generation).toBe(2);expect(task.recovery?.execution).toEqual(recovery.execution)
 expect((await transitionSharedTask({claim:q.claim,operationId:randomUUID(),transition:{kind:'start'}})).kind).toBe('refused')
})

test('operation path injection refuses before local intent or remote mutation', async()=>{
 const f=await fixture();expect((await acquireSharedTask({...f,operationId:'../../escape'})).kind).toBe('refused');expect(f.mutations).toBe(0)
})

async function parentFixture() {
    const f = await fixture();
    const parentCandidate = { ...f.candidate, independent: false, paths: [] };
    const parent = await acquireSharedTask({ ...f, candidate: parentCandidate, operationId: randomUUID() });
    if (parent.kind !== 'owned') throw Error('parent claim');
    expect((await transitionSharedTask({ claim: parent.claim, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('owned');
    const { taskKey, runId, generation, ownerToken, machineId, installationId, sessionId } = parent.claim;
    const parentBinding = { taskKey, runId, generation, ownerToken, machineId, installationId, sessionId };
    const child = { ...f.candidate, issue: 138, issueNodeId: 'I_138', runId: randomUUID(), paths: ['src/child'], parentTaskKey: taskKey, parentBinding };
    f.target.verifyChildRelationship = async ({ parent: current, child: incoming }) => {
        expect(current.runId).toBe(parentBinding.runId);
        expect(incoming.parentBinding).toEqual(parentBinding);
        return { maxChildren: 3 };
    };
    return { ...f, f, parent: parent.claim, parentCandidate, child };
}

test('verified original parent permits coordinator overlap and persists the immutable child binding', async () => {
    const p = await parentFixture(), operationId = randomUUID();
    const child = await acquireSharedTask({ ...p, candidate: p.child, operationId });
    expect(child.kind).toBe('owned');
    if (child.kind !== 'owned') throw Error('child claim');
    const stored = (await readCoordination(p.target)).tasks[child.claim.taskKey]!;
    expect(stored.parentBinding).toEqual(p.child.parentBinding);
    expect((await acquireSharedTask({ ...p, candidate: p.child, operationId })).kind).toBe('owned');
    expect((await acquireSharedTask({ ...p, candidate: { ...p.child, parentBinding: { ...p.child.parentBinding, runId: randomUUID() } }, operationId })).kind).toBe('refused');
    expect((await transitionSharedTask({ claim: child.claim, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('owned');
    for (const patch of [{ paths: ['src/child/nested'] }, { paths: [] }, { paths: ['src/*'] }]) {
        expect((await acquireSharedTask({ ...p, candidate: { ...p.child, ...patch, issue: 139, issueNodeId: 'I_139', runId: randomUUID() }, operationId: randomUUID() })).kind).not.toBe('owned');
    }
    expect((await acquireSharedTask({ ...p, candidate: { ...p.child, issue: 139, issueNodeId: 'I_139', runId: randomUUID(), paths: ['src/other'] }, operationId: randomUUID() })).kind).toBe('owned');
});

test('child admission refuses missing authority, invalid bounds and foreign original-parent identities', async () => {
    const p = await parentFixture(), mutations = p.f.mutations;
    const binding = p.child.parentBinding;
    for (const changed of [undefined, { ...binding, taskKey: d }, { ...binding, runId: randomUUID() }, { ...binding, generation: 2 }, { ...binding, ownerToken: randomUUID() }, { ...binding, machineId: 'other' }, { ...binding, installationId: randomUUID() }, { ...binding, sessionId: randomUUID() }, { ...binding, extra: true }]) {
        expect((await acquireSharedTask({ ...p, candidate: { ...p.child, parentBinding: changed }, operationId: randomUUID() })).kind).toBe('refused');
    }
    delete p.target.verifyChildRelationship;
    expect((await acquireSharedTask({ ...p, candidate: p.child, operationId: randomUUID() })).kind).toBe('refused');
    for (const maxChildren of [0, -1, 1.5, 4, NaN]) {
        p.target.verifyChildRelationship = async () => ({ maxChildren });
        expect((await acquireSharedTask({ ...p, candidate: p.child, operationId: randomUUID() })).kind).toBe('refused');
    }
    p.target.verifyChildRelationship = async () => { throw Error('canonical group revoked'); };
    expect((await acquireSharedTask({ ...p, candidate: p.child, operationId: randomUUID() })).kind).toBe('refused');
    expect(p.f.mutations).toBe(mutations);
});

test('parent cancellation preserves child reservations and fences child start and acquisition replay', async () => {
    const p = await parentFixture(), operationId = randomUUID();
    const acquired = await acquireSharedTask({ ...p, candidate: p.child, operationId });
    if (acquired.kind !== 'owned') throw Error('child claim');
    const stopProof = { kind: 'operator-confirmed' as const, machineId: p.parent.machineId, installationId: p.parent.installationId, sessionId: p.parent.sessionId, hostBindingDigest: d, bootIdDigest: d, runIds: [p.parent.runId], generation: 1, observedAt: new Date().toISOString(), evidenceRef: p.candidate.approvalBindings[0]!.source };
    const complete = await transitionSharedTask({ claim: p.parent, operationId: randomUUID(), transition: { kind: 'complete', stopProof, acceptedScope: p.candidate.approvalBindings[0]!.source as any } });
    expect(complete).toMatchObject({ kind: 'refused', reason: 'active child reservations retain parent ownership' });
    const recovery = {} as RecoveryEnvelope; // Child guard must refuse before considering incomplete transfer evidence.
    expect(await transitionSharedTask({ claim: p.parent, operationId: randomUUID(), transition: { kind: 'handoff', machine: p.machine, session: p.session, candidate: p.candidate, stopProof, recovery } })).toMatchObject({ kind: 'refused', reason: 'active child reservations retain parent ownership' });
    expect((await transitionSharedTask({ claim: p.parent, operationId: randomUUID(), transition: { kind: 'stop', stopProof } })).kind).toBe('owned');
    expect((await transitionSharedTask({ claim: acquired.claim, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('refused');
    expect((await acquireSharedTask({ ...p, candidate: p.child, operationId })).kind).toBe('refused');
    expect((await transitionSharedTask({ claim: acquired.claim, operationId: randomUUID(), transition: { kind: 'block', stopProof: null } })).kind).toBe('owned');
    expect((await readCoordination(p.target)).index.active).toHaveLength(2);
});

test('child acknowledgment and retry recheck the pinned parent after a concurrent stop', async () => {
    for (const mode of ['conflict', 'ambiguous'] as const) {
        const p = await parentFixture(), commit = p.target.provider.commit;
        let changed = false, calls = 0;
        p.target.verifyChildRelationship = async () => { calls++; return { maxChildren: 3 }; };
        p.target.provider.commit = async (target, input) => {
            if (changed) return commit(target, input);
            changed = true;
            const result = mode === 'ambiguous' ? await commit(target, input) : null;
            const stopped = await transitionSharedTask({ claim: p.parent, operationId: randomUUID(), transition: { kind: 'block', stopProof: null } });
            expect(stopped.kind).toBe('owned');
            return result ? { kind: 'ambiguous', reason: 'response lost after parent stop' } : { kind: 'conflict', reason: 'parent stopped concurrently' };
        };
        const result = await acquireSharedTask({ ...p, candidate: p.child, operationId: randomUUID() });
        expect(result.kind).not.toBe('owned');
        expect(calls).toBeGreaterThanOrEqual(1);
        expect((await readCoordination(p.target)).tasks[p.parent.taskKey]!.state).toBe('blocked');
    }
});

async function onMachine(p: Awaited<ReturnType<typeof parentFixture>>, index: number, childConcurrent = 1) {
    const machine = { ...p.machine, id: 'worker-' + index, installationId: randomUUID(), hostBindingDigest: sha256('worker-' + index), defaults: { ...p.machine.defaults, maxRuns: 1, childConcurrent } };
    const session = { ...p.session, machineId: machine.id, installationId: machine.installationId, hostBindingDigest: machine.hostBindingDigest, sessionId: randomUUID() };
    return { machine, session };
}

test('parent capacity is global while host child capacity spans parent groups', async () => {
    const p = await parentFixture();
    p.target.verifyChildRelationship = async () => ({ maxChildren: 2 });
    for (const index of [0, 1, 2]) {
        const host = await onMachine(p, index);
        const child = { ...p.child, issue: 150 + index, issueNodeId: 'I_' + (150 + index), runId: randomUUID(), paths: ['src/' + index] };
        const result = await acquireSharedTask({ ...host, candidate: child, operationId: randomUUID() });
        expect(result.kind).toBe(index < 2 ? 'owned' : 'busy');
        if (index === 2) expect(result).toMatchObject({ reason: 'parent child capacity busy' });
    }
    const q = await parentFixture();
    q.target.verifyChildRelationship = async () => ({ maxChildren: 3 });
    q.machine.defaults.childConcurrent = 1;
    expect((await acquireSharedTask({ ...q, candidate: q.child, operationId: randomUUID() })).kind).toBe('owned');
    q.machine.allowedRepositories.push('acme/second');
    q.machine.repositoryIds['acme/second'] = 'R_second';
    const parent2 = await acquireSharedTask({ ...q, candidate: { ...q.candidate, issue: 150, issueNodeId: 'I_150', repo: 'acme/second', repositoryNodeId: 'R_second', runId: randomUUID(), independent: false, paths: [] }, operationId: randomUUID() });
    if (parent2.kind !== 'owned') throw Error('second parent claim');
    expect((await transitionSharedTask({ claim: parent2.claim, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('owned');
    const { taskKey, runId, generation, ownerToken, machineId, installationId, sessionId } = parent2.claim;
    const child2 = { ...q.child, issue: 151, issueNodeId: 'I_151', repo: 'acme/second', repositoryNodeId: 'R_second', runId: randomUUID(), parentTaskKey: taskKey, parentBinding: { taskKey, runId, generation, ownerToken, machineId, installationId, sessionId } };
    expect(await acquireSharedTask({ ...q, candidate: child2, operationId: randomUUID() })).toMatchObject({ kind: 'busy', reason: 'machine child capacity busy' });
});

test('verified coordinator exemption does not bypass unrelated cross-repository resource reservations', async () => {
    const p = await parentFixture();
    p.machine.allowedRepositories.push('acme/second');
    p.machine.repositoryIds['acme/second'] = 'R_second';
    expect((await acquireSharedTask({ ...p, candidate: { ...p.candidate, issue: 150, issueNodeId: 'I_150', repo: 'acme/second', repositoryNodeId: 'R_second', runId: randomUUID(), resources: ['database'] }, operationId: randomUUID() })).kind).toBe('owned');
    expect(await acquireSharedTask({ ...p, candidate: { ...p.child, resources: ['database'] }, operationId: randomUUID() })).toMatchObject({ kind: 'busy', reason: 'incompatible resource reservation busy' });
});

test('legacy child stays inspectable and stoppable without deriving a new parent binding', async () => {
    const p = await parentFixture(), acquired = await acquireSharedTask({ ...p, candidate: p.child, operationId: randomUUID() });
    if (acquired.kind !== 'owned') throw Error('child claim');
    const snapshot = await readCoordination(p.target), task = snapshot.tasks[acquired.claim.taskKey]!;
    delete task.parentBinding;
    await p.target.provider.commit(p.target, { branchId: snapshot.branchId, expectedHeadOid: snapshot.head, files: { ['coordination/tasks/' + task.taskKey + '.json']: canonical(task) }, operationId: randomUUID() });
    expect((await readCoordination(p.target)).tasks[task.taskKey]!.parentBinding).toBeUndefined();
    expect(await transitionSharedTask({ claim: acquired.claim, operationId: randomUUID(), transition: { kind: 'start' } })).toMatchObject({ kind: 'refused', reason: 'original parent binding required; legacy child execution refused' });
    expect((await transitionSharedTask({ claim: acquired.claim, operationId: randomUUID(), transition: { kind: 'block', stopProof: null } })).kind).toBe('owned');
});

test('eligible conditional retry and duplicate start revalidate canonical parent group authority', async () => {
    const p = await parentFixture();
    let checks = 0;
    p.target.verifyChildRelationship = async () => { checks++; return { maxChildren: 3 }; };
    p.f.setConflicts(1);
    const acquired = await acquireSharedTask({ ...p, candidate: p.child, operationId: randomUUID() });
    expect(acquired.kind).toBe('owned');
    expect(checks).toBe(3); // Both conditional attempts and the immutable receipt readback.
    if (acquired.kind !== 'owned') throw Error('child claim');
    const operationId = randomUUID();
    expect((await transitionSharedTask({ claim: acquired.claim, operationId, transition: { kind: 'start' } })).kind).toBe('owned');
    p.target.verifyChildRelationship = async () => { throw Error('group authority revoked'); };
    expect(await transitionSharedTask({ claim: acquired.claim, operationId, transition: { kind: 'start' } })).toMatchObject({ kind: 'refused', reason: 'group authority revoked' });
});

test('restart uses persisted original parent identity rather than adopting the current parent record', async () => {
    for (const replacement of [{ runId: randomUUID() }, { generation: 2 }, { ownerToken: randomUUID() }]) {
        const p = await parentFixture(), acquired = await acquireSharedTask({ ...p, candidate: p.child, operationId: randomUUID() });
        if (acquired.kind !== 'owned') throw Error('child claim');
        const snapshot = await readCoordination(p.target), parent = snapshot.tasks[p.parent.taskKey]!;
        await p.target.provider.commit(p.target, { branchId: snapshot.branchId, expectedHeadOid: snapshot.head, files: { ['coordination/tasks/' + parent.taskKey + '.json']: canonical({ ...parent, ...replacement }) }, operationId: randomUUID() });
        const restarted = { ...acquired.claim, target: { ...p.target, localRoot: await mkdtemp(join(tmpdir(), 'vf-child-restart-')) } };
        expect((await readCoordination(restarted.target)).tasks[acquired.claim.taskKey]!.parentBinding).toEqual(p.child.parentBinding);
        expect(await transitionSharedTask({ claim: restarted, operationId: randomUUID(), transition: { kind: 'start' } })).toMatchObject({ kind: 'refused', reason: 'original parent owner/run/generation changed' });
    }
});

async function stoppedChildFixture(state: 'stopped' | 'blocked' = 'stopped') {
    const p = await parentFixture();
    p.machine.defaults.childConcurrent = 1;
    p.target.verifyChildRelationship = async () => ({ maxChildren: 1 });
    const child = await acquireSharedTask({ ...p, candidate: p.child, operationId: randomUUID() });
    if (child.kind !== 'owned') throw Error('child claim');
    const receipt = await publishRecoveryReceipt({ claim: child.claim, operationId: randomUUID(), payload: { schemaVersion: 2, kind: 'effect-reconciliation', runId: child.claim.runId, scopeDigest: d, approvalBindings: p.child.approvalBindings, allowedActionIds: [], checkedEffectIds: [], inspector: { kind: 'qualified-adapter', identityRef: p.machine.id }, result: 'unresolved', reasonCode: 'owned-process-group-stopped' } });
    const stopProof = { kind: 'process-exit' as const, machineId: p.machine.id, installationId: p.machine.installationId, sessionId: p.session.sessionId, hostBindingDigest: d, bootIdDigest: d, runIds: [child.claim.runId], generation: 1, observedAt: new Date().toISOString(), evidenceRef: receipt.reference };
    let physicalStop = true, verifications = 0;
    p.target.verifyTransition = async (task, transition) => {
        if (transition.kind === 'stop') {
            verifications++;
            if (!physicalStop || task.runId !== child.claim.runId || canonical(transition.stopProof) !== canonical(stopProof)) throw Error('physical stop unconfirmed');
        }
    };
    expect((await transitionSharedTask({ claim: child.claim, operationId: randomUUID(), transition: { kind: state === 'stopped' ? 'stop' : 'block', stopProof } })).kind).toBe('owned');
    const next = { ...p.child, issue: 139, issueNodeId: 'I_139', runId: randomUUID(), paths: ['src/next'] };
    return { ...p, childClaim: child.claim, next, stopProof, setUnconfirmed: () => { physicalStop = false; }, get verifications() { return verifications; } };
}

test.each(['stopped', 'blocked'] as const)('verified %s child frees process capacity but keeps resource and ownership reservations', async state => {
    const p = await stoppedChildFixture(state), checks = p.verifications;
    expect((await acquireSharedTask({ ...p, candidate: { ...p.next, paths: p.child.paths }, operationId: randomUUID() })).kind).toBe('busy');
    const operationId = randomUUID(), next = await acquireSharedTask({ ...p, candidate: p.next, operationId });
    expect(next.kind).toBe('owned');
    expect(p.verifications).toBeGreaterThan(checks);
    expect((await acquireSharedTask({ ...p, candidate: p.next, operationId })).kind).toBe('owned');
    const snapshot = await readCoordination(p.target);
    expect(snapshot.index.active).toHaveLength(3);
    expect(snapshot.tasks[p.childClaim.taskKey]!.state).toBe(state);
    expect(snapshot.tasks[p.childClaim.taskKey]!.acceptedScopes).toEqual([]);
    expect((await transitionSharedTask({ claim: p.childClaim, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('refused');
    // A new claimed child consumes the freed slot immediately.
    expect((await acquireSharedTask({ ...p, candidate: { ...p.next, issue: 140, issueNodeId: 'I_140', runId: randomUUID(), paths: ['src/third'] }, operationId: randomUUID() })).kind).toBe('busy');
    p.setUnconfirmed();
    expect((await acquireSharedTask({ ...p, candidate: p.next, operationId })).kind).not.toBe('owned');
});

test('unconfirmed or unavailable stop evidence cannot free a child slot', async () => {
    for (const kind of ['physical', 'receipt', 'generation', 'missing'] as const) {
        const p = await stoppedChildFixture();
        if (kind === 'physical') p.setUnconfirmed();
        if (kind === 'receipt') p.target.verifyEvidence = async () => { throw Error('immutable stop evidence unavailable'); };
        if (kind === 'generation' || kind === 'missing') {
            const snapshot = await readCoordination(p.target), task = snapshot.tasks[p.childClaim.taskKey]!;
            task.stopProof = kind === 'missing' ? null : { ...p.stopProof, generation: 2 };
            await p.target.provider.commit(p.target, { branchId: snapshot.branchId, expectedHeadOid: snapshot.head, files: { ['coordination/tasks/' + task.taskKey + '.json']: canonical(task) }, operationId: randomUUID() });
        }
        expect(await acquireSharedTask({ ...p, candidate: p.next, operationId: randomUUID() })).toMatchObject({ kind: 'busy', reason: 'parent child capacity busy' });
    }
});

async function pendingEffectFixture(kind: 'telemetry-push' | 'handback', state: 'prepared' | 'ambiguous' = 'prepared') {
    const f = await fixture(), owned = await acquireSharedTask({ ...f, operationId: randomUUID() });
    if (owned.kind !== 'owned') throw Error('claim');
    const qualification = await publishRecoveryReceipt({ claim: owned.claim, operationId: randomUUID(), payload: { schemaVersion: 2, kind: 'execution-qualification', harness: 'codex', harnessVersion: 'fixture', model: 'model', effort: 'high', accountRef: 'account', configurationDigest: d, candidateSha: root, validationIds: ['137-T4/check/' + d], managedKinds: ['checkpoint-push', 'handback', 'evidence', 'telemetry-push'], unmanagedDenied: true, result: 'qualified' } });
    const effectId = randomUUID(), target = kind === 'telemetry-push' ? { kind: 'telemetry' as const, destinationRepositoryId: 'R_stats', destinationPath: 'stats/events.jsonl', eventId: randomUUID(), batchId: randomUUID() } : { kind: 'issue-comment' as const, repositoryId: 'R_app', issueNodeId: 'I_137', commentId: null, markerId: 'handback' };
    const intent = await publishRecoveryReceipt({ claim: owned.claim, operationId: randomUUID(), payload: { schemaVersion: 2, kind: 'effect-intent', effectId, runId: owned.claim.runId, generation: 1, approvalBindings: f.candidate.approvalBindings, effectKind: kind, target, payloadDigest: d, result: 'prepared', observedRemoteId: null, observedDigest: null, reasonCode: null } });
    const checkpoint = { schemaVersion: 1 as const, id: randomUUID(), repo: 'acme/app', repositoryId: 'R_app', branch: 'task/137', baseSha: root, headSha: root, treeSha: root, scopeDigest: d, runId: owned.claim.runId, publishedAt: new Date().toISOString() };
    const recovery: RecoveryEnvelope = { schemaVersion: 2, taskKey: owned.claim.taskKey, runId: owned.claim.runId, generation: 1, scopeDigest: d, approvalDigest: d, approvalBindings: f.candidate.approvalBindings, recordBinding: null, execution: { providerMode: 'subscription', harness: 'codex', harnessVersion: 'fixture', model: 'model', effort: 'high', accountRef: 'account', qualification: qualification.reference }, checkpoint, completed: [], children: [], joins: [], effects: [{ operationId: effectId, runId: owned.claim.runId, generation: 1, kind, target, payloadDigest: d, state: 'prepared', intent: intent.reference, outcome: null }], remoteEffectCoverage: { kind: 'qualified-managed-only', qualification: qualification.reference } };
    expect((await transitionSharedTask({ claim: owned.claim, operationId: randomUUID(), transition: { kind: 'checkpoint', checkpoint, recovery } })).kind).toBe('owned');
    if (state === 'ambiguous') { await beginManagedEffect({ claim: owned.claim, effectId, operationId: randomUUID() }); recovery.effects[0]!.state = state; }
    const stopProof = { kind: 'operator-confirmed' as const, machineId: f.machine.id, installationId: f.machine.installationId, sessionId: f.session.sessionId, hostBindingDigest: d, bootIdDigest: d, runIds: [owned.claim.runId], generation: 1, observedAt: new Date().toISOString(), evidenceRef: f.candidate.approvalBindings[0]!.source };
    return { ...f, claim: owned.claim, recovery, stopProof, effectId };
}

async function stoppedGroupFixture(rich = true) {
    const p = await parentFixture();
    const childCandidates = [p.child, { ...p.child, issue: 139, issueNodeId: 'I_139', runId: randomUUID(), paths: ['src/second-child'], approvedTaskIds: ['139-T1'] }];
    const childClaims = [] as typeof p.parent[];
    for (const candidate of childCandidates) {
        const child = await acquireSharedTask({ ...p, candidate, operationId: randomUUID() });
        if (child.kind !== 'owned') throw Error(child.reason);
        childClaims.push(child.claim);
    }
    const prepared = [] as Array<{ candidate: VerifiedCandidate; claim: typeof p.parent; recovery: RecoveryEnvelope; checkpoint: NonNullable<RecoveryEnvelope['checkpoint']>; stopProof: import('../src/shared-claims.ts').StopProof }>;
    for (const [candidate, claim] of [[p.parentCandidate, p.parent], ...childCandidates.map((candidate, index) => [candidate, childClaims[index]!] as const)] as const) {
        const qualified = await publishRecoveryReceipt({ claim, operationId: randomUUID(), payload: { schemaVersion: 2, kind: 'execution-qualification', harness: 'codex', harnessVersion: 'fixture', model: 'model', effort: 'high', accountRef: 'account', configurationDigest: d, candidateSha: root, validationIds: ['137-T4/check/' + d], managedKinds: ['checkpoint-push', 'handback', 'evidence', 'telemetry-push'], unmanagedDenied: true, result: 'qualified' } });
        const checkpoint = { schemaVersion: 1 as const, id: randomUUID(), repo: candidate.repo, repositoryId: candidate.repositoryNodeId, branch: `task/${candidate.issue}`, baseSha: root, headSha: root, treeSha: root, scopeDigest: candidate.scopeDigest, runId: candidate.runId, publishedAt: new Date().toISOString() };
        const accepted = rich ? await publishRecoveryReceipt({ claim, operationId: randomUUID(), payload: { schemaVersion: 2, kind: 'acceptance', taskId: candidate.approvedTaskIds[0]!, runId: claim.runId, sourceSha: root, scopeDigest: candidate.scopeDigest, validationId: candidate.approvedTaskIds[0]! + '/check/' + d, commandDigest: d, result: 'passed', acceptedScope: { schemaVersion: 2, repo: candidate.repo, issue: candidate.issue, artifacts: [{ repo: candidate.repo, issue: candidate.issue, kind: 'plan', artifactId: 'IC_fixture', rev: 1, digest: d }], approvalBindings: candidate.approvalBindings, approvedTaskIds: candidate.approvedTaskIds, completedTaskIds: candidate.approvedTaskIds, parentRepo: candidate.repo, parentIssue: 133, parentBefore: root, parentAfter: root, acceptedAt: new Date().toISOString() } } }) : null;
        const effectId = randomUUID(), effectTarget = { kind: 'telemetry' as const, destinationRepositoryId: 'R_stats', destinationPath: `stats/${candidate.issue}.jsonl`, eventId: randomUUID(), batchId: randomUUID() };
        const intent = rich ? await publishRecoveryReceipt({ claim, operationId: randomUUID(), payload: { schemaVersion: 2, kind: 'effect-intent', effectId, runId: claim.runId, generation: claim.generation, approvalBindings: candidate.approvalBindings, effectKind: 'telemetry-push', target: effectTarget, payloadDigest: d, result: 'prepared', observedRemoteId: null, observedDigest: null, reasonCode: null } }) : null;
        const joinOperationId = randomUUID(), joinEvidence = rich ? await publishRecoveryReceipt({ claim, operationId: randomUUID(), payload: { schemaVersion: 2, kind: 'join', childRunId: claim.runId, generation: claim.generation, fromSha: root, parentBefore: root, parentAfter: null, state: 'prepared', validationId: null, commandDigest: null, result: null } }) : null;
        const recovery: RecoveryEnvelope = { schemaVersion: 2, taskKey: claim.taskKey, runId: claim.runId, generation: claim.generation, approvalBindings: candidate.approvalBindings, recordBinding: null, scopeDigest: candidate.scopeDigest, approvalDigest: d, execution: { providerMode: 'subscription', harness: 'codex', harnessVersion: 'fixture', model: 'model', effort: 'high', accountRef: 'account', qualification: qualified.reference }, checkpoint, completed: accepted ? [{ taskId: candidate.approvedTaskIds[0]!, headSha: root, acceptance: { sourceSha: root, validationId: candidate.approvedTaskIds[0]! + '/check/' + d, commandDigest: d, evidence: accepted.reference } }] : [], children: [], joins: joinEvidence ? [{ operationId: joinOperationId, childRunId: claim.runId, generation: claim.generation, fromSha: root, parentBefore: root, parentAfter: null, state: 'prepared', acceptance: null, evidence: joinEvidence.reference }] : [], effects: intent ? [{ operationId: effectId, runId: claim.runId, generation: claim.generation, kind: 'telemetry-push', target: effectTarget, payloadDigest: d, state: 'prepared', intent: intent.reference, outcome: null }] : [], remoteEffectCoverage: { kind: 'qualified-managed-only', qualification: qualified.reference } };
        const checkpointed = await transitionSharedTask({ claim, operationId: randomUUID(), transition: { kind: 'checkpoint', checkpoint, recovery } });
        if (checkpointed.kind !== 'owned') throw Error(checkpointed.reason);
        if (accepted) {
            const linked = await linkAcceptedScope({ claim, operationId: randomUUID(), acceptedScope: accepted.reference });
            if (linked.kind !== 'owned') throw Error(linked.reason);
        }
        const stopProof = { kind: 'operator-confirmed' as const, machineId: p.machine.id, installationId: p.machine.installationId, sessionId: p.session.sessionId, hostBindingDigest: p.machine.hostBindingDigest, bootIdDigest: p.session.bootIdDigest, runIds: [claim.runId], generation: claim.generation, observedAt: new Date().toISOString(), evidenceRef: candidate.approvalBindings[0]!.source };
        const stopped = await transitionSharedTask({ claim, operationId: randomUUID(), transition: { kind: 'stop', stopProof } });
        if (stopped.kind !== 'owned') throw Error(stopped.reason);
        prepared.push({ candidate, claim, recovery, checkpoint, stopProof });
    }
    const machine = { ...p.machine, id: 'receiver', installationId: randomUUID(), hostBindingDigest: 'a'.repeat(64), defaults: { ...p.machine.defaults, maxRuns: 1, childConcurrent: 1 } };
    const session = { ...p.session, machineId: machine.id, installationId: machine.installationId, hostBindingDigest: machine.hostBindingDigest, sessionId: randomUUID(), localRoot: await mkdtemp(join(tmpdir(), 'vf-group-receiver-')) };
    const before = await readCoordination(p.target);
    const request: GroupSuccessionRequest = { schemaVersion: 1, kind: 'recover-stopped-group', operationId: randomUUID(), expectedHead: before.head, parentTaskKey: p.parent.taskKey, groupPlan: { repo: p.candidate.repo, issue: 133, kind: 'plan', artifactId: 'IC_group_plan', rev: 1, digest: d }, groupsDigest: 'e'.repeat(64), members: prepared.map(({ candidate, claim }) => ({ expected: { taskKey: claim.taskKey, runId: claim.runId, generation: claim.generation, ownerToken: claim.ownerToken, machineId: claim.machineId, installationId: claim.installationId, sessionId: claim.sessionId }, candidate })).sort((a, b) => a.expected.taskKey.localeCompare(b.expected.taskKey)) };
    let groupChecks = 0;
    p.target.verifyGroupSuccession = async ({ parent, members, groupPlan, groupsDigest }) => {
        groupChecks++;
        expect(parent.taskKey).toBe(p.parent.taskKey);
        expect(members.map(row => row.task.taskKey).sort()).toEqual(prepared.map(row => row.claim.taskKey).sort());
        expect(groupPlan).toEqual(request.groupPlan);
        expect(groupsDigest).toBe(request.groupsDigest);
        return { maxChildren: 2 };
    };
    return { ...p, prepared, machine, session, request, before, get groupChecks() { return groupChecks; } };
}

test('atomic stopped-group succession preserves authority and reservations, queues children and fences old owners', async () => {
    const f = await stoppedGroupFixture(), mutations = f.f.mutations;
    const result = await recoverStoppedGroup({ machine: f.machine, session: f.session, request: f.request });
    expect(result.kind).toBe('owned');
    if (result.kind !== 'owned') throw Error(result.reason);
    expect(f.f.mutations).toBe(mutations + 1);
    expect(result.children).toHaveLength(2);
    const after = await readCoordination(f.target);
    const beforeParent = f.before.tasks[result.parent.taskKey]!, afterParent = after.tasks[result.parent.taskKey]!;
    expect(afterParent).toMatchObject({ schemaVersion: 2, state: 'claimed', generation: beforeParent.generation + 1, successionOperationId: f.request.operationId, machineId: f.machine.id, sessionId: f.session.sessionId });
    for (const child of result.children) expect(after.tasks[child.taskKey]).toMatchObject({ schemaVersion: 2, state: 'recovery-queued', generation: f.before.tasks[child.taskKey]!.generation + 1, successionOperationId: f.request.operationId, machineId: f.machine.id, sessionId: f.session.sessionId });
    for (const key of [result.parent.taskKey, ...result.children.map(child => child.taskKey)]) {
        const before = f.before.tasks[key]!, current = after.tasks[key]!;
        for (const field of ['taskKey', 'host', 'repo', 'issue', 'repositoryNodeId', 'issueNodeId', 'scopeDigest', 'approvalDigest', 'approvalBindings', 'runId', 'stage', 'paths', 'resources', 'independent', 'parentTaskKey', 'parentBinding', 'approvedTaskIds', 'checkpoint', 'stopProof', 'unresolvedEffects', 'acceptedScopes'] as const)
            expect(current[field]).toEqual(before[field]);
        expect(current.recovery).toEqual({ ...before.recovery!, generation: before.generation + 1 });
        expect(before.recovery!.completed).toHaveLength(1);
        expect(before.recovery!.joins).toHaveLength(1);
        expect(before.recovery!.effects).toHaveLength(1);
        expect(before.acceptedScopes).toHaveLength(1);
    }
    expect(after.index.active.map(row => ({ taskKey: row.taskKey, paths: row.paths, resources: row.resources })).sort((a, b) => a.taskKey.localeCompare(b.taskKey))).toEqual(f.before.index.active.map(row => ({ taskKey: row.taskKey, paths: row.paths, resources: row.resources })).sort((a, b) => a.taskKey.localeCompare(b.taskKey)));
    expect(after.machines[f.machine.id]!.activeTaskKeys.sort()).toEqual([result.parent.taskKey, ...result.children.map(child => child.taskKey)].sort());
    expect(after.machines[f.prepared[0]!.claim.machineId]!.activeTaskKeys).toEqual([]);
    expect(await inspectGroupSuccession(f.target, { operationId: f.request.operationId, parent: { taskKey: result.parent.taskKey, runId: result.parent.runId, generation: result.parent.generation, ownerToken: result.parent.ownerToken, machineId: result.parent.machineId, installationId: result.parent.installationId, sessionId: result.parent.sessionId } })).toMatchObject({ kind: 'verified', reference: result.reference });
    const oldMutationCount = f.f.mutations, oldParent = f.prepared.find(row => row.claim.taskKey === f.request.parentTaskKey)!;
    const oldOwnerTransitions = [
        { kind: 'start' },
        { kind: 'checkpoint', checkpoint: oldParent.checkpoint, recovery: oldParent.recovery },
        { kind: 'recovery', recovery: oldParent.recovery },
        { kind: 'receipt', payload: { schemaVersion: 2, kind: 'join', childRunId: f.prepared[1]!.claim.runId, generation: 1, fromSha: root, parentBefore: root, parentAfter: null, state: 'prepared', validationId: null, commandDigest: null, result: null } },
        { kind: 'effect-send', effectId: randomUUID() },
        { kind: 'accept-scope', acceptedScope: oldParent.recovery.execution.qualification },
        { kind: 'complete', stopProof: oldParent.stopProof, acceptedScope: oldParent.recovery.execution.qualification },
        { kind: 'handoff', machine: f.machine, session: f.session, candidate: oldParent.candidate, stopProof: oldParent.stopProof, recovery: oldParent.recovery },
    ] as import('../src/shared-claims.ts').TaskTransition[];
    for (const transition of oldOwnerTransitions) expect((await transitionSharedTask({ claim: oldParent.claim, operationId: randomUUID(), transition })).kind).toBe('refused');
    await expect(beginManagedEffect({ claim: oldParent.claim, effectId: randomUUID(), operationId: randomUUID() })).rejects.toThrow('current owner');
    for (const old of f.prepared) expect((await transitionSharedTask({ claim: old.claim, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('refused');
    expect(f.f.mutations).toBe(oldMutationCount);
    for (const child of result.children) expect((await transitionSharedTask({ claim: child, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('refused');
    const parentStarted = await transitionSharedTask({ claim: result.parent, operationId: randomUUID(), transition: { kind: 'start' } });
    expect(parentStarted.kind).toBe('owned');
    const childStarts = await Promise.all(result.children.map(child => transitionSharedTask({ claim: child, operationId: randomUUID(), transition: { kind: 'start' } })));
    expect(childStarts.filter(start => start.kind === 'owned'), JSON.stringify(childStarts)).toHaveLength(1);
    expect(childStarts.filter(start => start.kind !== 'owned'), JSON.stringify(childStarts)).toHaveLength(1);
});

test('two receivers race one stopped group and only one owner set is committed', async () => {
    const f = await stoppedGroupFixture(), secondMachine = { ...f.machine, id: 'receiver-two', installationId: randomUUID(), hostBindingDigest: 'b'.repeat(64) };
    const secondSession = { ...f.session, machineId: secondMachine.id, installationId: secondMachine.installationId, hostBindingDigest: secondMachine.hostBindingDigest, sessionId: randomUUID(), localRoot: await mkdtemp(join(tmpdir(), 'vf-group-receiver-two-')) };
    const results = await Promise.all([
        recoverStoppedGroup({ machine: f.machine, session: f.session, request: f.request }),
        recoverStoppedGroup({ machine: secondMachine, session: secondSession, request: { ...f.request, operationId: randomUUID() } }),
    ]);
    expect(results.filter(result => result.kind === 'owned'), JSON.stringify(results)).toHaveLength(1);
    const winner = results.find(result => result.kind === 'owned');
    if (!winner || winner.kind !== 'owned') throw Error('winner');
    const current = await readCoordination(f.target);
    expect(current.index.revision).toBe(f.before.index.revision + 1);
    expect(new Set(Object.values(current.tasks).map(task => task.machineId))).toEqual(new Set([winner.parent.machineId]));
    expect(new Set(Object.values(current.tasks).map(task => task.sessionId))).toEqual(new Set([winner.parent.sessionId]));
});

test('lost stopped-group CAS response recovers the exact receipt and tokens without a second mutation', async () => {
    const f = await stoppedGroupFixture(), commit = f.target.provider.commit, branch = f.target.provider.branch;
    let lost = false, sends = 0;
    f.target.provider.commit = async (...args) => { sends++; await commit(...args); lost = true; return { kind: 'ambiguous', reason: 'response lost after commit' }; };
    f.target.provider.branch = async (...args) => { if (lost) throw Error('readback unavailable'); return branch(...args); };
    const first = await recoverStoppedGroup({ machine: f.machine, session: f.session, request: f.request });
    expect(first.kind).toBe('ambiguous');
    lost = false;
    const retry = await recoverStoppedGroup({ machine: f.machine, session: f.session, request: f.request });
    expect(retry.kind).toBe('owned');
    if (retry.kind !== 'owned') throw Error(retry.reason);
    expect(sends).toBe(1);
    const again = await recoverStoppedGroup({ machine: f.machine, session: f.session, request: f.request });
    expect(again).toEqual(retry);
    expect(sends).toBe(1);
});

test.each(['live-member', 'missing-stop', 'missing-checkpoint', 'unmanaged-effects', 'authority-denied', 'context-denied', 'omitted-member', 'foreign-member', 'nested-member', 'over-bound'] as const)('stopped-group %s refusal leaves every remote byte unchanged', async mode => {
    const f = await stoppedGroupFixture(), request = structuredClone(f.request);
    const path = `coordination/tasks/${request.parentTaskKey}.json`, files = f.versions.get(f.f.head)!;
    const parent = JSON.parse(files[path]!);
    if (mode === 'live-member') { parent.state = 'running'; parent.stopProof = null; files[path] = canonical(parent); }
    if (mode === 'missing-stop') { parent.stopProof = null; files[path] = canonical(parent); }
    if (mode === 'missing-checkpoint') { parent.checkpoint = null; files[path] = canonical(parent); }
    if (mode === 'unmanaged-effects') { parent.recovery.remoteEffectCoverage = { kind: 'unmanaged-possible', reasonCode: 'unknown-vendor' }; files[path] = canonical(parent); }
    if (mode === 'authority-denied') f.target.verifyCandidate = async () => { throw Error('current authority denied'); };
    if (mode === 'context-denied') f.target.verifyGroupSuccession = async () => { throw Error('private source/context unavailable'); };
    if (mode === 'omitted-member') request.members = request.members.filter(member => member.expected.taskKey === request.parentTaskKey);
    if (mode === 'foreign-member') request.members[0]!.candidate.issueNodeId = 'I_foreign';
    if (mode === 'nested-member') request.members.find(member => member.expected.taskKey !== request.parentTaskKey)!.candidate.parentTaskKey = 'f'.repeat(64);
    if (mode === 'over-bound') request.members = Array.from({ length: 18 }, (_, index) => ({ ...structuredClone(request.members[index % request.members.length]!), expected: { ...structuredClone(request.members[index % request.members.length]!.expected), taskKey: index.toString(16).padStart(64, '0'), runId: randomUUID() }, candidate: { ...structuredClone(request.members[index % request.members.length]!.candidate), issueNodeId: `I_bound_${index}`, runId: randomUUID() } })).sort((a, b) => a.expected.taskKey.localeCompare(b.expected.taskKey));
    const beforeHead = f.f.head, beforeFiles = structuredClone(f.versions.get(beforeHead)), beforeMutations = f.f.mutations;
    const result = await recoverStoppedGroup({ machine: f.machine, session: f.session, request });
    expect(result.kind).not.toBe('owned');
    expect(f.f.head).toBe(beforeHead);
    expect(f.versions.get(beforeHead)).toEqual(beforeFiles);
    expect(f.f.mutations).toBe(beforeMutations);
});

test('new reader retains v1 state while the exact pre-amendment reader refuses v2 task and group receipt bytes', async () => {
    const f = await stoppedGroupFixture();
    expect((await readCoordination(f.target)).tasks[f.request.parentTaskKey]!.schemaVersion).toBe(1);
    const recovered = await recoverStoppedGroup({ machine: f.machine, session: f.session, request: f.request });
    if (recovered.kind !== 'owned') throw Error(recovered.reason);
    const directory = await mkdtemp(join(tmpdir(), 'vf-old-shared-reader-')), source = join(directory, 'src');
    await (await import('node:fs/promises')).mkdir(source, { recursive: true });
    for (const file of ['shared-claims.ts', 'claims.ts', 'gh.ts']) {
        const shown = Bun.spawnSync(['git', 'show', `216e600603e949b4459f74eb34789c0ea988a9b7:packages/cli/src/${file}`], { cwd: resolve(import.meta.dir, '../../..') });
        expect(shown.exitCode, shown.stderr.toString()).toBe(0);
        await writeFile(join(source, file), shown.stdout);
    }
    const old = await import(pathToFileURL(join(source, 'shared-claims.ts')).href + '?' + randomUUID());
    const oldTarget = { ...f.target, localRoot: await mkdtemp(join(tmpdir(), 'vf-old-reader-home-')) };
    await expect(old.readCoordination(oldTarget)).rejects.toThrow('task record');
    await expect(old.resolveEvidence(oldTarget, recovered.reference)).rejects.toThrow('schema');
});

test('historical group inspection survives a verified later child handoff and exposes initial plus current facts', async () => {
    const f = await stoppedGroupFixture(false), recovered = await recoverStoppedGroup({ machine: f.machine, session: f.session, request: f.request });
    if (recovered.kind !== 'owned') throw Error(recovered.reason);
    expect((await transitionSharedTask({ claim: recovered.parent, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('owned');
    const child = recovered.children[0]!, original = f.prepared.find(row => row.claim.taskKey === child.taskKey)!;
    expect((await transitionSharedTask({ claim: child, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('owned');
    const stopProof = { kind: 'operator-confirmed' as const, machineId: f.machine.id, installationId: f.machine.installationId, sessionId: f.session.sessionId, hostBindingDigest: f.machine.hostBindingDigest, bootIdDigest: f.session.bootIdDigest, runIds: [child.runId], generation: child.generation, observedAt: new Date().toISOString(), evidenceRef: original.candidate.approvalBindings[0]!.source };
    expect((await transitionSharedTask({ claim: child, operationId: randomUUID(), transition: { kind: 'stop', stopProof } })).kind).toBe('owned');
    const machine = { ...f.machine, id: 'child-successor', installationId: randomUUID(), hostBindingDigest: 'c'.repeat(64), defaults: { ...f.machine.defaults, childConcurrent: 2 } };
    const session = { ...f.session, machineId: machine.id, installationId: machine.installationId, hostBindingDigest: machine.hostBindingDigest, sessionId: randomUUID(), localRoot: await mkdtemp(join(tmpdir(), 'vf-child-successor-')) };
    statusHistory(f);
    const handed = await transitionSharedTask({ claim: child, operationId: randomUUID(), transition: { kind: 'handoff', machine, session, candidate: original.candidate, stopProof, recovery: { ...original.recovery, generation: child.generation } } });
    if (handed.kind !== 'owned') throw Error(handed.reason);
    const parent = { taskKey: recovered.parent.taskKey, runId: recovered.parent.runId, generation: recovered.parent.generation, ownerToken: recovered.parent.ownerToken, machineId: recovered.parent.machineId, installationId: recovered.parent.installationId, sessionId: recovered.parent.sessionId };
    const inspected = await inspectGroupSuccession(f.target, { operationId: f.request.operationId, parent });
    expect(inspected.kind).toBe('verified');
    if (inspected.kind !== 'verified') throw Error(inspected.reason);
    const progressed = inspected.currentMembers.find(row => row.current.taskKey === child.taskKey)!;
    expect(progressed.initial.generation).toBe(child.generation);
    expect(progressed.current).toMatchObject({ generation: handed.claim.generation, machineId: machine.id, ownerToken: handed.claim.ownerToken });
    expect(progressed.initial.parentBinding).toEqual(progressed.current.parentBinding ?? null);
    const history = f.target.provider.history; delete f.target.provider.history;
    expect((await inspectGroupSuccession(f.target, { operationId: f.request.operationId, parent })).kind).toBe('invalid-or-unavailable');
    f.target.provider.history = history;
    expect((await transitionSharedTask({ claim: handed.claim, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('owned');
    const handedStop = { ...stopProof, machineId: machine.id, installationId: machine.installationId, sessionId: session.sessionId, hostBindingDigest: machine.hostBindingDigest, generation: handed.claim.generation };
    expect((await transitionSharedTask({ claim: handed.claim, operationId: randomUUID(), transition: { kind: 'stop', stopProof: handedStop } })).kind).toBe('owned');
    const parentStop = { ...stopProof, runIds: [recovered.parent.runId], generation: recovered.parent.generation };
    expect((await transitionSharedTask({ claim: recovered.parent, operationId: randomUUID(), transition: { kind: 'stop', stopProof: parentStop } })).kind).toBe('owned');
    const beforeSecond = await readCoordination(f.target), receiver = { ...f.machine, id: 'second-group-receiver', installationId: randomUUID(), hostBindingDigest: 'b'.repeat(64) }, receiverSession = { ...f.session, machineId: 'second-group-receiver', installationId: receiver.installationId, hostBindingDigest: receiver.hostBindingDigest, sessionId: randomUUID() };
    const secondRequest = { ...f.request, operationId: randomUUID(), expectedHead: beforeSecond.head, members: f.prepared.map(row => { const task = beforeSecond.tasks[row.claim.taskKey]!; return { expected: { taskKey: task.taskKey, runId: task.runId, generation: task.generation, ownerToken: task.ownerToken, machineId: task.machineId, installationId: task.installationId, sessionId: task.sessionId }, candidate: row.candidate }; }).sort((a, b) => a.expected.taskKey.localeCompare(b.expected.taskKey)) };
    const second = await recoverStoppedGroup({ machine: receiver, session: receiverSession, request: secondRequest });
    expect(second.kind).toBe('owned');
    if (second.kind !== 'owned') throw Error(second.reason);
    expect(second.children.find(current => current.taskKey === child.taskKey)).toMatchObject({ generation: handed.claim.generation + 1, machineId: receiver.id });
    const status = await readSharedStatus(f.target, ['acme/app']);
    expect(status.history?.coverage).toBe('complete');
    for (const row of status.tasks) expect(row.history.events.filter(event => event.kind === 'group-succession')).toHaveLength(2);
});

test.each(['parent-binding', 'run', 'broken-link'] as const)('a second succession refuses a forged %s lineage even when the prior receipt has the same task key', async mode => {
    const f = await stoppedGroupFixture(false); f.machine.defaults.childConcurrent = 2;
    const first = await recoverStoppedGroup({ machine: f.machine, session: f.session, request: f.request });
    if (first.kind !== 'owned') throw Error(first.reason);
    expect((await transitionSharedTask({ claim: first.parent, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('owned');
    for (const claim of first.children) expect((await transitionSharedTask({ claim, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('owned');
    for (const claim of [first.parent, ...first.children]) {
        const source = f.prepared.find(row => row.claim.taskKey === claim.taskKey)!.candidate.approvalBindings[0]!.source;
        const proof = { kind: 'operator-confirmed' as const, machineId: f.machine.id, installationId: f.machine.installationId, sessionId: f.session.sessionId, hostBindingDigest: f.machine.hostBindingDigest, bootIdDigest: f.session.bootIdDigest, runIds: [claim.runId], generation: claim.generation, observedAt: new Date().toISOString(), evidenceRef: source };
        expect((await transitionSharedTask({ claim, operationId: randomUUID(), transition: { kind: 'stop', stopProof: proof } })).kind).toBe('owned');
    }
    const snapshot = await readCoordination(f.target), forgedKey = first.children[0]!.taskKey, path = `coordination/tasks/${forgedKey}.json`, task = snapshot.tasks[forgedKey]!;
    const forgedBinding = { ...task.parentBinding!, ownerToken: randomUUID() }, forgedRun = randomUUID();
    const changed = mode === 'parent-binding' ? { ...task, parentBinding: forgedBinding }
        : mode === 'run' ? { ...task, runId: forgedRun, checkpoint: { ...task.checkpoint!, runId: forgedRun }, stopProof: { ...task.stopProof!, runIds: [forgedRun] }, recovery: { ...task.recovery!, runId: forgedRun, checkpoint: { ...task.recovery!.checkpoint!, runId: forgedRun } } }
        : { ...task, successionOperationId: randomUUID() };
    f.versions.get(snapshot.head)![path] = canonical(changed);
    const current = await readCoordination(f.target), machine = { ...f.machine, id: 'second-receiver', installationId: randomUUID(), hostBindingDigest: 'b'.repeat(64) }, session = { ...f.session, machineId: 'second-receiver', installationId: machine.installationId, hostBindingDigest: machine.hostBindingDigest, sessionId: randomUUID() };
    const members = f.prepared.map(row => { const now = current.tasks[row.claim.taskKey]!; const candidate = now.taskKey !== forgedKey ? row.candidate : mode === 'parent-binding' ? { ...row.candidate, parentBinding: forgedBinding } : mode === 'run' ? { ...row.candidate, runId: forgedRun } : row.candidate; return { expected: { taskKey: now.taskKey, runId: now.runId, generation: now.generation, ownerToken: now.ownerToken, machineId: now.machineId, installationId: now.installationId, sessionId: now.sessionId }, candidate }; }).sort((a, b) => a.expected.taskKey.localeCompare(b.expected.taskKey));
    const request = { ...f.request, operationId: randomUUID(), expectedHead: current.head, members }, mutations = f.f.mutations;
    const result = await recoverStoppedGroup({ machine, session, request });
    expect(result.kind, JSON.stringify(result)).toBe('refused');
    expect(f.f.mutations).toBe(mutations);
});

test.each(['authority', 'group-context'] as const)('post-CAS %s loss returns no stopped-group claims', async mode => {
    const f = await stoppedGroupFixture(), commit = f.target.provider.commit;
    f.target.provider.commit = async (...args) => {
        const result = await commit(...args);
        if (result.kind === 'committed') {
            if (mode === 'authority') f.target.verifyCandidate = async () => { throw Error('authority revoked after CAS'); };
            else f.target.verifyGroupSuccession = async () => { throw Error('group context revoked after CAS'); };
        }
        return result;
    };
    const before = f.f.mutations, result = await recoverStoppedGroup({ machine: f.machine, session: f.session, request: f.request });
    expect(result.kind).not.toBe('owned');
    expect(f.f.mutations).toBe(before + 1);
    expect(Object.values((await readCoordination(f.target)).tasks).every(task => task.schemaVersion === 2)).toBe(true);
});

test('status validates and projects one typed group succession event per member', async () => {
    const f = await stoppedGroupFixture(false), recovered = await recoverStoppedGroup({ machine: f.machine, session: f.session, request: f.request });
    if (recovered.kind !== 'owned') throw Error(recovered.reason);
    statusHistory(f);
    const status = await readSharedStatus(f.target, ['acme/app']);
    expect(status.history?.coverage).toBe('complete');
    expect(status.tasks).toHaveLength(3);
    for (const task of status.tasks) expect(task.history.events).toContainEqual(expect.objectContaining({ kind: 'group-succession', generation: 2, machineId: f.machine.id, previousMachineId: f.prepared[0]!.claim.machineId }));
});

test.each(['prepared', 'ambiguous'] as const)('typed %s telemetry remains pending through verified transfer while code/control effects block', async state => {
    for (const kind of ['telemetry-push', 'handback'] as const) {
        const p = await pendingEffectFixture(kind, state);
        const machine = { ...p.machine, id: 'other', installationId: randomUUID(), hostBindingDigest: 'a'.repeat(64) }, session = { ...p.session, machineId: 'other', installationId: machine.installationId, hostBindingDigest: machine.hostBindingDigest, sessionId: randomUUID() };
        const transferred = await transitionSharedTask({ claim: p.claim, operationId: randomUUID(), transition: { kind: 'handoff', machine, session, candidate: p.candidate, stopProof: p.stopProof, recovery: p.recovery } });
        expect(transferred.kind).toBe(kind === 'telemetry-push' ? 'owned' : 'refused');
        if (transferred.kind === 'owned') {
            expect((await readCoordination(p.target)).tasks[p.claim.taskKey]!.recovery!.effects).toEqual(p.recovery.effects);
            await expect(verifyManagedEffect(p.claim, p.effectId)).rejects.toThrow('current owner');
        }
    }
});

test.each(['prepared', 'ambiguous'] as const)('reconciled %s telemetry does not block accepted completion and its exact history survives', async state => {
    const p = await pendingEffectFixture('telemetry-push', state);
    const reconciliation = await publishRecoveryReceipt({ claim: p.claim, operationId: randomUUID(), payload: { schemaVersion: 2, kind: 'effect-reconciliation', runId: p.claim.runId, scopeDigest: d, approvalBindings: p.candidate.approvalBindings, allowedActionIds: [], checkedEffectIds: [], inspector: { kind: 'authorized-operator', identityRef: 'fixture-inspector' }, result: 'complete', reasonCode: 'fixture-inspected' } });
    p.recovery.remoteEffectCoverage = { kind: 'reconciled', evidence: reconciliation.reference };
    expect((await transitionSharedTask({ claim: p.claim, operationId: randomUUID(), transition: { kind: 'recovery', recovery: p.recovery } })).kind).toBe('owned');
    const accepted = await publishRecoveryReceipt({ claim: p.claim, operationId: randomUUID(), payload: { schemaVersion: 2, kind: 'acceptance', taskId: '137-T1', runId: p.claim.runId, sourceSha: root, scopeDigest: d, validationId: '137-T1/check/' + d, commandDigest: d, result: 'passed', acceptedScope: { schemaVersion: 2, repo: p.candidate.repo, issue: p.candidate.issue, artifacts: [{ repo: p.candidate.repo, issue: p.candidate.issue, kind: 'brief', artifactId: 'I_137', rev: 1, digest: d }], approvalBindings: p.candidate.approvalBindings, approvedTaskIds: p.candidate.approvedTaskIds, completedTaskIds: p.candidate.approvedTaskIds, parentRepo: p.candidate.repo, parentIssue: 133, parentBefore: root, parentAfter: root, acceptedAt: new Date().toISOString() } } });
    if (state === 'ambiguous') expect((await linkAcceptedScope({ claim: p.claim, operationId: randomUUID(), acceptedScope: accepted.reference })).kind).toBe('owned');
    const complete = await transitionSharedTask({ claim: p.claim, operationId: randomUUID(), transition: { kind: 'complete', stopProof: p.stopProof, acceptedScope: accepted.reference } });
    expect(complete.kind).toBe('owned');
    if (complete.kind !== 'owned') throw Error('completion');
    const raw = await p.target.provider.read(p.target, complete.claim.stateCommit, 'coordination/tasks/' + p.claim.taskKey + '.json');
    expect(JSON.parse(raw!).recovery.effects).toEqual(p.recovery.effects);
    expect(JSON.parse(raw!).state).toBe('completed');
    expect((await readCoordination(p.target)).index.active).toEqual([]);
    const inspected = await inspectCoordinationTask(p.target, p.claim.taskKey, { runId: p.claim.runId, generation: p.claim.generation, ownerToken: p.claim.ownerToken, scopeDigest: d });
    expect(inspected.kind).toBe('completed');
    if (inspected.kind !== 'completed') throw Error('inspection');
    expect(inspected.head).toBe(complete.claim.stateCommit);
    expect(inspected.task).toEqual(JSON.parse(raw!));
    expect(inspected.task.recovery!.effects).toEqual(p.recovery.effects);
    expect(inspected.task.acceptedScopes).toEqual([{ scopeDigest: d, receipt: accepted.reference }]);
    statusHistory(p);
    const status = await readSharedStatus(p.target, [p.candidate.repo]);
    expect(status.tasks).toHaveLength(1);
    expect(status.tasks[0]).toMatchObject({ state: 'completed', sourceCommit: complete.claim.stateCommit, originMachineId: p.machine.id, history: { coverage: 'complete' } });
    expect(status.tasks[0]!.history.events[0]!.kind).toBe('complete');
    expect(status.history!.archiveCoverage).toBe('partial');
});

test('reporting exception preserves unmanaged coverage, code reconciliation and telemetry intent validation', async () => {
    const p = await pendingEffectFixture('telemetry-push');
    for (const effects of [[{ ...p.recovery.effects[0]!, payloadDigest: 'e'.repeat(64) }], [{ ...p.recovery.effects[0]!, target: { kind: 'telemetry' as const, destinationRepositoryId: 'R_other', destinationPath: 'stats/other.jsonl', eventId: randomUUID(), batchId: randomUUID() } }]]) {
        expect((await transitionSharedTask({ claim: p.claim, operationId: randomUUID(), transition: { kind: 'recovery', recovery: { ...p.recovery, effects } } })).kind).toBe('refused');
    }
    p.recovery.remoteEffectCoverage = { kind: 'unmanaged-possible', reasonCode: 'vendor-unknown' };
    expect((await transitionSharedTask({ claim: p.claim, operationId: randomUUID(), transition: { kind: 'recovery', recovery: p.recovery } })).kind).toBe('owned');
    expect(await transitionSharedTask({ claim: p.claim, operationId: randomUUID(), transition: { kind: 'complete', stopProof: p.stopProof, acceptedScope: p.recovery.execution.qualification as any } })).toMatchObject({ kind: 'refused', reason: 'unmanaged remote effects possible; recovery blocked' });
    const code = await pendingEffectFixture('handback');
    const reconciliation = await publishRecoveryReceipt({ claim: code.claim, operationId: randomUUID(), payload: { schemaVersion: 2, kind: 'effect-reconciliation', runId: code.claim.runId, scopeDigest: d, approvalBindings: code.candidate.approvalBindings, allowedActionIds: [], checkedEffectIds: [], inspector: { kind: 'authorized-operator', identityRef: 'fixture-inspector' }, result: 'complete', reasonCode: 'fixture-inspected' } });
    code.recovery.remoteEffectCoverage = { kind: 'reconciled', evidence: reconciliation.reference };
    expect(await transitionSharedTask({ claim: code.claim, operationId: randomUUID(), transition: { kind: 'recovery', recovery: code.recovery } })).toMatchObject({ kind: 'refused', reason: 'incomplete effect reconciliation' });
});

test('telemetry kind on a code/control target does not obtain the reporting exemption', async () => {
    const p = await pendingEffectFixture('telemetry-push'), effectId = randomUUID();
    const target = { kind: 'issue-comment' as const, repositoryId: 'R_app', issueNodeId: 'I_137', commentId: null, markerId: 'not-reporting' };
    const intent = await publishRecoveryReceipt({ claim: p.claim, operationId: randomUUID(), payload: { schemaVersion: 2, kind: 'effect-intent', effectId, runId: p.claim.runId, generation: 1, approvalBindings: p.candidate.approvalBindings, effectKind: 'telemetry-push', target, payloadDigest: d, result: 'prepared', observedRemoteId: null, observedDigest: null, reasonCode: null } });
    p.recovery.effects.push({ operationId: effectId, runId: p.claim.runId, generation: 1, kind: 'telemetry-push', target, payloadDigest: d, state: 'prepared', intent: intent.reference, outcome: null });
    expect((await transitionSharedTask({ claim: p.claim, operationId: randomUUID(), transition: { kind: 'recovery', recovery: p.recovery } })).kind).toBe('owned');
    expect(await transitionSharedTask({ claim: p.claim, operationId: randomUUID(), transition: { kind: 'complete', stopProof: p.stopProof, acceptedScope: p.recovery.execution.qualification as any } })).toMatchObject({ kind: 'refused', reason: 'unresolved remote effects retain ownership' });
});

test('retained inspector binds a single current head and refuses missing, invalid and mismatched records without writes', async () => {
    const f = await fixture(), key = taskKey(f.candidate.host, f.candidate.repositoryNodeId, f.candidate.issueNodeId);
    const before = await (await import('node:fs/promises')).readdir(f.target.localRoot);
    expect(await inspectCoordinationTask(f.target, key)).toEqual({ kind: 'absent', head: root });
    expect(await (await import('node:fs/promises')).readdir(f.target.localRoot)).toEqual(before);
    const owned = await acquireSharedTask({ ...f, operationId: randomUUID() });
    if (owned.kind !== 'owned') throw Error('claim');
    const pointer = await readFile(join(f.target.localRoot, sha256(`${f.target.host}\n${f.target.repositoryId}\n${f.target.branch}`), 'accepted.json'), 'utf8');
    const reads: string[] = [], read = f.target.provider.read;
    f.target.provider.read = async (target, head, path) => { reads.push(head); return read(target, head, path); };
    const count = f.mutations;
    const active = await inspectCoordinationTask(f.target, key);
    expect(active.kind).toBe('active');
    expect(new Set(reads)).toEqual(new Set([f.head]));
    expect(f.mutations).toBe(count);
    expect(await readFile(join(f.target.localRoot, sha256(`${f.target.host}\n${f.target.repositoryId}\n${f.target.branch}`), 'accepted.json'), 'utf8')).toBe(pointer);
    for (const expected of [{ runId: randomUUID() }, { generation: 2 }, { ownerToken: randomUUID() }, { scopeDigest: 'a'.repeat(64) }, { machineId: 'foreign' }, { installationId: randomUUID() }, { sessionId: randomUUID() }])
        expect((await inspectCoordinationTask(f.target, key, expected)).kind).toBe('invalid-or-unavailable');
    const files = f.versions.get(f.head)!, path = 'coordination/tasks/' + key + '.json', saved = files[path]!;
    for (const corrupt of [null, '{}', canonical({ ...JSON.parse(saved), state: 'completed' }), canonical({ ...JSON.parse(saved), issueNodeId: 'I_other' }), canonical({ ...JSON.parse(saved), extra: true })]) {
        if (corrupt === null) delete files[path]; else files[path] = corrupt;
        expect((await inspectCoordinationTask(f.target, key)).kind).toBe('invalid-or-unavailable');
    }
    files[path] = saved;
    const index = JSON.parse(files['coordination/index.json']!); index.active = []; files['coordination/index.json'] = canonical(index);
    // An orphaned claimed task is not an archival completion.
    const machinePath = 'coordination/machines/' + f.machine.id + '.json';
    const machine = JSON.parse(files[machinePath]!); machine.activeTaskKeys = []; files[machinePath] = canonical(machine);
    expect((await inspectCoordinationTask(f.target, key)).kind).toBe('invalid-or-unavailable');
    f.target.provider.branch = async () => { throw Error('offline'); };
    expect((await inspectCoordinationTask(f.target, key)).kind).toBe('invalid-or-unavailable');
});

test('retained inspector preserves unresolved refs and rejects malformed or foreign recovery envelopes', async () => {
    const p = await pendingEffectFixture('telemetry-push'), key = p.claim.taskKey;
    const snapshot = await readCoordination(p.target), task = snapshot.tasks[key]!;
    task.unresolvedEffects = [p.recovery.effects[0]!.intent];
    const path = 'coordination/tasks/' + key + '.json';
    const write = async (value: unknown) => p.target.provider.commit(p.target, { branchId: snapshot.branchId, expectedHeadOid: (await p.target.provider.branch(p.target)).head, files: { [path]: canonical(value) }, operationId: randomUUID() });
    await write(task);
    const inspected = await inspectCoordinationTask(p.target, key);
    expect(inspected.kind).toBe('active');
    if (inspected.kind !== 'active') throw Error('inspection');
    expect(inspected.task).toEqual(task);
    for (const recovery of [{ ...task.recovery, extra: true }, { ...task.recovery, runId: randomUUID() }, { ...task.recovery, generation: 2 }, { ...task.recovery, approvalDigest: 'a'.repeat(64) }, { ...task.recovery, effects: [{ ...task.recovery!.effects[0]!, state: 'acknowledged' }] }]) {
        await write({ ...task, recovery });
        expect((await inspectCoordinationTask(p.target, key)).kind).toBe('invalid-or-unavailable');
    }
});

async function acceptanceFixture() {
    const f = await fixture();
    f.candidate.approvedTaskIds.push('137-T2');
    const acquired = await acquireSharedTask({ ...f, operationId: randomUUID() });
    if (acquired.kind !== 'owned') throw Error('claim');
    const payload: Extract<RecoveryEvidencePayload, { kind: 'acceptance' }> = {
        schemaVersion: 2, kind: 'acceptance', taskId: '137-T1', runId: acquired.claim.runId,
        sourceSha: root, scopeDigest: d, validationId: '137-T1/check/' + d, commandDigest: d, result: 'passed',
        acceptedScope: { schemaVersion: 2, repo: f.candidate.repo, issue: f.candidate.issue,
            artifacts: [{ repo: f.candidate.repo, issue: f.candidate.issue, kind: 'brief', artifactId: 'I_137', rev: 1, digest: d }],
            approvalBindings: f.candidate.approvalBindings, approvedTaskIds: f.candidate.approvedTaskIds,
            completedTaskIds: ['137-T1'], parentRepo: f.candidate.repo, parentIssue: 133,
            parentBefore: root, parentAfter: '2'.repeat(40), acceptedAt: new Date().toISOString() }
    };
    const published = await publishRecoveryReceipt({ claim: acquired.claim, operationId: randomUUID(), payload });
    return { ...f, claim: acquired.claim, published, payload };
}
test('partial accepted scope links once after a lost response and retains active ownership and reservations', async () => {
    const f = await acceptanceFixture(), before = await readCoordination(f.target);
    f.setAmbiguous();
    const input = { claim: f.claim, operationId: randomUUID(), acceptedScope: f.published.reference };
    expect((await linkAcceptedScope(input)).kind).toBe('owned');
    const linked = await readCoordination(f.target);
    expect((await linkAcceptedScope(input)).kind).toBe('owned');
    expect((await readCoordination(f.target)).head).toBe(linked.head);
    expect(linked.index).toEqual(before.index);
    expect(linked.machines).toEqual(before.machines);
    expect(linked.tasks[f.claim.taskKey]).toEqual({ ...before.tasks[f.claim.taskKey]!, acceptedScopes: [{ scopeDigest: d, receipt: f.published.reference }] });
    expect((await transitionSharedTask({ claim: f.claim, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('owned');
    f.target.verifyTransition = async () => { throw Error('current approval revoked'); };
    expect(await linkAcceptedScope(input)).toMatchObject({ kind: 'refused', reason: 'current approval revoked' });
});
test('historical receipt and previous head preserve original identity without latest-owner substitution', async () => {
    const f = await acceptanceFixture();
    const { taskKey, runId, generation, ownerToken, machineId, installationId, sessionId } = f.claim;
    const input = { taskKey, expected: { taskKey, runId, generation, ownerToken, machineId, installationId, sessionId }, evidence: f.published.reference, at: 'previous-head' as const };
    await transitionSharedTask({ claim: f.claim, operationId: randomUUID(), transition: { kind: 'start' } });
    const result = await inspectHistoricalCoordinationTask(f.target, input);
    expect(result.kind).toBe('historical');
    if (result.kind !== 'historical') throw Error('historical');
    expect(result.head).toBe(f.claim.stateCommit);
    expect(result.task.state).toBe('claimed');
    expect((await inspectCoordinationTask(f.target, taskKey)).kind).toBe('active');
    for (const expected of [{ ...input.expected, generation: generation + 1 }, { ...input.expected, ownerToken: randomUUID() }])
        expect((await inspectHistoricalCoordinationTask(f.target, { ...input, expected })).kind).toBe('invalid-or-unavailable');
    expect((await inspectHistoricalCoordinationTask(f.target, { ...input, evidence: { ...input.evidence, blobSha256: 'f'.repeat(64) } })).kind).toBe('invalid-or-unavailable');
});

test('acceptance refuses missing receipts, stale generation, source or authority denial and unsupported transitions without writes', async () => {
    const f = await acceptanceFixture();
    const input = { claim: f.claim, operationId: randomUUID(), acceptedScope: f.published.reference };
    const before = (await readCoordination(f.target)).head;
    expect((await linkAcceptedScope({ ...input, acceptedScope: { ...input.acceptedScope, operationId: randomUUID() } })).kind).toBe('refused');
    expect((await linkAcceptedScope({ ...input, claim: { ...f.claim, generation: 2 } })).kind).toBe('refused');
    f.target.verifyEvidence = async (_ref, payload) => { if (payload?.kind === 'acceptance' && payload.sourceSha !== '3'.repeat(40)) throw Error('reviewed source mismatch'); };
    expect(await linkAcceptedScope(input)).toMatchObject({ kind: 'refused', reason: 'reviewed source mismatch' });
    f.target.verifyEvidence = async () => {};
    f.target.verifyTransition = async () => { throw Error('join not authorized'); };
    expect(await linkAcceptedScope(input)).toMatchObject({ kind: 'refused', reason: 'join not authorized' });
    f.target.verifyTransition = async () => {};
    expect(await transitionSharedTask({ claim: f.claim, operationId: randomUUID(), transition: { kind: 'typo' } as any })).toEqual({ kind: 'refused', reason: 'unsupported task transition kind' });
    expect((await readCoordination(f.target)).head).toBe(before);
});
test('acceptance exact scope bindings refuse foreign task sets, scope, run and receipt publisher', async () => {
    const f = await acceptanceFixture();
    const scope = f.payload.acceptedScope!;
    const variants = [
        { ...f.payload, acceptedScope: null },
        { ...f.payload, runId: randomUUID() },
        { ...f.payload, scopeDigest: 'e'.repeat(64) },
        { ...f.payload, taskId: '137-T2' },
        { ...f.payload, acceptedScope: { ...scope, approvedTaskIds: ['137-T1'] } },
        { ...f.payload, acceptedScope: { ...scope, approvalBindings: [{ ...scope.approvalBindings[0]!, approvalId: 'foreign' }] } },
    ];
    for (const payload of variants) {
        const published = await publishRecoveryReceipt({ claim: f.claim, operationId: randomUUID(), payload });
        const before = (await readCoordination(f.target)).head;
        expect((await linkAcceptedScope({ claim: f.claim, operationId: randomUUID(), acceptedScope: published.reference })).kind).toBe('refused');
        expect((await readCoordination(f.target)).head).toBe(before);
    }
    const other = await acquireSharedTask({ ...f, candidate: { ...f.candidate, issue: 138, issueNodeId: 'I_138', paths: ['src/b'], runId: randomUUID() }, operationId: randomUUID() });
    if (other.kind !== 'owned') throw Error('other claim');
    const published = await publishRecoveryReceipt({ claim: other.claim, operationId: randomUUID(), payload: f.payload });
    expect((await linkAcceptedScope({ claim: f.claim, operationId: randomUUID(), acceptedScope: published.reference })).kind).toBe('refused');
});
test('historical pins refuse unavailable or malformed state, foreign branch and every wrong owner field', async () => {
    const f = await acceptanceFixture();
    const { taskKey, runId, generation, ownerToken, machineId, installationId, sessionId } = f.claim;
    const input = { taskKey, expected: { taskKey, runId, generation, ownerToken, machineId, installationId, sessionId }, evidence: f.published.reference, at: 'receipt' as const };
    for (const field of ['taskKey', 'runId', 'ownerToken', 'machineId', 'installationId', 'sessionId'] as const) {
        const wrong = field === 'taskKey' ? 'e'.repeat(64) : field === 'machineId' ? 'foreign-machine' : randomUUID();
        expect((await inspectHistoricalCoordinationTask(f.target, { ...input, expected: { ...input.expected, [field]: wrong } })).kind).toBe('invalid-or-unavailable');
    }
    expect((await inspectHistoricalCoordinationTask(f.target, { ...input, expected: { taskKey } as any })).kind).toBe('invalid-or-unavailable');
    expect((await inspectHistoricalCoordinationTask(f.target, { ...input, evidence: null as any })).kind).toBe('invalid-or-unavailable');
    const path = 'coordination/tasks/' + taskKey + '.json', files = f.versions.get(input.evidence.commitSha)!;
    const original = files[path]!;
    for (const corrupt of ['{}', canonical({ ...JSON.parse(original), state: 'completed' }), canonical({ ...JSON.parse(original), extra: true })]) {
        files[path] = corrupt;
        expect((await inspectHistoricalCoordinationTask(f.target, input)).kind).toBe('invalid-or-unavailable');
    }
    delete files[path];
    expect((await inspectHistoricalCoordinationTask(f.target, input)).kind).toBe('invalid-or-unavailable');
    files[path] = original;
    const branch = f.target.provider.branch;
    f.target.provider.branch = async t => ({ ...await branch(t), defaultBranch: 'factory-state' });
    expect((await inspectHistoricalCoordinationTask(f.target, input)).kind).toBe('invalid-or-unavailable');
    f.target.provider.branch = branch;
    f.rewrite();
    expect((await inspectHistoricalCoordinationTask(f.target, input)).kind).toBe('invalid-or-unavailable');
});
test('historical read retains checkpoint, stop and pending effects across actual ownership transfer', async () => {
    const f = await pendingEffectFixture('telemetry-push', 'ambiguous');
    expect((await transitionSharedTask({ claim: f.claim, operationId: randomUUID(), transition: { kind: 'stop', stopProof: f.stopProof } })).kind).toBe('owned');
    const published = await publishRecoveryReceipt({ claim: f.claim, operationId: randomUUID(), payload: { schemaVersion: 2, kind: 'acceptance', taskId: '137-T1', runId: f.claim.runId, sourceSha: root, scopeDigest: d, validationId: '137-T1/check/' + d, commandDigest: d, result: 'passed', acceptedScope: null } });
    const original = (await readCoordination(f.target)).tasks[f.claim.taskKey]!;
    const machine = { ...f.machine, id: 'replacement', installationId: randomUUID(), hostBindingDigest: 'a'.repeat(64) }, session = { ...f.session, machineId: machine.id, installationId: machine.installationId, hostBindingDigest: machine.hostBindingDigest, sessionId: randomUUID() };
    expect((await transitionSharedTask({ claim: f.claim, operationId: randomUUID(), transition: { kind: 'handoff', machine, session, candidate: f.candidate, stopProof: f.stopProof, recovery: f.recovery } })).kind).toBe('owned');
    const { taskKey, runId, generation, ownerToken, machineId, installationId, sessionId } = f.claim;
    const expected = { taskKey, runId, generation, ownerToken, machineId, installationId, sessionId };
    const result = await inspectHistoricalCoordinationTask(f.target, { taskKey, expected, evidence: published.reference, at: 'receipt' });
    expect(result).toEqual({ kind: 'historical', head: published.reference.commitSha, task: original });
    expect((await inspectCoordinationTask(f.target, taskKey, { ownerToken })).kind).toBe('invalid-or-unavailable');
    expect((await transitionSharedTask({ claim: f.claim, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('refused');
});

test('historical child token comes only from immutable child facts bound to its exact original parent', async () => {
    const p = await parentFixture();
    const acquired = await acquireSharedTask({ ...p, candidate: p.child, operationId: randomUUID() });
    if (acquired.kind !== 'owned') throw Error('child');
    const published = await publishRecoveryReceipt({ claim: p.parent, operationId: randomUUID(), payload: { schemaVersion: 2, kind: 'acceptance', taskId: '137-T1', runId: acquired.claim.runId, sourceSha: root, scopeDigest: d, validationId: '137-T1/check/' + d, commandDigest: d, result: 'passed', acceptedScope: null } });
    const { taskKey, runId, generation, machineId, installationId, sessionId } = acquired.claim;
    const expected = { child: { taskKey, runId, generation, machineId, installationId, sessionId }, parent: p.child.parentBinding };
    const input = { taskKey, expected, evidence: published.reference, at: 'receipt' as const };
    const original = (await readCoordination(p.target)).tasks[taskKey]!;
    const current = await readCoordination(p.target);
    await p.target.provider.commit(p.target, { branchId: current.branchId, expectedHeadOid: current.head, operationId: randomUUID(), files: { ['coordination/tasks/' + taskKey + '.json']: canonical({ ...original, ownerToken: randomUUID(), generation: 2 }) } });
    expect(await inspectHistoricalCoordinationTask(p.target, input)).toEqual({ kind: 'historical', head: published.reference.commitSha, task: original });
    expect((await inspectCoordinationTask(p.target, taskKey, { ownerToken: acquired.claim.ownerToken })).kind).toBe('invalid-or-unavailable');
    expect((await inspectHistoricalCoordinationTask(p.target, { ...input, expected: { ...expected, parent: { ...expected.parent, ownerToken: randomUUID() } } })).kind).toBe('invalid-or-unavailable');
    expect((await inspectHistoricalCoordinationTask(p.target, { ...input, expected: { ...expected, child: { ...expected.child, generation: 2 } } })).kind).toBe('invalid-or-unavailable');
    expect((await inspectHistoricalCoordinationTask(p.target, { ...input, expected: expected.child as any })).kind).toBe('invalid-or-unavailable');
    expect((await inspectHistoricalCoordinationTask(p.target, { ...input, extra: true } as any)).kind).toBe('invalid-or-unavailable');
    const files = p.versions.get(published.reference.commitSha)!;
    const path = 'coordination/tasks/' + taskKey + '.json';
    const { parentBinding: _binding, ...legacy } = original;
    for (const record of [legacy, { ...original, parentBinding: null }, { ...original, parentTaskKey: null }]) {
        files[path] = canonical(record);
        expect((await inspectHistoricalCoordinationTask(p.target, input)).kind).toBe('invalid-or-unavailable');
    }
});

test('stopped unfinished ownership accepts a partial scope without releasing its reservations', async () => {
    const f = await acceptanceFixture();
    const stopProof = { kind: 'operator-confirmed' as const, machineId: f.machine.id, installationId: f.machine.installationId, sessionId: f.session.sessionId, hostBindingDigest: d, bootIdDigest: d, runIds: [f.claim.runId], generation: 1, observedAt: new Date().toISOString(), evidenceRef: f.candidate.approvalBindings[0]!.source };
    expect((await transitionSharedTask({ claim: f.claim, operationId: randomUUID(), transition: { kind: 'stop', stopProof } })).kind).toBe('owned');
    const before = await readCoordination(f.target);
    expect((await linkAcceptedScope({ claim: f.claim, operationId: randomUUID(), acceptedScope: f.published.reference })).kind).toBe('owned');
    const after = await readCoordination(f.target);
    expect(after.index).toEqual(before.index);
    expect(after.machines).toEqual(before.machines);
    expect(after.tasks[f.claim.taskKey]).toEqual({ ...before.tasks[f.claim.taskKey]!, acceptedScopes: [{ scopeDigest: d, receipt: f.published.reference }] });
});

test('handoff lost-response retry proves the original owner and returns only the committed successor', async () => {
    const p = await pendingEffectFixture('telemetry-push');
    const machine = { ...p.machine, id: 'other', installationId: randomUUID(), hostBindingDigest: 'a'.repeat(64) };
    const session = { ...p.session, machineId: machine.id, installationId: machine.installationId, hostBindingDigest: machine.hostBindingDigest, sessionId: randomUUID() };
    const transition = { kind: 'handoff' as const, machine, session, candidate: p.candidate, stopProof: p.stopProof, recovery: p.recovery };
    const request = { claim: p.claim, operationId: randomUUID(), transition };
    const commit = p.target.provider.commit, branch = p.target.provider.branch;
    let lost = false, sends = 0;
    p.target.provider.commit = async (...args) => { sends++; await commit(...args); lost = true; return { kind: 'ambiguous', reason: 'response lost' }; };
    p.target.provider.branch = async (...args) => { if (lost) throw Error('readback unavailable'); return branch(...args); };
    expect((await transitionSharedTask(request)).kind).toBe('ambiguous');
    lost = false;
    const current = await readCoordination(p.target), before = canonical(current);
    const retry = await transitionSharedTask(request);
    expect(retry.kind).toBe('owned');
    if (retry.kind !== 'owned') throw Error(retry.reason);
    expect(retry.claim.ownerToken).toBe(current.tasks[p.claim.taskKey]!.ownerToken);
    expect(retry.claim.generation).toBe(2);
    expect(sends).toBe(1);
    for (const bad of [
        { ...request, claim: { ...p.claim, ownerToken: randomUUID() } },
        { ...request, claim: retry.claim },
        { ...request, operationId: randomUUID() },
        { ...request, transition: { ...transition, session: { ...session, sessionId: randomUUID() } } },
        { ...request, transition: { ...transition, candidate: { ...p.candidate, scopeDigest: 'a'.repeat(64) } } },
    ]) expect((await transitionSharedTask(bad)).kind).toBe('refused');
    const verify = p.target.verifyCandidate;
    p.target.verifyCandidate = async () => { throw Error('current policy revoked'); };
    expect(await transitionSharedTask(request)).toMatchObject({ kind: 'refused', reason: 'current policy revoked' });
    p.target.verifyCandidate = verify;
    expect(canonical(await readCoordination(p.target))).toBe(before);
    expect(sends).toBe(1);
});


test('handoff history reads actual null-payload receipt and preserves both pinned owners', async () => {
    const f = await pendingEffectFixture('telemetry-push', 'ambiguous');
    expect((await transitionSharedTask({ claim: f.claim, operationId: randomUUID(), transition: { kind: 'stop', stopProof: f.stopProof } })).kind).toBe('owned');
    const predecessor = (await readCoordination(f.target)).tasks[f.claim.taskKey]!;
    const previousHead = (await f.target.provider.branch(f.target)).head;
    const machine = { ...f.machine, id: 'receiver', installationId: randomUUID(), hostBindingDigest: 'a'.repeat(64) };
    const session = { ...f.session, machineId: machine.id, installationId: machine.installationId, hostBindingDigest: machine.hostBindingDigest, sessionId: randomUUID() };
    const operationId = randomUUID();
    const transferred = await transitionSharedTask({ claim: f.claim, operationId, transition: { kind: 'handoff', machine, session, candidate: f.candidate, stopProof: f.stopProof, recovery: f.recovery } });
    if (transferred.kind !== 'owned') throw Error(transferred.reason);
    const handedOff = (await readCoordination(f.target)).tasks[f.claim.taskKey]!;
    const path = `coordination/operations/${operationId}.json`;
    const receiptHead = transferred.claim.stateCommit;
    const raw = f.versions.get(receiptHead)![path]!;
    const evidence = { kind: 'state-receipt' as const, operationId, commitSha: receiptHead, blobSha256: sha256(raw) };
    const { taskKey, runId, generation, ownerToken, machineId, installationId, sessionId } = f.claim;
    const input = { taskKey, expected: { taskKey, runId, generation, ownerToken, machineId, installationId, sessionId }, evidence };
    // Move latest state beyond the pinned handoff so neither returned record can be substituted.
    expect((await transitionSharedTask({ claim: transferred.claim, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('owned');
    let writes = 0;
    const commit = f.target.provider.commit;
    f.target.provider.commit = async (...args) => { writes++; return commit(...args); };
    expect(await inspectHandoffCoordinationTask(f.target, input)).toEqual({ kind: 'historical-handoff', receipt: JSON.parse(raw), predecessor, handedOff });
    expect(JSON.parse(raw)).toMatchObject({ type: 'handoff', previousHead, recoveryPayload: null });
    expect(predecessor.stopProof).toEqual(f.stopProof);
    expect(handedOff.recovery!.effects).toEqual(predecessor.recovery!.effects);
    await expect(resolveEvidence(f.target, evidence)).rejects.toThrow('payload mismatch');
    expect((await inspectHistoricalCoordinationTask(f.target, { ...input, at: 'previous-head' })).kind).toBe('invalid-or-unavailable');
    for (const bad of [
        { ...input, expected: { ...input.expected, ownerToken: handedOff.ownerToken } },
        { ...input, expected: { ...input.expected, runId: randomUUID() } },
        { ...input, evidence: { ...evidence, blobSha256: 'f'.repeat(64) } },
        { ...input, evidence: { ...evidence, operationId: randomUUID() } },
    ]) expect((await inspectHandoffCoordinationTask(f.target, bad)).kind).toBe('invalid-or-unavailable');
    // Rehash malformed receipts to exercise validation beyond the blob-integrity check.
    for (const patch of [
        { type: 'acquire' }, { operationId: randomUUID() }, { recoveryPayload: { schemaVersion: 2, kind: 'execution-qualification' } }, { previousHead: evidence.commitSha }, { previousHead: (await f.target.provider.branch(f.target)).head },
        { taskKey: 'f'.repeat(64) }, { generation: 3 },
        { resultOwner: { ...JSON.parse(raw).resultOwner, runId: randomUUID() } },
        { resultOwner: { ...JSON.parse(raw).resultOwner, ownerToken: randomUUID() } },
        { extra: true },
    ]) {
        const changed = canonical({ ...JSON.parse(raw), ...patch });
        f.versions.get(evidence.commitSha)![path] = changed;
        expect((await inspectHandoffCoordinationTask(f.target, { ...input, evidence: { ...evidence, blobSha256: sha256(changed) } })).kind).toBe('invalid-or-unavailable');
    }
    f.versions.get(evidence.commitSha)![path] = raw;
    const taskPath = `coordination/tasks/${taskKey}.json`;
    for (const head of [previousHead, evidence.commitSha]) {
        const saved = f.versions.get(head)![taskPath]!;
        for (const malformed of ['{}', canonical({ ...JSON.parse(saved), runId: randomUUID() }), ' '.repeat(256 * 1024 + 1)]) {
            f.versions.get(head)![taskPath] = malformed;
            expect((await inspectHandoffCoordinationTask(f.target, input)).kind).toBe('invalid-or-unavailable');
        }
        delete f.versions.get(head)![taskPath];
        expect((await inspectHandoffCoordinationTask(f.target, input)).kind).toBe('invalid-or-unavailable');
        f.versions.get(head)![taskPath] = saved;
    }
    const read = f.target.provider.read;
    f.target.provider.read = async () => { throw Error('offline'); };
    expect((await inspectHandoffCoordinationTask(f.target, input)).kind).toBe('invalid-or-unavailable');
    f.target.provider.read = read;
    expect((await inspectHandoffCoordinationTask({ ...f.target, rootCommit: 'e'.repeat(40) }, input)).kind).toBe('invalid-or-unavailable');
    const branch = f.target.provider.branch;
    f.target.provider.branch = async (...args) => ({ ...await branch(...args), private: false });
    expect((await inspectHandoffCoordinationTask(f.target, input)).kind).toBe('invalid-or-unavailable');
    f.target.provider.branch = async (...args) => ({ ...await branch(...args), repositoryId: 'R_other' });
    expect((await inspectHandoffCoordinationTask(f.target, input)).kind).toBe('invalid-or-unavailable');
    f.target.provider.branch = async (...args) => ({ ...await branch(...args), defaultBranch: f.target.branch });
    expect((await inspectHandoffCoordinationTask(f.target, input)).kind).toBe('invalid-or-unavailable');
    f.target.provider.branch = branch;
    f.rewrite();
    expect((await inspectHandoffCoordinationTask(f.target, input)).kind).toBe('invalid-or-unavailable');
    expect(writes).toBe(0);
});

test('same-machine new-session handoff verifies original stopped target before replacing ownership', async () => {
    const f = await pendingEffectFixture('telemetry-push', 'ambiguous');
    expect((await transitionSharedTask({ claim: f.claim, operationId: randomUUID(), transition: { kind: 'stop', stopProof: f.stopProof } })).kind).toBe('owned');
    const original = (await readCoordination(f.target)).tasks[f.claim.taskKey]!;
    const session = { ...f.session, sessionId: randomUUID() };
    let verifications = 0;
    f.target.verifySession = async (previous, machine, receiving) => {
        expect(previous.sessionId).toBe(f.session.sessionId);
        expect(previous.activeTaskKeys).toContain(f.claim.taskKey);
        expect(machine).toEqual(f.machine);
        expect(receiving.sessionId).toBe(session.sessionId);
        verifications++;
    };
    const result = await transitionSharedTask({ claim: f.claim, operationId: randomUUID(), transition: { kind: 'handoff', machine: f.machine, session, candidate: f.candidate, stopProof: f.stopProof, recovery: f.recovery } });
    expect(result).toMatchObject({ kind: 'owned' });
    if (result.kind !== 'owned') throw Error(result.reason);
    const current = await readCoordination(f.target), next = current.tasks[f.claim.taskKey]!;
    expect(verifications).toBe(1);
    expect(next).toMatchObject({ state: 'claimed', machineId: original.machineId, sessionId: session.sessionId, generation: 2, stopProof: original.stopProof });
    expect(next.ownerToken).not.toBe(original.ownerToken);
    expect(next.recovery!.effects).toEqual(original.recovery!.effects);
    expect(current.machines[f.machine.id]!.activeTaskKeys).toContain(f.claim.taskKey);
    expect((await transitionSharedTask({ claim: f.claim, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('refused');
});

test.each(['running', 'claimed', 'blocked', 'wrong-other-proof', 'wrong-target-proof', 'wrong-session', 'denied-session', 'missing-verifier'] as const)('same-machine new-session handoff refuses %s without changing old reservations', async mode => {
    const f = await pendingEffectFixture('telemetry-push');
    expect((await transitionSharedTask({ claim: f.claim, operationId: randomUUID(), transition: { kind: 'stop', stopProof: f.stopProof } })).kind).toBe('owned');
    if (['running', 'claimed', 'blocked', 'wrong-other-proof'].includes(mode)) {
        const acquired = await acquireSharedTask({ ...f, operationId: randomUUID(), candidate: { ...f.candidate, issue: 138, issueNodeId: 'I_138', runId: randomUUID(), paths: ['src/other'] } });
        if (acquired.kind !== 'owned') throw Error(acquired.reason);
        if (mode === 'running')
            expect((await transitionSharedTask({ claim: acquired.claim, operationId: randomUUID(), transition: { kind: 'start' } })).kind).toBe('owned');
        if (mode === 'blocked')
            expect((await transitionSharedTask({ claim: acquired.claim, operationId: randomUUID(), transition: { kind: 'block', stopProof: null } })).kind).toBe('owned');
        if (mode === 'wrong-other-proof') {
            const proof = { ...f.stopProof, runIds: [acquired.claim.runId] };
            expect((await transitionSharedTask({ claim: acquired.claim, operationId: randomUUID(), transition: { kind: 'stop', stopProof: proof } })).kind).toBe('owned');
            const snapshot = await readCoordination(f.target), task = snapshot.tasks[acquired.claim.taskKey]!;
            task.stopProof = { ...proof, sessionId: randomUUID() };
            await f.target.provider.commit(f.target, { branchId: snapshot.branchId, expectedHeadOid: snapshot.head, files: { [`coordination/tasks/${task.taskKey}.json`]: canonical(task) }, operationId: randomUUID() });
        }
    }
    const before = await readCoordination(f.target), session = { ...f.session, sessionId: randomUUID() };
    if (mode === 'wrong-session') session.installationId = randomUUID();
    if (mode !== 'missing-verifier') f.target.verifySession = async () => { if (mode === 'denied-session') throw Error('session authority denied'); };
    let commits = 0;
    const commit = f.target.provider.commit;
    f.target.provider.commit = async (...args) => { commits++; return commit(...args); };
    const result = await transitionSharedTask({ claim: f.claim, operationId: randomUUID(), transition: { kind: 'handoff', machine: f.machine, session, candidate: f.candidate, stopProof: mode === 'wrong-target-proof' ? { ...f.stopProof, sessionId: randomUUID() } : f.stopProof, recovery: f.recovery } });
    expect(result.kind).toBe(mode === 'missing-verifier' ? 'busy' : 'refused');
    expect(commits).toBe(0);
    expect(await readCoordination(f.target)).toEqual(before);
});


// Provider history is independent metadata, captured before fault injection.
function statusHistory(f: Pick<Awaited<ReturnType<typeof fixture>>, 'target' | 'versions'>, pageSize = 25) {
    const build = () => { const versions = [...f.versions.entries()]; return versions.map(([oid, files], i) => {
        const previous = versions[i - 1];
        const path = Object.keys(files).find(p => p.startsWith('coordination/operations/') && !previous?.[1][p]);
        return { oid, parents: previous ? [previous[0]] : [], headline: path ? 'factory coordination ' + path.slice('coordination/operations/'.length, -5) : 'initial state', committedAt: new Date(Date.UTC(2026, 8, 8, 12, i)).toISOString() };
    }).reverse(); };
    const commits = build();
    f.target.provider.history = async (_t, head, cursor, first) => {
        const current = head === commits[0]!.oid ? commits : build();
        const offset = current.findIndex(commit => commit.oid === head);
        expect(offset).toBeGreaterThanOrEqual(0);
        const scoped = current.slice(offset);
        const start = Number(cursor ?? 0), size = Math.min(first, pageSize);
        return { commits: scoped.slice(start, start + size), nextCursor: start + size < scoped.length ? String(start + size) : null };
    };
    return commits;
}

test('status projects current owner/checkpoint without claiming availability, origin or liveness and performs no writes', async () => {
    const f = await pendingEffectFixture('telemetry-push');
    const snapshot = await readCoordination(f.target), current = snapshot.tasks[f.claim.taskKey]!;
    const directory = await mkdtemp(join(tmpdir(), 'vf-status-readonly-'));
    const target = { ...f.target, localRoot: directory };
    target.provider.commit = async () => { throw Error('status attempted a write'); };
    const status = await readSharedStatus(target, ['acme/app']);
    expect(status).toMatchObject({ head: snapshot.head, refusal: null, history: { coverage: 'unsupported', archiveCoverage: 'active-only' } });
    expect(status.tasks).toHaveLength(1);
    expect(status.tasks[0]).toMatchObject({ machineId: f.machine.id, generation: 1, sourceCommit: snapshot.head, originMachineId: null, lastTransitionObservedAt: null,
        checkpoint: { headSha: current.checkpoint!.headSha, publishedAt: current.checkpoint!.publishedAt, sourceCommit: snapshot.head, availability: 'unknown' }, history: { coverage: 'unsupported', events: [] } });
    expect(await readdir(directory)).toEqual([]);
    const serialized = JSON.stringify(status);
    for (const privateValue of [current.ownerToken, current.installationId, current.sessionId, f.target.localRoot, 'accountRef', 'recoveryPayload', 'evidenceRef', 'hostBindingDigest', 'ownerToken', 'operations/'])
        expect(serialized).not.toContain(privateValue);
});

test('status pins the exact task transition independently of another task machine observation', async () => {
    const f = await fixture();
    const first = await acquireSharedTask({ ...f, operationId: randomUUID() });
    if (first.kind !== 'owned') throw Error('claim');
    const firstHead = first.claim.stateCommit;
    expect((await acquireSharedTask({ ...f, candidate: { ...f.candidate, issue: 138, issueNodeId: 'I_138', runId: randomUUID(), paths: ['src/b'] }, operationId: randomUUID() })).kind).toBe('owned');
    const commits = statusHistory(f);
    const current = await readSharedStatus(f.target, ['acme/app']);
    const row = current.tasks.find(t => t.issue === 137)!;
    expect(row.history.coverage).toBe('complete');
    expect(row.originMachineId).toBe(f.machine.id);
    expect(row.lastTransitionObservedAt).toBe(commits.find(c => c.oid === firstHead)!.committedAt);
    expect(row.lastTransitionObservedAt).not.toBe(commits[0]!.committedAt);
    expect(row.history.events).toEqual([{ kind: 'acquire', generation: 1, machineId: f.machine.id, previousMachineId: null, sourceCommit: firstHead, observedAt: row.lastTransitionObservedAt }]);
    expect(current.history!.archiveCoverage).toBe('partial');
});

test('status verifies A to B to C as one task, but a bounded suffix cannot establish origin', async () => {
    const f = await pendingEffectFixture('telemetry-push');
    let claim = f.claim, recovery = f.recovery, proof = f.stopProof;
    for (const [id, host] of [['machine-b', 'b'], ['machine-c', 'c']] as const) {
        const machine = { ...f.machine, id, installationId: randomUUID(), hostBindingDigest: host.repeat(64) };
        const session = { ...f.session, machineId: id, installationId: machine.installationId, hostBindingDigest: machine.hostBindingDigest, sessionId: randomUUID() };
        const result = await transitionSharedTask({ claim, operationId: randomUUID(), transition: { kind: 'handoff', machine, session, candidate: f.candidate, stopProof: proof, recovery } });
        if (result.kind !== 'owned') throw Error(result.reason);
        claim = result.claim;
        recovery = (await readCoordination(f.target)).tasks[claim.taskKey]!.recovery!;
        proof = { ...proof, machineId: id, installationId: machine.installationId, sessionId: session.sessionId, hostBindingDigest: machine.hostBindingDigest, generation: claim.generation };
    }
    statusHistory(f);
    const full = await readSharedStatus(f.target, ['acme/app']);
    expect(full.tasks).toHaveLength(1);
    expect(full.tasks[0]).toMatchObject({ machineId: 'machine-c', generation: 3, originMachineId: 'mac-one', history: { coverage: 'complete' } });
    expect(full.tasks[0]!.history.events.filter(e => e.kind === 'handoff').map(e => [e.previousMachineId, e.machineId])).toEqual([['machine-b', 'machine-c'], ['mac-one', 'machine-b']]);
    statusHistory(f, 1);
    const partial = await readSharedStatus(f.target, ['acme/app']);
    expect(partial.tasks[0]).toMatchObject({ machineId: 'machine-c', originMachineId: null, history: { coverage: 'bounded' } });
    expect(partial.tasks[0]!.history.events.filter(e => e.kind === 'handoff')).toHaveLength(2);
});

test.each(['missing', 'edited', 'foreign-owner', 'wrong-parent', 'reused-receipt', 'unknown-operation', 'noncontiguous', 'merge'] as const)('status refuses %s history evidence while preserving verified current state', async mode => {
    const f = await fixture(), operationId = randomUUID();
    const acquired = await acquireSharedTask({ ...f, operationId });
    if (acquired.kind !== 'owned') throw Error('claim');
    const started = await transitionSharedTask({ claim: acquired.claim, operationId: randomUUID(), transition: { kind: 'start' } });
    if (started.kind !== 'owned') throw Error('start');
    const commits = statusHistory(f), operationPath = 'coordination/operations/' + operationId + '.json';
    const raw = f.versions.get(acquired.claim.stateCommit)![operationPath]!;
    if (mode === 'missing') delete f.versions.get(acquired.claim.stateCommit)![operationPath];
    if (mode === 'edited') f.versions.get(f.head)![operationPath] = canonical({ ...JSON.parse(raw), requestDigest: 'e'.repeat(64) });
    if (mode === 'foreign-owner') {
        const value = JSON.parse(raw); value.resultOwner.machineId = 'foreign';
        f.versions.get(acquired.claim.stateCommit)![operationPath] = f.versions.get(f.head)![operationPath] = canonical(value);
    }
    if (mode === 'wrong-parent') {
        const value = JSON.parse(raw); value.previousHead = started.claim.stateCommit;
        f.versions.get(acquired.claim.stateCommit)![operationPath] = f.versions.get(f.head)![operationPath] = canonical(value);
    }
    if (mode === 'reused-receipt') f.versions.get(root)![operationPath] = raw;
    if (mode === 'unknown-operation') commits[0]!.headline = 'not a typed operation';
    if (mode === 'noncontiguous') commits[1]!.oid = 'f'.repeat(40);
    if (mode === 'merge') commits[0]!.parents.push(root);
    const status = await readSharedStatus(f.target, ['acme/app']);
    expect(status.refusal).toBeNull();
    expect(status.tasks[0]).toMatchObject({ state: 'running', machineId: 'mac-one', originMachineId: null, history: { coverage: 'unavailable' } });
    expect(status.tasks[0]!.history.events.some(e => e.kind === 'acquire')).toBe(false);
});

test('status history omits foreign repositories and source errors never leak provider messages', async () => {
    const f = await fixture();
    f.machine.allowedRepositories.push('acme/foreign'); f.machine.repositoryIds['acme/foreign'] = 'R_foreign';
    expect((await acquireSharedTask({ ...f, operationId: randomUUID() })).kind).toBe('owned');
    expect((await acquireSharedTask({ ...f, candidate: { ...f.candidate, repo: 'acme/foreign', repositoryNodeId: 'R_foreign', issueNodeId: 'I_foreign', paths: ['src/b'], runId: randomUUID() }, operationId: randomUUID() })).kind).toBe('owned');
    statusHistory(f);
    const scoped = await readSharedStatus(f.target, ['acme/app']);
    expect(scoped.tasks).toHaveLength(1);
    expect(JSON.stringify(scoped)).not.toContain('acme/foreign');
    expect(await readSharedStatus(f.target, [])).toMatchObject({ tasks: [], refusal: null });
    f.target.provider.branch = async () => { throw Error('sensitive provider credential and local path'); };
    expect(await readSharedStatus(f.target, ['acme/app'])).toEqual({ head: null, tasks: [], refusal: 'coordination-status-unavailable' });
});

test.each(['unavailable', 'oversized', 'repeated-cursor', 'short-page'] as const)('status preserves current data with explicit %s history disposition', async mode => {
    const f = await fixture();
    expect((await acquireSharedTask({ ...f, operationId: randomUUID() })).kind).toBe('owned');
    const commits = statusHistory(f);
    f.target.provider.history = async () => {
        if (mode === 'unavailable') throw Error('private path');
        if (mode === 'oversized') return { commits: [{ ...commits[0]!, headline: 'x'.repeat(65536) }], nextCursor: null };
        return { commits: [commits[0]!], nextCursor: mode === 'repeated-cursor' ? 'same' : null };
    };
    const result = await readSharedStatus(f.target, ['acme/app']);
    expect(result.tasks[0]).toMatchObject({ state: 'claimed', originMachineId: null, history: { coverage: mode === 'oversized' ? 'bounded' : 'unavailable' } });
    expect(result.refusal).toBeNull();
});

test('GitHub status history adapter uses an immutable head, bounded pagination and checked repository/commit identities', async () => {
    const f = await fixture(); let request: any;
    const provider = githubCoordinationProvider(async (_args, options) => {
        request = JSON.parse(options!.input!);
        return JSON.stringify({ data: { repository: { id: 'R_state', object: { oid: root, history: {
            nodes: [{ oid: root, messageHeadline: 'initial state', committedDate: '2026-09-08T12:00:00Z', parents: { nodes: [], pageInfo: { hasNextPage: false } } }],
            pageInfo: { hasNextPage: true, endCursor: 'next-page' },
        } } } } });
    });
    expect(await provider.history!(f.target, root, null, 25)).toEqual({ commits: [{ oid: root, parents: [], headline: 'initial state', committedAt: '2026-09-08T12:00:00Z' }], nextCursor: 'next-page' });
    expect(request.variables).toMatchObject({ head: root, cursor: null, first: 25 });
    expect(request.query).toContain('object(oid:$head)');
    await expect(provider.history!(f.target, root, null, 26)).rejects.toThrow();
    await expect(provider.history!({ ...f.target, repositoryId: 'R_foreign' }, root, null, 25)).rejects.toThrow('identity');
});


test('status keeps one immutable source head when the live branch later advances', async () => {
    const f = await fixture();
    const acquired = await acquireSharedTask({ ...f, operationId: randomUUID() });
    if (acquired.kind !== 'owned') throw Error('claim');
    const commits = statusHistory(f), original = f.target.provider.branch;
    let branchReads = 0;
    f.target.provider.branch = async t => { branchReads++; return branchReads === 1 ? original(t) : { ...await original(t), head: 'f'.repeat(40) }; };
    const result = await readSharedStatus(f.target, ['acme/app']);
    expect(result).toMatchObject({ head: acquired.claim.stateCommit, refusal: null });
    expect(result.tasks[0]!.history.events[0]!.sourceCommit).toBe(commits[0]!.oid);
    expect(result.tasks[0]!.history.coverage).toBe('complete');
    expect(branchReads).toBe(1);
});

test.each(['privacy', 'installation', 'rollback'] as const)('status refuses current %s corruption without returning private source details', async mode => {
    const f = await fixture();
    expect((await acquireSharedTask({ ...f, operationId: randomUUID() })).kind).toBe('owned');
    if (mode === 'privacy') { const branch = f.target.provider.branch; f.target.provider.branch = async t => ({ ...await branch(t), private: false }); }
    if (mode === 'installation') { const index = JSON.parse(f.versions.get(f.head)!['coordination/index.json']!); index.installationId = randomUUID(); f.versions.get(f.head)!['coordination/index.json'] = canonical(index); }
    if (mode === 'rollback') f.rewrite();
    expect(await readSharedStatus(f.target, ['acme/app'])).toEqual({ head: null, tasks: [], refusal: 'coordination-status-unavailable' });
});

test.each(['requests', 'bytes', 'time'] as const)('status enforces the aggregate %s budget and keeps already verified current fields', async mode => {
    const f = await fixture();
    const candidate = mode === 'bytes' ? { ...f.candidate, approvedTaskIds: Array.from({ length: 1800 }, (_, i) => 'task-' + i + '-' + 'x'.repeat(100)) } : f.candidate;
    const acquired = await acquireSharedTask({ ...f, candidate, operationId: randomUUID() });
    if (acquired.kind !== 'owned') throw Error(acquired.reason);
    for (let i = 0; i < (mode === 'time' ? 1 : 32); i++)
        expect((await transitionSharedTask({ claim: acquired.claim, operationId: randomUUID(), transition: { kind: 'block', stopProof: null } })).kind).toBe('owned');
    statusHistory(f);
    let calls = 0;
    for (const name of ['branch', 'read', 'compare', 'history'] as const) {
        const original = f.target.provider[name]!;
        (f.target.provider as any)[name] = (...args: any[]) => { calls++; return (original as any)(...args); };
    }
    const originalNow = Date.now;
    let shift = 0;
    try {
        if (mode === 'time') {
            Date.now = () => originalNow() + shift;
            const original = f.target.provider.history!;
            f.target.provider.history = async (...args) => { const result = await original(...args); shift = 10001; return result; };
        }
        const result = await readSharedStatus(f.target, ['acme/app']);
        expect(result).toMatchObject({ refusal: null, tasks: [{ state: 'blocked', machineId: 'mac-one', originMachineId: null, history: { coverage: 'bounded' } }] });
        expect(calls).toBeLessThanOrEqual(256);
        if (mode === 'requests') expect(calls).toBe(256);
    } finally { Date.now = originalNow; }
});


test('status refuses a structurally valid checkpoint bound to another task', async () => {
    const f = await pendingEffectFixture('telemetry-push');
    const head = (await f.target.provider.branch(f.target)).head, path = 'coordination/tasks/' + f.claim.taskKey + '.json';
    const task = JSON.parse(f.versions.get(head)![path]!);
    task.checkpoint.runId = randomUUID();
    f.versions.get(head)![path] = canonical(task);
    expect(await readSharedStatus(f.target, ['acme/app'])).toEqual({ head: null, tasks: [], refusal: 'coordination-status-unavailable' });
});


test('status does not treat a handoff with a foreign stopped owner as verified history', async () => {
    const f = await pendingEffectFixture('telemetry-push');
    const machine = { ...f.machine, id: 'receiver', installationId: randomUUID(), hostBindingDigest: 'b'.repeat(64) };
    const session = { ...f.session, machineId: machine.id, installationId: machine.installationId, hostBindingDigest: machine.hostBindingDigest, sessionId: randomUUID() };
    const handedOff = await transitionSharedTask({ claim: f.claim, operationId: randomUUID(), transition: { kind: 'handoff', machine, session, candidate: f.candidate, stopProof: f.stopProof, recovery: f.recovery } });
    if (handedOff.kind !== 'owned') throw Error(handedOff.reason);
    statusHistory(f);
    const path = 'coordination/tasks/' + f.claim.taskKey + '.json', files = f.versions.get(handedOff.claim.stateCommit)!;
    const task = JSON.parse(files[path]!); task.stopProof.machineId = 'foreign'; files[path] = canonical(task);
    const result = await readSharedStatus(f.target, ['acme/app']);
    expect(result.tasks[0]).toMatchObject({ machineId: 'receiver', generation: 2, originMachineId: null, history: { coverage: 'unavailable', events: [] } });
});
