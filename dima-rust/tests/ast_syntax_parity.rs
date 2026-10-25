#![cfg(feature = "ast-syntax")]

use dima_rust::utils::ast_syntax::{
    AstNode, DiagnosticCode, GrammarBuilder, Limits, PreparedGrammar, SourceSpan, SyntaxEngine,
    SyntaxHandler, SyntaxProfile, unescape_literal, unescape_rendered_text,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

fn fixture() -> Value {
    // Keep Serde's recursion guard enabled. Deep benchmark inputs are source
    // strings, and adversarial nesting is generated below rather than stored ASTs.
    serde_json::from_str(include_str!("fixtures/ast_syntax_cases.json"))
        .expect("oracle corpus must fit the default serde_json recursion guard; deep benchmark cases must be source-only")
}

fn diagnostic_value(error: &dima_rust::utils::ast_syntax::Diagnostic) -> Value {
    // Schema v2 uses the core's serialized diagnostic-code names. Keep the
    // complete diagnostic (including original-source UTF16 span) exact.
    serde_json::to_value(error).unwrap()
}

fn program_result(
    result: Result<
        &dima_rust::utils::ast_syntax::CompiledProgram,
        &dima_rust::utils::ast_syntax::Diagnostic,
    >,
) -> Value {
    match result {
        Ok(program) => json!({"outcome": "program", "ast": program.to_value()}),
        Err(error) => json!({"outcome": "diagnostic", "diagnostic": diagnostic_value(error)}),
    }
}

fn actual_case(engine: &SyntaxEngine, case: &Value) -> Result<Value, String> {
    let input = &case["input"];
    let source = input["source"].as_str().unwrap_or("");
    match case["operation"].as_str().ok_or("missing operation")? {
        "parse" => Ok(program_result(engine.parse(source).as_ref())),
        "scan" => engine
            .scan_template(source)
            .map(|segments| json!({"segments": segments}))
            .map_err(|error| format!("scan rejected: {error:?}")),
        "compiled-template" => {
            let plan = engine
                .compile_template(source)
                .map_err(|error| format!("plan rejected: {error:?}"))?;
            let segments: Vec<_> = plan
                .segments()
                .iter()
                .map(|segment| {
                    let mut value = serde_json::to_value(segment.source_segment()).unwrap();
                    if let Some(program) = segment.program() {
                        value
                            .as_object_mut()
                            .unwrap()
                            .insert("program".into(), program_result(program.as_ref()));
                    } else if let Some(diagnostic) = segment.diagnostic() {
                        value
                            .as_object_mut()
                            .unwrap()
                            .insert("diagnostic".into(), diagnostic_value(diagnostic));
                    }
                    value
                })
                .collect();
            Ok(json!({"segments": segments}))
        }
        "unescape" => {
            let value = input["value"]
                .as_str()
                .ok_or("source-only unescape API requires string fixture input")?;
            match input["surface"].as_str() {
                Some("rendered") => Ok(json!({"value": unescape_rendered_text(value)})),
                Some("literal") => Ok(json!({"value": unescape_literal(value)})),
                _ => Err("unknown unescape surface".into()),
            }
        }
        other => Err(format!("uncovered fixture operation: {other}")),
    }
}

// Recover the source oracle's original result from schema normalization. This
// checks that metadata/outcome normalization never changes an AST/error string.
fn raw_parse(normalized: &Value) -> Value {
    match normalized["outcome"].as_str().expect("parse outcome") {
        "program" => json!({"ast": normalized["ast"]}),
        "diagnostic" => {
            json!({"ast": {"type": "root", "children": []}, "error": normalized["diagnostic"]["message"]})
        }
        other => panic!("unknown normalized parse outcome {other}"),
    }
}
fn raw_result(operation: &str, normalized: &Value) -> Value {
    if operation == "parse" {
        return raw_parse(normalized);
    }
    if matches!(operation, "scan" | "compiled-template") {
        let segments: Vec<_> = normalized["segments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|segment| {
                let mut value = segment.clone();
                let object = value.as_object_mut().unwrap();
                object.remove("span");
                object.remove("diagnostic");
                if let Some(program) = object.remove("program") {
                    object.insert("parse".into(), raw_parse(&program));
                }
                value
            })
            .collect();
        return json!({"segments": segments});
    }
    normalized.clone()
}

