//! The reference's contract tests (`domain_events/domain_event_contracts.test.ts`,
//! `twitch_eventsub_events.test.ts`, `polar_events.test.ts`, `goal_custom_events.test.ts`), with
//! their case names. The Twitch fixtures `generateTestPayload` makes are taken from the recording
//! (its `fixture <type>` cases). Cases that need JavaScript-only values (cycles, accessors,
//! symbols, `Map`, `BigInt`, functions, array holes) have no Rust form and are left out; every
//! value Rust can hold is covered, with emoji, combining marks and right-to-left text.

mod support;

use anyhow::{Result, anyhow, ensure};
use dima_events::contracts::{
    Check, ContractError, JournalInput, MAX_JSON_BYTES, OccurredAt, SubjectInput, Topic,
    polar_billing_payload, retention_seconds, twitch_payload, validate_contract,
};
use dima_events::identity::encode_uri_component;
use dima_events::producers::goals::{CustomGoalContribution, GoalError};
use dima_events::producers::polar::PolarWebhook;
use dima_events::producers::twitch::{TwitchNotification, normalize as twitch_normalize};
use dima_events::value::{Object, Value};
use serde_json::json;

const NOW: i64 = 1_794_392_430_456;

type Mutation = Box<dyn Fn(&mut Object)>;
const TIMESTAMP: &str = "2026-09-05T12:00:00.000Z";

fn ingest(input: &Object) -> Result<(), ContractError> {
    validate_contract(input, Check::ingest(NOW))
}

fn retained(input: &Object) -> Result<(), ContractError> {
    validate_contract(input, Check::retained(NOW))
}

fn object(json: serde_json::Value) -> Object {
    match Value::from_json(&json) {
        Value::Object(object) => object,
        _ => Object::new(),
    }
}

fn notification(kind: &str, version: Option<&str>, event: serde_json::Value) -> TwitchNotification {
    let mut subscription = Object::new();
    subscription.insert("type", Value::from(kind));
    if let Some(version) = version {
        subscription.insert("version", Value::from(version));
    }
    TwitchNotification {
        message_id: "receipt".into(),
        message_timestamp: None,
        message_retry: None,
        stale_retry: None,
        subscription,
        event: Value::from_json(&event),
        source: None,
        durable_chat_handled: false,
        durable_defense_handled: false,
    }
}

/// `twitch(type, event)` of the reference test.
fn twitch(kind: &str, event: serde_json::Value) -> Result<Object> {
    let version = if kind == "channel.follow" { "2" } else { "1" };
    Ok(twitch_normalize(&notification(kind, Some(version), event))?
        .ok_or_else(|| anyhow!("journaled"))?
        .to_object())
}

fn follow() -> Result<Object> {
    twitch(
        "channel.follow",
        json!({ "broadcaster_user_id": "channel", "user_id": "follower" }),
    )
}

fn date(text: &str) -> f64 {
    dima_text::parse_date(text).map_or(f64::NAN, |ms| ms as f64)
}

/// `polar(type, data)` of the reference test.
fn polar(kind: &str, data: Value) -> Result<Object> {
    Ok(dima_events::producers::polar::normalize(
        &PolarWebhook {
            webhook_id: "receipt".into(),
            event_type: kind.into(),
            timestamp: Value::Date(date(TIMESTAMP)),
            data,
        },
        NOW,
    )?
    .to_object())
}

fn paid_order() -> Result<Object> {
    polar(
        "order.paid",
        Value::from_json(
            &json!({ "id": "order", "customerId": "customer", "paid": true, "status": "paid" }),
        ),
    )
}

fn set(object: &mut Object, path: &[&str], value: Value) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut current = object;
    for key in parents {
        let Some(Value::Object(next)) = current.get_mut(key) else {
            return;
        };
        current = next;
    }
    current.insert(*last, value);
}

fn remove(object: &mut Object, path: &[&str]) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut current = object;
    for key in parents {
        let Some(Value::Object(next)) = current.get_mut(key) else {
            return;
        };
        current = next;
    }
    current.remove(last);
}

