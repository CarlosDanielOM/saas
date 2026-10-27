// Prepared pure-function measurements; only the lead executes release binaries.
#[allow(dead_code)]
#[path = "ast_evaluator_bench.rs"]
mod harness;
#[cfg(feature = "ast-pure-functions")]
use harness::{adapter, support};

#[cfg(not(feature = "ast-pure-functions"))]
fn main() {
    eprintln!("enable --features ast-pure-functions");
    std::process::exit(2);
}
#[cfg(feature = "ast-pure-functions")]
fn main() {
    if let Err(error) = benchmark::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(feature = "ast-pure-functions")]
mod benchmark {
    use super::{
        adapter::{PreparedCase, normalize, project},
        support::{fingerprint, sha256_hex},
    };
    use serde::Deserialize;
    use serde_json::{Value, json, value::RawValue};
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
        warmup: usize,
        batches: usize,
        profile: String,
        fingerprint_encoding: String,
        #[serde(default)]
        iteration_reason: Option<String>,
        sources: Value,
        corpus_sha256_hex: String,
        manifest_sha256_hex: String,
        typescript_version: String,
        fixtures: Vec<Fixture>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Fixture {
        name: String,
        operation: String,
        description: String,
        input: Box<RawValue>,
        preparation: Value,
        workload_class: Value,
        expected: Option<Value>,
        expected_fingerprint_fnv1a_utf8: Option<String>,
    }
    fn median(values: &[f64]) -> f64 {
        let mut sorted = values.to_vec();
        sorted.sort_by(f64::total_cmp);
        let mid = sorted.len() / 2;
        if sorted.len() % 2 == 1 {
            sorted[mid]
        } else {
            (sorted[mid - 1] + sorted[mid]) / 2.0
        }
    }
    pub fn run() -> Result<(), Box<dyn Error>> {
        if cfg!(debug_assertions) {
            return Err("benchmark requires --release".into());
        }
        let mut args = std::env::args().skip(1);
        let mut path = None;
        let mut runtime_version = None;
        let mut implementation_variant = None;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--requests" => path = Some(args.next().ok_or("missing requests path")?),
                "--runtime-version" => {
                    runtime_version = Some(args.next().ok_or("missing compiler version")?)
                }
                "--implementation-variant" => {
                    implementation_variant =
                        Some(args.next().ok_or("missing implementation variant")?)
                }
                _ => return Err(format!("unknown argument {arg}").into()),
            }
        }
        let implementation_variant = implementation_variant
            .filter(|value| matches!(value.as_str(), "generic" | "ascii"))
            .ok_or("supply --implementation-variant generic|ascii (report label only)")?;
        let runtime_version = runtime_version
            .ok_or("supply --runtime-version with the lead's exact rustc --version record")?;
        let mut bytes = Vec::new();
        std::fs::File::open(path.ok_or("--requests required")?)?
            .take(4_000_001)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 4_000_000 {
            return Err("request exceeds 4MB".into());
        }
        let requests: Requests = serde_json::from_slice(&bytes)?;
        if requests.version != 1
            || requests.profile != "typescript_compatible"
            || requests.fingerprint_encoding != "json-tree-fnv1a-utf8-f64be-v1"
            || !(1..=100_000).contains(&requests.iterations)
            || requests.warmup > 1000
            || !(1..=20).contains(&requests.batches)
            || requests.fixtures.is_empty()
            || requests.fixtures.len() > 32
        {
            return Err("invalid request bounds/profile".into());
        }
        if requests.iterations != 50
            && requests
                .iteration_reason
                .as_ref()
                .is_none_or(|value| value.is_empty())
        {
            return Err("nonstandard iteration count requires a reason".into());
        }
        let corpus = include_bytes!("../tests/fixtures/ast_pure_cases.json");
        if sha256_hex(corpus) != requests.corpus_sha256_hex {
            return Err("request/candidate corpus byte SHA256 differs".into());
        }
        let manifest: Value = serde_json::from_slice(corpus)?;
        if manifest["manifestHash"] != requests.manifest_sha256_hex
            || manifest["sourceHashes"] != requests.sources
        {
            return Err("request/candidate source or manifest identity differs".into());
        }
        let definitions = manifest["benchmarks"]
            .as_array()
            .ok_or("missing frozen benchmarks")?;
        if definitions.len() != requests.fixtures.len() {
            return Err("request must retain every frozen benchmark".into());
        }
        let started = Instant::now();
        let mut measurements = Vec::new();
        let mut names = std::collections::BTreeSet::new();
        for (fixture, definition) in requests.fixtures.iter().zip(definitions) {
            let input: Value = serde_json::from_str(fixture.input.get())?;
            if definition["id"] != fixture.name || definition["input"] != input {
                return Err("request changed frozen benchmark identity or input".into());
            }
            let mut source_expected = definition["source"].clone();
            project(&mut source_expected);
            let mut request_expected = fixture
                .expected
                .clone()
                .ok_or("missing expected source result")?;
            project(&mut request_expected);
            if source_expected != request_expected {
                return Err("request changed frozen source observation".into());
            }
            if !names.insert(&fixture.name) {
                return Err("duplicate fixture name".into());
            }
            if !matches!(
                fixture.operation.as_str(),
                "evaluate" | "parseEvaluate" | "preparedRender"
            ) {
                return Err(format!("unsupported timed workload {}", fixture.name).into());
            }
            if input["pureBuiltins"] != true || input["operation"] != fixture.operation {
                return Err("timed inputs require pureBuiltins:true and matching operation".into());
            }
            let prepared = PreparedCase::new(fixture.input.get())?;
            let mut expected = fixture
                .expected
                .clone()
                .ok_or("missing expected source result")?;
            project(&mut expected);
            let preflight = normalize(&prepared.run(false));
            if preflight != expected {
                return Err(format!(
                    "preflight {} expected={expected} actual={preflight}",
                    fixture.name
                )
                .into());
            }
            let expected_fingerprint = fixture
                .expected_fingerprint_fnv1a_utf8
                .as_deref()
                .ok_or("missing fingerprint")?;
            if fingerprint(&preflight) != expected_fingerprint {
                return Err(format!("preflight fingerprint {}", fixture.name).into());
            }
            for _ in 0..requests.warmup {
                black_box(prepared.run(false));
                if started.elapsed() > Duration::from_secs(120) {
                    return Err("total exceeded 120 seconds".into());
                }
            }
            let mut durations = Vec::new();
            let mut exact = Vec::new();
            let mut postflight = None;
            for batch in 0..requests.batches {
                let mut last = None;
                let begin = Instant::now();
                for _ in 0..requests.iterations {
                    last = Some(black_box(prepared.run(false)));
                    if begin.elapsed() > Duration::from_secs(5) {
                        return Err("batch exceeded five seconds".into());
                    }
                    if started.elapsed() > Duration::from_secs(120) {
                        return Err("total exceeded 120 seconds".into());
                    }
                }
                let elapsed = begin.elapsed();
                if elapsed > Duration::from_secs(5) {
                    return Err("batch exceeded five seconds".into());
                }
                durations.push(elapsed.as_nanos());
                let actual = normalize(&last.expect("at least one iteration"));
                if actual != expected {
                    return Err(format!(
                        "postflight {}, batch {batch}, expected={expected} actual={actual}",
                        fixture.name
                    )
                    .into());
                }
                let checksum = fingerprint(&actual);
                if checksum != expected_fingerprint {
                    return Err(
                        format!("postflight fingerprint {}, batch {batch}", fixture.name).into(),
                    );
                }
                exact.push(json!({"batch":batch,"matched":true,"fingerprint_fnv1a_utf8":checksum}));
                postflight = Some(actual);
                if started.elapsed() > Duration::from_secs(120) {
                    return Err("total exceeded 120 seconds".into());
                }
            }
            let per_op: Vec<_> = durations
                .iter()
                .map(|value| *value as f64 / requests.iterations as f64)
                .collect();
            measurements.push(json!({"fixture":fixture.name,"operation":fixture.operation,"description":fixture.description,"workload_class":fixture.workload_class,
                "method":"Rust prepared AST/template evaluation, fresh context/fakehost/RNG per operation","preparation":fixture.preparation,
                "iterations":requests.iterations,"warmup":requests.warmup,"batches":requests.batches,"durations_ns":durations,"ns_per_op":per_op,
                "preflight":preflight,"postflight":postflight,"median_ns_per_op":median(&per_op),"fingerprint_fnv1a_utf8":expected_fingerprint,"exact_case_outcomes":exact}));
        }
        let binary = std::fs::read(std::env::current_exe()?)?;
        let runner_sha256_hex = sha256_hex(&binary);
        let request_sha256_hex = sha256_hex(&bytes);
        if started.elapsed() > Duration::from_secs(120) {
            return Err("total exceeded 120 seconds".into());
        }
        println!(
            "{}",
            json!({"version":1,"runtime":runtime_version,"implementation_variant":implementation_variant,
            "implementation_source":{"path":"dimabot/src/utils/ast_parser/evaluator/pure/casing.rs","sha256_hex":sha256_hex(include_bytes!("../src/utils/ast_parser/evaluator/pure/casing.rs"))},"build_profile":"release","profile":requests.profile,"fingerprint_encoding":requests.fingerprint_encoding,
            "request_sha256_hex":request_sha256_hex,"runner_sha256_hex":runner_sha256_hex,"corpus_sha256_hex":requests.corpus_sha256_hex,
            "manifest_sha256_hex":requests.manifest_sha256_hex,"sources":requests.sources,"typescript_version":requests.typescript_version,"measurements":measurements})
        );
        Ok(())
    }
}
