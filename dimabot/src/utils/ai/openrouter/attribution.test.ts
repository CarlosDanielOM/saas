import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import type { IModerationDecision } from '../../../schemas/moderation_decision.schema.js';
mock.module('../../logger.js', { namedExports: { error: async () => {}, debug: async () => {} } });
const { evaluateSemanticDecision } = await import('../../moderation/semantic.js');
const { generateMuseVariations } = await import('../../moderation/variations.js');
const { generateEmbedding, generateEmbeddings } = await import('./embeddings.ai.js');
const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = 'test-only';
after(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey; });
const calls: { url: string; user: string }[] = [];
let expectedUser = '';
globalThis.fetch = async (input, options) => {
  const headers = new Headers(options?.headers);
  assert.equal(headers.get('HTTP-Referer'), 'https://domdimabot.com');
  assert.equal(headers.get('X-OpenRouter-Title'), 'DomDimaBot');
  assert.equal(headers.get('X-OpenRouter-Description'), 'DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.');
  assert.equal(headers.get('X-OpenRouter-Categories'), 'general-chat, roleplay');
  const body = JSON.parse(String(options?.body));
  assert.equal(body.user, expectedUser);
  const url = String(input);
  calls.push({ url, user: body.user });
  if (url.endsWith('/decisions')) return Response.json({ model: body.model, id: 'decision-id', provider: 'fixture', answers: { violation: { type: 'noul', noul: 0.01 } }, usage: { cost: 0, input_tokens: 10 } });
  if (url.endsWith('/chat/completions')) return Response.json({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ entries: [{ term: 'rinn', spellings: ['rin'] }] }) } }], usage: { cost: 0 } });
  assert.ok(url.endsWith('/embeddings'));
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  return Response.json({ model: body.model, data: inputs.map((_: string, index: number) => ({ embedding: [0.1, 0.2], index, object: 'embedding' })), usage: { total_tokens: 10, prompt_tokens: 10 } });
};
const decision = (channelID: string) => ({ channelID, rule: { id: 'words', semantic: { enabled: true, policy: 'Reject hostile insults.', examples: [] } }, username: 'fixture', messageText: 'Hello!', context: [], matches: [], deadline: new Date(Date.now() + 4000) }) as unknown as IModerationDecision;

test('Jev and both Span models carry the owner channel ID and app headers', async () => {
  for (const [index, model] of ['typesafe/jev-1.13', 'respan/span-01', 'respan/span-01-lite'].entries()) {
    expectedUser = `channel-${index}`;
    const result = await evaluateSemanticDecision(decision(expectedUser), model);
    assert.equal(result.status, 'completed');
    assert.equal(result.model, model);
    assert.equal(calls.at(-1)?.user, expectedUser);
  }
});
test('Muse word variations carry the job channel ID', async () => {
  for (const user of ['channel-one', 'channel-two']) {
    expectedUser = user;
    const result = await generateMuseVariations(['rinn'], AbortSignal.timeout(4000), user);
    assert.equal(result.entries.length, 1);
    assert.equal(calls.at(-1)?.user, user);
  }
});
test('single, one-item and batched OpenRouter embeddings preserve the channel ID', async () => {
  expectedUser = 'embedding-channel';
  assert.equal((await generateEmbedding('hello', undefined, expectedUser)).error, false);
  assert.equal((await generateEmbeddings(['hello'], undefined, expectedUser)).error, false);
  assert.equal((await generateEmbeddings(['hello', 'world'], undefined, expectedUser)).error, false);
  assert.ok(calls.slice(-3).every(call => call.user === expectedUser));
});
test('missing channel context never makes a paid unattributed request', async () => {
  const count = calls.length;
  assert.equal((await evaluateSemanticDecision(decision(''))).status, 'invalid_context');
  await assert.rejects(generateMuseVariations(['rinn'], AbortSignal.timeout(4000), ''), /channel_context_required/);
  assert.equal((await generateEmbedding('hello')).error, true);
  assert.equal((await generateEmbeddings(['hello'])).error, true);
  assert.equal((await generateEmbeddings(['hello', 'world'])).error, true);
  assert.equal(calls.length, count);
});
