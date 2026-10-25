#![cfg(feature = "ast-blocks")]

// Source oracle owns the corpus. These checks never regenerate expected values
// from Rust. Approved changes are kept separate from unchanged TS semantics.
use dima_rust::utils::ast_blocks::{
    BlockKind, BlockNode, BlockRoot, BlocksEngine, BlocksError, BlocksErrorCode, StoredBlocks,
    compile_blocks, compile_blocks_owned, import_command_text, normalize_root, normalize_value,
    read_block_root, read_block_root_owned, stored_blocks, structural_eq, structural_eq_root,
};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/ast_blocks_cases.json"))
        .expect("source-only deep inputs and compact specs must fit Serde's recursion guard")
}
fn root(children: Vec<Value>) -> Value {
    json!({"id":"root", "type":"root", "children":children})
}
fn literal(id: &str, value: &str) -> Value {
    json!({"id":id,"type":"literal","value":value})
}
fn materialize(input: &Value) -> Value {
    if input["treeSpec"] != "flat-nodes" {
        return input.clone();
    }
    let count = input["literals"].as_u64().expect("literal count") as usize;
    let mut children: Vec<_> = (1..=count).map(|i| literal(&format!("g{i}"), "")).collect();
    match input["tail"].as_str().unwrap_or("none") {
        "none" => {}
        "getVarIndex" => children.push(
            json!({"id":format!("g{}",count+1),"type":"getVar","name":"v","storage":"memory",
            "accessor":{"type":"index","index":literal(&format!("g{}",count+2),"0")}}),
        ),
        "emptyTernary" => children.push(json!({"id":format!("g{}",count+1),"type":"ternary",
            "test":literal(&format!("g{}",count+2),"1"),"consequent":null,"alternate":null})),
        other => panic!("unknown source treeSpec tail {other}"),
    }
    json!({"id":"g-root","type":"root","children":children})
}
// Match the oracle's preorder of logical child fields. In particular TS
// forLoop wire insertion order is body before init/condition/update/iterable.
// Only IMPORTS use this function: supplied/repaired validation IDs stay exact.
fn canonicalize_import_ids(value: &mut Value) {
    fn walk(value: &mut Value, seq: &mut usize) {
        match value {
            Value::Array(items) => {
                for item in items {
                    walk(item, seq);
                }
            }
            Value::Object(object) => {
                if object.get("id").is_some_and(Value::is_string) {
                    *seq += 1;
                    object.insert("id".into(), json!(format!("n{seq}")));
                }
                for field in [
                    "children",
                    "args",
                    "value",
                    "left",
                    "right",
                    "argument",
                    "test",
                    "consequent",
                    "alternate",
                    "parts",
                    "items",
                    "accessor",
                    "userSelector",
                    "index",
                    "body",
                    "init",
                    "condition",
                    "update",
                    "iterable",
                ] {
                    if let Some(child) = object.get_mut(field) {
                        walk(child, seq);
                    }
                }
            }
            _ => {}
        }
    }
    walk(value, &mut 0);
}
fn node_count(value: &Value) -> usize {
    match value {
        Value::Array(items) => items.iter().map(node_count).sum(),
        Value::Object(object) => {
            usize::from(
                object.contains_key("id") && object.get("type").is_some_and(|t| t != "root"),
            ) + object.values().map(node_count).sum::<usize>()
        }
        _ => 0,
    }
}
fn source_error(error: &BlocksError) -> Value {
    let mut value = json!({"name":"Error","message":error.message});
    if let Some(id) = &error.block_id {
        value["blockId"] = json!(id);
    }
    json!({"outcome":"error","error":value})
}
fn persisted_roundtrip(root: &BlockRoot) -> Result<(), String> {
    // Exercise the SERIALIZED STRING boundary, not just Value conversion.
    let stored = stored_blocks(root.clone());
    let serialized = serde_json::to_string(&stored).map_err(|e| e.to_string())?;
    let decoded: StoredBlocks = serde_json::from_str(&serialized).map_err(|e| e.to_string())?;
    let value = serde_json::to_value(&decoded).map_err(|e| e.to_string())?;
    if decoded.v != 1 || value != json!({"v":1,"root":root.to_value()}) {
        return Err("version-1 serialized-string roundtrip changed wire fields".into());
    }
    Ok(())
}
fn imported_invariants(text: &str) -> Result<(), String> {
    let imported = import_command_text(text).map_err(|e| format!("import rejected: {e:?}"))?;
    let value = imported.root.to_value();
    let reread = read_block_root(&value).map_err(|e| format!("import is not valid: {e:?}"))?;
    if reread.to_value() != value || node_count(&value) > 7500 {
        return Err("typed import boundary changed its own result".into());
    }
    let mut raw = 0;
    let mut cursor = 0;
    for node in &imported.root.children {
        if let BlockKind::Raw { source } = &node.kind {
            raw += 1;
            let offset = text[cursor..]
                .find(source)
                .ok_or("raw fallback lost original expression bytes/order")?;
            cursor += offset + source.len();
        }
    }
    if raw == 0 || raw != imported.advanced_count {
        return Err("fallback must produce raw pieces and count them".into());
    }
    if !imported.diagnostics.is_empty() {
        return Err(format!(
            "feasible fallback unexpectedly unsaveable: {:?}",
            imported.diagnostics
        ));
    }
    let compiled =
        compile_blocks(&value).map_err(|e| format!("fallback cannot be saved: {e:?}"))?;
    if compiled.text.encode_utf16().count() > 10000 {
        return Err("fallback output exceeds UTF16 quota".into());
    }
    persisted_roundtrip(&imported.root)
}
fn actual_case(case: &Value) -> Result<Value, String> {
    let input = &case["input"];
    let operation = case["operation"].as_str().ok_or("missing operation")?;
    match operation {
        "read" => {
            let input = materialize(input);
            let borrowed = read_block_root(&input);
            let owned = read_block_root_owned(input);
            match (borrowed, owned) {
                (Ok(a), Ok(b)) => {
                    if a.to_value() != b.to_value()
                        || normalize_root(a.clone()).to_value() != normalize_root(b).to_value()
                    {
                        return Err(
                            "borrowed/consuming readers differ before or after normalization"
                                .into(),
                        );
                    }
                    persisted_roundtrip(&a)?;
                    if case["expected"]["outcome"] == "accepted" {
                        Ok(json!({"outcome":"accepted","validatedNodes":node_count(&a.to_value())}))
                    } else {
                        Ok(json!({"outcome":"root","root":a.to_value()}))
                    }
                }
                (Err(a), Err(b)) if a == b => Ok(source_error(&a)),
                other => Err(format!("borrowed/owned reader mismatch: {other:?}")),
            }
        }
        "compile" => match compile_blocks(input) {
            Ok(compiled) => {
                let owned = compile_blocks_owned(input.clone()).map_err(|e| e.to_string())?;
                if compiled.root.to_value() != owned.root.to_value() || compiled.text != owned.text
                {
                    return Err("borrowed/owned compiler mismatch".into());
                }
                persisted_roundtrip(&compiled.root)?;
                Ok(
                    json!({"outcome":"compiled","root":compiled.root.to_value(),"text":compiled.text}),
                )
            }
            Err(error) => {
                if case["parity"] == "approved-provenance" {
                    let (child, path) = if input["children"][0]["type"] == "binary" {
                        (&input["children"][0]["left"], "/children/0/left/value")
                    } else {
                        (&input["children"][0]["args"][0], "/children/0/args/0/value")
                    };
                    if error.code != BlocksErrorCode::RoundTripMismatch
                        || error.block_id.as_deref() != child["id"].as_str()
                        || error.path != path
                    {
                        return Err(format!("approved child diagnostics missing: {error:?}"));
                    }
                }
                let mut projection = source_error(&error);
                // TS OutputLimit has no blockId. Its newly supplied culprit is
                // additive diagnostics, asserted separately below, not ID repair.
                if error.code == BlocksErrorCode::OutputLimit
                    && case["source"]["error"].get("blockId").is_none()
                {
                    projection["error"]
                        .as_object_mut()
                        .unwrap()
                        .remove("blockId");
                }
                Ok(projection)
            }
        },
        "normalize" => {
            let value = if input["scope"] == "value" {
                let node: BlockNode =
                    serde_json::from_value(input["node"].clone()).map_err(|e| e.to_string())?;
                normalize_value(node).to_value()
            } else {
                let root: BlockRoot =
                    serde_json::from_value(input["root"].clone()).map_err(|e| e.to_string())?;
                normalize_root(root).to_value()
            };
            Ok(json!({"outcome":"root","root":value}))
        }
        "import" => {
            let text = input["text"].as_str().ok_or("missing import text")?;
            if case["expected"]["outcome"] == "invariants" {
                imported_invariants(text)?;
                return Ok(case["expected"].clone());
            }
            match import_command_text(text) {
                Ok(imported) => {
                    persisted_roundtrip(&imported.root)?;
                    if case["expected"]["resaveTextEqualsInput"] == true {
                        let compiled =
                            compile_blocks(&imported.root.to_value()).map_err(|e| e.to_string())?;
                        if compiled.text != text {
                            return Err("exact raw fallback changed bytes on resave".into());
                        }
                    }
                    let mut root = imported.root.to_value();
                    canonicalize_import_ids(&mut root);
                    let mut out = json!({"outcome":"imported","root":root,"advancedCount":imported.advanced_count,"canonicalization":"import-ids"});
                    if case["expected"]["resaveTextEqualsInput"] == true {
                        out["resaveTextEqualsInput"] = json!(true);
                    }
                    Ok(out)
                }
                Err(error) => Ok(source_error(&error)),
            }
        }
        "stored" => {
            let root: BlockRoot =
                serde_json::from_value(input["root"].clone()).map_err(|e| e.to_string())?;
            persisted_roundtrip(&root)?;
            let stored = serde_json::to_value(stored_blocks(root)).map_err(|e| e.to_string())?;
            Ok(json!({"outcome":"stored","value":stored,"keys":["v","root"]}))
        }
        "structural_eq" => {
            let equal = if input["left"]["type"] == "root" {
                let left: BlockRoot =
                    serde_json::from_value(input["left"].clone()).map_err(|e| e.to_string())?;
                let right: BlockRoot =
                    serde_json::from_value(input["right"].clone()).map_err(|e| e.to_string())?;
                structural_eq_root(&left, &right)
            } else {
                let left: BlockNode =
                    serde_json::from_value(input["left"].clone()).map_err(|e| e.to_string())?;
                let right: BlockNode =
                    serde_json::from_value(input["right"].clone()).map_err(|e| e.to_string())?;
                structural_eq(&left, &right)
            };
            Ok(json!({"outcome":"comparison","equal":equal}))
        }
        other => Err(format!("unknown fixture operation {other}")),
    }
}
// Independently reconstruct unchanged expectations from raw source results.
fn source_expectation(case: &Value) -> Value {
    let source = &case["source"];
    if source["summary"] == true {
        return json!({"outcome":"accepted","validatedNodes":source["validatedNodes"]});
    }
    if case["operation"] == "structural_eq" {
        return json!({"outcome":"comparison","equal":source["equal"]});
    }
    if source["ok"] == false {
        return json!({"outcome":"error","error":source["error"]});
    }
    match case["operation"].as_str().unwrap() {
        "read" | "normalize" => json!({"outcome":"root","root":source["value"]}),
        "compile" => {
            json!({"outcome":"compiled","root":source["value"]["root"],"text":source["value"]["text"]})
        }
        "stored" => json!({"outcome":"stored","value":source["value"],"keys":["v","root"]}),
        "import" => {
            let mut root = source["value"]["root"].clone();
            canonicalize_import_ids(&mut root);
            json!({"outcome":"imported","root":root,"advancedCount":source["value"]["advancedCount"],"canonicalization":"import-ids"})
        }
        other => panic!("unknown source projection {other}"),
    }
}
#[test]
fn source_oracle_results_sanitization_and_version_one_wire_roundtrips() {
    let corpus = fixture();
    assert_eq!(corpus["schemaVersion"], 1);
    assert_eq!(corpus["sources"].as_object().unwrap().len(), 11);
    assert_eq!(corpus["baseline"]["tsMaxBlockNodes"], 4000);
    assert_eq!(corpus["baseline"]["rustMaxBlockNodes"], 7500);
    let mut failures = Vec::new();
    let mut names = BTreeSet::new();
    for case in corpus["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        assert!(names.insert(name));
        let parity = case["parity"].as_str().unwrap();
        match parity {
            "source-parity" => {
                if source_expectation(case) != case["expected"] {
                    failures.push(format!(
                        "{name}: expected result drifted from untouched source oracle"
                    ));
                }
            }
            "approved-provenance" => {
                let mut source = source_expectation(case);
                assert_eq!(
                    case["approved"]["sourceBlockId"],
                    source["error"]["blockId"]
                );
                assert_eq!(case["approved"]["item"], 6);
                source["error"]["blockId"] = case["approved"]["expectedBlockId"].clone();
                if source != case["expected"] {
                    failures.push(format!(
                        "{name}: provenance delta changed more than the approved child ID"
                    ));
                }
            }
            "approved-node-limit" => {
                assert!(case["approved"].is_object());
                assert_eq!(case["input"]["treeSpec"], "flat-nodes");
            }
            "approved-import-fallback" | "approved-invariant" => {
                assert!(case["approved"].is_object());
                assert_eq!(case["operation"], "import");
            }
            other => failures.push(format!("{name}: unreviewed parity classification {other}")),
        }
        match std::panic::catch_unwind(|| actual_case(case)) {
            Ok(Ok(actual)) if actual == case["expected"] => {}
            Ok(Ok(actual)) => failures.push(format!(
                "{name}: expected={} actual={actual}",
                case["expected"]
            )),
            Ok(Err(error)) => failures.push(format!("{name}: {error}")),
            Err(_) => failures.push(format!("{name}: public API panicked")),
        }
    }
    for error in failures.iter().take(20) {
        eprintln!("{}", error.chars().take(4000).collect::<String>());
    }
    assert_eq!(
        failures.len(),
        0,
        "{} source/parity mismatches; first 20 shown",
        failures.len()
    );
}

