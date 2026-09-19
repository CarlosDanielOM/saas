import fs from 'node:fs';

const callsPath = '/tmp/saas-fixtures/polar-calls.jsonl';
const realFetch = globalThis.fetch;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);

  if (url.hostname === 'api.polar.sh' && url.pathname.replace(/\/$/, '') === '/v1/events/ingest') {
    const rawBody = init.body ?? (request ? await request.clone().text() : '{}');
    const body = JSON.parse(String(rawBody || '{}'));
    fs.appendFileSync(callsPath, `${JSON.stringify(body)}\n`);
    return json({ inserted: Array.isArray(body.events) ? body.events.length : 0, duplicates: 0 });
  }
  if (url.hostname === 'us.i.posthog.com') return json({ status: 1 });
  if (url.hostname === 'qdrant.test') return json({ result: { collections: [] }, status: 'ok', time: 0 });
  if (url.hostname === '127.0.0.1') return realFetch(input, init);

  throw new Error(`External request blocked in free credit reset test: ${url.origin}${url.pathname}`);
};
