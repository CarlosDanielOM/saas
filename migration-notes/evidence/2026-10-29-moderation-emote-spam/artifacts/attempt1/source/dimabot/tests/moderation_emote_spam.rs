#![cfg(feature = "moderation-emote-spam")]
use dima_rust::utils::moderation::emote_spam::{
    EmoteSpamInput, EmoteSpamRule, evaluate_emote_spam_rule,
};

#[test]
fn boundary_and_nullish() {
    let rule = EmoteSpamRule {
        max_emote_count: 10.0,
    };
    for (count, triggered) in [(None, false), (Some(10.0), false), (Some(11.0), true)] {
        let result = evaluate_emote_spam_rule(rule, EmoteSpamInput { emote_count: count });
        assert_eq!(result.triggered, triggered);
        assert_eq!(result.emote_count.to_bits(), count.unwrap_or(0.0).to_bits());
    }
}

#[test]
fn ieee_values_are_not_normalized() {
    for value in [
        -0.0,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NAN,
        f64::from_bits(1),
    ] {
        let result = evaluate_emote_spam_rule(
            EmoteSpamRule {
                max_emote_count: 0.0,
            },
            EmoteSpamInput {
                emote_count: Some(value),
            },
        );
        assert_eq!(result.triggered, value > 0.0);
        assert_eq!(result.emote_count.to_bits(), value.to_bits());
    }
}

#[test]
#[ignore = "external pinned actual-source corpus required"]
fn replay_actual_source_oracle() {
    use dima_rust::utils::json_number::number_string;
    use serde_json::Value;
    let dir = std::env::var("DIMA_EMOTE_SPAM_REFERENCE_DIR").expect("oracle directory");
    let bytes =
        std::fs::read(std::path::Path::new(&dir).join("moderation_emote_spam_reference.json"))
            .expect("oracle corpus");
    let data: Value = serde_json::from_slice(&bytes).expect("valid JSON");
    let meta = &data["metadata"];
    assert_eq!(meta["node"], "v24.22.1");
    assert_eq!(meta["v8"], "13.6.233.17-node.58");
    assert_eq!(meta["typescript"], "5.9.3");
    assert_eq!(
        meta["hashes"]["source"],
        "24e7c603569d1063642575372de1066e4f5d5d5de46c88e15e450a549c17f12f"
    );
    let cases = data["cases"].as_array().unwrap();
    assert_eq!(meta["total"].as_u64().unwrap() as usize, cases.len());
    assert!(cases.len() >= 100);
    let bits = |text: &str| f64::from_bits(u64::from_str_radix(text, 16).unwrap());
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let count = case["countBits"].as_str().map(bits);
        let result = evaluate_emote_spam_rule(
            EmoteSpamRule {
                max_emote_count: bits(case["limitBits"].as_str().unwrap()),
            },
            EmoteSpamInput { emote_count: count },
        );
        assert_eq!(
            result.triggered,
            case["triggered"].as_bool().unwrap(),
            "{id}"
        );
        assert_eq!(
            format!("{:016x}", result.emote_count.to_bits()),
            case["resultBits"].as_str().unwrap(),
            "{id}"
        );
        let number = if result.emote_count.is_finite() {
            number_string(result.emote_count)
        } else {
            "null".into()
        };
        let wire = format!(
            "{{\"triggered\":{},\"emoteCount\":{}}}",
            result.triggered, number
        );
        assert_eq!(wire, case["wire"].as_str().unwrap(), "{id}");
    }
}
