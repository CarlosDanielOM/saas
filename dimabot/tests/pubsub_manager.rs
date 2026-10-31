#![cfg(feature = "pubsub-manager")]

//! Pub/Sub manager parity: `dimabot/src/classes/pubsub_manager.class.ts`.
//!
//! The plain `#[test]` functions need no server, environment value or network.
//! They pin the source's payload construction (`JSON.stringify({ ...data,
//! timestamp: Date.now() })`), the clip channel template and the one-handler-per-
//! channel registry.
//!
//! The source comparison is authored by
//! `tests/fixtures/pubsub_manager_reference.cjs` and replayed only when the
//! external fixture is supplied:
//!
//! ```text
//! DIMA_PUBSUB_MANAGER_FIXTURE_DIR=<absolute dir outside the workspace>
//! DIMA_PUBSUB_MANAGER_FIXTURE_SHA256=<lowercase hex>
//! ```
//!
//! The `#[ignore]` adapter suites drive the real Redis/Dragonfly path against a
//! task-owned disposable instance, never a production service:
//!
//! ```text
//! DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration
//! DIMA_TEST_REDIS_URL=redis://127.0.0.1:6379/
//! ```
//!
//! Every channel name is derived from a random per-run prefix
//! (`dima:test:pubsub:<pid>:<nanos>:<name>`), so the suites never publish to or
//! observe an application channel. Nothing is deleted or flushed: a Pub/Sub
//! channel holds no data, and the suites only assert that their own prefix is
//! released. One suite intentionally connects to a closed loopback port to prove
//! that a connection failure is propagated; it binds and releases a task-owned
//! ephemeral port and never touches a listening service.

#[path = "support/pubsub_manager_support.rs"]
mod support;

use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use dima_rust::utils::{
    js_string::JsString,
    logger::Clock,
    lossless_json::{JsonValue, parse_json},
    pubsub_manager::{
        CLIP_REQUEST_TEMPLATE, HandlerRegistry, PubSubError, PubSubManager, clip_request_channel,
        payload_with_timestamp,
    },
};
use redis::aio::ConnectionManager;

const FIXED_NOW: i64 = 1_767_323_045_000;
const LIMIT: Duration = Duration::from_secs(5);
const RELEASE: Duration = Duration::from_secs(5);

/// Counts the source oracle's case inventory. The oracle writer and this list
/// must move together.
const ORACLE_CASES: [&str; 29] = [
    "publish_object_fields_then_timestamp",
    "publish_existing_timestamp_keeps_its_position",
    "publish_nested_and_scalar_fields",
    "publish_empty_object",
    "publish_array_spread",
    "publish_string_spread",
    "publish_null_spread",
    "publish_number_spread",
    "publish_undefined_fields_are_dropped",
    "publish_escapes_quotes_and_controls",
    "publish_unicode_and_surrogate_pair",
    "publish_lone_surrogate",
    "publish_mixed_key_order",
    "clip_channel_numeric",
    "clip_channel_colon",
    "clip_channel_empty",
    "clip_channel_braces",
    "subscribe_single_dispatch",
    "subscribe_replacement_calls_the_new_handler_once_per_listener",
    "unsubscribe_stops_dispatch_and_removes_the_handler",
    "unsubscribe_before_init_is_a_noop",
    "publish_before_init_initializes_both_clients",
    "publish_failure_is_logged_and_rethrown",
    "subscribe_failure_keeps_the_handler_in_the_map",
    "init_failure_is_logged_by_init_and_by_the_caller",
    "publish_after_a_failed_init_does_not_retry",
    "malformed_payload_throws_out_of_the_channel_listener",
    "handle_message_swallows_invalid_json_and_logs",
    "handle_message_dispatches_valid_json",
];

const PUBLISH_CASES: usize = 13;
const CLIP_CASES: usize = 4;

struct FixedClock(i64);

impl Clock for FixedClock {
    fn now_millis(&self) -> i64 {
        self.0
    }
}

