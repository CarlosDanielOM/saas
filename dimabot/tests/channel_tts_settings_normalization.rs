#![cfg(feature = "tts-utilities")]

use dima_rust::utils::{
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    tts::settings::{create_default_channel_tts_settings, normalize_channel_tts_settings},
};

fn normalized(source: &str) -> JsonValue {
    let input = parse_json(source).unwrap();
    normalize_channel_tts_settings(
        Some(&input),
        &JsString::from("channel-id"),
        &JsString::from(" fallback "),
    )
    .unwrap()
}
fn at<'a>(value: &'a JsonValue, path: &[&str]) -> &'a JsonValue {
    path.iter()
        .fold(value, |value, key| value.get(key).unwrap())
}
fn text(value: &str) -> JsonValue {
    JsonValue::String(JsString::from(value))
}

#[test]
fn default_trees_are_independent_and_identity_fields_are_verbatim() {
    let id = JsString::from_units(vec![0xd800, 32]);
    let channel = JsString::from("  channel  ");
    let baseline = create_default_channel_tts_settings(&id, &channel);
    let mut edited = create_default_channel_tts_settings(&id, &channel);
    let JsonValue::Object(fields) = &mut edited else {
        panic!("settings object")
    };
    let (_, JsonValue::Object(voices)) = fields
        .iter_mut()
        .find(|(key, _)| key.as_str() == Some("voices"))
        .unwrap()
    else {
        panic!("voices object")
    };
    voices
        .iter_mut()
        .find(|(key, _)| key.as_str() == Some("en"))
        .unwrap()
        .1 = text("edited");
    assert_eq!(
        baseline.get("channelID"),
        Some(&JsonValue::String(id.clone()))
    );
    assert_eq!(baseline.get("channel"), Some(&text("  channel  ")));
    assert_eq!(at(&baseline, &["voices", "en"]), &text("en_US-ryan-medium"));
    assert_ne!(edited, baseline);
    assert_eq!(baseline, create_default_channel_tts_settings(&id, &channel));
    let tags = at(&baseline, &["filters", "expressiveTags"]);
    let JsonValue::Object(tags) = tags else {
        panic!("expressive tags")
    };
    assert_eq!(tags.len(), 75);
    assert_eq!(tags.first().unwrap().0.as_str(), Some("happy"));
    assert_eq!(tags.last().unwrap().0.as_str(), Some("background laughter"));
    assert!(
        tags.iter()
            .all(|(_, value)| value == &JsonValue::Bool(true))
    );
}

#[test]
fn truthy_string_fallback_and_nullish_flags_are_distinct() {
    let value = normalized(
        r#"{
        "channelID":"ignored", "channel":[], "enabled":0,
        "provider":"openrouter", "defaultLanguage":"EN",
        "voices":{"en":[null,"  custom  "],"es":false,"cloneDefault":42,"kokoroDefault":" AF_HEART "},
        "filters":{"skipEmotes":null,"stripLinks":"false","normalizeWhitespace":[],"maxLength":null},
        "queue":{"maxItems":null}
    }"#,
    );
    assert_eq!(value.get("channelID"), Some(&text("channel-id")));
    // [] is truthy, then String([]) is empty. Channel has no post-trim fallback.
    assert_eq!(value.get("channel"), Some(&text("")));
    assert_eq!(value.get("enabled"), Some(&JsonValue::Number(0.0)));
    assert_eq!(value.get("provider"), Some(&text("piper")));
    assert_eq!(value.get("defaultLanguage"), Some(&text("es")));
    assert_eq!(at(&value, &["voices", "en"]), &text(",  custom"));
    assert_eq!(at(&value, &["voices", "es"]), &text("es_MX-ald-medium"));
    assert_eq!(at(&value, &["voices", "cloneDefault"]), &text("gojo"));
    assert_eq!(at(&value, &["voices", "kokoroDefault"]), &text("af_heart"));
    assert_eq!(
        at(&value, &["filters", "skipEmotes"]),
        &JsonValue::Bool(true)
    );
    assert_eq!(at(&value, &["filters", "stripLinks"]), &text("false"));
    assert_eq!(
        at(&value, &["filters", "normalizeWhitespace"]),
        &JsonValue::Array(vec![])
    );
    assert_eq!(
        at(&value, &["filters", "maxLength"]),
        &JsonValue::Number(30.0)
    );
    assert_eq!(at(&value, &["queue", "maxItems"]), &JsonValue::Number(1.0));
}

