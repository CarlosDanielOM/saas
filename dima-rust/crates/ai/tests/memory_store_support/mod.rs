#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Harness of the `memory_store` tests: a scratch MongoDB database and Qdrant collection named
//! `dima_test_ai_<random>` (dropped by [`Env::cleanup`], which every test calls, also on
//! failure), the LFM2 mock (`vector_for`, the recorder's `vectorFor`), a manual clock, ids
//! `<seconds><counter>` (the recorder's), and a fault seam that logs every step.

use bson::{Bson, Document, doc, oid::ObjectId};
use dima_ai::embeddings::{self, Service};
use dima_ai::memory_store::{
    BoxFuture, ChannelNames, Config, FaultAction, Faults, IdSource, MemoryStore, Parts, Step,
};
use dima_core::ManualClock;
use dima_http::testing::{MockResponse, MockServer};
use dima_http::{HttpClient, Method, Path, Provider};
use dima_model::channel_ai_memories::INFO;
use dima_store::mongo::{MongoConfig, MongoStore};
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

pub const T0: i64 = 1_763_000_000_000;

/// The recorder's `vectorFor`.
pub fn vector_for(text: &str) -> Vec<f64> {
    if text.contains("EMPTYVEC") {
        return vec![];
    }
    let t = text.to_lowercase();
    let has = |w: &str| if t.contains(w) { 1.0 } else { 0.0 };
    let mut v = vec![has("tea"), has("game"), has("music"), 0.0];
    if v[0] + v[1] + v[2] == 0.0 {
        v[3] = 1.0;
    }
    v
}

#[derive(Default)]
pub struct Names(pub HashMap<String, String>);
impl ChannelNames for Names {
    fn channel_name<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move { self.0.get(id).cloned() })
    }
}

/// `<seconds><counter>`, the counter restarting at 1 per scenario.
#[derive(Default)]
pub struct SeqIds(pub AtomicU64);
impl IdSource for SeqIds {
    fn object_id(&self, now_ms: i64) -> ObjectId {
        let n = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        let mut bytes = [0_u8; 12];
        bytes[..4].copy_from_slice(&u32::try_from(now_ms / 1000).unwrap().to_be_bytes());
        bytes[4..].copy_from_slice(&n.to_be_bytes());
        ObjectId::from_bytes(bytes)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plan {
    /// Fail the next occurrence of the step.
    Fail,
    /// Never complete the next occurrence (a kill: the test drops the operation).
    Kill,
    /// Wait at the barrier (races).
    Barrier,
}

#[derive(Default)]
pub struct ScriptFaults {
    pub log: Mutex<Vec<Step>>,
    plans: Mutex<HashMap<Step, Plan>>,
    pub reached: Notify,
    pub barrier: Mutex<Option<Arc<tokio::sync::Barrier>>>,
}

impl ScriptFaults {
    pub fn plan(&self, step: Step, plan: Plan) {
        self.plans.lock().unwrap().insert(step, plan);
    }
    pub fn clear(&self) {
        self.plans.lock().unwrap().clear();
        self.log.lock().unwrap().clear();
    }
    pub fn steps(&self) -> Vec<Step> {
        self.log.lock().unwrap().clone()
    }
}

impl Faults for ScriptFaults {
    fn before(&self, step: Step) -> BoxFuture<'_, FaultAction> {
        self.log.lock().unwrap().push(step);
        let plan = self.plans.lock().unwrap().remove(&step);
        Box::pin(async move {
            match plan {
                None => FaultAction::Proceed,
                Some(Plan::Fail) => FaultAction::Fail,
                Some(Plan::Kill) => {
                    self.reached.notify_one();
                    std::future::pending::<()>().await;
                    FaultAction::Fail
                }
                Some(Plan::Barrier) => {
                    let b = self.barrier.lock().unwrap().clone();
                    if let Some(b) = b {
                        b.wait().await;
                    }
                    FaultAction::Proceed
                }
            }
        })
    }
}

pub struct Env {
    pub store: Arc<MemoryStore>,
    pub mongo: MongoStore,
    pub name: String,
    pub http: HttpClient,
    pub qdrant: Provider,
    pub embed: MockServer,
    pub clock: ManualClock,
    pub ids: Arc<SeqIds>,
    pub faults: Arc<ScriptFaults>,
}

pub fn required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() == Ok("1")
}

