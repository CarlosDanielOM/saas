import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AdminRequestError } from '../../routes/admin_site/shared.js';
import { deliveryReason, isValidEventKey, receiptSteps } from './event_detail.js';
import { parseFeedQuery, parseFeedScope } from './query.js';
import { REDACTED, safeErrorText, scrubPayload } from './scrub.js';

describe('scrubPayload', () => {
    it('removes credential, email and signature keys at any depth and keeps the facts', () => {
        const clean = scrubPayload({
            user_id: '7', user_login: 'viewer', bits: 100, is_anonymous: false,
            access_token: 'abc', refreshToken: 'abc', client_secret: 'x', user_email: 'a@b.co', signature: 'sha256=1',
            message: { text: 'hi', fragments: [{ type: 'text', text: 'hi', oauth_token: 'x' }] },
            nested: { deeper: { Authorization: 'Bearer abc', api_key: 'k', session_id: 's', keep: 1 } }
        });
        assert.deepEqual(clean, {
            user_id: '7', user_login: 'viewer', bits: 100, is_anonymous: false,
            message: { text: 'hi', fragments: [{ type: 'text', text: 'hi' }] },
            nested: { deeper: { keep: 1 } }
        });
    });
    it('masks secrets and addresses inside any string value, keeping the rest of the text', () => {
        const clean = scrubPayload({
            note: 'write me at someone@example.com', jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXN0cmluZw',
            header: 'Bearer 0123456789abcdefghij', opaque: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0e1', id: 'f2b9c8a0-1c2d-4e5f-8a9b-0c1d2e3f4a5b', login: 'cdom201',
            chat: 'Bearer Champion42 wins the $(channel) raffle'
        });
        assert.deepEqual(clean, {
            note: 'write me at [email]', jwt: '[redacted token]', header: 'Bearer [redacted]', opaque: REDACTED,
            id: 'f2b9c8a0-1c2d-4e5f-8a9b-0c1d2e3f4a5b', login: 'cdom201', chat: 'Bearer Champion42 wins the $(channel) raffle'
        });
    });
    it('closes the reported bypasses: a secret inside a sentence, a nested string or a camelCase key', () => {
        const clean = scrubPayload({
            message: { text: 'use Bearer abcdefghij0123456789ZZ now' },
            error: 'connect failed mongodb://admin:hunter2@db.internal:27017/prod after 3 tries',
            accessToken: 'abc', refresh_Token: 'abc', 'Set-Cookie': 'sid=1', eMail: 'a@b.co',
            providerRequestID: 'gen-123', customerId: 'c-1', polar_customer_id: 'c-2', reviewerID: '533538623',
            nested: { list: [{ note: 'call https://x.test/hook?api_key=abcd1234efgh5678 please' }, 'token=zyxw9876vuts5432 then'] }
        });
        assert.deepEqual(clean, {
            message: { text: 'use Bearer [redacted] now' },
            error: 'connect failed mongodb://[redacted]@db.internal:27017/prod after 3 tries',
            nested: { list: [{ note: 'call https://x.test/hook?api_key=[redacted] please' }, 'token=[redacted] then'] }
        });
        // Whatever the depth, nothing of the secrets is left.
        assert.equal(/abcdefghij0123456789ZZ|hunter2|abcd1234efgh5678|zyxw9876vuts5432|gen-123|533538623/.test(JSON.stringify(clean)), false);
    });
    it('bounds depth, keys, items, strings and the total size', () => {
        let deep: Record<string, unknown> = { leaf: 1 };
        for (let i = 0; i < 20; i++) deep = { next: deep };
        const clean = JSON.stringify(scrubPayload({ deep, list: Array.from({ length: 500 }, (_, i) => i), long: 'x'.repeat(5000), many: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i])) }));
        assert.ok(clean.length < 25_000);
        assert.ok(!clean.includes('"leaf"'));
        const list = scrubPayload({ list: Array.from({ length: 500 }, (_, i) => i) }).list as number[];
        assert.equal(list.length, 50);
        assert.equal((scrubPayload({ long: 'x'.repeat(5000) }).long as string).length, 1001);
        const huge = scrubPayload({ a: 'y'.repeat(900), b: Array.from({ length: 50 }, () => 'z'.repeat(900)) });
        assert.ok(JSON.stringify(huge).length <= 21_000);
    });
    it('returns a plain object for anything else and drops operator-looking keys', () => {
        assert.deepEqual(scrubPayload(null), {});
        assert.deepEqual(scrubPayload('text'), {});
        assert.deepEqual(scrubPayload([1, 2]), {});
        assert.deepEqual(scrubPayload({ $where: 'x', ok: Number.NaN }), { ok: null });
    });
});

