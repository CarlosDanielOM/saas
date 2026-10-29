#![cfg(feature = "tts-utilities")]

use dima_rust::utils::{
    lossless_json::{JsonValue, parse_json},
    tts::{
        ExpressiveTtsTag, ExpressiveTtsTagSettings, expressive_tags, normalize_expressive_tags_json,
    },
};
use std::collections::{BTreeMap, HashSet};

#[test]
fn canonical_tags_are_exactly_the_catalog() {
    let catalog: Vec<_> = expressive_tags().collect();
    let tags: Vec<_> = ExpressiveTtsTag::iter().collect();
    assert_eq!(catalog.len(), 75);
    assert_eq!(catalog.iter().copied().collect::<HashSet<_>>().len(), 75);
    assert_eq!(
        tags.iter().map(|tag| tag.as_str()).collect::<Vec<_>>(),
        catalog
    );
    for tag in tags {
        assert_eq!(tag.as_str().parse::<ExpressiveTtsTag>(), Ok(tag));
    }
    for invalid in ["", "anger", "HAPPY", " happy", "happy ", "unknown"] {
        assert!(invalid.parse::<ExpressiveTtsTag>().is_err(), "{invalid:?}");
    }
}

#[test]
fn complete_records_are_independent_and_write_in_catalog_order() {
    let mut settings = ExpressiveTtsTagSettings::default();
    let original = settings.clone();
    for (index, tag) in ExpressiveTtsTag::iter().enumerate() {
        settings.set(tag, index % 2 == 0);
        assert_eq!(settings.get(tag), index % 2 == 0);
        assert!(original.get(tag));
    }
    assert_eq!(settings.iter().count(), 75);
    assert_eq!(
        settings,
        ExpressiveTtsTagSettings::from_fn(|tag| {
            expressive_tags()
                .position(|name| name == tag.as_str())
                .unwrap()
                % 2
                == 0
        })
    );
    let mut wire = String::from("prefix");
    settings.write_json(&mut wire);
    assert_eq!(&wire[6..], settings.to_json_string());
    let JsonValue::Object(entries) = parse_json(&wire[6..]).unwrap() else {
        panic!("record must be an object");
    };
    assert_eq!(entries.len(), 75);
    for (index, ((key, value), tag)) in entries.iter().zip(expressive_tags()).enumerate() {
        assert_eq!(key.as_str(), Some(tag));
        assert_eq!(*value, JsonValue::Bool(index % 2 == 0));
    }
}

#[test]
fn normalization_uses_shared_nullish_and_legacy_policy() {
    assert_eq!(
        ExpressiveTtsTagSettings::from_json(None),
        ExpressiveTtsTagSettings::default()
    );
    let input = parse_json(
        r#"{"happy":null,"sad":0,"inline":{"happy":false,"sad":false,"longPause":false},"\ud800":false}"#,
    )
    .unwrap();
    let settings = ExpressiveTtsTagSettings::from_json(Some(&input));
    for (name, expected) in [
        ("happy", false),
        ("sad", true),
        ("long-pause", false),
        ("angry", true),
    ] {
        assert_eq!(settings.get(name.parse().unwrap()), expected, "{name}");
    }
    let actual: BTreeMap<_, _> = settings
        .iter()
        .map(|(tag, value)| (tag.as_str().to_owned(), value))
        .collect();
    assert_eq!(actual, normalize_expressive_tags_json(Some(&input)));
}
