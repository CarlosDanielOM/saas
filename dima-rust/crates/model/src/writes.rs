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
use crate::shape::Against;
use crate::validation::{validate_given, validate_ordered};
use bson::{Bson, Document};
use dima_store::mongo::WriteContext;
use dima_store::mongo::insert::{InsertStyle, PreparedInsert, prepare_insert};
use dima_store::mongo::save::{Change, PreparedSave, prepare_save};
use dima_store::mongo::schema::{DefaultValue, Field, Kind, Schema};
use dima_store::mongo::update::{
    PreparedFindAndModify, PreparedUpdate, Returned, Update, UpdateDoc, UpdateOptions,
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
        update_unchecked(self, filter, update.into(), options, ctx)
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
        find_and_update_unchecked(self, filter, update.into(), options, returned, ctx)
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
    info: &CollectionInfo,
    filter: &Document,
    update: Update,
    options: UpdateOptions,
    ctx: &mut WriteContext,
) -> Result<PreparedUpdate, ModelError> {
    let update = immutable_mixed_children(info.schema, update, options.upsert);
    let prepared = prepare_update(info.schema, filter, update, options, ctx)?;
    if let Some(update) = &prepared.update {
        info.check_update(
            update,
            Against::Filter {
                filter: &prepared.filter,
                upsert: prepared.upsert,
            },
        )?;
    }
    Ok(prepared)
}

/// [`CollectionInfo::prepare_find_one_and_update`] without the hooks check.
pub(crate) fn find_and_update_unchecked(
    info: &CollectionInfo,
    filter: &Document,
    update: Update,
    options: UpdateOptions,
    returned: Returned,
    ctx: &mut WriteContext,
) -> Result<PreparedFindAndModify, ModelError> {
    let update = immutable_mixed_children(info.schema, update, options.upsert);
    let prepared =
        prepare_find_one_and_update(info.schema, filter, update, options, returned, ctx)?;
    if let Some(update) = &prepared.update {
        info.check_update(
            update,
            Against::Filter {
                filter: &prepared.filter,
                upsert: prepared.upsert,
            },
        )?;
    }
    Ok(prepared)
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
    validate_save(info, loaded.document(), &changes, ctx)?;
    let mut all = changes.clone();
    all.extend(hooks(loaded.document(), &changes, ctx)?);
    let prepared = prepare_save(schema, loaded.document(), &all, ctx)?;
    if let Some(update) = &prepared.update {
        info.check_update(
            &UpdateDoc::Document(update.clone()),
            Against::Loaded(loaded.document()),
        )?;
    }
    Ok(prepared)
}

/// `Model.create(given)` of a collection with document middleware: `pre_validate` changes the
/// new document (defaults and `trim` applied) before it is validated, as `pre('validate')`
/// does, and `pre_save` after, as `pre('save')` does (what it sets is not validated); then the
/// write guard. Either may refuse the write.
pub(crate) fn create_with_hooks(
    info: &CollectionInfo,
    given: &Document,
    pre_validate: impl FnOnce(&mut Document, &mut WriteContext) -> Result<(), ModelError>,
    pre_save: impl FnOnce(&mut Document, &mut WriteContext) -> Result<(), ModelError>,
    ctx: &mut WriteContext,
) -> Result<PreparedInsert, ModelError> {
    let mut prepared = prepare_insert(info.schema, given, InsertStyle::Create, ctx)?;
    pre_validate(&mut prepared.document, ctx)?;
    validate_given(
        info.model,
        info.schema,
        info.rules,
        &prepared.document,
        Some(given),
    )?;
    pre_save(&mut prepared.document, ctx)?;
    info.check_insert(&prepared.document)?;
    Ok(prepared)
}

/// The document a save of `loaded` after `changes` leaves, as the collection's middleware sees
/// it: the delta the store prepares for them (casts, `trim`, defaults of missing paths) applied,
/// and the `default: null` paths hydration adds.
pub(crate) fn document_after(
    info: &CollectionInfo,
    loaded: &Document,
    changes: &[Change],
    ctx: &WriteContext,
) -> Result<Document, ModelError> {
    let delta = prepare_save(info.schema, loaded, changes, &mut ctx.clone())?;
    let mut after = loaded.clone();
    if let Some(update) = &delta.update {
        apply_update(&mut after, update);
    }
    fill_null_defaults(info.schema.fields, &mut after);
    Ok(after)
}

