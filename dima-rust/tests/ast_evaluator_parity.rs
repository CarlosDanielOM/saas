#![cfg(feature = "ast-evaluator")]

// Expected behavior is authored by the actual TypeScript source oracle. This
// test never regenerates expectations from Rust and never uses a live service.
#[allow(dead_code)]
#[path = "../examples/ast_evaluator_bench.rs"]
mod harness;

use harness::support::{fingerprint, sha256_hex};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeSet, path::Path};

fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/ast_evaluator_cases.json"))
        .expect("source corpus must fit the default Serde recursion guard")
}

// Preserve JSON object's source insertion order when reproducing JSON.stringify
// for manifest SHA256. Serde Value's sorted-map representation is unsuitable.
fn compact_json(raw: &str) -> String {
    let mut output = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for character in raw.chars() {
        if quoted {
            output.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                quoted = false;
            }
        } else if character == '"' {
            quoted = true;
            output.push(character);
        } else if !character.is_ascii_whitespace() {
            output.push(character);
        }
    }
    assert!(!quoted && !escaped, "invalid raw JSON string");
    output
}

#[test]
fn hash_encodings_are_explicit_and_independent() {
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_ne!(sha256_hex(b"abc"), sha256_hex(b"616263"));
    assert_eq!(
        fingerprint(&json!({"b":[1,true],"a":"é"})),
        fingerprint(&json!({"a":"é","b":[1,true]}))
    );
    assert_ne!(fingerprint(&json!([1, 2])), fingerprint(&json!([2, 1])));
    assert_eq!(
        compact_json(" { \"z\": \" a \\\" b \" , \"a\": 1 } "),
        r#"{"z":" a \" b ","a":1}"#
    );
}

#[test]
fn source_hashes_manifest_and_artifact_provenance() {
    #[derive(Deserialize)]
    struct RawManifest<'a> {
        #[serde(borrow)]
        cases: &'a serde_json::value::RawValue,
        #[serde(borrow)]
        benchmarks: &'a serde_json::value::RawValue,
    }
    let bytes = include_bytes!("fixtures/ast_evaluator_cases.json");
    let raw: RawManifest<'_> = serde_json::from_slice(bytes).unwrap();
    let manifest = format!(
        "{{\"cases\":{},\"benchmarks\":{}}}",
        compact_json(raw.cases.get()),
        compact_json(raw.benchmarks.get())
    );
    let fixture = corpus();
    assert_eq!(fixture["schemaVersion"], 1);
    assert_eq!(fixture["profile"], "source-parity");
    assert_eq!(
        fixture["manifestHash"],
        sha256_hex(manifest.as_bytes()),
        "manifest hashes compact insertion-ordered cases/benchmarks, not pretty corpus bytes"
    );
    let artifact = sha256_hex(bytes);
    assert_ne!(artifact, fixture["manifestHash"].as_str().unwrap());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let sources = fixture["sourceHashes"]
        .as_object()
        .expect("path to lowercase hex SHA256 map");
    assert!(!sources.is_empty());
    for (path, expected) in sources {
        assert!(
            !path.starts_with('/') && !path.split('/').any(|part| part == ".."),
            "source path must remain under repository root"
        );
        let expected = expected.as_str().expect("hex SHA256 source digest");
        assert_eq!(expected.len(), 64);
        assert!(
            expected
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
        let source =
            std::fs::read(root.join(path)).unwrap_or_else(|error| panic!("source {path}: {error}"));
        assert_eq!(
            sha256_hex(&source),
            expected,
            "source drift: {path}; regenerate only with source oracle"
        );
    }
    eprintln!(
        "oracle artifact_sha256_hex={artifact} manifest_sha256_hex={}",
        fixture["manifestHash"]
    );
}

