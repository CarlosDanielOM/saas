#![cfg(feature = "raid-subscriptions")]
//! Source-parity and private adapter checks for
//! `src/utils/raid_subscriptions.rs`.
//!
//! The plain `#[test]` functions need no service, environment value or network.
//! They cover the pure boundaries and replay the externally written source
//! oracle (`tests/fixtures/raid_subscriptions_reference.cjs`) over the actual
//! TypeScript function with in-memory Mongoose models.
//!
//! The `#[ignore]` suites drive the concrete adapter against a lead-owned
//! disposable MongoDB and never contact a production service, database, queue
//! or credential:
//!
//! ```text
//! RAID_SUBSCRIPTIONS_TEST_MONGO_URI=mongodb://127.0.0.1:27017
//! RAID_SUBSCRIPTIONS_TEST_MONGO_DATABASE=rust_raid_subscriptions_fixture_<unique>
//! RAID_SUBSCRIPTIONS_TEST_MONGO_ACK=disposable
//! ```
//!
//! `..._DATABASE` must start with `rust_raid_subscriptions_fixture_`; each suite
//! appends its own suffix, asserts the derived database is empty before use and
//! drops exactly that database afterwards.
//!
//! This module is not declared until the central `utils/mod.rs` and `Cargo.toml`
//! patches in `migration-notes/raid-subscriptions-handoff.md` are applied.
//! Enabling the feature without both makes this target fail to compile.

#[path = "support/raid_subscriptions_support.rs"]
mod support;

use dima_rust::{
    schemas::{eventsub, raid_subscription_preference},
    utils::{
        eventsub::{RaidDirection, raid_direction_value},
        raid_subscriptions::{
            EVENTSUB_QUERY_MAX_TIME_MS, RaidSubscriptionError, RaidSubscriptionRef,
            RaidSubscriptionStore, accepts_config, deleted_preference_filter,
            eventsub_config_filter, eventsub_config_projection, notification_channel_id,
            preference_id_filter, raid_preference_id,
        },
    },
};
use mongodb::{
    bson::{Bson, Document, doc},
    options::ClientOptions,
};
use serde_json::{Value, json};
use std::time::Duration;

// ---------------------------------------------------------------------------
// Pure boundaries
// ---------------------------------------------------------------------------

#[test]
fn preference_id_and_filters_match_the_source() {
    assert_eq!(raid_preference_id("channel-a", RaidDirection::Incoming), "channel-a:incoming");
    assert_eq!(raid_preference_id("channel-a", RaidDirection::Outgoing), "channel-a:outgoing");
    assert_eq!(raid_preference_id("café:1", RaidDirection::Incoming), "café:1:incoming");

    assert_eq!(
        preference_id_filter("channel-a", RaidDirection::Outgoing),
        doc! {"_id": "channel-a:outgoing"}
    );
    assert_eq!(
        deleted_preference_filter("channel-a", RaidDirection::Incoming),
        doc! {"_id": "channel-a:incoming", "deleted": true}
    );
}

#[test]
fn remote_query_is_direction_scoped_and_bounded() {
    assert_eq!(
        eventsub_config_filter("channel-a", RaidDirection::Incoming),
        doc! {
            "channelID": "channel-a",
            "type": "channel.raid",
            "condition.to_broadcaster_user_id": "channel-a",
        }
    );
    assert_eq!(
        eventsub_config_filter("channel-a", RaidDirection::Outgoing),
        doc! {
            "channelID": "channel-a",
            "type": "channel.raid",
            "condition.from_broadcaster_user_id": "channel-a",
        }
    );
    assert_eq!(eventsub_config_projection(), doc! {"enabled": 1, "id": 1});
    assert_eq!(EVENTSUB_QUERY_MAX_TIME_MS, 1500);
    assert_eq!(Duration::from_millis(EVENTSUB_QUERY_MAX_TIME_MS), Duration::from_millis(1500));
}

