//! `channelconfigs`: an early per-channel configuration document.
//!
//! Reference: `dimabot/src/schemas/channel_config.schema.ts` (model `channelconfig`). No
//! timestamps, `__v`, no hooks, no index, no default. No code of the reference imports the
//! model, so production never created the collection and the copy has no document: the read type
//! follows the schema only. `commands` (an untyped array) stays raw.
//!
//! Client-fed writes (`null` from a request body): none (no process imports the schema).
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none (`commands`, the
//! `date` object); with no data, nothing shows them stored.

use crate::collection::{ClientNulls, CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::error::ModelError;
use crate::shape::ReadNeed;
use bson::oid::ObjectId;
use bson::{Bson, Document};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::schema::{Field, Schema};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "channelconfigs";

const DATE: &[Field] = &[
    Field::string("day"),
    Field::string("month"),
    Field::string("year"),
];

/// The schema, field by field as `channel_config.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::object_id("channel_id"),
    Field::string("channel"),
    Field::mixed_array("commands"),
    Field::date("createdAt"),
    Field::nested("date", DATE),
]);

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[ReadNeed::not_null("commands"), ReadNeed::not_null("date")];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "channelconfig",
    source: "dimabot/src/schemas/channel_config.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: &[],
    rules: &[],
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    // No process of the reference imports the schema (`ledger/modules.json`: unreachable).
    initialised_at_startup: false,
    private: &[],
    decode: decode_boxed::<ChannelConfig>,
};

/// A stored channel configuration.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelConfig {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The channel's document id.
    #[serde(default)]
    pub channel_id: Option<ObjectId>,
    /// The channel login.
    #[serde(default)]
    pub channel: Option<String>,
    /// The commands, as stored.
    #[serde(default)]
    pub commands: ChannelConfigCommands,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// The creation day as text.
    #[serde(default)]
    pub date: ChannelConfigDate,
}

/// The untyped `commands` array, kept as stored.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ChannelConfigCommands(pub Vec<Bson>);

/// `date` (`{day, month, year}` as strings).
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct ChannelConfigDate {
    /// Day of the month.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day: Option<String>,
    /// Month.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub month: Option<String>,
    /// Year.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
}

/// A new channel configuration (no create path is left in the reference).
#[derive(Clone, Debug, Default, Serialize)]
pub struct NewChannelConfig {
    /// The channel's document id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<ObjectId>,
    /// The channel login.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// The commands.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commands: Option<Vec<Bson>>,
    /// Creation time.
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<JsDate>,
    /// The creation day.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<ChannelConfigDate>,
}

impl NewChannelConfig {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
