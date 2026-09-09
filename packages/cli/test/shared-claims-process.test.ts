import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, sha256, taskKey } from '../src/shared-claims.ts';
for (const scenario of ['same-task', 'independent', 'last-child-slot', 'last-freed-child-slot'])
    test(`actual separate-home claimants: ${scenario}`, async () => {
        const independent = scenario === 'independent';
        const dir = await mkdtemp(join(tmpdir(), 'vf-shared-process-')), root = '1'.repeat(40), installation = '11111111-1111-4111-8111-111111111111';
        let head = root, sequence = 1, commitCalls = 0;
        const versions = new Map<string, Record<string, string>>([[root, { 'coordination/index.json': canonical({ schemaVersion: 1, installationId: installation, revision: 0, active: [], machines: [] }) }]]);
        const parentBinding = scenario.startsWith('last-') ? { taskKey: taskKey('github.com', 'R_app', 'I_parent'), runId: randomUUID(), generation: 1, ownerToken: randomUUID(), machineId: 'coordinator', installationId: randomUUID(), sessionId: randomUUID() } : null;
        if (parentBinding) {
            const { taskKey: key, ...identity } = parentBinding;
            const parent = { schemaVersion: 1, taskKey: key, ...identity, host: 'github.com', repo: 'acme/app', issue: 133, repositoryNodeId: 'R_app', issueNodeId: 'I_parent', scopeDigest: 'd'.repeat(64), approvalDigest: 'd'.repeat(64), approvalBindings: [{ approvalId: 'approved', source: { kind: 'github-comment', repositoryId: 'R_app', issueNodeId: 'I_parent', commentId: '123', bodySha256: 'd'.repeat(64) } }], stage: 'coordinate', state: 'running', paths: [], resources: [], independent: false, parentTaskKey: null, parentBinding: null, approvedTaskIds: ['133-T1'], checkpoint: null, stopProof: null, unresolvedEffects: [], recovery: null, acceptedScopes: [] };
            const active = { taskKey: key, repo: parent.repo, issueNodeId: parent.issueNodeId, machineId: parent.machineId, parentTaskKey: null, paths: [], resources: [], independent: false };
            versions.set(root, {
                'coordination/index.json': canonical({ schemaVersion: 1, installationId: installation, revision: 0, active: [active], machines: ['coordinator'] }),
                ['coordination/tasks/' + key + '.json']: canonical(parent),
                'coordination/machines/coordinator.json': canonical({ schemaVersion: 1, machineId: parent.machineId, installationId: parent.installationId, sessionId: parent.sessionId, hostBindingDigest: 'c'.repeat(64), bootIdDigest: 'd'.repeat(64), observedAt: new Date().toISOString(), activeTaskKeys: [key] }),
            });
        }
        if (scenario === 'last-freed-child-slot' && parentBinding) {
            const state = versions.get(root)!, parent = JSON.parse(state['coordination/tasks/' + parentBinding.taskKey + '.json']!);
            const key = taskKey('github.com', 'R_app', 'I_stopped'), runId = randomUUID();
            const child = { ...parent, taskKey: key, issue: 136, issueNodeId: 'I_stopped', runId, ownerToken: randomUUID(), parentTaskKey: parentBinding.taskKey, parentBinding, state: 'stopped', paths: ['src/stopped'], independent: true, stopProof: { kind: 'operator-confirmed', machineId: parent.machineId, installationId: parent.installationId, sessionId: parent.sessionId, hostBindingDigest: 'c'.repeat(64), bootIdDigest: 'd'.repeat(64), runIds: [runId], generation: 1, observedAt: new Date().toISOString(), evidenceRef: parent.approvalBindings[0].source } };
            const index = JSON.parse(state['coordination/index.json']!);
            index.active.push({ taskKey: key, repo: child.repo, issueNodeId: child.issueNodeId, machineId: child.machineId, parentTaskKey: parentBinding.taskKey, paths: child.paths, resources: [], independent: true });
            const machine = JSON.parse(state['coordination/machines/coordinator.json']!);
            machine.activeTaskKeys.push(key);
            state['coordination/index.json'] = canonical(index);
            state['coordination/tasks/' + key + '.json'] = canonical(child);
            state['coordination/machines/coordinator.json'] = canonical(machine);
        }
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
                const { method, args } = await request.json() as {
                    method: string;
                    args: unknown[];
                };
                let result: unknown;
                if (method === 'branch')
                    result = { id: 'REF_state', head, repositoryId: 'R_state', private: true, defaultBranch: 'main' };
                else if (method === 'read')
                    result = versions.get(String(args[0]))?.[String(args[1])] ?? null;
                else if (method === 'compare')
                    result = args[0] === args[1] ? 'identical' : versions.has(String(args[0])) && versions.has(String(args[1])) && [...versions.keys()].indexOf(String(args[0])) < [...versions.keys()].indexOf(String(args[1])) ? 'ahead' : 'diverged';
                else if (method === 'commit') {
                    commitCalls++;
                    const input = args[0] as {
                        expectedHeadOid: string;
                        files: Record<string, string>;
                    };
                    if (input.expectedHeadOid !== head)
                        result = { kind: 'conflict', reason: 'head changed' };
                    else {
                        const prior = head;
                        head = (++sequence).toString(16).padStart(40, '0');
                        versions.set(head, { ...versions.get(prior), ...input.files });
                        result = { kind: 'committed', head };
                    }
                }
                else
                    return new Response('bad method', { status: 400 });
                return Response.json(result);
            } });
        const worker = join(dir, 'worker.ts'), module = resolve('packages/cli/src/shared-claims.ts'), claims = resolve('packages/cli/src/claims.ts');
        await writeFile(worker, `import {acquireSharedTask} from ${JSON.stringify(module)};import {processIdentity} from ${JSON.stringify(claims)};import {appendFile,writeFile,access,mkdir} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
const [url,rootDir,machineId,index,independent,parentJson]=process.argv.slice(2);const parentBinding=JSON.parse(parentJson);const localRoot=rootDir+'/'+machineId;await mkdir(localRoot,{mode:0o700});
const rpc=async(method,...args)=>{const response=await fetch(url,{method:'POST',body:JSON.stringify({method,args})});if(!response.ok)throw Error('provider unavailable');return response.json()};
const provider={branch:()=>rpc('branch'),read:(_t,...args)=>rpc('read',...args),compare:(_t,...args)=>rpc('compare',...args),commit:(_t,input)=>rpc('commit',input)};
const target={host:'github.com',repository:'acme/control',repositoryId:'R_state',branch:'factory-state',rootCommit:'1'.repeat(40),installationId:${JSON.stringify(installation)},localRoot,provider,verifyCandidate:async()=>{},verifyTransition:async()=>{},verifyEvidence:async()=>{},verifyChildRelationship:async()=>({maxChildren:1})};
const machine={id:machineId,installationId:randomUUID(),hostBindingDigest:index==='0'?'a'.repeat(64):'b'.repeat(64),executionLogin:'robot',group:'dev',enabled:true,allowedRepositories:['acme/app'],repositoryIds:{'acme/app':'R_app'},policyDigest:'d'.repeat(64),coordination:{repositoryId:target.repositoryId,repository:target.repository,branch:target.branch,rootCommit:target.rootCommit,installationId:target.installationId},defaults:{maxRuns:1,childConcurrent:3,recovery:'verified-transfer'}};
const session={machineId,installationId:machine.installationId,sessionId:randomUUID(),hostBindingDigest:machine.hostBindingDigest,bootIdDigest:'d'.repeat(64),identity:await processIdentity(),localRoot,target};
const issue=independent==='true'?137+Number(index):137;const candidate={host:'github.com',repo:'acme/app',issue,repositoryNodeId:'R_app',issueNodeId:'I_'+issue,scopeDigest:'d'.repeat(64),approvalDigest:'d'.repeat(64),approvalBindings:[{approvalId:'approved',source:{kind:'github-comment',repositoryId:'R_app',issueNodeId:'I_parent',commentId:'123',bodySha256:'d'.repeat(64)}}],runId:randomUUID(),stage:'implement',paths:['src/'+issue],resources:[],independent:true,parentTaskKey:parentBinding?.taskKey??null,parentBinding,approvedTaskIds:[issue+'-T1']};
await writeFile(rootDir+'/ready'+index,'ready');for(;;){try{await access(rootDir+'/ready0');await access(rootDir+'/ready1');break}catch{await Bun.sleep(5)}}
const result=await acquireSharedTask({machine,session,candidate,operationId:randomUUID()});if(result.kind==='owned')await appendFile(rootDir+'/sentinel',machineId+'\\n');process.stdout.write(JSON.stringify(result.kind==='owned'?{kind:result.kind}:{kind:result.kind,reason:result.reason}));`);
        try {
            const workers = [0, 1].map(i => Bun.spawn([process.execPath, worker, server.url.toString(), dir, 'machine-' + i, String(i), String(scenario !== 'same-task'), JSON.stringify(parentBinding)], { stdout: 'pipe', stderr: 'pipe' }));
            const results = await Promise.all(workers.map(async (w) => ({ code: await w.exited, out: await new Response(w.stdout).text(), err: await new Response(w.stderr).text() })));
            expect(results.every(r => r.code === 0), JSON.stringify(results)).toBe(true);
            expect(results.filter(r => JSON.parse(r.out).kind === 'owned'), JSON.stringify(results)).toHaveLength(independent ? 2 : 1);
            expect((await readFile(join(dir, 'sentinel'), 'utf8')).trim().split('\n')).toHaveLength(independent ? 2 : 1);
            expect(commitCalls).toBeGreaterThanOrEqual(independent ? 2 : 1);
            if (scenario === 'last-freed-child-slot') expect(JSON.parse(versions.get(head)!['coordination/index.json']!).active).toHaveLength(3);
        }
        finally {
            server.stop(true);
            await rm(dir, { recursive: true, force: true });
        }
    }, 10000);

