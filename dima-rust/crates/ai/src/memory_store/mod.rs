//! A channel's AI memories: documents of `channelaimemories` (the truth) mirrored as points of
//! the Qdrant collection `twitch_channel_memories` (the recall index). Port of
//! `dimabot/src/utils/ai/memory/memory.service.ts`.
//!
//! Callers: the AI chat and its `create_memory` / `recall_memory` tools (create, recall,
//! validation of recalled ids, known-viewer facts, usage counts), the dashboard's memory routes
//! (list, update, status, delete), the stream memory worker (create, update, archive, delete),
//! account deletion ([`MemoryStore::delete_all_channel_memories`]) and the resync command of the
//! operator CLI ([`MemoryStore::sync_memory`], [`MemoryStore::repair`]).
//!
//! # Two stores, one truth
//!
//! MongoDB is the truth. The invariant kept by every operation: **Qdrant never holds more than
//! MongoDB allows** — a point exists only for a `confirmed` document of the same channel, with
//! the content that document had when the point was written. A write that removes something
//! from recall deletes the point first and writes MongoDB second; a write that adds to recall
//! writes MongoDB first and the point second; a write that changes a confirmed memory deletes
//! its point, saves, and writes the point again. Every failure or kill between the two writes
//! therefore leaves a document without a point (never recalled, still listed on the dashboard),
//! never a point without a document (a ghost recalled with text that may have been deleted).
//! [`MemoryStore::repair`] restores the missing points (and removes any ghost or stale point
//! from older data); retrying the operation repairs its own memory.
//!
//! | Operation | First write | Second | Failure or kill between leaves |
//! |---|---|---|---|
//! | create, confirmed | insert | point (insert rolled back if it fails) | document without point |
//! | create, other statuses | insert | — | — |
//! | dedupe update / update of a confirmed memory | delete point | save, then point | document without point |
//! | update of an unconfirmed memory | delete stale point | save | nothing harmful |
//! | status to confirmed | save | point | document without point |
//! | status away from confirmed | delete point | save | document without point |
//! | delete | delete point | delete document | document without point |
//! | delete all of a channel | delete points | delete documents, delete points again | documents without points |
//!
//! Where the reference differs (on purpose, see the recordings in `tests/memory_store*.rs`):
//! it writes the point *before* the document on create, update and confirmation, so a failed
//! save or a kill leaves a ghost (create: until the rollback runs; update: a point carrying the
//! new text while the document keeps the old one; an update that fails validation or the unique
//! fingerprint index leaves the point rewritten). Rust validates the whole save before any write.
//!
//! # Differences from the reference, on purpose
//!
//! - **Ownership.** Every Qdrant delete of this module names the memory and its channel, so the
//!   owner check of `deleteChannelMemoryEmbedding` always runs; the reference's id-less form
//!   (which deletes whatever point has that 32-bit id, any channel's) is never used. A point of
//!   another memory at our id (a 32-bit collision) is "not ours": deleting our memory succeeds
//!   instead of failing forever with the collision message.
//! - **Limits under races.** The pending and confirmed limits (`learningConfig`, per channel)
//!   are checked before the insert, as the reference does, and counted again after it: when two
//!   creates raced past the limit, the insert that finds the count above it removes itself. The
//!   limit can then be undershot by a race, never exceeded once both finish.
//! - **A duplicate fingerprint on insert** (two identical creates racing) is retried once as
//!   the dedupe update instead of failing.
//! - **Size bounds** ([`Config`]) refuse oversized text before any read, write or embedding.
//! - **Input types are closed.** Types, risks, statuses and sources are the stored enums; the
//!   stream worker's unchecked strings are parsed by its caller.
//! - Mongo `_id` strings: 24 hexadecimal digits, as Mongoose casts them.
//!
//! # Cost
//!
//! Embeddings come from the local LFM2 service (`lfm2.5-embedding-350m`, `document` for memories,
//! `query` for recall); the reference charges no usage event for them, and neither does this
//! module. Calls per operation: create or dedupe update 1 when the result is confirmed, else 0;
//! update of a confirmed memory 1; status to confirmed 1; recall 1; everything else 0; repair 1
//! per point it rewrites. No operation embeds the same text twice.
//!
//! # Deadlines
//!
//! Every MongoDB call, embedding and Qdrant call runs under the deadlines of [`Config`] (the
//! reference has none of its own: the Qdrant SDK's 300 s, the LFM2 client's 10 s per attempt
//! with two retries). Batches of the repair are bounded by [`Config::repair_batch`].
//!
//! Memory text is personal: it is [`Private`] in inputs, never in an error message, never
//! passed to the [`Observer`].

