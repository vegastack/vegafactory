import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
test('two actual processes synchronized after inspection enter once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vf-claim-process-'));
    const worker = join(dir, 'worker.ts');
    await writeFile(worker, `import {readLock,holdLock} from ${JSON.stringify(resolve('packages/cli/src/dispatch.ts'))};
import {writeFile,access,appendFile} from 'node:fs/promises';
const [path,barrier,id,sentinel]=process.argv.slice(2); await readLock(path);
await writeFile(barrier+id,'ready'); for (;;) {try {await access(barrier+'0');await access(barrier+'1');break}catch {await Bun.sleep(5)}}
try {await holdLock(path,process.pid); await appendFile(sentinel,'entered\\n'); await Bun.sleep(400);process.stdout.write('owned')}catch {process.stdout.write('busy')}`);
    try {
        const workers = [0, 1].map(id => Bun.spawn([process.execPath, worker, join(dir, 'lease'), join(dir, 'barrier'), String(id), join(dir, 'sentinel')], { stdout: 'pipe', stderr: 'pipe' }));
        const results = await Promise.all(workers.map(async (worker) => ({ code: await worker.exited, out: await new Response(worker.stdout).text(), err: await new Response(worker.stderr).text() })));
        expect(results.every(row => row.code === 0), JSON.stringify(results)).toBe(true);
        expect((await readFile(join(dir, 'sentinel'), 'utf8')).trim().split('\n')).toHaveLength(1);
        expect(results.filter(row => row.out === 'owned')).toHaveLength(1);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('watch refuses a second live process and recovers only after the original process exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vf-watch-owner-')), worker = join(dir, 'watch.ts');
    const config = { repos: [], interval: 1, maxRuns: 1, subagents: { spawnDepth: 1, concurrent: 3 }, controlRoom: {}, home: dir, stateFile: join(dir, 'state.json'), logRoot: join(dir, 'logs'), lockRoot: join(dir, 'locks'), dispatcherLock: join(dir, 'watch.lock') };
    await writeFile(worker, `import {watch} from ${JSON.stringify(resolve('packages/cli/src/dispatch.ts'))};import {writeFile} from 'node:fs/promises';try{await watch(${JSON.stringify(config)},{dryRun:true,onTick:async()=>{await writeFile(process.argv[2],'entered')}})}catch(e){process.stderr.write(e.message);process.exitCode=2}`);
    const first = Bun.spawn([process.execPath, worker, join(dir, 'first')], { stdout: 'pipe', stderr: 'pipe' });
    let replacement: ReturnType<typeof Bun.spawn> | undefined;
    try {
        for (let i = 0; i < 100; i++) {
            try {
                await readFile(join(dir, 'first'));
                break;
            }
            catch {
                await Bun.sleep(10);
            }
        }
        expect(await readFile(join(dir, 'first'), 'utf8')).toBe('entered');
        const second = Bun.spawn([process.execPath, worker, join(dir, 'second')], { stdout: 'pipe', stderr: 'pipe' });
        expect(await second.exited).toBe(2);
        first.kill('SIGKILL');
        await first.exited;
        replacement = Bun.spawn([process.execPath, worker, join(dir, 'replacement')], { stdout: 'pipe', stderr: 'pipe' });
        for (let i = 0; i < 100; i++) {
            try {
                await readFile(join(dir, 'replacement'));
                break;
            }
            catch {
                await Bun.sleep(10);
            }
        }
        expect(await readFile(join(dir, 'replacement'), 'utf8')).toBe('entered');
    }
    finally {
        first.kill();
        replacement?.kill();
        await replacement?.exited;
        await rm(dir, { recursive: true, force: true });
    }
}, 5000);
