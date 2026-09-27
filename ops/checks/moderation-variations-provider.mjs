// Optional synthetic live-provider check inside the backend image. This calls
// Muse with invented examples only; it does not touch databases, chat or billing.
import assert from 'node:assert/strict';
import { generateMuseVariations, rulePatterns, VARIATION_MODEL } from '/app/dist/utils/moderation/variations.js';
import { findBlacklistMatches } from '/app/dist/utils/moderation/advanced.js';
const result = await generateMuseVariations(['fuck', 'rinn', 'café', 'bad word'], AbortSignal.timeout(60000));
assert.equal(result.model, VARIATION_MODEL);
assert.equal(result.entries.length, 4);
const patterns = rulePatterns({ variations: { mode: 'broad', entries: result.entries } });
for (const text of ['fuck', 'fuuuck', 'Riiinnnn', 'CAFE', 'bad word']) assert.ok(findBlacklistMatches(text, [], patterns).length, text);
for (const text of ['bring', 'string', 'ordinary conversation']) assert.equal(findBlacklistMatches(text, [], patterns).length, 0, text);
console.log(JSON.stringify({ model: result.model, entries: result.entries.map(({term, spellings}) => ({term, spellings})), providerCost: result.usage.cost }));
console.log('PASS Muse generation: multiple terms, schema validation, safe regex compilation and boundaries; no user credit writes');
