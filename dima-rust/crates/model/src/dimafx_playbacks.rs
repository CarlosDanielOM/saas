//! `dimafxplaybacks`: the durable DimaFX playback queue of a channel's overlay (one job per
//! purchase, leased by the API process that plays it), kept 365 days as playback receipts.
//!
//! Reference: `dimabot/src/schemas/dimafx_playback.schema.ts` (model `DimafxPlayback`), written
//! only by `handlers/dimafx_queue.handler.ts`: an upsert with `$setOnInsert` on the job's string
//! `_id` (`bits-<ledger id>` for Bits purchases, so a retried request finds its job), then
//! lease-fenced `$set`s of `state`, `leaseOwner`, `leaseUntil`, `failure` and `widgetSentAt`.
//! Camel-case timestamps, `__v`, no hooks. Indexes `{channelID, state, createdAt}` and the TTL on
//! `createdAt` (365 days). `leaseUntil` defaults to the epoch (`() => new Date(0)`).
//!
//! `payload` (`Mixed`, the queue item) stays raw ([`PlaybackPayload`]) and is private: it holds
//! the viewer's TTS text and the buyer's id. The production copy holds no job.
//!
//! Client-fed writes (`null` from a request body): none: its writers (`ledger/mongo.json`) store
//! values the server builds or checks, and no request body reaches them unchecked.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; with no stored job
//! the census shows nothing, and the reference never writes those `null`s.

use crate::collection::{ClientNulls, CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::empty;
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::extension_wallet_transactions::RETENTION_SECONDS;
use crate::index::IndexSpec;
use crate::private::Private;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use bson::{Bson, Document};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "dimafxplaybacks";

str_enum! {
    /// `state`.
    pub enum PlaybackState {
        /// Waiting (the default).
        Queued = "queued",
        /// Sent to the overlay.
        Playing = "playing",
        /// Failed; the viewer is being refunded.
        Refunding = "refunding",
        /// Played.
        Completed = "completed",
        /// Refunded.
        Refunded = "refunded",
    }
}

/// The schema, field by field as `dimafx_playback.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelID"),
    Field::mixed("payload"),
    Field::string("state").default(D::Str("queued")),
    Field::string("leaseOwner").default(D::Str("")),
    Field::date("leaseUntil").default_fn(D::DateMs(0)),
    Field::string("failure"),
    Field::date("widgetSentAt"),
])
.declared_id()
.timestamps(Timestamps::CAMEL);

/// The declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1), ("state", 1), ("createdAt", 1)]),
    IndexSpec::on(&[("createdAt", 1)]).expire_after_seconds(RETENTION_SECONDS),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("_id"),
    Rule::required("channelID"),
    Rule::required("payload"),
    Rule::one_of("state", PlaybackState::STRINGS),
];

/// The private paths: their read type fields are [`crate::Private`].
pub const PRIVATE: &[&str] = &["payload"];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("channelID"),
    ReadNeed::present("payload"),
    ReadNeed::not_null("state"),
    ReadNeed::not_null("leaseOwner"),
    ReadNeed::not_null("leaseUntil"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "DimafxPlayback",
    source: "dimabot/src/schemas/dimafx_playback.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::String,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<DimafxPlayback>,
};

/// A stored playback job.
#[derive(Clone, Debug, Deserialize)]
pub struct DimafxPlayback {
    /// `_id`: the trigger id (`bits-<ledger id>` for Bits purchases).
    #[serde(rename = "_id")]
    pub id: String,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The queue item, as stored.
    pub payload: Private<PlaybackPayload>,
    /// Where it is.
    #[serde(default = "queued")]
    pub state: Open<PlaybackState>,
    /// The process holding the lease (`''` when free).
    #[serde(default = "empty", rename = "leaseOwner")]
    pub lease_owner: String,
    /// Lease expiry (the epoch when free).
    #[serde(default = "epoch", rename = "leaseUntil")]
    pub lease_until: JsDate,
    /// Why playback failed.
    #[serde(default)]
    pub failure: Option<String>,
    /// When custom widgets were told about the purchase.
    #[serde(default, rename = "widgetSentAt")]
    pub widget_sent_at: Option<JsDate>,
    /// Creation time (the TTL counts from it).
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

fn queued() -> Open<PlaybackState> {
    Open::Known(PlaybackState::Queued)
}

fn epoch() -> JsDate {
    JsDate(0)
}

/// The queue item (`DimafxQueueItem`), kept as stored until the DimaFX package types it.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct PlaybackPayload(pub Bson);

/// A new job (the reference upserts it with these values in `$setOnInsert`).
#[derive(Clone, Debug, Serialize)]
pub struct NewDimafxPlayback {
    /// The trigger id.
    #[serde(rename = "_id")]
    pub id: String,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The queue item.
    pub payload: Private<Document>,
    /// `queued`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<PlaybackState>,
    /// `''`.
    #[serde(rename = "leaseOwner", skip_serializing_if = "Option::is_none")]
    pub lease_owner: Option<String>,
    /// The epoch.
    #[serde(rename = "leaseUntil", skip_serializing_if = "Option::is_none")]
    pub lease_until: Option<JsDate>,
}

impl NewDimafxPlayback {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
