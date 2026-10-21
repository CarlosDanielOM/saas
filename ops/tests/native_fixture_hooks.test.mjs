import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const checks = fileURLToPath(new URL('../checks/', import.meta.url));

// The five supervised native children. A fixture may execute only its own
// binary; every other one must stay an inert double so a release check cannot
// start a hidden live worker.
const NATIVE = [
    ['stream-activity', '/usr/local/bin/stream_activity'],
    ['raid-analytics', '/usr/local/bin/raid_analytics'],
    ['follow-defense-baseline', '/usr/local/bin/follow_defense_baseline'],
    ['roulette-completion', '/usr/local/bin/roulette_completion'],
    ['ai-usage-receipts', '/usr/local/bin/ai_usage_receipts'],
];

const FIXTURES = [
    ['stream-activity', 'stream_activity_fixture_hooks', 'spawns.jsonl'],
    ['raid-analytics', 'raid_analytics_fixture_hooks', 'raid-spawns.jsonl'],
    ['follow-defense-baseline', 'follow_baseline_fixture_hooks', 'baseline-spawns.jsonl'],
    ['roulette-completion', 'roulette_completion_fixture_hooks', 'roulette-spawns.jsonl'],
];

for (const [name, database, log] of FIXTURES) {
    // This fixture owns one native binary; all four other names must be inert.
    const foreign = NATIVE.filter(([worker]) => worker !== name);
    test(`${name} fixture keeps the other four native children inert`, async () => {
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
                for (const command of ${JSON.stringify(foreign.map(([, command]) => command))}) {
                    const child = spawn(command, ['--telemetry-json'], {
                        env: { MONGO_URI: process.env.MONGO_URI }, uid: 65534, gid: 65534,
                    });
                    assert(child.pid >= 900000, command + ' must remain a fake child');
                    await new Promise(resolve => child.once('spawn', resolve));
                    const closed = new Promise(resolve => child.once('close', resolve));
                    child.kill('SIGTERM'); await closed;
                }
            `);
            const result = spawnSync(process.execPath, ['--import', hook, entry], {
                env: {
                    PATH: process.env.PATH, MONGO_URI: `mongodb://mongo:27017/${database}`, DRAGONFLY_HOST: 'redis',
                    AI_USAGE_RECEIPTS_ENABLED: 'true',
                },
                encoding: 'utf8', timeout: 5000,
            });
            assert.equal(result.status, 0, result.stderr);
            const records = (await readFile(path.join(directory, log), 'utf8')).trim().split('\n').map(JSON.parse);
            assert.equal(records.length, foreign.length);
            // No record may describe a real process for a foreign native binary.
            for (const record of records) assert.equal(record.native, false, `${record.worker} must stay inert`);
            assert.deepEqual(records.map(record => record.worker).sort(), foreign.map(([worker]) => worker).sort());
            for (const record of records) {
                assert.equal(record.command, 'inert-fixture-worker');
                assert(record.pid >= 900000, `${record.worker} must never be executed`);
            }
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
}

test('the four existing fixtures collectively recognize all five native workers', () => {
    const covered = new Set(FIXTURES.flatMap(([name]) => NATIVE.filter(([worker]) => worker !== name).map(([worker]) => worker)));
    assert.deepEqual([...covered].sort(), NATIVE.map(([worker]) => worker).sort());
    assert.equal(NATIVE.length, 5);
});
