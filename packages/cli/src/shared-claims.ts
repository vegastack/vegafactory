// Q45 shared ownership: controller-derived paths, immutable reads and conditional commits.
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, open, readFile, rename, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { GhUnavailable, ghText, type GhOptions } from './gh.ts';
import { acquireClaim, releaseClaim, processIdentity, type Claim, type ProcessIdentity } from './claims.ts';
export type CheckpointRef = {
    schemaVersion: 1;
    id: string;
    repo: string;
    repositoryId: string;
    branch: string;
    baseSha: string;
    headSha: string;
    treeSha: string;
    scopeDigest: string;
    runId: string;
    publishedAt: string;
};
export type StopProof = {
    kind: 'process-exit' | 'verified-reboot' | 'operator-confirmed';
    machineId: string;
    installationId: string;
    sessionId: string;
    hostBindingDigest: string;
    bootIdDigest: string;
    runIds: string[];
    generation: number;
    observedAt: string;
    evidenceRef: EvidenceRef;
};
export type ArtifactRef = {
    repo: string;
    issue: number;
    kind: 'brief' | 'plan';
    artifactId: string;
    rev: number;
    digest: string;
};
export type AcceptedScopeSnapshot = {
    schemaVersion: 2;
    repo: string;
    issue: number;
    artifacts: ArtifactRef[];
    approvalBindings: ApprovalAuthorityRef[];
    approvedTaskIds: string[];
    completedTaskIds: string[];
    parentRepo: string;
    parentIssue: number;
    parentBefore: string;
    parentAfter: string;
    acceptedAt: string;
};
export type EvidenceRef = {
    kind: "state-receipt";
    operationId: string;
    commitSha: string;
    blobSha256: string;
} | {
    kind: "github-comment";
    repositoryId: string;
    issueNodeId: string;
    commentId: string;
    bodySha256: string;
};
export type ApprovalAuthorityRef = {
    approvalId: string;
    source: Extract<EvidenceRef, {
        kind: "github-comment";
    }>;
};
export type ExecutionIdentity = {
    providerMode: "subscription";
    harness: "claude" | "codex";
    harnessVersion: string;
    model: string;
    effort: string;
    accountRef: string;
    qualification: EvidenceRef;
};
export type AcceptanceRef = {
    sourceSha: string;
    validationId: string;
    commandDigest: string;
    evidence: EvidenceRef;
};
export type EffectTarget = {
    kind: "source-ref";
    repositoryId: string;
    branch: string;
    headSha: string;
} | {
    kind: "issue-comment";
    repositoryId: string;
    issueNodeId: string;
    commentId: string | null;
    markerId: string;
} | {
    kind: "telemetry";
    destinationRepositoryId: string;
    destinationPath: string;
    eventId: string;
    batchId: string;
};
export type EffectRef = {
    operationId: string;
    runId: string;
    generation: number;
    kind: "checkpoint-push" | "handback" | "evidence" | "telemetry-push";
    target: EffectTarget;
    payloadDigest: string;
    state: "prepared" | "ambiguous" | "acknowledged" | "cancelled-before-send";
    intent: EvidenceRef;
    outcome: EvidenceRef | null;
};
export type ChildAcceptance = {
    childTaskKey: string;
    childRunId: string;
    generation: number;
    baseSha: string;
    headSha: string;
    scopeDigest: string;
    machineId: string;
    installationId: string;
    sessionId: string;
    terminationCause: "succeeded";
    noChange: boolean;
    checkpoint: CheckpointRef;
    acceptance: AcceptanceRef;
};
export type JoinRef = {
    operationId: string;
    childRunId: string;
    generation: number;
    fromSha: string;
    parentBefore: string;
    parentAfter: string | null;
    state: "prepared" | "accepted" | "refused";
    acceptance: AcceptanceRef | null;
    evidence: EvidenceRef;
};
export type RecoveryEnvelope = {
    schemaVersion: 2;
    taskKey: string;
    runId: string;
    generation: number;
    approvalBindings: ApprovalAuthorityRef[];
    recordBinding: ApprovalAuthorityRef | null;
    scopeDigest: string;
    approvalDigest: string;
    execution: ExecutionIdentity;
    checkpoint: CheckpointRef | null;
    completed: Array<{
        taskId: string;
        headSha: string;
        acceptance: AcceptanceRef;
    }>;
    children: ChildAcceptance[];
    joins: JoinRef[];
    effects: EffectRef[];
    remoteEffectCoverage: {
        kind: "qualified-managed-only";
        qualification: EvidenceRef;
    } | {
        kind: "unmanaged-possible";
        reasonCode: string;
    } | {
        kind: "reconciled";
        evidence: EvidenceRef;
    };
};
export type RecoveryEvidencePayload = {
    schemaVersion: 2;
    kind: "execution-qualification";
    harness: "claude" | "codex";
    harnessVersion: string;
    model: string;
    effort: string;
    accountRef: string;
    configurationDigest: string;
    candidateSha: string;
    validationIds: string[];
    managedKinds: Array<EffectRef["kind"]>;
    unmanagedDenied: boolean;
    result: "qualified" | "unqualified";
} | {
    schemaVersion: 2;
    kind: "acceptance";
    taskId: string;
    runId: string;
    sourceSha: string;
    scopeDigest: string;
    validationId: string;
    commandDigest: string;
    result: "passed" | "failed";
    acceptedScope: AcceptedScopeSnapshot | null;
} | {
    schemaVersion: 2;
    kind: "join";
    childRunId: string;
    generation: number;
    fromSha: string;
    parentBefore: string;
    parentAfter: string | null;
    state: "prepared" | "accepted" | "refused";
    validationId: string | null;
    commandDigest: string | null;
    result: "passed" | "failed" | null;
} | {
    schemaVersion: 2;
    kind: "effect-intent" | "effect-outcome";
    effectId: string;
    runId: string;
    generation: number;
    approvalBindings: ApprovalAuthorityRef[];
    effectKind: EffectRef["kind"];
    target: EffectTarget;
    payloadDigest: string;
    result: "prepared" | "ambiguous" | "acknowledged" | "cancelled-before-send";
    observedRemoteId: string | null;
    observedDigest: string | null;
    reasonCode: string | null;
} | {
    schemaVersion: 2;
    kind: "effect-reconciliation";
    runId: string;
    scopeDigest: string;
    approvalBindings: ApprovalAuthorityRef[];
    allowedActionIds: string[];
    checkedEffectIds: string[];
    inspector: {
        kind: "qualified-adapter" | "authorized-operator";
        identityRef: string;
    };
    result: "complete" | "unresolved";
    reasonCode: string | null;
};
const transactionClock = new AsyncLocalStorage<{ deadline: number; decodedBytes: number }>();
function requestTimeout(): number { return Math.max(1, Math.min(10000, (transactionClock.getStore()?.deadline ?? Date.now() + 10000) - Date.now())); }
async function bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('coordination request/transaction window exhausted')), requestTimeout()); })]);
    }
    finally {
        clearTimeout(timer);
    }
}
// Closed structural readers are also used by downstream producers before publication.
type Check = (value: unknown) => boolean;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f]/.test(v);
const pattern = (re: RegExp): Check => v => typeof v === 'string' && re.test(v);
const digest = pattern(/^[a-f0-9]{64}$/), sha = pattern(/^[a-f0-9]{40}$/), id = pattern(/^[A-Za-z0-9_-]{1,128}$/);
const node = pattern(/^[A-Za-z0-9_=-]{3,200}$/), uuid = pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
const positive: Check = v => Number.isSafeInteger(v) && Number(v) > 0;
const integer: Check = v => Number.isSafeInteger(v) && Number(v) >= 0;
const boolean: Check = v => typeof v === 'boolean';
const date: Check = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
const repo = pattern(/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i);
const branch: Check = v => text(v) && !v.startsWith('-') && !v.startsWith('/') && !v.endsWith('/') && !/[\s~^:?*\[\\]/.test(v) && !v.includes('..') && !v.includes('@{') && v.split('/').every(p => p && !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock'));
const relative: Check = v => text(v) && !v.startsWith('/') && !v.includes('\\') && v.split('/').every(p => p && p !== '.' && p !== '..');
const resource = pattern(/^[a-z0-9][a-z0-9._:/-]{0,127}$/);
const literal = (...values: unknown[]): Check => v => values.includes(v);
const nullable = (check: Check): Check => v => v === null || check(v);
const array = (check: Check): Check => v => Array.isArray(v) && v.length <= 4096 && v.every(check);
const unique = (check: Check): Check => v => array(check)(v) && new Set((v as unknown[]).map(canonical)).size === (v as unknown[]).length;
const closed = (fields: Record<string, Check>): Check => v => object(v) && Object.keys(v).length === Object.keys(fields).length && Object.entries(fields).every(([k, c]) => Object.hasOwn(v, k) && c(v[k]));
const union = (...checks: Check[]): Check => v => checks.some(c => c(v));
export function canonical(v: unknown): string { if (Array.isArray(v))
    return '[' + v.map(canonical).join(',') + ']'; if (object(v))
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'; return JSON.stringify(v); }
export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const stateEvidence = closed({ kind: literal('state-receipt'), operationId: uuid, commitSha: sha, blobSha256: digest });
const githubEvidence = closed({ kind: literal('github-comment'), repositoryId: node, issueNodeId: node, commentId: pattern(/^[1-9]\d{0,19}$/), bodySha256: digest });
const evidence = union(stateEvidence, githubEvidence);
const authority = closed({ approvalId: id, source: githubEvidence });
const authorities = unique(authority);
const checkpoint = closed({ schemaVersion: literal(1), id: uuid, repo, repositoryId: node, branch, baseSha: sha, headSha: sha, treeSha: sha, scopeDigest: digest, runId: uuid, publishedAt: date });
const stopProof = closed({ kind: literal('process-exit', 'verified-reboot', 'operator-confirmed'), machineId: id, installationId: uuid, sessionId: uuid, hostBindingDigest: digest, bootIdDigest: digest, runIds: unique(uuid), generation: positive, observedAt: date, evidenceRef: evidence });
const execution = closed({ providerMode: literal('subscription'), harness: literal('claude', 'codex'), harnessVersion: text, model: text, effort: text, accountRef: id, qualification: evidence });
const validation = pattern(/^[A-Za-z0-9_-]+\/check\/[a-f0-9]{64}$/);
const acceptance = closed({ sourceSha: sha, validationId: validation, commandDigest: digest, evidence });
const effectKinds = ['checkpoint-push', 'handback', 'evidence', 'telemetry-push'] as const;
const target = union(closed({ kind: literal('source-ref'), repositoryId: node, branch, headSha: sha }), closed({ kind: literal('issue-comment'), repositoryId: node, issueNodeId: node, commentId: nullable(pattern(/^[1-9]\d{0,19}$/)), markerId: id }), closed({ kind: literal('telemetry'), destinationRepositoryId: node, destinationPath: relative, eventId: uuid, batchId: uuid }));
const effect = closed({ operationId: uuid, runId: uuid, generation: positive, kind: literal(...effectKinds), target, payloadDigest: digest, state: literal('prepared', 'ambiguous', 'acknowledged', 'cancelled-before-send'), intent: evidence, outcome: nullable(evidence) });
const child = closed({ childTaskKey: digest, childRunId: uuid, generation: positive, baseSha: sha, headSha: sha, scopeDigest: digest, machineId: id, installationId: uuid, sessionId: uuid, terminationCause: literal('succeeded'), noChange: boolean, checkpoint, acceptance });
const joinRef = closed({ operationId: uuid, childRunId: uuid, generation: positive, fromSha: sha, parentBefore: sha, parentAfter: nullable(sha), state: literal('prepared', 'accepted', 'refused'), acceptance: nullable(acceptance), evidence });
const artifact = closed({ repo, issue: positive, kind: literal('brief', 'plan'), artifactId: node, rev: positive, digest });
const acceptedScope = closed({ schemaVersion: literal(2), repo, issue: positive, artifacts: unique(artifact), approvalBindings: authorities, approvedTaskIds: unique(id), completedTaskIds: unique(id), parentRepo: repo, parentIssue: positive, parentBefore: sha, parentAfter: sha, acceptedAt: date });
const coverage = union(closed({ kind: literal('qualified-managed-only'), qualification: evidence }), closed({ kind: literal('unmanaged-possible'), reasonCode: id }), closed({ kind: literal('reconciled'), evidence }));
const envelope = closed({ schemaVersion: literal(2), taskKey: digest, runId: uuid, generation: positive, approvalBindings: authorities, recordBinding: nullable(authority), scopeDigest: digest, approvalDigest: digest, execution, checkpoint: nullable(checkpoint), completed: unique(closed({ taskId: id, headSha: sha, acceptance })), children: unique(child), joins: unique(joinRef), effects: unique(effect), remoteEffectCoverage: coverage });
const effectPayload = { schemaVersion: literal(2), kind: literal('effect-intent', 'effect-outcome'), effectId: uuid, runId: uuid, generation: positive, approvalBindings: authorities, effectKind: literal(...effectKinds), target, payloadDigest: digest, result: literal('prepared', 'ambiguous', 'acknowledged', 'cancelled-before-send'), observedRemoteId: nullable(text), observedDigest: nullable(digest), reasonCode: nullable(id) };
const payload = union(closed({ schemaVersion: literal(2), kind: literal('execution-qualification'), harness: literal('claude', 'codex'), harnessVersion: text, model: text, effort: text, accountRef: id, configurationDigest: digest, candidateSha: sha, validationIds: unique(validation), managedKinds: unique(literal(...effectKinds)), unmanagedDenied: boolean, result: literal('qualified', 'unqualified') }), closed({ schemaVersion: literal(2), kind: literal('acceptance'), taskId: id, runId: uuid, sourceSha: sha, scopeDigest: digest, validationId: validation, commandDigest: digest, result: literal('passed', 'failed'), acceptedScope: nullable(acceptedScope) }), closed({ schemaVersion: literal(2), kind: literal('join'), childRunId: uuid, generation: positive, fromSha: sha, parentBefore: sha, parentAfter: nullable(sha), state: literal('prepared', 'accepted', 'refused'), validationId: nullable(validation), commandDigest: nullable(digest), result: nullable(literal('passed', 'failed')) }), closed(effectPayload), closed({ schemaVersion: literal(2), kind: literal('effect-reconciliation'), runId: uuid, scopeDigest: digest, approvalBindings: authorities, allowedActionIds: unique(id), checkedEffectIds: unique(uuid), inspector: closed({ kind: literal('qualified-adapter', 'authorized-operator'), identityRef: id }), result: literal('complete', 'unresolved'), reasonCode: nullable(id) }));
function parse<T>(value: unknown, check: Check, name: string, max = 256 * 1024): T {
    let bytes: number;
    try {
        bytes = Buffer.byteLength(JSON.stringify(value));
    }
    catch {
        throw new Error(`${name}: recursive or unserializable payload`);
    }
    if (bytes > max || !check(value))
        throw new Error(`${name}: unsupported, oversized or invalid closed schema`);
    return structuredClone(value) as T;
}
export function parseCheckpointRef(v: unknown): CheckpointRef { return parse(v, checkpoint, 'checkpoint'); }
export function parseStopProof(v: unknown): StopProof { return parse(v, stopProof, 'stop proof'); }
export function parseEvidenceRef(v: unknown): EvidenceRef { return parse(v, evidence, 'evidence'); }
export function parseAcceptedScope(v: unknown): AcceptedScopeSnapshot {
    const s = parse<AcceptedScopeSnapshot>(v, acceptedScope, 'accepted scope');
    if (!s.approvedTaskIds.length || !s.approvalBindings.length || !s.artifacts.length || s.completedTaskIds.some(t => !s.approvedTaskIds.includes(t)) || s.artifacts.some(a => a.repo !== s.repo || a.issue !== s.issue))
        throw new Error('accepted scope identity/task mismatch');
    return s;
}
export function parseRecoveryPayload(v: unknown): RecoveryEvidencePayload {
    const p = parse<RecoveryEvidencePayload>(v, payload, 'recovery payload', 32 * 1024);
    if (p.kind === 'effect-intent' && (p.result !== 'prepared' || p.observedRemoteId !== null || p.observedDigest !== null))
        throw new Error('intent must be prepared and unsent');
    if (p.kind === 'effect-outcome' && p.result === 'prepared')
        throw new Error('outcome cannot be prepared');
    if (p.kind === 'join' && ((p.state === 'accepted' && (p.parentAfter === null || p.result !== 'passed' || p.validationId === null || p.commandDigest === null)) || (p.state === 'prepared' && (p.parentAfter !== null || p.result !== null))))
        throw new Error('join acceptance combination invalid');
    if (p.kind === 'acceptance' && p.acceptedScope !== null) {
        parseAcceptedScope(p.acceptedScope);
        if (p.result !== 'passed')
            throw new Error('failed checks cannot accept scope');
    }
    if (p.kind === 'execution-qualification' && p.result === 'qualified' && (!p.unmanagedDenied || !p.validationIds.length || !effectKinds.every(k => p.managedKinds.includes(k))))
        throw new Error('incomplete effect qualification');
    return p;
}
export function parseRecoveryEnvelope(v: unknown): RecoveryEnvelope {
    const e = parse<RecoveryEnvelope>(v, envelope, 'recovery envelope');
    if (!e.approvalBindings.length || new Set(e.effects.map(x => x.operationId)).size !== e.effects.length || new Set(e.completed.map(x => x.taskId)).size !== e.completed.length)
        throw new Error('missing/duplicate recovery identity');
    for (const x of e.effects) {
        if (x.runId !== e.runId || x.generation > e.generation || ((x.state === 'acknowledged' || x.state === 'cancelled-before-send') && x.outcome === null))
            throw new Error('effect envelope identity/outcome mismatch');
    }
    for (const x of e.joins) {
        if (x.state === 'accepted' && (!x.parentAfter || !x.acceptance) || x.state === 'prepared' && (x.parentAfter !== null || x.acceptance !== null))
            throw new Error('join reference mismatch');
    }
    if (e.checkpoint && (e.checkpoint.scopeDigest !== e.scopeDigest || e.checkpoint.runId !== e.runId))
        throw new Error('checkpoint envelope mismatch');
    return e;
}
export interface EffectiveMachine {
    id: string;
    installationId: string;
    hostBindingDigest: string;
    executionLogin: string;
    group: string;
    enabled: boolean;
    allowedRepositories: string[];
    repositoryIds: Record<string, string>;
    policyDigest: string;
    coordination: {
        repositoryId: string;
        repository: string;
        branch: string;
        rootCommit: string;
        installationId: string;
    };
    defaults: {
        maxRuns: number;
        childConcurrent: number;
        recovery: string;
        [key: string]: unknown;
    };
}
export interface MachineSession {
    machineId: string;
    installationId: string;
    sessionId: string;
    hostBindingDigest: string;
    bootIdDigest: string;
    identity: ProcessIdentity;
    localRoot: string;
    target: CoordinationTarget;
}
export interface ParentClaimBinding {
    taskKey: string;
    runId: string;
    generation: number;
    ownerToken: string;
    machineId: string;
    installationId: string;
    sessionId: string;
}
export interface VerifiedCandidate {
    host: string;
    repo: string;
    issue: number;
    repositoryNodeId: string;
    issueNodeId: string;
    scopeDigest: string;
    approvalDigest: string;
    approvalBindings: ApprovalAuthorityRef[];
    runId: string;
    stage: string;
    paths: string[];
    resources: string[];
    independent: boolean;
    parentTaskKey: string | null;
    // Missing is readable legacy data, never authority for a new child execution.
    parentBinding?: ParentClaimBinding | null;
    approvedTaskIds: string[];
}
export interface SharedClaim {
    taskKey: string;
    generation: number;
    ownerToken: string;
    machineId: string;
    installationId: string;
    sessionId: string;
    runId: string;
    stateCommit: string;
    target: CoordinationTarget;
}
export type SharedClaimResult = {
    kind: 'owned';
    claim: SharedClaim;
} | {
    kind: 'busy' | 'refused' | 'ambiguous';
    reason: string;
    claim?: SharedClaim;
};
export type GroupSuccessionRequest = {
    schemaVersion: 1;
    kind: 'recover-stopped-group';
    operationId: string;
    expectedHead: string;
    parentTaskKey: string;
    groupPlan: ArtifactRef;
    groupsDigest: string;
    members: Array<{ expected: ParentClaimBinding; candidate: VerifiedCandidate }>;
};
export type GroupSuccessionReceipt = {
    schemaVersion: 2;
    type: 'group-succession';
    operationId: string;
    parentTaskKey: string;
    previousHead: string;
    requestDigest: string;
    groupPlan: ArtifactRef;
    groupsDigest: string;
    transferredAt: string;
    receiver: {
        machineId: string;
        installationId: string;
        sessionId: string;
        hostBindingDigest: string;
        bootIdDigest: string;
    };
    members: Array<{
        before: ParentClaimBinding;
        after: ParentClaimBinding;
        beforeTaskSha256: string;
        afterTaskSha256: string;
        previousSuccession: Extract<EvidenceRef, { kind: 'state-receipt' }> | null;
    }>;
};
export type GroupSuccessionResult = {
    kind: 'owned';
    parent: SharedClaim;
    children: SharedClaim[];
    reference: Extract<EvidenceRef, { kind: 'state-receipt' }>;
} | { kind: 'busy' | 'refused' | 'ambiguous'; reason: string };
export interface TaskRecordV1 {
    schemaVersion: 1;
    taskKey: string;
    host: string;
    repo: string;
    issue: number;
    repositoryNodeId: string;
    issueNodeId: string;
    scopeDigest: string;
    approvalDigest: string;
    approvalBindings: ApprovalAuthorityRef[];
    generation: number;
    machineId: string;
    installationId: string;
    sessionId: string;
    ownerToken: string;
    runId: string;
    stage: string;
    state: 'claimed' | 'running' | 'stopped' | 'blocked' | 'completed';
    paths: string[];
    resources: string[];
    independent: boolean;
    parentTaskKey: string | null;
    // Missing is readable legacy data, never authority for a new child execution.
    parentBinding?: ParentClaimBinding | null;
    approvedTaskIds: string[];
    checkpoint: CheckpointRef | null;
    stopProof: StopProof | null;
    unresolvedEffects: EvidenceRef[];
    recovery: RecoveryEnvelope | null;
    acceptedScopes: Array<{
        scopeDigest: string;
        receipt: Extract<EvidenceRef, {
            kind: 'state-receipt';
        }>;
    }>;
}
export interface TaskRecordV2 extends Omit<TaskRecordV1, 'schemaVersion' | 'state' | 'parentBinding'> {
    schemaVersion: 2;
    state: TaskRecordV1['state'] | 'recovery-queued';
    parentBinding: ParentClaimBinding | null;
    successionOperationId: string;
}
export type TaskRecord = TaskRecordV1 | TaskRecordV2;
export interface MachineRecord {
    schemaVersion: 1;
    machineId: string;
    installationId: string;
    sessionId: string;
    hostBindingDigest: string;
    bootIdDigest: string;
    observedAt: string;
    activeTaskKeys: string[];
}
interface Summary {
    taskKey: string;
    repo: string;
    issueNodeId: string;
    machineId: string;
    parentTaskKey: string | null;
    paths: string[];
    resources: string[];
    independent: boolean;
}
interface Index {
    schemaVersion: 1;
    installationId: string;
    revision: number;
    active: Summary[];
    machines: string[];
}
export interface OperationReceipt {
    schemaVersion: 1;
    operationId: string;
    type: string;
    taskKey: string;
    generation: number;
    previousHead: string;
    requestDigest: string;
    resultOwner: {
        ownerToken: string;
        machineId: string;
        installationId: string;
        sessionId: string;
        runId: string;
    };
    recoveryPayload: RecoveryEvidencePayload | null;
}
export interface CoordinationSnapshot {
    head: string;
    branchId: string;
    index: Index;
    tasks: Record<string, TaskRecord>;
    machines: Record<string, MachineRecord>;
}
export type SharedHistoryCoverage = 'complete' | 'partial' | 'unsupported' | 'unavailable' | 'bounded';
export type SharedTransitionKind = 'acquire' | 'start' | 'checkpoint' | 'stop' | 'handoff' | 'complete' | 'block' | 'recovery' | 'receipt' | 'effect-send' | 'accept-scope' | 'group-succession';
export interface SharedTaskStatus extends Pick<TaskRecord, 'taskKey' | 'repo' | 'issue' | 'state' | 'machineId' | 'generation'> {
    sourceCommit: string;
    originMachineId: string | null;
    // Recorded commit time of a verified task operation, never process liveness.
    lastTransitionObservedAt: string | null;
    checkpoint: { headSha: string; publishedAt: string; sourceCommit: string; availability: 'unknown' } | null;
    history: { coverage: SharedHistoryCoverage; events: Array<{
        kind: SharedTransitionKind; generation: number; machineId: string;
        previousMachineId: string | null; sourceCommit: string; observedAt: string | null;
    }> };
}
export interface SharedStatus {
    head: string | null;
    tasks: SharedTaskStatus[];
    refusal: string | null;
    // Missing in older/unavailable adapters means unknown, never complete.
    history?: { coverage: SharedHistoryCoverage; archiveCoverage: 'active-only' | 'partial'; sourceCommit: string };
}
export interface CoordinationHistoryPage {
    commits: Array<{ oid: string; parents: string[]; headline: string; committedAt: string | null }>;
    nextCursor: string | null;
}
export interface CoordinationProvider {
    // Read-only discovery on the existing state branch. Unsupported providers keep current status usable.
    history?(target: CoordinationTarget, head: string, cursor: string | null, first: number): Promise<CoordinationHistoryPage>;
    branch(target: CoordinationTarget): Promise<{
        id: string;
        head: string;
        repositoryId: string;
        private: boolean;
        defaultBranch: string;
    }>;
    read(target: CoordinationTarget, commit: string, path: string): Promise<string | null>;
    compare(target: CoordinationTarget, base: string, head: string): Promise<'ahead' | 'identical' | 'behind' | 'diverged'>;
    commit(target: CoordinationTarget, input: {
        branchId: string;
        expectedHeadOid: string;
        files: Record<string, string>;
        operationId: string;
    }): Promise<{
        kind: 'committed';
        head: string;
    } | {
        kind: 'conflict' | 'ambiguous' | 'refused';
        reason: string;
        retryAfterMs?: number;
    }>;
}
class CoordinationRateLimit extends Error {
    readonly retryAfterMs: number;
    constructor(retryAfterMs: number) { super('provider rate limited'); this.retryAfterMs = retryAfterMs; }
}
// These functions are controller dependencies. Nothing decoded from shared state can provide them.
export interface CoordinationTarget {
    host: string;
    repository: string;
    repositoryId: string;
    branch: string;
    rootCommit: string;
    installationId: string;
    localRoot: string;
    provider: CoordinationProvider;
    verifyCandidate: (candidate: VerifiedCandidate, machine: EffectiveMachine, session: MachineSession) => Promise<void>;
    // The controller binds canonical group/current authority to these pinned records.
    verifyChildRelationship?: (input: { parent: TaskRecord; child: TaskRecord }) => Promise<{ maxChildren: number }>;
    verifyGroupSuccession?: (input: { parent: TaskRecord; members: Array<{ task: TaskRecord; candidate: VerifiedCandidate }>; groupPlan: ArtifactRef; groupsDigest: string; machine: EffectiveMachine; session: MachineSession }) => Promise<{ maxChildren: number }>;
    verifySession?: (previous: MachineRecord, machine: EffectiveMachine, session: MachineSession) => Promise<void>;
    verifyTransition: (task: TaskRecord, transition: TaskTransition) => Promise<void>;
    verifyEvidence: (ref: EvidenceRef, payload: RecoveryEvidencePayload | null) => Promise<void>;
    now?: () => number;
    random?: () => number;
}
export type TaskTransition = {
    kind: 'start';
} | {
    kind: 'checkpoint';
    checkpoint: CheckpointRef;
    recovery: RecoveryEnvelope;
} | {
    kind: 'stop' | 'block';
    stopProof: StopProof | null;
} | {
    kind: 'complete';
    stopProof: StopProof;
    acceptedScope: Extract<EvidenceRef, {
        kind: 'state-receipt';
    }>;
} | {
    kind: 'accept-scope';
    acceptedScope: Extract<EvidenceRef, { kind: 'state-receipt' }>;
} | {
    kind: 'handoff';
    machine: EffectiveMachine;
    session: MachineSession;
    candidate: VerifiedCandidate;
    stopProof: StopProof;
    recovery: RecoveryEnvelope;
} | {
    kind: 'recovery';
    recovery: RecoveryEnvelope;
} | {
    kind: 'receipt';
    payload: RecoveryEvidencePayload;
} | {
    kind: 'effect-send';
    effectId: string;
};
const summary = closed({ taskKey: digest, repo, issueNodeId: node, machineId: id, parentTaskKey: nullable(digest), paths: unique(relative), resources: unique(resource), independent: boolean });
const indexSchema = closed({ schemaVersion: literal(1), installationId: uuid, revision: integer, active: unique(summary), machines: unique(id) });
const machineSchema = closed({ schemaVersion: literal(1), machineId: id, installationId: uuid, sessionId: uuid, hostBindingDigest: digest, bootIdDigest: digest, observedAt: date, activeTaskKeys: unique(digest) });
const recordFields = { schemaVersion: literal(1), taskKey: digest, host: pattern(/^[a-z0-9.-]+$/), repo, issue: positive, repositoryNodeId: node, issueNodeId: node, scopeDigest: digest, approvalDigest: digest, approvalBindings: authorities, generation: positive, machineId: id, installationId: uuid, sessionId: uuid, ownerToken: uuid, runId: uuid, stage: id, state: literal('claimed', 'running', 'stopped', 'blocked', 'completed'), paths: unique(relative), resources: unique(resource), independent: boolean, parentTaskKey: nullable(digest), approvedTaskIds: unique(id), checkpoint: nullable(checkpoint), stopProof: nullable(stopProof), unresolvedEffects: unique(evidence), recovery: nullable(envelope), acceptedScopes: unique(closed({ scopeDigest: digest, receipt: stateEvidence })) };
const parentBindingSchema = closed({ taskKey: digest, runId: uuid, generation: positive, ownerToken: uuid, machineId: id, installationId: uuid, sessionId: uuid });
const recordV1Schema = union(closed(recordFields), closed({ ...recordFields, parentBinding: nullable(parentBindingSchema) }));
const { schemaVersion: _recordVersion, state: _recordState, ...recordBodyFields } = recordFields;
const recordV2Schema = closed({ schemaVersion: literal(2), ...recordBodyFields, state: literal('claimed', 'running', 'stopped', 'blocked', 'completed', 'recovery-queued'), parentBinding: nullable(parentBindingSchema), successionOperationId: uuid });
const recordSchema = union(recordV1Schema, recordV2Schema);
const receiptSchema = closed({ schemaVersion: literal(1), operationId: uuid, type: id, taskKey: digest, generation: positive, previousHead: sha, requestDigest: digest, resultOwner: closed({ ownerToken: uuid, machineId: id, installationId: uuid, sessionId: uuid, runId: uuid }), recoveryPayload: nullable(payload) });
const candidateFields = { host: pattern(/^[a-z0-9.-]+$/), repo, issue: positive, repositoryNodeId: node, issueNodeId: node, scopeDigest: digest, approvalDigest: digest, approvalBindings: authorities, runId: uuid, stage: id, paths: unique(relative), resources: unique(resource), independent: boolean, parentTaskKey: nullable(digest), approvedTaskIds: unique(id) };
const candidateSchema = union(closed(candidateFields), closed({ ...candidateFields, parentBinding: nullable(parentBindingSchema) }));
const stateReceiptSchema = closed({ kind: literal('state-receipt'), operationId: uuid, commitSha: sha, blobSha256: digest });
const groupMemberSchema = closed({ before: parentBindingSchema, after: parentBindingSchema, beforeTaskSha256: digest, afterTaskSha256: digest, previousSuccession: nullable(stateReceiptSchema) });
const receiverSchema = closed({ machineId: id, installationId: uuid, sessionId: uuid, hostBindingDigest: digest, bootIdDigest: digest });
const groupReceiptSchema = closed({ schemaVersion: literal(2), type: literal('group-succession'), operationId: uuid, parentTaskKey: digest, previousHead: sha, requestDigest: digest, groupPlan: artifact, groupsDigest: digest, transferredAt: date, receiver: receiverSchema, members: unique(groupMemberSchema) });
const groupRequestSchema = closed({ schemaVersion: literal(1), kind: literal('recover-stopped-group'), operationId: uuid, expectedHead: sha, parentTaskKey: digest, groupPlan: artifact, groupsDigest: digest, members: unique(closed({ expected: parentBindingSchema, candidate: candidateSchema })) });
function parseCanonicalBytes<T>(raw: string, check: Check, name: string, max: number): T {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > max) throw Error(`${name}: unsupported, oversized or invalid closed schema`);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw Error(`${name}: corrupt JSON`); }
    const parsed = parse<T>(value, check, name, max);
    if (raw !== canonical(parsed)) throw Error(`${name}: noncanonical bytes`);
    return parsed;
}
export function parseTaskRecordBytes(raw: string): TaskRecord {
    const task = parseCanonicalBytes<TaskRecord>(raw, recordSchema, 'task record', 256 * 1024);
    if (task.recovery) parseRecoveryEnvelope(task.recovery);
    return task;
}
export function parseOperationReceiptBytes(raw: string): OperationReceipt {
    const receipt = parseCanonicalBytes<OperationReceipt>(raw, receiptSchema, 'operation receipt', 32 * 1024);
    if (receipt.recoveryPayload) parseRecoveryPayload(receipt.recoveryPayload);
    return receipt;
}
export function taskKey(host: string, repositoryNodeId: string, issueNodeId: string): string {
    if (!/^[a-z0-9.-]+$/.test(host) || !node(repositoryNodeId) || !node(issueNodeId))
        throw new Error('invalid canonical task identity');
    return sha256(`${host}\n${repositoryNodeId}\n${issueNodeId}`);
}
const taskPath = (key: string) => { if (!digest(key))
    throw Error('invalid task key'); return `coordination/tasks/${key}.json`; };
const machinePath = (key: string) => { if (!id(key))
    throw Error('invalid machine ID'); return `coordination/machines/${key}.json`; };
export const operationPath = (key: string) => { if (!uuid(key))
    throw Error('invalid operation ID'); return `coordination/operations/${key}.json`; };
function summaryOf(t: TaskRecord): Summary { return { taskKey: t.taskKey, repo: t.repo, issueNodeId: t.issueNodeId, machineId: t.machineId, parentTaskKey: t.parentTaskKey, paths: t.paths, resources: t.resources, independent: t.independent }; }
function ownerOf(t: TaskRecord) { return { ownerToken: t.ownerToken, machineId: t.machineId, installationId: t.installationId, sessionId: t.sessionId, runId: t.runId }; }
function bindingOf(t: TaskRecord): ParentClaimBinding { return { taskKey: t.taskKey, runId: t.runId, generation: t.generation, ownerToken: t.ownerToken, machineId: t.machineId, installationId: t.installationId, sessionId: t.sessionId }; }
function claimOf(t: TaskRecord, head: string, target: CoordinationTarget): SharedClaim { return { taskKey: t.taskKey, generation: t.generation, ...ownerOf(t), stateCommit: head, target }; }
function owns(t: TaskRecord, c: SharedClaim) { return t.taskKey === c.taskKey && t.generation === c.generation && canonical(ownerOf(t)) === canonical({ ownerToken: c.ownerToken, machineId: c.machineId, installationId: c.installationId, sessionId: c.sessionId, runId: c.runId }); }
async function privateWrite(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const dir = await lstat(dirname(path));
    if (dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077))
        throw Error('unsafe local coordination directory');
    try {
        const st = await lstat(path);
        if (st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077))
            throw Error('unsafe local coordination record');
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
            throw e;
    }
    const temp = path + '.' + randomUUID() + '.tmp', fd = await open(temp, 'wx', 0o600);
    try {
        await fd.writeFile(canonical(value) + '\n');
        await fd.sync();
    }
    finally {
        await fd.close();
    }
    ;
    await rename(temp, path);
    const parent = await open(dirname(path), 'r');
    try {
        await parent.sync();
    }
    finally {
        await parent.close();
    }
}
function localPath(target: CoordinationTarget, suffix: string) { return join(target.localRoot, sha256(`${target.host}\n${target.repositoryId}\n${target.branch}`), suffix); }
export async function acquireReadPointerClaim(path: string, maxWaitMs = requestTimeout()): Promise<Claim> {
    if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > 10000)
        throw Error('invalid coordination read-pointer wait window');
    const identity = await processIdentity(), deadline = Date.now() + maxWaitMs;
    let busyReason: string | null = null;
    for (;;) {
        if (busyReason && Date.now() >= deadline)
            throw Error(`${busyReason}; coordination read-pointer wait window exhausted`);
        const result = await acquireClaim(path, identity);
        if (result.kind === 'owned') {
            if (Date.now() > deadline) {
                await releaseClaim(result.claim);
                throw Error(`${busyReason ?? 'coordination read-pointer acquisition'}; wait window exhausted`);
            }
            return result.claim;
        }
        if (result.kind === 'refused')
            throw Error(result.reason);
        busyReason = result.reason;
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            throw Error(`${busyReason}; coordination read-pointer wait window exhausted`);
        await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
    }
}
async function remembered(target: CoordinationTarget): Promise<{
    head: string;
    revision: number;
} | null> {
    try {
        const path = localPath(target, 'accepted.json');
        const st = await lstat(path);
        if (st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077))
            throw Error('unsafe remembered state');
        return parse(JSON.parse(await readFile(path, 'utf8')), closed({ head: sha, revision: integer }), 'remembered state', 8192);
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return null;
        throw e;
    }
}
async function pinnedJson(target: CoordinationTarget, head: string, path: string, max: number, total?: {
    bytes: number;
}): Promise<unknown | null> {
    const raw = await bounded(target.provider.read(target, head, path));
    if (raw === null)
        return null;
    const bytes = Buffer.byteLength(raw);
    const budget = transactionClock.getStore();
    if (budget && (budget.decodedBytes += bytes) > 8 * 1024 * 1024) throw Error('total decoded transaction read bound exceeded');
    if (total)
        total.bytes += bytes;
    if (bytes > max || (total && total.bytes > 8 * 1024 * 1024))
        throw Error('coordination payload bound exceeded');
    try {
        return JSON.parse(raw);
    }
    catch {
        throw Error('coordination JSON is corrupt');
    }
}
export async function readCoordination(target: CoordinationTarget): Promise<CoordinationSnapshot> {
    return readCoordinationSnapshot(target, true);
}
async function readCoordinationSnapshot(target: CoordinationTarget, rememberHead: boolean, total = { bytes: 0 }, immutableHead?: string): Promise<CoordinationSnapshot> {
    if (!/^[a-z0-9.-]+$/.test(target.host) || !repo(target.repository) || !node(target.repositoryId) || !branch(target.branch) || !sha(target.rootCommit) || !uuid(target.installationId))
        throw Error('invalid coordination target');
    let remote = await bounded(target.provider.branch(target));
    if (!remote.private || remote.repositoryId !== target.repositoryId || !node(remote.id) || !sha(remote.head) || target.branch.replace(/^refs\/heads\//, '') === remote.defaultBranch)
        throw Error('coordination branch identity/privacy/default mismatch');
    const memory = await remembered(target);
    for (const base of new Set([target.rootCommit, ...(memory ? [memory.head] : [])]))
        if (!['ahead', 'identical'].includes(await bounded(target.provider.compare(target, base, remote.head))))
            throw Error('coordination history is not verified forward ancestry');
    let index = parse<Index>(await pinnedJson(target, remote.head, 'coordination/index.json', 1024 * 1024, total), indexSchema, 'coordination index', 1024 * 1024);
    if (index.installationId !== target.installationId || memory && index.revision < memory.revision)
        throw Error('coordination installation/revision rollback');
    if (immutableHead !== undefined) {
        if (rememberHead || !sha(immutableHead) || !['ahead', 'identical'].includes(await bounded(target.provider.compare(target, target.rootCommit, immutableHead))) || !['ahead', 'identical'].includes(await bounded(target.provider.compare(target, immutableHead, remote.head))))
            throw Error('historical state is outside verified branch ancestry');
        const historical = parse<Index>(await pinnedJson(target, immutableHead, 'coordination/index.json', 1024 * 1024, total), indexSchema, 'historical coordination index', 1024 * 1024);
        if (historical.installationId !== target.installationId || historical.revision > index.revision)
            throw Error('historical installation/revision mismatch');
        index = historical;
        remote = { ...remote, head: immutableHead };
    }
    const tasks: Record<string, TaskRecord> = {}, machines: Record<string, MachineRecord> = {};
    for (const row of index.active) {
        if (tasks[row.taskKey] || Object.values(tasks).some(t => t.issueNodeId === row.issueNodeId))
            throw Error('duplicate active task identity');
        const t = parse<TaskRecord>(await pinnedJson(target, remote.head, taskPath(row.taskKey), 256 * 1024, total), recordSchema, 'task record');
        if (t.taskKey !== taskKey(t.host, t.repositoryNodeId, t.issueNodeId) || canonical(summaryOf(t)) !== canonical(row) || t.state === 'completed')
            throw Error('task/index mismatch');
        if (t.recovery)
            parseRecoveryEnvelope(t.recovery);
        tasks[row.taskKey] = t;
    }
    for (const machineId of index.machines) {
        const m = parse<MachineRecord>(await pinnedJson(target, remote.head, machinePath(machineId), 256 * 1024, total), machineSchema, 'machine record');
        if (m.machineId !== machineId)
            throw Error('machine/index mismatch');
        machines[machineId] = m;
    }
    for (const m of Object.values(machines)) {
        const keys = Object.values(tasks).filter(t => t.machineId === m.machineId).map(t => t.taskKey).sort();
        if (canonical(keys) !== canonical([...m.activeTaskKeys].sort()) || keys.some(k => tasks[k]!.installationId !== m.installationId || tasks[k]!.sessionId !== m.sessionId && (!['stopped', 'blocked'].includes(tasks[k]!.state) || !tasks[k]!.stopProof)))
            throw Error('machine/task reservations disagree');
        if (Object.values(machines).some(other => other.machineId !== m.machineId && other.hostBindingDigest === m.hostBindingDigest))
            throw Error('duplicate host binding');
    }
    if (Object.values(tasks).some(t => !machines[t.machineId]))
        throw Error('missing reserved machine');
    if (!rememberHead)
        return { head: remote.head, branchId: remote.id, index, tasks, machines };
    // Serialize local read pointers: concurrent older reads must not regress remembered state.
    const lock = await acquireReadPointerClaim(localPath(target, 'read-pointer.lock'));
    try {
        const current = await remembered(target);
        if (current && current.head !== remote.head && !['ahead', 'identical'].includes(await bounded(target.provider.compare(target, current.head, remote.head))))
            throw Error('concurrent stale coordination read');
        await privateWrite(localPath(target, 'accepted.json'), { head: remote.head, revision: index.revision });
    }
    finally {
        await releaseClaim(lock);
    }
    return { head: remote.head, branchId: remote.id, index, tasks, machines };
}
// Inspection is a projection of retained private state, never completion/effect
// qualification. Consumers must still retain every unresolved recovery/delivery ref.
export type CoordinationTaskInspection = {
    kind: 'active' | 'completed';
    head: string;
    task: TaskRecord;
} | {
    kind: 'absent';
    head: string;
} | {
    kind: 'invalid-or-unavailable';
    reason: string;
};
export async function inspectCoordinationTask(
    target: CoordinationTarget,
    key: string,
    expected: Partial<Pick<TaskRecord, 'runId' | 'generation' | 'ownerToken' | 'machineId' | 'installationId' | 'sessionId' | 'scopeDigest'>> = {},
): Promise<CoordinationTaskInspection> {
    try {
        taskPath(key);
        const bindings: Record<string, Check> = { runId: uuid, generation: positive, ownerToken: uuid, machineId: id, installationId: uuid, sessionId: uuid, scopeDigest: digest };
        if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.entries(expected).some(([name, value]) => !Object.hasOwn(bindings, name) || !bindings[name]!(value)))
            throw Error('invalid expected task binding');
        // Reuse the current-head, private branch, ancestry, bounds and full index
        // consistency checks, without writing even the local accepted-head pointer.
        const total = { bytes: 0 }, snapshot = await readCoordinationSnapshot(target, false, total);
        return await inspectTaskAtSnapshot(target, key, expected, snapshot, total);
    }
    catch {
        return { kind: 'invalid-or-unavailable', reason: 'retained coordination task could not be verified' };
    }
}
async function inspectTaskAtSnapshot(target: CoordinationTarget, key: string, expected: Partial<TaskRecord>, snapshot: CoordinationSnapshot, total: { bytes: number }): Promise<CoordinationTaskInspection> {
    const path = taskPath(key);
    const raw = snapshot.tasks[key] ?? await pinnedJson(target, snapshot.head, path, 256 * 1024, total);
    if (raw === null) return { kind: 'absent', head: snapshot.head };
    const task = parse<TaskRecord>(raw, recordSchema, 'retained task record');
    const indexed = snapshot.index.active.some(row => row.taskKey === key);
    if (task.taskKey !== key || task.host !== target.host || key !== taskKey(task.host, task.repositoryNodeId, task.issueNodeId) || indexed !== (task.state !== 'completed'))
        throw Error('retained task/index identity mismatch');
    if (Object.entries(expected).some(([name, value]) => task[name as keyof TaskRecord] !== value))
        throw Error('retained task binding mismatch');
    if (task.recovery) {
        const e = parseRecoveryEnvelope(task.recovery);
        if (e.taskKey !== key || e.runId !== task.runId || e.generation !== task.generation || e.scopeDigest !== task.scopeDigest || e.approvalDigest !== task.approvalDigest || canonical(e.approvalBindings) !== canonical(task.approvalBindings))
            throw Error('retained recovery identity mismatch');
    }
    return { kind: indexed ? 'active' : 'completed', head: snapshot.head, task };
}
export type HistoricalTaskBinding = ParentClaimBinding | {
    child: Omit<ParentClaimBinding, 'ownerToken'>;
    parent: ParentClaimBinding;
};
export type HistoricalCoordinationTaskInspection = {
    kind: 'historical';
    head: string;
    task: TaskRecord;
} | { kind: 'invalid-or-unavailable'; reason: string };
// Immutable facts only: the returned owner must never authorize current work.
// The receipt can have been published by the parent while pinning a child record.
export async function inspectHistoricalCoordinationTask(target: CoordinationTarget, input: {
    taskKey: string;
    expected: HistoricalTaskBinding;
    evidence: Extract<EvidenceRef, { kind: 'state-receipt' }>;
    at: 'receipt' | 'previous-head';
}): Promise<HistoricalCoordinationTaskInspection> {
    try {
        const childBinding = closed({ child: closed({ taskKey: digest, runId: uuid, generation: positive, machineId: id, installationId: uuid, sessionId: uuid }), parent: parentBindingSchema });
        if (!closed({ taskKey: digest, expected: union(parentBindingSchema, childBinding), evidence: stateEvidence, at: literal('receipt', 'previous-head') })(input))
            throw Error('historical pin and exact task/parent binding required');
        const expected = 'child' in input.expected ? input.expected.child : input.expected;
        if (expected.taskKey !== input.taskKey) throw Error('historical task key mismatch');
        const total = { bytes: 0 };
        const receipt = await readEvidenceReceipt(target, input.evidence, total);
        const head = input.at === 'receipt' ? input.evidence.commitSha : receipt.previousHead;
        if (!['ahead', 'identical'].includes(await bounded(target.provider.compare(target, receipt.previousHead, input.evidence.commitSha))))
            throw Error('receipt previous head is not ancestral');
        const snapshot = await readCoordinationSnapshot(target, false, total, head);
        const result = await inspectTaskAtSnapshot(target, input.taskKey, expected, snapshot, total);
        if (result.kind !== 'active' && result.kind !== 'completed') throw Error('historical task missing');
        if ('child' in input.expected && (result.task.parentTaskKey !== input.expected.parent.taskKey || canonical(result.task.parentBinding ?? null) !== canonical(input.expected.parent)))
            throw Error('historical original parent binding mismatch');
        return { kind: 'historical', head, task: result.task };
    } catch {
        return { kind: 'invalid-or-unavailable', reason: 'historical coordination task could not be verified' };
    }
}

export type HandoffCoordinationTaskInspection = {
    kind: 'historical-handoff';
    receipt: OperationReceipt;
    predecessor: TaskRecord;
    handedOff: TaskRecord;
} | { kind: 'invalid-or-unavailable'; reason: string };
// Handoff receipts carry no recovery evidence payload. Inspect only their pinned
// ownership transition; callers must independently verify current work authority.
export async function inspectHandoffCoordinationTask(target: CoordinationTarget, input: {
    taskKey: string;
    expected: ParentClaimBinding;
    evidence: Extract<EvidenceRef, { kind: 'state-receipt' }>;
}): Promise<HandoffCoordinationTaskInspection> {
    try {
        if (!closed({ taskKey: digest, expected: parentBindingSchema, evidence: stateEvidence })(input) || input.expected.taskKey !== input.taskKey)
            throw Error('handoff pin and exact predecessor binding required');
        const total = { bytes: 0 };
        const receipt = await readImmutableOperationReceipt(target, input.evidence, total);
        if (receipt.type !== 'handoff' || receipt.recoveryPayload !== null || receipt.taskKey !== input.taskKey ||
            await bounded(target.provider.compare(target, receipt.previousHead, input.evidence.commitSha)) !== 'ahead')
            throw Error('invalid pinned handoff transition');
        const before = await readCoordinationSnapshot(target, false, total, receipt.previousHead);
        const predecessor = await inspectTaskAtSnapshot(target, input.taskKey, input.expected, before, total);
        const after = await readCoordinationSnapshot(target, false, total, input.evidence.commitSha);
        const handedOff = await inspectTaskAtSnapshot(target, input.taskKey, {}, after, total);
        if (predecessor.kind !== 'active' || handedOff.kind !== 'active')
            throw Error('handoff requires retained active owners');
        const prior = predecessor.task, next = handedOff.task;
        if (next.state !== 'claimed' || next.generation !== prior.generation + 1 || receipt.generation !== next.generation ||
            next.runId !== prior.runId || next.ownerToken === prior.ownerToken || canonical(receipt.resultOwner) !== canonical(ownerOf(next)))
            throw Error('handoff generation/result owner mismatch');
        for (const field of ['host', 'repo', 'repositoryNodeId', 'issueNodeId', 'scopeDigest', 'approvalDigest', 'approvalBindings', 'parentTaskKey', 'parentBinding'] as const)
            if (canonical(prior[field] ?? null) !== canonical(next[field] ?? null))
                throw Error('handoff changed original task authority');
        return { kind: 'historical-handoff', receipt, predecessor: prior, handedOff: next };
    } catch {
        return { kind: 'invalid-or-unavailable', reason: 'historical handoff could not be verified' };
    }
}

function groupSuccessor(before: TaskRecord, receipt: Pick<GroupSuccessionReceipt, 'operationId' | 'parentTaskKey' | 'receiver'>, after: ParentClaimBinding): TaskRecordV2 {
    return {
        ...before,
        schemaVersion: 2,
        parentBinding: before.parentBinding ?? null,
        successionOperationId: receipt.operationId,
        machineId: receipt.receiver.machineId,
        installationId: receipt.receiver.installationId,
        sessionId: receipt.receiver.sessionId,
        ownerToken: after.ownerToken,
        generation: before.generation + 1,
        state: before.taskKey === receipt.parentTaskKey ? 'claimed' : 'recovery-queued',
        recovery: before.recovery ? { ...before.recovery, generation: before.generation + 1 } : null,
    };
}

async function groupReceiptAt(target: CoordinationTarget, head: string, operationId: string, total = { bytes: 0 }): Promise<{ receipt: GroupSuccessionReceipt; raw: string } | null> {
    const raw = await bounded(target.provider.read(target, head, operationPath(operationId)));
    if (raw === null) return null;
    const bytes = Buffer.byteLength(raw), budget = transactionClock.getStore();
    total.bytes += bytes;
    if (bytes > 32 * 1024 || total.bytes > 8 * 1024 * 1024 || budget && (budget.decodedBytes += bytes) > 8 * 1024 * 1024)
        throw Error('coordination payload bound exceeded');
    const receipt = parse<GroupSuccessionReceipt>(JSON.parse(raw), groupReceiptSchema, 'group succession receipt', 32 * 1024);
    if (receipt.operationId !== operationId || receipt.members.length < 2 || receipt.members.length > 17)
        throw Error('group succession receipt identity/cardinality mismatch');
    return { receipt, raw };
}

type SuccessionValidationState = { visited: Set<string>; trail: Set<string>; cache: Map<string, Array<{ before: TaskRecord; after: TaskRecordV2 }>> };
const immutableSuccessionFields = ['taskKey', 'host', 'repo', 'issue', 'repositoryNodeId', 'issueNodeId', 'scopeDigest', 'approvalDigest', 'approvalBindings', 'runId', 'stage', 'paths', 'resources', 'independent', 'parentTaskKey', 'parentBinding', 'approvedTaskIds'] as const;
function validateImmutableSuccessionLineage(initial: TaskRecord, current: TaskRecord): void {
    for (const field of immutableSuccessionFields)
        if (canonical(initial[field] ?? null) !== canonical(current[field] ?? null))
            throw Error('group succession immutable task/run/scope/parent lineage changed');
}
async function validateOwnershipProgression(target: CoordinationTarget, initial: TaskRecord, current: TaskRecord, currentHead: string, total: { bytes: number }): Promise<void> {
    validateImmutableSuccessionLineage(initial, current);
    if (canonical(bindingOf(initial)) === canonical(bindingOf(current))) return;
    if (current.generation <= initial.generation || !target.provider.history) throw Error('intervening ownership history unavailable');
    let cursor: string | null = null, nextHead = currentHead, tracked = current, transitions = 0;
    const cursors = new Set<string>(), commits = new Set<string>();
    for (let pageNumber = 0; pageNumber < sharedStatusLimits.pages; pageNumber++) {
        const page: CoordinationHistoryPage = await bounded(target.provider.history(target, currentHead, cursor, sharedStatusLimits.pageSize));
        const bytes = Buffer.byteLength(JSON.stringify(page));
        if (bytes > sharedStatusLimits.pageBytes || (total.bytes += bytes) > 8 * 1024 * 1024 || !closed({ commits: array(closed({ oid: sha, parents: array(sha), headline: (v: unknown) => typeof v === 'string' && v.length <= 256, committedAt: nullable(date) })), nextCursor: nullable((v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 1024) })(page))
            throw Error('intervening ownership history invalid or over bound');
        for (const commit of page.commits) {
            if (commit.oid !== nextHead || commits.has(commit.oid)) throw Error('intervening ownership history is noncontiguous');
            commits.add(commit.oid);
            if (commit.oid === target.rootCommit) break;
            if (commit.parents.length !== 1 || commit.parents[0] === commit.oid) throw Error('intervening ownership history is nonlinear');
            nextHead = commit.parents[0]!;
            const operationId = /^factory coordination ([0-9a-f-]+)$/.exec(commit.headline)?.[1];
            if (!operationId || !uuid(operationId)) throw Error('intervening ownership operation unavailable');
            const raw = await pinnedJson(target, commit.oid, operationPath(operationId), 32 * 1024, total);
            if (receiptSchema(raw)) {
                const receipt = parse<OperationReceipt>(raw, receiptSchema, 'intervening handoff receipt', 32 * 1024);
                if (receipt.previousHead !== nextHead) throw Error('intervening handoff parent mismatch');
                if (await pinnedJson(target, nextHead, operationPath(operationId), 32 * 1024, total) !== null || canonical(await pinnedJson(target, currentHead, operationPath(operationId), 32 * 1024, total)) !== canonical(raw))
                    throw Error('intervening handoff receipt is not immutable');
                if (receipt.type === 'handoff' && receipt.taskKey === current.taskKey) {
                    if (++transitions > 32) throw Error('group succession predecessor bound exceeded');
                    const after = (await inspectTaskAtSnapshot(target, current.taskKey, {}, await readCoordinationSnapshot(target, false, total, commit.oid), total));
                    const before = (await inspectTaskAtSnapshot(target, current.taskKey, {}, await readCoordinationSnapshot(target, false, total, nextHead), total));
                    if ((after.kind !== 'active' && after.kind !== 'completed') || (before.kind !== 'active' && before.kind !== 'completed') || canonical(bindingOf(after.task)) !== canonical(bindingOf(tracked)) || statusTransition(receipt, before.task, after.task) !== 'handoff')
                        throw Error('intervening handoff lineage invalid');
                    validateImmutableSuccessionLineage(initial, before.task);
                    tracked = before.task;
                    if (canonical(bindingOf(tracked)) === canonical(bindingOf(initial))) return;
                }
            } else if (groupReceiptSchema(raw)) {
                if (await pinnedJson(target, nextHead, operationPath(operationId), 32 * 1024, total) !== null || canonical(await pinnedJson(target, currentHead, operationPath(operationId), 32 * 1024, total)) !== canonical(raw))
                    throw Error('intervening group receipt is not immutable');
            } else throw Error('intervening ownership receipt schema invalid');
        }
        if (page.nextCursor === null) break;
        if (cursors.has(page.nextCursor)) throw Error('intervening ownership cursor repeated');
        cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    throw Error('intervening ownership lineage does not reach succession endpoint');
}
async function validateGroupReceipt(target: CoordinationTarget, observed: CoordinationSnapshot, receipt: GroupSuccessionReceipt, total: { bytes: number }, requestedParent?: ParentClaimBinding, lineage: SuccessionValidationState = { visited: new Set(), trail: new Set(), cache: new Map() }): Promise<Array<{ before: TaskRecord; after: TaskRecordV2 }>> {
    if (lineage.trail.has(receipt.operationId)) throw Error('group succession predecessor cycle');
    if (!lineage.visited.has(receipt.operationId)) {
        if (lineage.visited.size >= 32) throw Error('group succession predecessor bound exceeded');
        lineage.visited.add(receipt.operationId);
    }
    lineage.trail.add(receipt.operationId);
    if (receipt.groupPlan.kind !== 'plan' || receipt.members.map(row => row.before.taskKey).join('\n') !== [...receipt.members].map(row => row.before.taskKey).sort().join('\n') ||
        new Set(receipt.members.map(row => row.before.taskKey)).size !== receipt.members.length || new Set(receipt.members.map(row => row.before.runId)).size !== receipt.members.length)
        throw Error('group succession receipt membership invalid');
    if (!['ahead', 'identical'].includes(await bounded(target.provider.compare(target, target.rootCommit, receipt.previousHead))) ||
        await bounded(target.provider.compare(target, receipt.previousHead, observed.head)) !== 'ahead')
        throw Error('group succession receipt ancestry invalid');
    const previous = await readCoordinationSnapshot(target, false, total, receipt.previousHead);
    const expectedKeys = [receipt.parentTaskKey, ...previous.index.active.filter(row => row.parentTaskKey === receipt.parentTaskKey).map(row => row.taskKey)].sort();
    if (canonical(expectedKeys) !== canonical(receipt.members.map(row => row.before.taskKey)))
        throw Error('group succession receipt omitted or added a retained member');
    const result: Array<{ before: TaskRecord; after: TaskRecordV2 }> = [];
    for (const member of receipt.members) {
        const before = previous.tasks[member.before.taskKey];
        if (!before || canonical(bindingOf(before)) !== canonical(member.before) || sha256(canonical(before)) !== member.beforeTaskSha256)
            throw Error('group succession predecessor changed');
        if (before.taskKey === receipt.parentTaskKey ? before.parentTaskKey !== null : before.parentTaskKey !== receipt.parentTaskKey)
            throw Error('group succession predecessor relationship invalid');
        const after = groupSuccessor(before, receipt, member.after);
        if (canonical(bindingOf(after)) !== canonical(member.after) || sha256(canonical(after)) !== member.afterTaskSha256)
            throw Error('group succession successor hash/owner invalid');
        if (before.schemaVersion === 1) {
            if (member.previousSuccession !== null) throw Error('v1 predecessor cannot cite succession history');
        } else {
            if (!member.previousSuccession || member.previousSuccession.operationId !== before.successionOperationId)
                throw Error('v2 predecessor succession history missing');
            const prior = await groupReceiptAt(target, member.previousSuccession.commitSha, member.previousSuccession.operationId, total);
            if (!prior || sha256(prior.raw) !== member.previousSuccession.blobSha256)
                throw Error('v2 predecessor succession history invalid');
            let priorRows = lineage.cache.get(prior.receipt.operationId);
            if (!priorRows) {
                const priorObserved = await readCoordinationSnapshot(target, false, total, member.previousSuccession.commitSha);
                priorRows = await validateGroupReceipt(target, priorObserved, prior.receipt, total, undefined, lineage);
                lineage.cache.set(prior.receipt.operationId, priorRows);
            }
            const predecessor = priorRows.find(row => row.after.taskKey === before.taskKey);
            if (!predecessor)
                throw Error('v2 predecessor succession endpoint invalid');
            await validateOwnershipProgression(target, predecessor.after, before, member.previousSuccession.commitSha, total);
        }
        result.push({ before, after });
    }
    const parent = receipt.members.find(row => row.before.taskKey === receipt.parentTaskKey);
    if (!parent || requestedParent && canonical(parent.after) !== canonical(requestedParent))
        throw Error('group succession current parent binding differs');
    lineage.trail.delete(receipt.operationId);
    lineage.cache.set(receipt.operationId, result);
    return result;
}

export type GroupSuccessionInspection = { kind: 'verified'; reference: Extract<EvidenceRef, { kind: 'state-receipt' }>; receipt: GroupSuccessionReceipt; currentMembers: Array<{ initial: TaskRecordV2; current: TaskRecord }> } | { kind: 'invalid-or-unavailable'; reason: string };
export async function inspectGroupSuccession(target: CoordinationTarget, input: { operationId: string; parent: ParentClaimBinding }): Promise<GroupSuccessionInspection> {
    try {
        if (!closed({ operationId: uuid, parent: parentBindingSchema })(input)) throw Error('group succession operation/current parent required');
        const total = { bytes: 0 }, current = await readCoordinationSnapshot(target, false, total);
        const found = await groupReceiptAt(target, current.head, input.operationId, total);
        if (!found) throw Error('group succession receipt missing');
        const rows = await validateGroupReceipt(target, current, found.receipt, total, input.parent);
        const currentMembers: Array<{ initial: TaskRecordV2; current: TaskRecord }> = [];
        for (const { after } of rows) {
            const task = current.tasks[after.taskKey];
            if (!task) throw Error('group succession current member unavailable');
            if (after.taskKey === found.receipt.parentTaskKey) {
                if (canonical(bindingOf(task)) !== canonical(input.parent)) throw Error('group succession current parent differs');
            } else await validateOwnershipProgression(target, after, task, current.head, total);
            currentMembers.push({ initial: after, current: task });
        }
        const reference = { kind: 'state-receipt' as const, operationId: input.operationId, commitSha: current.head, blobSha256: sha256(found.raw) };
        return { kind: 'verified', reference, receipt: found.receipt, currentMembers };
    } catch {
        return { kind: 'invalid-or-unavailable', reason: 'group succession could not be verified' };
    }
}

function validateSession(machine: EffectiveMachine, session: MachineSession, target: CoordinationTarget) {
    if (!machine.enabled || !id(machine.id) || !uuid(session.sessionId) || !digest(session.bootIdDigest) || machine.id !== session.machineId || machine.installationId !== session.installationId || machine.hostBindingDigest !== session.hostBindingDigest || !positive(machine.defaults.maxRuns) || !positive(machine.defaults.childConcurrent) || canonical(machine.coordination) !== canonical({ repositoryId: target.repositoryId, repository: target.repository, branch: target.branch, rootCommit: target.rootCommit, installationId: target.installationId }))
        throw Error('machine session/coordination mismatch');
}
function conflicting(a: Summary, b: Summary) {
    if (a.repo.toLowerCase() !== b.repo.toLowerCase())
        return a.resources.some(r => b.resources.includes(r));
    if (!a.independent || !b.independent || !a.paths.length || !b.paths.length)
        return true;
    if ([...a.paths, ...b.paths].some(p => /[\*?\[\]{}]/.test(p)))
        return true;
    return a.resources.some(r => b.resources.includes(r)) || a.paths.some(p => b.paths.some(q => { p = p.toLowerCase().replace(/\/$/, ''); q = q.toLowerCase().replace(/\/$/, ''); return p === q || p.startsWith(q + '/') || q.startsWith(p + '/'); }));
}
function validateParentBinding(t: Pick<TaskRecord, 'parentTaskKey' | 'parentBinding'>) {
    if (t.parentTaskKey === null) {
        if (t.parentBinding != null) throw Error('top-level task cannot carry a parent binding');
    } else if (!parentBindingSchema(t.parentBinding) || t.parentBinding!.taskKey !== t.parentTaskKey) {
        throw Error('original parent binding required; legacy child execution refused');
    }
}
async function verifyChildAdmission(snapshot: CoordinationSnapshot, child: TaskRecord, target: CoordinationTarget): Promise<number | null> {
    validateParentBinding(child);
    if (child.parentTaskKey === null) return null;
    const parent = snapshot.tasks[child.parentTaskKey];
    if (!parent || !snapshot.index.active.some(row => row.taskKey === parent.taskKey) || parent.taskKey === child.taskKey || parent.parentTaskKey !== null || parent.state !== 'running' || parent.stopProof || parent.host !== child.host || parent.repo !== child.repo || parent.repositoryNodeId !== child.repositoryNodeId)
        throw Error('active running top-level parent required');
    if (child.schemaVersion === 2) {
        if (parent.schemaVersion !== 2 || parent.successionOperationId !== child.successionOperationId)
            throw Error('recovery-queued child lacks its current parent succession');
        const inspected = await inspectGroupSuccession(target, { operationId: child.successionOperationId, parent: bindingOf(parent) });
        if (inspected.kind !== 'verified') throw Error(inspected.reason);
    } else if (canonical(child.parentBinding) !== canonical({ taskKey: parent.taskKey, generation: parent.generation, ...ownerOf(parent) }))
        throw Error('original parent owner/run/generation changed');
    if (!target.verifyChildRelationship) throw Error('verified parent group authority required');
    const result = await bounded(target.verifyChildRelationship({ parent: structuredClone(parent), child: structuredClone(child) }));
    if (!closed({ maxChildren: positive })(result) || result.maxChildren > 3)
        throw Error('approved parent child limit must be an integer from 1 to 3');
    return result.maxChildren;
}
async function verifyRecoveryQueued(snapshot: CoordinationSnapshot, task: TaskRecord, target: CoordinationTarget): Promise<void> {
    if (task.schemaVersion !== 2 || task.state !== 'recovery-queued') throw Error('queued succession state required');
    const total = { bytes: 0 }, found = await groupReceiptAt(target, snapshot.head, task.successionOperationId, total);
    if (!found) throw Error('queued succession receipt missing');
    const rows = await validateGroupReceipt(target, snapshot, found.receipt, total);
    const row = rows.find(value => value.after.taskKey === task.taskKey);
    if (!row || canonical(row.after) !== canonical(task) || !row.before.stopProof || !['stopped', 'blocked'].includes(row.before.state))
        throw Error('queued predecessor was not proved stopped and never restarted');
    await bounded(target.verifyTransition(structuredClone(row.before), { kind: 'stop', stopProof: structuredClone(row.before.stopProof) }));
    await verifyStop(target, row.before, row.before.stopProof);
    if (!row.before.recovery) throw Error('queued predecessor recovery unavailable');
    await validateRemoteRecovery(target, row.before.recovery, row.before, true);
}
async function occupiedChildSlots(snapshot: CoordinationSnapshot, rows: Summary[], target: CoordinationTarget): Promise<Summary[]> {
    const occupied: Summary[] = [];
    for (const row of rows) {
        const task = snapshot.tasks[row.taskKey];
        if (task?.schemaVersion === 2 && task.state === 'recovery-queued') {
            try { await verifyRecoveryQueued(snapshot, task, target); continue; }
            catch { /* Invalid succession still occupies a vendor-process slot. */ }
        }
        if (task && ['stopped', 'blocked'].includes(task.state) && task.stopProof) {
            try {
                // Revalidate physical termination through the real controller, not just
                // receipt shape. Failure retains capacity and every resource reservation.
                await bounded(target.verifyTransition(structuredClone(task), { kind: 'stop', stopProof: structuredClone(task.stopProof) }));
                await bounded(verifyStop(target, task, task.stopProof));
                continue;
            } catch { /* Unknown termination still occupies a vendor-process slot. */ }
        }
        occupied.push(row);
    }
    return occupied;
}
async function verifyAdmissionReadback(snapshot: CoordinationSnapshot, t: TaskRecord, type: string, target: CoordinationTarget) {
    if (t.parentTaskKey === null || !['acquire', 'start', 'handoff'].includes(type)) return;
    if (!['claimed', 'running'].includes(t.state)) throw Error('child admission is no longer executable');
    const maxChildren = await verifyChildAdmission(snapshot, t, target);
    const occupied = await occupiedChildSlots(snapshot, snapshot.index.active.filter(row => row.parentTaskKey === t.parentTaskKey), target);
    if (occupied.length > maxChildren!)
        throw Error('parent child capacity changed before acknowledgment');
}
async function reserve(snapshot: CoordinationSnapshot, t: TaskRecord, machine: EffectiveMachine, session: MachineSession, target: CoordinationTarget, replace = false) {
    const m = snapshot.machines[machine.id];
    if (m && (m.installationId !== session.installationId || m.hostBindingDigest !== session.hostBindingDigest))
        throw Error('registered machine installation/host mismatch');
    if (m && m.sessionId !== session.sessionId) {
        if (!target.verifySession)
            throw Error('registered machine already has another session; verified session reconciliation required');
        await target.verifySession(m, machine, session);
        for (const old of Object.values(snapshot.tasks).filter(t => t.machineId === machine.id)) {
            if (!['stopped', 'blocked'].includes(old.state) || !old.stopProof)
                throw Error('prior machine execution stop remains unknown');
            await verifyStop(target, old, old.stopProof);
        }
    }
    if (Object.values(snapshot.machines).some(x => x.machineId !== machine.id && x.hostBindingDigest === machine.hostBindingDigest))
        throw Error('host binding already reserved');
    const other = snapshot.index.active.filter(x => !replace || x.taskKey !== t.taskKey);
    if (other.some(x => x.issueNodeId === t.issueNodeId || x.taskKey === t.taskKey))
        throw Error('task busy');
    if (other.filter(x => x.machineId === machine.id && x.parentTaskKey === null).length >= machine.defaults.maxRuns && t.parentTaskKey === null)
        throw Error('machine at maxRuns');
    const maxChildren = await verifyChildAdmission(snapshot, t, target);
    const occupied = t.parentTaskKey === null ? [] : await occupiedChildSlots(snapshot, other.filter(x => x.parentTaskKey !== null && (x.parentTaskKey === t.parentTaskKey || x.machineId === machine.id)), target);
    if (t.parentTaskKey !== null && occupied.filter(x => x.parentTaskKey === t.parentTaskKey).length >= maxChildren!)
        throw Error('parent child capacity busy');
    if (t.parentTaskKey !== null && occupied.filter(x => x.machineId === machine.id).length >= machine.defaults.childConcurrent)
        throw Error('machine child capacity busy');
    // Only the verified coordinator pair overlaps; siblings and foreign resources still conflict.
    if (other.some(x => x.taskKey !== t.parentTaskKey && conflicting(x, summaryOf(t))))
        throw Error('incompatible resource reservation busy');
    snapshot.tasks[t.taskKey] = t;
    snapshot.index.active = [...other, summaryOf(t)];
    snapshot.machines[machine.id] = { schemaVersion: 1, machineId: machine.id, installationId: machine.installationId, sessionId: session.sessionId, hostBindingDigest: session.hostBindingDigest, bootIdDigest: session.bootIdDigest, observedAt: new Date().toISOString(), activeTaskKeys: snapshot.index.active.filter(x => x.machineId === machine.id).map(x => x.taskKey) };
    if (!snapshot.index.machines.includes(machine.id))
        snapshot.index.machines.push(machine.id);
}
function filesFor(snapshot: CoordinationSnapshot, t: TaskRecord, receipt: OperationReceipt): Record<string, string> {
    if (receipt.type !== 'accept-scope') snapshot.index.revision++;
    parse(snapshot.index, indexSchema, 'index', 1024 * 1024);
    parse(t, recordSchema, 'task');
    parse(receipt, receiptSchema, 'receipt', 32 * 1024);
    const files: Record<string, string> = { [taskPath(t.taskKey)]: canonical(t), [operationPath(receipt.operationId)]: canonical(receipt) };
    if (receipt.type !== 'accept-scope') files['coordination/index.json'] = canonical(snapshot.index);
    for (const m of receipt.type === 'accept-scope' ? [] : Object.values(snapshot.machines))
        files[machinePath(m.machineId)] = canonical(m);
    if (Object.values(files).reduce((n, v) => n + Buffer.byteLength(v), 0) > 8 * 1024 * 1024)
        throw Error('transaction size exceeded');
    return files;
}
async function receiptAt(target: CoordinationTarget, head: string, operationId: string): Promise<OperationReceipt | null> { const raw = await pinnedJson(target, head, operationPath(operationId), 32 * 1024); if (raw === null)
    return null; const r = parse<OperationReceipt>(raw, receiptSchema, 'receipt', 32 * 1024); if (r.operationId !== operationId)
    throw Error('receipt path identity mismatch'); if (r.recoveryPayload)
    parseRecoveryPayload(r.recoveryPayload); return r; }
function transact(...args: Parameters<typeof transactWithinWindow>): Promise<SharedClaimResult> {
    return transactionClock.run({ deadline: Date.now() + 45000, decodedBytes: 0 }, () => transactWithinWindow(...args));
}
async function transactWithinWindow(target: CoordinationTarget, operationId: string, build: (snapshot: CoordinationSnapshot) => Promise<{
    task: TaskRecord;
    type: string;
    payload: RecoveryEvidencePayload | null;
}>, expected?: SharedClaim, requestDigest = sha256(operationId)): Promise<SharedClaimResult> {
    if (!uuid(operationId))
        return { kind: 'refused', reason: 'invalid operation ID' };
    const deadline = Date.now() + 45000;
    for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
        try {
            const s = await readCoordination(target), prior = await receiptAt(target, s.head, operationId);
            if (prior) {
                if (prior.requestDigest !== requestDigest)
                    return { kind: 'refused', reason: 'operation ID reused for different request' };
                if (prior.type === 'effect-send')
                    return { kind: 'ambiguous', reason: 'effect send already reserved; reconcile outcome before retry' };
                const t = s.tasks[prior.taskKey] ?? parse<TaskRecord>(await pinnedJson(target, s.head, taskPath(prior.taskKey), 256 * 1024), recordSchema, 'completed task');
                if (prior.generation !== t.generation || canonical(prior.resultOwner) !== canonical(ownerOf(t)))
                    return { kind: 'refused', reason: 'old receipt no longer owns current task' };
                if (prior.type === 'handoff' && expected) {
                    // A successful handoff changes the owner. Prove the retry's old
                    // tuple at the receipt's immutable predecessor, never from the new token.
                    const historical = await readCoordinationSnapshot(target, false, { bytes: 0 }, prior.previousHead);
                    const original = historical.tasks[prior.taskKey];
                    if (!original || !owns(original, expected))
                        return { kind: 'refused', reason: 'handoff receipt original owner mismatch' };
                    await build(historical); // Revalidate current authority/evidence; no remote mutation.
                }
                else if (expected && !owns(t, expected))
                    return { kind: 'refused', reason: 'old receipt no longer owns current task' };
                if (prior.type === 'accept-scope') {
                    const retained = canonical(t);
                    await build(s); // Recheck current authority and immutable source/join evidence on retries.
                    if (canonical(t) !== retained) throw Error('acceptance receipt is not linked in current task');
                }
                await verifyAdmissionReadback(s, t, prior.type, target);
                return { kind: 'owned', claim: claimOf(t, s.head, target) };
            }
            const { task: t, type, payload: p } = await build(s);
            const receipt: OperationReceipt = { schemaVersion: 1, operationId, type, taskKey: t.taskKey, generation: t.generation, previousHead: s.head, requestDigest, resultOwner: ownerOf(t), recoveryPayload: p };
            const result = await bounded(target.provider.commit(target, { branchId: s.branchId, expectedHeadOid: s.head, files: filesFor(s, t, receipt), operationId })).catch(() => ({ kind: 'ambiguous' as const, reason: 'mutation response timed out' }));
            if (result.kind === 'refused')
                return { kind: 'refused', reason: result.reason };
            if (result.kind === 'committed' || result.kind === 'ambiguous') {
                try {
                    const current = await readCoordination(target), got = await receiptAt(target, current.head, operationId), task = current.tasks[t.taskKey] ?? parse<TaskRecord>(await pinnedJson(target, current.head, taskPath(t.taskKey), 256 * 1024), recordSchema, 'completed task');
                    if (got && canonical(got) === canonical(receipt) && owns(task, claimOf(t, s.head, target))) {
                        await verifyAdmissionReadback(current, task, type, target);
                        return { kind: 'owned', claim: claimOf(task, current.head, target) };
                    }
                    if (got)
                        return { kind: 'refused', reason: 'receipt/current ownership mismatch' };
                }
                catch {
                    return { kind: 'ambiguous', reason: 'receipt/current owner readback unavailable' };
                }
                if (result.kind === 'ambiguous')
                    return { kind: 'ambiguous', reason: 'remote mutation outcome unresolved; retained intent' };
                return { kind: 'refused', reason: 'acknowledged commit lacks matching receipt' };
            }
            const delay = Math.max(result.retryAfterMs ?? 0, [250, 500, 1000][attempt]! * (0.75 + (target.random?.() ?? Math.random()) / 2));
            if (Date.now() + delay >= deadline)
                return { kind: 'busy', reason: 'coordination backoff exceeds this transaction window' };
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        catch (error) {
            if (error instanceof CoordinationRateLimit) {
                if (Date.now() + error.retryAfterMs >= deadline)
                    return { kind: 'busy', reason: 'coordination rate-limit delay exceeds this transaction window' };
                await new Promise(resolve => setTimeout(resolve, error.retryAfterMs));
                continue;
            }
            return { kind: /busy|maxRuns|capacity|another session/.test((error as Error).message) ? 'busy' : 'refused', reason: (error as Error).message };
        }
    }
    return { kind: 'busy', reason: 'conditional claim contention; retry on a later tick' };
}
export async function acquireSharedTask(input: {
    machine: EffectiveMachine;
    session: MachineSession;
    candidate: VerifiedCandidate;
    operationId: string;
}): Promise<SharedClaimResult> {
    const { machine, session, candidate: c, operationId } = input, target = session.target;
    try {
        if (!uuid(operationId)) throw Error('invalid operation ID');
        validateSession(machine, session, target);
        validateParentBinding(c);
        await target.verifyCandidate(c, machine, session);
        const key = taskKey(c.host, c.repositoryNodeId, c.issueNodeId);
        if (!c.approvalBindings.length || !c.approvedTaskIds.length)
            throw Error('candidate lacks exact approved authority/task scope');
        if (c.host !== target.host || !machine.allowedRepositories.includes(c.repo) || machine.repositoryIds[c.repo] !== c.repositoryNodeId)
            throw Error('candidate outside verified machine repositories');
        const intentPath = localPath(target, `intent-${operationId}.json`);
        let ownerToken: string = randomUUID();
        const intentGuard = await acquireClaim(intentPath + '.lock', await processIdentity());
        if (intentGuard.kind !== 'owned') throw Error(intentGuard.reason);
        try {
            try {
                const stat = await lstat(intentPath);
                if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 8192) throw Error('unsafe prepared intent');
                const existing = parse<{ operationId: string; taskKey: string; ownerToken: string; sessionId: string; candidateDigest: string }>(JSON.parse(await readFile(intentPath, 'utf8')), closed({ operationId: uuid, taskKey: digest, ownerToken: uuid, sessionId: uuid, candidateDigest: digest }), 'prepared intent', 8192);
                if (existing.operationId !== operationId || existing.taskKey !== key || existing.sessionId !== session.sessionId || existing.candidateDigest !== sha256(canonical(c))) throw Error('prepared intent mismatch');
                ownerToken = existing.ownerToken;
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            await privateWrite(intentPath, { operationId, taskKey: key, ownerToken, sessionId: session.sessionId, candidateDigest: sha256(canonical(c)) });
        } finally { await releaseClaim(intentGuard.claim); }
        return await transact(target, operationId, async (s) => {
            await target.verifyCandidate(c, machine, session);
            const oldRaw = s.tasks[key] ?? await pinnedJson(target, s.head, taskPath(key), 256 * 1024);
            const old = oldRaw ? parse<TaskRecord>(oldRaw, recordSchema, 'prior task') : null;
            if (old && (old.state !== 'completed' || old.scopeDigest === c.scopeDigest || old.approvalDigest === c.approvalDigest || old.runId === c.runId))
                throw Error('task already recorded; explicit verified transfer/new intent required');
            if (old) {
                if (!old.stopProof)
                    throw Error('prior completed execution lacks stop proof');
                await verifyStop(target, old, old.stopProof);
            }
            const t: TaskRecord = { schemaVersion: 1, taskKey: key, host: c.host, repo: c.repo, issue: c.issue, repositoryNodeId: c.repositoryNodeId, issueNodeId: c.issueNodeId, scopeDigest: c.scopeDigest, approvalDigest: c.approvalDigest, approvalBindings: c.approvalBindings, generation: old ? old.generation + 1 : 1, machineId: machine.id, installationId: machine.installationId, sessionId: session.sessionId, ownerToken, runId: c.runId, stage: c.stage, state: 'claimed', paths: c.paths, resources: c.resources, independent: c.independent, parentTaskKey: c.parentTaskKey, parentBinding: c.parentBinding ?? null, approvedTaskIds: c.approvedTaskIds, checkpoint: null, stopProof: null, unresolvedEffects: [], recovery: null, acceptedScopes: old?.acceptedScopes ?? [] };
            parse(t, recordSchema, 'candidate task');
            await reserve(s, t, machine, session, target);
            return { task: t, type: 'acquire', payload: null };
        }, undefined, sha256(canonical({ candidate: c, machineId: machine.id, sessionId: session.sessionId, ownerToken })));
    }
    catch (error) {
        return { kind: 'refused', reason: (error as Error).message };
    }
}
export async function resolveEvidence(target: CoordinationTarget, ref: EvidenceRef): Promise<RecoveryEvidencePayload | null> {
    parseEvidenceRef(ref);
    if (ref.kind === 'github-comment') {
        await target.verifyEvidence(ref, null);
        return null;
    }
    return (await readEvidenceReceipt(target, ref)).recoveryPayload;
}
async function readImmutableOperationReceipt(target: CoordinationTarget, ref: Extract<EvidenceRef, { kind: 'state-receipt' }>, total?: { bytes: number }): Promise<OperationReceipt> {
    parseEvidenceRef(ref);
    const current = await bounded(target.provider.branch(target));
    if (current.repositoryId !== target.repositoryId || !current.private || ![target.rootCommit, ref.commitSha].every(v => sha(v)) || !['ahead', 'identical'].includes(await bounded(target.provider.compare(target, target.rootCommit, ref.commitSha))) || !['ahead', 'identical'].includes(await bounded(target.provider.compare(target, ref.commitSha, current.head))))
        throw Error('evidence is outside verified state-branch ancestry');
    const raw = await bounded(target.provider.read(target, ref.commitSha, operationPath(ref.operationId)));
    if (raw === null || Buffer.byteLength(raw) > 32 * 1024 || sha256(raw) !== ref.blobSha256)
        throw Error('immutable evidence blob missing or changed');
    if (total && (total.bytes += Buffer.byteLength(raw)) > 8 * 1024 * 1024) throw Error('coordination payload bound exceeded');
    const budget = transactionClock.getStore();
    if (budget && (budget.decodedBytes += Buffer.byteLength(raw)) > 8 * 1024 * 1024) throw Error('total decoded transaction read bound exceeded');
    const receipt = parse<OperationReceipt>(JSON.parse(raw), receiptSchema, 'evidence receipt', 32 * 1024);
    if (receipt.operationId !== ref.operationId)
        throw Error('evidence receipt identity/payload mismatch');
    return receipt;
}
async function readEvidenceReceipt(target: CoordinationTarget, ref: Extract<EvidenceRef, { kind: 'state-receipt' }>, total?: { bytes: number }): Promise<OperationReceipt> {
    const receipt = await readImmutableOperationReceipt(target, ref, total);
    if (receipt.recoveryPayload === null)
        throw Error('evidence receipt identity/payload mismatch');
    const p = parseRecoveryPayload(receipt.recoveryPayload);
    await target.verifyEvidence(ref, p);
    return receipt;
}
async function validateRemoteRecovery(target: CoordinationTarget, e: RecoveryEnvelope, t: TaskRecord, requireCoverage = false) {
    parseRecoveryEnvelope(e);
    if (e.taskKey !== t.taskKey || e.runId !== t.runId || e.generation !== t.generation || e.scopeDigest !== t.scopeDigest || e.approvalDigest !== t.approvalDigest || canonical(e.approvalBindings) !== canonical(t.approvalBindings))
        throw Error('recovery differs from current task identity/authority');
    for (const a of e.approvalBindings)
        await resolveEvidence(target, a.source);
    const q = await resolveEvidence(target, e.execution.qualification);
    if (!q || q.kind !== 'execution-qualification' || q.harness !== e.execution.harness || q.harnessVersion !== e.execution.harnessVersion || q.model !== e.execution.model || q.effort !== e.execution.effort || q.accountRef !== e.execution.accountRef)
        throw Error('original execution qualification unavailable');
    for (const x of e.completed) {
        const a = await resolveEvidence(target, x.acceptance.evidence);
        if (!a || a.kind !== 'acceptance' || a.result !== 'passed' || a.taskId !== x.taskId || a.sourceSha !== x.headSha || a.runId !== e.runId || a.scopeDigest !== e.scopeDigest || a.validationId !== x.acceptance.validationId || a.commandDigest !== x.acceptance.commandDigest)
            throw Error('completed check identity mismatch');
    }
    for (const x of e.children) {
        const a = await resolveEvidence(target, x.acceptance.evidence);
        if (!a || a.kind !== 'acceptance' || a.result !== 'passed' || a.runId !== x.childRunId || a.sourceSha !== x.headSha || a.scopeDigest !== x.scopeDigest || x.checkpoint.headSha !== x.headSha || x.checkpoint.baseSha !== x.baseSha || x.checkpoint.runId !== x.childRunId || x.noChange !== (x.headSha === x.baseSha))
            throw Error('child acceptance mismatch');
    }
    for (const x of e.joins) {
        const p = await resolveEvidence(target, x.evidence);
        if (!p || p.kind !== 'join' || p.childRunId !== x.childRunId || p.generation !== x.generation || p.fromSha !== x.fromSha || p.parentBefore !== x.parentBefore || p.parentAfter !== x.parentAfter || p.state !== x.state)
            throw Error('join evidence mismatch');
        if (x.acceptance)
            await resolveEvidence(target, x.acceptance.evidence);
    }
    for (const x of e.effects) {
        const p = await resolveEvidence(target, x.intent);
        if (!p || p.kind !== 'effect-intent' || p.result !== 'prepared' || p.effectId !== x.operationId || p.runId !== x.runId || p.generation !== x.generation || p.effectKind !== x.kind || canonical(p.target) !== canonical(x.target) || p.payloadDigest !== x.payloadDigest || canonical(p.approvalBindings) !== canonical(e.approvalBindings))
            throw Error('prepared effect receipt mismatch');
        if (x.outcome) {
            const o = await resolveEvidence(target, x.outcome);
            if (!o || o.kind !== 'effect-outcome' || o.effectId !== p.effectId || o.runId !== p.runId || o.generation !== p.generation || o.effectKind !== p.effectKind || o.payloadDigest !== p.payloadDigest || canonical(o.target) !== canonical(p.target) || canonical(o.approvalBindings) !== canonical(p.approvalBindings) || o.result !== x.state)
                throw Error('effect outcome differs from prepared intent');
        }
    }
    // Reporting backlog remains validated and retained; it is not code/control work.
    const blockingEffects = e.effects.filter(x => x.kind !== 'telemetry-push' || x.target.kind !== 'telemetry');
    const coverage = e.remoteEffectCoverage;
    if (coverage.kind === 'qualified-managed-only') {
        const p = await resolveEvidence(target, coverage.qualification);
        if (!p || p.kind !== 'execution-qualification' || canonical(p) !== canonical(q) || p.result !== 'qualified' || !p.unmanagedDenied || !effectKinds.every(k => p.managedKinds.includes(k)))
            throw Error('managed coverage qualification mismatch');
    }
    else if (coverage.kind === 'reconciled') {
        const p = await resolveEvidence(target, coverage.evidence);
        if (!p || p.kind !== 'effect-reconciliation' || p.result !== 'complete' || p.runId !== e.runId || p.scopeDigest !== e.scopeDigest || canonical(p.approvalBindings) !== canonical(e.approvalBindings) || blockingEffects.some(x => !p.checkedEffectIds.includes(x.operationId)))
            throw Error('incomplete effect reconciliation');
    }
    else if (requireCoverage)
        throw Error('unmanaged remote effects possible; recovery blocked');
    if (requireCoverage && blockingEffects.some(x => x.state === 'prepared' || x.state === 'ambiguous'))
        throw Error('unresolved remote effects retain ownership');
}
async function verifyStop(target: CoordinationTarget, t: TaskRecord, proof: StopProof) {
    parseStopProof(proof);
    if (proof.machineId !== t.machineId || proof.installationId !== t.installationId || proof.sessionId !== t.sessionId || proof.generation !== t.generation || !proof.runIds.includes(t.runId))
        throw Error('stop proof owner/generation mismatch');
    const current = await bounded(target.provider.branch(target));
    const machine = parse<MachineRecord>(await pinnedJson(target, current.head, machinePath(proof.machineId), 256 * 1024), machineSchema, 'stop proof machine');
    if (machine.hostBindingDigest !== proof.hostBindingDigest || machine.sessionId === proof.sessionId && machine.bootIdDigest !== proof.bootIdDigest) throw Error('stop proof host/boot binding mismatch');
    await resolveEvidence(target, proof.evidenceRef);
}
function sameCandidate(task: TaskRecord, candidate: VerifiedCandidate): boolean {
    return task.taskKey === taskKey(candidate.host, candidate.repositoryNodeId, candidate.issueNodeId) &&
        canonical({ host: task.host, repo: task.repo, issue: task.issue, repositoryNodeId: task.repositoryNodeId, issueNodeId: task.issueNodeId,
            scopeDigest: task.scopeDigest, approvalDigest: task.approvalDigest, approvalBindings: task.approvalBindings, runId: task.runId,
            stage: task.stage, paths: task.paths, resources: task.resources, independent: task.independent, parentTaskKey: task.parentTaskKey,
            parentBinding: task.parentBinding ?? null, approvedTaskIds: task.approvedTaskIds }) ===
        canonical({ host: candidate.host, repo: candidate.repo, issue: candidate.issue, repositoryNodeId: candidate.repositoryNodeId,
            issueNodeId: candidate.issueNodeId, scopeDigest: candidate.scopeDigest, approvalDigest: candidate.approvalDigest,
            approvalBindings: candidate.approvalBindings, runId: candidate.runId, stage: candidate.stage, paths: candidate.paths,
            resources: candidate.resources, independent: candidate.independent, parentTaskKey: candidate.parentTaskKey,
            parentBinding: candidate.parentBinding ?? null, approvedTaskIds: candidate.approvedTaskIds });
}
function groupFilesFor(snapshot: CoordinationSnapshot, tasks: TaskRecordV2[], machines: Set<string>, receipt: GroupSuccessionReceipt): Record<string, string> {
    snapshot.index.revision++;
    parse(snapshot.index, indexSchema, 'index', 1024 * 1024);
    parse(receipt, groupReceiptSchema, 'group succession receipt', 32 * 1024);
    const files: Record<string, string> = {
        'coordination/index.json': canonical(snapshot.index),
        [operationPath(receipt.operationId)]: canonical(receipt),
    };
    for (const task of tasks) {
        parse(task, recordV2Schema, 'group successor task');
        files[taskPath(task.taskKey)] = canonical(task);
    }
    for (const machineId of machines) {
        const machine = snapshot.machines[machineId];
        if (!machine) throw Error('affected group machine missing');
        parse(machine, machineSchema, 'group machine');
        files[machinePath(machineId)] = canonical(machine);
    }
    if (Object.values(files).reduce((sum, value) => sum + Buffer.byteLength(value), 0) > 8 * 1024 * 1024)
        throw Error('transaction size exceeded');
    return files;
}
function groupOwnedResult(target: CoordinationTarget, snapshot: CoordinationSnapshot, receipt: GroupSuccessionReceipt, reference: Extract<EvidenceRef, { kind: 'state-receipt' }>): GroupSuccessionResult {
    const members = receipt.members.map(row => snapshot.tasks[row.after.taskKey]);
    if (members.some((task, index) => !task || canonical(bindingOf(task!)) !== canonical(receipt.members[index]!.after)))
        return { kind: 'refused', reason: 'group receipt no longer owns every current member' };
    const parent = members.find(task => task!.taskKey === receipt.parentTaskKey)!;
    return { kind: 'owned', parent: claimOf(parent!, snapshot.head, target), children: members.filter(task => task!.taskKey !== receipt.parentTaskKey).map(task => claimOf(task!, snapshot.head, target)), reference };
}
async function validateStoppedGroupReadback(input: {
    target: CoordinationTarget;
    snapshot: CoordinationSnapshot;
    found: { receipt: GroupSuccessionReceipt; raw: string };
    request: GroupSuccessionRequest;
    machine: EffectiveMachine;
    session: MachineSession;
    requestDigest: string;
    receiver: GroupSuccessionReceipt['receiver'];
}): Promise<GroupSuccessionResult> {
    const { target, snapshot, found, request, machine, session, requestDigest, receiver } = input;
    if (found.receipt.requestDigest !== requestDigest || canonical(found.receipt.receiver) !== canonical(receiver))
        throw Error('operation ID reused for different group succession');
    const total = { bytes: 0 }, rows = await validateGroupReceipt(target, snapshot, found.receipt, total);
    if (!target.verifyGroupSuccession) throw Error('trusted stopped-group verifier unavailable');
    const predecessor = await readCoordinationSnapshot(target, false, total, found.receipt.previousHead);
    for (let index = 0; index < request.members.length; index++) {
        const member = request.members[index]!, task = rows[index]?.before;
        if (!task || canonical(bindingOf(task)) !== canonical(member.expected) || !sameCandidate(task, member.candidate))
            throw Error('group receipt request/member scope differs');
        await target.verifyCandidate(member.candidate, machine, session);
        if (task.state === 'recovery-queued') await verifyRecoveryQueued(predecessor, task, target);
        else {
            if (!['stopped', 'blocked'].includes(task.state) || !task.stopProof) throw Error('group receipt predecessor is not stopped');
            await bounded(target.verifyTransition(structuredClone(task), { kind: 'stop', stopProof: structuredClone(task.stopProof) }));
            await verifyStop(target, task, task.stopProof);
        }
        if (!task.checkpoint || !task.recovery || canonical(task.checkpoint) !== canonical(task.recovery.checkpoint)) throw Error('group receipt predecessor recovery unavailable');
        await validateRemoteRecovery(target, task.recovery, task, true);
    }
    const parent = rows.find(row => row.before.taskKey === request.parentTaskKey)?.before;
    if (!parent) throw Error('group receipt parent unavailable');
    const verified = await bounded(target.verifyGroupSuccession({ parent: structuredClone(parent), members: rows.map((row, index) => ({ task: structuredClone(row.before), candidate: structuredClone(request.members[index]!.candidate) })), groupPlan: structuredClone(request.groupPlan), groupsDigest: request.groupsDigest, machine, session }));
    if (!closed({ maxChildren: positive })(verified) || verified.maxChildren > 3) throw Error('approved group child limit must be an integer from 1 to 3');
    const reference = { kind: 'state-receipt' as const, operationId: request.operationId, commitSha: snapshot.head, blobSha256: sha256(found.raw) };
    const owned = groupOwnedResult(target, snapshot, found.receipt, reference);
    if (owned.kind !== 'owned') throw Error(owned.reason);
    return owned;
}
export async function recoverStoppedGroup(input: { machine: EffectiveMachine; session: MachineSession; request: GroupSuccessionRequest }): Promise<GroupSuccessionResult> {
    const { machine, session, request } = input, target = session.target;
    return transactionClock.run({ deadline: Date.now() + 45000, decodedBytes: 0 }, async () => {
        try {
            if (!groupRequestSchema(request) || request.members.length < 2 || request.members.length > 17 || request.groupPlan.kind !== 'plan')
                throw Error('invalid stopped-group succession request');
            const keys = request.members.map(row => row.expected.taskKey);
            if (canonical(keys) !== canonical([...keys].sort()) || new Set(keys).size !== keys.length ||
                new Set(request.members.map(row => row.expected.runId)).size !== request.members.length ||
                new Set(request.members.map(row => row.candidate.issueNodeId)).size !== request.members.length)
                throw Error('group members must be sorted and unique');
            validateSession(machine, session, target);
            if (machine.defaults.recovery !== 'verified-transfer' || !positive(machine.defaults.childConcurrent) || machine.defaults.childConcurrent > 3)
                throw Error('machine recovery/capacity policy forbids group succession');
            const receiver = { machineId: machine.id, installationId: machine.installationId, sessionId: session.sessionId, hostBindingDigest: session.hostBindingDigest, bootIdDigest: session.bootIdDigest };
            const requestDigest = sha256(canonical({ request, receiver }));
            const intentPath = localPath(target, `group-intent-${request.operationId}.json`);
            let intent: { operationId: string; requestDigest: string; receiver: typeof receiver; transferredAt: string; tokens: Array<{ taskKey: string; ownerToken: string }> };
            const intentSchema = closed({ operationId: uuid, requestDigest: digest, receiver: receiverSchema, transferredAt: date, tokens: unique(closed({ taskKey: digest, ownerToken: uuid })) });
            const intentGuard = await acquireClaim(intentPath + '.lock', await processIdentity());
            if (intentGuard.kind !== 'owned') throw Error(intentGuard.reason);
            try {
                try {
                    const stat = await lstat(intentPath);
                    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 32 * 1024) throw Error('unsafe prepared group intent');
                    intent = parse(JSON.parse(await readFile(intentPath, 'utf8')), intentSchema, 'prepared group intent', 32 * 1024);
                    if (intent.operationId !== request.operationId || intent.requestDigest !== requestDigest || canonical(intent.receiver) !== canonical(receiver) || canonical(intent.tokens.map(row => row.taskKey)) !== canonical(keys))
                        throw Error('prepared group intent mismatch');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    intent = { operationId: request.operationId, requestDigest, receiver, transferredAt: new Date(target.now?.() ?? Date.now()).toISOString(), tokens: keys.map(taskKey => ({ taskKey, ownerToken: randomUUID() })) };
                }
                await privateWrite(intentPath, intent!);
            } finally { await releaseClaim(intentGuard.claim); }

            const current = await readCoordination(target), existing = await groupReceiptAt(target, current.head, request.operationId);
            if (existing) {
                return await validateStoppedGroupReadback({ target, snapshot: current, found: existing, request, machine, session, requestDigest, receiver });
            }
            if (current.head !== request.expectedHead) return { kind: 'busy', reason: 'expected group head changed; prepare the complete set again' };
            const expectedKeys = [request.parentTaskKey, ...current.index.active.filter(row => row.parentTaskKey === request.parentTaskKey).map(row => row.taskKey)].sort();
            if (canonical(expectedKeys) !== canonical(keys)) throw Error('group request omitted or added a retained member');
            const rows: Array<{ task: TaskRecord; candidate: VerifiedCandidate; previousSuccession: Extract<EvidenceRef, { kind: 'state-receipt' }> | null }> = [];
            for (const member of request.members) {
                const task = current.tasks[member.expected.taskKey];
                if (!task || canonical(bindingOf(task)) !== canonical(member.expected) || !sameCandidate(task, member.candidate))
                    throw Error('group member current owner/scope differs');
                if (task.taskKey === request.parentTaskKey ? task.parentTaskKey !== null : task.parentTaskKey !== request.parentTaskKey || task.parentBinding == null)
                    throw Error('group must contain one top-level parent and direct retained children');
                if (task.host !== target.host || !machine.allowedRepositories.includes(task.repo) || machine.repositoryIds[task.repo] !== task.repositoryNodeId)
                    throw Error('group member outside verified machine repositories');
                await target.verifyCandidate(member.candidate, machine, session);
                let previousSuccession: Extract<EvidenceRef, { kind: 'state-receipt' }> | null = null;
                if (task.schemaVersion === 2) {
                    const previous = await groupReceiptAt(target, current.head, task.successionOperationId);
                    if (!previous) throw Error('prior group succession receipt unavailable');
                    const priorRows = await validateGroupReceipt(target, current, previous.receipt, { bytes: 0 });
                    const priorMember = priorRows.find(row => row.after.taskKey === task.taskKey);
                    if (!priorMember) throw Error('prior group succession member unavailable');
                    await validateOwnershipProgression(target, priorMember.after, task, current.head, { bytes: 0 });
                    previousSuccession = { kind: 'state-receipt', operationId: task.successionOperationId, commitSha: current.head, blobSha256: sha256(previous.raw) };
                }
                if (task.state === 'recovery-queued') await verifyRecoveryQueued(current, task, target);
                else {
                    if (!['stopped', 'blocked'].includes(task.state) || !task.stopProof) throw Error('every group member must be verified stopped');
                    await bounded(target.verifyTransition(structuredClone(task), { kind: 'stop', stopProof: structuredClone(task.stopProof) }));
                    await verifyStop(target, task, task.stopProof);
                }
                if (!task.checkpoint || !task.recovery || canonical(task.checkpoint) !== canonical(task.recovery.checkpoint))
                    throw Error('group member checkpoint/recovery unavailable');
                await validateRemoteRecovery(target, task.recovery, task, true);
                rows.push({ task, candidate: member.candidate, previousSuccession });
            }
            if (!target.verifyGroupSuccession) throw Error('trusted stopped-group verifier unavailable');
            const parent = rows.find(row => row.task.taskKey === request.parentTaskKey)!.task;
            const group = await bounded(target.verifyGroupSuccession({ parent: structuredClone(parent), members: rows.map(row => ({ task: structuredClone(row.task), candidate: structuredClone(row.candidate) })), groupPlan: structuredClone(request.groupPlan), groupsDigest: request.groupsDigest, machine, session }));
            if (!closed({ maxChildren: positive })(group) || group.maxChildren > 3) throw Error('approved group child limit must be an integer from 1 to 3');
            const memberKeys = new Set(keys), nonmembers = current.index.active.filter(row => !memberKeys.has(row.taskKey));
            if (nonmembers.filter(row => row.machineId === machine.id && row.parentTaskKey === null).length + 1 > machine.defaults.maxRuns)
                throw Error('machine at maxRuns');
            if (rows.some(row => nonmembers.some(other => conflicting(summaryOf(row.task), other))))
                throw Error('incompatible nonmember resource reservation busy');
            for (let index = 0; index < rows.length; index++) for (let other = index + 1; other < rows.length; other++) {
                const a = rows[index]!.task, b = rows[other]!.task;
                if (a.taskKey !== b.parentTaskKey && b.taskKey !== a.parentTaskKey && conflicting(summaryOf(a), summaryOf(b)))
                    throw Error('incompatible sibling resource reservation busy');
            }
            const receiverMachine = current.machines[machine.id];
            if (receiverMachine && (receiverMachine.installationId !== machine.installationId || receiverMachine.hostBindingDigest !== machine.hostBindingDigest))
                throw Error('registered machine installation/host mismatch');
            if (receiverMachine?.sessionId !== undefined && receiverMachine.sessionId !== session.sessionId) {
                if (!target.verifySession) throw Error('registered machine already has another session; verified session reconciliation required');
                await target.verifySession(receiverMachine, machine, session);
                for (const task of Object.values(current.tasks).filter(task => task.machineId === machine.id && !memberKeys.has(task.taskKey))) {
                    if (!['stopped', 'blocked'].includes(task.state) || !task.stopProof) throw Error('prior machine execution stop remains unknown');
                    await verifyStop(target, task, task.stopProof);
                }
            }
            if (Object.values(current.machines).some(row => row.machineId !== machine.id && row.hostBindingDigest === machine.hostBindingDigest))
                throw Error('host binding already reserved');
            const receiptBase = { operationId: request.operationId, parentTaskKey: request.parentTaskKey, receiver };
            const nextTasks = rows.map(row => groupSuccessor(row.task, receiptBase, { ...bindingOf(row.task), machineId: machine.id, installationId: machine.installationId, sessionId: session.sessionId, ownerToken: intent!.tokens.find(token => token.taskKey === row.task.taskKey)!.ownerToken, generation: row.task.generation + 1 }));
            const receipt: GroupSuccessionReceipt = { schemaVersion: 2, type: 'group-succession', operationId: request.operationId, parentTaskKey: request.parentTaskKey, previousHead: current.head, requestDigest, groupPlan: request.groupPlan, groupsDigest: request.groupsDigest, transferredAt: intent!.transferredAt, receiver,
                members: rows.map((row, index) => ({ before: bindingOf(row.task), after: bindingOf(nextTasks[index]!), beforeTaskSha256: sha256(canonical(row.task)), afterTaskSha256: sha256(canonical(nextTasks[index]!)), previousSuccession: row.previousSuccession })) };
            const affectedMachines = new Set<string>([machine.id]);
            for (const row of rows) affectedMachines.add(row.task.machineId);
            for (const machineId of affectedMachines) {
                const machineRow = current.machines[machineId];
                if (machineRow) machineRow.activeTaskKeys = machineRow.activeTaskKeys.filter(key => !memberKeys.has(key));
            }
            current.index.active = current.index.active.map(row => memberKeys.has(row.taskKey) ? { ...row, machineId: machine.id } : row);
            for (const task of nextTasks) current.tasks[task.taskKey] = task;
            current.machines[machine.id] = { schemaVersion: 1, machineId: machine.id, installationId: machine.installationId, sessionId: session.sessionId, hostBindingDigest: session.hostBindingDigest, bootIdDigest: session.bootIdDigest, observedAt: intent!.transferredAt, activeTaskKeys: current.index.active.filter(row => row.machineId === machine.id).map(row => row.taskKey) };
            if (!current.index.machines.includes(machine.id)) current.index.machines.push(machine.id);
            const result = await bounded(target.provider.commit(target, { branchId: current.branchId, expectedHeadOid: current.head, files: groupFilesFor(current, nextTasks, affectedMachines, receipt), operationId: request.operationId })).catch(() => ({ kind: 'ambiguous' as const, reason: 'mutation response timed out' }));
            if (result.kind === 'conflict') return { kind: 'busy', reason: 'expected group head changed; prepare the complete set again' };
            if (result.kind === 'refused') return { kind: 'refused', reason: result.reason };
            try {
                const readback = await readCoordination(target), found = await groupReceiptAt(target, readback.head, request.operationId);
                if (!found || canonical(found.receipt) !== canonical(receipt)) throw Error('group receipt readback differs');
                return await validateStoppedGroupReadback({ target, snapshot: readback, found, request, machine, session, requestDigest, receiver });
            } catch {
                return { kind: 'ambiguous', reason: 'group receipt/current owner readback unavailable' };
            }
        } catch (error) {
            return { kind: /busy|maxRuns|capacity|another session|expected group head/.test((error as Error).message) ? 'busy' : 'refused', reason: (error as Error).message };
        }
    });
}
export async function transitionSharedTask(input: {
    claim: SharedClaim;
    operationId: string;
    transition: TaskTransition;
}): Promise<SharedClaimResult> {
    const { claim, operationId, transition } = input, target = claim.target;
    if (!transition || !['start', 'checkpoint', 'stop', 'block', 'complete', 'accept-scope', 'handoff', 'recovery', 'receipt', 'effect-send'].includes(transition.kind))
        return { kind: 'refused', reason: 'unsupported task transition kind' };
    const requestDigest = sha256(canonical(transition.kind === 'handoff' ? { ...transition, session: { machineId: transition.session.machineId, sessionId: transition.session.sessionId, installationId: transition.session.installationId, hostBindingDigest: transition.session.hostBindingDigest, bootIdDigest: transition.session.bootIdDigest } } : transition));
    return transact(target, operationId, async (s) => {
        const t = s.tasks[claim.taskKey];
        if (!t || !owns(t, claim))
            throw Error('wrong current owner; transition refused');
        await target.verifyTransition(t, transition);
        if (['complete', 'handoff'].includes(transition.kind) && s.index.active.some(row => row.parentTaskKey === t.taskKey))
            throw Error('active child reservations retain parent ownership');
        let recoveryPayload: RecoveryEvidencePayload | null = null;
        if (transition.kind === 'receipt')
            recoveryPayload = parseRecoveryPayload(transition.payload);
        else if (transition.kind === 'effect-send') {
            if (!t.recovery)
                throw Error('acknowledged intent envelope required');
            await validateRemoteRecovery(target, t.recovery, t);
            const effect = t.recovery.effects.find(x => x.operationId === transition.effectId);
            if (!effect || effect.state !== 'prepared')
                throw Error('effect send already reserved or intent missing');
            effect.state = 'ambiguous';
        }
        else if (transition.kind === 'start') {
            if (t.state !== 'claimed' && !(t.schemaVersion === 2 && t.state === 'recovery-queued'))
                throw Error('task cannot start from current state');
            await verifyChildAdmission(s, t, target);
            t.state = 'running';
            if (t.schemaVersion === 2) t.stopProof = null;
        }
        else if (transition.kind === 'stop' || transition.kind === 'block') {
            if (transition.stopProof)
                await verifyStop(target, t, transition.stopProof);
            if (transition.kind === 'stop' && !transition.stopProof)
                throw Error('stopped state needs verified stop proof');
            t.stopProof = transition.stopProof;
            t.state = transition.kind === 'stop' ? 'stopped' : 'blocked';
        }
        else if (transition.kind === 'recovery' || transition.kind === 'checkpoint') {
            const e = parseRecoveryEnvelope(transition.recovery);
            await validateRemoteRecovery(target, e, t);
            if (t.recovery) {
                if (canonical(t.recovery.execution) !== canonical(e.execution))
                    throw Error('original execution identity cannot change');
                for (const old of t.recovery.effects) {
                    const next = e.effects.find(x => x.operationId === old.operationId);
                    if (!next || canonical({ ...old, state: next.state, outcome: next.outcome }) !== canonical(next) || old.state !== 'prepared' && next.state === 'prepared' || old.outcome && canonical(old) !== canonical(next))
                        throw Error('effect history cannot be removed, changed or replayed');
                }
                for (const done of t.recovery.completed)
                    if (!e.completed.some(x => canonical(x) === canonical(done)))
                        throw Error('completed work cannot be removed or replayed');
            }
            t.recovery = e;
            if (transition.kind === 'checkpoint') {
                const c = parseCheckpointRef(transition.checkpoint);
                if (c.runId !== t.runId || c.scopeDigest !== t.scopeDigest || c.repo !== t.repo || c.repositoryId !== t.repositoryNodeId || canonical(c) !== canonical(e.checkpoint))
                    throw Error('checkpoint identity mismatch');
                t.checkpoint = c;
            }
        }
        else if (transition.kind === 'accept-scope') {
            const receipt = await readEvidenceReceipt(target, transition.acceptedScope);
            const p = receipt.recoveryPayload;
            if (receipt.taskKey !== t.taskKey || receipt.generation !== t.generation || canonical(receipt.resultOwner) !== canonical(ownerOf(t)) || !p || p.kind !== 'acceptance' || p.result !== 'passed' || p.runId !== t.runId || p.scopeDigest !== t.scopeDigest || !p.acceptedScope)
                throw Error('current owner acceptance unavailable');
            const accepted = parseAcceptedScope(p.acceptedScope);
            if (accepted.repo !== t.repo || accepted.issue !== t.issue || canonical([...accepted.approvedTaskIds].sort()) !== canonical([...t.approvedTaskIds].sort()) || !accepted.completedTaskIds.length || !accepted.completedTaskIds.includes(p.taskId) || canonical(accepted.approvalBindings) !== canonical(t.approvalBindings))
                throw Error('foreign or mismatched accepted scope');
            for (const authority of t.approvalBindings) await resolveEvidence(target, authority.source);
            // The injected evidence/transition verifiers authorize the actual
            // reviewed source and parent join; decoded payloads grant no authority.
            const link = { scopeDigest: t.scopeDigest, receipt: transition.acceptedScope };
            if (!t.acceptedScopes.some(x => canonical(x) === canonical(link))) t.acceptedScopes.push(link);
        }
        else if (transition.kind === 'complete') {
            await verifyStop(target, t, transition.stopProof);
            if (!t.recovery)
                throw Error('completion needs remotely verified recovery envelope');
            await validateRemoteRecovery(target, t.recovery, t, true);
            const p = await resolveEvidence(target, transition.acceptedScope);
            if (!p || p.kind !== 'acceptance' || p.result !== 'passed' || p.runId !== t.runId || p.scopeDigest !== t.scopeDigest || !p.acceptedScope)
                throw Error('completion acceptance unavailable');
            const accepted = parseAcceptedScope(p.acceptedScope);
            if (accepted.repo !== t.repo || accepted.issue !== t.issue || canonical([...accepted.approvedTaskIds].sort()) !== canonical([...t.approvedTaskIds].sort()) || canonical([...accepted.completedTaskIds].sort()) !== canonical([...t.approvedTaskIds].sort()) || canonical(accepted.approvalBindings) !== canonical(t.approvalBindings))
                throw Error('partial or foreign acceptance cannot complete task');
            const link = { scopeDigest: t.scopeDigest, receipt: transition.acceptedScope };
            if (!t.acceptedScopes.some(x => canonical(x) === canonical(link))) t.acceptedScopes.push(link);
            t.stopProof = transition.stopProof;
            t.state = 'completed';
            s.index.active = s.index.active.filter(x => x.taskKey !== t.taskKey);
            s.machines[t.machineId]!.activeTaskKeys = s.machines[t.machineId]!.activeTaskKeys.filter(k => k !== t.taskKey);
        }
        else if (transition.kind === 'handoff') {
            if (transition.machine.defaults.recovery !== 'verified-transfer')
                throw Error('machine recovery policy forbids transfer');
            await verifyStop(target, t, transition.stopProof);
            if (!t.checkpoint || !transition.recovery.checkpoint || canonical(t.checkpoint) !== canonical(transition.recovery.checkpoint))
                throw Error('verified remotely available checkpoint required');
            await validateRemoteRecovery(target, transition.recovery, t, true);
            validateSession(transition.machine, transition.session, target);
            await target.verifyCandidate(transition.candidate, transition.machine, transition.session);
            const c = transition.candidate;
            if (taskKey(c.host, c.repositoryNodeId, c.issueNodeId) !== t.taskKey || c.scopeDigest !== t.scopeDigest || c.approvalDigest !== t.approvalDigest || canonical(c.approvalBindings) !== canonical(t.approvalBindings) || c.parentTaskKey !== t.parentTaskKey || canonical(c.parentBinding ?? null) !== canonical(t.parentBinding ?? null))
                throw Error('handoff must preserve verified original scope and parent binding');
            const previousMachineId = t.machineId;
            // Keep the stopped predecessor and its machine reservation intact while
            // reserve verifies every task belonging to the previous session.
            const successor: TaskRecord = { ...t, machineId: transition.machine.id, installationId: transition.machine.installationId,
                sessionId: transition.session.sessionId, generation: t.generation + 1, ownerToken: randomUUID(),
                state: 'claimed', stopProof: transition.stopProof,
                recovery: { ...transition.recovery, generation: t.generation + 1 } };
            await reserve(s, successor, transition.machine, transition.session, target, true);
            if (previousMachineId !== successor.machineId)
                s.machines[previousMachineId]!.activeTaskKeys = s.machines[previousMachineId]!.activeTaskKeys.filter(k => k !== t.taskKey);
            return { task: successor, type: transition.kind, payload: recoveryPayload };
        }
        return { task: t, type: transition.kind, payload: recoveryPayload };
    }, claim, requestDigest);
}
export async function linkAcceptedScope(input: {
    claim: SharedClaim;
    operationId: string;
    acceptedScope: Extract<EvidenceRef, { kind: 'state-receipt' }>;
}): Promise<SharedClaimResult> {
    return transitionSharedTask({ claim: input.claim, operationId: input.operationId, transition: { kind: 'accept-scope', acceptedScope: input.acceptedScope } });
}

export async function publishRecoveryReceipt(input: {
    claim: SharedClaim;
    operationId: string;
    payload: RecoveryEvidencePayload;
}): Promise<{
    claim: SharedClaim;
    reference: Extract<EvidenceRef, {
        kind: 'state-receipt';
    }>;
}> {
    const result = await transitionSharedTask({ claim: input.claim, operationId: input.operationId, transition: { kind: 'receipt', payload: input.payload } });
    if (result.kind !== 'owned')
        throw Error(result.reason);
    const raw = await bounded(input.claim.target.provider.read(input.claim.target, result.claim.stateCommit, operationPath(input.operationId)));
    if (raw === null)
        throw Error('published receipt readback unavailable');
    const reference = { kind: 'state-receipt' as const, operationId: input.operationId, commitSha: result.claim.stateCommit, blobSha256: sha256(raw) };
    await resolveEvidence(input.claim.target, reference);
    // Caller must link this reference through a separate transition, never infer authority here.
    return { claim: result.claim, reference };
}
export async function verifyManagedEffect(claim: SharedClaim, effectId: string): Promise<EffectRef> {
    const s = await readCoordination(claim.target), t = s.tasks[claim.taskKey];
    if (!t || !owns(t, claim) || !t.recovery)
        throw Error('current owner and acknowledged intent envelope required');
    await claim.target.verifyTransition(t, { kind: 'recovery', recovery: t.recovery });
    await validateRemoteRecovery(claim.target, t.recovery, t);
    // Unknown vendor effects retain completion/transfer barriers; this exact managed
    // intent is separately verified against current authority and ownership.
    const effect = t.recovery.effects.find(x => x.operationId === effectId);
    if (!effect || effect.state !== 'prepared')
        throw Error('effect not prepared or already sent; reconcile before retry');
    return effect;
}
const sharedStatusLimits = { pages: 4, pageSize: 25, requests: 256, milliseconds: 10000, pageBytes: 64 * 1024 } as const;
class StatusBoundExceeded extends Error {}
function statusTask(t: TaskRecord, head: string, coverage: SharedHistoryCoverage): SharedTaskStatus {
    if (t.checkpoint && (t.checkpoint.repo !== t.repo || t.checkpoint.repositoryId !== t.repositoryNodeId || t.checkpoint.runId !== t.runId || t.checkpoint.scopeDigest !== t.scopeDigest))
        throw Error('checkpoint task binding mismatch');
    return { taskKey: t.taskKey, repo: t.repo, issue: t.issue, state: t.state, machineId: t.machineId, generation: t.generation,
        sourceCommit: head, originMachineId: null, lastTransitionObservedAt: null,
        checkpoint: t.checkpoint ? { headSha: t.checkpoint.headSha, publishedAt: t.checkpoint.publishedAt, sourceCommit: head, availability: 'unknown' } : null,
        history: { coverage, events: [] } };
}
// Validate historical facts without invoking current authorization or effect verifiers.
function statusTransition(receipt: OperationReceipt, before: TaskRecord | null, after: TaskRecord): SharedTransitionKind {
    const kind = receipt.type;
    if (!['acquire', 'start', 'checkpoint', 'stop', 'handoff', 'complete', 'block', 'recovery', 'receipt', 'effect-send', 'accept-scope'].includes(kind) ||
        receipt.taskKey !== after.taskKey || receipt.generation !== after.generation || canonical(receipt.resultOwner) !== canonical(ownerOf(after)))
        throw Error('unverified status operation');
    if (kind === 'acquire') {
        if (after.state !== 'claimed' || after.generation !== (before ? before.generation + 1 : 1) || before && before.state !== 'completed' ||
            before && (before.taskKey !== after.taskKey || before.repositoryNodeId !== after.repositoryNodeId || before.issueNodeId !== after.issueNodeId))
            throw Error('unverified acquisition');
    } else {
        if (!before || before.state === 'completed') throw Error('missing original task');
        const changes: Record<string, string[]> = {
            start: before.schemaVersion === 2 ? ['state', 'stopProof'] : ['state'], stop: ['state', 'stopProof'], block: ['state', 'stopProof'],
            checkpoint: ['checkpoint', 'recovery'], recovery: ['recovery'], receipt: [],
            'effect-send': ['recovery'], 'accept-scope': ['acceptedScopes'], complete: ['state', 'stopProof', 'acceptedScopes'],
            handoff: ['machineId', 'installationId', 'sessionId', 'generation', 'ownerToken', 'state', 'stopProof', 'recovery'],
        };
        const changed = new Set(changes[kind]);
        for (const field of new Set([...Object.keys(before), ...Object.keys(after)]))
            if (!changed.has(field) && canonical(before[field as keyof TaskRecord] ?? null) !== canonical(after[field as keyof TaskRecord] ?? null))
                throw Error('unverified task mutation');
        if (['handoff', 'stop', 'complete'].includes(kind) || kind === 'block' && after.stopProof) {
            const proof = after.stopProof;
            if (!proof || proof.machineId !== before.machineId || proof.installationId !== before.installationId || proof.sessionId !== before.sessionId || proof.generation !== before.generation || !proof.runIds.includes(before.runId))
                throw Error('historical stop owner mismatch');
        }
        if (kind === 'handoff') {
            if (after.state !== 'claimed' || after.generation !== before.generation + 1 || after.ownerToken === before.ownerToken || !after.stopProof || !before.checkpoint ||
                !after.recovery || after.recovery.generation !== after.generation)
                throw Error('unverified handoff');
        } else if (canonical(ownerOf(before)) !== canonical(ownerOf(after)) || before.generation !== after.generation) throw Error('unexpected owner change');
        if (kind === 'start' && ((before.state !== 'claimed' && !(before.schemaVersion === 2 && before.state === 'recovery-queued')) || after.state !== 'running' || before.schemaVersion === 2 && after.stopProof !== null) ||
            kind === 'stop' && (after.state !== 'stopped' || !after.stopProof) || kind === 'block' && after.state !== 'blocked' ||
            kind === 'complete' && (after.state !== 'completed' || !after.stopProof) ||
            kind === 'checkpoint' && (!after.checkpoint || canonical(after.checkpoint) !== canonical(after.recovery?.checkpoint ?? null)))
            throw Error('unverified task state');
    }
    if (kind === 'receipt' ? receipt.recoveryPayload === null : receipt.recoveryPayload !== null) throw Error('unexpected operation payload');
    if (receipt.recoveryPayload) parseRecoveryPayload(receipt.recoveryPayload);
    return kind as SharedTransitionKind;
}
export async function readSharedStatus(target: CoordinationTarget, allowedRepos: string[]): Promise<SharedStatus> {
    return transactionClock.run({ deadline: Date.now() + sharedStatusLimits.milliseconds, decodedBytes: 0 }, async () => {
        let exhausted = false, requests = 0;
        let observedBranch: Awaited<ReturnType<CoordinationProvider['branch']>>;
        const source = target.provider;
        async function request<T>(call: () => Promise<T>): Promise<T> {
            if (++requests > sharedStatusLimits.requests || Date.now() >= transactionClock.getStore()!.deadline) {
                exhausted = true;
                throw new StatusBoundExceeded();
            }
            try { return await bounded(call()); }
            catch (error) {
                if (Date.now() >= transactionClock.getStore()!.deadline) exhausted = true;
                throw error;
            }
        }
        // Every distinct provider operation counts; repeated immutable pins reuse the
        // first bounded result. This reader cannot mutate remote state.
        const reads = new Map<string, Promise<string | null>>(), comparisons = new Map<string, Promise<'ahead' | 'identical' | 'behind' | 'diverged'>>(), histories = new Map<string, Promise<CoordinationHistoryPage>>();
        const provider: CoordinationProvider = {
            branch: async t => (observedBranch = await request(() => source.branch(t))),
            read: (t, h, p) => { const key = `${h}\n${p}`; let value = reads.get(key); if (!value) { value = request(() => source.read(t, h, p)); reads.set(key, value); } return value; },
            compare: (t, a, b) => { const key = `${a}\n${b}`; let value = comparisons.get(key); if (!value) { value = request(() => source.compare(t, a, b)); comparisons.set(key, value); } return value; },
            commit: async () => { throw Error('status is read-only'); },
            ...(source.history ? { history: (t: CoordinationTarget, head: string, cursor: string | null, first: number) => { const key = `${head}\n${cursor ?? ''}\n${first}`; let value = histories.get(key); if (!value) { value = request(() => source.history!(t, head, cursor, first)); histories.set(key, value); } return value; } } : {}),
        };
        const viewTarget = { ...target, provider }, total = { bytes: 0 };
        let snapshot: CoordinationSnapshot;
        try {
            if (!Array.isArray(allowedRepos) || allowedRepos.some(r => !repo(r))) throw Error('invalid repository scope');
            snapshot = await readCoordinationSnapshot(viewTarget, false, total);
        } catch { return { head: null, tasks: [], refusal: 'coordination-status-unavailable' }; }
        const rows = new Map<string, SharedTaskStatus>(), expected = new Map<string, TaskRecord | null>();
        try {
            for (const t of Object.values(snapshot.tasks).filter(t => allowedRepos.includes(t.repo))) {
                await inspectTaskAtSnapshot(viewTarget, t.taskKey, {}, snapshot, total);
                rows.set(t.taskKey, statusTask(t, snapshot.head, source.history ? 'partial' : 'unsupported'));
                expected.set(t.taskKey, t);
            }
        } catch { return { head: null, tasks: [], refusal: 'coordination-status-unavailable' }; }
        let coverage: SharedHistoryCoverage = source.history ? 'partial' : 'unsupported';
        // Full historical validation is pinned to this already verified branch observation.
        provider.branch = async () => observedBranch;
        const cache = new Map<string, CoordinationSnapshot>([[snapshot.head, snapshot]]);
        async function at(head: string): Promise<CoordinationSnapshot> {
            let value = cache.get(head);
            if (!value) { value = await readCoordinationSnapshot(viewTarget, false, total, head); cache.set(head, value); }
            return value;
        }
        async function taskAt(head: string, key: string): Promise<TaskRecord | null> {
            const inspected = await inspectTaskAtSnapshot(viewTarget, key, {}, await at(head), total);
            if (inspected.kind === 'absent') return null;
            if (inspected.kind !== 'active' && inspected.kind !== 'completed') throw Error('unverified historical task');
            return inspected.task;
        }
        if (source.history && allowedRepos.length) {
            let cursor: string | null = null, nextHead = snapshot.head;
            const cursors = new Set<string>(), seen = new Set<string>();
            try {
                for (let pageNumber = 0; pageNumber < sharedStatusLimits.pages; pageNumber++) {
                    const page = await request(() => source.history!(viewTarget, snapshot.head, cursor, sharedStatusLimits.pageSize));
                    const bytes = Buffer.byteLength(JSON.stringify(page));
                    transactionClock.getStore()!.decodedBytes += bytes;
                    if (bytes > sharedStatusLimits.pageBytes || transactionClock.getStore()!.decodedBytes > 8 * 1024 * 1024) { exhausted = true; throw new StatusBoundExceeded(); }
                    if (!closed({ commits: array(closed({ oid: sha, parents: array(sha), headline: (v: unknown) => typeof v === 'string' && v.length <= 256, committedAt: nullable(date) })), nextCursor: nullable((v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 1024) })(page) ||
                        !page.commits.length || page.commits.length > sharedStatusLimits.pageSize) throw Error('invalid history page');
                    let reachedRoot = false;
                    for (const commit of page.commits) {
                        if (commit.oid !== nextHead || seen.has(commit.oid)) throw Error('noncontiguous history');
                        seen.add(commit.oid);
                        if (commit.oid === target.rootCommit) { reachedRoot = true; break; }
                        if (commit.parents.length !== 1 || commit.parents[0] === commit.oid) throw Error('nonlinear history');
                        nextHead = commit.parents[0]!;
                        const operationId = /^factory coordination ([0-9a-f-]+)$/.exec(commit.headline)?.[1];
                        if (!operationId || !uuid(operationId)) throw Error('history operation unavailable');
                        const rawReceipt = await pinnedJson(viewTarget, commit.oid, operationPath(operationId), 32 * 1024, total);
                        if (groupReceiptSchema(rawReceipt)) {
                            const receipt = parse<GroupSuccessionReceipt>(rawReceipt, groupReceiptSchema, 'history group succession receipt', 32 * 1024);
                            if (receipt.operationId !== operationId || receipt.previousHead !== nextHead) throw Error('history group receipt parent mismatch');
                            if (await pinnedJson(viewTarget, nextHead, operationPath(operationId), 32 * 1024, total) !== null) throw Error('group receipt was not introduced at this commit');
                            const retained = await pinnedJson(viewTarget, snapshot.head, operationPath(operationId), 32 * 1024, total);
                            if (canonical(receipt) !== canonical(retained)) throw Error('history group receipt changed');
                            const groupSnapshot = await at(commit.oid), groupRows = await validateGroupReceipt(viewTarget, groupSnapshot, receipt, total);
                            for (const transition of groupRows) {
                                const after = groupSnapshot.tasks[transition.after.taskKey], before = transition.before;
                                if (!after || canonical(after) !== canonical(transition.after)) throw Error('history group member task mismatch');
                                if (!allowedRepos.includes(after.repo)) continue;
                                if (!expected.has(after.taskKey)) {
                                    const current = await taskAt(snapshot.head, after.taskKey);
                                    if (!current || !allowedRepos.includes(current.repo)) throw Error('current retained group member missing');
                                    expected.set(after.taskKey, current);
                                    rows.set(after.taskKey, statusTask(current, snapshot.head, 'partial'));
                                }
                                if (canonical(expected.get(after.taskKey)) !== canonical(after)) throw Error('group member history discontinuity');
                                const row = rows.get(after.taskKey)!;
                                row.history.events.push({ kind: 'group-succession', generation: after.generation, machineId: after.machineId, previousMachineId: before.machineId, sourceCommit: commit.oid, observedAt: commit.committedAt });
                                if (row.history.events.length === 1) row.lastTransitionObservedAt = commit.committedAt;
                                expected.set(after.taskKey, before);
                            }
                            continue;
                        }
                        const receipt = parse<OperationReceipt>(rawReceipt, receiptSchema, 'history receipt', 32 * 1024);
                        if (receipt.operationId !== operationId || receipt.previousHead !== nextHead) throw Error('history receipt parent mismatch');
                        // Scope discovery uses the pinned task only; foreign tasks produce no detail or counts.
                        const after = await taskAt(commit.oid, receipt.taskKey);
                        if (!after) throw Error('history task missing');
                        if (!allowedRepos.includes(after.repo)) continue;
                        if (await pinnedJson(viewTarget, nextHead, operationPath(operationId), 32 * 1024, total) !== null) throw Error('receipt was not introduced at this commit');
                        // Immutable receipts must still have exactly their original closed value at the pinned head.
                        const retained = await pinnedJson(viewTarget, snapshot.head, operationPath(operationId), 32 * 1024, total);
                        if (canonical(receipt) !== canonical(retained)) throw Error('history receipt changed');
                        const before = await taskAt(nextHead, receipt.taskKey);
                        if (!expected.has(receipt.taskKey)) {
                            const current = await taskAt(snapshot.head, receipt.taskKey);
                            if (!current || !allowedRepos.includes(current.repo)) throw Error('current retained task missing');
                            expected.set(receipt.taskKey, current);
                            rows.set(receipt.taskKey, statusTask(current, snapshot.head, 'partial'));
                        }
                        if (canonical(expected.get(receipt.taskKey)) !== canonical(after)) throw Error('task history discontinuity');
                        const kind = statusTransition(receipt, before, after), row = rows.get(receipt.taskKey)!;
                        row.history.events.push({ kind, generation: after.generation, machineId: after.machineId, previousMachineId: before?.machineId ?? null, sourceCommit: commit.oid, observedAt: commit.committedAt });
                        if (row.history.events.length === 1) row.lastTransitionObservedAt = commit.committedAt;
                        expected.set(receipt.taskKey, before);
                    }
                    if (reachedRoot) { coverage = 'complete'; break; }
                    if (page.nextCursor === null) throw Error('history ended before configured root');
                    if (cursors.has(page.nextCursor)) throw Error('repeated history cursor');
                    cursors.add(page.nextCursor); cursor = page.nextCursor;
                    coverage = 'bounded';
                }
            } catch (error) { coverage = error instanceof StatusBoundExceeded || exhausted || transactionClock.getStore()!.decodedBytes > 8 * 1024 * 1024 ? 'bounded' : 'unavailable'; }
        }
        for (const [key, row] of rows) {
            // A verified suffix alone cannot establish the task's first owner.
            const first = row.history.events.at(-1);
            row.history.coverage = coverage === 'complete' && (expected.get(key) !== null || first?.kind !== 'acquire') ? 'partial' : coverage;
            if (row.history.coverage === 'complete') row.originMachineId = first!.machineId;
        }
        return { head: snapshot.head, tasks: [...rows.values()], refusal: null,
            history: { coverage, archiveCoverage: source.history ? 'partial' : 'active-only', sourceCommit: snapshot.head } };
    });
}
// No state-branch creation or ref fallback exists. gh retains the configured local credentials.
export function githubCoordinationProvider(gh: (args: string[], options?: GhOptions) => Promise<string> = ghText): CoordinationProvider {
    const includedResponse = (raw: string): { body: string; headers: Headers } => {
        if (!raw.startsWith('HTTP/')) return { body: raw, headers: new Headers() }; // Preserve injected reader compatibility.
        const match = /^HTTP\/\S+ \d{3}[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(raw);
        if (!match) throw Error('GitHub response headers are unreadable');
        const headers = new Headers();
        for (const line of match[1]!.split(/\r?\n/)) { const split = line.indexOf(':'); if (split <= 0) throw Error('GitHub response headers are unreadable'); headers.append(line.slice(0, split), line.slice(split + 1).trim()); }
        return { body: match[2]!, headers };
    };
    const delayFrom = (headers: Headers): number => {
        const after = headers.get('retry-after'), reset = headers.get('x-ratelimit-reset');
        const delay = after !== null
            ? (/^\d+(?:\.\d+)?$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now())
            : reset !== null && /^\d+$/.test(reset) ? Number(reset) * 1000 - Date.now() : 0;
        return Number.isFinite(delay) ? Math.max(0, Math.ceil(delay)) : 0;
    };
    const rateLimitDelay = (error: unknown): number | null => {
        if (error instanceof CoordinationRateLimit) return error.retryAfterMs;
        if (!(error instanceof GhUnavailable)) return null;
        const limited = error.httpStatus === 429 || error.httpStatus === 403
            && (error.headers.has('retry-after') || error.headers.get('x-ratelimit-remaining') === '0');
        return limited ? delayFrom(error.headers) : null;
    };
    async function graphql(target: CoordinationTarget, query: string, variables: Record<string, unknown>, maxBytes?: number) {
        const raw = await gh(['api', '--hostname', target.host, 'graphql', '--input', '-', '--include'], { input: JSON.stringify({ query, variables }), timeoutMs: requestTimeout() });
        if (maxBytes !== undefined) {
            const bytes = Buffer.byteLength(raw), budget = transactionClock.getStore();
            if (budget) budget.decodedBytes += bytes;
            if (bytes > maxBytes || budget && budget.decodedBytes > 8 * 1024 * 1024) throw new StatusBoundExceeded();
        }
        const response = includedResponse(raw), body = JSON.parse(response.body);
        if (body.errors?.length) {
            const types = body.errors.map((x: {
                type?: string;
            }) => x.type ?? 'error');
            if (types.includes('RATE_LIMITED') || response.headers.get('x-ratelimit-remaining') === '0') throw new CoordinationRateLimit(delayFrom(response.headers));
            throw Error(`GraphQL refused: ${types.join(',')}`);
        }
        if (!body.data)
            throw Error('missing GraphQL result');
        return body.data;
    }
    return {
        async history(t, head, cursor, first) {
            if (!sha(head) || !Number.isInteger(first) || first < 1 || first > sharedStatusLimits.pageSize || cursor !== null && (typeof cursor !== 'string' || !cursor.length || cursor.length > 1024))
                throw Error('invalid history request');
            const [owner, name] = t.repository.split('/');
            const data = await graphql(t, 'query($owner:String!,$name:String!,$head:GitObjectID!,$cursor:String,$first:Int!){repository(owner:$owner,name:$name){id object(oid:$head){... on Commit{oid history(first:$first,after:$cursor){nodes{oid messageHeadline committedDate parents(first:2){nodes{oid} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}}}}', { owner, name, head, cursor, first }, sharedStatusLimits.pageBytes);
            const commit = data.repository?.object, history = commit?.history;
            if (data.repository?.id !== t.repositoryId || commit?.oid !== head || !history || !Array.isArray(history.nodes) || history.nodes.length > first ||
                typeof history.pageInfo?.hasNextPage !== 'boolean' || history.pageInfo.hasNextPage && typeof history.pageInfo.endCursor !== 'string')
                throw Error('history identity unavailable');
            return { commits: history.nodes.map((c: { oid: string; messageHeadline: string; committedDate: string; parents: { nodes: Array<{ oid: string }>; pageInfo: { hasNextPage: boolean } } }) => {
                if (!c || !Array.isArray(c.parents?.nodes) || c.parents.nodes.length > 1 || c.parents.pageInfo?.hasNextPage !== false) throw Error('nonlinear history');
                return { oid: c.oid, parents: c.parents.nodes.map(p => p.oid), headline: c.messageHeadline, committedAt: c.committedDate };
            }), nextCursor: history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null };
        },
        async branch(t) { const [owner, name] = t.repository.split('/'); const data = await graphql(t, 'query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){id isPrivate defaultBranchRef{name} ref(qualifiedName:$branch){id target{oid}}}}', { owner, name, branch: t.branch.startsWith('refs/heads/') ? t.branch : 'refs/heads/' + t.branch }); const r = data.repository; if (!r?.ref)
            throw Error('configured coordination branch missing'); return { id: r.ref.id, head: r.ref.target.oid, repositoryId: r.id, private: r.isPrivate, defaultBranch: r.defaultBranchRef.name }; },
        async read(t, commit, path) { if (!sha(commit) || !/^coordination\/(?:index\.json|(?:tasks|machines|operations)\/[A-Za-z0-9_-]+\.json)$/.test(path))
            throw Error('invalid derived coordination path'); const [owner, name] = t.repository.split('/'); const data = await graphql(t, 'query($owner:String!,$name:String!,$expression:String!){repository(owner:$owner,name:$name){object(expression:$expression){... on Blob{byteSize isBinary text}}}}', { owner, name, expression: commit + ':' + path }); const b = data.repository?.object; if (b === null)
            return null; if (!b || b.isBinary || typeof b.text !== 'string' || b.byteSize !== Buffer.byteLength(b.text) || b.byteSize > 1024 * 1024)
            throw Error('unreadable coordination blob'); return b.text; },
        async compare(t, base, head) { if (!sha(base) || !sha(head))
            throw Error('invalid ancestry identity'); try { const response = includedResponse(await gh(['api', '--hostname', t.host, `repos/${t.repository}/compare/${base}...${head}`, '--include'], { timeoutMs: requestTimeout() })), raw = JSON.parse(response.body); if (!['ahead', 'identical', 'behind', 'diverged'].includes(raw.status))
                throw Error('ancestry unavailable'); return raw.status; } catch (error) { const retryAfterMs = rateLimitDelay(error); if (retryAfterMs !== null) throw new CoordinationRateLimit(retryAfterMs); throw error; } },
        async commit(t, input) {
            try {
                const variables = { input: { branch: { id: input.branchId }, expectedHeadOid: input.expectedHeadOid, fileChanges: { additions: Object.entries(input.files).map(([path, text]) => ({ path, contents: Buffer.from(text).toString('base64') })) }, message: { headline: 'factory coordination ' + input.operationId }, clientMutationId: input.operationId } };
                const data = await graphql(t, 'mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}', variables);
                const head = data.createCommitOnBranch?.commit?.oid;
                if (!sha(head))
                    return { kind: 'ambiguous', reason: 'commit identity missing' };
                return { kind: 'committed', head };
            }
            catch (error) {
                const message = (error as Error).message;
                const retryAfterMs = rateLimitDelay(error);
                if (retryAfterMs !== null)
                    return { kind: 'conflict', reason: 'provider rate limited', retryAfterMs };
                if (/STALE_DATA|expectedHeadOid|head.*changed/i.test(message))
                    return { kind: 'conflict', reason: 'expected head changed' };
                if (/FORBIDDEN|UNPROCESSABLE|NOT_FOUND/.test(message) || error instanceof GhUnavailable && [401, 403, 404, 422].includes(error.httpStatus ?? 0))
                    return { kind: 'refused', reason: 'provider refused conditional mutation' };
                return { kind: 'ambiguous', reason: 'conditional mutation response unavailable' };
            }
        },
    };
}
// Atomically fence the send before the transport is called. A crash leaves an ambiguous
// effect; repeated operation IDs do not grant a second send.
export async function beginManagedEffect(input: {
    claim: SharedClaim;
    effectId: string;
    operationId: string;
}): Promise<{
    claim: SharedClaim;
    effect: EffectRef;
}> {
    const effect = await verifyManagedEffect(input.claim, input.effectId);
    const result = await transitionSharedTask({ claim: input.claim, operationId: input.operationId, transition: { kind: 'effect-send', effectId: input.effectId } });
    if (result.kind !== 'owned')
        throw Error(result.reason);
    return { claim: result.claim, effect };
}
