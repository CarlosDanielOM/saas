//! Every command-language text stored in the local copy (`domdimabot`, read only), run through
//! Rust and compared with what the real TypeScript did with it (`reference/record_commands.mts`,
//! recorded into `fixtures/stored_commands.json`): the answer, the chat posts in order with their
//! reply targets, the `astvariables` documents, the channel's commands as canonical extended JSON
//! (BSON types included), and the Dragonfly keys the run wrote (cache variables, cooldowns, AST
//! timers: type, value, lifetime). The fixture holds ids and hashes only; the texts are read from
//! the copy at test time.
//!
//! Each text runs against a fresh scratch copy of its channel, with the clock frozen at the
//! recording's time and the randomness reseeded with the case's position, as the recorder does.
//! Commands run as a chat message names them (`command_handler`, `execute_custom_command` for a
//! keyword) with an authored authorization and are delivered; every other text (timers, EventSub
//! messages, bits rules, rewards, roulette and goal actions) is rendered with a chat event as
//! context and delivered (`ChatOut::deliver`). A text that calls a function of a group P4-ACT-CORE
//! does not port fails in both with `$(name) is not ported yet` (the recorder replaces those 99
//! functions with one that throws it), so it is compared up to that failure; the test counts the
//! texts that reach each group (in their own text or through the commands they reference).
//!
//! With `STORED_COMMANDS_DEBUG=<dir>`, the canonical outcome of every text that differs is written
//! there (outside the repository) for comparison with the recorder's debug file.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use anyhow::{Result, bail};
use bson::{Bson, Document, doc};
use dima_actions::delivery::AstMessage;
use dima_actions::host::Group;
use dima_actions::runner::{
    CommandOutcome, CommandRequest, ExecutionAuthorization, ExecutionOrigin,
};
use dima_engine::host::HostFunction;
use dima_engine::syntax::AstNode;
use dima_engine::value::Value as EngineValue;
use dima_store::mongo::MongoStore;
use dima_twitch::chat::{ChatError, ChatOut, Rendering};
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use support::*;

const FIXTURE: &str = include_str!("fixtures/stored_commands.json");

/// The recorder's `SOURCES`.
const SOURCES: &[(&str, &[&str], &str)] = &[
    ("commands", &["message"], "channelID"),
    ("custom_timers", &["message"], "channelID"),
    (
        "eventsubs",
        &[
            "message",
            "endMessage",
            "temporalBanMessage",
            "modiversaryMessage",
            "cheerTiers[].message",
        ],
        "channelID",
    ),
    ("bits_rules", &["rules[].chat.message"], "_id"),
    ("redemptionrewards", &["message"], "channelID"),
    (
        "roulette_channels",
        &[
            "actions[].source",
            "state.roulettes[].items[].action",
            "state.roulettes[].settings.winnerAction",
        ],
        "_id",
    ),
    ("channel_goals", &["goals[].actions[].text"], "_id"),
];

struct Case {
    source: &'static str,
    id: String,
    path: String,
    channel: String,
    text: String,
    doc: Document,
}

fn id_text(value: &Bson) -> String {
    match value {
        Bson::String(text) => text.clone(),
        Bson::ObjectId(id) => id.to_hex(),
        Bson::Int32(n) => n.to_string(),
        Bson::Int64(n) => n.to_string(),
        _ => String::new(),
    }
}

/// The recorder's `stringsAt`.
fn strings_at(value: &Bson, steps: &[&str], at: &mut Vec<String>, out: &mut Vec<(String, String)>) {
    let Some((first, rest)) = steps.split_first() else {
        if let Bson::String(text) = value {
            out.push((at.join("."), text.clone()));
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
            for (index, item) in items.iter().enumerate() {
                at.push(key.to_owned());
                at.push(index.to_string());
                strings_at(item, rest, at, out);
                at.truncate(at.len() - 2);
            }
        }
        (Some(child), false) => {
            at.push(key.to_owned());
            strings_at(child, rest, at, out);
            at.pop();
        }
        _ => {}
    }
}

