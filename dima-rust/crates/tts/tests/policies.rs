#![allow(clippy::unwrap_used)]
use dima_billing::plans::PlanTier;
use dima_tts::{credit_fallback::*, deadline, playback_timeout::*, speech_id};
use std::time::Duration;
#[test]
fn credit_fallback_retains_paid_policy_and_strips_cues() {
    for provider in ["piper", "fish", "kokoro"] {
        for status in ["available", "exhausted", "unavailable"] {
            for tier in [PlanTier::Free, PlanTier::Premium, PlanTier::Pro] {
                let req = Request {
                    mode: "clone".into(),
                    text: "[happy] Hello <whisper>chat</whisper>".into(),
                    provider: provider.into(),
                    model: Some("model".into()),
                    language: "en".into(),
                    voice: if provider == "kokoro" {
                        "am_echo"
                    } else {
                        "gojo"
                    }
                    .into(),
                    clone_name: Some("clone".into()),
                    piper_fallback_voice: None,
                    kokoro_fallback_voice: Some("ef_dora".into()),
                };
                let actual = resolve(req.clone(), status, tier);
                if provider == "piper" || status == "available" {
                    assert_eq!(actual, req);
                } else {
                    let kokoro = status == "exhausted" && tier != PlanTier::Free;
                    assert_eq!(actual.provider, if kokoro { "kokoro" } else { "piper" });
                    assert_eq!(actual.mode, "speak");
                    assert_eq!(actual.text, "Hello chat");
                    assert_eq!(actual.model, None);
                    assert_eq!(actual.clone_name, None);
                    assert_eq!(
                        actual.voice,
                        if kokoro {
                            if provider == "kokoro" {
                                "am_echo"
                            } else {
                                "ef_dora"
                            }
                        } else {
                            "en_US-ryan-medium"
                        }
                    );
                }
            }
        }
    }
}
#[test]
fn ids_have_reference_format_and_injected_randomness() {
    let a = dima_core::SeededRandom::new(9);
    let b = dima_core::SeededRandom::new(9);
    assert_eq!(
        speech_id::generate(&a, 8).unwrap(),
        speech_id::generate(&b, 8).unwrap()
    );
    let id = speech_id::generate(&a, 100).unwrap();
    assert_eq!(id.len(), 100);
    assert!(
        id.bytes()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
    );
    assert_eq!(speech_id::generate(&a, 0).unwrap(), "");
    assert!(speech_id::generate(&a, 4097).is_err());
}
#[test]
fn playback_rounding_and_wav_header() {
    assert_eq!(duration_ms(f64::NAN), 0);
    assert_eq!(duration_ms(-1.0), 0);
    assert_eq!(duration_ms(1.0001), 1001);
    assert_eq!(playback_timeout_ms(0), 60000);
    assert_eq!(playback_timeout_ms(30000), 60000);
    assert_eq!(playback_timeout_ms(60001), 90001);
    let mut wav = [0u8; 44];
    wav[0..4].copy_from_slice(b"RIFF");
    wav[8..12].copy_from_slice(b"WAVE");
    wav[36..40].copy_from_slice(b"data");
    wav[28..32].copy_from_slice(&1000u32.to_le_bytes());
    wav[40..44].copy_from_slice(&1001u32.to_le_bytes());
    assert_eq!(wav_duration_ms(&wav), 1001);
    assert_eq!(wav_duration_ms(&wav[..43]), 0);
}
#[tokio::test]
async fn promise_with_timeout_rejects_when_work_never_settles() {
    assert!(
        deadline::with_timeout(
            std::future::pending::<()>(),
            Duration::from_millis(5),
            "TTS synthesis timed out"
        )
        .await
        .is_err()
    );
    assert_eq!(
        deadline::with_timeout(async { "ok" }, Duration::from_millis(50), "late")
            .await
            .unwrap(),
        "ok"
    );
}
#[test]
fn fish_voice_validation_and_scalar_display_limits() {
    use dima_tts::catalog::*;
    use serde_json::json;
    assert_eq!(resolve_voice(None).unwrap(), FISH_VOICES[0].1);
    assert!(resolve_voice(Some("constructor")).is_none());
    assert!(parse_search(&json!({"page":1})).is_err());
    assert!(parse_search(&json!({"page":"51"})).is_err());
    let v = json!({"_id":"a".repeat(32),"title":"😀".repeat(201),"description":"😀".repeat(301),"type":"tts","visibility":"public","tags":["female","english","calm","calm"],"cover_image":"https://evil.test/x","samples":[{"audio":"https://evil.test/x"}]});
    let voice = normalize_voice(&v).unwrap();
    assert_eq!(voice["name"].as_str().unwrap().chars().count(), 200);
    assert_eq!(voice["description"].as_str().unwrap().chars().count(), 300);
    assert_eq!(voice["tags"], json!(["calm"]));
    assert!(voice["coverUrl"].is_null());
    assert!(voice["sample"].is_null());
}

#[test]
fn legacy_tag_switches_have_nullish_precedence() {
    let flags = dima_tts::tags::normalize_settings(
        &serde_json::json!({"happy":null,"inline":{"happy":false,"longPause":false},"wrapping":{"happy":true,"angry":false}}),
    );
    assert_eq!(flags.len(), 75);
    assert!(!flags["happy"]);
    assert!(!flags["long-pause"]);
    assert!(!flags["angry"]);
    assert!(flags["whisper"]);
}
