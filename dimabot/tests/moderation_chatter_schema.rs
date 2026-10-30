#![cfg(feature = "moderation-spam")]
//! Focused coverage for the single-model `moderation_chatter` schema.
//!
//! Ordinary tests use the native `SchemaDefinition` contract only. The ignored
//! replay reads an externally generated, independently hashed oracle produced
//! from the complete actual TypeScript module and disconnected Mongoose. The
//! ignored Mongo test uses an ownership-guarded disposable database and the
//! production `SpamService::claim_first_observed_message` primitive with only
//! its external cache endpoint replaced by a loopback RESP fixture.
//!
//! Authoring status: this file was not executed by its author. The parent owns
//! isolated runtime verification under the repository production policies.
#[path = "ai_credit_projection_support/mod.rs"]
mod resp;

use dima_rust::schemas::moderation_chatter::{get_moderation_chatter_model, schema};
use dima_rust::schemas::{FieldDefault, FieldType, FlatInsertError, PersistenceError};
use dima_rust::utils::js_string::JsString;
use dima_rust::utils::moderation::spam::{SpamService, chatter_marker_id};
use mongodb::bson::{Bson, DateTime, Document, doc};
use mongodb::error::{ErrorKind, WriteFailure};
use serde_json::{Value, json};

const FIXTURE_NAME: &str = "moderation-chatter-schema-reference.json";
const NODE_SHA256: &str = "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108";
const SOURCE: &str = "src/schemas/moderation_chatter.schema.ts";

fn normalize(value: &Bson) -> Value {
    match value {
        Bson::DateTime(v) => json!({"$date":v.timestamp_millis()}),
        Bson::Document(v) => {
            Value::Object(v.iter().map(|(k, v)| (k.clone(), normalize(v))).collect())
        }
        Bson::Array(v) => Value::Array(v.iter().map(normalize).collect()),
        other => serde_json::to_value(other).unwrap(),
    }
}

#[test]
fn descriptor_matches_the_single_source_model() {
    let definition = schema();
    assert_eq!(definition.model, "moderation_chatter");
    assert_eq!(definition.collection, "moderation_chatters");
    assert!(definition.string_id);
    assert!(!definition.version_key);
    assert!(!definition.write_concern_journaled);
    assert!(definition.timestamps.is_none());
    assert!(definition.save_clock_field.is_none());
    assert!(definition.indexes.is_empty());
    assert!(definition.default_projection().is_empty());

    assert_eq!(definition.fields.len(), 2);
    let id_field = &definition.fields[0];
    assert_eq!(id_field.name, "_id");
    assert!(matches!(&id_field.kind, FieldType::String));
    assert!(id_field.required);
    assert!(matches!(&id_field.default, FieldDefault::Missing));
    let date_field = &definition.fields[1];
    assert_eq!(date_field.name, "firstSeenAt");
    assert!(matches!(&date_field.kind, FieldType::Date));
    assert!(date_field.required);
    assert!(matches!(&date_field.default, FieldDefault::Missing));
    for field in [id_field, date_field] {
        assert!(field.required_when.is_none());
        assert!(field.enum_values.is_empty());
        assert!(field.min.is_none() && field.max.is_none() && field.max_utf16.is_none());
        assert!(!field.hidden && !field.trim && !field.integer);
        assert!(!field.immutable && !field.minimize);
    }
}

