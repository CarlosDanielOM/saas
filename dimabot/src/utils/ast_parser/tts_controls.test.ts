import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { parse } from './parser.js';
import { createExecutionContext, evaluate } from './evaluator.js';
const calls: unknown[] = [];
let failed = false;
mock.module('../../functions/chats/control_tts.chat.js', { namedExports: { controlTts: async (channel: string, action: string) => {
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
