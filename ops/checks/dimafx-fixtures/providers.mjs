// Loaded only by saas-ops --test-env NODE_OPTIONS, inside the isolated API candidate.
// Mocks every external dependency of the DimaFX queue: Piper TTS HTTP, Qdrant,
// Polar billing, and Twitch. Loopback API traffic passes through untouched.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

if (!fs.existsSync('/tmp/saas-fixtures/sample.wav')) {
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-y', '/tmp/saas-fixtures/sample.wav', '-loglevel', 'error']);
}

const originalFetch = globalThis.fetch;
const logPath = '/tmp/saas-fixtures/provider-calls.jsonl';
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1' && url.port === '3000') return originalFetch(input, options);

  if (url.hostname === 'piper.test') {
    if (url.pathname === '/voices') return json({ 'en_US-ryan-medium': {}, 'es_MX-ald-medium': {} });
    if (url.pathname === '/synthesize') {
      const payload = JSON.parse(options.body || '{}');
      fs.appendFileSync(logPath, JSON.stringify({ synthesis: payload }) + '\n');
      if (!payload.text || !String(payload.text).trim()) return json({ error: 'empty text' }, 400);
      return new Response(fs.readFileSync('/tmp/saas-fixtures/sample.wav'), { headers: { 'Content-Type': 'audio/wav' } });
    }
  }

  if (url.hostname === 'qdrant.test') {
    return json(url.pathname === '/'
      ? { version: '1.18.0' }
      : { status: 'ok', time: 0, result: url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } });
  }

  if (url.hostname === 'api.polar.sh') {
    fs.appendFileSync(logPath, JSON.stringify({ billing: url.pathname }) + '\n');
    return json({ events: [], inserted: 1, duplicates: 0 });
  }

  if (url.hostname === 'id.twitch.tv' || url.hostname === 'api.twitch.tv') {
    // Auth tokens are pre-seeded in Redis; a real Twitch call means the
    // fixture leaked. Fail loudly instead of hitting the network.
    fs.appendFileSync(logPath, JSON.stringify({ twitch: url.toString() }) + '\n');
    return json({}, 401);
  }

  throw new Error(`Unmocked external request blocked: ${url.origin}${url.pathname}`);
};
