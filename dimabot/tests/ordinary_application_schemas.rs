#![cfg(feature = "ordinary-application-schemas")]
//! Ordinary application schema contracts. Runtime is unverified until the parent
//! wires `ordinary-application-schemas` and runs these tests. This file does not
//! spawn Node. The ignored replay reads an external source oracle. The ignored
//! Mongo test uses only the explicit fixture URI, database, and owner.

use dima_rust::schemas::{
    Field, FieldDefault, FieldType, PersistenceError, SchemaDefinition, ValidationErrors,
    command_timer, eventsub, ordinary_model_values::Reader, site_analytics, temporary_moderator,
    title_config, trigger_file, vip,
};
use dima_rust::utils::{bson_compat::js_number, js_string::JsString, json_number::number_string};
use futures_util::{FutureExt, TryStreamExt};
use model_schema_source::sha256 as sha256_hex;
use mongodb::bson::{Bson, DateTime, Document, doc, oid::ObjectId};
use mongodb::error::{ErrorKind, WriteFailure};
use mongodb::{Client, Collection, Database, IndexModel, options::ClientOptions};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::panic::AssertUnwindSafe;

const NODE_PIN: &str = "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108";
const ZONES: [&str; 5] = [
    "UTC",
    "America/New_York",
    "Europe/Berlin",
    "Australia/Lord_Howe",
    "Pacific/Apia",
];
const INSTANTS: [i64; 8] = [
    1_900_000_000_000,
    1_704_067_200_000,
    1_706_745_600_000,
    1_710_054_000_000,
    1_711_846_800_000,
    1_712_415_600_000,
    1_325_239_200_000,
    1_704_067_199_999,
];
const NOW: i64 = 1_900_000_000_000;
const EARLIER: i64 = 1_700_000_000_000;
const ID: &str = "507f1f77bcf86cd799439011";
const ARTIFACT: &str = "ordinary-application-schemas-reference.json";

fn clock(millis: i64) -> DateTime {
    DateTime::from_millis(millis)
}

fn field<'a>(schema: &'a SchemaDefinition, name: &str) -> &'a Field {
    schema
        .fields
        .iter()
        .find(|field| field.name == name)
        .unwrap_or_else(|| panic!("missing {name}"))
}

fn object_field<'a>(parent: &'a Field, name: &str) -> &'a Field {
    let FieldType::Object(children) = &parent.kind else {
        panic!("{name} parent is not an object");
    };
    children
        .iter()
        .find(|field| field.name == name)
        .unwrap_or_else(|| panic!("missing {name}"))
}

fn assert_flags(schema: &SchemaDefinition) {
    assert!(!schema.string_id);
    assert!(schema.version_key);
    assert!(!schema.write_concern_journaled);
    assert!(schema.save_clock_field.is_none());
    assert!(
        schema
            .indexes
            .iter()
            .all(|index| { index.ttl.is_none() && index.partial.is_none() && !index.sparse })
    );
}

fn temp_input() -> Document {
    doc! {
        "channelID": "channel-id",
        "channel": "channel",
        "userID": "user",
        "username": "viewer",
        "durationDays": 3,
        "expireTimestamp": clock(NOW),
    }
}

fn vip_input() -> Document {
    doc! {
        "username": "viewer",
        "userID": "user",
        "channel": "channel",
        "channelID": "channel-id",
        "duration": 7,
        "expireDate": {"day": 3, "month": 2, "year": 2031},
        "expireTimestamp": clock(NOW),
    }
}

fn vip_calendar_input() -> Document {
    doc! {
        "username": "viewer",
        "userID": "user",
        "channel": "channel",
        "channelID": "channel-id",
        "duration": 1,
        "expireDate": {"day": 1, "month": 0, "year": 2030},
        "expireTimestamp": clock(NOW),
    }
}

fn trigger_input() -> Document {
    doc! {
        "name": "clip",
        "fileName": "clip.mp4",
        "fileSize": 12,
        "fileType": "video/mp4",
        "fileUrl": "https://example.invalid/clip.mp4",
        "channel": "channel",
        "channelID": "channel-id",
    }
}

fn trigger_calendar_input() -> Document {
    let mut input = trigger_input();
    input.insert("fileSize", 1);
    input
}

fn event_input() -> Document {
    doc! {
        "id": "sub-1",
        "status": "enabled",
        "type": "channel.follow",
        "version": "1",
        "condition": {"broadcaster_user_id": "broadcaster"},
        "created_at": "2030-03-17T17:46:40Z",
        "transport": {"method": "webhook", "callback": "https://example.invalid/hook"},
        "cost": 1,
        "channel": "channel",
        "channelID": "channel-id",
    }
}

fn nested_i32(document: &Document, parent: &str, child: &str) -> i32 {
    document
        .get_document(parent)
        .unwrap()
        .get_i32(child)
        .unwrap()
}

fn calendar_of(schema: &SchemaDefinition, input: &Document, instant: i64) -> (i32, i32, i32, i64) {
    let document = schema.construct(input, clock(instant)).expect("calendar");
    (
        nested_i32(&document, "date", "day"),
        nested_i32(&document, "date", "month"),
        nested_i32(&document, "date", "year"),
        document
            .get_datetime("createdAt")
            .unwrap()
            .timestamp_millis(),
    )
}

