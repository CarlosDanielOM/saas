// Execute actual provider helpers and moderation worker flows with isolated data.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const tests = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test',
  '/app/dist/utils/ai/openrouter/attribution.test.js',
  '/app/dist/utils/moderation/advanced.test.js',
  '/app/dist/utils/moderation/spam.test.js',
  '/app/dist/utils/moderation/variations.test.js'], {
  env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'inherit', timeout: 60000,
});
assert.equal(tests.status, 0, 'compiled provider attribution and moderation tests');
for (const check of ['semantic-check.mjs', 'spam-check.mjs']) {
  // The spam suite assumes a fresh database: paid custom semantic decisions
  // from the first suite must not enter its global free-fallback assertions.
  // Its task-owned real worker uses a separate disposable Mongo database.
  const env = check === 'spam-check.mjs'
    ? { ...process.env, MONGO_URI: 'mongodb://mongo:27017/saas_ops_spam_attribution_test', SAAS_TARGET: 'attribution-worker' }
    : process.env;
  const result = spawnSync(process.execPath, [`/tmp/saas-fixtures/${check}`], { env, stdio: 'inherit', timeout: 110000 });
  assert.equal(result.status, 0, `${check}: real moderation worker must send app and channel attribution`);
}
console.log('PASS OpenRouter app/channel attribution: Jev, Span, Muse variations, embedding helpers, and actual moderation workers');
