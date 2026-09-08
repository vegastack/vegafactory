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

test('contender waits while a live process publishes its mutation guard owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vf-guard-publication-'));
    const module = new URL('../src/claims.ts', import.meta.url).href;
    const worker = join(dir, 'publication.mjs');
    await writeFile(worker, `import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const [dir,role]=process.argv.slice(2),path=dir+'/lease';
const wait=async(name)=>{const until=Date.now()+3000;while(true){try{await fs.access(dir+'/'+name);return}catch{}if(Date.now()>until)throw Error('barrier '+name);await new Promise(r=>setTimeout(r,5))}};
if(role==='owner'){const mkdir=fs.mkdir;fs.mkdir=async(...args)=>{const result=await mkdir(...args);if(args[0]===path+'.guard'){await fs.writeFile(dir+'/unpublished','ready');await wait('publish')}return result}}
else {const lstat=fs.lstat;fs.lstat=async(...args)=>{try{return await lstat(...args)}catch(error){if(args[0]===path+'.guard/owner.json'&&error.code==='ENOENT')await fs.writeFile(dir+'/observed-missing','ready');throw error}}}
syncBuiltinESMExports();
const {acquireClaim,processIdentity}=await import(${JSON.stringify(module)});
const identity=await processIdentity();
if(role==='contender'){await wait('unpublished');await fs.writeFile(dir+'/contending','ready')}
const result=await acquireClaim(path,identity);
await fs.writeFile(dir+'/'+role+'.tmp',JSON.stringify(result));await fs.rename(dir+'/'+role+'.tmp',dir+'/'+role);
if(role==='owner')await wait('finish');`);
    const wait = async (name: string) => {
        const until = Date.now() + 3000;
        for (;;) {
            try { return await readFile(join(dir, name), 'utf8'); } catch {}
            if (Date.now() >= until) throw Error('barrier ' + name);
            await Bun.sleep(5);
        }
    };
    const children = ['owner', 'contender'].map(role => Bun.spawn([Bun.which('node')!, worker, dir, role], { stdout: 'pipe', stderr: 'pipe' }));
    try {
        await wait('observed-missing');
        await writeFile(join(dir, 'publish'), 'go');
        const owner = JSON.parse(await wait('owner')), contender = JSON.parse(await wait('contender'));
        expect(owner.kind).toBe('owned');
        expect(contender).toMatchObject({ kind: 'busy' });
        expect(JSON.parse(await readFile(join(dir, 'lease'), 'utf8')).token).toBe(owner.claim.token);
        await writeFile(join(dir, 'finish'), 'done');
        for (const child of children) expect({ code: await child.exited, err: await new Response(child.stderr).text() }).toEqual({ code: 0, err: '' });
    } finally {
        for (const child of children) child.kill();
        await Promise.all(children.map(child => child.exited));
        await rm(dir, { recursive: true, force: true });
    }
});