fn roundtrip_asts(value: &Value, errors: &mut Vec<String>, label: &str) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if key == "ast" {
                    match serde_json::to_string(child)
                        .and_then(|serialized| serde_json::from_str::<AstNode>(&serialized))
                    {
                        Ok(ast) if ast.to_value() == *child => {}
                        Ok(ast) => errors.push(format!("{label}: AST roundtrip changed optional fields/shape: expected {child}, actual {}", ast.to_value())),
                        Err(error) => errors.push(format!("{label}: persisted AST cannot deserialize: {error}")),
                    }
                } else {
                    roundtrip_asts(child, errors, label);
                }
            }
        }
        Value::Array(array) => {
            for child in array {
                roundtrip_asts(child, errors, label);
            }
        }
        _ => {}
    }
}

#[test]
fn full_oracle_corpus_exact_results_and_persisted_ast_roundtrips() {
    let corpus = fixture();
    let cases = corpus["cases"].as_array().expect("cases array");
    let mut errors = Vec::new();
    let engines = [
        ("legacy", SyntaxEngine::typescript_compatible()),
        ("default", SyntaxEngine::default()),
    ];
    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let parity = case["parity"].as_str().expect("explicit parity label");
        match parity {
            "source-parity" => {
                let operation = case["operation"].as_str().unwrap();
                if raw_result(operation, &case["expected"]["legacy"]) != case["source"]
                    || raw_result(operation, &case["expected"]["default"]) != case["source"]
                {
                    errors.push(format!(
                        "{name}: unchanged case expectations diverge from the source oracle"
                    ));
                }
                roundtrip_asts(&case["source"], &mut errors, name);
            }
            "approved-correction" | "source-throw-hardened" => {
                let code = case["approved"]["code"].as_str().unwrap_or("");
                let category = match code {
                    "AC-1" => "scanner-contraction-apostrophe",
                    "AC-2" => "nested-tokenizer-errors",
                    "AC-3" => "template-inner-unconsumed-tokens",
                    "AC-4" => "array-item-unconsumed-tokens",
                    "AC-5" => "scanner-array-bracket-context",
                    _ => "UNKNOWN",
                };
                let item = if matches!(code, "AC-1" | "AC-5") {
                    4
                } else {
                    5
                };
                if case["approved"]["userApprovedItem"] != item {
                    errors.push(format!("{name}: fixture category must map to the approved scanner/nested-diagnostic item"));
                }
                if case["approved"]["category"] != category {
                    errors.push(format!("{name}: approval code/category mismatch"));
                }
                if parity == "approved-correction"
                    && case["expected"]["legacy"] == case["expected"]["default"]
                {
                    errors.push(format!(
                        "{name}: correction does not enumerate a changed result"
                    ));
                }
                if !matches!(code, "AC-1" | "AC-2" | "AC-3" | "AC-4" | "AC-5")
                    || case["approved"]["rationale"]
                        .as_str()
                        .is_none_or(str::is_empty)
                {
                    errors.push(format!(
                        "{name}: correction lacks an enumerated approval and rationale"
                    ));
                }
                if parity == "approved-correction"
                    && raw_result(
                        case["operation"].as_str().unwrap(),
                        &case["expected"]["legacy"],
                    ) != case["source"]
                {
                    errors.push(format!("{name}: nonthrowing legacy expectation changed"));
                }
                if parity == "source-throw-hardened" && !case["source"]["thrown"].is_object() {
                    errors.push(format!(
                        "{name}: throw hardening has no recorded source throw"
                    ));
                }
                roundtrip_asts(&case["expected"], &mut errors, name);
            }
            other => errors.push(format!("{name}: unknown parity policy {other}")),
        }
        for (profile, engine) in &engines {
            let expected = &case["expected"][*profile];
            match std::panic::catch_unwind(|| actual_case(engine, case)) {
                Ok(Ok(actual)) if actual == *expected => {}
                Ok(Ok(actual)) => errors.push(format!(
                    "{name} [{profile}] input={}\n  expected={expected}\n  actual={actual}",
                    case["input"]
                )),
                Ok(Err(error)) => errors.push(format!(
                    "{name} [{profile}] input={}\n  {error}",
                    case["input"]
                )),
                Err(_) => errors.push(format!("{name} [{profile}]: syntax API panicked")),
            }
        }
    }
    // One failure reports the total and bounded details, so the first capped
    // candidate run diagnoses independent mismatches instead of stopping early.
    let total = errors.len();
    for error in errors.iter().take(20) {
        eprintln!("{}", error.chars().take(4000).collect::<String>());
    }
    assert_eq!(
        total, 0,
        "{total} oracle/roundtrip mismatches; first 20 detailed cases printed"
    );
}

