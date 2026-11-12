//! Every command-language text stored in the local `domdimabot` copy (a stale production copy,
//! read only: nothing is written) compiles within the limits, as stored and with every
//! placeholder replaced by a 500-character argument, and never panics.
//!
//! The fields are the ones the reference renders with `parseSpecialCommands`
//! (`dimabot/src/handlers/special_parser.handler.ts` and its callers): command bodies, timers,
//! EventSub chat messages (follow, raid, ban, ad break, online/offline, cheer tiers,
//! modiversary), bits rules, channel-point rewards, roulette winner actions and goal actions.
//!
//! Skipped with a message when `DIMA_TEST_MONGO_URI` is not set or `domdimabot` is absent,
//! unless `DIMA_TEST_REQUIRE_STORES=1` (`tools/test-env`), which makes either a failure.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "support/placeholders.rs"]
mod placeholders;

use anyhow::{Result, bail};
use bson::{Bson, Document, doc};
use dima_engine::syntax::{
    CompiledProgram, Diagnostic, MAX_ARGUMENT_CHARS, MAX_SOURCE_CHARS, SegmentStep, SyntaxEngine,
};
use futures_util::TryStreamExt;
use mongodb::Database;
use serde_json::Value;
use std::panic::{AssertUnwindSafe, catch_unwind};

const DATABASE: &str = "domdimabot";

/// (collection, paths of command-language text; `[]` descends into an array)
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

fn required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").is_ok_and(|value| value == "1")
}

async fn database() -> Result<Option<Database>> {
    let Ok(uri) = std::env::var("DIMA_TEST_MONGO_URI") else {
        if required() {
            bail!("DIMA_TEST_REQUIRE_STORES=1 but DIMA_TEST_MONGO_URI is not set");
        }
        eprintln!("skipped: DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")");
        return Ok(None);
    };
    let client = mongodb::Client::with_uri_str(&uri).await?;
    if !client
        .list_database_names()
        .await?
        .iter()
        .any(|name| name == DATABASE)
    {
        if required() {
            bail!("DIMA_TEST_REQUIRE_STORES=1 but the local {DATABASE} copy is not present");
        }
        eprintln!("skipped: the local {DATABASE} copy is not present");
        return Ok(None);
    }
    Ok(Some(client.database(DATABASE)))
}

/// Every string at a dotted path (`a.b[].c`).
fn strings_at(value: &Bson, path: &[&str], out: &mut Vec<String>) {
    let Some((first, rest)) = path.split_first() else {
        if let Bson::String(text) = value {
            out.push(text.clone());
        }
        return;
    };
    let Bson::Document(document) = value else {
        return;
    };
    let (key, array) = match first.strip_suffix("[]") {
        Some(key) => (key, true),
        None => (*first, false),
    };
    match (document.get(key), array) {
        (Some(Bson::Array(items)), true) => {
            for item in items {
                strings_at(item, rest, out);
            }
        }
        (Some(child), false) => strings_at(child, rest, out),
        _ => {}
    }
}

/// Container depth of a JSON value, without recursion.
fn json_depth(value: &Value) -> usize {
    let mut pending = vec![(value, 0)];
    let mut deepest = 0;
    while let Some((value, depth)) = pending.pop() {
        deepest = deepest.max(depth);
        match value {
            Value::Array(items) => pending.extend(items.iter().map(|v| (v, depth + 1))),
            Value::Object(map) => pending.extend(map.values().map(|v| (v, depth + 1))),
            _ => {}
        }
    }
    deepest
}

#[derive(Default)]
struct Seen {
    texts: usize,
    over_source_limit: usize,
    largest_input: usize,
    most_nodes: usize,
    deepest_json: usize,
    segment_errors: usize,
}

impl Seen {
    fn program(&mut self, program: &CompiledProgram) {
        self.most_nodes = self.most_nodes.max(program.stats().nodes);
        if program.check_json_depth().is_ok() {
            self.deepest_json = self.deepest_json.max(json_depth(&program.to_value()));
        }
    }

    fn budget(error: &Diagnostic, what: &str) {
        assert!(!error.is_resource_limit(), "{what}: {error:?}");
    }

    /// Compiles `text` as a template and as one program; no resource limit may refuse it.
    fn compile(&mut self, engine: &SyntaxEngine, text: &str, what: &str) {
        self.largest_input = self.largest_input.max(dima_text::char_len(text));
        let plan = engine
            .compile_template(text)
            .unwrap_or_else(|error| panic!("{what}: {error:?}"));
        for segment in plan.segments() {
            match segment.step() {
                SegmentStep::Program(program) => self.program(program),
                SegmentStep::ParseError(error) => {
                    Self::budget(error, what);
                    self.segment_errors += 1;
                }
                SegmentStep::Text | SegmentStep::Unclosed(_) => {}
            }
        }
        match engine.parse(text) {
            Ok(program) => self.program(&program),
            Err(error) => Self::budget(&error, what),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_stored_command_text_compiles_within_the_limits() -> Result<()> {
    let Some(db) = database().await? else {
        return Ok(());
    };
    let engine = SyntaxEngine::default();
    // A plain word, the language itself, and emoji: each exactly 500 characters.
    let arguments = [
        "x".repeat(MAX_ARGUMENT_CHARS),
        "*(1?)$(user)".repeat(MAX_ARGUMENT_CHARS / 12) + "%[,]%(a)",
        "😀".repeat(MAX_ARGUMENT_CHARS),
    ];
    for argument in &arguments {
        assert_eq!(dima_text::char_len(argument), MAX_ARGUMENT_CHARS);
    }
    let mut seen = Seen::default();
    let mut per_collection = Vec::new();
    for (collection, paths) in SOURCES {
        let mut projection = Document::new();
        for path in *paths {
            let top = path.split(['.', '[']).next().unwrap_or(path);
            projection.insert(top, 1);
        }
        let mut cursor = db
            .collection::<Document>(collection)
            .find(doc! {})
            .projection(projection)
            .await?;
        let mut texts = Vec::new();
        while let Some(document) = cursor.try_next().await? {
            let value = Bson::Document(document);
            for path in *paths {
                let parts: Vec<&str> = path.split('.').collect();
                strings_at(&value, &parts, &mut texts);
            }
        }
        per_collection.push(format!("{collection} {}", texts.len()));
        for text in texts.iter().filter(|text| !text.trim().is_empty()) {
            let what = format!("{collection}: {}", dima_text::truncate_chars(text, 60));
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                seen.texts += 1;
                if engine.check_source(text).is_err() {
                    seen.over_source_limit += 1;
                }
                seen.compile(&engine, text, &what);
                for argument in &arguments {
                    let worst = placeholders::worst_case(text, argument);
                    if worst != *text {
                        seen.compile(&engine, &worst, &what);
                    }
                    if let Some(literal) = placeholders::resolve(text, argument, true) {
                        seen.compile(&engine, &literal, &what);
                    }
                }
            }));
            assert!(outcome.is_ok(), "panicked on {what}");
        }
    }
    eprintln!(
        "real data: {} ({} texts); over the {MAX_SOURCE_CHARS}-character source limit: {}; \
         largest input {} characters; most nodes in one program {}; deepest tree {} JSON \
         containers; segments with ordinary parse errors {}",
        per_collection.join(", "),
        seen.texts,
        seen.over_source_limit,
        seen.largest_input,
        seen.most_nodes,
        seen.deepest_json,
        seen.segment_errors,
    );
    if seen.texts < 1_000 {
        bail!(
            "expected the local copy's command texts, found {}",
            seen.texts
        );
    }
    Ok(())
}
