//! Part 3 against the recording of the TypeScript (`tests/eventsub/part3.json`): whole
//! `reconcileEventsubs` runs replayed (the same Helix requests in the same order, the same
//! result counts and errors, the same `eventsubs` documents afterwards), the take-over check
//! the cutover depends on, and the Rust-only safety properties: dry run, foreign
//! subscriptions, limits, interruption and repetition, two runs at once, the switch.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
#[path = "eventsub/fake.rs"]
mod fake;
#[path = "eventsub/replay.rs"]
mod replay;
mod support;

use anyhow::{Context, Result};
use bson::doc;
use dima_core::SecretString;
use dima_store::mongo::MongoStore;
use dima_twitch::TwitchError;
use dima_twitch::eventsub::{
    AlwaysContinue, EventsubManager, EventsubSettings, RaidDirection, RaidPreferences,
    ReconcileError, ReconcileReport, ReconcileSettings, RunControl,
};
use fake::FakeTwitch;
use futures_util::future::BoxFuture;
use replay::*;
use serde_json::{Map, Value};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use support::{Stores, with_stores};

/// `isRaidDeleted` / `shouldRepairRaid` over `raid_subscription_preferences`, as
/// `dima_stream::raid_subscriptions` reads them.
struct MongoRaids(MongoStore);

fn failed(error: impl std::fmt::Display) -> TwitchError {
    TwitchError::Mongo {
        op: "raid_subscription_preferences.findOne",
        message: error.to_string(),
    }
}

impl RaidPreferences for MongoRaids {
    fn is_raid_deleted<'a>(
        &'a self,
        channel: &'a str,
        direction: RaidDirection,
    ) -> BoxFuture<'a, Result<bool, TwitchError>> {
        Box::pin(async move {
            let id = format!("{channel}:{}", direction.as_str());
            Ok(self
                .0
                .documents("raid_subscription_preferences")
                .find_one(doc! {"_id": id, "deleted": true})
                .await
                .map_err(failed)?
                .is_some())
        })
    }

    fn should_repair_raid<'a>(
        &'a self,
        channel: &'a str,
        direction: RaidDirection,
    ) -> BoxFuture<'a, Result<bool, TwitchError>> {
        Box::pin(async move {
            let id = format!("{channel}:{}", direction.as_str());
            let row = self
                .0
                .documents("raid_subscription_preferences")
                .find_one(doc! {"_id": id})
                .await
                .map_err(failed)?;
            Ok(row.map_or(direction == RaidDirection::Incoming, |row| {
                row.get_bool("deleted").ok() != Some(true)
            }))
        })
    }
}

fn settings() -> ReconcileSettings {
    ReconcileSettings {
        enabled: true,
        ..ReconcileSettings::default()
    }
}

fn manager_of(process: &support::Process) -> Result<EventsubManager> {
    let settings = EventsubSettings::reference(Some(SecretString::from(SECRET)))?;
    Ok(EventsubManager::new(process.twitch.clone(), settings))
}

/// Seeds a recorded scenario's stores.
async fn seed(stores: &Stores, scenario: &Value) -> Result<i64> {
    let now = scenario["now"].as_i64().context("now")?;
    create_indexes(stores).await?;
    seed_channels(stores, &scenario["channels"], now).await?;
    seed_documents(stores, "eventsubs", &scenario["before"]).await?;
    seed_documents(stores, "raid_subscription_preferences", &scenario["prefs"]).await?;
    Ok(now)
}

/// A fake Twitch holding a scenario's subscriptions before the run.
fn fake_of(scenario: &Value, now: i64) -> FakeTwitch {
    let twitch = FakeTwitch::new(now);
    {
        let mut state = twitch.lock();
        for sub in scenario["remoteBefore"].as_array().into_iter().flatten() {
            if let Some(sub) = sub.as_object() {
                state.subs.push(sub.clone());
            }
        }
        state.next = 1000;
        state.status = "enabled".into();
    }
    twitch
}

fn report_json(outcome: &Result<ReconcileReport, ReconcileError>) -> (Value, Option<String>) {
    match outcome {
        Ok(report) => (report.reference_json(), None),
        Err(error) => (Value::Null, Some(error.to_string())),
    }
}

