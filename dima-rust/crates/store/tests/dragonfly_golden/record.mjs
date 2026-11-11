// Golden recordings of what node-redis 5 and the reference's Lua really store in Dragonfly, for
// `dima_store::dragonfly`, and the TypeScript-side peer of the interleaved test.
//
//   eval "$(dima-rust/tools/test-env)"
//   node dima-rust/crates/store/tests/dragonfly_golden/record.mjs          # writes golden.json
//   node dima-rust/crates/store/tests/dragonfly_golden/record.mjs peer     # JSON lines on stdin/stdout
//
// node-redis comes from DIMABOT_DIR (default: this repository's `dimabot/`, else the `dimabot/` of
// the main checkout, found through `git rev-parse --git-common-dir`; a git worktree has no
// node_modules). The script refuses any node-redis other than the production 5.12.1.
//
// Lua scripts are read from the frozen TypeScript source of this checkout (`dimabot/src`), never
// copied, so the recording exercises the real text. Producers are reproduced line for line from
// the reference where importing them would pull in the whole application (enqueueCronJob's job
// construction, PubSubManager.publish's envelope, planCacheVersion); each is marked with its source.
//
// Everything runs in logical database 15 (`redis://HOST:PORT/15`) under a unique key prefix, and
// every key it creates is deleted at the end. Pub/sub channels are global: they carry the prefix.
// Values are recorded as base64 of the exact bytes (node-redis with BLOB_STRING mapped to Buffer),
// plus the text for readable diffs. Clock and UUIDs are fixed (FIXED below), so the file is stable.
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoDimabot = resolve(here, '../../../../../dimabot');

function findDimabotWithModules() {
    if (process.env.DIMABOT_DIR) return process.env.DIMABOT_DIR;
    if (existsSync(join(repoDimabot, 'node_modules/redis'))) return repoDimabot;
    try {
        const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: here }).toString().trim();
        const main = resolve(common, '../dimabot');
        if (existsSync(join(main, 'node_modules/redis'))) return main;
    } catch { /* not a git checkout */ }
    throw new Error('node-redis not found: set DIMABOT_DIR to a dimabot checkout with node_modules');
}

const require = createRequire(join(findDimabotWithModules(), 'package.json'));
const { createClient, RESP_TYPES } = require('redis');
const redisVersion = require('@redis/client/package.json').version;
if (redisVersion !== '5.12.1') throw new Error(`expected @redis/client 5.12.1, found ${redisVersion}`);

// ---- The reference's Lua, read from the TypeScript source ----------------------------------
function literal(file, name) {
    const source = readFileSync(join(repoDimabot, 'src', file), 'utf8');
    const match = source.match(new RegExp(`const ${name} = \`([^\`]*)\`;`));
    if (!match || match[1].includes('${')) throw new Error(`${name} not found in ${file}`);
    return match[1];
}
const LUA = {
    WRITE_PLAN_ACCOUNT: literal('utils/plan_cache_fence.ts', 'WRITE_PLAN_ACCOUNT_SCRIPT'),
    CHECK_PLAN_ACCOUNTS: literal('utils/plan_cache_fence.ts', 'CHECK_PLAN_ACCOUNTS_SCRIPT'),
    ACCEPT_PLAN_CREDITS: literal('utils/plan_cache_fence.ts', 'ACCEPT_PLAN_CREDITS_SCRIPT'),
    INVALIDATE_PLAN: literal('domain_events/polar_billing_events.ts', 'INVALIDATE_PLAN_SCRIPT'),
    SYNC_CREDITS: literal('domain_events/polar_billing_events.ts', 'SYNC_CREDITS_SCRIPT'),
    APPLY_AI_CREDIT_USAGE: literal('utils/billing.ts', 'APPLY_AI_CREDIT_USAGE_SCRIPT'),
    ENQUEUE_DEDUPLICATED_JOB: literal('utils/cron_jobs_queue.ts', 'ENQUEUE_DEDUPLICATED_JOB'),
    PUBLISH_DURABLE_CRON_JOB: literal('utils/durable_cron_jobs.ts', 'PUBLISH_DURABLE_CRON_JOB'),
};