#[test]
fn missing_numbers_and_present_number_inputs_follow_ecmascript_conversion() {
    for (source, length, items) in [
        (r#"{}"#, 280.0, 5.0),
        (
            r#"{"filters":{"maxLength":"0x100"},"queue":{"maxItems":"0b101"}}"#,
            256.0,
            5.0,
        ),
        (
            r#"{"filters":{"maxLength":[["44.9"]]},"queue":{"maxItems":[[]]}}"#,
            44.0,
            1.0,
        ),
        (
            r#"{"filters":{"maxLength":"Infinity"},"queue":{"maxItems":{}}}"#,
            280.0,
            5.0,
        ),
        (
            r#"{"filters":{"maxLength":"\ufeff 502.9 "},"queue":{"maxItems":-0}}"#,
            500.0,
            1.0,
        ),
        (
            r#"{"filters":{"maxLength":"\u0085 99"},"queue":{"maxItems":"0o21"}}"#,
            280.0,
            17.0,
        ),
        (
            r#"{"filters":{"maxLength":true},"queue":{"maxItems":[1,2]}}"#,
            30.0,
            5.0,
        ),
    ] {
        let value = normalized(source);
        assert_eq!(
            at(&value, &["filters", "maxLength"]),
            &JsonValue::Number(length),
            "{source}"
        );
        assert_eq!(
            at(&value, &["queue", "maxItems"]),
            &JsonValue::Number(items),
            "{source}"
        );
    }
}

#[test]
fn nullish_tag_precedence_checks_type_after_selecting_the_value() {
    let value = normalized(
        r#"{"filters":{"expressiveTags":{
        "happy":"false", "sad":null, "angry":false, "long-pause":null,
        "inline":{"happy":false,"sad":false,"angry":true,"longPause":null,"laugh":0},
        "wrapping":{"sad":true,"longPause":false,"laugh":false}
    }}}"#,
    );
    for (tag, enabled) in [
        ("happy", true),
        ("sad", false),
        ("angry", false),
        ("long-pause", false),
        ("laugh", true),
    ] {
        assert_eq!(
            at(&value, &["filters", "expressiveTags", tag]),
            &JsonValue::Bool(enabled)
        );
    }
    let json = at(&value, &["filters", "expressiveTags"]).to_json_string();
    assert!(json.starts_with("{\"happy\":true,\"sad\":false,\"angry\":false,"));
}

#[test]
fn lone_utf16_survives_channel_and_voice_coercion_and_js_trim() {
    let value = normalized(
        r#"{
        "channel":"\ufeff\ud800 ",
        "voices":{"en":["\udc00"],"cloneDefault":" \ud801 ","kokoroDefault":"af_\ud800heart"}
    }"#,
    );
    assert_eq!(
        value.get("channel"),
        Some(&JsonValue::String(JsString::from_units(vec![0xd800])))
    );
    assert_eq!(
        at(&value, &["voices", "en"]),
        &JsonValue::String(JsString::from_units(vec![0xdc00]))
    );
    assert_eq!(
        at(&value, &["voices", "cloneDefault"]),
        &JsonValue::String(JsString::from_units(vec![0xd801]))
    );
    assert_eq!(at(&value, &["voices", "kokoroDefault"]), &text("ef_dora"));
}

#[test]
fn own_noncallable_to_string_raises_source_type_error_only_on_coercion() {
    for source in [
        r#"{"channel":{"toString":null}}"#,
        r#"{"voices":{"en":[{"toString":"voice"}]}}"#,
        r#"{"filters":{"maxLength":{"valueOf":42,"toString":false}}}"#,
        r#"{"queue":{"maxItems":[[{"toString":{}}]]}}"#,
    ] {
        let input = parse_json(source).unwrap();
        let error = normalize_channel_tts_settings(
            Some(&input),
            &JsString::from("id"),
            &JsString::from(""),
        )
        .unwrap_err();
        assert_eq!(error.name(), "TypeError");
        assert_eq!(
            error.to_string(),
            "Cannot convert object to primitive value"
        );
    }
    let value = normalized(
        r#"{"enabled":{"toString":null},"voices":{"cloneDefault":{"toString":null},"kokoroDefault":{"toString":null}},"filters":{"stripLinks":{"toString":false},"maxLength":{"valueOf":99}}}"#,
    );
    assert_eq!(
        value.get("enabled"),
        Some(&parse_json(r#"{"toString":null}"#).unwrap())
    );
    assert_eq!(
        at(&value, &["filters", "maxLength"]),
        &JsonValue::Number(280.0)
    );
}

#[test]
fn scalar_inputs_use_named_property_boxing_without_inventing_fields() {
    let id = JsString::from("id");
    let channel = JsString::from(" fallback ");
    let baseline = normalize_channel_tts_settings(None, &id, &channel).unwrap();
    for source in ["null", "false", "13", "\"voices\"", "[]"] {
        let input = parse_json(source).unwrap();
        assert_eq!(
            normalize_channel_tts_settings(Some(&input), &id, &channel).unwrap(),
            baseline,
            "{source}"
        );
    }
}
