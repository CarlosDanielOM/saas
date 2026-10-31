#![cfg(feature = "bot-runtime-metrics")]
#[path = "support/bot_runtime_metrics_support.rs"] mod support;
use dima_rust::utils::observability::bot_runtime_metrics::{BotRuntimeMetrics,Config,SemanticMemory,StreamMemoryJob,StreamMemoryAction};
use serde_json::Value;
use std::process::Command;

// A dedicated disposable Redis fixture is required. Do not run against shared data.
#[tokio::test]
#[ignore = "requires task-owned isolated Redis and installed TypeScript source oracle"]
async fn source_oracle_and_runtime_snapshot() {
    let mut conn=support::isolated_connection().await;
    let unique=format!("bot-metrics-test:{}",std::process::id());
    let mut config=Config::default(); config.prefix=unique.clone(); config.history_limit=2;
    let metrics=BotRuntimeMetrics::new(conn.clone(),config);
    let now=1767225600000;
    metrics.semantic_memory(&SemanticMemory {channel_id:"42".into(),requested:3.5,retrieved:-2.0,latency_ms:12.4,avg_score:0.2345,failed:true,pass:"first".into()},now).await.unwrap();
    metrics.stream_memory_job(&StreamMemoryJob {channel_id:"42".into(),latency_ms:5.5,failed:true,status:"done".into(),job_type:"summary".into(),source:"manual".into()},now).await.unwrap();
    metrics.stream_memory_action(&StreamMemoryAction {channel_id:"42".into(),action:"save".into(),source:"manual".into(),count:2.5},now).await.unwrap();
    let output=Command::new("node").arg(concat!(env!("CARGO_MANIFEST_DIR"),"/tests/fixtures/bot_runtime_metrics_reference.cjs")).output().unwrap(); assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    let oracle:Vec<Vec<Value>>=serde_json::from_slice(&output.stdout).unwrap();
    for op in oracle { let key=op[1].as_str().unwrap().replacen("metrics:bot",&unique,1); match op[0].as_str().unwrap() {
        "HINCRBY" | "HSET" => { let field=op[2].as_str().unwrap(); let expected=op[3].as_str().map(str::to_owned).unwrap_or_else(|| op[3].to_string()); let actual:String=redis::cmd("HGET").arg(&key).arg(field).query_async(&mut conn).await.unwrap(); assert_eq!(actual,expected,"{key} {field}"); },
        "EXPIRE" => { let ttl:i64=redis::cmd("TTL").arg(&key).query_async(&mut conn).await.unwrap(); assert!((86395..=86400).contains(&ttl),"{key}: {ttl}"); }, _=>panic!("unexpected command") } }
    metrics.observe_eventsub_notification("chat",42.0); metrics.start_message_handler(); metrics.end_message_handler(true); metrics.record_embedding_batch_result(4.0,true); metrics.flush_at(now).await.unwrap();
    let latest:String=redis::cmd("GET").arg(format!("{unique}:runtime:latest")).query_async(&mut conn).await.unwrap(); let snapshot:Value=serde_json::from_str(&latest).unwrap(); assert_eq!(snapshot["window"]["eventsubNotifications"],1); assert_eq!(snapshot["window"]["messageHandlerErrors"],1); assert_eq!(snapshot["window"]["embeddingMessagesProcessed"],4);
    metrics.flush_at(now).await.unwrap(); metrics.flush_at(now).await.unwrap(); let len:i64=redis::cmd("LLEN").arg(format!("{unique}:runtime:history")).query_async(&mut conn).await.unwrap(); assert_eq!(len,2);
    let n:i64=redis::cmd("HGET").arg(format!("{unique}:runtime:cumulative")).arg("eventsubNotifications").query_async(&mut conn).await.unwrap(); assert_eq!(n,1);
    // The fixture is task-owned; remove only the keys this test created.
    let keys:Vec<String>=redis::cmd("KEYS").arg(format!("{unique}:*")).query_async(&mut conn).await.unwrap(); if !keys.is_empty() { let _:i64=redis::cmd("DEL").arg(keys).query_async(&mut conn).await.unwrap(); }
}

