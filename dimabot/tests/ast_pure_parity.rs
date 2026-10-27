#![cfg(feature = "ast-pure-functions")]

// Source expectations belong to the oracle. Reuse the complete existing typed
// adapter, context/host observers and ONLY its established narrow projections.
#[allow(dead_code)]
#[path = "../examples/ast_evaluator_bench.rs"]
mod harness;

use dima_rust::utils::{
    ast_evaluator::{
        Context, Engine, EvalError, EvalResult, ExecutionContext, FunctionMetadata,
        FunctionRegistry, Host, HostFuture, HostRequest, JsString, JsValue,
    },
    ast_syntax::AstNode,
};
use harness::{
    adapter::{PreparedCase, normalize, project},
    support::{block_on, fingerprint, sha256_hex},
};
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use std::{collections::BTreeSet, path::Path, rc::Rc};

const NAMES: [&str; 27] = [
    "upper",
    "lower",
    "title",
    "capitalize",
    "trim",
    "length",
    "slice",
    "replace",
    "user",
    "touser",
    "random",
    "twitch.modiversary",
    "twitch.streak",
    "raid.channel",
    "raid.login",
    "raid.viewers",
    "cheer.amount",
    "cheer.message",
    "sub.tier",
    "sub.months",
    "gifted.user",
    "hypetrain.progress",
    "hypetrain.level",
    "hypetrain.end",
    "shoutout.channel",
    "reward.input",
    "redemption.input",
];

fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/ast_pure_cases.json")).unwrap()
}

// Preserve source object insertion order for the oracle's JSON.stringify hash.
fn compact(raw: &str) -> String {
    let mut result = String::new();
    let (mut quoted, mut escaped) = (false, false);
    for c in raw.chars() {
        if quoted {
            result.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
        } else if c == '"' {
            quoted = true;
            result.push(c);
        } else if !c.is_ascii_whitespace() {
            result.push(c);
        }
    }
    assert!(!quoted && !escaped);
    result
}

#[test]
fn frozen_source_manifest_provenance_and_complete_case_inventory() {
    #[derive(Deserialize)]
    struct Manifest<'a> {
        #[serde(borrow)]
        cases: &'a RawValue,
        #[serde(borrow)]
        benchmarks: &'a RawValue,
    }
    let bytes = include_bytes!("fixtures/ast_pure_cases.json");
    let raw: Manifest<'_> = serde_json::from_slice(bytes).unwrap();
    let manifest = format!(
        "{{\"cases\":{},\"benchmarks\":{}}}",
        compact(raw.cases.get()),
        compact(raw.benchmarks.get())
    );
    let corpus = corpus();
    assert_eq!(corpus["schemaVersion"], 1);
    assert_eq!(corpus["profile"], "source-parity");
    assert_eq!(corpus["manifestHash"], sha256_hex(manifest.as_bytes()));
    assert_ne!(corpus["manifestHash"], sha256_hex(bytes));
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let sources = corpus["sourceHashes"].as_object().unwrap();
    assert!(!sources.is_empty());
    for (path, hash) in sources {
        assert!(!path.starts_with('/') && !path.split('/').any(|part| part == ".."));
        assert_eq!(
            sha256_hex(
                &std::fs::read(
                    root.join(
                        path.strip_prefix("dimabot/")
                            .expect("source path must remain under dimabot"),
                    )
                )
                .unwrap()
            ),
            hash.as_str().unwrap(),
            "source drift {path}"
        );
    }
    let cases = corpus["cases"].as_array().unwrap();
    assert!((1000..=6000).contains(&cases.len()), "frozen corpus bounds");
    assert_eq!(corpus["coverage"]["caseCount"], cases.len());
    let mut ids = BTreeSet::new();
    let mut categories = std::collections::BTreeMap::<&str, usize>::new();
    for case in cases {
        assert!(
            ids.insert(case["id"].as_str().unwrap()),
            "duplicate source ID"
        );
        assert_eq!(case["input"]["pureBuiltins"], true);
        assert!(case["source"].is_object());
        for exemption in ["skip", "domain", "expectedRust", "limitation"] {
            assert!(
                case.get(exemption).is_none(),
                "no exemptions: {} {exemption}",
                case["id"]
            );
        }
        *categories
            .entry(case["category"].as_str().unwrap())
            .or_default() += 1;
    }
    for (category, count) in categories {
        assert_eq!(corpus["coverage"]["categoryCounts"][category], count);
    }
    let workloads = corpus["benchmarks"].as_array().unwrap();
    assert!(!workloads.is_empty() && workloads.len() <= 32);
    assert_eq!(corpus["coverage"]["benchmarkCount"], workloads.len());
    for workload in workloads {
        assert!(workload.get("excludedReason").is_none());
        assert_eq!(workload["input"]["pureBuiltins"], true);
        assert!(workload["source"].is_object());
    }
    let old: Value =
        serde_json::from_str(include_str!("fixtures/ast_evaluator_cases.json")).unwrap();
    assert_eq!(
        old["cases"].as_array().unwrap().len(),
        3563,
        "old corpus retained intact"
    );
    eprintln!(
        "pure corpus={} manifest={} cases={} benchmarks={}",
        sha256_hex(bytes),
        corpus["manifestHash"],
        cases.len(),
        workloads.len()
    );
}

