import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const checks = fileURLToPath(new URL('../checks/', import.meta.url));
for (const [name, database, log] of [
    ['stream-activity', 'stream_activity_fixture_hooks', 'spawns.jsonl'],
    ['raid-analytics', 'raid_analytics_fixture_hooks', 'raid-spawns.jsonl'],
    ['follow-defense-baseline', 'follow_baseline_fixture_hooks', 'baseline-spawns.jsonl'],
]) {
    test(`${name} fixture keeps the fourth native roulette child inert`, async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'saas-native-hook-'));
        try {
            const workers = path.join(directory, 'dist/workers');
            await mkdir(workers, { recursive: true });
            await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
            const source = await readFile(path.join(checks, `${name}-rust-fixtures/cron-boot.mjs`), 'utf8');
            const hook = path.join(directory, 'hook.mjs');
            await writeFile(hook, source.replaceAll('/tmp/saas-fixtures', directory));
            const entry = path.join(workers, 'cron.index.js');
            await writeFile(entry, `
                import assert from 'node:assert/strict';
                import { spawn } from 'node:child_process';
                const child = spawn('/usr/local/bin/roulette_completion', ['--telemetry-json'], {
                    env: { MONGO_URI: process.env.MONGO_URI }, uid: 65534, gid: 65534,
                });
                assert(child.pid >= 900000, 'roulette must remain a fake child');
                await new Promise(resolve => child.once('spawn', resolve));
                const closed = new Promise(resolve => child.once('close', resolve));
                child.kill('SIGTERM'); await closed;
            `);
            const result = spawnSync(process.execPath, ['--import', hook, entry], {
                env: { PATH: process.env.PATH, MONGO_URI: `mongodb://mongo:27017/${database}`, DRAGONFLY_HOST: 'redis' },
                encoding: 'utf8', timeout: 5000,
            });
            assert.equal(result.status, 0, result.stderr);
            const records = (await readFile(path.join(directory, log), 'utf8')).trim().split('\n').map(JSON.parse);
            assert.equal(records.length, 1);
            assert.equal(records[0].worker, 'roulette-completion');
            assert.equal(records[0].native, false);
            assert.equal(records[0].command, 'inert-fixture-worker');
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
}
