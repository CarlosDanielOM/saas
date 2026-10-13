import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { BOUNDS, ingest } from './store.mjs';

export function parseInfo(raw) {
  return Object.fromEntries(raw.split('\n').filter(line => line.includes(':')).map(line => { const i = line.indexOf(':'); return [line.slice(0,i), line.slice(i+1).trim()]; }));
}
export function parseOpenMetrics(raw) {
  const result = {};
  // Only fixed node-wide resource names. Collection labels are not summed into RAM.
  const allowed = new Set(['memory_active_bytes','memory_allocated_bytes','memory_resident_bytes','process_resident_memory_bytes','collections_total','collections_vector_total','rest_responses_fail_total']);
  for (const line of raw.split('\n')) {
    const match = /^([a-z_]+)(?:\{[^}]*\})?\s+([\d.eE+-]+)$/.exec(line.trim());
    if (match && allowed.has(match[1]) && Number.isFinite(Number(match[2]))) result[match[1]] = (result[match[1]] || 0) + Number(match[2]);
  }
  return result;
}

export function createCollectors({ pool, redis, config }) {
  let mongo;
  if (config.mongoUrl) {
    mongo = new MongoClient(config.mongoUrl, { maxPoolSize: 2, serverSelectionTimeoutMS: 2500, connectTimeoutMS: 2500, socketTimeoutMS: 3000 });
  }
  let cursor = '0', running = false;
  const latestQueues = new Map();
  async function sample() {
    if (running) return;
    running = true;
    const at = new Date(), resources = [];
    const record = (service, name, value) => { if (Number.isFinite(Number(value))) resources.push({ service, name, value: Number(value) }); };
    try {
      const tasks = [
        (async () => {
          const info = parseInfo(await redis.info());
          for (const key of ['used_memory','used_memory_rss','maxmemory','evicted_keys','expired_keys','keyspace_hits','keyspace_misses','connected_clients','instantaneous_ops_per_sec']) if (info[key] !== undefined) record('dragonfly',key,info[key]);
          record('analytics','buffer_batches',await redis.lLen('observability:v1:inbox'));
          record('analytics','buffer_dropped_batches',Number(await redis.get('observability:v1:overflow') || 0));
          record('dragonfly','collector_up',1);
        })(),
        (async () => {
          const stats = await pool.query(`SELECT pg_database_size(current_database()) AS database_bytes,
            (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()) AS connections,
            (SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='public' AND c.relkind='r') AS table_bytes`);
          for (const [key,value] of Object.entries(stats.rows[0])) record('postgres',key,value);
          record('postgres','collector_up',1);
        })(),
        (async () => {
          if (!config.qdrantUrl) return;
          const response = await fetch(`${config.qdrantUrl}/metrics`, { headers: config.qdrantKey ? { 'api-key':config.qdrantKey } : {}, signal:AbortSignal.timeout(3000) });
          if (!response.ok) throw new Error('Qdrant collector unavailable');
          for (const [key,value] of Object.entries(parseOpenMetrics(await response.text()))) record('qdrant',key,value);
          record('qdrant','collector_up',1);
        })(),
        (async () => {
          if (!mongo) return;
          const db = mongo.db();
          const [server, storage] = await Promise.all([db.admin().command({serverStatus:1}),db.command({dbStats:1,scale:1})]);
          record('mongodb','resident_bytes',(server.mem?.resident || 0)*1024*1024);
          record('mongodb','cache_bytes',server.wiredTiger?.cache?.['bytes currently in the cache']);
          record('mongodb','cache_limit_bytes',server.wiredTiger?.cache?.['maximum bytes configured']);
          record('mongodb','connections',server.connections?.current);
          for (const key of ['dataSize','storageSize','indexSize']) record('mongodb',key,storage[key]);
          record('mongodb','collector_up',1);
        })()
      ];
      const services = ['dragonfly','postgres','qdrant','mongodb'];
      const results = await Promise.allSettled(tasks);
      results.forEach((result,index)=>{if(result.status==='rejected') record(services[index],'collector_up',0);});
      record('analytics','rss_bytes',process.memoryUsage().rss);
      // Read-only incremental discovery: never KEYS or an unbounded scan of production.
      let scanned = 0;
      const queueMetrics = [];
      for (let i=0;i<4;i++) {
        const page = await redis.scan(cursor,{MATCH:'twitch:*:*:queue',COUNT:100}); cursor=String(page.cursor); scanned+=page.keys.length;
        for (const key of page.keys.slice(0,100)) {
          const match = /^twitch:([a-zA-Z0-9_-]+):(tts|clips):queue$/.exec(key);
          if (!match) continue;
          const [count,first] = await Promise.all([redis.zCard(key),redis.zRangeWithScores(key,0,0)]);
          if (latestQueues.size < 1000 || latestQueues.has(key)) latestQueues.set(key,{channel:match[1],name:match[2],seen:Date.now()});
          const age = first[0]?.score > 1e12 ? Math.max(0,Date.now()-first[0].score) : 0;
          for (const [name,value] of [[`${match[2]}.waiting`,count],[`${match[2]}.oldest_wait_ms`,age]]) queueMetrics.push(metric('queue',name,value,match[1]));
        }
        if (cursor==='0') break;
      }
      // Report empty queues once too, so an old positive depth does not look current.
      for (const [key,queue] of [...latestQueues].slice(0,100)) {
        if (Date.now()-queue.seen<10000) continue;
        const exists = await redis.exists(key);
        if (!exists) { queueMetrics.push(metric('queue',`${queue.name}.waiting`,0,queue.channel)); latestQueues.delete(key); }
        if (Date.now()-queue.seen>3600000) latestQueues.delete(key);
      }
      record('analytics','queue_keys_observed',scanned);
      if (queueMetrics.length) for(let i=0;i<queueMetrics.length;i+=100) await ingest(pool,{version:1,id:randomUUID(),service:'queues',instance:'collector',metrics:queueMetrics.slice(i,i+100),spans:[],logs:[]});
      await pool.query(`INSERT INTO analytics_resources SELECT $1,service,name,value FROM jsonb_to_recordset($2::jsonb) AS r(service text,name text,value double precision) ON CONFLICT DO NOTHING`,[at,JSON.stringify(resources)]);
    } finally { running=false; }
  }
  return { sample, close:()=>mongo?.close() };
}
function metric(kind,name,value,channel) {
  const histogram=BOUNDS.map(()=>0);histogram[Math.max(0,BOUNDS.findIndex(b=>value<=b))]=1;
  return {at:Math.floor(Date.now()/10000)*10000,kind,name,channel,outcome:'ok',count:1,sum:value,max:value,histogram};
}