async fn cases(copy: &MongoStore) -> Result<Vec<Case>> {
    let mut cases = Vec::new();
    for (collection, paths, channel_field) in SOURCES {
        let documents: Vec<Document> = copy
            .documents(collection)
            .find(doc! {})
            .sort(doc! { "_id": 1 })
            .await?
            .try_collect()
            .await?;
        for document in documents {
            let channel = document.get(channel_field).map(id_text).unwrap_or_default();
            if !(1..=30).contains(&channel.len()) || !channel.bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }
            for path in *paths {
                let steps: Vec<&str> = path.split('.').collect();
                let mut found = Vec::new();
                strings_at(
                    &Bson::Document(document.clone()),
                    &steps,
                    &mut Vec::new(),
                    &mut found,
                );
                for (at, text) in found {
                    if dima_text::trim(&text).is_empty() {
                        continue;
                    }
                    cases.push(Case {
                        source: collection,
                        id: document.get("_id").map(id_text).unwrap_or_default(),
                        path: at,
                        channel: channel.clone(),
                        text,
                        doc: document.clone(),
                    });
                }
            }
        }
    }
    Ok(cases)
}

const ARGUMENT: &str = "uno dos @Tres";

fn chat_event(channel: &str) -> serde_json::Map<String, Value> {
    json!({
        "broadcaster_user_id": channel, "broadcaster_user_login": "streamer", "broadcaster_user_name": "Streamer",
        "chatter_user_id": "5001", "chatter_user_login": "viewerone", "chatter_user_name": "ViewerOne",
        "message_id": "chat-1", "message": { "text": format!("!x {ARGUMENT}"), "fragments": [] }, "color": "#1E90FF",
        "badges": [{ "set_id": "subscriber", "id": "12", "info": "16" }], "message_type": "text", "cheer": null, "reply": null,
        "channel_points_custom_reward_id": null,
    })
    .as_object()
    .cloned()
    .unwrap()
}

fn canonical(document: Document) -> Value {
    sorted(Bson::Document(document).into_canonical_extjson())
}

async fn state_of(
    stores: &Stores,
    channel: &str,
    started: std::time::Instant,
) -> Result<(Value, Value, Value)> {
    let mut variables: Vec<Value> = stores
        .mongo
        .documents("astvariables")
        .find(doc! {})
        .await?
        .try_collect::<Vec<Document>>()
        .await?
        .into_iter()
        .map(|mut document| {
            document.remove("_id");
            canonical(document)
        })
        .collect();
    variables
        .sort_by(|a, b| dima_text::cmp_utf16(&dima_text::to_js_json(a), &dima_text::to_js_json(b)));
    let commands: Vec<Value> = stores
        .mongo
        .documents("commands")
        .find(doc! { "channelID": channel })
        .sort(doc! { "_id": 1 })
        .await?
        .try_collect::<Vec<Document>>()
        .await?
        .into_iter()
        .map(canonical)
        .collect();
    let mut names = Vec::new();
    for pattern in [
        format!("twitch:{channel}:variable:*"),
        format!("command:execution:cooldown:{channel}:*"),
        "ast:timers:*".to_owned(),
    ] {
        names.extend(keys_matching(stores, &pattern).await?);
    }
    names.sort_by(|a, b| dima_text::cmp_utf16(a, b));
    let mut keys = Vec::new();
    for name in names {
        let key = stores.key(&name);
        let kind: String = stores.dragonfly.query(redis::cmd("TYPE").arg(&key)).await?;
        let value = match kind.as_str() {
            "string" => json!(stores.dragonfly.get_text(&key).await?),
            "zset" => Value::Array(
                stores
                    .dragonfly
                    .zrange_with_scores(&key, 0, -1)
                    .await?
                    .into_iter()
                    .map(|(member, score)| json!([String::from_utf8_lossy(&member), score]))
                    .collect(),
            ),
            _ => Value::Null,
        };
        let pttl: i64 = stores.dragonfly.query(redis::cmd("PTTL").arg(&key)).await?;
        let ttl = if name.starts_with("ast:timers:") {
            if pttl < 0 { json!(pttl) } else { json!("at") }
        } else if pttl < 0 {
            json!(pttl)
        } else {
            // As it was set: what is left plus the time since the case started (the recorder's).
            let elapsed = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
            json!((pttl + elapsed + 50).div_euclid(1000))
        };
        keys.push(json!([name, kind, value, ttl]));
    }
    Ok((
        Value::Array(variables),
        Value::Array(commands),
        Value::Array(keys),
    ))
}

