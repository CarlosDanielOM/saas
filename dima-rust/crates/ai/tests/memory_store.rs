#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! `memory_store` against the recording of `memory.service.ts` (`memory_store_reference.json`,
//! made by `memory_store_reference.mts`): each scenario runs on the same seeds, clock, ids and
//! mock vectors, and the results, every stored document (BSON types and key order), every
//! Qdrant point (id, payload, vector) and every embedding request are compared. The scenarios
//! whose outcome changed on purpose are listed in `differs` with the reason, and asserted.

mod memory_store_support;

use dima_ai::memory::Policy;
use dima_ai::memory_store::{
    ActorInput, CreateMemory, CreateOutcome, EvidenceInput, KnownUserQuery, ListMemories,
    MemoryError, Private, RecallQuery, ScoredCandidate, SetStatus, Step, StoredMemory,
    SubjectInput, UpdateMemory,
};
use dima_ai::qdrant::{MemoryRetrievalMode, MemorySubjectScope};
use dima_model::channel_ai_memories::{
    MemoryRisk, MemorySource, MemoryStatus, MemoryType, SubjectScope,
};
use dima_model::enums::StrEnum;
use memory_store_support::{Env, with_env};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const RECORDING: &str = include_str!("memory_store_reference.json");

fn s(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}
fn parse<E: StrEnum>(v: &Value) -> Option<E> {
    v.as_str().and_then(E::parse)
}
fn subject(v: &Value) -> Option<SubjectInput> {
    v.is_object().then(|| SubjectInput {
        scope: parse::<SubjectScope>(&v["scope"]),
        username: s(&v["username"]),
        user_id: s(&v["userID"]),
    })
}
fn actor(v: &Value) -> Option<ActorInput> {
    v.is_object().then(|| ActorInput {
        source: parse::<MemorySource>(&v["source"]),
        username: s(&v["username"]),
        user_id: s(&v["userID"]),
    })
}

/// The recorded TypeScript input as the Rust input; `None` when the closed types cannot express
/// it (an unknown memory type).
fn create_input(v: &Value) -> Option<CreateMemory> {
    let kind = parse::<MemoryType>(&v["type"])?;
    let mut input = CreateMemory::new(
        s(&v["channelID"])?,
        kind,
        s(&v["content"]).unwrap_or_default(),
    );
    input.channel_name = s(&v["channelName"]);
    input.risk = parse::<MemoryRisk>(&v["risk"]);
    input.confidence = v["confidence"].as_f64();
    input.subject = subject(&v["subject"]);
    input.summary = s(&v["summary"]).map(Private::new);
    input.evidence = v["evidence"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| EvidenceInput {
            source: parse::<MemorySource>(&e["source"]),
            username: s(&e["username"]),
            user_id: s(&e["userID"]),
            message: s(&e["message"]).map(Private::new),
            message_id: s(&e["messageId"]),
            timestamp: e["timestamp"].as_f64(),
        })
        .collect();
    input.created_by = actor(&v["createdBy"]);
    input.force_status = parse::<MemoryStatus>(&v["forceStatus"]);
    input.bypass_learning_config = v["bypassLearningConfig"].as_bool().unwrap_or(false);
    input.bypass_memory_policy = v["bypassMemoryPolicy"].as_bool().unwrap_or(false);
    input.preserve_confirmed = v["preserveConfirmed"].as_bool().unwrap_or(false);
    Some(input)
}

fn memory_result(r: Result<StoredMemory, MemoryError>) -> Value {
    match r {
        Ok(m) => json!({"error": false, "memory": m.to_json()}),
        Err(e) => json!({"error": true, "message": e.message}),
    }
}

