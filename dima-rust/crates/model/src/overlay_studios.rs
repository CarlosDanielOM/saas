//! `overlay_studios`.
//! Reference: overlays/store.ts. No timestamps, __v, hooks or hidden paths.
//! Writers checked: overlays/store.ts:158 create,166 change; overlays/live.ts:575
//! findByIdAndUpdate controls. Callers: overlay-studio.route.ts:98 recover,105 save,
//! 111 publish/rotate,100 queue; overlays/recover.ts:7. No doc.save or runValidators.
//! Site agent tools/stream.ts calls requireOverlayAccount/publishStudioAlert only;
//! no direct model writer there.
//! Client state passes validateState (typed scalars, bounded arrays), checkCustomLayers,
//! validateAssets; recovery revalidates. Queue action/platform checked against enums.
//! No unchecked top-level client paths; nested Mixed values retain null verbatim.
//! Raw scenes/designs: combined JSON <=4 MiB, <=25 scenes,50 designs,60 layers/layout;
//! request /overlay-studio limit 5 MiB. Custom values <=64000 bytes; normal save uses JSON depth 6;
//! recovery skips checkCustomLayers, so values there have no depth bound. Controls are server-built.
//! Controls have no schema size/depth limit (HTTP body limit above).
//! Legacy: controls absent; variants/published absent; numeric revisions int32;
//! raw nested BSON numbers/nulls preserved. Scenes contain public access tokens.
//! Unique scenes.publicId index is best effort: no init wait or double-count fence.
//! Server-only null/removal of READ_NEEDS paths is refused.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::{Bson, Document};
use dima_store::mongo::schema::{Field, Schema};
use dima_store::mongo::{WriteContext, id::IdType, insert::PreparedInsert, number::JsNumber};
use serde::{Deserialize, Serialize};
/// Raw `scenes`; reference limits are described above.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct OverlayStudioScenesContent(pub Bson);
/// Raw `designs`; reference limits are described above.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct OverlayStudioDesignsContent(pub Bson);
/// Raw `controls`; reference limits are described above.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct OverlayStudioControlsContent(pub Bson);
/// Collection name.
pub const COLLECTION: &str = "overlay_studios";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::number("schemaVersion"),
    Field::number("revision"),
    Field::mixed_array("scenes"),
    Field::mixed_array("designs"),
    Field::mixed("controls"),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["scenes", "designs", "controls"];
/// Declared indexes (best effort).
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("scenes.publicId", 1)]).unique()];
/// Validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("schemaVersion"),
    ReadNeed::value("revision"),
    ReadNeed::not_null("scenes"),
    ReadNeed::not_null("designs"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "OverlayStudio",
    source: "dimabot/src/overlays/store.ts",
    schema: &SCHEMA,
    id_type: IdType::String,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<OverlayStudio>,
};
/// Stored document.
#[derive(Clone, Debug, Deserialize)]
pub struct OverlayStudio {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `schemaVersion`.
    #[serde(rename = "schemaVersion")]
    pub schema_version: JsNumber,
    /// `revision`.
    #[serde(rename = "revision")]
    pub revision: JsNumber,
    /// `scenes`.
    #[serde(rename = "scenes", default)]
    pub scenes: Private<Vec<OverlayStudioScenesContent>>,
    /// `designs`.
    #[serde(rename = "designs", default)]
    pub designs: Private<Vec<OverlayStudioDesignsContent>>,
    /// `controls`.
    #[serde(rename = "controls", default)]
    pub controls: Option<Private<OverlayStudioControlsContent>>,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewOverlayStudio {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `schemaVersion`.
    #[serde(rename = "schemaVersion")]
    pub schema_version: JsNumber,
    /// `revision`.
    #[serde(rename = "revision")]
    pub revision: JsNumber,
    /// `scenes`.
    #[serde(rename = "scenes")]
    pub scenes: Private<Vec<OverlayStudioScenesContent>>,
    /// `designs`.
    #[serde(rename = "designs")]
    pub designs: Private<Vec<OverlayStudioDesignsContent>>,
    /// `controls`.
    #[serde(rename = "controls", skip_serializing_if = "Option::is_none")]
    pub controls: Option<Private<OverlayStudioControlsContent>>,
}
impl NewOverlayStudio {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
