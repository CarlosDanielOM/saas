// Records what the reference's product events (`utils/posthog_events.ts`, posthog-node) send to
// PostHog for a fixed sequence of calls, for `tests/product_events_recorded.rs`.
//
//   cd "$DIMABOT_DIR" && TZ=UTC node_modules/.bin/tsx \
//     /path/to/dima-rust/crates/actions/tests/reference/record_product_events.mts \
//     /path/to/dima-rust/crates/actions/tests/fixtures/product_events_recorded.json
//
// `globalThis.fetch` is replaced before the module is loaded: every request posthog-node makes
// is recorded (method, URL, headers, the body inflated when gzip) and answered 200 `{}`, so
// nothing reaches PostHog. The project key in the bodies is the reference's public client key
// (hard-coded in `posthog_events.ts`), not a secret. `shutdownPosthog()` flushes at the end.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const out = process.argv[2];
if (!out) throw new Error('usage: record_product_events.mts <out.json>');
const requests: unknown[] = [];
(globalThis as any).fetch = async (input: any, init: any = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    let body: Buffer = Buffer.alloc(0);
    if (init.body instanceof Uint8Array || Buffer.isBuffer(init.body)) body = Buffer.from(init.body);
    else if (typeof init.body === 'string') body = Buffer.from(init.body);
    else if (init.body instanceof Blob) body = Buffer.from(await init.body.arrayBuffer());
    else if (init.body && typeof init.body.getReader === 'function') {
        const chunks: Buffer[] = [];
        const reader = init.body.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
        body = Buffer.concat(chunks);
    }
    const text = headers['content-encoding'] === 'gzip' ? gunzipSync(body).toString('utf8') : body.toString('utf8');
    requests.push({ method: init.method ?? 'GET', url: String(input?.url ?? input), headers, body: JSON.parse(text) });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

const root = process.cwd();
const imported = async (file: string) => import(pathToFileURL(path.join(root, file)).href);
const events = await imported('src/utils/posthog_events.ts');
const { AI_USAGE_SCHEMA_VERSION, AI_USAGE_PRICING_VERSION } = await imported('src/utils/ai_usage_event.ts');

events.identifyStreamer('1001', 'firstuser');
events.identifyStreamer('1001', 'firstuser'); // same name: not sent again
events.identifyStreamer('1001', 'renamed_user'); // a rename: sent
events.identifyStreamer('', 'nobody'); // no id: nothing
events.trackCommand({ channelID: '1001', channelName: 'firstuser', command: '!hola', status: 'success', userID: '5001', username: 'viewer', arguments: 'mundo 🌍' });
events.trackCommand({ channelID: '1001', channelName: 'firstuser', command: '!roto', status: 'error', userID: '', username: '', errorMessage: 'boom' });
events.trackTts({ channelID: '1001', channelName: 'firstuser', source: 'chat-command', ttsType: 'fish', characters: 12, message: 'hola مرحبا 👋🏽', status: 'success', mode: 'queue', provider: 'fish', userID: '5001', username: 'viewer' });
events.trackTts({ channelID: '1001', channelName: 'firstuser', source: 'ast', ttsType: 'gtts', characters: 0, message: '', status: 'error', userID: '', username: '', errorMessage: 'no voice' });
events.trackAiUsageRecorded({
    context: { schemaVersion: AI_USAGE_SCHEMA_VERSION, pricingVersion: AI_USAGE_PRICING_VERSION, entryId: 'entry-1', requestId: 'request-1',
        parentRequestId: 'parent-1', entryKind: 'usage', category: 'ai_chat', operation: 'chat.reply', source: 'chat', provider: 'openrouter',
        model: 'model-x', channelID: '1001', quantity: 1234, unit: 'tokens', resourceType: 'llm_generation', resourceId: 'gen-1' },
    credits: 2.5, reason: 'ai_chat', polarCostAmount: 3, inputTokens: 1000, outputTokens: 234, totalTokens: 1234
});
events.trackAiUsageRecorded({
    context: { schemaVersion: AI_USAGE_SCHEMA_VERSION, pricingVersion: AI_USAGE_PRICING_VERSION, entryId: 'entry-2', requestId: 'request-2',
        entryKind: 'adjustment', category: 'credit_adjustment', operation: 'grant', source: 'admin', provider: 'internal' },
    credits: -5, reason: 'grant'
});
events.trackAiOperation({ requestId: 'request-1', channelID: '1001', category: 'tts', operation: 'speech', source: 'chat', lifecycle: 'completed',
    requestedProvider: 'fish', actualProvider: 'gtts', fallbackReason: 'quota', errorCode: 'E1', resourceType: 'speech', resourceId: 'sp-1', latencyMs: 812 });
events.trackAiOperation({ requestId: 'request-3', channelID: '1001', category: 'memory', operation: 'embed', source: 'cron', lifecycle: 'queued' });
await events.shutdownPosthog();
writeFileSync(out, JSON.stringify({ requests }, null, 2) + '\n');
console.log(`recorded ${requests.length} requests to ${out}`);
process.exit(0);
