//! Every streamer-written pattern and keyword in the local `domdimabot` copy (a stale
//! production copy, read only: nothing is written) compiles, validates and indexes within this
//! crate's bounds.
//!
//! Patterns live in `channel_moderation_settings.rules[]`: `patterns[]` (`advanced.ts`), and
//! `variations` (`variations.ts`): `entries[].pattern.source`, `overrides[].source`, combined
//! per rule by `rulePatterns` (an override replaces its term's entry). Generated entries also
//! sit in `moderation_variation_caches.entry` and `moderation_variation_jobs.entries[]`.
//! Keywords are `commands` with `activation: 'keyword'` (`cmd`, `keywordSettings`).
//!
//! The combined rule is checked from the stored sources. The reference recompiles a generated
//! entry from its spellings when the rule's spacing or symbol mode differs from the entry's
//! (`withVariationSpacing`); that rewrite belongs to the moderation package and is not here.
//!
//! A refused pattern stops a moderation rule after the cutover, so every refusal fails the
//! test with its reason, unless it is listed in [`DECIDED`] with the decision taken.
//! Skipped when the copy is missing, unless `DIMA_TEST_REQUIRE_STORES=1` (`tools/test-env`).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;

use anyhow::{Result, bail};
use bson::{Bson, Document, doc};
use dima_commands::keywords::{self, KeywordEntry, KeywordIndex, KeywordMatchMode};
use dima_commands::patterns::{self, Boundary, CompiledAlternation, CompiledPattern};
use dima_store::mongo::{MongoConfig, MongoStore};
use futures_util::TryStreamExt;

const DATABASE: &str = "domdimabot";

/// Stored patterns refused on purpose: `(source, decision)`. Empty: nothing is refused.
const DECIDED: &[(&str, &str)] = &[];

async fn store() -> Result<Option<MongoStore>> {
    let required = std::env::var("DIMA_TEST_REQUIRE_STORES").is_ok_and(|value| value == "1");
    let skip = |message: &str| -> Result<Option<MongoStore>> {
        if required {
            bail!("{message} (DIMA_TEST_REQUIRE_STORES=1)");
        }
        eprintln!("skipped: {message}");
        Ok(None)
    };
    let Ok(uri) = std::env::var("DIMA_TEST_MONGO_URI") else {
        return skip("DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")");
    };
    let mut config = MongoConfig::new(uri);
    config.database = Some(DATABASE.into());
    let store = MongoStore::connect(&config, None).await?;
    let names = store.client().list_database_names().await?;
    if !names.iter().any(|name| name == DATABASE) {
        return skip("the local domdimabot copy is not present");
    }
    Ok(Some(store))
}

async fn all(store: &MongoStore, collection: &str, filter: Document) -> Result<Vec<Document>> {
    Ok(store
        .documents(collection)
        .find(filter)
        .await?
        .try_collect()
        .await?)
}

fn string<'a>(document: &'a Document, key: &str) -> Option<&'a str> {
    document.get_str(key).ok()
}

fn documents<'a>(document: &'a Document, key: &str) -> Vec<&'a Document> {
    document
        .get_array(key)
        .map(|items| items.iter().filter_map(Bson::as_document).collect())
        .unwrap_or_default()
}

#[derive(Default)]
struct Report {
    checked: usize,
    refused: Vec<String>,
    /// (bytes, where)
    largest: Vec<(usize, String)>,
}

impl Report {
    fn pattern(&mut self, place: String, source: &str, boundary: Boundary, ignore_case: bool) {
        self.checked += 1;
        self.largest.push((source.len(), place.clone()));
        let compiled = CompiledPattern::new(source, boundary, ignore_case)
            .and_then(|_| patterns::validate_user_pattern(source, ignore_case));
        if let Err(error) = compiled
            && !DECIDED.iter().any(|(decided, _)| *decided == source)
        {
            self.refused
                .push(format!("{place}: {error} ({} bytes)", source.len()));
        }
    }

    /// A generated or edited variation source: saved with `test('')`, matched whole word.
    fn variation(&mut self, place: String, source: &str) {
        self.pattern(place, source, Boundary::WholeWord, true);
    }
}

fn entry_source(entry: &Document) -> Option<&str> {
    entry
        .get_document("pattern")
        .ok()
        .and_then(|pattern| string(pattern, "source"))
}