fn value(json: &str) -> JsonValue {
    parse_json(json).expect("valid JSON")
}

fn object(fields: &[(&str, &str)]) -> JsonValue {
    JsonValue::Object(
        fields
            .iter()
            .map(|(key, value)| (JsString::from(*key), JsonValue::String(JsString::from(*value))))
            .collect(),
    )
}

fn counter(calls: &support::Counted) -> Arc<dyn Fn(&JsonValue) + Send + Sync> {
    let calls = calls.clone();
    Arc::new(move |_: &JsonValue| calls.bump())
}

// --- pure rules -----------------------------------------------------------

#[test]
fn payload_spreads_fields_then_appends_the_timestamp() {
    assert_eq!(
        payload_with_timestamp(&value(r#"{"channelID":"123","session":"abc"}"#), FIXED_NOW),
        r#"{"channelID":"123","session":"abc","timestamp":1767323045000}"#
    );
}

#[test]
fn payload_replaces_an_existing_timestamp_in_place() {
    // `{ ...data, timestamp }` keeps the original key position.
    assert_eq!(
        payload_with_timestamp(&value(r#"{"timestamp":1,"channelID":"123"}"#), 7),
        r#"{"timestamp":7,"channelID":"123"}"#
    );
}

#[test]
fn payload_spreads_arrays_strings_and_scalars_like_javascript() {
    assert_eq!(
        payload_with_timestamp(&value(r#"["a","b"]"#), 1),
        r#"{"0":"a","1":"b","timestamp":1}"#
    );
    assert_eq!(
        payload_with_timestamp(&value(r#""ab""#), 1),
        r#"{"0":"a","1":"b","timestamp":1}"#
    );
    assert_eq!(
        payload_with_timestamp(&value("null"), 1),
        r#"{"timestamp":1}"#
    );
    assert_eq!(
        payload_with_timestamp(&value("42"), 1),
        r#"{"timestamp":1}"#
    );
    assert_eq!(
        payload_with_timestamp(&JsonValue::Object(Vec::new()), 1),
        r#"{"timestamp":1}"#
    );
}

#[test]
fn payload_orders_canonical_indices_before_named_keys() {
    let data = JsonValue::Object(vec![
        (JsString::from("b"), JsonValue::Number(1.0)),
        (JsString::from("2"), JsonValue::String(JsString::from("two"))),
        (JsString::from("1"), JsonValue::String(JsString::from("one"))),
    ]);
    assert_eq!(
        payload_with_timestamp(&data, 3),
        r#"{"1":"one","2":"two","b":1,"timestamp":3}"#
    );
}

#[test]
fn payload_escapes_like_json_stringify() {
    assert_eq!(
        payload_with_timestamp(&value(r#"{"text":"a\"b\\c\nd\te\u0001"}"#), 1),
        r#"{"text":"a\"b\\c\nd\te\u0001","timestamp":1}"#
    );
    // A lone surrogate is escaped, never replaced or dropped.
    assert_eq!(
        payload_with_timestamp(&value(r#"{"text":"\ud800"}"#), 1),
        r#"{"text":"\ud800","timestamp":1}"#
    );
}

#[test]
fn clip_request_channel_matches_the_source_template() {
    assert_eq!(CLIP_REQUEST_TEMPLATE, "twitch:{}:clip:request");
    assert_eq!(
        clip_request_channel("123"),
        "twitch:123:clip:request"
    );
    assert_eq!(clip_request_channel("a:b"), "twitch:a:b:clip:request");
    assert_eq!(clip_request_channel(""), "twitch::clip:request");
    // Only the template's own placeholder is replaced.
    assert_eq!(
        clip_request_channel("{}"),
        "twitch:{}:clip:request"
    );
}

#[test]
fn registry_keeps_exactly_one_handler_per_channel() {
    let mut registry = HandlerRegistry::new();
    assert!(registry.is_empty());
    let first = counter(&support::Counted::new());
    let second = counter(&support::Counted::new());
    assert!(registry.set("a", first.clone()).is_none());
    assert!(registry.set("b", first.clone()).is_none());
    assert_eq!(registry.len(), 2);
    assert!(registry.set("a", second).is_some());
    assert_eq!(registry.len(), 2);
    assert!(registry.contains("a"));
    assert!(registry.remove("a").is_some());
    assert!(registry.remove("a").is_none());
    assert_eq!(registry.len(), 1);
    registry.clear();
    assert!(registry.is_empty());
}

// --- source oracle --------------------------------------------------------

#[test]
#[ignore = "requires the external source oracle fixture"]
fn oracle_case_names_are_pinned() {
    let fixture = support::fixture();
    assert_eq!(support::fixture_case_names(&fixture), ORACLE_CASES);
}

#[test]
#[ignore = "requires the external source oracle fixture"]
fn publish_payload_cases_replay_natively() {
    let fixture = support::fixture();
    let mut replayed = 0;
    for case in support::native_cases(&fixture) {
        if case["kind"] != "publish-payload" {
            continue;
        }
        let data = parse_json(support::input_json(case, "dataJson")).expect("recorded data");
        let timestamp = case["input"]["timestamp"].as_i64().expect("timestamp");
        let payload = payload_with_timestamp(&data, timestamp);
        assert_eq!(
            payload,
            case["expect"]["payload"].as_str().expect("payload"),
            "{}",
            case["name"]
        );
        assert_eq!(
            case["expect"]["channel"].as_str(),
            Some("oracle:publish"),
            "{}",
            case["name"]
        );
        replayed += 1;
    }
    assert_eq!(replayed, PUBLISH_CASES, "replayed publish cases");
}

#[test]
#[ignore = "requires the external source oracle fixture"]
fn clip_channel_cases_replay_natively() {
    let fixture = support::fixture();
    let mut replayed = 0;
    for case in support::native_cases(&fixture) {
        if case["kind"] != "clip-channel" {
            continue;
        }
        let channel_id = case["input"]["channelID"].as_str().expect("channelID");
        assert_eq!(
            clip_request_channel(channel_id),
            case["expect"]["channel"].as_str().expect("channel"),
            "{}",
            case["name"]
        );
        replayed += 1;
    }
    assert_eq!(replayed, CLIP_CASES, "replayed clip cases");
}

/// The recorded source-side evidence for the four deliberate differences.
#[test]
#[ignore = "requires the external source oracle fixture"]
fn divergence_evidence_is_recorded() {
    let fixture = support::fixture();

    let replacement = support::fixture_case(
        &fixture,
        "subscribe_replacement_calls_the_new_handler_once_per_listener",
    );
    assert_eq!(replacement["expect"]["first"], 0);
    assert_eq!(replacement["expect"]["second"], 2);
    assert_eq!(replacement["expect"]["listeners"], 2);
    assert_eq!(replacement["expect"]["commands"], 1);

    let failed = support::fixture_case(&fixture, "subscribe_failure_keeps_the_handler_in_the_map");
    assert_eq!(failed["expect"]["leakedCalls"], 1);
    assert_eq!(failed["expect"]["subscribeCommands"], 0);

    let malformed =
        support::fixture_case(&fixture, "malformed_payload_throws_out_of_the_channel_listener");
    assert_eq!(malformed["expect"]["threw"], true);
    assert_eq!(malformed["expect"]["handlerCalls"], 0);

    let retry = support::fixture_case(&fixture, "publish_after_a_failed_init_does_not_retry");
    assert_eq!(retry["expect"]["caught"], "The client is closed");
    assert_eq!(retry["expect"]["duplicates"], 2);
    assert_eq!(retry["expect"]["connects"], 0);
}

// --- task-owned disposable Redis -----------------------------------------

fn native_manager(url: &str) -> PubSubManager {
    let client = redis::Client::open(url).expect("fixture client");
    PubSubManager::new(client, None).with_clock(Arc::new(FixedClock(FIXED_NOW)))
}

/// Bounded wait for the fixture to report that no subscription from this run is
/// still attached. The socket is released by the runtime, so this is a real
/// readiness wait, not a cadence.
async fn wait_for_release(manager: &ConnectionManager, channels: &support::Channels) {
    let pattern = format!("{}:*", channels.token());
    let deadline = Instant::now() + RELEASE;
    loop {
        let mut connection = manager.clone();
        let listed: Vec<String> = redis::cmd("PUBSUB")
            .arg("CHANNELS")
            .arg(&pattern)
            .query_async(&mut connection)
            .await
            .expect("PUBSUB CHANNELS");
        if listed.is_empty() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "task-owned channels still subscribed: {listed:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "task-owned disposable Dragonfly only"]
async fn publish_reaches_a_subscriber_with_the_source_payload() {
    let channels = support::Channels::new();
    let url = channels.url().to_owned();
    let channel = channels.channel("publish");
    let mut probe = support::Probe::new(&url, &channel).await;
    let manager = native_manager(&url);

    manager
        .publish(&channel, &object(&[("channelID", "123"), ("session", "abc")]))
        .await
        .expect("publish");

    assert_eq!(
        probe.next(LIMIT).await.as_deref(),
        Some(r#"{"channelID":"123","session":"abc","timestamp":1767323045000}"#)
    );
    assert_eq!(manager.stats().published, 1);
    probe.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "task-owned disposable Dragonfly only"]
async fn subscribe_dispatches_a_published_message() {
    let channels = support::Channels::new();
    let url = channels.url().to_owned();
    let channel = channels.channel("subscribe");
    let manager = native_manager(&url);

    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&seen);
    manager
        .subscribe(
            &channel,
            Arc::new(move |data: &JsonValue| {
                recorded.lock().expect("lock").push(data.to_json_string());
            }),
        )
        .await
        .expect("subscribe");

    assert_eq!(
        support::raw_publish(&url, &channel, r#"{"channelID":"42"}"#).await,
        1
    );
    assert!(support::wait_until(|| !seen.lock().expect("lock").is_empty()).await);
    assert_eq!(
        seen.lock().expect("lock").as_slice(),
        [r#"{"channelID":"42"}"#]
    );
    assert_eq!(manager.stats().received, 1);
    assert_eq!(manager.handlers().read().await.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "task-owned disposable Dragonfly only"]
async fn subscribe_replaces_the_handler_and_dispatches_once() {
    let channels = support::Channels::new();
    let url = channels.url().to_owned();
    let channel = channels.channel("replace");
    let manager = native_manager(&url);

    let first = support::Counted::new();
    let second = support::Counted::new();
    manager
        .subscribe(&channel, counter(&first))
        .await
        .expect("first subscribe");
    manager
        .subscribe(&channel, counter(&second))
        .await
        .expect("second subscribe");

    assert_eq!(
        support::raw_publish(&url, &channel, r#"{"channelID":"42"}"#).await,
        1
    );
    assert!(support::wait_until(|| manager.stats().received == 1).await);
    // Exactly one dispatch, and only to the replacement.
    assert_eq!(second.value(), 1);
    assert_eq!(first.value(), 0);
    assert_eq!(manager.handlers().read().await.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "task-owned disposable Dragonfly only"]
async fn unsubscribe_stops_dispatch_and_clears_the_registry() {
    let channels = support::Channels::new();
    let url = channels.url().to_owned();
    let channel = channels.channel("unsubscribe");
    let manager = native_manager(&url);

    let calls = support::Counted::new();
    manager
        .subscribe(&channel, counter(&calls))
        .await
        .expect("subscribe");
    manager.unsubscribe(&channel).await.expect("unsubscribe");

    assert!(manager.handlers().read().await.is_empty());
    // The server reports no receiver, so the subscription is really gone.
    assert_eq!(
        support::raw_publish(&url, &channel, r#"{"channelID":"42"}"#).await,
        0
    );
    assert_eq!(calls.value(), 0);
    // Unsubscribing an unknown channel stays a successful no-op.
    manager
        .unsubscribe(&channel)
        .await
        .expect("second unsubscribe");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "task-owned disposable Dragonfly only"]
async fn invalid_json_is_counted_and_the_subscription_survives() {
    let channels = support::Channels::new();
    let url = channels.url().to_owned();
    let channel = channels.channel("malformed");
    let manager = native_manager(&url);

    let calls = support::Counted::new();
    manager
        .subscribe(&channel, counter(&calls))
        .await
        .expect("subscribe");

    assert_eq!(
        support::raw_publish(&url, &channel, "not json").await,
        1
    );
    assert_eq!(
        support::raw_publish(&url, &channel, r#"{"channelID":"42"}"#).await,
        1
    );
    assert!(support::wait_until(|| calls.value() == 1).await);
    assert_eq!(manager.stats().malformed, 1);
    assert_eq!(manager.stats().received, 2);
    assert!(manager.is_connected());
    assert_eq!(manager.handlers().read().await.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "task-owned disposable Dragonfly only"]
async fn connection_failures_are_propagated_and_retryable() {
    let channels = support::Channels::new();
    let channel = channels.channel("closed");
    // A task-owned ephemeral loopback port with nothing listening on it.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("ephemeral port");
    let port = listener.local_addr().expect("address").port();
    drop(listener);
    let client = redis::Client::open(format!("redis://127.0.0.1:{port}/")).expect("client");
    let manager = PubSubManager::new(client, None);

    for _ in 0..2 {
        let error = manager
            .publish(&channel, &object(&[("channelID", "123")]))
            .await
            .expect_err("publish must fail");
        assert!(matches!(&error, PubSubError::Redis(_)), "{error}");
        assert!(!manager.is_connected());
    }
    assert!(manager.init().await.is_err());
    assert_eq!(manager.stats().published, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "task-owned disposable Dragonfly only"]
async fn shutdown_stops_dispatch_and_allows_reinitialization() {
    let channels = support::Channels::new();
    let url = channels.url().to_owned();
    let channel = channels.channel("shutdown");
    let manager = native_manager(&url);

    let before = support::Counted::new();
    manager
        .subscribe(&channel, counter(&before))
        .await
        .expect("subscribe");
    let observer = support::raw_connection(&url).await;
    assert_eq!(
        support::raw_publish(&url, &channel, r#"{"channelID":"1"}"#).await,
        1
    );
    assert!(support::wait_until(|| before.value() == 1).await);

    manager.shutdown().await;
    assert!(!manager.is_connected());
    assert!(manager.handlers().read().await.is_empty());
    wait_for_release(&observer, &channels).await;
    assert_eq!(
        support::raw_publish(&url, &channel, r#"{"channelID":"2"}"#).await,
        0
    );
    assert_eq!(before.value(), 1);

    // A later subscribe initializes a fresh connection.
    let after = support::Counted::new();
    manager
        .subscribe(&channel, counter(&after))
        .await
        .expect("resubscribe");
    assert!(manager.is_connected());
    assert_eq!(
        support::raw_publish(&url, &channel, r#"{"channelID":"3"}"#).await,
        1
    );
    assert!(support::wait_until(|| after.value() == 1).await);
    assert_eq!(before.value(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "task-owned disposable Dragonfly only"]
async fn dropping_the_manager_cancels_the_dispatch_task() {
    let channels = support::Channels::new();
    let url = channels.url().to_owned();
    let channel = channels.channel("drop");
    let calls = support::Counted::new();
    {
        let manager = native_manager(&url);
        manager
            .subscribe(&channel, counter(&calls))
            .await
            .expect("subscribe");
        assert_eq!(
            support::raw_publish(&url, &channel, r#"{"channelID":"1"}"#).await,
            1
        );
        assert!(support::wait_until(|| calls.value() == 1).await);
    }

    let observer = support::raw_connection(&url).await;
    wait_for_release(&observer, &channels).await;
    assert_eq!(
        support::raw_publish(&url, &channel, r#"{"channelID":"2"}"#).await,
        0
    );
    assert_eq!(calls.value(), 1);
}
