// Real frozen functions, real scratch stores, no outside services. Fixtures are generated only.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
const root = process.env.DIMABOT_DIR;
if (!root || !process.env.DIMA_TEST_MONGO_URI || !process.argv[2]) throw Error('DIMABOT_DIR, test-env and output required');
const require = createRequire(`${root}/package.json`);
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const database = `dima_test_stream_${crypto.randomUUID().replaceAll('-', '')}`;
const prefix = database + ':';
process.env.SECRET_KEY = 'scratch-only';
process.env.DRAGONFLY_HOST = '127.0.0.1'; process.env.DRAGONFLY_PORT = '6379/6';
let n = 0;
crypto.randomUUID = (() => { const x = (++n).toString(16).padStart(2,'0'); return `${x.repeat(4)}-${x.repeat(2)}-4${x.slice(1)}${x}-${((n & 63)|128).toString(16)}${x}-${x.repeat(6)}`; }) as any;
syncBuiltinESMExports();
const RealDate = Date;
let now = 1794355200000;
class FixedDate extends RealDate { constructor(...args: any[]) { super(...(args.length ? args : [now]) as [any]); } static now() { return now; } }
Object.defineProperty(FixedDate, 'name', { value: 'Date' });
const { getDragonflyClient } = await import(`${root}/src/utils/databases/dragonfly.database.ts`);
const cache = await getDragonflyClient('queue-recording');
const send = cache.sendCommand.bind(cache);
cache.exists = (...keys: any[]) => send(['EXISTS', ...keys.flat().map(k => prefix+k)]);
cache.eval = (script: string, options: any) => send(['EVAL',script,String(options.keys.length),...options.keys.map((k: string)=>prefix+k),...options.arguments]);
cache.set = (key: string, value: string) => send(['SET',prefix+key,String(value)]);
cache.expire = (key: string, ttl: number) => send(['EXPIRE',prefix+key,String(ttl)]);
globalThis.fetch = (() => { throw Error('outbound forbidden'); }) as any;
const steps: any[] = [];
try {
    await mongoose.connect(process.env.DIMA_TEST_MONGO_URI, { dbName: database });
    await import(`${root}/src/utils/durable_cron_jobs.ts`);
    globalThis.Date = FixedDate as any;
    const clips = await import(`${root}/src/utils/ai/clip_recommendations/clip_recommendations_queue.ts`);
    const memory = await import(`${root}/src/utils/ai/memory/stream_memory_queue.ts`);
    async function run(kind: string, input: any) {
        n = steps.length;
        const result = await (kind === 'clip' ? clips.enqueueClipRecommendationJob(input) : kind === 'summary' ? memory.enqueueStreamMemorySummaryJob(input) : memory.enqueueMemoryMaintenanceJob(input));
        const state: any[] = [];
        for (const key of (await cache.keys(prefix+'*')).sort()) {
            const type = await cache.type(key);
            const value = type === 'list' ? await cache.lRange(key,0,-1) : await cache.get(key);
            state.push({key:key.slice(prefix.length), type, value, ttl: await cache.ttl(key)});
        }
        const docs = await mongoose.connection.db.collection('cron_job_intents').find({}, {promoteValues:false}).sort({jobID:1}).toArray();
        const documents = docs.map((d: any) => { if (d._id?._bsontype !== 'ObjectId') throw Error('unexpected id BSON type'); const value = EJSON.serialize(d,{relaxed:false}); value._id = { $oid: `generated:${d.jobID}` }; return value; });
        steps.push({kind,input,now,result,state,documents});
    }
    await run('clip',{channelID:' ',vodUrl:'x',source:'manual'});
    await run('clip',{channelID:'x',vodUrl:' ',source:'manual'});
    for (const input of [
        {channelID:' channel ',vodUrl:' https://twitch.tv/videos/1 ',source:'manual'},
        {channelID:' channel ',streamID:' stream ',vodUrl:'url',source:'manual'},
        {channelID:' 👋שם é ',sessionID:' جلسة ',streamID:' 播放 ',vodID:' vidéo ',channel:' 名 ',vodUrl:' url ',source:'stream_offline',requestedBy:' worker ',vodDurationMinutes:42.5},
        {channelID:'future',sessionID:'s',vodUrl:'url',source:'stream_offline',notBeforeUnix:now/1000+300}
    ]) { await run('clip',input); await run('clip',input); }
    await run('summary',{channelID:''});
    for (const input of [
        {channelID:' s1 '},
        {channelID:' s2 ',sessionID:' session '},
        {channelID:' 👋שם é ',sessionID:' جلسة ',streamID:' 流 ',reason:' why ',source:' manual ',requestedBy:' who ',notBeforeUnix:now/1000+120},
        {channelID:'s3',streamID:' id ',source:'manual',reason:' '}
    ]) { await run('summary',input); await run('summary',input); }
    const periods = [];
    for (const date of ['2020-12-31T23:59:59.999Z','2021-01-01T00:00:00.000Z','2021-01-03T23:59:59.999Z','2021-01-04T00:00:00.000Z','2024-12-30T00:00:00.000Z','2026-02-28T23:59:59.999Z','2026-03-01T00:00:00.000Z']) {
        now = RealDate.parse(date);
        periods.push({now,weekly:memory.getWeeklyMaintenancePeriodToken(new Date(now)),monthly:memory.getMonthlyMaintenancePeriodToken(new Date(now))});
        for (const cadence of ['weekly','monthly']) await run('maintenance',{channelID:`period-${periods.length}`,cadence});
    }
    await run('maintenance',{channelID:' ',cadence:'weekly'});
    await run('maintenance',{channelID:' 名 👋 ',cadence:'weekly',periodToken:' custom ',reason:' r ',requestedBy:' me '});
    const dedupe = ['', ' c ', ' 👋שם é '].flatMap(channel=>[undefined,'',' s ', ' جلسة '].flatMap(session=>[undefined,'',' v ', ' 流 '].map(last=>({channel,session,last,clip:clips.getClipRecommendationDedupeKey(channel,session,last),summary:memory.getStreamMemorySummaryDedupeKey(channel,session,last),weekly:memory.getMaintenanceDedupeKey(channel,'weekly',last || ''),monthly:memory.getMaintenanceDedupeKey(channel,'monthly',last || '')}))));
    const racing = await Promise.all(Array.from({length:8},()=>memory.enqueueStreamMemorySummaryJob({channelID:'race',sessionID:'one'})));
    const race = {accepted:racing.filter(r=>r.enqueued).length, canonical:new Set(racing.map(r=>r.job?.id)).size,
        intents:await mongoose.connection.db.collection('cron_job_intents').countDocuments({'payload.channelID':'race'})};
    await writeFile(process.argv[2], JSON.stringify({steps,periods,dedupe,race},null,2)+'\n');
    console.log(`recorded ${steps.length} store scenarios, ${periods.length} boundaries, ${dedupe.length} identities`);
} finally {
    globalThis.Date = RealDate;
    if(mongoose.connection.db?.databaseName === database) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    const keys = await cache.keys(prefix+'*'); if(keys.length) await cache.del(keys);
    await cache.quit();
}
