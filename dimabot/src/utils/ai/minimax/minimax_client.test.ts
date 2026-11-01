import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Fake MiniMax (Anthropic-compatible) server. Each test picks a scenario via the user text.
const requests: any[] = [];
let server: http.Server;

const sse = (res: http.ServerResponse, events: Array<[string, unknown]>, { holdOpen = false } = {}) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (!holdOpen) res.end();
};

const message = (usage: Record<string, unknown>) => ({
    id: 'msg_test', type: 'message', role: 'assistant', model: 'MiniMax-M3.1-Flash', content: [],
    stop_reason: null, stop_sequence: null, usage,
});

before(async () => {
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            const body = JSON.parse(raw);
            requests.push({ body, headers: req.headers });
            const text = String(body.messages.at(-1).content);
            if (text === 'bad') {
                res.writeHead(400, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'nope' } }));
            }
            if (text === 'quiet') {
                return sse(res, [['message_start', { type: 'message_start', message: message({ input_tokens: 0, output_tokens: 0 }) }]], { holdOpen: true });
            }
            if (text === 'overloaded') {
                return sse(res, [
                    ['message_start', { type: 'message_start', message: message({ input_tokens: 0, output_tokens: 0 }) }],
                    ['error', { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }],
                ]);
            }
            sse(res, [
                ['message_start', { type: 'message_start', message: message({ input_tokens: 0, output_tokens: 0 }) }],
                ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
                ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me look.' } }],
                ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }],
                ['content_block_stop', { type: 'content_block_stop', index: 0 }],
                ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
                ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } }],
                ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } }],
                ['content_block_stop', { type: 'content_block_stop', index: 1 }],
                ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
                    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 4000, output_tokens_details: { thinking_tokens: 50 } } }],
                ['message_stop', { type: 'message_stop' }],
            ]);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.MINIMAX_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.MINI_TOKEN_PLAN_API_KEY = 'test-key';
});

after(() => { server.closeAllConnections(); server.close(); });

const { minimaxChat, minimaxChatStream, calculateMiniMaxCost, MiniMaxError } = await import('./minimax_client.js');
const ask = (content: string) => ({ messages: [{ role: 'user' as const, content }] });

test('streams text, skips thinking from the reply, and reports usage and cost', async () => {
    const deltas: string[] = [];
    let thought = '';
    const result = await minimaxChatStream({ ...ask('hi'), system: 'Be brief', effort: 'xhigh' }, {
        onText: (delta) => deltas.push(delta),
        onThinking: (delta) => { thought += delta; },
    });
    assert.deepEqual(deltas, ['Hello ', 'world']);
    assert.equal(thought, 'Let me look.');
    assert.equal(result.content, 'Hello world');
    assert.equal(result.inputTokens, 1000);
    assert.equal(result.outputTokens, 200);
    assert.equal(result.cacheReadTokens, 4000);
    assert.equal(result.thinkingTokens, 50);
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.cost, calculateMiniMaxCost(1000, 200, 4000));
    assert.ok(Math.abs(result.cost - (1000 * 0.15 + 4000 * 0.015 + 200 * 0.6) / 1e6) < 1e-12);
});

test('sends M3.1-Flash, the requested effort, and the model ceiling as max_tokens (no artificial cap)', async () => {
    requests.length = 0;
    await minimaxChat({ ...ask('hi'), effort: 'high' });
    const { body, headers } = requests[0];
    assert.equal(body.model, 'MiniMax-M3.1-Flash');
    assert.equal(body.max_tokens, 524288);
    assert.deepEqual(body.output_config, { effort: 'high' });
    assert.equal(body.stream, true);
    assert.equal(headers['x-api-key'], 'test-key');
});

test('drops system-role messages from the message list', async () => {
    requests.length = 0;
    await minimaxChat({ messages: [{ role: 'system' as any, content: 'x' }, { role: 'user', content: 'hi' }] });
    assert.deepEqual(requests[0].body.messages.map((m: any) => m.role), ['user']);
});

test('classifies a 400 as bad_request without retrying', async () => {
    requests.length = 0;
    await assert.rejects(minimaxChat(ask('bad')), (err: any) => err instanceof MiniMaxError && err.kind === 'bad_request' && err.status === 400);
    assert.equal(requests.length, 1);
});

test('an error inside the stream is reported as overloaded', async () => {
    await assert.rejects(minimaxChat(ask('overloaded')), (err: any) => err instanceof MiniMaxError && err.kind === 'overloaded');
});

test('a stream that goes quiet times out', async () => {
    await assert.rejects(minimaxChat({ ...ask('quiet'), idleTimeoutMs: 300 }), (err: any) => err instanceof MiniMaxError && err.kind === 'timeout');
});

test('caller cancellation is reported as aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(minimaxChat({ ...ask('quiet'), signal: controller.signal }), (err: any) => err instanceof MiniMaxError && err.kind === 'aborted');
});

test('cancellation settles at once even if the connection never notices', async () => {
    // A transport whose body ignores the abort signal: the call must still end promptly.
    const realFetch = globalThis.fetch;
    const key = process.env.MINI_TOKEN_PLAN_API_KEY;
    const hold = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: message({ input_tokens: 0, output_tokens: 0 }) })}\n\n`;
    globalThis.fetch = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(hold)); } }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    process.env.MINI_TOKEN_PLAN_API_KEY = 'test-key-stuck'; // new key → new client using this fetch
    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        const started = Date.now();
        await assert.rejects(minimaxChat({ ...ask('hi'), signal: controller.signal }), (err: any) => err instanceof MiniMaxError && err.kind === 'aborted');
        assert.ok(Date.now() - started < 2000, 'settled promptly');
        await assert.rejects(minimaxChat({ ...ask('hi'), idleTimeoutMs: 200 }), (err: any) => err instanceof MiniMaxError && err.kind === 'timeout');
    } finally {
        globalThis.fetch = realFetch;
        process.env.MINI_TOKEN_PLAN_API_KEY = key;
    }
});

test('a missing key fails clearly before any request', async () => {
    const key = process.env.MINI_TOKEN_PLAN_API_KEY;
    delete process.env.MINI_TOKEN_PLAN_API_KEY;
    requests.length = 0;
    try {
        await assert.rejects(minimaxChat(ask('hi')), (err: any) => err instanceof MiniMaxError && err.kind === 'config');
        assert.equal(requests.length, 0);
    } finally {
        process.env.MINI_TOKEN_PLAN_API_KEY = key;
    }
});