/// The fixtures `generateTestPayload` made for every journaled type, from the recording.
fn fixtures() -> Result<Vec<(String, TwitchNotification)>> {
    let recording = support::recorded()?;
    let mut out = Vec::new();
    for case in recording["cases"].as_array().into_iter().flatten() {
        let Some(name) = case["name"]
            .as_str()
            .and_then(|n| n.strip_prefix("fixture "))
        else {
            continue;
        };
        let input = support::decode_object(&case["input"])?;
        out.push((
            name.to_owned(),
            TwitchNotification {
                message_id: name.to_owned(),
                message_timestamp: Some(TIMESTAMP.into()),
                message_retry: None,
                stale_retry: None,
                subscription: input
                    .at("subscription")
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                event: input.at("event").clone(),
                source: Some("twitch-eventsub-test".into()),
                durable_chat_handled: false,
                durable_defense_handled: false,
            },
        ));
    }
    ensure!(out.len() == 26, "{} fixtures", out.len());
    Ok(out)
}

#[test]
fn producer_retention_cannot_exceed_the_bounded_topic_horizon() -> Result<()> {
    for topic in [
        Topic::Channel,
        Topic::Activity,
        Topic::Telemetry,
        Topic::Domain,
    ] {
        let input = JournalInput {
            source: "extension".into(),
            source_event_id: "receipt".into(),
            kind: "extension.event".into(),
            topic,
            schema_version: None,
            owner_user_id: None,
            subject: Some(SubjectInput {
                provider: "extension".into(),
                kind: "resource".into(),
                id: "subject".into(),
            }),
            channel_id: Some("channel".into()),
            stream_id: None,
            occurred_at: None,
            payload: Object::new(),
            metadata: None,
            retention_seconds: Some(retention_seconds(topic)),
        };
        ensure!(input.validate(Check::ingest(NOW)).is_ok());
        for too_long in [retention_seconds(topic) + 1.0, 8e12] {
            let error = JournalInput {
                retention_seconds: Some(too_long),
                ..input.clone()
            }
            .validate(Check::ingest(NOW));
            ensure!(error.is_err_and(|e| e.reason().contains("topic retention limit")));
        }
    }
    Ok(())
}

#[test]
fn pre_75e22ef_retained_twitch_rows_remain_valid_without_inventing_a_subject_or_owner() -> Result<()>
{
    for source in ["twitch-eventsub", "twitch-eventsub-test"] {
        for (kind, fixture) in fixtures()? {
            if kind == "channel.raid" {
                continue;
            }
            let journal_type =
                dima_events::contracts::twitch_type(&kind).ok_or_else(|| anyhow!("type"))?;
            let event = fixture.event.clone();
            let occurred = match kind.as_str() {
                "channel.follow" => event.at("followed_at").as_str().map_or(f64::NAN, date),
                "stream.online" => event.at("started_at").as_str().map_or(f64::NAN, date),
                _ => date(TIMESTAMP),
            };
            let mut row = Object::new();
            row.insert("_id", Value::ObjectId(bson::oid::ObjectId::new()));
            row.insert(
                "eventKey",
                Value::from(format!("{source}:legacy-receipt:{journal_type}")),
            );
            row.insert("source", Value::from(source));
            row.insert("sourceEventId", Value::from("legacy-receipt"));
            row.insert("type", Value::from(journal_type));
            row.insert("topic", Value::from("channel"));
            row.insert("schemaVersion", Value::Number(1.0));
            // The recorded fixtures were generated for channel 1001.
            row.insert("channelID", Value::from("1001"));
            if kind == "stream.online" {
                row.insert("streamID", event.at("id").clone());
            }
            row.insert("occurredAt", Value::Date(occurred));
            row.insert("journaledAt", Value::Date(date(TIMESTAMP)));
            row.insert("expiresAt", Value::Date(date("2026-12-04T12:00:00Z")));
            let mut payload = Object::new();
            payload.insert("subscription", Value::Object(fixture.subscription.clone()));
            payload.insert("event", event.clone());
            row.insert("payload", Value::Object(payload));
            row.insert("metadata", Value::Object(object(json!({
                "originalEventType": kind,
                "subscriptionID": fixture.subscription.at("id").as_str().unwrap_or_default(),
                "subscriptionVersion": fixture.subscription.at("version").as_str().unwrap_or_default(),
                "messageTimestamp": TIMESTAMP,
            }))));
            ensure!(
                retained(&row).is_ok(),
                "{source} {kind}: {:?}",
                retained(&row)
            );
            ensure!(
                ingest(&row).is_err(),
                "{source} {kind}: ingest refuses the legacy shape"
            );
            ensure!(twitch_payload(&row, NOW).is_ok());
            let mut retry = row.clone();
            set(
                &mut retry,
                &["metadata", "messageRetry"],
                Value::Number(2.0),
            );
            set(&mut retry, &["metadata", "staleRetry"], Value::Bool(true));
            ensure!(retained(&retry).is_ok());
            let mutations: Vec<Mutation> = vec![
                Box::new(|r| {
                    set(
                        r,
                        &["payload", "event", "broadcaster_user_id"],
                        Value::from("other"),
                    )
                }),
                Box::new(|r| set(r, &["payload", "event"], Value::Object(Object::new()))),
                Box::new(|r| {
                    set(
                        r,
                        &["metadata", "originalEventType"],
                        Value::from("channel.raid"),
                    )
                }),
                Box::new(|r| set(r, &["metadata", "durableChatHandled"], Value::Bool(true))),
                Box::new(|r| set(r, &["metadata", "durableDefenseHandled"], Value::Bool(true))),
                Box::new(|r| {
                    r.insert("subject", Value::Object(object(json!({ "provider": "twitch", "kind": "streaming-account", "id": "other" }))))
                }),
                Box::new(|r| r.insert("eventKey", Value::from("different-receipt"))),
                Box::new(|r| r.insert("journaledAt", Value::Date(f64::NAN))),
                Box::new(|r| r.insert("schemaVersion", Value::Number(2.0))),
            ];
            for (index, mutate) in mutations.iter().enumerate() {
                let mut malformed = row.clone();
                mutate(&mut malformed);
                ensure!(
                    retained(&malformed).is_err(),
                    "{source} {kind}: mutation {index} accepted"
                );
            }
            let mut ingress = row.clone();
            for key in ["_id", "eventKey", "journaledAt", "expiresAt"] {
                ingress.remove(key);
            }
            ensure!(retained(&ingress).is_err());
        }
    }
    Ok(())
}

