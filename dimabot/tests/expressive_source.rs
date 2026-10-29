#![cfg(feature = "tts-utilities")]

// Replays an external fixture generated from the actual TypeScript modules.
// Run with EXPRESSIVE_TTS_FIXTURE_DIR=/artifacts/expressive-tts and --ignored.
use dima_rust::utils::{
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    tts::{
        DEFAULT_KOKORO_VOICE_EN, DEFAULT_KOKORO_VOICE_ES, DELIVERY, EFFECTS, EMOTIONS,
        KOKORO_VOICES, SOUNDS, TtsProvider, expressive_tags, filter_expressive_tts_tags_js,
        normalize_expressive_tags, reinforce_fish_tts_tags_js, resolve_kokoro_voice,
        resolve_kokoro_voice_str,
    },
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf};

// Config strings are only inspected for boolean type. Preserve nullishness,
// booleans and object structure even if a string contains an unpaired unit.
fn config_projection(value: &JsonValue) -> Value {
    match value {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(v) => json!(v),
        JsonValue::Number(v) => json!(v),
        JsonValue::String(v) => json!(v.as_str().unwrap_or("")),
        JsonValue::Array(items) => Value::Array(items.iter().map(config_projection).collect()),
        JsonValue::Object(fields) => Value::Object(
            fields
                .iter()
                .filter_map(|(k, v)| k.as_str().map(|key| (key.to_owned(), config_projection(v))))
                .collect(),
        ),
    }
}

fn string_output(value: &JsString) -> Value {
    json!({"units": value.units(), "wire": value.to_json_string()})
}

