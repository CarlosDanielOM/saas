#![cfg(all(feature = "moderation-links", feature = "moderation-normalize"))]
use dima_rust::utils::{
    js_string::JsString,
    moderation::{
        links_rule::{LinksEvaluationInput, LinksEvaluationResult, LinksRule, evaluate_links_rule},
        normalize::{escape_reg_exp, fold_text},
    },
};
use std::{
    borrow::Cow,
    io::{self, BufRead, Write},
};

// Independent SHA-256 helper copied from tests/js_unicode.rs; hashes raw fixture bytes before timing.
pub fn sha256_hex(bytes: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut state = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut padded = bytes.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&(bytes.len() as u64 * 8).to_be_bytes());
    for chunk in padded.as_chunks::<64>().0 {
        let mut words = [0u32; 64];
        for (index, word) in chunk.as_chunks::<4>().0.iter().enumerate() {
            words[index] = u32::from_be_bytes(*word);
        }
        for i in 16..64 {
            let a = words[i - 15].rotate_right(7)
                ^ words[i - 15].rotate_right(18)
                ^ (words[i - 15] >> 3);
            let b = words[i - 2].rotate_right(17)
                ^ words[i - 2].rotate_right(19)
                ^ (words[i - 2] >> 10);
            words[i] = words[i - 16]
                .wrapping_add(a)
                .wrapping_add(words[i - 7])
                .wrapping_add(b);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in 0..64 {
            let x = h
                .wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
                .wrapping_add((e & f) ^ (!e & g))
                .wrapping_add(K[i])
                .wrapping_add(words[i]);
            let y = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22))
                .wrapping_add((a & b) ^ (a & c) ^ (b & c));
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(x);
            d = c;
            c = b;
            b = a;
            a = x.wrapping_add(y);
        }
        for (slot, word) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(word);
        }
    }
    state.iter().map(|word| format!("{word:08x}")).collect()
}

struct Item {
    id: String,
    text: JsString,
    domains: Vec<JsString>,
}
enum Output<'a> {
    Link(LinksEvaluationResult),
    Text(Cow<'a, JsString>),
}
fn evaluate<'a>(kind: &str, item: &'a Item) -> Output<'a> {
    match kind {
        "link-common" | "link-large" => Output::Link(evaluate_links_rule(
            LinksRule {
                allowlist_domains: Some(&item.domains),
            },
            LinksEvaluationInput {
                text: Some(&item.text),
            },
        )),
        "fold-text" => Output::Text(fold_text(Some(&item.text))),
        "escape-regexp" => Output::Text(escape_reg_exp(&item.text)),
        _ => panic!("unknown workload"),
    }
}
fn wire(value: &Output<'_>) -> String {
    match value {
        Output::Text(s) => s.to_json_string(),
        Output::Link(v) => {
            let mut out = format!("{{\"triggered\":{},\"urls\":[", v.triggered);
            for (i, url) in v.urls.iter().enumerate() {
                if i != 0 {
                    out.push(',');
                }
                url.write_json_string(&mut out);
            }
            out.push_str("],\"blockedUrl\":");
            if let Some(url) = &v.blocked_url {
                url.write_json_string(&mut out);
            } else {
                out.push_str("null");
            }
            out.push('}');
            out
        }
    }
}
fn units(v: &serde_json::Value) -> Vec<u16> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| u16::try_from(x.as_u64().unwrap()).unwrap())
        .collect()
}

