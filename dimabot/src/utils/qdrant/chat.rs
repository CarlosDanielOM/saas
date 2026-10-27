//! Immediate writes, the queue adapter, bounded chat windows, and two-pass
//! semantic retrieval. Query embeddings are generated once across both passes.
//! Language detection is retained even for semantic queries, where the source
//! computes and discards its result. Stored text and timestamps are unchanged.

use super::backend::{execute_done, execute_points, unexpected_response};
use super::parity::normalize_timestamp;
use super::*;
use crate::utils::js_compat::trim;
use ::qdrant_client::qdrant::r#match::MatchValue;
use ::qdrant_client::{Payload, qdrant::*};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Instant;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoreChatLogResult {
    pub error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(rename = "embeddingTime", skip_serializing_if = "Option::is_none")]
    pub embedding_time: Option<u64>,
    #[serde(rename = "qdrantTime", skip_serializing_if = "Option::is_none")]
    pub qdrant_time: Option<u64>,
    #[serde(rename = "totalTime", skip_serializing_if = "Option::is_none")]
    pub total_time: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatWindowItem {
    pub channel_id: String,
    pub username: String,
    pub user_id: String,
    pub message: String,
    pub timestamp: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}
#[derive(Debug, Clone)]
pub struct ChatWindowParams {
    pub channel_id: String,
    pub from_unix: f64,
    pub to_unix: f64,
    pub limit: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatWindowResult {
    pub error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub items: Vec<ChatWindowItem>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SemanticChatItem {
    pub score: f64,
    pub channel_id: String,
    pub username: String,
    pub user_id: String,
    pub message: String,
    pub timestamp: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}
#[derive(Debug, Clone)]
pub struct SemanticChatContextParams {
    pub channel_id: String,
    pub query: String,
    pub limit: usize,
    pub primary_min_score: Option<f64>,
    pub fallback_min_score: Option<f64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticPassResult {
    pub pass: SemanticPass,
    pub threshold: f64,
    pub raw_matches: usize,
    pub kept_matches: usize,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticChatContextResult {
    pub error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub items: Vec<SemanticChatItem>,
    pub selected_pass: SemanticPass,
    pub pass_results: Vec<SemanticPassResult>,
}
impl SemanticChatContextResult {
    fn failure(message: impl Into<String>) -> Self {
        Self {
            error: true,
            message: Some(message.into()),
            items: vec![],
            selected_pass: SemanticPass::None,
            pass_results: vec![],
        }
    }
}

impl QdrantUtilities<'_> {
    /// The immediate source helper is deprecated in favor of the queue wrapper;
    /// both are functional here. Upserts use `wait: false` exactly as TS does.
    pub async fn store_chat_message_embedding(&self, data: &ChatMessageData) -> StoreChatLogResult {
        let start = Instant::now();
        let embedding_start = Instant::now();
        if trim(&data.message).is_empty() {
            return StoreChatLogResult {
                error: true,
                message: Some("Message is empty".into()),
                embedding_time: None,
                qdrant_time: None,
                total_time: None,
            };
        }
        let language = data
            .language
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| self.language.detect_language(&data.message, 0.1));
        let embedding = match self
            .embeddings
            .embed(&data.message, EMBEDDING_MODEL, EmbeddingKind::Document)
            .await
        {
            Ok(embedding) if !embedding.is_empty() => embedding,
            result => {
                let message = match result {
                    Err(err) if !err.0.is_empty() => err.0,
                    _ => "Failed to generate embedding".into(),
                };
                self.context.error(
                    "storeChatMessageEmbedding",
                    json!({"message": message, "channel_id": data.channel_id}),
                );
                return StoreChatLogResult {
                    error: true,
                    message: Some(message),
                    embedding_time: Some(elapsed_ms(embedding_start)),
                    qdrant_time: None,
                    total_time: None,
                };
            }
        };
        let embedding_time = elapsed_ms(embedding_start);
        let qdrant_start = Instant::now();
        let mut payload = json!({
            "channel_id": data.channel_id, "username": data.username, "user_id": data.user_id,
            "message": data.message, "timestamp": qdrant_number_payload(data.timestamp), "language": language,
        });
        if let Some(name) = &data.channel_name {
            payload["channel_name"] = json!(name);
        }
        let result = async {
            let point = PointStruct::new(
                u64::from(generate_qdrant_point_id(
                    &data.channel_id,
                    &data.user_id,
                    data.timestamp,
                )),
                embedding,
                Payload::try_from(payload)?,
            );
            execute_done(
                self.backend,
                QdrantRequest::Upsert(
                    UpsertPointsBuilder::new(&self.names.chat, vec![point])
                        .wait(false)
                        .build(),
                ),
            )
            .await
        }
        .await;
        if let Err(error) = result {
            self.context.error(
                "storeChatMessageEmbedding",
                json!({"error": error.to_string(), "channel_id": data.channel_id}),
            );
            return StoreChatLogResult {
                error: true,
                message: Some("Failed to store chat message embedding".into()),
                embedding_time: Some(elapsed_ms(embedding_start)),
                qdrant_time: None,
                total_time: Some(elapsed_ms(start)),
            };
        }
        let result = StoreChatLogResult {
            error: false,
            message: None,
            embedding_time: Some(embedding_time),
            qdrant_time: Some(elapsed_ms(qdrant_start)),
            total_time: Some(elapsed_ms(start)),
        };
        self.context.debug(
            "storeChatMessageEmbedding",
            json!({"channel_id":data.channel_id,"timings":result}),
        );
        result
    }

    /// Source wrapper only: queues immediately, rejects whitespace-only text,
    /// retains optional metadata, and reports queue failure only through context.
    pub async fn store_chat_message_embedding_batched(
        &self,
        queue: &dyn ChatEmbeddingQueue,
        data: &ChatMessageData,
    ) {
        if trim(&data.message).is_empty() {
            return;
        }
        let queued = QueuedChatMessage {
            text: data.message.clone(),
            channel_id: data.channel_id.clone(),
            channel_name: data.channel_name.clone(),
            username: data.username.clone(),
            user_id: data.user_id.clone(),
            timestamp: data.timestamp,
            language: data.language.clone(),
        };
        if let Err(error) = queue.add_message(queued) {
            self.context.error(
                "storeChatMessageEmbeddingBatched",
                json!({"error":error.to_string(),"channel_id":data.channel_id}),
            );
        }
    }

    /// At most 1440 raw points, 120 per request, and twelve scroll iterations.
    /// The raw point count consumes the limit before malformed/cross-channel
    /// points are dropped, preserving TS's bounded pagination semantics.
    pub async fn retrieve_channel_chat_window(
        &self,
        params: &ChatWindowParams,
    ) -> ChatWindowResult {
        let channel_id = trim(&params.channel_id);
        let from = normalize_timestamp(&json!(params.from_unix));
        let to = normalize_timestamp(&json!(params.to_unix));
        let limit = normalize_timestamp(&json!(params.limit)).clamp(1.0, 1440.0) as usize;
        if channel_id.is_empty() || from <= 0.0 || to <= 0.0 || from > to {
            return ChatWindowResult {
                error: true,
                message: Some("Invalid chat window parameters".into()),
                items: vec![],
            };
        }
        let filter = Filter::must([
            Condition::matches("channel_id", MatchValue::Keyword(channel_id.to_owned())),
            Condition::range(
                "timestamp",
                Range {
                    gte: Some(from),
                    lte: Some(to),
                    ..Default::default()
                },
            ),
        ]);
        let result = async {
            let mut points = Vec::new();
            let mut offset: Option<PointId> = None;
            for _ in 0..12 {
                if points.len() >= limit {
                    break;
                }
                let mut request = ScrollPointsBuilder::new(&self.names.chat)
                    .filter(filter.clone())
                    .with_payload(true)
                    .with_vectors(false)
                    .limit((limit - points.len()).min(120) as u32);
                if let Some(offset) = offset.take() {
                    request = request.offset(offset);
                }
                let (chunk, next) = match self
                    .backend
                    .execute(QdrantRequest::Scroll(request.build()))
                    .await?
                {
                    QdrantResponse::Scroll {
                        points,
                        next_offset,
                    } => (points, next_offset),
                    _ => return Err(unexpected_response()),
                };
                points.extend(chunk);
                // JS `if (!nextOffset)` also terminates at the numeric ID zero.
                let next = next.filter(|id| {
                    !matches!(id.point_id_options, Some(point_id::PointIdOptions::Num(0)))
                });
                if next.is_none() {
                    break;
                }
                offset = next;
            }
            let mut items: Vec<_> = points
                .iter()
                .filter_map(parse_chat_window_point)
                .filter(|i| i.channel_id == channel_id && i.timestamp >= from && i.timestamp <= to)
                .collect();
            items.sort_by(|a, b| {
                a.timestamp
                    .partial_cmp(&b.timestamp)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            items.truncate(limit);
            Ok::<_, UtilityError>(items)
        }
        .await;
        match result {
            Ok(items) => ChatWindowResult {
                error: false,
                message: None,
                items,
            },
            Err(error) => {
                self.context.error(
                    "retrieveChannelChatWindow",
                    json!({"error": error.to_string(), "channelID":params.channel_id}),
                );
                ChatWindowResult {
                    error: true,
                    message: Some("Failed to retrieve chat window context".into()),
                    items: vec![],
                }
            }
        }
    }

    /// Overfetches three times the limit, postfilters channel/threshold, keeps
    /// first phrase duplicates, ranks, then caps. A single primary match stops
    /// fallback; results from different passes are never combined.
    pub async fn retrieve_semantic_chat_context(
        &self,
        params: &SemanticChatContextParams,
    ) -> SemanticChatContextResult {
        let started = Instant::now();
        let result = self.semantic_chat_inner(params).await;
        self.context.semantic_memory_metric(SemanticMemoryMetric {
            channel_id: params.channel_id.clone(),
            requested: params.limit,
            retrieved: result.items.len(),
            avg_score: if result.items.is_empty() {
                0.0
            } else {
                result.items.iter().map(|i| i.score).sum::<f64>() / result.items.len() as f64
            },
            latency_ms: elapsed_ms(started),
            failed: result.error,
            pass: result.selected_pass,
        });
        result
    }

    async fn semantic_chat_inner(
        &self,
        params: &SemanticChatContextParams,
    ) -> SemanticChatContextResult {
        if params.channel_id.is_empty() || params.query.is_empty() || params.limit == 0 {
            return SemanticChatContextResult::failure("Missing required parameters");
        }
        let query = trim(&params.query);
        let _language = self.language.detect_language(query, 0.1);
        let embedding = match self
            .embeddings
            .embed(query, EMBEDDING_MODEL, EmbeddingKind::Query)
            .await
        {
            Ok(embedding) if !embedding.is_empty() => embedding,
            Err(error) if !error.0.is_empty() => {
                return SemanticChatContextResult::failure(error.0);
            }
            _ => return SemanticChatContextResult::failure("Failed to generate embedding"),
        };
        let primary = params.primary_min_score.unwrap_or(0.75);
        let fallback = params.fallback_min_score.unwrap_or(0.69);
        let mut result = SemanticChatContextResult {
            error: false,
            message: None,
            items: vec![],
            selected_pass: SemanticPass::None,
            pass_results: vec![],
        };
        for (pass, threshold) in [
            (SemanticPass::High, primary),
            (SemanticPass::Fallback, fallback),
        ] {
            let request = QueryPointsBuilder::new(&self.names.chat)
                .query(embedding.clone())
                .limit(params.limit.saturating_mul(3) as u64)
                .with_payload(true)
                .filter(Filter::must([Condition::matches(
                    "channel_id",
                    MatchValue::Keyword(params.channel_id.clone()),
                )]))
                .score_threshold(threshold as f32)
                .build();
            let points = match execute_points(self.backend, QdrantRequest::Query(request)).await {
                Ok(points) => points,
                Err(error) => {
                    self.context.error(
                        "retrieveSemanticChatContext",
                        json!({"error":error.to_string(),"channelID":params.channel_id}),
                    );
                    return SemanticChatContextResult::failure(
                        "Failed to retrieve semantic memory",
                    );
                }
            };
            let items =
                select_semantic_chat_items(&params.channel_id, &points, threshold, params.limit);
            result.pass_results.push(SemanticPassResult {
                pass,
                threshold,
                raw_matches: points.len(),
                kept_matches: items.len(),
            });
            if !items.is_empty() {
                result.items = items;
                result.selected_pass = pass;
                break;
            }
        }
        self.context.debug(
            "retrieveSemanticChatContext",
            json!({"channelID":params.channel_id,"result":result}),
        );
        result
    }
}
