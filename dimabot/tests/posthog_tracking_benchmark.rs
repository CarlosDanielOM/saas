#![cfg(feature = "posthog-benchmark")]
//! Pure prepared-payload comparison; requires an independently supplied input hash.
use dima_rust::utils::{
    ai_usage::AiUsageContext,
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    posthog_tracking::{self, NativeUsageRecorded, PreparedEvent},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, OpenOptions},
    hint::black_box,
    io::Write,
    path::PathBuf,
    time::Instant,
};

fn get<'a>(v: &'a JsonValue, key: &str) -> &'a JsonValue {
    v.get(key).unwrap_or_else(|| panic!("missing {key}"))
}
fn string(v: &JsonValue) -> &str {
    if let JsonValue::String(s) = v {
        s.as_str().expect("scalar string")
    } else {
        panic!("string")
    }
}
fn array(v: &JsonValue) -> &[JsonValue] {
    if let JsonValue::Array(a) = v {
        a
    } else {
        panic!("array")
    }
}
fn number(v: &JsonValue) -> f64 {
    if let JsonValue::Number(n) = v {
        *n
    } else {
        panic!("number")
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn sum(bytes: &[u8]) -> u32 {
    bytes
        .iter()
        .fold(0u32, |n, b| n.wrapping_add(u32::from(*b)))
}
fn wire(p: PreparedEvent) -> String {
    JsonValue::Object(vec![
        (
            JsString::from("distinctId"),
            JsonValue::String(p.distinct_id),
        ),
        (
            JsString::from("event"),
            JsonValue::String(JsString::from(p.event)),
        ),
        (JsString::from("properties"), p.properties),
    ])
    .to_json_string()
}
struct Input {
    params: JsonValue,
    context: Option<AiUsageContext>,
    expected: String,
    checksum: u32,
}
fn prepare(name: &str, i: &Input) -> PreparedEvent {
    let p = black_box(&i.params);
    match name {
        "command" => posthog_tracking::command(p),
        "tts" | "tts-unicode" | "tts-large" => posthog_tracking::tts(p),
        "ai-operation" => posthog_tracking::ai_operation(p),
        "ai-usage" => NativeUsageRecorded {
            context: black_box(i.context.as_ref().unwrap()),
            credits: number(get(p, "credits")),
            reason: string(get(p, "reason")),
            polar_cost_amount: Some(number(get(p, "polarCostAmount"))),
            input_tokens: Some(number(get(p, "inputTokens"))),
            output_tokens: Some(number(get(p, "outputTokens"))),
            total_tokens: Some(number(get(p, "totalTokens"))),
        }
        .prepare(),
        _ => panic!("unknown pool"),
    }
    .expect("prepared event")
}
fn run(name: &str, inputs: &[Input], count: usize) -> u32 {
    let mut checksum = 0u32;
    for i in 0..count {
        let output = wire(prepare(
            black_box(name),
            black_box(&inputs[i % inputs.len()]),
        ));
        checksum = checksum.wrapping_add(sum(black_box(output.as_bytes())));
    }
    black_box(checksum)
}
#[test]
#[ignore = "explicit isolated benchmark; needs POSTHOG_BENCH_DIR and independently obtained POSTHOG_BENCH_INPUT_SHA256"]
fn prepared_payload_benchmark() {
    let dir = PathBuf::from(env::var_os("POSTHOG_BENCH_DIR").expect("explicit fixture directory"));
    let expected_hash =
        env::var("POSTHOG_BENCH_INPUT_SHA256").expect("independent input SHA-256 required");
    assert_eq!(expected_hash.len(), 64);
    assert!(
        expected_hash
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    );
    let input_path = dir.join("input.json");
    let bytes = fs::read(&input_path).expect("fixture required");
    assert_eq!(hash(&bytes), expected_hash);
    let document = parse_json(std::str::from_utf8(&bytes).unwrap()).unwrap();
    let metadata: Value =
        serde_json::from_str(&get(&document, "metadata").to_json_string()).unwrap();
    assert_eq!(metadata["format"], "posthog-prepared-v1");
    let node: Value = serde_json::from_slice(
        &fs::read(dir.join("node-report.json")).expect("node report required"),
    )
    .unwrap();
    assert_eq!(node["format"], metadata["format"]);
    assert_eq!(node["metadata"], metadata);
    assert_eq!(node["runtime"], "node");
    assert_eq!(node["inputSha256"], expected_hash);
    let pools = array(get(&document, "pools"));
    assert_eq!(pools.len(), 6);
    let names = [
        "command",
        "tts",
        "ai-usage",
        "ai-operation",
        "tts-unicode",
        "tts-large",
    ];
    let mut prepared = Vec::new();
    for (index, pool) in pools.iter().enumerate() {
        let name = string(get(pool, "name"));
        assert_eq!(name, names[index]);
        let operations = number(get(pool, "operations")) as usize;
        let warmups = number(get(pool, "warmups")) as usize;
        assert_eq!(operations, if name == "tts-large" { 32768 } else { 256000 });
        assert_eq!(warmups, 32000);
        let entries = array(get(pool, "inputs"));
        assert_eq!(entries.len(), 32);
        let inputs: Vec<Input> = entries
            .iter()
            .map(|entry| {
                let context = if name == "ai-usage" {
                    Some(serde_json::from_str(string(get(entry, "contextText"))).unwrap())
                } else {
                    assert_eq!(get(entry, "contextText"), &JsonValue::Null);
                    None
                };
                Input {
                    params: get(entry, "params").clone(),
                    context,
                    expected: string(get(entry, "expectedWire")).to_owned(),
                    checksum: number(get(entry, "checksum")) as u32,
                }
            })
            .collect();
        for item in &inputs {
            let actual = wire(prepare(name, item));
            assert_eq!(actual, item.expected);
            assert_eq!(sum(actual.as_bytes()), item.checksum);
        }
        let expected = (0..operations).fold(0u32, |s, i| s.wrapping_add(inputs[i % 32].checksum));
        let report = &node["pools"][index];
        assert_eq!(report["name"], name);
        assert_eq!(report["operations"], operations);
        assert_eq!(report["warmups"], warmups);
        let trials = report["trials"].as_array().unwrap();
        assert_eq!(trials.len(), 7);
        let mut times = Vec::new();
        for trial in trials {
            assert_eq!(trial["checksum"], expected);
            let time = trial["nanoseconds"].as_u64().unwrap();
            assert!(time > 0);
            times.push(time);
        }
        times.sort_unstable();
        assert_eq!(report["min"], times[0]);
        assert_eq!(report["median"], times[3]);
        assert_eq!(report["max"], times[6]);
        prepared.push((name.to_owned(), operations, warmups, inputs, expected));
    }
    // Every source wire and every Node trial is validated before any native timing.
    let mut results = Vec::new();
    for (name, operations, warmups, inputs, expected) in &prepared {
        black_box(run(name, inputs, *warmups));
        let mut trials = Vec::new();
        let mut times = Vec::new();
        for _ in 0..7 {
            let start = Instant::now();
            let checksum = run(name, inputs, *operations);
            let nanoseconds = start.elapsed().as_nanos() as u64;
            assert_eq!(checksum, *expected);
            assert!(nanoseconds > 0);
            times.push(nanoseconds);
            trials.push(json!({"nanoseconds":nanoseconds,"checksum":checksum}));
        }
        times.sort_unstable();
        results.push(json!({"name":name,"operations":operations,"warmups":warmups,"trials":trials,"min":times[0],"median":times[3],"max":times[6]}));
    }
    assert_eq!(
        hash(&fs::read(&input_path).unwrap()),
        expected_hash,
        "fixture changed while running"
    );
    let report = json!({"format":"posthog-prepared-v1","runtime":"native","inputSha256":expected_hash,"metadata":metadata,"pools":results});
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join("native-report.json"))
        .expect("exclusive report creation");
    writeln!(out, "{}", report).unwrap();
}
