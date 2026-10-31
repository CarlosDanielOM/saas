#![cfg(feature = "ordinary-application-schemas")]
//! Release paired benchmark server. The coordinator owns warmup and sample
//! counts. This process times the requested operation and returns a checksum.
//! It does not record a speed claim. Runtime is unverified until the parent runs it.

#[path = "support/sha256.rs"]
mod sha256;

use dima_rust::schemas::{
    SchemaDefinition, eventsub, site_analytics, temporary_moderator, title_config, trigger_file,
    vip,
};
use dima_rust::utils::{bson_compat::js_number, json_number::number_string};
use mongodb::bson::{Bson, DateTime, Document, oid::ObjectId};
use serde_json::{Map, Value, json};
use sha256::sha256_hex;
use std::io::{self, BufRead, Write};

const NODE_PIN: &str = "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108";
const NOW: i64 = 1_900_000_000_000;
const ID: &str = "507f1f77bcf86cd799439011";
const ARTIFACT: &str = "ordinary-application-schemas-benchmark-input.json";

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

fn expand_bson(value: &Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(value) => Bson::Boolean(*value),
        Value::Number(value) => js_number(value.as_f64().expect("finite")),
        Value::String(value) => Bson::String(value.clone()),
        Value::Array(values) => Bson::Array(values.iter().map(expand_bson).collect()),
        Value::Object(map) if map.len() == 1 && map.contains_key("$date") => {
            Bson::DateTime(DateTime::from_millis(map["$date"].as_i64().unwrap()))
        }
        Value::Object(map) if map.len() == 1 && map.contains_key("$oid") => {
            Bson::ObjectId(ObjectId::parse_str(map["$oid"].as_str().unwrap()).unwrap())
        }
        Value::Object(map) => {
            let mut document = Document::new();
            for (key, value) in map {
                document.insert(key, expand_bson(value));
            }
            Bson::Document(document)
        }
    }
}

fn bson_json(value: &Bson) -> Value {
    match value {
        Bson::ObjectId(id) => json!({"$oid": id.to_hex()}),
        Bson::DateTime(time) => json!({"$dateMs": time.timestamp_millis()}),
        Bson::Document(document) => Value::Object(
            document
                .iter()
                .map(|(key, value)| (key.clone(), bson_json(value)))
                .collect(),
        ),
        Bson::Array(values) => Value::Array(values.iter().map(bson_json).collect()),
        Bson::String(text) => json!(text),
        Bson::Boolean(value) => json!(*value),
        Bson::Null => Value::Null,
        Bson::Int32(number) => json!(number),
        Bson::Int64(number) => json!(number),
        Bson::Double(number) => json!(*number),
        other => panic!("unexpected BSON {other:?}"),
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

fn wire_document(document: &Document) -> String {
    let record = json!({"ok": true, "document": bson_json(&Bson::Document(document.clone()))});
    let mut out = String::new();
    canonical(&record, &mut out);
    out
}

fn checksum<'a>(values: impl IntoIterator<Item = &'a str>) -> u32 {
    let mut hash = 2_166_136_261u32;
    for value in values {
        for byte in value.bytes() {
            hash = (hash ^ u32::from(byte)).wrapping_mul(16_777_619);
        }
        hash = (hash ^ u32::MAX).wrapping_mul(16_777_619);
    }
    hash
}

fn repo_bytes() -> Vec<(&'static str, &'static [u8])> {
    vec![
        (
            "src/schemas/temporary_moderator.schema.ts",
            include_bytes!("../src/schemas/temporary_moderator.schema.ts"),
        ),
        (
            "src/schemas/vip.schema.ts",
            include_bytes!("../src/schemas/vip.schema.ts"),
        ),
        (
            "src/schemas/title_config.schema.ts",
            include_bytes!("../src/schemas/title_config.schema.ts"),
        ),
        (
            "src/schemas/trigger_file.schema.ts",
            include_bytes!("../src/schemas/trigger_file.schema.ts"),
        ),
        (
            "src/schemas/eventsub.schema.ts",
            include_bytes!("../src/schemas/eventsub.schema.ts"),
        ),
        (
            "src/schemas/site_analytics.schema.ts",
            include_bytes!("../src/schemas/site_analytics.schema.ts"),
        ),
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
            "tests/ordinary_application_schemas_benchmark.rs",
            include_bytes!("ordinary_application_schemas_benchmark.rs"),
        ),
        (
            "tests/fixtures/ordinary_application_schemas_reference.cjs",
            include_bytes!("fixtures/ordinary_application_schemas_reference.cjs"),
        ),
        (
            "tests/fixtures/ordinary_application_schemas_benchmark.cjs",
            include_bytes!("fixtures/ordinary_application_schemas_benchmark.cjs"),
        ),
        ("Cargo.toml", include_bytes!("../Cargo.toml")),
        ("Cargo.lock", include_bytes!("../Cargo.lock")),
        (
            "rust-toolchain.toml",
            include_bytes!("../rust-toolchain.toml"),
        ),
        ("package.json", include_bytes!("../package.json")),
        ("package-lock.json", include_bytes!("../package-lock.json")),
    ]
}

