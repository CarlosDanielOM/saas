//! Every command-language text stored in the local `domdimabot` copy (a stale production copy,
//! read only: nothing is written) compiles within the limits, as stored and with every
//! placeholder replaced by a 500-character argument, and never panics.
//!
//! The fields are the ones the reference renders with `parseSpecialCommands`
//! (`dimabot/src/handlers/special_parser.handler.ts` and its callers): command bodies, timers,
//! EventSub chat messages (follow, raid, ban, ad break, online/offline, cheer tiers,
//! modiversary), bits rules, channel-point rewards, roulette winner actions and goal actions.
//!
//! Every stored command, timer, event message and reward also runs as one message on every
//! plan, its command references followed to the channel's stored commands the way the bot
//! delivers them, with an in-memory host: none that runs within each run's limits stops at the
//! message's shared budget (`dima_engine::eval::MessageBudget`), and the share of that budget
//! they use is printed.
//!
//! Skipped with a message when `DIMA_TEST_MONGO_URI` is not set or `domdimabot` is absent,
//! unless `DIMA_TEST_REQUIRE_STORES=1` (`tools/test-env`), which makes either a failure.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod memory;
#[path = "support/placeholders.rs"]
mod placeholders;

use anyhow::{Result, bail};
use bson::{Bson, Document, doc};
use dima_engine::syntax::{
    CompiledProgram, Diagnostic, MAX_ARGUMENT_CHARS, MAX_NESTING, MAX_SOURCE_CHARS, SegmentStep,
    SyntaxEngine,
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
    deepest_nesting: usize,
    deepest_tree: usize,
    segment_errors: usize,
}

impl Seen {
    fn program(&mut self, program: &CompiledProgram) {
        self.most_nodes = self.most_nodes.max(program.stats().nodes);
        self.deepest_nesting = self.deepest_nesting.max(program.stats().nesting);
        self.deepest_tree = self.deepest_tree.max(program.root().height());
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
         containers; deepest nesting {} (tree height {}); segments with ordinary parse errors {}",
        per_collection.join(", "),
        seen.texts,
        seen.over_source_limit,
        seen.largest_input,
        seen.most_nodes,
        seen.deepest_json,
        seen.deepest_nesting,
        seen.deepest_tree,
        seen.segment_errors,
    );
    // The deepest stored text nests 11 levels (tree height 10) in the local copy; the limit
    // keeps at least twice the room.
    const DEEPEST_REAL: usize = 16;
    const _: () = assert!(DEEPEST_REAL * 2 <= MAX_NESTING);
    assert!(
        seen.deepest_nesting <= DEEPEST_REAL && seen.deepest_tree <= DEEPEST_REAL,
        "a stored command nests {} levels",
        seen.deepest_nesting
    );
    if seen.texts < 1_000 {
        bail!(
            "expected the local copy's command texts, found {}",
            seen.texts
        );
    }
    Ok(())
}

/// The command texts of `collection` with their channel, and (for commands) the names a
/// reference finds them by.
async fn channel_texts(
    db: &Database,
    collection: &str,
    field: &str,
) -> Result<Vec<(String, Vec<String>, String)>> {
    let mut cursor = db
        .collection::<Document>(collection)
        .find(doc! {})
        .projection(doc! { "channelID": 1, "name": 1, "cmd": 1, field: 1 })
        .await?;
    let mut out = Vec::new();
    while let Some(document) = cursor.try_next().await? {
        let (Ok(channel), Ok(text)) = (document.get_str("channelID"), document.get_str(field))
        else {
            continue;
        };
        let names = ["name", "cmd"]
            .iter()
            .filter_map(|key| document.get_str(key).ok())
            .map(str::to_lowercase)
            .collect();
        out.push((channel.to_owned(), names, text.to_owned()));
    }
    Ok(out)
}

