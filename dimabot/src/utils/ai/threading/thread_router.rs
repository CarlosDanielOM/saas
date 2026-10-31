//! Ports `thread_router.ts` scoring, resolution, fallback and metric emission.
//! It does not acquire Redis connections or read process environment.
use std::collections::HashSet;
use super::{thread_store::words, thread_types::ThreadMeta};
pub const THREAD_MATCH_THRESHOLD:f64=0.35;
pub const STICKY_THREAD_WINDOW_MS:i64=45*60*1000;
pub fn tokenize(text:&str)->Vec<String> { words(text).into_iter().filter(|s| s!="domdimabot").take(64).collect() }
pub fn lexical_similarity(a:&[String],b:&[String])->f64 {
    let a:HashSet<_>=a.iter().collect(); let b:HashSet<_>=b.iter().collect();
    if a.is_empty() || b.is_empty() { return 0.0; }
    a.intersection(&b).count() as f64 / a.len().max(b.len()) as f64
}
pub fn recency_score(last:i64,now:i64)->f64 { (1.0 - (now.saturating_sub(last).max(0) as f64 / 3_600_000.0) / 24.0).max(0.0) }
pub fn combined_score(lexical:f64,recency:f64,same_owner:bool)->f64 { lexical*0.45+recency*0.35+if same_owner {0.2} else {0.04} }
pub fn sticky(meta:&ThreadMeta,now:i64)->bool { now.saturating_sub(meta.last_activity_ts)<=STICKY_THREAD_WINDOW_MS }

