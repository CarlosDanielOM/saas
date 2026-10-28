#![cfg(feature = "application-schemas")]
// The owner generates the five source fixtures in isolated processes, then
// runs this test once per matching TZ with MONGOOSE_DATE_FIXTURE set to the
// corresponding generated JSON. Missing fixtures are deliberately fatal.
use dima_rust::schemas::{Field, FieldDefault, FieldType, SchemaDefinition};
use dima_rust::utils::mongoose_date::{self, DateCastError};
use mongodb::bson::{Bson, DateTime, Document, doc};
use serde_json::{Value, json};

fn ordinary(v: &Value) -> Bson {
    match v {
        Value::Null => Bson::Null,
        Value::Bool(v) => Bson::Boolean(*v),
        Value::String(v) => Bson::String(v.clone()),
        Value::Number(v) => Bson::Double(v.as_f64().unwrap()),
        Value::Array(v) => Bson::Array(v.iter().map(ordinary).collect()),
        Value::Object(v) => {
            Bson::Document(v.iter().map(|(k, v)| (k.clone(), ordinary(v))).collect())
        }
    }
}
fn input(v: &Value) -> Bson {
    let text = v["value"].as_str().unwrap_or("");
    match v["kind"].as_str().unwrap() {
        "json" => ordinary(&v["value"]),
        "number" | "boxed" => Bson::Double(match text {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            _ => text.parse().unwrap(),
        }),
        // An invalid Date is represented by an out-of-range BSON DateTime.
        "date" => Bson::DateTime(DateTime::from_millis(text.parse().unwrap())),
        "int64-number" => Bson::Int64(text.parse().unwrap()),
        other => panic!("unknown input {other}"),
    }
}
fn schema() -> SchemaDefinition {
    SchemaDefinition {
        model: "DateFixture",
        collection: "date_fixture",
        fields: vec![
            Field::new("d", FieldType::Date).default(FieldDefault::Number(123.0)),
            Field::new("requiredDate", FieldType::Date).required(),
        ],
        string_id: true,
        version_key: false,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![],
    }
}
fn cast_result(v: Result<Bson, DateCastError>) -> Value {
    match v {
        Ok(Bson::Null) => json!({"value":null}),
        Ok(Bson::DateTime(d)) => json!({"value":d.timestamp_millis()}),
        Err(_) => json!({"error":"cast"}),
        other => panic!("unexpected {other:?}"),
    }
}
fn schema_result(input: Document) -> Value {
    match schema().construct(&input, DateTime::from_millis(0)) {
        Ok(d) => match d.get("d").unwrap() {
            Bson::Null => json!({"value":null}),
            Bson::DateTime(v) => json!({"value":v.timestamp_millis()}),
            other => panic!("unexpected {other:?}"),
        },
        Err(e) => {
            let mut errors: Vec<_> =
                e.0.iter()
                    .map(|e| json!({"path":e.path,"kind":e.kind}))
                    .collect();
            errors.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
            json!({"errors":errors})
        }
    }
}
#[test]
fn mongoose_source_corpus_and_shared_schema() {
    let path =
        std::env::var("MONGOOSE_DATE_FIXTURE").expect("generate and select a timezone fixture");
    let fixture: Value =
        serde_json::from_slice(&std::fs::read(path).expect("read Mongoose date fixture")).unwrap();
    assert_eq!(fixture["metadata"]["mongoose"], "8.24.2");
    assert_eq!(
        fixture["metadata"]["zone"].as_str().unwrap(),
        std::env::var("TZ").expect("set matching process TZ")
    );
    for case in fixture["cases"].as_array().unwrap() {
        let value = input(&case["input"]);
        assert_eq!(
            cast_result(mongoose_date::cast(&value)),
            case["expected"],
            "{:?}",
            case["input"]
        );
        assert_eq!(
            schema_result(doc! {"d":value,"requiredDate":0}),
            case["schema"],
            "{:?}",
            case["input"]
        );
        let result = dima_rust::schemas::admin::schema().construct(
            &doc! {"_id": mongodb::bson::oid::ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap(), "createdAt":input(&case["input"])},
            DateTime::from_millis(0),
        );
        let actual = match result {
            Ok(document) => match document.get("createdAt").unwrap() {
                Bson::Null => json!({"value":null}),
                Bson::DateTime(date) => json!({"value":date.timestamp_millis()}),
                other => panic!("unexpected {other:?}"),
            },
            Err(errors) => {
                let mut entries: Vec<_> = errors
                    .0
                    .iter()
                    .map(|e| json!({"path":e.path,"kind":e.kind}))
                    .collect();
                entries.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
                json!({"errors":entries})
            }
        };
        assert_eq!(actual, case["admin"], "{:?}", case["input"]);
    }
    assert_eq!(schema_result(doc! {"requiredDate":0}), fixture["missing"]);
    assert_eq!(
        schema_result(doc! {"requiredDate":Bson::Null}),
        json!({"errors":[{"path":"requiredDate","kind":"required"}]})
    );
}

