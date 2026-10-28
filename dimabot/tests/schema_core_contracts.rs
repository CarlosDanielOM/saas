#![cfg(feature = "application-schemas")]

use dima_rust::schemas::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use mongodb::bson::{Bson, DateTime, Document, doc, oid::ObjectId};

fn schema(fields: Vec<Field>, version_key: bool) -> SchemaDefinition {
    SchemaDefinition {
        model: "schema-core-fixture",
        collection: "schema_core_fixture",
        fields,
        string_id: false,
        version_key,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        indexes: Vec::new(),
    }
}

#[test]
fn maps_keep_empty_defaults_and_cast_entries_without_minimizing_them() {
    let schema = schema(
        vec![
            Field::new("variables", T::Map(Box::new(T::String))).default(D::Object),
            Field::new("metadata", T::Mixed).default(D::Object),
            Field::new("optional", T::Map(Box::new(T::String))),
        ],
        false,
    );
    let now = DateTime::from_millis(0);
    let empty = schema.construct(&Document::new(), now).unwrap();
    assert_eq!(empty.get_document("variables").unwrap(), &Document::new());
    assert!(!empty.contains_key("metadata"));
    assert!(!empty.contains_key("optional"));
    let cast = schema.construct(&doc! { "variables": { "count": 12, "enabled": true, "absent": Bson::Null }, "optional": Bson::Null }, now).unwrap();
    assert_eq!(
        cast.get_document("variables").unwrap(),
        &doc! { "count": "12", "enabled": "true", "absent": Bson::Null }
    );
    assert_eq!(cast.get("optional"), Some(&Bson::Null));
    for key in ["$field", "a.b", "__proto__", "prototype", "constructor"] {
        let mut invalid = Document::new();
        invalid.insert(key, "value");
        let errors = schema
            .construct(&doc! { "variables": invalid }, now)
            .unwrap_err();
        assert!(
            errors
                .0
                .iter()
                .any(|error| error.path == "variables" && error.kind == "cast")
        );
    }
}

#[test]
fn trimmed_timer_fields_and_conditional_journal_fields_validate_source_boundaries() {
    let schema = schema(
        vec![
            Field::new("name", T::String).trim().max_utf16(3).required(),
            Field::new("frequency", T::Number)
                .min(1.0)
                .max(1440.0)
                .integer()
                .required(),
            Field::new("topic", T::String),
            Field::new("channelID", T::String).required_when("topic", "channel"),
        ],
        true,
    );
    let now = DateTime::from_millis(0);
    let valid = schema
        .construct(
            &doc! { "name": "\u{feff}x\u{00a0}", "frequency": "1440", "topic": "activity" },
            now,
        )
        .unwrap();
    assert_eq!(valid.get_str("name").unwrap(), "x");
    for (frequency, expected) in [(0.0, "min"), (1441.0, "max"), (1.5, "user defined")] {
        let errors = schema
            .construct(&doc! { "name": "x", "frequency": frequency }, now)
            .unwrap_err();
        assert!(
            errors
                .0
                .iter()
                .any(|error| error.path == "frequency" && error.kind == expected)
        );
    }
    let required = schema
        .construct(
            &doc! { "name": "  ", "frequency": 1, "topic": "channel" },
            now,
        )
        .unwrap_err();
    assert!(
        required
            .0
            .iter()
            .any(|error| error.path == "name" && error.kind == "required")
    );
    assert!(
        required
            .0
            .iter()
            .any(|error| error.path == "channelID" && error.kind == "required")
    );
    let astral = schema
        .construct(&doc! { "name": "🎮🎮", "frequency": 1 }, now)
        .unwrap_err();
    assert!(
        astral
            .0
            .iter()
            .any(|error| error.path == "name" && error.kind == "maxlength")
    );
}

