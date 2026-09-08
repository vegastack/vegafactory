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