#[test]
fn declared_contracts() {
    assert!(std::ptr::eq(
        temporary_moderator::schema(),
        temporary_moderator::schema()
    ));
    for (model, collection, export_name, schema) in [
        (
            temporary_moderator::MODEL_NAME,
            temporary_moderator::COLLECTION_NAME,
            temporary_moderator::EXPORT_NAME,
            temporary_moderator::schema(),
        ),
        (
            vip::MODEL_NAME,
            vip::COLLECTION_NAME,
            vip::EXPORT_NAME,
            vip::schema(),
        ),
        (
            title_config::MODEL_NAME,
            title_config::COLLECTION_NAME,
            title_config::EXPORT_NAME,
            title_config::schema(),
        ),
        (
            trigger_file::MODEL_NAME,
            trigger_file::COLLECTION_NAME,
            trigger_file::EXPORT_NAME,
            trigger_file::schema(),
        ),
        (
            eventsub::MODEL_NAME,
            eventsub::COLLECTION_NAME,
            eventsub::EXPORT_NAME,
            eventsub::schema(),
        ),
        (
            site_analytics::MODEL_NAME,
            site_analytics::COLLECTION_NAME,
            site_analytics::EXPORT_NAME,
            site_analytics::schema(),
        ),
    ] {
        assert_eq!(schema.model, model);
        assert_eq!(schema.collection, collection);
        assert_flags(schema);
        assert!(!export_name.is_empty());
    }
    assert_eq!(temporary_moderator::COLLECTION_NAME, "temporary_moderators");
    assert_eq!(vip::COLLECTION_NAME, "vips");
    assert_eq!(title_config::MODEL_NAME, "titleConfig");
    assert_eq!(title_config::COLLECTION_NAME, "titleconfigs");
    assert_eq!(trigger_file::MODEL_NAME, "TriggerFile");
    assert_eq!(trigger_file::COLLECTION_NAME, "triggerfiles");
    assert_eq!(eventsub::COLLECTION_NAME, "eventsubs");
    assert_eq!(eventsub::EXPORT_NAME, "default");
    assert_eq!(site_analytics::COLLECTION_NAME, "site_analytics");

    let moderators = temporary_moderator::schema();
    assert_eq!(moderators.indexes.len(), 4);
    assert_eq!(moderators.indexes[0].keys, doc! {"channelID": 1});
    assert_eq!(moderators.indexes[1].keys, doc! {"userID": 1});
    assert_eq!(moderators.indexes[2].keys, doc! {"expireTimestamp": 1});
    assert_eq!(
        moderators.indexes[3].keys,
        doc! {"channelID": 1, "userID": 1}
    );
    assert!(moderators.indexes[3].unique);
    assert!(moderators.indexes.iter().take(3).all(|index| !index.unique));
    assert!(moderators.timestamps.is_none());
    assert!(vip::schema().indexes.is_empty());
    assert!(title_config::schema().indexes.is_empty());
    assert!(trigger_file::schema().indexes.is_empty());
    assert_eq!(eventsub::schema().indexes.len(), 2);
    assert!(!eventsub::schema().indexes[0].unique);
    assert_eq!(
        eventsub::schema().indexes[0].keys,
        doc! {"channelID": 1, "type": 1}
    );
    assert_eq!(eventsub::schema().indexes[1].keys, doc! {"id": 1});
    assert_eq!(site_analytics::schema().indexes.len(), 1);
    assert!(site_analytics::schema().indexes[0].unique);
    assert_eq!(
        site_analytics::schema().indexes[0].keys,
        doc! {"singletonKey": 1}
    );
    assert_eq!(
        site_analytics::schema().timestamps,
        Some(("created_at", "updated_at"))
    );
    assert!(matches!(
        field(temporary_moderator::schema(), "createdAt").default,
        FieldDefault::Now
    ));
    assert!(matches!(
        field(eventsub::schema(), "remote_missing_since").default,
        FieldDefault::Null
    ));
    assert!(field(eventsub::schema(), "condition").minimize);
    assert!(field(eventsub::schema(), "transport").minimize);
    assert!(field(eventsub::schema(), "cheerTiers").minimize);
    assert!(field(eventsub::schema(), "condition").required);
    assert!(matches!(
        field(eventsub::schema(), "created_at").kind,
        FieldType::String
    ));

    let channels = field(site_analytics::schema(), "liveChannels");
    let FieldType::Array(element) = &channels.kind else {
        panic!("liveChannels is an array");
    };
    let FieldType::Subdocument {
        generate_id,
        fields,
    } = element.as_ref()
    else {
        panic!("liveChannels element is a subdocument");
    };
    assert!(!generate_id);
    assert!(fields.iter().all(|field| field.name != "_id"));
    let platforms = fields
        .iter()
        .find(|field| field.name == "botPlatforms")
        .unwrap();
    let FieldType::ArrayElement(platform) = &platforms.kind else {
        panic!("botPlatforms is an array element");
    };
    assert_eq!(platform.enum_values, ["twitch", "kick"]);
    let plan = fields
        .iter()
        .find(|field| field.name == "planTier")
        .unwrap();
    assert_eq!(plan.enum_values, ["free", "premium", "pro"]);
    assert!(matches!(plan.default, FieldDefault::String("free")));
}

#[test]
fn month_conventions_follow_source_and_keep_local_month() {
    const { assert!(cfg!(unix), "libc local calendar is required") };
    assert!(matches!(
        object_field(field(vip::schema(), "date"), "month").default,
        FieldDefault::LocalMonthZero
    ));
    assert!(matches!(
        object_field(field(trigger_file::schema(), "date"), "month").default,
        FieldDefault::LocalMonth
    ));
    assert!(matches!(
        object_field(field(command_timer::schema(), "date"), "month").default,
        FieldDefault::LocalMonth
    ));
    let vip_input = vip_calendar_input();
    let trigger_input = trigger_calendar_input();
    for instant in INSTANTS {
        let vip_date = calendar_of(vip::schema(), &vip_input, instant);
        let trigger_date = calendar_of(trigger_file::schema(), &trigger_input, instant);
        assert_eq!(trigger_date.1, vip_date.1 + 1, "{instant}");
        assert_eq!(trigger_date.0, vip_date.0, "{instant}");
        assert_eq!(trigger_date.2, vip_date.2, "{instant}");
        assert_eq!(vip_date.3, instant);
        assert_eq!(trigger_date.3, instant);
        assert!((0..=11).contains(&vip_date.1), "{instant}");
        assert!((1..=12).contains(&trigger_date.1), "{instant}");
        assert!((1..=31).contains(&vip_date.0), "{instant}");
    }
    let january = calendar_of(vip::schema(), &vip_input, 1_704_067_200_000);
    let february = calendar_of(vip::schema(), &vip_input, 1_706_745_600_000);
    assert_ne!(
        (january.0, january.1, january.2),
        (february.0, february.1, february.2)
    );
}

#[test]
fn defaults_are_per_construction_and_site_timestamps_are_save_hooks() {
    let now = clock(NOW);
    let later = clock(NOW + 86_400_000);
    let earlier = clock(EARLIER);
    let mut first = eventsub::schema().construct(&event_input(), now).unwrap();
    let second = eventsub::schema().construct(&event_input(), now).unwrap();
    first
        .get_array_mut("cheerTiers")
        .unwrap()
        .push(Bson::Document(doc! {"id": "x"}));
    assert_eq!(first.get_array("cheerTiers").unwrap().len(), 1);
    assert!(second.get_array("cheerTiers").unwrap().is_empty());

    let mut site_a = site_analytics::schema()
        .construct(&Document::new(), now)
        .unwrap();
    let site_b = site_analytics::schema()
        .construct(&Document::new(), now)
        .unwrap();
    site_a
        .get_array_mut("liveChannels")
        .unwrap()
        .push(Bson::Document(doc! {"channelID": "x"}));
    assert!(site_b.get_array("liveChannels").unwrap().is_empty());
    assert!(site_a.get("created_at").is_none());
    assert!(site_a.get("updated_at").is_none());
    assert!(site_a.get("__v").is_none());

    let inserted = site_analytics::schema()
        .prepare_insert(Document::new(), now)
        .unwrap();
    assert_eq!(inserted.get_datetime("created_at").unwrap(), &now);
    assert_eq!(inserted.get_datetime("updated_at").unwrap(), &now);
    assert_eq!(inserted.get_i32("__v").unwrap(), 0);
    let mut saved_input = inserted.clone();
    saved_input.remove("__v");
    saved_input.insert("registeredUsers", 4);
    let saved = site_analytics::schema()
        .prepare_save(saved_input, later)
        .unwrap();
    assert!(saved.get("__v").is_none());
    assert_eq!(saved.get_datetime("created_at").unwrap(), &now);
    assert_eq!(saved.get_datetime("updated_at").unwrap(), &later);

    let explicit = site_analytics::schema()
        .prepare_insert(doc! {"created_at": earlier}, now)
        .unwrap();
    assert_eq!(explicit.get_datetime("created_at").unwrap(), &earlier);
    assert_eq!(explicit.get_datetime("updated_at").unwrap(), &earlier);
    let replaced = site_analytics::schema()
        .prepare_insert(doc! {"created_at": Bson::Null}, now)
        .unwrap();
    assert_eq!(replaced.get_datetime("created_at").unwrap(), &now);
    assert_eq!(replaced.get_datetime("updated_at").unwrap(), &now);

    let vip_document = vip::schema().construct(&vip_input(), now).unwrap();
    assert_eq!(vip_document.get_datetime("createdAt").unwrap(), &now);
    assert!(vip_document.get("__v").is_none());
    let vip_insert = vip::schema().prepare_insert(vip_input(), now).unwrap();
    assert_eq!(vip_insert.get_i32("__v").unwrap(), 0);
    let mut vip_save_input = vip_insert.clone();
    vip_save_input.remove("__v");
    let vip_save = vip::schema().prepare_save(vip_save_input, later).unwrap();
    assert!(vip_save.get("__v").is_none());
    assert_eq!(vip_save.get_datetime("createdAt").unwrap(), &now);
}

