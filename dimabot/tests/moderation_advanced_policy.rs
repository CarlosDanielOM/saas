#![cfg(feature = "moderation-advanced-policy")]

use dima_rust::utils::{lossless_json_view::JsonDocument, moderation::advanced_policy::*};

fn parse(input: &str) -> Result<SemanticPolicy, &'static str> {
    let document = JsonDocument::parse(input).unwrap();
    parse_semantic_policy(document.root().get("semantic"))
}

#[test]
fn defaults_types_constants_and_paid_tiers() {
    let mut first = empty_semantic_policy();
    first.examples.push(PolicyExample {
        message: "x".into(),
        label: ExampleLabel::Allow,
    });
    assert!(empty_semantic_policy().examples.is_empty());
    assert_eq!(parse("{}").unwrap(), empty_semantic_policy());
    assert_eq!(
        (
            MODERATION_RETENTION_DAYS,
            MODERATION_VISIBLE_DAYS,
            SEMANTIC_DEADLINE_MS
        ),
        (180, 30, 4000)
    );
    assert_eq!(
        (SEMANTIC_MODEL, DECISION_POLICY_VERSION, ALLOW_THRESHOLD),
        ("respan/span-01-lite", "contextual-v2", 0.1)
    );
    for (input, expected) in [
        ("\"premium\"", true),
        ("\"pro\"", true),
        ("\"Premium\"", false),
        ("null", false),
        ("[]", false),
        ("true", false),
    ] {
        let doc = JsonDocument::parse(input).unwrap();
        assert_eq!(paid_moderation(Some(doc.root())), expected);
    }
    assert!(!paid_moderation(None));
}