fn assert_set(value: &Value, expected: &[&str]) {
    let actual: BTreeSet<_> = value
        .as_array()
        .expect("coverage array")
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(actual, expected.iter().copied().collect());
}

fn json_depth(value: &Value) -> usize {
    match value {
        Value::Array(items) => 1 + items.iter().map(json_depth).max().unwrap_or(0),
        Value::Object(object) => 1 + object.values().map(json_depth).max().unwrap_or(0),
        _ => 0,
    }
}

fn discover_coverage(value: &Value, found: &mut BTreeMap<&'static str, BTreeSet<String>>) {
    match value {
        Value::Object(object) => {
            if let Some(kind) = object.get("type").and_then(Value::as_str) {
                if [
                    "root",
                    "literal",
                    "function",
                    "commandRef",
                    "setVar",
                    "getVar",
                    "exists",
                    "deleteVar",
                    "binary",
                    "unary",
                    "ternary",
                    "template",
                    "arrayLiteral",
                    "loopVar",
                    "loopAssign",
                    "forLoop",
                ]
                .contains(&kind)
                {
                    found.entry("nodeTypes").or_default().insert(kind.into());
                }
                for (kind_filter, property, category) in [
                    ("binary", "operator", "binaryOperators"),
                    ("unary", "operator", "unaryOperators"),
                    ("loopAssign", "operator", "loopAssignOperators"),
                    ("forLoop", "mode", "loopModes"),
                ] {
                    if kind == kind_filter
                        && let Some(text) = object.get(property).and_then(Value::as_str)
                    {
                        found.entry(category).or_default().insert(text.into());
                    }
                }
            }
            if let Some(storage) = object.get("storage").and_then(Value::as_str) {
                found.entry("storages").or_default().insert(storage.into());
            }
            if let Some(accessor) = object
                .get("accessor")
                .and_then(|v| v.get("type"))
                .and_then(Value::as_str)
            {
                found
                    .entry("accessors")
                    .or_default()
                    .insert(accessor.into());
            }
            for child in object.values() {
                discover_coverage(child, found);
            }
        }
        Value::Array(array) => {
            for child in array {
                discover_coverage(child, found);
            }
        }
        _ => {}
    }
}

