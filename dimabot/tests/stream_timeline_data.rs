#![cfg(feature = "stream-timeline-data")]
//! Slice-4a data-layer parity: `src/utils/stream_activity.ts`,
//! `src/utils/stream_timeline.ts` and the three schemas they use.
//!
//! The plain `#[test]` functions need no service, environment value or network.
//! They cover the pure document builders plus a replay of the externally written
//! source oracle (`tests/fixtures/stream-timeline-data-reference.cjs`).
//!
//! The `#[ignore]` suites drive the real capture, reader and timeline adapters
//! against a lead-owned disposable MongoDB and never contact a production
//! service, database, queue or credential:
//!
//! ```text
//! STREAM_TIMELINE_TEST_MONGO_URI=mongodb://127.0.0.1:27017
//! STREAM_TIMELINE_TEST_MONGO_DATABASE=rust_stream_timeline_fixture_<unique>
//! STREAM_TIMELINE_TEST_MONGO_ACK=disposable
//! ```
//!
//! `..._DATABASE` must start with `rust_stream_timeline_fixture_`; each suite
//! appends its own suffix, asserts the derived database is empty before use and
//! drops exactly that database afterwards. The suite refuses to run without the
//! explicit acknowledgement value.
//!
//! The oracle replay is also `#[ignore]`d and needs:
//!
//! ```text
//! DIMA_STREAM_TIMELINE_DATA_FIXTURE_DIR=<absolute dir outside the workspace>
//! DIMA_STREAM_TIMELINE_DATA_FIXTURE_SHA256=<lowercase hex>
//! ```
//!
//! The slice-4a sources contain no Redis usage: `capture.rs`, `read.rs` and
//! `stream_timeline.rs` hold only a database handle and a deadline, so Mongo-only
//! coverage is complete for this data layer.
//!
//! `support/stream_timeline_route_data_mongo.rs` adds the concrete
//! `MongoTimelineRouteData` insert/dedupe/delete and row-readback suites with
//! the same harness. It is compiled only under the slice-4b route feature and
//! needs one accessor in that lane's route file; see its module header.

#[path = "support/stream_timeline_data_support.rs"]
mod support;

// The concrete route data adapter lives in the slice-4b route module, so the
// suite is included only when that feature is enabled. It declares one access
// precondition in its own header (`StreamTimelineRouteService::data`).
#[cfg(feature = "stream-timeline-routes")]
#[path = "support/stream_timeline_route_data_mongo.rs"]
mod route_data_mongo;

use dima_rust::{
    schemas::{channel_stream_summary, FieldDefault, FieldType},
    utils::stream_timeline::{
        build_timeline, moment_marker_upsert, participant_coverage_update, participant_upsert,
        redemption_marker_upsert, session_row_filter, streams_page_filter, timeline_bucket,
        timeline_filters, timeline_offset, StreamTimelineService, TimelineFilters, TimelineMoment,
        TimelineRedemption, TimelineReward, BOT_ACCOUNT_ID, MAX_ROWS, TIMELINE_BUCKET_MS,
        TIMELINE_RETENTION_MS,
    },
    workers::stream_activity::{
        capture::{
            activity_insert, activity_outcome, activity_time_valid, activity_update, activity_upsert,
            activity_value, bounded, duplicate_code, hash, offset_seconds, session_filter,
            ActivityKind, CaptureInput, CaptureSession, StreamActivityCapture, TimelineEmote,
            ACTIVITY_RETENTION_MS, FUTURE_WINDOW_MS,
        },
        read::{
            activity_filters, build_activity_result, StreamActivityReader, ActivityFilters,
            READ_MAX_TIME_MS, RANK_LIMIT, SERIES_LIMIT,
        },
    },
};
use mongodb::{
    bson::{doc, oid::ObjectId, Bson, DateTime, Document},
    options::{IndexModel, IndexOptions},
};
use serde_json::Value;
use std::{str::FromStr, time::Duration};

// ---------------------------------------------------------------------------
// Pure tests
// ---------------------------------------------------------------------------

#[test]
fn hash_uses_compact_utf8_json_and_sha256() {
    assert_eq!(hash(&["channel".into(), "message".into(), "event".into()]).unwrap(), "7b6648cac1cf99038cb6314c4034710a5bc713b0a52e433f2d13f6714d9dc073");
    assert_eq!(hash(&["café".into(), "a\nb".into()]).unwrap(), "73c8d5e01b54c8cfdd01fde8e64479f89c5c742542c7ecb5e84eb7528adcd1c4");
}
#[test]
fn retention_bounds_and_scalar_policy() {
    let now = 2 * ACTIVITY_RETENTION_MS;
    assert_eq!(TIMELINE_RETENTION_MS, 90 * 86_400_000);
    assert_eq!(TIMELINE_BUCKET_MS, 300_000); assert_eq!(MAX_ROWS, 2000);
    assert!(activity_time_valid(now - ACTIVITY_RETENTION_MS, now));
    assert!(!activity_time_valid(now - ACTIVITY_RETENTION_MS - 1, now));
    assert!(activity_time_valid(now + FUTURE_WINDOW_MS, now));
    assert!(!activity_time_valid(now + FUTURE_WINDOW_MS + 1, now));
    assert_eq!(bounded(Some(&"a".repeat(110)), 64).len(), 64);
    assert_eq!(bounded(Some(&"b".repeat(110)), 100).len(), 100);
    assert_eq!(offset_seconds(1_501, 1_000), 0.501);
    assert_eq!(activity_value(None), 1.0); assert_eq!(activity_value(Some(-1.0)), 0.0);
    assert!(activity_value(Some(-0.0)).is_sign_positive());
    assert!(activity_value(Some(f64::NAN)).is_nan());
    assert_eq!(activity_outcome(Some("error")), "error"); assert_eq!(activity_outcome(Some("ERROR")), "ok");
    assert!(duplicate_code(11000)); assert!(!duplicate_code(11001));
    assert_eq!(timeline_bucket(301_000, 1_000), 1);
    assert_eq!(timeline_offset(1_501, 1_000), 0.501);
}
#[test]
fn capture_filter_document_and_insert_order() {
    let at = DateTime::from_millis(1_501);
    assert_eq!(session_filter("c", at), doc! {"channelID": "c", "started_at": {"$lte": at}, "$or": [{"ended_at": {"$gt": at}}, {"ended_at": null}]});
    let id = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
    let session = CaptureSession { id, started_at: DateTime::from_millis(1_000) };
    let input = CaptureInput { channel_id: "c".into(), event_id: "e".into(), kind: ActivityKind::Command, occurred_at: Some(at),
        session: None, actor: None, actor_label: None, key: Some("k".into()), label: None, value: None, outcome: None, emotes: vec![] };
    let row = activity_insert(&input, &session, at).unwrap();
    let update = activity_update(&input, &session, at).unwrap();
    assert_eq!(update.get_document("$setOnInsert").unwrap().get("dashboardProcessed"), Some(&mongodb::bson::Bson::Null));
    assert_eq!(row.keys().map(String::as_str).collect::<Vec<_>>(), vec!["channelID", "session_id", "occurredAt", "offset", "kind", "actor", "actorLabel", "key", "label", "value", "outcome", "emotes", "processed", "expiresAt"]);
    assert_eq!(row.get_f64("offset").unwrap(), 0.501);
    assert_eq!(row.get_f64("value").unwrap(), 1.0);
    assert_eq!(row.get_datetime("expiresAt").unwrap().timestamp_millis(), 1_501 + ACTIVITY_RETENTION_MS);
}
#[test]
fn activity_kind_round_trips() {
    for name in ["message", "command", "redemption", "follow", "sub", "gift", "bits", "raid"] {
        let kind = ActivityKind::from_str(name).unwrap();
        assert_eq!(kind.as_str(), name);
        assert_eq!(serde_json::from_str::<ActivityKind>(&serde_json::to_string(&kind).unwrap()).unwrap(), kind);
    }
    assert!(ActivityKind::from_str("unknown").is_err());
}
#[test]
fn summary_schema_fields_nested_defaults_and_indexes() {
    let schema = channel_stream_summary::schema();
    assert_eq!(schema.model, "ChannelStreamSummary"); assert_eq!(schema.collection, "channelstreamsummaries");
    assert_eq!(schema.fields.iter().map(|field| field.name).collect::<Vec<_>>(), vec!["channelID", "channel", "stream_session_id", "stream_id", "started_at", "ended_at", "duration_minutes", "average_viewers", "peak_viewers", "follows", "subs", "bits", "donations", "headline", "recap", "highlights", "chat_messages_sampled", "snapshot_count", "proposed_actions", "applied_actions", "totals", "status", "error_message", "source"]);
    let field = |name| schema.fields.iter().find(|field| field.name == name).unwrap();
    assert!(field("channelID").required); assert!(field("stream_session_id").required);
    assert!(matches!(&field("stream_session_id").kind, FieldType::ObjectId));
    assert!(matches!(&field("channel").default, FieldDefault::String("Unknown")));
    assert!(matches!(&field("status").default, FieldDefault::String("pending")));
    assert!(matches!(&field("source").default, FieldDefault::String("stream_offline")));
    assert!(matches!(&field("totals").kind, FieldType::Subdocument { generate_id: false, .. }));
    assert_eq!(channel_stream_summary::memory_proposal_fields().len(), 9);
    assert_eq!(channel_stream_summary::memory_action_result_fields().len(), 5);
    assert_eq!(channel_stream_summary::memory_action_totals_fields().len(), 4);
    assert!(schema.indexes.iter().any(|index| index.unique && index.keys == doc! {"channelID": 1, "stream_session_id": 1, "source": 1}));
    assert!(schema.indexes.iter().any(|index| index.keys == doc! {"status": 1, "created_at": -1}));
}

