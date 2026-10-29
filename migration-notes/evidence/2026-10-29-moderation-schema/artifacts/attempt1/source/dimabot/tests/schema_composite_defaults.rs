#![cfg(feature = "application-schemas")]
use dima_rust::schemas::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use mongodb::bson::{Bson, DateTime, Document, doc};
use serde_json::{Value, json};
use std::path::PathBuf;

// Independent raw-byte SHA-256 helper reused from ast_evaluator_bench.rs.
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

const CATEGORIES: &[&str] = &["spam", "ads", "self_promotion", "profanity", "insults"];
const TAGS: &[&str] = &["vip", "mod", "sub", "founder", "editor", "admin"];
const ACTIONS: &[&str] = &["off", "warn", "delete", "timeout", "ban"];
fn definition(fields: Vec<Field>) -> SchemaDefinition {
    SchemaDefinition {
        model: "composite-fixture",
        collection: "composite_fixture",
        fields,
        string_id: true,
        version_key: false,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: Vec::new(),
    }
}
fn step(default_action: &str) -> FieldTypeAndDefault {
    FieldTypeAndDefault {
        kind: T::Subdocument {
            fields: vec![
                Field::new("action", T::String)
                    .enumeration(ACTIONS)
                    .default(D::String("warn")),
                Field::new("timeoutSeconds", T::Number)
                    .default(D::Number(60.0))
                    .min(1.0)
                    .max(1209600.0),
            ],
            generate_id: false,
        },
        default: D::Value(Bson::Document(
            doc! { "action": default_action, "timeoutSeconds": 60 },
        )),
    }
}
struct FieldTypeAndDefault {
    kind: T,
    default: D,
}
fn composite() -> SchemaDefinition {
    let first = step("warn");
    let second = step("delete");
    let third = step("timeout");
    definition(vec![
        Field::new("first", first.kind).default(first.default),
        Field::new("second", second.kind).default(second.default),
        Field::new("third", third.kind).default(third.default),
        Field::new(
            "categories",
            T::ArrayElement(Box::new(Field::new("", T::String).enumeration(CATEGORIES))),
        )
        .default(D::Value(Bson::Array(vec![
            "spam".into(),
            "ads".into(),
            "self_promotion".into(),
        ]))),
        Field::new(
            "exemptTags",
            T::ArrayElement(Box::new(Field::new("", T::String).enumeration(TAGS))),
        )
        .default(D::Value(Bson::Array(vec![
            "mod".into(),
            "editor".into(),
            "admin".into(),
        ]))),
        Field::new(
            "weights",
            T::ArrayElement(Box::new(Field::new("", T::Number).min(1.0).max(10.0))),
        )
        .default(D::Value(Bson::Array(vec![2.into(), 3.into()]))),
        Field::new(
            "codes",
            T::ArrayElement(Box::new(
                Field::new("", T::String)
                    .enumeration(&["ok", "wide"])
                    .max_utf16(2),
            )),
        )
        .default(D::Array),
        Field::new("variations", T::Mixed)
            .default(D::Value(Bson::Document(doc! {"mode":"off", "entries":[]}))),
    ])
}
fn empty_schema() -> SchemaDefinition {
    let empty = || T::Subdocument {
        fields: Vec::new(),
        generate_id: false,
    };
    definition(vec![
        Field::new("mixed", T::Mixed).default(D::Value(Bson::Document(doc! {}))),
        Field::new("single", empty()).default(D::Value(Bson::Document(doc! {}))),
        Field::new("children", T::Array(Box::new(empty())))
            .default(D::Value(Bson::Array(vec![Bson::Document(doc! {})]))),
        Field::new("map", T::Map(Box::new(T::String))).default(D::Value(Bson::Document(doc! {}))),
    ])
}

#[test]
fn value_defaults_are_cloned_cast_and_keep_explicit_null() {
    let schema = composite();
    let now = DateTime::from_millis(0);
    let mut first = schema.construct(&doc! {}, now).unwrap();
    let second = schema.construct(&doc! {}, now).unwrap();
    assert_eq!(
        second
            .get_document("second")
            .unwrap()
            .get_str("action")
            .unwrap(),
        "delete"
    );
    assert_eq!(
        second
            .get_document("third")
            .unwrap()
            .get_str("action")
            .unwrap(),
        "timeout"
    );
    first
        .get_array_mut("categories")
        .unwrap()
        .push("insults".into());
    first
        .get_document_mut("variations")
        .unwrap()
        .get_array_mut("entries")
        .unwrap()
        .push("changed".into());
    first
        .get_document_mut("second")
        .unwrap()
        .insert("action", "ban");
    let fresh = schema.construct(&doc! {}, now).unwrap();
    assert_eq!(fresh, second);
    let explicit = schema
        .construct(&doc! {"second": {}, "categories": Bson::Null}, now)
        .unwrap();
    assert_eq!(
        explicit
            .get_document("second")
            .unwrap()
            .get_str("action")
            .unwrap(),
        "warn"
    );
    assert_eq!(explicit.get("categories"), Some(&Bson::Null));
    let cast_default = definition(vec![
        Field::new("value", T::Number).default(D::Value("42".into())),
    ]);
    assert_eq!(
        cast_default
            .construct(&doc! {}, now)
            .unwrap()
            .get_i32("value")
            .unwrap(),
        42
    );
}

