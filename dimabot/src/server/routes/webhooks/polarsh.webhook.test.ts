import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import express, { type Response } from 'express';
import { Webhook } from 'standardwebhooks';
import { validateEvent } from '@polar-sh/sdk/webhooks.js';
import type { CustomerState } from '@polar-sh/sdk/models/components/customerstate.js';
import type { WebhookCustomerStateChangedPayload$Outbound } from '@polar-sh/sdk/models/components/webhookcustomerstatechangedpayload.js';
import type { NormalizePolarWebhookInput } from '../../../domain_events/polar_events.js';
import { createPolarWebhookRouter } from './polarsh.webhook.js';

const secret = 'polar-webhook-transport-test-secret-not-a-real-credential';
const webhookId = 'polar-test-delivery-1';
const timestamp = '2026-09-04T12:00:00.000Z';

// Manually constructed wire payload, matching the installed SDK's inbound models.
const fixture = {
    type: 'customer.state_changed',
    timestamp,
    data: {
        id: 'customer-test-1',
        created_at: timestamp,
        modified_at: null,
        metadata: {},
        external_id: null,
        email: 'polar-webhook@example.test',
        email_verified: false,
        name: null,
        billing_address: null,
        tax_id: null,
        organization_id: 'organization-test-1',
        deleted_at: null,
        active_subscriptions: [],
        granted_benefits: [],
        active_meters: [{
            id: 'customer-meter-test-1',
            created_at: timestamp,
            modified_at: null,
            meter_id: 'meter-test-1',
            consumed_units: 2.5,
            credited_units: 10,
            balance: 7.5
        }],
        avatar_url: 'https://example.test/avatar.png'
    }
} satisfies WebhookCustomerStateChangedPayload$Outbound;

// Whitespace is intentional: signature verification must use the original bytes.
const body = JSON.stringify(fixture, null, 2) + '\n';

function signedHeaders(): Record<string, string> {
    const now = new Date();
    const signer = new Webhook(Buffer.from(secret, 'utf8').toString('base64'));
    return {
        'content-type': 'application/json',
        'webhook-id': webhookId,
        'webhook-timestamp': Math.floor(now.getTime() / 1000).toString(),
        'webhook-signature': signer.sign(webhookId, now, body)
    };
}

