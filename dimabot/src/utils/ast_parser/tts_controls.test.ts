import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { parse } from './parser.js';
import { createExecutionContext, evaluate, getFunctionHandler } from './evaluator.js';
const calls: unknown[] = [];
let failed = false;
let snapshot = { connected: true, playing: true, preparing: false, queueLength: 3 };
mock.module('../../functions/chats/control_tts.chat.js', { namedExports: { getTtsStatus: async () => failed ? { error: true, message: 'fixture unavailable' } : { error: false, data: snapshot }, controlTts: async (channel: string, action: string) => {
  calls.push([channel, action]); return { error: failed, message: 'fixture unavailable' };
} } });
mock.module('../tts/queue_default_tts.util.js', { namedExports: { queueDefaultTts: async () => assert.fail('control must not synthesize') } });
mock.module('../posthog_events.js', { namedExports: { trackTts: () => {} } });
const { registerTtsFunctions } = await import('./functions/tts.functions.js');
registerTtsFunctions();
const run = async (source: string, userLevel = 7, platform: 'twitch' | 'kick' = 'twitch') => (await evaluate(parse(source).ast,
  createExecutionContext({ broadcasterId: '123', userLevel, platform }))).value;
for (const action of ['skip', 'clear', 'refresh']) test(`tts.${action}: moderator gate, argument validation, channel and error propagation`, async () => {
  const before = calls.length;
  assert.match(String(await run(`$(tts.${action})`, 6)), /permission denied/i);
  assert.match(String(await run(`$(tts.${action} 456)`)), /Usage/);
  assert.match(String(await run(`$(tts.${action})`, 7, 'kick')), /Twitch/);
  assert.equal(calls.length, before);
  assert.equal(await run(`$(tts.${action})`), '');
  assert.deepEqual(calls.at(-1), ['123', action]);
  failed = true;
  assert.match(String(await run(`$(tts.${action})`)), /fixture unavailable/);
  failed = false;
});

test('status reads work for everyone and expose native booleans and numbers in conditions', async () => {
  const ctx = createExecutionContext({ broadcasterId: '123', userLevel: 1, platform: 'twitch' });
  assert.equal(await getFunctionHandler('tts.connected')!([], ctx), true);
  assert.equal(await getFunctionHandler('tts.queue.length')!([], ctx), 3);
  assert.equal(await run('$(tts.status)', 1), 'TTS: connected · playing · 3 queued');
  assert.equal(await run('*($(tts.connected) ? "online" : "offline")', 1), 'online');
  assert.equal(await run('*($(tts.queue.length) + 1)', 1), '4');
  snapshot = { connected: false, playing: false, preparing: false, queueLength: 0 };
  assert.equal(await run('*($(tts.connected) ? "online" : "offline")', 1), 'offline');
  assert.equal(await run('$(tts.status)', 1), 'TTS: disconnected · idle · 0 queued');
  failed = true;
  assert.equal(await getFunctionHandler('tts.connected')!([], ctx), false);
  assert.equal(await getFunctionHandler('tts.queue.length')!([], ctx), -1);
  assert.match(String(await run('$(tts.status)', 1)), /fixture unavailable/);
  assert.equal(await run('*($(tts.connected) ? "online" : "offline")', 1), 'offline');
  failed = false;
  assert.match(String(await run('$(tts.status extra)', 1)), /Usage/);
  assert.equal(await getFunctionHandler('tts.connected')!(['extra'], ctx), false);
  assert.equal(await getFunctionHandler('tts.queue.length')!(['extra'], ctx), -1);
});
