//! `channelaimemories`: what the channel's AI learned (preferences, running jokes, facts about
//! viewers, channel lore, boundaries), each reviewed into a status and mirrored into Qdrant.
//!
//! Reference: `dimabot/src/schemas/channel_ai_memory.schema.ts` (model `ChannelAIMemory`),
//! written by `utils/ai/memory/memory.service.ts` (`new` and `save()`, saves of loaded memories,
//! `$set` of `qdrantPointID`, `updateMany` with `$inc` of `useCount`). Camel-case timestamps,
//! `__v`, no hooks. Indexes: `{channelID, status, type}`, the sparse unique `qdrantPointID`, the
//! unique `{channelID, fingerprint}` (dedupe of a memory; best effort like the reference, which
//! awaits nothing), `{channelID, updatedAt: -1}` and two subject scans. `subject`, `createdBy`
//! and `reviewedBy` elements and `sourceEvidence` elements have no `_id`.
//!
//! Identity: `qdrantPointID` is the Qdrant point id derived from the memory; it is stored as
//! int32 or double (2483 and 2694 documents) and read as a [`JsNumber`] that keeps the value
//! exactly; missing (81 documents) stays missing, as the sparse unique index needs.
//! Private: `content`, `summary` and `sourceEvidence` (chat messages and facts about viewers).
//!
//! Client-fed writes (`null` from a request body): none. `server/routes/memories.route.ts` checks
//! `type` and `risk` against their lists and `content`/`summary` with `typeof`;
//! `utils/ai/memory/memory.service.ts` builds the rest (it removes `reviewedBy` on a review without
//! a reviewer, which the read type reads as missing).
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{ClientNulls, CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::{empty, zero};
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::private::Private;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::{JsNumber, js_int};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "channelaimemories";

str_enum! {
    /// `subject.scope`.
    pub enum SubjectScope {
        /// About the channel (the default).
        Channel = "channel",
        /// About one viewer.
        User = "user",
    }
}

str_enum! {
    /// `sourceEvidence[].source`, `createdBy.source`, `reviewedBy.source`.
    pub enum MemorySource {
        /// Chat.
        Chat = "chat",
        /// A moderator.
        Mod = "mod",
        /// The streamer.
        Streamer = "streamer",
        /// The system.
        System = "system",
        /// The desktop application.
        OauthDesktop = "oauth_desktop",
    }
}

str_enum! {
    /// `type`.
    pub enum MemoryType {
        /// A preference.
        Preference = "preference",
        /// A running joke.
        RunningJoke = "running_joke",
        /// A fact about a viewer.
        KnownUserFact = "known_user_fact",
        /// Channel lore.
        ChannelLore = "channel_lore",
        /// A boundary.
        Boundary = "boundary",
    }
}

str_enum! {
    /// `status`.
    pub enum MemoryStatus {
        /// Proposed (the default).
        Candidate = "candidate",
        /// Waiting for review.
        PendingReview = "pending_review",
        /// Confirmed: used and mirrored into Qdrant.
        Confirmed = "confirmed",
        /// Rejected.
        Rejected = "rejected",
        /// Archived.
        Archived = "archived",
    }
}

str_enum! {
    /// `risk`.
    pub enum MemoryRisk {
        /// Low (the default).
        Low = "low",
        /// Medium.
        Medium = "medium",
        /// High.
        High = "high",
    }
}

static SUBJECT: Schema = Schema::subdocument(&[
    Field::string("scope").default(D::Str("channel")),
    Field::string("username").default(D::Str("")),
    Field::string("userID").default(D::Str("")),
])
.no_id();

/// `() => Math.floor(Date.now() / 1000)`.
fn now_seconds(now_ms: i64) -> Bson {
    js_int(now_ms.div_euclid(1000))
}

static EVIDENCE: Schema = Schema::subdocument(&[
    Field::string("source").default(D::Str("chat")),
    Field::string("username").default(D::Str("")),
    Field::string("userID").default(D::Str("")),
    Field::string("message").default(D::Str("")),
    Field::string("messageId").default(D::Str("")),
    Field::number("timestamp").default_fn(D::With(now_seconds)),
])
.no_id();

static ACTOR: Schema = Schema::subdocument(&[
    Field::string("source").default(D::Str("system")),
    Field::string("username").default(D::Str("")),
    Field::string("userID").default(D::Str("")),
])
.no_id();

/// `default: { scope: 'channel' }`, cast to the sub-document.
fn channel_subject(_now_ms: i64) -> Bson {
    Bson::Document(doc! { "scope": "channel", "username": "", "userID": "" })
}

/// `default: { source: 'system' }`, cast to the sub-document.
fn system_actor(_now_ms: i64) -> Bson {
    Bson::Document(doc! { "source": "system", "username": "", "userID": "" })
}

/// The schema, field by field as `channel_ai_memory.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::number("qdrantPointID"),
    Field::string("channelID"),
    Field::string("channel").default(D::Str("Unknown")),
    Field::string("type"),
    Field::string("status").default(D::Str("candidate")),
    Field::string("risk").default(D::Str("low")),
    Field::number("confidence").default(D::Double(0.5)),
    Field::subdocument("subject", &SUBJECT).default(D::With(channel_subject)),
    Field::string("content"),
    Field::string("summary"),
    Field::string("fingerprint"),
    Field::document_array("sourceEvidence", &EVIDENCE).default(D::EmptyArray),
    Field::subdocument("createdBy", &ACTOR).default(D::With(system_actor)),
    Field::subdocument("reviewedBy", &ACTOR),
    Field::string("reviewReason").default(D::Str("")),
    Field::date("reviewedAt"),
    Field::number("useCount").default(D::Int(0)),
    Field::date("lastUsedAt"),
    Field::date("expiresAt"),
])
.timestamps(Timestamps::CAMEL);

