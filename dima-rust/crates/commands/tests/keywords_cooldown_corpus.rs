//! Keywords and cooldowns against the TypeScript reference.
//!
//! `fixtures/keywords_cooldown_cases.json` is written by
//! `fixtures/keywords_cooldown_reference.mjs` running today's `keywords.ts`,
//! `command_cooldown.ts` and `command_cooldown_write.ts` under Node 24. Cases must match as
//! recorded, except the intended differences in [`intended`], each of which counts the cases it
//! touches (the counts are pinned, so a new case that hits one is noticed).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::sync::Mutex;

use bson::{Bson, Document};
use dima_commands::cooldown::{self, CooldownError, CooldownStore, CurrentCommand};
use dima_commands::keywords::{
    self, KeywordEntry, KeywordError, KeywordIndex, KeywordMatchMode, PreparedMessage,
};
use dima_core::SeededRandom;
use serde_json::{Value, json};

const CORPUS: &str = include_str!("fixtures/keywords_cooldown_cases.json");

/// The corpus encoding (`$undefined`, `$number`) as BSON, which can hold both.
fn bson(value: &Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(flag) => Bson::Boolean(*flag),
        Value::Number(number) => Bson::Double(number.as_f64().unwrap()),
        Value::String(text) => Bson::String(text.clone()),
        Value::Array(items) => Bson::Array(items.iter().map(bson).collect()),
        Value::Object(map) => {
            if map.get("$undefined") == Some(&Value::Bool(true)) {
                return Bson::Undefined;
            }
            if let Some(Value::String(tag)) = map.get("$number") {
                return Bson::Double(match tag.as_str() {
                    "NaN" => f64::NAN,
                    "+Infinity" => f64::INFINITY,
                    "-Infinity" => f64::NEG_INFINITY,
                    "-0" => -0.0,
                    other => panic!("unknown number tag {other}"),
                });
            }
            Bson::Document(
                map.iter()
                    .map(|(k, v)| (k.clone(), bson(v)))
                    .collect::<Document>(),
            )
        }
    }
}

/// A present input property (`$undefined` reads as absent).
fn field<'a>(input: &'a Value, key: &str) -> Option<&'a Value> {
    input
        .get(key)
        .filter(|value| value.get("$undefined") != Some(&Value::Bool(true)))
}

fn entry(value: &Value) -> KeywordEntry {
    let mode = value["matchMode"].as_str().unwrap();
    KeywordEntry {
        id: value["id"].as_str().unwrap().into(),
        text: value["text"].as_str().unwrap().into(),
        // The loader reads stored modes this way; the corpus has one unknown mode.
        match_mode: KeywordMatchMode::from_stored(Some(mode)),
    }
}

/// Every place where this crate differs from the recorded JavaScript on purpose.
mod intended {
    use super::*;

    /// The 60 limit counts characters, not UTF-16 units (`MIGRATION.md` section 4, own limit
    /// on user text): a valid keyword with astral characters of more than 60 units and at most
    /// 60 characters is accepted.
    pub fn keyword_length_in_characters(text: &str) -> bool {
        dima_text::utf16_len(text) > 60
            && dima_text::char_len(text) <= 60
            && keywords::validate_keyword(&json!(text), &json!({ "matchMode": "start" })).is_ok()
    }

    /// V8 tries a match between the two UTF-16 halves of an astral character, where an empty
    /// keyword's lookarounds see lone surrogates and match. That position does not exist in
    /// UTF-8 (`MIGRATION.md` section 4, rule 2). Only an empty `anywhere` keyword can match
    /// there, and validation refuses empty keywords.
    pub fn empty_keyword_inside_astral(entry: &KeywordEntry, message: &str) -> bool {
        entry.text.is_empty()
            && entry.match_mode == KeywordMatchMode::Anywhere
            && keywords::normalize_keyword(message)
                .chars()
                .any(|ch| u32::from(ch) > 0xffff)
    }

    /// A non-string `matchMode` whose text is a mode: the reference accepts it at validation
    /// and stores the original value, which Mongoose then refuses; here it is refused at once.
    pub fn non_string_mode(settings: &Value) -> bool {
        settings
            .get("matchMode")
            .is_some_and(|mode| !mode.is_string() && !mode.is_null())
    }
}

#[derive(Default)]
struct Tally {
    empty_inside_astral: usize,
    keyword_length: usize,
    non_string_mode: usize,
}

