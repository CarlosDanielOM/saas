import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import AiUsageDailySchema from '/app/dist/schemas/ai_usage_daily.schema.js';
import AiUsageReceiptSchema from '/app/dist/schemas/ai_usage_receipt.schema.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';
import { ingestPolarSHEvent } from '/app/dist/utils/polarsh.js';

const workerEntry = path.join(process.cwd(), 'dist/workers/ai_usage_receipts.worker.js');

function runWorker() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerEntry, '--once'], {
      cwd: process.cwd(), env: { ...process.env, AI_USAGE_RECEIPTS_ENABLED: 'true' },
    });
    let output = '';
    const capture = chunk => { output += chunk.toString(); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`worker exited ${code}/${signal}\n${output}`));
      else resolve(output);
    });
  });
}

function account(id) {
  return [{ type: 'twitch', id, name: id, email: `${id}@example.invalid`, actived: true,
    chat_enabled: true, has_permissions: true, up_to_date_permissions: true }];
}

await getMongoDBConnection('ai-usage-ledger-worker-check');
const redis = await getDragonflyClient('ai-usage-ledger-worker-check');
await Promise.all([
  UsersSchema.deleteMany({}), AiUsageReceiptSchema.deleteMany({}), AiUsageDailySchema.deleteMany({}), redis.flushDb(),
]);

const occurredAt = new Date();
const tiers = [['free', 30], ['premium', 60], ['pro', 90]];
for (const [tier, days] of tiers) {
  const channelID = `producer-${tier}`;
  const customerId = `${days}`.padStart(8, '0') + '-1111-4111-8111-111111111111';
  await UsersSchema.create({ name: channelID, email: `${channelID}@example.invalid`, plan_tier: tier,
    polar_sh_customer_id: customerId, accounts: account(channelID) });
  const result = await ingestPolarSHEvent({
    customerId, channelID, externalId: `producer-${tier}-event`, cost: 0.15, reason: 'tts_fish', mode: 'immediate',
    usage: { category: 'tts', operation: 'synthesize', source: 'test', provider: 'fish', quantity: 100, unit: 'characters' },
  });
  assert.equal(result.error, false);
}
assert.equal(await redis.lLen('cron:ai-usage-receipts:queue'), 3);

const output = await runWorker();
assert.match(output, /AI usage receipt batch completed/);
for (const [tier, days] of tiers) {
  const receipt = await AiUsageReceiptSchema.findOne({ entryId: `producer-${tier}-event` }).lean();
  assert.equal(receipt.retentionTier, tier);
  const retentionMs = receipt.expiresAt.getTime() - receipt.occurredAt.getTime();
  assert.equal(retentionMs, Number(days) * 86400000);
  assert.ok(Math.abs(receipt.occurredAt.getTime() - occurredAt.getTime()) < 10_000);
}
assert.equal(await AiUsageDailySchema.countDocuments({}), 3);
const receiptIndexes = await AiUsageReceiptSchema.collection.indexes();
const ttlIndex = receiptIndexes.find(index => index.key?.expiresAt === 1);
assert.equal(ttlIndex?.expireAfterSeconds, 0, 'receipt expiry must be enforced by a Mongo TTL index');
const uniqueIndex = receiptIndexes.find(index => index.unique === true && index.key?.entryId === 1);
assert.ok(uniqueIndex, 'receipt deduplication requires the compound unique event index');
assert.equal(await redis.lLen('cron:ai-usage-receipts:queue'), 0);
assert.equal(await redis.lLen('cron:ai-usage-receipts:processing'), 0);

redis.destroy();
console.log('usage producer queue and Mongo worker retention passed');
process.exit(0);