#[test]
fn corpus_manifest_has_complete_coverage_and_real_source_files() {
    let corpus = fixture();
    assert_eq!(corpus["schemaVersion"], 2);
    assert_eq!(corpus["fixtureId"], "dima-rust-ast-syntax-reference");
    let depth = json_depth(&corpus);
    assert!(depth < 120, "keep the default serde_json recursion guard");
    assert_eq!(
        corpus["coverage"]["maxCorpusJsonDepth"].as_u64().unwrap() as usize,
        depth
    );
    let hash = |v: &Value| {
        let text = v.as_str().expect("SHA256 string");
        assert_eq!(text.len(), 64);
        assert!(
            text.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
    };
    hash(&corpus["corpusHash"]);
    let source_hashes = corpus["sources"].as_object().unwrap();
    assert_eq!(source_hashes.len(), 5);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    for name in [
        "types.ts",
        "tokenizer.ts",
        "registry.ts",
        "parser.ts",
        "render.ts",
    ] {
        hash(&source_hashes[name]);
        let relative = root.join("dimabot/src/utils/ast_parser").join(name);
        let path = if relative.exists() {
            relative
        } else {
            Path::new("/dimabot/src/utils/ast_parser").join(name)
        };
        // The lead's isolated source snapshot must include these files. Their
        // actual SHA256 equality is proved by the oracle --check, without
        // widening ast-syntax to sha2 or invoking processes from a Rust test.
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("source manifest path {}: {error}", path.display()));
        assert!(
            !source.trim().is_empty(),
            "empty hashed source {}",
            path.display()
        );
    }
    let cases = corpus["cases"].as_array().unwrap();
    assert!((1000..=4000).contains(&cases.len()));
    assert_eq!(
        corpus["counts"]["cases"].as_u64().unwrap() as usize,
        cases.len()
    );
    let mut operations = BTreeMap::<&str, usize>::new();
    let mut parities = BTreeMap::<&str, usize>::new();
    let mut approvals = BTreeMap::<&str, usize>::new();
    let mut names = BTreeSet::new();
    for case in cases {
        assert!(
            names.insert(case["name"].as_str().unwrap()),
            "duplicate case name"
        );
        *operations
            .entry(case["operation"].as_str().unwrap())
            .or_default() += 1;
        *parities
            .entry(case["parity"].as_str().unwrap())
            .or_default() += 1;
        if let Some(code) = case["approved"]["code"].as_str() {
            *approvals.entry(code).or_default() += 1;
        }
    }
    assert_eq!(
        operations.keys().copied().collect::<BTreeSet<_>>(),
        ["parse", "scan", "compiled-template", "unescape"]
            .into_iter()
            .collect()
    );
    for (operation, count) in operations {
        assert_eq!(
            corpus["counts"][operation].as_u64().unwrap() as usize,
            count
        );
    }
    for (parity, count) in parities {
        assert_eq!(
            corpus["counts"]["parity"][parity].as_u64().unwrap() as usize,
            count
        );
    }
    assert_eq!(approvals.len(), 5);
    for approval in corpus["approvedCorrections"].as_array().unwrap() {
        assert_eq!(
            approval["cases"].as_u64().unwrap() as usize,
            approvals[approval["code"].as_str().unwrap()]
        );
    }
    let mut discovered = BTreeMap::new();
    for case in cases {
        discover_coverage(&case["source"], &mut discovered);
    }
    for (category, actual) in &discovered {
        let declared: BTreeSet<_> = corpus["coverage"][*category]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            *actual, declared,
            "coverage manifest must describe real corpus ASTs: {category}"
        );
    }
    let coverage = &corpus["coverage"];
    assert_set(
        &coverage["nodeTypes"],
        &[
            "root",
            "literal",
            "function",
            "commandRef",
            "setVar",
            "getVar",
            "exists",
            "deleteVar",
            "binary",
            "unary",
            "ternary",
            "template",
            "arrayLiteral",
            "loopVar",
            "loopAssign",
            "forLoop",
        ],
    );
    assert_set(
        &coverage["storages"],
        &["memory", "cache", "cacheUser", "db", "dbUser"],
    );
    assert_set(
        &coverage["accessors"],
        &[
            "array", "index", "random", "length", "append", "setIndex", "remove", "clear",
        ],
    );
    assert_set(
        &coverage["binaryOperators"],
        &[
            "==", "!=", ">=", "<=", ">", "<", "=", "~=", "<>", "+", "-", "*", "/", "%",
        ],
    );
    assert_set(&coverage["unaryOperators"], &["+", "-"]);
    assert_set(
        &coverage["loopAssignOperators"],
        &["=", "+=", "-=", "*=", "/=", "%=", "++", "--"],
    );
    assert_set(&coverage["loopModes"], &["range", "foreach"]);
    for channel in [
        "parseErrorCases",
        "loopErrorLiteralNodes",
        "templateParseErrorTextSegments",
        "sourceOracleThrowsRecorded",
        "unclosedScanSegments",
    ] {
        assert!(
            coverage["errorChannels"][channel].as_u64().unwrap() > 0,
            "uncovered {channel}"
        );
    }
    assert_eq!(corpus["benchmarks"].as_array().unwrap().len(), 14);
    for benchmark in corpus["benchmarks"].as_array().unwrap() {
        assert!(benchmark["source"].is_string());
        assert!(
            benchmark.get("ast").is_none(),
            "deep benchmark AST must remain source-only"
        );
        assert!(benchmark["expected"].get("ast").is_none());
    }
}

