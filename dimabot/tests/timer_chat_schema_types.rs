//! Source-declared timer/chat types and their BSON projections.
#![cfg(feature = "application-schemas")]
#[path = "support/schema_source.rs"]
mod schema_source;
use dima_rust::schemas::{
    FieldDefault, chat_logs, command_timer, countdown_timer, countdown_timer_config, custom_timer,
};
use dima_rust::utils::js_string::JsString;
use mongodb::bson::{self, Bson, DateTime, doc, oid::ObjectId};
use std::{path::Path, str::FromStr};

#[test]
fn declared_types_bson_and_defaults() {
    let id = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
    let date = DateTime::from_millis(1_900_000_000_000);
    let command = command_timer::ICommandTimer {
        id,
        command: "!名".into(),
        timer: 1.5,
        channel: "stream".into(),
        channel_id: "42".into(),
        created_at: date,
        date: command_timer::CommandTimerDate {
            day: 31.0,
            month: 10.0,
            year: 2026.0,
        },
    };
    fn required_fields(
        document: &bson::Document,
        fields: &[&str],
        accepts: impl Fn(bson::Document) -> bool,
    ) {
        for field in fields {
            let mut candidate = document.clone();
            candidate.remove(*field);
            assert!(!accepts(candidate.clone()), "missing {field}");
            candidate.insert(*field, Bson::Null);
            assert!(!accepts(candidate), "null {field}");
        }
    }
    let mut command_doc = command.to_bson_document().unwrap();
    required_fields(
        &command_doc,
        &[
            "_id",
            "command",
            "timer",
            "channel",
            "channelID",
            "createdAt",
            "date",
        ],
        |d| command_timer::ICommandTimer::from_bson_document(d).is_ok(),
    );
    assert_eq!(
        command_timer::ICommandTimer::from_bson_document(command_doc.clone()).unwrap(),
        command
    );
    assert_eq!(
        command_doc
            .get_document("date")
            .unwrap()
            .get_f64("day")
            .unwrap(),
        31.0
    );
    command_doc.get_document_mut("date").unwrap().remove("day");
    assert!(command_timer::ICommandTimer::from_bson_document(command_doc).is_err());
    let countdown = countdown_timer::ICountdownTimer {
        id,
        channel: "c".into(),
        channel_id: "42".into(),
        start_time: 0.0,
        resumed_at: date,
        paused_at: date,
        time: 4.0,
        paused: false,
        active: true,
    };
    let mut countdown_doc = countdown.to_bson_document().unwrap();
    required_fields(
        &countdown_doc,
        &[
            "_id",
            "channel",
            "channelID",
            "startTime",
            "resumedAt",
            "pausedAt",
            "time",
            "paused",
            "active",
        ],
        |d| countdown_timer::ICountdownTimer::from_bson_document(d).is_ok(),
    );
    assert_eq!(
        countdown_timer::ICountdownTimer::from_bson_document(countdown_doc.clone()).unwrap(),
        countdown
    );
    // The source interface requires both dates; the schema itself allows them to be absent.
    countdown_doc.remove("resumedAt");
    assert!(countdown_timer::ICountdownTimer::from_bson_document(countdown_doc).is_err());
    assert!(
        !countdown_timer::schema()
            .fields
            .iter()
            .find(|f| f.name == "resumedAt")
            .unwrap()
            .required
    );
    assert!(
        !countdown_timer::schema()
            .fields
            .iter()
            .find(|f| f.name == "pausedAt")
            .unwrap()
            .required
    );
    let config = countdown_timer_config::ICountdownTimerConfig {
        id,
        channel: "c".into(),
        channel_id: "42".into(),
        bits: 1.0,
        tier1: 2.0,
        tier2: 3.0,
        tier3: 4.0,
        follows: 5.0,
        raids: 6.0,
        viewers: 7.0,
        donations: 8.0,
    };
    let config_doc = config.to_bson_document().unwrap();
    required_fields(
        &config_doc,
        &[
            "_id",
            "channel",
            "channelID",
            "bits",
            "tier1",
            "tier2",
            "tier3",
            "follows",
            "raids",
            "viewers",
            "donations",
        ],
        |d| countdown_timer_config::ICountdownTimerConfig::from_bson_document(d).is_ok(),
    );
    assert_eq!(
        countdown_timer_config::ICountdownTimerConfig::from_bson_document(config_doc).unwrap(),
        config
    );
    let custom = custom_timer::ICustomTimer {
        id: None,
        name: " n ".into(),
        message: "message".into(),
        frequency: 1.5,
        frequency_unit: Some(custom_timer::FrequencyUnit::Minutes),
        channel: "c".into(),
        channel_id: "42".into(),
        active: true,
        created_at: None,
        updated_at: None,
    };
    let custom_doc = custom.to_bson_document().unwrap();
    required_fields(
        &custom_doc,
        &[
            "name",
            "message",
            "frequency",
            "channel",
            "channelID",
            "active",
        ],
        |d| custom_timer::ICustomTimer::from_bson_document(d).is_ok(),
    );
    // The declared interface accepts this frequency; validation/trim remain descriptor behavior.
    assert_eq!(
        custom_timer::ICustomTimer::from_bson_document(custom_doc.clone()).unwrap(),
        custom
    );
    assert_eq!(custom_doc.get_str("name").unwrap(), " n ");
    for field in ["_id", "frequencyUnit", "created_at", "updated_at"] {
        let mut missing = custom_doc.clone();
        missing.remove(field);
        assert!(
            custom_timer::ICustomTimer::from_bson_document(missing.clone()).is_ok(),
            "{field}"
        );
        missing.insert(field, Bson::Null);
        assert!(
            custom_timer::ICustomTimer::from_bson_document(missing).is_err(),
            "{field}"
        );
    }
    assert_eq!(
        custom_timer::FrequencyUnit::ALL.len(),
        custom_timer::FREQUENCY_UNITS.len()
    );
    for (unit, wire) in custom_timer::FrequencyUnit::ALL
        .into_iter()
        .zip(custom_timer::FREQUENCY_UNITS)
    {
        assert_eq!(unit.as_str(), *wire);
        assert_eq!(custom_timer::FrequencyUnit::from_str(wire), Ok(unit));
        let json = serde_json::to_string(&unit).unwrap();
        assert_eq!(json, format!("\"{wire}\""));
        assert_eq!(
            serde_json::from_str::<custom_timer::FrequencyUnit>(&json).unwrap(),
            unit
        );
    }
    let mut invalid_unit = custom_doc.clone();
    invalid_unit.insert("frequencyUnit", "seconds");
    assert!(custom_timer::ICustomTimer::from_bson_document(invalid_unit).is_err());
    assert_eq!(
        custom_timer::FrequencyUnit::from_str("minutes"),
        Ok(custom_timer::FrequencyUnit::Minutes)
    );
    assert!(custom_timer::FrequencyUnit::from_str("seconds").is_err());
    let mut log = chat_logs::IChatLog {
        id,
        channel: "c".into(),
        message: JsString::from_units(vec![0xd800, 0x41, 0xdc00]),
        username: "名".into(),
        timestamp: date,
    };
    assert_eq!(log.message.units(), vec![0xd800, 0x41, 0xdc00]);
    let log_doc = log.to_bson_document().unwrap();
    required_fields(
        &log_doc,
        &["_id", "channel", "message", "username", "timestamp"],
        |d| chat_logs::IChatLog::from_bson_document(d).is_ok(),
    );
    assert_eq!(log_doc.get_str("message").unwrap(), "�A�");
    log.message = "�A�".into();
    assert_eq!(
        chat_logs::IChatLog::from_bson_document(log_doc).unwrap(),
        log
    );
    for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.0] {
        let mut special = custom.clone();
        special.frequency = number;
        let restored =
            custom_timer::ICustomTimer::from_bson_document(special.to_bson_document().unwrap())
                .unwrap();
        if number.is_nan() {
            assert!(restored.frequency.is_nan());
        } else {
            assert_eq!(restored.frequency.to_bits(), number.to_bits());
        }
    }
}

