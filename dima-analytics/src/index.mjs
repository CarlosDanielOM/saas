import express from 'express';
import { createClient } from 'redis';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { makePool, migrate, retain, ingest, overview, scopeSql, rangeQuery } from './store.mjs';
import { createCollectors } from './collectors.mjs';

export function configFromEnv(env=process.env) {
  return { databaseUrl:env.DATABASE_URL, redisUrl:env.REDIS_URL || 'redis://dragonfly:6379', ownerId:env.OWNER_TWITCH_ID,
    mongoUrl:env.MONGO_METRICS_URI, qdrantUrl:env.QDRANT_URL, qdrantKey:env.QDRANT_API_KEY, port:Number(env.PORT||3210), collectors:env.COLLECTORS_DISABLED!=='true' };
}
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
export function createApp({pool,redis,config,health,validateToken}) {
  const app=express();
  app.disable('x-powered-by');
  app.use(express.json({limit:'16kb'}));
  app.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.get('/health',asyncRoute(async(_req,res)=>{
    await pool.query('SELECT 1');
    res.json({status:'ok',service:'analytics',bufferReady:redis.isReady,ingestedAt:health.ingestedAt});
  }));
  const limits=new Map();
  app.use(asyncRoute(async(req,res,next)=>{
    const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
    if (!token || token.length>2048) return res.status(401).json({message:'Sign in to view analytics'});
    const key=createHash('sha256').update(token).digest('hex');
    const now=Date.now(), limit=limits.get(key);
    if(limits.size>2000) for(const[k,v]of limits)if(v.until<now)limits.delete(k);
    if(limits.size>=2000&&!limit)return res.status(429).json({message:'Try again shortly'});
    if(limit&&limit.until>now&&limit.count++>=120)return res.status(429).json({message:'Too many analytics queries'});
    if(!limit||limit.until<=now)limits.set(key,{count:1,until:now+60000});
    // Use the same validated session cache as the SaaS. Never trust browser-sent user IDs.
    let user=await redis.hGetAll(`token:${token}`);
    if(!user.id){
      const cached=await redis.get(`observability:v1:identity:${key}`);
      if(cached)user=JSON.parse(cached);
      else {
        const validated=validateToken?await validateToken(token):await fetch('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:`OAuth ${token}`},signal:AbortSignal.timeout(3000)}).then(r=>r.ok?r.json():null);
        if(!validated?.user_id)return res.status(401).json({message:'Session expired'});
        user={id:validated.user_id,login:validated.login};
        await redis.set(`observability:v1:identity:${key}`,JSON.stringify(user),{EX:Math.max(1,Math.min(60,Number(validated.expires_in)||60))});
      }
    }
    req.identity={id:user.id,login:user.login};
    if(user.id===config.ownerId)req.grant={role:'owner',channels:[],services:[]};
    else req.grant=(await pool.query('SELECT role,channels,services,expires_at FROM analytics_grants WHERE user_id=$1 AND (expires_at IS NULL OR expires_at>now())',[user.id])).rows[0];
    if(!req.grant)return res.status(403).json({message:'Analytics access has not been granted to your account'});
    next();
  }));
  app.get('/api/session',(req,res)=>res.json({user:req.identity,grant:req.grant}));
  app.get('/api/overview',asyncRoute(async(req,res)=>res.json(await overview(pool,req.grant,req.query))));
  app.get('/api/resources',asyncRoute(async(req,res)=>{
    if(req.grant.channels.length)return res.status(403).json({message:'System resources require a system-wide grant'});
    const {minutes}=rangeQuery(req.query),params=[Math.min(minutes,43200)];
    const scope=scopeSql(req.grant,params,{service:req.query.service});
    const result=await pool.query(`SELECT at,service,name,value FROM analytics_resources WHERE at>=now()-($1::int*interval '1 minute')${scope} ORDER BY at DESC LIMIT 5000`,params);
    res.json({samples:result.rows,limited:result.rows.length===5000,status:health});
  }));
  const investigate=(req,res,next)=>req.grant.role==='viewer'?res.status(403).json({message:'Investigator access is required'}):next();
  app.get('/api/traces',investigate,asyncRoute(async(req,res)=>{
    const {minutes}=rangeQuery(req.query),params=[Math.min(minutes,4320)];
    const scope=scopeSql(req.grant,params,req.query);
    const rows=await pool.query(`SELECT at,trace_id,span_id,parent_id,service,channel,kind,name,outcome,duration,partial FROM analytics_spans WHERE at>=now()-($1::int*interval '1 minute')${scope} ORDER BY at DESC LIMIT 100`,params);
    res.json({spans:rows.rows});
  }));
  app.get('/api/traces/:id',investigate,asyncRoute(async(req,res)=>{
    if(!/^[a-f0-9]{32}$/.test(req.params.id))return res.status(400).json({message:'Invalid trace ID'});
    const params=[req.params.id],scope=scopeSql(req.grant,params);
    const rows=await pool.query(`SELECT at,trace_id,span_id,parent_id,service,channel,kind,name,outcome,duration,partial FROM analytics_spans WHERE trace_id=$1 AND at>=now()-interval '3 days'${scope} ORDER BY at LIMIT 501`,params);
    if(!rows.rowCount)return res.status(404).json({message:'Trace not found in your scope'});
    res.json({spans:rows.rows.slice(0,500),partial:rows.rowCount>500||req.grant.channels.length>0||req.grant.services.length>0||rows.rows.some(r=>r.partial)});
  }));
  app.get('/api/logs',investigate,asyncRoute(async(req,res)=>{
    const {minutes}=rangeQuery(req.query),params=[Math.min(minutes,10080)];
    let scope=scopeSql(req.grant,params,{channel:req.query.channel,service:req.query.service});
    if(req.query.search){params.push('%'+String(req.query.search).slice(0,80).replace(/[\\%_]/g,'\\$&')+'%');scope+=` AND name ILIKE $${params.length}`;}
    const rows=await pool.query(`SELECT at,service,channel,level,name,trace_id,fields FROM analytics_logs WHERE at>=now()-($1::int*interval '1 minute')${scope} ORDER BY at DESC LIMIT 100`,params);
    res.json({logs:rows.rows});
  }));
  const owner=(req,res,next)=>req.grant.role!=='owner'?res.status(403).json({message:'Only the owner can manage analytics access'}):next();
  app.get('/api/grants',owner,asyncRoute(async(_req,res)=>res.json({grants:(await pool.query('SELECT user_id,role,channels,services,expires_at,updated_at FROM analytics_grants ORDER BY updated_at DESC LIMIT 500')).rows})));
  app.put('/api/grants/:id',owner,asyncRoute(async(req,res)=>{
    const id=req.params.id,{role,channels,services,expiresAt}=req.body;
    if(!/^\d{1,30}$/.test(id)||id===config.ownerId||!['viewer','investigator'].includes(role)||![channels,services].every(a=>Array.isArray(a)&&a.length<=100&&a.every(v=>typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,80}$/.test(v)))
      ||(expiresAt!==null&&(!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=Date.now())))return res.status(400).json({message:'Invalid access grant'});
    const db=await pool.connect();try{await db.query('BEGIN');
      await db.query(`INSERT INTO analytics_grants(user_id,role,channels,services,expires_at,granted_by) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,channels=excluded.channels,services=excluded.services,expires_at=excluded.expires_at,granted_by=excluded.granted_by,updated_at=now()`,[id,role,channels,services,expiresAt,req.identity.id]);
      await db.query("INSERT INTO analytics_audit(actor,action,subject) VALUES($1,'grant',$2)",[req.identity.id,id]);await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    res.json({saved:true});
  }));
  app.delete('/api/grants/:id',owner,asyncRoute(async(req,res)=>{
    await pool.query('DELETE FROM analytics_grants WHERE user_id=$1',[req.params.id]);
    await pool.query("INSERT INTO analytics_audit(actor,action,subject) VALUES($1,'revoke',$2)",[req.identity.id,req.params.id]);
    res.json({revoked:true});
  }));
  app.use((_req,res)=>res.status(404).json({message:'Analytics endpoint not found'}));
  app.use((error,_req,res,_next)=>{const status=error.status>=400&&error.status<500?error.status:503;res.status(status).json({message:status===503?'Analytics is temporarily unavailable':error.message});});
  return app;
}

export async function start(config=configFromEnv()) {
  if(!config.databaseUrl||!/^\d+$/.test(config.ownerId||''))throw new Error('DATABASE_URL and OWNER_TWITCH_ID are required');
  const pool=makePool(config.databaseUrl);
  const redis=createClient({url:config.redisUrl,disableOfflineQueue:true,socket:{connectTimeout:3000}});
  redis.on('error',()=>{});
  await redis.connect();await migrate(pool);
  const health={ingestedAt:null,invalidBatches:0,ingestionErrors:0,collectorError:false};
  const collectors=createCollectors({pool,redis,config});
  const app=createApp({pool,redis,config,health});
  const server=app.listen(config.port,'0.0.0.0');
  let stopping=false,busy=false;
  const drain=async()=>{
    if(busy||stopping)return;busy=true;
    try{
      // One consumer owns the processing list; an unfinished batch survives restarts.
      for(let i=0;i<10;i++){
        let raw=await redis.lIndex('observability:v1:processing',0);
        if(!raw)raw=await redis.lMove('observability:v1:inbox','observability:v1:processing','RIGHT','LEFT');
        if(!raw)break;
        let batch;
        try{if(Buffer.byteLength(raw)>256000)throw new Error();batch=JSON.parse(raw);}
        catch{health.invalidBatches++;await redis.lRem('observability:v1:processing',1,raw);continue;}
        try{await ingest(pool,batch);health.ingestedAt=new Date().toISOString();}
        catch(error){
          if(String(error.message).startsWith('Invalid')){health.invalidBatches++;await redis.lRem('observability:v1:processing',1,raw);continue;}
          health.ingestionErrors++;break;
        }
        await redis.lRem('observability:v1:processing',1,raw);
      }
    }catch{health.ingestionErrors++;}finally{busy=false;}
  };
  const timers=[setInterval(()=>void drain(),1000)];
  if(config.collectors){const collect=()=>collectors.sample().then(()=>{health.collectorError=false;}).catch(()=>{health.collectorError=true;});timers.push(setInterval(()=>void collect(),30000));void collect();}
  timers.push(setInterval(()=>void retain(pool).catch(()=>{health.collectorError=true;}),3600000));
  const close=async()=>{stopping=true;timers.forEach(clearInterval);server.close();await collectors.close();await redis.quit().catch(()=>redis.destroy());await pool.end();};
  return {server,close,health,pool,redis};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const runtime=await start();
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void runtime.close().then(()=>process.exit(0)));
}
