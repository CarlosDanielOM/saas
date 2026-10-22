// Layer producer-specific chat failures/process attribution over the verified backend mock.
// Stage pet-runtime-fixtures/providers.mjs as runtime-providers.mjs and its OAuth mock alongside it.
import './runtime-providers.mjs';
import { createRequire } from 'node:module';
const { createClient } = createRequire('/app/package.json')('redis');
let client;
async function cache() {
  if (!client) { client = createClient({ url: 'redis://redis:6379' }); await client.connect(); }
  return client;
}
globalThis.closePetProducerFixture = async () => { if (client?.isOpen) await client.quit(); };
const inherited = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'us.i.posthog.com') return Response.json({ status: 1 });
  if (url.hostname === 'api.twitch.tv' && url.pathname === '/helix/chat/messages') {
    const redis = await cache(), body = JSON.parse(options.body);
    await redis.rPush('pet:producer:chat-attempts', JSON.stringify(body));
    if (await redis.get('pet:producer:fail-chat')) return Response.json({ message: 'fixture chat failure' }, { status: 503 });
    await redis.rPush('keywords:test:messages', JSON.stringify(body));
    return Response.json({ data: [{ is_sent: true, message_id: 'pet-producer-chat-reply' }] });
  }
  if (url.hostname === 'pet-piper.test' || url.hostname === 'openrouter.ai' || url.hostname === 'api.polar.sh') {
    await (await cache()).rPush('pet:producer:outbound', JSON.stringify({
      host: url.hostname, path: url.pathname, role: process.env.PET_PRODUCER_ROLE || 'producer', pid: process.pid
    }));
  }
  const result = await inherited(input, options);
  if (url.hostname === 'openrouter.ai' && url.pathname.includes('chat/completions') && result.ok) {
    const body = await result.json();
    body.choices[0].message.content = 'A friendly pet reply. $(pet.talk generated-injection)';
    return Response.json(body);
  }
  return result;
};