describe('event detail helpers', () => {
    it('accepts only the three-part journal key shape', () => {
        assert.equal(isValidEventKey('twitch-eventsub:2f1c%3Aab:channel.follow.received'), true);
        for (const bad of ['', 'a:b', 'a:b:c:d', 'a b:c:d', 'a:b:c/d', `a:b:${'c'.repeat(400)}`, 'a:b:c\n']) assert.equal(isValidEventKey(bad), false, bad);
    });
    it('explains a delivery without leaking addresses or secrets', () => {
        assert.equal(deliveryReason({ status: 'succeeded', skipReason: '', lastErrorCode: '', lastError: 'old', lastDeadLetterError: '' }), null);
        assert.equal(deliveryReason({ status: 'skipped', skipReason: 'event_too_old', lastErrorCode: '', lastError: '', lastDeadLetterError: '' }), 'event_too_old');
        const reason = deliveryReason({ status: 'dead', skipReason: '', lastErrorCode: 'handler_failed', lastError: 'connect failed mongodb://user:pass@10.0.0.5:27017/db token=abc123', lastDeadLetterError: '' });
        assert.equal(reason, 'handler_failed: connect failed [address] token=[removed]');
        assert.ok((safeErrorText('x'.repeat(500)) as string).length <= 200);
    });
    it('lists stream steps in time order', () => {
        const steps = receiptSteps(new Map([
            ['rewards', { status: 'failed', reason: 'twitch 500 at https://api.twitch.tv/helix', at: new Date('2026-11-05T10:00:02Z') }],
            ['timers', { status: 'completed', at: new Date('2026-11-05T10:00:01Z') }],
            ['bogus', { status: 'weird', at: new Date() }]
        ]));
        assert.deepEqual(steps, [
            { step: 'timers', status: 'completed', reason: null, at: '2026-11-05T10:00:01.000Z' },
            { step: 'rewards', status: 'failed', reason: 'twitch 500 at [address]', at: '2026-11-05T10:00:02.000Z' }
        ]);
    });
});

describe('feed query', () => {
    const now = new Date('2026-11-13T12:00:00.000Z');
    const rejects = (query: Record<string, unknown>) => assert.throws(() => parseFeedQuery(query, now), (error: unknown) => error instanceof AdminRequestError && error.status === 400, JSON.stringify(query));
    it('defaults to the last 7 days, 40 rows, everything', () => {
        const { filters, cursor, limit } = parseFeedQuery({}, now);
        assert.deepEqual(filters, { from: new Date('2026-11-06T12:00:00.000Z'), to: now });
        assert.equal(cursor, undefined);
        assert.equal(limit, 40);
    });
    it('reads every filter', () => {
        const { filters, limit } = parseFeedQuery({ channel: '100', actor: '7', actorLogin: '@Viewer', kinds: 'command,alert', outcome: 'problems', limit: '100', from: '2026-11-01', to: '2026-11-02' }, now);
        assert.deepEqual(filters, { from: new Date('2026-11-01'), to: new Date('2026-11-02'), channelID: '100', actorID: '7', actorLogin: 'viewer', kinds: ['command', 'alert'], outcome: 'problems' });
        assert.equal(limit, 100);
    });
    it('refuses bad input', () => {
        for (const query of [{ kinds: 'command,nope' }, { kinds: { $ne: 'x' } }, { outcome: 'ok' }, { limit: '101' }, { limit: '0' }, { channel: 'abc' },
            { actor: ['1', '2'] }, { actorLogin: 'a.b' }, { from: '2026-01-01', to: '2026-11-01' }, { from: '2026-11-02', to: '2026-11-01' }]) rejects(query);
        assert.throws(() => parseFeedScope({ channel: { $gt: '' } }, now), AdminRequestError);
    });
});
