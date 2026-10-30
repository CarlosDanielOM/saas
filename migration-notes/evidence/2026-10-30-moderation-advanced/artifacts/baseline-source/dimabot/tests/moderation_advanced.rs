#![cfg(feature = "moderation-advanced")]
use dima_rust::utils::{
    js_string::JsString, lossless_json_view::JsonDocument, moderation::advanced::*,
};

fn parse(s: &str) -> Result<AdvancedRule, &'static str> {
    let doc = JsonDocument::parse(s).unwrap();
    parse_advanced_rule_with(doc.root(), &PatternCache::new(), || "generated".into())
}

#[test]
fn parser_order_ids_and_utf16_lengths() {
    assert_eq!(
        parse(r#"{"patterns":[{"source":"("}],"semantic":null}"#).unwrap_err(),
        "Invalid or unsupported regex. Use RE2 syntax without lookaround/backreferences or empty matches; select whole-word boundaries separately."
    );
    assert_eq!(
        parse(r#"{"type":"other","patterns":[{"source":"x"}],"semantic":null}"#).unwrap_err(),
        "Invalid contextual policy"
    );
    assert_eq!(parse(r#"{"type":"blacklist","patterns":[{"source":"x","id":"a\n"},{"source":"x","id":"generated"}]}"#).unwrap_err(), "Regex pattern IDs must be unique");
    let s = format!(
        "{{\"type\":\"blacklist\",\"patterns\":[{{\"source\":\"{}\"}}]}}",
        "😀".repeat(126)
    );
    assert_eq!(
        parse(&s).unwrap_err(),
        "Regex patterns must contain 1–250 characters"
    );
    let rule = parse(r#"{"type":"blacklist","patterns":[{"id":"ok-1","source":"cat"}]}"#).unwrap();
    assert_eq!(rule.patterns[0].boundary, Boundary::WholeWord);
    assert!(rule.patterns[0].ignore_case);
    assert_eq!(
        parse(r#"{"type":"blacklist","patterns":[{"source":"a*"}]}"#).unwrap_err(),
        "Invalid or unsupported regex. Use RE2 syntax without lookaround/backreferences or empty matches; select whole-word boundaries separately."
    );
}

#[test]
fn literal_and_patterns_keep_source_order_and_utf16_spans() {
    let rule = parse(r#"{"type":"blacklist","patterns":[{"id":"dog","source":"dog","boundary":"anywhere"},{"id":"cat","source":"cat"}]}"#).unwrap();
    let result = find_blacklist_matches_with_cache(
        &"😀 CÁT dog cat".into(),
        &["cat".into()],
        &rule.patterns,
        &PatternCache::new(),
    )
    .unwrap();
    assert_eq!(
        result
            .iter()
            .map(|m| (
                m.matcher_id.as_str().unwrap(),
                m.text.to_utf8_lossy(),
                m.start,
                m.end
            ))
            .collect::<Vec<_>>(),
        vec![
            ("literal", "CÁT".into(), 3, 6),
            ("dog", "dog".into(), 7, 10),
            ("cat", "cat".into(), 11, 14)
        ]
    );
}

#[test]
fn cache_is_bounded_and_shared_across_threads() {
    let cache = std::sync::Arc::new(PatternCache::new());
    let p = ModerationPattern {
        id: "a".into(),
        source: "a".into(),
        boundary: Boundary::Anywhere,
        ignore_case: false,
    };
    std::thread::scope(|scope| {
        for _ in 0..4 {
            let cache = cache.clone();
            let p = p.clone();
            scope.spawn(move || {
                find_blacklist_matches_with_cache(&"a".into(), &[], &[p], &cache).unwrap();
            });
        }
    });
    assert_eq!(cache.len(), 1);
    for i in 0..1000 {
        let mut p = p.clone();
        p.id = i.to_string().into();
        find_blacklist_matches_with_cache(&"a".into(), &[], &[p], &cache).unwrap();
    }
    assert_eq!(cache.len(), 1); // 1001st distinct insert clears all first.
}

#[path = "support/sha256.rs"]
mod digest;

mod fixture {
    use super::*;
    use dima_rust::utils::{
        lossless_json::{JsonValue, parse_json},
        moderation::advanced_policy::ExampleLabel,
    };
    use serde_json::Value;

    fn string(v: &Value) -> JsString {
        JsString::from_units(
            v.as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u16)
                .collect(),
        )
    }
    // Preserve undefined object properties by omission, but reject undefined
    // array elements and NaN: JSON cannot encode those JS values losslessly.
    fn json(v: &Value) -> Result<Option<String>, &'static str> {
        Ok(match v["kind"].as_str().unwrap() {
            "undefined" => None,
            "null" => Some("null".into()),
            "boolean" => Some(v["value"].to_string()),
            "string" => Some(string(&v["utf16"]).to_json_string()),
            "number" => {
                let n =
                    f64::from_bits(u64::from_str_radix(v["bits"].as_str().unwrap(), 16).unwrap());
                if n.is_nan() {
                    return Err("NaN");
                }
                Some(if n == f64::INFINITY {
                    "1e9999".into()
                } else if n == f64::NEG_INFINITY {
                    "-1e9999".into()
                } else if n == 0.0 && n.is_sign_negative() {
                    "-0".into()
                } else {
                    n.to_string()
                })
            }
            "array" => {
                let mut parts = Vec::new();
                for item in v["items"].as_array().unwrap() {
                    parts.push(json(item)?.ok_or("undefined array element")?);
                }
                Some(format!("[{}]", parts.join(",")))
            }
            "object" => {
                let mut parts = Vec::new();
                for entry in v["entries"].as_array().unwrap() {
                    if let Some(value) = json(&entry[1])? {
                        parts.push(format!("{}:{}", string(&entry[0]).to_json_string(), value));
                    }
                }
                Some(format!("{{{}}}", parts.join(",")))
            }
            _ => return Err("unsupported fixture kind"),
        })
    }
    fn object(fields: Vec<(&str, JsonValue)>) -> JsonValue {
        JsonValue::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }
    fn pattern(p: &ModerationPattern) -> JsonValue {
        object(vec![
            ("id", JsonValue::String(p.id.clone())),
            ("source", JsonValue::String(p.source.clone())),
            (
                "boundary",
                JsonValue::String(
                    match p.boundary {
                        Boundary::WholeWord => "whole_word",
                        Boundary::Anywhere => "anywhere",
                    }
                    .into(),
                ),
            ),
            ("ignoreCase", JsonValue::Bool(p.ignore_case)),
        ])
    }
    fn rule(r: AdvancedRule) -> JsonValue {
        let s = r.semantic;
        object(vec![
            (
                "patterns",
                JsonValue::Array(r.patterns.iter().map(pattern).collect()),
            ),
            (
                "semantic",
                object(vec![
                    ("enabled", JsonValue::Bool(s.enabled)),
                    (
                        "thresholdPercent",
                        JsonValue::Number(s.threshold_percent.unwrap()),
                    ),
                    ("policy", JsonValue::String(s.policy)),
                    (
                        "examples",
                        JsonValue::Array(
                            s.examples
                                .into_iter()
                                .map(|e| {
                                    object(vec![
                                        ("message", JsonValue::String(e.message)),
                                        (
                                            "label",
                                            JsonValue::String(
                                                match e.label {
                                                    ExampleLabel::Allow => "allow",
                                                    ExampleLabel::Violation => "violation",
                                                }
                                                .into(),
                                            ),
                                        ),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                    ("onUncertain", JsonValue::String("allow_and_log".into())),
                ]),
            ),
        ])
    }
    fn matched(ms: Vec<ModerationMatch>) -> JsonValue {
        JsonValue::Array(
            ms.into_iter()
                .map(|m| {
                    object(vec![
                        ("matcherID", JsonValue::String(m.matcher_id)),
                        ("text", JsonValue::String(m.text)),
                        ("start", JsonValue::Number(m.start as f64)),
                        ("end", JsonValue::Number(m.end as f64)),
                    ])
                })
                .collect(),
        )
    }
    fn view_pattern(v: dima_rust::utils::lossless_json_view::JsonView<'_>) -> ModerationPattern {
        ModerationPattern {
            id: v.get("id").unwrap().as_string().unwrap(),
            source: v.get("source").unwrap().as_string().unwrap(),
            boundary: if v.get("boundary").unwrap().as_string().unwrap().as_str()
                == Some("whole_word")
            {
                Boundary::WholeWord
            } else {
                Boundary::Anywhere
            },
            ignore_case: v.get("ignoreCase").unwrap().as_bool().unwrap(),
        }
    }

    #[test]
    #[ignore = "requires external source oracle fixture; run explicitly"]
    fn replay_all_464_source_cases() {
        let path =
            std::env::var("MODERATION_ADVANCED_FIXTURE").expect("external fixture path required");
        let path = std::path::Path::new(&path);
        assert!(path.is_absolute() && path.is_file());
        assert_eq!(path, path.canonicalize().unwrap());
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .canonicalize()
            .unwrap();
        assert!(!path.starts_with(root), "external fixture required");
        let expected_sha = std::env::var("MODERATION_ADVANCED_FIXTURE_SHA256")
            .expect("independent fixture SHA required");
        assert_eq!(
            expected_sha,
            "dbdc74c2127fdbe434de83bb4153521d4cc22b639bb7c08c10db375da2e0c78a"
        );
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(digest::sha256_hex(&bytes), expected_sha);
        let fixture: Value = serde_json::from_slice(&bytes).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 464);
        let mut excluded = std::collections::BTreeMap::<&str, usize>::new();
        let mut exercised = 0;
        for c in cases {
            let id = c["id"].as_str().unwrap();
            let raw = match json(&c["input"]) {
                Ok(Some(s)) => s,
                Ok(None) => {
                    *excluded.entry("undefined root").or_default() += 1;
                    continue;
                }
                Err(e) => {
                    *excluded.entry(e).or_default() += 1;
                    continue;
                }
            };
            if c["kind"] == "parse" && raw == "null" {
                *excluded.entry("null root TypeError").or_default() += 1;
                continue;
            }
            let doc = JsonDocument::parse(&raw).unwrap();
            let cache = PatternCache::new();
            let expected = &c["result"];
            if c["kind"] == "parse" {
                let mut queue = c["uuidQueue"].as_array().unwrap().iter().map(string);
                let mut draws = Vec::new();
                let actual = parse_advanced_rule_with_fallible_uuid(doc.root(), &cache, || {
                    let id = queue.next();
                    draws.push(id.clone());
                    id.ok_or("fixture UUID queue exhausted")
                });
                let expected_draws: Vec<_> = c["draws"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|value| (!value.is_null()).then(|| string(value)))
                    .collect();
                assert_eq!(draws, expected_draws, "UUID draws {id}");
                match actual {
                    Ok(r) => {
                        assert_eq!(expected["ok"], true, "{id}");
                        let wire = String::from_utf16(
                            &expected["wire"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|u| u.as_u64().unwrap() as u16)
                                .collect::<Vec<_>>(),
                        )
                        .unwrap();
                        assert_eq!(rule(r), parse_json(&wire).unwrap(), "{id}");
                    }
                    Err(e) => {
                        assert_eq!(expected["ok"], false, "{id}: {e}");
                        assert_eq!(JsString::from(e), string(&expected["message"]), "{id}");
                    }
                }
            } else {
                let root = doc.root();
                let text = root.get("text").unwrap().as_string().unwrap();
                let terms: Vec<_> = root
                    .get("terms")
                    .unwrap()
                    .array()
                    .unwrap()
                    .map(|v| v.as_string().unwrap())
                    .collect();
                let patterns: Vec<_> = root
                    .get("patterns")
                    .unwrap()
                    .array()
                    .unwrap()
                    .map(view_pattern)
                    .collect();
                let actual = find_blacklist_matches_with_cache(&text, &terms, &patterns, &cache);
                match actual {
                    Ok(ms) => {
                        assert_eq!(expected["ok"], true, "{id}");
                        let wire = String::from_utf16(
                            &expected["wire"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|u| u.as_u64().unwrap() as u16)
                                .collect::<Vec<_>>(),
                        )
                        .unwrap();
                        assert_eq!(matched(ms), parse_json(&wire).unwrap(), "{id}");
                    }
                    Err(_) => assert_eq!(expected["ok"], false, "{id}"),
                }
            }
            exercised += 1;
        }
        eprintln!("source cases exercised={exercised}; exclusions={excluded:?}");
        assert_eq!(exercised, 462);
        assert_eq!(
            excluded,
            std::collections::BTreeMap::from([("NaN", 1), ("null root TypeError", 1),])
        );
    }
}
