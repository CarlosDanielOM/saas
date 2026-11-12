//! The message handler against the recordings of the real TypeScript handler
//! (`tests/fixtures/message_recorded.json`, made by `tests/message_reference/record.mts`).
//!
//! Each recorded case is replayed against fresh state: the same seeds (users, commands, the chat
//! message subscription, a live stream session, Dragonfly keys), the same messages as the same
//! signed notifications, moderation, the AI and the built-ins answering what the recorder's stubs
//! answered. Everything observable is compared: the chat posts in order (text and reply target),
//! every seam call by kind with its arguments (moderation, the AI, built-ins and timers, the
//! widget feed, the site counter, product events, the embedding queue), the message metrics,
//! every MongoDB document of the case's channels (commands' counts, variables, stream sessions,
//! activity rows) and the handler's Dragonfly keys (chat history, the shared cooldown gate, cache
//! variables, with their lifetimes).
//!
//! Differences on purpose are stated in [`intended`] with their reason, applied to the recorded
//! observation before the comparison, and counted.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod message_support;

use anyhow::{Result, bail};
use dima_chat::message::seams::ModerationVerdict;
use message_support::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const FIXTURE: &str = include_str!("fixtures/message_recorded.json");

/// One intended difference applied to a recorded case.
struct Intended {
    case: &'static str,
    reason: &'static str,
    apply: fn(&mut Value, &[Value]),
}

fn activity_id(channel: &str, kind: &str, event_id: &str) -> String {
    dima_core::crypto::keys::json_sha256_hex(&json!([channel, kind, event_id]))
}

/// The differences on purpose, case by case (see `dima_chat::message`'s module docs).
fn intended() -> Vec<Intended> {
    vec![
        Intended {
            case: "a viewer's built-ins after a moderator spoke",
            reason: "the reference's `isMod` is one flag for the whole process, set by the first \
                moderator message and never reset: a viewer's `!vanish`, `!duel` and `!amor` reached \
                the built-ins as a moderator (`!vanish` would ask Twitch to remove and re-add a \
                moderator). Here it is this message's chatter (security fix)",
            apply: |observed, _| {
                for call in observed["calls"]["builtin"]
                    .as_array_mut()
                    .into_iter()
                    .flatten()
                {
                    let function = call["function"].as_str().unwrap_or_default().to_owned();
                    let args = &mut call["args"];
                    match function.as_str() {
                        "vanish" if args[1]["user-id"] == "5001" => args[1]["mod"] = json!(false),
                        "amor" if args[0]["user-id"] == "5001" => args[0]["mod"] = json!(false),
                        "duel" if args[1] == "viewerone" => args[2] = json!(false),
                        _ => {}
                    }
                }
            },
        },
        Intended {
            case: "an announcement over 300 UTF-16 units but within 300 characters",
            reason: "`!anuncio`'s 300 limit is our own limit on user text, counted in characters \
                (charter section 4): 160 emoji are 160 characters (320 UTF-16 units, refused by the \
                reference) and the announcement goes out",
            apply: |observed, messages| {
                let event = &messages[0];
                let channel = event["broadcaster_user_id"].as_str().unwrap_or_default();
                let text = "👋".repeat(160);
                observed["posts"][0] = json!([channel, "Announcement sent", null]);
                let builtin = observed["calls"]
                    .as_object_mut()
                    .map(|calls| calls.entry("builtin").or_insert_with(|| json!([])))
                    .and_then(Value::as_array_mut);
                if let Some(builtin) = builtin {
                    builtin.insert(
                        0,
                        json!({"function": "sendAnnouncement", "args": [channel, "5005", text]}),
                    );
                }
                if let Some(event) = observed["calls"]["product.command"][0].as_object_mut() {
                    event.insert("status".into(), json!("success"));
                    event.remove("errorMessage");
                }
                let id = activity_id(
                    channel,
                    "command",
                    event["message_id"].as_str().unwrap_or_default(),
                );
                for row in observed["mongo"]["stream_activities"]
                    .as_array_mut()
                    .into_iter()
                    .flatten()
                {
                    if row["_id"] == id {
                        row["outcome"] = json!("ok");
                    }
                }
            },
        },
    ]
}