mod index;
mod read;
mod rules;
mod write;

pub use read::{
    KnownUserFact, KnownUserQuery, ListMemories, ListedMemories, RecallQuery, ScoredCandidate,
};
pub use rules::LearningSettings;
pub use write::{
    ActorInput, CreateMemory, CreateOutcome, EvidenceInput, SetStatus, SubjectInput, UpdateMemory,
};

pub use index::RepairReport;

use crate::{embeddings, qdrant};
use bson::{Document, doc, oid::ObjectId};
use dima_core::Clock;
use dima_http::{HttpClient, Provider};
pub use dima_model::Private;
use dima_model::channel_ai_memories::{ChannelAiMemory, INFO};
use dima_model::channel_ai_personalities::{LearningConfig, MemoryPolicy};
use dima_store::mongo::{MongoStore, WriteContext};
use serde::Deserialize;
use std::borrow::Cow;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

/// A boxed future of this module's seams.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Deadlines, bounds and names. Built by the binary from its typed configuration.
#[derive(Clone, Debug)]
pub struct Config {
    /// The embedding model (`lfm2.5-embedding-350m`, the reference's).
    pub embedding_model: String,
    /// Deadline of one MongoDB call.
    pub store_timeout: Duration,
    /// Deadline of one embedding, retries included (the client's are 10 s per attempt, two
    /// retries, waits of 1 s and 3 s).
    pub embedding_timeout: Duration,
    /// Deadline of one Qdrant call.
    pub qdrant_timeout: Duration,
    /// Longest content, in Unicode scalars, of a memory created or edited by the streamer, the
    /// system or the stream worker (the longest stored memory has 16,772).
    pub max_content_chars: usize,
    /// Longest content of a memory whose creator is chat (`createdBy.source: chat`): the AI's
    /// `create_memory` tool acting for a viewer.
    pub max_chat_content_chars: usize,
    /// Longest summary given (it is then cut to 180 UTF-16 units).
    pub max_summary_chars: usize,
    /// Longest evidence message.
    pub max_evidence_message_chars: usize,
    /// Longest name, id, username, message id, channel name or review reason.
    pub max_name_chars: usize,
    /// Longest recall query: a longer one is cut before it is embedded.
    pub max_query_chars: usize,
    /// Documents and points examined per batch by the repair.
    pub repair_batch: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            embedding_model: "lfm2.5-embedding-350m".into(),
            store_timeout: Duration::from_secs(30),
            embedding_timeout: Duration::from_secs(60),
            qdrant_timeout: Duration::from_secs(60),
            max_content_chars: 20_000,
            max_chat_content_chars: 2_000,
            max_summary_chars: 20_000,
            max_evidence_message_chars: 2_000,
            max_name_chars: 200,
            max_query_chars: 2_000,
            repair_batch: 200,
        }
    }
}

/// Resolves a channel's login when the caller gave none (`TwitchStreamers.getTwitchAccountById`).
pub trait ChannelNames: Send + Sync {
    /// The channel's name, `None` when unknown.
    fn channel_name<'a>(&'a self, channel_id: &'a str) -> BoxFuture<'a, Option<String>>;
}

/// The source of new memory ids (randomness is injected).
pub trait IdSource: Send + Sync {
    /// A new ObjectId at `now_ms`.
    fn object_id(&self, now_ms: i64) -> ObjectId;
}

/// ObjectIds from the driver's generator.
#[derive(Clone, Copy, Debug, Default)]
pub struct DriverIds;

impl IdSource for DriverIds {
    fn object_id(&self, _now_ms: i64) -> ObjectId {
        ObjectId::new()
    }
}

