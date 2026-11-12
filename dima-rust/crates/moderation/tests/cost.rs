//! What compiling a settings document and checking one message cost, for a typical document
//! and for the largest ones the settings service accepts (20 rules; 200 words of 100
//! characters; 10 patterns of 250 characters; 200 words with variations). Figures are printed
//! (`--nocapture`); the bounds asserted are loose enough for a debug build on a busy machine.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use bson::{Bson, doc};
use dima_commands::permissions::UserIdentity;
use dima_model::channel_moderation_settings::ChannelModerationSettings;
use dima_moderation::rules::variations::{VariationMode, build_variation, with_variation_spacing};
use dima_moderation::rules::{
    CacheLimits, CompiledSettings, CompiledSettingsCache, MessageInput, RuleOutcome,
};
use serde_json::json;

fn rule(kind: &str, extra: bson::Document) -> Bson {
    let mut rule = doc! {
        "id": format!("r-{kind}-{}", extra.len()), "type": kind, "enabled": true,
        "firstOffense": { "action": "warn", "timeoutSeconds": 60 },
        "secondOffense": { "action": "delete", "timeoutSeconds": 60 },
        "thirdOffense": { "action": "timeout", "timeoutSeconds": 60 },
        "reason": "r", "exemptUserLevel": 7, "exemptExpression": Bson::Null,
        "capsThresholdMode": "count", "minCapsCount": 8, "maxCapsPercentage": 70, "minMessageLength": 10,
        "allowlistDomains": ["twitch.tv"], "maxEmoteCount": 10, "terms": [],
    };
    rule.extend(extra);
    Bson::Document(rule)
}

fn settings(rules: Vec<Bson>, version: i32) -> Arc<ChannelModerationSettings> {
    let document = doc! {
        "_id": bson::oid::ObjectId::new(), "channelID": "cost", "channel": "cost", "enabled": true,
        "offenseWindowSeconds": 3600, "rules": rules, "settingsVersion": version,
    };
    Arc::new(bson::deserialize_from_document(document).unwrap())
}

fn typical() -> Arc<ChannelModerationSettings> {
    let terms: Vec<String> = (0..10).map(|i| format!("blocked{i}")).collect();
    settings(
        vec![
            rule("caps", doc! {}),
            rule("links", doc! {}),
            rule("emote_spam", doc! {}),
            rule("blacklist", doc! { "terms": terms }),
        ],
        1,
    )
}

fn variations(words: &[String], suggestions: usize, mode: &str, allow_spaces: bool) -> Bson {
    let entries: Vec<serde_json::Value> = words
        .iter()
        .map(|word| {
            let prefix: String = word
                .chars()
                .take(word.chars().count().saturating_sub(1))
                .collect();
            let suggestions: Vec<String> =
                (0..suggestions).map(|i| format!("{prefix}{i}")).collect();
            let entry = build_variation(word, &json!(suggestions)).unwrap();
            let mode = if mode == "broad" {
                VariationMode::Broad
            } else {
                VariationMode::Common
            };
            serde_json::to_value(
                with_variation_spacing(&entry, allow_spaces, mode)
                    .unwrap()
                    .into_owned(),
            )
            .unwrap()
        })
        .collect();
    Bson::try_from(json!({ "mode": mode, "allowSpaces": allow_spaces, "entries": entries }))
        .unwrap()
}

/// 20 rules: the longest literal list, the longest patterns and 200 variation words in each
/// remaining blocked-word rule.
fn worst(word_length: usize, rules_with_variations: usize) -> Arc<ChannelModerationSettings> {
    let long_terms: Vec<String> = (0..200)
        .map(|i| {
            format!("{i:03}{}", "abcdefghij".repeat(10))
                .chars()
                .take(100)
                .collect()
        })
        .collect();
    let patterns: Vec<Bson> = (0..10)
        .map(|i| {
            let source = format!("(?:a+b*c?){{1,5}}x{i}{}", "(?:[a-z]+d)".repeat(20)).chars().take(250).collect::<String>();
            Bson::Document(doc! { "id": format!("p{i}"), "source": source, "boundary": "whole_word", "ignoreCase": true })
        })
        .collect();
    let words: Vec<String> = (0..200)
        .map(|i| {
            let word = format!("w{i:03}{}", "lorempsumdi".repeat(10));
            word.chars().take(word_length.max(5)).collect()
        })
        .collect();
    let mut rules = vec![
        rule("caps", doc! {}),
        rule("links", doc! {}),
        rule("emote_spam", doc! {}),
        rule(
            "blacklist",
            doc! { "terms": long_terms, "patterns": patterns },
        ),
    ];
    let variation = variations(&words, 8, "broad", true);
    for index in 0..16 {
        let extra = if index < rules_with_variations {
            doc! { "variations": variation.clone() }
        } else {
            doc! { "terms": ["placeholder"] }
        };
        rules.push(rule("blacklist", extra));
    }
    settings(rules, 1)
}

