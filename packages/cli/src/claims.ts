// Local claims serialize every mutation. Time is a contention bound, never ownership proof.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
export interface ProcessIdentity {
    pid: number;
    uid: number;
    bootId: string;
    startId: string;
}
export interface Claim {
    path: string;
    token: string;
    identity: ProcessIdentity;
}
export type ClaimResult = {
    kind: 'owned';
    claim: Claim;
} | {
    kind: 'busy' | 'refused';
    reason: string;
};
interface Owner {
    schemaVersion: 1;
    token: string;
    identity: ProcessIdentity;
}
export class ClaimRefusal extends Error {
    readonly kind = 'refused';
    constructor(message: string) { super(message); this.name = 'ClaimRefusal'; }
}
const execute = promisify(execFile);
const same = (a: ProcessIdentity, b: ProcessIdentity) => a.pid === b.pid && a.uid === b.uid && a.bootId === b.bootId && a.startId === b.startId;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function validIdentity(x: unknown): x is ProcessIdentity {
    const o = x as ProcessIdentity;
    return !!o && typeof o === 'object' && Object.keys(o).sort().join(',') === 'bootId,pid,startId,uid' && Number.isSafeInteger(o.pid) && o.pid > 0 && Number.isSafeInteger(o.uid) && o.uid >= 0 && typeof o.bootId === 'string' && o.bootId.length > 0 && o.bootId.length < 256 && typeof o.startId === 'string' && o.startId.length > 0 && o.startId.length < 256;
}
// Only this live process's boot/start tuple is immutable. Never cache another PID,
// liveness, ownership records or decisions. Include both Unix identities in the key.
let selfIdentity: { key: string; probe: Promise<ProcessIdentity> } | undefined;
const selfKey = () => `${process.pid}:${process.getuid?.()}:${process.geteuid?.()}`;
export async function processIdentity(pid = process.pid): Promise<ProcessIdentity> {
    if (pid !== process.pid)
        return probeProcessIdentity(pid);
    const key = selfKey();
    if (selfIdentity?.key !== key) selfIdentity = undefined;
    const entry = selfIdentity ?? { key, probe: probeProcessIdentity(pid) };
    selfIdentity = entry;
    try {
        const identity = await entry.probe;
        if (selfKey() !== key || identity.pid !== process.pid || identity.uid !== process.getuid?.())
            throw new ClaimRefusal('self process identity changed during verification');
        return { ...identity };
    }
    catch (error) {
        if (selfIdentity === entry) selfIdentity = undefined;
        throw error;
    }
}
async function probeProcessIdentity(pid: number): Promise<ProcessIdentity> {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new ClaimRefusal('process identity requires a positive PID');
    try {
        if (process.platform === 'linux') {
            const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
            const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
            const status = await readFile(`/proc/${pid}/status`, 'utf8');
            const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
            const startId = fields[19]!;
            if (!uuid.test(bootId) || !/^\d+$/.test(startId) || !Number.isSafeInteger(uid))
                throw Error('invalid process data');
            return { pid, uid, bootId, startId };
        }
        if (process.platform === 'darwin') {
            const options = { timeout: 2000, maxBuffer: 16384, env: { ...process.env, LC_ALL: 'C' } };
            const boot = (await execute('/usr/sbin/sysctl', ['-n', 'kern.boottime'], options)).stdout.trim();
            const row = (await execute('/bin/ps', ['-p', String(pid), '-o', 'uid=', '-o', 'lstart='], options)).stdout.trim();
            const match = /^(\d+)\s+(.+)$/.exec(row);
            if (!/^\{ sec = \d+, usec = \d+ \}/.test(boot) || !match || !Number.isFinite(Date.parse(match[2]!)))
                throw Error('invalid process data');
            return { pid, uid: Number(match[1]), bootId: boot, startId: match[2]! };
        }
        throw Error('unsupported platform');
    }
    catch {
        throw new ClaimRefusal(`cannot verify process ${pid} boot/start identity on ${process.platform}`);
    }
}
async function stopped(identity: ProcessIdentity): Promise<boolean> {
    try {
        process.kill(identity.pid, 0);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH')
            return true;
        throw new ClaimRefusal('process ownership cannot be inspected');
    }
    try {
        return !same(identity, await processIdentity(identity.pid));
    }
    catch (error) {
        try {
            process.kill(identity.pid, 0);
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ESRCH')
                return true;
        }
        throw error;
    }
}
async function privatePath(path: string, directory = false): Promise<boolean> {
    try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
            throw new ClaimRefusal(`unsafe claim permissions/type: ${path}`);
        return true;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return false;
        throw error;
    }
}
async function owner(path: string): Promise<Owner | null> {
    if (!await privatePath(path))
        return null;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await file.stat();
        if (stat.size > 8192)
            throw Error('oversized');
        const o = JSON.parse(await file.readFile('utf8')) as Owner;
        if (Object.keys(o).sort().join(',') !== 'identity,schemaVersion,token' || o.schemaVersion !== 1 || !uuid.test(o.token) || !validIdentity(o.identity))
            throw Error('invalid');
        return o;
    }
    catch {
        throw new ClaimRefusal(`unreadable, corrupt or legacy claim: ${path}; stop service and inspect preserved evidence`);
    }
    finally {
        await file.close();
    }
}
async function syncDir(path: string) { const fd = await open(path, 'r'); try {
    await fd.sync();
}
finally {
    await fd.close();
} }
async function atomicOwner(path: string, value: Owner) {
    const temp = `${path}.${randomUUID()}.tmp`;
    const fd = await open(temp, 'wx', 0o600);
    try {
        await fd.writeFile(JSON.stringify(value) + '\n');
        await fd.sync();
    }
    finally {
        await fd.close();
    }
    try {
        await rename(temp, path);
        await syncDir(dirname(path));
    }
    catch (error) {
        await rm(temp, { force: true });
        throw error;
    }
}
class ClaimBusy extends ClaimRefusal {}
async function guarded<T>(path: string, identity: ProcessIdentity, mutate: () => Promise<T>): Promise<T> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await privatePath(dirname(path), true);
    const guard = path + '.guard', token = randomUUID(), deadline = Date.now() + 2000;
    for (;;) {
        try {
            await mkdir(guard, { mode: 0o700 });
            break;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                throw error;
            await privatePath(guard, true);
            const held = await owner(guard + '/owner.json').catch(error => {
                // The owner can finish releasing between inspection and open.
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            });
            if (held && await stopped(held.identity))
                throw new ClaimRefusal(`abandoned mutation guard: ${guard}; offline operator recovery required`);
            if (Date.now() >= deadline)
                throw new ClaimBusy(`mutation guard busy: ${guard}`);
            await sleep(50);
        }
    }
    // Missing publication may be in progress or abandoned: wait only, never reclaim it.
    // A failed publication preserves the guard for offline recovery.
    await atomicOwner(guard + '/owner.json', { schemaVersion: 1, token, identity });
    try {
        return await mutate();
    }
    finally {
        const held = await owner(guard + '/owner.json');
        if (held?.token === token && same(held.identity, identity)) {
            await rm(guard + '/owner.json');
            await rmdir(guard);
            await syncDir(dirname(path));
        }
    }
}
export async function acquireClaim(path: string, identity: ProcessIdentity): Promise<ClaimResult> {
    try {
        if (!validIdentity(identity) || !same(identity, await processIdentity()))
            throw new ClaimRefusal('claimant must be this verified process');
        return await guarded(path, identity, async () => {
            const prior = await owner(path);
            if (prior && !await stopped(prior.identity))
                return { kind: 'busy', reason: `claim held by process ${prior.identity.pid}` } as const;
            const claim = { path, token: randomUUID(), identity };
            await atomicOwner(path, { schemaVersion: 1, token: claim.token, identity });
            return { kind: 'owned', claim } as const;
        });
    }
    catch (error) {
        return { kind: error instanceof ClaimBusy ? 'busy' : 'refused', reason: (error as Error).message };
    }
}
export async function releaseClaim(claim: Claim): Promise<void> {
    const identity = await processIdentity();
    if (!same(identity, claim.identity))
        return;
    await guarded(claim.path, identity, async () => { const held = await owner(claim.path); if (held?.token === claim.token && same(held.identity, claim.identity)) {
        await rm(claim.path);
        await syncDir(dirname(claim.path));
    } });
}
export async function renewClaim(claim: Claim): Promise<void> {
    const identity = await processIdentity();
    if (!same(identity, claim.identity))
        throw new ClaimRefusal('wrong claim owner');
    await guarded(claim.path, identity, async () => { const held = await owner(claim.path); if (held?.token !== claim.token || !same(held.identity, identity))
        throw new ClaimRefusal('wrong claim owner'); await atomicOwner(claim.path, held); });
}
export async function inspectClaim(path: string): Promise<{
    kind: 'absent' | 'held' | 'stopped' | 'refused';
    pid: number | null;
    reason?: string;
    token?: string;
}> {
    try {
        const held = await owner(path);
        if (!held)
            return { kind: 'absent', pid: null };
        return { kind: await stopped(held.identity) ? 'stopped' : 'held', pid: held.identity.pid, token: held.token };
    }
    catch (error) {
        return { kind: 'refused', pid: null, reason: (error as Error).message };
    }
}
