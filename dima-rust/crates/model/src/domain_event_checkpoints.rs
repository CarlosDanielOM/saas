//! `domain_event_checkpoints`: how far a journal consumer has read one topic.
//!
//! Reference: `dimabot/src/schemas/domain_event_checkpoint.schema.ts`. Camel-case timestamps, no
//! `__v`, no hooks. Unique `{consumer, topic}`.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode;
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::validation::Rule;
use bson::oid::ObjectId;
use bson::{Document, RawDocument};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::schema::{Field, Schema, Timestamps};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "domain_event_checkpoints";

/// The schema, field by field.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("consumer"),
    Field::string("topic"),
    Field::object_id("lastEventID"),
])
.timestamps(Timestamps::CAMEL)
.no_version_key();

/// The declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("consumer", 1), ("topic", 1)]).unique()];

/// The validators.
pub const RULES: &[Rule] = &[
    Rule::required("consumer"),
    Rule::required("topic"),
    Rule::required("lastEventID"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "domain_event_checkpoint",
    source: "dimabot/src/schemas/domain_event_checkpoint.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    hooks: Hooks::None,
    decode: |raw: &RawDocument| decode::<Checkpoint>(raw).map(drop),
};

/// A stored checkpoint.
#[derive(Clone, Debug, Deserialize)]
pub struct Checkpoint {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The consumer name.
    pub consumer: String,
    /// The topic.
    pub topic: String,
    /// The last event read (`domain_events._id`).
    #[serde(rename = "lastEventID")]
    pub last_event_id: ObjectId,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

/// A new checkpoint.
#[derive(Clone, Debug, Serialize)]
pub struct NewCheckpoint {
    /// The consumer name.
    pub consumer: String,
    /// The topic.
    pub topic: String,
    /// The last event read.
    #[serde(rename = "lastEventID")]
    pub last_event_id: ObjectId,
}

impl NewCheckpoint {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends, refused like Mongoose's validation would refuse it.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
