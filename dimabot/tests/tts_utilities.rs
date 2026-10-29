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

#[test]
fn lossless_normalization_and_pet_composition() {
    use dima_rust::pet_speech_text::filter_pet_talk_text;
    let lone = JsString::from_units(vec![0xd800]);
    let emotes = [lone.clone()];
    let options = NormalizeTtsMessageOptions {
        skip_emotes: true,
        strip_links: true,
        normalize_whitespace: true,
        max_length: 100.0,
        emote_names: &emotes,
    };
    let input = JsString::from_units(vec![
        0xd800, 32, 97, 46, 99, 111, 109, 47, 0xdc00, 32, 0xd801,
    ]);
    let result = normalize_tts_message_js(&input, &options);
    assert_eq!(result.original_text, input);
    assert_eq!(
        result.text.units(),
        vec![91, 108, 105, 110, 107, 93, 32, 0xd801]
    );
    let spoken = build_spoken_user_message_js(
        &lone,
        &result.text,
        TtsLanguage::En,
        SpeechSource::ChatCommand,
    );
    assert_eq!(spoken.units()[..7], [0xd800, 32, 115, 97, 121, 58, 32]);
    let names = extract_emote_names_js(&input, &[vec!["0-0".into(), "0-0".into()]]);
    assert_eq!(names, vec![lone]);
    let pet = filter_pet_talk_text(
        &JsString::from("[happy] a.com"),
        TtsProvider::Piper,
        &options,
        None,
    );
    assert_eq!(pet.original_text.as_str(), Some("a.com"));
    assert_eq!(pet.text.as_str(), Some("[link]"));
}

