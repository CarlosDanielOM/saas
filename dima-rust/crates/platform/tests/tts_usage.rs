// Test helpers read fixed fixtures and hold test-only locks.
#![allow(clippy::unwrap_used)]
use anyhow::{Context, Result};
use dima_billing::{
    polar::{IngestMode, IngestOutcome, UsageEventInput},
    usage::{AiUsageContextInput, ResourceType, Unit},
};
use dima_core::{ManualClock, Random};
use dima_platform::tts_usage::*;
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks, Ttl};
use futures_util::{FutureExt, future::BoxFuture};
use serde_json::{Value, json};
use std::{panic::AssertUnwindSafe, sync::Mutex, time::Duration};
fn reference() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "tts-usage-reference.json"
    ))?)
}
fn equal_json(a: &Value, b: &Value) {
    assert_eq!(dima_text::to_js_json(a), dima_text::to_js_json(b));
}
#[test]
fn recorded_calculations_and_caller_character_units() -> Result<()> {
    let r = reference()?;
    assert_eq!(
        r["sha256"],
        dima_core::crypto::digest::sha256(include_str!(
            "../../../../dimabot/src/utils/tts_usage.ts"
        ))
        .hex()
    );
    for row in r["calculations"].as_array().context("calculations")? {
        let actual = calculate_tts_usage(
            row["provider"].as_str().unwrap(),
            row["characters"].as_f64().unwrap(),
        );
        equal_json(&serde_json::to_value(actual)?, &row["result"]);
    }
    for row in r["counts"].as_array().context("counts")? {
        let text = row["text"].as_str().unwrap();
        let provider = row["provider"].as_str().unwrap();
        let count = if provider == "fish" || row["caller"] == "desktop-pet" {
            dima_text::utf16_len(text)
        } else {
            text.chars().count()
        };
        assert_eq!(count as u64, row["characters"].as_u64().unwrap());
        equal_json(
            &serde_json::to_value(calculate_tts_usage(provider, count as f64))?,
            &row["result"],
        );
    }
    Ok(())
}
async fn connect(db: u8) -> Result<Option<Dragonfly>> {
    let address = match std::env::var("DIMA_TEST_DRAGONFLY") {
        Ok(a) => a,
        Err(e) => {
            if std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() == Ok("1") {
                return Err(e.into());
            }
            return Ok(None);
        }
    };
    let (host, port) = address.rsplit_once(':').context("address")?;
    Ok(Some(
        Dragonfly::connect(
            DragonflyConfig::from_env_values(
                Some(host),
                Some(&format!("{port}/{db}")),
                "platform-tts-tests",
            ),
            Hooks::default(),
        )
        .await?,
    ))
}
async fn cleanup(cache: &Dragonfly, channel: &str) -> Result<()> {
    for pattern in [format!("{channel}*"), format!("*:{channel}*")] {
        let mut scan = cache.scan(&pattern, Some(100));
        while let Some(page) = scan.next_page().await? {
            for key in page {
                cache.del(&[std::str::from_utf8(&key)?]).await?;
            }
        }
    }
    Ok(())
}
async fn with_cache<F, Fut>(db: u8, f: F) -> Result<()>
where
    F: FnOnce(Dragonfly, String) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let Some(cache) = connect(db).await? else {
        return Ok(());
    };
    let channel = format!(
        "dima_test_platform_{}",
        dima_core::SystemRandom.hex_token(12)?
    );
    let result = AssertUnwindSafe(f(cache.clone(), channel.clone()))
        .catch_unwind()
        .await;
    cleanup(&cache, &channel).await?;
    match result {
        Ok(r) => r,
        Err(p) => std::panic::resume_unwind(p),
    }
}
#[derive(Default)]
struct Spy {
    calls: Mutex<Vec<(UsageEventInput, IngestMode)>>,
    failed: bool,
    hung: bool,
}
impl UsageIngest for Spy {
    fn ingest<'a>(
        &'a self,
        input: &'a UsageEventInput,
        mode: IngestMode,
    ) -> BoxFuture<'a, IngestOutcome> {
        Box::pin(async move {
            self.calls.lock().unwrap().push((input.clone(), mode));
            if self.hung {
                std::future::pending().await
            } else if self.failed {
                IngestOutcome::Failed {
                    message: "fixture failure".into(),
                }
            } else {
                IngestOutcome::Done { message: None }
            }
        })
    }
}
fn options(row: &Value, channel: &str) -> Result<TrackOptions> {
    let spec = &row["spec"];
    Ok(TrackOptions {
        channel_id: channel.into(),
        customer_id: spec["customer"]
            .as_bool()
            .unwrap()
            .then(|| "cus_fixture".into()),
        provider: serde_json::from_value(spec["provider"].clone())?,
        characters: spec["characters"].as_f64().unwrap(),
        require_durable_usage: spec["durable"].as_bool().unwrap_or(false),
        usage: if spec["minimal"] == true {
            UsageContext::default()
        } else {
            UsageContext {
                entry_id: Some("entry_fixture".into()),
                request_id: Some("request_fixture".into()),
                source: Some("voice_preview".into()),
                resource_type: Some(ResourceType::VoicePreview),
                resource_id: Some("speech_fixture".into()),
            }
        },
    })
}
fn expected_input(v: &Value, channel: &str) -> Result<UsageEventInput> {
    let u = &v["usage"];
    Ok(UsageEventInput {
        customer_id: v["customerId"].as_str().context("customer")?.into(),
        channel_id: Some(channel.into()),
        external_id: v["externalId"].as_str().map(str::to_owned),
        cost: v["cost"].as_f64().unwrap(),
        reason: v["reason"].as_str().unwrap().into(),
        tts_cost: v["_cost"].as_f64(),
        characters: v["characters"].as_f64(),
        usage: Some(AiUsageContextInput {
            request_id: u["requestId"].as_str().map(str::to_owned),
            source: u["source"].as_str().map(str::to_owned),
            provider: u["provider"].as_str().map(str::to_owned),
            quantity: u["quantity"].as_f64(),
            unit: Some(Unit::Characters),
            resource_type: u["resourceType"].as_str().and_then(ResourceType::parse),
            resource_id: u["resourceId"].as_str().map(str::to_owned),
            ..Default::default()
        }),
        ..Default::default()
    })
}
#[tokio::test]
async fn recorded_cache_and_exact_billing_admission() -> Result<()> {
    let r = reference()?;
    for row in r["tracking"].as_array().context("tracking")? {
        with_cache(14, |cache, channel| async move {
            let spy = Spy {
                failed: row["spec"]["fail"].as_bool().unwrap_or(false),
                ..Default::default()
            };
            let opts = options(row, &channel)?;
            let result = track_tts_usage(
                &cache,
                &spy,
                &ManualClock::new(row["now"].as_i64().unwrap()),
                &opts,
                Config::default(),
            )
            .await;
            let report = match result {
                Ok(r) => {
                    assert!(row["error"].is_null());
                    r
                }
                Err(Error::DurableUnavailable(r)) => {
                    assert_eq!(row["error"], "TTS usage recording unavailable");
                    *r
                }
                Err(e) => return Err(e.into()),
            };
            if !row["result"].is_null() {
                equal_json(&serde_json::to_value(report.usage)?, &row["result"]);
            }
            assert_eq!(
                report.cache_error.is_some(),
                row["cacheErrors"].as_u64().unwrap() > 0
            );
            {
                let calls = spy.calls.lock().unwrap();
                assert_eq!(calls.len(), row["ingestions"].as_array().unwrap().len());
                for ((input, mode), expected) in
                    calls.iter().zip(row["ingestions"].as_array().unwrap())
                {
                    assert_eq!(*mode, IngestMode::Batch);
                    assert_eq!(*input, expected_input(expected, &channel)?);
                }
            }
            if row["spec"]["fail"] == true {
                assert!(
                    report
                        .ingestion
                        .as_ref()
                        .is_some_and(IngestOutcome::is_error)
                );
            }
            let key = format!("{channel}:tts:usage");
            let hash: std::collections::BTreeMap<_, _> =
                cache.hgetall(&key).await?.into_iter().collect();
            assert_eq!(serde_json::to_value(hash)?, row["hash"]);
            let expected = row["ttl"].as_i64().unwrap();
            match cache.ttl(&key).await? {
                Ttl::Missing => assert_eq!(expected, -2),
                Ttl::NoExpiry => assert_eq!(expected, -1),
                Ttl::Seconds(n) => assert!((expected - 3..=expected + 1).contains(&n)),
            };
            Ok(())
        })
        .await?;
    }
    Ok(())
}
#[tokio::test]
async fn ingest_deadline_returns_unknown_for_telemetry_and_durable_failure() -> Result<()> {
    with_cache(15, |cache, channel| async move {
        let spy = Spy {
            hung: true,
            ..Default::default()
        };
        let mut opts = options(&reference()?["tracking"][1], &channel)?;
        let config = Config {
            ingest_deadline: Duration::from_millis(1),
            ..Default::default()
        };
        let clock = ManualClock::new(1794355200000);
        let r = track_tts_usage(&cache, &spy, &clock, &opts, config).await?;
        assert!(matches!(
            r.ingestion,
            Some(IngestOutcome::OutcomeUnknown { .. })
        ));
        opts.require_durable_usage = true;
        assert!(matches!(
            track_tts_usage(&cache, &spy, &clock, &opts, config).await,
            Err(Error::DurableUnavailable(_))
        ));
        Ok(())
    })
    .await
}
#[derive(Default)]
struct Sink(Mutex<Vec<(String, f64)>>);
impl dima_billing::polar::UsageSink for Sink {
    fn enqueue_receipt<'a>(
        &'a self,
        u: dima_billing::polar::AcceptedUsage<'a>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.0
                .lock()
                .unwrap()
                .push((u.context.entry_id.clone(), u.credits));
            Ok(())
        })
    }
    fn track(&self, _: dima_billing::polar::AcceptedUsage<'_>, _: &serde_json::Map<String, Value>) {
    }
}
#[tokio::test]
async fn concrete_billing_ingest_sends_only_to_local_polar_mock() -> Result<()> {
    use dima_billing::{
        NoopObserver,
        plans::credits_cache::CreditsCache,
        polar::{Ingest, PolarClient, build_usage_event},
    };
    use dima_http::{
        HttpClient,
        testing::{MockResponse, MockServer},
    };
    use std::sync::Arc;
    with_cache(15, |cache, channel| async move {
        let server = MockServer::start().await?;
        server.push(MockResponse::json(200, r#"{"inserted":1,"duplicates":0}"#));
        let polar = PolarClient::new(
            HttpClient::builder().build()?,
            server.provider(PolarClient::provider(&Default::default()))?,
            Some("test-only".into()),
        );
        let clock = Arc::new(ManualClock::new(1794355200000));
        let credits = CreditsCache::new(cache.clone(), clock.clone(), Arc::new(NoopObserver));
        let sink = Sink::default();
        let random = dima_core::SystemRandom;
        let ingest = Ingest {
            polar: &polar,
            dragonfly: &cache,
            credits: &credits,
            sink: &sink,
            random: &random,
            clock: clock.as_ref(),
            observer: &NoopObserver,
        };
        let row = &reference()?["tracking"][11];
        let opts = options(row, &channel)?;
        let result =
            track_tts_usage(&cache, &ingest, clock.as_ref(), &opts, Config::default()).await?;
        assert!(!result.ingestion.context("ingest")?.is_error());
        let input = expected_input(&row["ingestions"][0], &channel)?;
        let (event, _) = build_usage_event(&input, &random)?;
        let sent = tokio::time::timeout(Duration::from_secs(5), server.wait_for(1)).await?;
        equal_json(
            &serde_json::from_str(&sent[0].body_text())?,
            &json!({"events":[event.wire()?]}),
        );
        assert_eq!(
            sink.0.lock().unwrap().as_slice(),
            &[("entry_fixture".into(), result.usage.credits_consumed)]
        );
        Ok(())
    })
    .await
}
