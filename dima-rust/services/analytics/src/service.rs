use crate::{Error,Result,store::Store};
use dima_core::Clock;
use dima_store::dragonfly::{Dragonfly,DragonflyConfig};
use serde_json::{Value as V,json};
use std::{collections::{HashMap,VecDeque},sync::Arc,time::Duration};
use tokio::sync::Mutex;
use tokio_postgres::types::ToSql;
use sha2::{Digest,Sha256};
#[derive(Clone)]
pub struct Config {pub database_url:String,pub redis_url:String,pub owner_id:String,pub mongo_url:Option<String>,pub qdrant_url:Option<String>,pub qdrant_key:Option<String>,pub hoststats_url:Option<String>,pub collectors:bool}
pub struct State {pub config:Config,pub store:Store,pub redis:Dragonfly,pub clock:Arc<dyn Clock>,pub health:Mutex<V>,limits:Mutex<HashMap<String,(i64,u32)>>,names:Mutex<VecDeque<(String,V,i64)>>,draining:Mutex<()>,http:dima_http::HttpClient,twitch:dima_http::Provider}
pub async fn build(config:Config,clock:Arc<dyn Clock>,shutdown:dima_core::Shutdown)->Result<dima_web::App<State>> {
 if config.owner_id.is_empty()||!config.owner_id.bytes().all(|b|b.is_ascii_digit()){return Err(Error::Config);}
 let url=url::Url::parse(&config.redis_url).map_err(|_|Error::Config)?;
 if url.scheme()!="redis"{return Err(Error::Config);}
 let authority=config.redis_url.strip_prefix("redis://").and_then(|s|s.split('/').next()).ok_or(Error::Config)?;
 let (host,port)=authority.rsplit_once(':').unwrap_or((authority,"6379"));
 let mut rc=DragonflyConfig::from_env_values(Some(host),Some(&format!("{port}{}",url.path())),"analytics");rc.connect_timeout=Duration::from_secs(3);
 let redis=Dragonfly::connect(rc,Default::default()).await?;
 let store=Store::connect(&config.database_url).await?;store.migrate(clock.now_ms()).await?;
 let http=dima_http::HttpClient::builder().clock(clock.clone()).shutdown(shutdown).build()?;
 let twitch=dima_http::Provider::builder("twitch-validate","https://id.twitch.tv").timeout(Duration::from_secs(3)).max_bytes(16384).build().map_err(|_|Error::Config)?;
 let mut root=dima_web::Router::new();root.middleware(dima_web::body::json().limit(16384));root.middleware(handle);root.on_error(|error:dima_web::Error,_req:&mut dima_web::Req<State>|Box::pin(async move{reply(error.status().filter(|n|(400..500).contains(n)).unwrap_or(503),json!({"message":error.message()}))}));
 dima_web::App::new(root,State{config,store,redis,clock,health:Mutex::new(json!({"ingestedAt":null,"invalidBatches":0,"ingestionErrors":0,"collectorError":false})),limits:Default::default(),names:Default::default(),draining:Default::default(),http,twitch}).map_err(|_|Error::Config)
}
fn reply(status:u16,body:V)->dima_web::Response{match http::Response::builder().status(status).header("content-type","application/json; charset=utf-8").header("cache-control","no-store").body(dima_web::Body::from(dima_text::to_js_json(&body))){Ok(r)=>dima_web::Response::from_http(r),Err(_)=>dima_web::Response::status(500).end()}}
fn denied(status:u16,message:&str)->(u16,V){(status,json!({"message":message}))}
async fn handle(req:&mut dima_web::Req<State>)->dima_web::Response{let result=route(req).await.unwrap_or_else(|_|denied(503,"Analytics is temporarily unavailable"));reply(result.0,result.1)}
fn list(v:&V)->Vec<String>{v.as_array().into_iter().flatten().filter_map(|v|v.as_str().map(str::to_owned)).collect()}
fn normalize(v:&mut V){match v{V::Object(m)=>for(k,v)in m{if matches!(k.as_str(),"at"|"expires_at"|"updated_at"|"last_at")&&let Some(ms)=v.as_str().and_then(dima_text::parse_date){*v=json!(dima_text::to_iso_string(ms));}else{normalize(v);}},V::Array(a)=>for v in a{normalize(v);},_=>{}}}
impl State {
 pub async fn rows(&self,sql:&str,args:&[&(dyn ToSql+Sync)])->Result<Vec<V>>{let mut out=Vec::new();for row in self.store.query(&format!("SELECT row_to_json(r)::jsonb FROM ({sql}) r"),args).await?{let mut v:V=row.try_get(0)?;normalize(&mut v);out.push(v);}Ok(out)}
 pub async fn drain(&self)->Result<()>{let Ok(_guard)=self.draining.try_lock()else{return Ok(())};for _ in 0..10{
 let raw:Option<Vec<u8>>=self.redis.query(redis::cmd("LINDEX").arg("observability:v1:processing").arg(0)).await?;
 let raw=match raw {Some(raw)if !raw.is_empty()=>Some(raw),_=>self.redis.query(redis::cmd("LMOVE").arg("observability:v1:inbox").arg("observability:v1:processing").arg("RIGHT").arg("LEFT")).await?};let Some(raw)=raw else{break};
 let batch=if raw.len()>256000{None}else{std::str::from_utf8(&raw).ok().and_then(|s|dima_text::parse_js_json(s,Default::default()).ok())};
 let result=match batch{Some(ref batch)=>self.store.ingest(batch,self.clock.now_ms()).await,None=>Err(Error::Invalid("Invalid JSON"))};
 let mut h=self.health.lock().await;match result{Ok(_)=>h["ingestedAt"]=json!(dima_text::to_iso_string(self.clock.now_ms())),Err(Error::Invalid(_))=>{h["invalidBatches"]=json!(h["invalidBatches"].as_u64().unwrap_or(0)+1);},Err(_)=>{h["ingestionErrors"]=json!(h["ingestionErrors"].as_u64().unwrap_or(0)+1);break;}}drop(h);
 let _:i64=self.redis.query(redis::cmd("LREM").arg("observability:v1:processing").arg(1).arg(raw)).await?;
 }Ok(())}
 pub(crate) async fn names(&self,ids:Vec<String>)->V{let now=self.clock.now_ms();let mut cache=self.names.lock().await;let mut out=serde_json::Map::new();for id in ids{if out.len()>=500{break;}if id.is_empty()||id.len()>80||!id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')||out.contains_key(&id){continue;}
 if let Some((_,name,_))=cache.iter().find(|(key,_,until)|key==&id&&*until>now){out.insert(id,name.clone());continue;}
 let name:Option<String>=self.redis.query(redis::cmd("HGET").arg(format!("accounts:twitch:{id}:data")).arg("name")).await.unwrap_or(None);
 let name=name.filter(|s|!s.is_empty()&&s.len()<=25&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'));let ttl=if name.is_some(){60000}else{15000};let name=json!(name);cache.retain(|(key,_,_)|key!=&id);cache.push_back((id.clone(),name.clone(),now+ttl));while cache.len()>1000{cache.pop_front();}out.insert(id,name);
 }V::Object(out)}
}
pub(crate) fn range(query:&V)->Option<(i32,i32)>{let minutes=query["minutes"].as_str().filter(|s|!s.is_empty()).map(dima_text::parse_number).unwrap_or(60.);if ![15.,60.,360.,1440.,10080.,43200.,525600.].contains(&minutes){return None;}Some((minutes as i32,if minutes<=60.{10}else if minutes<=1440.{60}else{3600}))}
/// Grant predicates are conjunctive with every browser filter.
pub fn scope(grant:&V,query:&V,args:&mut Vec<Box<dyn ToSql+Sync+Send>>)->String{let mut parts=Vec::new();for(field,max)in[("channel",80),("service",50),("kind",30)]{let grant_key=match field{"channel"=>"channels","service"=>"services",_=>""};let values=list(&grant[grant_key]);if !values.is_empty(){args.push(Box::new(values));parts.push(format!("{field} = ANY(${}::text[])",args.len()));}if let Some(v)=query[field].as_str().filter(|s|!s.is_empty()){args.push(Box::new(dima_text::truncate_chars(v,max).to_owned()));parts.push(format!("{field} = ${}",args.len()));}}if parts.is_empty(){String::new()}else{format!(" AND {}",parts.join(" AND "))}}
pub(crate) fn refs(args:&[Box<dyn ToSql+Sync+Send>])->Vec<&(dyn ToSql+Sync)>{args.iter().map(|p|&**p as &(dyn ToSql+Sync)).collect()}
async fn route(req:&mut dima_web::Req<State>)->Result<(u16,V)>{let s=req.state();let now=s.clock.now_ms();let path=req.path();let method=req.method().as_str();
 if path=="/health"&&matches!(method,"GET"|"HEAD"){s.store.query("SELECT 1",&[]).await?;return Ok((200,json!({"status":"ok","service":"analytics","bufferReady":true,"ingestedAt":s.health.lock().await["ingestedAt"]})));}
 let auth=req.header("authorization").unwrap_or_default();let token=auth.strip_prefix("Bearer ").unwrap_or(&auth);if token.is_empty()||token.chars().count()>2048{return Ok(denied(401,"Sign in to view analytics"));}
 let key=hex::encode(Sha256::digest(token.as_bytes()));{
 let mut limits=s.limits.lock().await;if limits.len()>2000{limits.retain(|_,(until,_)|*until>=now);}if limits.len()>=2000&&!limits.contains_key(&key){return Ok(denied(429,"Try again shortly"));}let limit=limits.entry(key.clone()).or_insert((now+60000,0));if limit.0<=now{*limit=(now+60000,0);}let old=limit.1;limit.1=limit.1.saturating_add(1);if old>=120{return Ok(denied(429,"Too many analytics queries"));}}
 let user:HashMap<String,String>=s.redis.query(redis::cmd("HGETALL").arg(format!("token:{token}"))).await?;let user=if user.get("id").is_some_and(|id|!id.is_empty()){json!(user)}else{
 let cached:Option<String>=s.redis.query(redis::cmd("GET").arg(format!("observability:v1:identity:{key}"))).await?;
 if let Some(cached)=cached{serde_json::from_str(&cached).map_err(|_|Error::Config)?}else{let response=s.http.get(&s.twitch,dima_http::Path::fixed("/oauth2/validate")).header("Authorization",&format!("OAuth {token}")).send().await?;if !response.status().is_success(){return Ok(denied(401,"Session expired"));}let validated:V=response.json().await?;if validated["user_id"].as_str().is_none_or(|s|s.is_empty()){return Ok(denied(401,"Session expired"));}let user=json!({"id":validated["user_id"],"login":validated["login"]});let expiry=validated["expires_in"].as_f64().filter(|n|*n!=0.).unwrap_or(60.).clamp(1.,60.) as i64;let _:()=s.redis.query(redis::cmd("SET").arg(format!("observability:v1:identity:{key}")).arg(dima_text::to_js_json(&user)).arg("EX").arg(expiry)).await?;user}};
 let id=user["id"].as_str().unwrap_or("");let grant=if id==s.config.owner_id{json!({"role":"owner","channels":[],"services":[]})}else{let rows=s.rows("SELECT role,channels,services,expires_at FROM analytics_grants WHERE user_id=$1 AND (expires_at IS NULL OR expires_at>now())",&[&id]).await?;let Some(grant)=rows.into_iter().next()else{return Ok(denied(403,"Analytics access has not been granted to your account"));};grant};
 let q=req.query();
 if matches!(method,"GET"|"HEAD"){
 if path=="/api/session"{return Ok((200,json!({"user":{"id":user["id"],"login":user["login"]},"grant":grant,"channelNames":s.names(list(&grant["channels"])).await})));}
 if path=="/api/overview"{return super::overview::overview(s,&grant,q,now).await;}
 if path=="/api/resources"{if !list(&grant["channels"]).is_empty(){return Ok(denied(403,"System resources require a system-wide grant"));}let Some((minutes,_))=range(q)else{return Ok(denied(400,"Unsupported time range"));};let span=minutes.min(43200);let mut args:Vec<Box<dyn ToSql+Sync+Send>>=vec![Box::new(span),Box::new(30.max((span*60+359)/360))];let scope=scope(&grant,&json!({"service":q["service"]}),&mut args);let mut rows=s.rows(&format!("SELECT at,service,name,value FROM (SELECT DISTINCT ON (service,name,floor(extract(epoch FROM at)/$2::int)) at,service,name,value FROM analytics_resources WHERE at>=now()-($1::int*interval '1 minute') AND service<>'host' AND service NOT LIKE 'container:%'{scope} ORDER BY service,name,floor(extract(epoch FROM at)/$2::int),at DESC) slots ORDER BY at DESC LIMIT 20001"),&refs(&args)).await?;let limited=rows.len()>20000;rows.truncate(20000);return Ok((200,json!({"samples":rows,"limited":limited,"status":*s.health.lock().await})));}
 if path=="/api/traces"||path.starts_with("/api/traces/")||path=="/api/logs"{if grant["role"]=="viewer"{return Ok(denied(403,"Investigator access is required"));}let detail=path.strip_prefix("/api/traces/");let logs=path=="/api/logs";let mut args:Vec<Box<dyn ToSql+Sync+Send>>=Vec::new();let base=if let Some(trace)=detail{if !crate::batch::hex(&json!(trace),32){return Ok(denied(400,"Invalid trace ID"));}args.push(Box::new(trace.to_owned()));"trace_id=$1 AND at>=now()-interval '3 days'"}else{let Some((minutes,_))=range(q)else{return Ok(denied(400,"Unsupported time range"));};args.push(Box::new(minutes.min(if logs{10080}else{4320})));"at>=now()-($1::int*interval '1 minute')"};let filters=if detail.is_some(){json!({})}else if logs{json!({"channel":q["channel"],"service":q["service"]})}else{q.clone()};let mut scope=scope(&grant,&filters,&mut args);if logs&&let Some(search)=q["search"].as_str().filter(|s|!s.is_empty()){let search=dima_text::truncate_chars(search,80).replace('\\',"\\\\").replace('%',"\\%").replace('_',"\\_");args.push(Box::new(format!("%{search}%")));scope+=&format!(" AND name ILIKE ${}",args.len());}
 let fields=if logs{"at,service,channel,level,name,trace_id,fields"}else{"at,trace_id,span_id,parent_id,service,channel,kind,name,outcome,duration,partial"};let table=if logs{"logs"}else{"spans"};let order=if detail.is_some(){"at LIMIT 501"}else{"at DESC LIMIT 100"};let mut rows=s.rows(&format!("SELECT {fields} FROM analytics_{table} WHERE {base}{scope} ORDER BY {order}"),&refs(&args)).await?;if detail.is_some()&&rows.is_empty(){return Ok(denied(404,"Trace not found in your scope"));}let partial=rows.len()>500||!list(&grant["channels"]).is_empty()||!list(&grant["services"]).is_empty()||rows.iter().any(|r|r["partial"]==true);rows.truncate(500);let names=s.names(rows.iter().filter_map(|r|r["channel"].as_str().map(str::to_owned)).collect()).await;let mut body=if logs{json!({"logs":rows,"channelNames":names})}else{json!({"spans":rows,"channelNames":names})};if detail.is_some(){body["partial"]=json!(partial);}return Ok((200,body));}
 }
 if path=="/api/grants"||path.starts_with("/api/grants/"){if grant["role"]!="owner"{return Ok(denied(403,"Only the owner can manage analytics access"));}if path=="/api/grants"&&matches!(method,"GET"|"HEAD"){let rows=s.rows("SELECT user_id,role,channels,services,expires_at,updated_at FROM analytics_grants ORDER BY updated_at DESC LIMIT 500",&[]).await?;let ids=rows.iter().flat_map(|r|{let mut ids=list(&r["channels"]);ids.push(r["user_id"].as_str().unwrap_or("").to_owned());ids}).collect();return Ok((200,json!({"grants":rows,"channelNames":s.names(ids).await})));}
 if let Some(subject)=path.strip_prefix("/api/grants/") {if method=="DELETE"{s.store.execute("DELETE FROM analytics_grants WHERE user_id=$1",&[&subject]).await?;s.store.execute("INSERT INTO analytics_audit(actor,action,subject) VALUES($1,'revoke',$2)",&[&id,&subject]).await?;return Ok((200,json!({"revoked":true})));}if method=="PUT"{return super::grants::save(s,id,subject,req.body(),now).await;}}}
 Ok(denied(404,"Analytics endpoint not found"))
}