#[test]
fn direction_uses_the_shared_eventsub_policy() {
    for (condition, expected) in [
        (None, RaidDirection::Incoming),
        (Some(json!({})), RaidDirection::Incoming),
        (Some(json!({"from_broadcaster_user_id": "a"})), RaidDirection::Outgoing),
        (Some(json!({"to_broadcaster_user_id": "a"})), RaidDirection::Incoming),
        (Some(json!({"from_broadcaster_user_id": "a", "to_broadcaster_user_id": ""})), RaidDirection::Outgoing),
        (Some(json!({"from_broadcaster_user_id": "", "to_broadcaster_user_id": "a"})), RaidDirection::Incoming),
        (Some(json!({"from_broadcaster_user_id": "a", "to_broadcaster_user_id": "b"})), RaidDirection::Incoming),
        (Some(json!({"from_broadcaster_user_id": false})), RaidDirection::Incoming),
        (Some(json!({"from_broadcaster_user_id": true})), RaidDirection::Outgoing),
        (Some(json!({"from_broadcaster_user_id": 0})), RaidDirection::Incoming),
        (Some(json!({"from_broadcaster_user_id": 7})), RaidDirection::Outgoing),
    ] {
        assert_eq!(raid_direction_value(condition.as_ref()), expected, "{condition:?}");
    }
}

#[test]
fn notification_channel_uses_direction_and_javascript_coercion() {
    let outgoing = RaidDirection::Outgoing;
    let incoming = RaidDirection::Incoming;
    assert_eq!(
        notification_channel_id(&json!({"from_broadcaster_user_id": "a", "to_broadcaster_user_id": "b"}), outgoing),
        Some("a".into())
    );
    assert_eq!(
        notification_channel_id(&json!({"from_broadcaster_user_id": "a", "to_broadcaster_user_id": "b"}), incoming),
        Some("b".into())
    );
    for event in [
        json!({}),
        json!({"to_broadcaster_user_id": null}),
        json!({"to_broadcaster_user_id": ""}),
        json!({"to_broadcaster_user_id": false}),
        json!({"to_broadcaster_user_id": 0}),
    ] {
        assert_eq!(notification_channel_id(&event, incoming), None, "{event}");
    }
    assert_eq!(notification_channel_id(&json!({"to_broadcaster_user_id": 42}), incoming), Some("42".into()));
    assert_eq!(
        notification_channel_id(&json!({"to_broadcaster_user_id": {"a": 1}}), incoming),
        Some("[object Object]".into())
    );
    assert_eq!(
        notification_channel_id(&json!({"to_broadcaster_user_id": ["a", null, 1]}), incoming),
        Some("a,,1".into())
    );
}

#[test]
fn config_decision_matches_the_source_branches() {
    let incoming = RaidDirection::Incoming;
    let outgoing = RaidDirection::Outgoing;
    // No remote document: only an incoming default with no remote id repairs.
    assert!(accepts_config(incoming, None, None));
    assert!(!accepts_config(incoming, Some("remote-1"), None));
    assert!(accepts_config(incoming, Some(""), None));
    assert!(!accepts_config(outgoing, None, None));
    assert!(!accepts_config(outgoing, Some("remote-1"), None));

    // A remote document: enabled `!== false` and, when a subscription id is
    // present, an exact id match.
    assert!(accepts_config(incoming, None, Some(&doc! {"enabled": true, "id": "remote-1"})));
    assert!(accepts_config(incoming, Some("remote-1"), Some(&doc! {"enabled": true, "id": "remote-1"})));
    assert!(!accepts_config(incoming, Some("remote-2"), Some(&doc! {"enabled": true, "id": "remote-1"})));
    assert!(!accepts_config(incoming, Some("remote-1"), Some(&doc! {"enabled": true})));
    assert!(!accepts_config(incoming, None, Some(&doc! {"enabled": false, "id": "remote-1"})));
    assert!(accepts_config(incoming, Some("remote-1"), Some(&doc! {"id": "remote-1"})));
    assert!(accepts_config(incoming, Some("remote-1"), Some(&doc! {"enabled": "false", "id": "remote-1"})));
    assert!(accepts_config(outgoing, Some("remote-1"), Some(&doc! {"enabled": true, "id": "remote-1"})));
    assert!(!accepts_config(outgoing, None, Some(&doc! {"enabled": false, "id": "remote-1"})));
}

// ---------------------------------------------------------------------------
// Source oracle replay
// ---------------------------------------------------------------------------

