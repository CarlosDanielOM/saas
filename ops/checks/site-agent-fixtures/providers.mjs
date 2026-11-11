// Isolated providers for site agent checks. No production credentials, no outbound calls.
// Loaded into every Node process of the candidate with NODE_OPTIONS=--import (see test-env.json):
// - openrouter.test  fake OpenRouter: streamed chat completions picked by markers in the user's
//                    message ([[script:name]], [[call:tool {json}]] …) and GET /generation.
// - api.polar.sh     fake event ingest (dedupes external ids like Polar).
// - docs.test        a small docs export (en + es); embeddings/qdrant/Twitch/PostHog stubs.
// Everything else is blocked. Each request is appended to /tmp/saas-fixtures/calls.jsonl without
// auth headers (`authOk` says whether the expected test key was sent). See README.md.
//
// Local use: `node providers.mjs serve [port]` serves the same fake OpenRouter on 127.0.0.1
// (default 18787) at /api/v1, for a dev process with OPENROUTER_BASE_URL=http://127.0.0.1:<port>/api/v1.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = process.env.SITE_AGENT_FIXTURE_DIR || '/tmp/saas-fixtures';
const CALLS = path.join(DIR, 'calls.jsonl');
const GENERATIONS = path.join(DIR, 'generations');
const CONTROL = path.join(DIR, 'control.json');
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

function record(value) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(CALLS, `${JSON.stringify({ at: Date.now(), ...value })}\n`);
  } catch {}
}

/** Optional switches a check can write at run time: {"polar": "fail"}. */
function control() {
  try { return JSON.parse(fs.readFileSync(CONTROL, 'utf8')); } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Fake OpenRouter
// ---------------------------------------------------------------------------

let sequence = 0;
const flaky = new Set();
const newGenerationId = () => `gen-fx-${Date.now()}-${process.pid}-${++sequence}`;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return '';
}

/** Markers from one user message. */
function parseMarkers(text) {
  const out = { script: null, calls: [], delay: null, chunks: null, wait: 0, gen404: 2, nocost: false, crlf: false, compaction: null };
  for (const match of text.matchAll(/\[\[script:([a-z0-9_]+)\]\]/g)) out.script = match[1];
  for (const match of text.matchAll(/\[\[compaction:([a-z0-9_]+)\]\]/g)) out.compaction = match[1];
  for (const match of text.matchAll(/\[\[call(?:@(\d+))?:([A-Za-z0-9_]+)\s*(\{[\s\S]*?\})?\]\]/g)) {
    let args = {};
    try { args = match[3] ? JSON.parse(match[3]) : {}; } catch { args = { _raw: match[3] }; }
    out.calls.push({ step: Number(match[1] ?? 0), name: match[2], args });
  }
  const number = (name) => { const m = new RegExp(`\\[\\[${name}:(\\d+|never)\\]\\]`).exec(text); return m ? (m[1] === 'never' ? -1 : Number(m[1])) : null; };
  out.delay = number('delay');
  out.chunks = number('chunks');
  out.wait = number('wait') ?? 0;
  out.gen404 = number('gen404') ?? 2;
  out.nocost = text.includes('[[nocost]]');
  out.crlf = text.includes('[[crlf]]');
  return out;
}

/**
 * The script comes from the newest user message that has a marker, so a plain steer message keeps
 * the running script. `step` = assistant messages after that message (0 on the first model call).
 */
function analyze(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && textOf(messages[i].content).includes('[[')) { at = i; break; }
  }
  const markers = parseMarkers(at >= 0 ? textOf(messages[at].content) : '');
  const after = at >= 0 ? messages.slice(at + 1) : messages;
  const assistants = after.filter((m) => m.role === 'assistant');
  const toolResults = after.filter((m) => m.role === 'tool');
  // Reasoning continuity: every assistant tool-call message must carry the merged encrypted item back.
  const withCalls = messages.filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length);
  const reasoningEchoed = withCalls.every((m) => Array.isArray(m.reasoning_details) && m.reasoning_details.some((d) =>
    d?.type === 'reasoning.encrypted' && typeof d.id === 'string' && d.id.startsWith('rs_fx_') && d.data === encryptedData(d.id)));
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  return {
    markers, step: assistants.length, toolResults, reasoningEchoed, withCalls: withCalls.length,
    lastUser: textOf(lastUser?.content).slice(0, 500),
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
    toolNames: (body.tools ?? []).map((t) => t?.function?.name).filter(Boolean),
    forced: body.tool_choice === 'none',
  };
}

