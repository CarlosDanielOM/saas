#![cfg(feature = "moderation-action-log-schema")]
use dima_rust::schemas::moderation_action_log::{get_moderation_action_log_model, schema};
use mongodb::bson::{Bson, DateTime, Document, doc};
use serde_json::{Value, json};

fn base() -> Document {
    doc! {"_id":"0123456789abcdef01234567","channelID":"c","userID":"u","ruleID":"r","ruleType":"t","action":"warn"}
}
#[test]
fn defaults_required_enum_and_utf16() {
    let now = DateTime::from_millis(1700000000000);
    let d = schema().construct(&base(), now).unwrap();
    assert_eq!(d.get_i32("offenseNumber").unwrap(), 1);
    assert_eq!(d.get_str("username").unwrap(), "");
    assert!(!d.get_bool("success").unwrap());
    assert_eq!(d.get("errorMessage"), Some(&Bson::Null));
    assert_eq!(d.get_datetime("createdAt").unwrap(), &now);
    assert!(!d.contains_key("__v"));
    assert_eq!(
        schema()
            .prepare_insert(base(), now)
            .unwrap()
            .get_i32("__v")
            .unwrap(),
        0
    );
    let mut bad = base();
    bad.insert("action", "invalid");
    assert!(schema().construct(&bad, now).is_err());
    bad.insert("action", "ban");
    bad.insert("messageExcerpt", "😀".repeat(101));
    assert!(schema().construct(&bad, now).is_err());
    bad.insert("messageExcerpt", "😀".repeat(100));
    assert!(schema().construct(&bad, now).is_ok());
    bad.insert("userID", "");
    assert!(schema().construct(&bad, now).is_err());
    assert_eq!(schema().collection, "moderation_action_logs");
    assert_eq!(schema().indexes[0].keys, doc! {"channelID":1});
    assert_eq!(schema().indexes[1].ttl.unwrap().as_secs(), 2_592_000);
}
fn normalize(v: &Bson) -> Value {
    match v {
        Bson::DateTime(d) => json!({"$date":d.timestamp_millis()}),
        Bson::ObjectId(id) => json!({"$oid":id.to_hex()}),
        Bson::Document(d) => {
            Value::Object(d.iter().map(|(k, v)| (k.clone(), normalize(v))).collect())
        }
        Bson::Array(a) => Value::Array(a.iter().map(normalize).collect()),
        v => serde_json::to_value(v).unwrap(),
    }
}
#[test]
#[ignore = "requires external independently hashed pinned source oracle"]
fn replay_actual_mongoose_source() {
    use sha2::{Digest, Sha256};
    let dir = std::path::PathBuf::from(
        std::env::var_os("DIMA_ACTION_LOG_SCHEMA_FIXTURE_DIR").expect("fixture directory"),
    );
    assert!(dir.is_absolute());
    assert_eq!(dir.canonicalize().unwrap(), dir);
    assert!(
        !dir.starts_with(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .canonicalize()
                .unwrap()
        )
    );
    let bytes = std::fs::read(dir.join("moderation-action-log-schema-reference.json")).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        std::env::var("DIMA_ACTION_LOG_SCHEMA_FIXTURE_SHA256").expect("independent digest")
    );
    let corpus: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        corpus["nodeExecutableSha256"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    for (k, v) in [
        ("node", "24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("icu", "78.3"),
        ("unicode", "17.0"),
        ("typescript", "5.9.3"),
        ("mongoose", "8.24.2"),
        ("bson", "6.10.4"),
    ] {
        assert_eq!(corpus["versions"][k], v);
    }
    for (k, b) in [
        (
            "src/schemas/moderation_action_log.schema.ts",
            include_bytes!("../src/schemas/moderation_action_log.schema.ts").as_slice(),
        ),
        (
            "src/schemas/moderation_action_log.schema.rs",
            include_bytes!("../src/schemas/moderation_action_log.schema.rs").as_slice(),
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
            "oracle-script",
            include_bytes!("fixtures/moderation_action_log_schema_reference.cjs").as_slice(),
        ),
        (
            "tests/moderation_action_log_schema.rs",
            include_bytes!("moderation_action_log_schema.rs").as_slice(),
        ),
        (
            "src/schemas/channel_moderation_settings.schema.rs",
            include_bytes!("../src/schemas/channel_moderation_settings.schema.rs").as_slice(),
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
        assert_eq!(
            corpus["sourceSha256"][k],
            format!("{:x}", Sha256::digest(b))
        );
    }
    assert_eq!(corpus["model"], schema().model);
    assert_eq!(corpus["collection"], schema().collection);
    assert_eq!(corpus["indexes"][0][0], json!(schema().indexes[0].keys));
    assert_eq!(corpus["indexes"][1][0], json!(schema().indexes[1].keys));
    assert_eq!(corpus["indexes"][0][1], json!({"background":true}));
    assert_eq!(
        corpus["indexes"][1][1],
        json!({"expireAfterSeconds":2_592_000,"background":true})
    );
    for case in corpus["cases"].as_array().unwrap() {
        let mut input: Document = mongodb::bson::serialize_to_document(&case["input"]).unwrap();
        dima_rust::utils::bson_compat::normalize_document(&mut input);
        let actual = match schema().construct(
            &input,
            DateTime::from_millis(corpus["now"].as_i64().unwrap()),
        ) {
            Ok(d) => json!({"document":normalize(&Bson::Document(d))}),
            Err(e) => {
                let mut errors: Vec<_> =
                    e.0.iter()
                        .map(|x| json!({"path":x.path,"kind":x.kind}))
                        .collect();
                errors.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
                json!({"errors":errors})
            }
        };
        assert_eq!(actual, case["expected"], "case {case}");
    }
    let wire = doc! {"text":dima_rust::utils::js_string::JsString::from_units(vec![0xd800,b'x' as u16,0xdc00]).to_utf8_lossy()};
    let hex: String = mongodb::bson::serialize_to_vec(&wire)
        .unwrap()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(corpus["wire"]["hex"], hex);
    assert_eq!(corpus["wire"]["text"], "�x�");
}
#[tokio::test]
#[ignore = "requires task-owned keyword Mongo fixture"]
async fn mongo_crud_and_indexes() {
    use futures_util::TryStreamExt;
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_MONGO_URI").as_deref(),
        Ok("mongodb://keyword-mongo:27017")
    );
    let ns = std::env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
    assert!(
        ns.starts_with("keyword-fixture-")
            && ns.ends_with(':')
            && (24..=50).contains(&ns.len())
            && ns
                .trim_end_matches(':')
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    );
    let client = mongodb::Client::with_uri_str("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    let suffix = mongodb::bson::oid::ObjectId::new().to_hex();
    let name = format!(
        "{}_action_{}",
        ns.trim_end_matches(':').replace('-', "_"),
        &suffix[..8]
    );
    let db = client.database(&name);
    assert!(db.list_collection_names().await.unwrap().is_empty());
    let owned = db.clone();
    let result = tokio::spawn(async move {
        let repo = get_moderation_action_log_model(&owned);
        assert!(owned.list_collection_names().await.unwrap().is_empty());
        schema().install_indexes(&owned).await.unwrap();
        let now = DateTime::from_millis(4102444800000);
        let inserted = repo.insert(base(), now).await.unwrap();
        let id = inserted.get_object_id("_id").unwrap();
        assert_eq!(
            repo.find_one(doc! {"_id":id})
                .await
                .unwrap()
                .unwrap()
                .get_str("action")
                .unwrap(),
            "warn"
        );
        let mut update = inserted;
        update.insert("action", "ban");
        repo.save(update, now).await.unwrap();
        assert_eq!(
            repo.find_one(doc! {"_id":id})
                .await
                .unwrap()
                .unwrap()
                .get_str("action")
                .unwrap(),
            "ban"
        );
        let indexes: Vec<_> = repo
            .collection
            .list_indexes()
            .await
            .unwrap()
            .try_collect()
            .await
            .unwrap();
        for expected in &schema().indexes {
            assert!(indexes.iter().any(|i| i.keys == expected.keys
                && i.options.as_ref().and_then(|o| o.expire_after) == expected.ttl));
        }
        repo.collection.delete_one(doc! {"_id":id}).await.unwrap();
        assert!(repo.find_one(doc! {"_id":id}).await.unwrap().is_none());
    })
    .await;
    db.drop().await.expect("drop task-owned database");
    result.expect("fixture task failed");
}
