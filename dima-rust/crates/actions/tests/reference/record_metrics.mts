// Records what the reference's bot runtime metrics (`utils/observability/bot_runtime_metrics.ts`)
// write to Dragonfly for a fixed sequence of observations, for `tests/metrics_recorded.rs`.
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC DRAGONFLY_HOST=127.0.0.1 DRAGONFLY_PORT=6379/11 \
//     BOT_METRICS_PREFIX=dima:test:actions:metrics-rec:metrics:bot \
//     node_modules/.bin/tsx /path/to/dima-rust/crates/actions/tests/reference/record_metrics.mts \
//     /path/to/dima-rust/crates/actions/tests/fixtures/metrics_recorded.json
//
// Only the metrics module is loaded (it imports the Dragonfly client and nothing else). The
// clock is frozen at NOW_MS; the snapshot flush, which the module does not export, is triggered
// the way the reference's shutdown does: `startBotRuntimeMetricsLoop()` registers it on SIGTERM
// and SIGINT, and `process.emit` calls those listeners without a signal. Every key under the
// prefix is dumped (type, lifetime, value) and deleted, also after a failure.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const NOW_MS = Date.UTC(2026, 10, 12, 9, 30, 15, 250);
const RealDate = Date;
class FrozenDate extends RealDate {
    constructor(...args: any[]) {
        if (args.length === 0) super(NOW_MS);
        else super(...(args as [any]));
    }
    static now() {
        return NOW_MS;
    }
}
Object.defineProperty(FrozenDate, 'name', { value: 'Date' });
(globalThis as any).Date = FrozenDate;

const out = process.argv[2];
if (!out) throw new Error('usage: record_metrics.mts <out.json>');
const PREFIX = 'dima:test:actions:metrics-rec:metrics:bot';
for (const [name, value] of [['TZ', 'UTC'], ['DRAGONFLY_HOST', '127.0.0.1'], ['DRAGONFLY_PORT', '6379/11'], ['BOT_METRICS_PREFIX', PREFIX]]) {
    if (process.env[name] !== value) throw new Error(`run with ${name}=${value}`);
}
const root = process.cwd();
const imported = async (file: string) => import(pathToFileURL(path.join(root, file)).href);
const { getDragonflyClient } = await imported('src/utils/databases/dragonfly.database.ts');
const cache = await getDragonflyClient('MetricsRecorder');
const settle = () => new Promise(resolve => setTimeout(resolve, 300));

const dump = async () => {
    const keys = (await cache.keys(`${PREFIX}:*`)).sort();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
        const type = await cache.type(key);
        const ttl = await cache.ttl(key);
        let value: unknown;
        if (type === 'string') value = JSON.parse(await cache.get(key));
        else if (type === 'list') value = (await cache.lRange(key, 0, -1)).map((item: string) => JSON.parse(item));
        else if (type === 'hash') value = await cache.hGetAll(key);
        result[key.slice(PREFIX.length + 1)] = { type, ttl, value };
    }
    return result;
};

try {
    for (const key of await cache.keys(`${PREFIX}:*`)) await cache.del(key);
    const m = await imported('src/utils/observability/bot_runtime_metrics.ts');
    m.startBotRuntimeMetricsLoop();
    for (let i = 0; i < 3; i++) m.observeEventsubNotification('channel.chat.message', 512);
    m.observeEventsubNotification('channel.follow', 300);
    m.observeEventsubNotification('', 5);
    m.observeEventsubNotification('channel.unheard_of.thing', 10);
    const first = m.startEventsubHandlerMetric('channel.chat.message');
    const second = m.startEventsubHandlerMetric('channel.follow');
    m.endEventsubHandlerMetric(first, false);
    m.endEventsubHandlerMetric(second, true);
    const message = m.startMessageHandlerMetric();
    m.startMessageHandlerMetric(); // left in flight
    m.endMessageHandlerMetric(message, true);
    m.observeEmbeddingQueue(7, true);
    m.recordEmbeddingEnqueued(9);
    m.recordEmbeddingBatchResult(5, true);
    m.recordEmbeddingBatchResult(3, false);
    m.recordRedisOpsEstimate(4.6);
    m.recordOpenRouterEmbeddingRequest(120);
    m.recordOpenRouterEmbeddingError();
    await m.recordSemanticMemoryMetric({ channelID: '1001', requested: 5, retrieved: 3.4, latencyMs: 12.5, avgScore: 0.8765, failed: true, pass: 'first' });
    await m.recordSemanticMemoryMetric({ channelID: '1001' });
    await m.recordThreadRoutingMetric({ channelID: '1001', candidateCount: 4, selectedScore: 0.5, promptTurnsUsed: 6, latencyMs: 30, userEvictions: 1, channelEvictions: 0, created: true, reused: false, failed: false });
    await m.recordStreamMemoryJobMetric({ channelID: '1002', latencyMs: 1500, failed: false, status: 'done', jobType: 'summary', source: 'stream_offline' });
    await m.recordStreamMemoryJobMetric({ channelID: '1002', failed: true });
    await m.recordStreamMemoryActionMetric({ channelID: '1002', action: 'insert', source: 'manual', count: 3 });
    await m.recordStreamMemoryActionMetric({ channelID: '1002', action: 'insert', count: 0 });
    process.emit('SIGTERM' as any);
    await settle();
    m.observeEventsubNotification('channel.follow', 100);
    process.emit('SIGINT' as any);
    await settle();
    const result = { nowMs: NOW_MS, prefix: PREFIX, keys: await dump() };
    writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
    console.log(`recorded ${Object.keys(result.keys).length} keys to ${out}`);
} finally {
    for (const key of await cache.keys(`${PREFIX}:*`)) await cache.del(key);
    setTimeout(() => process.exit(0), 200).unref();
}