#[test]
fn strict_views_reject_incomplete_values_without_dropping_raw_bson() {
    let now = clock(NOW);
    let mut empty = event_input();
    empty.insert("condition", doc! {});
    empty.insert("transport", doc! {});
    let document = eventsub::schema().construct(&empty, now).unwrap();
    assert!(document.get("condition").is_none());
    assert!(document.get("transport").is_none());
    let error = eventsub::IEventsub::from_document(&document).unwrap_err();
    assert_eq!((error.path.as_str(), error.kind), ("condition", "required"));

    let mut extra = event_input();
    extra.insert(
        "condition",
        doc! {"broadcaster_user_id": "broadcaster", "extra": "kept", "empty": {}},
    );
    let document = eventsub::schema().construct(&extra, now).unwrap();
    let condition = document.get_document("condition").unwrap();
    assert_eq!(condition.get_str("extra").unwrap(), "kept");
    assert!(condition.get("empty").is_none());
    let view = eventsub::condition_view(&Bson::Document(condition.clone())).unwrap();
    assert_eq!(
        view.broadcaster_user_id.unwrap().as_str(),
        Some("broadcaster")
    );

    let mut cheer = event_input();
    cheer.insert("cheerTiers", vec![Bson::Document(Document::new())]);
    let document = eventsub::schema().construct(&cheer, now).unwrap();
    assert_eq!(document.get_array("cheerTiers").unwrap().len(), 1);
    assert!(eventsub::cheer_tiers_view(document.get("cheerTiers").unwrap()).is_err());

    let mut transport = event_input();
    transport.insert("transport", doc! {"method": "webhook"});
    let document = eventsub::schema().construct(&transport, now).unwrap();
    assert!(eventsub::IEventsub::from_document(&document).is_err());

    let with_null = eventsub::schema().construct(&event_input(), now).unwrap();
    let parsed = eventsub::IEventsub::from_document(&with_null).unwrap();
    assert_eq!(parsed.remote_missing_since, Some(None));
    let mut removed = with_null.clone();
    removed.remove("remote_missing_since");
    assert_eq!(
        eventsub::IEventsub::from_document(&removed)
            .unwrap()
            .remote_missing_since,
        None
    );

    let raw = doc! {
        "channelID": "channel-id",
        "channel": "channel",
        "viewers": 1,
        "botPlatforms": ["twitch"],
        "planTier": "free",
        "streamId": Bson::Null,
    };
    let error = site_analytics::ILiveChannel::from_reader(&Reader::new(&raw)).unwrap_err();
    assert_eq!((error.path.as_str(), error.kind), ("streamId", "null"));
    let mut missing = raw.clone();
    missing.remove("streamId");
    assert!(
        site_analytics::ILiveChannel::from_reader(&Reader::new(&missing))
            .unwrap()
            .stream_id
            .is_none()
    );
    let constructed = site_analytics::schema()
        .construct(&doc! {"liveChannels": [doc! {}]}, now)
        .unwrap();
    let channel = constructed.get_array("liveChannels").unwrap()[0]
        .as_document()
        .unwrap();
    assert!(channel.get("_id").is_none());
    assert_eq!(channel.get_str("streamId").unwrap(), "");
    assert_eq!(
        site_analytics::ILiveChannel::from_reader(&Reader::with_prefix(channel, "liveChannels.0"))
            .unwrap()
            .stream_id
            .unwrap()
            .as_str(),
        Some("")
    );

    let id = ObjectId::parse_str(ID).unwrap();
    let mut title =
        doc! {"_id": id, "channelID": "channel-id", "channel": "channel", "active": true};
    title.insert("pretitle", Bson::Null);
    let error = title_config::ITitleConfig::from_document(&title).unwrap_err();
    assert_eq!((error.path.as_str(), error.kind), ("pretitle", "null"));
    title.remove("pretitle");
    assert!(
        title_config::ITitleConfig::from_document(&title)
            .unwrap()
            .pretitle
            .is_none()
    );
}

#[test]
fn casts_numbers_booleans_enums_and_replaces_lone_surrogates() {
    let now = clock(NOW);
    let mut days = temp_input();
    days.insert("durationDays", "");
    let error = temporary_moderator::schema()
        .construct(&days, now)
        .unwrap_err();
    assert!(
        error
            .0
            .iter()
            .any(|item| item.path == "durationDays" && item.kind == "required")
    );
    let mut blank = doc! {"channelID": "", "channel": "channel"};
    let error = title_config::schema().construct(&blank, now).unwrap_err();
    assert!(
        error
            .0
            .iter()
            .any(|item| item.path == "channelID" && item.kind == "required")
    );
    blank.insert("channelID", "channel-id");
    blank.insert("active", "yes");
    assert!(
        title_config::schema()
            .construct(&blank, now)
            .unwrap()
            .get_bool("active")
            .unwrap()
    );

    let mut yes = vip_input();
    yes.insert("vip", "yes");
    yes.insert("duration", "3");
    let document = vip::schema().construct(&yes, now).unwrap();
    assert!(document.get_bool("vip").unwrap());
    assert_eq!(document.get_i32("duration").unwrap(), 3);

    let mut absent_id = temp_input();
    absent_id.insert("_id", Bson::Null);
    let document = temporary_moderator::schema()
        .construct(&absent_id, now)
        .unwrap();
    assert_eq!(document.get("_id"), Some(&Bson::Null));
    let mut null_date = vip_input();
    null_date.insert("date", Bson::Null);
    let document = vip::schema().construct(&null_date, now).unwrap();
    assert_eq!(document.get("date"), Some(&Bson::Null));
    assert!(document.get_document("expireDate").is_ok());
    let document = site_analytics::schema()
        .construct(&doc! {"liveChannels": Bson::Null}, now)
        .unwrap();
    assert_eq!(document.get("liveChannels"), Some(&Bson::Null));

    let wrapped = site_analytics::schema()
        .construct(
            &doc! {"liveChannels": [doc! {"botPlatforms": "twitch", "viewers": "4", "planTier": "premium"}]},
            now,
        )
        .unwrap();
    let channel = wrapped.get_array("liveChannels").unwrap()[0]
        .as_document()
        .unwrap();
    assert_eq!(
        channel.get_array("botPlatforms").unwrap(),
        &vec![Bson::String("twitch".into())]
    );
    assert_eq!(channel.get_str("planTier").unwrap(), "premium");
    let youtube = site_analytics::schema().construct(
        &doc! {"liveChannels": [doc! {"botPlatforms": ["youtube"]}]},
        now,
    );
    assert!(
        youtube
            .unwrap_err()
            .0
            .iter()
            .any(|item| { item.path == "liveChannels.0.botPlatforms.0" && item.kind == "enum" })
    );
    let diamond = site_analytics::schema()
        .construct(&doc! {"liveChannels": [doc! {"planTier": "diamond"}]}, now);
    assert!(
        diamond
            .unwrap_err()
            .0
            .iter()
            .any(|item| { item.path == "liveChannels.0.planTier" && item.kind == "enum" })
    );

    for (value, expected) in [
        (Bson::Int32(2_147_483_647), Bson::Int32(2_147_483_647)),
        (Bson::Double(2_147_483_648.0), Bson::Double(2_147_483_648.0)),
        (Bson::Double(1.5), Bson::Double(1.5)),
        (Bson::Double(-0.0), Bson::Double(-0.0)),
        (Bson::String("12".into()), Bson::Int32(12)),
    ] {
        let mut input = trigger_input();
        input.insert("fileSize", value);
        let document = trigger_file::schema().construct(&input, now).unwrap();
        let actual = document.get("fileSize").unwrap();
        match (&expected, actual) {
            (Bson::Double(left), Bson::Double(right)) if *left == 0.0 => {
                assert!(right.is_sign_negative() && *right == 0.0);
            }
            _ => assert_eq!(actual, &expected),
        }
    }

    let surrogate = JsString::from_units(vec![0xD800, u16::from(b'x'), 0xDC00]);
    assert!(surrogate.as_str().is_none());
    let moderator = temporary_moderator::ITemporaryModerator {
        id: ObjectId::parse_str(ID).unwrap(),
        channel_id: JsString::from("channel-id"),
        channel: JsString::from("channel"),
        user_id: JsString::from("user"),
        username: surrogate,
        duration_days: 3.0,
        expire_timestamp: now,
        created_at: now,
    };
    assert_eq!(
        moderator.to_document().get_str("username").unwrap(),
        "\u{FFFD}x\u{FFFD}"
    );
}

