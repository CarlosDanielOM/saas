import assert from 'node:assert/strict';
import mongoose from '/app/node_modules/mongoose/index.js';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { CronJobIntentSchema as Intents } from '/app/dist/schemas/cron_job_intent.schema.js';
import { createDurableCronJobs } from '/app/dist/utils/durable_cron_jobs.js';

assert.equal(process.env.SAAS_DISPOSABLE_DOWNSTREAM_CHECK, 'yes');
assert.equal(new URL(process.env.MONGO_URI).hostname, 'mongo');
assert.equal(process.env.DRAGONFLY_HOST, 'redis');
await getMongoDBConnection('concurrent-acceptance-check');
assert.equal(mongoose.connection.name, 'saas_ops_downstream_durability_test');
const redis = await getDragonflyClient('concurrent-acceptance-check');
const queue = 'fixture:concurrent-acceptance';
const service = createDurableCronJobs();
const jobs = Array.from({ length: 32 }, (_, i) => ({
    id: `concurrent-${i}`, job: 'fixture-summary', channelID: 'fixture-concurrent',
    requestedAt: new Date().toISOString(), dedupeKey: 'fixture:concurrent',
    data: { source: 'stream_offline', sessionID: 'fixture-concurrent-session' }
}));
const accepted = await Promise.all(jobs.map(job => service.prepare(job, queue, { dedupeSeconds: 60 })));
assert.equal(accepted.filter(result => result.created).length, 1);
assert.equal(new Set(accepted.map(result => result.job.id)).size, 1);
assert.equal(await Intents.countDocuments({ queueKey: queue }), 1);
await Promise.all(accepted.map(result => service.publish(result.job, queue)));
assert.equal(await redis.lLen(queue), 1);
const claims = await Promise.all(jobs.map((job, i) => service.claim(job, queue, `owner-${i}`)));
assert.equal(claims.filter(result => result.status === 'claimed').length, 1);
const winner = claims.find(result => result.status === 'claimed');
assert.equal(await service.complete(winner.claim), true);
await redis.del(queue);
assert.equal((await service.recover(queue, { limit: 100 })).published, 0);
assert((await Promise.all(jobs.map(job => service.claim(job, queue, 'duplicate')))).every(result => result.status === 'terminal'));
console.log('PASS 32 simultaneous acceptances, publications and claims produce one durable job and no terminal replay.');
process.exit(0);
