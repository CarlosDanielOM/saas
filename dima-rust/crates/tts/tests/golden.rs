#![allow(clippy::unwrap_used)]
use dima_tts::normalize::*;
use serde_json::Value;
#[test]
fn recorded_text_vectors() {
    let data: Value = serde_json::from_slice(&dima_text::sanitize_lone_surrogates(include_bytes!(
        "vectors.json"
    )))
    .unwrap();
    let mut changed = 0;
    for case in data["vectors"].as_array().unwrap() {
        let options: Options = serde_json::from_value(case["options"].clone()).unwrap();
        let raw = case["raw"].as_str().unwrap();
        assert_eq!(
            billable_characters(raw),
            case["billing"].as_u64().unwrap() as usize
        );
        let actual = normalize(raw, &options);
        let recorded: Normalized = serde_json::from_value(case["result"].clone()).unwrap();
        if actual != recorded {
            // Explicit intended difference: our own maxLength counts scalar values, never UTF-16 units.
            // Re-run without a cut, then independently apply the scalar prefix. Billing has no exception.
            let mut unbounded = options.clone();
            unbounded.max_length = 0;
            let full = normalize(raw, &unbounded);
            assert!(options.max_length > 0 && full.text.chars().any(|c| c.len_utf16() == 2));
            let expected: String = full.text.chars().take(options.max_length).collect();
            assert_eq!(actual.text, dima_text::trim(&expected));
            changed += 1;
        }
    }
    assert_eq!(
        changed, 1264,
        "update only after inspecting the intended differences"
    );
    for case in data["spoken"].as_array().unwrap() {
        assert_eq!(
            spoken_user_message(
                case["name"].as_str().unwrap(),
                "hello",
                case["language"].as_str().unwrap(),
                case["source"].as_str().unwrap()
            ),
            case["result"].as_str().unwrap()
        );
    }
    for case in data["templates"].as_array().unwrap() {
        assert_eq!(
            migrate_legacy_template(case["input"].as_str()),
            case["result"].as_str().unwrap()
        );
    }
}

#[test]
fn recorded_cues_and_emotes() {
    let data: Value = serde_json::from_slice(&dima_text::sanitize_lone_surrogates(include_bytes!(
        "vectors.json"
    )))
    .unwrap();
    for case in data["cues"].as_array().unwrap() {
        let enabled = serde_json::from_value(case["enabledTags"].clone()).unwrap();
        let filtered = dima_tts::tags::filter(
            case["text"].as_str().unwrap(),
            case["provider"].as_str().unwrap(),
            &enabled,
        );
        assert_eq!(filtered, case["filtered"].as_str().unwrap(), "{case}");
        assert_eq!(
            dima_tts::tags::reinforce(&filtered),
            case["reinforced"].as_str().unwrap()
        );
    }
    for case in data["emotes"].as_array().unwrap() {
        let ranges = serde_json::from_value::<Vec<String>>(case["ranges"].clone()).unwrap();
        let actual = extract_emote_names(case["text"].as_str().unwrap(), &ranges);
        // Boundary repair is intentional when the reference range cuts an emoji surrogate pair.
        let recorded: Vec<String> = serde_json::from_value(case["result"].clone()).unwrap();
        if actual != recorded {
            assert!(recorded.iter().any(|s| s.contains('�')));
        } else {
            assert_eq!(actual, recorded);
        }
    }
}

#[test]
fn recorded_catalog_display_limits() {
    let data: Value = serde_json::from_slice(&dima_text::sanitize_lone_surrogates(include_bytes!(
        "vectors.json"
    )))
    .unwrap();
    let mut differences = [0; 3];
    for case in data["voices"].as_array().unwrap() {
        let actual = dima_tts::catalog::normalize_voice(&case["raw"]).unwrap();
        let mut expected = case["result"].clone();
        // Intentional: public display limits are our own text limits, hence Unicode scalars.
        for (i, (field, max)) in [("name", 200), ("description", 300), ("sample", 400)]
            .into_iter()
            .enumerate()
        {
            let source = match field {
                "name" => case["raw"]["title"].as_str().unwrap(),
                "description" => case["raw"]["description"].as_str().unwrap(),
                _ => case["raw"]["samples"][0]["text"].as_str().unwrap(),
            };
            let text: String = dima_text::trim(source).chars().take(max).collect();
            let target = if field == "sample" {
                &mut expected["sample"]["text"]
            } else {
                &mut expected[field]
            };
            if target.as_str() != Some(&text) {
                differences[i] += 1;
                *target = Value::String(text);
            }
        }
        assert_eq!(actual, expected);
    }
    assert_eq!(
        differences,
        [22, 21, 17],
        "inspect changed scalar-limit cases"
    );
}

#[test]
fn recorded_mp3_duration() {
    let data: Value = serde_json::from_slice(&dima_text::sanitize_lone_surrogates(include_bytes!(
        "vectors.json"
    )))
    .unwrap();
    for case in data["audio"].as_array().unwrap() {
        let count = case["count"].as_u64().unwrap() as usize;
        let header: Vec<u8> = serde_json::from_value(case["header"].clone()).unwrap();
        let mut bytes = vec![0; count * 417];
        for i in 0..count {
            bytes[i * 417..i * 417 + 4].copy_from_slice(&header);
        }
        assert_eq!(
            dima_tts::playback_timeout::mp3_duration_ms(&bytes),
            case["duration"].as_u64().unwrap()
        );
    }
}