fn definition(model: &str) -> &'static SchemaDefinition {
    match model {
        temporary_moderator::MODEL_NAME => temporary_moderator::schema(),
        vip::MODEL_NAME => vip::schema(),
        title_config::MODEL_NAME => title_config::schema(),
        trigger_file::MODEL_NAME => trigger_file::schema(),
        eventsub::MODEL_NAME => eventsub::schema(),
        site_analytics::MODEL_NAME => site_analytics::schema(),
        other => panic!("unknown model {other}"),
    }
}

fn sentinel(map: &Map<String, Value>) -> Option<Bson> {
    if map.len() != 1 {
        return None;
    }
    let (key, value) = map.iter().next().unwrap();
    match (key.as_str(), value) {
        ("$oid", Value::String(hex)) => Some(Bson::ObjectId(ObjectId::parse_str(hex).unwrap())),
        ("$date", Value::Number(millis)) => Some(Bson::DateTime(clock(millis.as_i64().unwrap()))),
        ("$double", Value::String(text)) if text == "-0" => Some(Bson::Double(-0.0)),
        ("$double", Value::Number(number)) => Some(Bson::Double(number.as_f64().unwrap())),
        _ => None,
    }
}

fn expand_bson(value: &Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(value) => Bson::Boolean(*value),
        Value::Number(value) => js_number(value.as_f64().expect("finite")),
        Value::String(value) => Bson::String(value.clone()),
        Value::Array(values) => Bson::Array(values.iter().map(expand_bson).collect()),
        Value::Object(map) => {
            if let Some(value) = sentinel(map) {
                return value;
            }
            let mut document = Document::new();
            for (key, value) in map {
                document.insert(key, expand_bson(value));
            }
            Bson::Document(document)
        }
    }
}

fn presence(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(presence).collect()),
        Value::Object(map) if sentinel(map).is_some() => Value::Bool(true),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), presence(value)))
                .collect(),
        ),
        _ => Value::Bool(true),
    }
}

fn normalize(value: &Bson, present: Option<&Value>) -> Value {
    match value {
        Bson::DateTime(time) => json!({"$date": time.timestamp_millis()}),
        Bson::ObjectId(id) => {
            if present.is_none() {
                json!({"$oid": "generated"})
            } else {
                json!({"$oid": id.to_hex()})
            }
        }
        Bson::Double(number) if *number == 0.0 && number.is_sign_negative() => {
            json!({"$double": "-0"})
        }
        Bson::Double(number) => json!(*number),
        Bson::Int32(number) => json!(number),
        Bson::Int64(number) => json!(number),
        Bson::String(text) => json!(text),
        Bson::Boolean(value) => json!(*value),
        Bson::Null => Value::Null,
        Bson::Array(values) => {
            let items = present.and_then(Value::as_array);
            Value::Array(
                values
                    .iter()
                    .enumerate()
                    .map(|(index, value)| {
                        normalize(value, items.and_then(|items| items.get(index)))
                    })
                    .collect(),
            )
        }
        Bson::Document(document) => {
            let fields = present.and_then(Value::as_object);
            let mut map = Map::new();
            for (key, value) in document {
                map.insert(
                    key.clone(),
                    normalize(value, fields.and_then(|fields| fields.get(key))),
                );
            }
            Value::Object(map)
        }
        other => panic!("unexpected bson {other:?}"),
    }
}

fn canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&number_string(number.as_f64().unwrap())),
        Value::String(text) => out.push_str(&serde_json::to_string(text).unwrap()),
        Value::Array(values) => {
            out.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    out.push(',');
                }
                canonical(value, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            let mut entries = map.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index != 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap());
                out.push(':');
                canonical(value, out);
            }
            out.push('}');
        }
    }
}

fn canonical_string(value: &Value) -> String {
    let mut out = String::new();
    canonical(value, &mut out);
    out
}

fn record_types(value: &Bson, path: &str, out: &mut BTreeMap<String, String>) {
    let kind = match value {
        Bson::Int32(_) => Some("Int32"),
        Bson::Int64(_) => Some("Long"),
        Bson::Double(_) => Some("Double"),
        Bson::ObjectId(_) => Some("ObjectId"),
        Bson::Document(document) => {
            for (key, child) in document {
                let next = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                record_types(child, &next, out);
            }
            None
        }
        Bson::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                let next = if path.is_empty() {
                    index.to_string()
                } else {
                    format!("{path}.{index}")
                };
                record_types(child, &next, out);
            }
            None
        }
        _ => None,
    };
    if let Some(kind) = kind {
        out.insert(path.to_owned(), kind.to_owned());
    }
}

fn error_key(path: &str, kind: &str) -> Vec<u8> {
    let mut key = path.as_bytes().to_vec();
    key.push(0);
    key.extend_from_slice(kind.as_bytes());
    key
}

fn sorted_actual(errors: &ValidationErrors) -> Vec<(String, String)> {
    let mut rows: Vec<_> = errors
        .0
        .iter()
        .map(|error| (error.path.clone(), error.kind.to_owned()))
        .collect();
    rows.sort_by_key(|row| error_key(&row.0, &row.1));
    rows
}