#[tokio::test]
#[ignore = "requires dedicated disposable Redis and TypeScript source oracle"]
async fn runtime_oracle_reset_order_and_private_failure_paths() {
    let mut c=support::isolated_connection().await;
    let prefix=format!("bot-metrics-failure:{}",std::process::id());
    let mut config=Config::default(); config.prefix=prefix.clone();
    let m=BotRuntimeMetrics::new(c.clone(),config);
    let now=1767225600000;
    let output=Command::new("node").arg(concat!(env!("CARGO_MANIFEST_DIR"),"/tests/fixtures/bot_runtime_metrics_reference.cjs")).arg("runtime").output().unwrap();
    assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    let oracle:Vec<Vec<Value>>=serde_json::from_slice(&output.stdout).unwrap();
    let first:Vec<_>=oracle.iter().take_while(|op|op[0]!="SET" || op[2]["window"]["eventsubNotifications"]!=0).collect();
    let names:Vec<_>=first.iter().map(|op|op[0].as_str().unwrap()).collect();
    assert_eq!(&names[..4], &["SET","LPUSH","LTRIM","EXPIRE"]);
    let fields:Vec<_>=first.iter().filter(|op|op[0]=="HINCRBY" && op[1]=="metrics:bot:runtime:cumulative").map(|op|op[2].as_str().unwrap()).collect();
    assert_eq!(fields,vec!["eventsubNotifications","eventsubNotificationBytes","eventsubHandled","eventsubHandleErrors","messageHandlerStarted","messageHandlerCompleted","messageHandlerErrors","embeddingEnqueued","embeddingBatchesSuccess","embeddingBatchesFailed","embeddingMessagesProcessed","redisOpsEstimated","openrouterEmbeddingRequests","openrouterEmbeddingErrors","openrouterEmbeddingInputChars"]);
    m.observe_eventsub_notification("",42.0); m.observe_eventsub_notification("channel.raid",-5.0); m.start_message_handler(); m.end_message_handler(true); m.record_embedding_batch_result(4.0,true); m.record_redis_ops_estimate(2.5);
    m.flush_at(now).await.unwrap();
    let raw:String=redis::cmd("GET").arg(format!("{prefix}:runtime:latest")).query_async(&mut c).await.unwrap(); let snapshot:Value=serde_json::from_str(&raw).unwrap();
    for (key, expected) in oracle[0][2]["window"].as_object().unwrap() { if expected.is_number() {assert_eq!(snapshot["window"][key].as_f64(),expected.as_f64(),"{key}");} else {assert_eq!(&snapshot["window"][key],expected,"{key}");} }
    for (key, expected) in oracle[0][2]["totals"].as_object().unwrap() { if expected.is_number() {assert_eq!(snapshot["totals"][key].as_f64(),expected.as_f64(),"{key}");} else {assert_eq!(&snapshot["totals"][key],expected,"{key}");} }
    let minute=format!("{prefix}:eventsub:minute:202601010000");
    for field in ["total","unknown","channel.raid"] { let expected=first.iter().find(|op|op[0]=="HINCRBY" && op[1]=="metrics:bot:eventsub:minute:202601010000" && op[2]==field).unwrap()[3].as_i64().unwrap(); let actual:i64=redis::cmd("HGET").arg(&minute).arg(field).query_async(&mut c).await.unwrap(); assert_eq!(actual,expected); }
    m.flush_at(now).await.unwrap(); let raw:String=redis::cmd("GET").arg(format!("{prefix}:runtime:latest")).query_async(&mut c).await.unwrap(); let reset:Value=serde_json::from_str(&raw).unwrap(); assert_eq!(reset["window"]["eventsubNotifications"],0); assert_eq!(reset["window"]["eventsubByType"],serde_json::json!({}));
    // Wrong-type cumulative key fails after SET/LPUSH/LTRIM, before minute hashes.
    let fail_prefix=format!("{prefix}:partial"); let mut cfg=Config::default(); cfg.prefix=fail_prefix.clone(); let failing=BotRuntimeMetrics::new(c.clone(),cfg);
    let _:()=redis::cmd("SET").arg(format!("{fail_prefix}:runtime:cumulative")).arg("wrong-type").query_async(&mut c).await.unwrap();
    failing.observe_eventsub_notification("x",1.0); assert!(failing.flush_at(now).await.is_err());
    let history:i64=redis::cmd("LLEN").arg(format!("{fail_prefix}:runtime:history")).query_async(&mut c).await.unwrap(); assert_eq!(history,1);
    let exists:bool=redis::cmd("EXISTS").arg(format!("{fail_prefix}:eventsub:minute:202601010000")).query_async(&mut c).await.unwrap(); assert!(!exists);
    let _:i64=redis::cmd("DEL").arg(format!("{fail_prefix}:runtime:cumulative")).query_async(&mut c).await.unwrap(); failing.flush_at(now).await.unwrap();
    let count:i64=redis::cmd("HGET").arg(format!("{fail_prefix}:runtime:cumulative")).arg("eventsubNotifications").query_async(&mut c).await.unwrap(); assert_eq!(count,0);
    let semantic_bad=format!("{fail_prefix}:semantic:channel:42:minute:202601010000"); let _:()=redis::cmd("SET").arg(&semantic_bad).arg("wrong-type").query_async(&mut c).await.unwrap();
    assert!(failing.semantic_memory(&SemanticMemory {channel_id:"42".into(),requested:2.0,..Default::default()},now).await.is_err());
    let first_key=format!("{fail_prefix}:semantic:minute:202601010000"); let requests:i64=redis::cmd("HGET").arg(&first_key).arg("requests").query_async(&mut c).await.unwrap(); assert_eq!(requests,1);
    let ttl:i64=redis::cmd("TTL").arg(&first_key).query_async(&mut c).await.unwrap(); assert_eq!(ttl,-1);
    let frac_prefix=format!("{prefix}:fraction"); let mut cfg=Config::default(); cfg.prefix=frac_prefix.clone(); let frac=BotRuntimeMetrics::new(c.clone(),cfg); frac.observe_eventsub_notification("x",1.5); assert!(frac.flush_at(now).await.is_err());
    let n:i64=redis::cmd("HGET").arg(format!("{frac_prefix}:runtime:cumulative")).arg("eventsubNotifications").query_async(&mut c).await.unwrap(); assert_eq!(n,1);
    let present:bool=redis::cmd("HEXISTS").arg(format!("{frac_prefix}:runtime:cumulative")).arg("eventsubHandled").query_async(&mut c).await.unwrap(); assert!(!present);
    let keys:Vec<String>=redis::cmd("KEYS").arg(format!("{prefix}:*")).query_async(&mut c).await.unwrap(); if !keys.is_empty() {let _:i64=redis::cmd("DEL").arg(keys).query_async(&mut c).await.unwrap();}
}