async fn replay_one(scenario: Value) -> Result<()> {
    let name = scenario["name"].as_str().context("name")?.to_owned();
    with_stores(|stores| async move {
        let now = seed(&stores, &scenario).await?;
        let exchanges = scenario["exchanges"]
            .as_array()
            .context("exchanges")?
            .clone();
        let answers = exchanges.iter().map(|e| answer(&e["response"])).collect();
        let server = replay_twitch(answers, true).await?;
        let process = process(&stores, &server, CLIENT_ID, now)?;
        process.twitch.load_streamers().await?;
        let manager = manager_of(&process)?;
        let raids = MongoRaids(stores.mongo.clone());
        let outcome = manager
            .reconcile(&settings(), &raids, &AlwaysContinue)
            .await;
        let (result, threw) = report_json(&outcome);

        let sent = helix_requests(&server);
        let expected: Vec<Value> = exchanges.iter().map(recorded_shape).collect();
        let got: Vec<Value> = sent.iter().map(shape).collect();
        let known = object_ids(&scenario["before"]);
        let mut recorded_documents = scenario["documents"].clone();
        normalize(&mut recorded_documents, &known);
        let mut stored = Value::Array(documents(&stores, "eventsubs").await?);
        normalize(&mut stored, &known);

        if name == "foreign-callback" {
            // Intended difference: the reference deletes the other environment's subscription
            // as a duplicate of production's; Rust never deletes what it did not create.
            assert_eq!(expected.len(), 2);
            assert_eq!(expected[1]["method"], "DELETE");
            assert_eq!(got, expected[..1].to_vec(), "{name}: only the listing");
            let report = outcome.as_ref().expect("report");
            assert_eq!(report.foreign.len(), 1, "{name}: reported");
            assert_eq!(report.remote_subscriptions_removed, 0);
            let mut recorded = scenario["result"].clone();
            recorded["remoteSubscriptionsRemoved"] = Value::from(0);
            assert_eq!(result, recorded, "{name}: result");
        } else {
            assert_eq!(got, expected, "{name}: requests");
            assert_same_bodies(&name, &exchanges, &sent);
            match (&scenario["threw"], threw) {
                (Value::String(message), Some(error)) => assert_eq!(&error, message, "{name}"),
                (Value::Null, None) => assert_eq!(result, scenario["result"], "{name}: result"),
                (recorded, rust) => panic!("{name}: reference threw {recorded}, Rust {rust:?}"),
            }
        }
        assert_eq!(stored, recorded_documents, "{name}: documents");
        let mut prefs = Value::Array(documents(&stores, "raid_subscription_preferences").await?);
        normalize(&mut prefs, &known);
        assert_eq!(
            prefs, scenario["preferences"],
            "{name}: preferences untouched"
        );
        Ok(())
    })
    .await
}

fn scenarios() -> Result<Vec<Value>> {
    let recording = load("part3.json")?;
    assert_sources_unchanged(&recording)?;
    Ok(recording["scenarios"]
        .as_array()
        .context("scenarios")?
        .clone())
}

fn scenario(name: &str) -> Result<Value> {
    scenarios()?
        .into_iter()
        .find(|s| s["name"] == name)
        .with_context(|| format!("no scenario {name}"))
}

#[tokio::test]
async fn every_recorded_run_is_replayed() -> Result<()> {
    let all = scenarios()?;
    assert!(all.len() >= 19);
    for scenario in all {
        replay_one(scenario).await?;
    }
    Ok(())
}