/// Runs one recorded step in Rust and renders its result as the reference's JSON.
async fn run_step(env: &Env, op: &str, v: &Value) -> Value {
    let store = &env.store;
    let channel = s(&v["channelID"]).unwrap_or_default();
    let memory_id = s(&v["memoryID"]).unwrap_or_default();
    match op {
        "create" => match create_input(v) {
            None => json!({"unrepresentable": true}),
            Some(input) => match store.create_or_update(input).await {
                Ok(CreateOutcome::LearningDisabled) => {
                    json!({"error": false, "message": "Learning disabled for this channel"})
                }
                Ok(outcome) => {
                    json!({"error": false, "memory": outcome.memory().unwrap().to_json()})
                }
                Err(e) => json!({"error": true, "message": e.message}),
            },
        },
        "status" => memory_result(
            store
                .set_status(SetStatus {
                    channel_id: channel,
                    memory_id,
                    status: parse(&v["status"]).unwrap(),
                    review_reason: s(&v["reviewReason"]),
                    reviewer: actor(&v["reviewer"]),
                })
                .await,
        ),
        "update" => memory_result(
            store
                .update(UpdateMemory {
                    channel_id: channel,
                    memory_id,
                    kind: parse(&v["type"]),
                    risk: parse(&v["risk"]),
                    confidence: v["confidence"].as_f64(),
                    content: s(&v["content"]).map(Private::new),
                    summary: s(&v["summary"]).map(Private::new),
                    subject: subject(&v["subject"]),
                })
                .await,
        ),
        "delete" => match store.delete(&channel, &memory_id).await {
            Ok(()) => json!({"error": false, "deleted": true}),
            Err(e) => json!({"error": true, "message": e.message}),
        },
        "list" => {
            let params = ListMemories {
                channel_id: channel,
                statuses: v["statuses"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(s)
                    .collect(),
                kind: s(&v["type"]),
                limit: v["limit"].as_f64(),
                skip: v["skip"].as_f64(),
            };
            match store.list(&params).await {
                Ok(page) => {
                    json!({"error": false, "items": page.items.iter().map(StoredMemory::to_json).collect::<Vec<_>>(), "total": page.total})
                }
                Err(e) => json!({"error": true, "items": [], "total": 0, "message": e.message}),
            }
        }
        "pending" => json!(store.pending_count(&channel).await),
        "known" => json!(
            store
                .known_user_facts(&KnownUserQuery {
                    channel_id: channel,
                    user_id: s(&v["userID"]).unwrap_or_default(),
                    limit: v["limit"].as_u64().unwrap_or(0) as usize,
                    allow_sensitive_memories: v["allowSensitiveMemories"]
                        .as_bool()
                        .unwrap_or(false),
                })
                .await
        ),
        "validate" => {
            let p = &v["policy"];
            let policy = Policy {
                allow_sensitive_memories: p["allowSensitiveMemories"].as_bool().unwrap(),
                allow_user_preference_memories: p["allowUserPreferenceMemories"].as_bool().unwrap(),
                allow_running_jokes: p["allowRunningJokes"].as_bool().unwrap(),
            };
            let candidates: Vec<_> = v["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| ScoredCandidate {
                    memory_id: s(&c["memory_id"]).unwrap(),
                    score: c["score"].as_f64().unwrap(),
                })
                .collect();
            json!(
                store
                    .validate_context(
                        &channel,
                        &candidates,
                        v["limit"].as_u64().unwrap() as usize,
                        &policy
                    )
                    .await
            )
        }
        "usage" => {
            let ids: Vec<String> = v["memoryIDs"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(s)
                .collect();
            store.record_usage(&channel, &ids).await;
            Value::Null
        }
        "recall" => {
            let q = RecallQuery {
                channel_id: channel,
                query: Private::new(s(&v["query"]).unwrap_or_default()),
                limit: v["limit"].as_u64().unwrap() as usize,
                min_score: v["minScore"].as_f64(),
                mode: if v["mode"] == "explicit" {
                    MemoryRetrievalMode::Explicit
                } else {
                    MemoryRetrievalMode::Passive
                },
                subject_scope: if v["subjectScope"] == "any" {
                    MemorySubjectScope::Any
                } else {
                    MemorySubjectScope::Channel
                },
            };
            match store.recall(&q).await {
                Ok(items) => json!({"error": false, "items": items}),
                Err(e) => json!({"error": true, "message": e.message, "items": []}),
            }
        }
        "learning" => {
            let l = store.learning_settings(&channel).await.unwrap();
            json!({"autoConfirmThreshold": l.auto_confirm_threshold, "createMinConfidence": l.create_min_confidence, "autoConfirmEnabled": l.auto_confirm_enabled})
        }
        "sync" => match store.sync_memory(&channel, &memory_id).await {
            Ok(_) => json!({"error": false}),
            Err(e) => json!({"error": true, "message": e.message}),
        },
        // No id-less point delete exists in Rust: the nearest request a caller can make is a
        // delete of the other channel's memory by its id, which is refused.
        "rawDeletePoint" => {
            let (_, b) = memory_ids_of(env).await.into_iter().next().unwrap();
            match store.delete(&channel, &b).await {
                Ok(()) => json!({"error": false}),
                Err(e) => json!({"error": true, "message": e.message}),
            }
        }
        "deleteAll" => match store.delete_all_channel_memories(&channel).await {
            Ok(n) => json!({"points": {"error": false}, "deletedCount": n}),
            Err(e) => json!({"error": true, "message": e.message}),
        },
        other => panic!("unknown op {other}"),
    }
}

async fn memory_ids_of(env: &Env) -> Vec<(String, String)> {
    env.documents()
        .await
        .unwrap()
        .iter()
        .map(|d| {
            (
                d.get_str("channelID").unwrap().to_owned(),
                d.get_object_id("_id").unwrap().to_hex(),
            )
        })
        .collect()
}

struct Outcome {
    results: Vec<Value>,
    documents: Vec<Value>,
    points: Vec<Value>,
    embeddings: Vec<Value>,
}

async fn run_scenario(env: &Env, scenario: &Value) -> anyhow::Result<Outcome> {
    env.reset().await?;
    let seed = &scenario["seed"];
    for p in seed["personalities"].as_array().into_iter().flatten() {
        env.insert_ejson("channelaipersonalities", p).await?;
    }
    for m in seed["memories"].as_array().into_iter().flatten() {
        env.insert_ejson("channelaimemories", m).await?;
    }
    for (channel, id) in memory_ids_of(env).await {
        let n = u64::from_str_radix(id.get(8..).unwrap(), 16)?;
        if seed["points"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|p| p.as_u64() == Some(n))
        {
            env.store
                .sync_memory(&channel, &id)
                .await
                .map_err(|e| anyhow::anyhow!(e))?;
        }
    }
    let baseline = env.embeddings().len();
    let mut results = Vec::new();
    for step in scenario["steps"].as_array().unwrap() {
        env.clock.set(step["at"].as_i64().unwrap());
        results.push(run_step(env, step["op"].as_str().unwrap(), &step["input"]).await);
    }
    let documents = env
        .documents()
        .await?
        .into_iter()
        .map(|d| bson::Bson::Document(d).into_canonical_extjson())
        .collect();
    Ok(Outcome {
        results,
        documents,
        points: env.points().await?,
        embeddings: env.embeddings().split_off(baseline),
    })
}

/// Scenarios whose outcome changed on purpose, and why.
fn differs() -> BTreeMap<&'static str, &'static str> {
    BTreeMap::from([
        (
            "create_long_summary",
            "the reference cuts the summary inside an emoji; Qdrant refuses the lone surrogate and the create fails; Rust cuts before the character",
        ),
        (
            "update_empty_content_leaves_point_rewritten",
            "the reference rewrites the point before the save that the schema refuses; Rust validates first and writes nothing",
        ),
        (
            "update_fingerprint_clash_leaves_ghost",
            "the reference rewrites the point before the save that the unique index refuses (a ghost text); Rust refuses before any write",
        ),
        (
            "create_invalid_type_rolls_back",
            "an unknown type cannot be expressed in Rust; the reference buys an embedding and writes the point before the schema refuses it",
        ),
        (
            "usage_counts",
            "an invalid id makes the reference's cast fail the whole update; Rust skips it and counts the valid ones",
        ),
        (
            "delete_point_without_id_crosses_channels",
            "the reference's id-less delete removes another channel's point; Rust has no id-less delete and refuses the other channel's memory",
        ),
    ])
}

/// Equal as JSON values: numbers by value (`1` and `1.0`), object keys in any order. Used for
/// results and Qdrant points (Qdrant keeps payload keys in the writer's order, not a contract).
fn loose_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| loose_eq(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| loose_eq(v, w)))
        }
        _ => a == b,
    }
}

