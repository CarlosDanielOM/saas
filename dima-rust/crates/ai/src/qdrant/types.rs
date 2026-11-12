use serde::{Deserialize, Serialize};
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
    pub(crate) fn failure(message: impl Into<String>) -> Self {
        Self {
            error: true,
            message: Some(message.into()),
            items: vec![],
            selected_pass: SemanticPass::None,
            pass_results: vec![],
        }
    }
}

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
    pub(crate) fn failure(message: impl Into<String>) -> Self {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SemanticPass {
    High,
    Fallback,
    None,
}

/// The embedding batcher's input, before language detection and embedding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueuedChatMessage {
    pub text: String,
    pub channel_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    pub username: String,
    pub user_id: String,
    pub timestamp: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}
/// Caller-owned bounded embedding queue. False means the queue refused the item.
pub trait ChatEmbeddingQueue {
    fn add_message(&self, message: QueuedChatMessage) -> bool;
}
