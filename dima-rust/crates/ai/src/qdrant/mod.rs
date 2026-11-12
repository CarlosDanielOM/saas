//! REST Qdrant operations for the frozen TypeScript backend.
//!
//! Stored identities use MD5 of `namespace:entity:JavaScript-number-text`, first
//! four bytes big endian. No normalization or truncation occurs before hashing.
//! Chat's minimum length uses scalar values instead of UTF-16: existing emoji
//! messages shorter than three scalars can now be excluded from context, without
//! changing stored data or identities. Passive word matching already used Unicode
//! regex characters in JS and is unchanged. Empty-message checks are unchanged.
//!
//! Embeddings and detected language are caller inputs; no model is called here.
//! The batch wrapper's bounded queue belongs to the future embedding package. Callers may
//! use `store_chat_message_embedding` on its resulting vectors. No environment is read.
//! `None` configuration produces typed empty failures and an observer event.
//! Tests accept `DIMA_TEST_QDRANT_API_KEY` for local stores that enable auth;
//! `tools/test-env` supplies the URL and required-store gate. No key is recorded.
//! No waits or polling are introduced in the library. SDK constructor's advisory
//! version probe is omitted; transport headers (user-agent, compression and
//! fetch metadata) use the shared Rust stack rather than impersonating Node.
//! The functional getCollections readiness call remains.
//! Embedding timings, language detection and application metrics belong to callers.
//! All required shared helpers were available; no compatibility shim is needed.
//! The observer must connect to application logging; the default is silent.
//!
//! Requests have the SDK's 300s deadline, no retries, and bounded 8 MiB bodies.
//! Existing collections are skipped, including missing indexes. Text indexes use
//! the default tokenizer: the SDK drops the reference's sibling `tokenizer` field.
//! Startup retains the reference's successful outer result for individual errors.
//! Memory candidates require MongoDB policy validation by their caller before use.
//! Quirks retained: 32-bit chat ID collisions overwrite; deletion without a memory
//! ID skips ownership verification; read-before-write collision checks are not
//! atomic and cannot prevent a concurrent collision race; startup returns 200 for creation, not 201.
mod pure;
mod schema;
mod types;
use dima_http::{HttpClient, Method, Path, Provider};
pub use pure::*;
pub use schema::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
pub use types::*;