async function serve(
    t: TestContext,
    options: Parameters<typeof createPolarWebhookRouter>[0],
    observeResponse?: (response: Response) => void
) {
    const previousSecret = process.env.POLARSH_WEBHOOK_SECRET;
    process.env.POLARSH_WEBHOOK_SECRET = secret;
    t.after(() => {
        if (previousSecret === undefined) delete process.env.POLARSH_WEBHOOK_SECRET;
        else process.env.POLARSH_WEBHOOK_SECRET = previousSecret;
    });
    t.mock.method(console, 'error', () => {});

    const app = express();
    app.use((_req, res, next) => {
        observeResponse?.(res);
        next();
    });
    // Mount directly, without express.json(): this is a signed raw-body transport.
    app.use('/polar', createPolarWebhookRouter(options));
    const server = createServer(app);
    t.after(async () => {
        const closed = once(server, 'close');
        server.close();
        server.closeAllConnections();
        await closed;
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return (headers = signedHeaders(), payload = body) => fetch(`http://127.0.0.1:${address.port}/polar`, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(5000)
    });
}

test('a real SDK-verified delivery forwards camelCase meters, Dates and the receipt identity', async (t) => {
    const inputs: NormalizePolarWebhookInput[] = [];
    const post = await serve(t, {
        ingest: async (input) => {
            inputs.push(input);
            return { inserted: true };
        }
    });

    const response = await post();
    assert.equal(response.status, 202);
    assert.equal(await response.text(), '');
    assert.equal(inputs.length, 1);
    const input = inputs[0];
    assert.equal(input.webhookId, webhookId);
    assert.equal(input.event.type, fixture.type);
    assert.ok(input.event.timestamp instanceof Date);
    assert.equal(input.event.timestamp.toISOString(), timestamp);
    const data = input.event.data as CustomerState;
    assert.equal(data.id, fixture.data.id);
    assert.notEqual(input.webhookId, data.id);
    assert.ok(data.createdAt instanceof Date);
    assert.equal('active_meters' in data, false);
    assert.deepEqual(data.activeMeters, [{
        id: 'customer-meter-test-1',
        createdAt: new Date(timestamp),
        modifiedAt: null,
        meterId: 'meter-test-1',
        consumedUnits: 2.5,
        creditedUnits: 10,
        balance: 7.5
    }]);
});

test('verification receives the exact raw Buffer rather than pre-parsed JSON', async (t) => {
    let verified = false;
    const ingest = t.mock.fn(async (_input: NormalizePolarWebhookInput) => ({ inserted: true }));
    const post = await serve(t, {
        verify: (rawBody, headers, configuredSecret) => {
            assert.ok(Buffer.isBuffer(rawBody));
            assert.deepEqual(rawBody, Buffer.from(body));
            assert.equal(configuredSecret, secret);
            const event = validateEvent(rawBody, headers, configuredSecret);
            verified = true;
            return event;
        },
        ingest
    });

    const response = await post();
    assert.equal(response.status, 202);
    assert.equal(await response.text(), '');
    assert.equal(verified, true);
    assert.equal(ingest.mock.callCount(), 1);
});

test('an invalid signature returns 403 without ingestion', async (t) => {
    const ingest = t.mock.fn(async (_input: NormalizePolarWebhookInput) => ({ inserted: true }));
    const post = await serve(t, { ingest });
    const response = await post(signedHeaders(), body.replace('customer-test-1', 'customer-tampered'));

    assert.equal(response.status, 403);
    assert.equal(await response.text(), '');
    assert.equal(ingest.mock.callCount(), 0);
});

test('the real SDK rejects a missing webhook-id with 403 before ingestion', async (t) => {
    const ingest = t.mock.fn(async (_input: NormalizePolarWebhookInput) => ({ inserted: true }));
    const post = await serve(t, { ingest });
    const headers = signedHeaders();
    delete headers['webhook-id'];
    const response = await post(headers);

    assert.equal(response.status, 403);
    assert.equal(await response.text(), '');
    assert.equal(ingest.mock.callCount(), 0);
});

test('a rejected ingestion returns 500 rather than acknowledging the delivery', async (t) => {
    const ingest = t.mock.fn(async (_input: NormalizePolarWebhookInput) => {
        throw new Error('Synthetic ingestion failure');
    });
    const post = await serve(t, { ingest });
    const response = await post();

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
        error: true,
        message: 'Internal server error',
        status: 500
    });
    assert.equal(ingest.mock.callCount(), 1);
});

test('the response waits for a controlled ingestion promise to resolve', async (t) => {
    const entered = Promise.withResolvers<void>();
    const ingestion = Promise.withResolvers<{ inserted: boolean }>();
    let serverResponse: Response | undefined;
    const ingest = t.mock.fn((_input: NormalizePolarWebhookInput) => {
        entered.resolve();
        return ingestion.promise;
    });
    const post = await serve(t, { ingest }, (response) => { serverResponse = response; });
    let responded = false;
    const pendingResponse = post().then((response) => {
        responded = true;
        return response;
    });

    try {
        await Promise.race([
            entered.promise,
            pendingResponse.then(() => assert.fail('Response arrived without entering ingestion'))
        ]);
        // An event-loop turn lets an incorrectly unawaited route finish, without a timed sleep.
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.ok(serverResponse);
        assert.equal(serverResponse.headersSent, false);
        assert.equal(serverResponse.writableEnded, false);
        assert.equal(responded, false);
    } finally {
        ingestion.resolve({ inserted: true });
    }

    const response = await pendingResponse;
    assert.equal(response.status, 202);
    assert.equal(await response.text(), '');
    assert.equal(ingest.mock.callCount(), 1);
});

test('duplicate receipts still return 202 when ingestion reports inserted false', async (t) => {
    const inputs: NormalizePolarWebhookInput[] = [];
    const post = await serve(t, {
        ingest: async (input) => {
            inputs.push(input);
            return { inserted: false };
        }
    });
    const headers = signedHeaders();
    for (let delivery = 0; delivery < 2; delivery++) {
        const response = await post(headers);
        assert.equal(response.status, 202);
        assert.equal(await response.text(), '');
    }
    assert.equal(inputs.length, 2);
    assert.deepEqual(inputs.map((input) => input.webhookId), [webhookId, webhookId]);
    assert.deepEqual(inputs[0], inputs[1]);
});