#[test]
fn activity_tier_scopes_and_emote_deduplication() {
    use dima_rust::workers::stream_activity::{capture::{ChatEmote, ChatFragment, ChatMessage, extract_timeline_emotes}, read::build_activity_result};
    let message = ChatMessage { fragments: vec![
        ChatFragment { r#type: "emote".into(), text: "First".into(), emote: Some(ChatEmote { id: Some("1".into()) }) },
        ChatFragment { r#type: "text".into(), text: "ignored".into(), emote: None },
        ChatFragment { r#type: "emote".into(), text: "Second".into(), emote: Some(ChatEmote { id: Some("1".into()) }) },
    ] };
    let emotes = extract_timeline_emotes(&message);
    assert_eq!(emotes.len(), 1); assert_eq!(emotes[0].key, "twitch:1"); assert_eq!(emotes[0].label, "First"); assert_eq!(emotes[0].count, 2);
    let commands = vec![doc! {"key": "x", "label": "X", "count": 2, "failures": 1}];
    let series = vec![doc! {"bucket": 2, "commands": 2, "emotes": 1, "messages": 3, "chatters": 4}];
    let free = build_activity_result(None, &commands, &[], &series, false, "free");
    assert!(!free.get_array("commands").unwrap()[0].as_document().unwrap().contains_key("errors"));
    assert!(!free.get_array("series").unwrap()[0].as_document().unwrap().contains_key("commands"));
    let pro = build_activity_result(None, &commands, &[], &series, true, "pro");
    assert_eq!(pro.get_array("commands").unwrap()[0].as_document().unwrap().get_i32("errors").unwrap(), 1);
    assert!(pro.get_document("capabilities").unwrap().get_bool("users").unwrap());
}

#[test]
fn summary_nested_schema_contracts() {
    let proposal = channel_stream_summary::memory_proposal_fields();
    assert_eq!(proposal.iter().map(|f| f.name).collect::<Vec<_>>(), vec!["action", "type", "targetMemoryId", "summary", "content", "confidence", "risk", "reason", "evidence"]);
    assert!(proposal[0].required);
    assert_eq!(proposal[0].enum_values, channel_stream_summary::ACTIONS);
    assert!(matches!(&proposal[5].default, FieldDefault::Number(n) if *n == 0.0));
    assert!(matches!(&proposal[6].default, FieldDefault::String("low")));
    assert!(matches!(&proposal[8].kind, FieldType::Array(_)));
    let result = channel_stream_summary::memory_action_result_fields();
    assert_eq!(result.iter().map(|f| f.name).collect::<Vec<_>>(), vec!["action", "targetMemoryId", "status", "reason", "error"]);
    assert!(result[0].required && result[2].required);
    assert_eq!(result[2].enum_values, channel_stream_summary::ACTION_STATUSES);
    let totals = channel_stream_summary::memory_action_totals_fields();
    assert_eq!(totals.iter().map(|f| f.name).collect::<Vec<_>>(), vec!["proposed", "applied", "skipped", "failed"]);
    assert!(totals.iter().all(|f| matches!(&f.default, FieldDefault::Number(n) if *n == 0.0)));
    let indexes = &channel_stream_summary::schema().indexes;
    for keys in [doc! {"channelID": 1}, doc! {"stream_session_id": 1}, doc! {"started_at": 1}, doc! {"ended_at": 1}, doc! {"status": 1}, doc! {"source": 1}, doc! {"channelID": 1, "ended_at": -1}] {
        assert!(indexes.iter().any(|index| index.keys == keys));
    }
}

#[test]
fn constructed_activity_upsert_casts_and_supplies_dashboard_default() {
    use dima_rust::workers::stream_activity::capture::{activity_upsert, construct_upsert, TimelineEmote};
    use mongodb::bson::Bson;
    let at = DateTime::from_millis(1_501);
    let id = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
    let session = CaptureSession { id, started_at: DateTime::from_millis(1_000) };
    let input = CaptureInput { channel_id: "c".into(), event_id: "e".into(), kind: ActivityKind::Message,
        occurred_at: Some(at), session: None, actor: None, actor_label: None, key: None, label: None,
        value: Some(1.0), outcome: None, emotes: vec![TimelineEmote { key: "twitch:1".into(), label: "one".into(), count: 2 }] };
    let (filter, update) = activity_upsert(&input, &session, at).unwrap();
    assert_eq!(filter, doc! {"_id": hash(&["c".into(), "message".into(), "e".into()]).unwrap()});
    let row = update.get_document("$setOnInsert").unwrap();
    assert_eq!(row.get("dashboardProcessed"), Some(&Bson::Null));
    assert!(matches!(row.get("offset"), Some(Bson::Double(n)) if *n == 0.501));
    assert_eq!(row.get("value"), Some(&Bson::Int32(1)));
    assert_eq!(row.get("session_id"), Some(&Bson::ObjectId(id)));
    let emote = row.get_array("emotes").unwrap()[0].as_document().unwrap();
    assert!(!emote.contains_key("_id"));
    assert_eq!(emote.get("count"), Some(&Bson::Int32(2)));
    let mut raw = activity_insert(&input, &session, at).unwrap();
    raw.insert("session_id", id.to_hex());
    raw.insert("value", 1.5);
    let (filter, update) = construct_upsert(dima_rust::schemas::stream_activity::schema(), doc! {"_id": "fixture"}, raw, at).unwrap();
    assert_eq!(filter, doc! {"_id": "fixture"});
    let cast = update.get_document("$setOnInsert").unwrap();
    assert_eq!(cast.get("session_id"), Some(&Bson::ObjectId(id)));
    assert_eq!(cast.get("value"), Some(&Bson::Double(1.5)));
    assert!(!cast.contains_key("_id"));
}

#[test]
fn constructed_participant_and_moment_keep_cast_filter_and_omit_value() {
    use dima_rust::utils::stream_timeline::{moment_marker_upsert, participant_upsert, TimelineMoment};
    use mongodb::bson::Bson;
    let at = DateTime::from_millis(1_501);
    let id = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
    let (filter, update) = participant_upsert("c", id, 3, "u", at).unwrap();
    assert_eq!(filter, doc! {"channelID": "c", "session_id": id, "bucket": 3, "user_id": "u"});
    assert_eq!(filter.get("bucket"), Some(&Bson::Int32(3)));
    let insert = update.get_document("$setOnInsert").unwrap();
    assert!(!insert.contains_key("_id"));
    assert!(!insert.contains_key("__v"));
    assert_eq!(insert.get_datetime("expiresAt").unwrap().timestamp_millis(), 1_501 + TIMELINE_RETENTION_MS);
    let input = TimelineMoment { channel_id: "c".into(), event_id: "e".into(), kind: ActivityKind::Follow, at, label: "follow".into(), value: None };
    let (filter, update) = moment_marker_upsert(&input, id).unwrap();
    assert_eq!(filter, doc! {"channelID": "c", "session_id": id, "key": "event:e"});
    let insert = update.get_document("$setOnInsert").unwrap();
    assert!(!insert.contains_key("value"));
    assert!(!insert.contains_key("_id"));
    assert!(!insert.contains_key("__v"));
    assert_eq!(insert.get_str("kind").unwrap(), "follow");
}

#[test]
fn constructed_redemption_marker_casts_filter_and_numeric_cost() {
    use dima_rust::utils::stream_timeline::marker_upsert;
    use mongodb::bson::Bson;
    let at = DateTime::from_millis(1_501);
    let id = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
    let (filter, update) = marker_upsert(
        doc! {"channelID": "c", "session_id": id.to_hex(), "key": "redemption:e"},
        doc! {"kind": "redemption", "label": "reward", "occurredAt": at,
            "rewardID": "r", "cost": 1.5, "status": "fulfilled", "expiresAt": DateTime::from_millis(2_000)}, at,
    ).unwrap();
    assert_eq!(filter, doc! {"channelID": "c", "session_id": id, "key": "redemption:e"});
    let inserted = update.get_document("$setOnInsert").unwrap();
    assert_eq!(inserted.get("cost"), Some(&Bson::Double(1.5)));
    assert!(!inserted.contains_key("_id"));
    assert!(!inserted.contains_key("__v"));
}

#[test]
fn participant_coverage_preserves_receipt_time_and_refreshes_update_timestamp() {
    use dima_rust::utils::stream_timeline::participant_coverage_update;
    let receipt = DateTime::from_millis(1000);
    let updated = DateTime::from_millis(2000);
    // `$setOnInsert.created_at` is what the Mongoose timestamps pre-hook appends
    // to the source update; it is inert without an upsert.
    assert_eq!(participant_coverage_update(receipt, updated),
        doc! {"$min": {"chat_tracking_started_at": receipt}, "$set": {"updated_at": updated}, "$setOnInsert": {"created_at": updated}});
}

// ---------------------------------------------------------------------------
// Recorded source oracle replay
// ---------------------------------------------------------------------------

/// Reads a recorded JavaScript number or its `-0`/`NaN`/`Infinity` marker.
fn json_number(node: &Value) -> Option<f64> {
    support::number(node)
}
fn json_integer(document: &Document, key: &str) -> i64 {
    match document.get(key) {
        Some(Bson::Int32(value)) => i64::from(*value),
        Some(Bson::Int64(value)) => *value,
        Some(Bson::Double(value)) => *value as i64,
        other => panic!("{key}: not an integer BSON number: {other:?}"),
    }
}
fn json_field<'a>(document: &'a Document, key: &str) -> &'a Document {
    document.get_document(key).unwrap_or_else(|_| panic!("{key}: not a document"))
}
fn recorded<'a>(case: &'a Value, role: &str) -> Option<&'a Value> {
    support::optional_call(case, role)
}
fn session_from(document: &Document) -> CaptureSession {
    CaptureSession {
        id: document.get_object_id("_id").expect("session _id"),
        started_at: *document.get_datetime("started_at").expect("session started_at"),
    }
}
fn oracle_capture_input(case: &Value) -> CaptureInput {
    let input = &case["input"];
    CaptureInput {
        channel_id: input["channelID"].as_str().expect("channelID").to_owned(),
        event_id: input["eventID"].as_str().expect("eventID").to_owned(),
        kind: input["kind"].as_str().expect("kind").parse().expect("activity kind"),
        occurred_at: Some(DateTime::from_millis(case["subject"]["occurredAtMs"].as_i64().expect("occurredAtMs"))),
        session: None,
        actor: input["actor"].as_str().map(str::to_owned),
        actor_label: input["actorLabel"].as_str().map(str::to_owned),
        key: input["key"].as_str().map(str::to_owned),
        label: input["label"].as_str().map(str::to_owned),
        value: json_number(&input["value"]),
        outcome: input["outcome"].as_str().map(str::to_owned),
        emotes: input["emotes"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .map(|row| TimelineEmote {
                        key: row["key"].as_str().expect("emote key").to_owned(),
                        label: row["label"].as_str().expect("emote label").to_owned(),
                        count: json_number(&row["count"]).expect("emote count") as i64,
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

#[test]
#[ignore = "requires the external source oracle fixture (DIMA_STREAM_TIMELINE_DATA_FIXTURE_*)"]
fn source_documents_and_outputs_match_oracle() {
    let fixture = support::fixture();
    let names = support::fixture_case_names(&fixture);
    assert_eq!(
        fixture["metadata"]["caseCount"].as_u64(),
        Some(names.len() as u64),
        "case inventory"
    );
    assert!(names.len() >= 30, "oracle inventory must not shrink");

    // --- capture: exact driver documents for every accepted input -----------
    for case in support::cases_of(&fixture, "capture") {
        let name = case["name"].as_str().expect("case name");
        let subject = &case["subject"];
        let session = session_from(&support::document(
            subject["sessionHex"].as_str().expect("sessionHex"),
        ));
        let input = oracle_capture_input(case);
        let at = DateTime::from_millis(subject["occurredAtMs"].as_i64().expect("occurredAtMs"));
        let now = DateTime::from_millis(subject["now"].as_i64().expect("now"));
        match recorded(case, "activity.updateOne") {
            Some(call) => {
                let (filter, update) = activity_upsert(&input, &session, at).expect("activity upsert");
                support::assert_document(
                    &filter,
                    &support::call_document(call, "filterHex"),
                    &format!("{name}: filter"),
                );
                support::assert_document(
                    &update,
                    &support::call_document(call, "updateHex"),
                    &format!("{name}: update"),
                );
                let options = support::call_document(call, "optionsHex");
                assert!(options.get_bool("upsert").unwrap_or(false), "{name}: upsert");
                assert_eq!(
                    json_field(&options, "writeConcern"),
                    &doc! {"w": 1, "j": true},
                    "{name}: write concern"
                );
            }
            None => {
                // The source skipped this capture; the native guard must agree.
                let skipped = input.event_id.is_empty()
                    || input.channel_id.is_empty()
                    || !activity_time_valid(at.timestamp_millis(), now.timestamp_millis())
                    || at.timestamp_millis() < session.started_at.timestamp_millis();
                assert!(skipped, "{name}: unexpected native write");
            }
        }
        assert_eq!(
            case["outcome"]["status"].as_str(),
            Some("resolved"),
            "{name}: capture must never surface a skip"
        );
    }

    // --- capture: duplicate handling is code-based, not message-based -------
    let swallowed = support::fixture_case(&fixture, "capture-duplicate-11000-swallowed");
    assert!(recorded(swallowed, "activity.updateOne").is_some());
    assert_eq!(swallowed["outcome"]["status"].as_str(), Some("resolved"));
    assert!(duplicate_code(11000));
    let message_only = support::fixture_case(&fixture, "capture-duplicate-message-only-rejected");
    assert_eq!(message_only["outcome"]["status"].as_str(), Some("rejected"));
    assert!(message_only["outcome"]["error"]["code"].is_null(), "message-only duplicate carries no code");
    assert!(!duplicate_code(121));
    let other = support::fixture_case(&fixture, "capture-other-code-rejected");
    assert_eq!(other["outcome"]["error"]["code"].as_i64(), Some(121));

    // --- participant receipts and the session coverage update --------------
    for case in support::cases_of(&fixture, "participant") {
        let name = case["name"].as_str().expect("case name");
        let subject = &case["subject"];
        let channel = subject["channelId"].as_str().expect("channelId");
        let session_id = ObjectId::parse_str(subject["sessionIdHex"].as_str().expect("sessionIdHex"))
            .expect("session id");
        let started = DateTime::from_millis(subject["startedMs"].as_i64().expect("startedMs"));
        let at = DateTime::from_millis(subject["atMs"].as_i64().expect("atMs"));
        let user = subject["userId"].as_str().expect("userId");
        let bucket = timeline_bucket(at.timestamp_millis(), started.timestamp_millis());
        let (filter, update) = participant_upsert(channel, session_id, bucket, user, at).expect("participant upsert");
        match recorded(case, "participant.updateOne") {
            Some(call) => {
                support::assert_document(&filter, &support::call_document(call, "filterHex"), &format!("{name}: receipt filter"));
                support::assert_document(&update, &support::call_document(call, "updateHex"), &format!("{name}: receipt update"));
                let options = support::call_document(call, "optionsHex");
                assert!(options.get_bool("upsert").unwrap_or(false), "{name}: receipt upsert");
            }
            None => assert!(
                user.is_empty() || user == BOT_ACCOUNT_ID || at.timestamp_millis() < started.timestamp_millis(),
                "{name}: unexpected participant write"
            ),
        }
        let coverage = participant_coverage_update(
            at,
            DateTime::from_millis(subject["middlewareNow"].as_i64().expect("middlewareNow")),
        );
        let resolved = case["outcome"]["status"].as_str() == Some("resolved");
        match recorded(case, "session.updateOne") {
            Some(call) => support::assert_document(
                &coverage,
                &support::call_document(call, "updateHex"),
                &format!("{name}: coverage update"),
            ),
            None => assert!(!resolved || recorded(case, "participant.updateOne").is_none(), "{name}: coverage skipped after a success"),
        }
        assert_eq!(
            recorded(case, "session.updateOne").is_some(),
            resolved && recorded(case, "participant.updateOne").is_some(),
            "{name}: coverage is published only after a successful receipt"
        );
        if let (Some(receipt), Some(coverage)) = (recorded(case, "participant.updateOne"), recorded(case, "session.updateOne")) {
            let receipt_role = receipt["role"].as_str().expect("role");
            let coverage_role = coverage["role"].as_str().expect("role");
            let order = support::call_roles(case);
            let receipt_index = order.iter().position(|role| role == receipt_role);
            let coverage_index = order.iter().position(|role| role == coverage_role);
            assert!(receipt_index < coverage_index, "{name}: receipt must precede coverage");
        }
    }

    // --- markers: moment and redemption upserts ----------------------------
    for case in support::cases_of(&fixture, "moment") {
        let name = case["name"].as_str().expect("case name");
        let input = &case["input"];
        let subject = &case["subject"];
        let session = session_from(&support::document(subject["sessionHex"].as_str().expect("sessionHex")));
        let at = DateTime::from_millis(input["atMs"].as_i64().expect("atMs"));
        let moment = TimelineMoment {
            channel_id: input["channelID"].as_str().expect("channelID").to_owned(),
            event_id: input["eventID"].as_str().expect("eventID").to_owned(),
            kind: input["kind"].as_str().expect("kind").parse().expect("activity kind"),
            at,
            label: input["label"].as_str().expect("label").to_owned(),
            value: json_number(&input["value"]),
        };
        let (filter, update) = moment_marker_upsert(&moment, session.id).expect("moment marker");
        let call = support::call(case, "marker.updateOne");
        support::assert_document(&filter, &support::call_document(call, "filterHex"), &format!("{name}: marker filter"));
        support::assert_document(&update, &support::call_document(call, "updateHex"), &format!("{name}: marker update"));
        let capture = CaptureInput {
            channel_id: moment.channel_id.clone(),
            event_id: moment.event_id.clone(),
            kind: moment.kind,
            occurred_at: Some(at),
            session: Some(session.clone()),
            actor: None,
            actor_label: None,
            key: None,
            label: Some(moment.label.clone()),
            value: moment.value,
            outcome: None,
            emotes: vec![],
        };
        let (filter, update) = activity_upsert(&capture, &session, at).expect("moment activity");
        let call = support::call(case, "activity.updateOne");
        support::assert_document(&filter, &support::call_document(call, "filterHex"), &format!("{name}: activity filter"));
        support::assert_document(&update, &support::call_document(call, "updateHex"), &format!("{name}: activity update"));
    }

    for case in support::cases_of(&fixture, "redemption") {
        let name = case["name"].as_str().expect("case name");
        let input = &case["input"];
        let subject = &case["subject"];
        let session_id = ObjectId::parse_str(subject["sessionIdHex"].as_str().expect("sessionIdHex"))
            .expect("session id");
        let event = TimelineRedemption {
            id: input["id"].as_str().expect("id").to_owned(),
            broadcaster_user_id: input["broadcaster_user_id"].as_str().expect("broadcaster").to_owned(),
            redeemed_at: input["redeemed_at"].as_str().expect("redeemed_at").to_owned(),
            reward: TimelineReward {
                id: input["reward"]["id"].as_str().expect("reward id").to_owned(),
                title: input["reward"]["title"].as_str().expect("reward title").to_owned(),
                cost: json_number(&input["reward"]["cost"]).expect("reward cost"),
            },
            status: input["status"].as_str().expect("status").to_owned(),
        };
        match recorded(case, "marker.updateOne") {
            Some(call) => {
                let at = dima_rust::utils::js_date::parse_date(&event.redeemed_at)
                    .map(DateTime::from_millis)
                    .expect("parsed redemption time");
                let (filter, update) = redemption_marker_upsert(&event, session_id, at).expect("redemption marker");
                support::assert_document(&filter, &support::call_document(call, "filterHex"), &format!("{name}: marker filter"));
                support::assert_document(&update, &support::call_document(call, "updateHex"), &format!("{name}: marker update"));
                assert!(recorded(case, "activity.updateOne").is_some(), "{name}: activity follows the marker");
                let roles = support::call_roles(case);
                let marker_index = roles.iter().position(|role| role == "marker.updateOne");
                let activity_index = roles.iter().position(|role| role == "activity.updateOne");
                assert!(marker_index < activity_index, "{name}: marker must precede the activity write");
            }
            None => assert!(
                event.id.is_empty()
                    || dima_rust::utils::js_date::parse_date(&event.redeemed_at).is_none()
                    || support::call(case, "session.findOne")["docHex"].is_null(),
                "{name}: unexpected marker write"
            ),
        }
    }

    // --- activity reads: filters, options and output -----------------------
    for case in support::cases_of(&fixture, "read") {
        let name = case["name"].as_str().expect("case name");
        let subject = &case["subject"];
        let channel = subject["channelId"].as_str().expect("channelId");
        let session_id = ObjectId::parse_str(subject["sessionIdHex"].as_str().expect("sessionIdHex"))
            .expect("session id");
        let now = DateTime::from_millis(subject["now"].as_i64().expect("now"));
        let tier = subject["tier"].as_str().expect("tier");
        let ActivityFilters { summary, commands, emotes, series, pending } =
            activity_filters(channel, session_id, now);
        for (role, filter) in [
            ("aggregate.summary", &summary),
            ("aggregate.commands", &commands),
            ("aggregate.emotes", &emotes),
            ("aggregate.series", &series),
            ("activity.pending", &pending),
        ] {
            let call = support::call(case, role);
            support::assert_document(filter, &support::call_document(call, "filterHex"), &format!("{name}: {role} filter"));
        }
        let summary_call = support::call(case, "aggregate.summary");
        let summary_options = support::call_document(summary_call, "optionsHex");
        assert_eq!(json_integer(&summary_options, "maxTimeMS"), READ_MAX_TIME_MS as i64, "{name}: summary maxTimeMS");
        for role in ["aggregate.commands", "aggregate.emotes"] {
            let call = support::call(case, role);
            let options = support::call_document(call, "optionsHex");
            assert_eq!(json_integer(&options, "limit"), RANK_LIMIT, "{name}: {role} limit");
            assert_eq!(json_field(&options, "sort"), &doc! {"count": -1, "_id": 1}, "{name}: {role} sort");
            assert_eq!(json_integer(&options, "maxTimeMS"), READ_MAX_TIME_MS as i64, "{name}: {role} maxTimeMS");
        }
        let series_call = support::call(case, "aggregate.series");
        let series_options = support::call_document(series_call, "optionsHex");
        assert_eq!(json_integer(&series_options, "limit"), SERIES_LIMIT, "{name}: series limit");
        assert_eq!(json_field(&series_options, "sort"), &doc! {"bucket": 1}, "{name}: series sort");
        let pending_options = support::call_document(support::call(case, "activity.pending"), "optionsHex");
        assert_eq!(json_field(&pending_options, "projection"), &doc! {"_id": 1}, "{name}: pending projection");

        let summary = support::returned_document(summary_call);
        let commands = support::call_documents(support::call(case, "aggregate.commands"));
        let emotes = support::call_documents(support::call(case, "aggregate.emotes"));
        let series = support::call_documents(series_call);
        let pending = support::returned_document(support::call(case, "activity.pending")).is_some();
        let result = build_activity_result(summary.as_ref(), &commands, &emotes, &series, pending, tier);
        support::assert_json(&Bson::Document(result), support::output(case), &format!("{name}: output"));
    }

    // --- timeline reads: filters and the complete response ----------------
    for case in support::cases_of(&fixture, "timeline") {
        let name = case["name"].as_str().expect("case name");
        let subject = &case["subject"];
        let channel = subject["channelId"].as_str().expect("channelId");
        let session_id = ObjectId::parse_str(subject["sessionIdHex"].as_str().expect("sessionIdHex"))
            .expect("session id");
        let session_document = support::document(subject["sessionHex"].as_str().expect("sessionHex"));
        let started = DateTime::from_millis(subject["startedMs"].as_i64().expect("startedMs"));
        let end = DateTime::from_millis(subject["endedMs"].as_i64().expect("endedMs"));
        let now = DateTime::from_millis(subject["now"].as_i64().expect("now"));
        let tier = subject["tier"].as_str().expect("tier");
        let TimelineFilters { snapshots, raids, markers, participants } =
            timeline_filters(channel, session_id, started, end, now);
        for (role, filter) in [
            ("snapshot.find", &snapshots),
            ("raid.find", &raids),
            ("marker.find", &markers),
            ("participant.find", &participants),
        ] {
            if let Some(call) = recorded(case, role) {
                support::assert_document(filter, &support::call_document(call, "filterHex"), &format!("{name}: {role} filter"));
            }
        }
        let snapshot_call = support::call(case, "snapshot.find");
        let snapshot_options = support::call_document(snapshot_call, "optionsHex");
        assert_eq!(json_integer(&snapshot_options, "limit"), (MAX_ROWS + 1) as i64, "{name}: snapshot limit");
        assert_eq!(json_field(&snapshot_options, "sort"), &doc! {"captured_at": 1}, "{name}: snapshot sort");
        let marker_options = support::call_document(support::call(case, "marker.find"), "optionsHex");
        assert_eq!(json_integer(&marker_options, "limit"), 101, "{name}: marker limit");
        assert_eq!(json_field(&marker_options, "sort"), &doc! {"occurredAt": 1, "_id": 1}, "{name}: marker sort");
        let raid_options = support::call_document(support::call(case, "raid.find"), "optionsHex");
        assert_eq!(json_integer(&raid_options, "limit"), 101, "{name}: raid limit");

        let summary = support::returned_document(support::call(case, "aggregate.summary"));
        let commands = support::call_documents(support::call(case, "aggregate.commands"));
        let emotes = support::call_documents(support::call(case, "aggregate.emotes"));
        let series = support::call_documents(support::call(case, "aggregate.series"));
        let pending = support::returned_document(support::call(case, "activity.pending")).is_some();
        let activity = build_activity_result(summary.as_ref(), &commands, &emotes, &series, pending, tier);
        let response = build_timeline(
            subject["sessionIdHex"].as_str().expect("sessionIdHex"),
            &session_document,
            started,
            end,
            now,
            activity,
            &support::call_documents(snapshot_call),
            &support::call_documents(support::call(case, "raid.find")),
            &support::call_documents(support::call(case, "marker.find")),
            &recorded(case, "participant.find")
                .map(|call| support::call_documents(call))
                .unwrap_or_default(),
            tier,
        )
        .expect("timeline response");
        support::assert_json(&Bson::Document(response), support::output(case), &format!("{name}: output"));
    }

    // --- retention queries ------------------------------------------------
    let streams = support::fixture_case(&fixture, "streams-page-2");
    let streams_subject = &streams["subject"];
    let streams_now = DateTime::from_millis(streams_subject["now"].as_i64().expect("now"));
    let cutoff = DateTime::from_millis(streams_now.timestamp_millis() - TIMELINE_RETENTION_MS);
    let filter = streams_page_filter(streams_subject["channelId"].as_str().expect("channelId"), cutoff);
    let call = support::call(streams, "stream.find");
    support::assert_document(&filter, &support::call_document(call, "filterHex"), "streams: filter");
    let options = support::call_document(call, "optionsHex");
    assert_eq!(json_integer(&options, "skip"), 20, "streams: page 2 skip");
    assert_eq!(json_integer(&options, "limit"), 21, "streams: page size plus one");
    assert_eq!(json_field(&options, "sort"), &doc! {"started_at": -1}, "streams: sort");
    assert_eq!(json_integer(&options, "maxTimeMS"), 3000, "streams: maxTimeMS");

    let session_case = support::fixture_case(&fixture, "session-lookup");
    let session_now = DateTime::from_millis(session_case["subject"]["now"].as_i64().expect("now"));
    let cutoff = DateTime::from_millis(session_now.timestamp_millis() - TIMELINE_RETENTION_MS);
    let session_id = ObjectId::parse_str(session_case["subject"]["sessionIdHex"].as_str().expect("sessionIdHex"))
        .expect("session id");
    let filter = session_row_filter(session_case["subject"]["channelId"].as_str().expect("channelId"), session_id, cutoff);
    let call = support::call(session_case, "session.findOne");
    support::assert_document(&filter, &support::call_document(call, "filterHex"), "session: filter");
    assert_eq!(
        json_integer(&support::call_document(call, "optionsHex"), "maxTimeMS"),
        READ_MAX_TIME_MS as i64,
        "session: maxTimeMS"
    );
}

// ---------------------------------------------------------------------------
// Disposable MongoDB suites
// ---------------------------------------------------------------------------

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

async fn fixture(suffix: &str) -> TestResult<support::DisposableDatabase> {
    support::disposable_database(suffix).await
}

fn numeric(document: &Document, key: &str) -> f64 {
    match document.get(key) {
        Some(Bson::Int32(value)) => f64::from(*value),
        Some(Bson::Int64(value)) => *value as f64,
        Some(Bson::Double(value)) => *value,
        other => panic!("{key}: not a BSON number: {other:?}"),
    }
}

fn sample_input(channel: &str, event: &str, kind: ActivityKind, at: DateTime, session: Option<CaptureSession>) -> CaptureInput {
    CaptureInput {
        channel_id: channel.to_owned(),
        event_id: event.to_owned(),
        kind,
        occurred_at: Some(at),
        session,
        actor: Some("actor-1".into()),
        actor_label: Some("Actor One".into()),
        key: None,
        label: None,
        value: None,
        outcome: None,
        emotes: vec![TimelineEmote { key: "twitch:25".into(), label: "Kappa".into(), count: 2 }],
    }
}

async fn seed_session(
    database: &mongodb::Database,
    channel: &str,
    session_id: ObjectId,
    started_at: DateTime,
    ended_at: Option<DateTime>,
) -> TestResult {
    dima_rust::schemas::stream_session::schema()
        .native_collection(database)
        .insert_one(doc! {
            "_id": session_id,
            "channelID": channel,
            "channel": "Fixture Streamer",
            "stream_id": format!("stream-{session_id}"),
            "started_at": started_at,
            "ended_at": ended_at,
            "status": "live",
        })
        .await?;
    Ok(())
}

fn activities(database: &mongodb::Database) -> mongodb::Collection<Document> {
    dima_rust::schemas::stream_activity::schema().native_collection(database)
}

fn aggregates(database: &mongodb::Database) -> mongodb::Collection<Document> {
    dima_rust::schemas::stream_activity::aggregate_schema().native_collection(database)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a lead-owned disposable MongoDB (STREAM_TIMELINE_TEST_MONGO_*)"]
async fn capture_dedupe_and_upsert_defaults_against_disposable_mongo() -> TestResult {
    let fixture = fixture("capture").await?;
    let outcome = tokio::time::timeout(Duration::from_secs(60), async {
        let now = DateTime::now();
        let started = DateTime::from_millis(now.timestamp_millis() - 5_500);
        let at = DateTime::from_millis(now.timestamp_millis() - 1_000);
        let channel = "channel-capture";
        let session_id = ObjectId::new();
        seed_session(&fixture.database, channel, session_id, started, None).await?;

        let capture = StreamActivityCapture::new(fixture.database.clone());
        let input = sample_input(channel, "event-1", ActivityKind::Message, at, None);
        capture.capture_at(&input, now).await.expect("first capture");
        // Same event id twice: the deterministic `_id` must absorb the repeat.
        capture.capture_at(&input, now).await.expect("duplicate capture");
        let collection = activities(&fixture.database);
        let filter = doc! {"channelID": channel};
        assert_eq!(collection.count_documents(filter.clone()).await?, 1, "exactly one row per event id");

        let key = hash(&[channel.into(), "message".into(), "event-1".into()]).expect("event id");
        let stored = collection.find_one(doc! {"_id": &key}).await?.expect("stored activity");
        assert_eq!(stored.get_str("channelID")?, channel);
        assert_eq!(stored.get_object_id("session_id")?, session_id);
        assert_eq!(stored.get_datetime("occurredAt")?.timestamp_millis(), at.timestamp_millis());
        assert_eq!(stored.get_str("kind")?, "message");
        assert_eq!(stored.get_str("actor")?, "actor-1");
        assert_eq!(stored.get_str("actorLabel")?, "Actor One");
        // Omitted optionals fall back to the schema defaults the source relies on.
        assert_eq!(stored.get_str("key")?, "");
        assert_eq!(stored.get_str("label")?, "");
        assert_eq!(stored.get_str("outcome")?, "ok");
        assert_eq!(stored.get("processed"), Some(&Bson::Boolean(false)));
        assert!(stored.contains_key("dashboardProcessed"), "dashboard default is stored");
        assert_eq!(stored.get("dashboardProcessed"), Some(&Bson::Null));
        assert_eq!(stored.get_array("emotes")?.len(), 1);
        assert_eq!(stored.get_array("emotes")?[0].as_document().expect("emote").get_i32("count")?, 2);
        assert_eq!(stored.get("value"), Some(&Bson::Int32(1)), "Math.max(0, value ?? 1)");
        assert_eq!(stored.get("offset"), Some(&Bson::Double(4.5)), "fractional offset stays Double");
        assert_eq!(
            stored.get_datetime("expiresAt")?.timestamp_millis(),
            at.timestamp_millis() + ACTIVITY_RETENTION_MS
        );

        // A different event id is a different receipt.
        let second = sample_input(channel, "event-2", ActivityKind::Message, at, None);
        capture.capture_at(&second, now).await.expect("second event");
        assert_eq!(collection.count_documents(filter).await?, 2, "distinct event ids insert distinct rows");
        Ok(())
    })
    .await;
    let name = fixture.name.clone();
    fixture.drop_database().await;
    outcome.unwrap_or_else(|_| panic!("capture suite timed out in {name}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a lead-owned disposable MongoDB (STREAM_TIMELINE_TEST_MONGO_*)"]
async fn duplicate_key_is_swallowed_by_code_against_disposable_mongo() -> TestResult {
    let fixture = fixture("duplicate").await?;
    let outcome = tokio::time::timeout(Duration::from_secs(60), async {
        let now = DateTime::now();
        let started = DateTime::from_millis(now.timestamp_millis() - 5_500);
        let at = DateTime::from_millis(now.timestamp_millis() - 1_000);
        let channel = "channel-duplicate";
        let session_id = ObjectId::new();
        seed_session(&fixture.database, channel, session_id, started, None).await?;
        let collection = activities(&fixture.database);
        // A unique index the activity schema does not declare, so a second
        // receipt with a different event id collides for real on the server.
        let mut options = IndexOptions::default();
        options.unique = Some(true);
        collection
            .create_index(
                IndexModel::builder()
                    .keys(doc! {"channelID": 1, "occurredAt": 1})
                    .options(options)
                    .build(),
            )
            .await?;
        let capture = StreamActivityCapture::new(fixture.database.clone());
        capture
            .capture_at(&sample_input(channel, "event-a", ActivityKind::Message, at, None), now)
            .await
            .expect("first receipt");
        // The real driver returns code 11000 here; the source swallows that code.
        capture
            .capture_at(&sample_input(channel, "event-b", ActivityKind::Message, at, None), now)
            .await
            .expect("duplicate key is swallowed by code");
        let filter = doc! {"channelID": channel};
        assert_eq!(collection.count_documents(filter).await?, 1, "the duplicate write inserted nothing");
        Ok(())
    })
    .await;
    let name = fixture.name.clone();
    fixture.drop_database().await;
    outcome.unwrap_or_else(|_| panic!("duplicate suite timed out in {name}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a lead-owned disposable MongoDB (STREAM_TIMELINE_TEST_MONGO_*)"]
async fn reader_retention_buckets_and_limits_against_disposable_mongo() -> TestResult {
    let fixture = fixture("reader").await?;
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        let now = DateTime::now();
        let started = DateTime::from_millis(now.timestamp_millis() - 900_000);
        let channel = "channel-reader";
        let other = "channel-other";
        let session_id = ObjectId::new();
        let other_session = ObjectId::new();
        let fresh = now.timestamp_millis() + TIMELINE_RETENTION_MS;
        let expired = now.timestamp_millis() - 1_000;
        let aggregates = aggregates(&fixture.database);
        let live = |scope: &str, patch: Document| {
            let mut base = doc! {
                "channelID": channel,
                "session_id": session_id,
                "scope": scope,
                "expiresAt": DateTime::from_millis(fresh),
            };
            base.extend(patch);
            base
        };
        let mut documents = vec![
            live("summary", doc! {"_id": "live-summary", "messages": 12, "commands": 3, "emotes": 4,
                "emoteMessages": 2, "redemptions": 1, "follows": 1, "subs": 0, "bits": 250, "raids": 0,
                "firstAt": started, "messageStartedAt": DateTime::from_millis(started.timestamp_millis() + 300),
                "updatedAt": DateTime::from_millis(now.timestamp_millis() - 1_000)}),
            // Retention and session scope must exclude both of these.
            live("summary", doc! {"_id": "expired-summary", "messages": 999, "expiresAt": DateTime::from_millis(expired)}),
            doc! {"_id": "foreign-summary", "channelID": other, "session_id": other_session, "scope": "summary",
                "messages": 777, "expiresAt": DateTime::from_millis(fresh)},
            // Ranking rows: only the 20 highest counts survive the limit.
            live("rank", doc! {"_id": "rank-zero", "kind": "command", "key": "zero", "label": "!zero", "count": 0, "failures": 0}),
        ];
        for index in 1..=21 {
            documents.push(live("rank", doc! {"_id": format!("rank-{index:02}"), "kind": "command",
                "key": format!("cmd{index:02}"), "label": format!("!cmd{index:02}"), "count": index, "failures": if index % 2 == 0 { 1 } else { 0 }}));
            documents.push(live("rank", doc! {"_id": format!("emote-{index:02}"), "kind": "emote",
                "key": format!("twitch:{index}"), "label": format!("Emote{index:02}"), "count": index, "messages": index}));
        }
        // 2001 chart rows: one more than the point cap, so the read reports truncation.
        for bucket in 0..=2000 {
            documents.push(live("chart", doc! {"_id": format!("chart-{bucket:04}"), "bucket": bucket,
                "commands": 1, "emotes": 0, "messages": bucket, "chatters": 1}));
        }
        documents.push(live("chart", doc! {"_id": "chart-negative", "bucket": -1, "messages": 5}));
        documents.push(doc! {"_id": "foreign-chart", "channelID": other, "session_id": other_session, "scope": "chart",
            "bucket": 0, "messages": 5, "expiresAt": DateTime::from_millis(fresh)});
        aggregates.insert_many(documents).await?;

        let activity = activities(&fixture.database);
        activity
            .insert_many(vec![
                doc! {"_id": "pending", "channelID": channel, "session_id": session_id, "kind": "message",
                    "processed": false, "expiresAt": DateTime::from_millis(fresh)},
                doc! {"_id": "processed", "channelID": channel, "session_id": session_id, "kind": "message",
                    "processed": true, "expiresAt": DateTime::from_millis(fresh)},
                doc! {"_id": "expired", "channelID": channel, "session_id": session_id, "kind": "message",
                    "processed": false, "expiresAt": DateTime::from_millis(expired)},
            ])
            .await?;

        let reader = StreamActivityReader::new(fixture.database.clone());
        let free = reader.get_stream_activity(channel, session_id, None).await?;
        let totals = free.get_document("totals")?;
        assert_eq!(totals.get_i32("messages")?, 12, "the live summary is the only summary in scope");
        assert_eq!(totals.get_i32("bits")?, 250);
        assert!(free.get_bool("pending")?, "an unprocessed, unexpired receipt is pending");

        let commands = free.get_array("commands")?;
        assert_eq!(commands.len(), RANK_LIMIT as usize, "rank limit keeps the top twenty");
        let counts: Vec<i32> = commands.iter().map(|row| row.as_document().expect("command").get_i32("count").expect("count")).collect();
        assert_eq!(counts, (2..=21).rev().collect::<Vec<i32>>(), "count descending, lowest ranks dropped");
        assert!(counts.iter().all(|count| *count > 0), "the zero-count row is outside the limit");
        assert!(
            !commands[0].as_document().expect("command").contains_key("errors"),
            "free tier hides failures"
        );
        let emotes = free.get_array("emotes")?;
        assert_eq!(emotes.len(), RANK_LIMIT as usize);
        assert_eq!(emotes[0].as_document().expect("emote").get_i32("count")?, 21);

        let series = free.get_array("series")?;
        assert_eq!(series.len(), 2000, "points are capped at MAX_ROWS");
        assert!(free.get_bool("truncated")?, "a 2001st chart row marks the series truncated");
        let first_point = series[0].as_document().expect("point");
        assert_eq!(numeric(first_point, "offsetSeconds"), 0.0, "the first bucket starts at zero");
        assert!(!first_point.contains_key("commands"), "free tier hides per-point commands");
        assert_eq!(numeric(first_point, "messages"), 0.0);
        let last_point = series[1999].as_document().expect("point");
        assert_eq!(numeric(last_point, "offsetSeconds"), 599_700.0);

        let pro = reader.get_stream_activity(channel, session_id, Some("pro")).await?;
        assert_eq!(pro.get_array("commands")?[0].as_document().expect("command").get_i32("errors")?, 0);
        assert!(pro.get_array("series")?[0].as_document().expect("point").contains_key("commands"));
        assert!(pro.get_document("capabilities")?.get_bool("users")?);

        // Marking the pending receipt processed clears the flag.
        activity
            .update_many(doc! {"processed": false}, doc! {"$set": {"processed": true}})
            .await?;
        let settled = reader.get_stream_activity(channel, session_id, None).await?;
        assert!(!settled.get_bool("pending")?);
        Ok(())
    })
    .await;
    let name = fixture.name.clone();
    fixture.drop_database().await;
    outcome.unwrap_or_else(|_| panic!("reader suite timed out in {name}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a lead-owned disposable MongoDB (STREAM_TIMELINE_TEST_MONGO_*)"]
async fn timeline_queries_and_marker_cursor_against_disposable_mongo() -> TestResult {
    let fixture = fixture("timeline").await?;
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        let now = DateTime::now();
        let started = DateTime::from_millis(now.timestamp_millis() - 900_000);
        let ended = DateTime::from_millis(now.timestamp_millis() - 300_000);
        let channel = "channel-timeline";
        let session_id = ObjectId::new();
        seed_session(&fixture.database, channel, session_id, started, Some(ended)).await?;
        // Coverage publication timestamps come from the session record.
        dima_rust::schemas::stream_session::schema()
            .native_collection(&fixture.database)
            .update_one(doc! {"_id": session_id}, doc! {"$set": {"chat_tracking_started_at": started}})
            .await?;
        let fresh = now.timestamp_millis() + TIMELINE_RETENTION_MS;
        let expired = now.timestamp_millis() - 1_000;

        dima_rust::schemas::stream_viewer_snapshot::schema()
            .native_collection(&fixture.database)
            .insert_many(vec![
                doc! {"channelID": channel, "session_id": session_id, "stream_id": "stream-1",
                    "captured_at": DateTime::from_millis(started.timestamp_millis() + 60_000), "viewers": 120,
                    "title": "Title A", "game_name": "Game A", "messages": 10, "commands": 2},
                doc! {"channelID": channel, "session_id": session_id, "stream_id": "stream-1",
                    "captured_at": DateTime::from_millis(started.timestamp_millis() + 120_000), "viewers": 160,
                    "title": "Title B", "game_name": "Game B", "messages": 30, "commands": 5},
                // Outside the session window (ends at `ended`).
                doc! {"channelID": channel, "session_id": session_id, "stream_id": "stream-1",
                    "captured_at": DateTime::from_millis(started.timestamp_millis() + 700_000), "viewers": 9,
                    "title": "After", "game_name": "Game Z", "messages": 1, "commands": 0},
            ])
            .await?;

        dima_rust::schemas::domain_event::schema()
            .native_collection(&fixture.database)
            .insert_many(vec![
                doc! {"eventKey": "raid-1", "source": "twitch-eventsub", "sourceEventId": "raid-1",
                    "type": "channel.raid.received", "topic": "channel", "schemaVersion": 1, "channelID": channel,
                    "occurredAt": DateTime::from_millis(started.timestamp_millis() + 700_000),
                    "journaledAt": now, "payload": {"event": {"from_broadcaster_user_name": "RaidLeader", "viewers": 42}},
                    "metadata": {}, "expiresAt": DateTime::from_millis(fresh)},
                // Expired domain event: the `expiresAt` filter must drop it.
                doc! {"eventKey": "raid-expired", "source": "twitch-eventsub", "sourceEventId": "raid-expired",
                    "type": "channel.raid.received", "topic": "channel", "schemaVersion": 1, "channelID": channel,
                    "occurredAt": DateTime::from_millis(started.timestamp_millis() + 710_000),
                    "journaledAt": now, "payload": {"event": {"from_broadcaster_user_name": "Stale", "viewers": 1}},
                    "metadata": {}, "expiresAt": DateTime::from_millis(expired)},
            ])
            .await?;

        let mut markers = Vec::new();
        // Second precision: the marker cursor must still print `.000Z`, which
        // RFC 3339 formatting only produces by accident.
        let marker_base = now.timestamp_millis() - now.timestamp_millis() % 1_000;
        for index in 0..101i64 {
            markers.push(doc! {"channelID": channel, "session_id": session_id,
                "key": format!("event:{index}"), "kind": "follow", "label": format!("Follower {index}"),
                "occurredAt": DateTime::from_millis(marker_base + index * 1_000),
                "expiresAt": DateTime::from_millis(fresh)});
        }
        markers.push(doc! {"channelID": channel, "session_id": session_id, "key": "event:expired",
            "kind": "follow", "label": "Expired", "occurredAt": DateTime::from_millis(started.timestamp_millis()),
            "expiresAt": DateTime::from_millis(expired)});
        markers.push(doc! {"channelID": channel, "session_id": session_id, "key": "redemption:r1",
            "kind": "redemption", "label": "Hydrate", "rewardID": "reward-1", "cost": 500, "status": "fulfilled",
            "occurredAt": DateTime::from_millis(started.timestamp_millis() + 800_000),
            "expiresAt": DateTime::from_millis(fresh)});
        dima_rust::schemas::stream_timeline::marker_schema()
            .native_collection(&fixture.database)
            .insert_many(markers)
            .await?;

        dima_rust::schemas::stream_timeline::participant_schema()
            .native_collection(&fixture.database)
            .insert_many(vec![
                doc! {"channelID": channel, "session_id": session_id, "bucket": 0, "user_id": "u1", "expiresAt": DateTime::from_millis(fresh)},
                doc! {"channelID": channel, "session_id": session_id, "bucket": 1, "user_id": "u1", "expiresAt": DateTime::from_millis(fresh)},
                doc! {"channelID": channel, "session_id": session_id, "bucket": 1, "user_id": "u2", "expiresAt": DateTime::from_millis(fresh)},
                // Expired receipt in a counted bucket: it must not be counted.
                doc! {"channelID": channel, "session_id": session_id, "bucket": 1, "user_id": "expired", "expiresAt": DateTime::from_millis(expired)},
            ])
            .await?;

        let service = StreamTimelineService::new(fixture.database.clone());
        let session_hex = session_id.to_hex();
        let timeline = service
            .get_stream_timeline(channel, &session_hex, Some("pro"))
            .await?
            .expect("timeline response");
        let points = timeline.get_array("points")?;
        assert_eq!(points.len(), 2, "the out-of-window snapshot is excluded");
        assert_eq!(numeric(points[0].as_document().expect("point"), "viewers"), 120.0);
        assert_eq!(numeric(points[1].as_document().expect("point"), "viewers"), 160.0);
        let events = timeline.get_array("events")?;
        let ids: Vec<&str> = events
            .iter()
            .map(|event| event.as_document().expect("event").get_str("id").expect("event id"))
            .collect();
        assert!(ids.iter().any(|id| id.starts_with("game:")), "a game change is recorded");
        assert!(ids.iter().any(|id| id.starts_with("title:")), "a title change is recorded");
        assert!(ids.contains(&"event:raid-1"), "the live raid domain event is a moment");
        assert!(!ids.contains(&"event:raid-expired"), "the expired raid is filtered out");
        let raid = events
            .iter()
            .filter_map(Bson::as_document)
            .find(|event| event.get_str("id").unwrap_or("") == "event:raid-1")
            .expect("raid event");
        assert_eq!(raid.get_str("label")?, "RaidLeader");
        assert_eq!(numeric(raid, "value"), 42.0);
        let redemption = events
            .iter()
            .filter_map(Bson::as_document)
            .find(|event| event.get_str("kind").unwrap_or("") == "redemption")
            .expect("redemption marker");
        assert_eq!(redemption.get_str("label")?, "Hydrate");
        assert_eq!(redemption.get_str("rewardID")?, "reward-1");
        assert_eq!(numeric(redemption, "cost"), 500.0);

        let marker_page = timeline.get_document("markerPage")?;
        assert!(marker_page.get_bool("hasMore")?, "101 live markers exceed one page");
        let cursor = marker_page.get_str("cursor")?;
        assert!(
            cursor.contains(".000Z|"),
            "the cursor uses the JavaScript ISO form, not RFC 3339: {cursor}"
        );
        let (timestamp, marker_id) = cursor.split_once('|').expect("cursor carries a timestamp and id");
        assert!(timestamp.ends_with('Z'), "the cursor timestamp is UTC");
        assert_eq!(marker_id.len(), 24, "the cursor id is a hex ObjectId");
        let coverage = timeline.get_document("coverage")?;
        assert!(coverage.get_bool("momentsPartial")?);
        assert!(!coverage.get_bool("truncated")?);
        assert_eq!(coverage.get_i32("retentionDays")?, 90);

        let chatters = timeline.get_array("chatters")?;
        assert_eq!(chatters.len(), 2, "the 600-second session spans two five-minute buckets");
        assert_eq!(numeric(chatters[0].as_document().expect("bucket"), "count"), 1.0);
        assert_eq!(
            numeric(chatters[1].as_document().expect("bucket"), "count"),
            2.0,
            "the expired receipt is excluded"
        );

        // Listing: retention, newest first, page size plus one.
        let sessions = dima_rust::schemas::stream_session::schema().native_collection(&fixture.database);
        let mut rows = Vec::new();
        for index in 0..21u64 {
            rows.push(doc! {"channelID": channel, "channel": "Fixture", "stream_id": format!("listed-{index}"),
                "started_at": DateTime::from_millis(now.timestamp_millis() - 3_600_000 - index as i64 * 60_000),
                "ended_at": DateTime::from_millis(now.timestamp_millis() - 3_000_000), "status": "offline"});
        }
        // Outside the 90-day retention window, plus another channel.
        rows.push(doc! {"channelID": channel, "channel": "Fixture", "stream_id": "too-old",
            "started_at": DateTime::from_millis(now.timestamp_millis() - TIMELINE_RETENTION_MS - 60_000),
            "ended_at": DateTime::from_millis(now.timestamp_millis() - TIMELINE_RETENTION_MS), "status": "offline"});
        rows.push(doc! {"channelID": "channel-other", "channel": "Other", "stream_id": "other",
            "started_at": DateTime::from_millis(now.timestamp_millis() - 60_000), "ended_at": now, "status": "offline"});
        sessions.insert_many(rows).await?;
        let page_one = service.list_timeline_streams(channel, 1).await?;
        let streams = page_one.get_array("streams")?;
        assert_eq!(streams.len(), 20);
        assert!(page_one.get_bool("hasMore")?, "more retained sessions exist");
        // The seeded timeline session is the newest of the 22 retained rows.
        assert_eq!(streams[0].as_document().expect("stream").get_str("id")?, session_hex.as_str());
        let page_two = service.list_timeline_streams(channel, 2).await?;
        assert_eq!(page_two.get_array("streams")?.len(), 2);
        assert!(!page_two.get_bool("hasMore")?);
        let listed: Vec<&str> = streams
            .iter()
            .map(|row| row.as_document().expect("stream").get_str("id").expect("stream id"))
            .collect();
        assert!(!listed.contains(&"too-old"), "retention excludes the old session");
        assert!(!listed.contains(&"other"), "channel scoping excludes the other channel");
        assert_eq!(service.list_timeline_streams(channel, 1).await?.get_i64("page")?, 1, "page echo");

        // Session lookup: retention, channel scope, id shape.
        let found = service.get_timeline_session(channel, &session_hex).await?.expect("current session");
        assert_eq!(found.get_object_id("_id")?, session_id);
        assert!(service.get_timeline_session("channel-other", &session_hex).await?.is_none());
        assert!(service.get_timeline_session(channel, "not-an-object-id").await.is_err());
        Ok(())
    })
    .await;
    let name = fixture.name.clone();
    fixture.drop_database().await;
    outcome.unwrap_or_else(|_| panic!("timeline suite timed out in {name}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a lead-owned disposable MongoDB (STREAM_TIMELINE_TEST_MONGO_*)"]
async fn participant_timestamp_update_against_disposable_mongo() -> TestResult {
    let fixture = fixture("participant").await?;
    let outcome = tokio::time::timeout(Duration::from_secs(60), async {
        let now = DateTime::now();
        let started = DateTime::from_millis(now.timestamp_millis() - 700_000);
        let channel = "channel-participant";
        let session_id = ObjectId::new();
        seed_session(&fixture.database, channel, session_id, started, None).await?;
        let sessions = dima_rust::schemas::stream_session::schema().native_collection(&fixture.database);
        sessions
            .update_one(doc! {"_id": session_id}, doc! {"$set": {
                "created_at": DateTime::from_millis(now.timestamp_millis() - 3_600_000),
                "updated_at": DateTime::from_millis(now.timestamp_millis() - 3_600_000),
            }})
            .await?;
        let before = sessions.find_one(doc! {"_id": session_id}).await?.expect("session");
        let created_at = *before.get_datetime("created_at")?;
        let seeded_update = before.get_datetime("updated_at")?.timestamp_millis();

        let service = StreamTimelineService::new(fixture.database.clone());
        let later = DateTime::from_millis(now.timestamp_millis() - 60_000);
        let earlier = DateTime::from_millis(now.timestamp_millis() - 90_000);
        service.record_timeline_participant(channel, session_id, started, "user-1", later).await?;
        let after_later = sessions.find_one(doc! {"_id": session_id}).await?.expect("session");
        assert_eq!(
            after_later.get_datetime("chat_tracking_started_at")?.timestamp_millis(),
            later.timestamp_millis(),
            "coverage records the receipt time, not the refresh time"
        );
        let refreshed = after_later.get_datetime("updated_at")?.timestamp_millis();
        assert!(refreshed > seeded_update, "the timestamp refresh is a real write");

        service.record_timeline_participant(channel, session_id, started, "user-1", earlier).await?;
        let after_earlier = sessions.find_one(doc! {"_id": session_id}).await?.expect("session");
        assert_eq!(
            after_earlier.get_datetime("chat_tracking_started_at")?.timestamp_millis(),
            earlier.timestamp_millis(),
            "$min keeps the earliest coverage time"
        );
        assert!(
            after_earlier.get_datetime("updated_at")?.timestamp_millis() >= refreshed,
            "every receipt refreshes updated_at"
        );
        assert_eq!(
            after_earlier.get_datetime("created_at")?.timestamp_millis(),
            created_at.timestamp_millis(),
            "the session insert timestamp is untouched"
        );

        // Receipts: one row per (session, bucket, user), guards write nothing.
        let participants = dima_rust::schemas::stream_timeline::participant_schema().native_collection(&fixture.database);
        let filter = doc! {"channelID": channel, "session_id": session_id};
        assert_eq!(participants.count_documents(filter.clone()).await?, 1, "repeat receipts deduplicate");
        service
            .record_timeline_participant(channel, session_id, started, "user-2", earlier)
            .await?;
        assert_eq!(participants.count_documents(filter.clone()).await?, 2, "another user is another receipt");
        service.record_timeline_participant(channel, session_id, started, BOT_ACCOUNT_ID, later).await?;
        service.record_timeline_participant(channel, session_id, started, "", later).await?;
        service
            .record_timeline_participant(channel, session_id, started, "user-3", DateTime::from_millis(started.timestamp_millis() - 1))
            .await?;
        assert_eq!(participants.count_documents(filter).await?, 2, "guarded receipts write nothing");
        Ok(())
    })
    .await;
    let name = fixture.name.clone();
    fixture.drop_database().await;
    outcome.unwrap_or_else(|_| panic!("participant suite timed out in {name}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a lead-owned disposable MongoDB (STREAM_TIMELINE_TEST_MONGO_*)"]
async fn capture_failure_leaves_no_partial_write_against_disposable_mongo() -> TestResult {
    let fixture = fixture("failure").await?;
    let outcome = tokio::time::timeout(Duration::from_secs(60), async {
        let now = DateTime::now();
        let started = DateTime::from_millis(now.timestamp_millis() - 5_500);
        let at = DateTime::from_millis(now.timestamp_millis() - 1_000);
        let channel = "channel-failure";
        let session_id = ObjectId::new();
        seed_session(&fixture.database, channel, session_id, started, None).await?;
        // A server-side validator that no activity write can satisfy: the insert
        // fails with a document-validation error, not a duplicate key.
        fixture
            .database
            .run_command(doc! {"create": "stream_activities", "validator": {"$jsonSchema": {
                "bsonType": "object",
                "required": ["neverWritten"],
            }}})
            .await?;
        let capture = StreamActivityCapture::new(fixture.database.clone());
        let error = capture
            .capture_at(&sample_input(channel, "event-fail", ActivityKind::Message, at, None), now)
            .await
            .expect_err("a document-validation failure must not be swallowed");
        assert_eq!(error, dima_rust::workers::stream_activity::capture::StreamActivityError::Runtime);
        let collection = activities(&fixture.database);
        assert_eq!(
            collection.count_documents(doc! {"channelID": channel}).await?,
            0,
            "a failed capture leaves no partial document"
        );
        Ok(())
    })
    .await;
    let name = fixture.name.clone();
    fixture.drop_database().await;
    outcome.unwrap_or_else(|_| panic!("failure suite timed out in {name}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a lead-owned disposable MongoDB (STREAM_TIMELINE_TEST_MONGO_*)"]
async fn capture_cancellation_does_not_replay_into_duplicate_against_disposable_mongo() -> TestResult {
    let fixture = fixture("cancel").await?;
    let outcome = tokio::time::timeout(Duration::from_secs(60), async {
        let now = DateTime::now();
        let started = DateTime::from_millis(now.timestamp_millis() - 5_500);
        let at = DateTime::from_millis(now.timestamp_millis() - 1_000);
        let channel = "channel-cancel";
        let session_id = ObjectId::new();
        seed_session(&fixture.database, channel, session_id, started, None).await?;
        let capture = StreamActivityCapture::new(fixture.database.clone());
        let input = sample_input(channel, "event-cancel", ActivityKind::Message, at, None);
        let collection = activities(&fixture.database);
        let filter = doc! {"channelID": channel};

        // A future dropped mid-flight may leave the server-side write pending or
        // complete, but it can never leave a second row. The deadline here
        // expires before the first write is issued; the retry below is the
        // replay, and it must converge on the deterministic receipt id.
        let cancelled = tokio::time::timeout(Duration::from_nanos(1), capture.capture_at(&input, now)).await;
        assert!(cancelled.is_err(), "the one-nanosecond deadline must expire");
        let mut settled = collection.count_documents(filter.clone()).await?;
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let next = collection.count_documents(filter.clone()).await?;
            if next == settled {
                break;
            }
            settled = next;
        }
        assert!(settled <= 1, "a cancelled capture leaves at most one row");
        if settled == 1 {
            let stored = collection.find_one(filter.clone()).await?.expect("cancelled write");
            for field in ["channelID", "session_id", "occurredAt", "kind", "expiresAt", "processed", "dashboardProcessed"] {
                assert!(stored.contains_key(field), "a landed write is complete: missing {field}");
            }
        }

        // Retrying the same receipt must converge on exactly one row.
        capture.capture_at(&input, now).await.expect("retry after cancellation");
        capture.capture_at(&input, now).await.expect("second retry");
        assert_eq!(
            collection.count_documents(filter.clone()).await?,
            1,
            "the deterministic receipt id prevents replay duplicates"
        );

        // A cancelled attempt at a different receipt must not duplicate the
        // first one either: the rows stay one per event id.
        let other = sample_input(channel, "event-cancel-2", ActivityKind::Message, at, None);
        let cancelled = tokio::time::timeout(Duration::from_nanos(1), capture.capture_at(&other, now)).await;
        assert!(cancelled.is_err());
        capture.capture_at(&other, now).await.expect("retry of the second receipt");
        assert_eq!(collection.count_documents(filter).await?, 2, "one row per event id");
        Ok(())
    })
    .await;
    let name = fixture.name.clone();
    fixture.drop_database().await;
    outcome.unwrap_or_else(|_| panic!("cancellation suite timed out in {name}"))
}
