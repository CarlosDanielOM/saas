use super::*;
use futures_util::poll;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize};

struct FixedClock;
impl Clock for FixedClock {
    fn now_millis(&self) -> i64 {
        1_793_100_600_000
    }
}
struct Counter(AtomicU64);
impl IdSource for Counter {
    fn next_id(&self) -> String {
        self.0.fetch_add(1, Ordering::Relaxed).to_string()
    }
}
#[derive(Default)]
struct Records {
    cache: Mutex<Vec<CacheRecord>>,
    console: Mutex<Vec<ConsoleRecord>>,
    metadata: Mutex<Vec<MetadataRecord>>,
    otel: Mutex<Vec<OtelRecord>>,
}
impl CacheSink for Records {
    fn store(&self, record: CacheRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            self.cache.lock().unwrap().push(record);
            Ok(())
        })
    }
}
impl ConsoleSink for Records {
    fn write(&self, record: ConsoleRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            self.console.lock().unwrap().push(record);
            Ok(())
        })
    }
}
impl MetadataSink for Records {
    fn record(&self, record: MetadataRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            self.metadata.lock().unwrap().push(record);
            Ok(())
        })
    }
}
impl OtelSink for Records {
    fn emit(&self, record: OtelRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            self.otel.lock().unwrap().push(record);
            Ok(())
        })
    }
}
fn logger(
    config: LoggerConfig,
    records: Arc<Records>,
    cache: Option<Arc<dyn CacheSink>>,
) -> Logger {
    Logger::new(
        config,
        SinkHandles {
            cache: cache.or_else(|| Some(records.clone())),
            console: Some(records.clone()),
            metadata: Some(records.clone()),
            otel: Some(records),
        },
        Arc::new(FixedClock),
        Arc::new(Counter(AtomicU64::new(0))),
    )
    .unwrap()
}
#[derive(Default)]
struct Stall {
    started: AtomicUsize,
    canceled: AtomicUsize,
}
struct CancelProbe<'a>(&'a AtomicUsize);
impl Drop for CancelProbe<'_> {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
impl CacheSink for Stall {
    fn store(&self, _record: CacheRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            let _probe = CancelProbe(&self.canceled);
            self.started.fetch_add(1, Ordering::SeqCst);
            std::future::pending().await
        })
    }
}

#[test]
fn timestamps_cover_pre_epoch_midnight_noon_and_leap_day() {
    assert_eq!(format_timestamp(-1), "12/31/1969, 11:59:59 PM");
    assert_eq!(format_timestamp(0), "1/1/1970, 12:00:00 AM");
    assert_eq!(format_timestamp(43_200_000), "1/1/1970, 12:00:00 PM");
    assert_eq!(
        format_timestamp(1_709_208_000_000),
        "2/29/2024, 12:00:00 PM"
    );
    assert_eq!(
        format_timestamp(1_793_100_600_000),
        "10/27/2026, 11:30:00 AM"
    );
}

#[tokio::test]
async fn all_levels_and_destinations_keep_payload_key_ttl_and_stream_contract() {
    for level in [
        Level::Trace,
        Level::Debug,
        Level::Info,
        Level::Warn,
        Level::Error,
        Level::Fatal,
    ] {
        for destination in [Destination::Cache, Destination::Console, Destination::Both] {
            let records = Arc::new(Records::default());
            let log = logger(LoggerConfig::default(), records.clone(), None);
            let result = log
                .log(
                    level,
                    json!({"message":"raw", "status":200}),
                    LogOptions {
                        destination,
                        ..LogOptions::default()
                    },
                )
                .await;
            assert!(result.success());
            let cache = records.cache.lock().unwrap();
            assert_eq!(
                cache.len(),
                usize::from(destination != Destination::Console)
            );
            if let Some(value) = cache.first() {
                assert_eq!(value.ttl_seconds, 604800);
                assert_eq!(
                    value.key,
                    format!("logger:twitch:global:{}:1793100600000-0", level.as_str())
                );
                let entry: Value = serde_json::from_str(&value.json).unwrap();
                assert_eq!(
                    entry,
                    json!({"data":{"message":"raw","status":200},"timestamp":"10/27/2026, 11:30:00 AM","platform":"twitch","level":level.as_str()})
                );
            }
            let console = records.console.lock().unwrap();
            assert_eq!(
                console.len(),
                usize::from(destination != Destination::Cache)
            );
            if let Some(value) = console.first() {
                assert_eq!(
                    value.stream,
                    if level.high_priority() {
                        ConsoleStream::Stderr
                    } else {
                        ConsoleStream::Stdout
                    }
                );
            }
            assert_eq!(
                records.metadata.lock().unwrap().len(),
                usize::from(level.high_priority())
            );
            assert_eq!(records.otel.lock().unwrap().len(), 1);
        }
    }
}

