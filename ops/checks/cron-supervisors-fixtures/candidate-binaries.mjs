// Filesystem-only fixture API. Never expose an executable override in production.
import assert from 'node:assert/strict';
import { open, readFile, rename, writeFile, unlink, chmod, stat } from 'node:fs/promises';
import { NATIVE } from './native-cron-fixture.mjs';
export async function withCandidateBinaries(work, env = process.env) {
    const uri = new URL(env.MONGO_URI || '');
    assert.equal(uri.hostname, 'mongo'); assert.match(uri.pathname, /^\/cron_supervisors_fixture_[a-zA-Z0-9_]+$/);
    assert.equal(env.DRAGONFLY_HOST, 'redis'); assert.equal(env.DRAGONFLY_PORT, '6379');
    assert.equal(process.getuid(), 0);
    await readFile('/tmp/saas-fixtures/cron-boot.mjs');
    // docker cp may preserve the staging mktemp directory's root-only mode.
    // The nobody-owned shell children must be able to inspect their marker.
    const fixtureMode = (await stat('/tmp/saas-fixtures')).mode & 0o777;
    const lockPath = '/tmp/saas-fixtures/native-binary-substitution.lock';
    const lock = await open(lockPath, 'wx'); const owned = [];
    try {
        await chmod('/tmp/saas-fixtures', fixtureMode | 0o555);
        const script = await readFile('/tmp/saas-fixtures/native-child.sh');
        for (const worker of ['roulette-completion', 'raid-sessions']) {
            const binary = NATIVE[worker], backup = `${binary}.cron-fixture-${process.pid}`;
            await rename(binary, backup); const entry = { binary, backup, written: false }; owned.push(entry);
            await writeFile(binary, script, { mode: 0o755, flag: 'wx' }); entry.written = true;
        }
        return await work();
    } finally {
        try {
            for (const { binary, backup, written } of owned.reverse()) {
                if (written) await unlink(binary); await rename(backup, binary);
            }
        } finally {
            await lock.close(); await unlink(lockPath);
            await chmod('/tmp/saas-fixtures', fixtureMode);
        }
    }
}