#[test]
fn every_stored_message_runs_within_the_shared_budget() -> Result<()> {
    use dima_engine::context::{Context, Plan};
    use dima_engine::eval::{EvalLimits, LimitKind, MessageLimits, MessageUsage};
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let Some(texts) = runtime.block_on(async {
        let Some(db) = database().await? else {
            return Ok::<_, anyhow::Error>(None);
        };
        let mut commands = channel_texts(&db, "commands", "message").await?;
        let commands_len = commands.len();
        commands.extend(channel_texts(&db, "custom_timers", "message").await?);
        commands.extend(channel_texts(&db, "eventsubs", "message").await?);
        commands.extend(channel_texts(&db, "redemptionrewards", "message").await?);
        Ok(Some((commands, commands_len)))
    })?
    else {
        return Ok(());
    };
    let (texts, commands_len) = texts;
    // The channel's commands by name, as a reference looks them up.
    let mut by_channel: HashMap<String, HashMap<String, String>> = HashMap::new();
    for (channel, names, text) in &texts[..commands_len] {
        let commands = by_channel.entry(channel.clone()).or_default();
        for name in names {
            commands.entry(name.clone()).or_insert_with(|| text.clone());
        }
    }
    let no_commands = HashMap::new();
    let shared = EvalLimits::default();
    let unshared = EvalLimits {
        message_factor: 1_000,
        ..shared
    };
    let share = |usage: MessageUsage, limits: MessageLimits| {
        [
            usage.steps as f64 / limits.steps as f64,
            usage.host_calls as f64 / limits.host_calls as f64,
            usage.memory_bytes as f64 / limits.memory_bytes as f64,
            usage.output_bytes as f64 / limits.output_bytes as f64,
        ]
        .into_iter()
        .fold(0.0f64, f64::max)
    };
    let limit_marker = |text: &str| text.contains("[Parse error: This command");
    let (mut messages, mut with_references, mut near, mut stopped) = (0, 0, 0, 0);
    let (mut largest, mut largest_with_references) = (0.0f64, 0.0f64);
    let mut most_runs = 0;
    let mut slowest = Duration::ZERO;
    for (channel, _, text) in &texts {
        let Some(source) = placeholders::resolve(text, "a b c", false) else {
            continue;
        };
        if source.trim().is_empty() {
            continue;
        }
        let commands = by_channel.get(channel).unwrap_or(&no_commands);
        for plan in [Plan::Free, Plan::Premium, Plan::Pro] {
            let context = Context {
                broadcaster_id: channel.clone(),
                user_id: "1".into(),
                user_login: "caller".into(),
                user_plan: plan,
                enforce_function_permissions: false,
                ..Context::default()
            };
            let engine = memory::engine_with(&[]).with_limits(shared);
            if engine.compile(&source).is_err() {
                continue;
            }
            let started = Instant::now();
            let delivery = memory::deliver(
                &engine,
                commands,
                &source,
                &context,
                &mut memory::MemoryHost::new(1),
            );
            slowest = slowest.max(started.elapsed());
            messages += 1;
            most_runs = most_runs.max(delivery.runs.len());
            let used = share(delivery.budget.usage(), delivery.budget.limits());
            largest = largest.max(used);
            if delivery.runs.len() > 1 {
                with_references += 1;
                largest_with_references = largest_with_references.max(used);
                if used > 0.5 {
                    near += 1;
                }
            }
            if delivery.budget.stopped().is_some() {
                stopped += 1;
                // It stopped at the message's budget: it must also stop with fresh limits for
                // every reference (as before), or the shared budget broke it.
                let engine = memory::engine_with(&[]).with_limits(unshared);
                let before = memory::deliver(
                    &engine,
                    commands,
                    &source,
                    &context,
                    &mut memory::MemoryHost::new(1),
                );
                assert!(
                    before.runs.iter().any(|(_, outcome)| outcome
                        .as_ref()
                        .map_or(true, |text| limit_marker(text))),
                    "{plan:?} {channel}: {} passes with fresh limits per reference and stops at \
                     the message's budget ({:?})",
                    dima_text::truncate_chars(text, 80),
                    delivery.budget.stopped()
                );
            }
        }
    }
    let _ = LimitKind::Steps;
    eprintln!(
        "real data: {messages} messages (texts x plans); {with_references} started command \
         references (at most {} runs in one message); largest share of the message budget: \
         {largest:.6} (with references {largest_with_references:.6}); over half of it: {near}; \
         stopped at the shared budget: {stopped}; slowest message {slowest:?} (in-memory host)",
        most_runs
    );
    assert_eq!(
        near, 0,
        "a stored message with references uses over half of the budget"
    );
    if messages < 1_000 {
        bail!("expected the local copy's command texts, found {messages}");
    }
    Ok(())
}
