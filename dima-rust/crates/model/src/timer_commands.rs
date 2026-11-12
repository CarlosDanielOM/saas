//! `timer_commands`: a command scheduled to repeat on a timer (the legacy timer feature).
//!
//! Reference: `dimabot/src/schemas/command_timer.schema.ts` (model `timer_command`). No
//! timestamps (a hand-written `createdAt` with `Date.now`), `__v`, no hooks, no index. Empty in
//! the production copy.

use crate::collection::CollectionInfo;
use crate::decode::decode;
use crate::defaults::{utc_day, utc_month, utc_year};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::validation::Rule;
use bson::oid::ObjectId;
use bson::{Document, RawDocument};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "timer_commands";

/// `date: { day, month, year }` with the calendar defaults of the creation day (UTC).
pub(crate) const CREATION_DATE: &[Field] = &[
    Field::number("day").default_fn(D::With(utc_day)),
    Field::number("month").default_fn(D::With(utc_month)),
    Field::number("year").default_fn(D::With(utc_year)),
];

/// The schema, field by field as `command_timer.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("command"),
    Field::number("timer"),
    Field::string("channel"),
    Field::string("channelID"),
    Field::date("createdAt").default_fn(D::Now),
    Field::nested("date", CREATION_DATE),
]);

/// The `select: false` paths (none).
pub const HIDDEN: &[&str] = &[];

/// The declared indexes (none).
pub const INDEXES: &[IndexSpec] = &[];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("command"),
    Rule::required("timer"),
    Rule::required("channel"),
    Rule::required("channelID"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "timer_command",
    source: "dimabot/src/schemas/command_timer.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    decode: |raw: &RawDocument| decode::<TimerCommand>(raw).map(drop),
};

/// A stored timer command.
#[derive(Clone, Debug, Deserialize)]
pub struct TimerCommand {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The command name.
    pub command: String,
    /// The interval.
    pub timer: JsNumber,
    /// The channel login.
    pub channel: String,
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// Creation time (`default: Date.now`, not applied on read).
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// The creation day.
    #[serde(default)]
    pub date: CreationDate,
}

/// `date`: the calendar day a document was created (UTC). Each part is `None` when missing (its
/// default is the read day, which a read does not invent).
#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct CreationDate {
    /// Day of the month, 1 to 31.
    #[serde(default)]
    pub day: Option<JsNumber>,
    /// Month, 1 to 12.
    #[serde(default)]
    pub month: Option<JsNumber>,
    /// Year.
    #[serde(default)]
    pub year: Option<JsNumber>,
}

/// A new timer command.
#[derive(Clone, Debug, Serialize)]
pub struct NewTimerCommand {
    /// The command name.
    pub command: String,
    /// The interval.
    pub timer: JsNumber,
    /// The channel login.
    pub channel: String,
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
}

impl NewTimerCommand {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends, refused like Mongoose's validation would refuse it.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