#[test]
#[ignore = "external prepared paired benchmark coordinator required"]
fn prepared_moderation_text_server() {
    use serde_json::{Value, json};
    assert!(
        !std::hint::black_box(cfg!(debug_assertions)),
        "release only"
    );
    let directory = std::path::PathBuf::from(
        std::env::var_os("DIMA_MODERATION_TEXT_BENCH_DIR").expect("input directory"),
    );
    assert!(directory.is_absolute());
    let directory = directory.canonicalize().unwrap();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(!directory.starts_with(source));
    let bytes = std::fs::read(directory.join("moderation-text-benchmark-input.json")).unwrap();
    let input_sha = sha256_hex(&bytes);
    assert_eq!(
        input_sha,
        std::env::var("DIMA_MODERATION_TEXT_INPUT_SHA256").expect("independent input sha")
    );
    let data: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(data["metadata"]["realm"], "commonjs");
    assert_eq!(
        data["metadata"]["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    // Bind the native server to its exact compiled implementation and tables.
    for (file, content) in [
        (
            "src/utils/moderation/links_rule.rs",
            include_bytes!("../src/utils/moderation/links_rule.rs").as_slice(),
        ),
        (
            "src/utils/moderation/normalize.rs",
            include_bytes!("../src/utils/moderation/normalize.rs").as_slice(),
        ),
        (
            "src/utils/js_unicode.rs",
            include_bytes!("../src/utils/js_unicode.rs").as_slice(),
        ),
        (
            "src/utils/js_unicode_data.rs",
            include_bytes!("../src/utils/js_unicode_data.rs").as_slice(),
        ),
        (
            "src/utils/js_string.rs",
            include_bytes!("../src/utils/js_string.rs").as_slice(),
        ),
        (
            "src/utils/js_compat.rs",
            include_bytes!("../src/utils/js_compat.rs").as_slice(),
        ),
        (
            "tests/moderation_text_benchmark.rs",
            include_bytes!("moderation_text_benchmark.rs").as_slice(),
        ),
        (
            "tests/fixtures/moderation_text_benchmark.cjs",
            include_bytes!("fixtures/moderation_text_benchmark.cjs").as_slice(),
        ),
        ("Cargo.toml", include_bytes!("../Cargo.toml").as_slice()),
        ("Cargo.lock", include_bytes!("../Cargo.lock").as_slice()),
    ] {
        assert_eq!(
            sha256_hex(content),
            data["metadata"]["nativeHashes"][file].as_str().unwrap(),
            "{file}"
        );
    }
    for (file, content) in [
        (
            "src/utils/moderation/rules/links.rule.ts",
            include_bytes!("../src/utils/moderation/rules/links.rule.ts").as_slice(),
        ),
        (
            "src/utils/moderation/normalize.ts",
            include_bytes!("../src/utils/moderation/normalize.ts").as_slice(),
        ),
        (
            "src/schemas/channel_moderation_settings.schema.ts",
            include_bytes!("../src/schemas/channel_moderation_settings.schema.ts").as_slice(),
        ),
        ("package.json", include_bytes!("../package.json").as_slice()),
        (
            "package-lock.json",
            include_bytes!("../package-lock.json").as_slice(),
        ),
        (
            "rust-toolchain.toml",
            include_bytes!("../rust-toolchain.toml").as_slice(),
        ),
    ] {
        assert_eq!(
            sha256_hex(content),
            data["metadata"]["pins"][file].as_str().unwrap(),
            "{file}"
        );
    }
    let names = ["link-common", "link-large", "fold-text", "escape-regexp"];
    let mut pools: Vec<(&str, Vec<Item>)> = Vec::new();
    for name in names {
        let rows = data["pools"][name].as_array().unwrap();
        assert_eq!(rows.len(), 8);
        let mut pool = Vec::new();
        for row in rows {
            let item = Item {
                id: row["id"].as_str().unwrap().to_owned(),
                text: JsString::from_units(units(&row["text"])),
                domains: row["domains"]
                    .as_array()
                    .map(|a| a.iter().map(|x| JsString::from_units(units(x))).collect())
                    .unwrap_or_default(),
            };
            let output = evaluate(name, &item);
            assert_eq!(
                wire(&output),
                row["wire"].as_str().unwrap(),
                "{} {name}",
                item.id
            );
            match &output {
                Output::Text(s) => {
                    assert_eq!(s.units(), units(&row["expected"]["units"]), "{}", item.id)
                }
                Output::Link(v) => {
                    assert_eq!(v.triggered, row["expected"]["triggered"].as_bool().unwrap());
                    assert_eq!(
                        v.urls.iter().map(JsString::units).collect::<Vec<_>>(),
                        row["expected"]["urls"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(units)
                            .collect::<Vec<_>>()
                    );
                    assert_eq!(
                        v.blocked_url.as_ref().map(JsString::units),
                        row["expected"]["blocked"]
                            .as_array()
                            .map(|_| units(&row["expected"]["blocked"]))
                    );
                }
            }
            pool.push(item);
        }
        pools.push((name, pool));
    }
    let reps: usize = std::env::var("DIMA_MODERATION_TEXT_REPS")
        .unwrap_or_else(|_| "1000".into())
        .parse()
        .unwrap();
    assert!((1..=10_000).contains(&reps));
    let pool_ids = serde_json::Map::from_iter(pools.iter().map(|(k, p)| {
        (
            (*k).to_string(),
            json!(p.iter().map(|x| &x.id).collect::<Vec<_>>()),
        )
    }));
    println!(
        "{}",
        json!({"ready":true,"realm":"native","nodeSha":data["metadata"]["nodeSha"],"pools":pool_ids,"reps":reps,"inputSha":input_sha,"compiledSha":data["metadata"]["compiledSha"],"nativeHashes":data["metadata"]["nativeHashes"]})
    );
    io::stdout().flush().unwrap();
    for line in io::stdin().lock().lines() {
        let command: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let action = command["command"].as_str().unwrap();
        if action == "quit" {
            break;
        }
        assert!(action == "warmup" || action == "run");
        let kind = command["workload"].as_str().unwrap();
        let pool = &pools
            .iter()
            .find(|(name, _)| *name == kind)
            .expect("unknown workload")
            .1;
        let total = pool.len() * reps;
        let mut results: Vec<Option<Output<'_>>> = (0..total).map(|_| None).collect();
        let start = std::time::Instant::now();
        for (i, slot) in results.iter_mut().enumerate() {
            *slot = Some(std::hint::black_box(evaluate(
                std::hint::black_box(kind),
                std::hint::black_box(&pool[i % pool.len()]),
            )));
        }
        let elapsed = start.elapsed().as_nanos();
        let mut checksum = 2_166_136_261u32;
        for value in results.into_iter().flatten() {
            for unit in wire(&value).encode_utf16() {
                checksum = (checksum ^ u32::from(unit)).wrapping_mul(16_777_619);
            }
            checksum = (checksum ^ u32::MAX).wrapping_mul(16_777_619);
        }
        println!(
            "{}",
            json!({"workload":kind,"elapsedNs":elapsed.to_string(),"total":total,"checksum":checksum})
        );
        io::stdout().flush().unwrap();
    }
}
