// Records what the reference EventSub webhook (`bot/eventsub.twitch.ts`) answers and stores for a
// table of deliveries, for `tests/ingress_recorded.rs`.
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC DOMAIN_EVENTS_WAKEUPS_ENABLED=false OBSERVABILITY_DISABLED=true \
//     DRAGONFLY_HOST=127.0.0.1 DRAGONFLY_PORT=6379/11 \
//     TWITCH_EVENTSUB_SECRET=dima-test-eventsub-secret-01 \
//     node_modules/.bin/tsx /path/to/dima-rust/crates/chat/tests/reference/record_ingress.mts \
//     /path/to/dima-rust/crates/chat/tests/fixtures/ingress_recorded.json
//
// DIMABOT_DIR is a `dimabot/` checkout with `node_modules` whose `src/` is the frozen reference
// (commit 0c71108e). What is loaded: `createTwitchEventsubApp` itself (the route, `express.raw`,
// the telemetry middleware), with the real journal (`journalDomainEvent`), the real owner
// resolver and the real revocation handler and raid filter, against a throwaway MongoDB database
// (`dima_test_chat_rec_<random>`, dropped at the end, also after a failure) and Dragonfly logical
// database 11. `bot/index.ts` is never imported, so no bot, timer, subscriber or Twitch client
// starts; the inline handler (`handlers/eventsub.handler.ts`) is replaced by a recorder, so
// nothing is sent anywhere. `globalThis.fetch` refuses every call (none is expected). The app
// listens on an ephemeral loopback port; each request is written byte for byte on its own socket
// (`Connection: close`) and recorded as sent, with the answer as received.
//
// Twitch's secret here is a test value. Message ids carry a random run tag, so Dragonfly keys from
// an earlier run cannot collide; every key the run creates is deleted at the end.
//
// The two reference crashes (packages.md): an unhandled rejection exits Node; this script
// catches it with `process.on('unhandledRejection')` instead, records the error, and the
// request, which Express never answers, is recorded as `noAnswer` after a short wait.
import { randomInt, randomBytes, createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const NOW_MS = Date.UTC(2026, 10, 12, 9, 30, 0, 123);
const RealDate = Date;
class FrozenDate extends RealDate {
    constructor(...args: any[]) {
        if (args.length === 0) super(NOW_MS);
        else super(...(args as [any]));
    }
    static now() {
        return NOW_MS;
    }
}
Object.defineProperty(FrozenDate, 'name', { value: 'Date' });
(globalThis as any).Date = FrozenDate;

const out = process.argv[2];
if (!out) throw new Error('usage: record_ingress.mts <out.json>');
for (const [name, value] of [['TZ', 'UTC'], ['DOMAIN_EVENTS_WAKEUPS_ENABLED', 'false'], ['OBSERVABILITY_DISABLED', 'true'],
    ['DRAGONFLY_HOST', '127.0.0.1'], ['DRAGONFLY_PORT', '6379/11'], ['TWITCH_EVENTSUB_SECRET', 'dima-test-eventsub-secret-01']]) {
    if (process.env[name] !== value) throw new Error(`run with ${name}=${value}`);
}
const SECRET = process.env.TWITCH_EVENTSUB_SECRET!;
const uri = process.env.DIMA_TEST_MONGO_URI;
if (!uri) throw new Error('DIMA_TEST_MONGO_URI is not set: eval "$(dima-rust/tools/test-env)"');

const outbound: string[] = [];
(globalThis as any).fetch = async (input: unknown) => {
    outbound.push(String((input as any)?.url ?? input));
    throw new Error('outbound calls are refused while recording');
};
const rejections: { name: string; message: string; code?: string }[] = [];
process.on('unhandledRejection', (error: any) => {
    rejections.push({ name: error?.name ?? 'Error', message: error?.message ?? String(error), code: error?.code });
});

const root = process.cwd();
const imported = async (file: string) => import(pathToFileURL(path.join(root, file)).href);
const mongoose = (await import(pathToFileURL(path.join(root, 'node_modules/mongoose/index.js')).href)).default;
const { EJSON, ObjectId } = mongoose.mongo.BSON;
const canonical = (doc: unknown) => JSON.parse(EJSON.stringify(doc, { relaxed: false }));
const RAW = { promoteValues: false, promoteLongs: false, promoteBuffers: false };

const RUN = randomBytes(4).toString('hex');
const database = `dima_test_chat_rec_${randomInt(1e9)}`;
await mongoose.connect(uri, { dbName: database });
const { getDragonflyClient } = await imported('src/utils/databases/dragonfly.database.ts');
const cache = await getDragonflyClient('IngressRecorder');
const keysBefore = new Set<string>(await cache.keys('*'));

const result: Record<string, unknown> = { nowMs: NOW_MS, secret: SECRET, database: 'dima_test_chat_rec_<random>' };
let server: import('node:http').Server | undefined;
try {
    const { createTwitchEventsubApp } = await imported('src/bot/eventsub.twitch.ts');
    const { DomainEventSchema } = await imported('src/schemas/domain_event.schema.ts');
    const EventsubSchema = (await imported('src/schemas/eventsub.schema.ts')).default;
    const UsersSchema = (await imported('src/schemas/users.schema.ts')).default;
    const { RaidSubscriptionPreferenceSchema } = await imported('src/schemas/raid_subscription_preference.schema.ts');
    await Promise.all([DomainEventSchema.init(), EventsubSchema.init(), UsersSchema.init(), RaidSubscriptionPreferenceSchema.init()]);

    // Seeds, raw so the Rust test inserts the same documents.
    const seeds = {
        users: [
            { _id: new ObjectId('64c000000000000000000001'), accounts: [{ type: 'twitch', id: '1001', chat_enabled: true }] },
            { _id: new ObjectId('64c000000000000000000002'), accounts: [{ type: 'twitch', id: '1002', chat_enabled: true }] }
        ],
        eventsubs: [
            { _id: new ObjectId('64c000000000000000000101'), id: 'sub-chat-1002', type: 'channel.chat.message', version: '1',
              channelID: '1002', channel: 'seconduser', enabled: true,
              condition: { broadcaster_user_id: '1002', user_id: '698614112' } },
            { _id: new ObjectId('64c000000000000000000102'), id: 'sub-raid-in-1001', type: 'channel.raid', version: '1',
              channelID: '1001', channel: 'firstuser', enabled: true,
              condition: { to_broadcaster_user_id: '1001' } }
        ],
        raid_subscription_preferences: [
            { _id: '1002:incoming', deleted: true }
        ]
    };
    await UsersSchema.collection.insertMany(seeds.users);
    await EventsubSchema.collection.insertMany(seeds.eventsubs);
    await RaidSubscriptionPreferenceSchema.collection.insertMany(seeds.raid_subscription_preferences as any);
    result.seeds = canonical(seeds);

    const handled: unknown[] = [];
    const app = createTwitchEventsubApp({
        handleEvent: async (subscription: unknown, event: unknown, options: any) => {
            const { chatEffectContext, ...rest } = options ?? {};
            handled.push({ subscription, event, options: { ...rest, chatEffectContext: Boolean(chatEffectContext) } });
        }
    });
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const port = (server!.address() as net.AddressInfo).port;

    // Twitch's timestamps: RFC 3339 with nanoseconds.
    const stamp = (offsetMs: number) => new RealDate(NOW_MS + offsetMs).toISOString().replace('Z', '456789Z');
    const sign = (id: string, timestamp: string, body: Buffer) =>
        'sha256=' + createHmac('sha256', SECRET).update(id).update(timestamp).update(body).digest('hex');

    const subscription = (type: string, version: string, condition: Record<string, string>, id = `sub-${type}`) => ({
        id, status: 'enabled', type, version, condition,
        transport: { method: 'webhook', callback: 'https://subscriptions.domdimabot.com/eventsub' },
        created_at: '2026-11-01T08:00:00.123456789Z', cost: 0
    });
    const B = { broadcaster_user_id: '1001', broadcaster_user_login: 'firstuser', broadcaster_user_name: 'FirstUser' };
    const chatEvent = (text: string, extra: Record<string, unknown> = {}) => ({
        ...B, chatter_user_id: '5001', chatter_user_login: 'viewerone', chatter_user_name: 'ViewerOne',
        message_id: `chat-${RUN}`, message: { text, fragments: [{ type: 'text', text, cheermote: null, emote: null, mention: null }] },
        color: '#1E90FF', badges: [{ set_id: 'subscriber', id: '12', info: '16' }, { set_id: 'premium', id: '1', info: '' }],
        message_type: 'text', cheer: null, reply: null, channel_points_custom_reward_id: null,
        source_broadcaster_user_id: null, source_broadcaster_user_login: null, source_broadcaster_user_name: null,
        source_message_id: null, source_badges: null, ...extra
    });
    const events: Record<string, { sub: any; event: any }> = {
        chat: { sub: subscription('channel.chat.message', '1', { broadcaster_user_id: '1001', user_id: '698614112' }),
            event: chatEvent('hello 👋🏽 مرحبا é') },
        follow: { sub: subscription('channel.follow', '2', { broadcaster_user_id: '1001', moderator_user_id: '698614112' }),
            event: { user_id: '5002', user_login: 'followertwo', user_name: 'FollowerTwo', ...B, followed_at: '2026-11-12T09:29:58.987654321Z' } },
        subscribe: { sub: subscription('channel.subscribe', '1', { broadcaster_user_id: '1001' }),
            event: { user_id: '5003', user_login: 'subthree', user_name: 'SubThree', ...B, tier: '1000', is_gift: false } },
        redemption: { sub: subscription('channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: '1001', reward_id: 'reward-1' }),
            event: { id: `redemption-${RUN}`, ...B, user_id: '5004', user_login: 'redeemer', user_name: 'Redeemer', user_input: 'play ñandú 🎵',
                status: 'unfulfilled', reward: { id: 'reward-1', title: 'Song request', cost: 500, prompt: 'Name a song' },
                redeemed_at: '2026-11-12T09:29:57.111111111Z' } },
        online: { sub: subscription('stream.online', '1', { broadcaster_user_id: '1001' }),
            event: { id: '9876543210', ...B, type: 'live', started_at: '2026-11-12T09:28:00Z' } },
        offline: { sub: subscription('stream.offline', '1', { broadcaster_user_id: '1001' }), event: { ...B } },
        raidIncoming: { sub: subscription('channel.raid', '1', { to_broadcaster_user_id: '1001' }, 'sub-raid-in-1001'),
            event: { from_broadcaster_user_id: '7001', from_broadcaster_user_login: 'raider', from_broadcaster_user_name: 'Raider',
                to_broadcaster_user_id: '1001', to_broadcaster_user_login: 'firstuser', to_broadcaster_user_name: 'FirstUser', viewers: 42 } },
        raidDeleted: { sub: subscription('channel.raid', '1', { to_broadcaster_user_id: '1002' }, 'sub-raid-in-1002'),
            event: { from_broadcaster_user_id: '7001', from_broadcaster_user_login: 'raider', from_broadcaster_user_name: 'Raider',
                to_broadcaster_user_id: '1002', to_broadcaster_user_login: 'seconduser', to_broadcaster_user_name: 'SecondUser', viewers: 3 } },
        unknownType: { sub: subscription('channel.unheard_of.thing', '7', { broadcaster_user_id: '1001' }), event: { ...B, value: 1 } },
        followBadDate: { sub: subscription('channel.follow', '2', { broadcaster_user_id: '1001', moderator_user_id: '698614112' }),
            event: { user_id: '5005', user_login: 'baddate', user_name: 'BadDate', ...B, followed_at: 'not a date' } },
        followNoChannel: { sub: subscription('channel.follow', '2', { broadcaster_user_id: '1001', moderator_user_id: '698614112' }),
            event: { user_id: '5006', user_login: 'nochannel', user_name: 'NoChannel', followed_at: '2026-11-12T09:29:58Z' } },
        chatLarge: { sub: subscription('channel.chat.message', '1', { broadcaster_user_id: '1001', user_id: '698614112' }),
            event: chatEvent('large', { message_id: `chat-large-${RUN}` }) }
    };

    type Request = { method?: string; path?: string; headers: [string, string][]; body: Buffer };
    const send = (request: Request): Promise<{ raw: Buffer | null }> => new Promise(resolve => {
        const head = [`${request.method ?? 'POST'} ${request.path ?? '/eventsub'} HTTP/1.1`, `Host: 127.0.0.1:${port}`,
            ...request.headers.map(([n, v]) => `${n}: ${v}`), `Content-Length: ${request.body.length}`, 'Connection: close', '', ''].join('\r\n');
        const socket = net.connect(port, '127.0.0.1');
        const chunks: Buffer[] = [];
        let done = false;
        const finish = (raw: Buffer | null) => { if (!done) { done = true; socket.destroy(); resolve({ raw }); } };
        socket.on('data', chunk => chunks.push(chunk));
        socket.on('end', () => finish(Buffer.concat(chunks)));
        socket.on('error', () => finish(chunks.length ? Buffer.concat(chunks) : null));
        setTimeout(() => finish(chunks.length ? Buffer.concat(chunks) : null), 1500);
        // Header values are written as latin1, so a character U+0080..U+00FF is one byte on the wire.
        socket.write(Buffer.concat([Buffer.from(head, 'latin1'), request.body]));
    });
    const parse = (raw: Buffer | null) => {
        if (!raw || raw.length === 0) return null;
        const split = raw.indexOf('\r\n\r\n');
        const lines = raw.subarray(0, split).toString('latin1').split('\r\n');
        const status = Number(lines[0].split(' ')[1]);
        const headers: Record<string, string> = {};
        for (const line of lines.slice(1)) {
            const at = line.indexOf(':');
            headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
        }
        return { status, headers, body: raw.subarray(split + 4).toString('utf8') };
    };

    type Spec = {
        name: string; type?: string; id?: string | null; timestamp?: string | null; retry?: string | null; messageType?: string | null;
        body?: Buffer; signature?: string | null; extraHeaders?: [string, string][]; contentType?: string | null;
        method?: string; path?: string; omitSignatureFrom?: boolean;
    };
    const json = (value: unknown) => Buffer.from(JSON.stringify(value));
    const notification = (key: string, extra: Record<string, unknown> = {}) => json({ subscription: events[key].sub, event: events[key].event, ...extra });
    const specs: Spec[] = [];
    const add = (spec: Spec) => specs.push(spec);
    const id = (name: string) => `${RUN}-${name}`;

    // The message types.
    add({ name: 'challenge', id: id('challenge'), messageType: 'webhook_callback_verification',
        body: json({ challenge: 'pogchamp-kappa-360noscope-vohiyo', subscription: { ...events.follow.sub, status: 'webhook_callback_verification_pending' } }) });
    add({ name: 'challenge that is not text', id: id('challenge-number'), messageType: 'webhook_callback_verification',
        body: json({ challenge: 12345, subscription: events.follow.sub }) });
    add({ name: 'revocation of a stored chat subscription', id: id('revocation'), messageType: 'revocation',
        body: json({ subscription: { ...subscription('channel.chat.message', '1', { broadcaster_user_id: '1002', user_id: '698614112' }, 'sub-chat-1002'), status: 'authorization_revoked' } }) });
    add({ name: 'revocation without a subscription', id: id('revocation-empty'), messageType: 'revocation', body: json({ hello: 'world' }) });
    add({ name: 'revocation the handler refuses', id: id('revocation-invalid'), messageType: 'revocation',
        body: json({ subscription: { type: 'channel.follow', condition: {} } }) });
    add({ name: 'unknown message type', id: id('unknown-message-type'), messageType: 'telepathy', body: notification('chat') });

    // Notifications: each kind the plan names.
    add({ name: 'chat message', id: id('chat'), body: notification('chat') });
    add({ name: 'follow', id: id('follow'), body: notification('follow') });
    add({ name: 'subscription', id: id('subscribe'), body: notification('subscribe') });
    add({ name: 'redemption', id: id('redemption'), body: notification('redemption') });
    add({ name: 'stream online', id: id('online'), body: notification('online') });
    add({ name: 'stream offline', id: id('offline'), body: notification('offline') });
    add({ name: 'incoming raid', id: id('raid'), body: notification('raidIncoming') });
    add({ name: 'raid whose direction was deleted', id: id('raid-deleted'), body: notification('raidDeleted') });
    add({ name: 'event type the backend does not know', id: id('unknown-type'), body: notification('unknownType') });

    // Replays.
    add({ name: 'chat message replayed', id: id('chat'), body: notification('chat') });
    add({ name: 'follow replayed', id: id('follow'), body: notification('follow') });
    add({ name: 'old chat message', id: id('chat-old'), timestamp: stamp(-11 * 60_000), body: notification('chat') });
    add({ name: 'old follow retried', id: id('follow-old'), timestamp: stamp(-60 * 60_000), retry: '2', body: notification('follow') });
    add({ name: 'old follow not marked as a retry', id: id('follow-old-noretry'), timestamp: stamp(-60 * 60_000), retry: '0', body: notification('follow') });
    add({ name: 'chat message from the future', id: id('chat-future'), timestamp: stamp(9 * 60_000), body: notification('chat') });

    // Refusals.
    add({ name: 'wrong signature', id: id('wrong-signature'), body: notification('chat'), signature: 'sha256=' + '0'.repeat(64) });
    add({ name: 'signature in upper case', id: id('upper-signature'), body: notification('chat'), signature: 'UPPER' });
    add({ name: 'no signature', id: id('no-signature'), body: notification('chat'), signature: null });
    add({ name: 'non-ASCII signature of the expected length', id: id('non-ascii-signature'), body: notification('chat'),
        signature: 'sha256=é' + '0'.repeat(63) });
    add({ name: 'body that is not JSON (content type)', id: id('text-plain'), body: notification('chat'), contentType: 'text/plain' });
    add({ name: 'no content type', id: id('no-content-type'), body: notification('chat'), contentType: null });
    add({ name: 'valid signature over a body that is not JSON', id: id('not-json'), body: Buffer.from('this is { not json') });
    add({ name: 'valid signature over an empty body', id: id('empty-body'), body: Buffer.alloc(0) });
    add({ name: 'valid signature without a message id', id: null, body: notification('chat') });
    add({ name: 'valid signature without a timestamp', id: id('no-timestamp'), timestamp: null, body: notification('chat') });
    add({ name: 'notification without an event', id: id('no-event'), body: json({ subscription: events.chat.sub }) });
    add({ name: 'follow without a channel', id: id('follow-no-channel'), body: notification('followNoChannel') });
    add({ name: 'follow with a date that is not one', id: id('follow-bad-date'), body: notification('followBadDate') });
    add({ name: 'GET', id: id('get'), method: 'GET', body: Buffer.alloc(0) });
    add({ name: 'another path', id: id('other-path'), path: '/eventsub/extra', body: notification('chat') });
    add({ name: 'repeated signature header', id: id('repeated-signature'), body: notification('chat'), omitSignatureFrom: true });

    // Sizes: body-parser's 100 KB limit is 102,400 bytes.
    const limit = 102_400;
    const sized = (target: number) => {
        const base = notification('chatLarge', { padding: '' });
        return notification('chatLarge', { padding: 'x'.repeat(target - base.length) });
    };
    add({ name: 'body of exactly the limit', id: id('at-limit'), body: sized(limit) });
    add({ name: 'body one byte over the limit', id: id('over-limit'), body: sized(limit + 1) });

    const cases: unknown[] = [];
    for (const spec of specs) {
        const messageId = spec.id === undefined ? id(spec.name) : spec.id;
        const timestamp = spec.timestamp === undefined ? stamp(-2_000) : spec.timestamp;
        const body = spec.body ?? Buffer.alloc(0);
        const headers: [string, string][] = [];
        if (spec.contentType !== null) headers.push(['Content-Type', spec.contentType ?? 'application/json']);
        if (messageId !== null) headers.push(['Twitch-Eventsub-Message-Id', messageId]);
        headers.push(['Twitch-Eventsub-Message-Retry', spec.retry ?? '0']);
        if (spec.messageType !== null) headers.push(['Twitch-Eventsub-Message-Type', spec.messageType ?? 'notification']);
        const signature = spec.signature === undefined ? sign(messageId ?? '', timestamp ?? '', body) : spec.signature;
        if (signature !== null) {
            const value = signature === 'UPPER' ? sign(messageId ?? '', timestamp ?? '', body).toUpperCase().replace('SHA256=', 'sha256=') : signature;
            headers.push(['Twitch-Eventsub-Message-Signature', value]);
            if (spec.omitSignatureFrom) headers.push(['Twitch-Eventsub-Message-Signature', value]);
        }
        if (timestamp !== null) headers.push(['Twitch-Eventsub-Message-Timestamp', timestamp]);
        headers.push(['Twitch-Eventsub-Subscription-Type', JSON.parse(body.length && body[0] === 0x7b ? body.toString() : '{}')?.subscription?.type ?? 'none']);
        headers.push(['Twitch-Eventsub-Subscription-Version', '1']);
        const handledBefore = handled.length;
        const rejectionsBefore = rejections.length;
        const response = parse((await send({ method: spec.method, path: spec.path, headers, body })).raw);
        await new Promise(resolve => setTimeout(resolve, 50));
        cases.push({
            name: spec.name,
            request: {
                method: spec.method ?? 'POST', path: spec.path ?? '/eventsub',
                headers: headers.map(([n, v]) => [n, Buffer.from(v, 'latin1').toString('base64')]),
                body: body.toString('base64')
            },
            response,
            handled: handled.slice(handledBefore),
            crash: rejections.slice(rejectionsBefore)
        });
    }
    result.cases = cases;

    // What the run stored.
    result.domainEvents = (await DomainEventSchema.collection.find({}, { ...RAW, sort: { journaledAt: 1, _id: 1 } }).toArray()).map(canonical);
    result.eventsubs = (await EventsubSchema.collection.find({}, { ...RAW, sort: { _id: 1 } }).toArray()).map(canonical);
    result.users = (await UsersSchema.collection.find({}, { ...RAW, sort: { _id: 1 } }).toArray()).map(canonical);
    const created = (await cache.keys('*')).filter((key: string) => !keysBefore.has(key)).sort();
    const dedupe: Record<string, unknown> = {};
    for (const key of created.filter((key: string) => key.startsWith('twitch:eventsub:message:'))) {
        dedupe[key] = { value: await cache.get(key), ttl: await cache.ttl(key) };
    }
    result.dedupeKeys = dedupe;
    result.otherKeys = created.filter((key: string) => !key.startsWith('twitch:eventsub:message:')).map((key: string) => key.replace(/:[^:]*$/, ':<id>'));
    result.outbound = outbound;
    result.runTag = RUN;
    writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
    console.log(`recorded ${cases.length} cases to ${out}`);
} finally {
    server?.close();
    const created = (await cache.keys('*')).filter((key: string) => !keysBefore.has(key) && (key.startsWith('twitch:eventsub:message:') || key.startsWith('logger:')));
    if (created.length) await cache.del(created);
    await mongoose.connection.dropDatabase().catch(() => undefined);
    await mongoose.disconnect();
    await cache.quit?.().catch?.(() => undefined);
    setTimeout(() => process.exit(0), 200).unref();
}