// ---- Fixed inputs ----------------------------------------------------------------------------
export const FIXED = {
    nowIso: '2026-11-11T12:00:00.000Z',
    nowMs: Date.UTC(2026, 10, 11, 12, 0, 0, 0),
    uuid: (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
};

// Text the brief requires in payloads (the same list as tests/dragonfly_support/mod.rs).
const AWKWARD_TEXT = [
    'plain',
    'emoji 🎉 👩‍👩‍👧 🇲🇽 ❤️',
    'combining é ñ ǻ',
    'rtl مرحبا بالعالم שלום',
    'quotes "double" \'single\' `back` \\ backslash',
    'lines\nsecond\r\nthird\ttab',
    'slash / and   separator \u0007',
    '',
];

// ---- Producers, reproduced from the reference ------------------------------------------------
// utils/cron_jobs_queue.ts normalizeValue / buildDefaultDedupeToken / enqueueCronJob (job part).
const normalizeValue = (value) => typeof value === 'string' ? value.trim() : '';
function buildCronJob(input, id, requestedAt) {
    const job = {
        id,
        job: normalizeValue(input.job),
        requestedAt,
        requestedBy: normalizeValue(input.requestedBy) || undefined,
        userID: normalizeValue(input.userID) || undefined,
        accountID: normalizeValue(input.accountID) || undefined,
        channelID: normalizeValue(input.channelID) || undefined,
        data: input.data
    };
    const dedupeToken = normalizeValue(input.dedupeToken) || [
        normalizeValue(input.job), normalizeValue(input.channelID), normalizeValue(input.userID), normalizeValue(input.accountID)
    ].filter((value) => value.length > 0).join(':');
    const dedupeSeconds = Math.max(60, Number(input.dedupeSeconds || 900));
    const queueKey = normalizeValue(input.queueKey) || 'cron:jobs:queue';
    const dedupeKey = `cron:jobs:dedupe:${normalizeValue(dedupeToken)}`;
    job.dedupeKey = dedupeKey;
    const acceptanceKey = input.data?.source === 'stream_offline' && normalizeValue(input.data.sessionID)
        ? `cron:jobs:accepted:${job.job}:${job.channelID || ''}:${normalizeValue(input.data.sessionID)}` : undefined;
    return { job, dedupeKey, dedupeSeconds, queueKey, acceptanceKey };
}
// utils/plan_cache_fence.ts planCacheVersion.
const planCacheVersion = (at, key) => at && key ? `${String(at.getTime()).padStart(13, '0')}:${key}` : '';
// classes/pubsub_manager.class.ts publish(): the message body.
const envelope = (data, now) => JSON.stringify({ ...data, timestamp: now });

// ---- Clients ---------------------------------------------------------------------------------
async function connect() {
    const address = process.env.DIMA_TEST_DRAGONFLY;
    if (!address) throw new Error('DIMA_TEST_DRAGONFLY is not set (eval "$(dima-rust/tools/test-env)")');
    const [host, port] = [address.slice(0, address.lastIndexOf(':')), address.slice(address.lastIndexOf(':') + 1)];
    // The reference's address: `redis://${HOST}:${PORT}`, here with the database in the port.
    const client = createClient({ url: `redis://${host}:${port}/15` });
    client.on('error', () => {});
    await client.connect();
    const raw = client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
    return { client, raw };
}
const bytes = (value) => value === null || value === undefined ? null
    : { base64: Buffer.from(value).toString('base64'), text: Buffer.from(value).toString('utf8') };
const fromBase64 = (b64) => Buffer.from(b64, 'base64');

async function removePrefix(client, prefix) {
    for await (const keys of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 1000 })) {
        for (const key of keys) await client.del(key);
    }
}

