// Q45 shared ownership: controller-derived paths, immutable reads and conditional commits.
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, open, readFile, rename, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { ghText, type GhOptions } from './gh.ts';
import { acquireClaim, releaseClaim, processIdentity, type ProcessIdentity } from './claims.ts';
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
const transactionClock = new AsyncLocalStorage<number>();
function requestTimeout(): number { return Math.max(1, Math.min(10000, (transactionClock.getStore() ?? Date.now() + 10000) - Date.now())); }
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
export interface TaskRecord {
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
export interface SharedStatus {
    head: string | null;
    tasks: Array<Pick<TaskRecord, 'taskKey' | 'repo' | 'issue' | 'state' | 'machineId' | 'generation'>>;
    refusal: string | null;
}
export interface CoordinationProvider {
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
const summary = closed({ taskKey: digest, repo, issueNodeId: node, machineId: id, parentTaskKey: nullable(digest), paths: unique(relative), resources: unique(id), independent: boolean });
const indexSchema = closed({ schemaVersion: literal(1), installationId: uuid, revision: integer, active: unique(summary), machines: unique(id) });
const machineSchema = closed({ schemaVersion: literal(1), machineId: id, installationId: uuid, sessionId: uuid, hostBindingDigest: digest, bootIdDigest: digest, observedAt: date, activeTaskKeys: unique(digest) });
const recordSchema = closed({ schemaVersion: literal(1), taskKey: digest, host: pattern(/^[a-z0-9.-]+$/), repo, issue: positive, repositoryNodeId: node, issueNodeId: node, scopeDigest: digest, approvalDigest: digest, approvalBindings: authorities, generation: positive, machineId: id, installationId: uuid, sessionId: uuid, ownerToken: uuid, runId: uuid, stage: id, state: literal('claimed', 'running', 'stopped', 'blocked', 'completed'), paths: unique(relative), resources: unique(id), independent: boolean, parentTaskKey: nullable(digest), approvedTaskIds: unique(id), checkpoint: nullable(checkpoint), stopProof: nullable(stopProof), unresolvedEffects: unique(evidence), recovery: nullable(envelope), acceptedScopes: unique(closed({ scopeDigest: digest, receipt: stateEvidence })) });
const receiptSchema = closed({ schemaVersion: literal(1), operationId: uuid, type: id, taskKey: digest, generation: positive, previousHead: sha, requestDigest: digest, resultOwner: closed({ ownerToken: uuid, machineId: id, installationId: uuid, sessionId: uuid, runId: uuid }), recoveryPayload: nullable(payload) });
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
    if (!/^[a-z0-9.-]+$/.test(target.host) || !repo(target.repository) || !node(target.repositoryId) || !branch(target.branch) || !sha(target.rootCommit) || !uuid(target.installationId))
        throw Error('invalid coordination target');
    const remote = await bounded(target.provider.branch(target));
    if (!remote.private || remote.repositoryId !== target.repositoryId || !node(remote.id) || !sha(remote.head) || target.branch.replace(/^refs\/heads\//, '') === remote.defaultBranch)
        throw Error('coordination branch identity/privacy/default mismatch');
    const memory = await remembered(target);
    for (const base of new Set([target.rootCommit, ...(memory ? [memory.head] : [])]))
        if (!['ahead', 'identical'].includes(await bounded(target.provider.compare(target, base, remote.head))))
            throw Error('coordination history is not verified forward ancestry');
    const total = { bytes: 0 }, index = parse<Index>(await pinnedJson(target, remote.head, 'coordination/index.json', 1024 * 1024, total), indexSchema, 'coordination index', 1024 * 1024);
    if (index.installationId !== target.installationId || memory && index.revision < memory.revision)
        throw Error('coordination installation/revision rollback');
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
    // Serialize local read pointers: concurrent older reads must not regress remembered state.
    const lock = await acquireClaim(localPath(target, 'read-pointer.lock'), await processIdentity());
    if (lock.kind !== 'owned')
        throw Error(lock.reason);
    try {
        const current = await remembered(target);
        if (current && current.head !== remote.head && !['ahead', 'identical'].includes(await bounded(target.provider.compare(target, current.head, remote.head))))
            throw Error('concurrent stale coordination read');
        await privateWrite(localPath(target, 'accepted.json'), { head: remote.head, revision: index.revision });
    }
    finally {
        await releaseClaim(lock.claim);
    }
    return { head: remote.head, branchId: remote.id, index, tasks, machines };
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
async function reserve(snapshot: CoordinationSnapshot, t: TaskRecord, machine: EffectiveMachine, session: MachineSession, replace = false) {
    const m = snapshot.machines[machine.id];
    if (m && (m.installationId !== session.installationId || m.hostBindingDigest !== session.hostBindingDigest))
        throw Error('registered machine installation/host mismatch');
    if (m && m.sessionId !== session.sessionId) {
        if (!session.target.verifySession)
            throw Error('registered machine already has another session; verified session reconciliation required');
        await session.target.verifySession(m, machine, session);
        for (const old of Object.values(snapshot.tasks).filter(t => t.machineId === machine.id)) {
            if (!['stopped', 'blocked'].includes(old.state) || !old.stopProof)
                throw Error('prior machine execution stop remains unknown');
            await verifyStop(session.target, old, old.stopProof);
        }
    }
    if (Object.values(snapshot.machines).some(x => x.machineId !== machine.id && x.hostBindingDigest === machine.hostBindingDigest))
        throw Error('host binding already reserved');
    const other = snapshot.index.active.filter(x => !replace || x.taskKey !== t.taskKey);
    if (other.some(x => x.issueNodeId === t.issueNodeId || x.taskKey === t.taskKey))
        throw Error('task busy');
    if (other.filter(x => x.machineId === machine.id && x.parentTaskKey === null).length >= machine.defaults.maxRuns && t.parentTaskKey === null)
        throw Error('machine at maxRuns');
    if (t.parentTaskKey && other.filter(x => x.parentTaskKey === t.parentTaskKey).length >= Math.min(3, machine.defaults.childConcurrent))
        throw Error('parent child capacity busy');
    if (other.some(x => conflicting(x, summaryOf(t))))
        throw Error('incompatible resource reservation busy');
    snapshot.tasks[t.taskKey] = t;
    snapshot.index.active = [...other, summaryOf(t)];
    snapshot.machines[machine.id] = { schemaVersion: 1, machineId: machine.id, installationId: machine.installationId, sessionId: session.sessionId, hostBindingDigest: session.hostBindingDigest, bootIdDigest: session.bootIdDigest, observedAt: new Date().toISOString(), activeTaskKeys: snapshot.index.active.filter(x => x.machineId === machine.id).map(x => x.taskKey) };
    if (!snapshot.index.machines.includes(machine.id))
        snapshot.index.machines.push(machine.id);
}
function filesFor(snapshot: CoordinationSnapshot, t: TaskRecord, receipt: OperationReceipt): Record<string, string> {
    snapshot.index.revision++;
    parse(snapshot.index, indexSchema, 'index', 1024 * 1024);
    parse(t, recordSchema, 'task');
    parse(receipt, receiptSchema, 'receipt', 32 * 1024);
    const files: Record<string, string> = { 'coordination/index.json': canonical(snapshot.index), [taskPath(t.taskKey)]: canonical(t), [operationPath(receipt.operationId)]: canonical(receipt) };
    for (const m of Object.values(snapshot.machines))
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
    return transactionClock.run(Date.now() + 45000, () => transactWithinWindow(...args));
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
                if (prior.generation !== t.generation || canonical(prior.resultOwner) !== canonical(ownerOf(t)) || expected && !owns(t, expected))
                    return { kind: 'refused', reason: 'old receipt no longer owns current task' };
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
                    if (got && canonical(got) === canonical(receipt) && owns(task, claimOf(t, s.head, target)))
                        return { kind: 'owned', claim: claimOf(task, current.head, target) };
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
            const t: TaskRecord = { schemaVersion: 1, taskKey: key, host: c.host, repo: c.repo, issue: c.issue, repositoryNodeId: c.repositoryNodeId, issueNodeId: c.issueNodeId, scopeDigest: c.scopeDigest, approvalDigest: c.approvalDigest, approvalBindings: c.approvalBindings, generation: old ? old.generation + 1 : 1, machineId: machine.id, installationId: machine.installationId, sessionId: session.sessionId, ownerToken, runId: c.runId, stage: c.stage, state: 'claimed', paths: c.paths, resources: c.resources, independent: c.independent, parentTaskKey: c.parentTaskKey, approvedTaskIds: c.approvedTaskIds, checkpoint: null, stopProof: null, unresolvedEffects: [], recovery: null, acceptedScopes: old?.acceptedScopes ?? [] };
            parse(t, recordSchema, 'candidate task');
            await reserve(s, t, machine, session);
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
    const current = await bounded(target.provider.branch(target));
    if (current.repositoryId !== target.repositoryId || !current.private || ![target.rootCommit, ref.commitSha].every(v => sha(v)) || !['ahead', 'identical'].includes(await bounded(target.provider.compare(target, target.rootCommit, ref.commitSha))) || !['ahead', 'identical'].includes(await bounded(target.provider.compare(target, ref.commitSha, current.head))))
        throw Error('evidence is outside verified state-branch ancestry');
    const raw = await bounded(target.provider.read(target, ref.commitSha, operationPath(ref.operationId)));
    if (raw === null || Buffer.byteLength(raw) > 32 * 1024 || sha256(raw) !== ref.blobSha256)
        throw Error('immutable evidence blob missing or changed');
    const receipt = parse<OperationReceipt>(JSON.parse(raw), receiptSchema, 'evidence receipt', 32 * 1024);
    if (receipt.operationId !== ref.operationId || receipt.recoveryPayload === null)
        throw Error('evidence receipt identity/payload mismatch');
    const p = parseRecoveryPayload(receipt.recoveryPayload);
    await target.verifyEvidence(ref, p);
    return p;
}
async function validateRemoteRecovery(target: CoordinationTarget, e: RecoveryEnvelope, t: TaskRecord, requireCoverage = false) {
    parseRecoveryEnvelope(e);
    if (e.taskKey !== t.taskKey || e.runId !== t.runId || e.generation !== t.generation || e.scopeDigest !== t.scopeDigest || e.approvalDigest !== t.approvalDigest || canonical(e.approvalBindings) !== canonical(t.approvalBindings))
        throw Error('recovery differs from current task identity/authority');
    for (const a of e.approvalBindings)
        await resolveEvidence(target, a.source);
    const q = await resolveEvidence(target, e.execution.qualification);
    if (!q || q.kind !== 'execution-qualification' || q.result !== 'qualified' || q.harness !== e.execution.harness || q.harnessVersion !== e.execution.harnessVersion || q.model !== e.execution.model || q.effort !== e.execution.effort || q.accountRef !== e.execution.accountRef)
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
    const coverage = e.remoteEffectCoverage;
    if (coverage.kind === 'qualified-managed-only') {
        const p = await resolveEvidence(target, coverage.qualification);
        if (!p || p.kind !== 'execution-qualification' || canonical(p) !== canonical(q) || !p.unmanagedDenied || !effectKinds.every(k => p.managedKinds.includes(k)))
            throw Error('managed coverage qualification mismatch');
    }
    else if (coverage.kind === 'reconciled') {
        const p = await resolveEvidence(target, coverage.evidence);
        if (!p || p.kind !== 'effect-reconciliation' || p.result !== 'complete' || p.runId !== e.runId || p.scopeDigest !== e.scopeDigest || canonical(p.approvalBindings) !== canonical(e.approvalBindings) || e.effects.some(x => !p.checkedEffectIds.includes(x.operationId)))
            throw Error('incomplete effect reconciliation');
    }
    else if (requireCoverage)
        throw Error('unmanaged remote effects possible; recovery blocked');
    if (requireCoverage && e.effects.some(x => x.state === 'prepared' || x.state === 'ambiguous'))
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
export async function transitionSharedTask(input: {
    claim: SharedClaim;
    operationId: string;
    transition: TaskTransition;
}): Promise<SharedClaimResult> {
    const { claim, operationId, transition } = input, target = claim.target;
    const requestDigest = sha256(canonical(transition.kind === 'handoff' ? { ...transition, session: { machineId: transition.session.machineId, sessionId: transition.session.sessionId, installationId: transition.session.installationId, hostBindingDigest: transition.session.hostBindingDigest, bootIdDigest: transition.session.bootIdDigest } } : transition));
    return transact(target, operationId, async (s) => {
        const t = s.tasks[claim.taskKey];
        if (!t || !owns(t, claim))
            throw Error('wrong current owner; transition refused');
        await target.verifyTransition(t, transition);
        let recoveryPayload: RecoveryEvidencePayload | null = null;
        if (transition.kind === 'receipt')
            recoveryPayload = parseRecoveryPayload(transition.payload);
        else if (transition.kind === 'effect-send') {
            if (!t.recovery || t.recovery.remoteEffectCoverage.kind === 'unmanaged-possible')
                throw Error('unmanaged remote-effect barrier');
            await validateRemoteRecovery(target, t.recovery, t);
            const effect = t.recovery.effects.find(x => x.operationId === transition.effectId);
            if (!effect || effect.state !== 'prepared')
                throw Error('effect send already reserved or intent missing');
            effect.state = 'ambiguous';
        }
        else if (transition.kind === 'start') {
            if (t.state !== 'claimed')
                throw Error('task cannot start from current state');
            t.state = 'running';
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
            t.acceptedScopes.push({ scopeDigest: t.scopeDigest, receipt: transition.acceptedScope });
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
            if (taskKey(c.host, c.repositoryNodeId, c.issueNodeId) !== t.taskKey || c.scopeDigest !== t.scopeDigest || c.approvalDigest !== t.approvalDigest || canonical(c.approvalBindings) !== canonical(t.approvalBindings))
                throw Error('handoff must preserve verified original scope');
            s.machines[t.machineId]!.activeTaskKeys = s.machines[t.machineId]!.activeTaskKeys.filter(k => k !== t.taskKey);
            t.machineId = transition.machine.id;
            t.installationId = transition.machine.installationId;
            t.sessionId = transition.session.sessionId;
            t.generation++;
            t.ownerToken = randomUUID();
            t.state = 'claimed';
            t.stopProof = transition.stopProof;
            // Carry remotely sufficient original execution/effect history into the new ownership generation.
            t.recovery = { ...transition.recovery, generation: t.generation };
            await reserve(s, t, transition.machine, transition.session, true);
        }
        return { task: t, type: transition.kind, payload: recoveryPayload };
    }, claim, requestDigest);
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
    if (t.recovery.remoteEffectCoverage.kind === 'unmanaged-possible')
        throw Error('unmanaged remote-effect barrier');
    const effect = t.recovery.effects.find(x => x.operationId === effectId);
    if (!effect || effect.state !== 'prepared')
        throw Error('effect not prepared or already sent; reconcile before retry');
    return effect;
}
export async function readSharedStatus(target: CoordinationTarget, allowedRepos: string[]): Promise<SharedStatus> {
    try {
        const s = await readCoordination(target);
        return { head: s.head, tasks: Object.values(s.tasks).filter(t => allowedRepos.includes(t.repo)).map(({ taskKey, repo, issue, state, machineId, generation }) => ({ taskKey, repo, issue, state, machineId, generation })), refusal: null };
    }
    catch (error) {
        return { head: null, tasks: [], refusal: (error as Error).message };
    }
}
// No state-branch creation or ref fallback exists. gh retains the configured local credentials.
export function githubCoordinationProvider(gh: (args: string[], options?: GhOptions) => Promise<string> = ghText): CoordinationProvider {
    async function graphql(target: CoordinationTarget, query: string, variables: Record<string, unknown>) {
        const raw = await gh(['api', '--hostname', target.host, 'graphql', '--input', '-'], { input: JSON.stringify({ query, variables }), timeoutMs: requestTimeout() });
        const body = JSON.parse(raw);
        if (body.errors?.length)
            throw Error(`GraphQL refused: ${body.errors.map((x: {
                type?: string;
            }) => x.type ?? 'error').join(',')}`);
        if (!body.data)
            throw Error('missing GraphQL result');
        return body.data;
    }
    return {
        async branch(t) { const [owner, name] = t.repository.split('/'); const data = await graphql(t, 'query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){id isPrivate defaultBranchRef{name} ref(qualifiedName:$branch){id target{oid}}}}', { owner, name, branch: t.branch.startsWith('refs/heads/') ? t.branch : 'refs/heads/' + t.branch }); const r = data.repository; if (!r?.ref)
            throw Error('configured coordination branch missing'); return { id: r.ref.id, head: r.ref.target.oid, repositoryId: r.id, private: r.isPrivate, defaultBranch: r.defaultBranchRef.name }; },
        async read(t, commit, path) { if (!sha(commit) || !/^coordination\/(?:index\.json|(?:tasks|machines|operations)\/[A-Za-z0-9_-]+\.json)$/.test(path))
            throw Error('invalid derived coordination path'); const [owner, name] = t.repository.split('/'); const data = await graphql(t, 'query($owner:String!,$name:String!,$expression:String!){repository(owner:$owner,name:$name){object(expression:$expression){... on Blob{byteSize isBinary text}}}}', { owner, name, expression: commit + ':' + path }); const b = data.repository?.object; if (b === null)
            return null; if (!b || b.isBinary || typeof b.text !== 'string' || b.byteSize !== Buffer.byteLength(b.text) || b.byteSize > 1024 * 1024)
            throw Error('unreadable coordination blob'); return b.text; },
        async compare(t, base, head) { if (!sha(base) || !sha(head))
            throw Error('invalid ancestry identity'); const raw = JSON.parse(await gh(['api', '--hostname', t.host, `repos/${t.repository}/compare/${base}...${head}`], { timeoutMs: requestTimeout() })); if (!['ahead', 'identical', 'behind', 'diverged'].includes(raw.status))
            throw Error('ancestry unavailable'); return raw.status; },
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
                if (/STALE_DATA|expectedHeadOid|head.*changed/i.test(message))
                    return { kind: 'conflict', reason: 'expected head changed' };
                if (/FORBIDDEN|UNPROCESSABLE|NOT_FOUND/.test(message))
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
