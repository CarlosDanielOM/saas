#![cfg(feature = "application-schemas")]
//! Source-backed additional schema parity. All execution belongs to the
//! lead's capped compiler, with task-owned MongoDB for the ignored adapter case.
use dima_rust::schemas::{self, SchemaDefinition};
use mongodb::bson::{Bson, DateTime, Document, doc};
use serde_json::{Value, json};

#[path = "support/schema_source.rs"]
mod schema_source;
const NAMES: [&str; 24] = [
    "ai_usage_daily",
    "ai_usage_dashboard",
    "ai_usage_ledger_state",
    "ai_usage_receipt",
    "ast_variables",
    "chat_logs",
    "command_timer",
    "command_user_variables",
    "countdown_timer",
    "countdown_timer_config",
    "custom_timer",
    "dashboard_activity",
    "dashboard_insights",
    "domain_event",
    "domain_event_checkpoint",
    "domain_event_delivery",
    "raid_analytics",
    "raid_session",
    "raid_subscription_preference",
    "stream_activity",
    "stream_session",
    "stream_subscription_ledger",
    "stream_timeline",
    "stream_viewer_snapshot",
];
fn fixture() -> Value {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for (logical, _) in schema_source::PINS.iter().skip(9).take(5) {
        schema_source::archived(root, logical);
    }
    if let Some(dir) = std::env::var_os("DIMA_ADDITIONAL_SCHEMAS_FIXTURE_DIR") {
        let dir = std::path::PathBuf::from(dir);
        assert!(dir.is_absolute());
        assert_eq!(dir.canonicalize().unwrap(), dir);
        assert!(!dir.starts_with(root.canonicalize().unwrap()));
        let file = dir.join("additional-schemas-reference.json");
        assert!(
            std::fs::symlink_metadata(&file)
                .unwrap()
                .file_type()
                .is_file()
        );
        let bytes = std::fs::read(file).unwrap();
        assert_eq!(
            schema_source::sha256(&bytes),
            std::env::var("DIMA_ADDITIONAL_SCHEMAS_FIXTURE_SHA256")
                .expect("independent fixture digest")
        );
        let data: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            data["nodeExecutableSha256"],
            "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
        );
        for (key, value) in [
            ("node", "24.22.1"),
            ("v8", "13.6.233.17-node.58"),
            ("icu", "78.3"),
            ("unicode", "17.0"),
            ("typescript", "5.9.3"),
            ("mongoose", "8.24.2"),
        ] {
            assert_eq!(data["versions"][key], value);
        }
        assert_eq!(data["sources"].as_object().unwrap().len(), NAMES.len());
        assert_eq!(data["sourceProvenance"].as_object().unwrap().len(), 5);
        for name in NAMES {
            let logical = format!("src/schemas/{name}.schema.ts");
            let bytes = if schema_source::PINS
                .iter()
                .skip(9)
                .take(5)
                .any(|(id, _)| *id == logical)
            {
                assert_eq!(
                    data["sourceProvenance"][name],
                    schema_source::provenance(&logical)
                );
                schema_source::archived(root, &logical)
            } else {
                std::fs::read(root.join(&logical)).unwrap()
            };
            assert_eq!(
                data["sources"][name],
                schema_source::sha256(&bytes),
                "{name}"
            );
        }
        let files = data["nativeSha256"].as_object().unwrap();
        let mut expected: Vec<String> = NAMES
            .iter()
            .map(|name| format!("src/schemas/{name}.schema.rs"))
            .collect();
        expected.extend(
            [
                "src/schemas/schema.rs",
                "src/schemas/mod.rs",
                "src/utils/bson_compat.rs",
                "src/utils/mongoose_date.rs",
                "src/utils/js_string.rs",
                "tests/additional_schemas.rs",
                "tests/support/schema_source.rs",
                "tests/support/sha256.rs",
                "tests/fixtures/schema_source_resolver.cjs",
                "tests/fixtures/additional_schemas_reference.mjs",
                "Cargo.toml",
                "Cargo.lock",
                "rust-toolchain.toml",
                "package.json",
                "package-lock.json",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
        assert_eq!(files.len(), expected.len());
        for file in expected {
            assert_eq!(
                files[&file],
                schema_source::sha256(&std::fs::read(root.join(&file)).unwrap()),
                "{file}"
            );
        }
        data
    } else {
        serde_json::from_str(include_str!("fixtures/additional_schemas_cases.json"))
            .expect("source-backed additional schema corpus")
    }
}
fn definition(model: &str) -> &'static SchemaDefinition {
    schemas::by_model(model).unwrap_or_else(|| panic!("register native schema {model}"))
}
fn bson(value: &Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(value) => Bson::Boolean(*value),
        Value::String(value) => Bson::String(value.clone()),
        Value::Number(value) => dima_rust::utils::bson_compat::js_number(value.as_f64().unwrap()),
        Value::Array(values) => Bson::Array(values.iter().map(bson).collect()),
        Value::Object(values) => Bson::Document(
            values
                .iter()
                .map(|(key, value)| (key.clone(), bson(value)))
                .collect(),
        ),
    }
}
fn normalized(value: &Bson, input: Option<&Value>) -> Value {
    match value {
        Bson::ObjectId(id) => {
            json!({"$oid":if input.is_none() {"generated".to_owned()} else {id.to_hex()}})
        }
        Bson::DateTime(value) => json!({"$date":value.timestamp_millis()}),
        Bson::Document(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        normalized(value, input.and_then(|input| input.get(key))),
                    )
                })
                .collect(),
        ),
        Bson::Array(values) => Value::Array(
            values
                .iter()
                .enumerate()
                .map(|(index, value)| normalized(value, input.and_then(|input| input.get(index))))
                .collect(),
        ),
        Bson::Null => Value::Null,
        Bson::Boolean(value) => json!(value),
        Bson::String(value) => json!(value),
        Bson::Int32(value) => json!(value),
        Bson::Int64(value) => json!(value),
        Bson::Double(value) => json!(value),
        other => panic!("unsupported fixture BSON {other:?}"),
    }
}
fn equivalent(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| equivalent(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right.get(key).is_some_and(|right| equivalent(value, right))
                })
        }
        _ => left == right,
    }
}