#[tokio::test]
async fn every_stored_pattern_compiles_within_the_bounds() -> Result<()> {
    let Some(store) = store().await? else {
        return Ok(());
    };
    let mut report = Report::default();
    let mut rules = 0;
    let mut combined: Vec<(usize, usize, usize, String)> = Vec::new();
    let settings = all(&store, "channel_moderation_settings", doc! {}).await?;
    if settings.is_empty() {
        bail!("channel_moderation_settings is empty in the copy");
    }
    for document in &settings {
        let channel = string(document, "channelID").unwrap_or("?");
        for (index, rule) in documents(document, "rules").into_iter().enumerate() {
            rules += 1;
            let place = format!("channel {channel} rule {index}");
            for pattern in documents(rule, "patterns") {
                let source = string(pattern, "source").unwrap_or_default();
                let boundary = match string(pattern, "boundary") {
                    Some("anywhere") => Boundary::Anywhere,
                    _ => Boundary::WholeWord,
                };
                let ignore_case = pattern.get_bool("ignoreCase").unwrap_or(true);
                report.pattern(format!("{place} pattern"), source, boundary, ignore_case);
            }
            let Ok(variations) = rule.get_document("variations") else {
                continue;
            };
            let overrides: BTreeMap<&str, &str> = documents(variations, "overrides")
                .into_iter()
                .filter_map(|item| Some((string(item, "term")?, string(item, "source")?)))
                .collect();
            for source in overrides.values() {
                report.variation(format!("{place} override"), source);
            }
            let entries = documents(variations, "entries");
            for entry in &entries {
                if let Some(source) = entry_source(entry) {
                    report.variation(format!("{place} entry"), source);
                }
            }
            if string(variations, "mode").is_none_or(|mode| mode == "off") || entries.is_empty() {
                continue;
            }
            // `rulePatterns`: one combined alternation, an override in place of its entry.
            let components: Vec<&str> = entries
                .iter()
                .filter_map(|entry| {
                    let term = string(entry, "term")?;
                    overrides.get(term).copied().or_else(|| entry_source(entry))
                })
                .collect();
            let bytes = components.iter().map(|source| source.len()).sum();
            match CompiledAlternation::new(components.iter().copied()) {
                Ok(rule) => {
                    combined.push((bytes, rule.chunk_count(), rule.memory_usage(), place));
                }
                Err(error) => report
                    .refused
                    .push(format!("{place} combined rule: {error}")),
            }
        }
    }
    for document in all(&store, "moderation_variation_caches", doc! {}).await? {
        if let Some(source) = document.get_document("entry").ok().and_then(entry_source) {
            report.variation(format!("variation cache {:?}", document.get("_id")), source);
        }
    }
    for document in all(&store, "moderation_variation_jobs", doc! {}).await? {
        for entry in documents(&document, "entries") {
            if let Some(source) = entry_source(entry) {
                report.variation(format!("variation job {:?}", document.get("_id")), source);
            }
        }
    }
    report.largest.sort_by_key(|item| std::cmp::Reverse(item.0));
    combined.sort_by_key(|item| std::cmp::Reverse(item.0));
    eprintln!(
        "{} settings documents, {rules} rules, {} patterns checked, {} combined rules",
        settings.len(),
        report.checked,
        combined.len()
    );
    for (bytes, place) in report.largest.iter().take(3) {
        eprintln!("largest pattern: {bytes} bytes, {place}");
    }
    for (bytes, chunks, memory, place) in combined.iter().take(3) {
        eprintln!(
            "largest combined rule: {bytes} bytes, {chunks} chunk(s), {memory} bytes compiled, {place}"
        );
    }
    assert!(
        report.refused.is_empty(),
        "{} stored patterns refused (each needs a decision):\n{}",
        report.refused.len(),
        report.refused.join("\n")
    );
    Ok(())
}

#[tokio::test]
async fn every_stored_keyword_validates_and_indexes() -> Result<()> {
    let Some(store) = store().await? else {
        return Ok(());
    };
    let rows = all(&store, "commands", doc! { "activation": "keyword" }).await?;
    if rows.is_empty() {
        bail!("the copy has no keyword commands");
    }
    let mut refused = Vec::new();
    let mut channels: BTreeMap<String, Vec<KeywordEntry>> = BTreeMap::new();
    for row in &rows {
        let id = row.get("_id").map(ToString::to_string).unwrap_or_default();
        let cmd = row.get("cmd").cloned().unwrap_or(Bson::Null);
        let settings = row.get("keywordSettings").cloned().unwrap_or(Bson::Null);
        let stored_mode = settings
            .as_document()
            .and_then(|settings| string(settings, "matchMode"));
        // A row without settings loads as `start`; its text must still validate.
        let check = match stored_mode {
            Some(_) => keywords::validate_keyword(&cmd, &settings).map(|_| ()),
            None => {
                keywords::validate_keyword(&cmd, &Bson::Document(doc! { "matchMode": "start" }))
                    .map(|_| ())
            }
        };
        if let Err(error) = check {
            refused.push(format!("{id}: {error}"));
        }
        let text = keywords::normalize_keyword(cmd.as_str().unwrap_or_default());
        if cmd.as_str() != Some(text.as_str()) {
            refused.push(format!("{id}: stored keyword is not normalised"));
        }
        let channel = string(row, "channelID").unwrap_or("?").to_owned();
        channels.entry(channel).or_default().push(KeywordEntry {
            id,
            text,
            match_mode: KeywordMatchMode::from_stored(stored_mode),
        });
    }
    let mut largest: Vec<(usize, usize, String)> = channels
        .into_iter()
        .map(|(channel, entries)| {
            let count = entries.len();
            let index = KeywordIndex::new(entries.iter().cloned());
            for entry in &entries {
                let message = keywords::PreparedMessage::new(&entry.text);
                assert!(
                    message
                        .match_index(&index)
                        .iter()
                        .any(|found| found.id == entry.id),
                    "{channel}: keyword {} does not match its own text",
                    entry.id
                );
            }
            (count, index.word_count(), channel)
        })
        .collect();
    largest.sort_by_key(|item| std::cmp::Reverse(item.0));
    eprintln!("{} keywords in {} channels", rows.len(), largest.len());
    for (count, words, channel) in largest.iter().take(3) {
        eprintln!(
            "largest keyword index: {count} keywords, {words} first words, channel {channel}"
        );
    }
    let longest = rows
        .iter()
        .filter_map(|row| string(row, "cmd"))
        .map(|cmd| cmd.chars().count())
        .max()
        .unwrap_or(0);
    eprintln!("longest keyword: {longest} characters");
    assert!(refused.is_empty(), "{}", refused.join("\n"));
    Ok(())
}
