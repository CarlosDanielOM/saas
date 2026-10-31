//! Ports `thread_store.ts` keyword extraction and Redis thread persistence.
//! Preserves keys, TTL and ordering; it does not create connections.
use std::collections::HashSet;
pub(crate) fn words(text: &str) -> Vec<String> {
    let input=crate::utils::js_string::JsString::from(text);
    let lower=crate::utils::js_unicode::lowercase(&input);
    let lower=lower.to_utf8_lossy();
    let clean:String=lower.chars().map(|ch| if crate::utils::js_compat::is_whitespace(ch) || crate::utils::js_regexp_unicode::is_letter_or_number(ch as u32) {ch} else {' '}).collect();
    clean.split(crate::utils::js_compat::is_whitespace).filter(|s| s.encode_utf16().count() >= 3).map(str::to_owned).collect()
}
pub fn extract_keywords(text: &str) -> Vec<String> {
    const STOP: &[&str]=&["the","and","that","with","this","you","que","pero","para","como","con","una","por","wow","domdimabot"];
    let mut seen=HashSet::new();
    words(text).into_iter().filter(|word| !STOP.contains(&word.as_str()) && seen.insert(word.clone())).take(12).collect()
}

use super::{thread_limits::ThreadLimits, thread_types::{PromptContextTurn,ThreadMeta,ThreadRole,ThreadStatus,ThreadTurn}};
use crate::utils::credit_policy::JsDate;
use redis::aio::ConnectionManager;
use std::fmt;
pub const THREAD_TTL_SECONDS:i64=86400;
#[derive(Debug)]
pub enum ThreadStoreError { Redis(redis::RedisError), Json(serde_json::Error), InvalidDate }
impl fmt::Display for ThreadStoreError { fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result { match self {Self::Redis(e)=>e.fmt(f),Self::Json(e)=>e.fmt(f),Self::InvalidDate=>f.write_str("Invalid time value")} } }
impl std::error::Error for ThreadStoreError {}
impl From<redis::RedisError> for ThreadStoreError { fn from(e:redis::RedisError)->Self {Self::Redis(e)} }
impl From<serde_json::Error> for ThreadStoreError { fn from(e:serde_json::Error)->Self {Self::Json(e)} }
pub(crate) fn iso(timestamp:i64)->Result<String,ThreadStoreError> { JsDate::from_millis(timestamp as f64).to_iso_string().map_err(|_|ThreadStoreError::InvalidDate) }
pub(crate) fn now_ms()->i64 { match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {Ok(d)=>d.as_millis().min(i64::MAX as u128) as i64,Err(e)=>-(e.duration().as_millis().min(i64::MAX as u128) as i64)} }
fn channel_key(c:&str)->String {format!("twitch:{c}:ai:threads:active")}
fn user_key(c:&str,u:&str)->String {format!("twitch:{c}:ai:user:{u}:threads")}
fn meta_key(c:&str,t:&str)->String {format!("twitch:{c}:ai:thread:{t}:meta")}
fn turns_key(c:&str,t:&str)->String {format!("twitch:{c}:ai:thread:{t}:turns")}
/// Invalid JSON or a value outside the typed meta contract is treated as absent.
pub fn parse_thread_meta(payload:&str)->Option<ThreadMeta> {serde_json::from_str(payload).ok()}
/// Invalid list entries are skipped before returning chronological turns.
pub fn parse_thread_turns(entries:impl IntoIterator<Item=String>)->Vec<ThreadTurn> {
    let mut turns:Vec<ThreadTurn>=entries.into_iter().filter_map(|s|serde_json::from_str(&s).ok()).collect();
    turns.reverse(); turns
}
#[derive(Clone)]
pub struct ThreadStore { pub(crate) connection:ConnectionManager }
impl ThreadStore {
    pub fn new(connection:ConnectionManager)->Self {Self{connection}}
    pub async fn get_thread_meta(&self,c:&str,t:&str)->Result<Option<ThreadMeta>,ThreadStoreError> {
        let mut conn=self.connection.clone(); let value:Option<String>=redis::cmd("GET").arg(meta_key(c,t)).query_async(&mut conn).await?;
        Ok(value.and_then(|s|parse_thread_meta(&s)))
    }
    pub async fn get_thread_turns(&self,c:&str,t:&str,limit:i64)->Result<Vec<ThreadTurn>,ThreadStoreError> {
        let mut conn=self.connection.clone(); let values:Vec<String>=redis::cmd("LRANGE").arg(turns_key(c,t)).arg(0).arg((limit-1).max(0)).query_async(&mut conn).await?;
        Ok(parse_thread_turns(values))
    }
    pub async fn create_thread(&self,c:&str,u:&str,username:&str,seed:&str,timestamp:i64)->Result<ThreadMeta,ThreadStoreError> {
        let now=iso(timestamp)?;
        let meta=ThreadMeta {thread_id:uuid::Uuid::new_v4().to_string(),channel_id:c.into(),owner_user_id:u.into(),owner_username:username.into(),created_at:now.clone(),updated_at:now,last_activity_ts:timestamp,status:ThreadStatus::Active,topic_seed:crate::utils::js_string::JsString::from_units(seed.encode_utf16().collect()).slice(0,220),topic_keywords:extract_keywords(seed),message_count:0,last_user_message:None,last_assistant_message:None};
        let mut conn=self.connection.clone(); redis::cmd("SET").arg(meta_key(c,&meta.thread_id)).arg(serde_json::to_string(&meta)?).arg("EX").arg(THREAD_TTL_SECONDS).query_async::<()>(&mut conn).await?; Ok(meta)
    }
    pub async fn append_thread_turn(&self,c:&str,t:&str,turn:ThreadTurn,limits:ThreadLimits)->Result<(),ThreadStoreError> {
        let Some(mut meta)=self.get_thread_meta(c,t).await? else {return Ok(())};
        let ts=if turn.timestamp==0 {now_ms()} else {turn.timestamp}; meta.updated_at=iso(ts)?; meta.last_activity_ts=ts; meta.message_count+=1;
        match turn.role {ThreadRole::User=>{meta.last_user_message=Some(turn.message.clone()); for word in extract_keywords(&turn.message) {if !meta.topic_keywords.contains(&word) {meta.topic_keywords.push(word)}} meta.topic_keywords.truncate(18);},ThreadRole::Assistant=>meta.last_assistant_message=Some(turn.message.clone())}
        let mut conn=self.connection.clone(); let key=turns_key(c,t);
        redis::cmd("LPUSH").arg(&key).arg(serde_json::to_string(&turn)?).query_async::<i64>(&mut conn).await?;
        redis::cmd("LTRIM").arg(&key).arg(0).arg((limits.max_turns_stored-1).max(0)).query_async::<()>(&mut conn).await?;
        redis::cmd("EXPIRE").arg(&key).arg(THREAD_TTL_SECONDS).query_async::<bool>(&mut conn).await?;
        redis::cmd("SET").arg(meta_key(c,t)).arg(serde_json::to_string(&meta)?).arg("EX").arg(THREAD_TTL_SECONDS).query_async::<()>(&mut conn).await?; Ok(())
    }
    pub async fn touch_thread_indexes(&self,c:&str,u:&str,t:&str,score:i64)->Result<(),ThreadStoreError> {
        let mut conn=self.connection.clone(); for key in [channel_key(c),user_key(c,u)] { redis::cmd("ZADD").arg(&key).arg(score).arg(t).query_async::<i64>(&mut conn).await?; }
        for key in [channel_key(c),user_key(c,u)] {redis::cmd("EXPIRE").arg(&key).arg(THREAD_TTL_SECONDS).query_async::<bool>(&mut conn).await?;} Ok(())
    }
    pub async fn remove_thread(&self,c:&str,t:&str)->Result<(),ThreadStoreError> {
        let meta=self.get_thread_meta(c,t).await?; let mut conn=self.connection.clone();
        redis::cmd("ZREM").arg(channel_key(c)).arg(t).query_async::<i64>(&mut conn).await?;
        if let Some(m)=meta.filter(|m|!m.owner_user_id.is_empty()) {redis::cmd("ZREM").arg(user_key(c,&m.owner_user_id)).arg(t).query_async::<i64>(&mut conn).await?;}
        for key in [meta_key(c,t),turns_key(c,t)] {redis::cmd("DEL").arg(key).query_async::<i64>(&mut conn).await?;} Ok(())
    }
    pub async fn get_recent_sorted_set_members(&self,key:&str,limit:i64)->Result<Vec<String>,ThreadStoreError> {
        if limit<=0 {return Ok(vec![])} let mut conn=self.connection.clone();
        let result:redis::RedisResult<Vec<String>>=redis::cmd("ZRANGE").arg(key).arg(-limit).arg(-1).query_async(&mut conn).await;
        let mut values=match result {Ok(v)=>v,Err(_)=>redis::cmd("ZRANGE").arg(key).arg(0).arg(-1).query_async(&mut conn).await?}; values.reverse(); values.truncate(limit as usize); Ok(values)
    }
    pub async fn get_oldest_sorted_set_members(&self,key:&str,count:i64)->Result<Vec<String>,ThreadStoreError> {
        if count<=0 {return Ok(vec![])} let mut conn=self.connection.clone(); Ok(redis::cmd("ZRANGE").arg(key).arg(0).arg(count-1).query_async(&mut conn).await?)
    }
    pub async fn enforce_thread_limits(&self,c:&str,u:&str,limits:ThreadLimits)->Result<(i64,i64),ThreadStoreError> {
        let mut counts=(0,0); let mut conn=self.connection.clone();
        for (index,key,limit) in [(0,user_key(c,u),limits.max_user_threads),(1,channel_key(c),limits.max_channel_threads)] {
            let count:i64=redis::cmd("ZCARD").arg(&key).query_async(&mut conn).await?;
            for t in self.get_oldest_sorted_set_members(&key,count-limit).await? {self.remove_thread(c,&t).await?; if index==0 {counts.0+=1} else {counts.1+=1}}
        } Ok(counts)
    }
    pub async fn get_user_thread_candidates(&self,c:&str,u:&str,limit:i64)->Result<Vec<ThreadMeta>,ThreadStoreError> {
        let ids=self.get_recent_sorted_set_members(&user_key(c,u),limit.max(1)).await?; let mut result=Vec::new();
        for id in ids {if let Some(m)=self.get_thread_meta(c,&id).await? {if m.status==ThreadStatus::Active {result.push(m)}}} Ok(result)
    }
    pub async fn get_thread_prompt_context(&self,c:&str,t:&str,limit:i64)->Result<Vec<PromptContextTurn>,ThreadStoreError> {
        Ok(self.get_thread_turns(c,t,limit.max(1)).await?.into_iter().map(|turn| {let assistant=turn.role==ThreadRole::Assistant; PromptContextTurn {role:turn.role,source_message_id:turn.source_message_id,timestamp:turn.timestamp,username:turn.username.filter(|s|!s.is_empty()).unwrap_or_else(||if assistant {"DomDimaBot".into()} else {"UnknownUser".into()}),message:turn.message,badges:assistant.then(||"🤖".into())}}).collect())
    }
}
