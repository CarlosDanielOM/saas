#![cfg(feature = "moderation-variations")]
use dima_rust::utils::{js_string::JsString, lossless_json::JsonValue, moderation::variations::*};
use std::borrow::Cow;

#[test]
fn terms_preserve_nfc_whitespace_utf16_and_source_validation_order() {
    assert_eq!(
        variation_term(&"  E\u{301}\tΣ  ".into()),
        JsString::from("é σ")
    );
    assert_eq!(
        variation_term(&JsString::from_units(vec![0xd800, 32, 0x41])).units(),
        vec![0xd800, 32, 0x61]
    );
    assert_eq!(
        variation_terms(Some(&JsonValue::Array(vec![
            JsonValue::String(" É ".into()),
            JsonValue::String("e\u{301}".into())
        ])))
        .unwrap(),
        vec![JsString::from("é")]
    );
    assert!(
        variation_terms(Some(&JsonValue::Array(vec![JsonValue::String(
            "😀".repeat(51).into()
        )])))
        .is_err()
    );
    assert_eq!(variation_allow_spaces(None), Ok(false));
    assert_eq!(
        variation_allow_spaces(Some(&JsonValue::Null))
            .unwrap_err()
            .0,
        "Match spaces must be true or false"
    );
    assert_eq!(variation_mode(None), Ok(VariationMode::Off));
    assert_eq!(
        variation_mode(Some(&JsonValue::Null)).unwrap_err().0,
        "Invalid word variations"
    );
}
#[test]
fn compiler_spacing_and_matching() {
    let entry = build_variation(
        &"rinn".into(),
        Some(&JsonValue::Array(vec![JsonValue::String("rin".into())])),
    )
    .unwrap();
    assert_eq!(entry.pattern.source.as_str(), Some("(?:r+i+n+)"));
    assert!(matches!(
        with_variation_spacing(&entry, false, VariationMode::Common).unwrap(),
        Cow::Borrowed(_)
    ));
    let broad = with_variation_spacing(&entry, true, VariationMode::Broad)
        .unwrap()
        .into_owned();
    assert_eq!(
        broad.pattern.source.as_str(),
        Some("(?:r(?:\\s*r)*(?:\\s*[i1!¡|])+(?:\\s*n)+)")
    );
    validate_variations(std::slice::from_ref(&entry), true, VariationMode::Broad).unwrap();
    assert_eq!(
        validate_variations(&[entry], false, VariationMode::Off)
            .unwrap_err()
            .0,
        "Generated pattern failed validation"
    );
}
#[test]
fn overrides_check_membership_before_regex_and_cache_is_bounded() {
    let item = JsonValue::Object(vec![
        ("term".into(), JsonValue::String("other".into())),
        ("source".into(), JsonValue::String("(".into())),
    ]);
    assert_eq!(
        variation_overrides(
            Some(&JsonValue::Array(vec![item])),
            &["cat".into()],
            VariationMode::Common
        )
        .unwrap_err()
        .0,
        "Each edited regex must belong to a different blocked word"
    );
    let cache = VariationCache::new();
    let shared = cache.clone();
    let mut first = build_variation(&"cat".into(), None).unwrap();
    first.version = "0".into();
    let initial = cache
        .with_spacing_shared(&first, true, VariationMode::Common)
        .unwrap();
    for i in 1..1000 {
        let mut entry = first.clone();
        entry.version = format!("{i}").into();
        cache
            .with_spacing(&entry, true, VariationMode::Common)
            .unwrap();
    }
    let hit = cache
        .with_spacing_shared(&first, true, VariationMode::Common)
        .unwrap();
    let (CompiledVariation::Shared(a), CompiledVariation::Shared(b)) = (&initial, &hit) else {
        panic!("expected cached values")
    };
    assert!(std::sync::Arc::ptr_eq(a, b));
    let mut overflow = first.clone();
    overflow.version = "1000".into();
    cache
        .with_spacing(&overflow, true, VariationMode::Common)
        .unwrap();
    assert_eq!(shared.len(), 1000);
    let after = shared
        .with_spacing_shared(&first, true, VariationMode::Common)
        .unwrap();
    let CompiledVariation::Shared(after) = after else {
        panic!("expected cached value")
    };
    assert!(!std::sync::Arc::ptr_eq(a, &after));
}