fn sorted_expected(errors: &Value) -> Vec<(String, String)> {
    let mut rows: Vec<_> = errors
        .as_array()
        .unwrap()
        .iter()
        .map(|error| {
            (
                error["path"].as_str().unwrap().to_owned(),
                error["kind"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    rows.sort_by_key(|row| error_key(&row.0, &row.1));
    rows
}

fn external_dir(env_name: &str) -> std::path::PathBuf {
    let raw = std::env::var_os(env_name).unwrap_or_else(|| panic!("{env_name}"));
    let requested = std::path::PathBuf::from(&raw);
    assert!(requested.is_absolute(), "{env_name} must be absolute");
    let dir = requested.canonicalize().unwrap();
    assert_eq!(dir, requested, "{env_name} must already be a real path");
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    let workspace = source.parent().unwrap().to_path_buf();
    assert!(!dir.starts_with(&source) && dir != source);
    assert!(!dir.starts_with(&workspace) && dir != workspace);
    dir
}

fn manifest_bytes(relative: &str) -> Vec<u8> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative))
        .unwrap_or_else(|error| panic!("{relative}: {error}"))
}

fn repo_bytes() -> Vec<(&'static str, &'static [u8])> {
    vec![
        (
            "src/schemas/schema.rs",
            include_bytes!("../src/schemas/schema.rs"),
        ),
        (
            "src/schemas/ordinary_model_values.rs",
            include_bytes!("../src/schemas/ordinary_model_values.rs"),
        ),
        (
            "src/schemas/temporary_moderator.schema.rs",
            include_bytes!("../src/schemas/temporary_moderator.schema.rs"),
        ),
        (
            "src/schemas/vip.schema.rs",
            include_bytes!("../src/schemas/vip.schema.rs"),
        ),
        (
            "src/schemas/title_config.schema.rs",
            include_bytes!("../src/schemas/title_config.schema.rs"),
        ),
        (
            "src/schemas/trigger_file.schema.rs",
            include_bytes!("../src/schemas/trigger_file.schema.rs"),
        ),
        (
            "src/schemas/eventsub.schema.rs",
            include_bytes!("../src/schemas/eventsub.schema.rs"),
        ),
        (
            "src/schemas/site_analytics.schema.rs",
            include_bytes!("../src/schemas/site_analytics.schema.rs"),
        ),
        (
            "src/schemas/mod.rs",
            include_bytes!("../src/schemas/mod.rs"),
        ),
        ("src/lib.rs", include_bytes!("../src/lib.rs")),
        (
            "src/utils/js_string.rs",
            include_bytes!("../src/utils/js_string.rs"),
        ),
        (
            "src/utils/bson_compat.rs",
            include_bytes!("../src/utils/bson_compat.rs"),
        ),
        (
            "src/utils/mongoose_date.rs",
            include_bytes!("../src/utils/mongoose_date.rs"),
        ),
        (
            "src/utils/json_number.rs",
            include_bytes!("../src/utils/json_number.rs"),
        ),
        (
            "tests/ordinary_application_schemas.rs",
            include_bytes!("ordinary_application_schemas.rs"),
        ),
        (
            "tests/support/model_schema_source.rs",
            include_bytes!("support/model_schema_source.rs"),
        ),
        (
            "tests/fixtures/model_schema_source.cjs",
            include_bytes!("fixtures/model_schema_source.cjs"),
        ),
        (
            "tests/fixtures/ordinary_application_schemas_reference.cjs",
            include_bytes!("fixtures/ordinary_application_schemas_reference.cjs"),
        ),
        ("Cargo.toml", include_bytes!("../Cargo.toml")),
        ("Cargo.lock", include_bytes!("../Cargo.lock")),
        (
            "rust-toolchain.toml",
            include_bytes!("../rust-toolchain.toml"),
        ),
    ]
}

fn package_files() -> [&'static str; 9] {
    [
        "package.json",
        "package-lock.json",
        "node_modules/mongoose/package.json",
        "node_modules/mongoose/lib/helpers/pluralize.js",
        "node_modules/mongoose/lib/utils.js",
        "node_modules/mongoose/lib/helpers/schema/getIndexes.js",
        "node_modules/mongoose/lib/helpers/timestamps/setDocumentTimestamps.js",
        "node_modules/bson/package.json",
        "node_modules/typescript/package.json",
    ]
}

#[path = "support/model_schema_source.rs"]
mod model_schema_source;

fn assert_hashes(fixture: &Value) {
    let hashes = fixture["sourceSha256"].as_object().unwrap();
    let mut expected = BTreeSet::new();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for (path, _) in model_schema_source::PINS.iter().take(6) {
        assert_eq!(
            hashes[*path].as_str().unwrap(),
            model_schema_source::sha256(&model_schema_source::archived(root, path)),
            "{path}"
        );
        assert_eq!(
            fixture["sourceProvenance"][*path],
            model_schema_source::provenance(path)
        );
        expected.insert((*path).to_owned());
    }
    for (path, bytes) in repo_bytes() {
        assert_eq!(hashes[path].as_str().unwrap(), sha256_hex(bytes), "{path}");
        expected.insert(path.to_owned());
    }
    for path in package_files() {
        assert_eq!(
            hashes[path].as_str().unwrap(),
            sha256_hex(&manifest_bytes(path)),
            "{path}"
        );
        expected.insert(path.to_owned());
    }
    let actual: BTreeSet<_> = hashes.keys().cloned().collect();
    assert_eq!(actual, expected);
    let compiled = fixture["compiledSha256"].as_object().unwrap();
    let compiled_keys: BTreeSet<_> = compiled.keys().cloned().collect();
    assert_eq!(
        compiled_keys,
        BTreeSet::from([
            "src/schemas/temporary_moderator.schema.ts".to_owned(),
            "src/schemas/vip.schema.ts".to_owned(),
            "src/schemas/title_config.schema.ts".to_owned(),
            "src/schemas/trigger_file.schema.ts".to_owned(),
            "src/schemas/eventsub.schema.ts".to_owned(),
            "src/schemas/site_analytics.schema.ts".to_owned(),
        ])
    );
}

fn number_i64(value: &Value) -> i64 {
    value
        .as_i64()
        .unwrap_or_else(|| value.as_f64().unwrap() as i64)
}

fn replay_case(case: &Value) {
    let model = case["model"].as_str().unwrap();
    let operation = case["operation"].as_str().unwrap();
    let now = clock(number_i64(&case["now"]));
    let present = presence(&case["input"]);
    let Bson::Document(input) = expand_bson(&case["input"]) else {
        panic!("{model} input is not a document");
    };
    let schema = definition(model);
    let result = match operation {
        "construct" => schema.construct(&input, now),
        "insert" => schema.prepare_insert(input, now),
        "save" => schema.prepare_save(input, now),
        other => panic!("unknown operation {other}"),
    };
    let label = format!("{model} {operation}");
    let expected = &case["expected"];
    if let Some(thrown) = expected.get("thrown") {
        let native = match &result {
            Ok(document) => canonical_string(&normalize(
                &Bson::Document(document.clone()),
                Some(&present),
            )),
            Err(errors) => format!("{:?}", sorted_actual(errors)),
        };
        panic!("{label} source construction threw {thrown}; native {native}");
    }
    if expected.get("errors").is_some() {
        let errors = result.unwrap_err();
        assert_eq!(
            sorted_actual(&errors),
            sorted_expected(&expected["errors"]),
            "{label}"
        );
        return;
    }
    let document = result.unwrap_or_else(|errors| panic!("{label} native errors {errors:?}"));
    let actual = normalize(&Bson::Document(document.clone()), Some(&present));
    assert_eq!(
        canonical_string(&actual),
        canonical_string(&expected["document"]),
        "{label}"
    );
    let mut types = BTreeMap::new();
    record_types(&Bson::Document(document), "", &mut types);
    let expected_types: BTreeMap<_, _> = expected["types"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned()))
        .collect();
    assert_eq!(types, expected_types, "{label}");
}

