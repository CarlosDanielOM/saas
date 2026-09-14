import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
mock.module('../../utils/header.js', { namedExports: { getTwitchBotHeader: async () => ({ error: false, header: { Authorization: 'Bearer dummy' } }) } });
const { ban, banRateLimitHeaders } = await import('./ban.moderation.js');
test('reads Twitch reset, remaining and both Retry-After formats', () => {
    assert.deepEqual(banRateLimitHeaders(new Headers({ 'ratelimit-reset': '123', 'ratelimit-remaining': '0', 'retry-after': '5' })), {
        rateLimitRemaining: 0, rateLimitResetAt: 123000, retryAfterMs: 5000
    });
    assert.equal(banRateLimitHeaders(new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:01:00 GMT' }), 1000).retryAfterMs, 59000);
    assert.equal(banRateLimitHeaders(new Headers()).rateLimitRemaining, undefined);
});
test('non-JSON 429 retains HTTP status and rate limits', async context => {
    context.mock.method(globalThis, 'fetch', async () => new Response('busy', { status: 429, headers: { 'Retry-After': '30' } }));
    const result = await ban('channel', 'user', 'bot');
    assert.equal(result.error, true);
    assert.equal(result.status, 429);
    assert.equal(result.retryAfterMs, 30000);
});
test('abort while getting credentials cannot initiate a late moderation request', async context => {
    context.mock.method(globalThis, 'fetch', async () => assert.fail('No request after cancellation'));
    const signal = AbortSignal.abort();
    assert.equal((await ban('channel', 'user', 'bot', null, null, signal)).error, true);
});
