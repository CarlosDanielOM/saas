//! Injectable boundaries for the library-only Qdrant port. No adapter is
//! registered globally and constructing [`QdrantUtilities`] performs no I/O.

use std::{fmt, future::Future, pin::Pin};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::QdrantBackend;

pub type UtilityFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, UtilityError>> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UtilityError(pub String);

impl fmt::Display for UtilityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for UtilityError {}
impl From<qdrant_client::QdrantError> for UtilityError {
    fn from(value: qdrant_client::QdrantError) -> Self {
        Self(value.to_string())
    }
}

pub const EMBEDDING_MODEL: &str = "lfm2.5-embedding-350m";
pub const EMBEDDING_DIMENSIONS: u64 = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddingKind {
    Query,
    Document,
}

/// Adapter for the LFM2 helper: request this exact model and kind, return a
/// nonempty embedding or the provider's failure message. HTTP retries, batch
/// ordering, and normalization remain the embedding adapter's responsibility.
pub trait EmbeddingProvider: Send + Sync {
    fn embed<'a>(
        &'a self,
        text: &'a str,
        model: &'static str,
        kind: EmbeddingKind,
    ) -> UtilityFuture<'a, Vec<f32>>;
}

/// Explicit boundary around the stateful TypeScript language detector. The
/// detector is called with threshold 0.1; supplied nonempty languages bypass it.
/// A caller requiring the original global-regex state must supply that policy.
pub trait LanguageDetector: Send + Sync {
    fn detect_language(&self, text: &str, threshold: f64) -> String;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessageData {
    pub channel_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    pub message: String,
    pub username: String,
    pub user_id: String,
    pub timestamp: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

/// Boundary to `EmbeddingBatcher.addMessage`. This port enqueues one message
/// unchanged and swallows enqueue errors just like the TS wrapper. The batcher
/// class is outside the eleven-file folder: its 500-message/350ms timer and
/// three-attempt retry loop belong to the supplied queue, not this utility.
pub trait ChatEmbeddingQueue: Send + Sync {
    fn add_message(&self, message: QueuedChatMessage) -> Result<(), UtilityError>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SemanticMemoryMetric {
    pub channel_id: String,
    pub requested: usize,
    pub retrieved: usize,
    pub avg_score: f64,
    pub latency_ms: u64,
    pub failed: bool,
    pub pass: SemanticPass,
}

/// Logging/metrics are deliberately caller-owned. Hooks should enqueue local
/// telemetry without blocking; telemetry failure must not alter query results.
pub trait QdrantContext: Send + Sync {
    fn semantic_memory_metric(&self, _metric: SemanticMemoryMetric) {}
    fn debug(&self, _operation: &str, _details: Value) {}
    fn error(&self, _operation: &str, _details: Value) {}
}
pub struct NoopQdrantContext;
impl QdrantContext for NoopQdrantContext {}
static NOOP_CONTEXT: NoopQdrantContext = NoopQdrantContext;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QdrantCollectionNames {
    pub chat: String,
    pub memory: String,
}
impl Default for QdrantCollectionNames {
    fn default() -> Self {
        Self {
            chat: "twitch_chat_logs".into(),
            memory: "twitch_channel_memories".into(),
        }
    }
}

/// Library-first implementation of the eleven TS Qdrant sources. The existing
/// connector can supply the backend (`Qdrant` implements `QdrantBackend`), but
/// is never called by the constructor. No worker/profile/production wiring is
/// installed. Use fixture collection names to isolate integration tests.
pub struct QdrantUtilities<'a> {
    pub(crate) backend: &'a dyn QdrantBackend,
    pub(crate) embeddings: &'a dyn EmbeddingProvider,
    pub(crate) language: &'a dyn LanguageDetector,
    pub(crate) context: &'a dyn QdrantContext,
    pub(crate) names: QdrantCollectionNames,
}
impl<'a> QdrantUtilities<'a> {
    pub fn new(
        backend: &'a dyn QdrantBackend,
        embeddings: &'a dyn EmbeddingProvider,
        language: &'a dyn LanguageDetector,
    ) -> Self {
        Self {
            backend,
            embeddings,
            language,
            context: &NOOP_CONTEXT,
            names: QdrantCollectionNames::default(),
        }
    }
    pub fn with_context(mut self, context: &'a dyn QdrantContext) -> Self {
        self.context = context;
        self
    }
    pub fn with_collections(mut self, names: QdrantCollectionNames) -> Self {
        self.names = names;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationResult {
    pub error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
impl OperationResult {
    pub(crate) fn success() -> Self {
        Self {
            error: false,
            message: None,
        }
    }
    pub(crate) fn failure(message: impl Into<String>) -> Self {
        Self {
            error: true,
            message: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SemanticPass {
    High,
    Fallback,
    None,
}

pub(crate) fn elapsed_ms(start: std::time::Instant) -> u64 {
    start.elapsed().as_millis().min(u64::MAX as u128) as u64
}
