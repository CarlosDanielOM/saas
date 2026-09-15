// Loaded only by saas-ops --test-env NODE_OPTIONS, inside the isolated API candidate.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
if (!fs.existsSync('/tmp/saas-fixtures/sample.mp3')) execFileSync('ffmpeg', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-codec:a', 'libmp3lame', '-y', '/tmp/saas-fixtures/sample.mp3', '-loglevel', 'error']);
import { createRequire } from 'node:module';
const require = createRequire('/app/package.json');
const { decode } = require('@msgpack/msgpack');
const originalFetch = globalThis.fetch;
const logPath = '/tmp/saas-fixtures/provider-calls.jsonl';
const statePath = '/tmp/saas-fixtures/state.json';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const voice = (id, title, licensed = false, tags = ['female'], languages = ['en']) => ({
  _id: id, title, licensed, tags, languages, type: 'tts', visibility: 'public', state: 'trained'
});
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  if (url.hostname === '127.0.0.1' && url.port === '3000') return originalFetch(input, options);
  if (url.hostname === 'qdrant.test') {
    return json(url.pathname === '/' ? { version: '1.18.0' } : { status: 'ok', time: 0, result: url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } });
  }
  if (url.hostname === 'api.fish.audio') {
    fs.appendFileSync(logPath, JSON.stringify({ url: url.toString(), method: options.method || 'GET' }) + '\n');
    if (url.pathname === '/model') {
      if (url.searchParams.get('title') === 'outage') return json({}, 503);
      return json({ total: 40, has_more: url.searchParams.get('page_number') !== '2', items: [
        voice('a'.repeat(32), 'Alice', true), voice('b'.repeat(32), 'Bea', false),
        voice('c'.repeat(32), 'Carlos', false, ['male'], ['es']),
        { ...voice('d'.repeat(32), 'Removed'), dmca_taken_down: true },
        { ...voice('e'.repeat(32), 'Private'), visibility: 'private' },
        { ...voice('f'.repeat(32), 'Unknown license'), licensed: undefined }
      ] });
    }
    if (url.pathname.startsWith('/model/')) {
      const id = url.pathname.split('/').at(-1);
      return id === '0'.repeat(32) ? json({}, 404) : json(voice(id, 'Test voice'));
    }
    if (url.pathname === '/v1/tts') {
      const payload = decode(options.body);
      const headers = options.headers || {};
      const model = typeof headers.get === 'function' ? headers.get('model') : (headers.model ?? headers.Model);
      fs.appendFileSync(logPath, JSON.stringify({ synthesis: payload, model }) + '\n');
      if (state.slow) await new Promise(resolve => setTimeout(resolve, 300));
      if (state.fail) return json({ message: 'Unavailable voice' }, 422);
      return new Response(fs.readFileSync('/tmp/saas-fixtures/sample.mp3'), { headers: { 'Content-Type': 'audio/mpeg' } });
    }
  }
  if (url.hostname === 'api.polar.sh') {
    fs.appendFileSync(logPath, JSON.stringify({ billing: url.pathname }) + '\n');
    return json({ events: [], inserted: 1, duplicates: 0 });
  }
  throw new Error(`Unmocked external request blocked: ${url.origin}${url.pathname}`);
};
const { fishTtsService } = await import('/app/dist/server/services/tts/fish_tts.service.js');
const synthesize = fishTtsService.synthesize.bind(fishTtsService);
fishTtsService.synthesize = async request => {
  const result = await synthesize(request);
  if (result.error) console.log('Fixture synthesis error:', result.message);
  return result;
};
