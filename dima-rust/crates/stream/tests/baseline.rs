mod support;
use anyhow::{Context, Result};
use dima_core::{Clock, ManualClock};
use dima_store::dragonfly::SetOptions;
use dima_stream::defense_baseline::*;
use serde_json::Value;
use std::sync::Arc;

#[test]
fn every_reference_baseline_test_and_additional_boundaries() -> Result<()> {
    let recording: Value = serde_json::from_str(include_str!("baseline-reference.json"))?;
    let now = recording["now"].as_i64().context("now")?;
    for case in recording["pure"].as_array().context("cases")? {
        let days: Vec<Day> = serde_json::from_value(case["days"].clone())?;
        let streams: Vec<Stream> = serde_json::from_value(case["streams"].clone())?;
        let excluded: Vec<String> = serde_json::from_value(case["excluded"].clone())?;
        let baseline = calculate_defense_baseline(&days, &streams, &excluded, now);
        assert_eq!(
            baseline,
            serde_json::from_value::<DefenseBaseline>(case["expected"].clone())?,
            "{}",
            case["name"]
        );
    }
    assert_eq!(
        pipelines("c", -1)[0][0]
            .get_document("$match")?
            .get_document("followed_at")?
            .get_datetime("$lt")?
            .timestamp_millis(),
        -DAY
    );
    Ok(())
}
#[tokio::test]
async fn real_channel_baselines_equal_reference_aggregation() -> Result<()> {
    let Some(store) = support::mongo("domdimabot").await? else {
        return Ok(());
    };
    let Some(cache) = support::cache().await? else {
        return Ok(());
    };
    let recording: Value = serde_json::from_str(include_str!("baseline-reference.json"))?;
    let now = recording["now"].as_i64().context("now")?;
    let baselines = Baselines::new(
        store,
        cache,
        Arc::new(ManualClock::new(now)),
        Config::default(),
    );
    let channels = recording["baselines"].as_array().context("channels")?;
    for case in channels {
        let baseline = baselines
            .calculate_at(case["channel"].as_str().context("channel")?, now)
            .await?;
        let expected: DefenseBaseline = serde_json::from_value(case["expected"].clone())?;
        assert_eq!(baseline, expected, "channel {}", case["channel"]);
    }
    eprintln!("real baseline channels compared: {}", channels.len());
    Ok(())
}
#[tokio::test]
async fn cache_age_lt_requests_ttls_old_rust_payload_and_due_receipts() -> Result<()> {
    support::with_store(|store| async move {
        let Some(cache) = support::cache().await? else {
            return Ok(());
        };
        let prefix = format!("dima_test_stream_{}:", uuid::Uuid::new_v4().simple());
        let now = 1_794_355_200_000;
        let clock = Arc::new(ManualClock::new(now));
        let baselines = Baselines::new(
            store.clone(),
            cache.clone(),
            clock.clone(),
            Config {
                key_prefix: prefix.clone(),
                ..Config::default()
            },
        );
        let result: Result<()> = async {
            assert!(baselines.get_defense_baseline("c").await?.is_none());
            let due = format!("{prefix}{DUE}");
            assert_eq!(cache.zrange_with_scores(&due, 0, 0).await?[0].1, now as f64);
            assert!(baselines.process_defense_baseline().await?);
            assert_eq!(
                cache.zrange_with_scores(&due, 0, 0).await?[0].1,
                (now + 3_600_000) as f64
            );
            assert!(!baselines.process_defense_baseline().await?);
            let baseline = baselines
                .get_defense_baseline("c")
                .await?
                .context("fresh baseline")?;
            assert_eq!(baseline.attack_threshold, None);
            assert!(matches!(
                cache.ttl(&format!("{prefix}{}", key("c"))).await?,
                dima_store::dragonfly::Ttl::Seconds(604_799..=604_800)
            ));
            // Exact seven-field JSON emitted by the old Rust worker, with integer-looking floats.
            let mut old = serde_json::to_value(&baseline)?;
            old["calculatedAt"] = (now - DAY).into();
            old["streamCount"] = 3.into();
            old["averageDaily"] = 20000.into();
            old["attackThreshold"] = 40000.into();
            cache
                .set(
                    &format!("{prefix}{}", key("c")),
                    &serde_json::to_vec(&old)?,
                    SetOptions::ex(604800),
                )
                .await?;
            assert!(baselines.get_defense_baseline("c").await?.is_some());
            clock.set(now + 1);
            cache
                .del(&[&format!("{prefix}{}:requested", key("c"))])
                .await?;
            assert!(baselines.get_defense_baseline("c").await?.is_some());
            assert_eq!(
                cache.zrange_with_scores(&due, 0, 0).await?[0].1,
                (now + 1) as f64
            );
            clock.set(now + DAY + 1);
            assert!(baselines.get_defense_baseline("c").await?.is_none());
            cache
                .set(
                    &format!("{prefix}{}", key("bad")),
                    b"{malformed",
                    SetOptions::ex(100),
                )
                .await?;
            assert!(baselines.get_defense_baseline("bad").await?.is_none());
            // Force an aggregate deadline after the durable due-set retry receipt.
            let failing = Baselines::new(
                store.clone(),
                cache.clone(),
                clock.clone(),
                Config {
                    // Zero: the first poll of a network call is never ready, so this always elapses
                    // (one nanosecond rounded up to a timer tick that a fast local query could beat).
                    mongo_deadline: std::time::Duration::ZERO,
                    key_prefix: prefix.clone(),
                    ..Config::default()
                },
            );
            cache.del(&[&due]).await?;
            cache.zadd(&due, &[(clock.now_ms() as f64, b"c")]).await?;
            let prior = cache.get(&format!("{prefix}{}", key("c"))).await?;
            assert!(failing.process_defense_baseline().await.is_err());
            assert_eq!(
                cache.zrange_with_scores(&due, 0, 0).await?[0].1,
                (clock.now_ms() + 60_000) as f64
            );
            assert_eq!(cache.get(&format!("{prefix}{}", key("c"))).await?, prior);
            Ok(())
        }
        .await;
        support::cleanup(&cache, &prefix).await?;
        result
    })
    .await
}
