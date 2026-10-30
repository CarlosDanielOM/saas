#![cfg(feature = "moderation-variations")]
//! One release-mode actor. The fixture and pins are produced externally by the TS reader.
use dima_rust::utils::{
    js_string::JsString,
    lossless_json::JsonValue,
    moderation::{
        advanced::{Boundary, ModerationPattern},
        variations::*,
    },
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{env, fs, hint::black_box, path::Path, time::Instant};

fn string(value: &Value) -> JsString {
    JsString::from_units(
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|v| u16::try_from(v.as_u64().unwrap()).unwrap())
            .collect(),
    )
}
fn object(fields: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn pattern(p: &ModerationPattern) -> JsonValue {
    object(vec![
        ("id", JsonValue::String(p.id.clone())),
        ("source", JsonValue::String(p.source.clone())),
        (
            "boundary",
            JsonValue::String(
                match p.boundary {
                    Boundary::WholeWord => "whole_word",
                    Boundary::Anywhere => "anywhere",
                }
                .into(),
            ),
        ),
        ("ignoreCase", JsonValue::Bool(p.ignore_case)),
    ])
}
fn entry(e: &GeneratedVariation) -> JsonValue {
    let mut fields = vec![
        ("term", JsonValue::String(e.term.clone())),
        (
            "spellings",
            JsonValue::Array(e.spellings.iter().cloned().map(JsonValue::String).collect()),
        ),
        ("pattern", pattern(&e.pattern)),
        ("version", JsonValue::String(e.version.clone())),
    ];
    if let Some(v) = e.allow_spaces {
        fields.push(("allowSpaces", JsonValue::Bool(v)));
    }
    if let Some(v) = &e.symbol_version {
        fields.push(("symbolVersion", JsonValue::String(v.clone())));
    }
    object(fields)
}
fn wire(v: &JsonValue) -> Vec<u16> {
    v.to_json_string().encode_utf16().collect()
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn pin(name: &str) -> String {
    let v = env::var(name).unwrap();
    assert_eq!(v.len(), 64);
    assert!(
        v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    v
}
struct Case {
    term: JsString,
    channel: JsString,
    entry: GeneratedVariation,
    rule: VariationRule,
}
fn prepare(source: &[Value]) -> Vec<Case> {
    assert_eq!(source.len(), 32);
    let terms: Vec<_> = source.iter().map(|v| string(&v["term"])).collect();
    assert_eq!(
        terms.iter().collect::<std::collections::HashSet<_>>().len(),
        32
    );
    let entries: Vec<_> = terms
        .iter()
        .map(|t| build_variation(t, None).unwrap())
        .collect();
    (0..32)
        .map(|i| Case {
            term: terms[i].clone(),
            channel: string(&source[i]["channel"]),
            entry: entries[i].clone(),
            rule: VariationRule {
                patterns: Some(vec![ModerationPattern {
                    id: format!("manual-{i}").into(),
                    source: "dog".into(),
                    boundary: Boundary::Anywhere,
                    ignore_case: false,
                }]),
                variations: Some(ModerationVariations {
                    mode: if i % 2 == 0 {
                        VariationMode::Broad
                    } else {
                        VariationMode::Common
                    },
                    entries: vec![entries[i].clone(), entries[(i + 1) % 32].clone()],
                    overrides: Some(vec![VariationOverride {
                        term: entries[(i + 1) % 32].term.clone(),
                        source: "c.t".into(),
                    }]),
                    allow_spaces: Some(true),
                }),
            },
        })
        .collect()
}
fn project(name: &str, c: &Case, cache: &VariationCache) -> Vec<u16> {
    let value = match name {
        "term" => JsonValue::String(variation_term(&c.term)),
        "key" => JsonValue::String(variation_key(&c.channel, &c.term).into()),
        "build" => entry(&build_variation(&c.term, None).unwrap()),
        "spacing" => entry(
            cache
                .with_spacing_shared(&c.entry, true, VariationMode::Broad)
                .unwrap()
                .as_ref(),
        ),
        "patterns" => JsonValue::Array(
            rule_patterns(&c.rule)
                .unwrap()
                .iter()
                .map(pattern)
                .collect(),
        ),
        _ => panic!("invalid workload"),
    };
    wire(&value)
}
fn checksum(results: &[Vec<u16>]) -> u32 {
    let mut h = 2_166_136_261u32;
    for r in results {
        for u in r {
            h = (h ^ u32::from(*u)).wrapping_mul(16_777_619);
        }
        h = (h ^ 65_536).wrapping_mul(16_777_619);
    }
    h
}
// Retain operation outputs through the timer; project, validate, and checksum only afterward.
fn sample<T, F, P>(
    pool: &[Case],
    rounds: usize,
    mut call: F,
    project: P,
    expected: &[Value],
) -> (u128, u32)
where
    F: FnMut(&Case) -> T,
    P: Fn(&T) -> Vec<u16>,
{
    let count = rounds * pool.len();
    for _ in 0..3 {
        let mut retained = Vec::with_capacity(count);
        for _ in 0..rounds {
            for c in pool {
                retained.push(black_box(call(black_box(c))));
            }
        }
        assert_eq!(retained.len(), count);
    }
    let mut retained = Vec::with_capacity(count);
    let start = Instant::now();
    for _ in 0..rounds {
        for c in pool {
            retained.push(black_box(call(black_box(c))));
        }
    }
    let elapsed = start.elapsed().as_nanos();
    let projected: Vec<_> = retained.iter().map(project).collect();
    for (i, actual) in projected.iter().enumerate() {
        assert_eq!(*actual, string(&expected[i % 32]["result"]).units());
    }
    (elapsed, checksum(&projected))
}
#[test]
#[ignore = "isolated release benchmark actor"]
fn benchmark_sample() {
    let filename = env::var("DIMA_VARIATIONS_BENCHMARK_FIXTURE").unwrap();
    let path = Path::new(&filename);
    assert!(path.is_absolute());
    let real = fs::canonicalize(path).unwrap();
    let workspace =
        fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()).unwrap();
    assert!(!real.starts_with(workspace));
    let raw = fs::read(real).unwrap();
    let input_hash = hash(&raw);
    assert_eq!(input_hash, pin("DIMA_VARIATIONS_BENCHMARK_SHA256"));
    assert_eq!(
        hash(&fs::read(env::current_exe().unwrap()).unwrap()),
        pin("DIMA_VARIATIONS_BENCH_BINARY_SHA256")
    );
    let data: Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(data["format"], 1);
    let names = ["term", "key", "build", "spacing", "patterns"];
    assert_eq!(data["workloads"].as_object().unwrap().len(), names.len());
    let name = env::var("DIMA_VARIATIONS_BENCH_WORKLOAD").unwrap();
    assert!(names.contains(&name.as_str()));
    let source = data["workloads"]["term"].as_array().unwrap();
    let pool = prepare(source);
    let cache = VariationCache::new();
    for n in names {
        let cases = data["workloads"][n].as_array().unwrap();
        assert_eq!(cases.len(), 32);
        for (i, c) in pool.iter().enumerate() {
            assert_eq!(c.term, string(&cases[i]["term"]));
            assert_eq!(c.channel, string(&cases[i]["channel"]));
            assert_eq!(project(n, c, &cache), string(&cases[i]["result"]).units());
        }
    }
    for c in &pool {
        let a = cache
            .with_spacing_shared(&c.entry, true, VariationMode::Broad)
            .unwrap();
        let b = cache
            .with_spacing_shared(&c.entry, true, VariationMode::Broad)
            .unwrap();
        match (a, b) {
            (CompiledVariation::Shared(a), CompiledVariation::Shared(b)) => {
                assert!(std::sync::Arc::ptr_eq(&a, &b))
            }
            _ => panic!("expected shared cache hit"),
        }
    }
    let rounds: usize = env::var("DIMA_VARIATIONS_BENCH_ROUNDS")
        .unwrap_or_else(|_| "250".into())
        .parse()
        .unwrap();
    assert!((1..=500).contains(&rounds));
    let expected = data["workloads"][&name].as_array().unwrap();
    let (elapsed, checksum) = match name.as_str() {
        "term" => sample(
            &pool,
            rounds,
            |c| variation_term(&c.term),
            |v| wire(&JsonValue::String(v.clone())),
            expected,
        ),
        "key" => sample(
            &pool,
            rounds,
            |c| variation_key(&c.channel, &c.term),
            |v| wire(&JsonValue::String(v.as_str().into())),
            expected,
        ),
        "build" => sample(
            &pool,
            rounds,
            |c| build_variation(&c.term, None).unwrap(),
            |v| wire(&entry(v)),
            expected,
        ),
        // Inputs lack compiled flags, therefore all prepared spacing calls are shared cache hits.
        "spacing" => sample(
            &pool,
            rounds,
            |c| match cache
                .with_spacing_shared(&c.entry, true, VariationMode::Broad)
                .unwrap()
            {
                CompiledVariation::Shared(v) => v,
                CompiledVariation::Borrowed(_) => panic!("unexpected borrowed"),
            },
            |v| wire(&entry(v)),
            expected,
        ),
        // These rules contain entries, so rule_patterns returns its owned public result.
        "patterns" => sample(
            &pool,
            rounds,
            |c| rule_patterns(&c.rule).unwrap().into_owned(),
            |v| wire(&JsonValue::Array(v.iter().map(pattern).collect())),
            expected,
        ),
        _ => unreachable!(),
    };
    let count = rounds * 32;
    println!(
        "{}",
        json!({"format":1,"actor":"rust","workload":name,"rounds":rounds,"operations":count,"warmups":3,"warmupOperations":count*3,"nanoseconds":elapsed.to_string(),"checksum":checksum,"inputSha256":input_hash})
    );
}