/// The host functions a text reaches: its own calls, and those of the commands it references in
/// its channel, transitively.
fn groups_reached(
    engine: &dima_engine::eval::Engine,
    text: &str,
    commands: &HashMap<String, String>,
) -> HashSet<Group> {
    fn walk(node: &AstNode, functions: &mut Vec<String>, references: &mut Vec<String>) {
        match node {
            AstNode::Function { name, args } => {
                functions.push(name.clone());
                for arg in args {
                    walk(arg, functions, references);
                }
            }
            AstNode::CommandRef { command_name, args } => {
                references.push(dima_text::to_lower(dima_text::trim(command_name)));
                for arg in args {
                    walk(arg, functions, references);
                }
            }
            other => {
                let value = serde_json::to_value(other).unwrap_or(Value::Null);
                // Every child node, whatever its field.
                fn children(value: &Value, out: &mut Vec<AstNode>) {
                    match value {
                        Value::Object(map) if map.contains_key("type") => {
                            if let Ok(node) = serde_json::from_value::<AstNode>(value.clone()) {
                                out.push(node);
                            }
                        }
                        Value::Object(map) => map.values().for_each(|v| children(v, out)),
                        Value::Array(items) => items.iter().for_each(|v| children(v, out)),
                        _ => {}
                    }
                }
                let mut nested = Vec::new();
                if let Value::Object(map) = &value {
                    for (key, child) in map {
                        if key != "type" {
                            children(child, &mut nested);
                        }
                    }
                }
                for child in nested {
                    walk(&child, functions, references);
                }
            }
        }
    }
    let mut groups = HashSet::new();
    let mut pending = vec![text.to_owned()];
    let mut seen = HashSet::new();
    while let Some(text) = pending.pop() {
        let Ok(template) = engine.compile(&text) else {
            continue;
        };
        let (mut functions, mut references) = (Vec::new(), Vec::new());
        for plan in template.segments() {
            if let dima_engine::syntax::SegmentStep::Program(program) = plan.step() {
                walk(program.root(), &mut functions, &mut references);
            }
        }
        for name in functions {
            if let Some(group) = HostFunction::from_name(&name).and_then(Group::of) {
                groups.insert(group);
            }
        }
        for name in references {
            if seen.insert(name.clone())
                && let Some(text) = commands.get(&name)
            {
                pending.push(text.clone());
            }
        }
    }
    groups
}

/// Differences on purpose: none is expected among the stored texts. A case listed here is
/// counted with its reason instead of failing.
fn intended_difference(_case: &Case, _rust: &Value) -> Option<&'static str> {
    None
}