/// The declared indexes, in `schema.index` order.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1), ("status", 1), ("type", 1)]),
    IndexSpec::on(&[("qdrantPointID", 1)]).unique().sparse(),
    IndexSpec::on(&[("channelID", 1), ("fingerprint", 1)]).unique(),
    IndexSpec::on(&[("channelID", 1), ("updatedAt", -1)]),
    IndexSpec::on(&[("channelID", 1), ("subject.username", 1), ("type", 1)]),
    IndexSpec::on(&[
        ("channelID", 1),
        ("subject.userID", 1),
        ("status", 1),
        ("type", 1),
    ]),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("channel"),
    Rule::required("type"),
    Rule::one_of("type", MemoryType::STRINGS),
    Rule::required("status"),
    Rule::one_of("status", MemoryStatus::STRINGS),
    Rule::required("risk"),
    Rule::one_of("risk", MemoryRisk::STRINGS),
    Rule::required("confidence"),
    Rule::min("confidence", 0.0),
    Rule::max("confidence", 1.0),
    Rule::required("subject"),
    Rule::required("subject.scope"),
    Rule::one_of("subject.scope", SubjectScope::STRINGS),
    Rule::required("content"),
    Rule::required("summary"),
    Rule::required("fingerprint"),
    Rule::required("sourceEvidence.$.source"),
    Rule::one_of("sourceEvidence.$.source", MemorySource::STRINGS),
    Rule::required("sourceEvidence.$.timestamp"),
    Rule::required("createdBy"),
    Rule::required("createdBy.source"),
    Rule::one_of("createdBy.source", MemorySource::STRINGS),
    Rule::required("reviewedBy.source"),
    Rule::one_of("reviewedBy.source", MemorySource::STRINGS),
];

