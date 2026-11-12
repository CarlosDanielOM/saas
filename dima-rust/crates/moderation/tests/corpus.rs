//! Replays `corpus/rules_corpus.json.gz`, recorded from the reference by `corpus/generate.mjs`
//! (the compiled TypeScript in the reference image, Node 24.22, Unicode 17): chat messages
//! times moderation settings times chatters, with every rule's outcome, plus tables for the
//! Unicode classes and folding, variations, permits, the offense ladder and spam protection.
//!
//! Every difference must be an intended one, named in [`Kind`] with its reason and the
//! direction it moves a verdict, and is counted (printed with `--nocapture`).
//!
//! The 28 stored settings are read from the local `domdimabot` copy at test time (read-only):
//! the fixture holds only their ids, revisions and verdicts, and the messages that use their
//! words are templates expanded here. With `DIMA_TEST_REQUIRE_STORES=1` a missing database, or
//! a copy that no longer matches the recording, fails the test.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeMap;
use std::io::Read;
use std::sync::Arc;

use bson::{Bson, Document, doc};
use dima_commands::permissions::{RoleTag, UserIdentity};
use dima_model::channel_moderation_settings::ChannelModerationSettings;
use dima_moderation::rules::engine::rule_variations;
use dima_moderation::rules::normalize::fold_text;
use dima_moderation::rules::{CompiledSettings, MessageInput, RuleOutcome};
use regex_syntax::hir::{Class, HirKind};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

fn corpus() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/corpus/rules_corpus.json.gz"
    );
    let mut text = String::new();
    flate2::read::GzDecoder::new(std::fs::File::open(path).unwrap())
        .read_to_string(&mut text)
        .unwrap();
    serde_json::from_str(&text).unwrap()
}

fn short(text: &str) -> String {
    format!("#{}", &hex::encode(Sha256::digest(text.as_bytes()))[..16])
}

/// Why Rust's outcome differs from the reference's, on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    /// A pattern RE2 accepts and the translation refuses (`\C`, one byte: a match could end
    /// inside a character). The reference matches; Rust stops checking the message (the
    /// reference's own handling of a pattern it cannot compile): more lenient for viewers. No
    /// stored pattern uses it.
    RefusedPattern,
    /// A rule stored without a numeric field: the reference compares with `undefined`, the model
    /// reads the schema default. Without `minCapsCount` or `maxEmoteCount` the reference never
    /// fires and Rust can (stricter); without `minMessageLength` the reference skips the length
    /// check and Rust applies 10 letters (more lenient). No stored rule lacks a field (every
    /// stored rule has all of them; the settings service writes them all), so neither direction
    /// reaches a viewer.
    MissingField,
}

fn identity(value: &Value) -> UserIdentity {
    let name = value["name"].as_str().unwrap();
    let tags = value["tags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tag| RoleTag::parse(tag.as_str().unwrap()).unwrap());
    UserIdentity::new(
        value["level"].as_f64().unwrap(),
        tags,
        Some(&format!("id-{name}")),
        Some(name),
    )
}

fn input(message: &Value) -> MessageInput {
    let emotes: Vec<String> = message["emotes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e.as_str().unwrap().to_owned())
        .collect();
    MessageInput {
        text: message["text"].as_str().unwrap().to_owned(),
        emote_count: emotes.len(),
        emote_texts: emotes,
    }
}

/// The outcomes in the recorder's encoding (clear rules left out).
fn encode(outcomes: &[(usize, RuleOutcome)], hide: bool) -> Value {
    let hide_text = |text: &str| if hide { short(text) } else { text.to_owned() };
    let mut out = Vec::new();
    for (index, outcome) in outcomes {
        match outcome {
            RuleOutcome::Exempt => out.push(json!([index, "x"])),
            RuleOutcome::Failed(_) => out.push(json!([index, "f"])),
            RuleOutcome::Hit(hit) => {
                let matches: Vec<Value> = hit
                    .matches
                    .iter()
                    .map(|m| json!([m.matcher_id, m.start, m.end, hide_text(&m.text)]))
                    .collect();
                out.push(json!([
                    index,
                    "h",
                    u8::from(hit.triggered),
                    hide_text(&hit.detail),
                    hit.mode.as_str(),
                    u8::from(hit.advanced),
                    matches
                ]));
            }
            RuleOutcome::Clear | RuleOutcome::Disabled => {}
        }
    }
    Value::Array(out)
}

fn settings_from_json(value: &Value) -> Arc<ChannelModerationSettings> {
    let bson = Bson::try_from(value.clone()).unwrap();
    let Bson::Document(document) = bson else {
        panic!("settings are not a document")
    };
    Arc::new(bson::deserialize_from_document(document).unwrap())
}

/// Recorded outcomes by (settings, message, identity).
fn recorded(results: &Value) -> BTreeMap<(u64, u64, u64), Value> {
    results
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            let key = (
                row[0].as_u64().unwrap(),
                row[1].as_u64().unwrap(),
                row[2].as_u64().unwrap(),
            );
            (key, row[3].clone())
        })
        .collect()
}

