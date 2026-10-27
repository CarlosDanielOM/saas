#![cfg(feature = "domain-events")]

//! Source-backed fixtures for [`dima_rust::utils::domain_events`].
//!
//! The key expectations come from `dimabot/src/utils/domain_events.test.ts`; the
//! envelope cases mirror the duplicated `toEnvelope` projections in
//! `domain_events.ts` and `domain_event_consumer.ts` and the schema in
//! `dimabot/src/schemas/domain_event.schema.ts`.

use dima_rust::utils::domain_events::{
    DomainEventEnvelope, DomainEventKeyError, DomainEventTopic, build_domain_event_key,
};
use serde_json::{Value, json};

#[test]
fn event_keys_encode_delimiter_bearing_components_without_collisions() {
    assert_ne!(
        build_domain_event_key("a:b", "c", "d"),
        build_domain_event_key("a", "b:c", "d")
    );
    assert_eq!(
        build_domain_event_key("twitch", "message-1", "stream.started"),
        Ok("twitch:message-1:stream.started".to_owned())
    );
}

#[test]
fn event_keys_use_encode_uri_component_semantics() {
    // Unreserved and the `encodeURIComponent` punctuation set stay literal.
    assert_eq!(
        build_domain_event_key("a-b_c.d!e~f*g'h(i)", "x", "y"),
        Ok("a-b_c.d!e~f*g'h(i):x:y".to_owned())
    );
    // Reserved and non-ASCII bytes are uppercase percent-encoded.
    assert_eq!(
        build_domain_event_key("a:b c/d", "e%f", "g\"h"),
        Ok("a%3Ab%20c%2Fd:e%25f:g%22h".to_owned())
    );
    assert_eq!(
        build_domain_event_key("caf\u{E9}", "x", "y"),
        Ok("caf%C3%A9:x:y".to_owned())
    );
}

#[test]
fn event_keys_trim_with_ecmascript_whitespace_rules() {
    // U+FEFF is ECMAScript whitespace and is trimmed.
    assert_eq!(
        build_domain_event_key("\u{FEFF}twitch\u{FEFF}", " id ", "\tt"),
        Ok("twitch:id:t".to_owned())
    );
    // U+0085 is not ECMAScript whitespace; it is percent-encoded, not trimmed.
    assert_eq!(
        build_domain_event_key("\u{0085}id", "x", "y"),
        Ok("%C2%85id:x:y".to_owned())
    );
    // Rust `str::trim` would also strip U+0085; the source would not.
    assert_eq!(
        build_domain_event_key("id\u{0085}", "x", "y"),
        Ok("id%C2%85:x:y".to_owned())
    );
}

#[test]
fn event_keys_reject_blank_components() {
    assert_eq!(
        build_domain_event_key("", "b", "c"),
        Err(DomainEventKeyError)
    );
    assert_eq!(
        build_domain_event_key("a", "   ", "c"),
        Err(DomainEventKeyError)
    );
    assert_eq!(
        build_domain_event_key("a", "b", "\u{00A0}"),
        Err(DomainEventKeyError)
    );
}

fn full_document() -> Value {
    json!({
        "_id": {"$oid": "64b7f0c2e1a2b3c4d5e6f7a8"},
        "eventKey": "twitch:message-1:stream.started",
        "source": "twitch-eventsub",
        "sourceEventId": "message-1",
        "type": "stream.started",
        "topic": "channel",
        "schemaVersion": 1,
        "ownerUserId": null,
        "channelID": "channel-1",
        "occurredAt": {"$date": {"$numberLong": "1750000000000"}},
        "journaledAt": {"$date": {"$numberLong": "1750000001000"}},
        "payload": {"id": "stream-1"},
        "metadata": {"observability": {"traceId": "trace-1"}},
        "expiresAt": {"$date": {"$numberLong": "1757776000000"}},
        "unknownField": "dropped"
    })
}

#[test]
fn envelope_copies_exactly_the_shared_fields() {
    let envelope = DomainEventEnvelope::from_value(&full_document()).expect("object document");

    assert_eq!(
        envelope.event_key(),
        Some("twitch:message-1:stream.started")
    );
    assert_eq!(envelope.source(), Some("twitch-eventsub"));
    assert_eq!(envelope.source_event_id(), Some("message-1"));
    assert_eq!(envelope.event_type(), Some("stream.started"));
    assert_eq!(envelope.topic(), Some(DomainEventTopic::Channel));
    assert_eq!(envelope.payload(), Some(&json!({"id": "stream-1"})));
    assert_eq!(
        envelope.metadata(),
        Some(&json!({"observability": {"traceId": "trace-1"}}))
    );
    assert!(envelope.is_complete());
    assert!(envelope.missing_required_fields().is_empty());
    assert!(
        envelope.get("unknownField").is_none(),
        "unknown document fields must not leak into the envelope"
    );
}

