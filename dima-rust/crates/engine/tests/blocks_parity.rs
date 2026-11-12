//! The blocks corpus (`fixtures/ast_blocks_cases.json`, generated from today's TypeScript by
//! `fixtures/ast_blocks_reference.mjs` under Node 24) run against `dima_engine::blocks`.
//!
//! Every case must give the TypeScript result recorded in `source`. The one intended difference
//! is the character rule, stated once in [`expected`]: when a case's input contains a character
//! outside the Basic Multilingual Plane, the generator also ran the TypeScript on a *twin* input
//! where each such character is replaced by one BMP character of the same class (`\p{L}`,
//! `\p{N}`, other). The TypeScript counts UTF-16 units and the port counts characters, so the
//! port's result on the input is the twin's result with the replacements undone: limits,
//! counts in messages and the 24-character quote of an unknown type all follow from that.

// Test helpers outside `#[test]` functions: a failed expectation is a failed test.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dima_engine::blocks::{
    BlockNode, BlockRoot, IdMaker, MAX_BLOCK_NODES, compile_blocks, import_command_text_with,
    normalize_root, normalize_value, read_block_root, shape_eq, shape_eq_root, stored_blocks,
};
use serde_json::{Map, Value, json};
use std::collections::HashMap;

fn corpus() -> Value {
    let raw = include_bytes!("fixtures/ast_blocks_cases.json");
    // The TypeScript can cut a message inside a surrogate pair (`slice(0, 24)`); such a recorded
    // string has a lone surrogate escape, which the API edge replaces with U+FFFD.
    let clean = dima_text::sanitize_lone_surrogates(raw);
    serde_json::from_slice(&clean).expect("the corpus is JSON")
}

fn literal(id: String, value: &str) -> Value {
    json!({"id": id, "type": "literal", "value": value})
}

/// The compact quota trees (`treeSpec: flat-nodes`), built as the generator builds them.
fn materialize(input: &Value) -> Value {
    if input["treeSpec"] != "flat-nodes" {
        return input.clone();
    }
    let count = input["literals"].as_u64().unwrap_or_default() as usize;
    let mut children: Vec<_> = (1..=count).map(|i| literal(format!("g{i}"), "")).collect();
    match input["tail"].as_str() {
        Some("getVarIndex") => children.push(json!({
            "id": format!("g{}", count + 1), "type": "getVar", "name": "v", "storage": "memory",
            "accessor": {"type": "index", "index": literal(format!("g{}", count + 2), "0")}
        })),
        Some("emptyTernary") => children.push(json!({
            "id": format!("g{}", count + 1), "type": "ternary",
            "test": literal(format!("g{}", count + 2), "1"), "consequent": null, "alternate": null
        })),
        _ => {}
    }
    json!({"id": "g-root", "type": "root", "children": children})
}

/// Blocks in a tree, the root excluded (the generator's `countNodes`).
fn node_count(value: &Value) -> usize {
    match value {
        Value::Array(items) => items.iter().map(node_count).sum(),
        Value::Object(object) => {
            let own = object.get("id").is_some_and(Value::is_string)
                && object
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|t| t != "root");
            usize::from(own)
                + object
                    .iter()
                    .filter(|(key, _)| *key != "id")
                    .map(|(_, child)| node_count(child))
                    .sum::<usize>()
        }
        _ => 0,
    }
}

/// Import ids are random in both implementations: renumber them in pre-order, the way the
/// generator's `canonicalizeIds` walks (object fields in their written order).
fn canonical_ids(value: &Value) -> Value {
    fn walk(value: &Value, seq: &mut usize) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(|item| walk(item, seq)).collect()),
            Value::Object(object) => {
                let mut out = Map::new();
                if object.get("id").is_some_and(Value::is_string) {
                    *seq += 1;
                    out.insert("id".into(), json!(format!("n{seq}")));
                }
                for (key, child) in object {
                    if key != "id" {
                        out.insert(key.clone(), walk(child, seq));
                    }
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }
    walk(value, &mut 0)
}