fn check_keyword_case(case: &Value, tally: &mut Tally) -> Result<(), String> {
    let input = &case["input"];
    match case["operation"].as_str().unwrap() {
        "normalize_keyword" => {
            let actual = keywords::normalize_keyword(input["text"].as_str().unwrap());
            (case["expected"] == actual.as_str())
                .then_some(())
                .ok_or_else(|| format!("{actual:?} vs {}", case["expected"]))
        }
        "validate_keyword" => {
            let text = bson(&input["text"]);
            let settings = bson(&input["settings"]);
            let actual = keywords::validate_keyword(&text, &settings);
            let mut expected: Result<Value, String> = match case.get("error") {
                Some(error) => Err(error.as_str().unwrap().to_owned()),
                None => Ok(case["expected"]["matchMode"].clone()),
            };
            if let (Err(_), Some(raw)) = (&expected, input["text"].as_str())
                && intended::keyword_length_in_characters(raw)
            {
                tally.keyword_length += 1;
                expected = Ok(input["settings"]["matchMode"].clone());
            }
            if expected.is_ok() && intended::non_string_mode(&input["settings"]) {
                tally.non_string_mode += 1;
                expected = Err(KeywordError::MatchMode.to_string());
            }
            let actual = actual
                .map(|mode| Value::from(mode.as_str()))
                .map_err(|error| error.to_string());
            (actual == expected)
                .then_some(())
                .ok_or_else(|| format!("{actual:?} vs {expected:?}"))
        }
        "keyword_matches" => {
            let message = input["message"].as_str().unwrap();
            let entry = entry(&input["entry"]);
            let actual = keywords::keyword_matches(message, &entry);
            let mut expected = case["expected"].clone();
            if expected == Value::Bool(true)
                && !actual
                && intended::empty_keyword_inside_astral(&entry, message)
            {
                tally.empty_inside_astral += 1;
                expected = Value::Bool(false);
            }
            (expected == actual)
                .then_some(())
                .ok_or_else(|| format!("{actual} vs {expected}"))
        }
        "match_keywords" => {
            let entries: Vec<KeywordEntry> = input["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(entry)
                .collect();
            let index = KeywordIndex::new(entries);
            let matched =
                PreparedMessage::new(input["message"].as_str().unwrap()).match_index(&index);
            let expected = &case["expected"];
            let actual: Value = if expected
                .as_array()
                .is_some_and(|items| items.iter().all(Value::is_string))
            {
                matched
                    .iter()
                    .map(|entry| Value::from(entry.id.as_str()))
                    .collect()
            } else {
                serde_json::to_value(&matched).unwrap()
            };
            (&actual == expected)
                .then_some(())
                .ok_or_else(|| format!("{actual} vs {expected}"))
        }
        "compile_index" => {
            let entries: Vec<KeywordEntry> = input["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(entry)
                .collect();
            let index = KeywordIndex::new(entries);
            for bucket in case["expected"].as_array().unwrap() {
                let word = bucket[0].as_str().unwrap();
                let ids: Vec<&str> = index
                    .bucket(word)
                    .iter()
                    .map(|entry| entry.id.as_str())
                    .collect();
                let expected: Vec<&str> = bucket[1]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| id.as_str().unwrap())
                    .collect();
                if ids != expected {
                    return Err(format!("bucket {word:?}: {ids:?} vs {expected:?}"));
                }
            }
            (index.word_count() == case["expected"].as_array().unwrap().len())
                .then_some(())
                .ok_or_else(|| "bucket count".into())
        }
        "minimum_cooldown" => {
            let plan = field(input, "plan").and_then(Value::as_str);
            let actual = cooldown::minimum_command_cooldown(plan);
            (case["expected"] == actual)
                .then_some(())
                .ok_or_else(|| format!("{actual} vs {}", case["expected"]))
        }
        other => Err(format!("unmapped {other}")),
    }
}

/// `command_cooldown_write.ts` fakes, recording the same call vocabulary as the generator.
struct Store {
    plan: Option<String>,
    lease_taken: bool,
    zero_exists: bool,
    exists_fails: bool,
    release_fails: bool,
    calls: Mutex<Vec<Value>>,
}

impl Store {
    fn new(input: &Value) -> Self {
        let flag = |key: &str| input[key].as_bool().unwrap_or(false);
        Self {
            plan: field(input, "plan")
                .and_then(Value::as_str)
                .map(str::to_owned),
            lease_taken: flag("leaseTaken"),
            zero_exists: flag("zeroExists"),
            exists_fails: flag("existsFails"),
            release_fails: flag("releaseFails"),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn record(&self, call: Value) {
        self.calls.lock().unwrap().push(call);
    }
}

impl CooldownStore for Store {
    type Error = String;

    async fn owner_plan(&self, channel_id: &str) -> Result<Option<String>, String> {
        self.record(json!(["owner_plan", channel_id]));
        Ok(self.plan.clone())
    }

    async fn acquire_lease(&self, key: &str, token: &str, ttl: u64) -> Result<bool, String> {
        assert_eq!(token.len(), 36, "a UUID token");
        self.record(json!(["acquire_lease", key, "lease-token", ttl]));
        Ok(!self.lease_taken)
    }

    async fn editable_zero_exists(
        &self,
        channel_id: &str,
        exclude: Option<&str>,
    ) -> Result<bool, String> {
        self.record(json!(["editable_zero_exists", channel_id, exclude]));
        if self.exists_fails {
            return Err("exists failed".into());
        }
        Ok(self.zero_exists)
    }

    async fn release_lease(&self, key: &str, token: &str) -> Result<(), String> {
        assert_eq!(token.len(), 36);
        self.record(json!(["release_lease", key, "lease-token"]));
        if self.release_fails {
            return Err("release failed".into());
        }
        Ok(())
    }
}

async fn check_cooldown_case(case: &Value) -> Result<(), String> {
    let input = &case["input"];
    let store = Store::new(input);
    let value = bson(&input["cooldown"]);
    let actual = match case["operation"].as_str().unwrap() {
        "keyword_cooldown" => {
            match cooldown::validate_keyword_cooldown(&store, "c1", Some(&value)).await {
                Ok(()) => json!({ "ok": true }),
                Err(error) => json!({ "error": describe(&error) }),
            }
        }
        "write_cooldown" => {
            let current = field(input, "current").map(|current| CurrentCommand {
                id: current["_id"].as_str(),
                cooldown: current["cooldown"].as_f64(),
                reserved: current["reserved"].as_bool().unwrap_or(false),
            });
            let write_fails = input["writeFails"].as_bool().unwrap_or(false);
            let random = SeededRandom::new(7);
            let result = cooldown::write_command_with_cooldown(
                &store,
                &random,
                "c1",
                Some(&value),
                current.as_ref(),
                || async {
                    store.record(json!(["write"]));
                    if write_fails {
                        Err("write failed".to_owned())
                    } else {
                        Ok("written")
                    }
                },
            )
            .await;
            match result {
                Ok(written) => json!({ "result": written }),
                Err(error) => json!({
                    "error": describe(&error),
                    "cooldownError": matches!(error, CooldownError::Invalid(_)),
                }),
            }
        }
        other => return Err(format!("unmapped {other}")),
    };
    let mut actual = actual;
    actual["calls"] = Value::Array(store.calls.lock().unwrap().clone());
    let mut expected = case["expected"].clone();
    if let Some(error) = case.get("error") {
        expected = json!({ "error": error });
    }
    (actual == expected)
        .then_some(())
        .ok_or_else(|| format!("{actual} vs {expected}"))
}

fn describe(error: &CooldownError<String>) -> String {
    match error {
        CooldownError::Invalid(message) => message.clone(),
        CooldownError::Storage(message) => message.clone(),
        CooldownError::Random => "random".into(),
    }
}

#[tokio::test]
async fn keywords_and_cooldowns_match_the_reference() {
    let fixture: Value = serde_json::from_str(CORPUS).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(
        fixture["counts"]["cases"].as_u64(),
        Some(cases.len() as u64)
    );
    assert!(fixture["node"].as_str().unwrap().starts_with("v24."));
    let mut tally = Tally::default();
    let mut failures = Vec::new();
    let mut operations: BTreeMap<String, usize> = BTreeMap::new();
    for (index, case) in cases.iter().enumerate() {
        let operation = case["operation"].as_str().unwrap();
        *operations.entry(operation.into()).or_default() += 1;
        let outcome = if operation.ends_with("_cooldown") && operation != "minimum_cooldown" {
            check_cooldown_case(case).await
        } else {
            check_keyword_case(case, &mut tally)
        };
        if let Err(error) = outcome {
            failures.push(format!("#{index} {operation} {}: {error}", case["input"]));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures[..failures.len().min(25)].join("\n")
    );
    // The intended differences and how many recorded cases each changes.
    assert_eq!(
        tally.empty_inside_astral, 4,
        "empty keyword inside an astral character"
    );
    assert_eq!(tally.keyword_length, 6, "keyword length in characters");
    assert_eq!(tally.non_string_mode, 1, "non-string match mode");
    assert!(operations["keyword_matches"] > 2_000);
    assert!(operations["write_cooldown"] > 700);
}