fn assert_index_metadata(fixture: &Value) {
    for (model, schema) in [
        (
            temporary_moderator::MODEL_NAME,
            temporary_moderator::schema(),
        ),
        (vip::MODEL_NAME, vip::schema()),
        (title_config::MODEL_NAME, title_config::schema()),
        (trigger_file::MODEL_NAME, trigger_file::schema()),
        (eventsub::MODEL_NAME, eventsub::schema()),
        (site_analytics::MODEL_NAME, site_analytics::schema()),
    ] {
        let indexes = fixture["indexes"][model].as_array().unwrap();
        assert_eq!(indexes.len(), schema.indexes.len(), "{model}");
        for (expected, actual) in indexes.iter().zip(&schema.indexes) {
            assert_eq!(
                expected
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(String::as_str)
                    .collect::<BTreeSet<_>>(),
                BTreeSet::from(["keys", "keyOrder", "unique", "sparse", "ttl", "partial"])
            );
            assert!(expected["ttl"].is_null());
            assert!(expected["partial"].is_null());
            assert_eq!(expected["unique"].as_bool().unwrap(), actual.unique);
            assert_eq!(expected["sparse"].as_bool().unwrap(), actual.sparse);
            assert!(actual.ttl.is_none());
            let order: Vec<_> = expected["keyOrder"]
                .as_array()
                .unwrap()
                .iter()
                .map(|key| key.as_str().unwrap())
                .collect::<Vec<_>>();
            let actual_order: Vec<&str> = actual.keys.keys().map(String::as_str).collect();
            assert_eq!(actual_order, order);
            let Bson::Document(keys) = expand_bson(&expected["keys"]) else {
                panic!("index keys");
            };
            assert_eq!(keys, actual.keys);
        }
    }
}

#[test]
#[ignore = "external source oracle fixture required"]
fn replay_ordinary_application_schemas() {
    const { assert!(cfg!(unix), "libc local calendar is required") };
    let dir = external_dir("DIMA_ORDINARY_SCHEMAS_FIXTURE_DIR");
    let mut names: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, vec![ARTIFACT.to_owned()]);
    let bytes = std::fs::read(dir.join(ARTIFACT)).unwrap();
    assert_eq!(
        sha256_hex(&bytes),
        std::env::var("DIMA_ORDINARY_SCHEMAS_FIXTURE_SHA256").expect("fixture sha")
    );
    let fixture: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(fixture["format"], 1);
    assert_eq!(fixture["nodeExecutableSha256"], NODE_PIN);
    assert_eq!(fixture["versions"]["node"], "24.22.1");
    assert_eq!(fixture["versions"]["v8"], "13.6.233.17-node.58");
    assert_eq!(fixture["versions"]["icu"], "78.3");
    assert_eq!(fixture["versions"]["unicode"], "17.0");
    assert_eq!(fixture["versions"]["typescript"], "5.9.3");
    assert_eq!(fixture["versions"]["mongoose"], "8.24.2");
    assert_eq!(fixture["versions"]["bson"], "6.10.4");
    assert_eq!(fixture["arrayIndependent"], true);
    assert_hashes(&fixture);
    let zones: Vec<_> = fixture["zones"]
        .as_array()
        .unwrap()
        .iter()
        .map(|zone| zone.as_str().unwrap())
        .collect();
    assert_eq!(zones, ZONES);
    let instants: Vec<_> = fixture["instants"]
        .as_array()
        .unwrap()
        .iter()
        .map(number_i64)
        .collect::<Vec<_>>();
    assert_eq!(instants, INSTANTS);
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let vip_excerpt = "month: { type: Number, default: () => new Date().getMonth() }";
    let trigger_excerpt = "month: { type: Number, default: () => new Date().getMonth() + 1 }";
    assert_eq!(fixture["monthExcerpts"]["vip"], vip_excerpt);
    assert_eq!(fixture["monthExcerpts"]["TriggerFile"], trigger_excerpt);
    assert!(
        String::from_utf8(model_schema_source::archived(
            root,
            "src/schemas/vip.schema.ts"
        ))
        .unwrap()
        .contains(vip_excerpt)
    );
    assert!(
        String::from_utf8(model_schema_source::archived(
            root,
            "src/schemas/trigger_file.schema.ts"
        ))
        .unwrap()
        .contains(trigger_excerpt)
    );
    let vip_default = fixture["monthDefaults"]["vip"].as_str().unwrap();
    let trigger_default = fixture["monthDefaults"]["TriggerFile"].as_str().unwrap();
    assert!(vip_default.contains("getMonth()"));
    assert!(!vip_default.contains("+ 1") && !vip_default.contains("+1"));
    assert!(trigger_default.contains("getMonth() + 1"));
    for (model, collection, export_name) in [
        (
            temporary_moderator::MODEL_NAME,
            temporary_moderator::COLLECTION_NAME,
            temporary_moderator::EXPORT_NAME,
        ),
        (vip::MODEL_NAME, vip::COLLECTION_NAME, vip::EXPORT_NAME),
        (
            title_config::MODEL_NAME,
            title_config::COLLECTION_NAME,
            title_config::EXPORT_NAME,
        ),
        (
            trigger_file::MODEL_NAME,
            trigger_file::COLLECTION_NAME,
            trigger_file::EXPORT_NAME,
        ),
        (
            eventsub::MODEL_NAME,
            eventsub::COLLECTION_NAME,
            eventsub::EXPORT_NAME,
        ),
        (
            site_analytics::MODEL_NAME,
            site_analytics::COLLECTION_NAME,
            site_analytics::EXPORT_NAME,
        ),
    ] {
        assert_eq!(fixture["models"][model], model);
        assert_eq!(fixture["collections"][model], collection);
        let exports: Vec<_> = fixture["exports"][model]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        assert!(exports.contains(&export_name), "{model}");
        let imports = fixture["typeEvidence"][model]["imports"]
            .as_array()
            .unwrap();
        assert!(imports.iter().all(|item| item["module"] == "mongoose"));
    }
    for name in [
        "ITemporaryModerator",
        "IVip",
        "ITitleConfig",
        "ITriggerFile",
        "ICondition",
        "ITransport",
        "ICheerTiers",
        "IEventsub",
        "ILiveChannel",
        "ISiteAnalytics",
    ] {
        let found = [
            "temporary_moderator",
            "vip",
            "titleConfig",
            "TriggerFile",
            "eventsub",
            "site_analytics",
        ]
        .iter()
        .any(|model| {
            fixture["exports"][*model]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item.as_str() == Some(name))
        });
        assert!(found, "{name}");
    }
    assert_eq!(
        fixture["timestamps"]["site_analytics"]["createdAt"],
        "created_at"
    );
    assert_eq!(
        fixture["timestamps"]["site_analytics"]["updatedAt"],
        "updated_at"
    );
    for model in [
        "temporary_moderator",
        "vip",
        "titleConfig",
        "TriggerFile",
        "eventsub",
    ] {
        assert_eq!(fixture["timestamps"][model], false);
    }
    assert_eq!(
        fixture["paths"]["temporary_moderator"]["channelID"]["required"],
        true
    );
    assert_eq!(
        fixture["paths"]["temporary_moderator"]["channelID"]["index"],
        true
    );
    assert_eq!(
        fixture["paths"]["temporary_moderator"]["expireTimestamp"]["index"],
        true
    );
    assert_eq!(fixture["paths"]["vip"]["date.month"]["hasDefault"], true);
    assert_eq!(
        fixture["paths"]["TriggerFile"]["date.month"]["hasDefault"],
        true
    );
    assert_eq!(
        fixture["paths"]["site_analytics"]["singletonKey"]["unique"],
        true
    );
    assert_eq!(
        fixture["paths"]["site_analytics"]["liveChannels"]["instance"],
        "Array"
    );
    assert_eq!(
        fixture["paths"]["eventsub"]["condition"]["instance"],
        "Mixed"
    );
    assert_eq!(
        fixture["paths"]["eventsub"]["created_at"]["instance"],
        "String"
    );
    assert_index_metadata(&fixture);
    let text = JsString::from_units(vec![0xD800, u16::from(b'x'), 0xDC00]);
    assert!(text.as_str().is_none());
    assert_eq!(
        text.to_utf8_lossy(),
        fixture["wire"]["text"].as_str().unwrap()
    );
    assert_eq!(fixture["wire"]["types"]["n"], "Int32");
    assert_eq!(fixture["wire"]["types"]["fraction"], "Double");
    assert_eq!(fixture["wire"]["types"]["wide"], "Double");
    assert_eq!(fixture["wire"]["types"]["maxInt"], "Int32");
    assert_eq!(fixture["wire"]["types"]["negativeZero"], "Double");
    assert!(
        fixture["wire"]["hex"]
            .as_str()
            .unwrap()
            .chars()
            .all(|item| item.is_ascii_hexdigit())
    );

    for zone in ZONES {
        let cases = fixture["calendarCases"][zone].as_array().unwrap();
        assert_eq!(cases.len(), INSTANTS.len());
        for case in cases {
            assert_eq!(
                number_i64(&case["trigger"]["month"]),
                number_i64(&case["vip"]["month"]) + 1
            );
            assert_eq!(
                number_i64(&case["trigger"]["day"]),
                number_i64(&case["vip"]["day"])
            );
            assert_eq!(
                number_i64(&case["trigger"]["year"]),
                number_i64(&case["vip"]["year"])
            );
            assert_eq!(number_i64(&case["createdAt"]), number_i64(&case["instant"]));
        }
    }
    let tz = std::env::var("TZ").expect("TZ");
    assert!(ZONES.contains(&tz.as_str()), "{tz}");
    let vip_input = vip_calendar_input();
    let trigger_input = trigger_calendar_input();
    for case in fixture["calendarCases"][tz.as_str()].as_array().unwrap() {
        let instant = number_i64(&case["instant"]);
        let vip_date = calendar_of(vip::schema(), &vip_input, instant);
        let trigger_date = calendar_of(trigger_file::schema(), &trigger_input, instant);
        assert_eq!(
            i64::from(vip_date.0),
            number_i64(&case["vip"]["day"]),
            "{tz} {instant}"
        );
        assert_eq!(
            i64::from(vip_date.1),
            number_i64(&case["vip"]["month"]),
            "{tz} {instant}"
        );
        assert_eq!(
            i64::from(vip_date.2),
            number_i64(&case["vip"]["year"]),
            "{tz} {instant}"
        );
        assert_eq!(
            i64::from(trigger_date.0),
            number_i64(&case["trigger"]["day"]),
            "{tz} {instant}"
        );
        assert_eq!(
            i64::from(trigger_date.1),
            number_i64(&case["trigger"]["month"]),
            "{tz} {instant}"
        );
        assert_eq!(
            i64::from(trigger_date.2),
            number_i64(&case["trigger"]["year"]),
            "{tz} {instant}"
        );
    }
    for case in fixture["cases"].as_array().unwrap() {
        replay_case(case);
    }
}