fn recorded_filter(call: &Value, label: &str) -> Document {
    support::document(&call["filter"])
}

fn assert_config_call(call: &Value, channel: &str, direction: RaidDirection, label: &str) {
    assert_eq!(call["op"].as_str(), Some("findOne"), "{label}: operation");
    support::assert_document(
        &recorded_filter(call, label),
        &eventsub_config_filter(channel, direction),
        &format!("{label}: filter"),
    );
    assert_eq!(call["projection"].as_str(), Some("enabled id"), "{label}: projection");
    assert_eq!(
        call["maxTimeMS"].as_u64(),
        Some(EVENTSUB_QUERY_MAX_TIME_MS),
        "{label}: maxTimeMS"
    );
}

fn observed_preference(case: &Value) -> Option<Document> {
    let value = &case["observed"]["preference"];
    (!value.is_null()).then(|| support::document(value))
}

fn observed_config(case: &Value) -> Option<Document> {
    let value = &case["observed"]["config"];
    (!value.is_null()).then(|| support::document(value))
}

#[test]
#[ignore = "requires the external source oracle fixture (DIMA_RAID_SUBSCRIPTIONS_FIXTURE_*)"]
fn source_oracle_replays_the_typescript_policy() {
    let fixture = support::fixture();
    let names = support::fixture_case_names(&fixture);
    assert_eq!(fixture["schema"].as_u64(), Some(1));
    assert_eq!(fixture["constants"]["eventType"].as_str(), Some("channel.raid"));
    assert_eq!(fixture["constants"]["maxTimeMS"].as_u64(), Some(EVENTSUB_QUERY_MAX_TIME_MS));
    assert_eq!(fixture["constants"]["configProjection"].as_str(), Some("enabled id"));
    assert_eq!(
        support::document(&fixture["constants"]["existenceProjection"]),
        doc! {"_id": 1}
    );
    assert_eq!(fixture["constants"]["defaultIncoming"].as_bool(), Some(true));
    assert!(names.len() >= 44, "oracle inventory must not shrink: {}", names.len());

    for case in support::cases_of(&fixture, "accepts") {
        let name = case["name"].as_str().expect("case name");
        let input = &case["input"];
        let subscription = &input["subscription"];
        let condition = subscription.get("condition").filter(|value| !value.is_null());
        let id = subscription.get("id").and_then(Value::as_str);
        let event = &input["event"];
        let direction = raid_direction_value(condition);
        assert_eq!(
            case["observed"]["direction"].as_str(),
            Some(direction.as_str()),
            "{name}: direction"
        );
        let calls = case["observed"]["calls"].as_array().expect("calls");
        let channel = notification_channel_id(event, direction);
        if channel.is_none() {
            assert!(calls.is_empty(), "{name}: a missing event channel performs no reads");
            assert_eq!(case["expect"]["value"].as_bool(), Some(false), "{name}: value");
            continue;
        }
        let channel = channel.expect("checked");
        assert_eq!(
            calls[0]["op"].as_str(),
            Some("exists"),
            "{name}: deletion probe first"
        );
        support::assert_document(
            &recorded_filter(&calls[0], name),
            &deleted_preference_filter(&channel, direction),
            &format!("{name}: exists filter"),
        );

        if case["expect"]["ok"].as_bool() == Some(false) {
            let error = case["expect"]["error"].as_str().expect("error text");
            if error.contains("eventsub") {
                assert_eq!(calls.len(), 2, "{name}: failed remote read is the last call");
                assert_config_call(&calls[1], &channel, direction, name);
            } else {
                assert!(error.contains("preference"), "{name}: unexpected error {error}");
                assert_eq!(calls.len(), 1, "{name}: preference failure skips the remote read");
            }
            continue;
        }

        let preference = observed_preference(case);
        if preference
            .as_ref()
            .is_some_and(|preference| preference.get("deleted") == Some(&Bson::Boolean(true)))
        {
            assert_eq!(calls.len(), 1, "{name}: deleted preference skips the remote read");
            assert_eq!(case["expect"]["value"].as_bool(), Some(false), "{name}: deleted value");
            continue;
        }
        assert_eq!(calls.len(), 2, "{name}: existence plus remote read");
        assert_config_call(&calls[1], &channel, direction, name);
        let config = observed_config(case);
        assert_eq!(
            case["expect"]["value"].as_bool(),
            Some(accepts_config(direction, id, config.as_ref())),
            "{name}: native decision"
        );
    }

    for case in support::cases_of(&fixture, "deleted") {
        let name = case["name"].as_str().expect("case name");
        let channel = case["input"]["channelID"].as_str().expect("channelID");
        let direction = match case["observed"]["direction"].as_str() {
            Some("outgoing") => RaidDirection::Outgoing,
            Some("incoming") => RaidDirection::Incoming,
            other => panic!("{name}: direction {other:?}"),
        };
        let calls = case["observed"]["calls"].as_array().expect("calls");
        assert_eq!(calls.len(), 1, "{name}: one existence probe");
        assert_eq!(calls[0]["op"].as_str(), Some("exists"));
        support::assert_document(
            &recorded_filter(&calls[0], name),
            &deleted_preference_filter(channel, direction),
            &format!("{name}: exists filter"),
        );
        if case["expect"]["ok"].as_bool() == Some(false) {
            continue;
        }
        let deleted = observed_preference(case)
            .is_some_and(|preference| preference.get("deleted") == Some(&Bson::Boolean(true)));
        assert_eq!(case["expect"]["value"].as_bool(), Some(deleted), "{name}: value");
    }

    for case in support::cases_of(&fixture, "repair") {
        let name = case["name"].as_str().expect("case name");
        let channel = case["input"]["channelID"].as_str().expect("channelID");
        let direction = match case["observed"]["direction"].as_str() {
            Some("outgoing") => RaidDirection::Outgoing,
            Some("incoming") => RaidDirection::Incoming,
            other => panic!("{name}: direction {other:?}"),
        };
        let calls = case["observed"]["calls"].as_array().expect("calls");
        assert_eq!(calls.len(), 1, "{name}: one preference read");
        assert_eq!(calls[0]["op"].as_str(), Some("findById"));
        support::assert_document(
            &recorded_filter(&calls[0], name),
            &preference_id_filter(channel, direction),
            &format!("{name}: findById filter"),
        );
        if case["expect"]["ok"].as_bool() == Some(false) {
            continue;
        }
        let expected = match observed_preference(case) {
            Some(preference) => preference.get("deleted") != Some(&Bson::Boolean(true)),
            None => direction == RaidDirection::Incoming,
        };
        assert_eq!(case["expect"]["value"].as_bool(), Some(expected), "{name}: value");
    }
}

