import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CommandGroupRow, LogKey } from './admin_channel_debug.service.js';

process.env.SECRET_KEY ??= 'channel-debug-test-secret';
const {
    channelLogs, isDroppedLogField, mergeEventsubActivity, parseLogKey, scrubSecrets, shapeCommandStats, shapeLogEntry, sortLogKeys, twitchTypeOf
} = await import('./admin_channel_debug.service.js');

describe('log keys', () => {
    it('parses the logger key format', () => {
        assert.deepEqual(parseLogKey('logger:twitch:123:error:1762000000000-ab12'), {
            key: 'logger:twitch:123:error:1762000000000-ab12', platform: 'twitch', channelId: '123', level: 'error', ms: 1762000000000, logId: '1762000000000-ab12'
        });
        assert.equal(parseLogKey('logger:twitch:123:error:1762000000000-')?.ms, 1762000000000);
    });

    it('refuses anything else', () => {
        for (const key of [
            'logger:twitch:123:error', 'logger:twitch:123:error:abc-ab12', 'logger:twitch:123:error:1-ab:12',
            'other:twitch:123:error:1762000000000-ab12', 'logger::123:error:1762000000000-ab12', 'logger:twitch:123:error:1762000000000_ab12'
        ]) assert.equal(parseLogKey(key), null, key);
    });

    it('sorts newest first by the key time, not by the key text', () => {
        const keys = ['logger:twitch:1:info:999-a', 'logger:twitch:1:info:1000-a', 'logger:twitch:1:warn:1000-b', 'logger:twitch:1:info:20-z']
            .map(key => parseLogKey(key)!) as LogKey[];
        assert.deepEqual(sortLogKeys(keys).map(key => key.key), [
            'logger:twitch:1:warn:1000-b', 'logger:twitch:1:info:1000-a', 'logger:twitch:1:info:999-a', 'logger:twitch:1:info:20-z'
        ]);
    });
});

describe('secret scrubber', () => {
    it('removes credential and contact fields at any depth, arrays included', () => {
        const scrubbed = scrubSecrets({
            accessToken: 'tok-1', refresh_token: 'tok-2', Authorization: 'Bearer abc', clientSecret: 's', password: 'p', apiKey: 'k',
            email: 'a@b.co', userEmail: 'c@d.co', cookie: 'c', 'x-signature': 'sig', phone: '1', session: 's', streamKey: 'live_1',
            safe: 'kept', nested: { deep: { TOKEN: 'x', twitchAccessToken: 'y', ok: 1 }, list: [{ secret: 'y', fine: true }] }
        });
        assert.deepEqual(scrubbed, { safe: 'kept', nested: { deep: { ok: 1 }, list: [{ fine: true }] } });
    });

    it('keeps ids that merely end in "key" and token counts', () => {
        for (const key of ['eventKey', 'cacheKey', 'rewardKey', 'key', 'promptTokens', 'total_tokens', 'tokenCount', 'inputTokens']) {
            assert.equal(isDroppedLogField(key), false, key);
        }
        assert.deepEqual(scrubSecrets({ eventKey: 'twitch-eventsub:abc:channel.follow.received', promptTokens: 12 }),
            { eventKey: 'twitch-eventsub:abc:channel.follow.received', promptTokens: 12 });
        for (const key of ['accessToken', 'twitchAccessToken', 'tokenValue', 'apiKey', 'api_key', 'streamKey', 'userEmail', 'x-signature', 'phoneNumber', 'session_id']) {
            assert.equal(isDroppedLogField(key), true, key);
        }
    });

    it('masks credentials written inside text, at any depth', () => {
        assert.equal(scrubSecrets('connect mongodb://dima:hunter2@mongo:27017/db failed'), 'connect mongodb://[redacted]@mongo:27017/db failed');
        assert.equal(scrubSecrets('request failed: api_key=abcdefgh123456 was refused'), 'request failed: api_key=[redacted] was refused');
        assert.equal(scrubSecrets('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U expired'), 'token [redacted token] expired');
        assert.equal(scrubSecrets('mail viewer@example.com now'), 'mail [email] now');
        assert.equal(scrubSecrets('sent Bearer abcdefghijklmnopqrstuvwxyz123 to helix'), 'sent Bearer [redacted] to helix');
        assert.deepEqual(scrubSecrets({ a: { b: ['postgres://u:p4ss@db/x'] } }), { a: { b: ['postgres://[redacted]@db/x'] } });
        assert.equal(scrubSecrets('reward @viewer not found, use $(channel)'), 'reward @viewer not found, use $(channel)');
    });
});