fn duplicate_key(error: mongodb::error::Error) -> bool {
    matches!(error.kind.as_ref(), ErrorKind::Write(WriteFailure::WriteError(error)) if error.code == 11000)
        || matches!(error.kind.as_ref(), ErrorKind::Command(error) if error.code == 11000)
}

fn mongo_env() -> (String, String, String) {
    let uri = std::env::var("ORDINARY_APPLICATION_SCHEMAS_MONGO_URI").expect("fixture uri");
    let database =
        std::env::var("ORDINARY_APPLICATION_SCHEMAS_DATABASE").expect("fixture database");
    let owner = std::env::var("ORDINARY_APPLICATION_SCHEMAS_OWNER").expect("fixture owner");
    const PREFIX: &str = "rust_ordinary_schema_fixture_";
    assert!(database.starts_with(PREFIX) && database.len() > PREFIX.len());
    assert!(
        database
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    );
    assert!(database != "admin" && database != "local" && database != "config");
    assert!(!database.contains("prod"));
    assert!(!uri.is_empty());
    assert!(!owner.is_empty() && !owner.to_ascii_lowercase().contains("prod"));
    (uri, database, owner)
}

fn direction_one(value: &Bson) -> bool {
    matches!(value, Bson::Int32(1) | Bson::Int64(1))
        || matches!(value, Bson::Double(number) if *number == 1.0)
}

fn require_index(indexes: &[IndexModel], keys: &[&str], unique: bool) {
    let found = indexes.iter().any(|index| {
        let names: Vec<&str> = index.keys.keys().map(String::as_str).collect();
        let unique_flag = index.options.as_ref().and_then(|options| options.unique) == Some(true);
        names.as_slice() == keys
            && index.keys.values().all(direction_one)
            && unique_flag == unique
            && index
                .options
                .as_ref()
                .and_then(|options| options.expire_after)
                .is_none()
    });
    assert!(found, "missing {keys:?} unique={unique} in {indexes:?}");
}

async fn listed(collection: &Collection<Document>) -> Vec<IndexModel> {
    collection
        .list_indexes()
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap()
}