// The parent generates this source-bound fixture in an isolated environment.
// Set DIMA_VARIATIONS_REFERENCE to its absolute path to replay the value API.
#[test]
#[ignore = "requires independently hashed actual-source fixture"]
fn external_source_fixture_replays_native_value_calls() {
    use dima_rust::utils::moderation::advanced::Boundary;
    use serde_json::{Value, json};
    fn decode(v: &Value) -> Option<JsonValue> {
        Some(match v["kind"].as_str().unwrap() {
            "undefined" => return None,
            "null" | "hole" => JsonValue::Null,
            "boolean" => JsonValue::Bool(v["value"].as_bool().unwrap()),
            "number" => JsonValue::Number(f64::from_bits(
                u64::from_str_radix(v["bits"].as_str().unwrap(), 16).unwrap(),
            )),
            "string" => JsonValue::String(JsString::from_units(
                v["utf16"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_u64().unwrap() as u16)
                    .collect(),
            )),
            "array" => JsonValue::Array(
                v["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| decode(v).unwrap_or(JsonValue::Null))
                    .collect(),
            ),
            "object" => JsonValue::Object(
                v["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|pair| {
                        (
                            JsString::from_units(
                                pair[0]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .map(|n| n.as_u64().unwrap() as u16)
                                    .collect(),
                            ),
                            decode(&pair[1]).unwrap_or(JsonValue::Null),
                        )
                    })
                    .collect(),
            ),
            other => panic!("unknown tag {other}"),
        })
    }
    fn encode(v: &JsonValue) -> Value {
        match v {
            JsonValue::Null => json!({"kind":"null"}),
            JsonValue::Bool(b) => json!({"kind":"boolean","value":b}),
            JsonValue::Number(n) => json!({"kind":"number","bits":format!("{:016x}",n.to_bits())}),
            JsonValue::String(s) => json!({"kind":"string","utf16":s.units()}),
            JsonValue::Array(v) => {
                json!({"kind":"array","items":v.iter().map(encode).collect::<Vec<_>>()})
            }
            JsonValue::Object(v) => {
                json!({"kind":"object","entries":v.iter().map(|(k,v)| json!([k.units(),encode(v)])).collect::<Vec<_>>()})
            }
        }
    }
    fn obj(fields: Vec<(&str, JsonValue)>) -> JsonValue {
        JsonValue::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }
    fn entry(e: &GeneratedVariation) -> JsonValue {
        obj(vec![
            ("term", JsonValue::String(e.term.clone())),
            (
                "spellings",
                JsonValue::Array(e.spellings.iter().cloned().map(JsonValue::String).collect()),
            ),
            (
                "pattern",
                obj(vec![
                    ("id", JsonValue::String(e.pattern.id.clone())),
                    ("source", JsonValue::String(e.pattern.source.clone())),
                    (
                        "boundary",
                        JsonValue::String(
                            match e.pattern.boundary {
                                Boundary::WholeWord => "whole_word",
                                Boundary::Anywhere => "anywhere",
                            }
                            .into(),
                        ),
                    ),
                    ("ignoreCase", JsonValue::Bool(e.pattern.ignore_case)),
                ]),
            ),
            ("version", JsonValue::String(e.version.clone())),
        ])
    }
    use sha2::{Digest, Sha256};
    let path =
        std::env::var("DIMA_VARIATIONS_REFERENCE").expect("external source fixture required");
    let expected_sha =
        std::env::var("DIMA_VARIATIONS_REFERENCE_SHA256").expect("independent SHA-256");
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), expected_sha);
    let fixture: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(fixture["cases"].as_array().unwrap().len(), 175);
    let mut checked = 0;
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["export"].as_str().unwrap();
        let args: Vec<_> = case["args"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(decode)
            .collect();
        let arg = |i: usize| args.get(i).and_then(Option::as_ref);
        let mode_arg = |i| match arg(i) {
            Some(JsonValue::String(s)) if s.as_str() == Some("off") => VariationMode::Off,
            Some(JsonValue::String(s)) if s.as_str() == Some("broad") => VariationMode::Broad,
            _ => VariationMode::Common,
        };
        let bool_arg = |i| matches!(arg(i), Some(JsonValue::Bool(true)));
        if name == "variationTerm" || name == "variationKey" {
            let result = if name == "variationTerm" {
                variation_term_value(arg(0))
            } else {
                let Some(JsonValue::String(channel)) = arg(0) else {
                    panic!()
                };
                variation_key_value(channel, arg(1)).map(JsString::from)
            };
            let expected = &case["result"];
            checked += 1;
            match result {
                Ok(value) => {
                    assert_eq!(expected["ok"], true, "{}", case["id"]);
                    assert_eq!(
                        encode(&JsonValue::String(value)),
                        expected["value"],
                        "{}",
                        case["id"]
                    );
                }
                Err(e) => {
                    assert_eq!(expected["ok"], false, "{}", case["id"]);
                    assert_eq!(
                        e.name.encode_utf16().collect::<Vec<_>>(),
                        expected["name"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|n| n.as_u64().unwrap() as u16)
                            .collect::<Vec<_>>(),
                        "{}",
                        case["id"]
                    );
                    assert_eq!(
                        e.message.encode_utf16().collect::<Vec<_>>(),
                        expected["message"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|n| n.as_u64().unwrap() as u16)
                            .collect::<Vec<_>>(),
                        "{}",
                        case["id"]
                    );
                }
            }
            continue;
        }
        if name == "validateVariations" {
            let result = validate_variations_value(arg(0).unwrap(), bool_arg(1), mode_arg(2));
            let expected = &case["result"];
            checked += 1;
            match result {
                Ok(()) => {
                    assert_eq!(expected["ok"], true, "{}", case["id"]);
                    assert_eq!(expected["value"]["kind"], "undefined");
                }
                Err(e) => {
                    assert_eq!(expected["ok"], false, "{}", case["id"]);
                    assert_eq!(
                        e.0.encode_utf16().collect::<Vec<_>>(),
                        expected["message"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|n| n.as_u64().unwrap() as u16)
                            .collect::<Vec<_>>(),
                        "{}",
                        case["id"]
                    );
                }
            }
            continue;
        }
        let result: Option<Result<JsonValue, VariationError>> = match name {
            "withVariationSpacing" => Some(
                with_variation_spacing_value(arg(0).unwrap(), bool_arg(1), mode_arg(2))
                    .map(CompiledVariationValue::into_owned),
            ),
            "compileRuleVariations" => {
                Some(compile_rule_variations_value(arg(0).unwrap()).map(Cow::into_owned))
            }
            "rulePatterns" => Some(rule_patterns_value(arg(0).unwrap()).map(Cow::into_owned)),
            "variationAllowSpaces" => Some(variation_allow_spaces(arg(0)).map(JsonValue::Bool)),
            "variationMode" => Some(variation_mode(arg(0)).map(|v| {
                JsonValue::String(
                    match v {
                        VariationMode::Off => "off",
                        VariationMode::Common => "common",
                        VariationMode::Broad => "broad",
                    }
                    .into(),
                )
            })),
            "variationTerms" => Some(
                variation_terms(arg(0))
                    .map(|v| JsonValue::Array(v.into_iter().map(JsonValue::String).collect())),
            ),
            "variationTerm" => match arg(0) {
                Some(JsonValue::String(s)) => Some(Ok(JsonValue::String(variation_term(s)))),
                _ => None,
            },
            "variationKey" => match (arg(0), arg(1)) {
                (Some(JsonValue::String(c)), Some(JsonValue::String(s))) => {
                    Some(Ok(JsonValue::String(variation_key(c, s).into())))
                }
                _ => None,
            },
            "buildVariation" => match arg(0) {
                Some(JsonValue::String(s)) => Some(build_variation(s, arg(1)).map(|e| entry(&e))),
                _ => None,
            },
            "variationOverrides" => {
                let terms = match arg(1) {
                    Some(JsonValue::Array(v)) => v
                        .iter()
                        .map(|s| match s {
                            JsonValue::String(s) => s.clone(),
                            _ => panic!(),
                        })
                        .collect::<Vec<_>>(),
                    _ => panic!(),
                };
                let mode = match arg(2) {
                    Some(JsonValue::String(s)) if s.as_str() == Some("off") => VariationMode::Off,
                    _ => VariationMode::Common,
                };
                Some(variation_overrides(arg(0), &terms, mode).map(|v| {
                    JsonValue::Array(
                        v.into_iter()
                            .map(|o| {
                                obj(vec![
                                    ("term", JsonValue::String(o.term)),
                                    ("source", JsonValue::String(o.source)),
                                ])
                            })
                            .collect(),
                    )
                }))
            }
            _ => None,
        };
        let Some(result) = result else {
            assert_eq!(name, "museVariationRequest", "unhandled pure export");
            continue;
        };
        checked += 1;
        let expected = &case["result"];
        match result {
            Ok(value) => {
                assert_eq!(expected["ok"], true, "{}", case["id"]);
                if matches!(
                    name,
                    "withVariationSpacing" | "compileRuleVariations" | "rulePatterns"
                ) {
                    assert_eq!(
                        value.to_json_string().encode_utf16().collect::<Vec<_>>(),
                        expected["wire"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|n| n.as_u64().unwrap() as u16)
                            .collect::<Vec<_>>(),
                        "{}",
                        case["id"]
                    );
                } else {
                    assert_eq!(encode(&value), expected["value"], "{}", case["id"]);
                }
            }
            Err(e) => {
                assert_eq!(expected["ok"], false, "{}", case["id"]);
                assert_eq!(
                    e.0.encode_utf16().collect::<Vec<_>>(),
                    expected["message"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|n| n.as_u64().unwrap() as u16)
                        .collect::<Vec<_>>(),
                    "{}",
                    case["id"]
                );
            }
        }
    }
    assert_eq!(checked, 173, "all pure cases must be replayed");
}

