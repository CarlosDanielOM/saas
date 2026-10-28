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

for (const plan of ['premium', 'pro']) {
  test(`${plan} exhausted Fish requests use the configured Kokoro preset`, () => {
    const item = { ...fishItem(), text: '[happy] Hello [laugh]', kokoroFallbackVoice: 'am_michael' };
    const resolved = resolveTtsForCreditStatus(item, 'exhausted', plan);
    assert.equal(resolved.provider, 'kokoro');
    assert.equal(resolved.mode, 'speak');
    assert.equal(resolved.voice, 'am_michael');
    assert.equal(resolved.text, 'Hello');
    assert.equal(resolved.cloneName, undefined);
    assert.equal(resolved.model, undefined);
    assert.equal(item.provider, 'fish');
  });

  test(`${plan} exhausted Kokoro requests preserve their selected preset`, () => {
    const item = { ...fishItem('speak'), provider: 'kokoro' as const, voice: 'af_bella', kokoroFallbackVoice: 'ef_dora' };
    assert.equal(resolveTtsForCreditStatus(item, 'exhausted', plan).voice, 'af_bella');
    assert.equal(resolveTtsForCreditStatus(item, 'exhausted', plan).provider, 'kokoro');
  });

  test(`${plan} unavailable credits and synthesis failures still use Piper`, () => {
    assert.equal(resolveTtsForCreditStatus(fishItem(), 'unavailable', plan).provider, 'piper');
    const exhausted = resolveTtsForCreditStatus(fishItem(), 'exhausted', plan);
    assert.equal(resolveTtsForCreditStatus(exhausted, 'unavailable').voice, 'en_US-ryan-medium');
    assert.equal(resolveTtsForCreditStatus(exhausted, 'unavailable').provider, 'piper');
  });

  test(`${plan} requests with available credits or explicit Piper remain unchanged`, () => {
    assert.deepEqual(resolveTtsForCreditStatus(fishItem(), 'available', plan), fishItem());
    const piper = { ...fishItem('speak'), provider: 'piper' as const };
    assert.deepEqual(resolveTtsForCreditStatus(piper, 'exhausted', plan), piper);
  });
}

for (const [language, voice] of [['en', 'af_heart'], ['es', 'ef_dora']] as const) {
  test(`legacy and invalid Kokoro fallbacks use the ${language} default`, () => {
    const item = { ...fishItem(), language };
    assert.equal(resolveTtsForCreditStatus(item, 'exhausted', 'pro').voice, voice);
    assert.equal(resolveTtsForCreditStatus({ ...item, kokoroFallbackVoice: 'fish-id' }, 'exhausted', 'pro').voice, voice);
  });
}

for (const plan of ['free', undefined, 'unknown']) {
  test(`exhausted ${plan} accounts keep Piper`, () => {
    assert.equal(resolveTtsForCreditStatus(fishItem(), 'exhausted', plan).provider, 'piper');
  });
}