#[test]
fn additional_schema_construction_matches_source_defaults_casts_and_validation() {
    let data = fixture();
    let now = DateTime::from_millis(data["fixedNow"].as_i64().unwrap());
    assert_eq!(
        data["timeZone"], "UTC",
        "generate and execute local-calendar parity under explicit fixture UTC"
    );
    for (index, case) in data["cases"].as_array().unwrap().iter().enumerate() {
        let schema = definition(case["model"].as_str().unwrap());
        let input_value = &case["input"];
        let input = bson(input_value).as_document().unwrap().clone();
        let actual = match schema.construct(&input, now) {
            Ok(document) => {
                json!({"document":normalized(&Bson::Document(document),Some(input_value))})
            }
            Err(errors) => {
                let mut errors: Vec<_> = errors
                    .0
                    .into_iter()
                    .map(|error| json!({"path":error.path,"kind":error.kind}))
                    .collect();
                errors.sort_by(|left, right| {
                    left["path"]
                        .as_str()
                        .unwrap()
                        .cmp(right["path"].as_str().unwrap())
                });
                json!({"errors":errors})
            }
        };
        assert!(
            equivalent(&actual, &case["expected"]),
            "model {} case {index}\nactual: {actual}\nexpected: {}",
            case["model"],
            case["expected"]
        );
    }
}

#[test]
fn additional_schema_collection_index_and_write_contracts_match_source() {
    let data = fixture();
    assert_eq!(data["definitions"].as_object().unwrap().len(), 31);
    for (model, expected) in data["definitions"].as_object().unwrap() {
        let schema = definition(model);
        assert_eq!(
            schema.collection, expected["collection"],
            "{model} collection"
        );
        assert_eq!(schema.string_id, expected["stringId"], "{model} id type");
        assert_eq!(
            schema.version_key, expected["versionKey"],
            "{model} version key"
        );
        assert_eq!(
            schema.write_concern_journaled, expected["journaled"],
            "{model} durability"
        );
        let mut hidden: Vec<_> = schema.default_projection().keys().cloned().collect();
        hidden.sort();
        assert_eq!(json!(hidden), expected["hidden"], "{model} hidden fields");
        let mut immutable: Vec<_> = schema
            .fields
            .iter()
            .filter(|field| field.immutable)
            .map(|field| field.name)
            .chain(schema.timestamps.map(|(created, _)| created))
            .collect();
        immutable.sort_unstable();
        immutable.dedup();
        assert_eq!(
            json!(immutable),
            expected["immutable"],
            "{model} immutable fields"
        );
        let indexes:Vec<_>=schema.indexes.iter().map(|index|json!({
            "keys":normalized(&Bson::Document(index.keys.clone()),None),
            "keyOrder":index.keys.keys().collect::<Vec<_>>(),
            "unique":index.unique,"sparse":index.sparse,
            "ttl":index.ttl.map(|duration|duration.as_secs()),
            "partial":index.partial.as_ref().map(|filter|normalized(&Bson::Document(filter.clone()),None)),
        })).collect();
        assert_eq!(json!(indexes), expected["indexes"], "{model} indexes");
    }
}