#[test]
fn normalization_preserves_utf16_and_ignores_interface_only_keys() {
    let policy = parse(r#"{"semantic":{"enabled":true,"thresholdPercent":-0,"policy":" \ufeff\ud800 x \ufeff ","categories":["bad"],"broadcasterInvitation":true,"examples":[{"message":" \udc00 ","label":"violation"}]}}"#).unwrap();
    assert_eq!(policy.policy.units(), vec![0xd800, 32, 120]);
    assert_eq!(policy.examples[0].message.units(), vec![32, 0xdc00, 32]);
    assert_eq!(policy.examples[0].label, ExampleLabel::Violation);
    assert_eq!(
        policy.threshold_percent.unwrap().to_bits(),
        (-0.0f64).to_bits()
    );
    assert_eq!(policy.categories, None);
    assert_eq!(policy.broadcaster_invitation, None);
}

#[test]
fn error_order_and_presence_are_source_ordered() {
    for (input, error) in [
        (r#"{"semantic":null}"#, "Invalid contextual policy"),
        (r#"{"semantic":[]}"#, "Invalid contextual policy"),
        (
            r#"{"semantic":{"enabled":null,"thresholdPercent":null}}"#,
            "Invalid contextual review switch",
        ),
        (
            r#"{"semantic":{"thresholdPercent":null,"policy":null}}"#,
            "Flagging confidence must be a percentage from 0 to 100",
        ),
        (
            r#"{"semantic":{"policy":null,"onUncertain":null}}"#,
            "Policy must be text",
        ),
        (
            r#"{"semantic":{"enabled":true,"policy":" ","onUncertain":null}}"#,
            "Enabled contextual review needs a policy of 1–2000 characters",
        ),
        (
            r#"{"semantic":{"onUncertain":null,"examples":null}}"#,
            "Uncertain decisions must allow and log",
        ),
        (
            r#"{"semantic":{"examples":null}}"#,
            "Examples must be a list",
        ),
        (
            r#"{"semantic":{"examples":[null]}}"#,
            "Each example needs a message of 1–500 characters and an allow/violation label",
        ),
    ] {
        assert_eq!(parse(input).unwrap_err(), error, "{input}");
    }
}

#[test]
fn utf16_boundaries_examples_and_duplicate_keys() {
    for (count, ok) in [(1000, true), (1001, false)] {
        let input = format!(
            "{{\"semantic\":{{\"enabled\":true,\"policy\":\"{}\"}}}}",
            "😀".repeat(count)
        );
        assert_eq!(parse(&input).is_ok(), ok);
    }
    for (count, ok) in [(250, true), (251, false)] {
        let input = format!(
            "{{\"semantic\":{{\"examples\":[{{\"message\":\"{}\",\"label\":\"allow\"}}]}}}}",
            "😀".repeat(count)
        );
        assert_eq!(parse(&input).is_ok(), ok);
    }
    let many = format!(
        "{{\"semantic\":{{\"examples\":[{}]}}}}",
        ["null"; 11].join(",")
    );
    assert_eq!(
        parse(&many).unwrap_err(),
        "At most 10 policy examples are allowed"
    );
    assert!(parse(r#"{"semantic":{"enabled":null,"enabled":false}}"#).is_ok());
    assert!(parse(r#"{"semantic":{"policy":"\u200b","enabled":true}}"#).is_ok());
}

#[path = "support/sha256.rs"]
mod digest;

// This replay uses only the semantic-prefixed, blacklist cases. It does not
// claim coverage of regex, rule-type restriction, or arbitrary JS values.
#[test]
#[ignore = "requires independently hashed external actual-source fixture"]
fn source_semantic_subset_replay() {
    use dima_rust::utils::{js_string::JsString, lossless_json::JsonValue};
    use serde_json::Value;

    fn units(v: &Value) -> JsString {
        JsString::from_units(
            v.as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_u64().unwrap() as u16)
                .collect(),
        )
    }
    fn field<'a>(v: &'a Value, name: &str) -> Option<&'a Value> {
        assert_eq!(v["kind"], "object");
        v["entries"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find_map(|entry| (units(&entry[0]).as_str() == Some(name)).then_some(&entry[1]))
    }
    fn number(v: &Value) -> f64 {
        assert_eq!(v["kind"], "number");
        f64::from_bits(u64::from_str_radix(v["bits"].as_str().unwrap(), 16).unwrap())
    }
    // Undefined object properties become absent. Undefined array entries are
    // rejected; treating them as null generally changes source semantics.
    fn ordinary(v: &Value, out: &mut String) -> Result<(), ()> {
        match v["kind"].as_str().unwrap() {
            "null" => out.push_str("null"),
            "boolean" => out.push_str(if v["value"].as_bool().unwrap() {
                "true"
            } else {
                "false"
            }),
            "string" => units(&v["utf16"]).write_json_string(out),
            "number" => {
                let n = number(v);
                if !n.is_finite() {
                    return Err(());
                }
                if n.to_bits() == (-0.0f64).to_bits() {
                    out.push_str("-0");
                } else {
                    JsonValue::Number(n).write_json_string(out);
                }
            }
            "array" => {
                out.push('[');
                for (index, item) in v["items"].as_array().unwrap().iter().enumerate() {
                    if index != 0 {
                        out.push(',');
                    }
                    ordinary(item, out)?;
                }
                out.push(']');
            }
            "object" => {
                out.push('{');
                let mut first = true;
                for entry in v["entries"].as_array().unwrap() {
                    if entry[1]["kind"] == "undefined" {
                        continue;
                    }
                    if !first {
                        out.push(',');
                    }
                    first = false;
                    units(&entry[0]).write_json_string(out);
                    out.push(':');
                    ordinary(&entry[1], out)?;
                }
                out.push('}');
            }
            "undefined" => return Err(()),
            _ => panic!("unexpected fixture tag"),
        }
        Ok(())
    }
    fn text(v: &Value) -> JsString {
        assert_eq!(v["kind"], "string");
        units(&v["utf16"])
    }
    fn semantic_matches(actual: &SemanticPolicy, expected: &Value) {
        assert_eq!(expected["entries"].as_array().unwrap().len(), 5);
        assert_eq!(actual.categories, None);
        assert_eq!(actual.broadcaster_invitation, None);
        assert_eq!(
            field(expected, "enabled").unwrap()["value"]
                .as_bool()
                .unwrap(),
            actual.enabled
        );
        assert_eq!(
            number(field(expected, "thresholdPercent").unwrap()).to_bits(),
            actual.threshold_percent.unwrap().to_bits()
        );
        assert_eq!(text(field(expected, "policy").unwrap()), actual.policy);
        assert_eq!(
            text(field(expected, "onUncertain").unwrap()).as_str(),
            Some("allow_and_log")
        );
        assert_eq!(actual.on_uncertain, OnUncertain::AllowAndLog);
        let examples = field(expected, "examples").unwrap()["items"]
            .as_array()
            .unwrap();
        assert_eq!(actual.examples.len(), examples.len());
        for (actual, expected) in actual.examples.iter().zip(examples) {
            assert_eq!(expected["entries"].as_array().unwrap().len(), 2);
            assert_eq!(actual.message, text(field(expected, "message").unwrap()));
            let label = text(field(expected, "label").unwrap());
            assert_eq!(
                label.as_str(),
                Some(match actual.label {
                    ExampleLabel::Allow => "allow",
                    ExampleLabel::Violation => "violation",
                })
            );
        }
    }
    let path = std::env::var("DIMA_MODERATION_ADVANCED_FIXTURE").expect("external fixture path");
    let expected_hash = std::env::var("DIMA_MODERATION_ADVANCED_FIXTURE_SHA256")
        .expect("independent fixture SHA-256");
    assert_eq!(
        expected_hash,
        "dbdc74c2127fdbe434de83bb4153521d4cc22b639bb7c08c10db375da2e0c78a"
    );
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(digest::sha256_hex(&bytes), expected_hash);
    let fixture: Value = serde_json::from_slice(&bytes).unwrap();
    let constants = &fixture["constants"];
    assert_eq!(constants["entries"].as_array().unwrap().len(), 6);
    for (key, actual) in [
        (
            "MODERATION_RETENTION_DAYS",
            MODERATION_RETENTION_DAYS as f64,
        ),
        ("MODERATION_VISIBLE_DAYS", MODERATION_VISIBLE_DAYS as f64),
        ("SEMANTIC_DEADLINE_MS", SEMANTIC_DEADLINE_MS as f64),
        ("ALLOW_THRESHOLD", ALLOW_THRESHOLD),
    ] {
        assert_eq!(
            number(field(constants, key).unwrap()).to_bits(),
            actual.to_bits()
        );
    }
    assert_eq!(
        text(field(constants, "SEMANTIC_MODEL").unwrap()).as_str(),
        Some(SEMANTIC_MODEL)
    );
    assert_eq!(
        text(field(constants, "DECISION_POLICY_VERSION").unwrap()).as_str(),
        Some(DECISION_POLICY_VERSION)
    );
    let paid = fixture["paid"].as_array().unwrap();
    assert_eq!(paid.len(), 14);
    for case in paid {
        let tier = &case["tier"];
        let mut input = String::new();
        if tier["kind"] == "undefined" {
            assert_eq!(paid_moderation(None), case["result"].as_bool().unwrap());
        } else {
            ordinary(tier, &mut input).unwrap();
            let doc = JsonDocument::parse(&input).unwrap();
            assert_eq!(
                paid_moderation(Some(doc.root())),
                case["result"].as_bool().unwrap()
            );
        }
    }
    let prefixes = [
        "semantic-shape-",
        "semantic-error-order-",
        "threshold-",
        "policy-",
        "example-",
        "uncertain-",
    ];
    let mut selected = 0;
    let mut skipped = 0;
    let mut replayed = 0;
    for case in fixture["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        if case["kind"] != "parse" || !prefixes.iter().any(|p| id.starts_with(p)) {
            continue;
        }
        selected += 1;
        let input = &case["input"];
        assert_eq!(input["kind"], "object", "{id}");
        assert_eq!(
            text(field(input, "type").unwrap()).as_str(),
            Some("blacklist"),
            "{id}"
        );
        if let Some(patterns) = field(input, "patterns") {
            assert!(
                patterns["kind"] == "undefined"
                    || (patterns["kind"] == "array"
                        && patterns["items"].as_array().unwrap().is_empty()),
                "{id}"
            );
        }
        let mut json = String::new();
        if ordinary(input, &mut json).is_err() {
            skipped += 1;
            continue;
        }
        replayed += 1;
        let doc = JsonDocument::parse(&json).unwrap();
        let actual = parse_semantic_policy(doc.root().get("semantic"));
        let result = &case["result"];
        if result["ok"].as_bool().unwrap() {
            let rule = &result["value"];
            assert_eq!(rule["entries"].as_array().unwrap().len(), 2, "{id}");
            assert!(
                field(rule, "patterns").unwrap()["items"]
                    .as_array()
                    .unwrap()
                    .is_empty(),
                "{id}"
            );
            semantic_matches(&actual.unwrap(), field(rule, "semantic").unwrap());
        } else {
            assert_eq!(units(&result["name"]).as_str(), Some("Error"), "{id}");
            assert_eq!(
                JsString::from(actual.unwrap_err()),
                units(&result["message"]),
                "{id}"
            );
        }
    }
    assert_eq!((selected, skipped, replayed), (84, 3, 81));
}