#[test]
fn every_source_case_matches_full_typed_value_context_and_ordered_host_trace() {
    #[derive(Deserialize)]
    struct Corpus {
        cases: Vec<Case>,
    }
    #[derive(Deserialize)]
    struct Case {
        id: String,
        input: Box<RawValue>,
        source: Value,
    }
    let corpus: Corpus =
        serde_json::from_str(include_str!("fixtures/ast_pure_cases.json")).unwrap();
    let mut errors = Vec::new();
    let mut evaluated = 0;
    for case in &corpus.cases {
        let mut expected = case.source.clone();
        project(&mut expected);
        match PreparedCase::new(case.input.get()) {
            Ok(prepared) => {
                evaluated += 1;
                let actual = normalize(&prepared.run(false));
                if actual != expected {
                    errors.push(format!(
                        "{} input={}\nexpected={expected}\nactual={actual}",
                        case.id,
                        case.input.get()
                    ));
                }
            }
            Err(error) => errors.push(format!(
                "{} preparation error={error} input={}",
                case.id,
                case.input.get()
            )),
        }
    }
    for error in errors.iter().take(30) {
        eprintln!("{}", error.chars().take(12000).collect::<String>());
    }
    assert_eq!(
        evaluated,
        corpus.cases.len(),
        "every source ID must execute"
    );
    assert!(
        errors.is_empty(),
        "{} parity mismatches; first 30 shown",
        errors.len()
    );
}

#[test]
fn registration_metadata_aliases_and_independent_context_opt_in() {
    assert_eq!(FunctionRegistry::default().entries().count(), 0);
    let mut host = RecordingHost::default();
    let empty = run(
        &Engine::default(),
        "upper",
        Vec::new(),
        ExecutionContext::default().into_context(),
        &mut host,
    );
    assert_eq!(text(&empty), JsString::from("[Unknown function: upper]"));
    assert!(host.calls.is_empty());
    let pure = FunctionRegistry::with_pure_builtins();
    let actual: BTreeSet<_> = pure.entries().map(|entry| entry.name.as_str()).collect();
    assert_eq!(actual, NAMES.into_iter().collect());
    for absent in [
        "count",
        "scount",
        "bits",
        "break",
        "continue",
        "randomuser",
        "delay",
    ] {
        assert!(
            pure.metadata(absent).is_none(),
            "pure installer leaked {absent}"
        );
    }
    let fixture = corpus();
    let metadata = fixture["pureRegistry"]
        .as_array()
        .expect("source-derived registry metadata");
    assert_eq!(metadata.len(), 27);
    assert_eq!(
        pure.entries()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        metadata
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        "source registration order"
    );
    for entry in metadata {
        let name = entry["name"].as_str().unwrap();
        let actual = serde_json::to_value(pure.metadata(name).unwrap()).unwrap();
        assert_eq!(actual, entry["metadata"], "source metadata {name}");
    }
    assert_eq!(
        pure.metadata("redemption.input")
            .unwrap()
            .alias_of
            .as_deref(),
        Some("reward.input")
    );
    let context = FunctionRegistry::with_context_builtins();
    assert_eq!(context.entries().count(), 5);
    assert!(context.metadata("upper").is_none());
    let context_metadata: Vec<_> = context
        .entries()
        .map(|entry| {
            (
                entry.name.clone(),
                serde_json::to_value(&entry.metadata).unwrap(),
            )
        })
        .collect();
    let mut combined = FunctionRegistry::with_context_builtins();
    combined.register("custom", None);
    combined.register_pure_builtins();
    assert_eq!(combined.entries().count(), 33);
    assert!(combined.entries().any(|entry| entry.name == "custom"));
    for (name, metadata) in context_metadata {
        assert_eq!(
            serde_json::to_value(combined.metadata(&name)).unwrap(),
            metadata
        );
    }
}

