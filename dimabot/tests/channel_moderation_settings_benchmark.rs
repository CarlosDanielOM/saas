#![cfg(feature = "channel-moderation-settings")]

#[path = "support/moderation_leaf_source.rs"]
mod moderation_leaf_source;
use dima_rust::{
    schemas::{ValidationErrors, channel_moderation_settings::schema},
    utils::json_number::number_string,
};
use mongodb::bson::{self, Bson, DateTime, Document, oid::ObjectId};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
// Existing test-only SHA helper; no new dependency.
pub fn sha256_hex(bytes: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut state = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut padded = bytes.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&(bytes.len() as u64 * 8).to_be_bytes());
    for chunk in padded.as_chunks::<64>().0 {
        let mut words = [0u32; 64];
        for (index, word) in chunk.as_chunks::<4>().0.iter().enumerate() {
            words[index] = u32::from_be_bytes(*word);
        }
        for i in 16..64 {
            let a = words[i - 15].rotate_right(7)
                ^ words[i - 15].rotate_right(18)
                ^ (words[i - 15] >> 3);
            let b = words[i - 2].rotate_right(17)
                ^ words[i - 2].rotate_right(19)
                ^ (words[i - 2] >> 10);
            words[i] = words[i - 16]
                .wrapping_add(a)
                .wrapping_add(words[i - 7])
                .wrapping_add(b);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in 0..64 {
            let x = h
                .wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
                .wrapping_add((e & f) ^ (!e & g))
                .wrapping_add(K[i])
                .wrapping_add(words[i]);
            let y = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22))
                .wrapping_add((a & b) ^ (a & c) ^ (b & c));
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(x);
            d = c;
            c = b;
            b = a;
            a = x.wrapping_add(y);
        }
        for (slot, word) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(word);
        }
    }
    state.iter().map(|word| format!("{word:08x}")).collect()
}

fn value(v: &Bson) -> Value {
    match v {
        Bson::ObjectId(id) => json!({"$oid":id.to_hex()}),
        Bson::DateTime(time) => json!({"$dateMs":time.timestamp_millis()}),
        Bson::Document(d) => Value::Object(d.iter().map(|(k, v)| (k.clone(), value(v))).collect()),
        Bson::Array(a) => Value::Array(a.iter().map(value).collect()),
        Bson::String(s) => json!(s),
        Bson::Boolean(b) => json!(b),
        Bson::Null => Value::Null,
        Bson::Int32(n) => json!(n),
        Bson::Int64(n) => json!(n),
        Bson::Double(n) => json!(n),
        x => panic!("unexpected BSON {x:?}"),
    }
}
fn record(v: &Result<Document, ValidationErrors>) -> Value {
    match v {
        Ok(document) => json!({"ok":true,"document":value(&Bson::Document(document.clone()))}),
        Err(error) => {
            let mut e = error
                .0
                .iter()
                .map(|x| (x.path.clone(), x.kind))
                .collect::<Vec<_>>();
            e.sort();
            json!({"ok":false,"errors":e.into_iter().map(|(path,kind)|json!({"path":path,"kind":kind})).collect::<Vec<_>>()})
        }
    }
}
fn canonical(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(x) => out.push_str(if *x { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number_string(n.as_f64().unwrap())),
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap()),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i != 0 {
                    out.push(',');
                }
                canonical(x, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            let mut entries = map.iter().collect::<Vec<_>>();
            entries.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            for (i, (key, x)) in entries.into_iter().enumerate() {
                if i != 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap());
                out.push(':');
                canonical(x, out);
            }
            out.push('}');
        }
    }
}
fn wire(v: &Result<Document, ValidationErrors>) -> String {
    let mut result = String::new();
    canonical(&record(v), &mut result);
    result
}
fn checksum<'a>(strings: impl IntoIterator<Item = &'a str>) -> u32 {
    let mut h = 2_166_136_261u32;
    for s in strings {
        for byte in s.bytes() {
            h = (h ^ u32::from(byte)).wrapping_mul(16_777_619);
        }
        h = (h ^ u32::MAX).wrapping_mul(16_777_619);
    }
    h
}
struct Item {
    id: String,
    input: Document,
}

