// Run only in the lead's capped isolated compiler/runtime. See the benchmark
// fixture emitter for identical, source-guarded TypeScript requests.
#[cfg(not(feature = "ast-blocks"))]
fn main() {
    eprintln!("Enable --no-default-features --features ast-blocks for this example");
}

#[cfg(feature = "ast-blocks")]
fn main() {
    if let Err(error) = bench::run() {
        eprintln!("ast_blocks_bench: {error}");
        std::process::exit(1);
    }
}

#[cfg(feature = "ast-blocks")]
mod bench {
    use dima_rust::utils::ast_blocks::{BlocksEngine, BlocksError, CompiledBlocks, ImportedText};
    use serde::Deserialize;
    use serde_json::{Value, json};
    use std::{
        error::Error,
        hint::black_box,
        io::Read,
        time::{Duration, Instant},
    };

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Requests {
        version: u32,
        iterations: usize,
        batches: usize,
        warmup: usize,
        profile: String,
        sources: Value,
        corpus_hash: String,
        manifest_corpus_hash: String,
        typescript_version: String,
        fixtures: Vec<Fixture>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Fixture {
        name: String,
        operation: String,
        input: Value,
        expected: Option<Value>,
        expected_checksum: Option<String>,
        excluded_reason: Option<String>,
    }
    enum Output {
        Import(Result<ImportedText, BlocksError>),
        Compile(Result<CompiledBlocks, BlocksError>),
    }
    fn operation(engine: &BlocksEngine, fixture: &Fixture) -> Output {
        if fixture.operation == "import" {
            Output::Import(
                engine.import_command_text(fixture.input.as_str().expect("validated source")),
            )
        } else {
            // Intentionally public borrowed API: its validation clone stays timed.
            Output::Compile(engine.compile_blocks(&fixture.input))
        }
    }
    fn consume(output: &Output) -> usize {
        match output {
            Output::Import(Ok(value)) => value.root.children.len() + value.advanced_count,
            Output::Compile(Ok(value)) => value.root.children.len() + value.text.len(),
            Output::Import(Err(error)) | Output::Compile(Err(error)) => error.message.len(),
        }
    }
    fn without_ids(value: &mut Value) {
        match value {
            Value::Object(object) => {
                object.remove("id");
                for child in object.values_mut() {
                    without_ids(child);
                }
            }
            Value::Array(items) => {
                for item in items {
                    without_ids(item);
                }
            }
            _ => {}
        }
    }
    // Shape conversion, output text verification and fingerprints are NEVER timed.
    fn semantics(output: Output) -> Result<Value, Box<dyn Error>> {
        Ok(match output {
            Output::Import(Ok(value)) => {
                if !value.diagnostics.is_empty() {
                    return Err(format!(
                        "Paired import unexpectedly has diagnostics: {:?}",
                        value.diagnostics
                    )
                    .into());
                }
                let mut root = value.root.to_value();
                without_ids(&mut root);
                json!({"outcome":"imported", "root":root, "advancedCount":value.advanced_count})
            }
            Output::Compile(Ok(value)) => {
                let mut root = value.root.to_value();
                without_ids(&mut root);
                json!({"outcome":"compiled", "root":root, "text":value.text})
            }
            Output::Import(Err(error)) | Output::Compile(Err(error)) => {
                json!({"outcome":"error", "message":error.message})
            }
        })
    }
    fn checksum(value: &Value) -> String {
        fn feed(hash: &mut u32, text: &str) {
            for byte in text.as_bytes() {
                *hash = (*hash ^ u32::from(*byte)).wrapping_mul(16_777_619);
            }
        }
        fn walk(hash: &mut u32, value: &Value) {
            match value {
                Value::Array(items) => {
                    feed(hash, "[");
                    for item in items {
                        walk(hash, item);
                    }
                    feed(hash, "]");
                }
                Value::Object(object) => {
                    feed(hash, "{");
                    let mut keys: Vec<_> = object.keys().collect();
                    keys.sort();
                    for key in keys {
                        feed(hash, key);
                        feed(hash, ":");
                        walk(hash, &object[key]);
                    }
                    feed(hash, "}");
                }
                _ => {
                    feed(hash, &value.to_string());
                    feed(hash, ";");
                }
            }
        }
        let mut hash = 2_166_136_261;
        walk(&mut hash, value);
        format!("{hash:08x}")
    }
    fn measure(
        engine: &BlocksEngine,
        fixture: &Fixture,
        requests: &Requests,
        started: Instant,
        sink: &mut usize,
    ) -> Result<Vec<u128>, Box<dyn Error>> {
        for _ in 0..requests.warmup {
            let output = black_box(operation(black_box(engine), black_box(fixture)));
            *sink ^= black_box(consume(&output));
            drop(output);
            if started.elapsed() > Duration::from_secs(120) {
                return Err("Total exceeds 120s".into());
            }
        }
        let mut durations = Vec::with_capacity(requests.batches);
        for _ in 0..requests.batches {
            let begin = Instant::now();
            for i in 0..requests.iterations {
                let output = black_box(operation(black_box(engine), black_box(fixture)));
                *sink ^= black_box(consume(&output));
                drop(output);
                if i & 15 == 0 && begin.elapsed() > Duration::from_secs(5) {
                    return Err("Batch exceeds 5s".into());
                }
            }
            let elapsed = begin.elapsed();
            if elapsed > Duration::from_secs(5) {
                return Err("Batch exceeds 5s".into());
            }
            durations.push(elapsed.as_nanos());
            if started.elapsed() > Duration::from_secs(120) {
                return Err("Total exceeds 120s".into());
            }
        }
        Ok(durations)
    }
    pub fn run() -> Result<(), Box<dyn Error>> {
        let mut args = std::env::args().skip(1);
        let mut path = None;
        let mut runtime_version = "unreported; record rustc --version with result".to_owned();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--requests" => path = Some(args.next().ok_or("Missing requests path")?),
                "--runtime-version" => {
                    runtime_version = args.next().ok_or("Missing runtime version")?
                }
                _ => return Err(format!("Unknown argument {arg}").into()),
            }
        }
        let reader: Box<dyn Read> = match path {
            Some(path) => Box::new(std::fs::File::open(path)?),
            None => Box::new(std::io::stdin()),
        };
        let mut input = String::new();
        reader.take(2_000_001).read_to_string(&mut input)?;
        if input.len() > 2_000_000 {
            return Err("Requests exceed 2MB".into());
        }
        let request_value: Value = serde_json::from_str(&input)?;
        let request_checksum = checksum(&request_value);
        let requests: Requests = serde_json::from_value(request_value)?;
        if requests.version != 1
            || requests.profile != "typescript_compatible"
            || !(1..=500).contains(&requests.iterations)
            || !(1..=10).contains(&requests.batches)
            || requests.warmup > 100
            || requests.fixtures.is_empty()
            || requests.fixtures.len() > 64
        {
            return Err("Unsupported version/profile or benchmark bounds".into());
        }
        let engine = BlocksEngine::default();
        let started = Instant::now();
        let mut measurements = Vec::new();
        let mut sink = 0;
        for fixture in &requests.fixtures {
            if !matches!(fixture.operation.as_str(), "import" | "compile") {
                return Err("Unknown operation".into());
            }
            if let Some(reason) = &fixture.excluded_reason {
                measurements.push(json!({"fixture":fixture.name,"operation":fixture.operation,"excluded_reason":reason}));
                continue;
            }
            if fixture.operation == "import" && !fixture.input.is_string() {
                return Err("Import input must be text".into());
            }
            let actual = semantics(operation(&engine, fixture))?;
            let actual_checksum = checksum(&actual);
            if fixture.expected.as_ref() != Some(&actual)
                || fixture.expected_checksum.as_deref() != Some(actual_checksum.as_str())
            {
                return Err(format!("Semantic mismatch {}:{}; checksum {actual_checksum}; expected {:?}; actual {actual}", fixture.name, fixture.operation, fixture.expected).into());
            }
            let durations = measure(&engine, fixture, &requests, started, &mut sink)?;
            if semantics(operation(&engine, fixture))? != actual {
                return Err("Post-measurement semantics changed".into());
            }
            let per_op: Vec<_> = durations
                .iter()
                .map(|n| *n as f64 / requests.iterations as f64)
                .collect();
            measurements.push(json!({"fixture":fixture.name,"operation":fixture.operation,
                "iterations":requests.iterations,"batches":requests.batches,"durations_ns":durations,
                "ns_per_op":per_op,"checksum":actual_checksum}));
        }
        println!(
            "{}",
            json!({"version":1,"runtime":runtime_version,
            "build_profile":if cfg!(debug_assertions) {"debug"} else {"release"},
            "profile":requests.profile,"typescript_version":requests.typescript_version,
            "sources":requests.sources,"corpus_hash":requests.corpus_hash,"manifest_corpus_hash":requests.manifest_corpus_hash,"requests_checksum":request_checksum,
            "iterations":requests.iterations,"batches":requests.batches,"warmup":requests.warmup,
            "method":"separate full public import / borrowed compile operations; no evaluation",
            "sink":black_box(sink),"measurements":measurements})
        );
        Ok(())
    }
}