const encryptedData = (id) => `fx-encrypted-${id}-0123456789abcdef`;

/** Deterministic usage close to the real shape (BYOK: cost 0, upstream cost in cost_details). */
function usageFor(body, info, completionChars, { nocost = false } = {}) {
  const promptTokens = Math.max(1, Math.ceil((JSON.stringify(body.messages ?? []).length + JSON.stringify(body.tools ?? []).length) / 4));
  const cachedTokens = info.step > 0 ? Math.floor(promptTokens * 0.8) : 0;
  const reasoningTokens = 24;
  const completionTokens = Math.ceil(completionChars / 4) + reasoningTokens;
  const promptCost = ((promptTokens - cachedTokens) * 0.10 + cachedTokens * 0.01) / 1e6;
  const completionCost = completionTokens * 0.50 / 1e6;
  const usage = {
    prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost: 0, is_byok: true,
    prompt_tokens_details: { cached_tokens: cachedTokens, cache_write_tokens: 0, audio_tokens: 0, video_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: reasoningTokens, image_tokens: 0, audio_tokens: 0 },
  };
  if (!nocost) {
    usage.cost_details = {
      upstream_inference_cost: Math.round((promptCost + completionCost) * 1e10) / 1e10,
      upstream_inference_prompt_cost: Math.round(promptCost * 1e10) / 1e10,
      upstream_inference_completions_cost: Math.round(completionCost * 1e10) / 1e10,
    };
  }
  return usage;
}

function saveGeneration(id, data) {
  try {
    fs.mkdirSync(GENERATIONS, { recursive: true });
    fs.writeFileSync(path.join(GENERATIONS, `${id}.json`), JSON.stringify(data));
  } catch {}
}

function readGeneration(id) {
  if (!/^gen-[A-Za-z0-9-]+$/.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(GENERATIONS, `${id}.json`), 'utf8')); } catch { return null; }
}

function generationData(id, usage, { cancelled, finishReason }) {
  return {
    id, model: 'openai/gpt-6-luna', provider_name: 'OpenAI', streamed: true, cancelled, finish_reason: finishReason,
    tokens_prompt: usage.prompt_tokens, tokens_completion: usage.completion_tokens,
    native_tokens_prompt: usage.prompt_tokens, native_tokens_completion: usage.completion_tokens,
    native_tokens_cached: usage.prompt_tokens_details.cached_tokens, native_tokens_reasoning: usage.completion_tokens_details.reasoning_tokens,
    upstream_inference_cost: usage.cost_details?.upstream_inference_cost ?? null, total_cost: 0, is_byok: true,
  };
}

