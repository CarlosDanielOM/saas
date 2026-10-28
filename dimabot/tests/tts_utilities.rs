#![cfg(feature = "tts-utilities")]
use dima_rust::utils::tts::*;
use serde_json::{Value, json};

#[test]
fn source_backed_cases() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/tts_utilities_cases.json")).unwrap();
    let cases = fixture
        .as_array()
        .or_else(|| fixture["cases"].as_array())
        .unwrap();
    for c in cases {
        let input = &c["input"];
        let actual = match c["op"].as_str().unwrap() {
            "voice" => json!(resolve_kokoro_voice(input)),
            "template" => json!(migrate_legacy_speech_template(input.as_str())),
            "filter" => json!(filter_expressive_tts_tags(
                input.as_str().unwrap(),
                if c["provider"] == "fish" {
                    TtsProvider::Fish
                } else {
                    TtsProvider::Piper
                },
                Some(&normalize_expressive_tags(&Value::Null))
            )),
            "reinforce" => json!(reinforce_fish_tts_tags(input.as_str().unwrap())),
            "normalize" | "splitSurrogate" => {
                let o = &c["options"];
                let emotes: Vec<String> = o["emoteNames"]
                    .as_array()
                    .map(|a| a.iter().map(|v| v.as_str().unwrap().to_owned()).collect())
                    .unwrap_or_default();
                let options = NormalizeTtsMessageOptions {
                    skip_emotes: o["skipEmotes"].as_bool().unwrap(),
                    strip_links: o["stripLinks"].as_bool().unwrap(),
                    normalize_whitespace: o["normalizeWhitespace"].as_bool().unwrap(),
                    max_length: o["maxLength"].as_f64().unwrap(),
                    emote_names: &emotes,
                };
                let result = normalize_tts_message(input.as_str().unwrap(), &options);
                if c["op"] == "splitSurrogate" {
                    assert_eq!(result, Err(SplitSurrogate));
                    continue;
                }
                let result = result.unwrap();
                json!({"error":result.error,"message":result.message,"text":result.text,"originalText":result.original_text})
            }
            "status" => json!(parse_tts_status(input).map(|s| format_tts_status(&s))),
            other => panic!("unknown operation {other}"),
        };
        assert_eq!(actual, c["expected"], "{}", c);
    }
}
#[test]
fn unicode_and_settings_boundaries() {
    assert_eq!(expressive_tags().count(), 75);
    let tags = normalize_expressive_tags(
        &json!({"long-pause":null,"inline":{"longPause":false},"happy":"bad","wrapping":{"happy":false}}),
    );
    assert!(!tags["long-pause"]);
    assert!(tags["happy"]);
    let opts = NormalizeTtsMessageOptions {
        skip_emotes: false,
        strip_links: false,
        normalize_whitespace: false,
        max_length: 1.0,
        emote_names: &[],
    };
    assert_eq!(normalize_tts_message("😀a", &opts), Err(SplitSurrogate));
    assert_eq!(
        extract_emote_names("😀Kappa", &[vec!["2-6".into(), "2-6".into(), "bad".into()]]).unwrap(),
        vec!["Kappa"]
    );
    assert_eq!(
        extract_emote_names("😀", &[vec!["0-0".into()]]),
        Err(SplitSurrogate)
    );
    assert_eq!(
        build_spoken_user_message(
            " Viewer ",
            "hello",
            TtsLanguage::En,
            SpeechSource::ChatCommand
        ),
        "Viewer say: hello"
    );
    assert_eq!(
        build_spoken_user_message("Viewer", "hello", TtsLanguage::Es, SpeechSource::Ast),
        "hello"
    );
    assert_eq!(generate_speech_id_with_length(1.2).unwrap().len(), 2);
    assert_eq!(generate_speech_id_with_length(f64::NAN).unwrap(), "");
    assert!(generate_speech_id_with_length(f64::INFINITY).is_err());
    for length in [0, 1, 8, 100] {
        let id = generate_speech_id(length);
        assert_eq!(id.len(), length);
        assert!(
            id.bytes()
                .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
        );
    }
}

#[tokio::test]
async fn deadlines_and_stream_cancellation() {
    use std::time::Duration;
    let value = promise_with_timeout(async { Ok::<_, ()>(42) }, Duration::from_secs(1), "late")
        .await
        .unwrap();
    assert_eq!(value, 42);
    let (completed_tx, completed_rx) = tokio::sync::oneshot::channel();
    let result = promise_with_timeout(
        async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            let _ = completed_tx.send(());
            Ok::<_, ()>(())
        },
        Duration::from_millis(1),
        "late",
    )
    .await;
    assert!(matches!(result, Err(DeadlineError::Timeout(message)) if message == "late"));
    assert!(completed_rx.await.is_ok());
    let (sender, cancellation, stream) = AudioStream::channel(2);
    sender.send(Ok(vec![1, 2, 3])).await.unwrap();
    drop(sender);
    let (_abort, signal) = tokio::sync::watch::channel(None);
    assert_eq!(
        read_audio_stream(stream, signal, 3).await.unwrap(),
        vec![1, 2, 3]
    );
    assert!(cancellation.await.is_err());
    let (sender, cancellation, stream) = AudioStream::channel(2);
    sender.send(Ok(vec![1, 2, 3])).await.unwrap();
    let (_abort, signal) = tokio::sync::watch::channel(None);
    assert_eq!(
        read_audio_stream(stream, signal, 2).await,
        Err(AudioReadError::Limit)
    );
    assert_eq!(cancellation.await.unwrap(), None);
    let (_sender, cancellation, stream) = AudioStream::channel(2);
    let (abort, signal) = tokio::sync::watch::channel(None);
    abort.send(Some("deadline".to_owned())).unwrap();
    assert_eq!(
        read_audio_stream(stream, signal, 100).await,
        Err(AudioReadError::Timeout)
    );
    assert_eq!(cancellation.await.unwrap().as_deref(), Some("deadline"));
}
