import { createHash, randomUUID } from 'node:crypto';
import { getDragonflyClient } from './databases/dragonfly.database.js';
export async function withAiUsageLock<T>(channelID: string, customerId: string, run: () => Promise<T>): Promise<T> {
    const cache = await getDragonflyClient('AiUsageLedgerLock');
    const key = `locks:ai-usage-write:${createHash('sha256').update(JSON.stringify([channelID, customerId])).digest('hex')}`;
    const owner = randomUUID();
    const deadline = Date.now() + 10_000;
    while (await cache.set(key, owner, { NX: true, EX: 120 }) !== 'OK') {
        if (Date.now() >= deadline) throw new Error('AI usage ledger busy; retry later');
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    let lost = false;
    const heartbeat = setInterval(() => {
        void cache.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], 120) end return 0", { keys: [key], arguments: [owner] })
            .then(value => { if (Number(value) !== 1) lost = true; }).catch(() => { lost = true; });
    }, 30_000);
    heartbeat.unref();
    try {
        const result = await run();
        if (lost) throw new Error('AI usage ledger lease lost; retry required');
        return result;
    } finally {
        clearInterval(heartbeat);
        await cache.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", { keys: [key], arguments: [owner] });
    }
}