#[test]
fn constructor_required_string_and_date_casts() {
    let now = DateTime::from_millis(0);

    let missing = schema().construct(&doc! {}, now).unwrap_err();
    let mut paths: Vec<_> = missing
        .0
        .iter()
        .map(|error| (error.path.as_str(), error.kind))
        .collect();
    paths.sort();
    assert_eq!(
        paths,
        vec![("_id", "required"), ("firstSeenAt", "required")]
    );

    let nulls = schema()
        .construct(&doc! {"_id": Bson::Null, "firstSeenAt": Bson::Null}, now)
        .unwrap_err();
    assert_eq!(nulls.0.len(), 2);
    assert!(nulls.0.iter().all(|error| error.kind == "required"));

    let empty_id = schema()
        .construct(
            &doc! {"_id": "", "firstSeenAt": DateTime::from_millis(0)},
            now,
        )
        .unwrap_err();
    assert_eq!(empty_id.0.len(), 1);
    assert_eq!(
        (empty_id.0[0].path.as_str(), empty_id.0[0].kind),
        ("_id", "required")
    );

    let empty_date = schema()
        .construct(&doc! {"_id": "marker", "firstSeenAt": ""}, now)
        .unwrap_err();
    assert_eq!(
        (empty_date.0[0].path.as_str(), empty_date.0[0].kind),
        ("firstSeenAt", "required")
    );

    let valid = schema()
        .construct(
            &doc! {
                "_id": "marker",
                "firstSeenAt": DateTime::from_millis(1_700_000_000_123),
                "unknown": "discard",
                "nested": {"value": 1},
                "__v": 7,
            },
            now,
        )
        .unwrap();
    assert_eq!(valid.len(), 2);
    assert_eq!(valid.get_str("_id").unwrap(), "marker");
    assert_eq!(
        valid.get_datetime("firstSeenAt").unwrap(),
        &DateTime::from_millis(1_700_000_000_123)
    );
    assert!(valid.get("unknown").is_none());
    assert!(valid.get("nested").is_none());
    assert!(valid.get("__v").is_none());

    let prepared = schema()
        .prepare_insert(
            doc! {"_id": "marker", "firstSeenAt": DateTime::from_millis(0)},
            now,
        )
        .unwrap();
    assert_eq!(prepared.len(), 2);
    assert!(prepared.get("__v").is_none());
}

#[test]
fn string_casts_cover_numbers_booleans_and_wide_values() {
    let now = DateTime::from_millis(0);
    for (value, expected) in [
        (Bson::Int32(42), "42"),
        (Bson::Double(42.5), "42.5"),
        (Bson::Boolean(true), "true"),
        (Bson::Boolean(false), "false"),
        (Bson::Int32(0), "0"),
        (Bson::Double(1e21), "1e+21"),
    ] {
        let document = schema()
            .construct(
                &doc! {"_id": value, "firstSeenAt": DateTime::from_millis(0)},
                now,
            )
            .unwrap();
        assert_eq!(document.get_str("_id").unwrap(), expected);
    }
}

#[test]
fn date_casts_cover_extremes_and_reject_out_of_range_values() {
    let now = DateTime::from_millis(0);
    for (value, expected) in [
        (Bson::Int32(0), 0_i64),
        (Bson::Double(1.9), 1),
        (Bson::Double(-1.9), -1),
        (
            Bson::String("2025-01-01T00:00:00.000Z".into()),
            1_735_689_600_000,
        ),
        (Bson::Double(8_640_000_000_000_000.0), 8_640_000_000_000_000),
        (
            Bson::Double(-8_640_000_000_000_000.0),
            -8_640_000_000_000_000,
        ),
    ] {
        let document = schema()
            .construct(&doc! {"_id": "marker", "firstSeenAt": value}, now)
            .unwrap();
        assert_eq!(
            document
                .get_datetime("firstSeenAt")
                .unwrap()
                .timestamp_millis(),
            expected
        );
    }

    for value in [
        Bson::String("not-a-date".into()),
        Bson::Double(8_640_000_000_000_001.0),
        Bson::Double(-8_640_000_000_000_001.0),
    ] {
        let errors = schema()
            .construct(&doc! {"_id": "marker", "firstSeenAt": value}, now)
            .unwrap_err();
        assert_eq!(errors.0.len(), 1);
        assert_eq!(
            (errors.0[0].path.as_str(), errors.0[0].kind),
            ("firstSeenAt", "cast")
        );
    }
}

#[test]
fn flat_set_on_insert_preparation_is_bounded_and_typed() {
    let now = DateTime::from_millis(1_700_000_000_000);
    let inserted_at = DateTime::from_millis(1_700_000_000_123);
    let output = schema()
        .cast_flat_set_on_insert(
            &doc! {"_id": "marker"},
            &doc! {"firstSeenAt": inserted_at},
            now,
        )
        .unwrap();
    assert_eq!(output, doc! {"firstSeenAt": inserted_at});

    // Mongoose's bounded castUpdate copies a nonempty filter when no update
    // keys survive; this schema has no defaults to add.
    assert_eq!(
        schema()
            .cast_flat_set_on_insert(&doc! {"_id": "marker"}, &doc! {}, now)
            .unwrap(),
        doc! {"_id": "marker"}
    );

    assert!(matches!(
        schema().cast_flat_set_on_insert(
            &doc! {"_id": "marker"},
            &doc! {"firstSeenAt": "not-a-date"},
            now,
        ),
        Err(FlatInsertError::Cast(_))
    ));
    for (filter, insert) in [
        (doc! {"_id.value": 1}, doc! {}),
        (doc! {}, doc! {"$set": {"firstSeenAt": now}}),
        (doc! {"_id": {"$ne": "marker"}}, doc! {}),
    ] {
        assert!(matches!(
            schema().cast_flat_set_on_insert(&filter, &insert, now),
            Err(FlatInsertError::Unsupported(_))
        ));
    }
}

