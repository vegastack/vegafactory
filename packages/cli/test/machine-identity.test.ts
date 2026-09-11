import { test, expect } from 'bun:test';
import { hostBindingDigest, readHostBinding, readBootIdentityDigest } from '../src/machine-identity.ts';
test('host bindings validate OS formats and use distinct platform domains', () => {
    const linux = '1234567890abcdef1234567890abcdef';
    const mac = '"IOPlatformUUID" = "12345678-90AB-CDEF-1234-567890ABCDEF"';
    expect(hostBindingDigest('linux', linux)).toMatch(/^[a-f0-9]{64}$/);
    expect(hostBindingDigest('darwin', mac)).not.toBe(hostBindingDigest('linux', linux));
    for (const value of ['', '0'.repeat(32), 'token', 'path/to/file'])
        expect(() => hostBindingDigest('linux', value)).toThrow();
    expect(() => hostBindingDigest('darwin', 'private data')).toThrow('source missing or invalid');
});
test('local OS identity exposes only validated digests', async () => {
    expect((await readHostBinding()).digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readBootIdentityDigest()).toMatch(/^[a-f0-9]{64}$/);
});
