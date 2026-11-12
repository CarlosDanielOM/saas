//! The update and save entry points of a collection: `dima_store`'s helpers with the corrections
//! this crate makes, refused for collections whose Mongoose middleware must run (their modules
//! have their own adapters).
//!
//! The correction: Mongoose treats every path *below* an immutable `Mixed` path as immutable too
//! (`schema._getSchema('metadata.x')` resolves to the `metadata` schema type), so an update drops
//! `$set: {'metadata.x': 1}` from every operator but `$setOnInsert`, and an upsert moves a `$set`
//! of such a path into `$setOnInsert` (`moveImmutableProperties`). The store applies `immutable`
//! to the field itself only, so this is done here first. A save that changes such a path makes
//! Mongoose 8.24.3 overflow its stack (the reference never does it); here the change is ignored,
//! like a change of any immutable path.

use crate::collection::{CollectionInfo, Hooks};
use crate::error::ModelError;
use crate::loaded::LoadedForSave;
use bson::{Bson, Document};
use dima_store::mongo::WriteContext;
use dima_store::mongo::save::{Change, PreparedSave, prepare_save};
use dima_store::mongo::schema::{Field, Kind, Schema};
use dima_store::mongo::update::{
    PreparedFindAndModify, PreparedUpdate, Returned, Update, UpdateOptions,
    prepare_find_one_and_update, prepare_update,
};

impl CollectionInfo {
    /// `Model.updateOne` / `updateMany` of a collection without hooks.
    pub fn prepare_update(
        &self,
        filter: &Document,
        update: impl Into<Update>,
        options: UpdateOptions,
        ctx: &mut WriteContext,
    ) -> Result<PreparedUpdate, ModelError> {
        self.refuse_hooked(Hooks::UpdatesAndSave, "update")?;
        update_unchecked(self.schema, filter, update.into(), options, ctx)
    }

    /// `Model.findOneAndUpdate` of a collection without hooks.
    pub fn prepare_find_one_and_update(
        &self,
        filter: &Document,
        update: impl Into<Update>,
        options: UpdateOptions,
        returned: Returned,
        ctx: &mut WriteContext,
    ) -> Result<PreparedFindAndModify, ModelError> {
        self.refuse_hooked(Hooks::UpdatesAndSave, "findOneAndUpdate")?;
        find_and_update_unchecked(self.schema, filter, update.into(), options, returned, ctx)
    }

    /// `doc.save()` of a document of a collection without hooks, loaded whole with
    /// [`CollectionInfo::load_for_save`].
    pub fn prepare_save(
        &self,
        loaded: &LoadedForSave,
        changes: &[Change],
        ctx: &mut WriteContext,
    ) -> Result<PreparedSave, ModelError> {
        self.refuse_hooked(Hooks::Save, "save")?;
        save_with_hooks(self, loaded, changes, |_, _, _| Ok(Vec::new()), ctx)
    }

    /// Refuses when the collection has hooks that `operation` would skip: any hooks for a save,
    /// update hooks for an update.
    fn refuse_hooked(
        &self,
        skipped_by_update: Hooks,
        operation: &'static str,
    ) -> Result<(), ModelError> {
        let refused = match self.hooks {
            Hooks::None => false,
            Hooks::Save => skipped_by_update == Hooks::Save,
            Hooks::UpdatesAndSave => true,
        };
        if refused {
            return Err(ModelError::Hooked {
                collection: self.name,
                operation,
            });
        }
        Ok(())
    }
}

/// [`CollectionInfo::prepare_update`] without the hooks check (for the modules' adapters).
pub(crate) fn update_unchecked(
    schema: &Schema,
    filter: &Document,
    update: Update,
    options: UpdateOptions,
    ctx: &mut WriteContext,
) -> Result<PreparedUpdate, ModelError> {
    let update = immutable_mixed_children(schema, update, options.upsert);
    Ok(prepare_update(schema, filter, update, options, ctx)?)
}

/// [`CollectionInfo::prepare_find_one_and_update`] without the hooks check.
pub(crate) fn find_and_update_unchecked(
    schema: &Schema,
    filter: &Document,
    update: Update,
    options: UpdateOptions,
    returned: Returned,
    ctx: &mut WriteContext,
) -> Result<PreparedFindAndModify, ModelError> {
    let update = immutable_mixed_children(schema, update, options.upsert);
    Ok(prepare_find_one_and_update(
        schema, filter, update, options, returned, ctx,
    )?)
}

/// Every save of `info` (the generic one and the modules' adapters): checks that `loaded` was
/// loaded from this collection, then prepares the caller's changes followed by the changes the
/// collection's `pre('save')` middleware makes (`hooks`, given the loaded document and the
/// caller's changes).
pub(crate) fn save_with_hooks(
    info: &CollectionInfo,
    loaded: &LoadedForSave,
    changes: &[Change],
    hooks: impl FnOnce(&Document, &[Change], &mut WriteContext) -> Result<Vec<Change>, ModelError>,
    ctx: &mut WriteContext,
) -> Result<PreparedSave, ModelError> {
    if loaded.collection() != info.name {
        return Err(ModelError::WrongCollection {
            expected: info.name,
            found: loaded.collection(),
        });
    }
    let schema = info.schema;
    let changes = kept_changes(schema, changes);
    let mut all = changes.clone();
    all.extend(hooks(loaded.document(), &changes, ctx)?);
    Ok(prepare_save(schema, loaded.document(), &all, ctx)?)
}

