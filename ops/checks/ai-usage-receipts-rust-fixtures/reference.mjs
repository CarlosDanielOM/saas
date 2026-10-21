// Source-backed TypeScript reference only. Never runs external Polar/backfill workers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const uri = new URL(process.env.MONGO_URI || '');
assert.equal(uri.hostname, 'mongo'); assert.match(uri.pathname, /^\/ai_usage_receipts_fixture_[a-zA-Z0-9_]+$/);
assert.equal(process.env.DRAGONFLY_HOST, 'redis'); assert.equal(process.env.DRAGONFLY_PORT, '6379');
assert.match(process.argv[2] || '', /^\/tmp\/ai-usage-fixture-[0-9]+-[0-9]+\.json$/);
process.env.OBSERVABILITY_DISABLED = 'true';
globalThis.fetch = async () => { throw new Error('External providers forbidden in AI usage reference'); };
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const require = createRequire('/app/package.json'), mongoose = require('mongoose');
mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
let redis;
try {
    await getMongoDBConnection('AiUsageIsolatedReference'); redis = await getDragonflyClient('AiUsageIsolatedReference');
    const ledger = await import('/app/dist/utils/ai_usage_ledger.js');
    let result;
    if (input.mode === 'persist') {
        result = [];
        for (const { raw, tier } of input.receipts) {
            const receipt = ledger.parseQueuedAiUsageReceipt(raw);
            result.push(receipt ? { parsed: receipt, status: await ledger.persistAiUsageReceipt(receipt, tier) } : { parsed: null, status: 'invalid' });
        }
    } else if (input.mode === 'backfill') {
        console.log('AI_USAGE_BACKFILL_START');
        await ledger.backfillAiUsageLedger({ ...input.request, coverageStart: new Date(input.request.coverageStart),
            rebuildStart: input.request.rebuildStart ? new Date(input.request.rebuildStart) : undefined, now: new Date(input.now) });
        result = { backfilled: true };
    } else if (input.mode === 'dashboard') {
        const { computeDashboard } = await import('/app/dist/utils/ai_usage_dashboard.js');
        result = await computeDashboard(input.request, new Date(input.now));
    } else if (input.mode === 'refresh') {
        const { refreshAiUsageDashboards } = await import('/app/dist/utils/ai_usage_dashboard.js');
        result = await refreshAiUsageDashboards();
    } else if (input.mode === 'health') {
        const { monitorAiUsageQueues } = await import('/app/dist/utils/ai_usage_queue_health.js');
        result = await monitorAiUsageQueues(redis, input.now);
    } else if (input.mode === 'hold-lock') {
        const { withAiUsageLock } = await import('/app/dist/utils/ai_usage_lock.js');
        result = await withAiUsageLock(input.channelID, input.customerId, async () => {
            console.log('AI_USAGE_LOCK_HELD');
            await new Promise(resolve => setTimeout(resolve, input.holdMs)); return { released: true };
        });
    } else throw new Error('Unsupported isolated TypeScript reference mode');
    console.log('AI_USAGE_REFERENCE:' + JSON.stringify(result));
} finally {
    await mongoose.disconnect();
    if (redis?.isOpen) redis.destroy();
}
