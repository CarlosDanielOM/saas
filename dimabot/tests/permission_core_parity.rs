//! Source-backed parity for `dima_rust::utils::permissions`.
//!
//! Expected values come from the actual TypeScript permission core executed in
//! an isolated VM by `fixtures/permission_core_reference.mjs`; they are not a
//! restatement of the Rust implementation. Regenerate/check the corpus with:
//!
//! ```sh
//! node dimabot/tests/fixtures/permission_core_reference.mjs
//! node dimabot/tests/fixtures/permission_core_reference.mjs --check
//! ```
//!
//! Scope: pure compiled decisions, command/rule wrappers, validation,
//! general Boolean evaluation, inspection, identity serialization/parsing,
//! badge derivation, and role-tag decoding. No IO, cache, or service behavior.
#![cfg(feature = "permissions")]

use std::collections::HashSet;

use dima_rust::utils::permissions::{
    self, CompiledPermission, ExpressionState, RoleTag, UserIdentity,
};
use serde_json::{Map, Value, json};

/// JSON has one numeric type, so integer/f64 encodings are compared by value.
fn equivalent(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| equivalent(value, other)))
        }
        _ => actual == expected,
    }
}

fn identity(value: &Value) -> Result<UserIdentity, String> {
    let level = value
        .get("level")
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("identity level is missing: {value}"))?;
    let tags: Vec<RoleTag> = match value.get("tags") {
        None => Vec::new(),
        Some(Value::Array(tags)) => tags
            .iter()
            .map(|tag| {
                serde_json::from_value::<RoleTag>(tag.clone())
                    .map_err(|error| format!("identity tag {tag} is not a RoleTag: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(other) => return Err(format!("identity tags must be an array: {other}")),
    };
    let user_id = value
        .get("userId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let login = value
        .get("login")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(UserIdentity::new(level, tags, user_id, login))
}

fn config_value(input: &Value, expression_key: &str, level_key: &str) -> Value {
    let mut object = Map::new();
    if let Some(expression) = input.get("expression") {
        object.insert(expression_key.into(), expression.clone());
    }
    if let Some(legacy) = input.get("legacy") {
        object.insert(level_key.into(), legacy.clone());
    }
    Value::Object(object)
}

fn expected_bool(case: &Value) -> Result<bool, String> {
    case.get("expected")
        .and_then(Value::as_bool)
        .ok_or_else(|| "case is missing a boolean expected value".to_owned())
}

fn check_case(case: &Value) -> Result<(), String> {
    let operation = case["operation"]
        .as_str()
        .ok_or_else(|| format!("case has no operation: {case}"))?;
    match operation {
        "validate" => {
            let input = &case["input"]["expression"];
            let accepted = case["accepted"]
                .as_bool()
                .ok_or_else(|| "validate case has no accepted flag".to_owned())?;
            match (permissions::validate_expression(input), accepted) {
                (Ok(validated), true) => {
                    let sanitized = case
                        .get("sanitized")
                        .ok_or_else(|| "valid case has no sanitized tree".to_owned())?;
                    let actual = validated.to_value();
                    if !equivalent(&actual, sanitized) {
                        return Err(format!(
                            "sanitized tree mismatch: expected {sanitized}, got {actual}"
                        ));
                    }
                    if let Some(expected_count) = case.get("nodeCount").and_then(Value::as_u64)
                        && validated.node_count() as u64 != expected_count
                    {
                        return Err(format!(
                            "node count mismatch: expected {expected_count}, got {}",
                            validated.node_count()
                        ));
                    }
                    Ok(())
                }
                (Ok(_), false) => Err("TypeScript rejects this tree but Rust accepted it".into()),
                (Err(error), true) => Err(format!(
                    "TypeScript accepts this tree but Rust rejected it: {error}"
                )),
                (Err(error), false) => {
                    if error.to_string().is_empty() {
                        Err("validation error must expose a non-empty Display message".into())
                    } else {
                        Ok(())
                    }
                }
            }
        }
        "evaluate" => {
            let validated = permissions::validate_expression(&case["input"]["expression"])
                .map_err(|error| format!("fixture evaluation tree must be valid: {error}"))?;
            let identity = identity(&case["input"]["identity"])?;
            let expected = expected_bool(case)?;
            let actual = validated.evaluate(&identity);
            if actual != expected {
                return Err(format!(
                    "Boolean evaluation mismatch: expected {expected}, got {actual} for identity {}",
                    case["input"]["identity"]
                ));
            }
            Ok(())
        }
        "access" => {
            let input = &case["input"];
            let identity = identity(&input["identity"])?;
            let expression = input.get("expression");
            let legacy = input.get("legacy");
            let command = config_value(input, "permissionExpression", "userLevel");
            let rule = config_value(input, "exemptExpression", "exemptUserLevel");
            let expected = expected_bool(case)?;

            let compiled = CompiledPermission::compile(expression, legacy);
            let checks = [
                ("CompiledPermission::allowed", compiled.allowed(&identity)),
                (
                    "CompiledPermission::decide().allowed",
                    compiled.decide(&identity).allowed,
                ),
                (
                    "command_allowed",
                    permissions::command_allowed(Some(&command), &identity),
                ),
                (
                    "rule_exempt",
                    permissions::rule_exempt(Some(&rule), &identity),
                ),
            ];
            for (label, actual) in checks {
                if actual != expected {
                    return Err(format!(
                        "{label} mismatch for command {command} / rule {rule}: expected {expected}, got {actual}"
                    ));
                }
            }
            if let Some(expected_mode) = case.get("expectedMode").and_then(Value::as_str) {
                let actual = serde_json::to_value(compiled.mode())
                    .map_err(|error| format!("mode is not serializable: {error}"))?;
                if actual != Value::String(expected_mode.into()) {
                    return Err(format!(
                        "compiled mode mismatch: expected {expected_mode}, got {actual}"
                    ));
                }
            }
            Ok(())
        }
        "config" => {
            let identity = identity(&case["input"]["identity"])?;
            let command = case["input"].get("command");
            let expected = expected_bool(case)?;
            let actual = permissions::command_allowed(command, &identity);
            if actual != expected {
                let rendered = match command {
                    Some(value) => value.to_string(),
                    None => "None".to_owned(),
                };
                return Err(format!(
                    "command_allowed({rendered}) mismatch: expected {expected}, got {actual}"
                ));
            }
            let exempt = permissions::rule_exempt(command, &identity);
            if exempt != expected {
                return Err(format!(
                    "rule_exempt on the same raw value disagrees: expected {expected}, got {exempt}"
                ));
            }
            Ok(())
        }
        "serialize_identity" => {
            let identity = identity(&case["input"])?;
            let actual = permissions::serialize_user_identity(&identity);
            let expected = case
                .get("expected")
                .ok_or_else(|| "serialize case has no expected identity".to_owned())?;
            if !equivalent(&actual, expected) {
                return Err(format!(
                    "serialized identity mismatch: expected {expected}, got {actual}"
                ));
            }
            Ok(())
        }
        "parse_identity" => {
            let input = &case["input"];
            let fallback = input["fallbackLevel"]
                .as_f64()
                .ok_or_else(|| "parse case has no fallback level".to_owned())?;
            let identity = permissions::parse_user_identity(input.get("raw"), fallback);
            let actual = permissions::serialize_user_identity(&identity);
            let expected = case
                .get("expected")
                .ok_or_else(|| "parse case has no expected identity".to_owned())?;
            if !equivalent(&actual, expected) {
                return Err(format!(
                    "parsed identity mismatch: expected {expected}, got {actual}"
                ));
            }
            Ok(())
        }
        "badge_level" => {
            let null = Value::Null;
            let badges = case["input"].get("badges").unwrap_or(&null);
            let expected = case["expected"]
                .as_f64()
                .ok_or_else(|| "badge level case has no numeric expected value".to_owned())?;
            let actual = permissions::derive_badge_level(badges);
            if actual != expected {
                return Err(format!(
                    "badge level mismatch for {badges}: expected {expected}, got {actual}"
                ));
            }
            Ok(())
        }
        "badge_tags" => {
            let null = Value::Null;
            let badges = case["input"].get("badges").unwrap_or(&null);
            let mut actual = permissions::derive_badge_tags(badges)
                .iter()
                .map(|tag| tag.as_str().to_owned())
                .collect::<Vec<_>>();
            let mut expected = case["expected"]
                .as_array()
                .ok_or_else(|| "badge tags case has no expected array".to_owned())?
                .iter()
                .map(|tag| {
                    tag.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| "expected badge tag must be a string".to_owned())
                })
                .collect::<Result<Vec<_>, _>>()?;
            // Tags are a set in the source; insertion order is not part of the
            // assigned API for badge derivation.
            actual.sort();
            expected.sort();
            if actual != expected {
                return Err(format!(
                    "badge tags mismatch for {badges}: expected {expected:?}, got {actual:?}"
                ));
            }
            Ok(())
        }
        "role_tag" => {
            let value = &case["input"]["value"];
            let accepted = case["accepted"]
                .as_bool()
                .ok_or_else(|| "role tag case has no accepted flag".to_owned())?;
            let decoded = serde_json::from_value::<RoleTag>(value.clone());
            match (decoded, accepted) {
                (Ok(tag), true) => {
                    let round_trip = serde_json::to_value(tag).unwrap();
                    if !equivalent(&round_trip, value) {
                        return Err(format!(
                            "role tag round trip mismatch: expected {value}, got {round_trip}"
                        ));
                    }
                    Ok(())
                }
                (Ok(tag), false) => Err(format!("source rejects {value}, Rust decoded {tag:?}")),
                (Err(error), true) => Err(format!("source accepts {value}, Rust failed: {error}")),
                (Err(_), false) => Ok(()),
            }
        }
        "inspect" => {
            let expression = case["input"].get("expression");
            let expected = case["expectedMode"]
                .as_str()
                .ok_or_else(|| "inspect case has no expected mode".to_owned())?;
            match (permissions::inspect_expression(expression), expected) {
                (ExpressionState::Level, "level")
                | (ExpressionState::Tags { .. }, "tags")
                | (ExpressionState::Invalid { .. }, "invalid") => Ok(()),
                (state, _) => Err(format!(
                    "inspect mode mismatch for {expression:?}: expected {expected}, got {state:?}"
                )),
            }
        }
        other => Err(format!("unmapped operation: {other}")),
    }
}

#[test]
fn permission_corpus_manifest_is_source_backed_and_bounded() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/permission_core_cases.json")).unwrap();
    assert_eq!(fixture["schemaVersion"], 1);
    assert_eq!(
        fixture["counts"]["cases"].as_u64().unwrap() as usize,
        fixture["cases"].as_array().unwrap().len()
    );

    let sources = fixture["sources"].as_object().unwrap();
    assert_eq!(
        sources.len(),
        3,
        "roles/expression/index must all be hashed"
    );
    for file in ["roles.ts", "expression.ts", "index.ts"] {
        let hash = sources[file]
            .as_str()
            .unwrap_or_else(|| panic!("missing source hash: {file}"));
        assert_eq!(hash.len(), 64, "{file} hash must be SHA-256");
        assert!(hash.chars().all(|ch| ch.is_ascii_hexdigit()));
    }
    assert_eq!(
        fixture["fixtures"].as_object().unwrap().len(),
        1,
        "the shared permission fixture must be hashed too"
    );
    let corpus_hash = fixture["corpusHash"].as_str().unwrap();
    assert_eq!(corpus_hash.len(), 64);
    assert!(corpus_hash.chars().all(|ch| ch.is_ascii_hexdigit()));

    let cases = fixture["cases"].as_array().unwrap();
    assert!(
        (1000..=4000).contains(&cases.len()),
        "corpus size {} is outside the requested 1000..=4000 bound",
        cases.len()
    );
    let mut names = HashSet::new();
    let mut operations = HashSet::new();
    for case in cases {
        let name = case["name"].as_str().expect("every case must be named");
        assert!(names.insert(name.to_owned()), "duplicate case name: {name}");
        let operation = case["operation"]
            .as_str()
            .expect("every case needs an operation");
        operations.insert(operation);
        assert!(
            case["input"].is_object(),
            "case {name} must have an object input"
        );
    }
    for operation in [
        "validate",
        "evaluate",
        "access",
        "config",
        "serialize_identity",
        "parse_identity",
        "badge_level",
        "badge_tags",
        "role_tag",
        "inspect",
    ] {
        assert!(
            operations.contains(operation),
            "corpus lost operation: {operation}"
        );
    }
}

#[test]
fn permission_core_matches_source_backed_cases() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/permission_core_cases.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for case in cases {
        if let Err(error) = check_case(case) {
            failures.push(format!(
                "{} [{}] input={}\n  {error}",
                case["name"].as_str().unwrap_or("?"),
                case["operation"].as_str().unwrap_or("?"),
                case["input"]
            ));
            if failures.len() == 25 {
                break;
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} permission parity case(s) failed (showing up to 25 of {}):\n\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n\n")
    );
}

#[test]
fn permission_core_preserves_documented_source_edges() {
    let viewer = UserIdentity::new(1.0, [], None, None);
    let broadcaster = UserIdentity::new(10.0, [RoleTag::Broadcaster], None, None);

    // `if (!config) return false` and empty objects still use legacy level 0.
    assert!(!permissions::command_allowed(None, &viewer));
    assert!(!permissions::rule_exempt(None, &viewer));
    assert!(permissions::command_allowed(Some(&json!({})), &viewer));
    assert!(CompiledPermission::compile(None, None).allowed(&viewer));

    // Missing/null expressions select level mode; present invalid values fail
    // closed even for the broadcaster and never fall back to the stored level.
    assert!(matches!(
        permissions::inspect_expression(None),
        ExpressionState::Level
    ));
    assert!(matches!(
        permissions::inspect_expression(Some(&Value::Null)),
        ExpressionState::Level
    ));
    let invalid = json!({"role": "supermod"});
    assert!(
        !CompiledPermission::compile(Some(&invalid), Some(&json!(1))).allowed(&broadcaster),
        "invalid configuration must deny the broadcaster"
    );
    assert!(!permissions::command_allowed(
        Some(&json!({"permissionExpression": {"role": "supermod"}, "userLevel": 1})),
        &broadcaster
    ));

    // Identity serialization matches createUserIdentity: everyone appended,
    // tags insertion-ordered and unique, empty account fields omitted.
    let identity = UserIdentity::new(
        7.0,
        [RoleTag::Mod, RoleTag::Sub, RoleTag::Mod],
        Some(String::new()),
        None,
    );
    assert!(equivalent(
        &permissions::serialize_user_identity(&identity),
        &json!({"level": 7, "tags": ["mod", "sub", "everyone"]})
    ));

    // parseUserIdentity clamps/truncates only a finite numeric level.
    assert_eq!(
        permissions::parse_user_identity(Some(&json!({"level": 99})), 3.0).level(),
        10.0
    );
    assert_eq!(
        permissions::parse_user_identity(Some(&json!({"level": -5})), 3.0).level(),
        1.0
    );
    assert_eq!(
        permissions::parse_user_identity(Some(&json!({"level": "seven"})), 3.0).level(),
        3.0
    );
    assert_eq!(
        permissions::parse_user_identity(Some(&json!({"level": 2.9})), 3.0).level(),
        2.0
    );

    // Founder badges imply the sub tag; the canonical role enum is lowercase.
    assert_eq!(
        permissions::derive_badge_tags(&json!([{"set_id": "founder"}])),
        vec![RoleTag::Founder, RoleTag::Sub]
    );
    assert_eq!(
        permissions::derive_badge_level(&json!([{"set_id": "lead_moderator"}])),
        7.0
    );
    assert!(serde_json::from_value::<RoleTag>(json!("broadcaster")).is_ok());
    assert!(serde_json::from_value::<RoleTag>(json!("Broadcaster")).is_err());
}
