//! `streamsessions`: one live stream of a channel, from the first live snapshot to the offline
//! close, with its viewer statistics and counters.
//!
//! Reference: `dimabot/src/schemas/stream_session.schema.ts` (model `StreamSession`). Snake-case
//! timestamps, `__v`, no hooks. At most one open session per channel (unique partial index on
//! `{channelID, ended_at}` where `ended_at` is `null`). `applied_domain_event_keys` is
//! `select: false`: a save must not load the document without it (see the crate docs).
//!
//! Client-fed writes (`null` from a request body): none: its writers (`ledger/mongo.json`) store
//! values the server builds or checks, and no request body reaches them unchecked.
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
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps, ValueType};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "streamsessions";

str_enum! {
    /// `status`.
    pub enum SessionStatus {
        /// The stream is live (the default).
        Live = "live",
        /// The stream ended.
        Offline = "offline",
        /// Closed without an offline signal.
        Orphaned = "orphaned",
    }
}

str_enum! {
    /// `closure_source`: what closed the session.
    pub enum ClosureSource {
        /// A viewer snapshot saw the stream offline.
        Snapshot = "snapshot",
        /// A newer session of the channel replaced it.
        Superseded = "superseded",
        /// A `stream.offline` EventSub notification.
        Eventsub = "eventsub",
    }
}

/// The schema, field by field as `stream_session.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("channel").default(D::Str("")),
    Field::string("stream_id"),
    Field::date("started_at"),
    Field::date("ended_at").default(D::Null),
    Field::string("status").default(D::Str("live")),
    Field::string("closure_source"),
    Field::date("chat_tracking_started_at"),
    Field::number("peak_viewers").default(D::Int(0)),
    Field::number("average_viewers").default(D::Int(0)),
    Field::number("sample_count").default(D::Int(0)),
    Field::number("sample_total_viewers").default(D::Int(0)),
    Field::number("duration_minutes").default(D::Int(0)),
    Field::number("follows").default(D::Int(0)),
    Field::number("subs").default(D::Int(0)),
    Field::number("bits").default(D::Int(0)),
    Field::number("donations").default(D::Int(0)),
    Field::number("messages").default(D::Int(0)),
    Field::number("commands").default(D::Int(0)),
    Field::array("applied_domain_event_keys", ValueType::String),
    Field::date("offline_summary_enqueued_at").default(D::Null),
    Field::date("offline_clips_completed_at").default(D::Null),
    Field::date("last_seen_live_at").default(D::Null),
    Field::number("consecutive_offline_checks").default(D::Int(0)),
])
.timestamps(Timestamps::SNAKE);

/// The `select: false` paths.
pub const HIDDEN: &[&str] = &["applied_domain_event_keys"];

fn open_session() -> Document {
    doc! { "ended_at": Bson::Null }
}

/// The declared indexes (field-level `index: true` first, as Mongoose lists them).
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1)]),
    IndexSpec::on(&[("stream_id", 1)]),
    IndexSpec::on(&[("started_at", 1)]),
    IndexSpec::on(&[("ended_at", 1)]),
    IndexSpec::on(&[("status", 1)]),
    IndexSpec::on(&[("channelID", 1), ("started_at", -1)]),
    IndexSpec::on(&[("channelID", 1), ("started_at", -1), ("ended_at", 1)]),
    IndexSpec::on(&[("channelID", 1), ("stream_id", 1)]).unique(),
    IndexSpec::on(&[("channelID", 1), ("ended_at", 1)])
        .partial(open_session)
        .unique(),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("stream_id"),
    Rule::required("started_at"),
    Rule::one_of("status", SessionStatus::STRINGS),
    Rule::one_of("closure_source", ClosureSource::STRINGS),
];