#[test]
fn existing_descriptor_contracts() {
    let date = command_timer::schema()
        .fields
        .iter()
        .find(|f| f.name == "date")
        .unwrap();
    let dima_rust::schemas::FieldType::Object(children) = &date.kind else {
        panic!("date fields");
    };
    assert!(matches!(&children[0].default, FieldDefault::LocalDay));
    assert!(matches!(&children[1].default, FieldDefault::LocalMonth));
    assert!(matches!(&children[2].default, FieldDefault::LocalYear));
    let custom = custom_timer::schema();
    assert_eq!(custom.timestamps, Some(("created_at", "updated_at")));
    assert_eq!(custom.indexes.len(), 2);
    assert!(custom.indexes[1].unique);
    let name = custom.fields.iter().find(|f| f.name == "name").unwrap();
    assert!(name.trim);
    assert_eq!(name.max_utf16, Some(30));
    let frequency = custom
        .fields
        .iter()
        .find(|f| f.name == "frequency")
        .unwrap();
    assert!(frequency.integer);
    assert_eq!(frequency.min, Some(1.0));
    assert_eq!(frequency.max, Some(1440.0));
    assert_eq!(
        custom
            .fields
            .iter()
            .find(|f| f.name == "frequencyUnit")
            .unwrap()
            .enum_values,
        ["minutes"]
    );
    assert_eq!(chat_logs::schema().collection, "chat_logs");
}