fn package_files() -> [&'static str; 7] {
    [
        "node_modules/mongoose/package.json",
        "node_modules/mongoose/lib/helpers/pluralize.js",
        "node_modules/mongoose/lib/utils.js",
        "node_modules/mongoose/lib/helpers/schema/getIndexes.js",
        "node_modules/mongoose/lib/helpers/timestamps/setDocumentTimestamps.js",
        "node_modules/bson/package.json",
        "node_modules/typescript/package.json",
    ]
}

struct Item {
    id: String,
    input: Document,
}

struct Pool {
    name: &'static str,
    schema: &'static SchemaDefinition,
    items: Vec<Item>,
}

#[test]
#[ignore = "external prepared paired benchmark coordinator required"]
fn prepared_ordinary_application_schemas_server() {
    assert!(
        !std::hint::black_box(cfg!(debug_assertions)),
        "release only"
    );
    assert_eq!(std::env::var("TZ").as_deref(), Ok("UTC"));
    let requested = std::path::PathBuf::from(
        std::env::var_os("DIMA_ORDINARY_SCHEMAS_BENCH_DIR").expect("input directory"),
    );
    assert!(requested.is_absolute());
    let dir = requested.canonicalize().unwrap();
    assert_eq!(dir, requested);
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    let workspace = source.parent().unwrap();
    assert!(!dir.starts_with(&source));
    assert!(!dir.starts_with(workspace));
    let mut names: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, vec![ARTIFACT.to_owned()]);
    let bytes = std::fs::read(dir.join(ARTIFACT)).unwrap();
    assert_eq!(
        sha256_hex(&bytes),
        std::env::var("DIMA_ORDINARY_SCHEMAS_BENCH_INPUT_SHA256").expect("input sha")
    );
    let data: Value = serde_json::from_slice(&bytes).unwrap();
    let metadata = &data["metadata"];
    assert_eq!(metadata["format"], 1);
    assert_eq!(metadata["realm"], "commonjs-module");
    assert_eq!(metadata["nodeSha"], NODE_PIN);
    assert_eq!(metadata["tz"], "UTC");
    assert_eq!(metadata["now"], NOW);
    assert_eq!(metadata["objectId"], ID);
    assert_eq!(metadata["poolSize"], 4);
    assert_eq!(metadata["versions"]["node"], "24.22.1");
    assert_eq!(metadata["versions"]["v8"], "13.6.233.17-node.58");
    assert_eq!(metadata["versions"]["icu"], "78.3");
    assert_eq!(metadata["versions"]["unicode"], "17.0");
    assert_eq!(metadata["versions"]["typescript"], "5.9.3");
    assert_eq!(metadata["versions"]["mongoose"], "8.24.2");
    assert_eq!(metadata["versions"]["bson"], "6.10.4");
    assert_eq!(
        metadata["operations"],
        json!(["constructValidate", "constructValidateSerialize"])
    );
    let hashes = metadata["sourceSha256"].as_object().unwrap();
    for (path, bytes) in repo_bytes() {
        assert_eq!(hashes[path].as_str().unwrap(), sha256_hex(bytes), "{path}");
    }
    for path in package_files() {
        let bytes =
            std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap();
        assert_eq!(hashes[path].as_str().unwrap(), sha256_hex(&bytes), "{path}");
    }
    let object_id = ObjectId::parse_str(ID).unwrap();
    let now = DateTime::from_millis(NOW);
    let names = [
        temporary_moderator::MODEL_NAME,
        vip::MODEL_NAME,
        title_config::MODEL_NAME,
        trigger_file::MODEL_NAME,
        eventsub::MODEL_NAME,
        site_analytics::MODEL_NAME,
    ];
    assert_eq!(
        data["pools"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        names
    );
    let mut pools = Vec::new();
    for name in names {
        let schema = definition(name);
        let rows = data["pools"][name].as_array().unwrap();
        assert_eq!(rows.len(), 4, "{name}");
        let mut items = Vec::new();
        for row in rows {
            let Bson::Document(mut input) = expand_bson(&row["input"]) else {
                panic!("input");
            };
            input.insert("_id", object_id);
            let document = schema
                .construct(&input, now)
                .expect(row["id"].as_str().unwrap());
            let actual = wire_document(&document);
            assert_eq!(actual, row["wire"].as_str().unwrap(), "{}", row["id"]);
            assert_eq!(
                u64::from(checksum([actual.as_str()])),
                row["checksum"].as_u64().unwrap(),
                "{}",
                row["id"]
            );
            items.push(Item {
                id: row["id"].as_str().unwrap().to_owned(),
                input,
            });
        }
        pools.push(Pool {
            name,
            schema,
            items,
        });
    }
    let repetition_count: usize = std::env::var("DIMA_ORDINARY_SCHEMAS_BENCH_REPS")
        .unwrap_or_else(|_| "1000".to_owned())
        .parse()
        .unwrap();
    assert!((1..=10_000).contains(&repetition_count));
    let mut ready_pools = Map::new();
    for pool in &pools {
        ready_pools.insert(
            pool.name.to_owned(),
            json!(pool.items.iter().map(|item| &item.id).collect::<Vec<_>>()),
        );
    }
    println!(
        "{}",
        json!({
            "ready": true,
            "realm": "native",
            "pools": ready_pools,
            "reps": repetition_count,
            "operations": ["constructValidate", "constructValidateSerialize"],
            "inputSha": sha256_hex(&bytes),
            "nodeSha": NODE_PIN,
            "now": NOW,
            "objectId": ID,
            "tz": "UTC",
            "compiled": metadata["compiledSha256"],
            "nativeHashes": metadata["sourceSha256"],
        })
    );
    io::stdout().flush().unwrap();
    for line in io::stdin().lock().lines() {
        let command: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let action = command["command"].as_str().unwrap();
        if action == "quit" {
            break;
        }
        assert!(action == "warmup" || action == "run");
        let workload = command["workload"].as_str().unwrap();
        let operation = command["operation"].as_str().unwrap();
        let pool = pools
            .iter()
            .find(|pool| pool.name == workload)
            .expect("workload");
        let total = pool.items.len() * repetition_count;
        let (elapsed, hash) = match operation {
            "constructValidate" => {
                let mut documents = Vec::with_capacity(total);
                let started = std::time::Instant::now();
                for index in 0..total {
                    documents.push(std::hint::black_box(
                        pool.schema
                            .construct(
                                std::hint::black_box(&pool.items[index % pool.items.len()].input),
                                now,
                            )
                            .expect("valid"),
                    ));
                }
                let elapsed = started.elapsed().as_nanos();
                let wires = documents.iter().map(wire_document).collect::<Vec<_>>();
                (elapsed, checksum(wires.iter().map(String::as_str)))
            }
            "constructValidateSerialize" => {
                let mut wires = Vec::with_capacity(total);
                let started = std::time::Instant::now();
                for index in 0..total {
                    let document = pool
                        .schema
                        .construct(
                            std::hint::black_box(&pool.items[index % pool.items.len()].input),
                            now,
                        )
                        .expect("valid");
                    wires.push(std::hint::black_box(wire_document(&document)));
                }
                let elapsed = started.elapsed().as_nanos();
                (elapsed, checksum(wires.iter().map(String::as_str)))
            }
            other => panic!("unknown operation {other}"),
        };
        println!(
            "{}",
            json!({
                "workload": workload,
                "operation": operation,
                "elapsedNs": elapsed.to_string(),
                "total": total,
                "checksum": hash,
            })
        );
        io::stdout().flush().unwrap();
    }
}
