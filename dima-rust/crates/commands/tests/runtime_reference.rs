//! The runtime against what the real TypeScript did (`tests/runtime/reference.json`, recorded by
//! `tests/runtime/record.mts`): the same seed, the same calls in the same order, the same clock.
//! Compared: which command a lookup finds, the documents left after each write and availability
//! change (typed BSON, missing versus null), every Twitch request, chat history, the role cache
//! keys, the pure helpers. Each intended difference is stated where it is checked, and counted.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod runtime_support;

use std::sync::Arc;

use anyhow::Result;
use bson::doc;
use dima_commands::runtime::availability::{
    Availability, AvailabilityConfig, Target, TwitchRewardToggle,
};
use dima_commands::runtime::lookup::{CommandCache, Lookup, Names, Source};
use dima_commands::runtime::{
    RuntimeError, ast_variables, channel_cache, chat_history, random_user, user_level,
};
use dima_http::testing::MockResponse;
use runtime_support::*;
use serde_json::{Value, json};

const CHANNEL_A: &str = "990000001";
const CHANNEL_B: &str = "990000002";
const CHANNEL_C: &str = "990000003";

fn now() -> i64 {
    reference()["now"].as_i64().unwrap()
}

fn found_id(lookup: &Lookup) -> Value {
    lookup
        .command
        .as_ref()
        .map_or(Value::Null, |command| Value::String(command.id.to_hex()))
}