/// The cutover: a first Rust run over channels the TypeScript set up (every table entry, both
/// raid directions where the preference asks, a deleted incoming raid, a reward redemption and
/// the chat moderation types) sends the listing only and leaves every stored document as it was.
#[tokio::test]
async fn taking_over_from_the_typescript_changes_nothing() -> Result<()> {
    let scenario = scenario("take-over")?;
    // The reference's own run changed nothing either.
    assert_eq!(scenario["exchanges"].as_array().map(Vec::len), Some(1));
    assert_eq!(scenario["before"], scenario["documents"]);
    assert_eq!(scenario["remoteBefore"], scenario["remoteAfter"]);
    let mut types: Vec<String> = scenario["remoteBefore"]
        .as_array()
        .context("remote")?
        .iter()
        .map(|s| s["type"].as_str().unwrap_or_default().to_owned())
        .collect();
    types.sort();
    types.dedup();
    for entry in &dima_twitch::eventsub::SUBSCRIPTION_TYPES {
        assert!(
            types.iter().any(|t| t == entry.kind),
            "{} set up",
            entry.kind
        );
    }
    with_stores(|stores| async move {
        let now = seed(&stores, &scenario).await?;
        let twitch = fake_of(&scenario, now);
        let fake = twitch.clone();
        let server = twitch_with(true, move |request| fake.handle(request)).await?;
        let process = process(&stores, &server, CLIENT_ID, now)?;
        process.twitch.load_streamers().await?;
        let manager = manager_of(&process)?;
        let raids = MongoRaids(stores.mongo.clone());
        let before = documents(&stores, "eventsubs").await?;
        let report = manager
            .reconcile(&settings(), &raids, &AlwaysContinue)
            .await?;
        let sent = helix_requests(&server);
        assert!(
            sent.iter().all(|r| r.method == "GET"),
            "only the listing: {sent:?}"
        );
        assert_eq!(sent.len(), 1);
        assert_eq!(
            documents(&stores, "eventsubs").await?,
            before,
            "no stored change"
        );
        assert_eq!(
            Value::Array(before),
            scenario["before"],
            "seeded as recorded"
        );
        assert_eq!(report.subscriptions_created, 0);
        assert_eq!(report.remote_subscriptions_removed, 0);
        assert_eq!(report.stale_local_removed, 0);
        assert!(report.actions.is_empty(), "{:?}", report.actions);
        assert!(report.errors.is_empty());
        assert!(
            report.foreign.is_empty() && report.departed.is_empty() && report.unexpected.is_empty()
        );
        assert_eq!(
            report.unmanaged, 4,
            "the reward and the chat moderation types are left alone"
        );
        assert_eq!(
            twitch.subs(),
            fake_of(&scenario, now).subs(),
            "Twitch unchanged"
        );
        // Per type: every subscription the TypeScript created is still there.
        let mut per_type: Map<String, Value> = Map::new();
        for sub in twitch.subs() {
            let kind = sub["type"].as_str().unwrap_or_default().to_owned();
            let count = per_type.get(&kind).and_then(Value::as_u64).unwrap_or(0);
            per_type.insert(kind, Value::from(count + 1));
        }
        println!(
            "take-over, subscriptions per type kept: {}",
            Value::Object(per_type)
        );
        Ok(())
    })
    .await
}

/// Runs a scenario against a stateful fake Twitch with `settings`; `(report, fake, stores)`.
async fn run_on_fake(
    stores: &Stores,
    scenario: &Value,
    settings: &ReconcileSettings,
    control: &dyn RunControl,
) -> Result<(
    Result<ReconcileReport, ReconcileError>,
    FakeTwitch,
    dima_http::testing::MockServer,
)> {
    let now = seed(stores, scenario).await?;
    let twitch = fake_of(scenario, now);
    let fake = twitch.clone();
    let server = twitch_with(true, move |request| fake.handle(request)).await?;
    let process = process(stores, &server, CLIENT_ID, now)?;
    process.twitch.load_streamers().await?;
    let manager = manager_of(&process)?;
    let raids = MongoRaids(stores.mongo.clone());
    let outcome = manager.reconcile(settings, &raids, control).await;
    Ok((outcome, twitch, server))
}