describe('log entries', () => {
    const key = parseLogKey('logger:twitch:123:error:1762000000000-ab12')!;
    const stored = (data: unknown) => JSON.stringify({ data, timestamp: '11/1/2025, 12:26:40 PM', level: 'error', platform: 'twitch', channelId: '123' });

    it('takes function and message from the data and flattens the rest', () => {
        const entry = shapeLogEntry(key, stored({
            function: 'redemptionHandler', error: 'Reward not found in database', rewardID: 'r1', attempt: 2, live: false,
            nested: { step: 'lookup', token: 'SECRET-T', accessToken: 'SECRET-A' }, list: [1, 2], gone: undefined, nothing: null, long: 'x'.repeat(400),
            eventKey: 'twitch-eventsub:abc:channel.follow.received'
        }))!;
        assert.equal(entry.id, 'twitch:error:1762000000000-ab12');
        assert.equal(entry.at, new Date(1762000000000).toISOString());
        assert.equal(entry.level, 'error');
        assert.equal(entry.function, 'redemptionHandler');
        assert.equal(entry.message, 'Reward not found in database');
        assert.deepEqual({ ...entry.data, long: undefined }, {
            rewardID: 'r1', attempt: 2, live: false, 'nested.step': 'lookup', list: '[1,2]', nothing: null, long: undefined,
            eventKey: 'twitch-eventsub:abc:channel.follow.received'
        });
        assert.equal(JSON.stringify(entry).includes('SECRET-A'), false);
        assert.equal((entry.data.long as string).length, 300);
        assert.equal(JSON.stringify(entry).includes('SECRET-T'), false);
    });

    it('masks a connection string in the message', () => {
        const entry = shapeLogEntry(key, stored({ error: 'connect mongodb://dima:SECRET-PASS@mongo:27017/db failed' }))!;
        assert.equal(entry.message, 'connect mongodb://[redacted]@mongo:27017/db failed');
        const plain = shapeLogEntry(key, stored('request failed: api_key=SECRETabcdefgh12'))!;
        assert.equal(plain.message, 'request failed: api_key=[redacted]');
    });

    it('keeps the error as a field when there is also a message', () => {
        const entry = shapeLogEntry(key, stored({ message: 'Send failed', error: { message: 'HTTP 500', code: 'E' } }))!;
        assert.equal(entry.message, 'Send failed');
        assert.equal(entry.data.error, 'HTTP 500');
    });

    it('accepts a plain string and refuses broken values', () => {
        assert.equal(shapeLogEntry(key, stored('just text'))!.message, 'just text');
        assert.equal(shapeLogEntry(key, stored({ step: 1 }))!.message, null);
        assert.equal(shapeLogEntry(key, '{broken'), null);
        assert.equal(shapeLogEntry(key, null), null);
        assert.equal(shapeLogEntry(parseLogKey('logger:twitch:123:trace:1-a')!, stored('t')), null);
    });
});