#[test]
fn timer_chat_sources_are_archived_and_pinned() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for (logical, _) in schema_source::PINS.iter().skip(9).take(5) {
        schema_source::archived(root, logical);
    }
}

#[test]
#[ignore = "requires pinned external source fixture and SHA-256"]
fn source_oracle_and_bson_boundaries() {
    let fixture =
        std::env::var("TIMER_CHAT_TYPES_FIXTURE").expect("absolute external source fixture");
    let path = Path::new(&fixture);
    assert!(path.is_absolute());
    assert_eq!(path.canonicalize().unwrap(), path);
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    assert!(!path.starts_with(root.canonicalize().unwrap()));
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(
        schema_source::sha256(&bytes),
        std::env::var("TIMER_CHAT_TYPES_SHA256").unwrap()
    );
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let sources = [
        (
            "src/schemas/command_timer.schema.ts",
            "db42c5b989f6e154551c714f51736585b0230fa743f6bc51fe935b54530af4f5",
        ),
        (
            "src/schemas/countdown_timer.schema.ts",
            "5d6ab4812c726b2aab0a8fee4a3ca060c6dacc97f59b8aee66c46b669766b990",
        ),
        (
            "src/schemas/countdown_timer_config.schema.ts",
            "b4cf0d5f8cfe85dc1e04f11970aac8bbab48a27c86fc9fab43d935cdbb1ada8a",
        ),
        (
            "src/schemas/custom_timer.schema.ts",
            "6c59b38b43615325f87c870dcbd5dfe2cd0b50e91822dbe884d3c32dd45f387f",
        ),
        (
            "src/schemas/chat_logs.schema.ts",
            "732abc7b27b820fa6ded0d62b1dc3bf3aed8539c7fd636a47f47d98f70b63433",
        ),
    ];
    assert_eq!(value["sources"].as_object().unwrap().len(), sources.len());
    for (file, pin) in sources {
        assert_eq!(value["sources"][file], pin);
        assert_eq!(
            schema_source::sha256(&schema_source::archived(root, file)),
            pin
        );
        assert_eq!(value["provenance"][file], schema_source::provenance(file));
    }
    let dependencies = [
        "src/schemas/command_timer.schema.rs",
        "src/schemas/countdown_timer.schema.rs",
        "src/schemas/countdown_timer_config.schema.rs",
        "src/schemas/custom_timer.schema.rs",
        "src/schemas/chat_logs.schema.rs",
        "src/schemas/schema.rs",
        "src/utils/js_string.rs",
        "tests/fixtures/timer_chat_schema_types_reference.cjs",
        "tests/fixtures/schema_source_resolver.cjs",
        "tests/timer_chat_schema_types.rs",
        "tests/support/schema_source.rs",
        "tests/support/sha256.rs",
    ];
    assert_eq!(
        value["hashes"].as_object().unwrap().len(),
        dependencies.len()
    );
    for file in dependencies {
        assert_eq!(
            schema_source::sha256(&std::fs::read(root.join(file)).unwrap()),
            value["hashes"][file].as_str().unwrap(),
            "{file}"
        );
    }
    type MemberSpec = (&'static str, &'static str, bool);
    type InterfaceSpec = (&'static str, &'static [MemberSpec]);
    let expected: &[InterfaceSpec] = &[
        (
            "ICommandTimer",
            &[
                ("_id", "Types.ObjectId", false),
                ("command", "string", false),
                ("timer", "number", false),
                ("channel", "string", false),
                ("channelID", "string", false),
                ("createdAt", "Date", false),
                (
                    "date",
                    "{\n        day: number;\n        month: number;\n        year: number;\n    }",
                    false,
                ),
            ],
        ),
        (
            "ICountdownTimer",
            &[
                ("_id", "Types.ObjectId", false),
                ("channel", "string", false),
                ("channelID", "string", false),
                ("startTime", "number", false),
                ("resumedAt", "Date", false),
                ("pausedAt", "Date", false),
                ("time", "number", false),
                ("paused", "boolean", false),
                ("active", "boolean", false),
            ],
        ),
        (
            "ICountdownTimerConfig",
            &[
                ("_id", "Types.ObjectId", false),
                ("channel", "string", false),
                ("channelID", "string", false),
                ("bits", "number", false),
                ("tier1", "number", false),
                ("tier2", "number", false),
                ("tier3", "number", false),
                ("follows", "number", false),
                ("raids", "number", false),
                ("viewers", "number", false),
                ("donations", "number", false),
            ],
        ),
        (
            "ICustomTimer",
            &[
                ("_id", "Types.ObjectId", true),
                ("name", "string", false),
                ("message", "string", false),
                ("frequency", "number", false),
                ("frequencyUnit", "'minutes'", true),
                ("channel", "string", false),
                ("channelID", "string", false),
                ("active", "boolean", false),
                ("created_at", "Date", true),
                ("updated_at", "Date", true),
            ],
        ),
        (
            "IChatLog",
            &[
                ("_id", "Types.ObjectId", false),
                ("channel", "string", false),
                ("message", "string", false),
                ("username", "string", false),
                ("timestamp", "Date", false),
            ],
        ),
    ];
    for (name, members) in expected {
        let actual = value["declarations"][name]["members"].as_array().unwrap();
        assert_eq!(actual.len(), members.len(), "{name}");
        for (entry, (field, ty, optional)) in actual.iter().zip(members.iter()) {
            assert_eq!(entry["name"].as_str(), Some(*field));
            assert_eq!(entry["type"].as_str(), Some(*ty));
            assert_eq!(entry["optional"].as_bool(), Some(*optional));
        }
        assert_eq!(
            value["signatures"][name].as_array().unwrap().len(),
            members.len()
        );
    }
    for case in value["bsonStrings"].as_array().unwrap() {
        let units: Vec<u16> = case["units"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u16)
            .collect();
        let text = JsString::from_units(units.clone());
        assert_eq!(text.units(), units);
        let wire = bson::serialize_to_vec(&doc! {"value":text.to_utf8_lossy()}).unwrap();
        let hex: String = wire.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, case["bsonHex"].as_str().unwrap());
        let expected: Vec<u16> = case["outputUnits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u16)
            .collect();
        assert_eq!(JsString::from(text.to_utf8_lossy()).units(), expected);
    }
    for case in value["bsonNumbers"].as_array().unwrap() {
        let number = match case["name"].as_str().unwrap() {
            "nan" => f64::NAN,
            "positiveInfinity" => f64::INFINITY,
            "negativeInfinity" => f64::NEG_INFINITY,
            "negativeZero" => -0.0,
            "fraction" => 1.5,
            _ => panic!("unexpected number"),
        };
        let wire = bson::serialize_to_vec(&doc! {"value":number}).unwrap();
        let hex: String = wire.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, case["bsonHex"].as_str().unwrap());
    }
}
