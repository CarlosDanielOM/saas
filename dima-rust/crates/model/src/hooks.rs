//! Shared pieces of the collection adapters that reproduce Mongoose middleware.

use crate::error::ModelError;
use crate::writes::save_unchecked;
use bson::{Bson, Document};
use dima_store::mongo::WriteContext;
use dima_store::mongo::save::{Change, PreparedSave};
use dima_store::mongo::schema::Schema;

/// `schema.pre('save', function () { this[field] = new Date() })` around a save: the caller's
/// changes, then `field` set to the write time. Mongoose sends it even when nothing else changed
/// (the hook itself makes the change).
pub(crate) fn save_stamping(
    schema: &Schema,
    loaded: &Document,
    changes: &[Change],
    field: &str,
    ctx: &mut WriteContext,
) -> Result<PreparedSave, ModelError> {
    let mut all = changes.to_vec();
    all.push(Change::set(field, Bson::DateTime(ctx.now())));
    save_unchecked(schema, loaded, &all, ctx)
}

/// The same hook on a new document: `field` is the write time whatever the caller gave.
pub(crate) fn stamp_insert(document: &mut Document, field: &str, ctx: &WriteContext) {
    if document.contains_key(field) {
        document.insert(field, Bson::DateTime(ctx.now()));
    }
}
