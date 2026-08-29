import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

const SECRET = 'eventsub-test-secret';

function signedHeaders(body: string, options?: {
    messageId?: string;
    messageTimestamp?: string;
    messageType?: string;
    signature?: string;
}): Record<string, string> {
    const messageId = options?.messageId ?? 'message-1';
    const messageTimestamp = options?.messageTimestamp ?? new Date().toISOString();
    const signature = options?.signature ?? `sha256=${crypto.createHmac('sha256', SECRET)
        .update(messageId)
        .update(messageTimestamp)
        .update(body)
        .digest('hex')}`;
    return {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-timestamp': messageTimestamp,
        'twitch-eventsub-message-signature': signature,
        'twitch-eventsub-message-type': options?.messageType ?? 'notification'
    };
}

test('EventSub webhook validates transport before notification processing', async (context) => {
    process.env.TWITCH_EVENTSUB_SECRET = SECRET;
    process.env.SECRET_KEY = 'eventsub-test-encryption-key';
    const { acceptEventsubMessageTimestamp, createTwitchEventsubApp } = await import('./eventsub.twitch.js');
    const configuredSecret = process.env.TWITCH_EVENTSUB_SECRET;
    delete process.env.TWITCH_EVENTSUB_SECRET;
    assert.throws(() => createTwitchEventsubApp(), /TWITCH_EVENTSUB_SECRET is not set/);
    process.env.TWITCH_EVENTSUB_SECRET = configuredSecret;
    const server = createTwitchEventsubApp().listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    context.after(() => new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    }));
    const { port } = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/eventsub`;

    await context.test('accepts only bounded stale retries for durable notifications', () => {
        const staleTimestamp = new Date(Date.now() - 20 * 60_000).toISOString();
        assert.deepEqual(acceptEventsubMessageTimestamp(staleTimestamp, '1', true), {
            accepted: true,
            staleRetry: true
        });
        assert.deepEqual(acceptEventsubMessageTimestamp(staleTimestamp, '1', false), {
            accepted: false,
            staleRetry: false
        });
        assert.deepEqual(acceptEventsubMessageTimestamp(staleTimestamp, '1invalid', true), {
            accepted: false,
            staleRetry: false
        });
        assert.deepEqual(acceptEventsubMessageTimestamp(
            new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
            '1',
            true
        ), {
            accepted: false,
            staleRetry: false
        });
    });

    await context.test('answers verification challenges without an event payload', async () => {
        const body = JSON.stringify({
            challenge: 'challenge-token',
            subscription: { type: 'stream.online', version: '1' }
        });
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: signedHeaders(body, { messageType: 'webhook_callback_verification' }),
            body
        });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'challenge-token');
    });

    await context.test('rejects a validly signed malformed notification', async () => {
        const body = JSON.stringify({ subscription: { type: 'stream.online', version: '1' } });
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: signedHeaders(body),
            body
        });
        assert.equal(response.status, 400);
    });

    await context.test('rejects malformed JSON after signature validation', async () => {
        const body = '{';
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: signedHeaders(body),
            body
        });
        assert.equal(response.status, 400);
    });

    await context.test('rejects an invalid signature', async () => {
        const body = JSON.stringify({});
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: signedHeaders(body, { signature: 'sha256=invalid' }),
            body
        });
        assert.equal(response.status, 403);
    });

    await context.test('rejects a stale message timestamp', async () => {
        const body = JSON.stringify({});
        const messageTimestamp = new Date(Date.now() - 20 * 60_000).toISOString();
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: signedHeaders(body, { messageTimestamp }),
            body
        });
        assert.equal(response.status, 403);
    });
});