/** Builds the stream items of one reply. Items: object = data chunk, string = raw text, number = pause (ms). */
class Reply {
  constructor(id, info) {
    this.id = id;
    this.info = info;
    this.items = [];
    this.chars = 0;
  }
  chunk(delta, finishReason = null) {
    this.items.push({ id: this.id, provider: 'OpenAI', model: 'openai/gpt-6-luna', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, delta, finish_reason: finishReason, native_finish_reason: finishReason }] });
  }
  comment(text = 'OPENROUTER PROCESSING') { this.items.push(`: ${text}\n\n`); }
  pause(ms) { if (ms > 0) this.items.push(ms); }
  reasoning(summary = 'Thinking about the request.') {
    const half = Math.ceil(summary.length / 2);
    this.chunk({ role: 'assistant', content: '', reasoning: summary.slice(0, half), reasoning_details: [{ type: 'reasoning.summary', summary: summary.slice(0, half), format: 'openai-responses-v1', index: 0 }] });
    this.chunk({ content: '', reasoning: summary.slice(half), reasoning_details: [{ type: 'reasoning.summary', summary: summary.slice(half), format: 'openai-responses-v1', index: 0 }] });
    const id = `rs_fx_${this.id.replace(/[^A-Za-z0-9]/g, '')}`;
    const data = encryptedData(id);
    this.chunk({ content: '', reasoning_details: [{ type: 'reasoning.encrypted', data: data.slice(0, 20), id, format: 'openai-responses-v1', index: 1 }] });
    this.chunk({ content: '', reasoning_details: [{ type: 'reasoning.encrypted', data: data.slice(20), index: 1 }] });
  }
  text(text, pieces = 8, delayMs = 0) {
    const size = Math.max(1, Math.ceil(text.length / pieces));
    for (let i = 0; i < text.length; i += size) {
      this.pause(delayMs);
      this.chunk({ content: text.slice(i, i + size) });
      this.chars += Math.min(size, text.length - i);
    }
  }
  /** Several calls, interleaved, with id/name/arguments split across chunks. */
  toolCalls(calls, delayMs = 0) {
    const parts = calls.map((call, index) => {
      const args = JSON.stringify(call.args ?? {});
      this.chars += args.length + call.name.length;
      const cut = Math.max(1, Math.floor(call.name.length / 2));
      const id = `call_fx_${sequence}_${index}`;
      const pieces = [
        { index, id: id.slice(0, 8), type: 'function', function: { name: call.name.slice(0, cut), arguments: '' } },
        { index, id: id.slice(8), function: { name: call.name.slice(cut) } },
      ];
      for (let i = 0; i < args.length; i += 7) pieces.push({ index, function: { arguments: args.slice(i, i + 7) } });
      return pieces;
    });
    for (let round = 0; parts.some((list) => list.length > round); round++) {
      for (const list of parts) {
        if (list[round]) { this.pause(delayMs); this.chunk({ tool_calls: [list[round]] }); }
      }
    }
  }
  finish(reason, body, opts = {}) {
    this.chunk({}, reason);
    const usage = usageFor(body, this.info, this.chars, opts);
    this.usage = usage;
    if (!opts.noUsage) this.items.push({ id: this.id, provider: 'OpenAI', model: 'openai/gpt-6-luna', object: 'chat.completion.chunk', choices: [], usage });
    this.items.push('data: [DONE]\n\n');
  }
}

