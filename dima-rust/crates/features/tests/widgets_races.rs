//! Revision races between the API, journal delivery and cron, including two OS processes.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "roulette_support/mod.rs"]
mod support;
use anyhow::{Context, Result};
use bson::doc;
use dima_core::{ManualClock, SeededRandom};
use dima_events::envelope::Envelope;
use dima_features::widgets::{PollRequest, WidgetConfig, WidgetPolls, WidgetService};
use dima_http::guard::BoxFuture;
use dima_store::mongo::MongoStore;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
struct NoPolls;
impl WidgetPolls for NoPolls {
    fn get<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Option<Value>, String>> {
        Box::pin(async { Err("unexpected poll lookup".into()) })
    }
    fn create<'a>(&'a self, _: &'a str, _: PollRequest) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Err("unexpected poll creation".into()) })
    }
}
fn service(mongo: &MongoStore, clock: &ManualClock) -> WidgetService {
    WidgetService::new(
        mongo.clone(),
        Arc::new(clock.clone()),
        Arc::new(SeededRandom::new(91)),
        Arc::new(NoPolls),
        WidgetConfig::default(),
    )
}
async fn premium(mongo: &MongoStore) -> Result<()> {
    mongo
        .documents("users")
        .insert_one(doc! {"accounts":[{"type":"twitch","id":"7001"}],"plan_tier":"premium"})
        .await?;
    Ok(())
}
fn event(key: &str) -> Envelope {
    Envelope {
        id: bson::oid::ObjectId::new(),
        event_key: key.into(),
        source: "twitch-eventsub".into(),
        source_event_id: key.into(),
        kind: "channel.bits.received".into(),
        topic: "channel".into(),
        schema_version: 1.0,
        owner_user_id: None,
        subject: None,
        channel_id: Some("7001".into()),
        stream_id: None,
        occurred_at_ms: 1000,
        journaled_at_ms: Some(1000),
        payload: dima_events::value::Object::from_bson(&doc! {"event":{"bits":10}}),
        metadata: dima_events::value::Object::new(),
        expires_at_ms: 1000000,
    }
}
async fn settings(s: &WidgetService) -> Result<()> {
    s.execute("7001","events",&json!({"enabled":true,"active":true,"allowTestEvents":false,"rules":[{"id":"add","enabled":true,"event":"channel.bits.received","minBits":1,"maxBits":null,"action":{"type":"add-win-target","role":"killer","amount":1}}]}),"settings",0.0).await?;
    Ok(())
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn widgets_two_signals_dedupe_and_preserve_distinct_effects() -> Result<()> {
    support::with_database(|mongo, _| async move {
        premium(&mongo).await?;
        let clock = ManualClock::new(1000);
        let s = service(&mongo, &clock);
        settings(&s).await?;
        let e = event("same");
        let (a, b) = tokio::join!(
            s.apply_widget_event("7001", &e),
            s.apply_widget_event("7001", &e)
        );
        a?;
        b?;
        let d = s.read("7001").await?.context("state")?;
        assert_eq!(d.revision, 2.0);
        assert_eq!(d.state["config"]["targets"]["killer"], 4);
        let e1 = event("one");
        let e2 = event("two");
        let (a, b) = tokio::join!(
            s.apply_widget_event("7001", &e1),
            s.apply_widget_event("7001", &e2)
        );
        a?;
        b?;
        let d = s.read("7001").await?.context("state")?;
        assert_eq!(d.revision, 4.0);
        assert_eq!(d.state["config"]["targets"]["killer"], 6);
        let r = mongo
            .documents("widget_channels")
            .find_one(doc! {"_id":"7001"})
            .await?
            .context("raw")?;
        assert_eq!(r.get_array("eventReceipts")?.len(), 3);
        Ok(())
    })
    .await
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn widgets_signal_against_due_settle_keeps_both_changes() -> Result<()> {
    support::with_database(|mongo, _| async move {
        premium(&mongo).await?;
        let clock = ManualClock::new(1000);
        let s = service(&mongo, &clock);
        settings(&s).await?;
        s.execute("7001", "start", &json!({"mode":"characters"}), "start", 1.0)
            .await?;
        clock.set(5000);
        let e = event("race");
        let (a, b) = tokio::join!(s.apply_widget_event("7001", &e), s.advance("7001"));
        a?;
        b?;
        let d = s.read("7001").await?.context("state")?;
        assert_eq!(d.revision, 4.0);
        assert_eq!(d.state["phase"], "complete");
        assert_eq!(d.state["config"]["targets"]["killer"], 4);
        assert!(d.state["run"]["characterId"].is_string());
        Ok(())
    })
    .await
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn widgets_two_processes_settle_once() -> Result<()> {
    support::with_database(|mongo, name| async move {
        premium(&mongo).await?;
        let clock = ManualClock::new(1000);
        let s = service(&mongo, &clock);
        s.execute("7001", "start", &json!({"mode":"characters"}), "start", 0.0)
            .await?;
        let mut children = Vec::new();
        for n in 0..2 {
            children.push(
                tokio::process::Command::new(std::env::current_exe()?)
                    .args(["--exact", "widgets_child_settle", "--nocapture"])
                    .env("DIMA_WIDGETS_CHILD_DB", &name)
                    .env("DIMA_WIDGETS_CHILD_ID", n.to_string())
                    .kill_on_drop(true)
                    .spawn()?,
            );
        }
        for child in &mut children {
            assert!(
                tokio::time::timeout(Duration::from_secs(30), child.wait())
                    .await??
                    .success()
            );
        }
        let d = s.read("7001").await?.context("state")?;
        assert_eq!(d.revision, 2.0);
        assert_eq!(d.state["phase"], "complete");
        assert!(d.state["nextAt"].is_null());
        Ok(())
    })
    .await
}
#[tokio::test]
async fn widgets_child_settle() -> Result<()> {
    let Ok(name) = std::env::var("DIMA_WIDGETS_CHILD_DB") else {
        return Ok(());
    };
    if !name.starts_with("dima_test_features_") {
        anyhow::bail!("unsafe database");
    }
    let mongo = support::connect(&name).await?.context("store")?;
    let id = std::env::var("DIMA_WIDGETS_CHILD_ID")?;
    mongo
        .documents("widgets_race_barrier")
        .insert_one(doc! {"_id":id})
        .await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if mongo
                .documents("widgets_race_barrier")
                .count_documents(doc! {})
                .await?
                == 2
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    let clock = ManualClock::new(5000);
    let s = service(&mongo, &clock);
    for _ in 0..20 {
        s.settle_due().await?;
    }
    Ok(())
}