#[derive(Default)]
struct RecordingHost {
    calls: Vec<String>,
    arguments: Vec<Vec<Value>>,
    rng: Vec<f64>,
    random_calls: usize,
}
impl Host for RecordingHost {
    fn execute<'a>(&'a mut self, request: HostRequest, _: Context) -> HostFuture<'a> {
        Box::pin(async move {
            match request {
                HostRequest::Function { name, args } => {
                    self.calls.push(name.clone());
                    self.arguments
                        .push(args.iter().map(JsValue::to_typed_json).collect());
                    if name == "fixture.touch" {
                        Ok(args.first().cloned().unwrap_or_default())
                    } else {
                        Ok(JsValue::string("host override"))
                    }
                }
                other => panic!("unexpected host request {other:?}"),
            }
        })
    }
    fn random(&mut self) -> Result<f64, EvalError> {
        let value = self.rng.get(self.random_calls).copied().unwrap_or(0.25);
        self.random_calls += 1;
        Ok(value)
    }
}
fn function(name: &str, args: Vec<AstNode>) -> AstNode {
    AstNode::Function {
        name: name.into(),
        args,
    }
}
fn literal(value: &str) -> AstNode {
    AstNode::Literal {
        value: value.into(),
    }
}
fn run(
    engine: &Engine,
    name: &str,
    args: Vec<JsValue>,
    context: Context,
    host: &mut RecordingHost,
) -> EvalResult {
    let nodes = args
        .into_iter()
        .enumerate()
        .map(|(index, value)| {
            let name = format!("argument{index}");
            context
                .borrow()
                .variables
                .borrow_mut()
                .insert(name.clone(), value);
            serde_json::from_value(json!({"type":"getVar","name":name,"storage":"memory"})).unwrap()
        })
        .collect();
    block_on(engine.evaluate(&function(name, nodes), context, host)).unwrap()
}
fn text(result: &EvalResult) -> JsString {
    match &result.value {
        JsValue::String(value) => value.clone(),
        other => panic!("not text: {other:?}"),
    }
}