// ---- Record mode -----------------------------------------------------------------------------
async function record() {
    const { client, raw } = await connect();
    const prefix = `dima-test:golden:${Date.now()}-${randomBytes(4).toString('hex')}:`;
    const channelId = `${prefix.replaceAll(':', '-')}chan`;
    const cases = {};
    try {
        // 1. Cron job enqueue through ENQUEUE_DEDUPLICATED_JOB (follow ledger's input).
        {
            const input = { job: 'follow-ledger-sync', channelID: '123456', accountID: '123456', requestedBy: 'golden',
                dedupeSeconds: 120, dedupeToken: `${prefix}follow-ledger:123456`,
                data: { reason: 'manual_request', type: 'follow-ledger-sync' }, queueKey: `${prefix}cron-queue` };
            const built = buildCronJob(input, FIXED.uuid(1), FIXED.nowIso);
            const result = await client.eval(LUA.ENQUEUE_DEDUPLICATED_JOB, {
                keys: [built.dedupeKey, built.queueKey], arguments: [String(built.dedupeSeconds), JSON.stringify(built.job)] });
            cases.cron_follow_ledger = {
                input, result, dedupeSecondsArg: String(built.dedupeSeconds),
                item: bytes((await raw.lRange(built.queueKey, 0, -1))[0]),
                marker: bytes(await raw.get(built.dedupeKey)), markerTtl: await client.ttl(built.dedupeKey),
            };
            // A replay is refused by the marker.
            cases.cron_follow_ledger.replay = await client.eval(LUA.ENQUEUE_DEDUPLICATED_JOB, {
                keys: [built.dedupeKey, built.queueKey], arguments: [String(built.dedupeSeconds), JSON.stringify(built.job)] });
            await client.del(built.dedupeKey);
        }
        // 2. A job whose data has the awkward text and JavaScript number formatting.
        {
            const data = { texts: AWKWARD_TEXT, one: 1.0, big: 1e21, small: 1e-7, sum: 0.1 + 0.2, negZero: -0, huge: 2 ** 53 + 1,
                nested: { 10: 'index key', b: [true, null, 'é'] }, source: 'stream_offline', sessionID: ' sess ' };
            const input = { job: 'summary', channelID: ' 42 ', data, queueKey: `${prefix}cron-awkward`, dedupeToken: `${prefix}awkward` };
            const built = buildCronJob(input, FIXED.uuid(2), FIXED.nowIso);
            const acceptanceKey = `${prefix}accepted`; // the real key is global; the test keeps it under the prefix
            await client.eval(LUA.ENQUEUE_DEDUPLICATED_JOB, {
                keys: [built.dedupeKey, built.queueKey, acceptanceKey], arguments: [String(built.dedupeSeconds), JSON.stringify(built.job)] });
            cases.cron_awkward = {
                item: bytes((await raw.lRange(built.queueKey, 0, -1))[0]),
                acceptance: bytes(await raw.get(acceptanceKey)), acceptanceKeyByReference: built.acceptanceKey,
            };
            await client.del(built.dedupeKey);
        }
        // 3. LPUSH + head pop: newest first (cron:jobs:queue, stream memory).
        {
            const key = `${prefix}lifo`;
            for (const value of ['a', 'b', 'c']) await client.lPush(key, value);
            cases.lifo_order = (await client.lRange(key, 0, -1));
        }
        // 4. Durable publish of a stream memory job (payload = JSON.stringify of the intent payload).
        {
            const input = { job: 'stream-memory-summary', channelID: '42', accountID: '42', dedupeToken: 'stream-memory-summary:42:s:v',
                dedupeSeconds: 43200, queueKey: 'cron:stream-memory:queue',
                data: { reason: 'stream_offline', source: 'stream_offline', sessionID: 's', streamID: 'v', notBeforeUnix: 0 } };
            const built = buildCronJob(input, FIXED.uuid(3), FIXED.nowIso);
            const queue = `${prefix}stream-memory`;
            const automatic = `${prefix}automatic`;
            const payload = JSON.stringify(built.job);
            const first = await client.eval(LUA.PUBLISH_DURABLE_CRON_JOB, { keys: [queue, automatic], arguments: [payload, '1000'] });
            const second = await client.eval(LUA.PUBLISH_DURABLE_CRON_JOB, { keys: [queue], arguments: [payload, '1000'] });
            cases.cron_durable = { first, second, item: bytes((await raw.lRange(queue, 0, -1))[0]), length: await client.lLen(queue),
                automatic: bytes(await raw.get(automatic)) };
        }
        // 5. Plan fence: WRITE (account with the version field mid-object), CHECK publish, ACCEPT, SYNC, INVALIDATE.
        {
            const version = planCacheVersion(new Date(1_790_000_000_000), 'evt-1');
            const fenceKey = `twitch:${channelId}:ai:credits:plan-version`;
            const accountKey = `accounts:twitch:${channelId}:data`;
            const accountsKey = `${prefix}twitch-accounts`; // the real aggregate key is shared: kept under the prefix
            const account = { id: channelId, login: 'golden_user', __polar_plan_version: 'old', display_name: 'Ñandú 🎉 مرحبا', plan_tier: 'pro', missing: undefined, count: 3 };
            // classes/twitch_streamers.class.ts writeAccount: sanitizeCachePayload keeps string values only.
            const sanitized = Object.fromEntries(Object.entries({ ...account, __polar_plan_version: version }).filter(([, v]) => typeof v === 'string'));
            const written = await client.eval(LUA.WRITE_PLAN_ACCOUNT, { keys: [fenceKey, accountKey, accountsKey], arguments: [version, ...Object.entries(sanitized).flat()] });
            const hash = await client.hGetAll(accountKey);
            const accounts = [hash];
            const checked = await client.eval(LUA.CHECK_PLAN_ACCOUNTS, { keys: [fenceKey, accountsKey], arguments: [hash.__polar_plan_version ?? '', JSON.stringify(accounts)] });
            const credits = { version: 2, available: true, used: 5, balance: 10, updatedAt: FIXED.nowIso, status: 'available', note: 'é/🎉' };
            const creditsKey = `twitch:${channelId}:ai:credits`;
            const exhaust = [`twitch:${channelId}:ai:exhaust`, `${channelId}:ai:exhaust`];
            const accepted = await client.eval(LUA.ACCEPT_PLAN_CREDITS, { keys: [creditsKey, ...exhaust, fenceKey], arguments: [version, JSON.stringify(credits), 'write', '0', '3600'] });
            // utils/billing.ts recordAiCreditUsage: APPLY_AI_CREDIT_USAGE_SCRIPT rewrites the value with cjson.
            const marker = `${prefix}usage-local`;
            const applied = await client.eval(LUA.APPLY_AI_CREDIT_USAGE, { keys: [creditsKey, ...exhaust, marker], arguments: ['3', FIXED.nowIso, '2', String(31 * 24 * 60 * 60), '1'] });
            const afterApply = await raw.get(creditsKey);
            // domain_events/polar_billing_events.ts syncCredits: {...credits, __polar_plan_version} when a plan version exists.
            const snapshotVersion = `${String(1_790_000_000_500).padStart(13, '0')}:snap-1`;
            const syncPayload = JSON.stringify({ ...credits, ...(version ? { __polar_plan_version: version } : {}) });
            const synced = await client.eval(LUA.SYNC_CREDITS, { keys: [creditsKey, ...exhaust, `twitch:${channelId}:ai:credits:polar-version`, fenceKey], arguments: [snapshotVersion, syncPayload, '1', '3600', version] });
            cases.fence = {
                channelSuffix: 'chan', version, account: Object.entries(sanitized), written, hashPairs: Object.entries(hash),
                checked, aggregate: bytes(await raw.get(accountsKey)), accepted, applied, afterApply: bytes(afterApply),
                synced, syncPayload: bytes(syncPayload), afterSync: bytes(await raw.get(creditsKey)),
                exhaust: [bytes(await raw.get(exhaust[0])), bytes(await raw.get(exhaust[1]))],
            };
            const newer = planCacheVersion(new Date(1_800_000_000_000), 'evt-2');
            const invalidated = await client.eval(LUA.INVALIDATE_PLAN, { keys: [fenceKey, creditsKey, accountKey, accountsKey, `${prefix}billing-context`], arguments: [newer] });
            cases.fence.invalidated = invalidated;
            cases.fence.fenceAfterInvalidate = bytes(await raw.get(fenceKey));
            cases.fence.staleWrite = await client.eval(LUA.WRITE_PLAN_ACCOUNT, { keys: [fenceKey, accountKey, accountsKey], arguments: [version, 'id', channelId] });
            await client.del([fenceKey, accountKey, creditsKey, ...exhaust, `twitch:${channelId}:ai:credits:polar-version`]);
        }
        // 6. Pub/sub: what a subscriber receives from PubSubManager.publish and from a raw publish.
        {
            const subscriber = client.duplicate();
            subscriber.on('error', () => {});
            await subscriber.connect();
            const received = [];
            const channel = `${prefix}pubsub`;
            await subscriber.subscribe(channel, (message) => received.push(message), true);
            const clipData = { clipID: 'AwkwardClip', streamerLogin: 'golden', duration: 30.5, clipUrl: 'https://clips.twitch.tv/x?a=1&b=2',
                title: AWKWARD_TEXT[1], game: AWKWARD_TEXT[3], streamer: 'Gölden', profileImage: 'https://x/y.png', description: AWKWARD_TEXT[5],
                streamerColor: '#FF00FF', timestamp: FIXED.nowMs - 5 };
            const messages = [
                ['clip_request', envelope(clipData, FIXED.nowMs)],
                ['tts_session_ended', envelope({ channelID: '42', session: 'sess-é' }, FIXED.nowMs)],
                ['widget_feed', envelope({ channel: '42', type: 'chat', data: { id: 'm1', user: { login: 'u', color: null }, text: AWKWARD_TEXT[2], emotes: [], at: FIXED.nowMs } }, FIXED.nowMs)],
                ['keywords_changed', JSON.stringify({ channelID: '42' })],
            ];
            for (const [, message] of messages) await client.publish(channel, message);
            for (let i = 0; i < 50 && received.length < messages.length; i++) await new Promise((r) => setTimeout(r, 20));
            cases.pubsub = Object.fromEntries(messages.map(([name], index) => [name, bytes(received[index])]));
            cases.pubsub_inputs = { clipData, nowMs: FIXED.nowMs };
            await subscriber.quit();
        }
    } finally {
        await removePrefix(client, prefix);
        await client.quit();
    }
    const out = join(here, 'golden.json');
    // Keys and some values embed the run's prefix; the Rust replay substitutes its own before comparing.
    const ordered = { recordedWith: { node: process.version, nodeRedis: redisVersion }, fixed: { nowIso: FIXED.nowIso, nowMs: FIXED.nowMs }, prefix, channelId, cases };
    writeFileSync(out, JSON.stringify(ordered, null, 1) + '\n');
    console.log(`wrote ${out}`);
}

