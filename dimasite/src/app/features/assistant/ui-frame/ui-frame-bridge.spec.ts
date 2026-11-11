// Run: cd dimabot && node --import tsx --test ../dimasite/src/app/features/assistant/ui-frame/*.spec.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_FRAME_HEIGHT, MAX_SUBMIT_BYTES, MIN_FRAME_HEIGHT, isPlainJson, jsonBytes, validateFrameMessage } from './ui-frame-bridge.ts';

const T = 'token-abc';
const msg = (data: Record<string, unknown>) => ({ dimaUi: 1, token: T, ...data });

test('token, marker and type are required', () => {
  assert.equal(validateFrameMessage(msg({ type: 'resize', height: 10 }), 'other'), null);
  assert.equal(validateFrameMessage({ token: T, type: 'resize', height: 10 }, T), null);
  assert.equal(validateFrameMessage(msg({ type: 'eval', code: '1' }), T), null);
  assert.equal(validateFrameMessage(msg({ type: 'resize', height: 10 }), ''), null);
  assert.equal(validateFrameMessage('{"dimaUi":1}', T), null);
  assert.equal(validateFrameMessage(null, T), null);
  assert.equal(validateFrameMessage([msg({ type: 'ready', height: 1 })], T), null);
});

test('heights are clamped to the frame limits', () => {
  assert.deepEqual(validateFrameMessage(msg({ type: 'ready', height: 300.4 }), T), { type: 'ready', height: 300 });
  assert.deepEqual(validateFrameMessage(msg({ type: 'resize', height: 99999 }), T), { type: 'resize', height: MAX_FRAME_HEIGHT });
  assert.deepEqual(validateFrameMessage(msg({ type: 'resize', height: 3 }), T), { type: 'resize', height: MIN_FRAME_HEIGHT });
  for (const height of [-1, NaN, Infinity, '200', null]) assert.equal(validateFrameMessage(msg({ type: 'resize', height }), T), null, String(height));
});

test('submit: plain JSON object up to 16 KB only', () => {
  const values = { name: 'Raid alert', volume: 70, on: true, tags: ['a', 'b'], nested: { x: null } };
  assert.deepEqual(validateFrameMessage(msg({ type: 'submit', values }), T), { type: 'submit', values });
  for (const bad of [null, [], 'text', 5, new Date(), new Map(), { f: () => 1 }, { n: NaN }, { d: new Date() }, { big: 10n }]) {
    assert.equal(validateFrameMessage(msg({ type: 'submit', values: bad }), T), null, String(bad));
  }
  class Custom { a = 1; }
  assert.equal(validateFrameMessage(msg({ type: 'submit', values: new Custom() }), T), null, 'class instance');
  const atLimit = { s: 'x'.repeat(MAX_SUBMIT_BYTES - 8) };
  assert.equal(jsonBytes(atLimit), MAX_SUBMIT_BYTES);
  assert.ok(validateFrameMessage(msg({ type: 'submit', values: atLimit }), T));
  assert.equal(validateFrameMessage(msg({ type: 'submit', values: { s: 'x'.repeat(MAX_SUBMIT_BYTES) } }), T), null);
  // Multi-byte text counts in UTF-8 bytes.
  assert.equal(validateFrameMessage(msg({ type: 'submit', values: { s: 'ñ'.repeat(MAX_SUBMIT_BYTES / 2) } }), T), null);
  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let i = 0; i < 20; i++) { deep['n'] = {}; deep = deep['n'] as Record<string, unknown>; }
  assert.equal(isPlainJson(root), false, 'too deep');
});

test('navigate: only known route keys', () => {
  assert.deepEqual(validateFrameMessage(msg({ type: 'navigate', route: 'modules.tts' }), T), { type: 'navigate', route: 'modules.tts' });
  for (const route of ['https://evil.example', '/settings', 'modules', '__proto__', 'constructor', 'toString', 42, null]) {
    const result = validateFrameMessage(msg({ type: 'navigate', route }), T);
    if (route === 'modules') assert.deepEqual(result, { type: 'navigate', route: 'modules' });
    else assert.equal(result, null, String(route));
  }
});

test('stopped: the relay reports a card that tried to leave', () => {
  assert.deepEqual(validateFrameMessage(msg({ type: 'stopped' }), T), { type: 'stopped' });
  assert.equal(validateFrameMessage({ dimaUi: 1, token: 'x', type: 'stopped' }, T), null);
});
