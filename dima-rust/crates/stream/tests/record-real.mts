// Read-only production-copy aggregates. Mongoose autoCreate/autoIndex are disabled.
// Baseline cache writes are redirected into owned, prefixed keys in Dragonfly database 3.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const root = '/home/dom/Projects/saas/dimabot';
const require = createRequire(`${root}/package.json`);
const mongoose = require('mongoose');
const output = process.argv[2];
if (!output || !process.env.DIMA_TEST_MONGO_URI) throw new Error('output and test environment required');
process.env.SECRET_KEY = 'stream-test-only-key';
process.env.DRAGONFLY_HOST = '127.0.0.1'; process.env.DRAGONFLY_PORT = '6379/3';
const prefix = `dima_test_stream_${randomUUID()}:`;
const { getDragonflyClient } = await import(`${root}/src/utils/databases/dragonfly.database.ts`);
const cache = await getDragonflyClient('stream-real-recording');
const command = cache.sendCommand.bind(cache);
cache.set = (key: string, value: string, options: any) => command(['SET', prefix + key, value, ...(options?.EX ? ['EX', String(options.EX)] : [])]);
try {
    await mongoose.connect(process.env.DIMA_TEST_MONGO_URI, { dbName: 'domdimabot', autoIndex: false, autoCreate: false });
    const { calculateDefenseBaseline, refreshDefenseBaseline } = await import(`${root}/src/utils/follow_defense_baseline.ts`);
    const now = 1794355200000;
    const channels = await mongoose.connection.db.collection('follow_relationship_ledgers').aggregate([{ $group: { _id: '$followed_id', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 10 }]).toArray();
    const baselines = [];
    for (const channel of channels) baselines.push({ channel: channel._id, expected: await refreshDefenseBaseline(channel._id, now) });
    const days = Array.from({ length: 30 }, (_, i) => ({ day: String(i), follows: 20000 }));
    const streams = days.map(d => ({ ...d, count: 1 }));
    const pureInputs = [
        { name:'20k/day channel gets a 40k wave threshold, keeping 10k below attack', days, streams, excluded:[] },
        { name:'completed-stream average protects channels streaming less often', days:days.map(d => ({...d,follows:1000})), streams:streams.slice(0,3), excluded:[] },
        { name:'known attack days cannot train the baseline upward', days:[...days.slice(0,29),{day:'29',follows:10000000}], streams, excluded:['29','29'] },
        { name:'sparse history waits for manual attack', days:days.slice(0,6), streams:streams.slice(0,6), excluded:[] },
        { name:'two streams is insufficient', days, streams:streams.slice(0,2), excluded:[] },
        { name:'small channels have a floor', days:days.map(d=>({...d,follows:1})), streams:streams.map(d=>({...d,follows:1})), excluded:[] },
        { name:'empty channel', days:[], streams:[], excluded:[] },
        { name:'round upward', days:days.map(d=>({...d,follows:250.25})), streams:streams.map(d=>({...d,follows:0})), excluded:[] },
    ];
    const pure = pureInputs.map(i => ({ ...i, expected: calculateDefenseBaseline(i.days,i.streams,i.excluded,now) }));
    const documents = await mongoose.connection.db.collection('follow_relationship_ledgers').countDocuments();
    await writeFile(output, JSON.stringify({ now, documents, baselines, pure }, null, 2) + '\n');
    console.log(`recorded ${baselines.length} real channels from ${documents} ledger documents, ${pure.length} pure cases`);
} finally {
    await mongoose.disconnect();
    const keys = await cache.keys(prefix + '*'); if (keys.length) await cache.del(keys);
    await cache.quit();
}