#[tokio::test]
async fn explicit_empty_channel_is_retained_in_json_and_defaults_in_key() {
    let records = Arc::new(Records::default());
    let log = logger(LoggerConfig::default(), records.clone(), None);
    assert!(
        log.log(
            Level::Info,
            json!(1),
            LogOptions {
                platform: Some("".into()),
                channel_id: Some("".into()),
                ..LogOptions::default()
            }
        )
        .await
        .success()
    );
    let cache = records.cache.lock().unwrap();
    assert!(cache[0].key.starts_with("logger:twitch:global:info:"));
    let entry: Value = serde_json::from_str(&cache[0].json).unwrap();
    assert_eq!(entry["channelId"], "");
}

#[tokio::test]
async fn same_millisecond_uses_unique_uuid_ids() {
    let records = Arc::new(Records::default());
    let log = Logger::new(
        LoggerConfig::default(),
        SinkHandles {
            cache: Some(records.clone()),
            console: Some(records.clone()),
            ..SinkHandles::default()
        },
        Arc::new(FixedClock),
        Arc::new(UuidSource),
    )
    .unwrap();
    for _ in 0..64 {
        assert!(
            log.log(Level::Debug, json!(null), LogOptions::default())
                .await
                .success()
        );
    }
    let cache = records.cache.lock().unwrap();
    let unique: std::collections::HashSet<_> = cache.iter().map(|v| &v.key).collect();
    assert_eq!(unique.len(), 64);
}

#[tokio::test]
async fn metadata_is_bounded_allowlisted_and_context_is_explicit() {
    let records = Arc::new(Records::default());
    let log = logger(LoggerConfig::default(), records.clone(), None);
    let options = LogOptions {
        context: Some(TraceContext {
            trace_id: Some("0123456789abcdef0123456789abcdef".into()),
            channel: Some("owner-123".into()),
        }),
        ..LogOptions::default()
    };
    assert!(log.log(Level::Warn, json!({"function":["nested",[null,true]], "step":"😀é", "operation":"ignored", "status":503, "attempt":2, "durationMs":1.5,"message":"secret", "headers":{"secret":true}, "provider":"x".repeat(100)}), options).await.success());
    let metadata = records.metadata.lock().unwrap();
    let item = &metadata[0];
    assert_eq!(item.name, "nested__true");
    assert_eq!(item.channel, "owner-123");
    assert_eq!(
        item.trace_id.as_deref(),
        Some("0123456789abcdef0123456789abcdef")
    );
    assert_eq!(item.fields["step"], "___");
    assert_eq!(item.fields["provider"].as_str().unwrap().len(), 80);
    assert!(!item.fields.contains_key("function"));
    assert!(!item.fields.contains_key("message"));
    assert!(!item.fields.contains_key("headers"));
}

