// Stage oauth-beta-fixtures/providers.mjs alongside this file as oauth-providers.mjs.
import './oauth-providers.mjs';
import { createRequire } from 'node:module';
const { createClient } = createRequire('/app/package.json')('redis');
let client;
async function redis() { if (!client) { client = createClient({ url: 'redis://redis:6379' }); await client.connect(); } return client; }
const inherited = globalThis.fetch;
function wav() {
  const buffer = Buffer.alloc(44 + 16000); // 500ms, mono PCM16 16kHz.
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(16000, 40); return buffer;
}
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  // Exercise the real chat/memory retrieval code without an external embedding or vector service.
  if (url.hostname === 'lfm2.5-embeddings' || url.hostname === 'pet-embeddings.test') {
    return Response.json({ data: [{ index: 0, object: 'embedding', embedding: [1, 0, 0] }], model: 'lfm2.5-embedding-350m' });
  }
  if (url.hostname === 'qdrant.test' && /\/points\/(query|search)$/.test(url.pathname)) {
    const cache = await redis();
    const body = JSON.parse(String(options?.body ?? (input instanceof Request ? await input.clone().text() : '{}')));
    await cache.rPush('pet:test:context-queries', JSON.stringify({ path: url.pathname, body }));
    const key = url.pathname.includes('twitch_channel_memories') ? 'pet:test:memory-points' : 'pet:test:chat-points';
    const points = JSON.parse(await cache.get(key) || '[]');
    return Response.json({ status: 'ok', time: 0, result: url.pathname.endsWith('/query') ? { points } : points });
  }
  if (url.hostname === 'api.polar.sh' && url.pathname.replace(/\/$/, '') === '/v1/events/ingest') {
    const raw = options?.body ?? (input instanceof Request ? await input.clone().text() : '{}');
    const { events = [] } = JSON.parse(String(raw));
    const cache = await redis();
    for (const event of events) await cache.rPush('pet:test:billing-events', JSON.stringify(event));
    return Response.json({ inserted: events.length, duplicates: 0 });
  }
  if (url.hostname !== 'pet-piper.test' && url.hostname !== 'openrouter.ai') return inherited(input, options);
  const cache = await redis();
  const body = JSON.parse(options.body);
  const kind = url.pathname.includes('chat/completions') ? 'llm' : 'tts';
  await cache.rPush('pet:test:provider-calls', JSON.stringify({ kind, body }));
  const mode = await cache.get('pet:test:provider-mode');
  options.signal?.throwIfAborted();
  if (mode === 'hold') await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 3000);
    options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('cancelled', 'AbortError')); }, { once: true });
  });
  if (mode === 'ambiguous') throw new TypeError('mock connection reset after provider accepted');
  if (kind === 'llm' && mode === 'moderation-denied' && !body.messages.some(message => message.role === 'tool')) {
    return Response.json({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'fixture-denied-action', type: 'function',
      function: { name: 'AST_PARSER', arguments: JSON.stringify({ command: 'ban protected_fixture_user 600', userlevel: 9 }) } }] } }],
      usage: { total_tokens: 20, prompt_tokens: 10, completion_tokens: 10, cost_details: { upstream_inference_prompt_cost: 0.00001, upstream_inference_completions_cost: 0.00001 } } });
  }
  if (kind === 'llm') return Response.json({ choices: [{ message: { role: 'assistant', content: 'Kappa [happy] example.com $(counter must-not-evaluate)',
    ...(body.tools?.length ? {} : { tool_calls: [{ function: { name: 'ast_parser', arguments: '{"command":"must-not-run"}' } }] }) } }],
    usage: { total_tokens: 20, prompt_tokens: 10, completion_tokens: 10, cost_details: { upstream_inference_prompt_cost: 0.00001, upstream_inference_completions_cost: 0.00001 } } });
  if (mode === 'oversize') return new Response(Buffer.alloc(8_000_001), { headers: { 'Content-Type': 'audio/wav' } });
  if (url.hostname === 'openrouter.ai') return new Response('mock paid provider failure', { status: 503 });
  return new Response(wav(), { headers: { 'Content-Type': 'audio/wav' } });
};