fn in_subset(message: usize) -> bool {
    message % 8 == 0
}

/// The kind of an intended difference, or `None`.
fn classify(name: &str, rust: &Value, reference: &Value) -> Option<Kind> {
    match name {
        // Rust stops at the refused pattern; the reference went on.
        "pattern-byte" => {
            let failed = rust.as_array()?.iter().any(|o| o[1] == "f");
            failed.then_some(Kind::RefusedPattern)
        }
        // Rules 0-2 each lack one field; rule 3 lacks only optional ones and must agree.
        "missing-fields" => {
            let differs_only_in_0_to_2 = |a: &Value, b: &Value| {
                let keep = |list: &Value| -> Vec<Value> {
                    list.as_array()
                        .into_iter()
                        .flatten()
                        .filter(|o| o[0].as_u64().is_some_and(|i| i > 2))
                        .cloned()
                        .collect()
                };
                keep(a) == keep(b)
            };
            differs_only_in_0_to_2(rust, reference).then_some(Kind::MissingField)
        }
        _ => None,
    }
}

#[test]
fn synthetic_settings_replay_the_reference() {
    let corpus = corpus();
    let identities: Vec<UserIdentity> = corpus["identities"]
        .as_array()
        .unwrap()
        .iter()
        .map(identity)
        .collect();
    let messages: Vec<MessageInput> = corpus["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(input)
        .collect();
    let expected = recorded(&corpus["results"]["synthetic"]);
    let mut cases = 0_usize;
    let mut hits = 0_usize;
    let mut kinds: BTreeMap<Kind, usize> = BTreeMap::new();
    let mut unexplained = Vec::new();
    let empty = json!([]);
    for (s, entry) in corpus["synthetic"].as_array().unwrap().iter().enumerate() {
        let name = entry["name"].as_str().unwrap();
        let compiled = CompiledSettings::compile(settings_from_json(&entry["settings"]));
        for (m, message) in messages.iter().enumerate() {
            for (i, identity) in identities.iter().enumerate() {
                if i > 0 && !in_subset(m) {
                    continue;
                }
                cases += 1;
                let rust = encode(&compiled.check_all(message, identity), false);
                let reference = expected
                    .get(&(s as u64, m as u64, i as u64))
                    .unwrap_or(&empty);
                if rust.as_array().is_some_and(|r| !r.is_empty()) {
                    hits += 1;
                }
                if &rust == reference {
                    continue;
                }
                match classify(name, &rust, reference) {
                    Some(kind) => *kinds.entry(kind).or_default() += 1,
                    None => unexplained.push(format!(
                        "{name} / message {m} {:?} / identity {i}\n  rust:      {rust}\n  reference: {reference}",
                        message.text.chars().take(80).collect::<String>()
                    )),
                }
            }
        }
    }
    assert_eq!(
        cases as u64,
        corpus["meta"]["syntheticCases"].as_u64().unwrap()
    );
    println!("synthetic: {cases} cases, {hits} with an outcome, intended differences {kinds:?}");
    assert!(
        unexplained.is_empty(),
        "{} unexplained differences:\n{}",
        unexplained.len(),
        unexplained
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
    // Each intended kind is exercised (the corpus is meant to show it).
    assert!(kinds.contains_key(&Kind::RefusedPattern) && kinds.contains_key(&Kind::MissingField));
}

fn stored_words(settings: &ChannelModerationSettings) -> Vec<String> {
    let mut words = Vec::new();
    for rule in &settings.rules {
        if rule.r#type.as_str() == "blacklist" {
            words.extend(rule.terms.expose().iter().flatten().cloned());
        }
    }
    let entries: Vec<_> = settings
        .rules
        .iter()
        .filter_map(|rule| rule_variations(rule).ok().flatten())
        .collect();
    for variations in &entries {
        words.extend(variations.entries.iter().map(|e| e.term.clone()));
    }
    for variations in &entries {
        for entry in &variations.entries {
            words.extend(entry.spellings.iter().cloned());
        }
    }
    words
}

fn transform(word: &str, how: &str) -> String {
    match how {
        "n" => word.to_owned(),
        "u" => dima_text::to_upper(word),
        "s" => word.chars().map(String::from).collect::<Vec<_>>().join(" "),
        "r" => {
            let letter = regex::Regex::new(r"\p{L}").unwrap();
            letter
                .replacen(word, 1, |c: &regex::Captures<'_>| c[0].repeat(3))
                .into_owned()
        }
        "l" => word
            .chars()
            .map(|c| match c {
                'a' => '4',
                'e' => '3',
                'i' => '1',
                'o' => '0',
                's' => '5',
                't' => '7',
                other => other,
            })
            .collect(),
        "d" => word.nfd().collect(),
        "z" => word
            .chars()
            .map(String::from)
            .collect::<Vec<_>>()
            .join("\u{200b}"),
        other => panic!("transform {other}"),
    }
}

fn expand(template: &str, words: &[String]) -> Option<String> {
    let placeholder = regex::Regex::new(r"\{\{W:(\d+):([a-z])\}\}").unwrap();
    let mut ok = true;
    let text = placeholder.replace_all(template, |c: &regex::Captures<'_>| {
        match words.get(c[1].parse::<usize>().unwrap()) {
            Some(word) => transform(word, &c[2]),
            None => {
                ok = false;
                String::new()
            }
        }
    });
    ok.then(|| text.into_owned())
}

fn stores_required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").is_ok_and(|v| v == "1")
}