async function groupProcessFixture() {
    const dir = await mkdtemp(join(tmpdir(), 'vf-group-process-')), root = '1'.repeat(40), installation = '11111111-1111-4111-8111-111111111111', d = 'd'.repeat(64);
    const approvalBindings = [{ approvalId: 'approved', source: { kind: 'github-comment', repositoryId: 'R_app', issueNodeId: 'I_parent', commentId: '123', bodySha256: d } }];
    const machineId = 'original', machineInstallation = randomUUID(), sessionId = randomUUID();
    const parentKey = taskKey('github.com', 'R_app', 'I_parent'), parentRun = randomUUID(), parentToken = randomUUID();
    const parentBinding = { taskKey: parentKey, runId: parentRun, generation: 1, ownerToken: parentToken, machineId, installationId: machineInstallation, sessionId };
    const childKey = taskKey('github.com', 'R_app', 'I_child'), childRun = randomUUID(), childToken = randomUUID();
    const qualified = (taskKey: string, runId: string, ownerToken: string) => {
        const operationId = randomUUID(), payload = { schemaVersion: 2, kind: 'execution-qualification', harness: 'codex', harnessVersion: 'fixture', model: 'model', effort: 'high', accountRef: 'account', configurationDigest: d, candidateSha: root, validationIds: ['137-T4/check/' + d], managedKinds: ['checkpoint-push', 'handback', 'evidence', 'telemetry-push'], unmanagedDenied: true, result: 'qualified' };
        const receipt = { schemaVersion: 1, operationId, type: 'receipt', taskKey, generation: 1, previousHead: root, requestDigest: d, resultOwner: { ownerToken, machineId, installationId: machineInstallation, sessionId, runId }, recoveryPayload: payload };
        const raw = canonical(receipt);
        return { operationId, raw, reference: { kind: 'state-receipt', operationId, commitSha: root, blobSha256: sha256(raw) } };
    };
    const parentQualification = qualified(parentKey, parentRun, parentToken), childQualification = qualified(childKey, childRun, childToken);
    const task = (input: { taskKey: string; runId: string; ownerToken: string; issue: number; issueNodeId: string; parentTaskKey: string | null; parentBinding: typeof parentBinding | null; paths: string[]; qualification: typeof parentQualification }) => {
        const checkpoint = { schemaVersion: 1, id: randomUUID(), repo: 'acme/app', repositoryId: 'R_app', branch: `task/${input.issue}`, baseSha: root, headSha: root, treeSha: root, scopeDigest: d, runId: input.runId, publishedAt: new Date().toISOString() };
        const recovery = { schemaVersion: 2, taskKey: input.taskKey, runId: input.runId, generation: 1, approvalBindings, recordBinding: null, scopeDigest: d, approvalDigest: d, execution: { providerMode: 'subscription', harness: 'codex', harnessVersion: 'fixture', model: 'model', effort: 'high', accountRef: 'account', qualification: input.qualification.reference }, checkpoint, completed: [], children: [], joins: [], effects: [], remoteEffectCoverage: { kind: 'qualified-managed-only', qualification: input.qualification.reference } };
        return { schemaVersion: 1, taskKey: input.taskKey, host: 'github.com', repo: 'acme/app', issue: input.issue, repositoryNodeId: 'R_app', issueNodeId: input.issueNodeId, scopeDigest: d, approvalDigest: d, approvalBindings, generation: 1, machineId, installationId: machineInstallation, sessionId, ownerToken: input.ownerToken, runId: input.runId, stage: 'implement', state: 'stopped', paths: input.paths, resources: [], independent: input.parentTaskKey !== null, parentTaskKey: input.parentTaskKey, parentBinding: input.parentBinding, approvedTaskIds: [`${input.issue}-T1`], checkpoint, stopProof: { kind: 'operator-confirmed', machineId, installationId: machineInstallation, sessionId, hostBindingDigest: 'c'.repeat(64), bootIdDigest: d, runIds: [input.runId], generation: 1, observedAt: new Date().toISOString(), evidenceRef: approvalBindings[0]!.source }, unresolvedEffects: [], recovery, acceptedScopes: [] };
    };
    const parent = task({ taskKey: parentKey, runId: parentRun, ownerToken: parentToken, issue: 137, issueNodeId: 'I_parent', parentTaskKey: null, parentBinding: null, paths: [], qualification: parentQualification });
    const child = task({ taskKey: childKey, runId: childRun, ownerToken: childToken, issue: 138, issueNodeId: 'I_child', parentTaskKey: parentKey, parentBinding, paths: ['src/child'], qualification: childQualification });
    const summary = (value: typeof parent) => ({ taskKey: value.taskKey, repo: value.repo, issueNodeId: value.issueNodeId, machineId: value.machineId, parentTaskKey: value.parentTaskKey, paths: value.paths, resources: value.resources, independent: value.independent });
    let head = root, sequence = 1, attempts = 0, commits = 0, loseNext = false, denyBranch = 0;
    const versions = new Map<string, Record<string, string>>([[root, {
        'coordination/index.json': canonical({ schemaVersion: 1, installationId: installation, revision: 0, active: [summary(parent), summary(child)], machines: [machineId] }),
        [`coordination/tasks/${parentKey}.json`]: canonical(parent), [`coordination/tasks/${childKey}.json`]: canonical(child),
        [`coordination/machines/${machineId}.json`]: canonical({ schemaVersion: 1, machineId, installationId: machineInstallation, sessionId, hostBindingDigest: 'c'.repeat(64), bootIdDigest: d, observedAt: new Date().toISOString(), activeTaskKeys: [parentKey, childKey] }),
        [`coordination/operations/${parentQualification.operationId}.json`]: parentQualification.raw,
        [`coordination/operations/${childQualification.operationId}.json`]: childQualification.raw,
    }]]);
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const { method, args } = await request.json() as { method: string; args: unknown[] };
        if (method === 'branch' && denyBranch-- > 0) return new Response('lost readback', { status: 503 });
        let result: unknown;
        if (method === 'branch') result = { id: 'REF_state', head, repositoryId: 'R_state', private: true, defaultBranch: 'main' };
        else if (method === 'read') result = versions.get(String(args[0]))?.[String(args[1])] ?? null;
        else if (method === 'compare') result = args[0] === args[1] ? 'identical' : versions.has(String(args[0])) && versions.has(String(args[1])) && [...versions.keys()].indexOf(String(args[0])) < [...versions.keys()].indexOf(String(args[1])) ? 'ahead' : 'diverged';
        else if (method === 'commit') {
            attempts++;
            const input = args[0] as { expectedHeadOid: string; files: Record<string, string> };
            if (input.expectedHeadOid !== head) result = { kind: 'conflict', reason: 'head changed' };
            else { const prior = head; head = (++sequence).toString(16).padStart(40, '0'); versions.set(head, { ...versions.get(prior), ...input.files }); commits++; result = loseNext ? { kind: 'ambiguous', reason: 'response lost' } : { kind: 'committed', head }; if (loseNext) { loseNext = false; denyBranch = 1; } }
        } else return new Response('bad method', { status: 400 });
        return Response.json(result);
    } });
    const candidate = (value: typeof parent) => ({ host: value.host, repo: value.repo, issue: value.issue, repositoryNodeId: value.repositoryNodeId, issueNodeId: value.issueNodeId, scopeDigest: value.scopeDigest, approvalDigest: value.approvalDigest, approvalBindings: value.approvalBindings, runId: value.runId, stage: value.stage, paths: value.paths, resources: value.resources, independent: value.independent, parentTaskKey: value.parentTaskKey, parentBinding: value.parentBinding, approvedTaskIds: value.approvedTaskIds });
    const request = { schemaVersion: 1, kind: 'recover-stopped-group', operationId: randomUUID(), expectedHead: root, parentTaskKey: parentKey, groupPlan: { repo: 'acme/app', issue: 137, kind: 'plan', artifactId: 'IC_group', rev: 1, digest: d }, groupsDigest: 'e'.repeat(64), members: [{ expected: parentBinding, candidate: candidate(parent) }, { expected: { taskKey: childKey, runId: childRun, generation: 1, ownerToken: childToken, machineId, installationId: machineInstallation, sessionId }, candidate: candidate(child) }].sort((a, b) => a.expected.taskKey.localeCompare(b.expected.taskKey)) };
    const worker = join(dir, 'group-worker.ts'), module = resolve('packages/cli/src/shared-claims.ts'), claims = resolve('packages/cli/src/claims.ts');
    await writeFile(worker, `import {recoverStoppedGroup} from ${JSON.stringify(module)};import {processIdentity} from ${JSON.stringify(claims)};import {mkdir,writeFile,access} from 'node:fs/promises';
const [url,localRoot,machineJson,sessionJson,requestJson,barrier,index]=process.argv.slice(2);await mkdir(localRoot,{recursive:true,mode:0o700});const machine=JSON.parse(machineJson),saved=JSON.parse(sessionJson),request=JSON.parse(requestJson);
const rpc=async(method,...args)=>{const response=await fetch(url,{method:'POST',body:JSON.stringify({method,args})});if(!response.ok)throw Error('provider unavailable');return response.json()};const provider={branch:()=>rpc('branch'),read:(_t,...args)=>rpc('read',...args),compare:(_t,...args)=>rpc('compare',...args),commit:(_t,input)=>rpc('commit',input)};
const target={host:'github.com',repository:'acme/control',repositoryId:'R_state',branch:'factory-state',rootCommit:'1'.repeat(40),installationId:${JSON.stringify(installation)},localRoot,provider,verifyCandidate:async()=>{},verifyTransition:async()=>{},verifyEvidence:async()=>{},verifyGroupSuccession:async()=>({maxChildren:1})};const session={...saved,identity:await processIdentity(),localRoot,target};
if(barrier!=='none'){await writeFile(barrier+'/ready'+index,'ready');for(;;){try{await access(barrier+'/ready0');await access(barrier+'/ready1');break}catch{await Bun.sleep(5)}}}const result=await recoverStoppedGroup({machine,session,request});process.stdout.write(JSON.stringify(result.kind==='owned'?{kind:'owned',machineId:result.parent.machineId,parentToken:result.parent.ownerToken,childToken:result.children[0].ownerToken}:{kind:result.kind,reason:result.reason}));`);
    const receiver = (index: number) => { const machine = { id: `receiver-${index}`, installationId: randomUUID(), hostBindingDigest: String(index + 1).repeat(64), executionLogin: 'robot', group: 'dev', enabled: true, allowedRepositories: ['acme/app'], repositoryIds: { 'acme/app': 'R_app' }, policyDigest: d, coordination: { repositoryId: 'R_state', repository: 'acme/control', branch: 'factory-state', rootCommit: root, installationId: installation }, defaults: { maxRuns: 1, childConcurrent: 1, recovery: 'verified-transfer' } }; return { machine, session: { machineId: machine.id, installationId: machine.installationId, sessionId: randomUUID(), hostBindingDigest: machine.hostBindingDigest, bootIdDigest: d } }; };
    const run = async (machine: ReturnType<typeof receiver>['machine'], session: ReturnType<typeof receiver>['session'], requestValue: typeof request, barrier = 'none', index = 0) => { const childProcess = Bun.spawn([process.execPath, worker, server.url.toString(), join(dir, machine.id), JSON.stringify(machine), JSON.stringify(session), JSON.stringify(requestValue), barrier, String(index)], { stdout: 'pipe', stderr: 'pipe' }); return { code: await childProcess.exited, out: await new Response(childProcess.stdout).text(), err: await new Response(childProcess.stderr).text() }; };
    return { dir, root, server, versions, request, receiver, run, get head() { return head; }, get attempts() { return attempts; }, get commits() { return commits; }, lose: () => { loseNext = true; } };
}

