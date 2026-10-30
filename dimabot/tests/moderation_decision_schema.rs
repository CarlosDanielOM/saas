#![cfg(feature = "moderation-decision-schema")]
use dima_rust::schemas::moderation_decision::{get_moderation_decision_model, schema};
use mongodb::bson::{Bson, DateTime, Document, doc};
use serde_json::{Value, json};

#[test]
fn constructor_defaults_validation_and_indexes() {
    let now = DateTime::from_millis(1700000000000);
    let expiry = DateTime::from_millis(1800000000000);
    let d = schema().construct(&doc! {"channelID":"c", "expiresAt":expiry, "mode":"anything", "state":"other", "verdict":"other"}, now).unwrap();
    assert_eq!(d.get_datetime("createdAt").unwrap(), &now);
    assert_eq!(d.get_str("reviewSource").unwrap(), "rule");
    assert_eq!(d.get_str("state").unwrap(), "other");
    assert_eq!(d.get_str("verdict").unwrap(), "other");
    assert_eq!(d.get_array("matches").unwrap().len(), 0);
    assert_eq!(
        d.get_document("charge").unwrap().get_str("status").unwrap(),
        "none"
    );
    assert!(
        schema()
            .construct(
                &doc! {"channelID":"c", "expiresAt":expiry, "reviewSource":"invalid"},
                now
            )
            .is_err()
    );
    assert!(
        schema()
            .construct(&doc! {"channelID":"", "expiresAt":expiry}, now)
            .is_err()
    );
    assert_eq!(schema().collection, "moderation_decisions");
    assert_eq!(schema().indexes.len(), 4);
    assert_eq!(schema().indexes[0].ttl.unwrap().as_secs(), 0);
    assert_eq!(
        schema().indexes[2].keys,
        doc! {"state":1,"deadline":1,"createdAt":1}
    );
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
#[ignore = "requires pinned external Mongoose oracle"]
fn replay_actual_source() {
    use sha2::{Digest, Sha256};
    let dir = std::path::PathBuf::from(
        std::env::var_os("DIMA_DECISION_SCHEMA_FIXTURE_DIR").expect("fixture directory"),
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
    let bytes = std::fs::read(dir.join("moderation-decision-schema-reference.json")).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        std::env::var("DIMA_DECISION_SCHEMA_FIXTURE_SHA256").unwrap()
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
    for (file, bytes) in [
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
            "src/schemas/channel_moderation_settings.schema.ts",
            include_bytes!("../src/schemas/channel_moderation_settings.schema.ts").as_slice(),
        ),
        (
            "src/utils/moderation/advanced.ts",
            include_bytes!("../src/utils/moderation/advanced.ts").as_slice(),
        ),
        (
            "src/utils/moderation/variations.ts",
            include_bytes!("../src/utils/moderation/variations.ts").as_slice(),
        ),
        (
            "src/utils/moderation/spam_categories.ts",
            include_bytes!("../src/utils/moderation/spam_categories.ts").as_slice(),
        ),
        (
            "src/utils/permissions/expression.ts",
            include_bytes!("../src/utils/permissions/expression.ts").as_slice(),
        ),
        (
            "src/utils/permissions/roles.ts",
            include_bytes!("../src/utils/permissions/roles.ts").as_slice(),
        ),
        (
            "src/utils/bson_compat.rs",
            include_bytes!("../src/utils/bson_compat.rs").as_slice(),
        ),
        (
            "src/utils/mongoose_date.rs",
            include_bytes!("../src/utils/mongoose_date.rs").as_slice(),
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
        (
            "tests/moderation_decision_schema.rs",
            include_bytes!("moderation_decision_schema.rs").as_slice(),
        ),
        (
            "oracle-script",
            include_bytes!("fixtures/moderation_decision_schema_reference.cjs").as_slice(),
        ),
    ] {
        assert_eq!(
            corpus["sourceSha256"][file],
            format!("{:x}", Sha256::digest(bytes))
        );
    }
    assert_eq!(corpus["collection"], schema().collection);
    for (i, index) in schema().indexes.iter().enumerate() {
        assert_eq!(corpus["indexes"][i][0], json!(index.keys));
    }
    assert_eq!(corpus["indexes"][0][1]["expireAfterSeconds"], 0);
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
        assert_eq!(actual, case["expected"], "{case}");
    }
}
#[tokio::test]
#[ignore = "requires explicitly task-owned disposable MongoDB"]
async fn mongo_crud_and_indexes() {
    use futures_util::TryStreamExt;
    let uri = std::env::var("DIMA_DECISION_SCHEMA_MONGO_URI").unwrap();
    let db_name = std::env::var("DIMA_DECISION_SCHEMA_DATABASE").unwrap();
    let owner = std::env::var("DIMA_DECISION_SCHEMA_OWNER").unwrap();
    assert!((12..=32).contains(&owner.len()) && owner.bytes().all(|c| c.is_ascii_alphanumeric()));
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    assert_eq!(db_name, format!("rust_decision_fixture_{owner}"));
    assert!(
        (uri == "mongodb://keyword-mongo:27017" || uri.starts_with("mongodb://127.0.0.1:"))
            && !uri.contains('@')
            && !uri.contains(',')
    );
    let client = mongodb::Client::with_uri_str(uri).await.unwrap();
    let db = client.database(&db_name);
    let repo = get_moderation_decision_model(&db);
    schema().install_indexes(&db).await.unwrap();
    let now = DateTime::from_millis(1700000000000);
    let expiry = DateTime::from_millis(4102444800000);
    repo.insert(
        doc! {"_id":&owner,"channelID":"c","expiresAt":expiry,"rule":{"nested":{},"keep":1}},
        now,
    )
    .await
    .unwrap();
    let saved = repo
        .save(
            doc! {"_id":&owner,"state":"processing","charge":{"status":"pending","credits":2}},
            now,
        )
        .await
        .unwrap();
    assert_eq!(saved.get_str("state").unwrap(), "processing");
    assert_eq!(
        repo.find_one(doc! {"_id":&owner})
            .await
            .unwrap()
            .unwrap()
            .get_document("charge")
            .unwrap()
            .get_str("status")
            .unwrap(),
        "pending"
    );
    assert!(
        repo.insert(doc! {"_id":"bad","channelID":"c"}, now)
            .await
            .is_err()
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
    repo.collection
        .delete_one(doc! {"_id":&owner})
        .await
        .unwrap();
    assert!(repo.find_one(doc! {"_id":&owner}).await.unwrap().is_none());
}
