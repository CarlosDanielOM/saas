#![cfg(feature = "moderation-decision-schema")]
use dima_rust::schemas::moderation_decision::schema;
use mongodb::bson::{Bson, DateTime, Document, doc};
use serde_json::{Value, json};

#[test]
fn flat_insert_defaults_casting_and_bounds() {
    let now = DateTime::from_millis(1700000000000);
    let out = schema()
        .cast_flat_set_on_insert(
            &doc! {"state":"existing"},
            &doc! {
                "channelID":"", "reviewSource":"unrecognized", "rule":{}, "scores":{},
                "matches":[{}, {"nested":{}}], "inputTokens":"2", "unknown":1,
            },
            now,
        )
        .unwrap();
    assert!(!out.contains_key("state"));
    assert!(!out.contains_key("unknown"));
    assert_eq!(out.get_str("reviewSource").unwrap(), "unrecognized");
    assert_eq!(out.get_i32("inputTokens").unwrap(), 2);
    assert_eq!(out.get_document("rule").unwrap(), &Document::new());
    assert_eq!(out.get_document("scores").unwrap(), &Document::new());
    assert_eq!(
        out.get_array("matches").unwrap()[0],
        Bson::Document(Document::new())
    );
    assert_eq!(out.get_datetime("createdAt").unwrap(), &now);
    assert!(
        schema()
            .cast_flat_set_on_insert(&doc! {}, &doc! {"inputTokens":"bad"}, now)
            .is_err()
    );
    assert!(
        schema()
            .cast_flat_set_on_insert(&doc! {}, &doc! {"rule.a":1}, now)
            .is_err()
    );
    assert!(
        schema()
            .cast_flat_set_on_insert(&doc! {"state":{"$ne":"x"}}, &doc! {}, now)
            .is_err()
    );
    let null = schema()
        .cast_flat_set_on_insert(&doc! {}, &doc! {"matches":null, "state":null}, now)
        .unwrap();
    assert_eq!(null.get("matches"), Some(&Bson::Null));
    assert_eq!(null.get("state"), Some(&Bson::Null));
}
fn normalize(v: &Bson) -> Value {
    match v {
        Bson::DateTime(v) => json!({"$date":v.timestamp_millis()}),
        Bson::Document(v) => {
            Value::Object(v.iter().map(|(k, v)| (k.clone(), normalize(v))).collect())
        }
        Bson::Array(v) => Value::Array(v.iter().map(normalize).collect()),
        other => serde_json::to_value(other).unwrap(),
    }
}
#[test]
#[ignore = "requires pinned disconnected Mongoose oracle"]
fn replay_sdk_fixture() {
    use sha2::{Digest, Sha256};
    let dir = std::path::PathBuf::from(std::env::var_os("DIMA_SET_ON_INSERT_FIXTURE_DIR").unwrap());
    assert!(dir.is_absolute());
    assert_eq!(dir.canonicalize().unwrap(), dir);
    assert!(
        !dir.starts_with(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .canonicalize()
                .unwrap()
        )
    );
    let bytes = std::fs::read(dir.join("mongoose-set-on-insert-reference.json")).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        std::env::var("DIMA_SET_ON_INSERT_FIXTURE_SHA256").unwrap()
    );
    let corpus: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        corpus["nodeExecutableSha256"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    for (key, expected) in [
        ("node", "24.22.1"),
        ("typescript", "5.9.3"),
        ("mongoose", "8.24.2"),
        ("bson", "6.10.4"),
    ] {
        assert_eq!(corpus["versions"][key], expected);
    }
    for (name, bytes) in [
        (
            "src/schemas/moderation_decision.schema.ts",
            include_bytes!("../src/schemas/moderation_decision.schema.ts").as_slice(),
        ),
        (
            "src/schemas/moderation_decision.schema.rs",
            include_bytes!("../src/schemas/moderation_decision.schema.rs").as_slice(),
        ),
        (
            "src/schemas/schema.rs",
            include_bytes!("../src/schemas/schema.rs").as_slice(),
        ),
        (
            "tests/mongoose_set_on_insert.rs",
            include_bytes!("mongoose_set_on_insert.rs").as_slice(),
        ),
        (
            "oracle-script",
            include_bytes!("fixtures/mongoose_set_on_insert_reference.cjs").as_slice(),
        ),
    ] {
        assert_eq!(
            corpus["sourceSha256"][name],
            format!("{:x}", Sha256::digest(bytes))
        );
    }
    let paths = corpus["metadata"].as_object().unwrap();
    assert_eq!(paths.len(), schema().fields.len());
    for field in &schema().fields {
        assert!(paths.contains_key(field.name), "{}", field.name);
    }
    for case in corpus["cases"].as_array().unwrap() {
        let mut input: Document = mongodb::bson::serialize_to_document(&case["input"]).unwrap();
        let mut filter: Document = mongodb::bson::serialize_to_document(&case["filter"]).unwrap();
        dima_rust::utils::bson_compat::normalize_document(&mut input);
        dima_rust::utils::bson_compat::normalize_document(&mut filter);
        let actual = match schema().cast_flat_set_on_insert(
            &filter,
            &input,
            DateTime::from_millis(corpus["now"].as_i64().unwrap()),
        ) {
            Ok(document) => json!({"document":normalize(&Bson::Document(document))}),
            Err(dima_rust::schemas::FlatInsertError::Cast(errors)) => {
                json!({"error":{"path":errors.0[0].path,"kind":errors.0[0].kind}})
            }
            Err(e) => panic!("unsupported fixture: {e}"),
        };
        assert_eq!(actual, case["expected"], "{case}");
    }
}
