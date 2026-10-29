#![cfg(feature = "moderation-caps")]
use dima_rust::utils::js_string::JsString;
use dima_rust::utils::moderation::caps::{
    CapsEvaluationInput, CapsRule, CapsThresholdMode, evaluate_caps_rule, strip_emote_texts,
};

fn rule(mode: CapsThresholdMode, min: f64, max: f64, length: f64) -> CapsRule {
    CapsRule {
        caps_threshold_mode: mode,
        min_caps_count: min,
        max_caps_percentage: max,
        min_message_length: length,
    }
}

#[test]
fn unicode_emotes_and_counting() {
    let text = JsString::from("AΩ漢ǅʰe\u{301}𐐀𐐨😀 KAPPA");
    let emotes = [JsString::from("KAPPA")];
    let result = evaluate_caps_rule(
        rule(CapsThresholdMode::Count, 3.0, 0.0, 0.0),
        CapsEvaluationInput {
            text: Some(&text),
            emote_texts: Some(&emotes),
        },
    );
    assert_eq!(
        (result.caps_count, result.letter_count, result.triggered),
        (3, 8, true)
    );
    assert_eq!(result.caps_percentage.to_bits(), 37.5_f64.to_bits());
    let text = JsString::from_units(vec![0xd83d, 0xde00, 65, 0xd800]);
    let emotes = [JsString::from_units(vec![0xd83d])];
    assert_eq!(
        strip_emote_texts(&text, Some(&emotes)).units(),
        vec![32, 0xde00, 65, 0xd800]
    );
}

#[test]
fn replacements_and_numeric_boundaries() {
    let text = JsString::from("aaaaa $& ABC");
    let emotes = [
        JsString::from("aa"),
        JsString::from("$&"),
        JsString::from(""),
    ];
    assert_eq!(
        strip_emote_texts(&text, Some(&emotes)).as_str(),
        Some("  a   ABC")
    );
    let text = JsString::from("!!!");
    let result = evaluate_caps_rule(
        rule(CapsThresholdMode::Percentage, 0.0, 0.0, 0.0),
        CapsEvaluationInput {
            text: Some(&text),
            emote_texts: None,
        },
    );
    assert!(result.triggered);
    assert_eq!(result.caps_percentage.to_bits(), 0.0_f64.to_bits());
    let result = evaluate_caps_rule(
        rule(CapsThresholdMode::Count, f64::NAN, 0.0, f64::NAN),
        CapsEvaluationInput {
            text: Some(&text),
            emote_texts: None,
        },
    );
    assert!(!result.triggered);
}

#[test]
fn nullish_text_uses_empty_string() {
    let zero = evaluate_caps_rule(
        rule(CapsThresholdMode::Percentage, 0.0, 0.0, 0.0),
        CapsEvaluationInput {
            text: None,
            emote_texts: None,
        },
    );
    assert!(zero.triggered);
    assert_eq!(
        (
            zero.caps_count,
            zero.letter_count,
            zero.caps_percentage.to_bits()
        ),
        (0, 0, 0.0_f64.to_bits())
    );
    let guarded = evaluate_caps_rule(
        rule(CapsThresholdMode::Count, 0.0, 0.0, 1.0),
        CapsEvaluationInput {
            text: None,
            emote_texts: Some(&[JsString::from("A")]),
        },
    );
    assert!(!guarded.triggered);
    assert_eq!((guarded.caps_count, guarded.letter_count), (0, 0));
}