/// The private paths: their read type fields are [`crate::Private`].
pub const PRIVATE: &[&str] = &["content", "summary", "sourceEvidence"];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::not_null("channel"),
    ReadNeed::value("type"),
    ReadNeed::not_null("status"),
    ReadNeed::not_null("risk"),
    ReadNeed::not_null("confidence"),
    ReadNeed::not_null("subject"),
    ReadNeed::not_null("subject.scope"),
    ReadNeed::not_null("subject.username"),
    ReadNeed::not_null("subject.userID"),
    ReadNeed::value("content"),
    ReadNeed::value("summary"),
    ReadNeed::value("fingerprint"),
    ReadNeed::not_null("sourceEvidence"),
    ReadNeed::not_null("sourceEvidence.$.source"),
    ReadNeed::not_null("sourceEvidence.$.username"),
    ReadNeed::not_null("sourceEvidence.$.userID"),
    ReadNeed::not_null("sourceEvidence.$.message"),
    ReadNeed::not_null("sourceEvidence.$.messageId"),
    ReadNeed::not_null("createdBy"),
    ReadNeed::not_null("createdBy.source"),
    ReadNeed::not_null("createdBy.username"),
    ReadNeed::not_null("createdBy.userID"),
    ReadNeed::not_null("reviewedBy.source"),
    ReadNeed::not_null("reviewedBy.username"),
    ReadNeed::not_null("reviewedBy.userID"),
    ReadNeed::not_null("reviewReason"),
    ReadNeed::not_null("useCount"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "ChannelAIMemory",
    source: "dimabot/src/schemas/channel_ai_memory.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<ChannelAiMemory>,
};

/// A stored memory.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelAiMemory {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The Qdrant point id (missing on a few old memories).
    #[serde(default, rename = "qdrantPointID")]
    pub qdrant_point_id: Option<JsNumber>,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    #[serde(default = "unknown")]
    pub channel: String,
    /// The kind of memory.
    #[serde(rename = "type")]
    pub kind: Open<MemoryType>,
    /// Review status.
    #[serde(default = "candidate")]
    pub status: Open<MemoryStatus>,
    /// Risk.
    #[serde(default = "low")]
    pub risk: Open<MemoryRisk>,
    /// Confidence (0 to 1).
    #[serde(default = "half")]
    pub confidence: JsNumber,
    /// Who it is about.
    #[serde(default)]
    pub subject: MemorySubject,
    /// The memory.
    pub content: Private<String>,
    /// Its summary.
    pub summary: Private<String>,
    /// Dedupe fingerprint (unique per channel).
    pub fingerprint: String,
    /// The chat messages it was learned from.
    #[serde(default, rename = "sourceEvidence")]
    pub source_evidence: Private<Vec<MemoryEvidence>>,
    /// Who created it.
    #[serde(default = "system", rename = "createdBy")]
    pub created_by: MemoryActor,
    /// Who reviewed it.
    #[serde(default, rename = "reviewedBy")]
    pub reviewed_by: Option<MemoryActor>,
    /// Why it has its status.
    #[serde(default = "empty", rename = "reviewReason")]
    pub review_reason: String,
    /// When it was reviewed.
    #[serde(default, rename = "reviewedAt")]
    pub reviewed_at: Option<JsDate>,
    /// Times the AI used it.
    #[serde(default = "zero", rename = "useCount")]
    pub use_count: JsNumber,
    /// Last use.
    #[serde(default, rename = "lastUsedAt")]
    pub last_used_at: Option<JsDate>,
    /// Expiry (never set by the reference).
    #[serde(default, rename = "expiresAt")]
    pub expires_at: Option<JsDate>,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

fn unknown() -> String {
    "Unknown".to_owned()
}

fn candidate() -> Open<MemoryStatus> {
    Open::Known(MemoryStatus::Candidate)
}

fn low() -> Open<MemoryRisk> {
    Open::Known(MemoryRisk::Low)
}

fn half() -> JsNumber {
    JsNumber(0.5)
}

fn system() -> MemoryActor {
    MemoryActor {
        source: Open::Known(MemorySource::System),
        username: String::new(),
        user_id: String::new(),
    }
}

/// `subject`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct MemorySubject {
    /// Channel or user.
    #[serde(default = "channel_scope")]
    pub scope: Open<SubjectScope>,
    /// The viewer's login.
    #[serde(default = "empty")]
    pub username: String,
    /// The viewer's Twitch id.
    #[serde(default = "empty", rename = "userID")]
    pub user_id: String,
}

fn channel_scope() -> Open<SubjectScope> {
    Open::Known(SubjectScope::Channel)
}