#[test]
fn envelope_preserves_absent_and_null_fields_distinctly() {
    let envelope = DomainEventEnvelope::from_value(&full_document()).expect("object document");

    assert!(
        envelope.get("ownerUserId").is_some_and(Value::is_null),
        "an explicit null must stay present as null"
    );
    assert!(
        envelope.get("streamID").is_none(),
        "absent fields stay absent"
    );
    assert!(envelope.get("subject").is_none());
    assert!(
        envelope
            .channel_id()
            .is_some_and(|value| value.as_str() == Some("channel-1"))
    );
}

#[test]
fn envelope_preserves_object_id_and_date_representations() {
    let envelope = DomainEventEnvelope::from_value(&full_document()).expect("object document");

    assert_eq!(
        envelope.get("_id"),
        Some(&json!({"$oid": "64b7f0c2e1a2b3c4d5e6f7a8"}))
    );
    assert_eq!(
        envelope.occurred_at(),
        Some(&json!({"$date": {"$numberLong": "1750000000000"}}))
    );
    assert_eq!(
        envelope.journaled_at(),
        Some(&json!({"$date": {"$numberLong": "1750000001000"}}))
    );
}

#[test]
fn envelope_round_trips_through_json() {
    let envelope = DomainEventEnvelope::from_value(&full_document()).expect("object document");
    let serialized = envelope.to_json_string();
    let reparsed = DomainEventEnvelope::from_json_str(&serialized).expect("round trip");
    assert_eq!(reparsed, envelope);
    let mut expected = full_document();
    expected.as_object_mut().unwrap().remove("unknownField");
    assert_eq!(reparsed.into_value(), expected);
}

#[test]
fn envelope_reports_missing_required_fields_without_rejecting() {
    let envelope = DomainEventEnvelope::from_json_str(
        r#"{"eventKey":"key","topic":"telemetry","ownerUserId":null}"#,
    )
    .expect("partial document");
    assert!(!envelope.is_complete());
    assert!(envelope.missing_required_fields().contains(&"_id"));
    assert!(envelope.missing_required_fields().contains(&"expiresAt"));
    assert!(!envelope.missing_required_fields().contains(&"ownerUserId"));
    assert_eq!(envelope.topic(), Some(DomainEventTopic::Telemetry));
    assert_eq!(envelope.event_key(), Some("key"));
}

#[test]
fn completeness_accounts_for_channel_identity_only_on_channel_topics() {
    let mut document = full_document();
    document.as_object_mut().unwrap().remove("channelID");
    let channel = DomainEventEnvelope::from_value(&document).unwrap();
    assert!(!channel.is_complete());
    assert!(channel.missing_required_fields().contains(&"channelID"));
    document["topic"] = json!("telemetry");
    let telemetry = DomainEventEnvelope::from_value(&document).unwrap();
    assert!(telemetry.is_complete());
}

#[test]
fn envelope_rejects_invalid_or_non_object_json() {
    assert!(DomainEventEnvelope::from_json_str("{").is_err());
    let error = DomainEventEnvelope::from_json_str("[1, 2]").expect_err("array is not a document");
    assert_eq!(
        error.to_string(),
        "domain event document must be a JSON object"
    );
}

#[test]
fn topic_parsing_covers_every_schema_value() {
    for (text, topic) in [
        ("channel", DomainEventTopic::Channel),
        ("activity", DomainEventTopic::Activity),
        ("telemetry", DomainEventTopic::Telemetry),
        ("domain", DomainEventTopic::Domain),
    ] {
        assert_eq!(DomainEventTopic::parse(text), Some(topic));
        assert_eq!(topic.as_str(), text);
    }
    assert_eq!(DomainEventTopic::parse("unknown"), None);
}

#[cfg(feature = "mongo")]
mod bson_projection {
    use dima_rust::utils::domain_events::project_envelope_bson;
    use mongodb::bson::{Bson, DateTime, doc, oid::ObjectId};

    #[test]
    fn keeps_native_object_id_and_date_values() {
        let id = ObjectId::new();
        let occurred_at = DateTime::from_millis(1_750_000_000_000);
        let document = doc! {
            "_id": id,
            "eventKey": "twitch:message-1:stream.started",
            "source": "twitch-eventsub",
            "sourceEventId": "message-1",
            "type": "stream.started",
            "topic": "channel",
            "schemaVersion": 1_i64,
            "channelID": "channel-1",
            "occurredAt": occurred_at,
            "journaledAt": occurred_at,
            "payload": doc! { "id": "stream-1" },
            "metadata": doc! {},
            "expiresAt": occurred_at,
            "unknown": "dropped",
        };

        let envelope = project_envelope_bson(&document);
        assert_eq!(envelope.get("_id"), Some(&Bson::ObjectId(id)));
        assert_eq!(
            envelope.get("occurredAt"),
            Some(&Bson::DateTime(occurred_at))
        );
        assert_eq!(
            envelope.get("journaledAt"),
            Some(&Bson::DateTime(occurred_at))
        );
        assert!(!envelope.contains_key("unknown"));
        assert!(!envelope.contains_key("ownerUserId"));
        assert!(!envelope.contains_key("streamID"));
    }
}
