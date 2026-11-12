//! `clipdesigns`: reference `dimabot/src/schemas/clip_design.schema.ts`.
//! No timestamp option: createdAt/updatedAt use Date.now; __v; unique global name.
//! pre(save) #1 overwrites updatedAt with the write clock after validation, on create and save.
//! pre(save) #2, when isDefault is true, awaits updateMany({channelID,_id:{$ne:self}},
//! {isDefault:false}) BEFORE inserting/saving self; ordinary updates run neither hook.
//! PreparedDesignInsert/PreparedDesignSave carry that companion write; execute() runs it first.
//! This is intentionally not transactional: a later duplicate-name failure leaves peers cleared.
//! Client-fed writes: none in the frozen reference. Checked server/routes/clip.route.ts:20
//! (custom designs explicitly pending), all server/services/site_agent references, and
//! utils/account_deletion.ts:160 (deleteMany only). The production copy is empty.
//! No legacy shapes or runValidators call sites. Server-only READ_NEEDS nulls/removals refused.
//! The schema has no free-form layout field; overlay designs are another store, not this model.
use crate::Private;
use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, date::JsDate, id::IdType, insert::PreparedInsert};
use serde::{Deserialize, Serialize};
fn default_is_public() -> bool {
    false
}
fn default_is_default() -> bool {
    false
}
/// Collection name.
pub const COLLECTION: &str = "clipdesigns";
/// Frozen schema.
static SCHEMA: Schema = Schema::new(&[
    Field::string("name"),
    Field::string("channelID"),
    Field::string("channel"),
    Field::string("cssUrl"),
    Field::boolean("isPublic").default(D::Bool(false)),
    Field::boolean("isDefault").default(D::Bool(false)),
    Field::date("createdAt").default_fn(D::Now),
    Field::date("updatedAt").default_fn(D::Now),
]);
/// Hidden fields.
pub const HIDDEN: &[&str] = &[];
/// Private fields.
pub const PRIVATE: &[&str] = &["name", "cssUrl"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("name", 1)]).unique()];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("name"),
    Rule::required("channelID"),
    Rule::required("channel"),
    Rule::required("cssUrl"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("name"),
    ReadNeed::value("channelID"),
    ReadNeed::value("channel"),
    ReadNeed::value("cssUrl"),
    ReadNeed::not_null("isPublic"),
    ReadNeed::not_null("isDefault"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "ClipDesign",
    source: "dimabot/src/schemas/clip_design.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::Save,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<ClipDesign>,
};
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ClipDesign {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `name`.
    #[serde(rename = "name")]
    pub name: Private<String>,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `cssUrl`.
    #[serde(rename = "cssUrl")]
    pub css_url: Private<String>,
    /// `isPublic`.
    #[serde(rename = "isPublic", default = "default_is_public")]
    pub is_public: bool,
    /// `isDefault`.
    #[serde(rename = "isDefault", default = "default_is_default")]
    pub is_default: bool,
    /// `createdAt`.
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<JsDate>,
    /// `updatedAt`.
    #[serde(rename = "updatedAt", default)]
    pub updated_at: Option<JsDate>,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewClipDesign {
    /// `name`.
    #[serde(rename = "name")]
    pub name: Private<String>,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `cssUrl`.
    #[serde(rename = "cssUrl")]
    pub css_url: Private<String>,
    /// `isPublic`.
    #[serde(rename = "isPublic", skip_serializing_if = "Option::is_none")]
    pub is_public: Option<bool>,
    /// `isDefault`.
    #[serde(rename = "isDefault", skip_serializing_if = "Option::is_none")]
    pub is_default: Option<bool>,
    /// `createdAt`.
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<JsDate>,
    /// `updatedAt`.
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<JsDate>,
}
impl NewClipDesign {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedDesignInsert, ModelError> {
        prepare_create(&self.to_document()?, ctx)
    }
}

use crate::{LoadedForSave, UpdateOptions};
use dima_store::mongo::save::{Change, PreparedSave};
use dima_store::mongo::update::PreparedUpdate;
use dima_store::mongo::{
    MongoStore,
    write::{SaveOutcome, WriteError},
};

/// A validated create, including the awaited second save hook.
#[must_use = "execute the plan to run both the sibling hook and the primary write"]
#[derive(Debug)]
pub struct PreparedDesignInsert {
    /// Clear the other defaults first, when the new design is default.
    pub reset: Option<PreparedUpdate>,
    /// The new document, with updatedAt stamped after validation.
    pub insert: PreparedInsert,
}
impl PreparedDesignInsert {
    /// Run the companion update first, propagating failure before the insert.
    pub async fn execute(&self, store: &MongoStore) -> Result<(), WriteError> {
        let mut writes = store.writes(COLLECTION);
        if let Some(reset) = &self.reset {
            writes.update_many(reset).await?;
        }
        writes.insert_one(&self.insert).await
    }
}
/// A validated save with its awaited sibling reset.
#[must_use = "execute the plan to run both the sibling hook and the primary write"]
#[derive(Debug)]
pub struct PreparedDesignSave {
    /// Clear the other defaults before saving this document.
    pub reset: Option<PreparedUpdate>,
    /// The targeted delta (unknown stored fields survive).
    pub save: PreparedSave,
}
impl PreparedDesignSave {
    /// Run the companion update first, propagating failure before the save.
    pub async fn execute(&self, store: &MongoStore) -> Result<SaveOutcome, WriteError> {
        let mut writes = store.writes(COLLECTION);
        if let Some(reset) = &self.reset {
            writes.update_many(reset).await?;
        }
        writes.save(&self.save).await
    }
}
/// The second pre-save hook, given the validated document after the first hook.
/// Updates themselves have no save middleware.
pub fn prepare_reset(
    document: &Document,
    ctx: &mut WriteContext,
) -> Result<Option<PreparedUpdate>, ModelError> {
    if document.get_bool("isDefault").ok() != Some(true) {
        return Ok(None);
    }
    let channel = document
        .get("channelID")
        .cloned()
        .ok_or_else(|| ModelError::Refused {
            collection: COLLECTION,
            message: "default design has no channelID".into(),
        })?;
    let id = document
        .get("_id")
        .cloned()
        .ok_or_else(|| ModelError::Refused {
            collection: COLLECTION,
            message: "default design has no _id".into(),
        })?;
    INFO.prepare_update(
        &bson::doc! { "channelID": channel, "_id": { "$ne": id } },
        bson::doc! { "isDefault": false },
        UpdateOptions::default(),
        ctx,
    )
    .map(Some)
}
/// Both document hooks around a create: validation, timestamp, then awaited sibling reset.
pub fn prepare_create(
    given: &Document,
    ctx: &mut WriteContext,
) -> Result<PreparedDesignInsert, ModelError> {
    let insert = crate::writes::create_with_hooks(
        &INFO,
        given,
        |_, _| Ok(()),
        |document, ctx| {
            document.insert("updatedAt", ctx.now());
            Ok(())
        },
        ctx,
    )?;
    let reset = prepare_reset(&insert.document, ctx)?;
    Ok(PreparedDesignInsert { reset, insert })
}
/// Both document hooks around a save; validation failures produce no sibling write.
pub fn prepare_save(
    loaded: &LoadedForSave,
    changes: &[Change],
    ctx: &mut WriteContext,
) -> Result<PreparedDesignSave, ModelError> {
    let save = crate::hooks::save_stamping(&INFO, loaded, changes, "updatedAt", ctx)?;
    let mut changes = changes.to_vec();
    changes.push(Change::set("updatedAt", ctx.now()));
    let after = crate::writes::document_after(&INFO, loaded.document(), &changes, ctx)?;
    let reset = prepare_reset(&after, ctx)?;
    Ok(PreparedDesignSave { reset, save })
}
