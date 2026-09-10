import assert from 'node:assert/strict';
import test from 'node:test';

import type { AiCreditStatus } from '../utils/billing.js';
import type { TtsQueueItem } from './tts_queue.handler.js';
import { resolveTtsForCreditStatus } from '../utils/tts/tts_credit_fallback.util.js';

function fishItem(mode: TtsQueueItem['mode'] = 'clone'): TtsQueueItem {
  return {
    channelID: 'channel-1',
    source: 'ast',
    mode,
    provider: 'fish',
    model: 'fish-model',
    text: 'Hello world',
    language: 'en',
    voice: 'fish-reference-id',
    cloneName: 'gojo',
    piperFallbackVoice: 'en_US-ryan-medium',
    speechID: 'speech-1',
    timestamp: 1,
  };
}

for (const status of ['exhausted', 'unavailable'] as AiCreditStatus[]) {
  test(`Fish ${status} requests fall back to the configured Piper voice`, () => {
    const resolved = resolveTtsForCreditStatus(fishItem(), status);

    assert.equal(resolved.provider, 'piper');
    assert.equal(resolved.mode, 'speak');
    assert.equal(resolved.voice, 'en_US-ryan-medium');
    assert.equal(resolved.cloneName, undefined);
    assert.equal(resolved.model, undefined);
  });
}

test('Fish remains selected while credits are available', () => {
  assert.deepEqual(
    resolveTtsForCreditStatus(fishItem(), 'available'),
    fishItem(),
  );
});

test('Piper requests are unchanged regardless of credit status', () => {
  const item = { ...fishItem('speak'), provider: 'piper' as const };
  assert.deepEqual(
    resolveTtsForCreditStatus(item, 'exhausted'),
    item,
  );
});

test('legacy queued Fish requests use the default Piper voice', () => {
  const item = fishItem();
  delete item.piperFallbackVoice;

  assert.equal(
    resolveTtsForCreditStatus(item, 'exhausted').voice,
    'en_US-ryan-medium',
  );
});

test('Fish cues are removed from text when a request falls back to Piper', () => {
  const item = { ...fishItem('speak'), text: '[happy] Hello [laugh]' };

  assert.equal(
    resolveTtsForCreditStatus(item, 'exhausted').text,
    'Hello',
  );
});
