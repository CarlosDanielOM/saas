// Provider boundaries only: all changed handlers, Mongo writes and Redis scripts run unchanged.
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { spawn } from 'node:child_process';
const directory = '/tmp/saas-fixtures';
const originalFetch = globalThis.fetch;
const read = (name, fallback) => fs.existsSync(`${directory}/${name}.json`) ? JSON.parse(fs.readFileSync(`${directory}/${name}.json`, 'utf8')) : fallback;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return originalFetch(input, options);
  const mode = read('mode', {});
  if (url.hostname === 'id.twitch.tv' && url.pathname === '/oauth2/token') {
    fs.appendFileSync(`${directory}/tokens.jsonl`, JSON.stringify({ grant: new URLSearchParams(options.body).get('grant_type') }) + '\n');
    if (mode.refreshFailure === 'revoked') return json({ message: 'Invalid refresh token' }, 400);
    if (mode.refreshFailure === 'transient') return json({ message: 'Fixture temporarily unavailable' }, 503);
    return json({ access_token: 'fixture-rotated', refresh_token: 'fixture-rotated-refresh', expires_in: 3600, token_type: 'bearer' });
  }
  if (url.hostname === 'api.twitch.tv') {
    const authorization = new Headers(options.headers).get('authorization');
    fs.appendFileSync(`${directory}/calls.jsonl`, JSON.stringify({ path: url.pathname, query: url.search, method: options.method || 'GET', authorization }) + '\n');
    if (url.pathname === '/helix/channels/editors') {
      if (mode.editors === 'temporary') return json({ error: 'Fixture error', message: 'Editors temporarily unavailable' }, 503);
      if (authorization === 'Bearer fixture-rejected' || mode.editors === 'unauthorized') return json({ error: 'Unauthorized', message: 'Invalid OAuth token' }, 401);
      return json({ data: [{ user_id: '991999', user_name: 'FixtureEditor' }] });
    }
    if (url.pathname === '/helix/streams') return json({ data: mode.live ? [{ id: 'fixture-live', user_id: '991901' }] : [] });
    if (url.pathname === '/helix/users') return json({ data: [{ id: '991901', login: 'pipelinefixture', display_name: 'PipelineFixture' }] });
    if (url.pathname === '/helix/chat/messages') throw new Error('Pipeline recovery must not send chat');
    return json({ data: [], pagination: {}, total: 0 });
  }
  if (url.hostname === 'qdrant.test') return json({ version: '1.18.0', status: 'ok', result: { collections: [] } });
  throw new Error(`External request blocked in recovery fixture: ${url.origin}${url.pathname}`);
};
const modules = new Map([
  ['utils/databases/qdrant.database', 'export const getQdrantConnection=async()=>({});'],
  ['utils/qdrant/start_up.qdrant', 'export const QdrantStartUp=async()=>{};'],
  ['utils/opentelemetry_posthog', 'export default()=>({start:()=>{}});']
]);
globalThis.__pipelineSpawn = (...args) => /\/(domain_events|stream_analytics)\.worker\.js$/.test(String(args[1][0])) ? spawn(...args) : null;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:child_process' && (context.parentURL?.endsWith('/workers/cron.index.js') || context.parentURL?.endsWith('/workers/cron_native_bridge.js'))) {
      const source = `import {EventEmitter} from 'node:events'; export const spawn=(...args)=>{const actual=globalThis.__pipelineSpawn(...args);if(actual)return actual;const child=new EventEmitter();child.pid=0;child.kill=()=>true;return child;};`;
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    const resolved = nextResolve(specifier, context);
    for (const [path, source] of modules) if (resolved.url === `file:///app/dist/${path}.js`) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    return resolved;
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith('/domain_events/domain_event_consumers.js')) return { ...result, source: String(result.source).replace(/\];(?=\s*(?:\/\/#|$))/, "] .filter(definition => ['stream-operations-v1','stream-analytics-v1'].includes(definition.consumer));") };
    return result;
  }
});