#[test]
fn array_element_cast_and_validation_are_per_path_and_cast_first() {
    let schema = composite();
    let now = DateTime::from_millis(0);
    let scalar = schema.construct(&doc! {"categories":"ads"}, now).unwrap();
    assert_eq!(
        scalar.get_array("categories").unwrap(),
        &vec![Bson::String("ads".into())]
    );
    let errors = schema
        .construct(&doc! {"categories":["invalid", Bson::Null, "bad"]}, now)
        .unwrap_err();
    assert_eq!(
        errors
            .0
            .iter()
            .map(|e| (e.path.as_str(), e.kind))
            .collect::<Vec<_>>(),
        vec![("categories.0", "enum"), ("categories.2", "enum")]
    );
    let errors = schema
        .construct(&doc! {"categories":["bad",{},"also-bad"]}, now)
        .unwrap_err();
    assert_eq!(
        errors
            .0
            .iter()
            .map(|e| (e.path.as_str(), e.kind))
            .collect::<Vec<_>>(),
        vec![("categories.1", "cast")]
    );
}

#[test]
#[ignore = "requires pinned disconnected Mongoose external fixture"]
fn replay_mongoose_composite_defaults() {
    let dir = PathBuf::from(
        std::env::var_os("DIMA_SCHEMA_COMPOSITE_FIXTURE_DIR")
            .expect("external fixture directory required"),
    );
    assert!(dir.is_absolute());
    assert_eq!(dir.canonicalize().unwrap(), dir);
    assert!(
        !dir.starts_with(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .canonicalize()
                .unwrap()
        )
    );
    let expected = std::env::var("DIMA_SCHEMA_COMPOSITE_FIXTURE_SHA256")
        .expect("explicit fixture digest required");
    assert_eq!(expected.len(), 64);
    assert!(
        expected
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let bytes = std::fs::read(dir.join("schema-composite-defaults-reference.json")).unwrap();
    assert_eq!(sha256_hex(&bytes), expected);
    let corpus: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(corpus["format"], 1);
    assert_eq!(
        corpus["nodeExecutableSha256"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    for (key, value) in [
        ("node", "24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("icu", "78.3"),
        ("unicode", "17.0"),
        ("typescript", "5.9.3"),
        ("mongoose", "8.24.2"),
        ("bson", "6.10.4"),
    ] {
        assert_eq!(corpus["versions"][key], value);
    }
    let files = [
        (
            "src/schemas/schema.rs",
            include_bytes!("../src/schemas/schema.rs").as_slice(),
        ),
        (
            "src/schemas/channel_moderation_settings.schema.ts",
            include_bytes!("../src/schemas/channel_moderation_settings.schema.ts").as_slice(),
        ),
        (
            "src/utils/moderation/spam_categories.ts",
            include_bytes!("../src/utils/moderation/spam_categories.ts").as_slice(),
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
            "src/utils/json_number.rs",
            include_bytes!("../src/utils/json_number.rs").as_slice(),
        ),
        (
            "src/utils/js_compat.rs",
            include_bytes!("../src/utils/js_compat.rs").as_slice(),
        ),
        (
            "tests/schema_composite_defaults.rs",
            include_bytes!("schema_composite_defaults.rs").as_slice(),
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
            "oracle-script",
            include_bytes!("fixtures/schema_composite_defaults_reference.cjs").as_slice(),
        ),
    ];
    for (key, bytes) in files {
        assert_eq!(
            sha256_hex(bytes),
            corpus["sourceSha256"][key].as_str().unwrap(),
            "source {key}"
        );
    }
    let cases = corpus["cases"].as_array().unwrap();
    assert!(cases.len() >= 75);
    for (index, case) in cases.iter().enumerate() {
        let schema = match case["model"].as_str().unwrap() {
            "composite" => composite(),
            "empty" => empty_schema(),
            _ => panic!("unknown model"),
        };
        let input: Document = mongodb::bson::to_document(&case["input"]).unwrap();
        let actual = match schema.construct(&input, DateTime::from_millis(0)) {
            Ok(doc) => json!({"document":doc}),
            Err(errors) => {
                let mut list: Vec<_> = errors
                    .0
                    .iter()
                    .map(|e| json!({"path":e.path,"kind":e.kind}))
                    .collect();
                list.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
                json!({"errors":list})
            }
        };
        assert_eq!(actual, case["expected"], "case {index}: {}", case["input"]);
    }
    assert_eq!(
        corpus["cloneEvidence"]["fresh"],
        corpus["cloneEvidence"]["independent"]
    );
    // Real source model samples are compared with the synthetic native output
    // where their selected fields have exactly the same declared definitions.
    let actual = corpus["actualCases"].as_array().unwrap();
    assert_eq!(actual.len(), 4);
    // Undefined/sparse array slots are separately recorded for review; plain
    // JSON/BSON input cannot distinguish them without an explicit adapter.
    let element_defaults = corpus["elementDefaults"].as_array().unwrap();
    assert_eq!(element_defaults.len(), 4);
    for (row, label) in element_defaults
        .iter()
        .zip(["undefined", "null", "sparse", "empty"])
    {
        assert_eq!(row["label"], label);
    }
    let default = &actual[0]["selected"];
    let native = composite()
        .construct(&doc! {}, DateTime::from_millis(0))
        .unwrap();
    for key in ["first", "second", "third", "variations"] {
        assert_eq!(json!(native.get(key).unwrap()), default[key]);
    }
    assert_eq!(
        json!(native.get("categories").unwrap()),
        default["spamProtection"]["categories"]
    );
    assert_eq!(
        json!(native.get("exemptTags").unwrap()),
        default["spamProtection"]["exemptTags"]
    );
}