#[tokio::test]
async fn a_dry_run_sends_and_writes_nothing_but_plans_what_the_run_would_do() -> Result<()> {
    for name in [
        "missing-subscriptions",
        "duplicates",
        "unhealthy-and-old-pending",
        "legacy-bits-only",
        "raid-preferences",
        "missing-after-grace",
    ] {
        let scenario = scenario(name)?;
        with_stores(|stores| async move {
            let dry = ReconcileSettings {
                enabled: false,
                dry_run: true,
                ..ReconcileSettings::default()
            };
            let (outcome, twitch, server) =
                run_on_fake(&stores, &scenario, &dry, &AlwaysContinue).await?;
            let report = outcome?;
            assert!(report.dry_run);
            assert!(
                helix_requests(&server).iter().all(|r| r.method == "GET"),
                "{name}"
            );
            assert_eq!(
                Value::Array(documents(&stores, "eventsubs").await?),
                scenario["before"],
                "{name}: nothing written"
            );
            assert_eq!(
                twitch.subs(),
                fake_of(&scenario, 0).subs(),
                "{name}: Twitch unchanged"
            );
            // The plan names what the reference's run did.
            let recorded: Vec<&Value> = scenario["exchanges"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|e| e["request"]["method"] != "GET")
                .collect();
            let planned_deletes = report
                .actions
                .iter()
                .filter(|a| a.action == "delete")
                .count();
            let planned_creates = report
                .actions
                .iter()
                .filter(|a| a.action == "create")
                .count();
            let migrations = report
                .actions
                .iter()
                .filter(|a| a.action == "migrate-bits")
                .count();
            let deletes = recorded
                .iter()
                .filter(|e| e["request"]["method"] == "DELETE")
                .count();
            let creates = recorded
                .iter()
                .filter(|e| e["request"]["method"] == "POST")
                .count();
            if migrations == 0 {
                assert_eq!(planned_deletes, deletes, "{name}: {:?}", report.actions);
                assert_eq!(planned_creates, creates, "{name}: {:?}", report.actions);
            } else {
                assert_eq!(planned_creates + migrations, creates, "{name}");
            }
            assert!(report.actions.iter().all(|a| a.outcome == "planned"));
            if migrations == 0 {
                assert_eq!(
                    report.reference_json(),
                    scenario["result"],
                    "{name}: the plan's counts are the run's"
                );
            }
            Ok(())
        })
        .await?;
    }
    Ok(())
}

