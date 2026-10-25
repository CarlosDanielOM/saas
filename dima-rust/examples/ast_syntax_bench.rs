// Opt-in syntax-only microbenchmark. All compilation/execution belongs in the
// lead's single capped compiler container, including this example.
#[cfg(not(feature = "ast-syntax"))]
fn main() {
    eprintln!("Enable --no-default-features --features ast-syntax for this example");
}

#[cfg(feature = "ast-syntax")]
fn main() {
    if let Err(error) = bench::run() {
        eprintln!("ast_syntax_bench: {error}");
        std::process::exit(1);
    }
}

#[cfg(feature = "ast-syntax")]
mod bench {
    use dima_rust::utils::ast_syntax::{Limits, SyntaxEngine};
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
        #[serde(default = "default_iterations")]
        iterations: usize,
        #[serde(default = "default_batches")]
        batches: usize,
        #[serde(default = "default_warmup")]
        warmup: usize,
        #[serde(default)]
        plan_reuse: bool,
        sources: Vec<Value>,
        fixtures: Vec<Fixture>,
    }
    fn default_iterations() -> usize {
        100
    }
    fn default_batches() -> usize {
        5
    }
    fn default_warmup() -> usize {
        10
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Fixture {
        name: String,
        mode: String,
        source: String,
        profile: String,
        expected_checksum: Option<String>,
        excluded_reason: Option<String>,
    }

    fn fingerprint(value: &Value) -> String {
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

    // Conversion and fingerprinting happen once before timing, never per op.
    fn semantics(engine: &SyntaxEngine, fixture: &Fixture) -> Result<Value, Box<dyn Error>> {
        if fixture.mode == "program" {
            return Ok(engine.parse(&fixture.source)?.to_value());
        }
        let plan = engine.compile_template(&fixture.source)?;
        let mut result = Vec::new();
        for segment in plan.segments() {
            let mut source = serde_json::to_value(segment.source_segment())?;
            source
                .as_object_mut()
                .ok_or("segment is not an object")?
                .remove("span");
            if let Some(program) = segment.program() {
                source
                    .as_object_mut()
                    .ok_or("segment is not an object")?
                    .insert(
                        "ast".into(),
                        program.as_ref().map_err(Clone::clone)?.to_value(),
                    );
            }
            result.push(source);
        }
        Ok(Value::Array(result))
    }

    fn compile_once(engine: &SyntaxEngine, fixture: &Fixture) -> Result<usize, Box<dyn Error>> {
        if fixture.mode == "program" {
            let program = black_box(engine.parse(black_box(&fixture.source))?);
            Ok(black_box(program.stats().nodes))
        } else {
            let plan = black_box(engine.compile_template(black_box(&fixture.source))?);
            Ok(black_box(plan.stats().nodes + plan.segments().len()))
        }
    }

    fn measure(
        mut operation: impl FnMut() -> Result<usize, Box<dyn Error>>,
        requests: &Requests,
        started: Instant,
        sink: &mut usize,
    ) -> Result<Vec<u128>, Box<dyn Error>> {
        for _ in 0..requests.warmup {
            *sink ^= black_box(operation()?);
            if started.elapsed() > Duration::from_secs(30) {
                return Err("Total walltime exceeded 30s".into());
            }
        }
        let mut durations = Vec::with_capacity(requests.batches);
        for _ in 0..requests.batches {
            let begin = Instant::now();
            for iteration in 0..requests.iterations {
                *sink ^= black_box(operation()?);
                if iteration % 32 == 0 && begin.elapsed() > Duration::from_secs(2) {
                    return Err("Batch walltime exceeded 2s".into());
                }
            }
            let elapsed = begin.elapsed();
            if elapsed > Duration::from_secs(2) {
                return Err("Batch walltime exceeded 2s".into());
            }
            durations.push(elapsed.as_nanos());
            if started.elapsed() > Duration::from_secs(30) {
                return Err("Total walltime exceeded 30s".into());
            }
        }
        Ok(durations)
    }

    pub fn run() -> Result<(), Box<dyn Error>> {
        let mut args = std::env::args().skip(1);
        let mut path = None;
        let mut runtime_version =
            "unreported; record rustc --version alongside this result".to_owned();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--requests" => path = Some(args.next().ok_or("Missing --requests path")?),
                "--runtime-version" => {
                    runtime_version = args.next().ok_or("Missing runtime version")?
                }
                _ => return Err(format!("Unknown argument: {arg}").into()),
            }
        }
        let reader: Box<dyn Read> = if let Some(path) = path {
            Box::new(std::fs::File::open(path)?)
        } else {
            Box::new(std::io::stdin())
        };
        let mut input = String::new();
        reader.take(2_000_001).read_to_string(&mut input)?;
        if input.len() > 2_000_000 {
            return Err("Requests exceed 2MB".into());
        }
        let requests: Requests = serde_json::from_str(&input)?;
        if requests.version != 1
            || !(1..=10_000).contains(&requests.iterations)
            || !(1..=20).contains(&requests.batches)
            || requests.warmup > 1000
            || requests.fixtures.is_empty()
            || requests.fixtures.len() > 64
        {
            return Err("Unsupported version or benchmark bounds".into());
        }
        let started = Instant::now();
        let mut measurements = Vec::new();
        let mut sink = 0;
        for fixture in &requests.fixtures {
            if !matches!(fixture.mode.as_str(), "program" | "template")
                || !matches!(
                    fixture.profile.as_str(),
                    "improved" | "typescript_compatible"
                )
                || fixture.source.encode_utf16().count() > Limits::default().source_utf16
            {
                return Err(format!("Invalid fixture: {}", fixture.name).into());
            }
            if let Some(reason) = &fixture.excluded_reason {
                measurements.push(json!({"name": fixture.name, "excluded_reason": reason}));
                continue;
            }
            let engine = if fixture.profile == "improved" {
                SyntaxEngine::default()
            } else {
                SyntaxEngine::typescript_compatible()
            };
            let checksum = fingerprint(&semantics(&engine, fixture)?);
            if fixture.expected_checksum.as_deref() != Some(checksum.as_str()) {
                return Err(format!(
                    "Semantic checksum mismatch for {}: got {checksum}, expected {:?}",
                    fixture.name, fixture.expected_checksum
                )
                .into());
            }
            let durations = measure(
                || compile_once(&engine, fixture),
                &requests,
                started,
                &mut sink,
            )?;
            let per_op: Vec<_> = durations
                .iter()
                .map(|n| *n as f64 / requests.iterations as f64)
                .collect();
            measurements.push(json!({
                "fixture": fixture.name, "profile": fixture.profile,
                "method": if fixture.mode == "template" { "Rust compile_template" } else { "Rust parse" },
                "iterations": requests.iterations, "batches": requests.batches,
                "durations_ns": durations, "ns_per_op": per_op, "checksum": checksum,
            }));
            if requests.plan_reuse && fixture.mode == "template" {
                let plan = engine.compile_template(&fixture.source)?;
                let durations = measure(
                    || {
                        let count = black_box(&plan)
                            .segments()
                            .iter()
                            .map(|segment| {
                                segment
                                    .program()
                                    .and_then(|r| r.as_ref().ok())
                                    .map_or(0, |p| {
                                        black_box(p.root());
                                        p.stats().nodes
                                    })
                            })
                            .sum();
                        Ok(black_box(count))
                    },
                    &requests,
                    started,
                    &mut sink,
                )?;
                let per_op: Vec<_> = durations
                    .iter()
                    .map(|n| *n as f64 / requests.iterations as f64)
                    .collect();
                measurements.push(json!({
                    "fixture": fixture.name, "profile": fixture.profile,
                    "method": "Rust precompiled segment metadata traversal; no evaluation or parsing",
                    "iterations": requests.iterations, "batches": requests.batches,
                    "durations_ns": durations, "ns_per_op": per_op, "checksum": checksum,
                }));
            }
        }
        println!(
            "{}",
            json!({"version": 1, "runtime_version": runtime_version,
            "method": "syntax compilation; no evaluation or timed JSON serialization",
            "sources": requests.sources, "sink": black_box(sink), "measurements": measurements})
        );
        Ok(())
    }
}