// Execute in a fresh UTC process against the same generated fixture as the
// Node benchmark. This measures outcomes, not Rust error-message formatting.
#[test]
#[ignore]
fn mongoose_date_benchmark() {
    use std::hint::black_box;
    use std::time::Instant;

    assert_eq!(std::env::var("TZ").unwrap(), "UTC");
    let fixture: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("MONGOOSE_DATE_FIXTURE").unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(fixture["metadata"]["mongoose"], "8.24.2");
    assert_eq!(fixture["metadata"]["zone"], "UTC");
    let workload = std::env::var("MONGOOSE_DATE_BENCH_WORKLOAD").unwrap();
    assert!(["numeric", "string", "invalid", "mixed"].contains(&workload.as_str()));
    let selected: Vec<_> = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            let valid = c["expected"]["value"].is_number();
            let kind = c["input"]["kind"].as_str().unwrap();
            match workload.as_str() {
                "mixed" => true,
                "invalid" => c["expected"]["error"] == "cast",
                "string" => valid && kind == "json" && c["input"]["value"].is_string(),
                "numeric" => {
                    valid
                        && (["number", "boxed", "date", "int64-number"].contains(&kind)
                            || (kind == "json" && c["input"]["value"].is_number()))
                }
                _ => unreachable!(),
            }
        })
        .collect();
    assert!(!selected.is_empty());
    for (_, case) in &selected {
        if let Some(millis) = case["expected"]["value"].as_i64() {
            assert!(millis.unsigned_abs() <= 9_007_199_254_740_991);
        }
    }
    let indices: Vec<_> = selected.iter().map(|(i, _)| *i).collect();
    let values: Vec<_> = selected.iter().map(|(_, c)| input(&c["input"])).collect();
    const OPERATIONS: u32 = 10_000;
    let sample = || {
        let mut checksum = 0_u32;
        let (mut valid, mut nulls, mut invalid) = (0_u32, 0_u32, 0_u32);
        let start = Instant::now();
        for i in 0..OPERATIONS {
            checksum = checksum.wrapping_add(i);
            match black_box(mongoose_date::cast(black_box(
                &values[i as usize % values.len()],
            ))) {
                Ok(Bson::Null) => nulls += 1,
                Ok(Bson::DateTime(date)) => {
                    checksum = checksum.wrapping_add(date.timestamp_millis() as u32);
                    valid += 1;
                }
                Err(_) => invalid += 1,
                other => panic!("unexpected benchmark result {other:?}"),
            }
        }
        json!({"elapsed_ns": start.elapsed().as_nanos(), "checksum": checksum,
            "valid": valid, "nulls": nulls, "invalid": invalid})
    };
    black_box(sample());
    let samples: Vec<_> = (0..7).map(|_| sample()).collect();
    let output = json!({"engine": "rust", "timezone": "UTC", "workload": workload,
        "operations": OPERATIONS, "case_indices": indices, "samples": samples,
        "scope": "caster outcomes; Rust errors do not format details"});
    let encoded = serde_json::to_string_pretty(&output).unwrap() + "\n";
    std::fs::write(
        std::env::var("MONGOOSE_DATE_BENCH_OUTPUT").unwrap(),
        &encoded,
    )
    .unwrap();
    print!("{encoded}");
}