#[tokio::test]
#[ignore = "requires dedicated disposable Redis"]
async fn owned_sampler_and_loop_shutdown_and_cancellation() {
    let mut c=support::isolated_connection().await; let prefix=format!("bot-metrics-lifecycle:{}",std::process::id()); let mut cfg=Config::default(); cfg.prefix=prefix.clone(); cfg.interval=std::time::Duration::from_secs(60);
    let m=BotRuntimeMetrics::new(c.clone(),cfg); let task=m.start().unwrap(); assert!(m.start().is_none());
    tokio::time::sleep(std::time::Duration::from_millis(70)).await; m.flush().await.unwrap();
    let raw:String=redis::cmd("GET").arg(format!("{prefix}:runtime:latest")).query_async(&mut c).await.unwrap(); let value:Value=serde_json::from_str(&raw).unwrap(); assert!(value["tokioSchedulingDelay"]["samples"].as_u64().unwrap()>0); assert!(value["memory"]["rssBytes"].as_u64().unwrap()>0);
    drop(task); let mut restarted=m.start().unwrap(); m.start_message_handler(); restarted.shutdown().await.unwrap(); assert!(m.start().is_some());
    let raw:String=redis::cmd("GET").arg(format!("{prefix}:runtime:latest")).query_async(&mut c).await.unwrap(); let value:Value=serde_json::from_str(&raw).unwrap(); assert_eq!(value["window"]["messageHandlerStarted"],1);
    let keys:Vec<String>=redis::cmd("KEYS").arg(format!("{prefix}:*")).query_async(&mut c).await.unwrap(); if !keys.is_empty() {let _:i64=redis::cmd("DEL").arg(keys).query_async(&mut c).await.unwrap();}
}
