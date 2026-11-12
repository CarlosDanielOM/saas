//! Time per operation for the corpora's benchmark inputs: compiling a command text (what the
//! bot does for every command it runs), importing it into blocks and saving blocks.
//!
//! Run from a release build; debug timings are not meaningful:
//! `dima-rust/tools/cargo run --release -p dima-engine --example bench [iterations]`.

use dima_engine::blocks::{IdMaker, compile_blocks, import_command_text_with};
use dima_engine::syntax::SyntaxEngine;
use serde_json::Value;
use std::{hint::black_box, time::Instant};

fn load(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let bytes = std::fs::read(&path).unwrap_or_default();
    let clean = dima_text::sanitize_lone_surrogates(&bytes);
    serde_json::from_slice(&clean).unwrap_or(Value::Null)
}

fn time(iterations: u32, mut operation: impl FnMut() -> usize) -> f64 {
    let mut sink = 0usize;
    for _ in 0..iterations.min(50) {
        sink ^= operation();
    }
    let start = Instant::now();
    for _ in 0..iterations {
        sink ^= operation();
    }
    black_box(sink);
    start.elapsed().as_nanos() as f64 / f64::from(iterations)
}

fn main() {
    let iterations: u32 = std::env::args()
        .nth(1)
        .and_then(|arg| arg.parse().ok())
        .unwrap_or(2_000);
    let engine = SyntaxEngine::default();
    println!(
        "{:<28} {:>12} {:>12}",
        "syntax benchmark", "chars", "ns/compile"
    );
    let syntax = load("ast_syntax_cases.json");
    for bench in syntax["benchmarks"].as_array().into_iter().flatten() {
        let source = bench["source"].as_str().unwrap_or_default();
        let ns = time(iterations, || {
            engine
                .compile_template(black_box(source))
                .map_or(0, |plan| plan.segments().len())
        });
        println!(
            "{:<28} {:>12} {:>12.0}",
            bench["name"].as_str().unwrap_or_default(),
            dima_text::char_len(source),
            ns
        );
    }
    println!();
    println!(
        "{:<28} {:>12} {:>12}",
        "blocks benchmark", "ns/import", "ns/save"
    );
    let blocks = load("ast_blocks_cases.json");
    for bench in blocks["benchmarks"].as_array().into_iter().flatten() {
        let input = &bench["input"];
        if input["kind"] != "import" {
            continue;
        }
        let text = input["text"].as_str().unwrap_or_default();
        let import = time(iterations, || {
            import_command_text_with(black_box(text), &mut IdMaker::new("i", "bench"))
                .map_or(0, |imported| imported.root.children.len())
        });
        let root = import_command_text_with(text, &mut IdMaker::new("i", "bench"))
            .map(|imported| imported.root.to_value())
            .unwrap_or_default();
        let save = time(iterations, || {
            compile_blocks(black_box(&root)).map_or(0, |compiled| compiled.text.len())
        });
        println!(
            "{:<28} {:>12.0} {:>12.0}",
            bench["name"].as_str().unwrap_or_default(),
            import,
            save
        );
    }
}
