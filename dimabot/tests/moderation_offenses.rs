#![cfg(feature = "moderation-offenses")]
use dima_rust::utils::{js_string::JsString, moderation::offenses::*};
use serde_json::Value;
use std::path::PathBuf;

// Independent raw-byte SHA-256 helper reused from ast_evaluator_bench.rs.
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

fn units(v: &Value) -> Vec<u16> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| u16::try_from(x.as_u64().unwrap()).unwrap())
        .collect()
}
fn string(v: &Value) -> JsString {
    JsString::from_units(units(v))
}
fn number(v: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(v.as_str().unwrap(), 16).unwrap())
}
fn hex(value: &[u8]) -> String {
    value.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn keys_window_and_borrowed_ladder() {
    let channel = JsString::from_units(vec![0xd800]);
    assert_eq!(
        offense_key(&channel, &JsString::from("r"), &JsString::from("u")).to_utf8_lossy(),
        "moderation:�:offenses:r:u"
    );
    assert_eq!(
        offense_receipt_key(&channel).to_utf8_lossy(),
        "moderation:offense-receipt:�"
    );
    for (input, expected) in [
        (f64::NEG_INFINITY, "60"),
        (59.9, "60"),
        (60.9, "60"),
        (61.9, "61"),
        (f64::INFINITY, "Infinity"),
        (f64::NAN, "NaN"),
    ] {
        assert_eq!(offense_window_text(input), expected);
    }
    let first = 1;
    let second = 2;
    let third = 3;
    let ladder = || OffenseLadder {
        first_offense: &first,
        second_offense: &second,
        third_offense: &third,
    };
    for count in [f64::NEG_INFINITY, -1.0, 0.0, 1.0] {
        assert!(std::ptr::eq(resolve_offense_step(ladder(), count), &first));
    }
    assert!(std::ptr::eq(resolve_offense_step(ladder(), 2.0), &second));
    for count in [1.5, 3.0, f64::NAN, f64::INFINITY] {
        assert!(std::ptr::eq(resolve_offense_step(ladder(), count), &third));
    }
}

#[test]
#[ignore = "requires pinned actual-TypeScript source oracle"]
fn replay_actual_offense_source() {
    let dir = PathBuf::from(
        std::env::var_os("DIMA_OFFENSE_FIXTURE_DIR").expect("external fixture directory required"),
    );
    assert!(dir.is_absolute());
    assert_eq!(dir.canonicalize().unwrap(), dir);
    assert!(
        !dir.starts_with(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .canonicalize()
                .unwrap()
        )
    );
    let expected = std::env::var("DIMA_OFFENSE_FIXTURE_SHA256").expect("fixture SHA-256 required");
    assert_eq!(expected.len(), 64);
    assert!(
        expected
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let bytes = std::fs::read(dir.join("moderation-offenses-reference.json")).unwrap();
    assert_eq!(sha256_hex(&bytes), expected);
    let corpus: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(corpus["format"], 1);
    assert_eq!(corpus["implementation"], "actual-typescript");
    assert_eq!(
        corpus["nodeExecutableSha256"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    for (key, value) in [
        ("node", "24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("icu", "78.3"),
        ("unicode", "17.0"),
        ("typescript", "5.9.3"),
    ] {
        assert_eq!(corpus["versions"][key], value);
    }
    let sources = [
        (
            "src/utils/moderation/offenses.ts",
            include_bytes!("../src/utils/moderation/offenses.ts").as_slice(),
        ),
        (
            "src/schemas/channel_moderation_settings.schema.ts",
            include_bytes!("../src/schemas/channel_moderation_settings.schema.ts").as_slice(),
        ),
        (
            "src/utils/moderation/permit_offenses.test.ts",
            include_bytes!("../src/utils/moderation/permit_offenses.test.ts").as_slice(),
        ),
        (
            "src/utils/databases/dragonfly.database.ts",
            include_bytes!("../src/utils/databases/dragonfly.database.ts").as_slice(),
        ),
        (
            "src/utils/databases/dragonfly.database.rs",
            include_bytes!("../src/utils/databases/dragonfly.database.rs").as_slice(),
        ),
        (
            "src/utils/observability/telemetry.ts",
            include_bytes!("../src/utils/observability/telemetry.ts").as_slice(),
        ),
        (
            "src/utils/observability/mod.rs",
            include_bytes!("../src/utils/observability/mod.rs").as_slice(),
        ),
        (
            "src/utils/moderation/offenses.rs",
            include_bytes!("../src/utils/moderation/offenses.rs").as_slice(),
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
            "src/utils/json_number.rs",
            include_bytes!("../src/utils/json_number.rs").as_slice(),
        ),
        (
            "tests/moderation_offenses.rs",
            include_bytes!("moderation_offenses.rs").as_slice(),
        ),
        (
            "tests/moderation_offenses_redis.rs",
            include_bytes!("moderation_offenses_redis.rs").as_slice(),
        ),
        ("Cargo.toml", include_bytes!("../Cargo.toml").as_slice()),
        ("Cargo.lock", include_bytes!("../Cargo.lock").as_slice()),
        (
            "rust-toolchain.toml",
            include_bytes!("../rust-toolchain.toml").as_slice(),
        ),
        ("package.json", include_bytes!("../package.json").as_slice()),
        (
            "package-lock.json",
            include_bytes!("../package-lock.json").as_slice(),
        ),
        (
            "oracle-script",
            include_bytes!("fixtures/moderation_offenses_reference.cjs").as_slice(),
        ),
    ];
    for (key, bytes) in sources {
        assert_eq!(
            sha256_hex(bytes),
            corpus["sourceSha256"][key].as_str().unwrap(),
            "source {key}"
        );
    }
    let keys = corpus["keys"].as_array().unwrap();
    assert_eq!(keys.len(), 192);
    for row in keys {
        let key = offense_key(
            &string(&row["channel"]),
            &string(&row["rule"]),
            &string(&row["user"]),
        );
        assert_eq!(key.units(), units(&row["key"]));
        assert_eq!(
            hex(key.to_utf8_lossy().as_bytes()),
            row["wire"].as_str().unwrap()
        );
    }
    let first = 1;
    let second = 2;
    let third = 3;
    for row in corpus["steps"].as_array().unwrap() {
        let step = resolve_offense_step(
            OffenseLadder {
                first_offense: &first,
                second_offense: &second,
                third_offense: &third,
            },
            number(&row["numberBits"]),
        );
        let actual = if std::ptr::eq(step, &first) {
            "first"
        } else if std::ptr::eq(step, &second) {
            "second"
        } else {
            "third"
        };
        assert_eq!(actual, row["identity"].as_str().unwrap());
    }
    let cases = corpus["cases"].as_array().unwrap();
    assert!(cases.len() >= 100);
    for case in cases {
        let events = case["events"].as_array().unwrap();
        assert_eq!(events[0]["caller"], "moderation.recordOffense");
        if events.len() == 1 {
            assert_eq!(case["error"], true);
            continue;
        }
        let decision = if case["decision"].is_null() {
            None
        } else {
            Some(string(&case["decision"]))
        };
        let decision = decision.as_ref().filter(|v| !v.is_empty());
        let counter = offense_key(
            &string(&case["channel"]),
            &string(&case["rule"]),
            &string(&case["user"]),
        );
        if case.get("error").is_none() {
            let expected = case["count"].as_f64().unwrap_or(0.0);
            assert_eq!(number(&case["resultBits"]).to_bits(), expected.to_bits());
        }
        if let Some(decision) = decision {
            assert_eq!(events[1]["cmd"], "eval");
            assert_eq!(events[1]["script"], OFFENSE_SCRIPT);
            assert_eq!(units(&events[1]["keys"][0]), counter.units());
            assert_eq!(
                events[1]["keyHex"][0],
                hex(counter.to_utf8_lossy().as_bytes())
            );
            assert_eq!(
                units(&events[1]["keys"][1]),
                offense_receipt_key(decision).units()
            );
            assert_eq!(
                events[1]["keyHex"][1],
                hex(offense_receipt_key(decision).to_utf8_lossy().as_bytes())
            );
            assert_eq!(
                events[1]["arguments"][0],
                offense_window_text(number(&case["windowBits"]))
            );
            assert_eq!(events.len(), 2);
        } else {
            assert_eq!(events[1]["cmd"], "incr");
            assert_eq!(units(&events[1]["key"]), counter.units());
            assert_eq!(events[1]["keyHex"], hex(counter.to_utf8_lossy().as_bytes()));
            if events.len() == 3 {
                assert_eq!(events[2]["cmd"], "expire");
                assert_eq!(
                    events[2]["secondsText"],
                    offense_window_text(number(&case["windowBits"]))
                );
            }
            if case.get("error").is_none() {
                assert_eq!(events.len(), if case["count"] == 1 { 3 } else { 2 });
            }
        }
    }
    assert_eq!(
        corpus["abandonedCase"]["beforeRelease"],
        serde_json::json!(["connect", "incr"])
    );
    assert_eq!(
        corpus["abandonedCase"]["afterRelease"],
        serde_json::json!(["connect", "incr", "expire"])
    );
    assert_eq!(corpus["abandonedCase"]["secondsText"], "60");
}
