#![cfg(feature = "moderation-seed-plan")]
use dima_rust::utils::{
    js_string::JsString,
    moderation::seed_plan::{
        Candidate, ModerationSeedPlan, existing_channel_moderation_view,
        existing_channel_moderation_view_json, is_untouched_lazy_stub, plan_moderation_seed,
    },
};
use serde_json::Value;
use std::path::PathBuf;
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

#[test]
fn plans_and_ordered_views_cover_boundaries() {
    let stub = Candidate {
        enabled: Some(false),
        rules_len: None,
        settings_version: None,
    };
    assert!(is_untouched_lazy_stub(Some(&stub)));
    assert_eq!(plan_moderation_seed(None), ModerationSeedPlan::Create);
    assert_eq!(
        plan_moderation_seed(Some(&stub)),
        ModerationSeedPlan::ReplaceStub
    );
    for v in [0.0, 1.00000001, f64::NAN, f64::INFINITY] {
        assert_eq!(
            plan_moderation_seed(Some(&Candidate {
                settings_version: Some(v),
                ..stub
            })),
            ModerationSeedPlan::Keep
        );
    }
    assert_eq!(
        plan_moderation_seed(Some(&Candidate {
            rules_len: Some(1),
            ..stub
        })),
        ModerationSeedPlan::Keep
    );
    assert_eq!(
        plan_moderation_seed(Some(&Candidate {
            enabled: None,
            ..stub
        })),
        ModerationSeedPlan::Keep
    );
    let id = JsString::from_units(vec![0xd800]);
    let name = JsString::from("😀");
    let mut first = existing_channel_moderation_view(&id, &name);
    let second = existing_channel_moderation_view(&id, &name);
    assert_eq!(first.channel_id, &id);
    assert_eq!(first.channel, &name);
    assert!(!first.enabled);
    assert_eq!(first.offense_window_seconds, 3600.0);
    assert_eq!(first.settings_version, 1.0);
    assert!(first.rules.is_empty());
    first.enabled = true;
    first.offense_window_seconds = 9.0;
    first.settings_version = 2.0;
    first.rules.push(
        dima_rust::schemas::channel_moderation_settings::build_default_moderation_rules().remove(0),
    );
    assert!(!second.enabled);
    assert_eq!(second.offense_window_seconds, 3600.0);
    assert_eq!(second.settings_version, 1.0);
    assert!(second.rules.is_empty());
    assert_eq!(
        existing_channel_moderation_view_json(&id, &name),
        r#"{"channelID":"\ud800","channel":"😀","enabled":false,"offenseWindowSeconds":3600,"rules":[],"settingsVersion":1}"#
    );
}
#[test]
#[ignore = "requires pinned disconnected actual-source fixture"]
fn replay_actual_seed_plan() {
    let dir =
        PathBuf::from(std::env::var_os("DIMA_SEED_PLAN_FIXTURE_DIR").expect("fixture directory"));
    assert!(dir.is_absolute());
    assert_eq!(dir.canonicalize().unwrap(), dir);
    assert!(
        !dir.starts_with(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .canonicalize()
                .unwrap()
        )
    );
    let digest = std::env::var("DIMA_SEED_PLAN_FIXTURE_SHA256").expect("fixture digest");
    let raw = std::fs::read(dir.join("moderation-seed-plan-reference.json")).unwrap();
    assert_eq!(sha256_hex(&raw), digest);
    let data: Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(data["format"], 1);
    assert_eq!(
        data["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    // The fixture reader accepts exactly one regular, non-symlink source.
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    let logical = "src/utils/moderation/seed_plan.ts";
    let live = root.join(logical);
    let archive = root
        .parent()
        .unwrap()
        .join("archives/dimabot-typescript/2026-10-28")
        .join(logical);
    let candidates: Vec<_> = [live, archive]
        .into_iter()
        .filter(|path| match std::fs::symlink_metadata(path) {
            Ok(_) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => panic!("source metadata: {e}"),
        })
        .collect();
    assert_eq!(
        candidates.len(),
        1,
        "exactly one live/archive seed source required"
    );
    assert!(
        std::fs::symlink_metadata(&candidates[0])
            .unwrap()
            .file_type()
            .is_file(),
        "source must be a regular non-symlink file"
    );
    let seed_source = std::fs::read(&candidates[0]).unwrap();
    assert_eq!(
        sha256_hex(&seed_source),
        data["hashes"][logical].as_str().unwrap()
    );
    for (name, bytes) in [
        (
            "src/utils/moderation/seed_plan.rs",
            include_bytes!("../src/utils/moderation/seed_plan.rs").as_slice(),
        ),
        (
            "src/schemas/channel_moderation_settings.schema.ts",
            include_bytes!("../src/schemas/channel_moderation_settings.schema.ts").as_slice(),
        ),
        (
            "src/schemas/channel_moderation_settings.schema.rs",
            include_bytes!("../src/schemas/channel_moderation_settings.schema.rs").as_slice(),
        ),
        (
            "src/schemas/schema.rs",
            include_bytes!("../src/schemas/schema.rs").as_slice(),
        ),
        (
            "src/utils/moderation/spam_categories.ts",
            include_bytes!("../src/utils/moderation/spam_categories.ts").as_slice(),
        ),
        (
            "src/utils/moderation/spam_categories.rs",
            include_bytes!("../src/utils/moderation/spam_categories.rs").as_slice(),
        ),
        (
            "src/utils/js_string.rs",
            include_bytes!("../src/utils/js_string.rs").as_slice(),
        ),
        (
            "src/utils/json_number.rs",
            include_bytes!("../src/utils/json_number.rs").as_slice(),
        ),
        (
            "src/utils/js_compat.rs",
            include_bytes!("../src/utils/js_compat.rs").as_slice(),
        ),
        (
            "tests/moderation_seed_plan.rs",
            include_bytes!("moderation_seed_plan.rs").as_slice(),
        ),
        (
            "tests/fixtures/moderation_source_resolver.cjs",
            include_bytes!("fixtures/moderation_source_resolver.cjs").as_slice(),
        ),
        (
            "tests/fixtures/moderation_seed_plan_reference.cjs",
            include_bytes!("fixtures/moderation_seed_plan_reference.cjs").as_slice(),
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
    ] {
        assert_eq!(
            sha256_hex(bytes),
            data["hashes"][name].as_str().unwrap(),
            "{name}"
        );
    }
    let cases = data["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 110);
    for case in cases {
        let candidate = if case.get("label").is_some() {
            None
        } else {
            let enabled = match case["enabled"].as_str().unwrap() {
                "missing" => None,
                "true" => Some(true),
                "false" => Some(false),
                _ => panic!("enabled"),
            };
            let rules_len = match case["rules"].as_str().unwrap() {
                "missing" | "null" => None,
                "empty" => Some(0),
                "nonempty" => Some(1),
                _ => panic!("rules"),
            };
            let settings_version = match case["version"].as_str().unwrap() {
                "missing" | "null" => None,
                "NaN" => Some(f64::NAN),
                "Infinity" => Some(f64::INFINITY),
                v => Some(v.parse().unwrap()),
            };
            Some(Candidate {
                enabled,
                rules_len,
                settings_version,
            })
        };
        assert_eq!(
            is_untouched_lazy_stub(candidate.as_ref()),
            case["expected"]["stub"].as_bool().unwrap()
        );
        assert_eq!(
            plan_moderation_seed(candidate.as_ref()).as_str(),
            case["expected"]["plan"].as_str().unwrap()
        );
    }
    let views = data["views"].as_array().unwrap();
    assert_eq!(views.len(), 5);
    for view in views {
        let units = |name: &str| {
            view[name]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| u16::try_from(v.as_u64().unwrap()).unwrap())
                .collect()
        };
        let id = JsString::from_units(units("idUnits"));
        let name = JsString::from_units(units("nameUnits"));
        assert_eq!(
            existing_channel_moderation_view_json(&id, &name),
            view["wire"].as_str().unwrap()
        );
    }
}
