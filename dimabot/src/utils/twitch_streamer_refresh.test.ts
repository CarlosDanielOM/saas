import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let access = 'rejected';
let refresh = 'refresh';
let lock: string | null = null;
let refreshCalls = 0;
let refreshBehavior: () => Promise<string | null>;
const expiry = String(Math.floor(Date.now() / 1000) + 3600);
const cache = {
    hGet: async (_key: string, field: string) => field === 'access_token' ? access : field === 'expires_at' ? expiry : refresh,
    set: async (_key: string, value: string) => { if (lock) return null; lock = value; return 'OK'; },
    get: async () => lock,
    exists: async () => lock ? 1 : 0,
    del: async () => { lock = null; return 1; },
};
mock.module('./databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => cache } });
mock.module('./logger.js', { namedExports: { error: async () => {}, info: async () => {}, debug: async () => {}, warn: async () => {} } });
mock.module('./posthog_events.js', { namedExports: { identifyStreamer: () => {} } });
mock.module('./tokens.js', { namedExports: {
    refreshTwitchToken: async () => { refreshCalls++; const token = await refreshBehavior(); if (token) access = token; return { token, kind: token ? 'success' : 'transient_failure', expiresIn: 3600 }; },
    getAppToken: async () => null, getBotToken: async () => null
} });
mock.module('./oauth_debug_cache.js', { namedExports: { cacheOAuthAPIFailure: async () => {} } });
const { TwitchStreamers, default: streamers } = await import('../classes/twitch_streamers.class.js');
const { executeHelixStreamerRequestWith401Retry } = await import('./twitch_helix_retry.js');

function reset() { access = 'rejected'; refresh = 'refresh'; lock = null; refreshCalls = 0; refreshBehavior = async () => 'rotated'; }

test('401 refreshes the rejected cached token and sends the rotated token', async t => {
    reset();
    t.mock.method(streamers, 'getTwitchAccountById', async () => ({ id: 'owner', has_permissions: 'true' } as any));
    const sent: string[] = [];
    const result = await executeHelixStreamerRequestWith401Retry({ channelID: 'owner', retryDelaysMs: [1], executeRequest: async header => {
        sent.push(header.Authorization); return new Response('', { status: sent.length === 1 ? 401 : 200 });
    } });
    assert.equal(result.response?.status, 200);
    assert.deepEqual(sent, ['Bearer rejected', 'Bearer rotated']);
    assert.equal(refreshCalls, 1);
});

test('a newer token is reused without refreshing', async () => {
    reset(); access = 'newer';
    const token = await new TwitchStreamers().getAccountTokenById('owner', 'twitch', 'rejected');
    assert.equal(token, 'newer'); assert.equal(refreshCalls, 0);
});

test('concurrent callers wait for the lock holder instead of reusing the rejected token', async () => {
    reset();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    refreshBehavior = async () => { await gate; return 'rotated'; };
    const a = new TwitchStreamers().getAccountTokenById('owner', 'twitch', 'rejected');
    for (let i = 0; !refreshCalls && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(refreshCalls, 1, 'the rejected token must trigger a refresh');
    const b = new TwitchStreamers().getAccountTokenById('owner', 'twitch', 'rejected');
    setTimeout(release, 200);
    assert.deepEqual(await Promise.all([a, b]), ['rotated', 'rotated']);
    assert.equal(refreshCalls, 1);
});

test('a failed refresh does not resend the rejected credential', async t => {
    reset(); refreshBehavior = async () => null;
    t.mock.method(streamers, 'getTwitchAccountById', async () => ({ id: 'owner', has_permissions: 'true' } as any));
    const sent: string[] = [];
    const result = await executeHelixStreamerRequestWith401Retry({ channelID: 'owner', retryDelaysMs: [1], executeRequest: async header => {
        sent.push(header.Authorization); return new Response('', { status: 401 });
    } });
    assert.equal(result.response?.status, 401);
    assert.equal(result.error, true);
    assert.equal(result.status, 503);
    assert.equal(result.refreshUnavailable, true);
    assert.deepEqual(sent, ['Bearer rejected']);
    assert.equal(refresh, 'refresh');
});

test('persistent 401s stop after the configured retries', async t => {
    reset();
    refreshBehavior = async () => `rotated-${refreshCalls}`;
    t.mock.method(streamers, 'getTwitchAccountById', async () => ({ id: 'owner', has_permissions: 'true' } as any));
    const sent: string[] = [];
    const result = await executeHelixStreamerRequestWith401Retry({ channelID: 'owner', retryDelaysMs: [1, 1], executeRequest: async header => {
        sent.push(header.Authorization); return new Response('', { status: 401 });
    } });
    assert.equal(result.response?.status, 401);
    assert.equal(result.error, false);
    assert.equal(result.refreshUnavailable, undefined);
    assert.deepEqual(sent, ['Bearer rejected', 'Bearer rotated-1', 'Bearer rotated-2']);
    assert.equal(refreshCalls, 2);
});
