#![cfg(feature = "moderation-permit")]
use dima_rust::utils::{js_string::JsString, moderation::permit::*};
use serde_json::Value;
use std::path::PathBuf;

// Reused independent raw-byte hash helper from ast_evaluator_bench.rs.
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
fn s(v: &Value) -> JsString {
    JsString::from_units(units(v))
}
fn bits(v: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(v.as_str().unwrap(), 16).unwrap())
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn parse_keys_and_grant_plan() {
    let arg = |s: &str| JsString::from(s);
    assert_eq!(
        parse_permit_args(&[]),
        PermitParseResult::Target(PermitTarget {
            login: None,
            seconds: 60
        })
    );
    assert_eq!(
        parse_permit_args(&[arg(" @HELLO "), arg("0600")]),
        PermitParseResult::Target(PermitTarget {
            login: Some(arg("hello")),
            seconds: 600
        })
    );
    assert_eq!(
        parse_permit_args(&[arg(&"9".repeat(500))]),
        PermitParseResult::Error(DURATION_ERROR)
    );
    assert_eq!(
        parse_permit_args(&[arg("1"), arg("u")]),
        PermitParseResult::Error(PERMIT_USAGE)
    );
    let channel = JsString::from_units(vec![0xd800]);
    let login = arg("İ");
    let key = permit_user_key(&channel, &login);
    assert_eq!(key.to_utf8_lossy(), "moderation:�:permit:user:i\u{307}");
    let grant = grant_plan(&channel, 60.0, Some(&login), 1_700_000_000_123.0);
    assert_eq!(grant.key, key);
    assert_eq!(grant.value, "1700000060123");
    assert_eq!(grant.seconds, "60");
    assert_eq!(
        grant_plan(&channel, 0.0, Some(&arg("")), 0.0).key,
        permit_channel_key(&channel)
    );
}

