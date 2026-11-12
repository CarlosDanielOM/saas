//! Local extension for the deployed raid worker's persisted native scheduling fields.
//! The model crate's TypeScript schema omits rustRefresh/rustPending. Keep its validators,
//! decoder and checked write path, with only these two production fields added. Payload
//! aggregation BSON widths are preserved after validation, as in the activity adapter.
use bson::{Bson, Document};
use dima_model::CollectionInfo;
use dima_store::mongo::{
    schema::{DefaultValue as D, Field, Schema},
    update::UpdateDoc,
};
static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::date("dirtyAt"),
    Field::date("nextRefreshAt"),
    Field::date("leaseUntil").default_fn(D::DateMs(0)),
    Field::string("owner"),
    Field::date("updatedAt"),
    Field::mixed("payload"),
    Field::boolean("error").default(D::Bool(false)),
    Field::mixed("rustRefresh"),
    Field::boolean("rustPending"),
])
.declared_id()
.no_version_key();
pub(super) static INFO: CollectionInfo = CollectionInfo {
    schema: &SCHEMA,
    ..dima_model::raid_analytics_summaries::INFO
};
pub(super) fn preserve_payload(update: &mut Option<UpdateDoc>, original: &Document) {
    if let Some(UpdateDoc::Document(d)) = update
        && let Ok(set) = d.get_document_mut("$set")
        && let Some(payload) = original
            .get_document("$set")
            .ok()
            .and_then(|s| s.get("payload"))
    {
        set.insert("payload", payload.clone());
    }
}
pub(super) fn serialized<T: serde::Serialize>(value: &T) -> Result<Document, crate::Error> {
    bson::serialize_to_document(value).map_err(|e| crate::Error::Invalid(e.to_string()))
}
pub(super) fn bytes(value: &Document) -> Result<Vec<u8>, crate::Error> {
    bson::serialize_to_vec(value).map_err(|e| crate::Error::Invalid(e.to_string()))
}
pub(super) fn null_date(at: Option<bson::DateTime>) -> Bson {
    at.map_or(Bson::Null, Bson::DateTime)
}
