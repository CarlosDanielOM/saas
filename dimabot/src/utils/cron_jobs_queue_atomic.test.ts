import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { spawnSync } from 'node:child_process';

let marker = false;
let pushes = 0;
let unavailable = false;
let wrongType = false;
let loseResponse = false;
const accepted = new Set<string>();
const calls: Array<{ script: string; keys: string[]; arguments: string[] }> = [];
mock.module('./databases/dragonfly.database.js', {
    namedExports: {
        getDragonflyClient: async () => ({
            async eval(script: string, options: { keys: string[]; arguments: string[] }) {
                calls.push({ script, ...options });
                if (unavailable) throw new Error('Cache unavailable');
                if (options.keys[2] && accepted.has(options.keys[2])) return 0;
                if (marker) return 0;
                marker = true;
                if (wrongType) { marker = false; throw new Error('WRONGTYPE'); }
                pushes++;
                if (options.keys[2]) accepted.add(options.keys[2]);
                if (loseResponse) { loseResponse = false; throw new Error('Enqueue response lost'); }
                return 1;
            },
            set() { assert.fail('Separate SET would reopen the enqueue gap'); },
            lPush() { assert.fail('Deduplicated enqueue must use one atomic command'); }
        })
    }
});
const { enqueueCronJob } = await import('./cron_jobs_queue.js');

test('dedupe and queue push use one atomic script, and lost responses do not push twice', async () => {
    marker = false;
    pushes = 0;
    loseResponse = true;
    const input = { job: 'summary', queueKey: 'queue', dedupeToken: 'session:summary', dedupeSeconds: 120 };
    await assert.rejects(enqueueCronJob(input), /Enqueue response lost/);
    const replay = await enqueueCronJob(input);
    assert.equal(replay.enqueued, false);
    assert.equal(pushes, 1);
    assert.deepEqual(calls[0].keys, ['cron:jobs:dedupe:session:summary', 'queue']);
    assert.equal(calls[0].arguments[0], '120');
    assert.equal(JSON.parse(calls[0].arguments[1]).dedupeKey, replay.job.dedupeKey);
    assert.match(calls[0].script, /redis\.call\('SET'.*'NX'.*'EX'/);
    assert.match(calls[0].script, /redis\.pcall\('LPUSH'/);
    assert.match(calls[0].script, /redis\.call\('DEL'/);
    assert.match(calls[0].script, /redis\.error_reply/);
});

test('failed atomic enqueue leaves no false dedupe success, including a wrong-type queue', async () => {
    for (const failure of ['unavailable', 'wrongType']) {
        marker = false;
        pushes = 0;
        unavailable = failure === 'unavailable';
        wrongType = failure === 'wrongType';
        const input = { job: 'summary', dedupeToken: 'session:summary' };
        await assert.rejects(enqueueCronJob(input));
        assert.equal(marker, false);
        unavailable = false;
        wrongType = false;
        assert.equal((await enqueueCronJob(input)).enqueued, true);
        assert.equal(pushes, 1);
    }
});

test('automatic session-job acceptance survives response loss, worker dedupe cleanup and expiry', async () => {
    marker = false;
    pushes = 0;
    loseResponse = true;
    const input = {
        job: 'summary', dedupeToken: 'session:automatic-summary',
        data: { source: 'stream_offline', sessionID: 'session' }
    };
    await assert.rejects(enqueueCronJob(input), /Enqueue response lost/);
    marker = false; // Worker completion or the short-lived dedupe TTL is not permission to resend.
    assert.equal((await enqueueCronJob(input)).enqueued, false);
    assert.equal(pushes, 1);
    const call = calls.at(-1)!;
    assert.equal(call.keys[2], 'cron:jobs:accepted:summary::session');
    assert.match(call.script, /redis\.call\('EXISTS', KEYS\[3\]\)/);
    assert.match(call.script, /redis\.pcall\('SET', KEYS\[3\], '1'\)/);
    assert.match(call.script, /redis\.call\('DEL', KEYS\[3\]\)/);
    assert.equal((await enqueueCronJob({ ...input, dedupeToken: 'corrected-stream-id' })).enqueued, false);
    assert.equal(pushes, 1, 'session acceptance remains stable across stream-ID corrections');
    assert.equal((await enqueueCronJob({ ...input, data: { ...input.data, source: 'manual' } })).enqueued, true);
    assert.equal(pushes, 2, 'manual jobs retain their existing short-lived dedupe behavior');
});

test('the actual Lua script rolls back failed pushes and protects accepted session jobs (mocked Redis)', t => {
    const version = spawnSync('lua', ['-v'], { encoding: 'utf8' });
    if ((version.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        t.skip('Optional standalone Lua interpreter is not installed');
        return;
    }
    const script = calls.at(-1)!.script;
    const result = spawnSync('lua', ['-'], { encoding: 'utf8', input: `
local values, pushes, failPush, failAcceptance = {}, 0, false, false
redis = {}
function redis.call(command, key, value, nx, ex, ttl)
    if command == 'EXISTS' then return values[key] and 1 or 0 end
    if command == 'DEL' then values[key] = nil; return 1 end
    if command == 'SET' then
        if key == 'acceptance' and failAcceptance then error('OOM acceptance') end
        if nx == 'NX' then
            assert(ex == 'EX' and tonumber(ttl) > 0)
            if values[key] then return false end
        end
        values[key] = value
        return 'OK'
    end
    if command == 'LPUSH' then
        if failPush then error('WRONGTYPE') end
        pushes = pushes + 1
        return pushes
    end
    error('Unexpected command: ' .. command)
end
function redis.pcall(...)
    local ok, result = pcall(redis.call, ...)
    if ok then return result end
    return {err = result}
end
function redis.error_reply(message) return {err = message} end
KEYS, ARGV = {'dedupe', 'queue', 'acceptance'}, {'120', 'job'}
local enqueue = assert(load([==[${script}]==]))
failPush = true
assert(enqueue().err:match('WRONGTYPE'))
assert(not values.dedupe and not values.acceptance and pushes == 0)
failPush, failAcceptance = false, true
assert(enqueue().err:match('OOM acceptance'))
assert(not values.dedupe and not values.acceptance and pushes == 0)
failAcceptance = false
assert(enqueue() == 1 and pushes == 1)
values.dedupe = nil
assert(enqueue() == 0 and pushes == 1)
KEYS[3] = nil
assert(enqueue() == 1 and pushes == 2)
assert(enqueue() == 0 and pushes == 2)
` });
    assert.equal(result.status, 0, result.stderr || String(result.error));
});