#[test]
fn all_shipped_twitch_fixture_types_and_legacy_bits_aliases_satisfy_schema_1_unchanged()
-> Result<()> {
    for (kind, fixture) in fixtures()? {
        let input = twitch_normalize(&fixture)?.ok_or_else(|| anyhow!("{kind} journaled"))?;
        let object = input.to_object();
        ensure!(retained(&object).is_ok(), "{kind}: {:?}", retained(&object));
        ensure!(twitch_payload(&object, NOW).is_ok());
        ensure!(
            input.payload.at("event") == &fixture.event,
            "{kind}: payload unchanged"
        );
    }
    Ok(())
}

#[test]
fn follow_time_fallback_permits_no_timestamps_message_time_or_nanosecond_provider_time()
-> Result<()> {
    let missing = follow()?;
    ensure!(retained(&missing).is_ok() && !missing.has("occurredAt"));
    let mut fallback = notification(
        "channel.follow",
        None,
        json!({ "broadcaster_user_id": "channel", "user_id": "follower" }),
    );
    fallback.message_timestamp = Some(TIMESTAMP.into());
    let fallback = twitch_normalize(&fallback)?.ok_or_else(|| anyhow!("event"))?;
    ensure!(fallback.occurred_at == Some(OccurredAt::Text(TIMESTAMP.into())));
    ensure!(fallback.validate(Check::retained(NOW)).is_ok());
    let precise = twitch(
        "channel.follow",
        json!({ "broadcaster_user_id": "channel", "user_id": "follower", "followed_at": "2026-09-05T12:00:00.123456789Z" }),
    )?;
    ensure!(retained(&precise).is_ok());
    let mut stored = precise.clone();
    stored.insert("_id", Value::ObjectId(bson::oid::ObjectId::new()));
    stored.insert("eventKey", Value::from("key"));
    stored.insert("occurredAt", Value::Date(date("2026-09-05T12:00:00.123Z")));
    stored.insert("journaledAt", Value::Date(date(TIMESTAMP)));
    stored.insert("expiresAt", Value::Date(date(TIMESTAMP)));
    ensure!(retained(&stored).is_ok());
    // Only pre-journal inputs may omit the occurrence time.
    let mut without = stored.clone();
    without.remove("occurredAt");
    ensure!(retained(&without).is_err());
    let mut invalid = stored;
    invalid.insert("journaledAt", Value::Date(f64::NAN));
    ensure!(retained(&invalid).is_err());
    Ok(())
}