impl Default for MemorySubject {
    fn default() -> Self {
        Self {
            scope: channel_scope(),
            username: String::new(),
            user_id: String::new(),
        }
    }
}

/// `sourceEvidence[]`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct MemoryEvidence {
    /// Where it came from.
    #[serde(default = "chat")]
    pub source: Open<MemorySource>,
    /// The author's login.
    #[serde(default = "empty")]
    pub username: String,
    /// The author's Twitch id.
    #[serde(default = "empty", rename = "userID")]
    pub user_id: String,
    /// The message.
    #[serde(default = "empty")]
    pub message: String,
    /// The message id.
    #[serde(default = "empty", rename = "messageId")]
    pub message_id: String,
    /// When (epoch seconds; the default is the write time, not applied on read).
    #[serde(default)]
    pub timestamp: Option<JsNumber>,
}

fn chat() -> Open<MemorySource> {
    Open::Known(MemorySource::Chat)
}

/// `createdBy`, `reviewedBy`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct MemoryActor {
    /// Where it came from.
    #[serde(default = "system_source")]
    pub source: Open<MemorySource>,
    /// The actor's login.
    #[serde(default = "empty")]
    pub username: String,
    /// The actor's Twitch id.
    #[serde(default = "empty", rename = "userID")]
    pub user_id: String,
}

fn system_source() -> Open<MemorySource> {
    Open::Known(MemorySource::System)
}

/// A new memory (`new ChannelAIMemorySchema({...})` in `memory.service.ts:406`).
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelAiMemory {
    /// `_id` (the reference generates it first: the Qdrant point id derives from it).
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The Qdrant point id.
    #[serde(rename = "qdrantPointID")]
    pub qdrant_point_id: JsNumber,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    pub channel: String,
    /// The kind of memory.
    #[serde(rename = "type")]
    pub kind: MemoryType,
    /// Review status.
    pub status: MemoryStatus,
    /// Risk.
    pub risk: MemoryRisk,
    /// Confidence.
    pub confidence: JsNumber,
    /// Who it is about.
    pub subject: NewMemorySubject,
    /// The memory.
    pub content: Private<String>,
    /// Its summary.
    pub summary: Private<String>,
    /// Dedupe fingerprint.
    pub fingerprint: String,
    /// The chat messages it was learned from.
    #[serde(rename = "sourceEvidence")]
    pub source_evidence: Private<Vec<NewMemoryEvidence>>,
    /// Who created it.
    #[serde(rename = "createdBy")]
    pub created_by: NewMemoryActor,
    /// Why it has its status.
    #[serde(rename = "reviewReason")]
    pub review_reason: String,
    /// Creation time (the reference passes it).
    #[serde(rename = "createdAt")]
    pub created_at: JsDate,
    /// Update time (the reference passes it).
    #[serde(rename = "updatedAt")]
    pub updated_at: JsDate,
}

/// The subject of a new memory.
#[derive(Clone, Debug, Serialize)]
pub struct NewMemorySubject {
    /// Channel or user.
    pub scope: SubjectScope,
    /// The viewer's login.
    pub username: String,
    /// The viewer's Twitch id.
    #[serde(rename = "userID")]
    pub user_id: String,
}

/// The creator of a new memory.
#[derive(Clone, Debug, Serialize)]
pub struct NewMemoryActor {
    /// Where it came from.
    pub source: MemorySource,
    /// The actor's login.
    pub username: String,
    /// The actor's Twitch id.
    #[serde(rename = "userID")]
    pub user_id: String,
}

/// Evidence of a new memory.
#[derive(Clone, Debug, Serialize)]
pub struct NewMemoryEvidence {
    /// Where it came from.
    pub source: MemorySource,
    /// The author's login.
    pub username: String,
    /// The author's Twitch id.
    #[serde(rename = "userID")]
    pub user_id: String,
    /// The message.
    pub message: String,
    /// The message id.
    #[serde(rename = "messageId")]
    pub message_id: String,
    /// Epoch seconds.
    pub timestamp: JsNumber,
}

impl NewChannelAiMemory {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
