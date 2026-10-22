// Exact-candidate check, executed only by the lead's isolated saas-ops verifier.
// Stage cron-supervisors-fixtures/*, native-cron-fixture.mjs and exact
// dima-analytics/src/store.mjs as analytics-store.mjs. Requires disposable mongo/redis.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink, readdir, chmod } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { NATIVE, rustRegistry, processIdentity, diagnosticParser, assertSelectedNatives } from '/tmp/saas-fixtures/native-cron-fixture.mjs';
import { withCandidateBinaries } from '/tmp/saas-fixtures/candidate-binaries.mjs';
import { standaloneMetricsReady } from '/tmp/saas-fixtures/telemetry-assertions.mjs';

const uri = new URL(process.env.MONGO_URI || '');
assert.equal(uri.hostname, 'mongo'); assert.match(uri.pathname, /^\/cron_supervisors_fixture_[a-zA-Z0-9_]+$/);
assert.equal(process.env.DRAGONFLY_HOST, 'redis'); assert.equal(process.env.DRAGONFLY_PORT, '6379');
const require = createRequire('/app/package.json');
const { createClient } = require('redis');
const { MongoClient } = require('mongodb');
const redis = createClient({ url: 'redis://redis:6379', socket: { reconnectStrategy: false } }); redis.on('error', () => {});
const mongo = new MongoClient(uri.href, { serverSelectionTimeoutMS: 5000, timeoutMS: 5000 });
const ownedDatabases = new Set(), children = new Set(), groups = new Set();
const deadline = Date.now() + 190000;
const SELECTED = ['stream-activity', 'raid-analytics'];
const source = await readFile('/tmp/saas-fixtures/analytics-store.mjs', 'utf8');
assert(source.startsWith("import pg from 'pg';\n"));
const { validateBatch } = await import('data:text/javascript,' + encodeURIComponent(source.replace("import pg from 'pg';", 'const pg = {};')));
const privacy = value => assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|mongodb:\/\//);
async function waitFor(check, label, ms = 20000) {
    const end = Math.min(deadline, Date.now() + ms);
    do { const value = await check(); if (value) return value; await delay(40); } while (Date.now() < end);
    throw new Error(`Timed out: ${label}`);
}
async function bounded(promise, ms, label) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms); })]); }
    finally { clearTimeout(timer); }
}
async function records(scope = 'main') {
    let text;
    try { text = await readFile('/tmp/saas-fixtures/cron-supervisors.jsonl', 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return text.split('\n').filter(Boolean).map(JSON.parse).filter(row => row.scope === scope);
}
function current(rows, worker) {
    const exited = new Set(rows.filter(row => row.event === 'exit').map(row => row.pid));
    return rows.filter(row => row.event === 'spawn' && row.worker === worker && !exited.has(row.pid)).at(-1);
}
function counts(rows) {
    return Object.fromEntries([...new Set(rows.map(row => row.worker))].map(worker => [worker, rows.filter(row => row.worker === worker && row.event === 'spawn').length]));
}
async function stopped(pid) {
    try { return /^State:\s+[ZX]/m.test(await readFile(`/proc/${pid}/status`, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
function launch(command, args, env, extra = {}) {
    assert(Date.now() < deadline);
    const { captureStdout = true, ...spawnOptions } = extra;
    const child = spawn(command, args, { cwd: '/app', env, stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    children.add(child); if (extra.detached) groups.add(child.pid);
    child.output = '';
    const capture = chunk => {
        const next = child.output + chunk;
        if (next.length > 131072) child.outputOverflow = true;
        child.output = next.slice(-131072);
    };
    if (captureStdout) child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.completion = new Promise((resolve, reject) => {
        child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output: child.output }));
    });
    child.completion.catch(() => {}); return child;
}
async function finished(child, ms = 29000) {
    const result = await bounded(child.completion, Math.min(ms, deadline - Date.now()), 'owned fixture process');
    children.delete(child); if (groups.delete(child.pid)) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    assert(!child.outputOverflow, 'bounded supervisor output');
    return result;
}
function observe(child, selected) {
    const rows = []; let failure;
    const parse = diagnosticParser({ selected, rustPid: child.pid, record: row => rows.push(row) });
    child.stdout.on('data', chunk => { try { parse(chunk); } catch (error) { failure ||= error; } });
    return { rows, check() { if (failure) throw failure; } };
}
function scopedEnv(scope) {
    const selected = new URL(uri); selected.pathname = `/cron_supervisors_fixture_${process.pid}_${scope.replaceAll('-', '_')}`;
    ownedDatabases.add(selected.pathname.slice(1));
    return { ...process.env, MONGO_URI: selected.href, CRON_SUPERVISORS_FIXTURE_SCOPE: scope };
}
async function auxiliary(scope, runtime = 'node') {
    const child = launch(process.execPath, ['/app/dist/workers/cron.index.js'], { ...scopedEnv(scope), CRON_WORKER_RUNTIME: runtime });
    const rows = await waitFor(async () => { const rows = await records(scope); return SELECTED.every(worker => current(rows, worker)) && current(rows, 'follow-ledger') ? rows : null; }, `${scope} dual ownership`);
    assertSelectedNatives(rows, SELECTED); return { child, rows };
}
async function assertNoExtraNative(rustPid) {
    const found = [];
    for (const directory of await readdir('/proc')) {
        if (!/^\d+$/.test(directory)) continue;
        try {
            const identity = processIdentity(Number(directory));
            if (identity.parentPid !== rustPid) continue;
            const command = (await readFile(`/proc/${directory}/cmdline`, 'utf8')).split('\0')[0];
            found.push(command);
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    assert.deepEqual(found.sort(), SELECTED.map(name => NATIVE[name]).sort(), 'no hidden unselected worker or provider process');
}
async function hash(binary) { return createHash('sha256').update(await readFile(binary)).digest('hex'); }

try {
    await redis.connect(); await mongo.connect();
    const { WORKERS, resolveWorkerLaunch } = await import('/app/dist/workers/cron.index.js');
    const { resolveNativeIndexLaunch, NATIVE_BRIDGE_SHUTDOWN_MS } = await import('/app/dist/workers/cron_native_bridge.js');
    const { TYPESCRIPT_SHUTDOWN_MS } = await import('/app/dist/workers/cron.index.js');
    assert.equal(WORKERS.length, 19); assert(WORKERS.every(worker => worker.kind === 'typescript'));
    assert.equal(TYPESCRIPT_SHUTDOWN_MS, 25000); assert.equal(NATIVE_BRIDGE_SHUTDOWN_MS, 28000);
    const registry = rustRegistry(); assert.equal(registry.length, 7);
    for (const runtime of ['node', 'tsx']) {
        const launch = resolveNativeIndexLaunch({ once: false, dryRun: false }, { ...process.env, NODE_OPTIONS: 'PRIVATE_NODE', SECRET_KEY: 'PRIVATE_SECRET' }, 0);
        assert.equal(launch.command, '/usr/local/bin/cron_index'); assert.equal(launch.options.detached, true);
        assert.equal(launch.options.uid, 65534); assert.equal(launch.options.gid, 65534);
        assert.equal(launch.options.env.NODE_OPTIONS, undefined); assert.equal(launch.options.env.SECRET_KEY, undefined);
        assert.equal(launch.options.env.UNRELATED_FIXTURE_SECRET, undefined);
        const control = resolveWorkerLaunch(WORKERS.find(worker => worker.name === 'follow-ledger'), { runtime, once: false, dryRun: false, restartDelayMs: 1000 }, process.env);
        assert.equal(control.command, runtime === 'node' ? process.execPath : 'tsx');
        assert(control.args[0].endsWith(runtime === 'node' ? '/follow_ledger.worker.js' : '/follow_ledger.worker.ts'));
    }
    const rows = await waitFor(async () => { const rows = await records(); return SELECTED.every(worker => current(rows, worker)) && rows.filter(row => row.event === 'spawn' && !row.native).length === 19 ? rows : null; }, 'main supervisor process tree');
    assertSelectedNatives(rows, SELECTED);
    const bridge = rows.find(row => row.event === 'rust-supervisor'), root = bridge.supervisor;
    const indexIdentity = processIdentity(bridge.pid);
    assert.equal(indexIdentity.parentPid, root); assert.equal(indexIdentity.processGroup, bridge.pid);
    assert.equal(indexIdentity.effectiveUid, 65534); assert.equal(indexIdentity.effectiveGid, 65534);
    for (const worker of SELECTED) {
        const row = current(rows, worker), identity = processIdentity(row.pid);
        assert.equal(identity.parentPid, bridge.pid); assert.equal(identity.processGroup, bridge.pid);
        assert.equal(identity.effectiveUid, 65534); assert.equal(identity.effectiveGid, 65534);
        assert.deepEqual(row.envKeys, registry.find(item => item.name === worker).envKeys.sort());
    }
    assert.equal(processIdentity(current(rows, 'follow-ledger').pid).parentPid, root);
    await assertNoExtraNative(bridge.pid);
    console.log('PASS actual Node parent owns 19 TS definitions and one detached UID65534 Rust index; two selected natives belong only to Rust');

    const beforeNative = counts(rows), stream = current(rows, 'stream-activity'), stableRaid = current(rows, 'raid-analytics');
    process.kill(stream.pid, 'SIGKILL');
    const replacement = await waitFor(async () => { const row = current(await records(), 'stream-activity'); return row && row.pid !== stream.pid ? row : null; }, 'Rust self-heals only stream child');
    const afterNative = await records(); assert.equal(replacement.rustSupervisor, bridge.pid);
    assert.equal(current(afterNative, 'raid-analytics').pid, stableRaid.pid);
    for (const [name, count] of Object.entries(beforeNative)) assert.equal(counts(afterNative)[name], count + (name === 'stream-activity' ? 1 : 0));
    assert(afterNative.some(row => row.event === 'exit' && row.pid === stream.pid && row.restarting === true && row.signal === 'SIGKILL'));
    const control = current(afterNative, 'follow-ledger'); assert.equal(control.actualTypescript, true);
    assert.equal(await readFile(`/proc/${control.pid}/cmdline`, 'utf8').then(value => value.split('\0')[1]), '/tmp/saas-fixtures/typescript-child.mjs');
    process.kill(control.pid, 'SIGKILL');
    const controlReplacement = await waitFor(async () => { const row = current(await records(), 'follow-ledger'); return row && row.pid !== control.pid ? row : null; }, 'actual TS self-heal');
    assert.equal(controlReplacement.actualTypescript, true);
    const afterTs = await records(); assert.equal(current(afterTs, 'stream-activity').pid, replacement.pid); assert.equal(current(afterTs, 'raid-analytics').pid, stableRaid.pid);
    for (const [name, count] of Object.entries(counts(afterNative))) assert.equal(counts(afterTs)[name], count + (name === 'follow-ledger' ? 1 : 0));
    assert.equal(afterTs.filter(row => row.event === 'rust-supervisor').length, 1);
    console.log('PASS a real native SIGKILL restarts only that Rust child; an actual harmless Node child SIGKILL self-heals through the TS supervisor');

    const crashed = await auxiliary('crash'); const crashedBridge = crashed.rows.find(row => row.event === 'rust-supervisor');
    const ownedPids = SELECTED.map(name => current(crashed.rows, name).pid);
    ownedPids.push(current(crashed.rows, 'follow-ledger').pid);
    process.kill(crashedBridge.pid, 'SIGKILL'); const crashedResult = await finished(crashed.child);
    assert.notEqual(crashedResult.code, 0); assert.equal(crashedResult.signal, null);
    await waitFor(async () => (await Promise.all(ownedPids.map(stopped))).every(Boolean), 'bridge kills remaining native group and TS host children');
    const crashRows = await records('crash'); assert.equal(crashRows.filter(row => row.event === 'rust-supervisor').length, 1);
    assert.equal(crashRows.filter(row => row.event === 'spawn' && row.native).length, 2);
    assert.equal((await records()).filter(row => row.event === 'rust-supervisor').length, 1, 'main Node host stays alive');
    assert(!(await stopped(root))); assert(!(await stopped(replacement.pid))); assert(!(await stopped(stableRaid.pid)));
    console.log('PASS unexpected Rust-index death kills its surviving process group, fails Node closed and never starts a replacement index');

    const graceful = await auxiliary('graceful', 'tsx'), started = Date.now(); graceful.child.kill('SIGTERM');
    const gracefulResult = await finished(graceful.child); assert.equal(gracefulResult.code, 0, gracefulResult.output);
    assert(Date.now() - started < 28000, 'concurrent TS/Rust drains fit beneath the bridge deadline');
    for (const name of SELECTED) {
        const pid = current(graceful.rows, name).pid;
        const exit = (await records('graceful')).find(row => row.event === 'exit' && row.pid === pid);
        assert(exit && exit.code === 0 && exit.signal === null && exit.restarting === false);
        assert(await stopped(pid));
    }
    assert.equal((await records('graceful')).filter(row => row.event === 'spawn' && row.native).length, 2);
    console.log('PASS real tsx-configured Node host drains Rust children normally without child restarts under the 28-second bridge deadline');

    // These two binaries are unselected by every still-running Node fixture.
    // The standalone tests use the real index plus shell fixtures, with no Node child.
    const substituted = ['roulette-completion', 'raid-sessions'];
    const hashes = await Promise.all(substituted.map(name => hash(NATIVE[name])));
    await withCandidateBinaries(async () => {
        const scopedChildren = new Set();
        const standalone = (...args) => { const child = launch(...args); scopedChildren.add(child); return child; };
        try {
            const env = { MONGO_URI: scopedEnv('standalone').MONGO_URI, PATH: process.env.PATH,
                DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379', CRON_WORKER_RESTART_DELAY_MS: '1000',
                NODE_OPTIONS: 'PRIVATE_NODE_OPTIONS', CLIENT_SECRET: 'PRIVATE_PROVIDER_SECRET', SECRET_KEY: 'PRIVATE_SECRET' };
            const args = ['--workers', substituted.join(','), '--events-json'];
            for (const failing of [false, true]) {
                if (failing) await writeFile('/tmp/saas-fixtures/fail-roulette-once', 'fixture');
                const child = standalone('/usr/local/bin/cron_index', [...args, '--once'], env, { uid: 65534, gid: 65534, detached: true });
                const observation = observe(child, substituted), captured = observation.rows;
                const result = await finished(child); observation.check(); privacy(result.output);
                assert.equal(result.signal, null); assert.equal(result.code, failing ? 1 : 0);
                assert.equal(captured.filter(row => row.event === 'spawn').length, 2);
                assert.equal(captured.filter(row => row.event === 'batch').length, 2, 'only one valid batch per child survives hostile output');
                for (const row of captured.filter(row => row.event === 'batch')) assert.deepEqual(row.frame, { event: 'batch', events: 3, durationMs: 2, success: true });
                assert(captured.filter(row => row.event === 'spawn').every(row => row.args.includes('--once')));
                assert(captured.filter(row => row.event === 'exit').every(row => row.restarting === false));
                assert.equal(captured.filter(row => row.event === 'restart').length, 0);
                const scope = failing ? 'once-failure' : 'once-success';
                const nodeOnce = standalone(process.execPath, ['/app/dist/workers/cron.index.js', '--once'], scopedEnv(scope));
                const nodeResult = await finished(nodeOnce); assert.equal(nodeResult.code, failing ? 1 : 0, nodeResult.output);
                assert.equal(nodeResult.signal, null);
                const onceRows = await records(scope); assertSelectedNatives(onceRows, substituted);
                assert.equal(onceRows.filter(row => row.event === 'spawn' && !row.native).length, 19);
                assert.equal(onceRows.filter(row => row.event === 'spawn' && row.native).length, 2);
                assert(onceRows.filter(row => row.event === 'spawn' && row.native).every(row => row.args.includes('--once')));
                assert(onceRows.filter(row => row.event === 'exit' && row.rustSupervisor).every(row => row.restarting === false));
                if (failing) {
                    assert(captured.some(row => row.worker === 'roulette-completion' && row.event === 'exit' && row.code === 7));
                    assert(captured.some(row => row.worker === 'raid-sessions' && row.event === 'exit' && row.code === 0));
                    await unlink('/tmp/saas-fixtures/fail-roulette-once');
                }
            }
            const previousInstances = new Set((await redis.lRange('observability:v1:inbox', 0, -1)).map(row => JSON.parse(row).instance));
            const nodeFree = standalone('/usr/local/bin/cron_index', args, env, { uid: 65534, gid: 65534, detached: true });
            const observation = observe(nodeFree, substituted), captured = observation.rows;
            await waitFor(() => { observation.check(); return captured.filter(row => row.event === 'batch').length === 2; }, 'standalone validated frames');
            for (const row of captured.filter(row => row.event === 'spawn')) {
                assert.equal(processIdentity(row.pid).parentPid, nodeFree.pid);
                const command = await readFile(`/proc/${row.pid}/cmdline`, 'utf8'); assert.doesNotMatch(command, /(?:^|\0)(?:[^\0]*\/)?node(?:\0|$)/);
            }
            await waitFor(async () => {
                const batches = (await redis.lRange('observability:v1:inbox', 0, -1)).map(JSON.parse);
                for (const batch of batches) validateBatch(batch);
                const standaloneBatches = batches.filter(batch => !previousInstances.has(batch.instance)
                    && batch.metrics.some(row => row.name === 'roulette_completion_rust.rss_bytes'));
                const instance = standaloneBatches.at(-1)?.instance;
                if (!instance) return false;
                const owned = batches.filter(batch => batch.instance === instance); privacy(owned);
                assert(owned.every(batch => batch.service === 'cron' && batch.spans.length === 0 && batch.logs.length === 0));
                const metrics = owned.flatMap(batch => batch.metrics);
                return standaloneMetricsReady(metrics, substituted);
            }, 'standalone Rust exports runtime and batch telemetry directly to Dragonfly', 30000);
            nodeFree.kill('SIGTERM'); const result = await finished(nodeFree); observation.check(); assert.equal(result.code, 0); privacy(result.output);
            assert.equal(captured.filter(row => row.event === 'spawn').length, 2);
            console.log('PASS standalone Rust exports finite positive supervisor RSS and finite nonnegative supervisor CPU with its worker telemetry');

            // A private endpoint catches attempted exports without racing the
            // other fixture instances that continue writing to shared Redis.
            let disabledConnections = 0;
            const disabledEndpoint = createServer(socket => { disabledConnections++; socket.destroy(); });
            try {
                await new Promise((resolve, reject) => {
                    disabledEndpoint.once('error', reject);
                    disabledEndpoint.listen(0, '127.0.0.1', resolve);
                });
                const disabled = standalone('/usr/local/bin/cron_index', args, { ...env, OBSERVABILITY_DISABLED: 'true',
                    DRAGONFLY_HOST: '127.0.0.1', DRAGONFLY_PORT: String(disabledEndpoint.address().port) },
                { uid: 65534, gid: 65534, detached: true });
                const disabledObservation = observe(disabled, substituted);
                await waitFor(() => { disabledObservation.check(); return disabledObservation.rows.filter(row => row.event === 'batch').length === 2; },
                    'telemetry-disabled index still supervises workers');
                // Cover the ten-second sampling/export interval while running,
                // then check the final shutdown flush is also disabled.
                await delay(11000);
                assert.equal(disabled.exitCode, null); assert.equal(disabled.signalCode, null);
                disabled.kill('SIGTERM'); const disabledResult = await finished(disabled);
                disabledObservation.check(); assert.equal(disabledResult.code, 0); assert.equal(disabledResult.signal, null); privacy(disabledResult.output);
                assert.equal(disabledConnections, 0, 'disabled telemetry never connects, including final flush');
                console.log('PASS telemetry-disabled Rust index keeps worker supervision active and makes no periodic or final export connection');
            } finally {
                await new Promise(resolve => disabledEndpoint.close(resolve));
            }

            // Deliberately attach NO reader to index stdout. The shell's
            // independently readable counter proves at least 20,000 accepted
            // worker frames traversed its pipe, far beyond diagnostic pipe capacity.
            const floodFiles = ['flood-supervisor-output', 'flood-progress', 'flood-stopped'];
            for (const name of floodFiles) {
                await writeFile(`/tmp/saas-fixtures/${name}`, '');
                await chmod(`/tmp/saas-fixtures/${name}`, 0o666);
            }
            const blocked = standalone('/usr/local/bin/cron_index', ['--workers', 'roulette-completion', '--events-json'], env,
                { uid: 65534, gid: 65534, detached: true, captureStdout: false });
            const nativePid = await waitFor(async () => {
                for (const name of await readdir('/proc')) if (/^\d+$/.test(name)) {
                    try { if (processIdentity(Number(name)).parentPid === blocked.pid) return Number(name); }
                    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
                }
            }, 'blocked-output native fixture starts');
            let floodFailure;
            try { await waitFor(async () => Number(await readFile('/tmp/saas-fixtures/flood-progress', 'utf8')) >= 20000,
                'worker pipe continues draining while index diagnostics are unread', 8000); }
            catch (error) { floodFailure = error; }
            assert.notEqual(blocked.stdout.readableFlowing, true, 'index stdout remains unread before shutdown');
            const stoppedAt = Date.now(); blocked.kill('SIGTERM');
            const blockedResult = await finished(blocked, 28000);
            assert.equal(blockedResult.code, 0, 'unread diagnostic stdout cannot prevent graceful Rust shutdown');
            assert.equal(blockedResult.signal, null); assert(Date.now() - stoppedAt < 28000);
            assert.equal(Number(await readFile('/tmp/saas-fixtures/flood-stopped', 'utf8')), nativePid, 'native child receives TERM and drains cooperatively');
            assert(await stopped(nativePid), 'native child is reaped despite unread index stdout');
            if (floodFailure) throw floodFailure;
            for (const name of floodFiles) await unlink(`/tmp/saas-fixtures/${name}`);
            console.log('PASS exact Rust index drains 20,000 worker frames and shuts down cooperatively while its diagnostic stdout is unread');
        } finally {
            // Fence every possible restart before restoring the original binaries.
            for (const child of scopedChildren) if (children.has(child)) { try { child.kill('SIGTERM'); } catch {} }
            for (const child of scopedChildren) if (children.has(child)) {
                try { await finished(child); }
                catch {
                    if (groups.has(child.pid)) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
                    else { try { child.kill('SIGKILL'); } catch {} }
                    await bounded(child.completion.catch(() => {}), 2000, 'substitution process fence').catch(() => {});
                }
            }
        }
    });
    assert.deepEqual(await Promise.all(substituted.map(name => hash(NATIVE[name]))), hashes, 'candidate binaries restored byte-for-byte');
    privacy(await records());
    console.log('PASS Node/Rust once aggregate mixed exits; standalone Rust rejects private/invalid output, exports without Node children and restores candidate binaries');
} finally {
    // Stop owned processes before restoring/dropping fixture data.
    for (const child of children) { try { child.kill('SIGTERM'); } catch {} }
    for (const child of children) {
        try { await bounded(child.completion, 29000, 'fixture cleanup'); }
        catch { try { child.kill('SIGKILL'); } catch {} await bounded(child.completion.catch(() => {}), 2000, 'forced fixture cleanup').catch(() => {}); }
    }
    for (const group of groups) { try { process.kill(-group, 'SIGKILL'); } catch {} }
    for (const name of ['fail-roulette-once', 'flood-supervisor-output', 'flood-progress', 'flood-stopped']) {
        await unlink(`/tmp/saas-fixtures/${name}`).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    try { for (const name of ownedDatabases) { assert.match(name, /^cron_supervisors_fixture_[a-zA-Z0-9_]+$/); await mongo.db(name).dropDatabase(); } }
    finally { await mongo.close(); if (redis.isOpen) await redis.quit(); }
}
