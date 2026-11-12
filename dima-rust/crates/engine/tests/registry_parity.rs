//! The registry against the reference's (`fixtures/ast_registry_cases.json`, recorded from its
//! registration code by `fixtures/ast_registry_reference.mjs` under Node 24): the same names in
//! the same order, the same metadata, and every name either a builtin or a host function.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dima_engine::host::HostFunction;
use dima_engine::registry::{FunctionKind, Registry};
use serde_json::Value;

fn normalized(value: &Value) -> Value {
    match value {
        Value::Number(n) => serde_json::json!(n.as_f64().unwrap()),
        Value::Array(items) => Value::Array(items.iter().map(normalized).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), normalized(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[test]
fn registry_matches_the_reference() {
    let raw = std::fs::read(format!(
        "{}/tests/fixtures/ast_registry_cases.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let reference: Value = serde_json::from_slice(&raw).unwrap();
    let registry = Registry::standard();
    let names: Vec<&str> = registry.iter().map(|spec| spec.name.as_str()).collect();
    let expected: Vec<&str> = reference["functions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, expected);
    for (spec, recorded) in registry
        .iter()
        .zip(reference["functions"].as_array().unwrap())
    {
        let ours = serde_json::to_value(&spec.metadata).unwrap();
        assert_eq!(
            normalized(&ours),
            normalized(&recorded["metadata"]),
            "{}",
            spec.name
        );
    }
    let (mut builtins, mut host) = (0, 0);
    for spec in registry.iter() {
        match spec.kind {
            FunctionKind::Builtin(_) => builtins += 1,
            FunctionKind::Host(HostFunction::Custom) => {
                panic!("{} has no host function", spec.name)
            }
            FunctionKind::Host(_) => host += 1,
        }
    }
    assert_eq!((builtins, host), (37, 99));
}
