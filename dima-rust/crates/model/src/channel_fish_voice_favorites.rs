//! `channel_fish_voice_favorites`: the Fish Audio voices a channel saved, each with the nickname
//! chat uses to pick it.
//!
//! Reference: `dimabot/src/schemas/channel_fish_voice_favorites.schema.ts` (model
//! `channel_fish_voice_favorites`, which also holds the writers): an upsert with `$setOnInsert`,
//! a guarded `$push` (`$expr` on the size, at most 20), `$pull` by id and an `arrayFilters`
//! `$set` of an alias. No timestamps, `__v`, no hooks. Unique `channelID` (field level), best
//! effort (the upsert on it; nothing awaits it). `favorites` elements have no `_id`. Legacy
//! shape: none (two documents have an empty list).
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use bson::Document;
use bson::oid::ObjectId;
use dima_store::mongo::WriteContext;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "channel_fish_voice_favorites";

/// Most favorites per channel (`MAX_FISH_VOICE_FAVORITES`).
pub const MAX_FAVORITES: usize = 20;

static FAVORITE: Schema = Schema::subdocument(&[
    Field::string("id"),
    Field::string("name"),
    Field::string("alias"),
])
.no_id();

/// The schema, field by field as `channel_fish_voice_favorites.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::document_array("favorites", &FAVORITE).default(D::EmptyArray),
]);

/// The declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("channelID", 1)]).unique()];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("favorites.$.id"),
    Rule::required("favorites.$.name"),
    Rule::required("favorites.$.alias"),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::not_null("favorites"),
    ReadNeed::value("favorites.$.id"),
    ReadNeed::value("favorites.$.name"),
    ReadNeed::value("favorites.$.alias"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "channel_fish_voice_favorites",
    source: "dimabot/src/schemas/channel_fish_voice_favorites.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    private: &[],
    decode: decode_boxed::<ChannelFishVoiceFavorites>,
};

/// A channel's favorites.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelFishVoiceFavorites {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The saved voices, in the order they were added.
    #[serde(default)]
    pub favorites: Vec<FishVoiceFavorite>,
}

/// `favorites[]`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct FishVoiceFavorite {
    /// The Fish Audio model id.
    pub id: String,
    /// The voice's name.
    pub name: String,
    /// The nickname chat uses.
    pub alias: String,
}

/// A new favorites document (the reference upserts it with `favorites: []`).
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelFishVoiceFavorites {
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The saved voices.
    pub favorites: Vec<FishVoiceFavorite>,
}

impl NewChannelFishVoiceFavorites {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
