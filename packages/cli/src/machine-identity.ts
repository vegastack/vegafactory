import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ClaimRefusal, processIdentity } from './claims.ts';
// Raw OS identifiers never leave this function or appear in a diagnostic.
export function hostBindingDigest(platform: 'darwin' | 'linux', source: string): string {
    const raw = platform === 'darwin' ? /"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]+)"/.exec(source)?.[1] : source.trim();
    if (!raw || (platform === 'darwin' ? !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(raw) : !/^[a-f0-9]{32}$/i.test(raw)) || /^0+$/.test(raw.replaceAll('-', '')))
        throw new ClaimRefusal('host binding source missing or invalid');
    return createHash('sha256').update(`VegaFactory/host-binding/v1\n${platform}\n${raw.toLowerCase()}`).digest('hex');
}
export async function readHostBinding(): Promise<{
    digest: string;
    platform: 'darwin' | 'linux';
}> {
    try {
        const platform = process.platform;
        if (platform !== 'darwin' && platform !== 'linux')
            throw Error('unsupported');
        const source = platform === 'darwin' ? (await promisify(execFile)('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 2000, maxBuffer: 65536 })).stdout : await readFile('/etc/machine-id', 'utf8');
        return { platform, digest: hostBindingDigest(platform, source) };
    }
    catch {
        throw new ClaimRefusal('cannot verify host binding on this platform');
    }
}
export async function readBootIdentityDigest(): Promise<string> {
    const identity = await processIdentity();
    return createHash('sha256').update(`VegaFactory/boot/v1\n${identity.bootId}`).digest('hex');
}