async fn exercise(database: Database, owner: &str, database_name: &str) {
    let owner_record = database
        .collection::<Document>("_owner")
        .find_one(doc! {"_id": "owner"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(owner_record.get_str("owner").unwrap(), owner);
    assert_eq!(owner_record.get_str("database").unwrap(), database_name);

    let temporary_moderators = temporary_moderator::repository(&database);
    let vips = vip::repository(&database);
    let title_configs = title_config::repository(&database);
    let trigger_files = trigger_file::repository(&database);
    let eventsubs = eventsub::repository(&database);
    let site_analytics = site_analytics::repository(&database);
    assert!(std::ptr::eq(
        temporary_moderators.schema,
        temporary_moderator::schema()
    ));
    assert_eq!(
        temporary_moderators.collection.name(),
        temporary_moderator::COLLECTION_NAME
    );
    assert_eq!(vips.collection.name(), vip::COLLECTION_NAME);
    assert_eq!(
        title_configs.collection.name(),
        title_config::COLLECTION_NAME
    );
    assert_eq!(
        trigger_files.collection.name(),
        trigger_file::COLLECTION_NAME
    );
    assert_eq!(eventsubs.collection.name(), eventsub::COLLECTION_NAME);
    assert_eq!(
        site_analytics.collection.name(),
        site_analytics::COLLECTION_NAME
    );

    temporary_moderator::install_indexes(&database)
        .await
        .unwrap();
    vip::install_indexes(&database).await.unwrap();
    title_config::install_indexes(&database).await.unwrap();
    trigger_file::install_indexes(&database).await.unwrap();
    eventsub::install_indexes(&database).await.unwrap();
    site_analytics::install_indexes(&database).await.unwrap();
    let names = database.list_collection_names().await.unwrap();
    for name in ["temporary_moderators", "eventsubs", "site_analytics"] {
        assert!(names.iter().any(|item| item == name), "{names:?}");
    }
    for name in ["vips", "titleconfigs", "triggerfiles"] {
        assert!(
            !names.iter().any(|item| item == name),
            "{name} was created by an empty index list"
        );
    }

    let now = clock(NOW);
    let past = clock(EARLIER);
    let moderator_documents: Collection<Document> = temporary_moderators.collection.clone();
    let vip_documents: Collection<Document> = vips.collection.clone();
    let title_documents: Collection<Document> = title_configs.collection.clone();
    let trigger_documents: Collection<Document> = trigger_files.collection.clone();
    let eventsub_documents: Collection<Document> = eventsubs.collection.clone();
    let site_documents: Collection<Document> = site_analytics.collection.clone();

    let moderator_indexes = listed(&moderator_documents).await;
    assert_eq!(moderator_indexes.len(), 5);
    assert!(
        moderator_indexes
            .iter()
            .any(|index| index.keys.keys().eq(["_id"]))
    );
    require_index(&moderator_indexes, &["channelID"], false);
    require_index(&moderator_indexes, &["userID"], false);
    require_index(&moderator_indexes, &["expireTimestamp"], false);
    require_index(&moderator_indexes, &["channelID", "userID"], true);
    let event_indexes = listed(&eventsub_documents).await;
    assert_eq!(event_indexes.len(), 3);
    require_index(&event_indexes, &["channelID", "type"], false);
    require_index(&event_indexes, &["id"], false);
    let site_indexes = listed(&site_documents).await;
    assert_eq!(site_indexes.len(), 2);
    require_index(&site_indexes, &["singletonKey"], true);
    for indexes in [&moderator_indexes, &event_indexes, &site_indexes] {
        assert!(indexes.iter().all(|index| {
            index
                .options
                .as_ref()
                .and_then(|options| options.expire_after)
                .is_none()
        }));
    }

    let mut expired = temp_input();
    expired.insert("userID", "expired-user");
    expired.insert("expireTimestamp", past);
    let inserted = temporary_moderators.insert(expired, now).await.unwrap();
    let expired_id = inserted.get_object_id("_id").unwrap();
    let found: Vec<Document> = moderator_documents
        .find(doc! {"expireTimestamp": {"$lte": now}})
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].get_str("userID").unwrap(), "expired-user");
    moderator_documents
        .delete_one(doc! {"_id": expired_id})
        .await
        .unwrap();
    assert_eq!(
        moderator_documents
            .count_documents(doc! {"_id": expired_id})
            .await
            .unwrap(),
        0
    );

    let mut first_user = temp_input();
    first_user.insert("userID", "same-user");
    temporary_moderators
        .insert(first_user.clone(), now)
        .await
        .unwrap();
    let duplicate = temporary_moderators
        .insert(first_user, now)
        .await
        .unwrap_err();
    match duplicate {
        PersistenceError::Mongo(error) => assert!(duplicate_key(error), "compound unique"),
        other => panic!("{other:?}"),
    }

    let mut active = vip_input();
    active.insert("userID", "vip-user");
    vips.insert(active, now).await.unwrap();
    let mut inactive = vip_input();
    inactive.insert("userID", "former-vip");
    inactive.insert("vip", false);
    vips.insert(inactive, now).await.unwrap();
    assert_eq!(
        vip_documents
            .count_documents(doc! {"vip": true})
            .await
            .unwrap(),
        1
    );
    let vip_indexes = listed(&vip_documents).await;
    assert_eq!(vip_indexes.len(), 1);
    assert!(vip_indexes[0].keys.keys().eq(["_id"]));

    title_configs
        .insert(doc! {"channelID": "channel-id", "channel": "channel"}, now)
        .await
        .unwrap();
    assert_eq!(
        title_documents
            .count_documents(doc! {"channelID": "channel-id"})
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        title_documents
            .delete_many(doc! {"channelID": "channel-id"})
            .await
            .unwrap()
            .deleted_count,
        1
    );
    let title_indexes = listed(&title_documents).await;
    assert_eq!(title_indexes.len(), 1);

    let mut kept = trigger_input();
    kept.insert("fileUrl", "https://example.invalid/clips/a.mp4");
    trigger_files.insert(kept, now).await.unwrap();
    let mut other = trigger_input();
    other.insert("fileUrl", "https://example.invalid/other/a.mp4");
    trigger_files.insert(other, now).await.unwrap();
    assert_eq!(
        trigger_documents
            .count_documents(doc! {"fileUrl": "https://example.invalid/clips/a.mp4"})
            .await
            .unwrap(),
        1
    );
    let expression = mongodb::bson::Regex {
        pattern: r"^https://example\.invalid/clips/".try_into().unwrap(),
        options: "".try_into().unwrap(),
    };
    assert_eq!(
        trigger_documents
            .count_documents(doc! {"fileUrl": expression})
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        trigger_documents
            .delete_many(doc! {"channelID": "channel-id"})
            .await
            .unwrap()
            .deleted_count,
        2
    );
    let trigger_indexes = listed(&trigger_documents).await;
    assert_eq!(trigger_indexes.len(), 1);

    let mut subscription = event_input();
    subscription.insert("type", "channel.raid");
    subscription.insert(
        "condition",
        doc! {"broadcaster_user_id": "broadcaster", "from_broadcaster_user_id": "from-id", "extra": "kept"},
    );
    let stored = eventsubs.insert(subscription, now).await.unwrap();
    let event_id = stored.get_object_id("_id").unwrap();
    assert_eq!(
        eventsub_documents
            .find_one(doc! {"_id": event_id})
            .await
            .unwrap()
            .unwrap()
            .get_document("condition")
            .unwrap()
            .get_str("extra")
            .unwrap(),
        "kept"
    );
    assert_eq!(
        eventsub_documents
            .count_documents(doc! {"channelID": "channel-id", "type": "channel.raid"})
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        eventsub_documents
            .count_documents(doc! {"id": "sub-1"})
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        eventsub_documents
            .count_documents(doc! {"condition.from_broadcaster_user_id": "from-id"})
            .await
            .unwrap(),
        1
    );

    let saved_site = site_analytics
        .insert(doc! {"singletonKey": "save-target"}, now)
        .await
        .unwrap();
    let created = *saved_site.get_datetime("created_at").unwrap();
    let site_id = saved_site.get_object_id("_id").unwrap();
    let later = clock(NOW + 60_000);
    let updated = site_analytics
        .save(doc! {"_id": site_id, "registeredUsers": 4}, later)
        .await
        .unwrap();
    assert_eq!(updated.get_datetime("created_at").unwrap(), &created);
    assert_eq!(updated.get_datetime("updated_at").unwrap(), &later);
    assert_eq!(
        site_documents
            .find_one(doc! {"singletonKey": "save-target"})
            .await
            .unwrap()
            .unwrap()
            .get_i32("registeredUsers")
            .unwrap(),
        4
    );
    site_analytics
        .insert(doc! {"singletonKey": "global"}, now)
        .await
        .unwrap();
    let duplicate = site_analytics.insert(doc! {}, now).await.unwrap_err();
    match duplicate {
        PersistenceError::Mongo(error) => assert!(duplicate_key(error), "singleton unique"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "ownership-guarded disposable MongoDB fixture required"]
async fn mongo_ordinary_application_schemas() {
    let (uri, database_name, owner) = mongo_env();
    let mut options = ClientOptions::parse(&uri).await.expect("fixture uri");
    options.direct_connection = Some(true);
    options.retry_reads = Some(false);
    options.retry_writes = Some(false);
    let client = Client::with_options(options).unwrap();
    let database = client.database(&database_name);
    assert_eq!(database.name(), database_name);
    let names = database.list_collection_names().await.unwrap();
    assert!(
        names.is_empty(),
        "refusing a non-empty database {database_name}: {names:?}"
    );
    database
        .collection::<Document>("_owner")
        .insert_one(doc! {"_id": "owner", "owner": &owner, "database": &database_name})
        .await
        .expect("owner");
    let owned = database.clone();
    let owner_for_body = owner.clone();
    let database_for_body = database_name.clone();
    let outcome = AssertUnwindSafe(async move {
        exercise(owned, &owner_for_body, &database_for_body).await;
    })
    .catch_unwind()
    .await;
    let cleanup = database.drop().await;
    assert!(cleanup.is_ok(), "cleanup failed: {cleanup:?}");
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}