#[test]
fn aggregate_segment_and_nested_budgets_cannot_reset() {
    let engine = SyntaxEngine::default();
    let source = "$(user) $(user) $(user)";
    let plan = engine.compile_template(source).unwrap();
    let one = engine.compile_template("$(user)").unwrap().stats();
    assert!(plan.stats().tokens >= one.tokens * 3);
    assert!(plan.stats().nodes >= one.nodes * 3);
    let limits = Limits {
        tokens: plan.stats().tokens - 1,
        ..Limits::default()
    };
    assert_eq!(
        engine
            .clone()
            .with_limits(limits)
            .compile_template(source)
            .unwrap_err()
            .code,
        DiagnosticCode::TokenLimit
    );
    let limits = Limits {
        nodes: plan.stats().nodes - 1,
        ..Limits::default()
    };
    assert_eq!(
        engine
            .clone()
            .with_limits(limits)
            .compile_template(source)
            .unwrap_err()
            .code,
        DiagnosticCode::NodeLimit
    );
    for nested in ["%[%[1,2],%[3,4]]", "\"${1}${2}${3}\""] {
        let stats = engine.parse(nested).unwrap().stats();
        let limits = Limits {
            tokens: stats.tokens - 1,
            ..Limits::default()
        };
        assert_eq!(
            engine
                .clone()
                .with_limits(limits)
                .parse(nested)
                .unwrap_err()
                .code,
            DiagnosticCode::TokenLimit
        );
        let limits = Limits {
            nodes: stats.nodes - 1,
            ..Limits::default()
        };
        assert_eq!(
            engine
                .clone()
                .with_limits(limits)
                .parse(nested)
                .unwrap_err()
                .code,
            DiagnosticCode::NodeLimit
        );
    }
}