/// Failures, for logging and metrics. Operation names only, never ids or text.
pub trait Observer: Send + Sync {
    /// `operation` failed (a store, index or embedding error).
    fn failed(&self, operation: &'static str);
}

struct Silent;
impl Observer for Silent {
    fn failed(&self, _: &'static str) {}
}

/// A write or call of an operation, named for the fault seam.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Step {
    /// An embedding request.
    Embed,
    /// The insert of a new memory.
    MongoInsert,
    /// The count after an insert (limit races).
    LimitRecount,
    /// The save of a loaded memory.
    MongoSave,
    /// `deleteOne` of a memory.
    MongoDelete,
    /// `deleteMany` of a channel's memories.
    MongoDeleteMany,
    /// A point upsert.
    QdrantUpsert,
    /// A point delete.
    QdrantDelete,
}

/// What a [`Faults`] seam decides before a step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaultAction {
    /// Run the step.
    Proceed,
    /// Fail the step as its store would (the operation sees an error).
    Fail,
}

/// Test seam called before every write and call of an operation. Production uses none; tests
/// fail a step, or simulate a kill by never completing the returned future (the test drops the
/// operation once the step is reached).
pub trait Faults: Send + Sync {
    /// Called before `step`.
    fn before(&self, step: Step) -> BoxFuture<'_, FaultAction>;
}

/// The kind of a [`MemoryError`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    /// The input breaks a rule of the reference (missing content, a user subject without id).
    Invalid,
    /// The channel's memory policy refuses it.
    Policy,
    /// No such memory in this channel.
    NotFound,
    /// The channel's pending or confirmed limit is reached.
    Limit,
    /// A size bound of [`Config`] is exceeded; nothing was read, written or embedded.
    TooLarge,
    /// MongoDB failed or timed out.
    Store,
    /// Qdrant or the embedding service failed or timed out.
    Index,
}

/// An operation's failure. The message is the reference's (what the dashboard and the AI tools
/// show) and never contains memory text.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct MemoryError {
    /// What failed.
    pub kind: ErrorKind,
    /// The reference's message.
    pub message: Cow<'static, str>,
}

impl MemoryError {
    pub(crate) fn new(kind: ErrorKind, message: impl Into<Cow<'static, str>>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn not_found() -> Self {
        Self::new(ErrorKind::NotFound, "Memory not found")
    }

    /// The same failure under another operation's generic message (the reference's `catch`).
    pub(crate) fn generic(self, message: &'static str) -> Self {
        match self.kind {
            ErrorKind::Store | ErrorKind::Index => Self::new(self.kind, message),
            _ => self,
        }
    }
}

/// A memory document as stored (read back after the write, or listed).
#[derive(Clone)]
pub struct StoredMemory {
    document: Document,
}

impl StoredMemory {
    /// `_id`.
    pub fn id(&self) -> Option<ObjectId> {
        self.document.get_object_id("_id").ok()
    }

    /// The document as `res.json` renders the hydrated or lean Mongoose document.
    pub fn to_json(&self) -> serde_json::Value {
        INFO.response_json(self.document.clone())
    }

    /// The document as its read type.
    pub fn decode(&self) -> Result<ChannelAiMemory, dima_model::DecodeError> {
        dima_model::decode_document(&self.document)
    }

    /// The stored BSON (private text included).
    pub fn document(&self) -> &Document {
        &self.document
    }
}

impl fmt::Debug for StoredMemory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredMemory")
            .field("_id", &self.id())
            .finish_non_exhaustive()
    }
}

/// What a [`MemoryStore`] is built from.
pub struct Parts {
    /// The database holding `channelaimemories` and `channelaipersonalities`.
    pub mongo: MongoStore,
    /// The HTTP client for Qdrant.
    pub qdrant_http: HttpClient,
    /// Qdrant (`None`: not configured; every index call then fails as the reference's does).
    pub qdrant_provider: Option<Provider>,
    /// The memory collection (`twitch_channel_memories`).
    pub qdrant_collection: String,
    /// The embedding client (LFM2).
    pub embeddings: Arc<embeddings::Client>,
    /// Channel names for new memories.
    pub channel_names: Arc<dyn ChannelNames>,
    /// The clock.
    pub clock: Arc<dyn Clock>,
    /// New memory ids.
    pub ids: Arc<dyn IdSource>,
    /// Deadlines and bounds.
    pub config: Config,
    /// Failure reports (default: silent).
    pub observer: Option<Arc<dyn Observer>>,
    /// The fault seam (tests only; `None` in production).
    pub faults: Option<Arc<dyn Faults>>,
}

