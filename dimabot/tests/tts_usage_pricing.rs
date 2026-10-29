#![cfg(feature = "tts-utilities")]
use dima_rust::utils::{
    js_string::JsString,
    tts::{calculate_tts_usage, calculate_tts_usage_js},
};
use serde_json::Value;

#[test]
fn pricing_and_wire_examples() {
    let r = calculate_tts_usage("fish", 51.0);
    assert_eq!(
        (r.characters, r.credits_consumed, r.polarsh_cost, r.cost_usd),
        (51.0, 77.0, 0.077, 0.00077)
    );
    assert_eq!(
        r.to_json_string(),
        "{\"characters\":51,\"creditsConsumed\":77,\"polarshCost\":0.077,\"costUsd\":0.00077}"
    );
    assert_eq!(
        calculate_tts_usage("constructor", f64::INFINITY).to_json_string(),
        "{\"characters\":null,\"creditsConsumed\":0,\"polarshCost\":0,\"costUsd\":0}"
    );
    let r = calculate_tts_usage_js(&JsString::from_units(vec![0xd800]), -0.0);
    assert_eq!(r.characters.to_bits(), (-0.0f64).to_bits());
    assert_eq!(r.credits_consumed.to_bits(), (-0.0f64).to_bits());
    assert_eq!(
        r.to_json_string(),
        "{\"characters\":0,\"creditsConsumed\":0,\"polarshCost\":0,\"costUsd\":0}"
    );
}
#[test]
#[cfg(feature = "credit-policy")]
fn shared_credit_policy_api_and_serialization() {
    use dima_rust::utils::{credit_policy, tts};
    let usage: credit_policy::TtsUsageResult = tts::usage::calculate_tts_usage("fish", 51.0);
    assert_eq!(usage, credit_policy::calculate_tts_usage("fish", 51.0));
    assert_eq!(
        serde_json::to_string(&usage).unwrap(),
        "{\"characters\":51.0,\"creditsConsumed\":77.0,\"polarshCost\":0.077,\"costUsd\":0.00077}"
    );
}

fn decode(s: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(s, 16).unwrap())
}
fn same(actual: f64, expected: f64) {
    assert_eq!(actual.to_bits(), expected.to_bits());
}
#[test]
#[ignore = "parent-owned actual-source oracle fixture"]
fn actual_source_pricing() {
    let dir = std::env::var_os("DIMA_TTS_USAGE_FIXTURE_DIR").expect("fixture directory required");
    let bytes = std::fs::read(std::path::Path::new(&dir).join("tts-usage-pricing.json"))
        .expect("fixture required");
    assert!(!bytes.is_empty());
    let fixture: Value = serde_json::from_slice(&bytes).unwrap();
    let meta = &fixture["metadata"];
    assert_eq!(meta["schema"], 1);
    assert_eq!(meta["executionRealm"], "isolated-vm");
    assert_eq!(meta["node"], "v24.22.1");
    assert_eq!(meta["v8"], "13.6.233.17-node.58");
    assert_eq!(meta["typescript"], "5.9.3");
    for key in [
        "source",
        "oracle",
        "package",
        "lock",
        "typescript",
        "typescriptPackage",
        "node",
    ] {
        let hash = meta["hashes"][key].as_str().unwrap();
        assert!(hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit()));
    }
    assert_eq!(
        meta["evidence"]["interface"],
        "export interface TtsUsageResult {\n  characters: number;\n  creditsConsumed: number;\n  /** For Polar.sh _cost field (1 = 1 cent) */\n  polarshCost: number;\n  /** For Polar.sh cost field (in USD) and visual display */\n  costUsd: number;\n}"
    );
    assert_eq!(
        meta["evidence"]["functionSignature"],
        "export function calculateTtsUsage(\n  provider: string,\n  characters: number,\n): TtsUsageResult"
    );
    assert_eq!(
        meta["evidence"]["pricingInitializer"],
        "{\n  piper: 50, // One credit per 50 characters; available even after exhaustion\n  kokoro: 15, // One credit per 15 characters, rounded up\n  fish: 1.5, // 1.5 credits per character\n}"
    );
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 22 * (7 + 12 * 2 * 3));
    for case in cases {
        let provider = JsString::from_units(
            case["provider"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| u16::try_from(v.as_u64().unwrap()).unwrap())
                .collect(),
        );
        let r = calculate_tts_usage_js(&provider, decode(case["characters"].as_str().unwrap()));
        let fields = case["fields"].as_array().unwrap();
        assert_eq!(fields.len(), 4);
        for (actual, expected) in [r.characters, r.credits_consumed, r.polarsh_cost, r.cost_usd]
            .into_iter()
            .zip(fields)
        {
            same(actual, decode(expected.as_str().unwrap()));
        }
        assert_eq!(r.to_json_string(), case["wire"].as_str().unwrap());
    }
}