#[test]
#[ignore = "requires EXPRESSIVE_TTS_FIXTURE_DIR from the isolated actual-TypeScript oracle"]
fn expressive_and_kokoro_actual_source() {
    let dir = std::env::var_os("EXPRESSIVE_TTS_FIXTURE_DIR")
        .expect("EXPRESSIVE_TTS_FIXTURE_DIR is required");
    let path = PathBuf::from(dir).join("expressive-tts-reference.json");
    let bytes = std::fs::read(path).expect("actual-TypeScript fixture missing");
    assert!(!bytes.is_empty(), "actual-TypeScript fixture is empty");
    let fixture: Value = serde_json::from_slice(&bytes).expect("invalid fixture envelope");
    assert_eq!(fixture["schema"], 1);
    assert_eq!(fixture["provenance"]["node"], "v24.22.1");
    assert_eq!(fixture["provenance"]["v8"], "13.6.233.17-node.58");
    for key in [
        "src/utils/tts/expressive_tts_tags.util.ts",
        "src/utils/tts/kokoro_voices.util.ts",
        "tests/fixtures/expressive_tts_reference.mjs",
        "package.json",
        "package-lock.json",
        "node_modules/typescript/package.json",
        "node_modules/typescript/lib/typescript.js",
        "node-executable",
    ] {
        let hash = fixture["provenance"]["sourceHashes"][key]
            .as_str()
            .expect("missing hash");
        assert_eq!(hash.len(), 64, "invalid hash for {key}");
        assert!(
            hash.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid hash for {key}"
        );
    }
    let metadata = &fixture["metadata"];
    assert_eq!(
        metadata["expressiveExports"],
        json!([
            "EXPRESSIVE_TTS_TAGS",
            "EXPRESSIVE_TTS_TAG_GROUPS",
            "filterExpressiveTtsTags",
            "normalizeExpressiveTtsTags",
            "reinforceFishTtsTags"
        ])
    );
    assert_eq!(
        metadata["kokoroExports"],
        json!([
            "DEFAULT_KOKORO_VOICES",
            "KOKORO_VOICES",
            "resolveKokoroVoice"
        ])
    );
    assert_eq!(
        metadata["groups"],
        json!([
            {"name":"emotions", "tags":EMOTIONS},
            {"name":"delivery", "tags":DELIVERY},
            {"name":"sounds", "tags":SOUNDS},
            {"name":"effects", "tags":EFFECTS}
        ])
    );
    assert_eq!(
        metadata["tags"],
        json!(expressive_tags().collect::<Vec<_>>())
    );
    assert_eq!(metadata["tags"].as_array().unwrap().len(), 75);
    assert_eq!(
        metadata["typeExports"],
        json!(["ExpressiveTtsTag", "ExpressiveTtsTagSettings"])
    );
    assert_eq!(metadata["voices"], json!(KOKORO_VOICES));
    assert_eq!(metadata["voices"].as_array().unwrap().len(), 54);
    assert_eq!(
        metadata["defaults"],
        json!({"en":DEFAULT_KOKORO_VOICE_EN, "es":DEFAULT_KOKORO_VOICE_ES})
    );
    assert_eq!(metadata["aliases"].as_array().unwrap().len(), 14);

    let cases = fixture["cases"].as_array().expect("missing cases");
    assert!(!cases.is_empty(), "fixture has no cases");
    let mut counts = BTreeMap::<&str, usize>::new();
    for case in cases {
        let op = case["op"].as_str().expect("missing operation");
        *counts.entry(op).or_default() += 1;
        let name = case["name"].as_str().expect("missing name");
        let actual = match op {
            "filter" | "reinforce" => {
                let input = JsString::from_units(
                    case["inputUnits"]
                        .as_array()
                        .expect("missing units")
                        .iter()
                        .map(|v| {
                            u16::try_from(v.as_u64().expect("invalid unit"))
                                .expect("unit exceeds u16")
                        })
                        .collect(),
                );
                if op == "reinforce" {
                    string_output(&reinforce_fish_tts_tags_js(&input))
                } else {
                    let provider = match case["provider"].as_str().expect("missing provider") {
                        "piper" => TtsProvider::Piper,
                        "fish" => TtsProvider::Fish,
                        "kokoro" => TtsProvider::Kokoro,
                        other => panic!("unexpected provider {other}"),
                    };
                    let enabled: Option<BTreeMap<String, bool>> =
                        case.get("enabledJson").map(|v| {
                            let raw: Value =
                                serde_json::from_str(v.as_str().expect("invalid enabledJson"))
                                    .expect("invalid enabled JSON");
                            raw.as_object()
                                .expect("enabled must be object")
                                .iter()
                                .filter_map(|(k, v)| v.as_bool().map(|b| (k.clone(), b)))
                                .collect()
                        });
                    string_output(&filter_expressive_tts_tags_js(
                        &input,
                        provider,
                        enabled.as_ref(),
                    ))
                }
            }
            "normalize" => {
                let raw = case["inputJson"].as_str().expect("missing inputJson");
                let lossless = parse_json(raw).expect("invalid inputJson");
                let projected = config_projection(&lossless);
                if let Ok(ordinary) = serde_json::from_str::<Value>(raw) {
                    assert_eq!(
                        normalize_expressive_tags(&ordinary),
                        normalize_expressive_tags(&projected),
                        "projection in {name}"
                    );
                }
                json!(normalize_expressive_tags(&projected))
            }
            "voice" => {
                let raw = case["inputJson"].as_str().expect("missing inputJson");
                let lossless = parse_json(raw).expect("invalid inputJson");
                let actual = match lossless {
                    JsonValue::String(value) => value.as_str().and_then(resolve_kokoro_voice_str),
                    _ => None,
                };
                if let Ok(ordinary) = serde_json::from_str::<Value>(raw) {
                    assert_eq!(
                        resolve_kokoro_voice(&ordinary),
                        actual,
                        "value resolver in {name}"
                    );
                }
                json!(actual)
            }
            other => panic!("unexpected operation {other}"),
        };
        assert_eq!(actual, case["expected"], "case {name} ({op})");
    }
    for (op, minimum) in [
        ("filter", 1000),
        ("reinforce", 150),
        ("normalize", 10),
        ("voice", 150),
    ] {
        assert!(
            counts.get(op).copied().unwrap_or(0) >= minimum,
            "missing or truncated {op} corpus"
        );
    }
}
