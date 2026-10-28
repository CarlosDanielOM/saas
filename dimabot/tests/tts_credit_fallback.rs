#![cfg(feature = "tts-utilities")]
use dima_rust::utils::{
    js_string::JsString,
    tts::{
        TtsLanguage, TtsMode, TtsProvider,
        credit_fallback::{
            AiCreditStatus, CreditFallbackRequest, filter_fallback_text,
            resolve_tts_for_credit_status,
        },
    },
};
use serde_json::{Value, json};
use std::borrow::Cow;

fn units(value: &Value) -> JsString {
    JsString::from_units(
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u16)
            .collect(),
    )
}
fn optional_units(value: &Value) -> Option<JsString> {
    if value.is_null() {
        None
    } else {
        Some(units(value))
    }
}
fn request(value: &Value) -> CreditFallbackRequest<Value> {
    CreditFallbackRequest {
        mode: match value["mode"].as_str().unwrap() {
            "speak" => TtsMode::Speak,
            "ai" => TtsMode::Ai,
            "clone" => TtsMode::Clone,
            _ => panic!("mode"),
        },
        text: units(&value["textUnits"]),
        provider: match value["provider"].as_str().unwrap() {
            "piper" => TtsProvider::Piper,
            "fish" => TtsProvider::Fish,
            "kokoro" => TtsProvider::Kokoro,
            _ => panic!("provider"),
        },
        model: value["model"].as_str().map(JsString::from),
        language: match value["language"].as_str().unwrap() {
            "en" => TtsLanguage::En,
            "es" => TtsLanguage::Es,
            _ => panic!("language"),
        },
        voice: units(&value["voiceUnits"]),
        clone_name: value["cloneName"].as_str().map(JsString::from),
        piper_fallback_voice: optional_units(&value["piperFallbackUnits"]),
        kokoro_fallback_voice: optional_units(&value["kokoroFallbackUnits"]),
        extra: value["extra"].clone(),
    }
}
#[test]
fn borrowed_identity_and_lossless_boundaries() {
    let r = CreditFallbackRequest {
        mode: TtsMode::Clone,
        text: JsString::from_units(vec![
            0x20, 0xd800, 0x20, 0x20, 0x5b, 0x78, 0xdc00, 0x5d, 0x20, 0xdc00, 0x20,
        ]),
        provider: TtsProvider::Fish,
        model: Some("m".into()),
        language: TtsLanguage::Es,
        voice: "v".into(),
        clone_name: Some("c".into()),
        piper_fallback_voice: Some("  ".into()),
        kokoro_fallback_voice: None,
        extra: json!({"unknown":{"x":1}}),
    };
    let same = resolve_tts_for_credit_status(&r, AiCreditStatus::Available, None);
    assert!(matches!(&same, Cow::Borrowed(_)));
    assert!(std::ptr::eq(same.as_ref(), &r));
    let result = resolve_tts_for_credit_status(&r, AiCreditStatus::Unavailable, Some("pro"));
    assert_eq!(result.text.units(), vec![0xd800, 0x20, 0xdc00]);
    assert_eq!(result.voice.as_str(), Some("  "));
    assert_eq!(result.mode, TtsMode::Speak);
    assert_eq!(result.model, None);
    assert_eq!(result.clone_name, None);
    assert_eq!(result.extra, r.extra);
    assert_eq!(
        filter_fallback_text(&JsString::from("  😀 <happy> [x] ok  ")).as_str(),
        Some("😀 ok")
    );
}

/// Requires the freshly generated source oracle; absent or empty files fail.
#[test]
#[ignore = "run with TTS_CREDIT_FALLBACK_FIXTURE pointing to disposable source oracle"]
fn actual_source_replay() {
    let file = std::env::var("TTS_CREDIT_FALLBACK_FIXTURE").expect("fixture path required");
    let doc: Value =
        serde_json::from_slice(&std::fs::read(file).expect("fixture must exist")).unwrap();
    let cases = doc["cases"].as_array().expect("cases required");
    assert!(!cases.is_empty(), "empty source replay");
    for case in cases {
        let input = request(&case["input"]);
        let status = match case["status"].as_str().unwrap() {
            "available" => AiCreditStatus::Available,
            "exhausted" => AiCreditStatus::Exhausted,
            "unavailable" => AiCreditStatus::Unavailable,
            _ => panic!("status"),
        };
        let actual = resolve_tts_for_credit_status(&input, status, case["tier"].as_str());
        assert_eq!(
            matches!(&actual, Cow::Borrowed(_)),
            case["same"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        assert_eq!(
            actual.as_ref(),
            &request(&case["output"]),
            "{}",
            case["name"]
        );
        if !case["same"].as_bool().unwrap() {
            assert!(case["output"].get("model").is_none());
            assert!(case["output"].get("cloneName").is_none());
            assert!(!case["outputJson"].as_str().unwrap().contains("\"model\":"));
            assert!(
                !case["outputJson"]
                    .as_str()
                    .unwrap()
                    .contains("\"cloneName\":")
            );
        }
    }
}

#[test]
fn provider_tier_language_mode_and_voice_matrix() {
    for language in [TtsLanguage::En, TtsLanguage::Es] {
        for mode in [TtsMode::Speak, TtsMode::Ai, TtsMode::Clone] {
            for provider in [TtsProvider::Piper, TtsProvider::Fish, TtsProvider::Kokoro] {
                for status in [
                    AiCreditStatus::Available,
                    AiCreditStatus::Exhausted,
                    AiCreditStatus::Unavailable,
                ] {
                    for tier in [
                        None,
                        Some("premium"),
                        Some("pro"),
                        Some("free"),
                        Some("Premium"),
                    ] {
                        let r = CreditFallbackRequest {
                            mode,
                            text: "[laugh] hello".into(),
                            provider,
                            model: Some("model".into()),
                            language,
                            voice: " AF_BELLA ".into(),
                            clone_name: Some("clone".into()),
                            piper_fallback_voice: None,
                            kokoro_fallback_voice: Some(" AM_MICHAEL ".into()),
                            extra: (),
                        };
                        let out = resolve_tts_for_credit_status(&r, status, tier);
                        let unchanged =
                            provider == TtsProvider::Piper || status == AiCreditStatus::Available;
                        assert_eq!(matches!(&out, Cow::Borrowed(_)), unchanged);
                        if unchanged {
                            assert!(std::ptr::eq(out.as_ref(), &r));
                            continue;
                        }
                        let expected = if status == AiCreditStatus::Exhausted
                            && matches!(tier, Some("premium" | "pro"))
                        {
                            TtsProvider::Kokoro
                        } else {
                            TtsProvider::Piper
                        };
                        assert_eq!(out.provider, expected);
                        assert_eq!(
                            out.mode,
                            if mode == TtsMode::Clone {
                                TtsMode::Speak
                            } else {
                                mode
                            }
                        );
                        assert_eq!(out.text.as_str(), Some("hello"));
                        assert_eq!(out.model, None);
                        assert_eq!(out.clone_name, None);
                        let voice = if expected == TtsProvider::Kokoro {
                            if provider == TtsProvider::Kokoro {
                                "af_bella"
                            } else {
                                "am_michael"
                            }
                        } else if language == TtsLanguage::En {
                            "en_US-ryan-medium"
                        } else {
                            "es_MX-ald-medium"
                        };
                        assert_eq!(out.voice.as_str(), Some(voice));
                    }
                }
            }
        }
    }
}