#[test]
fn case_manifest_has_unique_ids_and_no_semantic_exemptions() {
    let fixture = corpus();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    let mut ids = BTreeSet::new();
    let mut categories = std::collections::BTreeMap::<&str, usize>::new();
    let mut boundaries = Vec::new();
    for case in cases {
        assert!(
            ids.insert(case["id"].as_str().expect("case id")),
            "duplicate case"
        );
        *categories
            .entry(case["category"].as_str().expect("source category"))
            .or_default() += 1;
        if case.get("domain").is_some() {
            boundaries.push(
                json!({"id":case["id"],"domain":case["domain"],"limitation":case["limitation"]}),
            );
        }
        assert!(case["input"].is_object());
        assert!(case["source"].is_object());
        assert!(
            case.get("expectedRust").is_none(),
            "Rust-specific expectations cannot replace source semantics"
        );
        assert!(
            case.get("skip").is_none(),
            "complete corpus runs without silent case skipping"
        );
    }
    assert!(!categories.is_empty());
    assert_eq!(fixture["coverage"]["caseCount"], cases.len());
    for (category, count) in categories {
        assert_eq!(fixture["coverage"]["categoryCounts"][category], count);
    }
    assert_eq!(
        fixture["coverage"]["sourceOnlyBoundaries"],
        Value::Array(boundaries)
    );
    assert_eq!(
        fixture["coverage"]["benchmarkCount"],
        fixture["benchmarks"].as_array().unwrap().len()
    );
    let declared: BTreeSet<_> = fixture["coverage"]["declaredAstTags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert_eq!(
        declared,
        [
            "root",
            "setVar",
            "getVar",
            "deleteVar",
            "function",
            "literal",
            "custom",
            "exists",
            "binary",
            "unary",
            "ternary",
            "template",
            "arrayLiteral",
            "commandRef",
            "loopVar",
            "loopAssign",
            "forLoop"
        ]
        .into_iter()
        .collect()
    );
}

#[test]
fn complete_source_corpus_exact_typed_effects_context_and_ordered_host_trace() {
    #[derive(Deserialize)]
    struct CorpusInputs {
        cases: Vec<Case>,
    }
    #[derive(Deserialize)]
    struct Case {
        id: String,
        input: Box<serde_json::value::RawValue>,
        source: Value,
        domain: Option<String>,
        limitation: Option<String>,
    }
    let fixture: CorpusInputs =
        serde_json::from_str(include_str!("fixtures/ast_evaluator_cases.json")).unwrap();
    let mut errors = Vec::new();
    let mut evaluated = 0;
    let mut boundaries = Vec::new();
    for case in &fixture.cases {
        if let Some(domain) = &case.domain {
            assert!(
                case.limitation
                    .as_ref()
                    .is_some_and(|reason| !reason.is_empty())
            );
            assert!(
                matches!(
                    domain.as_str(),
                    "source-only-function-boundary" | "source-only-invalid-ast-boundary"
                ),
                "unknown boundary exclusion {domain}"
            );
            assert!(
                harness::adapter::PreparedCase::new(case.input.get()).is_err(),
                "source-only boundary unexpectedly accepted; review coverage: {}",
                case.id
            );
            boundaries.push(json!({"id":case.id,"domain":domain,"limitation":case.limitation}));
            continue;
        }
        let mut expected = case.source.clone();
        harness::adapter::project(&mut expected);
        match harness::adapter::PreparedCase::new(case.input.get()) {
            Ok(prepared) => {
                evaluated += 1;
                let actual = harness::adapter::normalize(&prepared.run(false));
                if actual != expected {
                    errors.push(format!(
                        "{} input={}\nexpected={expected}\nactual={actual}",
                        case.id,
                        case.input.get()
                    ));
                }
            }
            Err(error) => errors.push(format!(
                "{} cannot prepare source case: {error}; input={}",
                case.id,
                case.input.get()
            )),
        }
    }
    eprintln!(
        "evaluated={evaluated} source-only-boundaries={}",
        Value::Array(boundaries)
    );
    for error in errors.iter().take(30) {
        eprintln!("{}", error.chars().take(12000).collect::<String>());
    }
    assert_eq!(
        errors.len(),
        0,
        "{} source parity mismatches; first 30 shown",
        errors.len()
    );
    assert!(evaluated > 0);
}