#[test]
fn anonymous_gifts_preserve_missing_total_and_nullable_sdk_cumulative_totals_without_defaulting_payload()
-> Result<()> {
    let input = twitch(
        "channel.subscription.gift",
        json!({
            "broadcaster_user_id": "channel", "is_anonymous": true, "user_id": null,
            "user_login": null, "user_name": null, "cumulative_total": null
        }),
    )?;
    ensure!(retained(&input).is_ok());
    ensure!(input.at("payload").at("event").at("total").is_undefined());
    Ok(())
}

#[test]
fn known_source_envelope_integrity_and_unsupported_versions_fail_with_permanent_contract_errors()
-> Result<()> {
    let mutations: Vec<Mutation> = vec![
        Box::new(|i| i.insert("source", Value::from("polar-webhook"))),
        Box::new(|i| i.insert("type", Value::from("channel.bits.received"))),
        Box::new(|i| i.insert("topic", Value::from("domain"))),
        Box::new(|i| i.insert("schemaVersion", Value::Number(2.0))),
        Box::new(|i| set(i, &["subject", "id"], Value::from("other"))),
        Box::new(|i| set(i, &["subject", "provider"], Value::from("polar"))),
        Box::new(|i| set(i, &["subject", "kind"], Value::from("customer"))),
        Box::new(|i| i.insert("channelID", Value::from("other"))),
        Box::new(|i| {
            set(
                i,
                &["metadata", "originalEventType"],
                Value::from("channel.raid"),
            )
        }),
        Box::new(|i| remove(i, &["metadata", "originalEventType"])),
        Box::new(|i| set(i, &["metadata", "subscriptionVersion"], Value::from("99"))),
        Box::new(|i| {
            set(
                i,
                &["payload", "subscription", "version"],
                Value::from("99"),
            )
        }),
        Box::new(|i| {
            set(
                i,
                &["payload", "subscription", "type"],
                Value::from("channel.raid"),
            )
        }),
        Box::new(|i| {
            set(
                i,
                &["payload", "subscription", "condition"],
                Value::Object(object(json!({ "broadcaster_user_id": "other" }))),
            )
        }),
        Box::new(|i| set(i, &["payload", "event"], Value::Array(Vec::new()))),
        Box::new(|i| set(i, &["payload", "event", "user_id"], Value::Number(123.0))),
        Box::new(|i| set(i, &["payload", "event", "user_id"], Value::from(""))),
        Box::new(|i| set(i, &["metadata", "messageRetry"], Value::Number(1.5))),
        Box::new(|i| set(i, &["metadata", "durableChatHandled"], Value::from("true"))),
    ];
    for (index, mutate) in mutations.iter().enumerate() {
        let mut input = follow()?;
        mutate(&mut input);
        ensure!(retained(&input).is_err(), "mutation {index} accepted");
    }
    for mut input in [
        follow()?,
        paid_order()?,
        polar(
            "product.created",
            Value::from_json(&json!({ "id": "product" })),
        )?,
    ] {
        input.insert("schemaVersion", Value::Number(99.0));
        let before = input.clone();
        ensure!(retained(&input).is_err());
        ensure!(
            input == before,
            "unsupported retained rows are not modified"
        );
    }
    Ok(())
}

#[test]
fn raid_requires_destination_raider_and_safe_integer_viewers_stream_online_requires_matching_stream_id()
-> Result<()> {
    let raid = twitch(
        "channel.raid",
        json!({ "to_broadcaster_user_id": "channel", "from_broadcaster_user_id": "raider", "viewers": 0 }),
    )?;
    ensure!(retained(&raid).is_ok());
    for field in [
        "to_broadcaster_user_id",
        "from_broadcaster_user_id",
        "viewers",
    ] {
        let mut invalid = raid.clone();
        remove(&mut invalid, &["payload", "event", field]);
        ensure!(retained(&invalid).is_err(), "{field}");
    }
    let stream = twitch(
        "stream.online",
        json!({ "broadcaster_user_id": "channel", "id": "stream", "started_at": TIMESTAMP }),
    )?;
    ensure!(retained(&stream).is_ok());
    for stream_id in [None, Some("other")] {
        let mut invalid = stream.clone();
        match stream_id {
            None => drop(invalid.remove("streamID")),
            Some(id) => invalid.insert("streamID", Value::from(id)),
        }
        ensure!(retained(&invalid).is_err());
    }
    let mut without_id = stream;
    remove(&mut without_id, &["payload", "event", "id"]);
    ensure!(retained(&without_id).is_err());
    Ok(())
}

