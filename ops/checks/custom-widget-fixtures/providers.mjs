// Test-only provider boundary for custom widget checks: the shared overlay mocks plus a fake
// StreamElements CDN (tiny PNGs) so media copying runs without the internet.
await import('./base-providers.mjs');
// The fake CDN resolves to a public address (DNS isn't available in disposable test networks).
const dns = await import('node:dns');
const lookup = dns.promises.lookup;
dns.promises.lookup = async (host, options) => host === 'cdn.streamelements.com' ? (options?.all ? [{ address: '151.101.2.1', family: 4 }] : { address: '151.101.2.1', family: 4 })
  : host === 'evil.streamelements.com' ? (options?.all ? [{ address: '10.0.0.5', family: 4 }] : { address: '10.0.0.5', family: 4 }) : lookup(host, options);
const inner = globalThis.fetch;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'cdn.streamelements.com') {
    if (url.pathname.endsWith('/missing.png')) return new Response('missing', { status: 404 });
    if (url.pathname.endsWith('/redirect-private.png')) return new Response(null, { status: 302, headers: { location: 'https://evil.streamelements.com/a.png' } });
    if (url.pathname.endsWith('/redirect-away.png')) return new Response(null, { status: 302, headers: { location: 'https://example.com/a.png' } });
    return new Response(options?.method === 'HEAD' ? null : PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } });
  }
  if (url.hostname === 'evil.streamelements.com' || url.hostname === 'example.com') throw new Error('SSRF guard failed: fetched ' + url.href);
  // Fake Twitch hype train status and ad schedule: the check writes helix-<name>.json ({ status, body, delayMs }) and reads helix-calls.jsonl.
  if (url.hostname === 'api.twitch.tv' && (url.pathname === '/helix/hypetrain/status' || url.pathname === '/helix/channels/ads')) {
    const { appendFileSync, readFileSync } = await import('node:fs');
    const name = url.pathname.endsWith('/status') ? 'hypetrain' : 'ads';
    appendFileSync('/tmp/saas-fixtures/helix-calls.jsonl', JSON.stringify({ name, at: Date.now() }) + '\n');
    let reply; try { reply = JSON.parse(readFileSync(`/tmp/saas-fixtures/helix-${name}.json`, 'utf8')); } catch { return new Response('{}', { status: 503 }); }
    if (reply.delayMs) await new Promise(resolve => setTimeout(resolve, reply.delayMs));
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }
  return inner(input, options);
};