#[test]
fn corpus_covers_all_wire_kinds_and_enum_surfaces() {
    let corpus = fixture();
    let coverage = &corpus["coverage"];
    for (field, expected) in [
        ("blockTypes", 17),
        ("binaryOps", 14),
        ("unaryOps", 2),
        ("loopAssignOps", 8),
        ("storages", 5),
        ("accessors", 8),
    ] {
        assert_eq!(
            coverage[field].as_array().unwrap().len(),
            expected,
            "{field}"
        );
    }
    let mut actual_kinds = BTreeSet::new();
    fn collect(value: &Value, kinds: &mut BTreeSet<String>) {
        match value {
            Value::Array(items) => {
                for item in items {
                    collect(item, kinds);
                }
            }
            Value::Object(object) => {
                if object.contains_key("id")
                    && let Some(kind) = object.get("type").and_then(Value::as_str)
                {
                    kinds.insert(kind.to_owned());
                }
                for value in object.values() {
                    collect(value, kinds);
                }
            }
            _ => {}
        }
    }
    for case in corpus["cases"].as_array().unwrap() {
        if case["operation"] == "read" && case["expected"]["outcome"] == "root" {
            let validated = read_block_root(&materialize(&case["input"])).unwrap();
            persisted_roundtrip(&validated).unwrap();
            collect(&validated.to_value(), &mut actual_kinds);
        }
    }
    let mut expected: BTreeSet<String> = coverage["blockTypes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    expected.insert("root".into());
    assert_eq!(
        actual_kinds, expected,
        "all 18 tagged wire node kinds must survive serialized-string storage"
    );
    assert_eq!(
        corpus["legacyTestSource"]["names"]
            .as_array()
            .unwrap()
            .len(),
        12
    );
}

#[test]
fn cache_is_operation_local_immutable_fresh_ids_and_logically_charged() {
    let engine = BlocksEngine::default();
    let single = engine.import_command_text("$(say hi)").unwrap();
    let text = "$(say hi)".repeat(500);
    let many = engine.import_command_text(&text).unwrap();
    assert_eq!(many.advanced_count, 0);
    assert_eq!(many.root.children.len(), 500);
    assert!(
        many.stats.parse_calls <= 4,
        "exact repeated syntax should need very few actual parses: {:?}",
        many.stats
    );
    assert!(many.stats.cache_hits >= 499);
    assert!(many.stats.syntax_nodes_charged >= single.stats.syntax_nodes_charged * 500);
    assert!(many.stats.syntax_tokens_charged >= single.stats.syntax_tokens_charged * 500);
    assert!(
        many.stats.syntax_source_units_charged >= single.stats.syntax_source_units_charged * 500
    );
    let compiled = engine.compile_blocks(&many.root.to_value()).unwrap();
    assert!(compiled.stats.parse_calls <= 2);
    assert!(compiled.stats.cache_hits >= 499);
    let mut ids = Vec::new();
    fn visit(value: &Value, ids: &mut Vec<String>) {
        match value {
            Value::Array(items) => {
                for item in items {
                    visit(item, ids);
                }
            }
            Value::Object(object) => {
                if let Some(id) = object.get("id").and_then(Value::as_str) {
                    ids.push(id.to_owned());
                }
                for child in object.values() {
                    visit(child, ids);
                }
            }
            _ => {}
        }
    }
    visit(&many.root.to_value(), &mut ids);
    assert_eq!(
        ids.iter().collect::<BTreeSet<_>>().len(),
        ids.len(),
        "cache may not reuse mutable block IDs"
    );
    let fresh = engine.import_command_text("$(say hi)").unwrap();
    assert_eq!(
        fresh.stats.parse_calls, single.stats.parse_calls,
        "new operation has a fresh cache"
    );
    assert!(fresh.stats.parse_calls > 0);
    assert!(structural_eq_root(&single.root, &fresh.root));
    assert_ne!(single.root.id, fresh.root.id);
    let canonical = engine.import_command_text("$(say hi)").unwrap();
    let noncanonical = engine.import_command_text("$(say    \"hi\")").unwrap();
    assert!(structural_eq_root(&canonical.root, &noncanonical.root));
    assert!(
        canonical.stats.parse_calls < noncanonical.stats.parse_calls,
        "exact-source verification fastpath should avoid a second parse"
    );
}

#[test]
fn typed_equality_ignores_editor_ids_and_provenance_but_checks_values() {
    let a = read_block_root(&root(vec![literal("a", "x")])).unwrap();
    let b = read_block_root(&root(vec![
        json!({"id":"group","type":"group","children":[literal("b","x")]}),
    ]))
    .unwrap();
    let b = normalize_root(b);
    assert!(structural_eq(&a.children[0], &b.children[0]));
    let different = BlockNode::new("a", BlockKind::Literal { value: "y".into() });
    assert!(!structural_eq(&a.children[0], &different));
    assert!(structural_eq_root(&a, &b));
}

#[test]
fn approved_fallbacks_are_saveable_and_unavoidable_literal_diagnostics_are_explicit() {
    for text in [
        "$(123)".to_owned(),
        format!("{}x{}", "$(s ".repeat(48), ")".repeat(48)),
    ] {
        let imported = import_command_text(&text).unwrap();
        assert_eq!(imported.advanced_count, 1);
        assert_eq!(imported.root.children.len(), 1);
        assert!(
            matches!(&imported.root.children[0].kind,BlockKind::Raw {source} if source == &text)
        );
        assert!(imported.diagnostics.is_empty());
        assert_eq!(
            compile_blocks(&imported.root.to_value()).unwrap().text,
            text
        );
    }
    imported_invariants(&"*(1?2:3)".repeat(1100)).unwrap();
    let imported = import_command_text("price \\\\$5").unwrap();
    assert!(!imported.diagnostics.is_empty());
    assert_eq!(imported.diagnostics[0].code, BlocksErrorCode::LiteralEscape);
    let rejected = compile_blocks(&imported.root.to_value()).unwrap_err();
    assert_eq!(rejected.code, BlocksErrorCode::LiteralEscape);
    assert_eq!(rejected.message, imported.diagnostics[0].message);
}

#[test]
fn structured_errors_retain_precise_actual_child_provenance_after_normalization() {
    let invalid = root(vec![
        json!({"id":"outer","type":"function","name":"say","args":[
        {"id":"bad","type":"getVar","name":"bad-name","storage":"memory"}]}),
    ]);
    let error = read_block_root(&invalid).unwrap_err();
    assert_eq!(error.code, BlocksErrorCode::InvalidName);
    assert_eq!(error.block_id.as_deref(), Some("bad"));
    assert_eq!(error.path, "/children/0/args/0/name");
    let collapsed = root(vec![
        json!({"id":"say","type":"function","name":"say","args":[
        {"id":"template","type":"template","parts":[literal("actual-child","${1}")]}]}),
    ]);
    let normalized = normalize_root(read_block_root(&collapsed).unwrap());
    // Wire ID remains the template ID, exactly as TypeScript normalizeValue.
    assert_eq!(
        normalized.to_value()["children"][0]["args"][0]["id"],
        "template"
    );
    let error = compile_blocks(&collapsed).unwrap_err();
    assert_eq!(error.code, BlocksErrorCode::RoundTripMismatch);
    assert_eq!(error.block_id.as_deref(), Some("actual-child"));
    assert_eq!(error.path, "/children/0/args/0/parts/0/value");
    let json = serde_json::to_value(&error).unwrap();
    assert_eq!(json["code"], "ROUND_TRIP_MISMATCH");
    assert_eq!(json["blockId"], "actual-child");
    assert_eq!(json["path"], error.path);
}

#[test]
fn legacy_late_output_length_and_literal_interpolation_rejections_stay_exact() {
    let children: Vec<_> = (0..50)
        .map(|i| {
            json!({"id":format!("f{i}"),"type":"function","name":"say",
        "args":[literal(&format!("arg{i}"),&"\"".repeat(1000))]})
        })
        .collect();
    let error = compile_blocks(&root(children)).unwrap_err();
    assert_eq!(error.code, BlocksErrorCode::OutputLimit);
    assert_eq!(
        error.message,
        "This command is too long (100450 of 10000 characters)."
    );
    assert_eq!(error.block_id.as_deref(), Some("arg4"));
    assert_eq!(error.path, "/children/4/args/0/value");
    // The rejected writer's retained <=10000 bound is checked inside core;
    // error stats are intentionally not part of the public API.
    let input = root(vec![
        json!({"id":"say","type":"function","name":"say","args":[literal("arg","${1}")]}),
    ]);
    let error = compile_blocks(&input).unwrap_err();
    assert_eq!(error.code, BlocksErrorCode::RoundTripMismatch);
    assert_eq!(
        error.message,
        "This block would run differently than it looks. Try retyping its text."
    );
    assert_eq!(error.block_id.as_deref(), Some("arg"));
    assert_eq!(error.path, "/children/0/args/0/value");
}

#[test]
fn namespace_and_factory_controls_never_allow_duplicate_or_invalid_ids() {
    let engine = BlocksEngine::default();
    let mut factory = || "duplicate".to_owned();
    let imported = engine
        .import_command_text_with_id_factory("$(say hi)$(say hi)", &mut factory)
        .unwrap();
    let value = imported.root.to_value();
    let reread = read_block_root(&value).unwrap();
    assert_eq!(
        reread.to_value(),
        value,
        "factory IDs are repaired within import, not later validation"
    );
    let error = engine
        .import_command_text_with_namespace("$(user)", "invalid namespace")
        .unwrap_err();
    assert_eq!(error.code, BlocksErrorCode::InvalidNamespace);
    let a = engine
        .import_command_text_with_namespace("$(user)", "deterministic")
        .unwrap();
    let b = engine
        .import_command_text_with_namespace("$(user)", "deterministic")
        .unwrap();
    assert_eq!(a.root.to_value(), b.root.to_value());
}

#[test]
fn feasible_import_fallback_preserves_original_pieces_after_root_normalization() {
    // Root normalization would turn the quoted compute value into chat text,
    // expanding 2400 expression starts past the output cap unless it stays raw.
    let source = format!("*(\"{}\")", "$(x)".repeat(2400));
    assert_eq!(source.encode_utf16().count(), 9605);
    let imported = import_command_text(&source).unwrap();
    assert!(imported.diagnostics.is_empty());
    assert_eq!(imported.advanced_count, 1);
    assert_eq!(imported.root.children.len(), 1);
    assert!(matches!(
        &imported.root.children[0].kind,
        BlockKind::Raw { source: piece } if piece == &source
    ));
    assert_eq!(
        compile_blocks(&imported.root.to_value()).unwrap().text,
        source
    );

    // Exact bytes: * ( " \ \ " ) $ ( u s e r ). The two backslashes are
    // inside the quoted compute expression; $(user) is a separate expression.
    let source = r#"*("\\")$(user)"#;
    let first_piece = r#"*("\\")"#;
    let imported = import_command_text(source).unwrap();
    assert!(imported.diagnostics.is_empty());
    assert_eq!(imported.advanced_count, 1);
    assert_eq!(imported.root.children.len(), 2);
    assert!(matches!(
        &imported.root.children[0].kind,
        BlockKind::Raw { source: piece } if piece == first_piece
    ));
    assert!(matches!(
        &imported.root.children[1].kind,
        BlockKind::Function { name, args } if name == "user" && args.is_empty()
    ));
    assert_eq!(
        compile_blocks(&imported.root.to_value()).unwrap().text,
        source
    );
}

#[test]
fn quoted_literal_at_block_depth_48_compiles_without_transient_syntax_depth_penalty() {
    fn nested_functions(wrappers: usize) -> Value {
        let mut node = literal("leaf", "two words");
        for index in 0..wrappers {
            node = json!({"id":format!("function-{index}"),"type":"function","name":"s","args":[node]});
        }
        root(vec![node])
    }

    let valid = nested_functions(47);
    assert!(read_block_root(&valid).is_ok());
    let compiled = compile_blocks(&valid).unwrap();
    let expected = format!("{}\"two words\"{}", "$(s ".repeat(47), ")".repeat(47));
    assert_eq!(compiled.text, expected);
    assert_eq!(compiled.text.encode_utf16().count(), 246);

    let too_deep = nested_functions(48);
    assert_eq!(
        read_block_root(&too_deep).unwrap_err().code,
        BlocksErrorCode::DepthLimit
    );
    assert_eq!(
        compile_blocks(&too_deep).unwrap_err().code,
        BlocksErrorCode::DepthLimit
    );
}

#[test]
fn merged_literal_output_limit_points_at_original_child_that_crosses_the_limit() {
    let input = root(vec![
        literal("first", &"a".repeat(5000)),
        literal("actual", &"b".repeat(5001)),
    ]);
    assert!(read_block_root(&input).is_ok());
    let error = compile_blocks(&input).unwrap_err();
    assert_eq!(error.code, BlocksErrorCode::OutputLimit);
    // The exact legacy message is source parity; precise child ID/path are
    // approved additive diagnostics after normalization merges the literals.
    assert_eq!(
        error.message,
        "This command is too long (10001 of 10000 characters)."
    );
    assert_eq!(error.block_id.as_deref(), Some("actual"));
    assert_eq!(error.path, "/children/1/value");
}

#[test]
fn import_root_template_spreading_accepts_final_block_depth_48() {
    // Source-probed TypeScript behavior: the outer root template spreads into
    // chat text plus a function. Its temporary wrapper must not consume the
    // final block tree's depth quota. The separate depth-49 reader regression
    // continues to enforce the actual persisted tree boundary.
    let inner = format!("{}\"two words\"{}", "$(s ".repeat(47), ")".repeat(47));
    let source = format!("*(\"a${{{inner}}}\")");
    assert_eq!(source.encode_utf16().count(), 255);

    let imported = import_command_text(&source).unwrap();
    assert_eq!(imported.advanced_count, 0);
    assert!(imported.diagnostics.is_empty());
    assert_eq!(imported.root.children.len(), 2);
    assert!(matches!(
        &imported.root.children[0].kind,
        BlockKind::Literal { value } if value == "a"
    ));
    assert!(matches!(
        &imported.root.children[1].kind,
        BlockKind::Function { name, args } if name == "s" && args.len() == 1
    ));

    let value = imported.root.to_value();
    let validated = read_block_root(&value).unwrap();
    assert_eq!(validated.to_value(), value);
    let compiled = compile_blocks(&value).unwrap();
    assert_eq!(compiled.text, format!("a{inner}"));
    assert_eq!(compiled.text.encode_utf16().count(), 247);
}