#[test]
fn public_api_smoke_immutable_plan_reuse_and_fresh_contexts() {
    use dima_rust::utils::ast_evaluator::{Engine, ExecutionContext, JsValue};
    use harness::{adapter::PreparedCase, support::block_on};
    let fixture = PreparedCase::new(
        r#"{"operation":"evaluate","ast":{"type":"literal","value":"host-independent"}}"#,
    )
    .unwrap();
    let engine = Engine::default();
    let program = engine.compile_program("plain").unwrap();
    let plan = engine.compile_template("prefix *(1 + 2) suffix").unwrap();
    let clone = plan.clone();
    for count in [0.0, 17.0] {
        let context = ExecutionContext {
            count,
            ..ExecutionContext::default()
        };
        let context = context.into_context();
        let mut host = fixture.run(false).host;
        let result =
            block_on(engine.evaluate_program(&program, context.clone(), &mut host)).unwrap();
        assert_eq!(
            result.value.to_typed_json(),
            JsValue::string("plain").to_typed_json()
        );
        let rendered = block_on(engine.render(&clone, context, &mut host)).unwrap();
        assert_eq!(rendered.text.to_utf8().unwrap(), "prefix 3 suffix");
        assert_eq!(rendered.context.borrow().count, count);
        assert!(host.events.is_empty());
        assert_eq!(rendered.stats.node_futures, 0);
        assert_eq!(rendered.stats.host_futures, 0);
    }
    let mut first = fixture.run(false);
    let second = fixture.run(false);
    first.initial.borrow_mut().count = 99.0;
    assert_eq!(second.initial.borrow().count, 0.0);
    assert_eq!(fixture.run(false).initial.borrow().count, 0.0);
    assert_eq!(
        first.result.as_mut().unwrap().value.to_typed_json(),
        JsValue::string("host-independent").to_typed_json()
    );
}

#[test]
fn deterministic_suspending_fakehost_preserves_source_order_and_effects() {
    let input = r#"{"operation":"evaluate","ast":{"type":"function","name":"fixture.echo","args":[{"type":"function","name":"fixture.count","args":[]},{"type":"function","name":"fixture.count","args":[]}]}}"#;
    let prepared = harness::adapter::PreparedCase::new(input).unwrap();
    let immediate = prepared.run(false);
    let suspending = prepared.run(true);
    assert_eq!(
        harness::adapter::normalize(&immediate),
        harness::adapter::normalize(&suspending)
    );
    let result = suspending.result.unwrap();
    assert_eq!(
        result.value.to_typed_json(),
        json!({"type":"string","value":"1|2"})
    );
    assert_eq!(result.stats.host_calls, 3);
    assert_eq!(result.stats.host_futures, 3);
    assert_eq!(result.stats.node_futures, 0);
}

