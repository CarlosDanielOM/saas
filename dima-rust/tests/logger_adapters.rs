#![cfg(feature = "logger-redis")]

//! Only run explicitly against the task-owned disposable Dragonfly fixture.
//! Never loads application env files or uses production connection helpers.
use dima_rust::utils::logger::{
    CacheRecord, CacheSink, Destination, Level, LogOptions, Logger, LoggerConfig, SinkFuture,
    SinkHandles, SystemClock, UuidSource, redis::RedisCacheSink,
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

struct AuditSink {
    inner: RedisCacheSink,
    records: Mutex<Vec<CacheRecord>>,
}
impl CacheSink for AuditSink {
    fn store(&self, record: CacheRecord) -> SinkFuture<'_> {
        self.records.lock().unwrap().push(record.clone());
        self.inner.store(record)
    }
}
fn calls(info: &str, command: &str) -> u64 {
    info.lines()
        .find_map(|line| {
            line.strip_prefix(&format!("cmdstat_{command}:calls="))
                .and_then(|rest| rest.split(',').next())
                .and_then(|value| value.parse().ok())
        })
        .unwrap_or(0)
}

#[tokio::test]
#[ignore = "requires explicit task-owned disposable Dragonfly fixture"]
async fn real_cache_writes_preserve_payload_ttl_and_use_only_set() {
    let url = std::env::var("LOGGER_FIXTURE_REDIS_URL").expect("explicit fixture URL required");
    assert_eq!(
        url, "redis://logger-redis-fixture:6379",
        "only task-owned fixture alias accepted"
    );
    let namespace =
        std::env::var("LOGGER_FIXTURE_NAMESPACE").expect("explicit fixture namespace required");
    assert!(namespace.starts_with("logger-fixture-") && namespace.len() < 70);
    assert!(
        namespace
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    );
    let client = redis::Client::open(url).unwrap();
    let mut raw = redis::aio::ConnectionManager::new(client).await.unwrap();
    let sink = Arc::new(AuditSink {
        inner: RedisCacheSink::new(raw.clone(), Duration::from_secs(2)).unwrap(),
        records: Mutex::new(Vec::new()),
    });
    let logger = Logger::new(
        LoggerConfig::default(),
        SinkHandles {
            cache: Some(sink.clone()),
            ..Default::default()
        },
        Arc::new(SystemClock),
        Arc::new(UuidSource),
    )
    .unwrap();
    let before: String = redis::cmd("INFO")
        .arg("commandstats")
        .query_async(&mut raw)
        .await
        .unwrap();
    for index in 0..32 {
        let report = logger
            .log(
                Level::Warn,
                json!({"function":"logger.fixture", "index":index, "message":"cache diagnostic"}),
                LogOptions {
                    destination: Destination::Cache,
                    channel_id: Some(namespace.clone()),
                    ..Default::default()
                },
            )
            .await;
        assert!(report.success(), "{report:?}");
    }
    let after: String = redis::cmd("INFO")
        .arg("commandstats")
        .query_async(&mut raw)
        .await
        .unwrap();
    let records = sink.records.lock().unwrap().clone();
    let keys: Vec<String> = records.iter().map(|record| record.key.clone()).collect();
    assert_eq!(
        keys.iter().collect::<std::collections::HashSet<_>>().len(),
        32
    );
    // This fixture server has no other writers. Verify the command reduction
    // without MONITOR or access to any production command stream.
    assert_eq!(calls(&after, "set") - calls(&before, "set"), 32);
    assert_eq!(calls(&after, "expire") - calls(&before, "expire"), 0);
    for (index, record) in records.iter().enumerate() {
        assert!(
            record
                .key
                .starts_with(&format!("logger:twitch:{namespace}:warn:"))
        );
        let value: String = redis::cmd("GET")
            .arg(&record.key)
            .query_async(&mut raw)
            .await
            .unwrap();
        let parsed: Value = serde_json::from_str(&value).unwrap();
        assert_eq!(parsed["data"]["index"], index);
        assert_eq!(parsed["channelId"], namespace);
        assert_eq!(parsed["platform"], "twitch");
        assert_eq!(parsed["level"], "warn");
        let ttl: i64 = redis::cmd("TTL")
            .arg(&record.key)
            .query_async(&mut raw)
            .await
            .unwrap();
        assert!((604_790..=604_800).contains(&ttl), "TTL was {ttl}");
    }
    let deleted: usize = redis::cmd("DEL")
        .arg(&keys)
        .query_async(&mut raw)
        .await
        .unwrap();
    assert_eq!(deleted, keys.len());
    assert!(logger.shutdown(Duration::from_secs(1)).await.drained);
}
