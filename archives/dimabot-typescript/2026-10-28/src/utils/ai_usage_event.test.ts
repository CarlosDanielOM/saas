import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_USAGE_PRICING_VERSION,
  AI_USAGE_SCHEMA_VERSION,
  createAiUsageContext,
  enrichPolarUsageMetadata,
} from './ai_usage_event.js';

test('canonical TTS metadata is additive and preserves accounting fields', () => {
  const accounting = {
    _cost: { amount: 0.15, currency: 'usd' },
    cost: 0.0015,
    credits: 150,
    currency: 'usd',
    reason: 'tts_fish',
    characters: 100,
  };
  const original = structuredClone(accounting);
  const context = createAiUsageContext('tts_fish', {
    entryId: 'entry-1',
    requestId: 'request-1',
    channelID: 'channel-1',
    resourceType: 'speech',
    resourceId: 'speech-1',
    quantity: 100,
    unit: 'characters',
  });

  const enriched = enrichPolarUsageMetadata(accounting, context);

  for (const [key, value] of Object.entries(original)) {
    assert.deepEqual(enriched[key as keyof typeof enriched], value);
  }
  assert.equal(enriched.schema_version, AI_USAGE_SCHEMA_VERSION);
  assert.equal(enriched.pricing_version, AI_USAGE_PRICING_VERSION);
  assert.equal(enriched.entry_id, 'entry-1');
  assert.equal(enriched.request_id, 'request-1');
  assert.equal(enriched.category, 'tts');
  assert.equal(enriched.operation, 'synthesize');
  assert.equal(enriched.provider, 'fish');
  assert.equal(enriched.resource_id, 'speech-1');
});

test('legacy reasons map to receipt categories without storing prompts or text', () => {
  const context = createAiUsageContext('harness_tools', {
    entryId: 'entry-2',
    requestId: 'request-2',
    model: 'openai/model',
    quantity: 42,
    unit: 'tokens',
  });
  const metadata = enrichPolarUsageMetadata({
    cost: 1,
    credits: 1000,
    currency: 'usd',
    reason: 'harness_tools',
  }, context);

  assert.equal(metadata.category, 'ai_chat');
  assert.equal(metadata.operation, 'tool_reasoning');
  assert.equal(metadata.provider, 'openrouter');
  assert.equal(metadata.quantity, 42);
  assert.equal(metadata.unit, 'tokens');
  assert.equal('text' in metadata, false);
  assert.equal('prompt' in metadata, false);
  assert.equal('message' in metadata, false);
});