#[test]
#[ignore = "requires an externally generated, independently hashed actual-Mongoose oracle"]
fn replay_actual_mongoose_source() {
    use sha2::{Digest, Sha256};
    let dir = std::path::PathBuf::from(
        std::env::var_os("DIMA_CHATTER_SCHEMA_FIXTURE_DIR").expect("fixture directory"),
    );
    assert!(dir.is_absolute());
    assert_eq!(dir.canonicalize().unwrap(), dir);
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(!dir.starts_with(&manifest));
    assert!(!dir.starts_with(manifest.parent().unwrap()));
    let bytes = std::fs::read(dir.join(FIXTURE_NAME)).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        std::env::var("DIMA_CHATTER_SCHEMA_FIXTURE_SHA256").expect("independent fixture digest")
    );
    let corpus: Value = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(corpus["format"], 1);
    assert_eq!(corpus["metadata"]["format"], 1);
    assert_eq!(corpus["metadata"]["nodeExecutableSha256"], NODE_SHA256);
    for (key, expected) in [
        ("node", "24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("icu", "78.3"),
        ("unicode", "17.0"),
        ("typescript", "5.9.3"),
        ("mongoose", "8.24.2"),
        ("bson", "6.10.4"),
    ] {
        assert_eq!(corpus["metadata"]["versions"][key], expected);
    }
    assert_eq!(corpus["metadata"]["source"]["logical"], SOURCE);
    assert_eq!(corpus["metadata"]["source"]["provenance"], "live");
    assert_eq!(
        corpus["metadata"]["source"]["sha256"],
        format!(
            "{:x}",
            Sha256::digest(
                include_bytes!("../src/schemas/moderation_chatter.schema.ts").as_slice()
            )
        )
    );
    assert_eq!(
        corpus["metadata"]["caseCount"].as_u64().unwrap() as usize,
        corpus["cases"].as_array().unwrap().len()
    );

    for (key, bytes) in [
        (
            "src/schemas/moderation_chatter.schema.ts",
            include_bytes!("../src/schemas/moderation_chatter.schema.ts").as_slice(),
        ),
        (
            "src/schemas/moderation_chatter.schema.rs",
            include_bytes!("../src/schemas/moderation_chatter.schema.rs").as_slice(),
        ),
        (
            "src/schemas/schema.rs",
            include_bytes!("../src/schemas/schema.rs").as_slice(),
        ),
        (
            "src/utils/bson_compat.rs",
            include_bytes!("../src/utils/bson_compat.rs").as_slice(),
        ),
        (
            "src/utils/mongoose_date.rs",
            include_bytes!("../src/utils/mongoose_date.rs").as_slice(),
        ),
        (
            "src/utils/js_date/mod.rs",
            include_bytes!("../src/utils/js_date/mod.rs").as_slice(),
        ),
        (
            "src/utils/js_date/parser.rs",
            include_bytes!("../src/utils/js_date/parser.rs").as_slice(),
        ),
        (
            "src/utils/json_number.rs",
            include_bytes!("../src/utils/json_number.rs").as_slice(),
        ),
        (
            "src/utils/js_string.rs",
            include_bytes!("../src/utils/js_string.rs").as_slice(),
        ),
        (
            "src/utils/moderation/spam.rs",
            include_bytes!("../src/utils/moderation/spam.rs").as_slice(),
        ),
        (
            "tests/moderation_chatter_schema.rs",
            include_bytes!("moderation_chatter_schema.rs").as_slice(),
        ),
        (
            "oracle-script",
            include_bytes!("fixtures/moderation_chatter_schema_reference.cjs").as_slice(),
        ),
        ("Cargo.toml", include_bytes!("../Cargo.toml").as_slice()),
        ("Cargo.lock", include_bytes!("../Cargo.lock").as_slice()),
        (
            "rust-toolchain.toml",
            include_bytes!("../rust-toolchain.toml").as_slice(),
        ),
        ("package.json", include_bytes!("../package.json").as_slice()),
        (
            "package-lock.json",
            include_bytes!("../package-lock.json").as_slice(),
        ),
    ] {
        assert_eq!(corpus["sourceSha256"][key], digest_bytes(bytes), "{key}");
    }
    for key in [
        "typescript-js",
        "typescript-package",
        "mongoose-js",
        "mongoose-package",
        "mongoose/index.js",
        "mongoose/lib/mongoose.js",
        "mongoose/lib/schema/string.js",
        "mongoose/lib/schema/date.js",
        "mongoose/lib/document.js",
        "mongoose/lib/helpers/clone.js",
        "bson-js",
        "bson-package",
    ] {
        let digest = corpus["sourceSha256"][key]
            .as_str()
            .unwrap_or_else(|| panic!("missing npm digest {key}"));
        assert_eq!(digest.len(), 64, "{key}");
        assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()), "{key}");
    }

    assert_eq!(corpus["sourceMetadata"]["typecheckDiagnostics"], 0);
    assert_eq!(corpus["sourceMetadata"]["typeDeclarations"], json!([]));
    assert_eq!(
        corpus["sourceMetadata"]["imports"],
        json!([{"module":"mongoose","typeOnly":false,"bindings":"{ Schema, model }"}])
    );
    assert_eq!(
        corpus["sourceMetadata"]["export"],
        json!({"kind":"VariableStatement","symbol":"ModerationChatter","initializer":"model","modelName":"moderation_chatter"})
    );
    assert_eq!(
        corpus["sourceMetadata"]["runtimeKeys"],
        json!(["ModerationChatter"])
    );

    assert_eq!(corpus["modelMetadata"]["modelName"], schema().model);
    assert_eq!(corpus["modelMetadata"]["collection"], schema().collection);
    assert_eq!(corpus["modelMetadata"]["versionKey"], json!(false));
    assert!(
        corpus["modelMetadata"]["indexes"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(corpus["modelMetadata"]["connectionReadyState"], 0);
    assert_eq!(
        corpus["modelMetadata"]["paths"],
        json!(["_id", "firstSeenAt"])
    );
    assert_eq!(
        corpus["modelMetadata"]["fields"],
        json!([
            {"path":"_id","instance":"String","required":true,"hasDefault":false},
            {"path":"firstSeenAt","instance":"Date","required":true,"hasDefault":false}
        ])
    );
    assert_eq!(corpus["constants"]["modelName"], schema().model);
    assert_eq!(corpus["constants"]["collection"], schema().collection);
    assert_eq!(corpus["constants"]["versionKey"], json!(false));
    assert_eq!(corpus["constants"]["indexCount"], 0);
    assert_eq!(corpus["constants"]["stringID"], json!(true));

    for case in corpus["cases"].as_array().unwrap() {
        let mut input: Document = mongodb::bson::serialize_to_document(&case["input"]).unwrap();
        dima_rust::utils::bson_compat::normalize_document(&mut input);
        let actual = match schema().construct(&input, DateTime::from_millis(0)) {
            Ok(document) => json!({"document":normalize(&Bson::Document(document))}),
            Err(errors) => {
                let mut fields: Vec<_> = errors
                    .0
                    .iter()
                    .map(|error| json!({"path":error.path,"kind":error.kind}))
                    .collect();
                fields.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
                json!({"errors":fields})
            }
        };
        assert_eq!(actual, case["expected"], "case {}", case["id"]);
    }

    let wire = doc! {
        "_id": JsString::from_units(vec![0xd800, b'x' as u16, 0xdc00]).to_utf8_lossy(),
        "firstSeenAt": DateTime::from_millis(1_735_689_600_123),
    };
    let hex: String = mongodb::bson::serialize_to_vec(&wire)
        .unwrap()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(corpus["wire"]["hex"], hex);
    assert_eq!(corpus["wire"]["decodedId"], "\u{fffd}x\u{fffd}");
    assert_eq!(corpus["wire"]["firstSeenAtMs"], 1_735_689_600_123_i64);
    assert_eq!(
        corpus["wire"]["maxDateMs"],
        DateTime::from_millis(8_640_000_000_000_000).timestamp_millis()
    );
    assert_eq!(
        corpus["wire"]["minDateMs"],
        DateTime::from_millis(-8_640_000_000_000_000).timestamp_millis()
    );

    println!(
        "{}",
        json!({"cases":corpus["metadata"]["caseCount"],"source":SOURCE,"boundary":"owned BSON values only"})
    );
}

fn digest_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

fn fixture_namespace() -> String {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_MONGO_URI").as_deref(),
        Ok("mongodb://keyword-mongo:27017")
    );
    let namespace = std::env::var("KEYWORD_FIXTURE_NAMESPACE").expect("fixture namespace");
    assert!(
        namespace.starts_with("keyword-fixture-")
            && namespace.ends_with(':')
            && (24..=50).contains(&namespace.len())
            && namespace
                .trim_end_matches(':')
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    );
    namespace
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn loopback_cache() -> resp::Endpoint {
    let seen = std::sync::Arc::new(std::sync::Mutex::new(
        std::collections::HashSet::<String>::new(),
    ));
    resp::Endpoint::new(move |command| match command[0].as_str() {
        "PING" => b"+PONG\r\n".to_vec(),
        "GET" => {
            let seen = seen.lock().unwrap();
            if seen.contains(&command[1]) {
                resp::bulk(Some("1"))
            } else {
                resp::bulk(None)
            }
        }
        "SET" => {
            seen.lock().unwrap().insert(command[1].clone());
            b"+OK\r\n".to_vec()
        }
        other => panic!("unexpected loopback cache command {other}"),
    })
}

async fn verify_owner(db: &mongodb::Database, namespace: &str) {
    let record = db
        .collection::<Document>("_owner")
        .find_one(doc! {"_id":"owner"})
        .await
        .unwrap()
        .expect("owner record");
    assert_eq!(record.get_str("owner").unwrap(), "dimabot-migration");
    assert_eq!(record.get_str("namespace").unwrap(), namespace);
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires an ownership-guarded disposable MongoDB fixture"]
async fn mongo_crud_and_atomic_first_seen() {
    use mongodb::event::{EventHandler, command::CommandEvent};
    use mongodb::{Client, Database, options::ClientOptions};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    let namespace = fixture_namespace();
    let suffix = mongodb::bson::oid::ObjectId::new().to_hex();
    let database_name = format!(
        "{}_chatter_{}",
        namespace.trim_end_matches(':').replace('-', "_"),
        &suffix[..8]
    );
    let updates = Arc::new(AtomicUsize::new(0));
    let recorded = updates.clone();
    let mut options = ClientOptions::parse("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    options.direct_connection = Some(true);
    options.retry_reads = Some(false);
    options.retry_writes = Some(false);
    options.command_event_handler = Some(EventHandler::callback(move |event: CommandEvent| {
        if let CommandEvent::Started(event) = event
            && event.command_name == "update"
        {
            recorded.fetch_add(1, Ordering::SeqCst);
        }
    }));
    let client = Client::with_options(options).unwrap();
    let db = client.database(&database_name);
    assert!(
        db.list_collection_names().await.unwrap().is_empty(),
        "fresh task-owned database required"
    );
    db.collection::<Document>("_owner")
        .insert_one(doc! {"_id":"owner","owner":"dimabot-migration","namespace":&namespace})
        .await
        .unwrap();

    let owned = db.clone();
    let body = tokio::spawn(async move {
        let db: Database = owned;
        let updates: Arc<AtomicUsize> = updates;
        let repo = get_moderation_chatter_model(&db);
        schema().install_indexes(&db).await.unwrap();
        assert!(
            !db.list_collection_names()
                .await
                .unwrap()
                .iter()
                .any(|name| name == schema().collection),
            "index installation must not create a collection for an index-free schema"
        );

        let now = DateTime::from_millis(1_700_000_000_000);
        let first_seen = DateTime::from_millis(1_700_000_000_123);
        let inserted = repo
            .insert(
                doc! {"_id":"crud-marker","firstSeenAt":first_seen,"ignored":"discard"},
                now,
            )
            .await
            .unwrap();
        assert_eq!(inserted.len(), 2);
        assert_eq!(inserted.get_str("_id").unwrap(), "crud-marker");
        assert_eq!(inserted.get_datetime("firstSeenAt").unwrap(), &first_seen);
        assert!(inserted.get("__v").is_none());
        assert_eq!(
            repo.find_one(doc! {"_id":"crud-marker"})
                .await
                .unwrap()
                .unwrap(),
            inserted
        );

        let updated_seen = DateTime::from_millis(1_700_000_000_456);
        let saved = repo
            .save(doc! {"_id":"crud-marker","firstSeenAt":updated_seen}, now)
            .await
            .unwrap();
        assert_eq!(saved.len(), 2);
        assert_eq!(saved.get_datetime("firstSeenAt").unwrap(), &updated_seen);
        assert_eq!(updates.load(Ordering::SeqCst), 1);

        match repo.insert(doc! {"firstSeenAt":first_seen}, now).await {
            Err(PersistenceError::Validation(errors)) => {
                assert_eq!(errors.0.len(), 1);
                assert_eq!(
                    (errors.0[0].path.as_str(), errors.0[0].kind),
                    ("_id", "required")
                );
            }
            other => panic!("expected required validation for an absent string _id, got {other:?}"),
        }
        let duplicate = match repo
            .insert(doc! {"_id":"crud-marker","firstSeenAt":first_seen}, now)
            .await
        {
            Err(PersistenceError::Mongo(error)) => error,
            other => panic!("expected a duplicate-key Mongo error, got {other:?}"),
        };
        assert!(
            matches!(duplicate.kind.as_ref(), ErrorKind::Write(WriteFailure::WriteError(error)) if error.code == 11000)
                || matches!(duplicate.kind.as_ref(), ErrorKind::Command(error) if error.code == 11000),
            "duplicate key: {duplicate}"
        );

        // Production first-seen primitive: real Mongo upsert, loopback RESP
        // cache only. A fresh endpoint starts with an empty cache.
        let channel = JsString::from("fixture-channel");
        let user = JsString::from("fixture-user");
        let marker_id = chatter_marker_id(&channel, &user);
        assert_eq!(marker_id.len(), 64);
        assert!(marker_id.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let endpoint = loopback_cache();
        let service = SpamService::new(db.clone(), endpoint.manager().await);
        let before = now_millis();
        assert!(
            service
                .claim_first_observed_message(&channel, &user)
                .await
                .unwrap()
        );
        let after = now_millis();
        assert_eq!(updates.load(Ordering::SeqCst), 2);
        assert_eq!(repo.collection.name(), schema().collection);

        let stored = repo
            .find_one_with_hidden(doc! {"_id":marker_id.as_str()})
            .await
            .unwrap()
            .expect("first-seen marker");
        assert_eq!(stored.len(), 2);
        assert!(stored.get("__v").is_none());
        let sealed = *stored.get_datetime("firstSeenAt").unwrap();
        assert!((before..=after).contains(&sealed.timestamp_millis()));

        // A second process with an empty cache but the same database must lose
        // the atomic primary-key insert and must not overwrite firstSeenAt.
        let second_endpoint = loopback_cache();
        let second_service = SpamService::new(db.clone(), second_endpoint.manager().await);
        assert!(
            !second_service
                .claim_first_observed_message(&channel, &user)
                .await
                .unwrap()
        );
        assert_eq!(updates.load(Ordering::SeqCst), 3);
        let repeated = repo
            .find_one_with_hidden(doc! {"_id":marker_id.as_str()})
            .await
            .unwrap()
            .unwrap();
        assert_eq!(repeated, stored);

        // A warm cache hit returns before Mongo; the update count is unchanged.
        assert!(
            !second_service
                .claim_first_observed_message(&channel, &user)
                .await
                .unwrap()
        );
        assert_eq!(updates.load(Ordering::SeqCst), 3);
        let calls = second_endpoint.calls.lock().unwrap().clone();
        assert_eq!(calls.iter().filter(|call| call[0] == "GET").count(), 2);
        assert_eq!(calls.iter().filter(|call| call[0] == "SET").count(), 1);

        // Per-chatter keys: a different user still claims its own first marker.
        let other_user = JsString::from("fixture-user-2");
        assert!(
            second_service
                .claim_first_observed_message(&channel, &other_user)
                .await
                .unwrap()
        );
        assert_eq!(updates.load(Ordering::SeqCst), 4);
        let other_id = chatter_marker_id(&channel, &other_user);
        assert_ne!(other_id, marker_id);
        let other = repo
            .find_one_with_hidden(doc! {"_id":other_id.as_str()})
            .await
            .unwrap()
            .expect("second marker");
        assert_eq!(other.len(), 2);
        assert_eq!(repo.collection.count_documents(doc! {}).await.unwrap(), 3);

        repo.collection
            .delete_one(doc! {"_id":"crud-marker"})
            .await
            .unwrap();
        assert!(
            repo.find_one(doc! {"_id":"crud-marker"})
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(db.name(), database_name.as_str());
    });

    let outcome = body.await;
    let cleanup = async {
        verify_owner(&db, &namespace).await;
        db.drop().await
    }
    .await;
    cleanup.expect("task-owned database cleanup");
    outcome.expect("fixture body must not panic");
}
