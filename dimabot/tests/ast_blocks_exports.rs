#![cfg(feature = "ast-blocks")]

use dima_rust::utils::{
    ast_blocks::{
        BlockNode, BlockRoot, ast_to_block, block_shape, escape_chat_text, id_maker,
        id_maker_with_prefix, literal, normalize_root, normalize_value, root_to_source, top_level,
    },
    ast_syntax::AstNode,
};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/ast_blocks_exports_cases.json"))
        .expect("frozen source-backed AST exports corpus")
}

#[test]
fn standalone_exports_match_the_typescript_source() {
    for (index, case) in fixture()["cases"].as_array().unwrap().iter().enumerate() {
        let input = &case["input"];
        let result = match case["op"].as_str().unwrap() {
            "astToBlock" => {
                let ast: AstNode = serde_json::from_value(input.clone()).unwrap();
                let mut sequence = 0;
                let mut next_id = || {
                    sequence += 1;
                    format!("n{sequence}")
                };
                match ast_to_block(&ast, &mut next_id) {
                    Ok(node) => json!({"ok":node}),
                    Err(error) => json!({"error":error.to_string()}),
                }
            }
            "normalizeRoot" => {
                json!({"ok": normalize_root(serde_json::from_value(input.clone()).unwrap())})
            }
            "normalizeValue" => {
                json!({"ok": normalize_value(serde_json::from_value(input.clone()).unwrap())})
            }
            "blockShape" => {
                let shape = if input["type"] == "root" {
                    block_shape(&serde_json::from_value::<BlockRoot>(input.clone()).unwrap())
                } else {
                    block_shape(&serde_json::from_value::<BlockNode>(input.clone()).unwrap())
                };
                json!({"ok":shape.unwrap()})
            }
            "rootToSource" => match root_to_source(&serde_json::from_value(input.clone()).unwrap())
            {
                Ok(text) => json!({"ok":text}),
                Err(error) => json!({"error":error.message}),
            },
            "topLevel" => match top_level(&serde_json::from_value(input.clone()).unwrap()) {
                Ok(text) => json!({"ok":text}),
                Err(error) => json!({"error":error.message}),
            },
            "escapeChatText" => json!({"ok":escape_chat_text(input.as_str().unwrap())}),
            "literal" => json!({"ok":literal(input.as_str().unwrap())}),
            other => panic!("unhandled oracle operation {other}"),
        };
        assert_eq!(result, case["expected"], "case {index}: {}", case["op"]);
    }
}

#[test]
fn factories_have_private_sequence_and_preserve_the_prefix() {
    for prefix in ["", "b", "custom-", "文"] {
        let mut factory = id_maker_with_prefix(prefix);
        let first = factory();
        let stem = &first[..first.len() - 1];
        assert!(stem.starts_with(prefix));
        assert_eq!(stem[prefix.len()..].len(), 4);
        assert!(
            stem[prefix.len()..]
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        );
        for (sequence, suffix) in [(2, "2"), (10, "a"), (35, "z"), (36, "10")] {
            let mut last = String::new();
            let start = match sequence {
                2 => 2,
                10 => 3,
                35 => 11,
                _ => 36,
            };
            for _ in start..=sequence {
                last = factory();
            }
            assert_eq!(last, format!("{stem}{suffix}"));
        }
        let mut another = id_maker_with_prefix(prefix);
        assert!(another().ends_with('1'));
    }
    assert!(id_maker()().starts_with('b'));
}

#[test]
fn incomplete_typed_loop_returns_an_error_without_panicking() {
    let incomplete: BlockNode = serde_json::from_value(json!({
        "id":"loop", "type":"forLoop", "loopVar":"i", "mode":"foreach", "body":[]
    }))
    .unwrap();
    let error = top_level(&incomplete).unwrap_err();
    assert_eq!(error.block_id.as_deref(), Some("loop"));
    assert_eq!(error.path, "/iterable");
}

#[test]
fn canonical_shape_excludes_ids_without_mutating_the_original() {
    let original: BlockRoot=serde_json::from_value(json!({"id":"root","type":"root","children":[
        {"id":"parent","type":"getVar","name":"x","storage":"cacheUser", "accessor":{"type":"index","index":{"id":"nested","type":"literal","value":"0"}}}
    ]})).unwrap();
    let before = original.to_value();
    let text = block_shape(&original).unwrap();
    assert!(!text.contains("\"id\""));
    assert_eq!(original.to_value(), before);
}

/// Same pre-parsed ASTs/trees, operations, warmup, iterations and seven samples
/// as ast_blocks_exports_reference.mjs --benchmark. Run only in an isolated,
/// resource-capped RELEASE test container. No services or production data.
#[test]
#[ignore = "explicit isolated release comparison only"]
fn benchmark_ast_block_exports() {
    use std::{hint::black_box, time::Instant};
    let data = fixture();
    let mut runs = Vec::new();
    for workload in data["benchmarkInputs"].as_array().unwrap() {
        let ast: AstNode = serde_json::from_value(workload["ast"].clone()).unwrap();
        let root: BlockRoot = serde_json::from_value(workload["root"].clone()).unwrap();
        let iterations = workload["iterations"].as_u64().unwrap() as usize;
        for operation in ["astToBlock", "blockShape", "rootToSource"] {
            let run = || -> usize {
                match operation {
                    "astToBlock" => {
                        let mut sequence = 0;
                        let mut next = || {
                            sequence += 1;
                            format!("n{sequence}")
                        };
                        let block = black_box(ast_to_block(black_box(&ast), &mut next).unwrap());
                        match block.kind {
                            dima_rust::utils::ast_blocks::BlockKind::Function { args, .. } => {
                                args.len()
                            }
                            _ => unreachable!(),
                        }
                    }
                    "blockShape" => black_box(block_shape(black_box(&root)).unwrap()).len(),
                    "rootToSource" => black_box(root_to_source(black_box(&root)).unwrap()).len(),
                    _ => unreachable!(),
                }
            };
            for _ in 0..100 {
                black_box(run());
            }
            let mut samples = Vec::new();
            let mut sink = 0;
            for _ in 0..7 {
                let start = Instant::now();
                for _ in 0..iterations {
                    sink += black_box(run());
                }
                samples.push(start.elapsed().as_nanos() as f64 / iterations as f64);
            }
            let mut sorted = samples.clone();
            sorted.sort_by(f64::total_cmp);
            runs.push(json!({"workload":workload["name"],"operation":operation,"iterations":iterations,"samplesNsPerOp":samples,"medianNsPerOp":sorted[3],"sink":sink}));
        }
    }
    let report =
        json!({"implementation":"rust-native-exports","profile":"release","samples":7,"runs":runs});
    if let Ok(path) = std::env::var("AST_EXPORTS_BENCHMARK_OUTPUT") {
        std::fs::write(path, serde_json::to_string_pretty(&report).unwrap() + "\n").unwrap();
    }
    println!("AST_EXPORTS_BENCHMARK={report}");
}