#[test]
fn lossless_pet_raw_tag_settings_and_spoken_default() {
    use dima_rust::pet_speech_text::filter_pet_talk_text;
    use dima_rust::utils::lossless_json::parse_json;
    let opts = NormalizeTtsMessageOptions {
        skip_emotes: false,
        strip_links: true,
        normalize_whitespace: true,
        max_length: 100.0,
        emote_names: &[],
    };
    let text = JsString::from("[happy] [sad] a.com");
    let tags = parse_json(r#"{"happy":false,"happy":true,"sad":false,"x":"\ud800"}"#).unwrap();
    let result = filter_pet_talk_text(&text, TtsProvider::Fish, &opts, Some(&tags));
    assert_eq!(result.original_text, JsString::from("[happy] a.com"));
    assert_eq!(result.text, JsString::from("[happy] [link]"));
    let missing = filter_pet_talk_text(&text, TtsProvider::Fish, &opts, None);
    assert_eq!(missing.original_text, JsString::from("a.com"));
    assert_eq!(missing.text, JsString::from("[link]"));
    let user = JsString::from_units(vec![32, 0xd800, 32]);
    let message = JsString::from_units(vec![0xdc00]);
    assert_eq!(
        build_spoken_user_message_js(&user, &message, TtsLanguage::Es, SpeechSource::ChatCommand)
            .units(),
        vec![0xd800, 32, 100, 105, 99, 101, 58, 32, 0xdc00]
    );
}

// Generated only by the pinned actual-TypeScript oracle in a disposable environment.
#[test]
#[ignore]
fn lossless_actual_source_replay() {
    use dima_rust::pet_speech_text::filter_pet_talk_text;
    use dima_rust::utils::lossless_json::parse_json;

    fn decode(value: &Value, id: &str) -> JsString {
        let units = value
            .as_array()
            .unwrap_or_else(|| panic!("{id}: missing unit array"))
            .iter()
            .map(|unit| {
                let n = unit
                    .as_u64()
                    .unwrap_or_else(|| panic!("{id}: non-integer unit"));
                u16::try_from(n).unwrap_or_else(|_| panic!("{id}: out-of-range UTF-16 unit {n}"))
            })
            .collect();
        JsString::from_units(units)
    }
    fn options<'a>(c: &Value, emotes: &'a [JsString]) -> NormalizeTtsMessageOptions<'a> {
        let max_length = match c["maxLength"].as_str().expect("maxLength") {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            value => value.parse().expect("maxLength number"),
        };
        NormalizeTtsMessageOptions {
            skip_emotes: c["skip"].as_bool().expect("skip"),
            strip_links: c["stripLinks"].as_bool().expect("stripLinks"),
            normalize_whitespace: c["normalizeWhitespace"]
                .as_bool()
                .expect("normalizeWhitespace"),
            max_length,
            emote_names: emotes,
        }
    }
    let dir = std::env::var("DIMA_TTS_LOSSLESS_FIXTURES").expect("fixture directory required");
    let input = std::fs::read_to_string(std::path::Path::new(&dir).join("tts_lossless_cases.json"))
        .expect("oracle fixture required");
    let fixture: Value = serde_json::from_str(&input).expect("valid oracle fixture");
    assert_eq!(fixture["schema"], 2);
    assert_eq!(fixture["provenance"]["node"], "v24.22.1");
    assert_eq!(fixture["provenance"]["v8"], "13.6.233.17-node.58");
    assert_eq!(fixture["provenance"]["typescript"], "5.9.3");
    assert_eq!(
        fixture["provenance"]["hashes"]["pet"],
        "9a5c1923ef1ceb3e1c454dab4803a589289c04cf1eb954aa3720ca2c163a6561"
    );
    for name in [
        "normalizer",
        "expressive",
        "pet",
        "petTest",
        "creditFallback",
        "schema",
        "voices",
        "resolver",
        "loader",
        "oracle",
        "package",
        "lock",
        "typescript",
        "typescriptPackage",
        "node",
    ] {
        let hash = fixture["provenance"]["hashes"][name]
            .as_str()
            .expect("source hash");
        assert_eq!(hash.len(), 64, "{name} hash");
        assert!(hash.bytes().all(|b| b.is_ascii_hexdigit()), "{name} hash");
        assert!(
            !fixture["provenance"]["sourcePaths"][name]
                .as_str()
                .expect("source path")
                .is_empty(),
            "{name} path"
        );
    }
    assert_eq!(
        fixture["metadata"]["exports"]["normalizer"],
        json!([
            "buildSpokenUserMessage",
            "extractEmoteNames",
            "filterExpressiveTtsTags",
            "normalizeTtsMessage"
        ])
    );
    assert_eq!(
        fixture["metadata"]["exports"]["pet"],
        json!(["filterPetTalkText"])
    );
    assert_eq!(
        fixture["metadata"]["exports"]["creditFallback"],
        json!(["resolveTtsForCreditStatus"])
    );
    assert_eq!(
        fixture["metadata"]["exports"]["expressive"],
        json!([
            "EXPRESSIVE_TTS_TAGS",
            "EXPRESSIVE_TTS_TAG_GROUPS",
            "filterExpressiveTtsTags",
            "normalizeExpressiveTtsTags",
            "reinforceFishTtsTags"
        ])
    );
    assert_eq!(
        fixture["metadata"]["ast"]["schema"]["aliases"]["TtsLanguage"],
        "'en' | 'es'"
    );
    assert_eq!(
        fixture["metadata"]["ast"]["schema"]["aliases"]["TtsProvider"],
        "'piper' | 'fish' | 'kokoro'"
    );
    let ast = &fixture["metadata"]["ast"]["normalizer"];
    assert_eq!(
        ast["interfaces"]["NormalizeTtsMessageOptions"],
        json!([
            {"name":"skipEmotes","optional":false,"type":"boolean"},
            {"name":"stripLinks","optional":false,"type":"boolean"},
            {"name":"normalizeWhitespace","optional":false,"type":"boolean"},
            {"name":"maxLength","optional":false,"type":"number"},
            {"name":"emoteNames","optional":true,"type":"string[]"}
        ])
    );
    assert_eq!(
        ast["interfaces"]["NormalizeTtsMessageResult"],
        json!([
            {"name":"error","optional":false,"type":"boolean"},
            {"name":"message","optional":false,"type":"string"},
            {"name":"text","optional":false,"type":"string"},
            {"name":"originalText","optional":false,"type":"string"}
        ])
    );
    assert_eq!(ast["imports"][0]["typeOnly"], true);
    assert_eq!(
        ast["imports"][0]["module"],
        "../../schemas/channel_tts_settings.schema.js"
    );
    assert_eq!(
        ast["reexports"][0]["module"],
        "./expressive_tts_tags.util.js"
    );
    assert_eq!(ast["reexports"][0]["names"], "{ filterExpressiveTtsTags }");
    assert_eq!(
        ast["returns"]["normalizeTtsMessage"],
        "NormalizeTtsMessageResult"
    );
    assert_eq!(ast["returns"]["extractEmoteNames"], "string[]");
    assert_eq!(
        ast["functions"]["normalizeTtsMessage"][1]["type"],
        "NormalizeTtsMessageOptions"
    );
    assert_eq!(
        ast["functions"]["buildSpokenUserMessage"][2]["type"],
        "TtsLanguage"
    );
    assert_eq!(
        ast["functions"]["buildSpokenUserMessage"][3]["type"],
        "'chat-command' | 'ast' | 'redemption'"
    );
    assert_eq!(
        ast["functions"]["buildSpokenUserMessage"][3]["default"],
        "'chat-command'"
    );
    assert_eq!(
        fixture["metadata"]["ast"]["pet"]["imports"][0]["typeOnly"],
        true
    );
    assert_eq!(
        fixture["metadata"]["ast"]["pet"]["imports"][1]["module"],
        "../utils/tts/normalize_tts_message.util.js"
    );
    let cases = fixture["cases"].as_array().expect("cases required");
    assert!(!cases.is_empty(), "empty oracle fixture");
    let mut counts = [0_usize; 4];
    for c in cases {
        let id = c["id"].as_str().expect("case ID");
        let input = decode(&c["input"], id);
        match c["op"].as_str().expect("operation") {
            "normalize" | "pet" => {
                let emotes: Vec<_> = c["emotes"]
                    .as_array()
                    .expect("emotes")
                    .iter()
                    .map(|v| decode(v, id))
                    .collect();
                let opts = options(c, &emotes);
                let actual = if c["op"] == "pet" {
                    counts[1] += 1;
                    let provider = match c["provider"].as_str().expect("provider") {
                        "fish" => TtsProvider::Fish,
                        "kokoro" => TtsProvider::Kokoro,
                        "piper" => TtsProvider::Piper,
                        other => panic!("{id}: unknown provider {other}"),
                    };
                    // Parse the literal, not a serde value: escaped lones and duplicate keys survive.
                    let tags = c["tagsJson"]
                        .as_str()
                        .map(|raw| parse_json(raw).expect("lossless tags"));
                    filter_pet_talk_text(&input, provider, &opts, tags.as_ref())
                } else {
                    counts[0] += 1;
                    normalize_tts_message_js(&input, &opts)
                };
                let expected = &c["expected"];
                assert_eq!(
                    actual.error,
                    expected["error"].as_bool().expect("error"),
                    "{id}: error"
                );
                assert_eq!(
                    actual.message,
                    expected["message"].as_str().expect("message"),
                    "{id}: message"
                );
                assert_eq!(actual.text, decode(&expected["text"], id), "{id}: text");
                assert_eq!(
                    actual.original_text,
                    decode(&expected["originalText"], id),
                    "{id}: originalText"
                );
            }
            "extract" => {
                counts[2] += 1;
                let groups: Vec<Vec<JsString>> = c["groups"]
                    .as_array()
                    .expect("groups")
                    .iter()
                    .map(|group| {
                        group
                            .as_array()
                            .expect("entries")
                            .iter()
                            .map(|v| decode(v, id))
                            .collect()
                    })
                    .collect();
                let expected: Vec<_> = c["expected"]
                    .as_array()
                    .expect("expected names")
                    .iter()
                    .map(|v| decode(v, id))
                    .collect();
                assert_eq!(
                    extract_emote_names_js(&input, &groups),
                    expected,
                    "{id}: extracted names and order"
                );
            }
            "spoken" => {
                counts[3] += 1;
                let user = decode(&c["user"], id);
                let lang = match c["language"].as_str().expect("language") {
                    "en" => TtsLanguage::En,
                    "es" => TtsLanguage::Es,
                    other => panic!("{id}: language {other}"),
                };
                let source = match c["source"].as_str().expect("source") {
                    "default" | "chat-command" => SpeechSource::ChatCommand,
                    "ast" => SpeechSource::Ast,
                    "redemption" => SpeechSource::Redemption,
                    other => panic!("{id}: source {other}"),
                };
                assert_eq!(
                    build_spoken_user_message_js(&user, &input, lang, source),
                    decode(&c["expected"], id),
                    "{id}: spoken"
                );
            }
            other => panic!("{id}: unknown operation {other}"),
        }
    }
    assert!(
        counts.iter().all(|count| *count > 0),
        "missing operation coverage: {counts:?}"
    );
}