function sseResponse(reply, { signal, crlf, hold, onAbort, onDone }) {
  const encoder = new TextEncoder();
  let sent = 0;
  let finished = false;
  return new Response(new ReadableStream({
    cancel() {
      // The client dropped the body without aborting the request.
      if (!finished) { finished = true; onAbort?.(sent); }
    },
    async start(controller) {
      const abort = () => {
        if (finished) return;
        finished = true;
        onAbort?.(sent);
        try { controller.error(new DOMException('aborted', 'AbortError')); } catch {}
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        for (const item of reply.items) {
          if (finished) return;
          if (typeof item === 'number') { await sleep(item); continue; }
          let text = typeof item === 'string' ? item : `data: ${JSON.stringify(item)}\n\n`;
          if (crlf) text = text.replace(/\n/g, '\r\n');
          // Split every event in two writes so lines arrive across network chunks.
          const cut = Math.max(1, Math.floor(text.length / 2));
          controller.enqueue(encoder.encode(text.slice(0, cut)));
          controller.enqueue(encoder.encode(text.slice(cut)));
          if (typeof item === 'object') sent++;
        }
        if (hold) {
          while (!finished) {
            await sleep(5_000);
            if (!finished) controller.enqueue(encoder.encode(': OPENROUTER PROCESSING\n\n'));
          }
          return;
        }
        finished = true;
        signal?.removeEventListener('abort', abort);
        onDone?.(sent);
        controller.close();
      } catch {}
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

const SUMMARY = 'FIXTURE_SUMMARY The user asked for help with the channel. Earlier answers and tool results are summarized here.';
const TEXT = 'FIXTURE_TEXT Here is a scripted answer from the fake model. It arrives in several chunks so the stream is exercised.';

async function openRouterChat(body, headers, signal) {
  const info = analyze(body);
  const { markers } = info;
  const id = newGenerationId();
  let script = markers.script ?? (markers.calls.length ? 'tools' : 'text');
  // No tools offered = a compaction call: summary text unless [[compaction:<script>]] says otherwise.
  if (!info.hasTools) script = markers.compaction ?? 'summary';
  if (/^http_\d{3}$/.test(script) || script === 'context') {
    const status = script === 'context' ? 400 : Number(script.slice(5));
    record({ provider: 'openrouter', path: '/chat/completions', script, step: info.step, status, ...requestLog(body, headers, info) });
    const message = script === 'context' ? "This model's maximum context length is 100000 tokens. However, you requested 140000 tokens." : `Fixture HTTP ${status}`;
    return json({ error: { code: status, message } }, status, status === 429 || status === 503 ? { 'retry-after': '1' } : {});
  }
  if (script === 'flaky') {
    const key = `${body.session_id}|${info.lastUser}|${info.step}`;
    if (!flaky.has(key)) {
      flaky.add(key);
      record({ provider: 'openrouter', path: '/chat/completions', script, step: info.step, status: 503, ...requestLog(body, headers, info) });
      return json({ error: { code: 503, message: 'Fixture: temporarily unavailable' } }, 503, { 'retry-after': '0' });
    }
    script = 'text';
  }
  record({ provider: 'openrouter', path: '/chat/completions', script, step: info.step, generationId: id, ...requestLog(body, headers, info) });
  if (markers.wait > 0) await sleep(markers.wait);

  const reply = new Reply(id, info);
  const delay = markers.delay ?? 0;
  reply.comment();
  let hold = false;
  let noUsage = false;
  let finishReason = 'stop';

  if (script === 'summary') {
    reply.reasoning('Summarizing the conversation.');
    reply.text(SUMMARY, 6, delay);
  } else if (info.forced) {
    // Last step: tools are off, the model must answer.
    reply.reasoning('No more tools; answering.');
    reply.text(`FIXTURE_FINAL Answer without tools (step ${info.step}).`, 4, delay);
  } else if (script === 'tools' || script === 'loop') {
    const steps = markers.calls.length ? markers.calls : [{ step: 0, name: 'search_docs', args: { query: 'text to speech' } }, { step: 0, name: 'read_docs', args: { id: '/tts' } }];
    const now = script === 'loop'
      ? [{ name: steps[0].name, args: { ...steps[0].args, n: info.step } }]
      : steps.filter((call) => call.step === info.step);
    if (now.length) {
      reply.reasoning(`Step ${info.step}: calling ${now.map((c) => c.name).join(', ')}.`);
      reply.text(`Checking (step ${info.step}).`, 2, delay);
      reply.toolCalls(now, delay);
      finishReason = 'tool_calls';
    } else {
      reply.reasoning('All tool results are in.');
      const results = info.toolResults.map((m) => `${m.tool_call_id}: ${textOf(m.content).replace(/\s+/g, ' ').slice(0, 80)}`).join(' | ');
      reply.text(`FIXTURE_TOOLS_DONE step=${info.step} results=${info.toolResults.length} reasoning=${info.reasoningEchoed ? 'ok' : 'missing'} ${results}`, 6, delay);
    }
  } else if (script === 'slow') {
    reply.reasoning('Writing a long answer slowly.');
    const chunks = markers.chunks ?? 40;
    for (let i = 0; i < chunks; i++) { reply.pause(markers.delay ?? 250); reply.chunk({ content: `slow-${i} ` }); reply.chars += 8; }
  } else if (script === 'hang') {
    reply.reasoning('Thinking for a long time…');
    hold = true;
  } else if (script === 'error_mid') {
    reply.reasoning();
    reply.text('FIXTURE_PARTIAL This answer breaks ', 3, delay);
    reply.items.push({ id, provider: 'OpenAI', object: 'chat.completion.chunk', error: { code: 502, message: 'Fixture: provider returned error' },
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });
  } else if (script === 'incomplete') {
    reply.reasoning();
    reply.text('FIXTURE_PARTIAL The stream ends without finishing', 3, delay);
  } else if (script === 'no_usage') {
    reply.reasoning();
    reply.text(TEXT, 8, delay);
    noUsage = true;
  } else {
    reply.reasoning();
    reply.text(markers.chunks ? Array.from({ length: markers.chunks }, (_, i) => `part-${i} `).join('') : TEXT, markers.chunks ?? 8, delay);
  }
  const breaks = script === 'error_mid' || script === 'incomplete' || hold;
  if (!breaks) reply.finish(finishReason, body, { nocost: markers.nocost, noUsage });
  const final = reply.usage ?? usageFor(body, info, reply.chars, { nocost: markers.nocost });
  const misses = markers.gen404;
  const store = (cancelled, chars) => saveGeneration(id, { misses, data: generationData(id, chars === undefined ? final : usageFor(body, info, chars, { nocost: markers.nocost }),
    { cancelled, finishReason: cancelled ? null : breaks ? null : finishReason }) });
  store(false);

  return sseResponse(reply, {
    signal, crlf: markers.crlf, hold,
    onAbort: (sent) => {
      // Like OpenRouter: no usage in the stream, the generation shows up later with cancelled: true.
      store(true, Math.min(reply.chars, sent * 6));
      record({ provider: 'openrouter', event: 'aborted', generationId: id, sentChunks: sent });
    },
  });
}

function requestLog(body, headers, info) {
  return {
    authOk: headers.get('authorization') === `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}` && !!process.env.OPENROUTER_API_KEY,
    referer: headers.get('http-referer'), title: headers.get('x-title'),
    lastUser: info.lastUser, toolNames: info.toolNames, forced: info.forced, toolResults: info.toolResults.length,
    reasoningEchoed: info.reasoningEchoed, assistantToolCallMessages: info.withCalls, body,
  };
}

function openRouterGeneration(id, headers) {
  const authOk = headers.get('authorization') === `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}`;
  if (!authOk) { record({ provider: 'openrouter-generation', id, status: 401 }); return json({ error: { code: 401, message: 'No auth credentials found' } }, 401); }
  const saved = readGeneration(id);
  if (!saved || saved.misses === -1 || saved.misses > 0) {
    if (saved && saved.misses > 0) saveGeneration(id, { ...saved, misses: saved.misses - 1 });
    record({ provider: 'openrouter-generation', id, status: 404 });
    return json({ error: { message: `Generation ${id} not found`, code: 404 } }, 404);
  }
  record({ provider: 'openrouter-generation', id, status: 200, cancelled: saved.data.cancelled });
  return json({ data: saved.data });
}

/** The fake OpenRouter API for a URL under /api/v1. */
export async function handleOpenRouter(url, method, headers, rawBody, signal) {
  const route = url.pathname.replace(/^\/api\/v1/, '');
  if (method === 'POST' && route === '/chat/completions') {
    let body;
    try { body = JSON.parse(String(rawBody || '{}')); } catch { return json({ error: { code: 400, message: 'Invalid JSON' } }, 400); }
    if (!process.env.OPENROUTER_API_KEY || headers.get('authorization') !== `Bearer ${process.env.OPENROUTER_API_KEY}`) {
      record({ provider: 'openrouter', path: route, status: 401, authOk: false });
      return json({ error: { code: 401, message: 'No auth credentials found' } }, 401);
    }
    return openRouterChat(body, headers, signal);
  }
  if (method === 'GET' && route === '/generation') return openRouterGeneration(url.searchParams.get('id') ?? '', headers);
  record({ provider: 'openrouter', path: route, status: 404, method });
  return json({ error: { code: 404, message: 'Not found in fixture' } }, 404);
}

// ---------------------------------------------------------------------------
// Fake Polar (event ingest)
// ---------------------------------------------------------------------------

const polarSeen = new Set();

function polar(url, method, rawBody) {
  if (method === 'POST' && url.pathname === '/v1/events/ingest') {
    const body = JSON.parse(String(rawBody || '{}'));
    const events = Array.isArray(body.events) ? body.events : [];
    if (control().polar === 'fail') {
      record({ provider: 'polar', path: url.pathname, status: 503, events });
      return json({ detail: 'Fixture: Polar unavailable' }, 503);
    }
    let inserted = 0;
    let duplicates = 0;
    for (const event of events) {
      const key = event.external_id ?? event.externalId;
      if (key && polarSeen.has(key)) duplicates++;
      else { inserted++; if (key) polarSeen.add(key); }
    }
    record({ provider: 'polar', path: url.pathname, status: 200, events, inserted, duplicates });
    return json({ inserted, duplicates });
  }
  record({ provider: 'polar', path: url.pathname, method, status: 404 });
  return json({ detail: 'Not found in fixture' }, 404);
}

// ---------------------------------------------------------------------------
// Docs export and other stubs (same shapes as docs-assistant-fixtures)
// ---------------------------------------------------------------------------

const page = (title, description, pagePath, body, lang) => `# ${title}

${description}

Source: https://docs.domdimabot.com/${pagePath}
Language: ${lang}
Documentation index: https://docs.domdimabot.com/llms.txt

${body}`;

const DOCS = {
  '/llms-full.txt': `# DomDimaBot — en

${page('Text to Speech', 'Make the bot read chat aloud.', 'tts/', `Open **Modules → Text to speech** and turn on **Enable channel TTS**.

## Speech URL

FIXTURE_EN_TTS Copy the Speech URL into OBS as a Browser Source.`, 'en')}

---

${page('Commands', 'Create chat commands.', 'commands/', `## Create a command

FIXTURE_EN_COMMANDS Open **Commands** and press **New command**.`, 'en')}
`,
  '/es/llms-full.txt': `# DomDimaBot — es

${page('Texto a voz', 'Haz que el bot lea el chat.', 'es/tts/', `## URL de voz

FIXTURE_ES_TTS Abre **Módulos → Texto a voz**.`, 'es')}
`,
  '/llms.txt': `# DomDimaBot

- [Text to Speech](https://docs.domdimabot.com/tts/index.txt): Make the bot read chat aloud.
- [Commands](https://docs.domdimabot.com/commands/index.txt): Create chat commands.
`,
  '/es/llms.txt': `# DomDimaBot

- [Texto a voz](https://docs.domdimabot.com/es/tts/index.txt): Haz que el bot lea el chat.
`,
};

async function bodyText(input, init) {
  if (init.body !== undefined && init.body !== null) return typeof init.body === 'string' ? init.body : await new Response(init.body).text();
  return input instanceof Request ? await input.clone().text() : '';
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  const signal = init.signal || (input instanceof Request ? input.signal : undefined);
  if (url.hostname === 'openrouter.test') return handleOpenRouter(url, method, headers, await bodyText(input, init), signal);
  if (url.hostname === 'api.polar.sh' || url.hostname === 'sandbox-api.polar.sh') return polar(url, method, await bodyText(input, init));
  if (url.hostname === 'docs.test') {
    record({ provider: 'docs', path: url.pathname });
    return DOCS[url.pathname] ? new Response(DOCS[url.pathname], { headers: { 'content-type': 'text/plain' } }) : new Response('missing', { status: 404 });
  }
  if (url.hostname === 'embeddings.test') {
    const body = JSON.parse(String(await bodyText(input, init) || '{}'));
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
  throw new Error(`External request blocked in site agent test: ${url.origin}${url.pathname}`);
};

// ---------------------------------------------------------------------------
// Optional real HTTP server (local runs; checks inside the candidate use the fetch hook)
// ---------------------------------------------------------------------------

/** Serves the fake OpenRouter at http://127.0.0.1:<port>/api/v1. Resolves with the server. */
export function startFakeOpenRouter({ port = 18787, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const headers = new Headers(Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v === undefined ? [] : [[k, v]])));
    try {
      const response = await handleOpenRouter(url, req.method ?? 'GET', headers, Buffer.concat(chunks).toString('utf8'), controller.signal);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.flushHeaders();
      if (response.body) for await (const part of response.body) res.write(part);
      res.end();
    } catch {
      res.destroy();
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2] === 'serve') {
  const port = Number(process.argv[3] ?? 18787);
  await startFakeOpenRouter({ port });
  console.log(`Fake OpenRouter on http://127.0.0.1:${port}/api/v1 (calls → ${CALLS})`);
}
