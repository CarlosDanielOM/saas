//! Source-compatible vector memory candidates and synchronization. Ranking is
//! score descending with updated_at descending only for equal scores. There is
//! no time decay and no memory deduplication in the source. Passive weak matches
//! additionally require distinctive lexical overlap; explicit mode or a caller
//! threshold bypasses that lexical gate.
//!
//! Qdrant candidates are not authoritative memory records. The TypeScript AI
//! caller subsequently validates them through MongoDB `memory_policy` (channel,
//! confirmed status, expiry, sensitive/user/joke permissions). That unported
//! service remains the caller's responsibility before using these candidates;
//! it is not replaced with stale Qdrant payload policy checks.

use super::OperationResult;
use super::backend::{execute_done, execute_points};
use super::parity::descending;
use super::*;
use ::qdrant_client::qdrant::r#match::MatchValue;
use ::qdrant_client::{Payload, qdrant::*};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RetrievedMemoryItem {
    pub score: f64,
    pub qdrant_point_id: String,
    pub memory_id: String,
    pub channel_id: String,
    pub memory_type: String,
    pub status: String,
    pub risk: String,
    pub confidence: f64,
    pub subject_scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject_username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject_user_id: Option<String>,
    pub content: String,
    pub summary: String,
    pub updated_at: f64,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum MemoryRetrievalMode {
    #[default]
    Passive,
    Explicit,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum MemorySubjectScope {
    #[default]
    Channel,
    Any,
}
#[derive(Debug, Clone)]
pub struct RetrieveMemoryContextParams {
    pub channel_id: String,
    pub query: String,
    pub limit: usize,
    pub min_score: Option<f64>,
    pub mode: MemoryRetrievalMode,
    pub subject_scope: MemorySubjectScope,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RetrieveMemoryContextResult {
    pub error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub items: Vec<RetrievedMemoryItem>,
}
impl RetrieveMemoryContextResult {
    fn failure(message: impl Into<String>) -> Self {
        Self {
            error: true,
            message: Some(message.into()),
            items: vec![],
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct UpsertChannelMemoryParams {
    pub qdrant_point_id: f64,
    pub memory_id: String,
    pub channel_id: String,
    pub memory_type: Option<String>,
    pub status: Option<String>,
    pub risk: Option<String>,
    pub confidence: Option<f64>,
    pub subject_scope: Option<String>,
    pub subject_username: Option<String>,
    pub subject_user_id: Option<String>,
    pub content: String,
    pub summary: String,
    pub created_at_unix: Option<f64>,
    pub updated_at_unix: Option<f64>,
}

impl QdrantUtilities<'_> {
    pub async fn retrieve_channel_memory_context(
        &self,
        params: &RetrieveMemoryContextParams,
    ) -> RetrieveMemoryContextResult {
        if params.channel_id.is_empty() || params.query.is_empty() || params.limit == 0 {
            return RetrieveMemoryContextResult::failure("Missing required parameters");
        }
        let embedding = match self
            .embeddings
            .embed(&params.query, EMBEDDING_MODEL, EmbeddingKind::Query)
            .await
        {
            Ok(embedding) if !embedding.is_empty() => embedding,
            Err(error) if !error.0.is_empty() => {
                return RetrieveMemoryContextResult::failure(error.0);
            }
            _ => return RetrieveMemoryContextResult::failure("Failed to generate embedding"),
        };
        let min_score = params.min_score.unwrap_or(match params.mode {
            MemoryRetrievalMode::Explicit => 0.55,
            MemoryRetrievalMode::Passive => PASSIVE_CANDIDATE_SCORE,
        });
        let mut must = vec![
            Condition::matches("channel_id", MatchValue::Keyword(params.channel_id.clone())),
            Condition::matches("status", MatchValue::Keyword("confirmed".to_owned())),
        ];
        if params.subject_scope == MemorySubjectScope::Channel {
            must.push(Condition::matches(
                "subject_scope",
                MatchValue::Keyword("channel".to_owned()),
            ));
        }
        let request = QueryPointsBuilder::new(&self.names.memory)
            .query(embedding)
            .limit(params.limit.saturating_mul(8) as u64)
            .with_payload(true)
            .filter(Filter::must(must))
            .score_threshold(min_score as f32)
            .build();
        match execute_points(self.backend, QdrantRequest::Query(request)).await {
            Ok(points) => {
                let mut items: Vec<_> = points
                    .iter()
                    .filter_map(parse_memory_point)
                    .filter(|item| {
                        item.channel_id == params.channel_id
                            && item.status == "confirmed"
                            && item.score >= min_score
                    })
                    .filter(|item| {
                        params.mode == MemoryRetrievalMode::Explicit
                            || params.min_score.is_some()
                            || is_passive_memory_relevant(
                                &params.query,
                                &format!(
                                    "{} {}",
                                    item.summary,
                                    item.subject_username.as_deref().unwrap_or("")
                                ),
                                item.score,
                            )
                    })
                    .collect();
                items.sort_by(|a, b| {
                    descending(a.score, b.score).then_with(|| {
                        if a.score == b.score {
                            descending(a.updated_at, b.updated_at)
                        } else {
                            std::cmp::Ordering::Equal
                        }
                    })
                });
                items.truncate(params.limit);
                self.context.debug("retrieveChannelMemoryContext", json!({"channelID":params.channel_id,"retrieved":items.len(),"minScore":min_score}));
                RetrieveMemoryContextResult {
                    error: false,
                    message: None,
                    items,
                }
            }
            Err(error) => {
                self.context.error(
                    "retrieveChannelMemoryContext",
                    json!({"error":error.to_string(),"channelID":params.channel_id}),
                );
                RetrieveMemoryContextResult::failure("Failed to retrieve channel memory context")
            }
        }
    }

    async fn retrieve_memory_payload(&self, point_id: u64) -> Result<Option<Value>, UtilityError> {
        let request = GetPointsBuilder::new(&self.names.memory, vec![point_id.into()])
            .with_payload(true)
            .with_vectors(false)
            .build();
        let points = execute_points(self.backend, QdrantRequest::Retrieve(request)).await?;
        Ok(points.first().map(|point| {
            point["payload"]
                .as_object()
                .map(|map| Value::Object(map.clone()))
                .unwrap_or_else(|| json!({}))
        }))
    }

    /// Checks the existing payload before generating an embedding. Collision
    /// detection is the source's read-then-write guard, not an atomic CAS: callers
    /// must serialize competing writes when that race matters. `wait: true`.
    pub async fn upsert_channel_memory_embedding(
        &self,
        params: &UpsertChannelMemoryParams,
    ) -> OperationResult {
        if !valid_js_point_id(params.qdrant_point_id)
            || params.memory_id.is_empty()
            || params.channel_id.is_empty()
        {
            return OperationResult::failure(
                "Missing or invalid qdrantPointID, memoryId, or channelID",
            );
        }
        let result = self.upsert_memory_inner(params).await;
        match result {
            Ok(result) => result,
            Err(error) => {
                self.context.error(
                    "upsertChannelMemoryEmbedding",
                    json!({"error":error.to_string(),"channelID":params.channel_id}),
                );
                OperationResult::failure("Failed to upsert channel memory embedding")
            }
        }
    }
    async fn upsert_memory_inner(
        &self,
        params: &UpsertChannelMemoryParams,
    ) -> Result<OperationResult, UtilityError> {
        let point_id = native_point_id(params.qdrant_point_id)?;
        let existing = self.retrieve_memory_payload(point_id).await?;
        if existing.as_ref().is_some_and(|payload| {
            !qdrant_point_belongs_to_memory(Some(payload), &params.memory_id, &params.channel_id)
        }) {
            return Ok(OperationResult::failure(
                "Qdrant point ID collision detected; refusing to overwrite another memory",
            ));
        }
        let input = build_memory_embedding_input(&params.summary, &params.content);
        if input.is_empty() {
            return Ok(OperationResult::failure("Memory content is empty"));
        }
        let embedding = match self
            .embeddings
            .embed(&input, EMBEDDING_MODEL, EmbeddingKind::Document)
            .await
        {
            Ok(embedding) if !embedding.is_empty() => embedding,
            Err(error) if !error.0.is_empty() => return Ok(OperationResult::failure(error.0)),
            _ => {
                return Ok(OperationResult::failure(
                    "Failed to generate memory embedding",
                ));
            }
        };
        let mut payload = json!({ "memory_id": params.memory_id, "channel_id":params.channel_id,
            "subject_username":params.subject_username.as_deref().unwrap_or(""),
            "subject_user_id":params.subject_user_id.as_deref().unwrap_or(""),
            "content":params.content, "summary":params.summary });
        for (key, value) in [
            ("memory_type", &params.memory_type),
            ("status", &params.status),
            ("risk", &params.risk),
            ("subject_scope", &params.subject_scope),
        ] {
            if let Some(value) = value {
                payload[key] = json!(value);
            }
        }
        for (key, value) in [
            ("confidence", params.confidence),
            ("created_at", params.created_at_unix),
            ("updated_at", params.updated_at_unix),
        ] {
            if let Some(value) = value {
                payload[key] = qdrant_number_payload(value);
            }
        }
        let point = PointStruct::new(point_id, embedding, Payload::try_from(payload)?);
        execute_done(
            self.backend,
            QdrantRequest::Upsert(
                UpsertPointsBuilder::new(&self.names.memory, vec![point])
                    .wait(true)
                    .build(),
            ),
        )
        .await?;
        self.context.debug(
            "upsertChannelMemoryEmbedding",
            json!({"memoryId":params.memory_id,"channelID":params.channel_id}),
        );
        Ok(OperationResult::success())
    }

    /// An absent/empty memory ID intentionally disables the ownership guard,
    /// matching TS's legacy deletion contract. Pass a stable memory ID for a
    /// guarded deletion. A missing point succeeds without issuing a delete.
    pub async fn delete_channel_memory_embedding(
        &self,
        point_id: f64,
        channel_id: &str,
        memory_id: Option<&str>,
    ) -> OperationResult {
        if !valid_js_point_id(point_id) {
            return OperationResult::failure("Missing or invalid qdrantPointID");
        }
        let result = async {
            let point_id = native_point_id(point_id)?;
            let Some(existing) = self.retrieve_memory_payload(point_id).await? else {
                return Ok(OperationResult::success());
            };
            if let Some(memory_id) = memory_id.filter(|id| !id.is_empty())
                && !qdrant_point_belongs_to_memory(Some(&existing), memory_id, channel_id)
            {
                return Ok(OperationResult::failure(
                    "Qdrant point ID collision detected; refusing to delete another memory",
                ));
            }
            execute_done(
                self.backend,
                QdrantRequest::Delete(
                    DeletePointsBuilder::new(&self.names.memory)
                        .points(vec![PointId::from(point_id)])
                        .wait(true)
                        .build(),
                ),
            )
            .await?;
            Ok::<_, UtilityError>(OperationResult::success())
        }
        .await;
        match result {
            Ok(result) => result,
            Err(error) => {
                self.context.error(
                    "deleteChannelMemoryEmbedding",
                    json!({"error":error.to_string(),"channelID":channel_id}),
                );
                OperationResult::failure("Failed to delete channel memory embedding")
            }
        }
    }

    pub async fn delete_channel_memory_embeddings_by_channel(
        &self,
        channel_id: &str,
    ) -> OperationResult {
        if channel_id.is_empty() {
            return OperationResult::failure("Missing channelID");
        }
        let request = DeletePointsBuilder::new(&self.names.memory)
            .points(Filter::must([Condition::matches(
                "channel_id",
                MatchValue::Keyword(channel_id.to_owned()),
            )]))
            .wait(true)
            .build();
        match execute_done(self.backend, QdrantRequest::Delete(request)).await {
            Ok(()) => OperationResult::success(),
            Err(error) => {
                self.context.error(
                    "deleteChannelMemoryEmbeddingsByChannel",
                    json!({"error":error.to_string(),"channelID":channel_id}),
                );
                OperationResult::failure("Failed to delete channel memory embeddings")
            }
        }
    }
}
fn valid_js_point_id(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value >= 0.0
}
fn native_point_id(value: f64) -> Result<u64, UtilityError> {
    if value >= 18_446_744_073_709_551_616.0 {
        return Err(UtilityError(
            "Point ID exceeds Qdrant's unsigned 64-bit range".into(),
        ));
    }
    Ok(value as u64)
}