#[test]
fn partial_save_preserves_hidden_defaults_and_ignores_invalid_immutable_setters() {
    let schema = schema(
        vec![
            Field::new("receipt", T::String).required().immutable(),
            Field::new("payload", T::Mixed).required().immutable(),
            Field::new("count", T::Number).default(D::Number(0.0)),
            Field::new("secret", T::String).hidden(),
            Field::new("state", T::String),
        ],
        false,
    );
    let first = DateTime::from_millis(1000);
    let second = DateTime::from_millis(2000);
    let original = schema.prepare_insert(doc! { "receipt": "original", "payload": { "value": true }, "count": 7, "secret": "retained", "state": "pending" }, first).unwrap();
    let patch = doc! { "_id": ObjectId::new(), "receipt": { "invalid": true }, "payload": Bson::Null, "createdAt": second, "state": "complete" };
    let saved = schema
        .prepare_save_against(&patch, &original, second)
        .unwrap();
    assert_eq!(saved.get("_id"), original.get("_id"));
    assert_eq!(saved.get_str("receipt").unwrap(), "original");
    assert_eq!(
        saved.get_document("payload").unwrap(),
        original.get_document("payload").unwrap()
    );
    assert_eq!(saved.get_i32("count").unwrap(), 7);
    assert_eq!(saved.get_str("secret").unwrap(), "retained");
    assert_eq!(saved.get_str("state").unwrap(), "complete");
    assert_eq!(saved.get_datetime("createdAt").unwrap(), &first);
    assert_eq!(saved.get_datetime("updatedAt").unwrap(), &second);
    assert!(!saved.contains_key("__v"));
}

#[test]
fn epoch_defaults_and_version_key_disable_are_persisted_without_extra_fields() {
    let plain = schema(
        vec![Field::new("checkpoint", T::Date).default(D::Epoch)],
        false,
    );
    let document = plain
        .prepare_insert(doc! { "__v": 99 }, DateTime::from_millis(1000))
        .unwrap();
    assert_eq!(
        document.get_datetime("checkpoint").unwrap(),
        &DateTime::from_millis(0)
    );
    assert!(!document.contains_key("__v"));
    let versioned = schema(Vec::new(), true)
        .prepare_insert(Document::new(), DateTime::from_millis(1000))
        .unwrap();
    assert_eq!(versioned.get_i32("__v").unwrap(), 0);
}

#[cfg(unix)]
#[test]
fn local_calendar_defaults_follow_process_timezone() {
    const CASE_VARIABLE: &str = "SCHEMA_CORE_CALENDAR_CASE";
    if let Ok(case) = std::env::var(CASE_VARIABLE) {
        let (timestamp, expected) = match case.as_str() {
            "utc" => ("2023-12-31T23:30:00Z", (2023, 12, 31)),
            "east" => ("2023-12-31T23:30:00Z", (2024, 1, 1)),
            "west" => ("1970-01-01T00:00:00Z", (1969, 12, 31)),
            _ => panic!("unknown private calendar fixture"),
        };
        let schema = schema(
            vec![Field::new(
                "date",
                T::Object(vec![
                    Field::new("day", T::Number).default(D::LocalDay),
                    Field::new("month", T::Number).default(D::LocalMonth),
                    Field::new("year", T::Number).default(D::LocalYear),
                ]),
            )],
            false,
        );
        let now = DateTime::parse_rfc3339_str(timestamp).unwrap();
        let document = schema.construct(&Document::new(), now).unwrap();
        let date = document.get_document("date").unwrap();
        assert_eq!(
            (
                date.get_i32("year").unwrap(),
                date.get_i32("month").unwrap(),
                date.get_i32("day").unwrap()
            ),
            expected
        );
        return;
    }
    // Process-local TZ state never mutates the concurrent Rust test process.
    for (case, timezone) in [
        ("utc", "UTC0"),
        ("east", "IST-5:30"),
        ("west", "EST5EDT,M3.2.0/2,M11.1.0/2"),
    ] {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "local_calendar_defaults_follow_process_timezone",
                "--nocapture",
            ])
            .env(CASE_VARIABLE, case)
            .env("TZ", timezone)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{case}: {}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