#[test]
fn stored_command_texts_match_the_reference() -> Result<()> {
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
        let cases = cases(&copy).await?;
        let recorded = fixture["recorded"].as_array().unwrap();
        let now_ms = fixture["nowMs"].as_i64().unwrap();
        assert_eq!(
            cases.len(),
            recorded.len(),
            "the copy holds other texts than when it was recorded"
        );
        let debug = std::env::var("STORED_COMMANDS_DEBUG").ok();
        with_stores(|stores| async move {
            let channels: Vec<String> = {
                let mut seen = Vec::new();
                for case in &cases {
                    if !seen.contains(&case.channel) {
                        seen.push(case.channel.clone());
                    }
                }
                seen
            };
            let mut plans = HashMap::new();
            for channel in &channels {
                let owner = copy
                    .documents("users")
                    .find_one(doc! { "accounts": { "$elemMatch": { "type": "twitch", "id": channel } } })
                    .await?;
                let plan = owner
                    .as_ref()
                    .and_then(|o| o.get_str("plan_tier").ok())
                    .unwrap_or("free")
                    .to_owned();
                let name = owner
                    .as_ref()
                    .and_then(|o| o.get_array("accounts").ok())
                    .and_then(|accounts| {
                        accounts.iter().find_map(|a| match a {
                            Bson::Document(a) if a.get_str("id").ok() == Some(channel.as_str()) => {
                                a.get_str("name").ok().map(str::to_owned)
                            }
                            _ => None,
                        })
                    })
                    .unwrap_or_else(|| "streamer".to_owned());
                insert_user(&stores, channel, &name, &plan).await?;
                plans.insert(channel.clone(), plan);
            }
            let twitch = TwitchMock::start().await?;
            let random = Reseedable::new(0);
            let process = process(&stores, &twitch, random.clone())?;
            process.clock.set(now_ms);
            let engine = process.delivery.engine().clone();
            let authored = ExecutionAuthorization {
                origin: ExecutionOrigin::Authored,
                identity: dima_engine::permissions::create_broadcaster_identity(),
            };
            let mut channel_texts: HashMap<String, HashMap<String, String>> = HashMap::new();
            let (mut matched, mut differed, mut intended) = (0usize, Vec::new(), BTreeMap::new());
            let mut waiting: BTreeMap<&'static str, usize> = BTreeMap::new();
            let mut fully_covered = 0usize;
            for (index, (case, expected)) in cases.iter().zip(recorded).enumerate() {
                assert_eq!(
                    (case.source, case.id.as_str(), case.path.as_str()),
                    (expected["source"].as_str().unwrap(), expected["id"].as_str().unwrap(), expected["path"].as_str().unwrap()),
                    "case {index} is another text than the recorded one"
                );
                let channel = case.channel.as_str();
                // A fresh scratch copy of the channel.
                stores.mongo.documents("astvariables").delete_many(doc! {}).await?;
                stores.mongo.documents("commands").delete_many(doc! { "channelID": channel }).await?;
                let commands: Vec<Document> = copy
                    .documents("commands")
                    .find(doc! { "channelID": channel })
                    .sort(doc! { "_id": 1 })
                    .await?
                    .try_collect()
                    .await?;
                if !commands.is_empty() {
                    stores.mongo.documents("commands").insert_many(commands.clone()).await?;
                }
                let texts = channel_texts.entry(channel.to_owned()).or_insert_with(|| {
                    commands
                        .iter()
                        .filter(|c| c.get_str("activation").ok() != Some("keyword"))
                        .filter_map(|c| Some((c.get_str("cmd").ok()?.to_owned(), c.get_str("message").ok()?.to_owned())))
                        .collect()
                });
                for pattern in [format!("twitch:{channel}:*"), format!("command:execution:cooldown:{channel}:*"), "ast:timers:*".into(), "keywords:*".into()] {
                    for key in keys_matching(&stores, &pattern).await? {
                        stores.dragonfly.del(&[&stores.key(&key)]).await?;
                    }
                }
                process.deps.commands.invalidate_channel(channel).await?;
                random.reseed(index as u64 + 1);
                let posted_before = twitch.posts().len();
                let started = std::time::Instant::now();
                let result = if case.source == "commands" {
                    let name = case.doc.get_str("cmd").unwrap_or_default().to_owned();
                    let request = CommandRequest {
                        channel_id: channel.to_owned(),
                        event_data: EngineValue::from(Value::Object(chat_event(channel))),
                        name: name.clone(),
                        argument: Some(ARGUMENT.to_owned()),
                        authorization: Some(authored.clone()),
                        reference: None,
                        effect: None,
                    };
                    let outcome = if case.doc.get_str("activation").ok() == Some("keyword") {
                        let stored = stores.mongo.documents("commands").find_one(doc! { "_id": case.doc.get("_id").cloned().unwrap() }).await?.unwrap();
                        let command: dima_model::commands::Command = dima_model::decode_document(&stored)?;
                        process.delivery.execute_custom_command(&command, request).await
                    } else {
                        process.delivery.command_handler(request).await
                    };
                    match outcome {
                        Ok(CommandOutcome::Ran(ran)) => {
                            let message = ran.message.clone();
                            let delivered = process
                                .delivery
                                .deliver_message(channel, AstMessage { text: ran.message, references: ran.references }, true)
                                .await;
                            json!({ "error": false, "message": message, "delivered": match delivered {
                                Ok(()) => "ok".to_owned(),
                                Err(error) => error.message().unwrap_or_default().to_owned(),
                            } })
                        }
                        Ok(CommandOutcome::Refused(refused)) => {
                            json!({ "error": true, "message": refused.message, "status": refused.status, "type": refused.kind })
                        }
                        Err(error) => json!({ "thrown": error.to_string() }),
                    }
                } else {
                    let rendering = Rendering {
                        event_data: chat_event(channel),
                        argument: Some(ARGUMENT.to_owned()),
                        literal_arguments: true,
                        ..Rendering::default()
                    };
                    match process.delivery.deliver(channel, Some(&rendering), &case.text).await {
                        Ok(()) => json!({ "delivered": "ok" }),
                        Err(ChatError::Render { reason }) => json!({ "thrown": reason }),
                        Err(error @ ChatError::RequiredGoalContribution) => json!({ "thrown": error.to_string() }),
                        Err(error) => json!({ "delivered": error.message().unwrap_or_default() }),
                    }
                };
                let posts: Vec<Value> = twitch
                    .posts()
                    .into_iter()
                    .skip(posted_before)
                    .map(|post| json!([post.channel, post.text, post.reply_to]))
                    .collect();
                let (variables, commands, keys) = state_of(&stores, channel, started).await?;
                let outcome = sorted(json!({
                    "result": result, "posts": posts, "variables": variables, "commands": commands, "keys": keys,
                }));
                let groups = groups_reached(&engine, &case.text, texts);
                if groups.is_empty() {
                    fully_covered += 1;
                }
                for group in &groups {
                    *waiting.entry(group.name()).or_default() += 1;
                }
                if hash(&outcome) == expected["hash"].as_str().unwrap() {
                    matched += 1;
                } else if let Some(reason) = intended_difference(case, &outcome) {
                    *intended.entry(reason).or_insert(0usize) += 1;
                } else {
                    if let Some(dir) = &debug {
                        let line = json!({ "source": case.source, "id": case.id, "path": case.path, "outcome": outcome });
                        std::fs::create_dir_all(dir)?;
                        let file = std::path::Path::new(dir).join("rust_commands.jsonl");
                        let mut out = std::fs::OpenOptions::new().create(true).append(true).open(file)?;
                        std::io::Write::write_all(&mut out, format!("{line}\n").as_bytes())?;
                    }
                    differed.push(format!("{} {} {}", case.source, case.id, case.path));
                }
            }
            eprintln!(
                "stored texts: {} ran, {matched} match fully, {} differ on purpose {intended:?}; {fully_covered} reach no unported group; texts reaching each group: {waiting:?}",
                cases.len(),
                intended.values().sum::<usize>(),
            );
            assert!(twitch.unexpected().is_empty(), "{:?}", twitch.unexpected());
            assert!(differed.is_empty(), "{} texts differ from the reference: {:?}", differed.len(), &differed[..differed.len().min(20)]);
            let _ = plans;
            Ok(())
        })
        .await
    })
}
