//! Shared actual-source semantic replay boundary: lossless UTF-16/binary64.
#![allow(dead_code)]
use dima_rust::utils::{
    js_string::JsString,
    lossless_json::{JsonValue, JsonValueRef},
    moderation::spam_categories::SpamCategory,
};
use serde_json::{Value, json};
use std::{env, fs, path::Path};
#[path = "sha256.rs"]
mod digest;
pub fn string(v: &Value) -> JsString {
    JsString::from_units(
        v["utf16"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| u16::try_from(x.as_u64().unwrap()).unwrap())
            .collect(),
    )
}
pub fn decode(v: &Value) -> Option<JsonValue> {
    Some(match v["kind"].as_str().unwrap() {
        "undefined" | "hole" => return None,
        "date" => return decode(&v["milliseconds"]),
        "null" => JsonValue::Null,
        "boolean" => JsonValue::Bool(v["value"].as_bool().unwrap()),
        "number" => JsonValue::Number(f64::from_bits(
            u64::from_str_radix(v["bits"].as_str().unwrap(), 16).unwrap(),
        )),
        "string" => JsonValue::String(string(v)),
        "array" => JsonValue::Array(
            v["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| decode(x).unwrap_or(JsonValue::Null))
                .collect(),
        ),
        "object" => JsonValue::Object(
            v["entries"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|x| {
                    decode(&x[1]).map(|value| {
                        (
                            JsString::from_units(
                                x[0].as_array()
                                    .unwrap()
                                    .iter()
                                    .map(|x| u16::try_from(x.as_u64().unwrap()).unwrap())
                                    .collect(),
                            ),
                            value,
                        )
                    })
                })
                .collect(),
        ),
        tag => panic!("unsupported tag {tag}"),
    })
}
pub fn encode(v: &JsonValue) -> Value {
    match v {
        JsonValue::Null => json!({"kind":"null"}),
        JsonValue::Bool(v) => json!({"kind":"boolean","value":v}),
        JsonValue::Number(v) => json!({"kind":"number","bits":format!("{:016x}",v.to_bits())}),
        JsonValue::String(v) => json!({"kind":"string","utf16":v.units()}),
        JsonValue::Array(v) => {
            json!({"kind":"array","items":v.iter().map(encode).collect::<Vec<_>>()})
        }
        JsonValue::Object(v) => {
            json!({"kind":"object","entries":v.iter().map(|(k,v)|json!([k.units(),encode(v)])).collect::<Vec<_>>()})
        }
    }
}
pub fn obj(fields: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
pub fn text(v: &JsonValue) -> &JsString {
    if let JsonValue::String(s) = v {
        s
    } else {
        panic!("expected string")
    }
}
pub fn number(v: &JsonValue) -> f64 {
    if let JsonValue::Number(n) = v {
        *n
    } else {
        panic!("expected number")
    }
}
pub fn arg(args: &[Value], index: usize) -> Option<JsonValue> {
    args.get(index).and_then(decode)
}
pub fn threshold(args: &[Value], index: usize) -> f64 {
    match arg(args, index) {
        None => 85.0,
        Some(JsonValue::Number(n)) => n,
        _ => f64::NAN,
    }
}
pub fn categories(v: &JsonValue) -> Result<Vec<SpamCategory>, &'static str> {
    if let JsonValue::Array(items) = v {
        items
            .iter()
            .map(|v| {
                text(v)
                    .as_str()
                    .and_then(SpamCategory::parse)
                    .ok_or("unknown-category-enum")
            })
            .collect()
    } else {
        Err("non-array-category")
    }
}
pub fn result(actual: Result<JsonValue, String>, expected: &Value, id: &str) {
    match actual {
        Ok(v) => {
            assert_eq!(expected["ok"], true, "{id}");
            assert_eq!(encode(&v), expected["value"], "{id}");
        }
        Err(error) => {
            assert_eq!(expected["ok"], false, "{id}: {error}");
            assert_eq!(
                JsString::from_units(
                    expected["name"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|x| x.as_u64().unwrap() as u16)
                        .collect()
                )
                .as_str(),
                Some("TypeError"),
                "{id}: native request error class"
            );
        }
    }
}
pub fn external_bytes(file: &str, pin: &str) -> Vec<u8> {
    assert!(Path::new(file).is_absolute());
    let real = fs::canonicalize(file).unwrap();
    let workspace =
        fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()).unwrap();
    assert!(!real.starts_with(workspace));
    assert!(
        pin.len() == 64
            && pin
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let bytes = fs::read(real).unwrap();
    assert_eq!(digest::sha256_hex(&bytes), pin);
    bytes
}
pub fn reference() -> Value {
    let data: Value = serde_json::from_slice(&external_bytes(
        &env::var("DIMA_SEMANTIC_REFERENCE").unwrap(),
        &env::var("DIMA_SEMANTIC_REFERENCE_SHA256").unwrap(),
    ))
    .unwrap();
    let m = &data["metadata"];
    assert_eq!(m["format"], 1);
    assert_eq!(
        m["nodeSha256"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    for (k, v) in [
        ("node", "24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("icu", "78.3"),
        ("unicode", "17.0"),
        ("typescript", "5.9.3"),
        ("mongoose", "8.24.2"),
    ] {
        assert_eq!(m["versions"][k], v);
    }
    for (k, v) in [
        (
            "src/utils/moderation/semantic.ts",
            "8e14987048727194d8e55b48f5c0890a0984c3fd1fa4634488c8758d1a835e25",
        ),
        (
            "src/utils/ai/openrouter/app_attribution.util.ts",
            "0073e0b48172fc7ccc449fb6c47e1bcd4ffe39549d6641d32b1d0718a6e01c0c",
        ),
        (
            "tests/fixtures/moderation_spam_source.cjs",
            "24173a6f2eb5979c89aa27cf5804c4c2c9f92df02daf7a66d9479e5e52cb7b8a",
        ),
    ] {
        assert_eq!(m["pins"][k], v);
    }
    assert_eq!(
        m["loaderSha256"],
        env::var("DIMA_SEMANTIC_LOADER_SHA256").unwrap()
    );
    assert_eq!(
        m["readerSha256"],
        env::var("DIMA_SEMANTIC_READER_SHA256").unwrap()
    );
    assert_eq!(
        m["spamLoaderSha256"],
        env::var("DIMA_SPAM_LOADER_SHA256").unwrap()
    );
    assert_eq!(m["runtimeExports"].as_array().unwrap().len(), 10);
    assert_eq!(m["typeExports"], json!(["SemanticResult"]));
    assert_eq!(m["privateTypes"], json!(["SemanticState"]));
    assert_eq!(m["mongooseFiles"].as_object().unwrap().len(), 707);
    assert_eq!(
        digest::sha256_hex(&serde_json::to_vec(&m["mongooseFiles"]).unwrap()),
        "63200fe45fbe04c23f601aaa191eb08934ea6795a4442d22ca5a5ba9b679b722"
    );
    for (k, v) in [
        (
            "loadedBinarySha256",
            "94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb",
        ),
        (
            "sourceManifestSha256",
            "e33073a155ce1180ee2cc52dc8ae548d3a0d24d5c81c2fbd8082834638c15664",
        ),
        (
            "buildProvenanceSha256",
            "4efad596bf97c83c92a825c0bb2452b182051066174951eb2644e8a6bda9ad4c",
        ),
    ] {
        assert_eq!(m["re2Runtime"][k], v);
    }
    assert_eq!(
        m["caseCount"].as_u64().unwrap() as usize,
        data["cases"].as_array().unwrap().len()
    );
    assert_eq!(
        m["evaluateCount"].as_u64().unwrap() as usize,
        data["evaluate"].as_array().unwrap().len()
    );
    data
}
// Use JsonValueRef for wire comparison without lossy serde conversion.
pub fn wire(value: &JsonValue) -> String {
    let mut out = String::new();
    JsonValueRef::Value(value).write_json_string(&mut out);
    out
}
