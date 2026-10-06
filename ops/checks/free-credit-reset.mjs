import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { resolveFreeCreditPeriod } from '/app/dist/utils/ai_usage_receipts.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';

const workerEntry = path.join(process.cwd(), 'dist/workers/free_credit_reset.worker.js');
const callsPath = '/tmp/saas-fixtures/polar-calls.jsonl';

function runWorker() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerEntry, '--once'], {
      cwd: process.cwd(),
      env: { ...process.env, FREE_CREDIT_RESET_ENABLED: 'true' },
    });
    let output = '';
    const capture = (chunk) => { output += chunk.toString(); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`worker exited ${code}/${signal}\n${output}`));
        return;
      }
      resolve(output);
    });
  });
}

function twitchAccount(id) {
  return [{
    type: 'twitch', id, name: id, email: `${id}@example.invalid`, actived: true,
    chat_enabled: true, has_permissions: true, up_to_date_permissions: true,
  }];
}

await getMongoDBConnection('free-credit-reset-check');
const redis = await getDragonflyClient('free-credit-reset-check');
await UsersSchema.deleteMany({});
await redis.flushDb();
fs.writeFileSync(callsPath, '');

const now = new Date();
const anchor = new Date(Date.UTC(2025, 0, 7, 10, 30));
const current = resolveFreeCreditPeriod(anchor, now);
assert.ok(current, 'current free period must resolve');
const prior = resolveFreeCreditPeriod(anchor, new Date(current.start.getTime() - 1));
assert.ok(prior, 'prior free period must resolve');

const due = await UsersSchema.create({
  name: 'due-free', email: 'due@example.invalid', created_at: anchor, plan_tier: 'free',
  polar_sh_customer_id: '11111111-1111-4111-8111-111111111111',
  accounts: twitchAccount('due-channel'),
  free_credit_reset: {
    periodStart: prior.start, periodEnd: prior.end, status: 'completed', credits: 0,
    externalId: `free-credit-reset-due-${prior.start.toISOString().slice(0, 10)}`,
    updatedAt: prior.end, completedAt: prior.end,
  },
});
const baseline = await UsersSchema.create({
  name: 'baseline-free', email: 'baseline@example.invalid', created_at: anchor,
  plan_tier: 'free', polar_sh_customer_id: '22222222-2222-4222-8222-222222222222',
  accounts: twitchAccount('baseline-channel'),
});
await UsersSchema.create({
  name: 'paid', email: 'paid@example.invalid', created_at: anchor,
  plan_tier: 'premium', polar_sh_customer_id: '33333333-3333-4333-8333-333333333333',
  accounts: twitchAccount('paid-channel'),
});

for (const [channel, used] of [['due-channel', 5_000], ['baseline-channel', 7_000]]) {
  await redis.set(`twitch:${channel}:ai:credits`, JSON.stringify({
    version: 3, used, limit: 25_000, balance: 25_000 - used,
    meterId: '5103e79b-fd74-4ba8-a287-f95574f9addf', updatedAt: now.toISOString(),
    available: true, status: 'available',
  }));
  await redis.set(`twitch:${channel}:ai:exhaust`, 'true');
  await redis.set(`${channel}:ai:exhaust`, 'true');
}

const firstOutput = await runWorker();
assert.match(firstOutput, /Free credit reset scan completed/);

const dueAfterFirst = await UsersSchema.findById(due._id).lean().exec();
const baselineAfterFirst = await UsersSchema.findById(baseline._id).lean().exec();
assert.equal(dueAfterFirst?.free_credit_reset?.status, 'completed');
assert.equal(dueAfterFirst?.free_credit_reset?.credits, 5_000);
assert.equal(dueAfterFirst?.free_credit_reset?.periodStart.toISOString(), current.start.toISOString());
assert.equal(baselineAfterFirst?.free_credit_reset?.status, 'initialized');
assert.equal(baselineAfterFirst?.free_credit_reset?.credits, 0);

const callsAfterFirst = fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
assert.equal(callsAfterFirst.length, 1, 'only the due user should receive a Polar grant');
const event = callsAfterFirst[0].events[0];
assert.equal(event.customer_id, '11111111-1111-4111-8111-111111111111');
assert.equal(event.external_id, `free-credit-reset-${due._id}-${current.start.toISOString().slice(0, 10)}`);
assert.equal(event.metadata.credits, -5_000);
assert.equal(event.metadata.cost, 0);
assert.equal(event.metadata.reason, 'free_monthly_credit_reset');
assert.equal(event.metadata.usage_source, 'free_credit_reset_worker');

assert.equal(await redis.exists('twitch:due-channel:ai:credits'), 0);
assert.equal(await redis.exists('twitch:due-channel:ai:exhaust'), 0);
assert.equal(await redis.exists('due-channel:ai:exhaust'), 0);
assert.equal(await redis.exists('twitch:baseline-channel:ai:credits'), 1);

const completedAt = dueAfterFirst?.free_credit_reset?.completedAt?.toISOString();
const secondOutput = await runWorker();
assert.match(secondOutput, /Free credit reset scan completed/);
const dueAfterSecond = await UsersSchema.findById(due._id).lean().exec();
assert.equal(dueAfterSecond?.free_credit_reset?.completedAt?.toISOString(), completedAt);
const callsAfterSecond = fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean);
assert.equal(callsAfterSecond.length, 1, 'a completed period must not grant twice');

redis.destroy();
console.log('free credit reset grant, baseline, cache invalidation, and rerun idempotency passed');
process.exit(0);