// Exact behavior cases from the archived caps.rule.test.ts; source oracle
// and pinned Unicode range replay provide the independent comparison.
#[test]
fn archived_caps_test_examples() {
    let count = rule(CapsThresholdMode::Count, 8.0, 70.0, 10.0);
    let percentage = rule(CapsThresholdMode::Percentage, 8.0, 70.0, 10.0);
    let run = |r, text: &str| {
        evaluate_caps_rule(
            r,
            CapsEvaluationInput {
                text: Some(&JsString::from(text)),
                emote_texts: None,
            },
        )
    };
    let loud = run(count, "THIS IS WAY TOO LOUD");
    assert!(loud.triggered);
    assert_eq!((loud.caps_count, loud.letter_count), (16, 16));
    let quiet = run(count, "HELLO how are you today friend");
    assert!(!quiet.triggered);
    assert_eq!(quiet.caps_count, 5);
    let digits = run(count, "GG123!!!????");
    assert!(!digits.triggered);
    assert_eq!(digits.letter_count, 2);
    assert!(!run(count, "GG").triggered);
    assert!(!run(count, "LOL OMG").triggered);
    let mostly = run(percentage, "THIS IS MOSTLY CAPS now ok");
    assert!(mostly.triggered && mostly.caps_percentage >= 70.0);
    assert!(
        !run(
            percentage,
            "This is a totally normal sentence with A FEW caps words"
        )
        .triggered
    );
    let short = run(percentage, "LOL");
    assert!(!short.triggered);
    assert_eq!(short.caps_percentage, 100.0);
    let accented = run(count, "ÁÉÍÓÚ ÜÑÇ ĤÊĽĻÕ");
    assert!(accented.triggered);
    assert_eq!(accented.caps_count, accented.letter_count);
    let lowercase = run(count, "áéíóú üñç ça va très bien");
    assert!(!lowercase.triggered);
    assert_eq!(lowercase.caps_count, 0);
    let text = JsString::from("KAPPA KAPPA KAPPA KAPPA hello there friend");
    let emotes = [JsString::from("KAPPA")];
    let stripped = evaluate_caps_rule(
        count,
        CapsEvaluationInput {
            text: Some(&text),
            emote_texts: Some(&emotes),
        },
    );
    assert!(!stripped.triggered);
    assert_eq!(stripped.caps_count, 0);
    let hello = JsString::from("HELLO WORLD");
    assert_eq!(strip_emote_texts(&hello, None).as_ref(), &hello);
    assert_eq!(strip_emote_texts(&hello, Some(&[])).as_ref(), &hello);
    assert_eq!(
        strip_emote_texts(&JsString::from("KAPPA hello"), Some(&emotes)).as_str(),
        Some("  hello")
    );
    let empty = run(count, "");
    assert!(!empty.triggered);
    assert_eq!(empty.letter_count, 0);
}

#[test]
#[ignore = "external pinned actual-source corpus required"]
fn replay_actual_source() {
    use dima_rust::utils::json_number::number_string;
    use serde_json::Value;
    let dir = std::env::var("DIMA_CAPS_REFERENCE_DIR").expect("reference directory");
    let data: Value = serde_json::from_slice(
        &std::fs::read(std::path::Path::new(&dir).join("moderation_caps_reference.json")).unwrap(),
    )
    .unwrap();
    let meta = &data["metadata"];
    assert_eq!(
        meta["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    assert_eq!(
        meta["hashes"]["src/utils/moderation/caps_unicode_data.rs"],
        "f47a1f1595777a04f8f97a688a7ca663b949936a1c92758a83b6860abdd4c344"
    );
    let cases = data["cases"].as_array().unwrap();
    assert_eq!(meta["total"].as_u64().unwrap() as usize, cases.len());
    assert!(cases.len() > 3000);
    let units = |v: &Value| {
        v.as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u16)
            .collect::<Vec<_>>()
    };
    let bits = |v: &Value| f64::from_bits(u64::from_str_radix(v.as_str().unwrap(), 16).unwrap());
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let text = match case["textKind"].as_str().unwrap() {
            "string" => Some(JsString::from_units(units(&case["text"]))),
            "missing" | "null" => {
                assert!(case["text"].is_null());
                None
            }
            _ => panic!("invalid text kind"),
        };
        let emotes = case["emotes"].as_array().map(|a| {
            a.iter()
                .map(|v| JsString::from_units(units(v)))
                .collect::<Vec<_>>()
        });
        let mode = match case["mode"].as_str().unwrap() {
            "count" => CapsThresholdMode::Count,
            "percentage" => CapsThresholdMode::Percentage,
            _ => panic!("invalid mode"),
        };
        let result = evaluate_caps_rule(
            rule(
                mode,
                bits(&case["min"]),
                bits(&case["max"]),
                bits(&case["length"]),
            ),
            CapsEvaluationInput {
                text: text.as_ref(),
                emote_texts: emotes.as_deref(),
            },
        );
        let empty = JsString::from_static("");
        assert_eq!(
            strip_emote_texts(text.as_ref().unwrap_or(&empty), emotes.as_deref()).units(),
            units(&case["stripped"]),
            "{id}"
        );
        assert_eq!(
            result.triggered,
            case["triggered"].as_bool().unwrap(),
            "{id}"
        );
        assert_eq!(
            result.caps_count as u64,
            case["capsCount"].as_u64().unwrap(),
            "{id}"
        );
        assert_eq!(
            result.letter_count as u64,
            case["letterCount"].as_u64().unwrap(),
            "{id}"
        );
        assert_eq!(
            result.caps_percentage.to_bits(),
            bits(&case["percentage"]).to_bits(),
            "{id}"
        );
        let wire = format!(
            "{{\"triggered\":{},\"capsCount\":{},\"letterCount\":{},\"capsPercentage\":{}}}",
            result.triggered,
            result.caps_count,
            result.letter_count,
            number_string(result.caps_percentage)
        );
        assert_eq!(wire, case["wire"].as_str().unwrap(), "{id}");
    }
}