#[tokio::test]
#[ignore = "requires explicitly supplied task-owned MongoDB fixture"]
async fn mongoose_date_admin_repository_persistence() {
    use mongodb::{Client, bson::oid::ObjectId};

    assert_eq!(std::env::var("TZ").expect("TZ required"), "UTC");
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").expect("fixture owner required"),
        "dimabot-migration"
    );
    let uri =
        std::env::var("APPLICATION_SCHEMAS_TEST_MONGO_URI").expect("task-owned Mongo URI required");
    let base = std::env::var("APPLICATION_SCHEMAS_TEST_DATABASE")
        .expect("task-owned database name required");
    assert!(base.starts_with("rust_schema_fixture_"));
    let client = Client::with_uri_str(uri).await.unwrap();
    let db = client.database(&format!("{base}_mongoose_date"));
    assert!(
        db.list_collection_names().await.unwrap().is_empty(),
        "fixture database must be fresh"
    );

    let admin = dima_rust::schemas::admin::schema().repository(&db);
    let id = ObjectId::new();
    let first = DateTime::from_millis(1_900_000_000_000);
    let second = DateTime::from_millis(1_900_000_001_000);
    let third = DateTime::from_millis(1_900_000_002_000);
    let legacy = DateTime::from_millis(1_578_133_230_000);
    let numeric_string = DateTime::from_millis(978_307_200_000);
    admin
        .insert(
            doc! {"_id": id, "adminName": "fixture",
            "createdAt": "January 4, 2020 10:20:30"},
            first,
        )
        .await
        .unwrap();
    let raw = admin
        .collection
        .find_one(doc! {"_id": id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(raw.get("createdAt"), Some(&Bson::DateTime(legacy)));
    assert_eq!(raw.get("updatedAt"), Some(&Bson::DateTime(first)));

    let saved = admin
        .save(doc! {"_id": id, "createdAt": "1"}, second)
        .await
        .unwrap();
    assert_eq!(
        saved.get("createdAt"),
        Some(&Bson::DateTime(numeric_string))
    );
    assert_eq!(saved.get("updatedAt"), Some(&Bson::DateTime(second)));
    admin
        .save(doc! {"_id": id, "adminName": "changed"}, third)
        .await
        .unwrap();
    let found = admin.find_one(doc! {"_id": id}).await.unwrap().unwrap();
    assert_eq!(
        found.get("createdAt"),
        Some(&Bson::DateTime(numeric_string))
    );
    assert_eq!(found.get("updatedAt"), Some(&Bson::DateTime(third)));
    assert_eq!(found.get_str("adminName").unwrap(), "changed");
    let raw = admin
        .collection
        .find_one(doc! {"_id": id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(raw.get("createdAt"), Some(&Bson::DateTime(numeric_string)));
    assert_eq!(raw.get("updatedAt"), Some(&Bson::DateTime(third)));

    admin
        .save(doc! {"_id": id, "createdAt": ""}, third)
        .await
        .unwrap();
    let before_invalid = admin
        .collection
        .find_one(doc! {"_id": id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(before_invalid.get("createdAt"), Some(&Bson::Null));
    let count = admin.collection.count_documents(doc! {}).await.unwrap();
    assert_eq!(count, 1);
    assert!(
        admin
            .save(doc! {"_id": id, "createdAt": true}, second)
            .await
            .is_err()
    );
    assert!(
        admin
            .insert(
                doc! {"_id": ObjectId::new(), "createdAt": "not a date"},
                first
            )
            .await
            .is_err()
    );
    assert_eq!(
        admin.collection.count_documents(doc! {}).await.unwrap(),
        count
    );
    assert_eq!(
        admin
            .collection
            .find_one(doc! {"_id": id})
            .await
            .unwrap()
            .unwrap(),
        before_invalid
    );
}
