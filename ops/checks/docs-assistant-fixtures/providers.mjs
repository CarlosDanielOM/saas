// Isolated providers for the docs assistant check. No production credentials or outbound calls.
// - docs.test serves a small docs export (en + es).
// - minimax.test fakes MiniMax's Anthropic-compatible streaming API; the question picks a scenario.
// Every request is appended to /tmp/saas-fixtures/calls.jsonl for the check to inspect.
import fs from 'node:fs';

const realFetch = globalThis.fetch;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const record = (value) => fs.appendFileSync('/tmp/saas-fixtures/calls.jsonl', `${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const page = (title, description, path, body, lang) => `# ${title}

${description}

Source: https://docs.domdimabot.com/${path}
Language: ${lang}
Documentation index: https://docs.domdimabot.com/llms.txt

${body}`;

const DOCS = {
  '/llms-full.txt': `# DomDimaBot — en

${page('Text to Speech', 'Make the bot read chat aloud.', 'tts/', 'Open **Modules → Text to speech** and turn on **Enable channel TTS**. See [plans](https://docs.domdimabot.com/plans/index.txt).', 'en')}

---

${page('Plans & credits', 'What each plan includes.', 'plans/', 'FIXTURE_EN_PLANS Premium costs $6/month.', 'en')}
`,
  '/es/llms-full.txt': `# DomDimaBot — es

${page('Texto a voz', 'Haz que el bot lea el chat.', 'es/tts/', 'FIXTURE_ES_TTS Abre **Módulos → Texto a voz**.', 'es')}
`,
};

function sse(events, { hold, signal } = {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      // Like a real connection: cancelling the request errors the body.
      signal?.addEventListener('abort', () => { try { controller.error(new DOMException('aborted', 'AbortError')); } catch {} }, { once: true });
      try {
        for (const item of events) {
          if (typeof item === 'number') { await sleep(item); continue; }
          if (signal?.aborted) return;
          controller.enqueue(encoder.encode(`event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`));
        }
        if (hold) {
          await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
          return;
        }
        controller.close();
      } catch {}
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const start = { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'MiniMax-M3.1-Flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } };
const thinking = (text) => [
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } },
  { type: 'content_block_stop', index: 0 },
];
const text = (parts) => [
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  ...parts.map((part) => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: part } })),
  { type: 'content_block_stop', index: 1 },
];
const finish = [
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 800, output_tokens_details: { thinking_tokens: 40 } } },
  { type: 'message_stop' },
];

// Tool scenario: first turn asks for a catalog search and a command test together; after the
// tool results come back, the answer quotes what the tools returned.
function toolTurn(body, signal) {
  const last = body.messages.at(-1);
  if (Array.isArray(last.content) && last.content.some((block) => block.type === 'tool_result')) {
    const results = last.content.filter((block) => block.type === 'tool_result').map((block) => block.content).join(' ');
    const found = /"name":"tts\.skip"/.test(results) ? 'found tts.skip' : 'no tts.skip';
    const tested = /"reply":"Skipped\."/.test(results) && /tts\.skip\(\)/.test(results) ? 'test ok' : 'test missing';
    return sse([start, ...thinking('Both tools answered.'), ...text([`Use \`$(tts.skip) Skipped.\` (${found}, ${tested}).`]), ...finish], { signal });
  }
  return sse([start, ...thinking('Look it up and test it.'),
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_search', name: 'search_ast_functions', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"tts.skip"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_test', name: 'test_command', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"body":"$(tts.skip) Skipped.","runs":[{"user":"Sam","role":"mod"}]}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 1200, output_tokens: 50 } },
    { type: 'message_stop' },
  ], { signal });
}

