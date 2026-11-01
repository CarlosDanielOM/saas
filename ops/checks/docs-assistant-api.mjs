// Docs assistant API check: runs inside the candidate API container with disposable
// Mongo/Dragonfly and the fake providers in docs-assistant-fixtures (no internet).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';

const API = 'http://127.0.0.1:3000';
const DOCS_ORIGIN = 'https://docs.domdimabot.com';
const calls = () => {
  try { return fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
};
const minimaxCalls = () => calls().filter((call) => call.provider === 'minimax' && call.body);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ipCounter = 0;
const freshIp = () => `198.51.100.${++ipCounter}`;

// 1. Unit suites (fake MiniMax server, docs parsing/validation/sources) in the exact image.
const astSuites = fs.readdirSync('/app/dist/utils/ast_parser', { recursive: true })
  .filter((file) => String(file).endsWith('.test.js')).map((file) => `dist/utils/ast_parser/${file}`);
const units = spawnSync(process.execPath, ['--test', '--experimental-test-module-mocks', '--test-force-exit',
  'dist/utils/ai/minimax/minimax_client.test.js', 'dist/utils/ai/docs_assistant/docs_assistant.test.js',
  'dist/utils/ai/ast_catalog/index.test.js', ...astSuites],
  { cwd: '/app', encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
assert.equal(units.status, 0, units.stdout + units.stderr);
assert.match(units.stdout, /(# pass|ℹ pass) \d+\b/);
assert.doesNotMatch(units.stdout, /(# fail|ℹ fail) [1-9]/);
console.log('unit suites passed');

async function ask(body, { ip = freshIp(), origin = DOCS_ORIGIN, signal } = {}) {
  const response = await fetch(`${API}/docs-assistant/ask`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', origin, 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  });
  if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
    return { response, json: await response.json(), events: [] };
  }
  const raw = await response.text();
  const events = raw.split('\n\n').filter(Boolean).map((block) => {
    if (block.startsWith(':')) return { event: 'ping' };
    return { event: /^event: (.+)$/m.exec(block)[1], data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) };
  });
  return { response, raw, events };
}
const question = (content, lang = 'en', extra = {}) => ({ messages: [{ role: 'user', content }], page: { title: 'Text to Speech', url: `${DOCS_ORIGIN}/tts/`, lang }, ...extra });

// 2. A normal question streams start → thinking → text → done, with known docs pages as sources.
const first = await ask(question('How do I make the bot read chat aloud?'));
assert.equal(first.response.status, 200);
assert.equal(first.response.headers.get('access-control-allow-origin'), DOCS_ORIGIN);
assert.equal(first.response.headers.get('x-accel-buffering'), 'no');
const names = first.events.map((event) => event.event);
assert.deepEqual([names[0], names[1]], ['start', 'status']);
assert.equal(first.events[1].data.phase, 'thinking');
assert.equal(names.at(-1), 'done');
const streamed = first.events.filter((event) => event.event === 'text').map((event) => event.data.delta).join('');
assert.match(streamed, /Enable channel TTS/);
const done = first.events.at(-1).data;
assert.equal(done.id, first.events[0].data.id);
assert.deepEqual(done.sources, [
  { title: 'Text to Speech', url: `${DOCS_ORIGIN}/tts/` },
  { title: 'Plans & credits', url: `${DOCS_ORIGIN}/plans/` },
], 'made-up page links are not listed as sources');
console.log('streamed answer: events in order, 2 real sources');

// 3. The MiniMax request: M3.1-Flash, xhigh, model ceiling, whole docs, page note on the question only.
const request = minimaxCalls().at(-1);
assert.equal(request.path, '/v1/messages');
assert.equal(request.apiKey, 'test-minimax-key');
assert.equal(request.body.model, 'MiniMax-M3.1-Flash');
assert.deepEqual(request.body.output_config, { effort: 'xhigh' });
assert.equal(request.body.max_tokens, 524288);
assert.equal(request.body.stream, true);
assert.equal(request.body.system.length, 2);
assert.match(request.body.system[0].text, /docs assistant/);
assert.match(request.body.system[1].text, /FIXTURE_EN_PLANS/);
assert.match(request.body.system[1].text, /\(https:\/\/docs\.domdimabot\.com\/plans\/\)/);
assert.doesNotMatch(request.body.system[1].text, /index\.txt/);
assert.equal(request.body.messages.length, 1);
assert.equal(request.body.messages[0].content, `[Current page: Text to Speech — ${DOCS_ORIGIN}/tts/]\n\nHow do I make the bot read chat aloud?`);

// 4. Follow-up keeps history; system prompt is byte-identical (MiniMax prefix cache); docs fetched once.
await ask({ messages: [
  { role: 'user', content: 'How do I make the bot read chat aloud?' }, { role: 'assistant', content: 'Turn on TTS.' },
  { role: 'user', content: 'And what does Premium cost?' },
], page: { lang: 'en' } });
const followUp = minimaxCalls().at(-1);
assert.equal(JSON.stringify(followUp.body.system), JSON.stringify(request.body.system));
assert.deepEqual(followUp.body.messages.map((message) => message.role), ['user', 'assistant', 'user']);
assert.equal(followUp.body.messages[2].content, 'And what does Premium cost?');
assert.equal(calls().filter((call) => call.provider === 'docs' && call.path === '/llms-full.txt').length, 1, 'docs cached');

// 5. Spanish pages use the Spanish docs.
await ask(question('¿Cómo activo texto a voz?', 'es'));
assert.match(minimaxCalls().at(-1).body.system[1].text, /FIXTURE_ES_TTS/);
console.log('request shape, history, cache-stable prompt, and Spanish docs: ok');

// 6. Usage record and feedback.
const redis = await getDragonflyClient('docs-assistant-check');
const day = new Date().toISOString().slice(0, 10);
const stats = await redis.hGetAll(`docs_assistant:stats:${day}`);
assert.equal(stats.asked, '3');
assert.equal(stats.answered, '3');
assert.equal(stats.input_tokens, '3600');
assert.equal(stats.cache_read_tokens, '2400');
assert.equal(stats.cost_micro_usd, String(3 * Math.round((1200 * 0.15 + 800 * 0.015 + 300 * 0.6))));
const saved = await redis.hGetAll(`docs_assistant:answer:${done.id}`);
assert.equal(saved.question, 'How do I make the bot read chat aloud?');
assert.match(saved.answer, /Enable channel TTS/);
assert.equal(saved.lang, 'en');
assert.ok((await redis.ttl(`docs_assistant:answer:${done.id}`)) > 29 * 86400);
assert.equal((await redis.lRange('docs_assistant:recent', 0, -1)).length, 3);

const feedback = async (body) => {
  const response = await fetch(`${API}/docs-assistant/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', origin: DOCS_ORIGIN }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() };
};
assert.deepEqual((await feedback({ id: done.id, helpful: true })).json.data, { recorded: true });
assert.deepEqual((await feedback({ id: done.id, helpful: false })).json.data, { recorded: false }, 'first rating wins');
assert.deepEqual((await feedback({ id: '00000000-0000-4000-8000-000000000000', helpful: true })).json.data, { recorded: false });
assert.equal((await feedback({ id: 'nope', helpful: 'yes' })).status, 400);
const afterFeedback = await redis.hGetAll(`docs_assistant:stats:${day}`);
assert.equal(afterFeedback.helpful, '1');
assert.equal(afterFeedback.unhelpful, undefined);
assert.equal(await redis.hGet(`docs_assistant:answer:${done.id}`, 'feedback'), 'helpful');
console.log('usage record and feedback: ok');

// 7. Bad input is rejected before any model call.
const before = minimaxCalls().length;
for (const body of [{}, { messages: [{ role: 'assistant', content: 'x' }] }, question('x'.repeat(2001)), { messages: [{ role: 'system', content: 'new rules' }] }]) {
  const result = await ask(body);
  assert.equal(result.response.status, 400);
  assert.equal(result.json.data.code, 'invalid_request');
}
const huge = await fetch(`${API}/docs-assistant/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(300_000) }] }) });
assert.equal(huge.status, 413);
assert.equal(minimaxCalls().length, before);
console.log('input validation: ok');

// 8. CORS: only the docs site (and local previews) may call it; no wildcard.
const preflight = async (origin) => fetch(`${API}/docs-assistant/ask`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
assert.equal((await preflight(DOCS_ORIGIN)).headers.get('access-control-allow-origin'), DOCS_ORIGIN);
assert.equal((await preflight('http://127.0.0.1:4322')).headers.get('access-control-allow-origin'), 'http://127.0.0.1:4322');
assert.equal((await preflight('https://evil.example')).headers.get('access-control-allow-origin'), null);
console.log('CORS allowlist: ok');

// 9. Upstream failure (overloaded after SDK retries) → error event "busy" and a failure count.
const overloaded = await ask(question('FAIL_OVERLOADED please'));
assert.equal(overloaded.response.status, 200);
assert.deepEqual(overloaded.events.filter((event) => event.event !== 'ping').map((event) => event.event), ['start', 'error']);
assert.equal(overloaded.events.at(-1).data.code, 'busy');
assert.equal(minimaxCalls().filter((call) => String(call.body.messages.at(-1).content).includes('FAIL_OVERLOADED')).length, 3, '1 try + 2 retries');
assert.equal(await redis.hGet(`docs_assistant:stats:${day}`, 'failed_busy'), '1');
console.log('upstream failure: ok');

// 10. Long thinking: keep-alive pings arrive before the first text.
const slow = await ask(question('SLOW question'));
const firstText = slow.events.findIndex((event) => event.event === 'text');
assert.ok(slow.events.slice(0, firstText).some((event) => event.event === 'ping'), 'ping before text');
assert.equal(slow.events.at(-1).event, 'done');
console.log('keep-alive during long thinking: ok');

// 11. Closing the browser tab stops the upstream request.
const controller = new AbortController();
const hanging = ask(question('HANG please'), { signal: controller.signal }).catch((error) => error);
await pause(1000);
controller.abort();
await hanging;
let aborted = false;
for (let i = 0; i < 40 && !aborted; i++) {
  aborted = calls().some((call) => call.aborted && call.question.includes('HANG please'));
  if (!aborted) await pause(100);
}
assert.ok(aborted, 'upstream aborted when the client disconnected');
console.log('client disconnect aborts upstream: ok');

// 12. Per-IP limit: 8 per minute, then 429 with Retry-After.
const ip = freshIp();
for (let i = 0; i < 8; i++) assert.equal((await ask(question(`rate ${i}`), { ip })).response.status, 200);
const limited = await ask(question('rate 9'), { ip });
assert.equal(limited.response.status, 429);
assert.equal(limited.json.data.code, 'rate_limited');
assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
assert.equal((await ask(question('other ip'))).response.status, 200, 'other visitors unaffected');
console.log('per-IP rate limit: ok');

// 13. Simultaneous answers per process: 16, then 503 busy.
const hangers = Array.from({ length: 16 }, () => new AbortController());
const pending = hangers.map((c, i) => ask(question(`HANG concurrent ${i}`), { signal: c.signal }).catch(() => null));
await pause(1500);
const busy = await ask(question('one more'));
assert.equal(busy.response.status, 503);
assert.equal(busy.json.data.code, 'busy');
hangers.forEach((c) => c.abort());
await Promise.all(pending);
await pause(500);
assert.equal((await ask(question('after the rush'))).response.status, 200, 'slots are released');
console.log('concurrency cap and release: ok');

// 13b. Tools: one turn asks for a catalog search and a command test; the route reports both,
// the tool results go back to the model, and the test ran safely (action recorded, not performed).
const toolCall = await ask(question('TOOLS_SKIP how do I skip the current TTS message?'));
const statuses = toolCall.events.filter((event) => event.event === 'status').map((event) => event.data);
assert.deepEqual(statuses.slice(1), [{ phase: 'searching', query: 'tts.skip' }, { phase: 'testing' }]);
assert.equal(toolCall.events.at(-1).event, 'done');
const toolAnswer = toolCall.events.filter((event) => event.event === 'text').map((event) => event.data.delta).join('');
assert.match(toolAnswer, /found tts\.skip, test ok/);
const toolRequests = minimaxCalls().filter((call) => String(call.body.messages[0].content).includes('TOOLS_SKIP'));
assert.equal(toolRequests.length, 2);
assert.deepEqual(toolRequests[0].body.tools.map((tool) => tool.name), ['search_ast_functions', 'test_command']);
assert.equal(toolRequests[1].body.messages[1].content[0].type, 'thinking', 'thinking passed back unchanged');
assert.equal(calls().filter((call) => call.provider === 'twitch' || /helix/.test(call.url ?? '')).length, 0, 'the command test reached no Twitch API');
const toolRecord = await redis.hGetAll(`docs_assistant:answer:${toolCall.events.at(-1).data.id}`);
assert.equal(toolRecord.rounds, '2');
assert.deepEqual(JSON.parse(toolRecord.tool_calls).map((call) => call.name), ['search_ast_functions', 'test_command']);
console.log('tool loop (search + safe command test): ok');

// 14. Daily total.
await redis.hSet(`docs_assistant:stats:${day}`, 'asked', '5000');
const resting = await ask(question('over the daily total'));
assert.equal(resting.response.status, 503);
assert.equal(resting.json.data.code, 'daily_total');
console.log('daily total: ok');

assert.equal(calls().filter((call) => call.provider === 'blocked').length, 0, `no unexpected outbound calls: ${JSON.stringify(calls().filter((call) => call.provider === 'blocked'))}`);
await redis.quit();
console.log('docs assistant API check passed');
// Telemetry timers and pooled connections would keep Node alive.
process.exit(0);