/// This checks actual Mongo index definitions and repository semantics in a
/// private fixture database. TTL timing itself is not asserted: Mongo's TTL
/// monitor is asynchronous, while expireAfterSeconds:0 is verified directly.
#[tokio::test]
#[ignore = "requires lead-owned disposable MongoDB fixture"]
async fn additional_schema_native_indexes_conditions_immutability_and_maps() {
    use futures_util::TryStreamExt;
    use mongodb::{Client, bson::oid::ObjectId};
    let uri =
        std::env::var("APPLICATION_SCHEMAS_TEST_MONGO_URI").expect("explicit task-owned Mongo URI");
    let name =
        std::env::var("ADDITIONAL_SCHEMAS_TEST_DATABASE").expect("explicit task-owned Mongo DB");
    assert!(name.starts_with("rust_additional_schema_fixture_"));
    let client = Client::with_uri_str(&uri).await.unwrap();
    let database = client.database(&name);
    assert!(
        database.list_collection_names().await.unwrap().is_empty(),
        "task database must be fresh"
    );
    let now = DateTime::from_millis(1_900_000_000_000);
    let data = fixture();
    for model in data["definitions"].as_object().unwrap().keys() {
        definition(model).install_indexes(&database).await.unwrap();
    }
    let ledger = definition("stream_subscription_ledger").repository(&database);
    let input = doc! {"streamer_id":"channel","user_id":"user"};
    let first = ledger.insert(input.clone(), now).await.unwrap();
    assert!(
        ledger.insert(input.clone(), now).await.is_err(),
        "partial active index prevents two active subscriptions"
    );
    ledger
        .insert(
            doc! {"streamer_id":"channel","user_id":"user","status":"ended"},
            now,
        )
        .await
        .unwrap();
    let id = first.get("_id").unwrap().clone();
    let loaded = ledger
        .find_one(doc! {"_id":id.clone()})
        .await
        .unwrap()
        .unwrap();
    assert!(!loaded.contains_key("applied_event_keys"));
    let events = definition("domain_event").repository(&database);
    let event = doc! {"eventKey":"fixture:event:type","source":"fixture","sourceEventId":"event","type":"fixture.event","topic":"channel","channelID":"channel","occurredAt":now,"payload":{"value":1},"expiresAt":DateTime::from_millis(now.timestamp_millis()+86_400_000)};
    let original = events.insert(event, now).await.unwrap();
    let mut changed = original.clone();
    changed.insert("topic", "invalid");
    changed.insert("payload", doc! {"changed":true});
    changed.insert("dispatchPending", true);
    let saved = events.save(changed, now).await.unwrap();
    assert_eq!(saved.get_str("topic").unwrap(), "channel");
    assert_eq!(
        saved.get_document("payload").unwrap(),
        original.get_document("payload").unwrap()
    );
    assert!(saved.get_bool("dispatchPending").unwrap());
    assert!(events.insert(doc! {"eventKey":"fixture:missing:type","source":"fixture","sourceEventId":"missing","type":"fixture.event","topic":"channel","occurredAt":now,"payload":{"value":1},"expiresAt":now},now).await.is_err(),"channel topic must carry channelID");
    let variables = definition("CommandUserVariables").repository(&database);
    let document=variables.insert(doc! {"commandId":ObjectId::new(),"channelID":"channel","userId":"user","variables":{"value":42}},now).await.unwrap();
    assert_eq!(
        document
            .get_document("variables")
            .unwrap()
            .get_str("value")
            .unwrap(),
        "42"
    );
    let persisted = variables
        .find_one(doc! {"_id":document.get("_id").unwrap().clone()})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        persisted
            .get_document("variables")
            .unwrap()
            .get_str("value")
            .unwrap(),
        "42"
    );
    for model in [
        "domain_event",
        "stream_participant",
        "stream_marker",
        "raid_session",
    ] {
        let schema = definition(model);
        let indexes: Vec<_> = database
            .collection::<Document>(schema.collection)
            .list_indexes()
            .await
            .unwrap()
            .try_collect()
            .await
            .unwrap();
        assert!(
            indexes.iter().any(|index| index
                .options
                .as_ref()
                .and_then(|options| options.expire_after)
                == Some(std::time::Duration::ZERO)),
            "{model} TTL index"
        );
    }
    database.drop().await.unwrap();
}