#[test]
fn defaults_utf16_offsets_and_budget_diagnostics_are_safe() {
    let limits = Limits::default();
    assert_eq!(
        (
            limits.source_utf16,
            limits.tokens,
            limits.nodes,
            limits.nesting
        ),
        (10_000, 20_000, 4_000, 128)
    );
    let engine = SyntaxEngine::default();
    let source = "😀 )";
    let error = engine.parse(source).unwrap_err();
    assert_eq!(error.code, DiagnosticCode::UnexpectedClosing);
    assert_eq!(error.span, SourceSpan { start: 3, end: 4 });
    let source = "\"😀\\n${1}\" )";
    let error = engine.parse(source).unwrap_err();
    let start = source[..source.rfind(')').unwrap()].encode_utf16().count();
    assert_eq!(
        error.span,
        SourceSpan {
            start,
            end: start + 1
        }
    );
    let source = "\"😀\\n${1 2}\"";
    let error = engine.parse(source).unwrap_err();
    let start = source[..source.find('2').unwrap()].encode_utf16().count();
    assert_eq!(error.code, DiagnosticCode::UnexpectedToken);
    assert_eq!(
        error.span,
        SourceSpan {
            start,
            end: start + 1
        },
        "decoded escapes must retain original UTF16 offsets"
    );
    let segments = engine.scan_template("😀 $(user)!").unwrap();
    assert_eq!(segments[1].span(), SourceSpan { start: 3, end: 10 });
    let short = engine.clone().with_limits(Limits {
        source_utf16: 2,
        ..limits
    });
    assert!(short.parse("😀").is_ok());
    let error = short.parse("😀x").unwrap_err();
    assert_eq!(error.code, DiagnosticCode::SourceLimit);
    assert_eq!(error.span, SourceSpan { start: 0, end: 3 });
    for limits in [
        Limits {
            tokens: 0,
            ..limits
        },
        Limits { nodes: 0, ..limits },
        Limits {
            nesting: 0,
            ..limits
        },
    ] {
        let result =
            std::panic::catch_unwind(|| engine.clone().with_limits(limits).parse("$(user)"));
        let error = result
            .expect("budget exhaustion must never panic")
            .unwrap_err();
        assert!(error.is_resource_limit());
        assert!(!error.message.is_empty());
    }
}

#[test]
fn generated_nesting_obeys_configured_and_hard_ceiling() {
    let engine = SyntaxEngine::default();
    let small = engine.clone().with_limits(Limits {
        nesting: 8,
        ..Limits::default()
    });
    assert!(small.parse("%[%[1]]").is_ok());
    let nested = format!("{}1{}", "%[".repeat(20), "]".repeat(20));
    assert_eq!(
        small.parse(&nested).unwrap_err().code,
        DiagnosticCode::NestingLimit
    );
    let chain = format!("*({})", vec!["1"; 140].join(" + "));
    assert_eq!(
        engine.parse(&chain).unwrap_err().code,
        DiagnosticCode::NestingLimit,
        "AST depth also needs a bound when input delimiter nesting is shallow"
    );
    let too_deep = format!("{}1{}", "%[".repeat(140), "]".repeat(140));
    let raised = engine.with_limits(Limits {
        nesting: usize::MAX,
        ..Limits::default()
    });
    let outcome = std::panic::catch_unwind(|| raised.parse(&too_deep));
    assert_eq!(
        outcome
            .expect("hard ceiling must prevent panic")
            .unwrap_err()
            .code,
        DiagnosticCode::NestingLimit
    );
}

#[test]
fn plans_reuse_exact_source_profile_grammar_and_limits() {
    let source = "Hi $(user)!";
    let engine = SyntaxEngine::default();
    let plan = engine.compile_template(source).unwrap();
    let cloned = plan.clone();
    assert_eq!(cloned.source(), source);
    assert!(cloned.matches_source(source));
    assert!(cloned.is_compatible_with(&engine.clone(), source));
    assert!(cloned.is_compatible_with(&SyntaxEngine::default(), source));
    assert!(!cloned.matches_source("Hi $(user)! "));
    assert!(!cloned.is_compatible_with(&engine, "Hi $(user)! "));
    assert!(!cloned.is_compatible_with(&SyntaxEngine::typescript_compatible(), source));
    for limits in [
        Limits {
            tokens: 19_999,
            ..Limits::default()
        },
        Limits {
            nodes: 3999,
            ..Limits::default()
        },
        Limits {
            source_utf16: 9999,
            ..Limits::default()
        },
        Limits {
            nesting: 127,
            ..Limits::default()
        },
    ] {
        assert!(!cloned.is_compatible_with(&engine.clone().with_limits(limits), source));
    }
    let grammar = GrammarBuilder::default()
        .register("$extra(", ")", SyntaxHandler::Function)
        .build()
        .unwrap();
    let extended = SyntaxEngine::new(grammar, SyntaxProfile::Improved, Limits::default());
    assert!(!cloned.is_compatible_with(&extended, source));
    let stats = cloned.stats();
    let values: Vec<_> = cloned
        .segments()
        .iter()
        .filter_map(|s| s.program())
        .map(|p| p.as_ref().unwrap().to_value())
        .collect();
    for _ in 0..20 {
        let reused: Vec<_> = cloned
            .segments()
            .iter()
            .filter_map(|s| s.program())
            .map(|p| p.as_ref().unwrap().to_value())
            .collect();
        assert_eq!(values, reused);
        assert_eq!(
            stats,
            cloned.stats(),
            "traversal must not parse or mutate counters"
        );
    }
    let plain = engine.compile_template(&"x".repeat(8000)).unwrap();
    assert_eq!(plain.stats().tokens, 0);
    assert_eq!(plain.stats().nodes, 0);
    assert_eq!(plain.segments().len(), 1);
}

