// Benchmark runtime: compiled application JS plus actual isolated Mongo/Redis.
// Prepared by keyword_native_reference.mjs --prepare-benchmark OUTPUT_DIR.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const mongoose=require('mongoose');
const {createClient}=require('redis');
const sources=require('./sources.json');
assert.equal(process.env.KEYWORD_FIXTURE_MONGO_URI,'mongodb://keyword-mongo:27017');
assert.equal(process.env.KEYWORD_FIXTURE_REDIS_URL,'redis://keyword-redis:6379/');
const namespace=process.env.KEYWORD_FIXTURE_NAMESPACE;
assert.ok(/^keyword-fixture-[a-zA-Z0-9-]{8,40}:$/.test(namespace));
const database=namespace.slice(0,-1).replaceAll('-','_');
const channel=namespace;
const redis=createClient({url:process.env.KEYWORD_FIXTURE_REDIS_URL});
redis.on('error',()=>{});
await redis.connect();
globalThis.__keywordFixtureRedis=redis;
await mongoose.connect(`${process.env.KEYWORD_FIXTURE_MONGO_URI}/${database}`);
assert.deepEqual(await mongoose.connection.db.listCollections().toArray(),[], 'database must be unused');
const {CommandsSchema}=require('./src/schemas/commands.schema.js');
await CommandsSchema.init();
const {keywordIndexCache,getKeywordBody,refreshKeywordIndex,saveKeywordCount}=require('./src/utils/keyword_cache.js');
const {compileKeywordIndex,matchKeywords}=require('./src/utils/keywords.js');
const ids=Array.from({length:100},(_,i)=>(i+1).toString(16).padStart(24,'0'));
const rows=ids.map((id,i)=>({_id:new mongoose.Types.ObjectId(id),channelID:channel,activation:'keyword',enabled:true,cmd:`word${i}`,keywordSettings:{matchMode:'anywhere'},message:`Hello ${i}`,count:0,createdAt:new Date(0),date:{day:1,month:1,year:1970}}));
const indexKey=`keywords:index:${channel}`;
const revisionKey=`keywords:revision:${channel}`;
const bodyKey=`keywords:body:${channel}:${ids[0]}`;
assert.equal(await redis.exists([indexKey,revisionKey,bodyKey]),0);
const iterations=Number(process.env.KEYWORD_BENCH_ITERATIONS||100);
const samples=Number(process.env.KEYWORD_BENCH_SAMPLES||7);
assert.ok(Number.isSafeInteger(iterations)&&iterations>0&&Number.isSafeInteger(samples)&&samples>0);
const results=[];
try {
    await CommandsSchema.collection.insertMany(rows);
    const pure=compileKeywordIndex(rows.map(row=>({id:row._id.toString(),text:row.cmd,matchMode:'anywhere'})));
    const match=()=>matchKeywords(pure,'WORD99 word12! unrelated word99').length;
    assert.equal(match(),2);
    const operations=[
        ['index_match',async()=>match()],
        ['local_index_hit',async()=>(await keywordIndexCache.get(channel)).size],
        ['shared_index_hit',async()=>{keywordIndexCache.invalidate(channel);return(await keywordIndexCache.get(channel)).size;}],
        ['index_mongo_miss',async()=>{await redis.del(indexKey);keywordIndexCache.invalidate(channel);return(await keywordIndexCache.get(channel)).size;}],
        ['body_cache_hit',async()=>Number((await getKeywordBody(channel,ids[0])).count)],
        ['body_mongo_miss',async()=>{await redis.del(bodyKey);return Number((await getKeywordBody(channel,ids[0])).count);} ],
        ['refresh',async()=>{await refreshKeywordIndex(channel,ids[0]);return(await keywordIndexCache.get(channel)).size;}],
        ['count_write',async()=>{await saveKeywordCount(channel,ids[0],7);return 7;}],
    ];
    for(const [operation,run] of operations) {
        // Normalize setup once per operation; measured work is identical in Rust.
        await CommandsSchema.collection.updateOne({_id:rows[0]._id},{$set:{count:0}});
        await redis.del(bodyKey);
        await keywordIndexCache.get(channel);
        await getKeywordBody(channel,ids[0]);
        let checksum=0;
        for(let i=0;i<iterations;i++)checksum+=operation==='index_match'?match():await run();
        const measurements=[];
        for(let sample=0;sample<samples;sample++) {
            const cpu=process.cpuUsage();const started=process.hrtime.bigint();
            for(let i=0;i<iterations;i++)checksum+=operation==='index_match'?match():await run();
            const elapsed=process.hrtime.bigint()-started;const used=process.cpuUsage(cpu);
            measurements.push({elapsedNs:Number(elapsed),cpuUserUs:used.user,cpuSystemUs:used.system,rssBytes:process.memoryUsage().rss});
        }
        const median=measurements.map(x=>x.elapsedNs).sort((a,b)=>a-b)[Math.floor(samples/2)];
        results.push({operation,iterations,checksum,samples:measurements,medianElapsedNs:median});
    }
    assert.equal((await CommandsSchema.collection.findOne({_id:rows[0]._id})).count,7);
    console.log(JSON.stringify({implementation:'typescript',measurementProcess:'compiled-js-only',node:process.version,sources,fixtureRows:100,results}));
} finally {
    await mongoose.connection.db.dropDatabase();
    await redis.del([indexKey,revisionKey,...ids.map(id=>`keywords:body:${channel}:${id}`)]);
    await mongoose.disconnect();await redis.quit();
}
