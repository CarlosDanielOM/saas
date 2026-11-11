import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import type { LlmRequest } from '../types.js';
import { LlmError, mergeReasoningDetails, reconcileGeneration, streamChat } from './openrouter.js';

const KEY = 'sk-or-v1-testkey0123456789';
type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>;
interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: string }

let handler: Handler = (_req, res) => { res.end(); };
const seen: Seen[] = [];
const sockets = new Set<import('node:net').Socket>();
const server = createServer((req, res) => {
    let body = '';
    req.on('data', (part) => { body += part; });
    req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        void handler(req, res, body);
    });
});
server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });

before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/`;
    process.env.OPENROUTER_API_KEY = KEY;
});
after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => { seen.length = 0; });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ id: 'gen-1', provider: 'OpenAI', model: 'openai/gpt-6-luna', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra });
const finish = (reason = 'stop') => ({ id: 'gen-1', provider: 'OpenAI', choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageChunk = {
    id: 'gen-1', provider: 'OpenAI', choices: [],
    usage: {
        prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, cost: 0, is_byok: true,
        prompt_tokens_details: { cached_tokens: 900 }, completion_tokens_details: { reasoning_tokens: 120 },
        cost_details: { upstream_inference_cost: 0.000271, upstream_inference_prompt_cost: 0.000121, upstream_inference_completions_cost: 0.00015 },
    },
};

/** Writes raw pieces with optional pauses (numbers = ms). Holds the response open with `hold`. */
function stream(pieces: (string | number)[], opts: { status?: number; headers?: Record<string, string>; hold?: boolean } = {}): Handler {
    return async (_req, res) => {
        res.writeHead(opts.status ?? 200, { 'content-type': 'text/event-stream', ...opts.headers });
        res.flushHeaders();
        for (const piece of pieces) {
            if (typeof piece === 'number') await sleep(piece);
            else res.write(piece);
        }
        if (!opts.hold) res.end();
    };
}
const jsonError = (status: number, message: string, headers: Record<string, string> = {}): Handler => (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ error: { code: status, message } }));
};

const request = (extra: Partial<LlmRequest> = {}): LlmRequest => ({
    model: 'openai/gpt-6-luna', effort: 'xhigh', sessionKey: 'sess-1',
    messages: [{ role: 'system', content: 'You help.' }, { role: 'user', content: 'Hi' }], ...extra,
});
const fast = { retryDelaysMs: [5, 5] };

/** Splits text into pieces of `size` characters (cuts through lines, CRLFs and JSON). */
const shred = (text: string, size: number) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));

test('fragmented CRLF stream: text, reasoning, several tool calls, usage and the exact request', async () => {
    const sse = [
        ': OPENROUTER PROCESSING\r\n\r\n',
        data(chunk({ role: 'assistant', reasoning: 'Looking ', reasoning_details: [{ type: 'reasoning.summary', summary: 'Looking ', format: 'openai-responses-v1', index: 0 }] })),
        data(chunk({ reasoning: 'it up.', reasoning_details: [{ type: 'reasoning.summary', summary: 'it up.', index: 0 }] })),
        data(chunk({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'enc-A', id: 'rs_1', format: 'openai-responses-v1', index: 1 }] })),
        data(chunk({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'enc-B', index: 1 }] })),
        data(chunk({ content: 'Let me ' })),
        data(chunk({ content: 'check. ¡Olé! 🎉' })),
        // Second call starts before the first one finishes; pieces of id/name/arguments.
        data(chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'search_', arguments: '' } }] })),
        data(chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'read_docs', arguments: '{"id":' } }] })),
        data(chunk({ tool_calls: [{ index: 0, function: { name: 'docs', arguments: '{"query":"tts"' } }] })),
        data(chunk({ tool_calls: [{ index: 1, function: { arguments: '"/tts"}' } }] })),
        data(chunk({ tool_calls: [{ index: 0, function: { arguments: '}' } }] })),
        data(chunk({ tool_calls: [{ index: 2, id: 'call_c', function: { arguments: '{}' } }] })), // never named: dropped
        ': keep-alive\n\n',
        data(finish('tool_calls')),
        data(usageChunk),
        'data: [DONE]\n\n',
    ].join('').replace(/\n/g, '\r\n').replace(/\r\r\n/g, '\r\n');
    handler = stream(shred(sse, 7));
    const texts: string[] = [];
    const thoughts: string[] = [];
    const result = await streamChat(request({
        tools: [{ name: 'search_docs', description: 'Search', parameters: { type: 'object', properties: {} } }],
        toolChoice: 'auto',
    }), { onText: (d) => texts.push(d), onReasoning: (d) => thoughts.push(d) });

    assert.equal(result.content, 'Let me check. ¡Olé! 🎉');
    assert.deepEqual(texts, ['Let me ', 'check. ¡Olé! 🎉']);
    assert.deepEqual(thoughts, ['Looking ', 'it up.']);
    assert.deepEqual(result.toolCalls, [
        { id: 'call_a', name: 'search_docs', arguments: '{"query":"tts"}' },
        { id: 'call_b', name: 'read_docs', arguments: '{"id":"/tts"}' },
    ]);
    assert.deepEqual(result.reasoning, [
        { type: 'reasoning.summary', summary: 'Looking it up.', format: 'openai-responses-v1', index: 0 },
        { type: 'reasoning.encrypted', data: 'enc-Aenc-B', id: 'rs_1', format: 'openai-responses-v1', index: 1 },
    ]);
    assert.deepEqual(result.usage, {
        promptTokens: 1200, cachedTokens: 900, completionTokens: 300, reasoningTokens: 120,
        upstreamCostUsd: 0.000271, routerCostUsd: 0, source: 'reported', isByok: true,
    });
    assert.equal(result.generationId, 'gen-1');
    assert.equal(result.provider, 'OpenAI');
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.aborted, false);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].url, '/api/v1/chat/completions');
    assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(seen[0].headers['http-referer'], 'https://domdimabot.com');
    assert.equal(seen[0].headers['x-title'], 'DomDimaBot assistant');
    assert.equal(seen[0].headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(seen[0].body), {
        model: 'openai/gpt-6-luna',
        messages: [{ role: 'system', content: 'You help.' }, { role: 'user', content: 'Hi' }],
        stream: true, reasoning: { effort: 'xhigh' }, usage: { include: true }, session_id: 'sess-1', user: 'sess-1',
        tools: [{ type: 'function', function: { name: 'search_docs', description: 'Search', parameters: { type: 'object', properties: {} } } }],
        parallel_tool_calls: true, tool_choice: 'auto',
    });
});

test('byte-sized pieces with lone CR line endings and split UTF-8 characters', async () => {
    const sse = [data(chunk({ content: 'Hola 👋 ' })), data(chunk({ content: 'señor' })), data(finish()), 'data: [DONE]\n\n'].join('').replace(/\n/g, '\r');
    handler = async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const bytes = Buffer.from(sse);
        for (let i = 0; i < bytes.length; i += 3) res.write(bytes.subarray(i, i + 3));
        res.end();
    };
    const result = await streamChat(request());
    assert.equal(result.content, 'Hola 👋 señor');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.usage, null, 'no usage chunk → null (reconcile later)');
});

test('request options: max_tokens and tool_choice none only when set; no tool fields without tools', async () => {
    handler = stream([data(chunk({ content: 'ok' })), data(finish())]);
    await streamChat(request({ maxOutputTokens: 500, toolChoice: 'none', tools: [{ name: 't', description: 'd', parameters: {} }] }));
    let body = JSON.parse(seen[0].body);
    assert.equal(body.max_tokens, 500);
    assert.equal(body.tool_choice, 'none');
    await streamChat(request({ toolChoice: 'none' }));
    body = JSON.parse(seen[1].body);
    assert.equal('max_tokens' in body, false);
    assert.equal('tools' in body || 'tool_choice' in body || 'parallel_tool_calls' in body, false);
});

test('a tool call without id gets a stable one', async () => {
    handler = stream([data(chunk({ tool_calls: [{ index: 0, function: { name: 'navigate', arguments: '{}' } }] })), data(finish('tool_calls'))]);
    const result = await streamChat(request());
    assert.deepEqual(result.toolCalls, [{ id: 'call_gen-1_0', name: 'navigate', arguments: '{}' }]);
});

test('mid-stream errors become LlmError and are never retried', async () => {
    handler = stream([data(chunk({ content: 'Part' })), data({ id: 'gen-1', error: { code: 502, message: 'Provider returned error' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] })]);
    await assert.rejects(streamChat(request(), {}, fast), (err: unknown) => err instanceof LlmError && err.kind === 'overloaded' && err.status === 502);
    assert.equal(seen.length, 1);

    handler = stream([data(chunk({ content: 'x' })), data({ id: 'gen-1', choices: [{ index: 0, delta: {}, finish_reason: 'error', error: { code: 400, message: "This model's maximum context length is 400000 tokens" } }] })]);
    await assert.rejects(streamChat(request(), {}, fast), (err: unknown) => err instanceof LlmError && err.kind === 'context_too_long');

    handler = stream([data(chunk({ content: 'x' })), data({ id: 'gen-1', choices: [{ index: 0, delta: {}, finish_reason: 'error' }] })]);
    await assert.rejects(streamChat(request(), {}, fast), (err: unknown) => err instanceof LlmError && err.kind === 'upstream');
});

test('abort mid-stream resolves with the partial text, no tool calls and no usage', async () => {
    handler = stream([
        data(chunk({ reasoning_details: [{ type: 'reasoning.summary', summary: 'Thinking', index: 0 }] })),
        data(chunk({ content: 'Partial ' })),
        data(chunk({ tool_calls: [{ index: 0, id: 'call_x', function: { name: 'search_docs', arguments: '{"qu' } }] })),
    ], { hold: true });
    const controller = new AbortController();
    const texts: string[] = [];
    const result = await streamChat(request({ signal: controller.signal }), {
        onText: (delta) => { texts.push(delta); setTimeout(() => controller.abort(), 20); },
    });
    assert.equal(result.aborted, true);
    assert.equal(result.content, 'Partial ');
    assert.deepEqual(result.toolCalls, [], 'half-received tool calls are dropped');
    assert.equal(result.usage, null);
    assert.equal(result.generationId, 'gen-1');
    assert.deepEqual(result.reasoning, [{ type: 'reasoning.summary', summary: 'Thinking', index: 0 }]);
    assert.deepEqual(texts, ['Partial ']);
});

test('abort before the response headers rejects with aborted', async () => {
    handler = async (_req, res) => { await sleep(300); res.end(); };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(streamChat(request({ signal: controller.signal })), (err: unknown) => err instanceof LlmError && err.kind === 'aborted');
    const done = new AbortController();
    done.abort();
    await assert.rejects(streamChat(request({ signal: done.signal })), (err: unknown) => err instanceof LlmError && err.kind === 'aborted');
});

test('retries 503/429/network errors before any data, honoring Retry-After', async () => {
    const answers: Handler[] = [
        jsonError(503, 'busy', { 'retry-after': '0' }),
        (req) => { req.socket.destroy(); }, // network error before headers
        stream([data(chunk({ content: 'ok' })), data(finish())]),
    ];
    handler = (req, res, body) => answers.shift()!(req, res, body);
    const result = await streamChat(request(), {}, fast);
    assert.equal(result.content, 'ok');
    assert.equal(seen.length, 3);

    seen.length = 0;
    handler = jsonError(429, 'slow down', { 'retry-after': '1' });
    const started = Date.now();
    await assert.rejects(streamChat(request(), {}, fast), (err: unknown) => err instanceof LlmError && err.kind === 'rate_limited' && err.retryAfter === 1);
    assert.equal(seen.length, 3, 'one try + two retries');
    assert.ok(Date.now() - started >= 1900, 'Retry-After (1 s) was honored twice');

    seen.length = 0;
    handler = stream([data(chunk({ content: 'Started' }))]); // data then the stream ends without finishing
    await assert.rejects(streamChat(request(), {}, fast), (err: unknown) => err instanceof LlmError && err.kind === 'incomplete');
    assert.equal(seen.length, 1, 'never retried after data started');

    seen.length = 0;
    handler = async (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(data(chunk({ content: 'x' }))); await sleep(20); req.socket.destroy(); };
    await assert.rejects(streamChat(request(), {}, fast), (err: unknown) => err instanceof LlmError && err.kind === 'incomplete');
    assert.equal(seen.length, 1);
});

test('idle timeout after silence; comments keep the stream alive; headers timeout', async () => {
    handler = stream([data(chunk({ content: 'Hi' }))], { hold: true });
    await assert.rejects(streamChat(request(), {}, { idleTimeoutMs: 120 }), (err: unknown) => err instanceof LlmError && err.kind === 'timeout');

    handler = stream([': PROCESSING\n\n', 80, ': PROCESSING\n\n', 80, ': PROCESSING\n\n', 80, data(chunk({ content: 'Late' })), data(finish())]);
    const result = await streamChat(request(), {}, { idleTimeoutMs: 150 });
    assert.equal(result.content, 'Late');

    handler = async (_req, res) => { await sleep(400); res.end(); };
    await assert.rejects(streamChat(request(), {}, { headersTimeoutMs: 100 }), (err: unknown) => err instanceof LlmError && err.kind === 'timeout');
});

test('a step that finished keeps its result when the usage chunk never comes', async () => {
    handler = stream([data(chunk({ content: 'Done' })), data(finish())], { hold: true });
    const result = await streamChat(request(), {}, { idleTimeoutMs: 100 });
    assert.equal(result.content, 'Done');
    assert.equal(result.usage, null);
    assert.equal(result.aborted, false);
});

test('[DONE] without finish_reason is incomplete', async () => {
    handler = stream([data(chunk({ content: 'Half' })), 'data: [DONE]\n\n']);
    await assert.rejects(streamChat(request()), (err: unknown) => err instanceof LlmError && err.kind === 'incomplete');
});

test('HTTP status mapping, sanitized messages, missing key', async () => {
    const cases: [number, string, string][] = [
        [400, 'Invalid tools', 'bad_request'],
        [400, "This model's maximum context length is 400000 tokens", 'context_too_long'],
        [401, 'No auth', 'config'], [402, 'Insufficient credits', 'config'], [403, 'Forbidden', 'config'],
        [408, 'Timeout', 'timeout'], [504, 'Gateway timeout', 'timeout'],
        [429, 'Rate limited', 'rate_limited'], [502, 'Bad gateway', 'overloaded'], [503, 'Unavailable', 'overloaded'],
        [500, 'Internal', 'upstream'], [404, 'No such model', 'upstream'],
    ];
    for (const [status, message, kind] of cases) {
        handler = jsonError(status, `${message} (key ${KEY})`);
        await assert.rejects(streamChat(request(), {}, { retryDelaysMs: [1, 1] }), (err: unknown) => {
            assert.ok(err instanceof LlmError);
            assert.equal(err.kind, kind, `${status} ${message}`);
            assert.equal(err.status, status);
            assert.ok(!err.message.includes(KEY), 'key never in the message');
            return true;
        });
    }
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
        await assert.rejects(streamChat(request()), (err: unknown) => err instanceof LlmError && err.kind === 'config');
        await assert.rejects(reconcileGeneration('gen-1'), (err: unknown) => err instanceof LlmError && err.kind === 'config');
    } finally {
        process.env.OPENROUTER_API_KEY = saved;
    }
});

test('a 200 JSON error body is mapped', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 503, message: 'No providers' } })); };
    await assert.rejects(streamChat(request(), {}, fast), (err: unknown) => err instanceof LlmError && err.kind === 'overloaded');
});

test('reconcileGeneration retries 404 on the schedule and maps the generation', async () => {
    let calls = 0;
    handler = (_req, res) => {
        calls++;
        if (calls <= 2) return jsonError(404, 'Generation gen-9 not found')(_req, res, '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: {
            id: 'gen-9', tokens_prompt: 16, tokens_completion: 319, native_tokens_prompt: 18, native_tokens_completion: 320,
            native_tokens_cached: 4, native_tokens_reasoning: 266, upstream_inference_cost: 0.0001611, total_cost: 0, is_byok: true, cancelled: true,
        } }));
    };
    const started = Date.now();
    const usage = await reconcileGeneration('gen-9', { scheduleMs: [30, 60, 90] });
    assert.deepEqual(usage, {
        promptTokens: 18, cachedTokens: 4, completionTokens: 320, reasoningTokens: 266,
        upstreamCostUsd: 0.0001611, routerCostUsd: 0, source: 'reconciled', isByok: true,
    });
    assert.equal(calls, 3);
    assert.ok(Date.now() - started >= 55, 'third lookup waited for the 60 ms mark');
    assert.equal(seen[0].url, '/api/v1/generation?id=gen-9');
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);

    seen.length = 0;
    handler = jsonError(404, 'not found');
    assert.equal(await reconcileGeneration('gen-x', { scheduleMs: [5, 10] }), null);
    assert.equal(seen.length, 3, 'first lookup + one per schedule entry');

    seen.length = 0;
    handler = jsonError(401, 'bad key');
    assert.equal(await reconcileGeneration('gen-x', { scheduleMs: [5, 10] }), null);
    assert.equal(seen.length, 1, 'auth errors stop at once');
});

test('mergeReasoningDetails keeps types and indexes apart', () => {
    const target: Record<string, unknown>[] = [];
    mergeReasoningDetails(target, [
        { type: 'reasoning.text', text: 'a', signature: 's1', index: 0 },
        { type: 'reasoning.summary', summary: 'x' },
        { type: 'reasoning.text', text: 'b', signature: 's2', index: 0 },
        { type: 'reasoning.text', text: 'other', index: 1 },
        null,
    ]);
    assert.deepEqual(target, [
        { type: 'reasoning.text', text: 'ab', signature: 's1s2', index: 0 },
        { type: 'reasoning.summary', summary: 'x' },
        { type: 'reasoning.text', text: 'other', index: 1 },
    ]);
});
