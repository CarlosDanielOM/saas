import { runWorker } from './worker_loop.js';

const INTERVAL_MS = 5_000;

await runWorker<{ events: number; failed: boolean; more: boolean }>({
    name: 'tts-usage', prefix: 'tts_usage', batchMetric: 'batch_lines',
    dryRun: 'Voice usage: sends each OpenRouter voice line to Polar once OpenRouter reports what it charged',
    // Every row stays in MongoDB until Polar has its event, so a failed pass is simply retried.
    onFailure: 'retry',
    // A pass makes at most 25 five-second lookups and 25 Polar calls.
    watchdogMs: 10 * 60_000,
    async setup() {
        const [
            { getMongoDBConnection }, { default: TtsUsagePending }, { sendTtsUsageEvent }, { flushPolarSHEventQueue },
            { error: logError, info: logInfo }, usage,
        ] = await Promise.all([
            import('../utils/databases/mongodb.database.js'), import('../schemas/tts_usage_pending.schema.js'), import('../utils/tts_usage.js'),
            import('../utils/polarsh.js'), import('../utils/logger.js'), import('../utils/tts/tts_provider_cost.js'),
        ]);
        await getMongoDBConnection('tts-usage');
        const deps: import('../utils/tts/tts_provider_cost.js').TtsUsageDeliveryDependencies = {
            async claimDue(now, leaseUntil) {
                const row = await TtsUsagePending.findOneAndUpdate(
                    { nextAttemptAt: { $lte: now } },
                    { $set: { nextAttemptAt: leaseUntil }, $inc: { attempts: 1 } },
                    { sort: { nextAttemptAt: 1 }, new: true }
                ).lean();
                return row ? {
                    id: String(row._id), entryId: row.entryId, channelID: row.channelID, customerId: row.customerId, provider: row.provider,
                    backend: row.backend, generationId: row.generationId, bytes: row.bytes, characters: row.characters, credits: row.credits,
                    usage: row.usage ?? {}, occurredAt: new Date(row.occurredAt), attempts: row.attempts, queued: row.queued === true
                } : null;
            },
            async reschedule(id, at, lastError) {
                await TtsUsagePending.updateOne({ _id: id }, { $set: { nextAttemptAt: at, lastError } });
            },
            async markQueued(id, at, lastError) {
                await TtsUsagePending.updateOne({ _id: id }, { $set: { queued: true, nextAttemptAt: at, lastError } });
            },
            async remove(id) {
                await TtsUsagePending.deleteOne({ _id: id });
            },
            lookupGeneration: generationId => usage.lookupOpenRouterGeneration(generationId),
            async send(row, costUsd) {
                const result = await sendTtsUsageEvent({ customerId: row.customerId, channelID: row.channelID, entryId: row.entryId,
                    provider: row.provider, credits: row.credits, characters: row.characters, usage: row.usage }, costUsd);
                return { recorded: !result.error, queued: result.error && result.queued === true, message: result.message };
            },
            async flush(row) {
                const result = await flushPolarSHEventQueue(row.channelID);
                return { recorded: !result.error, message: result.message };
            },
            log: (level, message, details) => {
                const entry = { worker: 'tts_usage', message, ...details };
                return (level === 'error' ? logError(entry, { destination: 'both' }) : logInfo(entry, { destination: 'console' })).then(() => undefined);
            },
            now: () => Date.now(),
        };
        return {
            pass: () => usage.runTtsUsagePass(deps),
            delayMs: outcome => outcome?.more && !outcome.failed ? 0 : INTERVAL_MS,
            async health() {
                const [backlog, queued, oldest] = await Promise.all([
                    TtsUsagePending.estimatedDocumentCount(),
                    TtsUsagePending.countDocuments({ queued: true }),
                    TtsUsagePending.findOne({}, { occurredAt: 1 }).sort({ occurredAt: 1 }).lean(),
                ]);
                return { backlog_lines: backlog, queued_lines: queued, oldest_age_ms: oldest ? Date.now() - new Date(oldest.occurredAt).getTime() : null };
            },
        };
    },
});