/// `validateBeforeSave`, as Mongoose 8.24.3 runs it (recorded: the `save_*` cases with errors):
///
/// - **when**: first of the `pre('save')` middleware (the plugin registers itself with
///   `unshift`), so the collection's own hooks run after it and what they set is not validated;
///   a refused save sends nothing, the hooks' writes included;
/// - **what**: the whole hydrated document after the caller's changes (casts, `trim`, defaults
///   of missing paths): every loaded path, every changed one, every required one. A stored value
///   the caller did not touch fails the save too, as does a required path the document lacks;
/// - **order** of the report: required paths that are missing and were not changed (reverse
///   schema order), then the unchanged stored paths in the stored document's key order, then
///   the changed paths in the order they were first changed, then paths a default filled; the
///   errors inside sub-documents and array elements follow, in schema order.
///
/// The document validated is the loaded one with the delta the store prepares for these changes
/// applied to it (the same casts and `trim`), plus the `default: null` paths hydration adds.
fn validate_save(
    info: &CollectionInfo,
    loaded: &Document,
    changes: &[Change],
    ctx: &WriteContext,
) -> Result<(), ModelError> {
    let delta = prepare_save(info.schema, loaded, changes, &mut ctx.clone())?;
    let mut after = loaded.clone();
    if let Some(update) = &delta.update {
        apply_update(&mut after, update);
    }
    fill_null_defaults(info.schema.fields, &mut after);
    // Mongoose validates before `minimize`: an object the caller set counts even when empty.
    let mut given = Document::new();
    for change in changes {
        if let Change::Set(path, value) = change
            && !path
                .split('.')
                .any(|segment| segment.parse::<usize>().is_ok())
        {
            put(&mut given, path, value.clone());
        }
    }
    let stored = stored_order(loaded);
    let key = |local: &str, has_value: bool, position: &[usize]| -> (u8, Vec<usize>) {
        let changed = changes.iter().position(|change| {
            let path = match change {
                Change::Set(path, _) | Change::Unset(path) | Change::Push(path, _) => path,
            };
            let covers = path == local
                || local
                    .strip_prefix(path.as_str())
                    .is_some_and(|rest| rest.starts_with('.'));
            // Setting a path to the value it holds does not modify it.
            covers && (matches!(change, Change::Unset(_)) || at(loaded, local) != at(&after, local))
        });
        match changed {
            Some(index) => (2, vec![index]),
            None if !has_value => (0, position.iter().map(|p| usize::MAX - p).collect()),
            None => match stored.iter().position(|path| path == local) {
                Some(index) => (1, vec![index]),
                None => (3, position.to_vec()),
            },
        }
    };
    validate_ordered(
        info.model,
        info.schema,
        info.rules,
        &after,
        Some(&given),
        Some(&key),
    )?;
    Ok(())
}

