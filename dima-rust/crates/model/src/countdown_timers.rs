//! `countdowntimers` and `countdowntimerconfigs`: the subathon countdown of a channel and what
//! each event adds to it (seconds per bit, sub tier, follow, raid, viewer and donation).
//!
//! Reference: `dimabot/src/schemas/countdown_timer.schema.ts` (model `Countdowntimer`) and
//! `countdown_timer_config.schema.ts` (`Countdowntimerconfig`). No timestamps, `__v`, no hooks,
//! no index.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] and [`CONFIG_READ_NEEDS`] say the read types have
//! none; the census of the production copy shows none stored there, so Mongoose's acceptance of
//! them is not reproduced.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::zero;
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use bson::Document;
use bson::oid::ObjectId;
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use serde::{Deserialize, Serialize};

/// The countdown collection.
pub const COLLECTION: &str = "countdowntimers";
/// The configuration collection.
pub const CONFIG_COLLECTION: &str = "countdowntimerconfigs";

/// The countdown schema, field by field.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channel"),
    Field::string("channelID"),
    Field::number("startTime"),
    Field::date("resumedAt"),
    Field::date("pausedAt"),
    Field::number("time").default(D::Int(0)),
    Field::boolean("paused").default(D::Bool(false)),
    Field::boolean("active").default(D::Bool(true)),
]);

/// The countdown validators.
pub const RULES: &[Rule] = &[
    Rule::required("channel"),
    Rule::required("channelID"),
    Rule::required("startTime"),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channel"),
    ReadNeed::value("channelID"),
    ReadNeed::value("startTime"),
    ReadNeed::not_null("time"),
    ReadNeed::not_null("paused"),
    ReadNeed::not_null("active"),
];

/// The countdown registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "Countdowntimer",
    source: "dimabot/src/schemas/countdown_timer.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: &[] as &[IndexSpec],
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    initialised_at_startup: true,
    private: &[],
    decode: decode_boxed::<Countdown>,
};

/// The configuration schema, field by field.
pub static CONFIG_SCHEMA: Schema = Schema::new(&[
    Field::string("channel"),
    Field::string("channelID"),
    Field::number("bits"),
    Field::number("tier1"),
    Field::number("tier2"),
    Field::number("tier3"),
    Field::number("follows"),
    Field::number("raids"),
    Field::number("viewers"),
    Field::number("donations"),
]);

/// The configuration validators.
pub const CONFIG_RULES: &[Rule] = &[
    Rule::required("channel"),
    Rule::required("channelID"),
    Rule::required("bits"),
    Rule::required("tier1"),
    Rule::required("tier2"),
    Rule::required("tier3"),
    Rule::required("follows"),
    Rule::required("raids"),
    Rule::required("viewers"),
    Rule::required("donations"),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const CONFIG_READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channel"),
    ReadNeed::value("channelID"),
    ReadNeed::value("bits"),
    ReadNeed::value("tier1"),
    ReadNeed::value("tier2"),
    ReadNeed::value("tier3"),
    ReadNeed::value("follows"),
    ReadNeed::value("raids"),
    ReadNeed::value("viewers"),
    ReadNeed::value("donations"),
];

/// The configuration registry entry.
pub static CONFIG_INFO: CollectionInfo = CollectionInfo {
    name: CONFIG_COLLECTION,
    model: "Countdowntimerconfig",
    source: "dimabot/src/schemas/countdown_timer_config.schema.ts",
    schema: &CONFIG_SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: &[] as &[IndexSpec],
    rules: CONFIG_RULES,
    read_needs: CONFIG_READ_NEEDS,
    hooks: Hooks::None,
    initialised_at_startup: true,
    private: &[],
    decode: decode_boxed::<CountdownConfig>,
};

/// A stored countdown.
#[derive(Clone, Debug, Deserialize)]
pub struct Countdown {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The channel login.
    pub channel: String,
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The starting length.
    #[serde(rename = "startTime")]
    pub start_time: JsNumber,
    /// When it was last resumed.
    #[serde(default, rename = "resumedAt")]
    pub resumed_at: Option<JsDate>,
    /// When it was last paused.
    #[serde(default, rename = "pausedAt")]
    pub paused_at: Option<JsDate>,
    /// Time left.
    #[serde(default = "zero")]
    pub time: JsNumber,
    /// Paused.
    #[serde(default)]
    pub paused: bool,
    /// Active.
    #[serde(default = "crate::defaults::yes")]
    pub active: bool,
}

/// A new countdown.
#[derive(Clone, Debug, Serialize)]
pub struct NewCountdown {
    /// The channel login.
    pub channel: String,
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The starting length.
    #[serde(rename = "startTime")]
    pub start_time: JsNumber,
}

impl NewCountdown {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends, refused like Mongoose's validation would refuse it.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}

/// A stored countdown configuration: what each event adds.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CountdownConfig {
    /// `_id`.
    #[serde(rename = "_id", skip_serializing)]
    pub id: Option<ObjectId>,
    /// The channel login.
    pub channel: String,
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// Per bit.
    pub bits: JsNumber,
    /// Per tier 1 sub.
    pub tier1: JsNumber,
    /// Per tier 2 sub.
    pub tier2: JsNumber,
    /// Per tier 3 sub.
    pub tier3: JsNumber,
    /// Per follow.
    pub follows: JsNumber,
    /// Per raid.
    pub raids: JsNumber,
    /// Per viewer.
    pub viewers: JsNumber,
    /// Per donation.
    pub donations: JsNumber,
}

impl CountdownConfig {
    /// A configuration to insert (every field is required, so the read type is the input type;
    /// `id` is ignored).
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        CONFIG_INFO.prepare_create(&bson::serialize_to_document(self)?, ctx)
    }
}
