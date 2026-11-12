#![allow(dead_code, clippy::unwrap_used)]
use anyhow::{Context, Result, ensure};
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_core::{ManualClock, Random, RandomError, SecretString, Shutdown, SystemRandom};
use dima_events::{
    jobs::{DragonflyQueue, DurableJobs, JobQueue, JobsConfig},
    store::StoreError,
};
use dima_http::{
    HttpClient,
    testing::{MockResponse, MockServer},
};
use dima_model::CollectionInfo;
use dima_store::{
    dragonfly::{Dragonfly, QueueItem, SetOptions},
    mongo::MongoStore,
};
use dima_stream::{
    clip_recommendations_queue::{QueueConfig, QueueProducer},
    site_analytics::{Config as SiteConfig, SiteAnalytics},
    stream_session_tick::{Config, StreamSessionTick},
};
use dima_twitch::{KeySpace, Twitch, TwitchConfig, TwitchDeps};
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};
pub const NOW: i64 = 1794355200000;
pub const INFOS: [&CollectionInfo; 3] = [
    &dima_model::stream_sessions::INFO,
    &dima_model::stream_viewer_snapshots::INFO,
    &dima_model::cron_job_intents::INFO,
];
#[derive(Debug, Default)]
pub struct Counting(pub AtomicU8);
impl Random for Counting {
    fn fill(&self, b: &mut [u8]) -> Result<(), RandomError> {
        b.fill(self.0.fetch_add(1, Ordering::SeqCst) + 1);
        Ok(())
    }
}
pub struct Prefixed {
    inner: DragonflyQueue,
    prefix: String,
}
impl JobQueue for Prefixed {
    async fn publish(
        &self,
        key: &str,
        automatic: Option<&str>,
        payload: &QueueItem,
    ) -> Result<bool, StoreError> {
        self.inner
            .publish(
                &format!("{}{key}", self.prefix),
                automatic.map(|s| format!("{}{s}", self.prefix)).as_deref(),
                payload,
            )
            .await
    }
    async fn marker_exists(&self, key: &str) -> Result<bool, StoreError> {
        self.inner
            .marker_exists(&format!("{}{key}", self.prefix))
            .await
    }
}
pub struct Contextual {
    pub store: MongoStore,
    pub cache: Dragonfly,
    pub prefix: String,
    pub clock: Arc<ManualClock>,
    pub random: Arc<Counting>,
    pub jobs: DurableJobs<Prefixed>,
}
pub fn recording() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "../stream-tick-reference.json"
    ))?)
}
pub fn document(v: &Value) -> Result<Document> {
    Ok(Bson::try_from(v.clone())?
        .as_document()
        .context("BSON document")?
        .clone())
}
pub fn hash(s: impl AsRef<[u8]>) -> String {
    dima_core::crypto::sha256(s)
        .hex()
        .get(..24)
        .unwrap()
        .to_owned()
}
impl Contextual {
    pub async fn new(store: MongoStore, cache: Dragonfly) -> Result<Self> {
        for info in INFOS {
            for i in info.indexes {
                store.documents(info.name).create_index(i.model()).await?;
            }
        }
        let info = &dima_model::cron_job_intents::INFO;
        let report = dima_model::ensure_indexes(
            &store,
            info,
            dima_model::startup_policy(info).context("policy")?,
            Duration::from_secs(60),
        )
        .await;
        let prefix = format!("{}:", store.database().name());
        let clock = Arc::new(ManualClock::new(NOW));
        let random = Arc::new(Counting::default());
        let jobs = DurableJobs::new(
            store.clone(),
            Prefixed {
                inner: DragonflyQueue {
                    dragonfly: cache.clone(),
                    deadline: Duration::from_secs(60),
                },
                prefix: prefix.clone(),
            },
            clock.clone(),
            random.clone(),
            JobsConfig {
                store_deadline: Duration::from_secs(60),
                ..Default::default()
            },
            &report,
        )?;
        Ok(Self {
            store,
            cache,
            prefix,
            clock,
            random,
            jobs,
        })
    }
    pub fn producer(&self) -> QueueProducer<'_, Prefixed> {
        QueueProducer {
            jobs: &self.jobs,
            clock: self.clock.as_ref(),
            random: self.random.as_ref(),
            config: QueueConfig::default(),
        }
    }
    pub fn tick(&self, timeout: bool) -> Result<StreamSessionTick> {
        Ok(StreamSessionTick::new(
            self.store.clone(),
            self.cache.clone(),
            self.clock.clone(),
            Arc::new(SystemRandom),
            Config {
                key_prefix: self.prefix.clone(),
                store_deadline: Duration::from_secs(60),
                tick_deadline: Duration::from_secs(1200),
                request_deadline: if timeout {
                    Duration::from_millis(500)
                } else {
                    Duration::from_secs(30)
                },
                max_channels: 1000,
                ..Default::default()
            },
        )?)
    }
    pub fn site(&self) -> SiteAnalytics {
        SiteAnalytics::new(
            self.cache.clone(),
            self.clock.clone(),
            SiteConfig {
                key_prefix: self.prefix.clone(),
                store_deadline: Duration::from_secs(60),
                ..Default::default()
            },
        )
    }
    pub fn twitch(&self, server: &MockServer) -> Result<Twitch> {
        self.twitch_at(&server.url())
    }
    pub fn twitch_at(&self, url: &str) -> Result<Twitch> {
        let registry = dima_http::ProviderRegistry::builder()
            .test_mode(dima_http::TestMode::RigMock {
                loopback_only: true,
            })
            .provider(dima_twitch::helix_provider("tick-client"))
            .base_url_override(dima_twitch::HELIX_PROVIDER, &format!("{url}/helix"))
            .provider(dima_twitch::oauth_provider())
            .base_url_override(dima_twitch::OAUTH_PROVIDER, &format!("{url}/oauth2"))
            .build()?;
        let mut cfg = TwitchConfig::new("tick-client", SecretString::from("tick-secret"));
        cfg.keys = KeySpace::prefixed(&self.prefix);
        Ok(Twitch::new(
            cfg,
            TwitchDeps {
                http: HttpClient::builder().build()?,
                exchange_http: dima_twitch::exchange_client(HttpClient::builder())?,
                helix: registry.get(dima_twitch::HELIX_PROVIDER)?.clone(),
                oauth: registry.get(dima_twitch::OAUTH_PROVIDER)?.clone(),
                mongo: self.store.clone(),
                dragonfly: self.cache.clone(),
                cipher: dima_core::crypto::CredentialCipher::new("tick-test-only")?,
                clock: self.clock.clone(),
                random: Arc::new(SystemRandom),
                events: Arc::new(dima_twitch::NoopEvents),
                shutdown: Shutdown::new(),
            },
        ))
    }
    pub async fn seed(
        &self,
        seed: &Value,
        board: &Value,
        ids: &Value,
        order: Option<&Value>,
    ) -> Result<()> {
        crate::support::cleanup(&self.cache, &self.prefix).await?;
        self.clock.set(NOW);
        self.random.0.store(0, Ordering::SeqCst);
        for info in INFOS {
            self.store.documents(info.name).delete_many(doc! {}).await?;
            let mut rows = seed[info.name].as_array().context("seed")?.clone();
            if info.name == "streamsessions"
                && let Some(order) = order.and_then(Value::as_array)
            {
                rows.sort_by_key(|r| {
                    order
                        .iter()
                        .position(|id| id == &r["channelID"])
                        .unwrap_or(usize::MAX)
                });
            }
            for row in rows {
                self.store
                    .documents(info.name)
                    .insert_one(document(&row)?)
                    .await?;
            }
        }
        let cipher = dima_core::crypto::CredentialCipher::new("tick-test-only")?;
        let sealed = cipher.encrypt("mock-token", &SystemRandom)?;
        self.cache
            .set(
                &format!("{}app:twitch:token", self.prefix),
                &serde_json::to_vec(&sealed)?,
                SetOptions::ex(3600),
            )
            .await?;
        if board.as_array().is_some_and(|v| !v.is_empty()) {
            self.cache
                .set(
                    &format!("{}site:analytics:live:channels", self.prefix),
                    dima_text::to_js_json(board).as_bytes(),
                    SetOptions::ex(600),
                )
                .await?;
        }
        if let Some(ids) = ids.as_array().filter(|v| !v.is_empty()) {
            let mut cmd = redis::cmd("SADD");
            cmd.arg(format!("{}streamers:by:id", self.prefix));
            for id in ids {
                cmd.arg(id.as_str().context("id")?);
            }
            self.cache.query::<i64>(&cmd).await?;
        }
        Ok(())
    }
    pub async fn snapshot(&self) -> Result<Value> {
        let rows: Vec<Document> = self
            .store
            .documents("streamsessions")
            .find(doc! {})
            .await?
            .try_collect()
            .await?;
        let maps = rows
            .iter()
            .map(|d| {
                Ok((
                    d.get_object_id("_id")?.to_hex(),
                    hash(format!(
                        "{}:{}",
                        d.get_str("channelID")?,
                        d.get_str("stream_id")?
                    )),
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        let mut documents = serde_json::Map::new();
        for info in INFOS {
            let rows: Vec<Document> = self
                .store
                .documents(info.name)
                .find(doc! {})
                .await?
                .try_collect()
                .await?;
            let mut ord = std::collections::HashMap::new();
            let mut values = Vec::new();
            for mut d in rows {
                (info.decode)(&bson::RawDocumentBuf::try_from(&d)?)?;
                if info.name == "cron_job_intents" {
                    d.insert("_id", ObjectId::from_bytes([0; 12]));
                }
                if info.name == "streamviewersnapshots" {
                    let sid = d.get_object_id("session_id")?.to_hex();
                    let logical = maps
                        .iter()
                        .find(|(old, _)| old == &sid)
                        .context("session")?
                        .1
                        .clone();
                    let key = format!(
                        "{logical}:{}",
                        d.get_datetime("captured_at")?.timestamp_millis()
                    );
                    let count = ord.entry(key.clone()).or_insert(0);
                    d.insert(
                        "_id",
                        ObjectId::parse_str(hash(format!("{key}:{}", *count)))?,
                    );
                    *count += 1;
                }
                let mut v = Bson::Document(d);
                replace(&mut v, &maps);
                values.push(v.into_canonical_extjson());
            }
            values.sort_by_key(|v| v["_id"].to_string());
            documents.insert(info.name.into(), json!(values));
        }
        let mut keys = Vec::new();
        let mut scan = self.cache.scan(&format!("{}*", self.prefix), Some(100));
        while let Some(page) = scan.next_page().await? {
            keys.extend(page);
        }
        keys.sort();
        let mut state = Vec::new();
        for key in keys {
            let key = String::from_utf8(key)?;
            let short = key.strip_prefix(&self.prefix).context("prefix")?;
            if short.starts_with("stream:analytics:tick:") {
                continue;
            }
            let kind: String = self.cache.query(redis::cmd("TYPE").arg(&key)).await?;
            let ttl: i64 = self.cache.query(redis::cmd("TTL").arg(&key)).await?;
            let value = if kind == "set" {
                let mut values: Vec<String> =
                    self.cache.query(redis::cmd("SMEMBERS").arg(&key)).await?;
                values.sort();
                json!(values)
            } else if kind == "list" {
                let rows: Vec<String> = self
                    .cache
                    .query(redis::cmd("LRANGE").arg(&key).arg(0).arg(-1))
                    .await?;
                json!(
                    rows.into_iter()
                        .map(|s| serde_json::from_str::<Value>(&s))
                        .collect::<Result<Vec<_>, _>>()?
                )
            } else {
                let value = self.cache.get(&key).await?.context("cache value")?;
                if short == "app:twitch:token" {
                    ensure!(value != b"mock-token", "app token must be sealed");
                    let sealed = serde_json::from_slice(&value)?;
                    json!(
                        dima_core::crypto::CredentialCipher::new("tick-test-only")?
                            .decrypt(&sealed)?
                            .context("plaintext")?
                    )
                } else if short == "site:analytics:live:channels" {
                    serde_json::from_slice(&value)?
                } else {
                    json!(String::from_utf8(value)?)
                }
            };
            state.push(json!({"key":short,"type":kind,"ttl":ttl,"value":value}));
        }
        Ok(json!({"documents":documents,"cache":state}))
    }
    pub async fn assert_finished(&self) -> Result<()> {
        ensure!(
            !self
                .cache
                .exists(&[&format!("{}stream:analytics:tick:lock", self.prefix)])
                .await?
                .gt(&0),
            "lease leaked"
        );
        let fields = self
            .cache
            .hgetall(&format!("{}stream:analytics:tick:state", self.prefix))
            .await?;
        ensure!(
            fields
                .iter()
                .all(|(k, _)| ["done", "cleanup"].contains(&k.as_str())),
            "unfinished journal {fields:?}"
        );
        Ok(())
    }
}
fn replace(v: &mut Bson, maps: &[(String, String)]) {
    match v {
        Bson::ObjectId(id) => {
            if let Some((_, new)) = maps.iter().find(|(old, _)| old == &id.to_hex()) {
                *id = ObjectId::parse_str(new).unwrap();
            }
        }
        Bson::String(s) => {
            for (old, new) in maps {
                *s = s.replace(old, new)
            }
        }
        Bson::Document(d) => {
            for (_, v) in d.iter_mut() {
                replace(v, maps)
            }
        }
        Bson::Array(a) => {
            for v in a {
                replace(v, maps)
            }
        }
        _ => {}
    }
}
pub fn responses(server: &MockServer, values: &[Value]) {
    for v in values {
        let status = v["status"].as_u64().unwrap_or(200) as u16;
        let body = if let Some(s) = v["body"].as_str() {
            s.to_owned()
        } else {
            v["body"].to_string()
        };
        let response = MockResponse::json(status, &body);
        server.push(if v["timeout"] == true {
            response.stall_after_headers()
        } else {
            response
        });
    }
}
pub fn requests(server: &MockServer) -> Value {
    json!(
        server
            .requests()
            .iter()
            .map(|r| json!({"method":r.method,"target":r.target}))
            .collect::<Vec<_>>()
    )
}
pub fn cache_equal(actual: &Value, expected: &Value) -> Result<()> {
    let mut a = actual.clone();
    let mut e = expected.clone();
    ensure!(
        a.as_array().context("cache")?.len() == e.as_array().context("cache")?.len(),
        "cache key count {a} != {e}"
    );
    for (a, e) in a
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(e.as_array_mut().unwrap())
    {
        let at = a["ttl"].as_i64().context("ttl")?;
        let et = e["ttl"].as_i64().context("ttl")?;
        ensure!((at > 0 && et > 0) || at == et, "TTL class {a} != {e}");
        a["ttl"] = Value::Null;
        e["ttl"] = Value::Null;
    }
    ensure!(
        dima_text::to_js_json(&a) == dima_text::to_js_json(&e),
        "cache {a} != {e}"
    );
    Ok(())
}
