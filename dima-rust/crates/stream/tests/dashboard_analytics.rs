mod support;
use anyhow::{Context, Result};
use bson::Bson;
use dima_core::ManualClock;
use dima_model::{stream_sessions, stream_viewer_snapshots};
use dima_store::mongo::{MongoStore, WriteContext};
use dima_stream::dashboard_analytics::*;
use serde_json::Value;
use std::sync::Arc;
fn days(s: &str) -> Option<f64> {
    match s {
        "default" => None,
        "NaN" => Some(f64::NAN),
        "Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ => s.parse().ok(),
    }
}
fn reader(store: MongoStore, r: &Value) -> Result<DashboardAnalytics> {
    Ok(DashboardAnalytics::new(
        store,
        Arc::new(ManualClock::new(r["now"].as_i64().context("now")?)),
        Config::default(),
    )?)
}
async fn compare(reader: &DashboardAnalytics, case: &Value) -> Result<()> {
    let channel = case["channel"].as_str().context("channel")?;
    let actual = if case.get("live").is_some() {
        serde_json::to_value(
            reader
                .get_live_session_metrics(channel, case["viewers"].as_f64())
                .await,
        )?
    } else {
        let result = reader
            .get_dashboard_analytics(channel, days(case["days"].as_str().context("days")?))
            .await;
        if case["error"] == true {
            assert!(result.is_err(), "{case}");
            return Ok(());
        }
        serde_json::to_value(result?)?
    };
    let expected = if case.get("live").is_some() {
        &case["live"]
    } else {
        &case["expected"]
    };
    assert_eq!(
        dima_text::to_js_json(&actual),
        dima_text::to_js_json(expected),
        "{case}"
    );
    Ok(())
}
#[tokio::test]
async fn synthetic_reference_json_default_invalid_days_and_live_options() -> Result<()> {
    let r: Value = serde_json::from_str(include_str!("dashboard-analytics-reference.json"))?;
    for phase in ["empty", "one", "boundaries", "live"] {
        support::with_store(|store| {
            let r = &r;
            async move {
                for seed in r["seeds"]
                    .as_array()
                    .context("seeds")?
                    .iter()
                    .filter(|s| s["phase"] == phase)
                {
                    let info = if seed["collection"] == "streamsessions" {
                        &stream_sessions::INFO
                    } else {
                        &stream_viewer_snapshots::INFO
                    };
                    for row in seed["documents"].as_array().context("documents")? {
                        let doc = Bson::try_from(row.clone())?
                            .as_document()
                            .context("BSON document")?
                            .clone();
                        let prepared = info.prepare_create(
                            &doc,
                            &mut WriteContext::new(r["now"].as_i64().context("now")?),
                        )?;
                        store.writes(info.name).insert_one(&prepared).await?;
                    }
                }
                let a = reader(store, r)?;
                for case in r["cases"]
                    .as_array()
                    .context("cases")?
                    .iter()
                    .filter(|c| c["phase"] == phase)
                {
                    compare(&a, case).await?;
                }
                Ok(())
            }
        })
        .await?;
    }
    Ok(())
}
#[tokio::test]
async fn real_channel_reads_match_once_recorded_reference() -> Result<()> {
    let Some(store) = support::mongo("domdimabot").await? else {
        return Ok(());
    };
    let r: Value = serde_json::from_str(include_str!("dashboard-analytics-real-reference.json"))?;
    let a = reader(store, &r)?;
    let cases = r["cases"].as_array().context("cases")?;
    assert_eq!(cases.len(), 60);
    for case in cases {
        compare(&a, case).await?;
    }
    eprintln!("12 real channels: 48 dashboard and 12 live reads matched");
    Ok(())
}
