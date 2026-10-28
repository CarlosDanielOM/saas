#![cfg(feature = "tts-utilities")]
use dima_rust::utils::js_string::JsString;
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
                let emotes: Vec<JsString> = o["emoteNames"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|v| JsString::from(v.as_str().unwrap()))
                            .collect()
                    })
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
                    assert_eq!(json!(result.text.units()), c["expected"]);
                    continue;
                }
                json!({"error":result.error,"message":result.message,"text":result.text.as_str().unwrap(),"originalText":result.original_text})
            }
            "extract" => {
                let ranges = c["ranges"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| {
                        v.as_array()
                            .unwrap()
                            .iter()
                            .map(|s| s.as_str().unwrap().to_owned())
                            .collect()
                    })
                    .collect::<Vec<Vec<String>>>();
                let names = extract_emote_names(input.as_str().unwrap(), &ranges);
                json!({"units": names.iter().map(JsString::units).collect::<Vec<_>>(), "wire": format!("[{}]", names.iter().map(JsString::to_json_string).collect::<Vec<_>>().join(","))})
            }
            "pipeline" => {
                let ranges = c["ranges"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| {
                        v.as_array()
                            .unwrap()
                            .iter()
                            .map(|s| s.as_str().unwrap().to_owned())
                            .collect()
                    })
                    .collect::<Vec<Vec<String>>>();
                let names = extract_emote_names(input.as_str().unwrap(), &ranges);
                let o = &c["options"];
                let options = NormalizeTtsMessageOptions {
                    skip_emotes: o["skipEmotes"].as_bool().unwrap(),
                    strip_links: o["stripLinks"].as_bool().unwrap(),
                    normalize_whitespace: o["normalizeWhitespace"].as_bool().unwrap(),
                    max_length: o["maxLength"].as_f64().unwrap(),
                    emote_names: &names,
                };
                let result = normalize_tts_message(input.as_str().unwrap(), &options);
                json!({"units":result.text.units(), "wire":result.text.to_json_string(), "error":result.error})
            }
            "status" => json!(parse_tts_status(input).map(|s| format_tts_status(&s))),
            other => panic!("unknown operation {other}"),
        };
        assert_eq!(actual, c["expected"], "{}", c);
    }
}
#[test]
fn unicode_and_settings_boundaries() {
    let raw = serde_json::value::RawValue::from_string(
        JsString::from_units(vec![0xd83d]).to_json_string(),
    )
    .unwrap();
    assert_eq!(serde_json::to_string(&(raw,)).unwrap(), r#"["\ud83d"]"#);
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
    assert_eq!(
        normalize_tts_message("😀a", &opts).text.units(),
        vec![0xd83d]
    );
    assert_eq!(
        extract_emote_names("😀Kappa", &[vec!["2-6".into(), "2-6".into(), "bad".into()]]),
        vec![JsString::from("Kappa")]
    );
    assert_eq!(
        extract_emote_names("😀", &[vec!["0-0".into()]]),
        vec![JsString::from_units(vec![0xd83d])]
    );
    let emotes = extract_emote_names("😀 Kappa", &[vec!["0-0".into(), "3-7".into()]]);
    let options = NormalizeTtsMessageOptions {
        skip_emotes: true,
        emote_names: &emotes,
        ..opts
    };
    assert_eq!(
        normalize_tts_message("😀 Kappa", &options).text.units(),
        vec![0xd83d]
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

// Run only in the capped compiler container with DIMA_TTS_BENCH_FIXTURES and
// DIMA_TTS_BENCH_OUTPUT pointing to the prepared fixture and result paths.
#[test]
#[ignore]
fn normalization_benchmark() {
    use std::{hint::black_box, time::Instant};

    let fixture_path = std::env::var("DIMA_TTS_BENCH_FIXTURES").expect("prepared fixture path");
    let output_path = std::env::var("DIMA_TTS_BENCH_OUTPUT").expect("result output path");
    let fixture: Value = serde_json::from_slice(&std::fs::read(fixture_path).unwrap()).unwrap();
    let mut results = Vec::new();
    for workload in fixture["workloads"].as_array().unwrap() {
        let name = workload["name"].as_str().unwrap();
        let input = workload["input"].as_str().unwrap();
        let settings = &workload["options"];
        let names: Vec<JsString> = settings["emoteNames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| JsString::from(value.as_str().unwrap()))
            .collect();
        let options = NormalizeTtsMessageOptions {
            skip_emotes: settings["skipEmotes"].as_bool().unwrap(),
            strip_links: settings["stripLinks"].as_bool().unwrap(),
            normalize_whitespace: settings["normalizeWhitespace"].as_bool().unwrap(),
            max_length: settings["maxLength"].as_f64().unwrap(),
            emote_names: &names,
        };
        let iterations = workload["iterations"].as_u64().unwrap();
        let warmup = workload["warmupIterations"].as_u64().unwrap();
        let checksum_per_op = workload["checksumPerOp"].as_u64().unwrap() as u32;
        let expected_length = workload["outputCodeUnits"].as_u64().unwrap() as usize;
        let initial = normalize_tts_message(input, &options);
        assert_eq!(initial.text.code_units().count(), expected_length, "{name}");
        assert_eq!(
            initial
                .text
                .code_units()
                .fold(0_u32, |sum, unit| sum.wrapping_add(unit as u32)),
            checksum_per_op,
            "{name}"
        );
        let run = |count| {
            let mut checksum = 0_u32;
            for _ in 0..count {
                let result = normalize_tts_message(black_box(input), black_box(&options));
                for unit in result.text.code_units() {
                    checksum = checksum.wrapping_add(unit as u32);
                }
            }
            black_box(checksum)
        };
        run(warmup);
        let expected_checksum = checksum_per_op.wrapping_mul(iterations as u32);
        let mut samples = Vec::new();
        let mut elapsed = Vec::new();
        for _ in 0..7 {
            let started = Instant::now();
            let checksum = run(iterations);
            let elapsed_ns = started.elapsed().as_nanos() as u64;
            assert_eq!(checksum, expected_checksum, "{name}");
            samples.push(json!({"elapsedNs": elapsed_ns, "checksum": checksum}));
            elapsed.push(elapsed_ns);
        }
        elapsed.sort_unstable();
        results.push(json!({"name":name,"iterations":iterations,"warmupIterations":warmup,"outputCodeUnits":expected_length,"checksumPerOp":checksum_per_op,"samples":samples,"medianNsPerOp":elapsed[3] as f64 / iterations as f64}));
    }
    let report = json!({"version":1,"runtime":"rust-release","measurement":"normalization plus UTF-16 checksum; excludes JSON serialization","sourceHashes":fixture["sourceHashes"],"workloads":results});
    std::fs::write(output_path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}