#[test]
fn grammar_extensions_preserve_prefixes_and_ast_optional_field_omission() {
    let grammar = GrammarBuilder::default()
        .register("$long(", ")", SyntaxHandler::Function)
        .register("$((", ")", SyntaxHandler::Function)
        .build()
        .unwrap();
    let engine = SyntaxEngine::new(grammar.clone(), SyntaxProfile::Improved, Limits::default());
    let source = "a $long(user) $(user) %del(x)";
    let plan = engine.compile_template(source).unwrap();
    assert_eq!(
        plan.segments()
            .iter()
            .filter(|s| s.program().is_some())
            .count(),
        3
    );
    assert_eq!(
        engine.parse("$long(user)").unwrap().to_value(),
        SyntaxEngine::default().parse("$(user)").unwrap().to_value()
    );
    assert_ne!(grammar.identity(), PreparedGrammar::default().identity());
    let overlapping = engine.compile_template("$((user)").unwrap();
    assert_eq!(overlapping.segments().len(), 1);
    assert_eq!(
        overlapping.segments()[0]
            .program()
            .unwrap()
            .as_ref()
            .unwrap()
            .to_value(),
        SyntaxEngine::default().parse("$(user)").unwrap().to_value(),
        "scanner and parser must agree on the longest registered introducer"
    );
    assert!(
        GrammarBuilder::default()
            .register("bad", ")", SyntaxHandler::Function)
            .build()
            .is_err()
    );
    for (prefix, storage) in [
        ("", "memory"),
        ("#", "cache"),
        ("##", "cacheUser"),
        ("*", "db"),
        ("**", "dbUser"),
    ] {
        let ast = engine.parse(&format!("%({prefix}x)")).unwrap().to_value();
        assert_eq!(
            ast,
            json!({"type": "root", "children": [{"type": "getVar", "name": format!("{prefix}x"), "storage": storage}]})
        );
        let roundtrip: AstNode = serde_json::from_value(ast.clone()).unwrap();
        assert_eq!(roundtrip.to_value(), ast);
    }
    let ast = engine.parse("%[1]").unwrap().to_value();
    assert!(ast["children"][0].get("accessor").is_none());
    assert!(ast["children"][0].get("span").is_none());
}