test('actual two-receiver homes commit one atomic stopped-group successor', async () => {
    const f = await groupProcessFixture(), receivers = [f.receiver(0), f.receiver(1)];
    try {
        const results = await Promise.all(receivers.map((receiver, index) => f.run(receiver.machine, receiver.session, { ...f.request, operationId: randomUUID() }, f.dir, index)));
        expect(results.every(result => result.code === 0), JSON.stringify(results)).toBe(true);
        const parsed = results.map(result => JSON.parse(result.out));
        expect(parsed.filter(result => result.kind === 'owned'), JSON.stringify(parsed)).toHaveLength(1);
        expect(f.commits).toBe(1);
        const tasks = Object.entries(f.versions.get(f.head)!).filter(([path]) => path.startsWith('coordination/tasks/')).map(([, raw]) => JSON.parse(raw));
        expect(new Set(tasks.map(task => task.machineId))).toEqual(new Set([parsed.find(result => result.kind === 'owned')!.machineId]));
        expect(tasks.map(task => task.schemaVersion)).toEqual([2, 2]);
    } finally { f.server.stop(true); await rm(f.dir, { recursive: true, force: true }); }
}, 10000);

test('actual restarted receiver reads a lost group response without a second CAS', async () => {
    const f = await groupProcessFixture(), receiver = f.receiver(0);
    try {
        f.lose();
        const first = await f.run(receiver.machine, receiver.session, f.request);
        expect(first.code, first.err).toBe(0);
        expect(JSON.parse(first.out).kind).toBe('ambiguous');
        const retry = await f.run(receiver.machine, receiver.session, f.request);
        expect(retry.code, retry.err).toBe(0);
        expect(JSON.parse(retry.out).kind).toBe('owned');
        expect(f.commits).toBe(1);
        expect(f.attempts).toBe(1);
    } finally { f.server.stop(true); await rm(f.dir, { recursive: true, force: true }); }
}, 10000);

