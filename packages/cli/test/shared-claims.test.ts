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

async function parentFixture() {
    const f = await fixture();
    const parent = await acquireSharedTask({ ...f, candidate: { ...f.candidate, independent: false, paths: [] }, operationId: randomUUID() });
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
    return { ...f, f, parent: parent.claim, child };
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
    const complete = await transitionSharedTask({ claim: p.claim, operationId: randomUUID(), transition: { kind: 'complete', stopProof: p.stopProof, acceptedScope: accepted.reference } });
    expect(complete.kind).toBe('owned');
    if (complete.kind !== 'owned') throw Error('completion');
    const raw = await p.target.provider.read(p.target, complete.claim.stateCommit, 'coordination/tasks/' + p.claim.taskKey + '.json');
    expect(JSON.parse(raw!).recovery.effects).toEqual(p.recovery.effects);
    expect(JSON.parse(raw!).state).toBe('completed');
    expect((await readCoordination(p.target)).index.active).toEqual([]);
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