fn same_order(a: &Value, b: &Value) -> bool {
    serde_json::to_string(a).ok() == serde_json::to_string(b).ok()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recorded_scenarios_match_the_reference() -> anyhow::Result<()> {
    let recording: Value = serde_json::from_str(RECORDING)?;
    let names: Vec<(String, String)> = recording["names"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
        .collect();
    let names: Vec<(&str, &str)> = names
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    with_env(&names, |env| async move {
        let differs = differs();
        let mut compared = 0;
        for scenario in recording["scenarios"].as_array().unwrap() {
            let name = scenario["name"].as_str().unwrap();
            let rust = run_scenario(&env, scenario).await?;
            let ts_results: Vec<Value> = scenario["steps"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["result"].clone())
                .collect();
            if let Some(reason) = differs.get(name) {
                check_difference(name, reason, scenario, &rust)?;
                continue;
            }
            for (i, (r, t)) in rust.results.iter().zip(&ts_results).enumerate() {
                anyhow::ensure!(
                    loose_eq(r, t),
                    "{name} step {i}: result\n rust {r}\n   ts {t}"
                );
            }
            let ts_docs = scenario["documents"].as_array().unwrap();
            anyhow::ensure!(
                rust.documents.len() == ts_docs.len(),
                "{name}: document count"
            );
            for (r, t) in rust.documents.iter().zip(ts_docs) {
                anyhow::ensure!(same_order(r, t), "{name}: document\n rust {r}\n   ts {t}");
            }
            anyhow::ensure!(
                loose_eq(&Value::from(rust.points.clone()), &scenario["points"]),
                "{name}: points\n rust {:?}\n   ts {}",
                rust.points,
                scenario["points"]
            );
            anyhow::ensure!(
                Value::from(rust.embeddings.clone()) == scenario["embeddings"],
                "{name}: embedding requests\n rust {:?}\n   ts {}",
                rust.embeddings,
                scenario["embeddings"]
            );
            compared += 1;
        }
        anyhow::ensure!(compared >= 18, "only {compared} scenarios compared");
        Ok(())
    })
    .await
}

fn check_difference(name: &str, reason: &str, ts: &Value, rust: &Outcome) -> anyhow::Result<()> {
    let ts_docs = ts["documents"].as_array().unwrap();
    let ts_points = ts["points"].as_array().unwrap();
    let ts_last = ts["steps"].as_array().unwrap().last().unwrap()["result"].clone();
    let rust_last = rust.results.last().unwrap().clone();
    let ctx = || format!("{name} ({reason})");
    let point_of = |doc: &Value, points: &[Value]| -> Option<Value> {
        let id = doc["_id"]["$oid"].as_str()?;
        points
            .iter()
            .find(|p| p["payload"]["memory_id"] == id)
            .cloned()
    };
    match name {
        "create_long_summary" => {
            anyhow::ensure!(
                ts_last["error"] == true && ts_docs.is_empty() && ts_points.is_empty(),
                "{}",
                ctx()
            );
            anyhow::ensure!(
                rust_last["error"] == false && rust.points.len() == 1,
                "{}",
                ctx()
            );
            let summary = rust_last["memory"]["summary"].as_str().unwrap();
            anyhow::ensure!(
                summary == format!("{}{}...", "é".repeat(100), "😀".repeat(38)),
                "{}",
                ctx()
            );
        }
        "update_empty_content_leaves_point_rewritten" | "update_fingerprint_clash_leaves_ghost" => {
            // Same answer, same documents.
            anyhow::ensure!(
                ts_last == rust_last && ts_last["error"] == true,
                "{}",
                ctx()
            );
            for (r, t) in rust.documents.iter().zip(ts_docs) {
                anyhow::ensure!(same_order(r, t), "{}: documents", ctx());
            }
            // The reference: the edited memory's point no longer matches its document.
            let edited = ts_docs.last().unwrap();
            let ts_point = point_of(edited, ts_points).unwrap();
            anyhow::ensure!(
                ts_point["payload"]["summary"] != edited["summary"],
                "{}: reference leftover",
                ctx()
            );
            // Rust: every point still matches its document.
            for doc in &rust.documents {
                let p = point_of(doc, &rust.points).unwrap();
                anyhow::ensure!(
                    p["payload"]["content"] == doc["content"]
                        && p["payload"]["summary"] == doc["summary"],
                    "{}: rust point",
                    ctx()
                );
            }
            anyhow::ensure!(
                rust.embeddings.len() < ts["embeddings"].as_array().unwrap().len(),
                "{}: embeddings",
                ctx()
            );
        }
        "create_invalid_type_rolls_back" => {
            anyhow::ensure!(
                rust_last["unrepresentable"] == true && rust.embeddings.is_empty(),
                "{}",
                ctx()
            );
            anyhow::ensure!(
                !ts["embeddings"].as_array().unwrap().is_empty(),
                "{}: reference paid",
                ctx()
            );
            // The reference wrote the point before the insert it then failed.
            let events: Vec<String> = ts["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e.to_string())
                .collect();
            let put = events
                .iter()
                .position(|e| e.contains("PUT /points"))
                .unwrap();
            anyhow::ensure!(
                !events.iter().any(|e| e.contains("\"insert\""))
                    || events
                        .iter()
                        .position(|e| e.contains("\"insert\""))
                        .unwrap()
                        > put,
                "{}",
                ctx()
            );
        }
        "usage_counts" => {
            let use_count = |docs: &[Value], i: usize| docs[i]["useCount"].clone();
            anyhow::ensure!(
                use_count(ts_docs, 1) == json!({"$numberInt": "0"}),
                "{}",
                ctx()
            );
            anyhow::ensure!(
                use_count(&rust.documents, 1) == json!({"$numberInt": "1"}),
                "{}",
                ctx()
            );
            anyhow::ensure!(
                same_order(&rust.documents[0], &ts_docs[0])
                    && same_order(&rust.documents[2], &ts_docs[2]),
                "{}: other documents",
                ctx()
            );
        }
        "delete_point_without_id_crosses_channels" => {
            // TypeScript: channel 1001's call deleted channel 2002's point.
            anyhow::ensure!(
                ts_last == json!({"error": false}) && ts_points.is_empty(),
                "{}",
                ctx()
            );
            anyhow::ensure!(
                rust_last == json!({"error": true, "message": "Memory not found"}),
                "{}",
                ctx()
            );
            anyhow::ensure!(
                rust.points.len() == 1 && rust.points[0]["payload"]["channel_id"] == "2002",
                "{}",
                ctx()
            );
        }
        _ => anyhow::bail!("no check for {name}"),
    }
    Ok(())
}

/// The reference writes the point before the document; Rust the document first (create),
/// and deletes the point first when a memory leaves recall.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn write_order_differs_on_purpose() -> anyhow::Result<()> {
    let recording: Value = serde_json::from_str(RECORDING)?;
    let scenario = recording["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "create_confirmed_then_list")
        .unwrap();
    let events: Vec<String> = scenario["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e.to_string())
        .collect();
    let put = events
        .iter()
        .position(|e| e.contains("PUT /points"))
        .unwrap();
    let insert = events
        .iter()
        .position(|e| e.contains("\"insert\""))
        .unwrap();
    assert!(put < insert, "reference: point before document");
    with_env(&[("1001", "alpha")], |env| async move {
        let mut input = CreateMemory::new("1001", MemoryType::ChannelLore, "tea order");
        input.confidence = Some(0.9);
        env.store.create_or_update(input).await?;
        let steps = env.faults.steps();
        let insert = steps.iter().position(|s| *s == Step::MongoInsert).unwrap();
        let upsert = steps.iter().position(|s| *s == Step::QdrantUpsert).unwrap();
        anyhow::ensure!(insert < upsert, "{steps:?}");
        Ok(())
    })
    .await
}

#[test]
fn recording_names_the_frozen_reference() {
    let recording: Value = serde_json::from_str(RECORDING).unwrap();
    assert_eq!(recording["reference"], "0c71108e");
    let Ok(dir) = std::env::var("DIMABOT_DIR") else {
        return;
    };
    for (file, hash) in recording["sources"].as_object().unwrap() {
        let bytes = std::fs::read(format!("{dir}/{file}")).unwrap();
        assert_eq!(
            dima_core::crypto::sha256(&bytes).hex(),
            hash.as_str().unwrap(),
            "{file} changed"
        );
    }
}
