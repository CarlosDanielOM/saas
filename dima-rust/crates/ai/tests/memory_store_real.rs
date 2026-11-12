#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Real data, read only (`domdimabot`, the local production copy): every stored memory decodes,
//! its stored Qdrant point id is the one `generate_qdrant_point_id` derives, and the list,
//! pending count, known-viewer facts and validation of recalled ids give the reference's
//! answers over a sample of real channels (`memory_store_real.json`, made by
//! `memory_store_real.mts`: ids, numbers and hashes only).

use dima_ai::embeddings::{self, Service};
use dima_ai::memory::Policy;
use dima_ai::memory_store::{
    DriverIds, KnownUserQuery, ListMemories, MemoryStore, Parts, ScoredCandidate, StoredMemory,
};
use dima_core::SystemClock;
use dima_model::channel_ai_memories::ChannelAiMemory;
use dima_store::mongo::{MongoConfig, MongoStore};
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use std::sync::Arc;

const FIXTURE: &str = include_str!("memory_store_real.json");

/// Numbers by value (`1` and `1.0`).
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

fn hash(v: &Value) -> String {
    dima_core::crypto::sha256(serde_json::to_string(v).unwrap().as_bytes()).hex()
}

async fn production_copy() -> anyhow::Result<Option<(MongoStore, MemoryStore)>> {
    let Ok(uri) = std::env::var("DIMA_TEST_MONGO_URI") else {
        anyhow::ensure!(
            std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() != Ok("1"),
            "MongoDB required"
        );
        return Ok(None);
    };
    let mut config = MongoConfig::new(uri);
    config.database = Some("domdimabot".into());
    let mongo = MongoStore::connect(&config, None).await?;
    let http = dima_http::HttpClient::builder().build()?;
    // No embedding or Qdrant call is made by these reads; both point nowhere.
    let embeddings = Arc::new(embeddings::Client {
        http: http.clone(),
        provider: embeddings::Config::lfm2().provider(Service::Lfm2)?,
        service: Service::Lfm2,
    });
    let store = MemoryStore::new(Parts {
        mongo: mongo.clone(),
        qdrant_http: http,
        qdrant_provider: None,
        qdrant_collection: "unused".into(),
        embeddings,
        channel_names: Arc::new(NoNames),
        clock: Arc::new(SystemClock),
        ids: Arc::new(DriverIds),
        config: Default::default(),
        observer: None,
        faults: None,
    });
    Ok(Some((mongo, store)))
}

struct NoNames;
impl dima_ai::memory_store::ChannelNames for NoNames {
    fn channel_name<'a>(
        &'a self,
        _: &'a str,
    ) -> dima_ai::memory_store::BoxFuture<'a, Option<String>> {
        Box::pin(async { None })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_stored_memory_decodes_and_keeps_its_point_id() -> anyhow::Result<()> {
    let Some((mongo, _)) = production_copy().await? else {
        return Ok(());
    };
    let fixture: Value = serde_json::from_str(FIXTURE)?;
    let mut cursor = mongo
        .documents("channelaimemories")
        .find(bson::doc! {})
        .await?;
    let (mut decoded, mut with_id, mut derived) = (0_u64, 0_u64, 0_u64);
    while let Some(document) = cursor.try_next().await? {
        let memory: ChannelAiMemory = dima_model::decode_document(&document).map_err(|e| {
            anyhow::anyhow!(
                "{} does not decode: {e}",
                document
                    .get_object_id("_id")
                    .map(|i| i.to_hex())
                    .unwrap_or_default()
            )
        })?;
        decoded += 1;
        if let (Some(stored), Some(created)) = (memory.qdrant_point_id, memory.created_at) {
            with_id += 1;
            let id = dima_ai::qdrant::generate_qdrant_point_id(
                &memory.channel_id,
                &memory.id.to_hex(),
                created.0.div_euclid(1000) as f64,
            );
            if f64::from(id) == stored.0 {
                derived += 1;
            }
        }
    }
    anyhow::ensure!(
        decoded == fixture["documents"].as_u64().unwrap(),
        "{decoded} documents"
    );
    anyhow::ensure!(
        with_id > 5_000 && derived == with_id,
        "{derived} of {with_id} point ids derive from the memory"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_over_real_channels_match_the_reference() -> anyhow::Result<()> {
    let Some((_, store)) = production_copy().await? else {
        return Ok(());
    };
    let fixture: Value = serde_json::from_str(FIXTURE)?;
    let s = |v: &Value| v.as_str().map(str::to_owned);
    for case in fixture["cases"].as_array().unwrap() {
        let channel = case["channelID"].as_str().unwrap();
        for list in case["lists"].as_array().unwrap() {
            let i = &list["input"];
            let page = store
                .list(&ListMemories {
                    channel_id: channel.into(),
                    statuses: i["statuses"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(s)
                        .collect(),
                    kind: s(&i["type"]),
                    limit: i["limit"].as_f64(),
                    skip: i["skip"].as_f64(),
                })
                .await?;
            let items: Vec<Value> = page.items.iter().map(StoredMemory::to_json).collect();
            let ids: Vec<Value> = items.iter().map(|x| x["_id"].clone()).collect();
            let hashes: Vec<Value> = items.iter().map(|x| json!(hash(x))).collect();
            anyhow::ensure!(
                json!(page.total) == list["total"] && json!(ids) == list["ids"],
                "{channel}: list {i}"
            );
            anyhow::ensure!(
                json!(hashes) == list["hashes"],
                "{channel}: list items render differently {i}"
            );
        }
        anyhow::ensure!(
            json!(store.pending_count(channel).await) == case["pending"],
            "{channel}: pending"
        );
        for k in case["known"].as_array().unwrap() {
            let i = &k["input"];
            let facts = store
                .known_user_facts(&KnownUserQuery {
                    channel_id: channel.into(),
                    user_id: s(&i["userID"]).unwrap(),
                    limit: i["limit"].as_u64().unwrap() as usize,
                    allow_sensitive_memories: i["allowSensitiveMemories"].as_bool().unwrap(),
                })
                .await;
            let got: Vec<Value> = facts
                .iter()
                .map(|f| {
                    let mut v = json!(f);
                    v["summary"] = json!(hash(&v["summary"]));
                    v
                })
                .collect();
            anyhow::ensure!(
                loose_eq(&json!(got), &k["result"]),
                "{channel}: known facts"
            );
        }
        for v in case["validate"].as_array().unwrap() {
            let i = &v["input"];
            let p = &i["policy"];
            let candidates: Vec<ScoredCandidate> = i["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| ScoredCandidate {
                    memory_id: s(&c["memory_id"]).unwrap(),
                    score: c["score"].as_f64().unwrap(),
                })
                .collect();
            let policy = Policy {
                allow_sensitive_memories: p["allowSensitiveMemories"].as_bool().unwrap(),
                allow_user_preference_memories: p["allowUserPreferenceMemories"].as_bool().unwrap(),
                allow_running_jokes: p["allowRunningJokes"].as_bool().unwrap(),
            };
            let got: Vec<Value> = store
                .validate_context(
                    channel,
                    &candidates,
                    i["limit"].as_u64().unwrap() as usize,
                    &policy,
                )
                .await
                .iter()
                .map(|m| {
                    let mut x = json!(m);
                    x["summary"] = json!(hash(&x["summary"]));
                    x
                })
                .collect();
            anyhow::ensure!(
                loose_eq(&json!(got), &v["result"]),
                "{channel}: validate\n rust {}\n   ts {}",
                json!(got),
                v["result"]
            );
        }
    }
    Ok(())
}