/// Import roots in the generator's key order: the TypeScript builds `forLoop` blocks with the
/// body first, and pre-order numbering follows key order.
fn typescript_key_order(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(typescript_key_order).collect()),
        Value::Object(object) => {
            let mut out = Map::new();
            let first: &[&str] = if object.get("type") == Some(&json!("forLoop")) {
                &["id", "type", "loopVar", "mode", "body"]
            } else if object.get("type") == Some(&json!("setVar")) {
                &["id", "type", "name", "storage", "value"]
            } else {
                &["id", "type"]
            };
            for key in first {
                if let Some(child) = object.get(*key) {
                    out.insert((*key).into(), typescript_key_order(child));
                }
            }
            for (key, child) in object {
                if !out.contains_key(key) {
                    out.insert(key.clone(), typescript_key_order(child));
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn error_value(message: &str, block_id: Option<&str>) -> Value {
    let mut error = json!({"name": "Error", "message": message});
    if let Some(id) = block_id {
        error["blockId"] = json!(id);
    }
    json!({"outcome": "error", "error": error})
}

/// The TypeScript result of a case, in one comparable shape.
fn project(operation: &str, source: &Value) -> Value {
    if source["summary"] == true {
        if operation == "import" {
            return json!({
                "outcome": "summary",
                "advancedCount": source["advancedCount"],
                "nodeCount": source["nodeCount"],
                "rootChildTypes": source["rootChildTypes"],
            });
        }
        return match source["outcome"].as_str() {
            Some("accepted") => {
                json!({"outcome": "accepted", "validatedNodes": source["validatedNodes"]})
            }
            _ => json!({"outcome": "error", "error": source["error"]}),
        };
    }
    if operation == "structural_eq" {
        return json!({"outcome": "comparison", "equal": source["equal"]});
    }
    if source["ok"] == false {
        return json!({"outcome": "error", "error": source["error"]});
    }
    let value = &source["value"];
    match operation {
        "read" | "normalize" => json!({"outcome": "root", "root": value}),
        "compile" => json!({"outcome": "compiled", "root": value["root"], "text": value["text"]}),
        "stored" => json!({"outcome": "stored", "value": value}),
        "import" => json!({
            "outcome": "imported",
            "root": canonical_ids(&value["root"]),
            "advancedCount": value["advancedCount"],
        }),
        _ => Value::Null,
    }
}

/// Undoes a twin's replacements in every string of `value`.
fn map_back(value: &Value, map: &HashMap<char, char>) -> Value {
    match value {
        Value::String(text) => Value::String(
            text.chars()
                .map(|ch| map.get(&ch).copied().unwrap_or(ch))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(|v| map_back(v, map)).collect()),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, child)| (key.clone(), map_back(child, map)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The intended difference, stated once: on input with astral characters, the port gives the
/// BMP twin's TypeScript result with the replacements undone.
fn expected(case: &Value) -> Value {
    let operation = case["operation"].as_str().unwrap_or_default();
    let twin = &case["twin"];
    if twin.is_null() {
        return project(operation, &case["source"]);
    }
    let map: HashMap<char, char> = twin["map"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(placeholder, original)| {
            Some((
                placeholder.chars().next()?,
                original.as_str()?.chars().next()?,
            ))
        })
        .collect();
    map_back(&project(operation, &twin["source"]), &map)
}

fn from_value<T: serde::de::DeserializeOwned>(value: &Value) -> T {
    serde_json::from_value(value.clone()).expect("a typed tree")
}

fn actual(case: &Value) -> Value {
    let input = &case["input"];
    match case["operation"].as_str().unwrap_or_default() {
        "read" => match read_block_root(&materialize(input)) {
            Ok(root) if input["treeSpec"] == "flat-nodes" => {
                json!({"outcome": "accepted", "validatedNodes": node_count(&root.to_value())})
            }
            Ok(root) => json!({"outcome": "root", "root": root.to_value()}),
            Err(error) => error_value(&error.message, error.block_id.as_deref()),
        },
        "compile" => match compile_blocks(input) {
            Ok(compiled) => {
                json!({"outcome": "compiled", "root": compiled.root.to_value(), "text": compiled.text})
            }
            Err(error) => error_value(&error.message, error.block_id.as_deref()),
        },
        "normalize" => {
            let root = if input["scope"] == "value" {
                normalize_value(from_value::<BlockNode>(&input["node"])).to_value()
            } else {
                normalize_root(from_value::<BlockRoot>(&input["root"])).to_value()
            };
            json!({"outcome": "root", "root": root})
        }
        "import" => {
            let text = input["text"].as_str().unwrap_or_default();
            match import_command_text_with(text, &mut IdMaker::new("i", "test")) {
                Ok(imported) if case["source"]["summary"] == true => {
                    let root = imported.root.to_value();
                    json!({
                        "outcome": "summary",
                        "advancedCount": imported.advanced_count,
                        "nodeCount": node_count(&root),
                        "rootChildTypes": root["children"].as_array().into_iter().flatten()
                            .map(|child| child["type"].clone()).collect::<Vec<_>>(),
                    })
                }
                Ok(imported) => json!({
                    "outcome": "imported",
                    "root": canonical_ids(&typescript_key_order(&imported.root.to_value())),
                    "advancedCount": imported.advanced_count,
                }),
                Err(error) => error_value(&error.message, error.block_id.as_deref()),
            }
        }
        "stored" => {
            let stored = stored_blocks(from_value(&input["root"]));
            json!({"outcome": "stored", "value": serde_json::to_value(stored).unwrap_or_default()})
        }
        "structural_eq" => {
            let equal = if input["left"]["type"] == "root" {
                shape_eq_root(&from_value(&input["left"]), &from_value(&input["right"]))
            } else {
                shape_eq(&from_value(&input["left"]), &from_value(&input["right"]))
            };
            json!({"outcome": "comparison", "equal": equal})
        }
        other => json!({"unknown operation": other}),
    }
}

/// The height of a block tree (a block with no children is 1), counted without recursion.
fn block_height(root: &Value) -> usize {
    let mut deepest = 0;
    let mut pending = vec![(root, 1usize)];
    while let Some((node, depth)) = pending.pop() {
        deepest = deepest.max(depth);
        for key in ["children", "args", "items", "body"] {
            for child in node[key].as_array().into_iter().flatten() {
                pending.push((child, depth + 1));
            }
        }
    }
    deepest
}

/// The intended difference: the reference parses until V8's stack ends; the port refuses text
/// nested deeper than `syntax::MAX_NESTING`. Such text imports as the importer's fallback for
/// text it cannot read (one raw block), and a block tree that deep cannot be written back: its
/// outermost block "would run differently". `None` for every other case.
fn nested_too_deep(case: &Value) -> Option<Value> {
    let input = &case["input"];
    match case["operation"].as_str()? {
        "import" => {
            let text = input["text"].as_str()?;
            let error = dima_engine::syntax::SyntaxEngine::default()
                .parse(text)
                .err()?;
            (error.code == dima_engine::syntax::DiagnosticCode::NestingLimit).then(|| {
                json!({"outcome": "imported", "root": {"id": "n1", "type": "root",
                    "children": [{"id": "n2", "type": "raw", "source": text}]},
                    "advancedCount": 1})
            })
        }
        "compile" if block_height(input) > dima_engine::syntax::MAX_NESTING => {
            Some(json!({"outcome": "error", "error": {"name": "Error",
                "message": "This block would run differently than it looks. Try retyping its text.",
                "blockId": input["children"][0]["id"]}}))
        }
        _ => None,
    }
}

#[test]
fn every_corpus_case_gives_the_typescript_result() {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().expect("cases");
    assert_eq!(
        cases.len(),
        532,
        "regenerate the test's counts with the corpus"
    );
    assert_eq!(corpus["baseline"]["tsMaxBlockNodes"], MAX_BLOCK_NODES);
    let mut failures = Vec::new();
    let (mut twins, mut changed_by_twin, mut deeper_than_the_limit) = (0, 0, 0);
    for case in cases {
        let name = case["name"].as_str().unwrap_or_default();
        assert_eq!(case["parity"], "source-parity", "{name}");
        let mut expected = expected(case);
        if let Some(port) = nested_too_deep(case) {
            if port != expected {
                deeper_than_the_limit += 1;
            }
            expected = port;
        }
        if !case["twin"].is_null() {
            twins += 1;
            if expected
                != project(
                    case["operation"].as_str().unwrap_or_default(),
                    &case["source"],
                )
            {
                changed_by_twin += 1;
            }
        }
        let actual = actual(case);
        if actual != expected {
            failures.push(format!(
                "{name}\n  expected {}\n  actual   {}",
                truncate(&expected),
                truncate(&actual)
            ));
        }
    }
    for failure in failures.iter().take(20) {
        eprintln!("{failure}");
    }
    assert!(failures.is_empty(), "{} corpus mismatches", failures.len());
    assert_eq!(
        deeper_than_the_limit, 3,
        "cases nested deeper than the port's limit"
    );
    assert_eq!(twins, 61, "cases with astral characters (each has a twin)");
    // Where the character rule changes the result: the 10,000-character text and raw limits
    // (7 cases), variable names (5), command names (5), function and counter names (1 each,
    // a different message), the unknown-type quote (3), the compiled command's limit and its
    // count (7) and the import limit and its count (3).
    assert_eq!(
        changed_by_twin, 32,
        "cases where the character rule changes the result"
    );
}

fn truncate(value: &Value) -> String {
    dima_text::truncate_chars(&value.to_string(), 700).to_owned()
}

#[test]
fn compiled_and_imported_trees_survive_the_stored_wire_format() {
    let corpus = corpus();
    for case in corpus["cases"].as_array().into_iter().flatten() {
        let root = match case["operation"].as_str() {
            Some("compile") => compile_blocks(&case["input"]).ok().map(|c| c.root),
            Some("import") => case["input"]["text"]
                .as_str()
                .and_then(|text| import_command_text_with(text, &mut IdMaker::new("i", "x")).ok())
                .map(|i| i.root),
            _ => None,
        };
        let Some(root) = root else { continue };
        let text = serde_json::to_string(&stored_blocks(root.clone())).expect("serialises");
        let back: dima_engine::blocks::StoredBlocks =
            serde_json::from_str(&text).expect("deserialises");
        assert_eq!(back.v, 1);
        assert_eq!(back.root, root);
    }
}