use super::{thread_limits::{get_thread_limits_for_tier,ThreadLimits,ThreadPlanTier},thread_store::{ThreadStore,ThreadStoreError,iso,now_ms},thread_types::{PromptContextTurn,ThreadRole,ThreadTurn}};
pub const DEFAULT_METRICS_PREFIX:&str="metrics:bot";
pub const SEMANTIC_METRICS_TTL_SECONDS:u64=86_400;
/// Stable payload for the single threading metrics writer.
#[derive(Clone,Debug)]
pub struct ThreadRoutingMetric {pub channel_id:String,pub created:bool,pub reused:bool,pub failed:bool,pub candidate_count:i64,pub selected_score:f64,pub prompt_turns_used:i64,pub user_evictions:i64,pub channel_evictions:i64,pub latency_ms:i64}
use std::fmt;
#[derive(Debug)]
pub struct ThreadRouterError { pub original:Option<ThreadStoreError>, pub failure:ThreadStoreError }
impl fmt::Display for ThreadRouterError {fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result {if let Some(e)=&self.original {write!(f,"routing failed: {e}; fallback failed: {}",self.failure)} else {self.failure.fmt(f)}}}
impl std::error::Error for ThreadRouterError {}
impl From<ThreadStoreError> for ThreadRouterError {fn from(failure:ThreadStoreError)->Self {Self {original:None,failure}}}
#[derive(Clone,Debug)]
pub struct ResolveThreadParams {pub channel_id:String,pub user_id:String,pub username:String,pub message:String,pub plan_tier:ThreadPlanTier,pub source_message_id:Option<String>}
#[derive(Clone,Debug)]
pub struct AppendAssistantParams {pub channel_id:String,pub thread_id:String,pub message:String,pub plan_tier:ThreadPlanTier,pub source_message_id:Option<String>,pub delivered:Option<bool>}
#[derive(Debug)]
pub struct ResolvedThread {pub thread_id:String,pub created_new_thread:bool,pub selected_score:f64,pub threshold:f64,pub candidate_count:usize,pub prompt_turns_used:i64,pub limits:ThreadLimits,pub prompt_context:Vec<PromptContextTurn>,pub fallback_reason:Option<ThreadStoreError>}
#[derive(Clone)]
pub struct ThreadRouter {store:ThreadStore,metrics_prefix:String,metric_completion:Option<tokio::sync::mpsc::UnboundedSender<()>>}
impl ThreadRouter {
    /// The connection is already established; construction performs no I/O.
    pub fn new(store:ThreadStore,metrics_prefix:Option<String>)->Self { Self {store,metrics_prefix:metrics_prefix.filter(|s|!s.is_empty()).unwrap_or_else(||DEFAULT_METRICS_PREFIX.into()),metric_completion:None} }
    /// Optional observation of completion, including failed emission; routing
    /// remains fire-and-forget and does not wait for or propagate metrics.
    pub fn with_metric_completion(mut self,completion:tokio::sync::mpsc::UnboundedSender<()>)->Self {self.metric_completion=Some(completion);self}
    async fn score_thread(&self,meta:&ThreadMeta,p:&ResolveThreadParams,now:i64)->Result<f64,ThreadStoreError> {
        let incoming=tokenize(&p.message); let turns=self.store.get_thread_turns(&meta.channel_id,&meta.thread_id,4).await?;
        let recent=tokenize(&turns.iter().map(|t|t.message.as_str()).collect::<Vec<_>>().join(" "));
        let lexical=lexical_similarity(&incoming,&meta.topic_keywords).max(lexical_similarity(&incoming,&recent));
        Ok(combined_score(lexical,recency_score(meta.last_activity_ts,now),meta.owner_user_id==p.user_id))
    }
    pub async fn resolve_user_thread_for_message(&self,p:ResolveThreadParams)->Result<ResolvedThread,ThreadRouterError> {
        let started=now_ms(); let now=now_ms(); let limits=get_thread_limits_for_tier(p.plan_tier);
        match self.resolve_primary(&p,limits,now,started).await {
            Ok(result)=>Ok(result), Err(original)=>{
                self.record_metric(ThreadRoutingMetric {channel_id:p.channel_id.clone(),created:false,reused:false,candidate_count:0,selected_score:0.0,prompt_turns_used:limits.prompt_turns,user_evictions:0,channel_evictions:0,latency_ms:now_ms().saturating_sub(started),failed:true});
                match self.fallback_after_routing_failure(&p,limits,now).await {Ok(mut result)=>{result.fallback_reason=Some(original);Ok(result)},Err(failure)=>Err(ThreadRouterError {original:Some(original),failure})}
            }
        }
    }
    async fn resolve_primary(&self,p:&ResolveThreadParams,limits:ThreadLimits,now:i64,started:i64)->Result<ResolvedThread,ThreadStoreError> {
        let candidates=self.store.get_user_thread_candidates(&p.channel_id,&p.user_id,(limits.max_user_threads*3).max(5)).await?;
        let mut best:Option<ThreadMeta>=None; let mut score=0.0;
        if let Some(first)=candidates.first().filter(|m|sticky(m,now)) {best=Some(first.clone());score=1.0;} else {
            for candidate in &candidates {let s=self.score_thread(candidate,p,now).await?;if s>score {score=s;best=Some(candidate.clone());}}
        }
        let created=should_create_thread(best.is_some(),score);
        let selected=if created {self.store.create_thread(&p.channel_id,&p.user_id,&p.username,&p.message,now).await?} else {match best {Some(m)=>m,None=>return Err(ThreadStoreError::InvalidDate)}};
        self.store.touch_thread_indexes(&p.channel_id,&p.user_id,&selected.thread_id,now).await?;
        let context=self.store.get_thread_prompt_context(&p.channel_id,&selected.thread_id,limits.prompt_turns).await?;
        self.store.append_thread_turn(&p.channel_id,&selected.thread_id,user_turn(p,now),limits).await?;
        let (user_evictions,channel_evictions)=self.store.enforce_thread_limits(&p.channel_id,&p.user_id,limits).await?;
        self.record_metric(ThreadRoutingMetric {channel_id:p.channel_id.clone(),created,reused:!created,candidate_count:candidates.len() as i64,selected_score:score,prompt_turns_used:limits.prompt_turns,user_evictions,channel_evictions,latency_ms:now_ms().saturating_sub(started),failed:false});
        Ok(ResolvedThread {thread_id:selected.thread_id,created_new_thread:created,selected_score:score,threshold:THREAD_MATCH_THRESHOLD,candidate_count:candidates.len(),prompt_turns_used:limits.prompt_turns,limits,prompt_context:context,fallback_reason:None})
    }
    async fn fallback_after_routing_failure(&self,p:&ResolveThreadParams,limits:ThreadLimits,now:i64)->Result<ResolvedThread,ThreadStoreError> {
        let thread=self.store.create_thread(&p.channel_id,&p.user_id,&p.username,&p.message,now).await?;
        self.store.touch_thread_indexes(&p.channel_id,&p.user_id,&thread.thread_id,now).await?;
        self.store.append_thread_turn(&p.channel_id,&thread.thread_id,user_turn(p,now),limits).await?;
        Ok(ResolvedThread {thread_id:thread.thread_id,created_new_thread:true,selected_score:0.0,threshold:THREAD_MATCH_THRESHOLD,candidate_count:0,prompt_turns_used:limits.prompt_turns,limits,prompt_context:vec![],fallback_reason:None})
    }
    pub async fn append_assistant_turn_to_thread(&self,p:AppendAssistantParams)->Result<(),ThreadRouterError> {
        let now=now_ms(); let meta=self.store.get_thread_meta(&p.channel_id,&p.thread_id).await?;
        let turn=ThreadTurn {role:ThreadRole::Assistant,user_id:None,username:Some("DomDimaBot".into()),message:p.message,timestamp:now,source_message_id:p.source_message_id,delivered:p.delivered};
        self.store.append_thread_turn(&p.channel_id,&p.thread_id,turn,get_thread_limits_for_tier(p.plan_tier)).await?;
        if let Some(m)=meta.filter(|m|!m.owner_user_id.is_empty()) {self.store.touch_thread_indexes(&p.channel_id,&m.owner_user_id,&p.thread_id,now).await?;} Ok(())
    }
    fn record_metric(&self,metric:ThreadRoutingMetric) {let mut conn=self.store.connection.clone();let prefix=self.metrics_prefix.clone();let completion=self.metric_completion.clone();tokio::spawn(async move {let _=record_thread_routing_metric(&mut conn,&prefix,&metric).await;if let Some(tx)=completion {let _=tx.send(());}});}
}
pub fn should_create_thread(has_best:bool,score:f64)->bool {!has_best || score<THREAD_MATCH_THRESHOLD}
fn user_turn(p:&ResolveThreadParams,now:i64)->ThreadTurn {ThreadTurn {role:ThreadRole::User,user_id:Some(p.user_id.clone()),username:Some(p.username.clone()),message:p.message.clone(),timestamp:now,source_message_id:p.source_message_id.clone(),delivered:None}}
pub fn format_minute_bucket(timestamp:i64)->Result<String,ThreadStoreError> {let s=iso(timestamp)?; if s.len()!=24 {return Err(ThreadStoreError::InvalidDate)} Ok(format!("{}{}{}{}{}",&s[0..4],&s[5..7],&s[8..10],&s[11..13],&s[14..16]))}
/// Write the three metric hashes. Callers that need fire-and-forget semantics
/// should spawn this future and discard or separately log its error.
pub async fn record_thread_routing_metric(conn:&mut redis::aio::ConnectionManager,prefix:&str,metric:&ThreadRoutingMetric)->Result<(),ThreadStoreError> {
    let now=now_ms();let bucket=format_minute_bucket(now)?;
    let keys=[format!("{prefix}:threading:minute:{bucket}"),format!("{prefix}:threading:channel:{}:minute:{bucket}",metric.channel_id),format!("{prefix}:threading:cumulative")];
    let score=(metric.selected_score*1000.0).round().max(0.0) as i64;
    for key in &keys {
        let fields=[("requests",1),("candidateCountTotal",metric.candidate_count.max(0)),("selectedScoreMilliTotal",score),("promptTurnsTotal",metric.prompt_turns_used.max(0)),("latencyMsTotal",metric.latency_ms.max(0)),("userEvictions",metric.user_evictions.max(0)),("channelEvictions",metric.channel_evictions.max(0))];
        for (field,value) in fields {redis::cmd("HINCRBY").arg(key).arg(field).arg(value).query_async::<i64>(conn).await?;}
        for (field,enabled) in [("created",metric.created),("reused",metric.reused),("errors",metric.failed)] {if enabled {redis::cmd("HINCRBY").arg(key).arg(field).arg(1).query_async::<i64>(conn).await?;}}
    }
    redis::cmd("HSET").arg(&keys[2]).arg("updatedAt").arg(iso(now)?).query_async::<i64>(conn).await?;
    for key in &keys {redis::cmd("EXPIRE").arg(key).arg(SEMANTIC_METRICS_TTL_SECONDS).query_async::<bool>(conn).await?;} Ok(())
}