/// The caller's changes without those Mongoose ignores (paths below an immutable `Mixed` path).
fn kept_changes(schema: &Schema, changes: &[Change]) -> Vec<Change> {
    changes
        .iter()
        .filter(|change| {
            let path = match change {
                Change::Set(path, _) | Change::Unset(path) | Change::Push(path, _) => path,
            };
            !below_immutable_mixed(schema.fields, path)
        })
        .cloned()
        .collect()
}

/// `true` when `path` lies strictly below an immutable `Mixed` field (through plain nested
/// objects).
fn below_immutable_mixed(fields: &'static [Field], path: &str) -> bool {
    let mut fields = fields;
    let mut segments = path.split('.').peekable();
    while let Some(segment) = segments.next() {
        let Some(field) = fields.iter().find(|f| f.name == segment) else {
            return false;
        };
        let deeper = segments.peek().is_some();
        match field.kind {
            Kind::Mixed => return deeper && field.immutable,
            Kind::Nested(children) if deeper => fields = children,
            _ => return false,
        }
    }
    false
}

/// Mongoose's handling of paths below immutable `Mixed` paths (see the module docs).
fn immutable_mixed_children(schema: &Schema, update: Update, upsert: bool) -> Update {
    let Update::Document(mut update) = update else {
        return update;
    };
    let fields = schema.fields;
    let mut moved: Vec<(String, Bson)> = Vec::new();
    // Bare keys are `$set`.
    let bare: Vec<String> = update
        .keys()
        .filter(|k| !k.starts_with('$') && below_immutable_mixed(fields, k))
        .cloned()
        .collect();
    for key in bare {
        if let Some(value) = update.remove(&key)
            && upsert
        {
            moved.push((key, value));
        }
    }
    for (operator, value) in update.iter_mut() {
        if !operator.starts_with('$') || operator == "$setOnInsert" {
            continue;
        }
        let Bson::Document(paths) = value else {
            continue;
        };
        let hit: Vec<String> = paths
            .keys()
            .filter(|k| below_immutable_mixed(fields, k))
            .cloned()
            .collect();
        for key in hit {
            if let Some(value) = paths.remove(&key)
                && upsert
                && operator == "$set"
            {
                moved.push((key, value));
            }
        }
    }
    if !moved.is_empty() {
        if !matches!(update.get("$setOnInsert"), Some(Bson::Document(_))) {
            update.insert("$setOnInsert", Document::new());
        }
        if let Some(Bson::Document(on_insert)) = update.get_mut("$setOnInsert") {
            for (key, value) in moved {
                on_insert.insert(key, value);
            }
        }
    }
    Update::Document(update)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::REGISTRY;
    use bson::doc;

    /// A generic save must not skip a collection's `pre('save')` middleware.
    #[test]
    fn hooked_collections_refuse_generic_saves() {
        let mut ctx = WriteContext::new(0);
        for info in REGISTRY {
            let loaded = LoadedForSave::for_test(info, doc! { "_id": 1 });
            let refused = matches!(
                info.prepare_save(&loaded, &[], &mut ctx),
                Err(ModelError::Hooked { .. })
            );
            assert_eq!(refused, info.hooks != Hooks::None, "{}", info.name);
        }
    }

    static S: Schema = Schema::new(&[
        Field::mixed("payload").immutable(),
        Field::mixed("free"),
        Field::nested("n", &[Field::mixed("m").immutable()]),
        Field::boolean("flag"),
    ]);

    #[test]
    fn paths_below_immutable_mixed_are_immutable() {
        assert!(below_immutable_mixed(S.fields, "payload.a.b"));
        assert!(below_immutable_mixed(S.fields, "n.m.x"));
        assert!(!below_immutable_mixed(S.fields, "payload"));
        assert!(!below_immutable_mixed(S.fields, "free.a"));
        assert!(!below_immutable_mixed(S.fields, "flag"));
        let update = doc! {
            "payload.x": 1,
            "$set": { "payload.y": 2, "flag": true },
            "$inc": { "n.m.z": 1 },
            "$setOnInsert": { "payload.w": 3 },
        };
        let Update::Document(plain) = immutable_mixed_children(&S, update.clone().into(), false)
        else {
            panic!("a document stays a document");
        };
        assert_eq!(
            plain,
            doc! { "$set": { "flag": true }, "$inc": {}, "$setOnInsert": { "payload.w": 3 } }
        );
        let Update::Document(upsert) = immutable_mixed_children(&S, update.into(), true) else {
            panic!("a document stays a document");
        };
        assert_eq!(
            upsert,
            doc! {
                "$set": { "flag": true },
                "$inc": {},
                "$setOnInsert": { "payload.w": 3, "payload.x": 1, "payload.y": 2 },
            }
        );
    }
}
