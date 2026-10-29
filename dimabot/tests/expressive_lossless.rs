#![cfg(feature = "tts-utilities")]

use dima_rust::utils::{
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    tts::{
        TtsLanguage, TtsMode, TtsProvider,
        credit_fallback::{
            AiCreditStatus, CreditFallbackRequest, filter_fallback_text,
            resolve_tts_for_credit_status,
        },
        filter_expressive_tts_tags, filter_expressive_tts_tags_js, normalize_expressive_tags,
        normalize_expressive_tags_json, reinforce_fish_tts_tags, reinforce_fish_tts_tags_js,
        resolve_kokoro_voice_json,
        settings::normalize_channel_tts_settings,
    },
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn with_unit(before: &str, unit: u16, after: &str) -> JsString {
    JsString::from_units(
        before
            .encode_utf16()
            .chain([unit])
            .chain(after.encode_utf16())
            .collect(),
    )
}

#[test]
fn surrogate_boundaries_survive_filter_and_reinforcement() {
    let enabled = normalize_expressive_tags(&Value::Null);
    let input = JsString::from_units(vec![0xd800, 91, 72, 65, 80, 80, 89, 93, 0xdc00]);
    assert_eq!(
        filter_expressive_tts_tags_js(&input, TtsProvider::Fish, Some(&enabled)).to_json_string(),
        "\"\\ud800[happy]\\udc00\""
    );
    assert_eq!(
        filter_fallback_text(&input).units(),
        vec![0xd800, 32, 0xdc00]
    );
    let inside = JsString::from_units(vec![91, 0xd800, 93, 0xdc00]);
    assert_eq!(
        filter_expressive_tts_tags_js(&inside, TtsProvider::Fish, Some(&enabled)).units(),
        vec![0xdc00]
    );
    let repeated = with_unit("[happy]", 0xd800, "[happy]");
    assert_eq!(
        reinforce_fish_tts_tags_js(&repeated),
        with_unit("[happy] [happy]", 0xd800, "[happy] [happy]")
    );
}

#[test]
fn filtering_keeps_js_whitespace_and_ascii_angle_matching_rules() {
    let enabled = normalize_expressive_tags(&Value::Null);
    let input = with_unit(
        "\u{feff}  ",
        0xd800,
        "[ HAPPY ]  [unknown]\t\t< / long - pause >😀\u{feff}",
    );
    assert_eq!(
        filter_expressive_tts_tags_js(&input, TtsProvider::Fish, Some(&enabled)),
        with_unit("", 0xd800, "[happy] \t\t</long-pause>😀")
    );
    assert_eq!(
        filter_fallback_text(&input),
        with_unit("", 0xd800, " \t\t😀")
    );

    // /i without /u cannot fold a non-ASCII angle character to ASCII. Square
    // names instead use toLowerCase, so the Kelvin sign can name the break alias.
    let partial = BTreeMap::from([("pause".to_owned(), true), ("shouting".to_owned(), false)]);
    let input = with_unit("", 0xdc00, "<ſoft>[breaK][LOUD]\u{a0}[crying loudly]x");
    assert_eq!(
        filter_expressive_tts_tags_js(&input, TtsProvider::Fish, Some(&partial)),
        with_unit("", 0xdc00, "<ſoft>[pause] \u{a0} x")
    );
    assert_eq!(
        filter_expressive_tts_tags_js(&input, TtsProvider::Fish, None),
        with_unit("", 0xdc00, "<ſoft> \u{a0} x")
    );

    let valid = "😀 < HAPPY > [crowd laughing]  text\t\tend";
    let wrapped = JsString::from(valid);
    assert!(wrapped.as_str().is_some());
    assert_eq!(
        filter_expressive_tts_tags_js(&wrapped, TtsProvider::Fish, Some(&enabled)).as_str(),
        Some(filter_expressive_tts_tags(valid, TtsProvider::Fish, Some(&enabled)).as_str())
    );
}

#[test]
fn reinforcement_retains_exact_repeat_groups_and_unknown_boundaries() {
    let input = with_unit(
        "[happy]\u{a0}\t[happy][happy]😀",
        0xd800,
        "[happy][unknown][happy]",
    );
    let expected = with_unit(
        "[happy]\u{a0}\t[happy][happy]😀",
        0xd800,
        "[happy] [happy][unknown][happy] [happy]",
    );
    let actual = reinforce_fish_tts_tags_js(&input);
    assert_eq!(actual, expected);
    assert_eq!(reinforce_fish_tts_tags_js(&actual), actual);

    let inside = with_unit("[hap", 0xdc00, "py] [happy]");
    assert_eq!(
        reinforce_fish_tts_tags_js(&inside),
        with_unit("[hap", 0xdc00, "py] [happy] [happy]")
    );
    let valid = "[HAPPY] [anger] [happy][happy] [happy]x[happy]";
    assert_eq!(
        reinforce_fish_tts_tags_js(&valid.into()).as_str(),
        Some(reinforce_fish_tts_tags(valid).as_str())
    );
    assert_eq!(
        reinforce_fish_tts_tags(valid),
        "[HAPPY] [anger] [happy][happy] [happy]x[happy] [happy]"
    );
}

#[test]
fn ordinary_json_nullish_precedence_and_credit_caller_use_shared_policy() {
    let enabled = normalize_expressive_tags(&json!({
        "happy": "true",
        "calm": null,
        "inline": {"happy": false, "longPause": false},
        "wrapping": {"calm": false, "longPause": true}
    }));
    assert!(enabled["happy"]);
    assert!(!enabled["calm"]);
    assert!(!enabled["long-pause"]);

    let request = CreditFallbackRequest {
        mode: TtsMode::Clone,
        text: with_unit("[happy]😀", 0xd800, "<whisper>[unknown]x"),
        provider: TtsProvider::Fish,
        model: Some("s2.1".into()),
        language: TtsLanguage::En,
        voice: "fish-id".into(),
        clone_name: Some("clone".into()),
        piper_fallback_voice: None,
        kokoro_fallback_voice: Some(" AF_BELLA ".into()),
        extra: (),
    };
    let result = resolve_tts_for_credit_status(&request, AiCreditStatus::Exhausted, Some("pro"));
    assert_eq!(result.provider, TtsProvider::Kokoro);
    assert_eq!(result.text, with_unit("😀", 0xd800, " x"));
    assert_eq!(result.voice.as_str(), Some("af_bella"));
    assert_eq!(result.mode, TtsMode::Speak);
}

#[test]
fn lossless_json_adapters_and_settings_share_policy() {
    let config = parse_json(r#"{"happy":"\ud800","sad":null,"long-pause":null,"inline":{"happy":false,"sad":null,"longPause":false},"wrapping":{"sad":false,"longPause":true},"\udc00":false,"unknown":false,"angry":true,"angry":false}"#).unwrap();
    let normalized = normalize_expressive_tags_json(Some(&config));
    assert_eq!(normalized.len(), 75);
    assert!(normalized["happy"]);
    assert!(!normalized["sad"]);
    assert!(!normalized["long-pause"]);
    assert!(!normalized["angry"]);
    for raw in ["null", "false", "12", "\"text\"", "[]"] {
        let value = parse_json(raw).unwrap();
        assert!(
            normalize_expressive_tags_json(Some(&value))
                .values()
                .all(|v| *v)
        );
        assert_eq!(resolve_kokoro_voice_json(&value), None);
    }
    assert!(normalize_expressive_tags_json(None).values().all(|v| *v));
    assert_eq!(
        resolve_kokoro_voice_json(&parse_json(r#""af_heart\ud800""#).unwrap()),
        None
    );
    assert_eq!(
        resolve_kokoro_voice_json(&parse_json(r#"" af_Kore ""#).unwrap()).as_deref(),
        Some("af_kore")
    );

    let input = JsonValue::Object(vec![
        (
            JsString::from("filters"),
            JsonValue::Object(vec![(JsString::from("expressiveTags"), config)]),
        ),
        (
            JsString::from("voices"),
            parse_json(r#"{"kokoroDefault":" af_Kore "}"#).unwrap(),
        ),
    ]);
    let output =
        normalize_channel_tts_settings(Some(&input), &"id".into(), &"channel".into()).unwrap();
    let tags = output
        .get("filters")
        .unwrap()
        .get("expressiveTags")
        .unwrap();
    assert_eq!(tags.get("happy"), Some(&JsonValue::Bool(true)));
    assert_eq!(tags.get("sad"), Some(&JsonValue::Bool(false)));
    assert_eq!(tags.get("long-pause"), Some(&JsonValue::Bool(false)));
    assert_eq!(
        output.get("voices").unwrap().get("kokoroDefault"),
        Some(&JsonValue::String("af_kore".into()))
    );
}