#[tokio::test]
async fn stored_settings_replay_the_reference() {
    let Ok(uri) = std::env::var("DIMA_TEST_MONGO_URI") else {
        assert!(!stores_required(), "DIMA_TEST_MONGO_URI is not set");
        eprintln!("skipped: DIMA_TEST_MONGO_URI is not set");
        return;
    };
    let client = mongodb::Client::with_uri_str(&uri).await.unwrap();
    let collection = client
        .database("domdimabot")
        .collection::<Document>("channel_moderation_settings");
    let mut cursor = match collection.find(doc! {}).sort(doc! { "_id": 1 }).await {
        Ok(cursor) => cursor,
        Err(error) => {
            assert!(
                !stores_required(),
                "the local MongoDB cannot be read: {error}"
            );
            eprintln!("skipped: {error}");
            return;
        }
    };
    let mut documents = Vec::new();
    while cursor.advance().await.unwrap() {
        documents.push(cursor.deserialize_current().unwrap());
    }
    let corpus = corpus();
    let recorded_docs = corpus["real"].as_array().unwrap();
    assert_eq!(
        documents.len(),
        recorded_docs.len(),
        "the local copy changed: regenerate the corpus"
    );
    let identities: Vec<UserIdentity> = corpus["identities"]
        .as_array()
        .unwrap()
        .iter()
        .map(identity)
        .collect();
    let messages = corpus["messages"].as_array().unwrap();
    let templates = corpus["templates"].as_array().unwrap();
    let expected = recorded(&corpus["results"]["real"]);
    let empty = json!([]);
    let (mut cases, mut hits, mut patterns, mut compiled_patterns) =
        (0_usize, 0_usize, 0_usize, 0_usize);
    let mut unexplained = Vec::new();
    for (d, (document, recorded_doc)) in documents.into_iter().zip(recorded_docs).enumerate() {
        let settings: ChannelModerationSettings =
            bson::deserialize_from_document(document).unwrap();
        assert_eq!(settings.id.to_hex(), recorded_doc["id"].as_str().unwrap());
        assert_eq!(
            Some(settings.settings_version.0),
            recorded_doc["settingsVersion"].as_f64()
        );
        assert_eq!(
            settings.updated_at.map(|d| d.0),
            recorded_doc["updatedAt"].as_i64(),
            "the local copy changed: regenerate the corpus"
        );
        let words = stored_words(&settings);
        let compiled = CompiledSettings::compile(Arc::new(settings));
        // Every stored pattern and variation compiles (a refusal would show as `f`).
        for rule in compiled.settings().rules.iter() {
            patterns += rule.patterns.len();
            if let Ok(Some(variations)) = rule_variations(rule) {
                patterns += usize::from(!variations.is_off() && !variations.entries.is_empty());
            }
        }
        let all: Vec<Option<MessageInput>> = messages
            .iter()
            .map(|m| Some(input(m)))
            .chain(templates.iter().map(|t| {
                expand(t["text"].as_str().unwrap(), &words).map(|text| MessageInput {
                    text,
                    emote_texts: Vec::new(),
                    emote_count: 0,
                })
            }))
            .collect();
        let mut failed = false;
        for (m, message) in all.iter().enumerate() {
            let Some(message) = message else { continue };
            for (i, identity) in identities.iter().enumerate() {
                if i > 0 && !in_subset(m) {
                    continue;
                }
                cases += 1;
                let outcomes = compiled.check_all(message, identity);
                failed |= outcomes
                    .iter()
                    .any(|(_, o)| matches!(o, RuleOutcome::Failed(_)));
                let rust = encode(&outcomes, true);
                if rust.as_array().is_some_and(|r| !r.is_empty()) {
                    hits += 1;
                }
                let reference = expected
                    .get(&(d as u64, m as u64, i as u64))
                    .unwrap_or(&empty);
                if &rust != reference {
                    unexplained.push(format!("stored settings {d} / message {m} / identity {i}\n  rust:      {rust}\n  reference: {reference}"));
                }
            }
        }
        if !failed {
            compiled_patterns += compiled
                .settings()
                .rules
                .iter()
                .map(|rule| {
                    rule.patterns.len()
                        + rule_variations(rule)
                            .ok()
                            .flatten()
                            .map_or(0, |v| usize::from(!v.is_off() && !v.entries.is_empty()))
                })
                .sum::<usize>();
        }
    }
    assert_eq!(cases as u64, corpus["meta"]["realCases"].as_u64().unwrap());
    println!(
        "stored: {cases} cases, {hits} with an outcome; patterns {compiled_patterns}/{patterns} compile"
    );
    assert_eq!(compiled_patterns, patterns);
    assert!(
        unexplained.is_empty(),
        "{} unexplained differences:\n{}",
        unexplained.len(),
        unexplained
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

fn rust_ranges(pattern: &str) -> Vec<(u32, u32)> {
    let hir = regex_syntax::ParserBuilder::new()
        .build()
        .parse(pattern)
        .unwrap();
    let HirKind::Class(Class::Unicode(class)) = hir.kind() else {
        panic!("{pattern}")
    };
    class
        .ranges()
        .iter()
        .map(|r| (r.start() as u32, r.end() as u32))
        .collect()
}

fn contains(ranges: &[(u32, u32)], cp: u32) -> bool {
    ranges.iter().any(|&(a, b)| a <= cp && cp <= b)
}

/// The Unicode classes and the per-character fold agree with Node's except for characters the
/// `regex` crate's Unicode 16 tables do not assign (Unicode 17 additions): those are no letter,
/// mark or number here, so a message made of them cannot fire the caps rule and a blocked word
/// containing them folds differently. Counted.
#[test]
fn unicode_tables_differ_only_by_unicode_17_additions() {
    let corpus = corpus();
    let unassigned = rust_ranges(r"\p{Cn}");
    let mut differences = BTreeMap::new();
    for class in ["L", "Lu", "M", "N"] {
        let js: Vec<(u32, u32)> = corpus["unicode"][class]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| (r[0].as_u64().unwrap() as u32, r[1].as_u64().unwrap() as u32))
            .collect();
        let rust = rust_ranges(&format!(r"\p{{{class}}}"));
        let mut count = 0;
        for cp in (0..0x11_0000_u32).filter(|cp| !(0xd800..=0xdfff).contains(cp)) {
            if contains(&js, cp) != contains(&rust, cp) {
                assert!(
                    contains(&unassigned, cp),
                    "\\p{{{class}}} differs at U+{cp:04X}, which Unicode 16 assigns"
                );
                count += 1;
            }
        }
        differences.insert(class, count);
    }
    let folds: BTreeMap<u32, String> = corpus["unicode"]["fold"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f[0].as_u64().unwrap() as u32,
                f[1].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let mut fold_differences = 0;
    for ch in (0..0x11_0000_u32).filter_map(char::from_u32) {
        let expected = folds
            .get(&(ch as u32))
            .cloned()
            .unwrap_or_else(|| ch.to_string());
        if fold_text(&ch.to_string()) != expected {
            assert!(
                contains(&unassigned, ch as u32),
                "fold differs at U+{:04X}",
                ch as u32
            );
            fold_differences += 1;
        }
    }
    println!(
        "Unicode 17 additions classified differently: {differences:?}, folded differently: {fold_differences}"
    );
}
