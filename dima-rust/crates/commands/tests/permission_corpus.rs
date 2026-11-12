//! The permission core against the TypeScript reference.
//!
//! `fixtures/permission_core_cases.json` is written by `fixtures/permission_core_reference.mjs`
//! running the actual `dimabot/src/utils/permissions/*.ts` and
//! `dimabot/src/middleware/channel_permissions.ts` under Node 24. Every case must match as
//! recorded: no text rule changes a permission outcome (tags, ids and logins are ASCII by rule).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashSet;

use dima_commands::permissions::{
    self, CompiledPermission, RoleTag, UserIdentity, count_expression_nodes,
};
use serde_json::{Map, Value};

const CORPUS: &str = include_str!("fixtures/permission_core_cases.json");

/// JSON has one number type: integers and floats compare by value.
fn equivalent(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .zip(b)
                    .all(|((ka, va), (kb, vb))| ka == kb && equivalent(va, vb))
        }
        _ => actual == expected,
    }
}

fn identity(value: &Value) -> Result<UserIdentity, String> {
    let level = value["level"]
        .as_f64()
        .ok_or_else(|| format!("identity level is missing: {value}"))?;
    let tags = value["tags"]
        .as_array()
        .map(|tags| {
            tags.iter()
                .map(|tag| {
                    tag.as_str()
                        .and_then(RoleTag::parse)
                        .ok_or_else(|| format!("bad tag {tag}"))
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(UserIdentity::new(
        level,
        tags,
        value["userId"].as_str(),
        value["login"].as_str(),
    ))
}

fn config(input: &Value, expression_key: &str, level_key: &str) -> Value {
    let mut object = Map::new();
    if let Some(expression) = input.get("expression") {
        object.insert(expression_key.into(), expression.clone());
    }
    if let Some(legacy) = input.get("legacy") {
        object.insert(level_key.into(), legacy.clone());
    }
    Value::Object(object)
}

fn expect_bool(case: &Value, actual: bool, label: &str) -> Result<(), String> {
    let expected = case["expected"]
        .as_bool()
        .ok_or("case has no boolean expectation")?;
    if actual == expected {
        Ok(())
    } else {
        Err(format!("{label}: expected {expected}, got {actual}"))
    }
}

fn expect_json(case: &Value, actual: &Value) -> Result<(), String> {
    let expected = &case["expected"];
    if equivalent(actual, expected) {
        Ok(())
    } else {
        Err(format!("expected {expected}, got {actual}"))
    }
}

fn check(case: &Value) -> Result<(), String> {
    let input = &case["input"];
    match case["operation"].as_str().unwrap_or_default() {
        "validate" => {
            let accepted = case["accepted"].as_bool().ok_or("no accepted flag")?;
            match (
                permissions::validate_expression(&input["expression"]),
                accepted,
            ) {
                (Ok(valid), true) => {
                    if !equivalent(&valid.to_json(), &case["sanitized"]) {
                        return Err(format!(
                            "sanitized {} vs {}",
                            valid.to_json(),
                            case["sanitized"]
                        ));
                    }
                    // The reference counts the input shape; a valid tree has the same count.
                    let count = case["nodeCount"].as_u64().ok_or("no node count")?;
                    if valid.node_count() as u64 != count {
                        return Err(format!("node count {} vs {count}", valid.node_count()));
                    }
                    let bson = valid.to_bson();
                    let reread = permissions::validate_expression(&bson)
                        .map_err(|error| format!("BSON form does not validate: {error}"))?;
                    if reread != valid {
                        return Err("BSON form validates to a different tree".into());
                    }
                    Ok(())
                }
                (Err(error), false) => {
                    let expected = case["error"].as_str().ok_or("no error text")?;
                    if error.message == expected {
                        Ok(())
                    } else {
                        Err(format!("error {:?} vs {expected:?}", error.message))
                    }
                }
                (Ok(_), false) => Err("the reference refuses this tree".into()),
                (Err(error), true) => Err(format!("the reference accepts this tree: {error}")),
            }
        }
        "count" => {
            let actual = count_expression_nodes(&input["expression"]);
            expect_json(case, &Value::from(actual))
        }
        "evaluate" => {
            let valid = permissions::validate_expression(&input["expression"])
                .map_err(|error| format!("fixture tree must be valid: {error}"))?;
            expect_bool(
                case,
                valid.evaluate(&identity(&input["identity"])?),
                "evaluate",
            )
        }
        "access" => {
            let who = identity(&input["identity"])?;
            let compiled =
                CompiledPermission::compile(input.get("expression"), input.get("legacy"));
            let command = config(input, "permissionExpression", "userLevel");
            let rule = config(input, "exemptExpression", "exemptUserLevel");
            expect_bool(case, compiled.allowed(&who), "compiled")?;
            expect_bool(
                case,
                permissions::command_allowed(Some(&command), &who),
                "command",
            )?;
            expect_bool(case, permissions::rule_exempt(Some(&rule), &who), "rule")?;
            if let Some(mode) = case["expectedMode"].as_str()
                && compiled.mode().as_str() != mode
            {
                return Err(format!("mode {} vs {mode}", compiled.mode().as_str()));
            }
            Ok(())
        }
        "config" => {
            let who = identity(&input["identity"])?;
            let command = input.get("command");
            expect_bool(case, permissions::command_allowed(command, &who), "command")?;
            expect_bool(case, permissions::rule_exempt(command, &who), "rule")
        }
        "serialize_identity" => expect_json(case, &identity(input)?.to_json()),
        "parse_identity" => {
            let fallback = input["fallbackLevel"].as_f64().ok_or("no fallback")?;
            expect_json(
                case,
                &permissions::parse_user_identity(input.get("raw"), fallback).to_json(),
            )
        }
        "badge_level" => {
            let badges = input.get("badges").unwrap_or(&Value::Null);
            expect_json(case, &Value::from(permissions::derive_badge_level(badges)))
        }
        "badge_tags" => {
            let badges = input.get("badges").unwrap_or(&Value::Null);
            let tags: Vec<&str> = permissions::derive_badge_tags(badges)
                .iter()
                .map(|tag| tag.as_str())
                .collect();
            // A Set in the reference: insertion order is kept, so compare in order.
            expect_json(case, &Value::from(tags))
        }
        "role_tag" => {
            let accepted = case["accepted"].as_bool().ok_or("no accepted flag")?;
            let decoded = RoleTag::from_js(&input["value"]);
            let serde = serde_json::from_value::<RoleTag>(input["value"].clone()).ok();
            if decoded.is_some() != accepted || serde != decoded {
                return Err(format!(
                    "decoded {decoded:?} / serde {serde:?}, accepted {accepted}"
                ));
            }
            Ok(())
        }
        "inspect" => {
            let mode = permissions::inspect_expression(input.get("expression")).mode();
            if Some(mode) == case["expectedMode"].as_str() {
                Ok(())
            } else {
                Err(format!("mode {mode} vs {}", case["expectedMode"]))
            }
        }
        "channel_permissions" => {
            let value = input.get("value").unwrap_or(&Value::Null);
            let actual = permissions::parse_channel_admin_permissions(value)
                .map_or(Value::Null, Value::from);
            expect_json(case, &actual)
        }
        "chat_admin_role" => {
            let value = input.get("value").unwrap_or(&Value::Null);
            expect_bool(
                case,
                permissions::grants_chat_admin_role_js(value),
                "chat admin",
            )
        }
        other => Err(format!("unmapped operation {other}")),
    }
}

#[test]
fn permission_core_matches_the_reference() {
    let fixture: Value = serde_json::from_str(CORPUS).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(
        fixture["counts"]["cases"].as_u64(),
        Some(cases.len() as u64)
    );
    let sources = fixture["sources"].as_object().unwrap();
    for file in [
        "roles.ts",
        "expression.ts",
        "index.ts",
        "channel_permissions.ts",
    ] {
        assert_eq!(
            sources[file].as_str().map(str::len),
            Some(64),
            "{file} hash"
        );
    }
    let mut names = HashSet::new();
    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        assert!(names.insert(name), "duplicate case {name}");
        if let Err(error) = check(case) {
            failures.push(format!("{name}: {error}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures[..failures.len().min(30)].join("\n")
    );
    assert!(cases.len() >= 3_900, "corpus shrank to {}", cases.len());
}

/// A Mixed path read as raw BSON gives the same answers as the JSON form.
#[test]
fn bson_values_read_like_json() {
    use bson::{Bson, doc};
    let viewer = UserIdentity::new(1.0, [], None, None);
    let moderator = UserIdentity::new(7.0, [RoleTag::Mod], None, None);
    let stored = Bson::Document(doc! { "or": [ { "role": "mod" }, { "level": Bson::Int64(9) } ] });
    let compiled = CompiledPermission::compile(Some(&stored), None::<&Bson>);
    assert!(compiled.allowed(&moderator));
    assert!(!compiled.allowed(&viewer));
    // An ObjectId or a Date is an object with no operator: invalid, denied even to the owner.
    for other in [
        Bson::ObjectId(bson::oid::ObjectId::new()),
        Bson::DateTime(bson::DateTime::now()),
    ] {
        let state = permissions::inspect_expression(Some(&other));
        assert_eq!(state.mode(), "invalid");
        let owner = permissions::create_broadcaster_identity();
        assert!(!CompiledPermission::from_state(state, 0.0).allowed(&owner));
    }
    // BSON undefined is JavaScript undefined: level mode.
    assert_eq!(
        permissions::inspect_expression(Some(&Bson::Undefined)).mode(),
        "level"
    );
    let level = Bson::Int32(7);
    assert!(CompiledPermission::compile(None::<&Bson>, Some(&level)).allowed(&moderator));
    assert!(!CompiledPermission::compile(None::<&Bson>, Some(&level)).allowed(&viewer));
}