function shoutoutToolTurn(body, signal) {
  const last = body.messages.at(-1);
  if (Array.isArray(last.content) && last.content.some(block => block.type === 'tool_result')) {
    const result = JSON.parse(last.content.find(block => block.type === 'tool_result').content);
    record({ provider: 'shoutout-tool-result', result });
    return sse([start, ...thinking('Read the modeled outcomes, not live account data.'),
      ...text(['Shoutout guard checked in simulation; Twitch accounts remain unverified.']), ...finish], { signal });
  }
  const command = '*($(twitch.channel &t) ? $(announcement purple "Check out ${$(twitch.channel &t)} at https://twitch.tv/${$(twitch.login &t)} and give them a follow! They were last playing ${$(twitch.game &t)}") : "Please provide a valid user to shoutout. Usage: !so <username>") *($(twitch.channel &t) ? $(shoutout &t) : "") *($(twitch.channel &t) ? $(show.clip &t) : "")';
  return sse([start, ...thinking('Test missing, found, failed and invalid target outcomes.'),
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_shoutout_test', name: 'test_command', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ body: command,
      runs: [{ argument: '' }, { argument: 'FriendlyStreamer' }, { argument: 'missingstreamer', targetLookup: 'not_found' },
        { argument: 'not a login' }, { argument: '$(chat.send injected)' }] }) } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 1200, output_tokens: 50 } },
    { type: 'message_stop' },
  ], { signal });
}

function minimax(body, signal) {
  if (String(body.messages[0].content).includes('TOOLS_SHOUTOUT')) return shoutoutToolTurn(body, signal);
  if (String(body.messages[0].content).includes('TOOLS_SKIP')) return toolTurn(body, signal);
  const question = String(body.messages.at(-1).content);
  if (signal) signal.addEventListener('abort', () => record({ provider: 'minimax', aborted: true, question }), { once: true });
  if (question.includes('FAIL_OVERLOADED')) return json({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 529);
  if (question.includes('HANG')) return sse([start, ...thinking('…')], { hold: true, signal });
  if (question.includes('SLOW')) {
    const ticks = Array.from({ length: 17 }, () => [1000, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '.' } }]).flat();
    return sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }, ...ticks,
      { type: 'content_block_stop', index: 0 }, ...text(['Slow but done.']), ...finish], { signal });
  }
  return sse([start, ...thinking('Looking at the TTS page.'), ...text([
    'Turn on **Enable channel TTS** in **Modules → Text to speech**.\n\n',
    'See [Text to Speech](https://docs.domdimabot.com/tts/index.txt), [Plans](https://docs.domdimabot.com/plans/) ',
    'and [made up](https://docs.domdimabot.com/not-a-page/).',
  ]), ...finish], { signal });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  const raw = init.body ?? (input instanceof Request ? await input.clone().text() : '');
  if (url.hostname === 'docs.test') {
    record({ provider: 'docs', path: url.pathname });
    return DOCS[url.pathname] ? new Response(DOCS[url.pathname], { headers: { 'content-type': 'text/plain' } }) : new Response('missing', { status: 404 });
  }
  if (url.hostname === 'minimax.test') {
    const body = JSON.parse(String(raw || '{}'));
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    record({ provider: 'minimax', path: url.pathname, apiKey: headers.get('x-api-key'), body });
    return minimax(body, init.signal || (input instanceof Request ? input.signal : undefined));
  }
  if (url.hostname === 'embeddings.test') {
    const body = JSON.parse(String(raw || '{}'));
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return json({ data: inputs.map((_, index) => ({ embedding: Array(1024).fill(0.01), index, object: 'embedding' })), model: 'fixture' });
  }
  if (url.hostname === 'qdrant.test') {
    if (url.pathname === '/') return json({ version: '1.18.0' });
    const result = url.pathname.endsWith('/exists') ? { exists: true } : url.pathname.endsWith('/query') ? { points: [] }
      : url.pathname.endsWith('/count') ? { count: 0 } : url.pathname.endsWith('/search') ? [] : { collections: [] };
    return json({ status: 'ok', time: 0, result });
  }
  if (url.hostname === 'api.twitch.tv') return json({ data: [] });
  if (url.hostname === 'id.twitch.tv') return json({ access_token: 'dummy-token', expires_in: 36000, token_type: 'bearer' });
  if (url.hostname === 'us.i.posthog.com') return json({ status: 1 });
  record({ provider: 'blocked', url: url.origin + url.pathname });
  throw new Error(`External request blocked in docs assistant test: ${url.origin}${url.pathname}`);
};