describe('channel log scan', () => {
    const value = (level: string, message: string) => JSON.stringify({ data: { function: 'f', message, token: 'SECRET-T' }, level });
    function fakeStore(keys: string[], perCall = 3, delayMs = 0) {
        const values = new Map(keys.map(key => [key, value(key.split(':')[3], key)]));
        let calls = 0;
        const store = {
            mgets: [] as string[][],
            async scan(cursor: string, match: string) {
                calls++;
                assert.equal(match, 'logger:*:123:*');
                if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
                const start = Number(cursor);
                const next = start + perCall;
                return { cursor: next >= keys.length ? '0' : String(next), keys: keys.slice(start, next) };
            },
            async mGet(batch: string[]) { store.mgets.push(batch); return batch.map(key => values.get(key) ?? null); },
            get calls() { return calls; }
        };
        return store;
    }
    const keys = [
        'logger:twitch:123:debug:100-a', 'logger:twitch:123:warn:300-a', 'logger:twitch:123:error:500-a', 'logger:twitch:123:info:200-a',
        'logger:twitch:123:fatal:50-a', 'logger:twitch:9123:error:900-a', 'logger:twitch:123:error:400-b', 'logger:twitch:123:trace:1-a'
    ];
    const options = { scanMs: 1000, maxKeys: 1000, scanCount: 10 };

    it('returns the newest problems, counts every level, and reads only what it returns', async () => {
        const store = fakeStore(keys);
        const page = await channelLogs('123', 'problems', 2, store, options);
        assert.deepEqual(page.entries.map(entry => entry.message), ['logger:twitch:123:error:500-a', 'logger:twitch:123:error:400-b']);
        assert.deepEqual(page.counts, { debug: 1, info: 1, warn: 1, error: 2, fatal: 1 });
        assert.equal(page.truncated, true);
        assert.deepEqual(store.mgets, [['logger:twitch:123:error:500-a', 'logger:twitch:123:error:400-b']]);
        assert.equal(JSON.stringify(page).includes('SECRET-T'), false);
    });

    it('filters one level and is not truncated when everything fits', async () => {
        const page = await channelLogs('123', 'info', 50, fakeStore(keys), options);
        assert.deepEqual(page.entries.map(entry => entry.level), ['info']);
        assert.equal(page.truncated, false);
    });

    it('stops at the time budget and says so', async () => {
        const store = fakeStore(keys, 1, 30);
        const page = await channelLogs('123', 'problems', 50, store, { ...options, scanMs: 40 });
        assert.equal(page.truncated, true);
        assert.ok(store.calls < keys.length);
    });

    it('stops at the key cap and says so', async () => {
        const page = await channelLogs('123', 'problems', 50, fakeStore(keys, 2), { ...options, maxKeys: 2 });
        assert.equal(page.truncated, true);
    });

    it('skips a line that expired between the scan and the read', async () => {
        const store = fakeStore(keys);
        store.mGet = async (batch: string[]) => batch.map(() => null);
        const page = await channelLogs('123', 'problems', 50, store, options);
        assert.deepEqual(page.entries, []);
        assert.equal(page.counts.error, 2);
    });
});

