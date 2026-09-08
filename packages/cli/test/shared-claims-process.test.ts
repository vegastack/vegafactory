import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, taskKey } from '../src/shared-claims.ts';
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