#[test]
fn improved_errors_are_local_and_nested_array_failures_propagate() {
    let engine = SyntaxEngine::default();
    let error = engine.parse("%[%(x]").unwrap_err();
    assert_eq!(error.code, DiagnosticCode::UnclosedDelimiter);
    assert_eq!(error.message, "Unclosed \"%(\"");
    assert_eq!(error.span, SourceSpan { start: 2, end: 4 });
    let error = engine.parse("%[1 2]").unwrap_err();
    assert_eq!(error.code, DiagnosticCode::UnexpectedToken);
    assert_eq!(error.span, SourceSpan { start: 4, end: 5 });
    let plan = engine
        .compile_template("$(user) $(say %[1 2]) $(user)")
        .unwrap();
    let programs: Vec<_> = plan.segments().iter().filter_map(|s| s.program()).collect();
    assert_eq!(programs.len(), 3);
    assert!(programs[0].is_ok());
    assert_eq!(
        programs[1].as_ref().unwrap_err().code,
        DiagnosticCode::UnexpectedToken
    );
    assert!(
        programs[2].is_ok(),
        "one syntax failure must not abort later expressions"
    );
    let plan = engine.compile_template("$(user) tail $(unclosed").unwrap();
    assert!(plan.segments()[0].program().unwrap().is_ok());
    assert_eq!(
        plan.segments().last().unwrap().diagnostic().unwrap().code,
        DiagnosticCode::UnclosedExpression
    );
    for source in ["$(say don't panic)", "$(say can't stop)", "$(say y'all)"] {
        let segments = engine.scan_template(source).unwrap();
        assert_eq!(serde_json::to_value(&segments).unwrap()[0]["kind"], "expr");
        assert_eq!(segments.len(), 1);
        assert!(
            engine.compile_template(source).unwrap().segments()[0]
                .program()
                .unwrap()
                .is_ok()
        );
    }
}

#[test]
fn array_index_and_lexer_counters_prove_no_recursive_retokenization() {
    let engine = SyntaxEngine::default();
    // 62 nested arrays fit the standard JSON reader's 127-container ceiling.
    for depth in [1, 8, 16, 32, 62] {
        let source = format!("{}1{}", "%[".repeat(depth), "]".repeat(depth));
        let stats = engine.parse(&source).unwrap().stats();
        assert_eq!(stats.arrays, depth);
        assert_eq!(
            stats.tokens,
            depth + 1,
            "one array token per level plus one literal"
        );
        assert_eq!(
            stats.array_indexed_bytes,
            source.len(),
            "each nested array region must be indexed once"
        );
        // lexed_bytes counts token spans (including parent array spans);
        // array_indexed_bytes measures actual structural scanning work.
    }
}

#[test]
fn malformed_unicode_inputs_keep_public_ranges_and_persistence_safe() {
    let alphabet = [
        'a', '1', ' ', '$', '%', '*', '^', '#', '(', ')', '[', ']', '{', '}', ';', ':', '?', '"',
        '\\', '\n', 'é', '😀', '\0',
    ];
    let engines = [
        SyntaxEngine::default(),
        SyntaxEngine::typescript_compatible(),
    ];
    let mut seed = 0x6173_745f_7379_6e74_u64;
    for sample in 0..512 {
        let length = (seed as usize) % 48;
        let mut input = String::new();
        for _ in 0..length {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            input.push(alphabet[(seed >> 32) as usize % alphabet.len()]);
        }
        seed = seed.wrapping_add(1);
        let units = input.encode_utf16().count();
        let check_span = |span: SourceSpan| {
            assert!(
                span.start <= span.end && span.end <= units,
                "sample {sample}: {input:?}, {span:?}"
            );
        };
        for engine in &engines {
            match engine.parse(&input) {
                Ok(program) => {
                    let serialized = serde_json::to_string(program.root()).unwrap();
                    let restored: AstNode = serde_json::from_str(&serialized).unwrap();
                    assert_eq!(restored.to_value(), program.to_value());
                }
                Err(error) => check_span(error.span),
            }
            match engine.compile_template(&input) {
                Ok(plan) => {
                    let reconstructed: String = plan
                        .segments()
                        .iter()
                        .map(|segment| segment.source_segment().raw_text())
                        .collect();
                    assert_eq!(reconstructed, input);
                    for segment in plan.segments() {
                        check_span(segment.source_segment().span());
                        if let Some(error) = segment.diagnostic() {
                            check_span(error.span);
                        }
                    }
                }
                Err(error) => check_span(error.span),
            }
        }
    }
}