#[test]
#[ignore = "external prepared paired benchmark coordinator required"]
fn prepared_moderation_schema_server() {
    moderation_leaf_source::path(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
        "src/utils/moderation/spam_categories.ts",
    );
    assert!(
        !std::hint::black_box(cfg!(debug_assertions)),
        "release only"
    );
    let dir = std::path::PathBuf::from(
        std::env::var_os("DIMA_MODERATION_SCHEMA_BENCH_DIR").expect("input directory"),
    );
    assert!(dir.is_absolute());
    let dir = dir.canonicalize().unwrap();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(!dir.starts_with(source));
    let bytes =
        std::fs::read(dir.join("channel-moderation-settings-benchmark-input.json")).unwrap();
    let input_sha = sha256_hex(&bytes);
    assert_eq!(
        input_sha,
        std::env::var("DIMA_MODERATION_SCHEMA_BENCH_INPUT_SHA256").expect("explicit input SHA")
    );
    let data: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        data["metadata"]["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    assert_eq!(data["metadata"]["realm"], "commonjs-real-mongoose");
    for (file, content) in [
        (
            "src/schemas/channel_moderation_settings.schema.rs",
            include_bytes!("../src/schemas/channel_moderation_settings.schema.rs").as_slice(),
        ),
        (
            "src/schemas/schema.rs",
            include_bytes!("../src/schemas/schema.rs").as_slice(),
        ),
        (
            "src/utils/moderation/spam_categories.rs",
            include_bytes!("../src/utils/moderation/spam_categories.rs").as_slice(),
        ),
        (
            "src/utils/moderation/caps.rs",
            include_bytes!("../src/utils/moderation/caps.rs").as_slice(),
        ),
        (
            "src/utils/bson_compat.rs",
            include_bytes!("../src/utils/bson_compat.rs").as_slice(),
        ),
        (
            "src/utils/json_number.rs",
            include_bytes!("../src/utils/json_number.rs").as_slice(),
        ),
        (
            "src/utils/js_compat.rs",
            include_bytes!("../src/utils/js_compat.rs").as_slice(),
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
            "src/utils/js_date/local_time.rs",
            include_bytes!("../src/utils/js_date/local_time.rs").as_slice(),
        ),
        (
            "src/utils/js_string.rs",
            include_bytes!("../src/utils/js_string.rs").as_slice(),
        ),
        (
            "src/utils/moderation/caps_unicode_data.rs",
            include_bytes!("../src/utils/moderation/caps_unicode_data.rs").as_slice(),
        ),
        (
            "tests/channel_moderation_settings_schema.rs",
            include_bytes!("channel_moderation_settings_schema.rs").as_slice(),
        ),
        (
            "tests/channel_moderation_settings_store.rs",
            include_bytes!("channel_moderation_settings_store.rs").as_slice(),
        ),
        (
            "tests/fixtures/channel_moderation_settings_reference.cjs",
            include_bytes!("fixtures/channel_moderation_settings_reference.cjs").as_slice(),
        ),
        (
            "tests/channel_moderation_settings_benchmark.rs",
            include_bytes!("channel_moderation_settings_benchmark.rs").as_slice(),
        ),
        (
            "tests/fixtures/channel_moderation_settings_benchmark.cjs",
            include_bytes!("fixtures/channel_moderation_settings_benchmark.cjs").as_slice(),
        ),
        ("Cargo.toml", include_bytes!("../Cargo.toml").as_slice()),
        ("Cargo.lock", include_bytes!("../Cargo.lock").as_slice()),
    ] {
        assert_eq!(
            sha256_hex(content),
            data["metadata"]["nativeHashes"][file].as_str().unwrap(),
            "{file}"
        );
    }
    for (file, content) in [
        (
            "src/schemas/channel_moderation_settings.schema.ts",
            include_bytes!("../src/schemas/channel_moderation_settings.schema.ts").as_slice(),
        ),
        (
            "src/utils/moderation/spam_categories.ts",
            include_bytes!("../../archives/dimabot-typescript/2026-10-28/src/utils/moderation/spam_categories.ts").as_slice(),
        ),
        (
            "src/utils/moderation/variations.ts",
            include_bytes!("../src/utils/moderation/variations.ts").as_slice(),
        ),
        (
            "src/utils/moderation/advanced.ts",
            include_bytes!("../src/utils/moderation/advanced.ts").as_slice(),
        ),
        (
            "src/utils/permissions/expression.ts",
            include_bytes!("../src/utils/permissions/expression.ts").as_slice(),
        ),
        (
            "src/utils/permissions/roles.ts",
            include_bytes!("../src/utils/permissions/roles.ts").as_slice(),
        ),
        ("package.json", include_bytes!("../package.json").as_slice()),
        (
            "package-lock.json",
            include_bytes!("../package-lock.json").as_slice(),
        ),
        (
            "rust-toolchain.toml",
            include_bytes!("../rust-toolchain.toml").as_slice(),
        ),
    ] {
        assert_eq!(
            sha256_hex(content),
            data["metadata"]["pins"][file].as_str().unwrap(),
            "{file}"
        );
    }
    assert_eq!(data["metadata"]["objectId"], "507f1f77bcf86cd799439011");
    let names = ["defaults", "four-rules", "invalid"];
    let now = DateTime::from_millis(1_900_000_000_000);
    let schema = schema();
    let mut pools: Vec<(&str, Vec<Item>)> = Vec::new();
    for name in names {
        let rows = data["pools"][name].as_array().unwrap();
        assert_eq!(rows.len(), 8);
        let mut pool = Vec::new();
        for row in rows {
            let mut input: Document = bson::serialize_to_document(&row["input"]).unwrap();
            input.insert(
                "_id",
                ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap(),
            );
            let result = schema.construct(&input, now);
            let actual = wire(&result);
            assert_eq!(actual, row["wire"].as_str().unwrap(), "{}", row["id"]);
            assert_eq!(record(&result), row["expected"], "{}", row["id"]);
            assert_eq!(
                u64::from(checksum([actual.as_str()])),
                row["checksum"].as_u64().unwrap()
            );
            assert_eq!(result.is_ok(), name != "invalid");
            pool.push(Item {
                id: row["id"].as_str().unwrap().to_owned(),
                input,
            });
        }
        pools.push((name, pool));
    }
    let reps: usize = std::env::var("DIMA_MODERATION_SCHEMA_BENCH_REPS")
        .unwrap_or_else(|_| "1000".into())
        .parse()
        .unwrap();
    assert!((1..=10_000).contains(&reps));
    let ids = serde_json::Map::from_iter(pools.iter().map(|(k, p)| {
        (
            (*k).to_string(),
            json!(p.iter().map(|x| &x.id).collect::<Vec<_>>()),
        )
    }));
    println!(
        "{}",
        json!({"ready":true,"realm":"native","pools":ids,"reps":reps,"inputSha":input_sha,"nodeSha":data["metadata"]["nodeSha"],"compiled":data["metadata"]["compiled"],"nativeHashes":data["metadata"]["nativeHashes"]})
    );
    io::stdout().flush().unwrap();
    for line in io::stdin().lock().lines() {
        let cmd: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let action = cmd["command"].as_str().unwrap();
        if action == "quit" {
            break;
        }
        assert!(action == "warmup" || action == "run");
        let name = cmd["workload"].as_str().unwrap();
        let pool = &pools
            .iter()
            .find(|(n, _)| *n == name)
            .expect("unknown workload")
            .1;
        let total = pool.len() * reps;
        let mut outputs: Vec<Option<Result<Document, ValidationErrors>>> =
            (0..total).map(|_| None).collect();
        let start = std::time::Instant::now();
        for (i, slot) in outputs.iter_mut().enumerate() {
            *slot = Some(std::hint::black_box(
                schema.construct(std::hint::black_box(&pool[i % pool.len()].input), now),
            ));
        }
        let elapsed = start.elapsed().as_nanos();
        let wires = outputs
            .iter()
            .map(|x| wire(x.as_ref().unwrap()))
            .collect::<Vec<_>>();
        let hash = checksum(wires.iter().map(String::as_str));
        println!(
            "{}",
            json!({"workload":name,"elapsedNs":elapsed.to_string(),"total":total,"checksum":hash})
        );
        io::stdout().flush().unwrap();
    }
}