// ---- Peer mode (the TypeScript side of tests/dragonfly_interleaved.rs) ------------------------
async function peer() {
    const { client, raw } = await connect();
    const subscriptions = new Map();
    let subscriber = null;
    const ops = {
        // enqueueCronJob through ENQUEUE_DEDUPLICATED_JOB, exactly as the reference builds the job.
        async enqueue({ input, uuid }) {
            const built = buildCronJob(input, uuid, FIXED.nowIso);
            const keys = built.acceptanceKey ? [built.dedupeKey, built.queueKey, built.acceptanceKey] : [built.dedupeKey, built.queueKey];
            const result = await client.eval(LUA.ENQUEUE_DEDUPLICATED_JOB, { keys, arguments: [String(built.dedupeSeconds), JSON.stringify(built.job)] });
            return { result, json: JSON.stringify(built.job), dedupeKey: built.dedupeKey };
        },
        // The JSON text the reference would write for this job, without touching Dragonfly.
        async job_json({ input, uuid }) { return JSON.stringify(buildCronJob(input, uuid, FIXED.nowIso).job); },
        async lpush({ key, base64 }) { return client.lPush(key, fromBase64(base64)); },
        async lrange({ key }) { return (await raw.lRange(key, 0, -1)).map((b) => b.toString('base64')); },
        // stream_memory.worker.ts: BLMOVE queue processing LEFT RIGHT 5, then LREM processing 1 raw.
        async claim_and_ack({ queue, processing }) {
            const item = await raw.sendCommand(['BLMOVE', queue, processing, 'LEFT', 'RIGHT', '2']);
            if (item === null) return null;
            const removed = await client.lRem(processing, 1, item);
            return { base64: Buffer.from(item).toString('base64'), removed };
        },
        // Acknowledge by value with the reference's own serialisation of the job.
        async ack_job({ processing, input, uuid }) {
            return client.lRem(processing, 1, JSON.stringify(buildCronJob(input, uuid, FIXED.nowIso).job));
        },
        async fence_invalidate({ id, versions }) {
            return Promise.all(versions.map((version) => client.eval(LUA.INVALIDATE_PLAN, {
                keys: [`twitch:${id}:ai:credits:plan-version`, `twitch:${id}:ai:credits`, `accounts:twitch:${id}:data`, `${id}:accounts-aggregate`, `${id}:billing-context`],
                arguments: [version] })));
        },
        async fence_write({ id, version, fields }) {
            return client.eval(LUA.WRITE_PLAN_ACCOUNT, { keys: [`twitch:${id}:ai:credits:plan-version`, `accounts:twitch:${id}:data`, `${id}:accounts-aggregate`],
                arguments: [version, ...fields.flat()] });
        },
        async apply_usage({ id, credits, marker }) {
            const keys = [`twitch:${id}:ai:credits`, `twitch:${id}:ai:exhaust`, `${id}:ai:exhaust`, marker];
            const result = await client.eval(LUA.APPLY_AI_CREDIT_USAGE, { keys, arguments: [String(credits), FIXED.nowIso, '2', String(31 * 24 * 60 * 60), '1'] });
            return { result, stored: (await raw.get(keys[0])).toString('base64') };
        },
        // PubSubManager.subscribe: JSON.parse each message and keep it with the raw text.
        async subscribe({ channel }) {
            if (!subscriber) { subscriber = client.duplicate(); subscriber.on('error', () => {}); await subscriber.connect(); }
            subscriptions.set(channel, []);
            await subscriber.subscribe(channel, (message) => {
                subscriptions.get(channel)?.push({ raw: message, parsed: JSON.parse(message) });
            });
            return true;
        },
        async received({ channel, count }) {
            for (let i = 0; i < 100 && (subscriptions.get(channel)?.length ?? 0) < count; i++) await new Promise((r) => setTimeout(r, 20));
            return subscriptions.get(channel) ?? [];
        },
        async envelope({ data, now }) { return envelope(data, now); },
        async publish_envelope({ channel, data, now }) { return client.publish(channel, envelope(data, now)); },
        async cleanup({ prefix }) { await removePrefix(client, prefix); return true; },
    };
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
        if (!line.trim()) continue;
        let request;
        try { request = JSON.parse(line); } catch (error) {
            process.stdout.write(JSON.stringify({ ok: false, error: `bad request line: ${error.message}` }) + '\n');
            continue;
        }
        const { op, args } = request;
        if (op === 'quit') break;
        try {
            const result = await ops[op](args ?? {});
            process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
        } catch (error) {
            process.stdout.write(JSON.stringify({ ok: false, error: String(error?.message ?? error) }) + '\n');
        }
    }
    if (subscriber) await subscriber.quit();
    await client.quit();
}

if (process.argv[2] === 'peer') await peer();
else await record();