#[test]
fn loop_frames_and_decoded_array_memo_have_independent_observable_counters() {
    #[derive(Deserialize)]
    struct Benchmarks {
        benchmarks: Vec<Benchmark>,
    }
    #[derive(Deserialize)]
    struct Benchmark {
        id: String,
        input: Box<serde_json::value::RawValue>,
    }
    let corpus: Benchmarks =
        serde_json::from_str(include_str!("fixtures/ast_evaluator_cases.json")).unwrap();
    let find = |id: &str| {
        let definition = corpus
            .benchmarks
            .iter()
            .find(|case| case.id == id)
            .expect("source benchmark workload");
        harness::adapter::PreparedCase::new(definition.input.get()).unwrap()
    };
    let loop_plan = find("loop-seeded100-manybody");
    let raw = loop_plan.run(false);
    let result = raw.result.as_ref().unwrap();
    assert_eq!(result.stats.loop_iterations, 5);
    assert!(result.stats.loop_frames > 0);
    let original = corpus
        .benchmarks
        .iter()
        .find(|case| case.id == "loop-seeded100-manybody")
        .unwrap();
    let mut tick_only: Value = serde_json::from_str(original.input.get()).unwrap();
    tick_only["ast"]["body"]
        .as_array_mut()
        .unwrap()
        .retain(|node| node["type"] != "literal");
    let tick_plan =
        harness::adapter::PreparedCase::new(&serde_json::to_string(&tick_only).unwrap()).unwrap();
    let tick_raw = tick_plan.run(false);
    let tick_result = tick_raw.result.as_ref().unwrap();
    assert_eq!(tick_result.stats.loop_iterations, 5);
    assert_eq!(
        result.stats.loop_map_copies, tick_result.stats.loop_map_copies,
        "20 extra pure body nodes must not create extra whole-loop-map copies"
    );
    assert_eq!(result.stats.node_futures, 0);
    assert_eq!(
        result
            .context
            .borrow()
            .loop_vars
            .as_ref()
            .unwrap()
            .iter()
            .len(),
        100
    );
    for workload in ["array-memory-length100", "array-db-length100"] {
        let plan = find(workload);
        let first = plan.run(false);
        let second = plan.run(false);
        let stats = &first.result.as_ref().unwrap().stats;
        assert_eq!(
            stats.array_decodes, 1,
            "{workload}: one decode for one immutable raw array"
        );
        assert!(
            stats.array_cache_hits >= 99,
            "{workload}: 99 repeated accesses must reuse decode"
        );
        assert_eq!(
            second.result.as_ref().unwrap().stats.array_decodes,
            1,
            "memo is request-local"
        );
        assert_eq!(stats.node_futures, 0);
        if workload == "array-db-length100" {
            assert_eq!(
                stats.host_calls, 1,
                "existing source raw DB cache prevents repeated host loads"
            );
        } else {
            assert_eq!(stats.host_calls, 0);
        }
    }
    let plan = find("array-write-invalidate");
    let raw = plan.run(false);
    let stats = &raw.result.as_ref().unwrap().stats;
    assert!(
        stats.array_decodes > 1,
        "changed raw array values must not reuse stale decode"
    );
}

