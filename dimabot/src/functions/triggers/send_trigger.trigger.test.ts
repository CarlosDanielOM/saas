import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const state: { token: string | null; account: Record<string, string> | null; fetchResponse: Response; fetchCalls: Array<{ url: string; init: any }> } = {
    token: null,
    account: null,
    fetchResponse: new Response(JSON.stringify({ error: false, message: 'Trigger sent', status: 200 }), { status: 200 }),
    fetchCalls: []
};

mock.module('../../classes/twitch_streamers.class.js', {
    defaultExport: {
        getAccountTokenById: async () => state.token,
        getTwitchAccountById: async () => state.account
    }
});
mock.module('../../utils/logger.js', {
    namedExports: { error: async () => ({ success: true }) }
});

const { sendTrigger } = await import('./send_trigger.trigger.js');

const triggerData = { url: 'https://example.com/alert.mp3', mediaType: 'audio/mpeg', volume: 50 };

test.beforeEach(() => {
    state.token = null;
    state.account = null;
    state.fetchCalls = [];
    state.fetchResponse = new Response(JSON.stringify({ error: false, message: 'Trigger sent', status: 200 }), { status: 200 });
    mock.method(globalThis, 'fetch', async (url: any, init: any) => {
        state.fetchCalls.push({ url: String(url), init });
        return state.fetchResponse;
    });
});

test('revoked permissions (has_permissions=false) ask the streamer to reauthenticate in the dashboard', async () => {
    state.account = { id: 'chan', has_permissions: 'false', access_token: '', refresh_token: '' };
    const result = await sendTrigger('chan', triggerData);
    assert.equal(result.error, true);
    assert.equal(result.message, "I don't have the permissions to perform this action. Please reauthenticate in the dashboard.");
    assert.equal(state.fetchCalls.length, 0);
});

test('missing account record also asks to reauthenticate in the dashboard', async () => {
    state.account = null;
    const result = await sendTrigger('chan', triggerData);
    assert.equal(result.error, true);
    assert.equal(result.message, "I don't have the permissions to perform this action. Please reauthenticate in the dashboard.");
    assert.equal(state.fetchCalls.length, 0);
});

test('transient token failure (has_permissions=true) reports a renew failure to retry later', async () => {
    state.account = { id: 'chan', has_permissions: 'true', access_token: '', refresh_token: '' };
    const result = await sendTrigger('chan', triggerData);
    assert.equal(result.error, true);
    assert.equal(result.message, 'Failed to renew permissions. Please try again later.');
    assert.equal(state.fetchCalls.length, 0);
});

test('valid token posts to the channel trigger endpoint with the streamer bearer token', async () => {
    state.token = 'streamer-token';
    const result = await sendTrigger('chan', triggerData, true);
    assert.equal(result.error, false);
    assert.equal(result.message, 'Trigger sent');
    assert.equal(state.fetchCalls.length, 1);
    const call = state.fetchCalls[0];
    assert.ok(call.url.endsWith('/triggers/chan/send'));
    assert.equal(call.init.headers.Authorization, 'Bearer streamer-token');
    assert.deepEqual(JSON.parse(call.init.body), { ...triggerData, queue: true });
});

test('API error responses forward the API message', async () => {
    state.token = 'streamer-token';
    state.fetchResponse = new Response(JSON.stringify({ error: true, message: 'No trigger overlay clients connected', status: 409 }), { status: 409 });
    const result = await sendTrigger('chan', triggerData);
    assert.equal(result.error, true);
    assert.equal(result.message, 'No trigger overlay clients connected');
});