// ---------------------------------------------------------------------------
// Disposable MongoDB suites
// ---------------------------------------------------------------------------

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn incoming(channel: &str) -> Value {
    json!({"to_broadcaster_user_id": channel})
}

fn outgoing(channel: &str) -> Value {
    json!({"from_broadcaster_user_id": channel})
}

fn event_incoming(channel: &str) -> Value {
    json!({"to_broadcaster_user_id": channel})
}

fn event_outgoing(channel: &str) -> Value {
    json!({"from_broadcaster_user_id": channel})
}

async fn insert_preference(
    database: &mongodb::Database,
    channel: &str,
    direction: &str,
    deleted: Option<bool>,
) -> TestResult {
    let mut document = doc! {
        "_id": format!("{channel}:{direction}"),
        "channelID": channel,
        "direction": direction,
    };
    if let Some(deleted) = deleted {
        document.insert("deleted", deleted);
    }
    raid_subscription_preference::schema()
        .native_collection(database)
        .insert_one(document)
        .await?;
    Ok(())
}

/// Minimal raw EventSub row: the adapter projects only `enabled` and `id`, so
/// seeding the full EventSub contract would add noise without covering it.
async fn insert_config(
    database: &mongodb::Database,
    channel: &str,
    direction: &str,
    enabled: Option<bool>,
    id: &str,
) -> TestResult {
    let field = if direction == "outgoing" {
        "from_broadcaster_user_id"
    } else {
        "to_broadcaster_user_id"
    };
    let mut document = doc! {
        "channelID": channel,
        "type": "channel.raid",
        "condition": doc! {field: channel},
        "id": id,
    };
    if let Some(enabled) = enabled {
        document.insert("enabled", enabled);
    }
    eventsub::collection(database).insert_one(document).await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires a lead-owned disposable MongoDB (RAID_SUBSCRIPTIONS_TEST_MONGO_*)"]
async fn defaults_and_deleted_settings_against_disposable_mongo() -> TestResult {
    let fixture = support::disposable_database("defaults").await?;
    let database = &fixture.database;
    let store = RaidSubscriptionStore::new(database);

    // Construction only resolves handles: no collections and no indexes.
    assert!(database.list_collection_names().await?.is_empty(), "constructor I/O");
    assert!(!store.is_raid_deleted("channel-a", RaidDirection::Incoming).await?);
    assert!(!store.is_raid_deleted("channel-a", RaidDirection::Outgoing).await?);
    assert!(store.should_repair_raid("channel-a", RaidDirection::Incoming).await?);
    assert!(!store.should_repair_raid("channel-a", RaidDirection::Outgoing).await?);
    assert!(database.list_collection_names().await?.is_empty(), "reads must not create collections");

    // Missing remote configuration: incoming repairs by default, outgoing does
    // not, and a remote id prevents an unverified default acceptance.
    assert!(store
        .accepts_raid_notification(
            RaidSubscriptionRef {
                id: None,
                condition: Some(&incoming("channel-a")),
            },
            &event_incoming("channel-a"),
        )
        .await?);
    assert!(!store
        .accepts_raid_notification(
            RaidSubscriptionRef {
                id: None,
                condition: Some(&outgoing("channel-a")),
            },
            &event_outgoing("channel-a"),
        )
        .await?);
    assert!(!store
        .accepts_raid_notification(
            RaidSubscriptionRef {
                id: Some("remote-1"),
                condition: Some(&incoming("channel-a")),
            },
            &event_incoming("channel-a"),
        )
        .await?);

    // A durable deletion blocks both directions and survives an active remote.
    insert_preference(database, "channel-a", "incoming", Some(true)).await?;
    insert_preference(database, "channel-a", "outgoing", Some(true)).await?;
    insert_config(database, "channel-a", "incoming", Some(true), "remote-1").await?;
    insert_config(database, "channel-a", "outgoing", Some(true), "remote-2").await?;
    for direction in [RaidDirection::Incoming, RaidDirection::Outgoing] {
        assert!(store.is_raid_deleted("channel-a", direction).await?);
        assert!(!store.should_repair_raid("channel-a", direction).await?);
    }
    assert!(!store
        .accepts_raid_notification(
            RaidSubscriptionRef {
                id: Some("remote-1"),
                condition: Some(&incoming("channel-a")),
            },
            &event_incoming("channel-a"),
        )
        .await?);

    // An active row and an absent `deleted` field both permit repair; a stored
    // `false` is not a deletion.
    for (channel, deleted) in [("channel-b", Some(false)), ("channel-c", None), ("channel-d", Some(false))] {
        insert_preference(database, channel, "incoming", deleted).await?;
        assert!(!store.is_raid_deleted(channel, RaidDirection::Incoming).await?);
        assert!(store.should_repair_raid(channel, RaidDirection::Incoming).await?);
    }

    fixture.drop_database().await;
    Ok(())
}

#[tokio::test]
#[ignore = "requires a lead-owned disposable MongoDB (RAID_SUBSCRIPTIONS_TEST_MONGO_*)"]
async fn remote_id_and_query_scope_against_disposable_mongo() -> TestResult {
    let fixture = support::disposable_database("remote").await?;
    let database = &fixture.database;
    let store = RaidSubscriptionStore::new(database);

    insert_config(database, "channel-a", "incoming", Some(true), "remote-in-a").await?;
    insert_config(database, "channel-a", "outgoing", Some(true), "remote-out-a").await?;
    insert_config(database, "channel-b", "incoming", Some(true), "remote-in-b").await?;
    insert_config(database, "channel-c", "incoming", Some(false), "remote-in-c").await?;
    insert_config(database, "channel-d", "incoming", None, "remote-in-d").await?;

    // Exact remote-id acceptance for the matching direction.
    assert!(store
        .accepts_raid_notification(
            RaidSubscriptionRef {
                id: Some("remote-in-a"),
                condition: Some(&incoming("channel-a")),
            },
            &event_incoming("channel-a"),
        )
        .await?);
    assert!(store
        .accepts_raid_notification(
            RaidSubscriptionRef {
                id: Some("remote-out-a"),
                condition: Some(&outgoing("channel-a")),
            },
            &event_outgoing("channel-a"),
        )
        .await?);

    // A stale/duplicate remote id is rejected even though the row exists.
    assert!(!store
        .accepts_raid_notification(
            RaidSubscriptionRef {
                id: Some("remote-stale"),
                condition: Some(&incoming("channel-a")),
            },
            &event_incoming("channel-a"),
        )
        .await?);
    // A direction's row cannot authorize the other direction.
    assert!(!store
        .accepts_raid_notification(
            RaidSubscriptionRef {
                id: Some("remote-in-a"),
                condition: Some(&outgoing("channel-a")),
            },
            &event_outgoing("channel-a"),
        )
        .await?);
    // An incoming id is not valid for an outgoing subscription.
    assert!(!store
        .accepts_raid_notification(
            RaidSubscriptionRef {
                id: Some("remote-out-a"),
                condition: Some(&incoming("channel-a")),
            },
            &event_incoming("channel-a"),
        )
        .await?);

    // A row for another channel never authorizes this channel.
    assert!(store
        .accepts_raid_notification(
            RaidSubscriptionRef {
                id: None,
                condition: Some(&incoming("channel-a")),
            },
            &event_incoming("channel-a"),
        )
        .await?);
    assert!(store
        .accepts_raid_notification(
            RaidSubscriptionRef {
                id: None,
                condition: Some(&incoming("channel-b")),
            },
            &event_incoming("channel-b"),
        )
        .await?);

    // `enabled: false` rejects; an absent enabled field is enabled.
    assert!(!store
        .accepts_raid_notification(
            RaidSubscriptionRef {
                id: None,
                condition: Some(&incoming("channel-c")),
            },
            &event_incoming("channel-c"),
        )
        .await?);
    assert!(store
        .accepts_raid_notification(
            RaidSubscriptionRef {
                id: Some("remote-in-d"),
                condition: Some(&incoming("channel-d")),
            },
            &event_incoming("channel-d"),
        )
        .await?);
    assert!(!store
        .accepts_raid_notification(
            RaidSubscriptionRef {
                id: Some("remote-other"),
                condition: Some(&incoming("channel-d")),
            },
            &event_incoming("channel-d"),
        )
        .await?);

    // The deletion probe still wins over an otherwise valid remote row.
    insert_preference(database, "channel-a", "incoming", Some(true)).await?;
    assert!(!store
        .accepts_raid_notification(
            RaidSubscriptionRef {
                id: Some("remote-in-a"),
                condition: Some(&incoming("channel-a")),
            },
            &event_incoming("channel-a"),
        )
        .await?);

    fixture.drop_database().await;
    Ok(())
}

#[tokio::test]
#[ignore = "requires loopback only; no service, database or credential"]
async fn read_errors_are_reported_as_the_typed_adapter_error() -> TestResult {
    // No server is started or contacted. Port 1 on loopback with a short server
    // selection deadline yields the driver's own operation error deterministically.
    let options = ClientOptions::parse(
        "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=100&connectTimeoutMS=100",
    )
    .await?;
    let client = mongodb::Client::with_options(options)?;
    let database = client.database("rust_raid_subscriptions_fixture_errors");
    let store = RaidSubscriptionStore::new(&database);

    for error in [
        store.is_raid_deleted("channel-a", RaidDirection::Incoming).await.unwrap_err(),
        store.should_repair_raid("channel-a", RaidDirection::Incoming).await.unwrap_err(),
        store
            .accepts_raid_notification(
                RaidSubscriptionRef {
                    id: None,
                    condition: Some(&incoming("channel-a")),
                },
                &event_incoming("channel-a"),
            )
            .await
            .unwrap_err(),
    ] {
        assert!(matches!(&error, RaidSubscriptionError::Mongo(_)), "{error:?}");
        assert!(error.to_string().starts_with("raid subscription read failed"), "{error}");
    }
    Ok(())
}