#[test]
#[ignore = "requires actual-TypeScript pinned external fixture"]
fn replay_actual_permit_source() {
    let dir = PathBuf::from(
        std::env::var_os("DIMA_PERMIT_FIXTURE_DIR").expect("external fixture directory required"),
    );
    assert!(dir.is_absolute());
    assert_eq!(dir.canonicalize().unwrap(), dir);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(!dir.starts_with(root));
    let expected_hash =
        std::env::var("DIMA_PERMIT_FIXTURE_SHA256").expect("fixture SHA-256 required");
    assert_eq!(expected_hash.len(), 64);
    assert!(
        expected_hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let data = std::fs::read(dir.join("moderation-permit-reference.json")).unwrap();
    assert_eq!(sha256_hex(&data), expected_hash);
    let fixture: Value = serde_json::from_slice(&data).unwrap();
    assert_eq!(fixture["format"], 1);
    assert_eq!(fixture["implementation"], "actual-typescript");
    assert_eq!(
        fixture["nodeExecutableSha256"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    for (key, expected) in [
        ("node", "24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("icu", "78.3"),
        ("unicode", "17.0"),
        ("typescript", "5.9.3"),
    ] {
        assert_eq!(fixture["versions"][key], expected);
    }
    let files = [
        (
            "src/utils/moderation/permit.ts",
            include_bytes!("../src/utils/moderation/permit.ts").as_slice(),
        ),
        (
            "src/utils/moderation/permit.rs",
            include_bytes!("../src/utils/moderation/permit.rs").as_slice(),
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
            "src/utils/js_string.rs",
            include_bytes!("../src/utils/js_string.rs").as_slice(),
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
            "src/utils/js_compat.rs",
            include_bytes!("../src/utils/js_compat.rs").as_slice(),
        ),
        (
            "src/utils/json_number.rs",
            include_bytes!("../src/utils/json_number.rs").as_slice(),
        ),
        (
            "tests/moderation_permit.rs",
            include_bytes!("moderation_permit.rs").as_slice(),
        ),
        (
            "tests/moderation_permit_redis.rs",
            include_bytes!("moderation_permit_redis.rs").as_slice(),
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
            include_bytes!("fixtures/moderation_permit_reference.cjs").as_slice(),
        ),
    ];
    for (key, bytes) in files {
        assert_eq!(
            sha256_hex(bytes),
            fixture["sourceSha256"][key].as_str().unwrap(),
            "hash {key}"
        );
    }
    assert_eq!(fixture["constants"]["min"], PERMIT_MIN_SECONDS);
    assert_eq!(fixture["constants"]["max"], PERMIT_MAX_SECONDS);
    assert_eq!(fixture["constants"]["default"], PERMIT_DEFAULT_SECONDS);
    assert_eq!(fixture["constants"]["usage"], PERMIT_USAGE);
    for row in fixture["logins"].as_array().unwrap() {
        assert_eq!(
            normalize_permit_login(&s(&row["input"])).units(),
            units(&row["output"])
        );
    }
    let parses = fixture["parsed"].as_array().unwrap();
    assert!(parses.len() >= 300);
    for row in parses {
        let args: Vec<JsString> = row["args"].as_array().unwrap().iter().map(s).collect();
        match parse_permit_args(&args) {
            PermitParseResult::Error(error) => {
                assert_eq!(row["result"]["error"], error, "args {args:?}")
            }
            PermitParseResult::Target(target) => {
                assert!(row["result"].get("error").is_none());
                let login = &row["result"]["login"];
                assert_eq!(
                    target.login.map(|v| v.units()),
                    if login.is_null() {
                        None
                    } else {
                        Some(units(login))
                    }
                );
                assert_eq!(row["result"]["seconds"], target.seconds);
            }
        }
    }
    for row in fixture["keys"].as_array().unwrap() {
        let channel = s(&row["channel"]);
        let login = s(&row["login"]);
        let user = permit_user_key(&channel, &login);
        let all = permit_channel_key(&channel);
        assert_eq!(user.units(), units(&row["user"]));
        assert_eq!(all.units(), units(&row["all"]));
        assert_eq!(
            hex(user.to_utf8_lossy().as_bytes()),
            row["userHex"].as_str().unwrap()
        );
        assert_eq!(
            hex(all.to_utf8_lossy().as_bytes()),
            row["allHex"].as_str().unwrap()
        );
    }
    for row in fixture["grants"].as_array().unwrap() {
        let login = if row["login"].is_null() {
            None
        } else {
            Some(s(&row["login"]))
        };
        let channel = JsString::from_units(vec![b'c' as u16, b'h' as u16, 0xd800]);
        let plan = grant_plan(
            &channel,
            bits(&row["secondsBits"]),
            login.as_ref(),
            bits(&row["nowBits"]),
        );
        let events = row["events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["caller"], "moderation.grantPermit");
        let event = &events[1];
        assert_eq!(event["cmd"], "set");
        assert_eq!(plan.key.units(), units(&event["key"]));
        assert_eq!(
            hex(plan.key.to_utf8_lossy().as_bytes()),
            event["keyHex"].as_str().unwrap()
        );
        assert_eq!(plan.value, event["value"].as_str().unwrap());
        assert_eq!(plan.seconds, event["exString"].as_str().unwrap());
        assert_eq!(row["secondsBits"], event["exBits"]);
    }
    let reads = fixture["reads"].as_array().unwrap();
    assert_eq!(reads.len(), 8);
    for row in reads {
        let events = row["events"].as_array().unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["caller"], "moderation.hasActivePermit");
        assert_eq!(events[1]["cmd"], "get");
        assert_eq!(events[2]["cmd"], "get");
        assert_eq!(
            permit_user_key(&s(&row["channel"]), &s(&row["login"])).units(),
            units(&events[1]["key"])
        );
        assert_eq!(
            permit_channel_key(&s(&row["channel"])).units(),
            units(&events[2]["key"])
        );
        match row["scenario"].as_str().unwrap() {
            "none" => assert_eq!(row["result"]["active"], false),
            "user" | "channel" | "both" | "empty-user" => assert_eq!(row["result"]["active"], true),
            _ => assert_eq!(row["result"]["error"], true),
        }
    }
    let held = fixture["heldReads"].as_array().unwrap();
    assert_eq!(held.len(), 2);
    for (case, failed) in held.iter().zip(["user", "channel"]) {
        assert_eq!(case["failed"], failed);
        assert_eq!(case["error"], true);
        assert_eq!(
            case["beforeRelease"],
            serde_json::json!(["connect", "get", "get"])
        );
        assert_eq!(
            case["afterRelease"],
            serde_json::json!(["connect", "get", "get", "released"])
        );
    }
    // The native unit read_tasks_keep_parent_telemetry_context asserts this
    // same parent in each read future; this records the actual source result.
    let context_case = &fixture["contextCase"];
    let parent = serde_json::json!({
        "traceId": "0123456789abcdef0123456789abcdef",
        "spanId": "0123456789abcdef",
        "sampled": true,
        "channel": "permit_channel"
    });
    assert_eq!(context_case["parent"], parent);
    assert_eq!(context_case["result"], false);
    let context_reads = context_case["reads"].as_array().unwrap();
    assert_eq!(context_reads.len(), 2);
    for read in context_reads {
        assert_eq!(read["context"], parent);
    }
    let channel = JsString::from("permit_channel");
    let login = JsString::from("USER");
    assert_eq!(
        units(&context_reads[0]["key"]),
        permit_user_key(&channel, &login).units()
    );
    assert_eq!(
        units(&context_reads[1]["key"]),
        permit_channel_key(&channel).units()
    );
    assert_eq!(fixture["setFailure"]["error"], true);
}
