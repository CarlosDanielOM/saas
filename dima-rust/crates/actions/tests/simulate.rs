//! The command editor's simulation compared, as JSON text, with what the TypeScript answered
//! (`reference/record_simulate.mts`, `fixtures/simulate_recorded.json`): a table of editor inputs
//! kept whole, and every command-language text stored in the local copy kept as the hash of the
//! answer (the texts are read from the copy at test time). The simulation holds no store, Twitch
//! or chat handle; the test checks that no call of any run left the run's memory.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use anyhow::{Result, bail};
use bson::{Bson, Document, doc};
use dima_actions::simulate::{parse_simulation_input, simulate_command};
use dima_core::{Clock, ManualClock, Random};
use dima_engine::eval::Engine;
use dima_engine::registry::Registry;
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use std::sync::Arc;
use support::*;

const FIXTURE: &str = include_str!("fixtures/simulate_recorded.json");

/// The recorder's sources (every document, no channel filter).
const SOURCES: &[(&str, &[&str])] = &[
    ("commands", &["message"]),
    ("custom_timers", &["message"]),
    (
        "eventsubs",
        &[
            "message",
            "endMessage",
            "temporalBanMessage",
            "modiversaryMessage",
            "cheerTiers[].message",
        ],
    ),
    ("bits_rules", &["rules[].chat.message"]),
    ("redemptionrewards", &["message"]),
    (
        "roulette_channels",
        &[
            "actions[].source",
            "state.roulettes[].items[].action",
            "state.roulettes[].settings.winnerAction",
        ],
    ),
    ("channel_goals", &["goals[].actions[].text"]),
];

fn strings_at(value: &Bson, steps: &[&str], out: &mut Vec<String>) {
    let Some((first, rest)) = steps.split_first() else {
        if let Bson::String(text) = value {
            out.push(text.clone());
        }
        return;
    };
    let Bson::Document(document) = value else {
        return;
    };
    match first.strip_suffix("[]") {
        Some(key) => {
            if let Some(Bson::Array(items)) = document.get(key) {
                for item in items {
                    strings_at(item, rest, out);
                }
            }
        }
        None => {
            if let Some(child) = document.get(*first) {
                strings_at(child, rest, out);
            }
        }
    }
}

/// The answer the tools receive, as the recorder writes it.
async fn answer(
    engine: &Engine,
    raw: &Value,
    random: &Arc<Reseedable>,
    seed: u64,
) -> (String, usize) {
    random.reseed(seed);
    let clock = ManualClock::new(NOW_MS);
    match parse_simulation_input(raw) {
        Err(error) => (dima_text::to_js_json(&json!({ "inputError": error.0 })), 0),
        Ok(input) => {
            let random: Arc<dyn Random> = random.clone();
            let result = simulate_command(engine, &input, &clock as &dyn Clock, random).await;
            (dima_text::to_js_json(&result.to_json()), result.host_calls)
        }
    }
}

#[test]
fn editor_inputs_are_answered_as_the_reference_answers_them() {
    run(async {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        let engine = Engine::new(Registry::standard(), Default::default());
        let random = Reseedable::new(0);
        for (index, case) in fixture["inputs"].as_array().unwrap().iter().enumerate() {
            let (answer, host_calls) =
                answer(&engine, &case["input"], &random, 2000 + index as u64).await;
            assert_eq!(
                answer,
                case["answer"].as_str().unwrap(),
                "input {index}: {}",
                case["input"]
            );
            assert_eq!(host_calls, 0);
        }
    });
}

#[test]
fn stored_texts_are_simulated_as_the_reference_simulates_them() -> Result<()> {
    run(async {
        let fixture: Value = serde_json::from_str(FIXTURE)?;
        let Some(copy) = connect_mongo("domdimabot").await? else {
            return Ok(());
        };
        if !copy
            .client()
            .list_database_names()
            .await?
            .iter()
            .any(|name| name == "domdimabot")
        {
            if stores_required() {
                bail!("DIMA_TEST_REQUIRE_STORES=1 but the local domdimabot copy is not present");
            }
            eprintln!("skipped: the local domdimabot copy is not present");
            return Ok(());
        }
        let mut texts = Vec::new();
        for (collection, paths) in SOURCES {
            let documents: Vec<Document> = copy
                .documents(collection)
                .find(doc! {})
                .sort(doc! { "_id": 1 })
                .await?
                .try_collect()
                .await?;
            for document in documents {
                for path in *paths {
                    let steps: Vec<&str> = path.split('.').collect();
                    let mut found = Vec::new();
                    strings_at(&Bson::Document(document.clone()), &steps, &mut found);
                    texts.extend(
                        found
                            .into_iter()
                            .filter(|text| !dima_text::trim(text).is_empty()),
                    );
                }
            }
        }
        let recorded = fixture["stored"].as_array().unwrap();
        assert_eq!(
            texts.len(),
            recorded.len(),
            "the copy holds other texts than when it was recorded"
        );
        let engine = Engine::new(Registry::standard(), Default::default());
        let random = Reseedable::new(0);
        let mut differ = Vec::new();
        for (index, (text, expected)) in texts.iter().zip(recorded).enumerate() {
            let (answer, host_calls) = answer(
                &engine,
                &json!({ "body": text }),
                &random,
                5000 + index as u64 + 1,
            )
            .await;
            assert_eq!(host_calls, 0, "text {index} reached the host");
            if dima_core::crypto::sha256(&answer).hex() != expected.as_str().unwrap() {
                differ.push(index);
            }
        }
        eprintln!(
            "simulated stored texts: {} ran, {} match",
            texts.len(),
            texts.len() - differ.len()
        );
        assert!(
            differ.is_empty(),
            "{} of {} differ: {:?}",
            differ.len(),
            texts.len(),
            &differ[..differ.len().min(20)]
        );
        Ok(())
    })
}