#[tokio::test]
async fn subscriptions_this_backend_did_not_create_are_never_deleted() -> Result<()> {
    let scenario = scenario("everything-in-place")?;
    with_stores(|stores| async move {
        let now = seed(&stores, &scenario).await?;
        let twitch = fake_of(&scenario, now);
        {
            let mut state = twitch.lock();
            // Another environment's webhook, a WebSocket whose session is gone and a conduit, all
            // for subscriptions the table expects, and unhealthy.
            let mut push = |id: &str, status: &str, transport: Value| {
                let mut sub = state.subs[0].clone();
                sub.insert("id".into(), Value::from(id));
                sub.insert("status".into(), Value::from(status));
                sub.insert("transport".into(), transport);
                state.subs.push(sub);
            };
            push("foreign-webhook", "webhook_callback_verification_failed", serde_json::json!({"method": "webhook", "callback": "https://dev.example.invalid/eventsub"}));
            push("foreign-websocket", "websocket_disconnected", serde_json::json!({"method": "websocket", "session_id": "gone", "connected_at": "x"}));
            push("foreign-conduit", "enabled", serde_json::json!({"method": "conduit", "conduit_id": "c"}));
        }
        let fake = twitch.clone();
        let server = twitch_with(true, move |request| fake.handle(request)).await?;
        let process = process(&stores, &server, CLIENT_ID, now)?;
        process.twitch.load_streamers().await?;
        let manager = manager_of(&process)?;
        let raids = MongoRaids(stores.mongo.clone());
        let report = manager.reconcile(&settings(), &raids, &AlwaysContinue).await?;
        assert!(helix_requests(&server).iter().all(|r| r.method == "GET"));
        assert_eq!(report.foreign, ["foreign-webhook", "foreign-websocket", "foreign-conduit"]);
        assert_eq!(twitch.subs().len(), scenario["remoteBefore"].as_array().map_or(0, Vec::len) + 3);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn the_switch_is_off_unless_configured_on() -> Result<()> {
    let scenario = scenario("missing-subscriptions")?;
    with_stores(|stores| async move {
        let off = ReconcileSettings::default();
        assert!(!off.enabled);
        let (outcome, _twitch, server) =
            run_on_fake(&stores, &scenario, &off, &AlwaysContinue).await?;
        assert!(matches!(outcome, Err(ReconcileError::Disabled)));
        assert!(helix_requests(&server).is_empty());
        Ok(())
    })
    .await
}

#[tokio::test]
async fn limits_defer_the_rest_to_the_next_run() -> Result<()> {
    let scenario = scenario("missing-subscriptions")?;
    with_stores(|stores| async move {
        let limited = ReconcileSettings {
            max_creates: 1,
            ..settings()
        };
        let (outcome, twitch, server) =
            run_on_fake(&stores, &scenario, &limited, &AlwaysContinue).await?;
        let report = outcome?;
        assert_eq!(report.subscriptions_created, 1);
        assert_eq!(report.deferred, 2);
        assert_eq!(
            helix_requests(&server)
                .iter()
                .filter(|r| r.method == "POST")
                .count(),
            1
        );
        // The next run, without the limit, creates the rest and nothing twice.
        let process = process(
            &stores,
            &server,
            CLIENT_ID,
            scenario["now"].as_i64().unwrap_or(0),
        )?;
        let manager = manager_of(&process)?;
        let raids = MongoRaids(stores.mongo.clone());
        let second = manager
            .reconcile(&settings(), &raids, &AlwaysContinue)
            .await?;
        assert_eq!(second.subscriptions_created, 2);
        assert_eq!(
            twitch.subs().len(),
            scenario["remoteBefore"].as_array().map_or(0, Vec::len) + 3
        );
        let third = manager
            .reconcile(&settings(), &raids, &AlwaysContinue)
            .await?;
        assert_eq!(third.subscriptions_created, 0);
        assert!(third.actions.is_empty());
        Ok(())
    })
    .await?;
    // Per channel: one Twitch action for r1 in this run.
    let scenario = crate::scenario("missing-subscriptions")?;
    with_stores(|stores| async move {
        let limited = ReconcileSettings {
            max_actions_per_channel: 1,
            ..settings()
        };
        let (outcome, _twitch, server) =
            run_on_fake(&stores, &scenario, &limited, &AlwaysContinue).await?;
        let report = outcome?;
        assert_eq!(report.subscriptions_created, 1);
        assert_eq!(report.deferred, 2);
        assert_eq!(
            report
                .actions
                .iter()
                .filter(|a| a.outcome == "deferred")
                .count(),
            2
        );
        assert_eq!(
            helix_requests(&server)
                .iter()
                .filter(|r| r.method == "POST")
                .count(),
            1
        );
        Ok(())
    })
    .await
}

/// Says yes `n` times, then no.
struct StopAfter(AtomicUsize);

impl RunControl for StopAfter {
    fn should_continue(&self) -> BoxFuture<'_, bool> {
        Box::pin(async move { self.0.fetch_sub(1, Ordering::SeqCst) > 0 })
    }
}

#[tokio::test]
async fn an_interrupted_run_stops_reports_and_is_finished_by_the_next() -> Result<()> {
    for name in [
        "missing-subscriptions",
        "duplicates",
        "unhealthy-and-old-pending",
    ] {
        let scenario = scenario(name)?;
        // The state a whole run leaves.
        let whole = {
            let scenario = scenario.clone();
            let holder = Arc::new(std::sync::Mutex::new(None));
            let out = Arc::clone(&holder);
            with_stores(|stores| async move {
                let (outcome, twitch, _server) =
                    run_on_fake(&stores, &scenario, &settings(), &AlwaysContinue).await?;
                outcome?;
                let mut kinds: Vec<String> = twitch
                    .subs()
                    .iter()
                    .map(|s| format!("{}|{}", s["type"], s["condition"]))
                    .collect();
                kinds.sort();
                *out.lock().expect("lock") =
                    Some((kinds, documents(&stores, "eventsubs").await?.len()));
                Ok(())
            })
            .await?;
            holder.lock().expect("lock").clone()
        };
        let Some((whole_kinds, whole_documents)) = whole else {
            continue;
        };
        for stop_after in [0_usize, 1, 5, 20, 40, 60] {
            let scenario = scenario.clone();
            let whole_kinds = whole_kinds.clone();
            with_stores(|stores| async move {
                let control = StopAfter(AtomicUsize::new(stop_after));
                let (outcome, twitch, server) =
                    run_on_fake(&stores, &scenario, &settings(), &control).await?;
                match outcome {
                    Err(ReconcileError::Cancelled(report)) => {
                        assert!(report.actions.len() <= 3, "{name}: {stop_after}");
                    }
                    Ok(_) => {}
                    Err(other) => panic!("{name}: {other}"),
                }
                // The next run finishes the work: the same Twitch state as one whole run.
                let process = process(
                    &stores,
                    &server,
                    CLIENT_ID,
                    scenario["now"].as_i64().unwrap_or(0),
                )?;
                let manager = manager_of(&process)?;
                let raids = MongoRaids(stores.mongo.clone());
                manager
                    .reconcile(&settings(), &raids, &AlwaysContinue)
                    .await?;
                let mut kinds: Vec<String> = twitch
                    .subs()
                    .iter()
                    .map(|s| format!("{}|{}", s["type"], s["condition"]))
                    .collect();
                kinds.sort();
                assert_eq!(kinds, whole_kinds, "{name} stopped after {stop_after}");
                assert_eq!(
                    documents(&stores, "eventsubs").await?.len(),
                    whole_documents,
                    "{name} stopped after {stop_after}"
                );
                Ok(())
            })
            .await?;
        }
    }
    Ok(())
}

#[tokio::test]
async fn two_runs_at_once_create_nothing_twice() -> Result<()> {
    for name in [
        "missing-subscriptions",
        "duplicates",
        "unhealthy-and-old-pending",
        "raid-preferences",
    ] {
        let scenario = scenario(name)?;
        with_stores(|stores| async move {
            let now = seed(&stores, &scenario).await?;
            let twitch = fake_of(&scenario, now);
            let fake = twitch.clone();
            let server = twitch_with(true, move |request| {
                fake.handle(request)
                    .delay(std::time::Duration::from_millis(5))
            })
            .await?;
            let first = process(&stores, &server, CLIENT_ID, now)?;
            let second = process(&stores, &server, CLIENT_ID, now)?;
            first.twitch.load_streamers().await?;
            let (a, b) = (manager_of(&first)?, manager_of(&second)?);
            let raids = MongoRaids(stores.mongo.clone());
            let run = settings();
            let (left, right) = tokio::join!(
                a.reconcile(&run, &raids, &AlwaysContinue),
                b.reconcile(&run, &raids, &AlwaysContinue)
            );
            let (left, right) = (left?, right?);
            // Twitch holds each expected subscription once.
            let mut keys: Vec<String> = twitch
                .subs()
                .iter()
                .map(|s| format!("{}|{}|{}", s["type"], s["version"], s["condition"]))
                .collect();
            let total = keys.len();
            keys.sort();
            keys.dedup();
            assert_eq!(keys.len(), total, "{name}: a duplicate at Twitch");
            assert_eq!(
                left.subscriptions_created + right.subscriptions_created,
                scenario["result"]["subscriptionsCreated"]
                    .as_u64()
                    .unwrap_or(0),
                "{name}: each missing one created once"
            );
            Ok(())
        })
        .await?;
    }
    Ok(())
}

#[tokio::test]
async fn unexpected_and_departed_are_reported_and_removed_only_when_asked() -> Result<()> {
    for remove in [false, true] {
        let scenario = scenario("stale-version")?;
        with_stores(|stores| async move {
            let now = seed(&stores, &scenario).await?;
            // A departed channel's subscription and a reward redemption of an active channel.
            let twitch = fake_of(&scenario, now);
            for body in [
                serde_json::json!({"type": "stream.online", "version": "1", "condition": {"broadcaster_user_id": "gone"}, "transport": {"method": "webhook", "callback": dima_twitch::eventsub::REFERENCE_CALLBACK}}),
                serde_json::json!({"type": "channel.channel_points_custom_reward_redemption.add", "version": "1", "condition": {"broadcaster_user_id": "r1", "reward_id": "x"}, "transport": {"method": "webhook", "callback": dima_twitch::eventsub::REFERENCE_CALLBACK}}),
            ] {
                twitch.create(&body, "enabled");
            }
            let fake = twitch.clone();
            let server = twitch_with(true, move |request| fake.handle(request)).await?;
            let process = process(&stores, &server, CLIENT_ID, now)?;
            process.twitch.load_streamers().await?;
            let manager = manager_of(&process)?;
            let raids = MongoRaids(stores.mongo.clone());
            let report = manager
                .reconcile(&ReconcileSettings { remove_unexpected: remove, ..settings() }, &raids, &AlwaysContinue)
                .await?;
            assert_eq!(report.unexpected.len(), 2, "{:?}", report.unexpected);
            assert_eq!(report.departed.len(), 1);
            assert_eq!(report.unmanaged, 1);
            let deletes: Vec<_> = helix_requests(&server).into_iter().filter(|r| r.method == "DELETE").collect();
            assert_eq!(deletes.len(), if remove { 3 } else { 0 });
            assert!(twitch.subs().iter().any(|s| s["type"] == "channel.channel_points_custom_reward_redemption.add"));
            Ok(())
        })
        .await?;
    }
    Ok(())
}