pub fn qdrant_provider() -> anyhow::Result<Option<Provider>> {
    let Ok(url) = std::env::var("DIMA_TEST_QDRANT_URL") else {
        return Ok(None);
    };
    let mut config = dima_ai::qdrant::Config::new(url);
    config.api_key = std::env::var("DIMA_TEST_QDRANT_API_KEY")
        .ok()
        .map(dima_core::SecretString::new);
    Ok(Some(config.provider()?))
}

pub fn test_config() -> Config {
    Config {
        // Generous: the laptop is busy during the gate.
        store_timeout: Duration::from_secs(60),
        embedding_timeout: Duration::from_secs(60),
        qdrant_timeout: Duration::from_secs(60),
        repair_batch: 3,
        ..Config::default()
    }
}

impl Env {
    /// `None` when the stores are absent and not required.
    pub async fn new(names: HashMap<String, String>) -> anyhow::Result<Option<Self>> {
        let name = format!("dima_test_ai_{}", uuid::Uuid::new_v4().simple());
        Self::open(names, name, true).await
    }

    /// An environment over existing scratch stores (a race child process).
    pub async fn open(
        names: HashMap<String, String>,
        name: String,
        create: bool,
    ) -> anyhow::Result<Option<Self>> {
        let (Ok(uri), Some(qdrant)) = (std::env::var("DIMA_TEST_MONGO_URI"), qdrant_provider()?)
        else {
            anyhow::ensure!(!required(), "MongoDB and Qdrant are required");
            return Ok(None);
        };
        let mut config = MongoConfig::new(uri);
        config.database = Some(name.clone());
        let mongo = MongoStore::connect(&config, None).await?;
        let http = HttpClient::builder().build()?;
        let embed = MockServer::start().await?;
        embed.fallback(|request| {
            let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
            let v = vector_for(body["input"].as_str().unwrap_or(""));
            MockResponse::json(
                200,
                &json!({"object":"list","data":[{"object":"embedding","index":0,"embedding":v}],
                    "model":body["model"],"usage":{"prompt_tokens":1,"total_tokens":1}})
                .to_string(),
            )
        });
        let provider = embed.provider(embeddings::Config::lfm2().builder(Service::Lfm2))?;
        let embeddings = Arc::new(embeddings::Client {
            http: http.clone(),
            provider,
            service: Service::Lfm2,
        });
        let clock = ManualClock::new(T0);
        let ids = Arc::new(SeqIds::default());
        let faults = Arc::new(ScriptFaults::default());
        let store = Arc::new(MemoryStore::new(Parts {
            mongo: mongo.clone(),
            qdrant_http: http.clone(),
            qdrant_provider: Some(qdrant.clone()),
            qdrant_collection: name.clone(),
            embeddings,
            channel_names: Arc::new(Names(names)),
            clock: Arc::new(clock.clone()),
            ids: ids.clone(),
            config: test_config(),
            observer: None,
            faults: Some(faults.clone()),
        }));
        let env = Self {
            store,
            mongo,
            name,
            http,
            qdrant,
            embed,
            clock,
            ids,
            faults,
        };
        if create {
            let policy = dima_model::startup_policy(&INFO).unwrap();
            let report =
                dima_model::ensure_indexes(&env.mongo, &INFO, policy, Duration::from_secs(60))
                    .await;
            report.require()?;
            env.reset_qdrant().await?;
        }
        Ok(Some(env))
    }