#[test]
fn value_rule_spreads_unknown_fields_and_shares_cached_identity() {
    use dima_rust::utils::lossless_json::parse_json;
    let entry = parse_json(r#"{"term":"cat","spellings":["cat"],"pattern":{"id":"a","source":"x","boundary":"whole_word","ignoreCase":true,"extra":3},"version":"v","extra":"kept"}"#).unwrap();
    let cache = VariationValueCache::new();
    let clone = cache.clone();
    let a = cache
        .with_spacing(&entry, true, VariationMode::Common)
        .unwrap();
    let b = clone
        .with_spacing(&entry, true, VariationMode::Common)
        .unwrap();
    match (&a, &b) {
        (CompiledVariationValue::Shared(a), CompiledVariationValue::Shared(b)) => {
            assert!(std::sync::Arc::ptr_eq(a, b))
        }
        _ => panic!("expected shared cache hit"),
    }
    assert_eq!(a.as_ref().get("extra"), entry.get("extra"));
    assert_eq!(
        a.as_ref().get("pattern").unwrap().get("extra"),
        entry.get("pattern").unwrap().get("extra")
    );
    let rule =
        parse_json(r#"{"extra":9,"variations":{"mode":"off","entries":[],"extra":true}}"#).unwrap();
    assert!(matches!(
        compile_rule_variations_value(&rule).unwrap(),
        Cow::Borrowed(_)
    ));
}
