#![cfg(feature = "moderation-variation-storage")]
use dima_rust::schemas::moderation_variation::{
    cache_schema, generated_variation_from_bson, generated_variation_to_bson, job_schema,
};
use dima_rust::utils::{
    js_string::JsString,
    moderation::types::{GeneratedVariation, ModerationPattern, PatternBoundary},
};
use mongodb::bson::{Bson, DateTime, Document, doc};
use serde_json::{Value, json};

#[test]
fn definitions_defaults_casts_and_mixed() {
    let now = DateTime::from_millis(0);
    let cache = cache_schema()
        .construct(&doc! {"_id":"x", "entry": {"term":"x"}, "other":1}, now)
        .unwrap();
    assert_eq!(cache, doc! {"_id":"x", "entry":{"term":"x"}});
    let job = job_schema()
        .construct(
            &doc! {"terms":"a", "state":"other", "attempts":"2", "providerUsage":7},
            now,
        )
        .unwrap();
    assert_eq!(
        job.get_array("terms").unwrap(),
        &vec![Bson::String("a".into())]
    );
    assert_eq!(job.get_array("entries").unwrap().len(), 0);
    assert_eq!(job.get_str("state").unwrap(), "other");
    assert_eq!(job.get_i32("attempts").unwrap(), 2);
    assert_eq!(job.get_i32("providerUsage").unwrap(), 7);
    assert_eq!(job.get_str("error").unwrap(), "");
    assert_eq!(job.get_i32("creditsCharged").unwrap(), 0);
    assert_eq!(
        job_schema()
            .construct(&doc! {"providerUsage":Bson::Null}, now)
            .unwrap()
            .get("providerUsage"),
        Some(&Bson::Null)
    );
    assert!(
        job_schema()
            .construct(&doc! {"attempts":"invalid"}, now)
            .is_err()
    );
    assert!(!job_schema().version_key);
    assert_eq!(cache_schema().collection, "moderation_variation_caches");
    assert_eq!(job_schema().collection, "moderation_variation_jobs");
    assert_eq!(job_schema().indexes[0].keys, doc! {"state":1,"createdAt":1});
    assert_eq!(job_schema().indexes[1].ttl.unwrap().as_secs(), 0);
}
#[test]
fn shared_generated_variation_uses_node_utf8_boundary() {
    let v = GeneratedVariation {
        term: JsString::from_units(vec![0xd800, b'x' as u16]),
        spellings: vec!["é😀".into()],
        pattern: ModerationPattern {
            id: "id".into(),
            source: "source".into(),
            boundary: PatternBoundary::WholeWord,
            ignore_case: true,
        },
        version: "v".into(),
        allow_spaces: Some(false),
        symbol_version: None,
    };
    let bson = generated_variation_to_bson(&v);
    let result = generated_variation_from_bson(&bson).unwrap();
    assert_eq!(result.term.as_str(), Some("�x"));
    assert_eq!(result.pattern, v.pattern);
    assert_eq!(result.spellings, v.spellings);
}
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
#[ignore = "requires external pinned Mongoose oracle"]
fn replay_actual_mongoose_source() {
    use sha2::{Digest, Sha256};
    let dir = std::path::PathBuf::from(
        std::env::var_os("DIMA_VARIATION_SCHEMA_FIXTURE_DIR").expect("fixture directory"),
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
    let bytes = std::fs::read(dir.join("moderation-variation-schema-reference.json")).unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    assert_eq!(
        digest,
        std::env::var("DIMA_VARIATION_SCHEMA_FIXTURE_SHA256").expect("fixture digest")
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
            "src/schemas/moderation_variation.schema.ts",
            include_bytes!("../src/schemas/moderation_variation.schema.ts").as_slice(),
        ),
        (
            "src/schemas/moderation_variation.schema.rs",
            include_bytes!("../src/schemas/moderation_variation.schema.rs").as_slice(),
        ),
        (
            "tests/moderation_variation_schema.rs",
            include_bytes!("moderation_variation_schema.rs").as_slice(),
        ),
        (
            "tests/fixtures/moderation_variation_schema_reference.cjs",
            include_bytes!("fixtures/moderation_variation_schema_reference.cjs").as_slice(),
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
            "src/utils/moderation/types.rs",
            include_bytes!("../src/utils/moderation/types.rs").as_slice(),
        ),
        (
            "src/utils/js_string.rs",
            include_bytes!("../src/utils/js_string.rs").as_slice(),
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
        let key = if file.starts_with("tests/fixtures/") {
            "oracle-script"
        } else {
            file
        };
        assert_eq!(
            corpus["sourceSha256"][key],
            format!("{:x}", Sha256::digest(bytes))
        );
    }
    assert_eq!(corpus["collections"]["cache"], cache_schema().collection);
    assert_eq!(corpus["collections"]["job"], job_schema().collection);
    assert_eq!(
        corpus["indexes"]["cache"][0][0],
        json!(cache_schema().indexes[0].keys)
    );
    assert_eq!(
        corpus["indexes"]["job"][0][0],
        json!(job_schema().indexes[0].keys)
    );
    assert_eq!(corpus["indexes"]["job"][1][1]["expireAfterSeconds"], 0);
    let wire = doc! {
        "text": JsString::from_units(vec![0xd800, b'x' as u16, 0xdc00]).to_utf8_lossy(),
        "nested": {
            "n": dima_rust::utils::bson_compat::js_number(1.0),
            "fraction": dima_rust::utils::bson_compat::js_number(1.5),
            "wide": dima_rust::utils::bson_compat::js_number(2147483648.0),
        },
        "negativeZero": dima_rust::utils::bson_compat::js_number(-0.0),
    };
    let encoded = mongodb::bson::serialize_to_vec(&wire).unwrap();
    let hex: String = encoded.iter().map(|byte| format!("{byte:02x}")).collect();
    assert_eq!(corpus["wire"]["hex"], hex);
    assert_eq!(corpus["wire"]["text"], "�x�");
    assert_eq!(corpus["wire"]["types"]["n"], "Int32");
    assert_eq!(corpus["wire"]["types"]["fraction"], "Double");
    assert_eq!(corpus["wire"]["types"]["wide"], "Double");
    assert_eq!(corpus["wire"]["types"]["negativeZero"], "Double");
    assert_eq!(corpus["cases"].as_array().unwrap().len(), 42);
    for case in corpus["cases"].as_array().unwrap() {
        let schema = if case["model"] == "cache" {
            cache_schema()
        } else {
            job_schema()
        };
        let mut input: Document = mongodb::bson::serialize_to_document(&case["input"]).unwrap();
        dima_rust::utils::bson_compat::normalize_document(&mut input);
        let actual = match schema.construct(&input, DateTime::from_millis(0)) {
            Ok(doc) => json!({"document":normalize(&Bson::Document(doc))}),
            Err(e) => {
                let mut errors: Vec<_> =
                    e.0.iter()
                        .map(|v| json!({"path":v.path,"kind":v.kind}))
                        .collect();
                errors.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
                json!({"errors":errors})
            }
        };
        assert_eq!(actual, case["expected"], "case {case}");
    }
}

#[tokio::test]
#[ignore = "requires explicitly task-owned disposable MongoDB"]
async fn mongo_crud_and_indexes() {
    use futures_util::TryStreamExt;
    let uri = std::env::var("DIMA_VARIATION_SCHEMA_MONGO_URI").expect("fixture URI");
    let db_name = std::env::var("DIMA_VARIATION_SCHEMA_DATABASE").expect("fixture database");
    let owner = std::env::var("DIMA_VARIATION_SCHEMA_OWNER").expect("task owner");
    assert!((12..=32).contains(&owner.len()) && owner.bytes().all(|c| c.is_ascii_alphanumeric()));
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    assert_eq!(db_name, format!("rust_variation_fixture_{owner}"));
    assert!(
        (uri == "mongodb://keyword-mongo:27017" || uri.starts_with("mongodb://127.0.0.1:"))
            && !uri.contains('@')
            && !uri.contains(',')
    );
    let client = mongodb::Client::with_uri_str(uri).await.unwrap();
    let db = client.database(&db_name);
    for schema in [cache_schema(), job_schema()] {
        schema.install_indexes(&db).await.unwrap();
        let repo = schema.repository(&db);
        let now = DateTime::from_millis(1000);
        repo.insert(doc! {"_id":&owner,"channelID":"test"}, now)
            .await
            .unwrap();
        assert_eq!(
            repo.find_one(doc! {"_id":&owner})
                .await
                .unwrap()
                .unwrap()
                .get_str("channelID")
                .unwrap(),
            "test"
        );
        repo.save(doc! {"_id":&owner,"channelID":"changed"}, now)
            .await
            .unwrap();
        assert_eq!(
            repo.find_one(doc! {"_id":&owner})
                .await
                .unwrap()
                .unwrap()
                .get_str("channelID")
                .unwrap(),
            "changed"
        );
        let indexes: Vec<_> = repo
            .collection
            .list_indexes()
            .await
            .unwrap()
            .try_collect()
            .await
            .unwrap();
        for expected in &schema.indexes {
            assert!(indexes.iter().any(|i| i.keys == expected.keys
                && i.options.as_ref().and_then(|o| o.expire_after) == expected.ttl));
        }
        repo.collection
            .delete_one(doc! {"_id":&owner})
            .await
            .unwrap();
    }
}