test.each(['disjoint', 'absent', 'prefix-overlap', 'equal-resource', 'same-issue', 'selected-mismatch', 'invalid-peer', 'authority-drift', 'dependency-drift'] as const)('default shared adapters admit the %s two-home fleet projection', async scenario => {
    const fs = await import('node:fs/promises'), runtime = await import('../src/runs.ts'), configOwner = await import('../src/config.ts');
    const policyOwner = await import('../../../skills/dev/dev-setup/scripts/effective-policy.mjs'), approvalOwner = await import('../../../skills/dev/dev-implement/scripts/lib/approval.mjs');
    const dir = await fs.realpath(await mkdtemp(join(tmpdir(), 'vf-default-fleet-'))), room = join(dir, 'room'), stateRoot = '1'.repeat(40), installation = randomUUID(), d = 'd'.repeat(64);
    const git = (cwd: string, ...args: string[]) => { const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } }); if (result.exitCode !== 0) throw Error(result.stderr.toString()); return result.stdout.toString().trim(); };
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
        await fs.mkdir(join(room, 'groups', 'dev'), { recursive: true });
        const machines = Object.fromEntries([0, 1].map(index => [`machine-${index}`, { installationId: randomUUID(), hostBindingDigest: String(index + 1).repeat(64), executionLogin: 'robot', group: 'dev', repositories: ['acme/app'], enabled: true, overrides: {} }]));
        const fleet = { schemaVersion: 1, coordination: { repositoryId: 'R_room', repository: 'acme/room', branch: 'factory-state', rootCommit: stateRoot, installationId: installation }, defaults: { pollSeconds: 120, maxRuns: 2, childConcurrent: 3, checkpoints: 'task-branch', recovery: 'verified-transfer' }, groupDefaults: {}, machines };
        await fs.writeFile(join(room, 'org.md'), 'sync-max-age: 2h\npolicy-schema: 2\n```vsk-policy\n' + JSON.stringify({ schemaVersion: 2, fleet }) + '\n```\n');
        await fs.writeFile(join(room, 'groups/dev/group.md'), 'review: subagent\n');
        await fs.writeFile(join(room, 'people.csv'), 'login,name,role,slack,timezone,groups\nrobot,Robot,lead,,UTC,dev\n');
        await fs.writeFile(join(room, 'repos.md'), '| repo | group | board | owner | repository-id |\n|---|---|---|---|---|\n| acme/app | dev | | robot | R_app |\n');
        git(room, 'init', '-q', '-b', 'main'); git(room, 'remote', 'add', 'origin', 'https://github.com/acme/room.git'); git(room, 'add', '.'); git(room, 'commit', '-qm', 'policy');
        const devMd = 'repo: acme/app\ncontrol-room: acme/room#dev\nsync-max-age: 2h\ndispatch: local\noperators: robot\nplan: codex fixture-model high\nimplement: codex fixture-model high\n';
        const plans = new Map<number, string>(), issues = new Map<number, Record<string, unknown>>(), comments = new Map<number, Array<Record<string, unknown>>>(), tuples = new Map<number, { approvalId: string; commentId: number; bodySha256: string }>(), bindings = new Map<number, Array<{ repo: string; issue: number; kind: 'brief' | 'plan'; artifactId: string; rev: number; digest: string }>>();
        for (const [index, issue] of [137, 138].entries()) {
            const path = scenario === 'prefix-overlap' ? (index === 0 ? 'src/one' : 'src/one/nested.ts') : index === 0 ? 'src/one.ts' : 'src/two.ts';
            const resource = scenario === 'equal-resource' ? 'fixture:shared' : `fixture:${index}`;
            const taskIds = scenario === 'selected-mismatch' ? [`${issue}-T2`] : [`${issue}-T1`];
            const declaration = scenario === 'absent' ? '' : `**Fleet parallel:** ${JSON.stringify({ schemaVersion: 1, eligible: true, taskIds, resources: [resource], ...(scenario === 'invalid-peer' && index === 1 ? { unexpected: true } : {}) })}\n`;
            const plan = `<!-- vsk:v1 type=plan rev=1 -->\n## Plan (v1)\n**Goal:** controlled fleet work.\n**Approach:** use the approved fixture.\n**Constraints:** current authority and closed dependencies.\n${declaration}\n### Tasks\n- [ ] **Task 1: fixture** <!-- task-id:${issue}-T1 -->\n  - Files — Modify: \`${path}\`\n  - Interfaces — existing fixture\n  - Steps: run the controlled check\n`;
            const brief = '<!-- vsk:v1 type=brief rev=1 scope=quick-build -->\n## Outcome\nRun the controlled fleet fixture.\n';
            const artifacts = [{ repo: 'acme/app', issue, kind: 'brief' as const, artifactId: `I_${issue}`, rev: 1, digest: approvalOwner.scopeDigest(brief, 'brief') }, { repo: 'acme/app', issue, kind: 'plan' as const, artifactId: `PLAN_${issue}`, rev: 1, digest: approvalOwner.scopeDigest(plan, 'plan') }];
            const event = { schemaVersion: 2, id: `approved-${issue}`, operator: 'robot', scope: 'brief+plan', source: { kind: 'session', ref: `session:${issue}`, quote: 'I approve this exact controlled fixture.' }, artifacts, supersedes: [], revokes: [] };
            const approvalBody = '<!-- vsk:v1 type=approval scope=brief+plan -->\n```json\n' + JSON.stringify(event) + '\n```\n', commentId = issue * 100 + 2;
            const base = { issue_url: `https://api.github.com/repos/acme/app/issues/${issue}`, user: { login: 'robot' }, updated_at: '2026-09-09T00:00:00Z' };
            plans.set(issue, plan); bindings.set(issue, artifacts); tuples.set(issue, { approvalId: event.id, commentId, bodySha256: sha256(approvalBody) });
            issues.set(issue, { id: issue, node_id: `I_${issue}`, number: issue, title: `feat: fleet ${issue}`, body: brief, state: 'open', labels: [{ name: 'ready' }, { name: 'quick-build' }], assignees: [], updated_at: new Date().toISOString() });
            comments.set(issue, [{ ...base, id: issue * 100 + 1, node_id: `PLAN_${issue}`, body: plan }, { ...base, id: commentId, node_id: `APPROVAL_${issue}`, body: approvalBody }]);
        }
        const versions = new Map<string, Record<string, string>>([[stateRoot, { 'coordination/index.json': canonical({ schemaVersion: 1, installationId: installation, revision: 0, active: [], machines: [] }) }]]);
        let head = stateRoot, sequence = 1, activeVendor = 0, maxVendor = 0, drift = false, dependencyOpen = false, admissionWaiters: Array<() => void> = [];
        const qualification = new Map<number, { reference: { kind: 'state-receipt'; operationId: string; commitSha: string; blobSha256: string }; payload: Record<string, unknown> }>();
        for (const issue of [137, 138]) {
            const operationId = randomUUID(), runId = randomUUID(), payload = { schemaVersion: 2, kind: 'execution-qualification', harness: 'codex', harnessVersion: 'fixture', model: 'fixture-model', effort: 'high', accountRef: 'account', configurationDigest: d, candidateSha: stateRoot, validationIds: ['158-H1/check/' + d], managedKinds: ['checkpoint-push', 'handback', 'evidence', 'telemetry-push'], unmanagedDenied: true, result: 'qualified' };
            const raw = canonical({ schemaVersion: 1, operationId, type: 'receipt', taskKey: sha256(String(issue)), generation: 1, previousHead: stateRoot, requestDigest: d, resultOwner: { ownerToken: randomUUID(), machineId: `machine-${issue - 137}`, installationId: machines[`machine-${issue - 137}`]!.installationId, sessionId: randomUUID(), runId }, recoveryPayload: payload });
            versions.get(stateRoot)![`coordination/operations/${operationId}.json`] = raw;
            qualification.set(issue, { reference: { kind: 'state-receipt', operationId, commitSha: stateRoot, blobSha256: sha256(raw) }, payload });
        }
        const reply = (args: string[], input: string): unknown => {
            const endpoint = args.find(arg => arg === 'user' || arg === 'graphql' || arg.startsWith('repos/')) ?? '';
            if (endpoint === 'graphql') {
                const request = JSON.parse(input), variables = request.variables ?? {}, query = request.query as string;
                if (query.includes('createCommitOnBranch')) { if (variables.input.expectedHeadOid !== head) return { errors: [{ type: 'STALE_DATA' }] }; const next = { ...versions.get(head)! }; for (const addition of variables.input.fileChanges.additions) next[addition.path] = Buffer.from(addition.contents, 'base64').toString('utf8'); head = (++sequence).toString(16).padStart(40, '0'); versions.set(head, next); return { data: { createCommitOnBranch: { commit: { oid: head } } } }; }
                if (query.includes('object(expression:')) { const split = variables.expression.indexOf(':'), commit = variables.expression.slice(0, split), path = variables.expression.slice(split + 1), text = versions.get(commit)?.[path]; return { data: { repository: { object: text === undefined ? null : { byteSize: Buffer.byteLength(text), isBinary: false, text } } } }; }
                return { data: { repository: { id: 'R_room', isPrivate: true, defaultBranchRef: { name: 'main' }, ref: { id: 'REF_state', target: { oid: head } } } } };
            }
            const path = endpoint.split('?')[0]!;
            if (path === 'user') return { login: 'robot' };
            if (path === 'repos/acme/room' || path === 'repos/acme/app') return { node_id: path.endsWith('room') ? 'R_room' : 'R_app', full_name: path.slice(6), permissions: { pull: true }, default_branch: 'main', private: true };
            if (path.startsWith('repos/acme/room/compare/')) { const [base, next] = path.split('/compare/')[1]!.split('...'), keys = [...versions.keys()]; return { status: base === next ? 'identical' : keys.indexOf(base!) >= 0 && keys.indexOf(base!) < keys.indexOf(next!) ? 'ahead' : 'diverged' }; }
            const issueMatch = /^repos\/acme\/app\/issues\/(\d+)$/.exec(path); if (issueMatch) return issues.get(Number(issueMatch[1]));
            const history = /^repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(path); if (history) { const rows = structuredClone(comments.get(Number(history[1])) ?? []); if (drift) { const plan = rows.find(row => String(row.node_id).startsWith('PLAN_')); if (plan) plan.body = String(plan.body) + '\nchanged after preparation\n'; } return rows; }
            const comment = /^repos\/acme\/app\/issues\/comments\/(\d+)$/.exec(path); if (comment) return [...comments.values()].flat().find(row => row.id === Number(comment[1]));
            if (path.endsWith('/dependencies/blocked_by')) return dependencyOpen ? [{ number: 999, state: 'open' }] : [];
            throw Error('unexpected endpoint ' + endpoint);
        };
        server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) { const body = await request.json() as { kind?: string; args?: string[]; input?: string }; if (body.kind === 'vendor') { activeVendor += body.input === 'enter' ? 1 : -1; maxVendor = Math.max(maxVendor, activeVendor); return Response.json({ ok: true }); } if (body.kind === 'admission-ready') { await new Promise<void>(resolve => { admissionWaiters.push(resolve); if (admissionWaiters.length === 2) { if (body.input === 'dependency-drift') dependencyOpen = true; else drift = true; const ready = admissionWaiters; admissionWaiters = []; for (const done of ready) done(); } }); return Response.json({ ok: true }); } try { const value = reply(body.args ?? [], body.input ?? ''), serialized = JSON.stringify(value); return new Response((body.args ?? []).includes('--include') ? 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n' + serialized : serialized); } catch (error) { return new Response(String(error), { status: 500 }); } } });
        const rawSettings: unknown[] = [], configs: unknown[] = [];
        for (const index of [0, 1]) {
            const home = join(dir, `home-${index}`), repoPath = join(home, 'app'); await fs.mkdir(join(repoPath, '.vegastack'), { recursive: true }); await fs.mkdir(join(home, '.vegastack'), { recursive: true, mode: 0o700 }); await fs.writeFile(join(repoPath, '.vegastack/dev.md'), devMd); git(repoPath, 'init', '-q', '-b', 'main'); git(repoPath, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
            const snapshot = { schemaVersion: 2, org: 'acme', group: 'dev', repository: 'acme/room', origin: 'https://github.com/acme/room.git', sourceCommit: git(room, 'rev-parse', 'HEAD'), policyDigest: '0'.repeat(64), validatedAt: new Date().toISOString(), contentPath: room };
            snapshot.policyDigest = policyOwner.loadSnapshotPolicy({ snapshot, repo: 'acme/app', devMd, expectedOrigin: snapshot.origin, now: Date.now() }).policy.policyDigest;
            const machine = machines[`machine-${index}`]!, raw = { schemaVersion: 2, revision: 0, repos: [{ repo: 'acme/app', org: 'acme', path: repoPath }], machine: { id: `machine-${index}`, installationId: machine.installationId, hostBindingDigest: machine.hostBindingDigest, group: 'dev', controlRoom: { repositoryId: 'R_room', repo: 'acme/room', remote: snapshot.origin, branch: 'main' } }, controlRooms: { acme: { repo: 'acme/room', remote: snapshot.origin, path: join(home, 'operator-room'), branch: 'main', sha: snapshot.sourceCommit, lastSyncedAt: snapshot.validatedAt, repositoryId: 'R_room', snapshots: { 'acme/app': snapshot } } } };
            await fs.writeFile(join(home, '.vegastack/factory.json'), JSON.stringify(raw)); rawSettings.push(raw); const config = configOwner.parseFactoryConfig(raw, home); configs.push(config);
            const issue = scenario === 'same-issue' ? 137 : 137 + index, artifactRows = bindings.get(issue)!, selected = [`${issue}-T1`], scope = sha256(canonical({ artifacts: artifactRows, taskIds: selected })), q = qualification.get(issue)!;
            await runtime.createRun({ root: runtime.runsRoot(home), repo: 'acme/app', issue, parent: null, checkout: repoPath, branch: `feat/${issue}`, baseSha: stateRoot, headSha: null, stage: 'implement', harness: 'codex', model: 'fixture-model', effort: 'high', execution: { providerMode: 'subscription', harness: 'codex', harnessVersion: 'fixture', model: 'fixture-model', effort: 'high', accountRef: 'account', qualification: q.reference }, runtimeBinding: { schemaVersion: 1, sourceSha: stateRoot, treeSha: stateRoot, packageName: '@vegastack/vegafactory', version: '1.0.0', tarballSha256: d, inventoryDigest: d }, configurationDigest: d, approvalBindings: [{ approvalId: tuples.get(issue)!.approvalId, source: { kind: 'github-comment', repositoryId: 'R_app', issueNodeId: `I_${issue}`, commentId: String(tuples.get(issue)!.commentId), bodySha256: tuples.get(issue)!.bodySha256 } }], recordBinding: null, approvalRefs: artifactRows, approvedTaskIds: selected, policyDigest: snapshot.policyDigest, claimToken: randomUUID(), startedAt: new Date().toISOString(), activeElapsedMs: 0, taskKey: { repo: 'acme/app', issue, taskId: selected[0]!, scopeDigest: scope }, taskOwner: null, agentAccountOwner: null, accountRef: 'account', waitReason: null, machine: { id: `machine-${index}`, installationId: machine.installationId, sessionId: randomUUID(), hostBindingDigest: machine.hostBindingDigest }, sharedClaim: null, checkpoint: null, remoteEffectCoverage: { kind: 'qualified-managed-only', qualification: q.reference } });
        }
        const worker = join(dir, 'fleet-worker.ts'), dispatch = resolve('packages/cli/src/dispatch.ts'), shared = resolve('packages/cli/src/shared-claims.ts'), configPath = resolve('packages/cli/src/config.ts'), control = resolve('packages/cli/src/control-room.ts'), claims = resolve('packages/cli/src/claims.ts'), runs = resolve('packages/cli/src/runs.ts');
        await fs.writeFile(worker, `import {sharedRunAdapters,fleetParallelProjection} from ${JSON.stringify(dispatch)};import {acquireSharedTask} from ${JSON.stringify(shared)};import {parseFactoryConfig,repoPolicyFromEffective} from ${JSON.stringify(configPath)};import {loadConfiguredPolicy} from ${JSON.stringify(control)};import {processIdentity} from ${JSON.stringify(claims)};import {readRuns,runsRoot} from ${JSON.stringify(runs)};import {readFile,writeFile,access} from 'node:fs/promises';
process.env.VSK_PREFLIGHT_SCRIPT=${JSON.stringify(resolve('skills/dev/dev-implement/scripts/preflight.mjs'))};const [url,home,rawJson,issueText,index,barrier,expectedText,scenario]=process.argv.slice(2),raw=JSON.parse(rawJson),issue=Number(issueText),expected=Number(expectedText),config=parseFactoryConfig(raw,home);const gh=async(args,options={})=>{const response=await fetch(url,{method:'POST',body:JSON.stringify({args,input:options.input??''})});if(!response.ok)throw Error(await response.text());return response.text()};const devMd=await readFile(config.repos[0].path+'/.vegastack/dev.md','utf8'),resolved=loadConfiguredPolicy({home,repo:'acme/app',devMd,settingsPath:config.settingsPath}),policy=repoPolicyFromEffective(resolved);const identity=await processIdentity(),host=raw.machine.hostBindingDigest,adapters=sharedRunAdapters(config,undefined,gh,{readHostBinding:async()=>({digest:host,platform:'linux'}),readBootIdentityDigest:async()=> 'd'.repeat(64),processIdentity:async()=>identity});await writeFile(barrier+'/fleet-ready-'+index,'ready');for(;;){try{await access(barrier+'/fleet-ready-0');await access(barrier+'/fleet-ready-1');break}catch{await Bun.sleep(5)}}const tuple=${JSON.stringify(Object.fromEntries(tuples))}[issue],bindings=${JSON.stringify(Object.fromEntries(bindings))}[issue],saved=(await readRuns(runsRoot(home)))[0],projection=await fleetParallelProjection(saved,gh);const admission=await adapters.sharedAdmission({run:{repo:'acme/app',issue,title:'fixture',stage:'implement',commentId:null,reactionId:null},entry:config.repos[0],policy,approvalBindings:[tuple],bindings,recordBinding:null});if(expected===0)await fetch(url,{method:'POST',body:JSON.stringify({kind:'admission-ready',input:scenario})});const result=await acquireSharedTask(admission);if(result.kind==='owned'){await writeFile(barrier+'/vendor-ready-'+index,'ready');if(expected===2)for(;;){try{await access(barrier+'/vendor-ready-0');await access(barrier+'/vendor-ready-1');break}catch{await Bun.sleep(5)}}await fetch(url,{method:'POST',body:JSON.stringify({kind:'vendor',input:'enter'})});await Bun.sleep(200);await fetch(url,{method:'POST',body:JSON.stringify({kind:'vendor',input:'exit'})})}process.stdout.write(JSON.stringify(result.kind==='owned'?{kind:'owned',candidate:admission.candidate,projection}:{kind:result.kind,reason:result.reason,projection}));`);
        const expected = scenario === 'disjoint' ? 2 : scenario === 'authority-drift' || scenario === 'dependency-drift' ? 0 : 1;
        const processes = [0, 1].map(index => { const issue = scenario === 'same-issue' ? 137 : 137 + index; const child = Bun.spawn([process.execPath, worker, server!.url.toString(), join(dir, `home-${index}`), JSON.stringify(rawSettings[index]), String(issue), String(index), dir, String(expected), scenario], { stdout: 'pipe', stderr: 'pipe' }); return child; });
        const results = await Promise.all(processes.map(async child => ({ code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() })));
        expect(results.every(result => result.code === 0), JSON.stringify(results)).toBe(true);
        const parsed = results.map(result => JSON.parse(result.out));
        expect(parsed.filter(result => result.kind === 'owned'), JSON.stringify(parsed)).toHaveLength(expected);
        expect(maxVendor).toBe(expected);
        if (scenario === 'disjoint') expect(parsed.map(result => result.candidate).every(candidate => candidate.independent && candidate.paths.length === 1)).toBe(true);
        if (scenario === 'absent') expect(parsed.map(result => result.projection).every(projection => !projection.independent && projection.paths.length === 0)).toBe(true);
    } finally { server?.stop(true); await rm(dir, { recursive: true, force: true }); }
}, 20000);
