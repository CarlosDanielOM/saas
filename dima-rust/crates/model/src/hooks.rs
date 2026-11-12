//! Shared pieces of the collection adapters that reproduce Mongoose middleware.

use crate::collection::CollectionInfo;
use crate::error::ModelError;
use crate::loaded::LoadedForSave;
use crate::writes::save_with_hooks;
use bson::{Bson, Document};
use dima_store::mongo::WriteContext;
use dima_store::mongo::save::{Change, PreparedSave};

/// `schema.pre('save', function () { this[field] = new Date() })` around a save: the caller's
/// changes, then `field` set to the write time. Mongoose sends it even when nothing else changed
/// (the hook itself makes the change).
pub(crate) fn save_stamping(
    info: &CollectionInfo,
    loaded: &LoadedForSave,
    changes: &[Change],
    field: &'static str,
    ctx: &mut WriteContext,
) -> Result<PreparedSave, ModelError> {
    save_with_hooks(
        info,
        loaded,
        changes,
        |_, _, ctx| Ok(vec![Change::set(field, Bson::DateTime(ctx.now()))]),
        ctx,
    )
}

/// The same hook on a new document: `field` is the write time whatever the caller gave.
pub(crate) fn stamp_insert(document: &mut Document, field: &str, ctx: &WriteContext) {
    if document.contains_key(field) {
        document.insert(field, Bson::DateTime(ctx.now()));
    }
}