/// Which command each name finds, in channel A then B. The reference answers a found name from
/// MongoDB, then from its cached key; a missing name from MongoDB every time. Rust loads the
/// channel's snapshot on its first lookup and answers everything after it from the snapshot,
/// missing names included (no query per unknown name: intended).
#[tokio::test]
async fn lookups_find_what_the_reference_finds() -> Result<()> {
    with_env(now(), |env| async move {
        seed(&env).await?;
        let cache = env.cache();
        let mut compared = 0;
        let mut source_differs = 0;
        let mut first_in_channel = std::collections::HashSet::new();
        let mut unreadable = 0;
        for case in reference()["lookups"].as_array().unwrap() {
            let channel = case["channel"].as_str().unwrap();
            let name = case["name"].as_str().unwrap();
            for step in case["steps"].as_array().unwrap() {
                let expected = if first_in_channel.insert(channel.to_owned()) {
                    Source::Database
                } else {
                    Source::Cache
                };
                let lookup = match cache.find(channel, name).await {
                    Ok(lookup) => lookup,
                    // Intended: two stored shapes the model does not read (`dima-model` decides
                    // them, from the census): a `cmd` stored as an array (MongoDB matches each
                    // element; Mongoose casts every write to text) and `activation: null` (only
                    // a missing one occurs). The production copy holds neither. Rust finds the
                    // document (the snapshot maps each element) but cannot read it, so the
                    // lookup fails instead of answering.
                    Err(RuntimeError::Decode(path))
                        if matches!(name, "arr1" | "arr2" | "nullact") =>
                    {
                        assert!(
                            path.starts_with("cmd") || path.starts_with("activation"),
                            "{path}"
                        );
                        assert!(step["id"].is_string());
                        unreadable += 1;
                        compared += 1;
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                };
                assert!(
                    lookup.cache_error.is_none(),
                    "{name:?}: {:?}",
                    lookup.cache_error
                );
                assert_eq!(found_id(&lookup), step["id"], "{channel} {name:?}");
                if !step["enabled"].is_null() {
                    let enabled = lookup.command.as_ref().map(|c| c.is_enabled());
                    assert_eq!(
                        enabled.map(Value::Bool).unwrap_or(Value::Null),
                        step["enabled"]
                    );
                }
                let reference_source = if step["message"].as_str().unwrap().contains("from cache") {
                    Source::Cache
                } else {
                    Source::Database
                };
                assert_eq!(lookup.source, expected, "{channel} {name:?}");
                if expected != reference_source {
                    source_differs += 1;
                }
                compared += 1;
            }
        }
        assert_eq!(unreadable, 6);
        assert_eq!(compared, 79);
        // Intended: 55 lookups the reference sends to MongoDB come from the snapshot (40 for the
        // 20 names that do not exist, asked twice each; 15 first lookups of names that do).
        assert_eq!(source_differs, 55);
        // The snapshot: one hash per channel, complete, the reference's lifetime.
        let key = env.key(&format!("commands:snapshot:{CHANNEL_A}"));
        let ttl: i64 = env
            .stores
            .dragonfly
            .query(redis::cmd("PTTL").arg(&key))
            .await?;
        assert!((3_590_000..=3_600_000).contains(&ttl), "{ttl}");
        let mode: Option<String> = env
            .stores
            .dragonfly
            .query(redis::cmd("HGET").arg(&key).arg("v"))
            .await?;
        assert_eq!(mode.as_deref(), Some("c"));
        Ok(())
    })
    .await
}

fn writes_case(name: &str) -> &'static Value {
    reference()["writes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap()
}

#[tokio::test]
async fn count_update_stores_what_the_reference_stores() -> Result<()> {
    with_env(now(), |env| async move {
        seed(&env).await?;
        let cache = env.cache();
        let case = writes_case("count_update");
        cache.find(CHANNEL_A, "hola").await?;
        let outcomes = [
            cache.update_count(CHANNEL_A, "hola", 5.0).await,
            cache.update_count(CHANNEL_A, "nope", 1.0).await,
            cache.update_count(CHANNEL_A, "Mayus", 2.5).await,
            cache
                .update_count(CHANNEL_A, "\u{f1}and\u{fa}", 3_000_000_000.0)
                .await,
        ];
        for (outcome, recorded) in outcomes
            .into_iter()
            .zip(case["results"].as_array().unwrap())
        {
            let found = outcome.map_err(|e| e.into_runtime())?;
            assert_eq!(!found, recorded["error"].as_bool().unwrap());
        }
        let after = cache.find(CHANNEL_A, "hola").await?;
        assert_eq!(after.command.unwrap().count.0, 5.0);
        assert_eq!(
            after.source,
            Source::Database,
            "the updated name was re-read"
        );
        assert_eq!(
            changed_documents(&env, "commands").await?,
            case["documents"]
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn delete_removes_what_the_reference_removes() -> Result<()> {
    with_env(now(), |env| async move {
        seed(&env).await?;
        let cache = env.cache();
        let case = writes_case("delete");
        cache.find(CHANNEL_A, "hola").await?;
        let deleted = cache
            .delete(CHANNEL_A, "hola")
            .await
            .map_err(|e| e.into_runtime())?;
        let missing = cache
            .delete(CHANNEL_A, "nope")
            .await
            .map_err(|e| e.into_runtime())?;
        let results = case["results"].as_array().unwrap();
        assert_eq!(
            deleted.map(|c| c.id.to_hex()),
            results[0]["id"].as_str().map(str::to_owned)
        );
        assert!(missing.is_none() && results[1]["id"].is_null());
        assert!(cache.find(CHANNEL_A, "hola").await?.command.is_none());
        assert_eq!(case["after"], "Command does not exist");
        assert_eq!(
            changed_documents(&env, "commands").await?,
            case["documents"]
        );
        Ok(())
    })
    .await
}

/// The reference's stale entries, recorded, and what Rust serves instead (intended: the three
/// are closed; `tests/runtime_cache.rs` races them for real).
#[tokio::test]
async fn reference_staleness_is_closed() -> Result<()> {
    with_env(now(), |env| async move {
        // A writer killed between its database write and its invalidation.
        let recorded = writes_case("killed_writer");
        assert_eq!(
            recorded["served"], "reply 1",
            "the reference serves the old message"
        );
        assert_eq!(recorded["ttl"], 3600, "for an hour");
        seed(&env).await?;
        let cache = env.cache();
        cache.find(CHANNEL_A, "hola").await?;
        let writer = {
            let cache = cache.clone();
            let mongo = env.stores.mongo.clone();
            tokio::spawn(async move {
                cache
                    .write(CHANNEL_A, Names::These(&["hola"]), || async move {
                        mongo
                            .documents("commands")
                            .update_one(
                                doc! { "_id": oid("64a000000000000000000001") },
                                doc! { "$set": { "message": "changed" } },
                            )
                            .await?;
                        std::future::pending::<Result<(), anyhow::Error>>().await
                    })
                    .await
            })
        };
        wait_for_message(&env, "changed").await?;
        writer.abort();
        let _ = writer.await;
        let served = cache.find(CHANNEL_A, "hola").await?;
        assert_eq!(served.command.as_ref().unwrap().message, "changed");
        assert_eq!(served.source, Source::Database);

        // `deleteMany` (account deletion): Rust's caller drops the channel's snapshot.
        let recorded = writes_case("delete_many");
        assert_eq!(
            recorded["served"], "64a000000000000000000001",
            "the reference serves a deleted command"
        );
        seed(&env).await?;
        cache.find(CHANNEL_A, "hola").await?;
        env.stores
            .mongo
            .documents("commands")
            .delete_many(doc! { "channelID": CHANNEL_A })
            .await?;
        cache.invalidate_channel(CHANNEL_A).await?;
        assert!(cache.find(CHANNEL_A, "hola").await?.command.is_none());

        // A lookup that read before an update and published after it.
        let recorded = writes_case("read_write_race");
        assert_eq!(
            (recorded["served"].clone(), recorded["stored"].clone()),
            (json!(false), json!(true))
        );
        Ok(())
    })
    .await
}

async fn wait_for_message(env: &Env, message: &str) -> Result<()> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let stored = env
            .stores
            .mongo
            .documents("commands")
            .find_one(doc! { "_id": oid("64a000000000000000000001") })
            .await?;
        if stored
            .and_then(|d| d.get_str("message").ok().map(str::to_owned))
            .as_deref()
            == Some(message)
        {
            return Ok(());
        }
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "the write never landed"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

fn mock_response(answer: &Value) -> MockResponse {
    MockResponse::json(
        u16::try_from(answer["status"].as_u64().unwrap()).unwrap(),
        answer["body"].as_str().unwrap(),
    )
}

async fn run_availability_case(
    env: &Env,
    availability: &Availability<TwitchRewardToggle>,
    cache: &CommandCache,
    script: &Script,
    server: &dima_http::testing::MockServer,
    case: &Value,
) -> Result<()> {
    let name = case["name"].as_str().unwrap();
    seed(env).await?;
    env.clock.set(now());
    let offset = server.requests().len();
    let mut results = Vec::new();
    for step in case["steps"].as_array().unwrap() {
        for answer in step["twitch"].as_array().into_iter().flatten() {
            script.push(mock_response(answer));
        }
        match step["op"].as_str().unwrap() {
            "set" => {
                let seconds = match &step["seconds"] {
                    Value::Null => None,
                    Value::String(text) if text == "NaN" => Some(f64::NAN),
                    value => value.as_f64(),
                };
                let target = Target::from_name(step["target"].as_str().unwrap());
                let outcome = match target {
                    Ok(target) => {
                        availability
                            .set(
                                target,
                                step["channel"].as_str().unwrap_or(CHANNEL_A),
                                step["name"].as_str().unwrap(),
                                step["enabled"].as_bool().unwrap(),
                                seconds,
                            )
                            .await
                    }
                    Err(error) => Err(error),
                };
                results.push(match outcome {
                    Ok(()) => json!({ "ok": true }),
                    Err(error) => json!({ "error": error.to_string() }),
                });
            }
            "advance" => {
                env.clock.advance(step["ms"].as_i64().unwrap());
                results.push(json!({ "now": env.clock_now() }));
            }
            "recover" => {
                let report = availability.recover().await?;
                assert!(report.failed.is_empty(), "{name}: {:?}", report.failed);
                results.push(json!({ "recovered": true }));
            }
            _ => {
                let lookup = cache
                    .find(CHANNEL_A, step["name"].as_str().unwrap())
                    .await?;
                let enabled = lookup.command.as_ref().map(|c| c.is_enabled());
                results.push(json!({ "found": lookup.command.is_some(), "enabled": enabled }));
            }
        }
        assert_eq!(script.remaining(), 0, "{name}: unused Twitch answers");
    }
    // Lookups: only whether something was found and its `enabled` are compared (the message
    // names the source, which differs on purpose: see `lookups_find_what_the_reference_finds`).
    let recorded: Vec<Value> = case["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|result| match result.get("lookup") {
            Some(message) => json!({
                "found": message != "Command does not exist",
                "enabled": result["enabled"],
            }),
            None => result.clone(),
        })
        .collect();
    assert_eq!(
        Value::Array(results),
        Value::Array(recorded),
        "{name}: results"
    );
    let requests: Vec<Value> = server
        .requests()
        .iter()
        .skip(offset)
        .map(|request| {
            assert_eq!(request.header("client-id"), Some(CLIENT_ID));
            assert_eq!(request.header("content-type"), Some("application/json"));
            assert_eq!(
                request.header("authorization"),
                Some("Bearer streamer-access")
            );
            json!({
                "method": request.method,
                "target": request.target,
                "body": serde_json::from_str::<Value>(&request.body_text()).unwrap(),
            })
        })
        .collect();
    let recorded: Vec<Value> = case["requests"]
        .as_array()
        .unwrap()
        .iter()
        .map(|request| {
            json!({
                "method": request["method"],
                "target": request["url"].as_str().unwrap().trim_start_matches("https://api.twitch.tv"),
                "body": serde_json::from_str::<Value>(request["body"].as_str().unwrap()).unwrap(),
            })
        })
        .collect();
    assert_eq!(requests, recorded, "{name}: Twitch requests");
    assert_eq!(
        changed_documents(env, "commands").await?,
        case["commands"],
        "{name}: commands"
    );
    assert_eq!(
        changed_documents(env, "redemptionrewards").await?,
        case["rewards"],
        "{name}: rewards"
    );
    Ok(())
}

trait ClockNow {
    fn clock_now(&self) -> i64;
}

impl ClockNow for Env {
    fn clock_now(&self) -> i64 {
        dima_core::Clock::now_ms(&self.clock)
    }
}

fn availability_for(
    env: &Env,
    cache: &CommandCache,
    twitch: dima_twitch::Twitch,
) -> Availability<TwitchRewardToggle> {
    Availability::new(
        env.stores.clone(),
        cache.clone(),
        Arc::new(TwitchRewardToggle::new(twitch)),
        env.clock(),
        Arc::new(dima_core::SystemRandom),
        AvailabilityConfig::default(),
    )
}

/// Every recorded availability case but the one without a streamer token: same results, same
/// requests to Twitch, same documents.
#[tokio::test]
async fn availability_matches_the_reference() -> Result<()> {
    with_env(now(), |env| async move {
        let script = Script::default();
        let server = twitch_mock(script.clone()).await?;
        env.stores
            .mongo
            .documents("users")
            .insert_one(user_document(CHANNEL_A, now()))
            .await?;
        let (twitch, _shutdown) = twitch(&env, &server)?;
        let cache = env.cache();
        let availability = availability_for(&env, &cache, twitch);
        let mut cases = 0;
        for case in reference()["availability"].as_array().unwrap() {
            if case["name"] == "reward_no_credential" {
                continue;
            }
            run_availability_case(&env, &availability, &cache, &script, &server, case).await?;
            cases += 1;
        }
        assert_eq!(cases, 30);
        Ok(())
    })
    .await
}

/// No streamer token: the state is saved, nothing reaches Twitch, the credential's text (the
/// reference's `getTwitchStreamerHeaderById` message) is in the answer.
#[tokio::test]
async fn availability_without_a_streamer_token() -> Result<()> {
    with_env(now(), |env| async move {
        let script = Script::default();
        let server = twitch_mock(script.clone()).await?;
        let (twitch, _shutdown) = twitch(&env, &server)?;
        let cache = env.cache();
        let availability = availability_for(&env, &cache, twitch);
        let case = reference()["availability"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == "reward_no_credential")
            .unwrap();
        let mut case = case.clone();
        case["results"][0]["error"] = json!(
            case["results"][0]["error"]
                .as_str()
                .unwrap()
                .replace("{id}", CHANNEL_A)
        );
        run_availability_case(&env, &availability, &cache, &script, &server, &case).await
    })
    .await
}

#[tokio::test]
async fn chat_history_matches_the_reference() -> Result<()> {
    with_env(now(), |env| async move {
        let recorded = &reference()["history"];
        let stores = &env.stores;
        let platform = chat_history::Platform::Twitch;
        let mut lengths = Vec::new();
        for i in 0..105_i64 {
            let message = if i % 7 == 0 {
                format!("emoji \u{1f389} {i}")
            } else if i % 5 == 0 {
                format!("\u{645}\u{631}\u{62d}\u{628}\u{627} {i}")
            } else {
                format!("message {i}")
            };
            let entry = chat_history::HistoryEntry {
                username: format!("User{i}"),
                message,
                timestamp: now() + i,
                message_id: (i % 4 != 0).then(|| format!("id-{i}")),
                badges: (i % 3 != 0).then(|| vec!["moderator/1".to_owned()]),
            };
            assert!(chat_history::add_message(stores, platform, CHANNEL_A, &entry).await?);
            if [0, 99, 100, 104].contains(&i) {
                let key = chat_history::history_key(stores, platform, CHANNEL_A);
                let length: i64 = stores.dragonfly.query(redis::cmd("LLEN").arg(&key)).await?;
                lengths.push(json!({ "after": i + 1, "length": length }));
            }
        }
        assert_eq!(Value::Array(lengths), recorded["lengths"]);
        let invalid = |username: &str, message: &str| chat_history::HistoryEntry {
            username: username.to_owned(),
            message: message.to_owned(),
            timestamp: now(),
            message_id: Some("x".to_owned()),
            badges: Some(Vec::new()),
        };
        assert!(
            !chat_history::add_message(stores, platform, CHANNEL_A, &invalid("", "no user"))
                .await?
        );
        assert!(
            !chat_history::add_message(stores, platform, CHANNEL_A, &invalid("user", "")).await?
        );
        assert!(
            !chat_history::add_message(stores, platform, "", &invalid("user", "no channel"))
                .await?
        );
        let kick = chat_history::HistoryEntry {
            username: "KickUser".into(),
            message: "on kick".into(),
            timestamp: now(),
            message_id: None,
            badges: None,
        };
        chat_history::add_message(stores, chat_history::Platform::Kick, CHANNEL_A, &kick).await?;
        for limit in [7, 1, 0, -5, 30, 100, 200] {
            let read = chat_history::recent_messages(stores, platform, CHANNEL_A, limit).await?;
            assert_eq!(
                serde_json::to_value(&read)?,
                recorded["reads"][limit.to_string()],
                "limit {limit}"
            );
        }
        let kick =
            chat_history::recent_messages(stores, chat_history::Platform::Kick, CHANNEL_A, 7)
                .await?;
        assert_eq!(serde_json::to_value(&kick)?, recorded["kick"]);
        let empty = chat_history::recent_messages(stores, platform, CHANNEL_B, 7).await?;
        assert_eq!(serde_json::to_value(&empty)?, recorded["empty"]);
        chat_history::clear_history(stores, platform, CHANNEL_A).await?;
        let key = chat_history::history_key(stores, platform, CHANNEL_A);
        let kick_key = chat_history::history_key(stores, chat_history::Platform::Kick, CHANNEL_A);
        assert_eq!(
            json!(stores.dragonfly.exists(&[&key]).await?),
            recorded["afterClear"]
        );
        assert_eq!(
            json!(stores.dragonfly.exists(&[&kick_key]).await?),
            recorded["kickAfterClear"]
        );
        Ok(())
    })
    .await
}

/// Every key under `pattern` (without the test prefix) with its type, lifetime and content, as
/// `record.mts` writes them.
async fn key_state(env: &Env, pattern: &str) -> Result<Value> {
    let prefix = env.stores.keys.as_str().to_owned();
    let mut scan = env
        .stores
        .dragonfly
        .scan(&format!("{prefix}{pattern}"), Some(500));
    let mut keys = Vec::new();
    while let Some(page) = scan.next_page().await? {
        keys.extend(page.into_iter().map(|k| String::from_utf8(k).unwrap()));
    }
    keys.sort();
    let mut state = serde_json::Map::new();
    for key in keys {
        let dragonfly = &env.stores.dragonfly;
        let kind: String = dragonfly.query(redis::cmd("TYPE").arg(&key)).await?;
        let ttl: i64 = dragonfly.query(redis::cmd("TTL").arg(&key)).await?;
        let value = match kind.as_str() {
            "string" => json!(dragonfly.get_text(&key).await?),
            "set" => {
                let mut members: Vec<String> =
                    dragonfly.query(redis::cmd("SMEMBERS").arg(&key)).await?;
                members.sort();
                json!(members)
            }
            "hash" => {
                let fields: std::collections::BTreeMap<String, String> =
                    dragonfly.hgetall(&key).await?.into_iter().collect();
                json!(fields)
            }
            _ => Value::Null,
        };
        state.insert(
            key.trim_start_matches(&prefix).to_owned(),
            json!({ "type": kind, "ttl": ttl, "value": value }),
        );
    }
    Ok(Value::Object(state))
}

/// Compares two key states, hashes by content (the recording keeps the reference's field
/// order, which `HGETALL` does not promise).
fn same_keys(rust: &Value, reference: &Value) {
    let normalize = |value: &Value| -> Value {
        let mut value = value.clone();
        for entry in value.as_object_mut().unwrap().values_mut() {
            if entry["type"] == "hash" {
                let sorted: std::collections::BTreeMap<String, Value> = entry["value"]
                    .as_object()
                    .unwrap()
                    .clone()
                    .into_iter()
                    .collect();
                entry["value"] = json!(sorted);
            }
        }
        value
    };
    assert_eq!(normalize(rust), normalize(reference));
}

#[tokio::test]
async fn role_cache_load_and_resets_match_the_reference() -> Result<()> {
    with_env(now(), |env| async move {
        let recorded = &reference()["channelCache"];
        seed(&env).await?;
        let dragonfly = &env.stores.dragonfly;
        let key = |k: &str| env.key(k);
        dragonfly
            .query_value(
                redis::cmd("SADD")
                    .arg(key(&format!("twitch:{CHANNEL_C}:admins")))
                    .arg("gone"),
            )
            .await?;
        dragonfly
            .query_value(
                redis::cmd("SADD")
                    .arg(key(&format!("twitch:{CHANNEL_C}:admins:ids")))
                    .arg("a999"),
            )
            .await?;
        dragonfly
            .hset(
                &key(&format!("twitch:{CHANNEL_C}:admins:a999")),
                &[("adminID", b"a999"), ("adminName", b"gone")],
            )
            .await?;
        dragonfly
            .query_value(
                redis::cmd("SET")
                    .arg(key(&format!("{CHANNEL_C}:admins:legacy")))
                    .arg("x"),
            )
            .await?;
        dragonfly
            .query_value(
                redis::cmd("SADD")
                    .arg(key(&format!("twitch:{CHANNEL_B}:admins")))
                    .arg("untouched"),
            )
            .await?;
        let deadline = std::time::Duration::from_secs(30);
        assert_eq!(
            channel_cache::load_channel_admins(&env.stores, CHANNEL_C, deadline).await?,
            4
        );
        same_keys(
            &key_state(&env, &format!("*{CHANNEL_C}*")).await?,
            &recorded["admins"],
        );
        same_keys(
            &key_state(&env, &format!("*{CHANNEL_B}*")).await?,
            &recorded["otherChannel"],
        );
        channel_cache::load_channel_admins(&env.stores, CHANNEL_C, deadline).await?;
        same_keys(
            &key_state(&env, &format!("*{CHANNEL_C}*")).await?,
            &recorded["adminsTwice"],
        );

        clean_prefix(dragonfly, env.stores.keys.as_str()).await?;
        for (k, v) in [
            (format!("{CHANNEL_A}:follows:count"), "17"),
            (format!("{CHANNEL_A}:commands"), "legacy"),
            (format!("{CHANNEL_A}:sumimetro:alice"), "42"),
            (format!("{CHANNEL_A}:sumimetro:bob"), "7"),
            (format!("{CHANNEL_B}:sumimetro:carol"), "1"),
        ] {
            dragonfly
                .query_value(redis::cmd("SET").arg(key(&k)).arg(v))
                .await?;
        }
        dragonfly
            .hset(
                &key(&format!("{CHANNEL_A}:sumimetro:dominant")),
                &[("user", b"alice"), ("value", b"42")],
            )
            .await?;
        channel_cache::clear_channel_cache(&env.stores, CHANNEL_A).await?;
        assert_eq!(
            channel_cache::reset_sumimetro(&env.stores, CHANNEL_A).await?,
            3
        );
        let mut expected_a = recorded["afterResets"]["a"].clone();
        // Intended: `{channel}:commands` (a legacy key nothing writes) is not deleted.
        assert!(expected_a.get(format!("{CHANNEL_A}:commands")).is_none());
        expected_a[format!("{CHANNEL_A}:commands")] =
            json!({ "type": "string", "ttl": -1, "value": "legacy" });
        same_keys(
            &key_state(&env, &format!("*{CHANNEL_A}*")).await?,
            &expected_a,
        );
        same_keys(
            &key_state(&env, &format!("*{CHANNEL_B}*")).await?,
            &recorded["afterResets"]["b"],
        );
        assert!(
            channel_cache::reset_sumimetro(&env.stores, "99*")
                .await
                .is_err(),
            "glob characters are refused"
        );
        Ok(())
    })
    .await
}

#[test]
fn user_levels_match_the_reference() {
    let mut cases = 0;
    for case in reference()["userLevels"].as_array().unwrap() {
        let level = match &case["level"] {
            Value::Number(n) => n.as_f64(),
            Value::String(text) if text == "Infinity" => Some(f64::INFINITY),
            Value::String(text) if text == "NaN" => Some(f64::NAN),
            // `typeof '9' !== 'number'`: not a level.
            _ => None,
        };
        let got = user_level::resolve_authored_user_level(&case["event"], level);
        assert_eq!(Some(got), case["expected"].as_f64(), "{case}");
        cases += 1;
    }
    assert_eq!(cases, 22);
}

#[test]
fn blacklists_match_the_reference() {
    for case in reference()["blacklists"].as_array().unwrap() {
        let got = random_user::normalize_random_user_blacklist(&case["input"]);
        assert_eq!(json!(got), case["expected"], "{}", case["input"]);
    }
}

#[test]
fn ast_variable_plan_matches_the_reference() {
    let plan = &reference()["astPlan"];
    let rows: Vec<ast_variables::LegacyAstVariables> = plan["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| ast_variables::LegacyAstVariables {
            channel_id: row["channelID"].as_str().unwrap().to_owned(),
            scope_type: row["scopeType"].as_str().unwrap().to_owned(),
            scope_name: row["scopeName"].as_str().unwrap().to_owned(),
            user_id: row["userId"].as_str().unwrap().to_owned(),
            user_login: row["userLogin"].as_str().unwrap().to_owned(),
            variables: row["variables"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
                .collect(),
            updated_at_ms: row["updatedAt"].as_i64(),
            id: row["_id"].as_str().map(str::to_owned),
        })
        .collect();
    let collator = dima_text::Collator::new().unwrap();
    let got: Vec<Value> = ast_variables::plan_global_ast_variables(&rows, &collator)
        .into_iter()
        .map(|group| {
            let variables: serde_json::Map<String, Value> = group
                .variables
                .into_iter()
                .map(|(k, v)| (k, Value::String(v)))
                .collect();
            json!({
                "channelID": group.channel_id,
                "scopeType": "global",
                "scopeName": "global",
                "userId": group.user_id,
                "userLogin": group.user_login,
                "variables": variables,
            })
        })
        .collect();
    assert_eq!(Value::Array(got), plan["expected"]);
}