fn raid_with(condition: serde_json::Value) -> Result<Object> {
    let mut n = notification(
        "channel.raid",
        Some("1"),
        json!({ "to_broadcaster_user_id": "channel", "from_broadcaster_user_id": "raider", "viewers": 5 }),
    );
    n.subscription
        .insert("condition", Value::from_json(&condition));
    Ok(twitch_normalize(&n)?
        .ok_or_else(|| anyhow!("event"))?
        .to_object())
}

#[test]
fn raid_conditions_accept_an_empty_unused_direction_without_changing_the_provider_payload()
-> Result<()> {
    for condition in [
        json!({ "to_broadcaster_user_id": "channel" }),
        json!({ "to_broadcaster_user_id": "channel", "from_broadcaster_user_id": "" }),
        json!({ "from_broadcaster_user_id": "raider" }),
        json!({ "from_broadcaster_user_id": "raider", "to_broadcaster_user_id": "" }),
    ] {
        let input = raid_with(condition.clone())?;
        ensure!(ingest(&input).is_ok(), "{condition}: {:?}", ingest(&input));
        let outgoing = condition["from_broadcaster_user_id"] == json!("raider");
        ensure!(
            input.at("channelID").as_str() == Some(if outgoing { "raider" } else { "channel" })
        );
        ensure!(
            input.at("type").as_str()
                == Some(if outgoing {
                    "channel.raid.sent"
                } else {
                    "channel.raid.received"
                })
        );
    }
    Ok(())
}

#[test]
fn raid_empty_filter_handling_still_rejects_mismatched_malformed_and_unscoped_conditions()
-> Result<()> {
    for condition in [
        json!({ "to_broadcaster_user_id": "channel", "from_broadcaster_user_id": "other" }),
        json!({ "to_broadcaster_user_id": "other", "from_broadcaster_user_id": "raider" }),
        json!({ "to_broadcaster_user_id": "other", "from_broadcaster_user_id": "" }),
        json!({ "to_broadcaster_user_id": "", "from_broadcaster_user_id": "other" }),
        json!({ "to_broadcaster_user_id": "", "from_broadcaster_user_id": "" }),
        json!({ "from_broadcaster_user_id": "" }),
        json!({ "to_broadcaster_user_id": "" }),
        json!({ "to_broadcaster_user_id": "channel", "from_broadcaster_user_id": null }),
        json!({ "to_broadcaster_user_id": "channel", "from_broadcaster_user_id": " " }),
        json!({ "to_broadcaster_user_id": "channel", "from_broadcaster_user_id": 0 }),
        json!({ "to_broadcaster_user_id": "channel", "from_broadcaster_user_id": false }),
        json!({ "to_broadcaster_user_id": "channel", "broadcaster_user_id": "" }),
    ] {
        let mut input = twitch(
            "channel.raid",
            json!({ "to_broadcaster_user_id": "channel", "from_broadcaster_user_id": "raider", "viewers": 5 }),
        )?;
        set(
            &mut input,
            &["payload", "subscription", "condition"],
            Value::from_json(&condition),
        );
        ensure!(
            ingest(&input).is_err() && retained(&input).is_err(),
            "{condition}"
        );
    }
    let mut follow = follow()?;
    set(
        &mut follow,
        &["payload", "subscription", "condition"],
        Value::from_json(&json!({ "broadcaster_user_id": "" })),
    );
    ensure!(ingest(&follow).is_err());
    Ok(())
}

