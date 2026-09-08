import { test, expect } from 'bun:test';
import { mkdtemp, readFile, writeFile, chmod, symlink, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireClaim, releaseClaim, renewClaim, processIdentity, inspectClaim } from '../src/claims.ts';
async function fixture() { return join(await mkdtemp(join(tmpdir(), 'vf-claims-')), 'lease'); }
test('one acquisition wins, wrong token cannot release or renew the owner', async () => {
    const path = await fixture(), identity = await processIdentity();
    const results = await Promise.all([acquireClaim(path, identity), acquireClaim(path, identity)]);
    expect(results.filter(r => r.kind === 'owned')).toHaveLength(1);
    const result = results.find(r => r.kind === 'owned')!;
    if (result.kind !== 'owned')
        throw Error('missing claim');
    const before = await readFile(path, 'utf8');
    await releaseClaim({ ...result.claim, token: crypto.randomUUID() });
    expect(await readFile(path, 'utf8')).toBe(before);
    await expect(renewClaim({ ...result.claim, token: crypto.randomUUID() })).rejects.toThrow('owner');
    await renewClaim(result.claim);
    await releaseClaim(result.claim);
    expect((await inspectClaim(path)).kind).toBe('absent');
    const next = await acquireClaim(path, identity);
    expect(next.kind).toBe('owned');
    await releaseClaim(result.claim);
    expect((await inspectClaim(path)).kind).toBe('held');
});
test('unreadable, corrupt, legacy, symlink and abandoned guard refuse without removal', async () => {
    const identity = await processIdentity();
    for (const mode of ['corrupt', 'legacy', 'permission', 'symlink', 'guard']) {
        const path = await fixture();
        if (mode === 'guard')
            await mkdir(path + '.guard', { mode: 0o700 });
        else if (mode === 'symlink') {
            await writeFile(path + '.target', 'secret');
            await symlink(path + '.target', path);
        }
        else {
            await writeFile(path, mode === 'legacy' ? JSON.stringify({ pid: 99999999 }) : '{', { mode: 0o600 });
            if (mode === 'permission')
                await chmod(path, 0o644);
        }
        expect((await acquireClaim(path, identity)).kind, mode).toBe('refused');
    }
});
test('different start identity is stale and reclaimed, but unverifiable identity refuses', async () => {
    const path = await fixture(), identity = await processIdentity(), result = await acquireClaim(path, identity);
    if (result.kind !== 'owned')
        throw Error('missing');
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.identity.startId = 'prior-process-start';
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    const replacement = await acquireClaim(path, identity);
    expect(replacement.kind).toBe('owned');
    await releaseClaim(result.claim);
    expect((await inspectClaim(path)).kind).toBe('held');
    await expect(processIdentity(-1)).rejects.toThrow();
    await rm(path, { force: true });
});

// Isolated subprocess keeps OS-probe mocks out of every real ownership test.
test('self identity shares only successful probes, copies results and rechecks PID/UID/effective UID', async () => {
    const source = new URL('../src/claims.ts', import.meta.url).href;
    const script = `
        import assert from 'node:assert/strict';
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        let pid = 100, uid = 501, euid = 501, calls = 0, fail = false, release;
        Object.defineProperty(process, 'pid', { get: () => pid });
        process.getuid = () => uid; process.geteuid = () => euid;
        function execFile(file, args, options, callback) {
            calls++;
            const respond = () => callback(fail ? Error('probe failed') : null,
                file.endsWith('sysctl') ? '{ sec = 1, usec = 0 }' : String(uid) + ' Tue Sep  8 12:00:00 2026', '');
            if (release === null) release = respond; else queueMicrotask(respond);
        }
        execFile[Symbol.for('nodejs.util.promisify.custom')] = (...args) => new Promise((resolve, reject) => execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({stdout, stderr})));
        cp.execFile = execFile; syncBuiltinESMExports();
        const { processIdentity } = await import(${JSON.stringify(source)});
        fail = true;
        await assert.rejects(processIdentity(), /cannot verify/);
        const afterFailure = calls; fail = false;
        const values = await Promise.all([processIdentity(), processIdentity(), processIdentity()]);
        assert.equal(calls - afterFailure, 2);
        const first = { ...values[0] }; values[0].startId = 'mutated';
        assert.deepEqual(values[1], first); assert.deepEqual(await processIdentity(), first);
        assert.equal(calls - afterFailure, 2);
        await processIdentity(200); await processIdentity(200);
        assert.equal(calls - afterFailure, 6);
        uid++; assert.equal((await processIdentity()).uid, uid);
        euid++; await processIdentity(); pid++; assert.equal((await processIdentity()).pid, pid);
        assert.equal(calls - afterFailure, 12);
        // Changing identity during the initial probe must never publish the old tuple.
        pid++; release = null;
        const pending = processIdentity(); await new Promise(r => setTimeout(r, 0));
        uid++; release();
        await assert.rejects(pending, /changed/);
        assert.equal((await processIdentity()).uid, uid);
        // A failed replacement must not revive the old memo when the key returns.
        const oldUid = uid; uid++; fail = true;
        await assert.rejects(processIdentity());
        uid = oldUid; fail = false; const beforeRetry = calls;
        await processIdentity(); assert.equal(calls - beforeRetry, 2);
        console.log(JSON.stringify({ immutableSelfProbes: 1, concurrentCallers: 3, macOSCommandsPerSelfProbe: 2, foreignProbes: 2 }));
    `;
    const child = Bun.spawn([Bun.which('node')!, '--input-type=module', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout).immutableSelfProbes).toBe(1);
});

test('memoized self identity never accepts a changed claimant tuple', async () => {
    const path = await fixture(), identity = await processIdentity(), held = await acquireClaim(path, identity);
    if (held.kind !== 'owned') throw Error('claim');
    const before = await readFile(path, 'utf8');
    for (const wrong of [{ ...identity, pid: identity.pid + 1 }, { ...identity, uid: identity.uid + 1 }, { ...identity, bootId: 'other-boot' }, { ...identity, startId: 'other-start' }]) {
        expect((await acquireClaim(path, wrong)).kind).toBe('refused');
        await releaseClaim({ ...held.claim, identity: wrong });
        await expect(renewClaim({ ...held.claim, identity: wrong })).rejects.toThrow();
        expect(await readFile(path, 'utf8')).toBe(before);
    }
    await releaseClaim(held.claim);
});
