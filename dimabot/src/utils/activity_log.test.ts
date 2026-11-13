import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildActivityRow, dropRowsWithoutAccount, flushActivityLog, pendingActivityRowsForTests, recordActivity, safeText, setActivityLogSinkForTests
} from './activity_log.js';
import type { IActivityLog } from '../schemas/activity_log.schema.js';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');

test('a row is bounded: clipped text, flat data, lower-case login, 30-day expiry', () => {
    const row = buildActivityRow({
        kind: 'command', name: '!so', channelID: '123', outcome: 'skipped', reason: 'cooldown',
        actor: { id: '42', login: 'Some_Viewer', name: 'Some Viewer' },
        text: 'x'.repeat(500), ref: 'msg-1', durationMs: 12.6,
        data: { func: 'custom', live: true, nested: { no: 1 }, list: [1], 'a.b': 'dots', $bad: 'dollar', long: 'y'.repeat(500), nan: Number.NaN, nothing: null }
    }, NOW)!;
    assert.equal(row.text.length, 300);
    assert.equal(row.actorLogin, 'some_viewer');
    assert.equal(row.durationMs, 13);
    assert.deepEqual(Object.keys(row.data).sort(), ['_bad', 'a_b', 'func', 'live', 'long', 'nothing']);
    assert.equal(String(row.data.long).length, 200);
    assert.equal(row.expiresAt.getTime() - row.at.getTime(), 30 * 86_400_000);
    assert.equal(row.reason, 'cooldown');
});

test('ok rows carry no reason, unknown outcomes become ok, unusable input is refused', () => {
    assert.equal(buildActivityRow({ kind: 'command', name: '!a', outcome: 'ok', reason: 'leftover' }, NOW)!.reason, '');
    assert.equal(buildActivityRow({ kind: 'command', name: '!a', outcome: 'weird' as never }, NOW)!.outcome, 'ok');
    assert.equal(buildActivityRow({ kind: 'nope' as never, name: '!a' }, NOW), null);
    assert.equal(buildActivityRow({ kind: 'command', name: '   ' }, NOW), null);
});

test('a clock far in the future or the past falls back to the write time', () => {
    assert.equal(buildActivityRow({ kind: 'system', name: 'x', at: new Date(NOW + 3_600_000) }, NOW)!.at.getTime(), NOW);
    assert.equal(buildActivityRow({ kind: 'system', name: 'x', at: new Date(NOW - 40 * 86_400_000) }, NOW)!.at.getTime(), NOW);
    assert.equal(buildActivityRow({ kind: 'system', name: 'x', at: new Date(NOW - 5_000) }, NOW)!.at.getTime(), NOW - 5_000);
    assert.equal(buildActivityRow({ kind: 'system', name: 'x', at: new Date('nope') }, NOW)!.at.getTime(), NOW);
});

test('the same dedupe key gives the same id; without one every row is its own', () => {
    const a = buildActivityRow({ kind: 'twitch_event', name: 'channel.update', channelID: '1', dedupeKey: 'm1' }, NOW)!;
    const b = buildActivityRow({ kind: 'twitch_event', name: 'channel.update', channelID: '1', dedupeKey: 'm1' }, NOW + 5)!;
    const otherChannel = buildActivityRow({ kind: 'twitch_event', name: 'channel.update', channelID: '2', dedupeKey: 'm1' }, NOW)!;
    assert.equal(a._id, b._id);
    assert.notEqual(a._id, otherChannel._id);
    assert.notEqual(buildActivityRow({ kind: 'system', name: 'x' }, NOW)!._id, buildActivityRow({ kind: 'system', name: 'x' }, NOW)!._id);
});

test('an emoji at the clip boundary is not cut in half', () => {
    const row = buildActivityRow({ kind: 'bot_message', name: 'command', text: 'a'.repeat(299) + '😀😀' }, NOW)!;
    assert.equal(row.text, 'a'.repeat(299) + '😀');
});

test('recording queues without touching the store, and a flush writes in batches', async () => {
    const written: IActivityLog[][] = [];
    setActivityLogSinkForTests(async rows => { written.push(rows); });
    try {
        for (let i = 0; i < 450; i++) recordActivity({ kind: 'command', name: `!c${i}`, channelID: '1' });
        assert.equal(written.length, 0, 'nothing is written while recording');
        assert.equal(pendingActivityRowsForTests().length, 450);
        await flushActivityLog();
        assert.deepEqual(written.map(rows => rows.length), [200, 200, 50]);
        assert.equal(pendingActivityRowsForTests().length, 0);
    } finally { setActivityLogSinkForTests(null); }
});

test('a store that fails loses that batch only, never throws, and the queue is capped', async () => {
    let calls = 0;
    setActivityLogSinkForTests(async () => { calls++; throw new Error('store down'); });
    try {
        for (let i = 0; i < 2500; i++) recordActivity({ kind: 'command', name: '!c', channelID: '1' });
        assert.equal(pendingActivityRowsForTests().length, 2000, 'rows past the cap are dropped at the door');
        await flushActivityLog();
        assert.equal(calls, 1, 'no retry loop against a store that is down');
        assert.equal(pendingActivityRowsForTests().length, 1800);
        assert.doesNotThrow(() => recordActivity(null as never));
        assert.doesNotThrow(() => recordActivity({ kind: 'command', name: '!c', data: { get boom(): string { throw new Error('getter'); } } }));
    } finally { setActivityLogSinkForTests(null); }
});