/// Startup-owned configuration; API key optional for local unauthenticated stores.
pub struct Config {
    pub base_url: String,
    pub api_key: Option<dima_core::SecretString>,
    pub timeout: Duration,
}
impl Config {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            api_key: None,
            timeout: Duration::from_secs(300),
        }
    }
    pub fn provider(&self) -> Result<Provider, dima_http::ConfigError> {
        let mut p = Provider::builder("qdrant", &self.base_url)
            .internal(true)
            .timeout(self.timeout)
            .headers_timeout(self.timeout)
            .idle_timeout(self.timeout);
        if let Some(key) = &self.api_key {
            p = p.secret_header("api-key", key);
        }
        p.build()
    }
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Qdrant is not configured")]
    NotConfigured,
    #[error(transparent)]
    Http(#[from] dima_http::Error),
    #[error(transparent)]
    Path(#[from] dima_http::PathError),
    #[error("Malformed Qdrant result")]
    Malformed,
}
pub trait Observer: Send + Sync {
    fn error(&self, operation: &str);
}
struct Silent;
impl Observer for Silent {
    fn error(&self, _: &str) {}
}
pub struct Client {
    http: HttpClient,
    provider: Option<Provider>,
    ready: tokio::sync::OnceCell<()>,
    observer: Arc<dyn Observer>,
    pub chat_collection: String,
    pub memory_collection: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct OperationResult {
    pub error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
impl OperationResult {
    fn success() -> Self {
        Self {
            error: false,
            message: None,
        }
    }
    fn failure(s: &str) -> Self {
        Self {
            error: true,
            message: Some(s.into()),
        }
    }
}
#[derive(Debug)]
pub struct CollectionResult {
    pub error: bool,
    pub status: u16,
    pub message: String,
}
#[derive(Debug)]
pub struct StartupResult {
    pub error: bool,
    pub status: u16,
    pub data: Vec<CollectionResult>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ChatMessageData {
    pub channel_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    pub username: String,
    pub user_id: String,
    pub message: String,
    pub timestamp: f64,
    pub language: String,
}
impl Client {
    pub fn new(http: HttpClient, provider: Option<Provider>) -> Self {
        Self {
            http,
            provider,
            ready: tokio::sync::OnceCell::new(),
            observer: Arc::new(Silent),
            chat_collection: "twitch_chat_logs".into(),
            memory_collection: "twitch_channel_memories".into(),
        }
    }
    pub fn with_observer(mut self, observer: Arc<dyn Observer>) -> Self {
        self.observer = observer;
        self
    }
    async fn ensure_ready(&self) -> Result<(), Error> {
        self.ready
            .get_or_try_init(|| async {
                self.get_collections().await?;
                Ok::<(), Error>(())
            })
            .await?;
        Ok(())
    }
    async fn call(
        &self,
        method: Method,
        path: Path,
        body: Option<&Value>,
        wait: Option<bool>,
    ) -> Result<Value, Error> {
        let provider = self.provider.as_ref().ok_or(Error::NotConfigured)?;
        let mut request = self.http.request(provider, method, path).header(
            "accept",
            if body.is_some() {
                "application/json"
            } else {
                "*/*"
            },
        );
        if let Some(wait) = wait {
            request = request.query(&[("wait", if wait { "true" } else { "false" })]);
        }
        if let Some(body) = body {
            request = request.json_js(body);
        }
        let v: Value = request.send_json().await?;
        v.get("result")
            .filter(|v| !v.is_null())
            .cloned()
            .ok_or(Error::Malformed)
    }
    fn path(template: &'static str, c: &str) -> Result<Path, Error> {
        Ok(Path::template(template, &[c])?)
    }
    pub async fn get_collections(&self) -> Result<Value, Error> {
        let result = self
            .call(Method::GET, "/collections".into(), None, None)
            .await?;
        if !result["collections"].is_array() {
            return Err(Error::Malformed);
        }
        Ok(result)
    }
    pub async fn create_collection(&self, s: &CollectionSchema) -> CollectionResult {
        let result = async {
            self.ensure_ready().await?;
            let exists = self
                .call(
                    Method::GET,
                    Self::path("/collections/{}/exists", &s.collection_name)?,
                    None,
                    None,
                )
                .await?;
            if exists["exists"].as_bool().ok_or(Error::Malformed)? {
                return Ok(false);
            }
            self.call(
                Method::PUT,
                Self::path("/collections/{}", &s.collection_name)?,
                Some(&json!({"vectors":s.vectors,"quantization_config":s.quantization_config})),
                None,
            )
            .await?;
            for i in &s.payload_indexes {
                self.call(
                    Method::PUT,
                    Self::path("/collections/{}/index", &s.collection_name)?,
                    Some(&json!({"field_name":i.field_name,"field_schema":i.field_schema})),
                    None,
                )
                .await?;
            }
            Ok::<_, Error>(true)
        }
        .await;
        match result {
            Ok(true) => CollectionResult {
                error: false,
                status: 200,
                message: format!("Collection {} created", s.collection_name),
            },
            Ok(false) => CollectionResult {
                error: true,
                status: 409,
                message: format!("Collection {} already exists", s.collection_name),
            },
            Err(_) => {
                self.observer.error("createQdrantCollection");
                CollectionResult {
                    error: true,
                    status: 500,
                    message: format!("Error creating Qdrant collection {}", s.collection_name),
                }
            }
        }
    }
    pub async fn startup(&self) -> StartupResult {
        if self.ensure_ready().await.is_err() {
            self.observer.error("QdrantStartUp");
            return StartupResult {
                error: true,
                status: 500,
                data: vec![],
            };
        }
        let mut data = vec![];
        for s in [
            twitch_chat_logs_collection(),
            twitch_channel_memories_collection(),
        ] {
            data.push(self.create_collection(&s).await);
        }
        StartupResult {
            error: false,
            status: 200,
            data,
        }
    }
    async fn upsert(
        &self,
        c: &str,
        id: f64,
        vector: &[f64],
        payload: Value,
        wait: bool,
    ) -> Result<(), Error> {
        self.ensure_ready().await?;
        self.call(
            Method::PUT,
            Self::path("/collections/{}/points", c)?,
            Some(&json!({"points":[{"id":id,"vector":vector,"payload":payload}]})),
            Some(wait),
        )
        .await?;
        Ok(())
    }
    pub async fn store_chat_message_embedding(
        &self,
        d: &ChatMessageData,
        vector: &[f64],
    ) -> OperationResult {
        if dima_text::trim(&d.message).is_empty() {
            return OperationResult::failure("Message is empty");
        }
        let id = generate_qdrant_point_id(&d.channel_id, &d.user_id, d.timestamp);
        let Ok(payload) = serde_json::to_value(d) else {
            return OperationResult::failure("Failed to store chat message embedding");
        };
        self.outcome(
            self.upsert(&self.chat_collection, f64::from(id), vector, payload, false)
                .await,
            "storeChatMessageEmbedding",
            "Failed to store chat message embedding",
        )
    }
    fn outcome(&self, r: Result<(), Error>, op: &str, msg: &str) -> OperationResult {
        if r.is_ok() {
            OperationResult::success()
        } else {
            self.observer.error(op);
            OperationResult::failure(msg)
        }
    }
    async fn payload(&self, id: f64) -> Result<Option<Value>, Error> {
        self.ensure_ready().await?;
        let v = self
            .call(
                Method::POST,
                Self::path("/collections/{}/points", &self.memory_collection)?,
                Some(&json!({"ids":[id],"with_payload":true,"with_vector":false})),
                None,
            )
            .await?;
        let points = v.as_array().ok_or(Error::Malformed)?;
        Ok(points
            .first()
            .map(|p| p.get("payload").cloned().unwrap_or(json!({}))))
    }
    pub async fn upsert_channel_memory_embedding(
        &self,
        p: &UpsertChannelMemoryParams,
        vector: &[f64],
    ) -> OperationResult {
        if !valid_id(p.qdrant_point_id) || p.memory_id.is_empty() || p.channel_id.is_empty() {
            return OperationResult::failure(
                "Missing or invalid qdrantPointID, memoryId, or channelID",
            );
        }
        let result=async {
   if let Some(payload)=self.payload(p.qdrant_point_id).await? && !qdrant_point_belongs_to_memory(Some(&payload),&p.memory_id,&p.channel_id) {return Ok(OperationResult::failure("Qdrant point ID collision detected; refusing to overwrite another memory"));}
   if build_memory_embedding_input(&p.summary,&p.content).is_empty() {return Ok(OperationResult::failure("Memory content is empty"));}
   let mut payload=json!({"memory_id":p.memory_id,"channel_id":p.channel_id,"subject_username":p.subject_username.as_deref().unwrap_or(""),"subject_user_id":p.subject_user_id.as_deref().unwrap_or(""),"content":p.content,"summary":p.summary});
   for (key, value) in [
       ("memory_type", p.memory_type.as_ref().map(|v| json!(v))),
       ("status", p.status.as_ref().map(|v| json!(v))),
       ("risk", p.risk.as_ref().map(|v| json!(v))),
       ("confidence", p.confidence.map(|v| json!(v))),
       ("subject_scope", p.subject_scope.as_ref().map(|v| json!(v))),
       ("created_at", p.created_at_unix.map(|v| json!(v))),
       ("updated_at", p.updated_at_unix.map(|v| json!(v))),
   ] {
       // Missing values are omitted; supplied nonfinite numbers serialize as null, as JS does.
       if let Some(value) = value { payload[key] = value; }
   }
   self.upsert(&self.memory_collection,p.qdrant_point_id,vector,payload,true).await?;Ok::<_,Error>(OperationResult::success())
  }.await;
        result.unwrap_or_else(|_| {
            self.observer.error("upsertChannelMemoryEmbedding");
            OperationResult::failure("Failed to upsert channel memory embedding")
        })
    }
    pub async fn delete_channel_memory_embedding(
        &self,
        id: f64,
        channel: &str,
        memory: Option<&str>,
    ) -> OperationResult {
        if !valid_id(id) {
            return OperationResult::failure("Missing or invalid qdrantPointID");
        }
        let result = async {
            let Some(payload) = self.payload(id).await? else {
                return Ok(OperationResult::success());
            };
            if let Some(m) = memory.filter(|m| !m.is_empty())
                && !qdrant_point_belongs_to_memory(Some(&payload), m, channel)
            {
                return Ok(OperationResult::failure(
                    "Qdrant point ID collision detected; refusing to delete another memory",
                ));
            }
            self.delete(json!({"points":[id]})).await?;
            Ok::<_, Error>(OperationResult::success())
        }
        .await;
        result.unwrap_or_else(|_| {
            self.observer.error("deleteChannelMemoryEmbedding");
            OperationResult::failure("Failed to delete channel memory embedding")
        })
    }
    async fn delete(&self, body: Value) -> Result<(), Error> {
        self.ensure_ready().await?;
        self.call(
            Method::POST,
            Self::path("/collections/{}/points/delete", &self.memory_collection)?,
            Some(&body),
            Some(true),
        )
        .await?;
        Ok(())
    }
    pub async fn delete_channel_memory_embeddings_by_channel(
        &self,
        channel: &str,
    ) -> OperationResult {
        if channel.is_empty() {
            return OperationResult::failure("Missing channelID");
        }
        self.outcome(
            self.delete(json!({"filter":channel_filter(channel)})).await,
            "deleteChannelMemoryEmbeddingsByChannel",
            "Failed to delete channel memory embeddings",
        )
    }
    pub async fn retrieve_channel_chat_window(&self, p: &ChatWindowParams) -> ChatWindowResult {
        let channel = dima_text::trim(&p.channel_id);
        let from = normalized(p.from_unix);
        let to = normalized(p.to_unix);
        let limit = normalized(p.limit).clamp(1.0, 1440.0) as usize;
        if channel.is_empty() || from <= 0.0 || to <= 0.0 || from > to {
            return ChatWindowResult {
                error: true,
                message: Some("Invalid chat window parameters".into()),
                items: vec![],
            };
        }
        let result=async {
   self.ensure_ready().await?;let mut points=vec![];let mut offset=None;
   for _ in 0..12 { if points.len()>=limit{break;}
    let mut body=json!({"filter":{"must":[{"key":"channel_id","match":{"value":channel}},{"key":"timestamp","range":{"gte":from,"lte":to}}]},"with_payload":true,"with_vector":false,"limit":120.min(limit-points.len())});
    if let Some(o)=offset {body["offset"]=o;}
    let v=self.call(Method::POST,Self::path("/collections/{}/points/scroll",&self.chat_collection)?,Some(&body),None).await?;
    points.extend(v["points"].as_array().ok_or(Error::Malformed)?.iter().cloned());
    offset=v.get("next_page_offset").filter(|v|pure::truthy(*v)).cloned();if offset.is_none(){break;}
   }
   let mut items:Vec<_>=points.iter().filter_map(parse_chat_window_point).filter(|i|i.channel_id==channel&&i.timestamp>=from&&i.timestamp<=to).collect();items.sort_by(|a,b|a.timestamp.total_cmp(&b.timestamp));items.truncate(limit);Ok::<_,Error>(items)
  }.await;
        match result {
            Ok(items) => ChatWindowResult {
                error: false,
                message: None,
                items,
            },
            Err(_) => {
                self.observer.error("retrieveChannelChatWindow");
                ChatWindowResult {
                    error: true,
                    message: Some("Failed to retrieve chat window context".into()),
                    items: vec![],
                }
            }
        }
    }
    async fn query(
        &self,
        c: &str,
        vector: &[f64],
        filter: Value,
        limit: usize,
        threshold: f64,
    ) -> Result<Vec<Value>, Error> {
        self.ensure_ready().await?;
        let v=self.call(Method::POST,Self::path("/collections/{}/points/query",c)?,Some(&json!({"query":vector,"limit":limit,"with_payload":true,"filter":filter,"score_threshold":threshold})),None).await?;
        if !v.is_object() && !v.is_array() {
            return Err(Error::Malformed);
        }
        Ok(normalize_qdrant_points(&v))
    }
    pub async fn retrieve_semantic_chat_context(
        &self,
        p: &SemanticChatContextParams,
        vector: &[f64],
    ) -> SemanticChatContextResult {
        if p.channel_id.is_empty() || p.query.is_empty() || p.limit == 0 {
            return SemanticChatContextResult::failure("Missing required parameters");
        }
        let mut result = SemanticChatContextResult {
            error: false,
            message: None,
            items: vec![],
            selected_pass: SemanticPass::None,
            pass_results: vec![],
        };
        for (pass, threshold) in [
            (SemanticPass::High, p.primary_min_score.unwrap_or(0.75)),
            (SemanticPass::Fallback, p.fallback_min_score.unwrap_or(0.69)),
        ] {
            let Ok(points) = self
                .query(
                    &self.chat_collection,
                    vector,
                    channel_filter(&p.channel_id),
                    p.limit.saturating_mul(3),
                    threshold,
                )
                .await
            else {
                self.observer.error("retrieveSemanticChatContext");
                return SemanticChatContextResult::failure("Failed to retrieve semantic memory");
            };
            result.items = select_semantic_chat_items(&p.channel_id, &points, threshold, p.limit);
            result.pass_results.push(SemanticPassResult {
                pass,
                threshold,
                raw_matches: points.len(),
                kept_matches: result.items.len(),
            });
            if !result.items.is_empty() {
                result.selected_pass = pass;
                break;
            }
        }
        result
    }
    pub async fn retrieve_channel_memory_context(
        &self,
        p: &RetrieveMemoryContextParams,
        vector: &[f64],
    ) -> RetrieveMemoryContextResult {
        if p.channel_id.is_empty() || p.query.is_empty() || p.limit == 0 {
            return RetrieveMemoryContextResult::failure("Missing required parameters");
        }
        let threshold = p
            .min_score
            .unwrap_or(if p.mode == MemoryRetrievalMode::Explicit {
                0.55
            } else {
                0.45
            });
        let mut filter = channel_filter(&p.channel_id);
        if let Some(must) = filter["must"].as_array_mut() {
            must.push(json!({"key":"status","match":{"value":"confirmed"}}));
            if p.subject_scope == MemorySubjectScope::Channel {
                must.push(json!({"key":"subject_scope","match":{"value":"channel"}}));
            }
        }
        let Ok(points) = self
            .query(
                &self.memory_collection,
                vector,
                filter,
                p.limit.saturating_mul(8),
                threshold,
            )
            .await
        else {
            self.observer.error("retrieveChannelMemoryContext");
            return RetrieveMemoryContextResult::failure(
                "Failed to retrieve channel memory context",
            );
        };
        let mut items: Vec<_> = points
            .iter()
            .filter_map(parse_memory_point)
            .filter(|i| {
                i.channel_id == p.channel_id && i.status == "confirmed" && i.score >= threshold
            })
            .filter(|i| {
                p.mode == MemoryRetrievalMode::Explicit
                    || p.min_score.is_some()
                    || is_passive_memory_relevant(
                        &p.query,
                        &format!(
                            "{} {}",
                            i.summary,
                            i.subject_username.as_deref().unwrap_or("")
                        ),
                        i.score,
                    )
            })
            .collect();
        items.sort_by(|a, b| {
            pure::descending(a.score, b.score)
                .then_with(|| pure::descending(a.updated_at, b.updated_at))
        });
        items.truncate(p.limit);
        RetrieveMemoryContextResult {
            error: false,
            message: None,
            items,
        }
    }
}
fn valid_id(n: f64) -> bool {
    n.is_finite() && n >= 0.0 && n.fract() == 0.0
}
fn normalized(n: f64) -> f64 {
    if n.is_finite() { n.floor() } else { 0.0 }
}
fn channel_filter(channel: &str) -> Value {
    json!({"must":[{"key":"channel_id","match":{"value":channel}}]})
}

#[cfg(test)]
#[path = "../../tests/wire.inc"]
mod wire;

/// Reference's fire-and-forget queue wrapper; empty messages and queue errors
/// never fail message handling. The caller owns queue capacity and scheduling.
pub fn store_chat_message_embedding_batched(
    queue: &dyn ChatEmbeddingQueue,
    observer: &dyn Observer,
    message: QueuedChatMessage,
) {
    if !dima_text::trim(&message.text).is_empty() && !queue.add_message(message) {
        observer.error("storeChatMessageEmbeddingBatched");
    }
}
