// Run from the main checkout with its installed dependencies. Never changes main-checkout files.
// All database writes are scratch-only; domdimabot is queried only in record-real.ts.
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const root = '/home/dom/Projects/saas/dimabot';
const require = createRequire(`${root}/package.json`);
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const output = process.argv[2];
if (!output || !process.env.DIMA_TEST_MONGO_URI) throw new Error('output and test environment required');
process.env.SECRET_KEY = 'stream-test-only-key';
process.env.DRAGONFLY_HOST = '127.0.0.1';
process.env.DRAGONFLY_PORT = '6379/3';
const prefix = `dima_test_stream_${randomUUID()}:`;
const { getDragonflyClient } = await import(`${root}/src/utils/databases/dragonfly.database.ts`);
const cache = await getDragonflyClient('stream-recording');
// Prefix the reference's diagnostic logs, so cleanup touches only this recording's keys.
const command = cache.sendCommand.bind(cache);
cache.set = (key: string, ...args: any[]) => command(['SET', key.startsWith('logger:') ? prefix + key : key, ...args]);
cache.expire = (key: string, ...args: any[]) => command(['EXPIRE', key.startsWith('logger:') ? prefix + key : key, ...args.map(String)]);
const database = `dima_test_stream_${randomUUID().replaceAll('-', '')}`;
const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const incoming = url.pathname.endsWith('/followers');
    const cursor = Number(url.searchParams.get('after') || 0);
    if (incoming && failPage === cursor) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: true, message: 'scripted page failure' })); return; }
    const all = incoming ? followers : following;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: all.slice(cursor, cursor + 100), total: all.length, pagination: cursor + 100 < all.length ? { cursor: String(cursor + 100) } : {} }));
});
let followers: any[] = [], following: any[] = [], failPage = -1;
const originalFetch = globalThis.fetch;
const RealDate = Date;
const now = 1794355200000;
// Dates are deterministic; the reference still uses its real Mongoose operations.
class FixedDate extends RealDate { constructor(...args: any[]) { super(...(args.length ? args : [now]) as [any]); } static now() { return now; } }
try {
    await mongoose.connect(process.env.DIMA_TEST_MONGO_URI, { dbName: database });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as any;
    globalThis.fetch = (input: any, init: any) => {
        const url = new URL(String(input));
        if (url.hostname !== 'api.twitch.tv') throw new Error(`Unexpected outbound request: ${url.hostname}`);
        return originalFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
    };
    const { default: streamers } = await import(`${root}/src/classes/twitch_streamers.class.ts`);
    streamers.getTwitchAccountById = async () => ({ id: 'channel', name: 'streamer', has_permissions: 'true' });
    streamers.getAccountTokenById = async () => 'mock-token';
    const { FollowRelationshipLedgerSchema: Ledger } = await import(`${root}/src/schemas/follow_relationship_ledger.schema.ts`);
    const { recordFollowLedgerStart, syncFollowLedgerForChannel } = await import(`${root}/src/utils/follow_ledger.ts`);
    await Ledger.init();
    globalThis.Date = FixedDate as any;
    const snapshots: any[] = [];
    const ids = new Map<string, string>();
    const follower = (id: string, at = '2026-10-01T00:00:00.000Z') => ({ user_id: id, user_login: `login-${id}`, user_name: `שם👋é-${id}`, followed_at: at });
    async function snapshot(name: string, result: any) {
        const docs = await Ledger.collection.find({}).sort({ follower_id: 1, followed_id: 1, followed_at: 1, status: 1 }).toArray();
        const bsonDocuments = await Ledger.collection.find({}, { promoteValues: false }).sort({ follower_id: 1, followed_id: 1, followed_at: 1, status: 1 }).toArray();
        snapshots.push({ name, result, bsonDocuments: bsonDocuments.map((d: any) => { const id = d._id.toHexString(); if (!ids.has(id)) ids.set(id, `generated-${ids.size + 1}`); const value = EJSON.serialize(d, { relaxed: false }); value._id = { $oid: ids.get(id) }; return value; }), followers: structuredClone(followers), following: structuredClone(following), failPage, documents: docs.map((d: any) => { delete d._id; return d; }) });
    }
    followers = [follower('a'), follower('b')];
    following = [{ broadcaster_id: 'a', broadcaster_login: 'login-a', broadcaster_name: 'שם👋é-a', followed_at: '2026-10-01T00:00:00.000Z' }];
    await snapshot('first-sync', await syncFollowLedgerForChannel('channel'));
    followers.push(follower('c'));
    await snapshot('new-follower', await syncFollowLedgerForChannel('channel'));
    followers = followers.filter(f => f.user_id !== 'b');
    await snapshot('unfollow', await syncFollowLedgerForChannel('channel'));
    followers.push(follower('b', '2026-10-02T00:00:00.000Z'));
    await snapshot('refollow-after-scan', await syncFollowLedgerForChannel('channel'));
    followers[0] = follower('a', '2026-10-03T00:00:00.000Z');
    await snapshot('refollow-between-scans-overwrites', await syncFollowLedgerForChannel('channel'));
    followers = Array.from({ length: 205 }, (_, i) => follower(`bulk-${String(i).padStart(3, '0')}`));
    await snapshot('three-pages', await syncFollowLedgerForChannel('channel'));
    followers.push(follower('tail')); failPage = 100;
    await snapshot('second-page-fails', await syncFollowLedgerForChannel('channel'));
    failPage = -1;
    await snapshot('retry-completes', await syncFollowLedgerForChannel('channel'));
    followers = []; following = [];
    await snapshot('empty-channel', await syncFollowLedgerForChannel('channel'));
    await recordFollowLedgerStart({ follower_id: ' event ', followed_id: 'channel', follower_name: ' 👋שם ', followed_at: '2026-10-04T00:00:00Z' });
    await snapshot('follow-event', null);
    await recordFollowLedgerStart({ follower_id: 'event', followed_id: 'channel', followed_at: '2026-10-05T00:00:00Z' });
    await snapshot('refollow-event', null);
    await writeFile(output, JSON.stringify({ now, snapshots }, null, 2) + '\n');
    console.log(`recorded ${snapshots.length} steps, ${snapshots.reduce((n, s) => n + s.documents.length, 0)} documents`);
} finally {
    globalThis.Date = RealDate;
    globalThis.fetch = originalFetch;
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    server.close();
    const keys = await cache.keys(prefix + '*');
    if (keys.length) await cache.del(keys);
    await cache.quit();
}
