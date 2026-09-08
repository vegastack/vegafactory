import { test, expect } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { processIdentity } from '../src/claims.ts';
import { acquireSharedTask, transitionSharedTask, readCoordination, readSharedStatus, taskKey, parseRecoveryEnvelope, parseRecoveryPayload, publishRecoveryReceipt, resolveEvidence, beginManagedEffect, verifyManagedEffect, canonical, sha256, githubCoordinationProvider, type CoordinationTarget, type CoordinationProvider, type VerifiedCandidate, type EffectiveMachine, type MachineSession, type RecoveryEvidencePayload, type RecoveryEnvelope } from '../src/shared-claims.ts';
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
    let request: Record<string, unknown> | null = null;
    const f = await fixture(), p = githubCoordinationProvider(async (_args, options) => { request = JSON.parse(options!.input!); return JSON.stringify({ errors: [{ type: 'STALE_DATA' }] }); });
    const result = await p.commit(f.target, { branchId: 'REF_state', expectedHeadOid: root, files: { 'coordination/index.json': '{}' }, operationId: randomUUID() });
    expect(result.kind).toBe('conflict');
    expect((request as any).variables.input.expectedHeadOid).toBe(root);
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
 expect(results.filter(x=>x.kind==='owned')).toHaveLength(1)
 const current=await readCoordination(f.target),task=current.tasks[owned.claim.taskKey]!
 expect(task.generation).toBe(2);expect(task.recovery?.generation).toBe(2);expect(task.recovery?.execution).toEqual(recovery.execution)
 expect((await transitionSharedTask({claim:q.claim,operationId:randomUUID(),transition:{kind:'start'}})).kind).toBe('refused')
})

test('operation path injection refuses before local intent or remote mutation', async()=>{
 const f=await fixture();expect((await acquireSharedTask({...f,operationId:'../../escape'})).kind).toBe('refused');expect(f.mutations).toBe(0)
})