describe('command stats', () => {
    const row = (name: string, outcome: CommandGroupRow['_id']['outcome'], reason: string, n: number, at: string): CommandGroupRow =>
        ({ _id: { name, outcome, reason }, n, lastAt: new Date(at) });

    it('adds outcomes per command, takes the last run, and ranks the reasons', () => {
        const stats = shapeCommandStats([
            row('!so', 'ok', '', 5, '2026-11-13T10:00:00Z'),
            row('!so', 'skipped', 'cooldown', 3, '2026-11-13T11:00:00Z'),
            row('!so', 'blocked', 'permission_denied', 4, '2026-11-12T11:00:00Z'),
            row('!so', 'failed', 'timeout', 1, '2026-11-11T11:00:00Z'),
            row('!so', 'skipped', 'disabled', 1, '2026-11-10T11:00:00Z'),
            row('!hi', 'ok', '', 20, '2026-11-13T12:00:00Z'),
            row('!rare', 'failed', '', 1, '2026-11-13T12:30:00Z')
        ]);
        assert.deepEqual(stats.map(stat => stat.name), ['!hi', '!so', '!rare']);
        assert.deepEqual(stats[1], {
            name: '!so', runs: 14, ok: 5, skipped: 4, blocked: 4, failed: 1, lastAt: '2026-11-13T11:00:00.000Z', lastOutcome: 'skipped', lastReason: 'cooldown',
            reasons: [{ reason: 'permission_denied', count: 4 }, { reason: 'cooldown', count: 3 }, { reason: 'disabled', count: 1 }]
        });
        assert.deepEqual({ ...stats[0], name: undefined }, { name: undefined, runs: 20, ok: 20, skipped: 0, blocked: 0, failed: 0, lastAt: '2026-11-13T12:00:00.000Z', lastOutcome: 'ok', lastReason: null, reasons: [] });
        assert.equal(stats[2].lastReason, null);
    });

    it('keeps at most 200 commands', () => {
        const rows = Array.from({ length: 250 }, (_, index) => row(`!c${index}`, 'ok', '', index + 1, '2026-11-13T10:00:00Z'));
        const stats = shapeCommandStats(rows);
        assert.equal(stats.length, 200);
        assert.equal(stats[0].name, '!c249');
    });
});

describe('eventsub activity', () => {
    it('maps journal types back to the Twitch type', () => {
        assert.equal(twitchTypeOf('channel.follow.received', 'channel.follow'), 'channel.follow');
        assert.equal(twitchTypeOf('channel.subscription.received', 'channel.subscription.message'), 'channel.subscription.message');
        assert.equal(twitchTypeOf('channel.follow.received', undefined), 'channel.follow');
        assert.equal(twitchTypeOf('channel.bits.received', ''), 'channel.bits.use');
        assert.equal(twitchTypeOf('channel.raid.sent', null), 'channel.raid');
        assert.equal(twitchTypeOf('stream.started', undefined), 'stream.online');
        assert.equal(twitchTypeOf('something.new', undefined), 'something.new');
    });

    it('merges journal, activity log, alerts and dead deliveries per type', () => {
        const types = mergeEventsubActivity(
            [
                { type: 'channel.follow', lastAt: new Date('2026-11-13T10:00:00Z'), received7d: 3 },
                { type: 'channel.follow', lastAt: new Date('2026-11-01T10:00:00Z'), received7d: 0 },
                { type: 'channel.ban', lastAt: new Date('2026-11-12T10:00:00Z'), received7d: 1 }
            ],
            [
                { type: 'channel.follow', at: new Date('2026-11-13T10:00:01Z'), outcome: 'skipped', reason: 'alert_disabled' },
                { type: 'channel.follow', at: new Date('2026-11-12T10:00:01Z'), outcome: 'ok', reason: '' },
                { type: 'channel.cheer', at: new Date('2026-11-10T10:00:01Z'), outcome: 'ok', reason: '' }
            ],
            new Map([['channel.follow', 2], ['stream.online', 1]])
        );
        assert.deepEqual(types, [
            {
                type: 'channel.follow', lastReceivedAt: '2026-11-13T10:00:00.000Z', received7d: 3,
                lastAlert: { at: '2026-11-13T10:00:01.000Z', outcome: 'skipped', reason: 'alert_disabled' }, failedDeliveries: 2
            },
            { type: 'channel.ban', lastReceivedAt: '2026-11-12T10:00:00.000Z', received7d: 1, lastAlert: null, failedDeliveries: 0 },
            { type: 'channel.cheer', lastReceivedAt: null, received7d: 0, lastAlert: { at: '2026-11-10T10:00:01.000Z', outcome: 'ok', reason: null }, failedDeliveries: 0 },
            { type: 'stream.online', lastReceivedAt: null, received7d: 0, lastAlert: null, failedDeliveries: 1 }
        ]);
    });
});