#[test]
fn twitch_counts_are_never_coerced_rounded_or_stored_with_lost_integer_precision() -> Result<()> {
    for (kind, field, base) in [
        (
            "channel.bits.use",
            "bits",
            json!({ "broadcaster_user_id": "channel" }),
        ),
        (
            "channel.subscription.gift",
            "total",
            json!({ "broadcaster_user_id": "channel" }),
        ),
        (
            "channel.raid",
            "viewers",
            json!({ "to_broadcaster_user_id": "channel", "from_broadcaster_user_id": "raider" }),
        ),
    ] {
        for value in [
            Value::from("1"),
            Value::Null,
            Value::Number(-1.0),
            Value::Number(1.5),
            Value::Number(f64::NAN),
            Value::Number(f64::INFINITY),
            Value::Number(9_007_199_254_740_992.0),
        ] {
            let mut input = twitch(kind, base.clone())?;
            set(&mut input, &["payload", "event", field], value.clone());
            ensure!(retained(&input).is_err(), "{field}={value:?}");
        }
        let mut input = twitch(kind, base)?;
        set(
            &mut input,
            &["payload", "event", field],
            Value::Number(9_007_199_254_740_991.0),
        );
        ensure!(retained(&input).is_ok(), "{field} max safe");
    }
    Ok(())
}

#[test]
fn present_twitch_dates_must_be_real_rfc3339_times_consistent_with_occurrence_time() -> Result<()> {
    for value in [
        json!(""),
        json!("tomorrow"),
        json!("2026-02-30T12:00:00Z"),
        json!("2026-09-05"),
        json!("2026-09-05T24:00:00Z"),
        json!(123),
        json!(null),
        json!("٢٠٢٦-09-05T12:00:00Z"),
    ] {
        let mut input = follow()?;
        set(
            &mut input,
            &["payload", "event", "followed_at"],
            Value::from_json(&value),
        );
        ensure!(retained(&input).is_err(), "{value}");
    }
    let mut input = twitch(
        "channel.follow",
        json!({ "broadcaster_user_id": "channel", "user_id": "follower", "followed_at": TIMESTAMP }),
    )?;
    input.insert("occurredAt", Value::from("2026-09-04T12:00:00Z"));
    ensure!(retained(&input).is_err());
    Ok(())
}