test('recording can be switched off', () => {
    setActivityLogSinkForTests(async () => {});
    process.env.ACTIVITY_LOG_ENABLED = 'false';
    try {
        recordActivity({ kind: 'command', name: '!c' });
        assert.equal(pendingActivityRowsForTests().length, 0);
    } finally { delete process.env.ACTIVITY_LOG_ENABLED; setActivityLogSinkForTests(null); }
});

test('flushing an empty queue does not stop later flushes', async () => {
    const written: IActivityLog[][] = [];
    setActivityLogSinkForTests(async rows => { written.push(rows); });
    try {
        await flushActivityLog();
        await flushActivityLog();
        recordActivity({ kind: 'command', name: '!c', channelID: '1' });
        await flushActivityLog();
        assert.deepEqual(written.map(rows => rows.length), [1]);
        recordActivity({ kind: 'command', name: '!d', channelID: '1' });
        await flushActivityLog();
        assert.deepEqual(written.map(rows => rows.length), [1, 1], 'a second round still writes');
    } finally { setActivityLogSinkForTests(null); }
});

test('rows written while a flush is in flight are written by the next one', async () => {
    const written: number[] = [];
    let release!: () => void;
    setActivityLogSinkForTests(rows => new Promise<void>(resolve => { written.push(rows.length); release = resolve; }));
    try {
        recordActivity({ kind: 'command', name: '!a', channelID: '1' });
        const first = flushActivityLog();
        recordActivity({ kind: 'command', name: '!b', channelID: '1' });
        assert.equal(flushActivityLog(), first, 'one flush at a time');
        release();
        // The loop picks up the row queued meanwhile before it finishes.
        await new Promise(resolve => setImmediate(resolve));
        release();
        await first;
        assert.deepEqual(written, [1, 1]);
        assert.equal(pendingActivityRowsForTests().length, 0);
    } finally { setActivityLogSinkForTests(null); }
});

test('credentials and e-mail addresses are masked wherever the text came from', () => {
    const row = buildActivityRow({
        kind: 'twitch_event', name: 'channel.channel_points_custom_reward_redemption.add', channelID: '1',
        text: 'contact me at person.name+x@example.co.uk please',
        data: {
            error: 'MongoServerError: connect to mongodb://admin:hunter2@db.internal:27017/app failed',
            header: 'Authorization: Bearer abcDEF123456.ghiJKL-789',
            query: 'GET /x?access_token=abc123def456&ok=1 and client_secret="s3cr3tvalue"',
            irc: 'PASS oauth:abcdefgh12345678',
            url: 'fetching https://api.example.test/v1/quote?key=AbCdEf123456&lang=en#top',
            plain: 'cheer500 love the stream, token economy is fun'
        }
    }, NOW)!;
    assert.equal(row.text, 'contact me at [email] please');
    assert.equal(row.data.error, 'MongoServerError: connect to mongodb://[redacted]@db.internal:27017/app failed');
    assert.equal(row.data.header, 'Authorization: [redacted]');
    assert.equal(row.data.query, 'GET /x?access_token=[redacted]&ok=1 and client_secret=[redacted]');
    assert.equal(row.data.irc, 'PASS oauth:[redacted]');
    assert.equal(row.data.url, 'fetching https://api.example.test/v1/quote?key=[redacted]&lang=en#top');
    assert.equal(row.data.plain, 'cheer500 love the stream, token economy is fun', 'ordinary words are left alone');
    // A secret that straddles the cut is masked before the text is clipped.
    const straddling = 'x'.repeat(290) + ' Bearer abcdefghijklmnopqrstuvwxyz0123456789';
    assert.equal(safeText(straddling, 300).includes('abcdefgh'), false);
    assert.ok(safeText(straddling, 300).length <= 300);
});

test('rows for a channel without an account are dropped right before the write; rows with no channel pass', async () => {
    const row = (channelID: string) => buildActivityRow({ kind: 'alert', name: 'channel.ad_break.begin', channelID }, NOW)!;
    const asked: string[][] = [];
    const kept = await dropRowsWithoutAccount([row('100'), row('200'), row('100'), row('')], async ids => { asked.push(ids); return new Set(['100']); });
    assert.deepEqual(kept.map(item => item.channelID), ['100', '100', '']);
    assert.deepEqual(asked, [['100', '200']], 'one lookup for the distinct channels of the batch');
    // Nothing to look up when no row has a channel.
    assert.equal((await dropRowsWithoutAccount([row('')], async () => { throw new Error('not called'); })).length, 1);
    // A lookup that fails fails the batch: better no rows than rows for a deleted account.
    await assert.rejects(dropRowsWithoutAccount([row('100')], async () => { throw new Error('store down'); }));
});