fn messages() -> Vec<MessageInput> {
    let short = "hey everyone, how is the stream going today?";
    let long = "Chat about the game, the raid and the clips: ".repeat(11);
    let long: String = long.chars().take(500).collect();
    let emoji: String = "😀 LUL ".repeat(70).chars().take(500).collect();
    [short.to_owned(), long, emoji, "A".repeat(500)]
        .into_iter()
        .map(|text| MessageInput {
            text,
            emote_texts: Vec::new(),
            emote_count: 0,
        })
        .collect()
}

fn time_checks(compiled: &CompiledSettings) -> Vec<Duration> {
    let viewer = UserIdentity::new(1.0, [], Some("v"), Some("viewer"));
    messages()
        .iter()
        .map(|message| {
            let runs = 20;
            let started = Instant::now();
            for _ in 0..runs {
                let outcomes = compiled.check_all(message, &viewer);
                assert!(
                    !outcomes
                        .iter()
                        .any(|(_, o)| matches!(o, RuleOutcome::Failed(_))),
                    "{outcomes:?}"
                );
            }
            started.elapsed() / runs
        })
        .collect()
}

#[test]
fn cost_of_compiling_and_checking() {
    for (name, settings) in [
        ("typical", typical()),
        (
            "largest literal list and patterns, 200 short variation words in one rule",
            worst(8, 1),
        ),
        (
            "largest everything, 200 variation words of 100 letters in one rule",
            worst(100, 1),
        ),
        (
            "largest everything, 16 rules of 200 short variation words",
            worst(8, 16),
        ),
    ] {
        let started = Instant::now();
        let compiled = CompiledSettings::compile(settings);
        let compile = started.elapsed();
        for (index, rule) in compiled.rules().iter().enumerate() {
            let viewer = UserIdentity::new(1.0, [], Some("v"), Some("viewer"));
            let probe = MessageInput {
                text: "probe".into(),
                ..MessageInput::default()
            };
            if let RuleOutcome::Failed(error) = rule.check(&probe, &viewer) {
                panic!("{name}: rule {index} cannot be compiled: {error}");
            }
        }
        let checks = time_checks(&compiled);
        println!(
            "{name}: compile {compile:?}, compiled variation heap {} KiB, one check (44 / 500 / 500 emoji / 500 caps chars): {checks:?}",
            compiled.memory_usage() / 1024
        );
        assert!(
            compile < Duration::from_secs(120),
            "{name}: compile {compile:?}"
        );
        assert!(
            checks.iter().all(|c| *c < Duration::from_secs(2)),
            "{name}: {checks:?}"
        );
    }
}

#[test]
fn the_cache_is_bounded() {
    let cache = CompiledSettingsCache::new(CacheLimits {
        channels: 3,
        bytes: 1024 * 1024,
    });
    let channel = |id: &str, version: i32| {
        let mut settings = (*typical()).clone();
        settings.channel_id = id.to_owned();
        settings.settings_version.0 = f64::from(version);
        Arc::new(settings)
    };
    let first = cache.get_or_compile(channel("a", 1));
    assert!(
        Arc::ptr_eq(&first, &cache.get_or_compile(channel("a", 1))),
        "reused for the same revision"
    );
    assert!(
        !Arc::ptr_eq(&first, &cache.get_or_compile(channel("a", 2))),
        "recompiled for a new one"
    );
    for id in ["b", "c", "d", "e"] {
        cache.get_or_compile(channel(id, 1));
    }
    assert_eq!(cache.len(), 3);
    // The byte budget: 1 MiB holds at most 16 entries of the 64 KiB minimum.
    let small = CompiledSettingsCache::new(CacheLimits {
        channels: 1000,
        bytes: 4 * 64 * 1024,
    });
    for i in 0..10 {
        small.get_or_compile(channel(&format!("c{i}"), 1));
    }
    assert_eq!(small.len(), 4);
    assert!(small.bytes() <= 4 * 64 * 1024);
    small.invalidate("c9");
    assert_eq!(small.len(), 3);
    // An entry over the whole budget is kept alone rather than recompiled on every message.
    let tiny = CompiledSettingsCache::new(CacheLimits {
        channels: 10,
        bytes: 1024,
    });
    tiny.get_or_compile(channel("p", 1));
    let big = tiny.get_or_compile(channel("q", 1));
    assert_eq!(tiny.len(), 1);
    assert!(Arc::ptr_eq(&big, &tiny.get_or_compile(channel("q", 1))));
    // The least recently used is the one dropped.
    let lru = CompiledSettingsCache::new(CacheLimits {
        channels: 2,
        bytes: usize::MAX,
    });
    let kept = lru.get_or_compile(channel("x", 1));
    lru.get_or_compile(channel("y", 1));
    lru.get_or_compile(channel("x", 1));
    lru.get_or_compile(channel("z", 1));
    assert!(Arc::ptr_eq(&kept, &lru.get_or_compile(channel("x", 1))));
}