#[tokio::test]
async fn filter_and_sampling_skip_lazy_payload_and_never_sample_high_severity() {
    let records = Arc::new(Records::default());
    let log = logger(
        LoggerConfig {
            min_level: Level::Info,
            sample_every: 2,
            ..LoggerConfig::default()
        },
        records.clone(),
        None,
    );
    assert_eq!(
        log.log_lazy(Level::Debug, LogOptions::default(), || panic!(
            "must not run"
        ))
        .await
        .disposition,
        Disposition::Filtered
    );
    assert!(
        log.log(Level::Info, json!(null), LogOptions::default())
            .await
            .success()
    );
    assert_eq!(
        log.log_lazy(Level::Info, LogOptions::default(), || panic!(
            "must not run"
        ))
        .await
        .disposition,
        Disposition::SampledOut
    );
    for level in [Level::Warn, Level::Error, Level::Fatal] {
        assert!(
            log.log(level, json!(null), LogOptions::default())
                .await
                .success()
        );
    }
    assert_eq!(log.stats().filtered, 1);
    assert_eq!(log.stats().sampled_out, 1);
}

#[tokio::test]
async fn payload_depth_bytes_and_escaping_are_bounded_before_sink_submission() {
    let records = Arc::new(Records::default());
    let log = logger(
        LoggerConfig {
            max_payload_bytes: 256,
            max_depth: 3,
            ..LoggerConfig::default()
        },
        records.clone(),
        None,
    );
    for data in [
        json!("x".repeat(257)),
        json!([[[[0]]]]),
        json!("\u{0000}".repeat(80)),
    ] {
        assert_eq!(
            log.log(Level::Error, data, LogOptions::default())
                .await
                .disposition,
            Disposition::InvalidPayload
        );
    }
    assert!(records.cache.lock().unwrap().is_empty());
    assert_eq!(log.stats().invalid_payload, 3);
}

#[tokio::test]
async fn stalled_cache_does_not_delay_other_sink_submission_and_times_out() {
    let records = Arc::new(Records::default());
    let stall = Arc::new(Stall::default());
    let log = logger(
        LoggerConfig {
            sink_timeout: Duration::from_millis(25),
            ..LoggerConfig::default()
        },
        records.clone(),
        Some(stall.clone()),
    );
    let future = log.log(
        Level::Error,
        json!({"operation":"test"}),
        LogOptions::default(),
    );
    tokio::pin!(future);
    assert!(poll!(&mut future).is_pending());
    assert_eq!(records.console.lock().unwrap().len(), 1);
    assert_eq!(records.metadata.lock().unwrap().len(), 1);
    assert_eq!(records.otel.lock().unwrap().len(), 1);
    let result = future.await;
    assert_eq!(result.cache, SinkStatus::TimedOut);
    assert_eq!(result.console, SinkStatus::Succeeded);
    assert_eq!(stall.canceled.load(Ordering::SeqCst), 1);
    assert_eq!(log.stats().cache_timed_out, 1);
    assert_eq!(log.stats().pending_cache_bytes, 0);
}

struct PanicCache {
    on_construction: bool,
}
impl CacheSink for PanicCache {
    fn store(&self, _record: CacheRecord) -> SinkFuture<'_> {
        assert!(!self.on_construction, "sink construction panic");
        Box::pin(async { panic!("sink polling panic") })
    }
}
struct FailingCache;
impl CacheSink for FailingCache {
    fn store(&self, _: CacheRecord) -> SinkFuture<'_> {
        Box::pin(async { Err(SinkError::Io) })
    }
}
#[tokio::test]
async fn sink_failures_and_panics_are_isolated_and_reported() {
    for cache in [
        Arc::new(PanicCache {
            on_construction: true,
        }) as Arc<dyn CacheSink>,
        Arc::new(PanicCache {
            on_construction: false,
        }),
        Arc::new(FailingCache),
    ] {
        let records = Arc::new(Records::default());
        let log = logger(LoggerConfig::default(), records.clone(), Some(cache));
        let result = log
            .log(Level::Fatal, json!("diagnostic"), LogOptions::default())
            .await;
        assert!(!result.success());
        assert!(matches!(
            result.cache,
            SinkStatus::Panicked | SinkStatus::Failed(SinkError::Io)
        ));
        assert_eq!(result.console, SinkStatus::Succeeded);
        assert_eq!(result.metadata, SinkStatus::Succeeded);
        assert_eq!(result.otel, SinkStatus::Succeeded);
        assert_eq!(log.stats().cache_failed, 1);
    }
}