/// The memory store of every channel. Cheap to share behind an `Arc`.
pub struct MemoryStore {
    mongo: MongoStore,
    qdrant: qdrant::Client,
    qdrant_http: HttpClient,
    qdrant_provider: Option<Provider>,
    embeddings: Arc<embeddings::Client>,
    names: Arc<dyn ChannelNames>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn IdSource>,
    config: Config,
    observer: Arc<dyn Observer>,
    faults: Option<Arc<dyn Faults>>,
}

impl fmt::Debug for MemoryStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MemoryStore")
            .field("collection", &self.qdrant.memory_collection)
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

/// The two settings documents of a channel's personality this module reads.
#[derive(Debug, Default, Deserialize)]
struct PersonalitySettings {
    #[serde(default, rename = "learningConfig")]
    learning: Option<LearningConfig>,
    #[serde(default, rename = "memoryPolicy")]
    policy: Option<MemoryPolicy>,
}

impl MemoryStore {
    /// A store over `parts`.
    pub fn new(parts: Parts) -> Self {
        let mut qdrant =
            qdrant::Client::new(parts.qdrant_http.clone(), parts.qdrant_provider.clone());
        qdrant.memory_collection = parts.qdrant_collection;
        Self {
            mongo: parts.mongo,
            qdrant,
            qdrant_http: parts.qdrant_http,
            qdrant_provider: parts.qdrant_provider,
            embeddings: parts.embeddings,
            names: parts.channel_names,
            clock: parts.clock,
            ids: parts.ids,
            config: parts.config,
            observer: parts.observer.unwrap_or_else(|| Arc::new(Silent)),
            faults: parts.faults,
        }
    }

    pub(crate) async fn fault(&self, step: Step) -> Result<(), ()> {
        match &self.faults {
            None => Ok(()),
            Some(f) => match f.before(step).await {
                FaultAction::Proceed => Ok(()),
                FaultAction::Fail => Err(()),
            },
        }
    }

    /// A MongoDB call under the store deadline.
    pub(crate) async fn mongo_call<T, E>(
        &self,
        operation: &'static str,
        call: impl std::future::IntoFuture<Output = Result<T, E>>,
    ) -> Result<T, MemoryError> {
        match tokio::time::timeout(self.config.store_timeout, call.into_future()).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) | Err(_) => {
                self.observer.failed(operation);
                Err(MemoryError::new(ErrorKind::Store, "MongoDB call failed"))
            }
        }
    }

    pub(crate) fn ctx(&self) -> WriteContext {
        WriteContext::new(self.clock.now_ms())
    }

    /// The channel's learning settings and memory policy (one read; the reference reads twice).
    pub(crate) async fn settings(
        &self,
        channel_id: &str,
    ) -> Result<(LearningSettings, crate::memory::Policy), MemoryError> {
        let collection = self
            .mongo
            .documents(dima_model::channel_ai_personalities::COLLECTION);
        let found = self
            .mongo_call(
                "memorySettings",
                collection
                    .find_one(doc! { "channelID": channel_id })
                    .projection(doc! { "learningConfig": 1, "memoryPolicy": 1 }),
            )
            .await?;
        let settings: PersonalitySettings = match found {
            None => PersonalitySettings::default(),
            Some(document) => dima_model::decode_document(&document).map_err(|_| {
                self.observer.failed("memorySettings");
                MemoryError::new(ErrorKind::Store, "Unreadable personality settings")
            })?,
        };
        Ok((
            LearningSettings::from_stored(settings.learning.as_ref()),
            rules::policy_from_stored(settings.policy.as_ref()),
        ))
    }

    /// `getChannelLearningConfig`: what the AI's `create_memory` tool reads.
    pub async fn learning_settings(
        &self,
        channel_id: &str,
    ) -> Result<LearningSettings, MemoryError> {
        Ok(self.settings(channel_id).await?.0)
    }

    /// The memory policy of a channel (`resolveMemoryPolicy`).
    pub async fn memory_policy(
        &self,
        channel_id: &str,
    ) -> Result<crate::memory::Policy, MemoryError> {
        Ok(self.settings(channel_id).await?.1)
    }

    /// Reads one whole memory of `channel_id` back, as stored.
    pub(crate) async fn reread(&self, id: ObjectId) -> Result<StoredMemory, MemoryError> {
        let found = self
            .mongo_call(
                "memoryRead",
                self.mongo.documents(INFO.name).find_one(doc! { "_id": id }),
            )
            .await?;
        found
            .map(|document| StoredMemory { document })
            .ok_or_else(MemoryError::not_found)
    }
}