#[test]
fn flat_polar_payload_guards_accept_one_time_paid_orders_subscriptions_and_fractional_negative_meters()
-> Result<()> {
    for input in [
        paid_order()?,
        polar(
            "subscription.updated",
            Value::from_json(
                &json!({ "id": "sub", "customerId": "customer", "productId": "product", "status": "canceled", "recurringInterval": "year", "currentPeriodEnd": null }),
            ),
        )?,
        polar(
            "customer.state_changed",
            Value::from_json(
                &json!({ "id": "customer", "activeMeters": [{ "meterId": "meter", "consumedUnits": 12.5, "creditedUnits": 10, "balance": -2.5 }] }),
            ),
        )?,
    ] {
        ensure!(retained(&input).is_ok());
        ensure!(polar_billing_payload(&input, NOW).is_ok());
        ensure!(twitch_payload(&input, NOW).is_err());
    }
    ensure!(polar_billing_payload(&follow()?, NOW).is_err());
    ensure!(
        polar_billing_payload(
            &polar(
                "product.created",
                Value::from_json(&json!({ "id": "product" }))
            )?,
            NOW
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn malformed_retained_flat_polar_contracts_cannot_reach_billing_through_casts() -> Result<()> {
    let mutations: Vec<Mutation> = vec![
        Box::new(|i| set(i, &["payload", "customerId"], Value::from("other"))),
        Box::new(|i| set(i, &["payload", "paid"], Value::from("true"))),
        Box::new(|i| set(i, &["payload", "totalAmount"], Value::Number(-1.0))),
        Box::new(|i| remove(i, &["payload", "orderId"])),
        Box::new(|i| set(i, &["payload", "status"], Value::Object(Object::new()))),
        Box::new(|i| {
            set(
                i,
                &["payload", "periodEnd"],
                Value::from("2026-02-30T12:00:00Z"),
            )
        }),
        Box::new(|i| set(i, &["payload", "cadence"], Value::from("weekly"))),
        Box::new(|i| set(i, &["payload", "subscriptionId"], Value::from("sub"))),
        Box::new(|i| i.insert("channelID", Value::from("fabricated"))),
        Box::new(|i| {
            set(
                i,
                &["metadata", "originalEventType"],
                Value::from("order.refunded"),
            )
        }),
        Box::new(|i| set(i, &["metadata", "unmapped"], Value::Bool(true))),
        Box::new(|i| {
            let payload = i.at("payload").clone();
            let mut wrapped = Object::new();
            wrapped.insert("data", payload);
            i.insert("payload", Value::Object(wrapped));
        }),
        Box::new(|i| {
            set(
                i,
                &["payload", "meters"],
                Value::from_json(&json!([{ "meter_id": "meter", "balance": "1" }])),
            )
        }),
    ];
    for (index, mutate) in mutations.iter().enumerate() {
        let mut input = paid_order()?;
        mutate(&mut input);
        ensure!(
            polar_billing_payload(&input, NOW).is_err(),
            "mutation {index}"
        );
    }
    for value in [
        Value::Number(f64::NAN),
        Value::Number(f64::INFINITY),
        Value::from("1"),
        Value::Null,
        Value::Number(9_007_199_254_740_992.0),
    ] {
        let mut input = polar(
            "customer.state_changed",
            Value::from_json(&json!({ "id": "customer", "activeMeters": [] })),
        )?;
        let mut meter = Object::new();
        meter.insert("meter_id", Value::from("meter"));
        meter.insert("consumed_units", value);
        set(
            &mut input,
            &["payload", "meters"],
            Value::Array(vec![Value::Object(meter)]),
        );
        ensure!(polar_billing_payload(&input, NOW).is_err());
    }
    Ok(())
}

#[test]
fn unknown_polar_provider_events_remain_extensible_but_retain_source_subject_type_and_schema_integrity()
-> Result<()> {
    let valid = polar(
        "new.resource.changed",
        Value::from_json(
            &json!({ "id": "resource", "arbitrary": [true, { "text": "hello 👋🏽 مرحبا é\u{301}" }] }),
        ),
    )?;
    ensure!(retained(&valid).is_ok());
    let mutations: Vec<Mutation> = vec![
        Box::new(|i| i.insert("type", Value::from("billing.order.paid"))),
        Box::new(|i| set(i, &["subject", "id"], Value::from("other"))),
        Box::new(|i| set(i, &["metadata", "unmapped"], Value::Bool(false))),
        Box::new(|i| {
            set(
                i,
                &["payload", "providerData"],
                Value::Object(Object::new()),
            )
        }),
    ];
    for (index, mutate) in mutations.iter().enumerate() {
        let mut input = valid.clone();
        mutate(&mut input);
        ensure!(retained(&input).is_err(), "mutation {index}");
    }
    Ok(())
}

#[test]
fn unknown_producer_sources_permit_arbitrary_event_types_and_future_integer_schemas_with_generic_envelope_checks()
-> Result<()> {
    let input = object(json!({
        "source": "extension", "sourceEventId": "receipt", "type": "billing.order.paid", "topic": "domain", "schemaVersion": 42,
        "subject": { "provider": "extension", "kind": "integration-account", "id": "account" }, "payload": { "arbitrary": [1.25, true, null] }
    }));
    ensure!(retained(&input).is_ok());
    for version in [
        Value::Number(0.0),
        Value::Number(-1.0),
        Value::Number(1.5),
        Value::from("1"),
        Value::Null,
        Value::Number(f64::NAN),
        Value::Number(f64::INFINITY),
        Value::Number(9_007_199_254_740_992.0),
    ] {
        let mut changed = input.clone();
        changed.insert("schemaVersion", version.clone());
        ensure!(retained(&changed).is_err(), "{version:?}");
    }
    let changes: Vec<(&str, Value)> = vec![
        ("topic", Value::from("unknown")),
        ("subject", Value::Undefined),
        ("sourceEventId", Value::Number(123.0)),
        ("ownerUserId", Value::from("channel")),
    ];
    for (key, value) in changes {
        let mut changed = input.clone();
        changed.insert(key, value);
        ensure!(retained(&changed).is_err(), "{key}");
    }
    Ok(())
}

#[test]
fn payload_and_metadata_enforce_bounded_json_without_prototypes_or_lossy_values() -> Result<()> {
    let mut deep = Value::Object(Object::new());
    for _ in 0..35 {
        let mut next = Object::new();
        next.insert("nested", deep);
        deep = Value::Object(next);
    }
    let invalid = vec![
        Value::Undefined,
        Value::Number(f64::NAN),
        Value::Number(f64::INFINITY),
        Value::Number(f64::NEG_INFINITY),
        Value::Number(9_007_199_254_740_992.0),
        Value::Date(1.0),
        Value::Other,
        deep,
        Value::Object(object(json!({ "__proto__": { "polluted": true } }))),
        Value::Object(object(json!({ "constructor": {} }))),
        Value::Object(object(json!({ "prototype": 1 }))),
        Value::String("x".repeat(MAX_JSON_BYTES)),
        // 4 UTF-8 bytes and 2 UTF-16 units each: over the byte budget.
        Value::String("\u{1f600}".repeat(MAX_JSON_BYTES / 4)),
    ];
    for value in invalid {
        let mut input = object(
            json!({ "source": "test", "sourceEventId": "receipt", "type": "test", "topic": "channel", "channelID": "channel" }),
        );
        let mut payload = Object::new();
        payload.insert("value", value.clone());
        input.insert("payload", Value::Object(payload.clone()));
        ensure!(retained(&input).is_err(), "payload {value:?}");
        input.insert("payload", Value::Object(Object::new()));
        input.insert("metadata", Value::Object(payload));
        ensure!(retained(&input).is_err(), "metadata");
    }
    // Text near the budget counts UTF-8 bytes of its JSON text: combining marks and RTL included.
    let mut fits = object(
        json!({ "source": "test", "sourceEventId": "receipt", "type": "test", "topic": "channel", "channelID": "channel" }),
    );
    let mut payload = Object::new();
    payload.insert("value", Value::from("é\u{301}مرحبا👋🏽".repeat(1000)));
    fits.insert("payload", Value::Object(payload));
    ensure!(retained(&fits).is_ok());
    Ok(())
}

#[test]
fn nonblank_text_is_the_reference_s_trim() -> Result<()> {
    // `\u{feff}` and `\u{a0}` are JavaScript whitespace, `\u{85}` is not.
    for (source, ok) in [
        ("\u{feff}twitch", false),
        ("twitch\u{a0}", false),
        ("\u{85}twitch", true),
        ("شبكة", true),
    ] {
        let input = object(
            json!({ "source": source, "sourceEventId": "r", "type": "t", "topic": "channel", "channelID": "c", "payload": {} }),
        );
        ensure!(retained(&input).is_ok() == ok, "{source:?}");
    }
    ensure!(encode_uri_component("مرحبا") == "%D9%85%D8%B1%D8%AD%D8%A8%D8%A7");
    Ok(())
}

#[test]
fn custom_goal_contract_scopes_identity_by_channel_and_validates_payloads() -> Result<()> {
    let base = CustomGoalContribution {
        channel_id: "123".into(),
        receipt_identity: "scope:receipt".into(),
        item_key: "sticker".into(),
        quantity: 3.0,
        occurred_at_ms: date("2026-01-01T00:00:00Z"),
    };
    let event = dima_events::producers::goals::normalize(&base)?;
    ensure!(event.validate(Check::ingest(NOW)).is_ok());
    let other_channel = dima_events::producers::goals::normalize(&CustomGoalContribution {
        channel_id: "456".into(),
        ..base.clone()
    })?;
    ensure!(event.source_event_id != other_channel.source_event_id);
    let other_item = dima_events::producers::goals::normalize(&CustomGoalContribution {
        item_key: "other".into(),
        quantity: 2.0,
        ..base.clone()
    })?;
    ensure!(event.source_event_id == other_item.source_event_id);
    for invalid in [
        CustomGoalContribution {
            item_key: "invalid-key".into(),
            ..base.clone()
        },
        CustomGoalContribution {
            quantity: 0.0,
            ..base.clone()
        },
        CustomGoalContribution {
            quantity: 1e9 + 1.0,
            ..base.clone()
        },
        // 1,001 UTF-16 units (an emoji counts two).
        CustomGoalContribution {
            receipt_identity: format!("{}👋", "x".repeat(999)),
            ..base.clone()
        },
    ] {
        ensure!(dima_events::producers::goals::normalize(&invalid) == Err(GoalError::Invalid));
    }
    let mut object = event.to_object();
    set(&mut object, &["payload", "quantity"], Value::Number(0.0));
    ensure!(ingest(&object).is_err());
    Ok(())
}