#[tokio::test]
async fn call_limit_has_high_severity_reserve_and_rejects_before_lazy_creation() {
    let records = Arc::new(Records::default());
    let stall = Arc::new(Stall::default());
    let log = logger(
        LoggerConfig {
            max_pending_calls: 2,
            reserved_high_calls: 1,
            ..LoggerConfig::default()
        },
        records,
        Some(stall),
    );
    let low = log.log(Level::Info, json!(null), LogOptions::default());
    tokio::pin!(low);
    assert!(poll!(&mut low).is_pending());
    assert_eq!(
        log.log_lazy(Level::Debug, LogOptions::default(), || panic!(
            "full calls must not build"
        ))
        .await
        .disposition,
        Disposition::Dropped
    );
    let high = log.log(Level::Error, json!(null), LogOptions::default());
    tokio::pin!(high);
    assert!(poll!(&mut high).is_pending());
    assert_eq!(log.stats().active_calls, 2);
    assert_eq!(
        log.log_lazy(Level::Warn, LogOptions::default(), || panic!(
            "all slots full"
        ))
        .await
        .disposition,
        Disposition::Dropped
    );
}

#[tokio::test]
async fn cache_admission_reserves_items_and_bytes_without_blocking_other_sinks() {
    for config in [
        LoggerConfig {
            max_pending_cache_items: 2,
            reserved_high_items: 1,
            ..LoggerConfig::default()
        },
        LoggerConfig {
            max_pending_cache_bytes: 600,
            reserved_high_bytes: 400,
            ..LoggerConfig::default()
        },
    ] {
        let records = Arc::new(Records::default());
        let stall = Arc::new(Stall::default());
        let log = logger(config, records.clone(), Some(stall));
        let first = log.log(Level::Info, json!(null), LogOptions::default());
        tokio::pin!(first);
        assert!(poll!(&mut first).is_pending());
        let rejected = log
            .log(Level::Debug, json!(null), LogOptions::default())
            .await;
        assert_eq!(rejected.cache, SinkStatus::Dropped);
        assert_eq!(rejected.console, SinkStatus::Succeeded);
        let warning = log.log(Level::Warn, json!(null), LogOptions::default());
        tokio::pin!(warning);
        assert!(poll!(&mut warning).is_pending());
        assert_eq!(log.stats().pending_cache_items, 2);
        assert_eq!(log.stats().cache_dropped, 1);
    }
}

