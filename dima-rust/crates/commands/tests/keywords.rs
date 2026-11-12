//! Ported from `utils/keywords.test.ts`, plus the shared cache protocol and hostile input.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dima_commands::keywords::{
    self, BODY_SCRIPT, KeywordCacheError, KeywordCacheLimits, KeywordEntry, KeywordIndex,
    KeywordIndexCache, KeywordLoader, KeywordMatchMode, KeywordRow, KeywordStorage,
    KeywordStorageError, Overload, PreparedMessage, SHARED_INDEX_SCRIPT, SharedKeywordLoader,
};
use dima_core::{Clock, ManualClock};
use serde_json::{Value, json};

fn entry(text: &str, mode: KeywordMatchMode) -> KeywordEntry {
    entry_id(text, mode, text)
}

fn entry_id(text: &str, mode: KeywordMatchMode, id: &str) -> KeywordEntry {
    KeywordEntry {
        id: id.into(),
        text: text.into(),
        match_mode: mode,
    }
}

fn ids(index: &KeywordIndex, message: &str) -> Vec<String> {
    keywords::match_keywords(index, message)
        .into_iter()
        .map(|entry| entry.id.clone())
        .collect()
}

use KeywordMatchMode::{Anywhere, Exact, Start};

#[test]
fn whole_words_capitalization_punctuation_unicode_and_repeated_words() {
    let index = KeywordIndex::new([
        entry("f", Anywhere),
        entry("hormiga", Anywhere),
        entry("éxito", Anywhere),
    ]);
    assert!(ids(&index, "failure hormiguero").is_empty());
    assert_eq!(ids(&index, "F! f f"), ["f"]);
    assert_eq!(ids(&index, "vi una HORMIGA hoy"), ["hormiga"]);
    assert_eq!(ids(&index, "¡ÉXITO!"), ["éxito"]);
    assert!(ids(&index, "éxitosa").is_empty());
}

#[test]
fn start_exact_rules_phrases_leading_whitespace_and_independent_matches() {
    let index = KeywordIndex::new([
        entry("f", Start),
        entry_id("f", Exact, "exact"),
        entry("hola mundo", Anywhere),
    ]);
    assert_eq!(ids(&index, " f "), ["f", "exact"]);
    assert_eq!(ids(&index, "f otra falla"), ["f"]);
    assert!(ids(&index, "otra falla f").is_empty());
    assert_eq!(ids(&index, "¡hola mundo!"), ["hola mundo"]);
    assert!(ids(&index, "hola mundoso").is_empty());
}

#[test]
fn validation_rejects_commands_regexes_empty_keywords_and_unsupported_modes() {
    let start = json!({ "matchMode": "start" });
    for text in ["", "!f", "a.*", &"a".repeat(61)] {
        assert!(
            keywords::validate_keyword(&json!(text), &start).is_err(),
            "{text}"
        );
    }
    assert!(keywords::validate_keyword(&json!("f"), &json!({ "matchMode": "regex" })).is_err());
    assert_eq!(
        keywords::validate_keyword(&json!("hola mundo"), &json!({ "matchMode": "anywhere" })),
        Ok(Anywhere)
    );
    assert_eq!(keywords::normalize_keyword("  HOLA   Mundo "), "hola mundo");
}

#[test]
fn limits_count_characters_in_every_script() {
    let start = json!({ "matchMode": "start" });
    let valid = |text: String| keywords::validate_keyword(&json!(text), &start).is_ok();
    for letter in ["a", "é", "𐐀", "𝐀", "𠀀", "م", "ש", "१"] {
        assert!(valid(letter.repeat(60)), "60 × {letter}");
        assert!(!valid(letter.repeat(61)), "61 × {letter}");
    }
    // Combining marks count one each, before NFC composes them.
    assert!(valid("a\u{301}".repeat(30)));
    assert!(!valid("a\u{301}".repeat(31)));
    // Emoji and joiners are not word characters.
    for text in ["😀", "hola😀", "a\u{200d}b", "👍🏽", "\u{200f}مرحبا"] {
        assert!(!valid(text.into()), "{text}");
    }
}