/// Every path of plain objects in `document`, in stored key order (`a`, `a.b`, …).
fn stored_order(document: &Document) -> Vec<String> {
    fn walk(document: &Document, prefix: &str, out: &mut Vec<String>) {
        for (key, value) in document {
            let path = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            out.push(path.clone());
            if let Bson::Document(inner) = value {
                walk(inner, &path, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(document, "", &mut out);
    out
}

/// The `default: null` paths a hydrated document shows where the stored one has nothing (the
/// store does not write them on a save, but validators see `null` there).
fn fill_null_defaults(fields: &'static [Field], document: &mut Document) {
    for field in fields {
        match field.kind {
            Kind::Nested(children) => match document.get_mut(field.name) {
                Some(Bson::Document(inner)) => fill_null_defaults(children, inner),
                None => {
                    let mut inner = Document::new();
                    fill_null_defaults(children, &mut inner);
                    if !inner.is_empty() {
                        document.insert(field.name, inner);
                    }
                }
                Some(_) => {}
            },
            Kind::Subdocument(sub) => {
                if let Some(Bson::Document(inner)) = document.get_mut(field.name) {
                    fill_null_defaults(sub.fields, inner);
                }
            }
            Kind::DocumentArray(sub) => {
                if let Some(Bson::Array(items)) = document.get_mut(field.name) {
                    for item in items {
                        if let Bson::Document(inner) = item {
                            fill_null_defaults(sub.fields, inner);
                        }
                    }
                }
            }
            _ => {
                let null_default = field
                    .default
                    .is_some_and(|d| matches!(d.value, DefaultValue::Null));
                if null_default && !document.contains_key(field.name) {
                    document.insert(field.name, Bson::Null);
                }
            }
        }
    }
}

/// `update` (`$set`, `$unset`, `$push: {$each}`, `$inc`, as a save sends them) applied to
/// `document`, the way the server applies it.
fn apply_update(document: &mut Document, update: &Document) {
    for (operator, paths) in update {
        let Bson::Document(paths) = paths else {
            continue;
        };
        for (path, value) in paths {
            match operator.as_str() {
                "$set" => put(document, path, value.clone()),
                "$unset" => remove(document, path),
                "$push" => {
                    let each = match value {
                        Bson::Document(each) => match each.get("$each") {
                            Some(Bson::Array(items)) => items.clone(),
                            _ => vec![value.clone()],
                        },
                        other => vec![other.clone()],
                    };
                    match at_mut(document, path) {
                        Some(Bson::Array(items)) => items.extend(each),
                        _ => put(document, path, Bson::Array(each)),
                    }
                }
                "$inc" => {
                    let current = at(document, path)
                        .and_then(dima_store::mongo::number::read_number)
                        .unwrap_or(0.0);
                    let step = dima_store::mongo::number::read_number(value).unwrap_or(0.0);
                    put(
                        document,
                        path,
                        dima_store::mongo::number::js_number(current + step),
                    );
                }
                _ => {}
            }
        }
    }
}

/// The value at a dotted path through documents and array positions.
pub(crate) fn at<'a>(document: &'a Document, path: &str) -> Option<&'a Bson> {
    let mut segments = path.split('.');
    let mut current = document.get(segments.next()?)?;
    for segment in segments {
        current = match current {
            Bson::Document(inner) => inner.get(segment)?,
            Bson::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

fn at_mut<'a>(document: &'a mut Document, path: &str) -> Option<&'a mut Bson> {
    let mut segments = path.split('.');
    let mut current = document.get_mut(segments.next()?)?;
    for segment in segments {
        current = match current {
            Bson::Document(inner) => inner.get_mut(segment)?,
            Bson::Array(items) => items.get_mut(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

/// `$set` of one dotted path: missing objects on the way are created, array positions are
/// followed.
pub(crate) fn put(document: &mut Document, path: &str, value: Bson) {
    let Some((head, rest)) = path.split_once('.') else {
        document.insert(path, value);
        return;
    };
    if !matches!(document.get(head), Some(Bson::Document(_) | Bson::Array(_))) {
        document.insert(head, Document::new());
    }
    match document.get_mut(head) {
        Some(Bson::Document(inner)) => put(inner, rest, value),
        Some(Bson::Array(items)) => put_in_array(items, rest, value),
        _ => {}
    }
}

fn put_in_array(items: &mut [Bson], path: &str, value: Bson) {
    let (index, rest) = match path.split_once('.') {
        Some((index, rest)) => (index, Some(rest)),
        None => (path, None),
    };
    let Some(slot) = index.parse::<usize>().ok().and_then(|i| items.get_mut(i)) else {
        return;
    };
    match (rest, slot) {
        (None, slot) => *slot = value,
        (Some(rest), Bson::Document(inner)) => put(inner, rest, value),
        (Some(rest), Bson::Array(inner)) => put_in_array(inner, rest, value),
        _ => {}
    }
}

/// `$unset` of one dotted path.
fn remove(document: &mut Document, path: &str) {
    match path.rsplit_once('.') {
        None => {
            document.remove(path);
        }
        Some((parent, last)) => match at_mut(document, parent) {
            Some(Bson::Document(inner)) => {
                inner.remove(last);
            }
            Some(Bson::Array(items)) => {
                if let Some(slot) = last.parse::<usize>().ok().and_then(|i| items.get_mut(i)) {
                    *slot = Bson::Null;
                }
            }
            _ => {}
        },
    }
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

    /// Validation runs before the save hooks (the scratch probe against Mongoose 8.24.3 stored
    /// a value a `pre('save')` hook set outside its enum): what a hook sets is not validated,
    /// what the caller changes is, and so is every stored path.
    #[test]
    fn saves_validate_before_the_hooks() {
        static SCHEMA: Schema = Schema::new(&[Field::string("tier"), Field::number("n")]);
        static RULES: &[crate::Rule] = &[
            crate::Rule::one_of("tier", &["a", "b"]),
            crate::Rule::min("n", 1.0),
        ];
        let info = CollectionInfo {
            name: "probes",
            model: "Probe",
            source: "",
            schema: &SCHEMA,
            id_type: dima_store::mongo::id::IdType::ObjectId,
            hidden: &[],
            indexes: &[],
            rules: RULES,
            read_needs: &[],
            hooks: Hooks::Save,
            private: &[],
            decode: |_| Ok(Box::new(())),
        };
        let mut ctx = WriteContext::new(0);
        let hook = |_: &Document, _: &[Change], _: &mut WriteContext| {
            Ok(vec![Change::set("tier", "set-by-hook")])
        };
        let loaded = LoadedForSave::for_test(&info, doc! { "_id": 1, "tier": "a", "n": 2 });
        let saved = save_with_hooks(&info, &loaded, &[Change::set("n", 3)], hook, &mut ctx);
        assert!(saved.is_ok(), "{saved:?}");
        let refused = save_with_hooks(&info, &loaded, &[Change::set("tier", "c")], hook, &mut ctx);
        assert!(matches!(refused, Err(ModelError::Validation(_))));
        // An unchanged stored value is validated too.
        let stored = LoadedForSave::for_test(&info, doc! { "_id": 1, "tier": "a", "n": 0 });
        let refused = save_with_hooks(&info, &stored, &[Change::set("tier", "b")], hook, &mut ctx);
        let Err(ModelError::Validation(error)) = refused else {
            panic!("must fail: {refused:?}");
        };
        assert_eq!(error.errors[0].path, "n");
    }

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