#[test]
fn all_27_native_names_allocate_zero_host_futures_and_random_uses_existing_host_rng() {
    let engine = Engine::new(FunctionRegistry::with_pure_builtins());
    for name in NAMES {
        let mut host = RecordingHost::default();
        let result = run(
            &engine,
            name,
            Vec::new(),
            ExecutionContext::default().into_context(),
            &mut host,
        );
        assert_eq!(result.stats.host_futures, 0, "{name}");
        assert_eq!(result.stats.node_futures, 0, "{name}");
        assert!(
            host.calls.is_empty(),
            "pure function crossed boxed host boundary: {name}"
        );
        assert_eq!(host.random_calls, usize::from(name == "random"));
        assert_eq!(result.stats.host_calls, u64::from(name == "random"));
    }
    let prepared = PreparedCase::new(r#"{"operation":"evaluate","pureBuiltins":true,"ast":{"type":"function","name":"random","args":[]},"host":{"randomSeed":1}}"#).unwrap();
    let first = prepared.run(false);
    let second = prepared.run(false);
    assert_eq!(
        normalize(&first),
        normalize(&second),
        "fresh deterministic host RNG"
    );
    assert_eq!(
        normalize(&first)["host"]["events"],
        json!([{"type":"array","value":[{"type":"string","value":"random"},{"type":"number","value":1015568748.0 / 4294967296.0}]}])
    );
    assert_eq!(text(first.result.as_ref().unwrap()), JsString::from("23"));
    assert_eq!(first.result.as_ref().unwrap().stats.host_futures, 0);
    for (args, expected) in [
        (vec![], "25"),
        (vec![JsValue::string("0")], "25"),
        (vec![JsValue::string("bad")], "25"),
        (vec![JsValue::string("-8")], "-2"),
        (vec![JsValue::string("12tail")], "3"),
    ] {
        let mut host = RecordingHost::default();
        let result = run(
            &engine,
            "random",
            args,
            ExecutionContext::default().into_context(),
            &mut host,
        );
        assert_eq!(text(&result), JsString::from(expected));
        assert_eq!(host.random_calls, 1);
    }
}

#[test]
fn custom_override_metadata_inheritance_and_permission_after_all_arguments() {
    let mut registry = FunctionRegistry::with_pure_builtins();
    let metadata = serde_json::to_value(registry.metadata("upper")).unwrap();
    registry.register("upper", None);
    assert_eq!(
        serde_json::to_value(registry.metadata("upper")).unwrap(),
        metadata
    );
    let engine = Engine::new(registry.clone());
    let mut host = RecordingHost::default();
    let result = run(
        &engine,
        "upper",
        vec![JsValue::string("abc")],
        ExecutionContext::default().into_context(),
        &mut host,
    );
    assert_eq!(text(&result), JsString::from("host override"));
    assert_eq!(host.calls, ["upper"]);
    assert_eq!(result.stats.host_futures, 1);
    registry.register_pure_builtins();
    let mut host = RecordingHost::default();
    let restored = run(
        &Engine::new(registry.clone()),
        "upper",
        vec![JsValue::string("abc")],
        ExecutionContext::default().into_context(),
        &mut host,
    );
    assert_eq!(text(&restored), JsString::from("ABC"));
    assert!(host.calls.is_empty());
    registry.register("fixture.touch", None);
    registry.register(
        "upper",
        Some(FunctionMetadata {
            min_user_level: Some(8.0),
            ..FunctionMetadata::default()
        }),
    );
    let engine = Engine::new(registry);
    let mut host = RecordingHost::default();
    let context = ExecutionContext {
        user_level: 1.0,
        enforce_function_permissions: true,
        ..ExecutionContext::default()
    }
    .into_context();
    let args = vec![
        function("fixture.touch", vec![literal("one")]),
        function("fixture.touch", vec![literal("two")]),
    ];
    let result = block_on(engine.evaluate(&function("upper", args), context, &mut host)).unwrap();
    assert!(
        text(&result)
            .to_utf8()
            .unwrap()
            .starts_with("Error: permission denied")
    );
    assert_eq!(host.calls, ["fixture.touch", "fixture.touch"]);
    assert_eq!(
        host.arguments,
        vec![
            vec![json!({"type":"string","value":"one"})],
            vec![json!({"type":"string","value":"two"})]
        ]
    );
    assert_eq!(
        result.stats.host_futures, 2,
        "both argument handlers execute; denied function does not"
    );
}

#[test]
fn pure_arguments_execute_fully_even_when_handler_does_not_read_them() {
    let mut registry = FunctionRegistry::with_pure_builtins();
    registry.register(
        "fixture.touch",
        Some(FunctionMetadata {
            min_user_level: Some(0.0),
            ..FunctionMetadata::default()
        }),
    );
    let engine = Engine::new(registry);
    for (name, level, expected) in [("raid.viewers", 1.0, Some("0")), ("upper", 0.0, None)] {
        let mut host = RecordingHost::default();
        let node = function(
            name,
            vec![
                function("fixture.touch", vec![literal("one")]),
                function("fixture.touch", vec![literal("two")]),
            ],
        );
        let context = ExecutionContext {
            user_level: level,
            ..ExecutionContext::default()
        }
        .into_context();
        let result = block_on(engine.evaluate(&node, context, &mut host)).unwrap();
        if let Some(expected) = expected {
            assert_eq!(text(&result), JsString::from(expected));
        } else {
            assert!(
                text(&result)
                    .to_utf8()
                    .unwrap()
                    .starts_with("Error: permission denied")
            );
        }
        assert_eq!(host.calls, ["fixture.touch", "fixture.touch"]);
        assert_eq!(
            host.arguments,
            vec![
                vec![json!({"type":"string","value":"one"})],
                vec![json!({"type":"string","value":"two"})]
            ]
        );
        assert_eq!(
            result.stats.host_futures, 2,
            "both arguments execute before native permission gate/ignored-args handler"
        );
    }
}

#[test]
fn native_get_preserves_shared_borrows_identity_first_match_and_independent_contexts() {
    let nested = JsValue::object(vec![("bits".into(), JsValue::Number(12.0))]);
    let event = JsValue::object(vec![
        ("cheer".into(), nested.clone()),
        ("bits".into(), JsValue::Number(99.0)),
        ("bits".into(), JsValue::Number(101.0)),
    ]);
    let JsValue::Object(entries) = &event else {
        unreachable!()
    };
    let borrow = entries.borrow();
    assert_eq!(
        event.get("bits").to_typed_json(),
        JsValue::Number(99.0).to_typed_json(),
        "public get keeps first matching key"
    );
    let JsValue::Object(found) = event.get("cheer") else {
        panic!("nested object")
    };
    let JsValue::Object(original) = &nested else {
        unreachable!()
    };
    assert!(
        Rc::ptr_eq(&found, original),
        "get clones shared handle, not object contents"
    );
    let before = event.to_typed_json();
    let engine = Engine::new(FunctionRegistry::with_pure_builtins());
    let program = function("cheer.amount", Vec::new());
    let first = ExecutionContext {
        event_data: event.clone(),
        ..ExecutionContext::default()
    }
    .into_context();
    let second = ExecutionContext {
        event_data: JsValue::object(vec![("bits".into(), JsValue::Number(7.0))]),
        ..ExecutionContext::default()
    }
    .into_context();
    let mut host = RecordingHost::default();
    let result = block_on(engine.evaluate(&program, first.clone(), &mut host)).unwrap();
    assert_eq!(text(&result), JsString::from("12"));
    assert!(Rc::ptr_eq(&first, &result.context));
    assert_eq!(event.to_typed_json(), before);
    assert_eq!(
        borrow.len(),
        3,
        "read-only native lookup coexists with caller borrow"
    );
    drop(borrow);
    nested.set("bits", JsValue::Number(18.0));
    assert_eq!(
        text(&block_on(engine.evaluate(&program, first, &mut host)).unwrap()),
        JsString::from("18")
    );
    assert_eq!(
        text(&block_on(engine.evaluate(&program, second, &mut host)).unwrap()),
        JsString::from("7")
    );
    assert!(host.calls.is_empty());
}

#[test]
fn utf16_units_lone_surrogates_expansions_and_literal_linear_replace() {
    let engine = Engine::new(FunctionRegistry::with_pure_builtins());
    let cases = [
        ("length", vec![JsValue::string("a😀b")], JsString::from("4")),
        (
            "slice",
            vec![
                JsValue::string("1"),
                JsValue::string("2"),
                JsValue::string("a😀b"),
            ],
            JsString::from_units(vec![0xd83d]),
        ),
        (
            "upper",
            vec![JsValue::String(JsString::from_units(vec![
                0xd800, 0x61, 0xdc00,
            ]))],
            JsString::from_units(vec![0xd800, 0x41, 0xdc00]),
        ),
        (
            "lower",
            vec![JsValue::string("ΟΣ İ")],
            JsString::from("ος i\u{307}"),
        ),
        (
            "upper",
            vec![JsValue::string("straße ﬃ")],
            JsString::from("STRASSE FFI"),
        ),
        (
            "title",
            vec![JsValue::string("éCOLE σΊΓΜΑ")],
            JsString::from("École Σίγμα"),
        ),
        (
            "capitalize",
            vec![JsValue::string("ßHELLO")],
            JsString::from("SSHELLO"),
        ),
        (
            "capitalize",
            vec![JsValue::String(JsString::from_units(vec![
                0xd801, 0xdc28, 0x61,
            ]))],
            JsString::from_units(vec![0xd801, 0xdc28, 0x61]),
        ),
        (
            "replace",
            vec![
                JsValue::string("aa"),
                JsValue::string("$&"),
                JsValue::string("aaaaa"),
            ],
            JsString::from("$&$&a"),
        ),
        (
            "replace",
            vec![
                JsValue::String(JsString::from_units(vec![0xd800])),
                JsValue::string("x"),
                JsValue::String(JsString::from_units(vec![0xd800, 0x61, 0xd800])),
            ],
            JsString::from("xax"),
        ),
    ];
    for (name, args, expected) in cases {
        let result = run(
            &engine,
            name,
            args,
            ExecutionContext::default().into_context(),
            &mut RecordingHost::default(),
        );
        assert_eq!(text(&result), expected, "{name}");
        assert_eq!(result.stats.host_futures, 0);
    }
    let long = format!("{}b", "a".repeat(16384));
    let needle = format!("{}b", "a".repeat(8192));
    let result = run(
        &engine,
        "replace",
        vec![
            JsValue::string(needle),
            JsValue::string("x"),
            JsValue::string(long),
        ],
        ExecutionContext::default().into_context(),
        &mut RecordingHost::default(),
    );
    assert_eq!(
        text(&result),
        JsString::from(format!("{}x", "a".repeat(8192))),
        "adversarial repeated prefix; no timing claim"
    );
}

#[test]
fn user_filter_escape_and_fallback_paths_are_read_only_and_fresh() {
    let engine = Engine::new(FunctionRegistry::with_pure_builtins());
    let context = || {
        ExecutionContext {
            user_display_name: "A\u{301}_١Ⅳ😀$%*".into(),
            argument: Some("$%*".into()),
            ..ExecutionContext::default()
        }
        .into_context()
    };
    for (name, args, expected) in [
        ("user", vec![], "A\u{301}_١Ⅳ😀$%*"),
        (
            "user",
            vec![JsValue::string("ignore symbols numbers")],
            "A\u{301}",
        ),
        (
            "user",
            vec![JsValue::string("ignore"), JsValue::string("symbols")],
            "A\u{301}١Ⅳ",
        ),
        (
            "user",
            vec![JsValue::string("ignore symbols invalid")],
            "A\u{301}_١Ⅳ😀$%*",
        ),
        ("touser", vec![], "\\$\\%\\*"),
    ] {
        let result = run(
            &engine,
            name,
            args,
            context(),
            &mut RecordingHost::default(),
        );
        assert_eq!(text(&result), JsString::from(expected));
        assert_eq!(result.stats.host_futures, 0);
    }
    let neutral = ExecutionContext {
        user_display_name: "\u{301}١😀".into(),
        ..ExecutionContext::default()
    }
    .into_context();
    let result = run(
        &engine,
        "user",
        vec![JsValue::string("ignore symbols numbers")],
        neutral,
        &mut RecordingHost::default(),
    );
    assert_eq!(text(&result), JsString::from("viewer"));
    let prepared = PreparedCase::new(r#"{"pureBuiltins":true,"contextBuiltins":true,"ast":{"type":"root","children":[{"type":"function","name":"scount","args":[]},{"type":"function","name":"upper","args":[{"type":"function","name":"count","args":[{"type":"literal","value":"+3"}]}]}]},"context":{"count":10}}"#).unwrap();
    let first = prepared.run(false);
    let second = prepared.run(false);
    assert_eq!(normalize(&first), normalize(&second));
    assert_eq!(first.result.as_ref().unwrap().context.borrow().count, 14.0);
    assert!(!Rc::ptr_eq(&first.initial, &second.initial));
    assert!(!Rc::ptr_eq(
        &first.initial.borrow().variables,
        &second.initial.borrow().variables
    ));
    assert_eq!(
        fingerprint(&normalize(&first)),
        fingerprint(&normalize(&second))
    );
}

#[test]
fn context_scalar_interop_preserves_raw_types_snapshot_identity_and_string_path() {
    // These typed expectations were confirmed against actual timer.ts snapshots
    // through the source oracle; no function output or source case is projected.
    let cases = [
        ("null", json!({"type":"null"})),
        ("false", json!({"type":"boolean","value":false})),
        ("0", json!({"type":"number","value":0})),
        ("[]", json!({"type":"array","value":[]})),
        (
            r#"["$x"]"#,
            json!({"type":"array","value":[{"type":"string","value":"$x"}]}),
        ),
        (r#"{"$value":"undefined"}"#, json!({"type":"undefined"})),
        (
            r#"{"toString":null}"#,
            json!({"type":"object","value":[["toString",{"type":"null"}]]}),
        ),
    ];
    for (value, expected) in cases {
        let input = format!(
            "{{\"operation\":\"evaluate\",\"pureBuiltins\":true,\"ast\":{{\"type\":\"literal\",\"value\":\"untouched\"}},\"context\":{{\"argument\":{value},\"userDisplayName\":{value}}}}}"
        );
        let prepared = PreparedCase::new(&input).unwrap();
        let raw = prepared.run(false);
        let context = raw.initial.borrow();
        assert!(
            context.argument_override.is_some(),
            "explicit raw argument {value}"
        );
        assert!(
            context.user_display_name_override.is_some(),
            "explicit raw display {value}"
        );
        assert_eq!(context.effective_argument().to_typed_json(), expected);
        assert_eq!(
            context.effective_user_display_name().to_typed_json(),
            expected
        );
        assert_eq!(
            context.user_display_name, "Caller",
            "typed producer field is retained"
        );
        assert!(context.argument.is_none());
        let snapshot = dima_rust::utils::ast_evaluator::snapshot_timer_context(&raw.initial);
        assert_eq!(snapshot.get("argument").to_typed_json(), expected);
        assert_eq!(snapshot.get("userDisplayName").to_typed_json(), expected);
        if let JsValue::Array(original) = context.effective_argument() {
            let JsValue::Array(copied) = snapshot.get("argument") else {
                panic!("snapshot array")
            };
            assert!(
                Rc::ptr_eq(&original, &copied),
                "snapshot shares raw scalar array identity"
            );
        }
        drop(context);
        let observation = normalize(&raw);
        assert_eq!(
            observation["context"]["scalarDeltas"],
            json!([]),
            "raw source baseline {value}"
        );
        assert_eq!(observation["initialContext"]["scalarDeltas"], json!([]));
        assert!(
            raw.host.events.is_empty(),
            "literal/snapshot does not coerce the raw values"
        );
    }
    let prepared = PreparedCase::new(
        r#"{"operation":"evaluate","pureBuiltins":true,"ast":{"type":"literal","value":"untouched"},"context":{"argument":"$x","userDisplayName":"Display"}}"#,
    ).unwrap();
    let raw = prepared.run(false);
    let context = raw.initial.borrow();
    assert!(context.argument_override.is_none());
    assert!(context.user_display_name_override.is_none());
    assert_eq!(context.argument, Some(JsString::from("$x")));
    assert_eq!(context.user_display_name, "Display");
    assert_eq!(
        context.effective_argument().to_typed_json(),
        json!({"type":"string","value":"$x"})
    );
    assert_eq!(
        context.effective_user_display_name().to_typed_json(),
        json!({"type":"string","value":"Display"})
    );
}