#[tokio::test]
async fn dropping_caller_future_releases_all_accounting_and_cancels_sink() {
    let stall = Arc::new(Stall::default());
    let log = logger(
        LoggerConfig::default(),
        Arc::new(Records::default()),
        Some(stall.clone()),
    );
    {
        let future = log.log(Level::Info, json!(null), LogOptions::default());
        tokio::pin!(future);
        assert!(poll!(&mut future).is_pending());
        assert_eq!(log.stats().pending_cache_items, 1);
    }
    assert_eq!(log.stats().active_calls, 0);
    assert_eq!(log.stats().pending_cache_items, 0);
    assert_eq!(log.stats().pending_cache_bytes, 0);
    assert_eq!(stall.canceled.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn flush_deadline_and_shutdown_are_truthful_idempotent_and_cancel_sinks() {
    let stall = Arc::new(Stall::default());
    let log = logger(
        LoggerConfig::default(),
        Arc::new(Records::default()),
        Some(stall.clone()),
    );
    let worker = log.clone();
    let task = tokio::spawn(async move {
        worker
            .log(Level::Info, json!(null), LogOptions::default())
            .await
    });
    while stall.started.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    let flush = log.flush(Duration::from_millis(5)).await;
    assert!(!flush.drained);
    assert_eq!(flush.pending_calls, 1);
    assert!(log.shutdown(Duration::from_secs(1)).await.drained);
    assert_eq!(task.await.unwrap().cache, SinkStatus::Closed);
    assert_eq!(stall.canceled.load(Ordering::SeqCst), 1);
    assert!(log.shutdown(Duration::ZERO).await.drained);
    assert_eq!(
        log.log_lazy(Level::Fatal, LogOptions::default(), || panic!("closed"))
            .await
            .disposition,
        Disposition::Closed
    );
    assert_eq!(log.stats().pending_cache_items, 0);
}

#[tokio::test]
async fn shutdown_reports_unpolled_caller_future_without_detaching_work() {
    let stall = Arc::new(Stall::default());
    let log = logger(
        LoggerConfig::default(),
        Arc::new(Records::default()),
        Some(stall.clone()),
    );
    let future = log.log(Level::Info, json!(null), LogOptions::default());
    tokio::pin!(future);
    assert!(poll!(&mut future).is_pending());
    assert_eq!(
        log.shutdown(Duration::ZERO).await,
        LifecycleReport {
            drained: false,
            pending_calls: 1
        }
    );
    assert_eq!(future.await.cache, SinkStatus::Closed);
    assert!(log.flush(Duration::ZERO).await.drained);
    assert_eq!(stall.canceled.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn collector_bounds_metadata_and_transfers_it_to_explicit_consumer() {
    let collector = MetadataCollector::new(1).unwrap();
    let record = metadata_record(
        0,
        Level::Warn,
        &json!({"operation":"test"}),
        &LogOptions::default(),
    );
    assert_eq!(collector.record(record.clone()).await, Ok(()));
    assert_eq!(
        collector.record(record.clone()).await,
        Err(SinkError::Rejected)
    );
    assert_eq!(collector.dropped(), 1);
    assert_eq!(collector.drain().len(), 1);
    assert!(collector.drain().is_empty());
    assert_eq!(collector.record(record).await, Ok(()));
}

#[tokio::test]
async fn bad_clock_id_and_payload_panics_do_not_reach_sinks() {
    struct BadId;
    impl IdSource for BadId {
        fn next_id(&self) -> String {
            "secret:unsafe".into()
        }
    }
    let records = Arc::new(Records::default());
    let log = Logger::new(
        LoggerConfig::default(),
        SinkHandles {
            cache: Some(records.clone()),
            ..SinkHandles::default()
        },
        Arc::new(FixedClock),
        Arc::new(BadId),
    )
    .unwrap();
    assert_eq!(
        log.log(Level::Warn, json!(null), LogOptions::default())
            .await
            .disposition,
        Disposition::InvalidPayload
    );
    let touched = AtomicBool::new(false);
    assert_eq!(
        log.log_lazy(Level::Error, LogOptions::default(), || {
            touched.store(true, Ordering::Relaxed);
            panic!("bad closure")
        })
        .await
        .disposition,
        Disposition::Panicked
    );
    assert!(touched.load(Ordering::Relaxed));
    assert!(records.cache.lock().unwrap().is_empty());
    assert_eq!(log.stats().active_calls, 0);
}

#[tokio::test]
async fn extreme_owned_value_nesting_is_rejected_and_disposed_without_recursive_drop() {
    let records = Arc::new(Records::default());
    let log = logger(LoggerConfig::default(), records.clone(), None);
    let mut value = Value::Null;
    for _ in 0..10_000 {
        value = Value::Array(vec![value]);
    }
    assert_eq!(
        log.log(Level::Error, value, LogOptions::default())
            .await
            .disposition,
        Disposition::InvalidPayload
    );
    assert!(records.cache.lock().unwrap().is_empty());
    assert!(records.console.lock().unwrap().is_empty());
    assert!(records.metadata.lock().unwrap().is_empty());
    assert!(records.otel.lock().unwrap().is_empty());
    // Eager inputs also need safe disposal if their future is never polled.
    let mut value = Value::Null;
    for _ in 0..10_000 {
        value = Value::Object(Map::from_iter([("child".into(), value)]));
    }
    drop(log.log(Level::Info, value, LogOptions::default()));
    assert_eq!(log.stats().active_calls, 0);
}