    pub async fn qdrant_call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<Value> {
        let (path, wait) = match path.strip_suffix("?wait=true") {
            Some(p) => (p, true),
            None => (path, false),
        };
        let template = format!("/collections/{{}}{path}");
        let path = Path::template(Box::leak(template.into_boxed_str()), &[&self.name])?;
        let mut request = self.http.request(&self.qdrant, method, path);
        if wait {
            request = request.query(&[("wait", "true")]);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        Ok(request.send_json::<Value>().await?["result"].clone())
    }

    pub async fn reset_qdrant(&self) -> anyhow::Result<()> {
        let _ = self.qdrant_call(Method::DELETE, "", None).await;
        self.qdrant_call(
            Method::PUT,
            "",
            Some(json!({"vectors":{"size":4,"distance":"Cosine"}})),
        )
        .await?;
        for (field, schema) in [
            ("memory_id", "keyword"),
            ("channel_id", "keyword"),
            ("memory_type", "keyword"),
            ("status", "keyword"),
            ("risk", "keyword"),
            ("confidence", "float"),
            ("subject_scope", "keyword"),
            ("subject_username", "keyword"),
            ("subject_user_id", "keyword"),
            ("updated_at", "integer"),
        ] {
            self.qdrant_call(
                Method::PUT,
                "/index?wait=true",
                Some(json!({"field_name":field,"field_schema":schema})),
            )
            .await?;
        }
        Ok(())
    }

    pub async fn reset(&self) -> anyhow::Result<()> {
        for c in ["channelaimemories", "channelaipersonalities"] {
            self.mongo.documents(c).delete_many(doc! {}).await?;
        }
        self.reset_qdrant().await?;
        self.ids.0.store(0, Ordering::SeqCst);
        self.faults.clear();
        self.clock.set(T0);
        Ok(())
    }

    /// Every memory document, by `_id`.
    pub async fn documents(&self) -> anyhow::Result<Vec<Document>> {
        let cursor = self
            .mongo
            .documents(INFO.name)
            .find(doc! {})
            .sort(doc! {"_id": 1})
            .await?;
        Ok(cursor.try_collect().await?)
    }

    /// Every point (id, payload, vector), by id.
    pub async fn points(&self) -> anyhow::Result<Vec<Value>> {
        let result = self
            .qdrant_call(
                Method::POST,
                "/points/scroll",
                Some(json!({"limit":1000,"with_payload":true,"with_vector":true})),
            )
            .await?;
        let mut points = result["points"].as_array().cloned().unwrap_or_default();
        points.sort_by_key(|p| p["id"].as_u64());
        Ok(points)
    }

    /// Embedding request bodies since the mock started.
    pub fn embeddings(&self) -> Vec<Value> {
        self.embed
            .requests()
            .iter()
            .map(|r| serde_json::from_slice(&r.body).unwrap_or(Value::Null))
            .collect()
    }

    pub async fn insert_ejson(&self, collection: &str, value: &Value) -> anyhow::Result<()> {
        let Bson::Document(document) = Bson::try_from(value.clone())? else {
            anyhow::bail!("not a document");
        };
        self.mongo
            .documents(collection)
            .insert_one(document)
            .await?;
        Ok(())
    }

    /// Drops the database and the collection.
    pub async fn cleanup(&self) {
        let _ = self.mongo.database().drop().await;
        let _ = self.qdrant_call(Method::DELETE, "", None).await;
    }
}

/// Runs `body` with a fresh environment and always cleans up, a panic included (the body runs
/// in its own task; its panic is turned into an error after the cleanup).
pub async fn with_env<F, Fut>(names: &[(&str, &str)], body: F) -> anyhow::Result<()>
where
    F: FnOnce(Arc<Env>) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>> + Send + 'static,
{
    let names = names
        .iter()
        .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
        .collect();
    let Some(env) = Env::new(names).await? else {
        return Ok(());
    };
    let env = Arc::new(env);
    let result = tokio::spawn(body(env.clone())).await;
    env.cleanup().await;
    result.map_err(|e| anyhow::anyhow!("test body panicked: {e}"))?
}
