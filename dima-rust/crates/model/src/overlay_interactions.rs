//! `overlay_interactions`.
//! Reference: overlays/interactions.ts. No timestamps, __v, hooks or hidden paths.
//! Writers checked: overlays/interactions.ts:28,44 create;30,46 updateOne,
//! including LiveState alias in saveLive; goals/twitch-store.ts calls saveLive.
//! Events and Helix recovery are parsed/reduced server-side, no client-fed writes,
//! saves or runValidators. Key channel:kind (poll,prediction,hypetrain,adbreak,
//! twitchgoals). Repeat: interaction receipt equality; reducers reject older events
//! and retain event receipts; revision CAS fences writes/recovery, retries bounded.
//! Raw state has no schema byte/depth limit; server EventSub/Helix inputs, not an
//! editor body; HTTP JSON default 100 KiB where applicable, MongoDB 16 MiB ceiling.
//! Legacy: heterogeneous state shapes, absent fields and null deadlines/winnerId,
//! cleared; revision int32. Raw BSON retains all numeric widths and nulls.
//! Server-only null/removal of READ_NEEDS paths is refused.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::{Bson, Document};
use dima_store::mongo::schema::{Field, Schema};
use dima_store::mongo::{WriteContext, id::IdType, insert::PreparedInsert, number::JsNumber};
use serde::{Deserialize, Serialize};
/// Raw `state`; reference limits are described above.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct OverlayInteractionStateContent(pub Bson);
/// Collection name.
pub const COLLECTION: &str = "overlay_interactions";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::number("revision"),
    Field::mixed("state"),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["state"];
/// Declared indexes (best effort).
pub const INDEXES: &[IndexSpec] = &[];
/// Validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[ReadNeed::value("_id"), ReadNeed::value("revision")];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "OverlayInteraction",
    source: "dimabot/src/overlays/interactions.ts",
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
    decode: decode_boxed::<OverlayInteraction>,
};
/// Stored document.
#[derive(Clone, Debug, Deserialize)]
pub struct OverlayInteraction {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `revision`.
    #[serde(rename = "revision")]
    pub revision: JsNumber,
    /// `state`.
    #[serde(rename = "state", default)]
    pub state: Option<Private<OverlayInteractionStateContent>>,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewOverlayInteraction {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `revision`.
    #[serde(rename = "revision")]
    pub revision: JsNumber,
    /// `state`.
    #[serde(rename = "state", skip_serializing_if = "Option::is_none")]
    pub state: Option<Private<OverlayInteractionStateContent>>,
}
impl NewOverlayInteraction {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