#[test]
fn keywords_made_of_combining_marks_only() {
    let marks = "\u{301}".repeat(60);
    assert!(keywords::validate_keyword(&json!(marks), &json!({ "matchMode": "anywhere" })).is_ok());
    let index = KeywordIndex::new([entry(&marks, Anywhere)]);
    assert_eq!(
        ids(&index, &format!("x {marks} y")),
        std::slice::from_ref(&marks)
    );
    // A mark after a letter is part of that letter's word.
    assert!(ids(&index, &format!("a{marks}")).is_empty());
    // A million marks in a message: linear work.
    let started = Instant::now();
    let message = "\u{301}".repeat(1_000_000);
    assert!(ids(&index, &message).is_empty());
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn hostile_messages_and_indexes_stay_linear_per_candidate() {
    let entries: Vec<_> = (0..2_000)
        .map(|index| entry_id(&format!("w{index} tail"), Anywhere, &format!("k{index}")))
        .collect();
    let index = KeywordIndex::new(entries);
    let message: String = (0..2_000)
        .map(|index| format!("w{index} "))
        .collect::<String>()
        + "w5 tail";
    let started = Instant::now();
    assert_eq!(ids(&index, &message), ["k5"]);
    // Overlapping occurrences of a phrase are all tried.
    let index = KeywordIndex::new([entry("a a", Anywhere)]);
    assert_eq!(ids(&index, "xa a a"), ["a a"]);
    let long = "a".repeat(200_000);
    let index = KeywordIndex::new([entry(&"a".repeat(100), Anywhere)]);
    assert!(ids(&index, &long).is_empty());
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn a_prepared_message_answers_every_entry() {
    let message = PreparedMessage::new("  ¡Hola   MUNDO! 😀 ");
    assert_eq!(message.text(), "¡hola mundo! 😀");
    assert_eq!(
        message.distinct_words().collect::<Vec<_>>(),
        ["hola", "mundo"]
    );
    assert!(message.matches(&entry("hola mundo", Anywhere)));
    assert!(!message.matches(&entry("hola mundo", Start)));
    assert!(message.matches(&entry("¡hola", Start)));
    assert!(!message.matches(&entry("hola", Exact)));
}

#[test]
fn stored_modes_read_like_the_reference_matcher() {
    assert_eq!(KeywordMatchMode::from_stored(None), Start);
    assert_eq!(KeywordMatchMode::from_stored(Some("exact")), Exact);
    assert_eq!(KeywordMatchMode::from_stored(Some("regex")), Anywhere);
    let entry: KeywordEntry =
        serde_json::from_value(json!({"id": "1", "text": "x", "matchMode": "exact"})).unwrap();
    assert_eq!(entry.match_mode, Exact);
    assert_eq!(
        serde_json::to_value(&entry).unwrap(),
        json!({"id": "1", "text": "x", "matchMode": "exact"})
    );
}

/// A loader the tests drive by hand.
struct Loader {
    reads: AtomicUsize,
    plan: Box<dyn Fn(usize) -> LoadPlan + Send + Sync>,
}

enum LoadPlan {
    Ready(Vec<KeywordEntry>),
    Fail,
    Wait(tokio::sync::oneshot::Receiver<Vec<KeywordEntry>>),
}

impl KeywordLoader for Loader {
    type Error = String;

    async fn load(&self, _: &str) -> Result<Vec<KeywordEntry>, String> {
        let read = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
        tokio::task::yield_now().await;
        match (self.plan)(read) {
            LoadPlan::Ready(entries) => Ok(entries),
            LoadPlan::Fail => Err("shared cache unavailable".into()),
            LoadPlan::Wait(receiver) => receiver.await.map_err(|_| "dropped".to_owned()),
        }
    }
}

fn clock() -> (Arc<ManualClock>, Arc<dyn Clock>) {
    let clock = Arc::new(ManualClock::new(1_000));
    let dynamic: Arc<dyn Clock> = clock.clone();
    (clock, dynamic)
}

#[tokio::test]
async fn simultaneous_loads_share_one_request_and_empty_indexes_stay_cached() {
    let loader = Loader {
        reads: AtomicUsize::new(0),
        plan: Box::new(|_| LoadPlan::Ready(Vec::new())),
    };
    let cache = Arc::new(KeywordIndexCache::new(loader, clock().1));
    let tasks: Vec<_> = (0..50)
        .map(|_| {
            let cache = Arc::clone(&cache);
            tokio::spawn(async move { cache.get("channel").await.unwrap().is_empty() })
        })
        .collect();
    for task in tasks {
        assert!(task.await.unwrap());
    }
    cache.get("channel").await.unwrap();
    assert_eq!(cache.loader().reads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn invalidation_discards_an_obsolete_in_flight_load_and_retries_from_shared_storage() {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let receiver = Mutex::new(Some(receiver));
    let loader = Loader {
        reads: AtomicUsize::new(0),
        plan: Box::new(move |read| match read {
            1 => LoadPlan::Wait(receiver.lock().unwrap().take().unwrap()),
            _ => LoadPlan::Ready(vec![entry("new", Start)]),
        }),
    };
    let cache = Arc::new(KeywordIndexCache::new(loader, clock().1));
    let stale = {
        let cache = Arc::clone(&cache);
        tokio::spawn(async move { cache.get("channel").await })
    };
    while cache.loader().reads.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    cache.invalidate("channel");
    sender.send(vec![entry("old", Start)]).unwrap();
    let index = stale.await.unwrap().unwrap();
    assert_eq!(index.bucket("new").len(), 1);
    assert!(index.bucket("old").is_empty());
    assert_eq!(cache.loader().reads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn failed_cold_load_is_retried_and_local_ttl_and_capacity_bound_memory() {
    let loader = Loader {
        reads: AtomicUsize::new(0),
        plan: Box::new(|read| {
            if read == 1 {
                LoadPlan::Fail
            } else {
                LoadPlan::Ready(Vec::new())
            }
        }),
    };
    let (manual, clock) = clock();
    let limits = |ttl_ms, channels| KeywordCacheLimits {
        ttl_ms,
        channels,
        ..KeywordCacheLimits::default()
    };
    let cache = KeywordIndexCache::with_limits(loader, Arc::clone(&clock), limits(0, 1));
    match cache.get("a").await.unwrap_err() {
        KeywordCacheError::Load(error) => assert_eq!(*error, "shared cache unavailable"),
        other => panic!("{other:?}"),
    }
    cache.get("a").await.unwrap();
    cache.get("a").await.unwrap();
    assert_eq!(
        cache.loader().reads.load(Ordering::SeqCst),
        3,
        "a zero TTL never serves"
    );

    let loader = Loader {
        reads: AtomicUsize::new(0),
        plan: Box::new(|_| LoadPlan::Ready(Vec::new())),
    };
    let bounded = KeywordIndexCache::with_limits(loader, clock, limits(60_000, 1));
    bounded.get("a").await.unwrap();
    bounded.get("b").await.unwrap();
    bounded.get("a").await.unwrap();
    assert_eq!(
        bounded.loader().reads.load(Ordering::SeqCst),
        3,
        "capacity 1 evicted a"
    );
    assert_eq!(bounded.len(), 1);
    manual.advance(60_000);
    bounded.get("a").await.unwrap();
    assert_eq!(
        bounded.loader().reads.load(Ordering::SeqCst),
        4,
        "expired after the TTL"
    );
}

#[tokio::test]
async fn a_dropped_loader_wakes_the_waiters() {
    let (sender, receiver) = tokio::sync::oneshot::channel::<Vec<KeywordEntry>>();
    let receiver = Mutex::new(Some(receiver));
    let loader = Loader {
        reads: AtomicUsize::new(0),
        plan: Box::new(move |read| match read {
            1 => LoadPlan::Wait(receiver.lock().unwrap().take().unwrap()),
            _ => LoadPlan::Ready(vec![entry("x", Start)]),
        }),
    };
    let cache = Arc::new(KeywordIndexCache::new(loader, clock().1));
    let first = {
        let cache = Arc::clone(&cache);
        tokio::spawn(async move { cache.get("c").await })
    };
    while cache.loader().reads.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    let waiter = {
        let cache = Arc::clone(&cache);
        tokio::spawn(async move { cache.get("c").await })
    };
    tokio::task::yield_now().await;
    first.abort();
    let _ = first.await;
    drop(sender);
    let index = waiter.await.unwrap().unwrap();
    assert_eq!(index.bucket("x").len(), 1);
}

/// MongoDB and Dragonfly in memory, with the revision fence of the two Lua scripts.
#[derive(Default)]
struct Storage {
    strings: Mutex<HashMap<String, String>>,
    rows: Mutex<Vec<KeywordRow>>,
    bodies: Mutex<HashMap<String, Value>>,
    published: Mutex<Vec<(String, String)>>,
    /// Revision bumps to apply while a query runs (an edit racing the load).
    racing_edits: AtomicUsize,
}

impl Storage {
    fn bump(&self, channel: &str) {
        let mut strings = self.strings.lock().unwrap();
        let key = keywords::keyword_revision_key(channel);
        let next = strings
            .get(&key)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
            + 1;
        strings.insert(key, next.to_string());
    }

    fn race(&self, channel: &str) {
        if self
            .racing_edits
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(1)
            })
            .is_ok()
        {
            self.bump(channel);
        }
    }
}

impl KeywordStorage for Storage {
    type Error = String;
    type Body = Value;

    async fn get(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.strings.lock().unwrap().get(key).cloned())
    }

    async fn query_index(&self, channel: &str, limit: usize) -> Result<Vec<KeywordRow>, String> {
        self.race(channel);
        Ok(self
            .rows
            .lock()
            .unwrap()
            .iter()
            .take(limit)
            .cloned()
            .collect())
    }

    async fn query_body(&self, channel: &str, id: &str) -> Result<Option<Value>, String> {
        self.race(channel);
        Ok(self.bodies.lock().unwrap().get(id).cloned())
    }

    async fn set_if_revision(
        &self,
        script: &'static str,
        data_key: &str,
        revision_key: &str,
        revision: &str,
        json: &str,
    ) -> Result<bool, String> {
        assert!(script == SHARED_INDEX_SCRIPT || script == BODY_SCRIPT);
        let mut strings = self.strings.lock().unwrap();
        let current = strings
            .get(revision_key)
            .cloned()
            .unwrap_or_else(|| "0".into());
        if current != revision {
            return Ok(false);
        }
        strings.insert(data_key.into(), json.into());
        Ok(true)
    }

    async fn invalidate_shared(
        &self,
        revision_key: &str,
        index_key: &str,
        body_key: Option<&str>,
    ) -> Result<(), String> {
        let channel = revision_key
            .trim_start_matches("keywords:revision:")
            .to_owned();
        self.bump(&channel);
        let mut strings = self.strings.lock().unwrap();
        strings.remove(index_key);
        if let Some(body) = body_key {
            strings.remove(body);
        }
        Ok(())
    }

    async fn publish(&self, topic: &str, json: &str) -> Result<(), String> {
        self.published
            .lock()
            .unwrap()
            .push((topic.into(), json.into()));
        Ok(())
    }

    async fn update_keyword_count(&self, _: &str, id: &str, count: f64) -> Result<(), String> {
        if let Some(body) = self.bodies.lock().unwrap().get_mut(id) {
            body["count"] = json!(count);
        }
        Ok(())
    }

    async fn delete(&self, key: &str) -> Result<(), String> {
        self.strings.lock().unwrap().remove(key);
        Ok(())
    }
}

#[tokio::test]
async fn the_shared_index_is_fenced_by_the_revision() {
    let storage = Arc::new(Storage::default());
    storage.rows.lock().unwrap().push(KeywordRow {
        id: "k1".into(),
        cmd: "  Hola  MUNDO ".into(),
        match_mode: KeywordMatchMode::from_stored(None),
    });
    // Two edits race the first two queries: the third attempt publishes.
    storage.racing_edits.store(2, Ordering::SeqCst);
    let entries = keywords::load_shared_index(storage.as_ref(), "c")
        .await
        .unwrap();
    assert_eq!(entries, [entry_id("hola mundo", Start, "k1")]);
    let shared = storage
        .strings
        .lock()
        .unwrap()
        .get("keywords:index:c")
        .cloned()
        .unwrap();
    assert_eq!(
        shared,
        r#"[{"id":"k1","text":"hola mundo","matchMode":"start"}]"#
    );
    // An edit on every attempt gives up after five.
    storage.strings.lock().unwrap().remove("keywords:index:c");
    storage.racing_edits.store(5, Ordering::SeqCst);
    let error = keywords::load_shared_index(storage.as_ref(), "c")
        .await
        .unwrap_err();
    assert!(matches!(error, KeywordStorageError::RepeatedIndexChange));
    assert_eq!(
        error.to_string(),
        "Keyword settings changed repeatedly while loading"
    );
    // A malformed shared value reports its position, never its text.
    storage
        .strings
        .lock()
        .unwrap()
        .insert("keywords:index:c".into(), "[{\"secret".into());
    let error = keywords::load_shared_index(storage.as_ref(), "c")
        .await
        .unwrap_err();
    assert!(!error.to_string().contains("secret"));
}

#[tokio::test]
async fn refresh_bumps_announces_and_warms_and_bodies_follow_the_fence() {
    let storage = Arc::new(Storage::default());
    storage
        .bodies
        .lock()
        .unwrap()
        .insert("k1".into(), json!({"_id": "k1", "cmd": "hola", "count": 1}));
    let cache = KeywordIndexCache::new(
        SharedKeywordLoader {
            storage: Arc::clone(&storage),
        },
        clock().1,
    );
    assert!(
        keywords::get_keyword_body(storage.as_ref(), "c", "k1")
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        storage
            .strings
            .lock()
            .unwrap()
            .contains_key("keywords:body:c:k1")
    );
    assert_eq!(
        keywords::get_keyword_body(storage.as_ref(), "c", "missing")
            .await
            .unwrap(),
        None
    );

    keywords::save_keyword_count(storage.as_ref(), "c", "k1", 2.0)
        .await
        .unwrap();
    assert!(
        !storage
            .strings
            .lock()
            .unwrap()
            .contains_key("keywords:body:c:k1")
    );
    assert_eq!(
        storage.strings.lock().unwrap().get("keywords:revision:c"),
        None,
        "counts keep the revision"
    );

    keywords::refresh_keyword_index(&cache, "c", Some("k1"))
        .await
        .unwrap();
    assert_eq!(
        storage
            .strings
            .lock()
            .unwrap()
            .get("keywords:revision:c")
            .map(String::as_str),
        Some("1")
    );
    assert_eq!(
        storage.published.lock().unwrap().as_slice(),
        [(
            "keywords:changed".to_owned(),
            r#"{"channelID":"c"}"#.to_owned()
        )]
    );
    assert_eq!(cache.len(), 1, "warmed");
    assert!(keywords::apply_keyword_change(
        &cache,
        &json!({"channelID": "c"})
    ));
    assert!(cache.is_empty());
    assert!(!keywords::apply_keyword_change(
        &cache,
        &json!({"channelID": ""})
    ));
    assert!(!keywords::apply_keyword_change(&cache, &json!({})));
}

fn entries(count: usize, prefix: &str) -> Vec<KeywordEntry> {
    (0..count)
        .map(|index| {
            entry_id(
                &format!("{prefix}{index}"),
                Anywhere,
                &format!("{prefix}{index}"),
            )
        })
        .collect()
}

#[tokio::test]
async fn a_channel_over_its_keyword_or_byte_limit_is_refused_and_the_refusal_cached() {
    let loader = Loader {
        reads: AtomicUsize::new(0),
        plan: Box::new(|_| LoadPlan::Ready(entries(4, "w"))),
    };
    let limits = KeywordCacheLimits {
        keywords_per_channel: 3,
        ..KeywordCacheLimits::default()
    };
    let cache = KeywordIndexCache::with_limits(loader, clock().1, limits);
    for _ in 0..3 {
        assert!(matches!(
            cache.get("big").await,
            Err(KeywordCacheError::Overloaded(Overload::TooManyKeywords {
                limit: 3
            }))
        ));
    }
    assert_eq!(
        cache.loader().reads.load(Ordering::SeqCst),
        1,
        "the refusal is cached"
    );

    let loader = Loader {
        reads: AtomicUsize::new(0),
        plan: Box::new(|_| LoadPlan::Ready(vec![entry(&"x".repeat(2_000), Exact)])),
    };
    let limits = KeywordCacheLimits {
        index_bytes: 1_000,
        ..KeywordCacheLimits::default()
    };
    let cache = KeywordIndexCache::with_limits(loader, clock().1, limits);
    assert!(matches!(
        cache.get("long").await,
        Err(KeywordCacheError::Overloaded(Overload::IndexTooLarge {
            limit: 1_000,
            ..
        }))
    ));
}

#[tokio::test]
async fn the_bytes_of_all_indexes_are_bounded_by_evicting_whole_channels() {
    let loader = Loader {
        reads: AtomicUsize::new(0),
        plan: Box::new(|_| LoadPlan::Ready(entries(20, "keyword"))),
    };
    let one = KeywordIndex::new(entries(20, "keyword")).heap_bytes() + 1;
    let limits = KeywordCacheLimits {
        total_bytes: one * 2 + 16,
        ..KeywordCacheLimits::default()
    };
    let cache = KeywordIndexCache::with_limits(loader, clock().1, limits);
    for channel in ["a", "b", "c", "d"] {
        assert_eq!(cache.get(channel).await.unwrap().len(), 20);
        assert!(
            cache.heap_bytes() <= limits.total_bytes,
            "{}",
            cache.heap_bytes()
        );
    }
    assert_eq!(cache.len(), 2);
    // "a" was evicted (the oldest), "d" was kept.
    cache.get("d").await.unwrap();
    assert_eq!(cache.loader().reads.load(Ordering::SeqCst), 4);
    cache.get("a").await.unwrap();
    assert_eq!(cache.loader().reads.load(Ordering::SeqCst), 5);
}

#[tokio::test]
async fn loads_in_flight_are_bounded_and_the_refusal_does_not_wait() {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let receiver = Mutex::new(Some(receiver));
    let loader = Loader {
        reads: AtomicUsize::new(0),
        plan: Box::new(move |read| match read {
            1 => LoadPlan::Wait(receiver.lock().unwrap().take().unwrap()),
            _ => LoadPlan::Ready(Vec::new()),
        }),
    };
    let limits = KeywordCacheLimits {
        loads_in_flight: 1,
        ..KeywordCacheLimits::default()
    };
    let cache = Arc::new(KeywordIndexCache::with_limits(loader, clock().1, limits));
    let slow = {
        let cache = Arc::clone(&cache);
        tokio::spawn(async move { cache.get("slow").await })
    };
    while cache.loads_in_flight() == 0 {
        tokio::task::yield_now().await;
    }
    // Another channel is refused at once; a caller of the channel in flight waits for it.
    assert!(matches!(
        cache.get("other").await,
        Err(KeywordCacheError::Overloaded(Overload::LoadsInFlight {
            limit: 1
        }))
    ));
    let waiter = {
        let cache = Arc::clone(&cache);
        tokio::spawn(async move { cache.get("slow").await })
    };
    sender.send(vec![entry("x", Start)]).unwrap();
    assert_eq!(slow.await.unwrap().unwrap().len(), 1);
    assert_eq!(waiter.await.unwrap().unwrap().len(), 1);
    assert_eq!(cache.loads_in_flight(), 0);
    cache.get("other").await.unwrap();
}

#[tokio::test]
async fn the_shared_index_never_reads_or_publishes_more_than_the_limit() {
    let storage = Storage::default();
    *storage.rows.lock().unwrap() = (0..=keywords::MAX_KEYWORDS_PER_CHANNEL)
        .map(|index| KeywordRow {
            id: format!("id{index}"),
            cmd: format!("word{index}"),
            match_mode: Start,
        })
        .chain([KeywordRow {
            id: "beyond".into(),
            cmd: "beyond".into(),
            match_mode: Start,
        }])
        .collect();
    let loaded = keywords::load_shared_index(&storage, "c").await.unwrap();
    assert_eq!(loaded.len(), keywords::MAX_KEYWORDS_PER_CHANNEL + 1);
    assert!(
        storage
            .strings
            .lock()
            .unwrap()
            .get("keywords:index:c")
            .is_none()
    );

    let oversized = format!("[{}]", " ".repeat(keywords::MAX_SHARED_INDEX_JSON_BYTES));
    storage
        .strings
        .lock()
        .unwrap()
        .insert("keywords:index:c".into(), oversized);
    assert!(matches!(
        keywords::load_shared_index(&storage, "c").await,
        Err(KeywordStorageError::SharedIndexTooLarge { .. })
    ));
}
