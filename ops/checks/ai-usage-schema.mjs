import assert from 'node:assert/strict';

import {
  AI_USAGE_PRICING_VERSION,
  AI_USAGE_SCHEMA_VERSION,
  createAiUsageContext,
  enrichPolarUsageMetadata,
} from '/app/dist/utils/ai_usage_event.js';

const accounting = {
  _cost: { amount: 0.15, currency: 'usd' },
  cost: 0.0015,
  credits: 150,
  currency: 'usd',
  reason: 'tts_fish',
  characters: 100,
};
const context = createAiUsageContext('tts_fish', {
  entryId: 'candidate-entry',
  requestId: 'candidate-request',
  channelID: 'candidate-channel',
  quantity: 100,
  unit: 'characters',
  resourceType: 'speech',
  resourceId: 'candidate-speech',
});
const metadata = enrichPolarUsageMetadata(accounting, context);

for (const [key, value] of Object.entries(accounting)) {
  assert.deepEqual(metadata[key], value, `${key} accounting value changed`);
}
assert.equal(metadata.schema_version, AI_USAGE_SCHEMA_VERSION);
assert.equal(metadata.pricing_version, AI_USAGE_PRICING_VERSION);
assert.equal(metadata.entry_id, 'candidate-entry');
assert.equal(metadata.request_id, 'candidate-request');
assert.equal(metadata.category, 'tts');
assert.equal(metadata.operation, 'synthesize');
assert.equal(metadata.provider, 'fish');
assert.equal(metadata.quantity, 100);
assert.equal(metadata.unit, 'characters');
assert.equal(metadata.resource_id, 'candidate-speech');
assert.equal('text' in metadata, false);
assert.equal('prompt' in metadata, false);
assert.equal('message' in metadata, false);

console.log(`ai usage schema passed for ${process.env.SAAS_TARGET}`);
