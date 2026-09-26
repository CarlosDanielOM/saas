import { appendFileSync } from 'node:fs';
// Test-only provider boundary for the isolated AST candidate.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return originalFetch(input, options);
  if (url.hostname === 'api.twitch.tv' && url.pathname === '/helix/users') {
    const login = url.searchParams.get('login');
    return new Response(JSON.stringify({ data: login === 'punished' ? [{ id:'990099',login:'punished',display_name:'Punished' }] : [] }), {headers:{'Content-Type':'application/json'}});
  }
  if (url.hostname === 'api.twitch.tv' && url.pathname === '/helix/chat/messages') {
    const body = JSON.parse(options.body);
    if (!body.message.startsWith('ROULETTE_TEST')) throw new Error('Unexpected test chat message');
    appendFileSync('/tmp/saas-fixtures/roulette-messages.jsonl', JSON.stringify(body)+'\n');
    if (body.message.includes('ROULETTE_TEST_FAIL')) return new Response(JSON.stringify({error:'Forbidden',message:'fixture failure',status:403}),{status:403,headers:{'Content-Type':'application/json'}});
    return new Response(JSON.stringify({data:[{message_id:'fixture',is_sent:true}]}), {headers:{'Content-Type':'application/json'}});
  }
  if (url.hostname === 'qdrant.test') return new Response(JSON.stringify(
    url.pathname === '/' ? { version: '1.18.0' } : { status: 'ok', time: 0, result:
      url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } }
  ), { headers: { 'Content-Type': 'application/json' } });
  throw new Error(`External request blocked in AST test: ${url.origin}${url.pathname}`);
};