/// The private paths: their read type fields are [`crate::Private`].
pub const PRIVATE: &[&str] = &["applied_domain_event_keys"];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::not_null("channel"),
    ReadNeed::value("stream_id"),
    ReadNeed::value("started_at"),
    ReadNeed::not_null("status"),
    ReadNeed::not_null("peak_viewers"),
    ReadNeed::not_null("average_viewers"),
    ReadNeed::not_null("sample_count"),
    ReadNeed::not_null("sample_total_viewers"),
    ReadNeed::not_null("duration_minutes"),
    ReadNeed::not_null("follows"),
    ReadNeed::not_null("subs"),
    ReadNeed::not_null("bits"),
    ReadNeed::not_null("donations"),
    ReadNeed::not_null("messages"),
    ReadNeed::not_null("commands"),
    ReadNeed::not_null("consecutive_offline_checks"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "StreamSession",
    source: "dimabot/src/schemas/stream_session.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<StreamSession>,
};

/// A stored stream session.
#[derive(Clone, Debug, Deserialize)]
pub struct StreamSession {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    #[serde(default = "empty")]
    pub channel: String,
    /// Twitch's stream id.
    pub stream_id: String,
    /// Stream start.
    pub started_at: JsDate,
    /// Stream end (`None` while open).
    #[serde(default)]
    pub ended_at: Option<JsDate>,
    /// Status.
    #[serde(default = "live")]
    pub status: Open<SessionStatus>,
    /// What closed the session.
    #[serde(default)]
    pub closure_source: Option<Open<ClosureSource>>,
    /// When chat tracking started.
    #[serde(default)]
    pub chat_tracking_started_at: Option<JsDate>,
    /// Peak viewers.
    #[serde(default = "zero")]
    pub peak_viewers: JsNumber,
    /// Average viewers.
    #[serde(default = "zero")]
    pub average_viewers: JsNumber,
    /// Viewer samples taken.
    #[serde(default = "zero")]
    pub sample_count: JsNumber,
    /// Sum of the sampled viewers.
    #[serde(default = "zero")]
    pub sample_total_viewers: JsNumber,
    /// Duration (fractional minutes).
    #[serde(default = "zero")]
    pub duration_minutes: JsNumber,
    /// Follows during the stream.
    #[serde(default = "zero")]
    pub follows: JsNumber,
    /// Subs during the stream.
    #[serde(default = "zero")]
    pub subs: JsNumber,
    /// Bits during the stream.
    #[serde(default = "zero")]
    pub bits: JsNumber,
    /// Donations during the stream.
    #[serde(default = "zero")]
    pub donations: JsNumber,
    /// Chat messages during the stream.
    #[serde(default = "zero")]
    pub messages: JsNumber,
    /// Commands run during the stream.
    #[serde(default = "zero")]
    pub commands: JsNumber,
    /// Domain events already counted (`select: false`: `None` unless the read selected it).
    #[serde(default)]
    pub applied_domain_event_keys: Option<Private<Vec<String>>>,
    /// When the offline summary was queued.
    #[serde(default)]
    pub offline_summary_enqueued_at: Option<JsDate>,
    /// When the offline clips finished.
    #[serde(default)]
    pub offline_clips_completed_at: Option<JsDate>,
    /// Last snapshot that saw the stream live.
    #[serde(default)]
    pub last_seen_live_at: Option<JsDate>,
    /// Offline snapshots in a row.
    #[serde(default = "zero")]
    pub consecutive_offline_checks: JsNumber,
    /// Creation time.
    #[serde(default)]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default)]
    pub updated_at: Option<JsDate>,
}

fn live() -> Open<SessionStatus> {
    Open::Known(SessionStatus::Live)
}

/// A new session.
#[derive(Clone, Debug, Serialize)]
pub struct NewStreamSession {
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// Twitch's stream id.
    pub stream_id: String,
    /// Stream start.
    pub started_at: JsDate,
    /// Status (default `live`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<SessionStatus>,
    /// Last snapshot that saw the stream live.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_live_at: Option<JsDate>,
}

impl NewStreamSession {
    /// A live session of `channel_id`.
    pub fn new(
        channel_id: impl Into<String>,
        stream_id: impl Into<String>,
        started_at: JsDate,
    ) -> Self {
        Self {
            channel_id: channel_id.into(),
            channel: None,
            stream_id: stream_id.into(),
            started_at,
            status: None,
            last_seen_live_at: None,
        }
    }

    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends, refused like Mongoose's validation would refuse it.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
