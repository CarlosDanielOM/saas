// Stage the existing pet-runtime and OAuth provider fixtures alongside this file.
// All paid services, Twitch writes, embeddings and billing stay inside fixtures.
import './pet-providers.mjs';
import { createRequire } from 'node:module';
const { createClient } = createRequire('/app/package.json')('redis');
let client;
async function cache() {
  if (!client) { client = createClient({ url: 'redis://redis:6379' }); await client.connect(); }
  return client;
}
const inherited = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'us.i.posthog.com') return Response.json({ status: 1 });
  const raw = options.body ?? (input instanceof Request ? await input.clone().text() : '{}');
  if (url.hostname === 'openrouter.ai' && url.pathname.endsWith('/chat/completions')) {
    const redis = await cache(), body = JSON.parse(String(raw || '{}'));
    await redis.rPush('desktop:test:llm', JSON.stringify(body));
    const mode = await redis.get('desktop:test:mode');
    if (mode === 'hold') await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 2500);
      const signal = options.signal ?? (input instanceof Request ? input.signal : undefined);
      if (signal?.aborted) { clearTimeout(timer); reject(signal.reason); return; }
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('cancelled', 'AbortError')); }, { once: true });
    });
    if (mode === 'ambiguous') throw new TypeError('fixture connection lost after provider accepted');
    const commands = { action: 'set.title Desktop fixture title', self: 'ban.self 60', protected: 'ban oauth_owner 60' };
    const command = commands[mode];
    const message = mode === 'memory' && !body.messages.some(item => item.role === 'tool')
      ? { role: 'assistant', tool_calls: [{ id: 'desktop-memory', type: 'function', function: {
        name: 'create_memory', arguments: JSON.stringify({ type: 'known_user_fact', content: 'Streamer prefers tea', summary: 'Prefers tea', risk: 'low' }) } }] }
      : command && !body.messages.some(item => item.role === 'tool')
      ? { role: 'assistant', tool_calls: [{ id: 'desktop-action', type: 'function', function: {
        name: 'AST_PARSER', arguments: JSON.stringify({ command, userlevel: 9 }) } }] }
      : { role: 'assistant', content: mode === 'long' ? 'A very long explanation. '.repeat(100) : 'I’m doing well. Ready when you are!' };
    return Response.json({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost_details: {
        upstream_inference_prompt_cost: 0.00001, upstream_inference_completions_cost: 0.00001 } } });
  }
  if (url.hostname === 'api.twitch.tv' && ['POST', 'PATCH', 'DELETE', 'PUT'].includes(options.method)) {
    await (await cache()).rPush('desktop:test:twitch-writes', JSON.stringify({ path: url.pathname,
      method: options.method, body: String(raw || ''), query: Object.fromEntries(url.searchParams) }));
    if (url.pathname === '/helix/chat/messages') return Response.json({ data: [{ is_sent: true, message_id: 'desktop-fixture-message' }] });
    return new Response(null, { status: 204 });
  }
  return inherited(input, options);
};