/// Compares `actual` with `expected` at `path`, collecting the first lines of each mismatch.
fn compare(
    case: &str,
    section: &str,
    expected: &Value,
    actual: &Value,
    mismatches: &mut Vec<String>,
) {
    let (expected, actual) = (normalized(expected), normalized(actual));
    if expected != actual {
        let show = |value: &Value| {
            let text = serde_json::to_string_pretty(value).unwrap_or_default();
            text.chars().take(4_000).collect::<String>()
        };
        mismatches.push(format!(
            "case `{case}`, {section}:\n  expected {}\n  actual   {}",
            show(&expected),
            show(&actual)
        ));
    }
}

fn object(map: BTreeMap<String, Value>) -> Value {
    Value::Object(map.into_iter().collect())
}

#[test]
fn the_recorded_cases_replay_like_the_reference() -> Result<()> {
    let fixture: Value = serde_json::from_str(FIXTURE)?;
    run(async move {
        with_stores(|stores| async move {
            let twitch = TwitchMock::start().await?;
            let timestamp = fixture["timestamp"].as_str().unwrap_or_default().to_owned();
            let intended = intended();
            let mut applied = 0_usize;
            let mut mismatches = Vec::new();
            let cases = fixture["cases"].as_array().cloned().unwrap_or_default();
            assert!(cases.len() >= 30, "the recorded table");
            for (index, case) in cases.iter().enumerate() {
                let name = case["name"].as_str().unwrap_or_default();
                let config = &case["config"];
                let seams = Seams {
                    moderation: if config["moderation"] == "action" {
                        ModerationVerdict::ActionTaken
                    } else {
                        ModerationVerdict::Pass
                    },
                    moderation_gate: None,
                    ai: config.get("ai").cloned().unwrap_or(json!({})),
                    builtins: config.get("builtins").cloned().unwrap_or(json!({})),
                };
                let process = process(
                    &stores,
                    &twitch,
                    seeded(index as u64 + 1),
                    seams,
                    test_config(),
                    &format!("c{index}"),
                )?;
                let seed = &case["seed"];
                for collection in ["users", "streamsessions", "commands", "eventsubs"] {
                    insert(&stores, collection, &seed[collection]).await?;
                }
                for command in seed["dragonfly"].as_array().into_iter().flatten() {
                    let words: Vec<String> = command
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|word| word.as_str().map(str::to_owned))
                        .collect();
                    let mut redis_command = redis::cmd(&words[0]);
                    redis_command.arg(stores.key(&words[1]));
                    for word in &words[2..] {
                        redis_command.arg(word);
                    }
                    stores.dragonfly.query_value(&redis_command).await?;
                }
                let channels: Vec<String> = case["channels"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|channel| channel["id"].as_str().map(str::to_owned))
                    .collect();
                let posts_before = twitch.posts().len();
                let started = tokio::time::Instant::now();
                let messages = case["messages"].as_array().cloned().unwrap_or_default();
                for event in &messages {
                    process
                        .handler
                        .handle_notification(notification(event, &timestamp))
                        .await
                        .map_err(|error| anyhow::anyhow!("case `{name}`: {error}"))?;
                }
                let posts: Vec<Value> = twitch.posts()[posts_before..]
                    .iter()
                    .filter(|post| channels.contains(&post.channel))
                    .map(|post| json!([post.channel, post.text, post.reply_to]))
                    .collect();
                let mut calls = process.calls.by_kind();
                calls.remove("embedding.refused");
                let observed = json!({
                    "posts": posts,
                    "calls": object(calls.into_iter().map(|(k, v)| (k, Value::Array(v))).collect()),
                    "metrics": process.message_metrics(&stores).await?,
                    "mongo": object(mongo_state(&stores, &channels).await?),
                    "dragonfly": object(dragonfly_state(&stores, &channels, started).await?),
                });
                let mut expected = case["observed"].clone();
                for difference in intended.iter().filter(|d| d.case == name) {
                    (difference.apply)(&mut expected, &messages);
                    applied += 1;
                    let _ = difference.reason;
                }
                for section in ["posts", "calls", "metrics", "mongo", "dragonfly"] {
                    compare(
                        name,
                        section,
                        &expected[section],
                        &observed[section],
                        &mut mismatches,
                    );
                }
            }
            assert_eq!(
                twitch.unexpected(),
                Vec::<String>::new(),
                "no other Twitch call"
            );
            if !mismatches.is_empty() {
                bail!(
                    "{} mismatch(es):\n{}",
                    mismatches.len(),
                    mismatches.join("\n\n")
                );
            }
            assert_eq!(
                applied,
                intended.len(),
                "every intended difference applied once"
            );
            eprintln!(
                "{} recorded cases replayed, {applied} with an intended difference",
                cases.len()
            );
            Ok(())
        })
        .await
    })
}