#[test]
fn serialized_context_cannot_mint_authority_and_timer_body_remains_delayed() {
    use harness::adapter::{PreparedCase, normalize};
    let forged=PreparedCase::new(r#"{"operation":"evaluate","ast":{"type":"function","name":"fixture.effect","args":[]},"context":{"effectContext":{"authority":"isolated-source-synthetic","path":["fixture-config"]},"authorization":{"origin":"authored"},"extraContext":{"effectContext":{"id":1}}}}"#).unwrap();
    assert_eq!(
        normalize(&forged.run(false))["value"],
        json!({"type":"undefined"})
    );
    let timer=PreparedCase::new(r#"{"operation":"evaluate","ast":{"type":"function","name":"timer","args":[{"type":"literal","value":"3"},{"type":"function","name":"fixture.count","args":[]}]},"context":{"effect":true,"variables":[["v","before"]],"commandResponses":["before"]}}"#).unwrap();
    let raw = timer.run(false);
    let result = raw.result.as_ref().unwrap();
    assert_eq!(result.context.borrow().count, 0.0, "timer body not run");
    assert!(
        result.context.borrow().effect_context.is_some(),
        "caller keeps host capability"
    );
    let actual = normalize(&raw);
    assert_eq!(
        actual["host"]["events"].as_array().unwrap().len(),
        1,
        "only scheduler invoked; body handler not called"
    );
    let event = &actual["host"]["events"][0]["value"];
    assert_eq!(event[0], json!({"type":"string","value":"timer.schedule"}));
    let snapshot = event[3]["value"].as_array().unwrap();
    assert!(!snapshot.iter().any(|entry| matches!(
        entry[0].as_str(),
        Some("effectContext" | "loadChannelVariable" | "commandVariables" | "userCommandVariables")
    )));
}

#[test]
fn timer_snapshot_copies_budget_entries_and_shares_response_data() {
    use dima_rust::utils::ast_evaluator::{ExecutionContext, JsValue, snapshot_timer_context};
    let context = ExecutionContext::default().into_context();
    context
        .borrow()
        .variables
        .borrow_mut()
        .insert("v".into(), JsValue::string("before"));
    context
        .borrow()
        .command_responses
        .borrow_mut()
        .push(JsValue::string("before"));
    let snapshot = snapshot_timer_context(&context);
    context.borrow().command_ref_budget.borrow_mut().remaining = 3.0;
    context
        .borrow()
        .variables
        .borrow_mut()
        .insert("v".into(), JsValue::string("after"));
    context
        .borrow()
        .command_responses
        .borrow_mut()
        .push(JsValue::string("after"));
    let mut value = snapshot.to_typed_json();
    harness::adapter::canonical_numbers(&mut value);
    let field = |key: &str| {
        value["value"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry[0] == key)
            .unwrap()[1]
            .clone()
    };
    assert_eq!(
        field("commandRefBudget"),
        json!({"type":"object","value":[["remaining",{"type":"number","value":50}]]})
    );
    assert_eq!(
        field("variables"),
        json!({"type":"array","value":[{"type":"array","value":[{"type":"string","value":"v"},{"type":"string","value":"before"}]}]})
    );
    assert_eq!(
        field("commandResponses"),
        json!({"type":"array","value":[{"type":"string","value":"before"},{"type":"string","value":"after"}]})
    );
}

#[test]
fn permission_gate_follows_argument_effects_and_reference_budget_is_shared() {
    use harness::adapter::{PreparedCase, normalize};
    let denied=PreparedCase::new(r#"{"operation":"evaluate","ast":{"type":"function","name":"fixture.gated7","args":[{"type":"setVar","name":"written","storage":"memory","value":{"type":"literal","value":"yes"}}]},"context":{"userLevel":1}}"#).unwrap().run(false);
    let actual = normalize(&denied);
    assert_eq!(
        actual["context"]["maps"]["variables"],
        json!([["written",{"type":"string","value":"yes"}]])
    );
    assert!(
        actual["value"]["value"]
            .as_str()
            .unwrap()
            .starts_with("Error: permission denied")
    );
    assert!(
        denied.host.events.is_empty(),
        "denied handler never runs after argument effects"
    );
    let refs=PreparedCase::new(r#"{"operation":"evaluate","ast":{"type":"root","children":[{"type":"commandRef","commandName":"same","args":[]},{"type":"commandRef","commandName":"same","args":[]}]},"context":{"commandRefBudget":{"remaining":2}}}"#).unwrap().run(false);
    let result = refs.result.as_ref().unwrap();
    let context = result.context.borrow();
    let queue = context.command_references.borrow();
    assert_eq!(queue.len(), 2, "siblings can enqueue the same command");
    assert_eq!(context.command_ref_budget.borrow().remaining, 0.0);
    for reference in queue.iter() {
        assert!(std::rc::Rc::ptr_eq(
            &reference.state.command_ref_budget,
            &context.command_ref_budget
        ));
        assert_eq!(reference.state.visited_commands, vec!["123:same"]);
    }
    assert!(
        context
            .visited_commands
            .as_ref()
            .is_none_or(|values| values.borrow().is_empty()),
        "queued visited set must not mutate live siblings"
    );
    assert!(
        refs.host.events.is_empty(),
        "references enqueue data without host dispatch"
    );
    let exhausted=PreparedCase::new(r#"{"operation":"evaluate","ast":{"type":"commandRef","commandName":"guarded","args":[{"type":"setVar","name":"must-not-run","storage":"memory","value":{"type":"literal","value":"bad"}}]},"context":{"commandRefBudget":{"remaining":0}}}"#).unwrap().run(false);
    assert!(
        exhausted.initial.borrow().variables.borrow().is_empty(),
        "initial ref guard precedes arguments"
    );
}

#[test]
fn explicitly_enabled_context_builtins_run_without_fake_host_dispatch() {
    let prepared=harness::adapter::PreparedCase::new(r#"{"operation":"evaluate","contextBuiltins":true,"ast":{"type":"function","name":"count","args":[{"type":"literal","value":"+3"}]},"context":{"count":10}}"#).unwrap();
    let raw = prepared.run(false);
    let result = raw.result.as_ref().unwrap();
    assert_eq!(
        result.value.to_typed_json(),
        json!({"type":"string","value":"13"})
    );
    assert_eq!(result.context.borrow().count, 13.0);
    assert_eq!(result.context.borrow().count_modified, Some(true));
    assert!(raw.host.events.is_empty());
    assert_eq!(result.stats.host_calls, 0);
    assert_eq!(result.stats.host_futures, 0);
    assert_eq!(result.stats.node_futures, 0);
}

#[test]
fn db_user_unpaired_selector_reaches_host_without_utf8_conversion() {
    use harness::adapter::{PreparedCase, normalize};
    let prepared = PreparedCase::new(
        r#"{"operation":"evaluate","ast":{"type":"getVar","name":"x","storage":"dbUser","userSelector":{"type":"function","name":"fixture.value","args":[]}},"host":{"returnValue":{"$utf16":[55296]}}}"#,
    )
    .unwrap();
    let actual = normalize(&prepared.run(false));
    assert_eq!(
        json!({
            "outcome": actual["outcome"],
            "value": actual["value"],
            "events": actual["host"]["events"]
        }),
        json!({
            "outcome": "returned",
            "value": {"type":"string","value":""},
            "events": [
                {"type":"array","value":[
                    {"type":"string","value":"handler"},
                    {"type":"string","value":"fixture.value"},
                    {"type":"array","value":[]}
                ]},
                {"type":"array","value":[
                    {"type":"string","value":"dbUser.load"},
                    {"type":"string","value":"x"},
                    {"type":"string","utf16":[55296]}
                ]}
            ]
        }),
        "source passes the selector's UTF16 units to the host and returns the empty missing value"
    );
}

#[test]
fn command_reference_event_data_spreads_arrays_and_utf16_string_indices() {
    use harness::adapter::PreparedCase;
    for (event_data, indexed_entries) in [
        (
            json!(["a", "b"]),
            json!([
                ["0", {"type":"string","value":"a"}],
                ["1", {"type":"string","value":"b"}]
            ]),
        ),
        (
            json!("ab"),
            json!([
                ["0", {"type":"string","value":"a"}],
                ["1", {"type":"string","value":"b"}]
            ]),
        ),
        (
            json!("😀"),
            json!([
                ["0", {"type":"string","utf16":[55357]}],
                ["1", {"type":"string","utf16":[56832]}]
            ]),
        ),
    ] {
        let input = json!({
            "operation":"evaluate",
            "ast":{"type":"commandRef","commandName":"next","args":[]},
            "context":{"eventData":event_data}
        });
        let prepared = PreparedCase::new(&input.to_string()).unwrap();
        let raw = prepared.run(false);
        let result = raw
            .result
            .as_ref()
            .expect("reference enqueues successfully");
        let context = result.context.borrow();
        let references = context.command_references.borrow();
        assert_eq!(references.len(), 1);
        let mut expected_entries = indexed_entries.as_array().unwrap().clone();
        expected_entries.extend([
            json!(["chatter_user_id", {"type":"string","value":"456"}]),
            json!(["chatter_user_login", {"type":"string","value":"caller"}]),
            json!(["chatter_user_name", {"type":"string","value":"Caller"}]),
        ]);
        assert_eq!(
            references[0].event_data.to_typed_json(),
            json!({"type":"object","value":expected_entries}),
            "JS object spread retains indexed source properties before chatter fields: {event_data}"
        );
    }
}
