//! The update document Mongoose sends for `updateOne`, `updateMany`, `findOneAndUpdate` and
//! the update operations of `bulkWrite` (ledger `mongo.md`, rules 5 to 12, 16, 29).
//!
//! Each entry point takes the update the caller means and returns the update Mongoose 8.24.3
//! would send for it. The steps are Mongoose's own (`applyTimestampsToUpdate`,
//! `decorateUpdateWithVersionKey`, `castUpdate`, `setDefaultsOnInsert`), applied in the order
//! each call applies them; the order changes where fields land, so it is kept exactly.
//!
//! What they do (all pinned by the golden recording):
//! - bare keys become `$set`; operators come out in **reverse** order of the input (castUpdate
//!   walks the keys from the end);
//! - with timestamps, every update gets `$set.<updatedAt> = now` (replacing a caller's value,
//!   unless `$currentDate` sets it) and `$setOnInsert.<createdAt> = now` **even without
//!   upsert**; a caller's `createdAt` in `$set` or at the top level is removed;
//! - an upsert gets `$setOnInsert.__v = 0` when the update does not set the version key, and
//!   every schema default whose path is not in the filter (equality conditions) nor touched by
//!   the update;
//! - immutable paths are dropped from every operator except `$setOnInsert`, or moved there on
//!   an upsert; unknown paths are dropped (strict mode) and reported in `dropped_paths`;
//! - `trim` applies to strings set by `$set`, `$setOnInsert` and pushed elements; pushed or set
//!   sub-documents get their defaults and `_id`; an array pushed onto an array of values becomes
//!   `$each`;
//! - an operator left empty is removed; an update left empty is not sent at all
//!   (`update: None`), except an upsert with a filter, which becomes `{$setOnInsert: <filter>}`;
//! - a pipeline update only gets a trailing `{$set: {<updatedAt>: now}}` stage;
//! - every number in the filter, the update and the array filters is typed as the Node BSON
//!   writer types a JavaScript number ([`crate::mongo::number::js_number`]), whatever BSON type
//!   the caller used: an int64 `5` or a double `5.0` goes out as int32 `5`.
//!
//! Not covered: `overwrite`/`replaceOne` (no Mongoose call site), `timestamps: false` per query
//! (none in the reference), dotted timestamp names, and casting of filter values (callers build
//! filters with the right BSON types; see [`crate::mongo::id`]).

use crate::mongo::cast::{
    Caster, PrepareError, WriteContext, check_document_depth, get_path, truthy,
};
use crate::mongo::number::normalize_js_numbers;
use crate::mongo::schema::{Leaf, Schema, TargetKind, resolve};
use bson::{Bson, Document};
use mongodb::options::{ReturnDocument, UpdateModifications};

/// The update operators Mongoose recognises; any other top-level key is a field (`$set` sugar).
const UPDATE_OPERATORS: [&str; 15] = [
    "$currentDate",
    "$inc",
    "$min",
    "$max",
    "$mul",
    "$rename",
    "$set",
    "$setOnInsert",
    "$unset",
    "$addToSet",
    "$pop",
    "$pull",
    "$push",
    "$pullAll",
    "$bit",
];

/// Operators whose values are cast as documents (`castOps`).
const CAST_OPS: [&str; 4] = ["$push", "$addToSet", "$set", "$setOnInsert"];

/// An update as the caller writes it.
#[derive(Clone, Debug, PartialEq)]
pub enum Update {
    /// Operators (and bare fields, which mean `$set`).
    Document(Document),
    /// An aggregation pipeline.
    Pipeline(Vec<Document>),
}

impl From<Document> for Update {
    fn from(value: Document) -> Self {
        Self::Document(value)
    }
}

impl From<Vec<Document>> for Update {
    fn from(value: Vec<Document>) -> Self {
        Self::Pipeline(value)
    }
}

/// The update to send.
#[derive(Clone, Debug, PartialEq)]
pub enum UpdateDoc {
    /// An operator document.
    Document(Document),
    /// A pipeline.
    Pipeline(Vec<Document>),
}

impl UpdateDoc {
    /// Every number typed as the Node BSON writer types a JavaScript number.
    fn node_numbers(mut self) -> Self {
        match &mut self {
            Self::Document(document) => normalize_js_numbers(document),
            Self::Pipeline(stages) => stages.iter_mut().for_each(normalize_js_numbers),
        }
        self
    }

    /// The operator document, if this is one.
    pub fn as_document(&self) -> Option<&Document> {
        match self {
            Self::Document(document) => Some(document),
            Self::Pipeline(_) => None,
        }
    }
}

impl From<UpdateDoc> for UpdateModifications {
    fn from(value: UpdateDoc) -> Self {
        match value {
            UpdateDoc::Document(document) => Self::Document(document),
            UpdateDoc::Pipeline(stages) => Self::Pipeline(stages),
        }
    }
}

/// The options that change what is sent.
#[derive(Clone, Debug, PartialEq)]
pub struct UpdateOptions {
    /// `upsert: true`.
    pub upsert: bool,
    /// Mongoose's `setDefaultsOnInsert` (on unless a call turns it off).
    pub set_defaults_on_insert: bool,
    /// `arrayFilters`, as the caller writes them; the prepared update carries them as they
    /// are sent.
    pub array_filters: Option<Vec<Document>>,
}

impl Default for UpdateOptions {
    fn default() -> Self {
        Self {
            upsert: false,
            set_defaults_on_insert: true,
            array_filters: None,
        }
    }
}

impl UpdateOptions {
    /// `{ upsert: true }`.
    pub fn upsert() -> Self {
        Self {
            upsert: true,
            ..Self::default()
        }
    }

    /// The same options with `arrayFilters`.
    pub fn array_filters(mut self, filters: Vec<Document>) -> Self {
        self.array_filters = Some(filters);
        self
    }
}

/// A prepared update. Run it with [`crate::mongo::write::Writes`], which also enforces
/// [`PreparedUpdate::dropped_paths`].
#[must_use = "a prepared update does nothing until it is executed, and its dropped paths must be checked"]
#[derive(Clone, Debug, PartialEq)]
pub struct PreparedUpdate {
    /// The filter to send (numbers typed as Node types them).
    pub filter: Document,
    /// What to send, or `None` when Mongoose sends nothing (the update is empty after casting;
    /// the operation then reports nothing matched or modified).
    pub update: Option<UpdateDoc>,
    /// Pass to the driver's `upsert`.
    pub upsert: bool,
    /// The `arrayFilters` to send, when the caller gave some.
    pub array_filters: Option<Vec<Document>>,
    /// Paths strict mode dropped (unknown to the schema). Empty when the caller's update only
    /// names schema paths, which is what a Rust caller should always do.
    pub dropped_paths: Vec<String>,
}

/// `Model.updateOne` / `Model.updateMany`. The result's `update` is `None` when Mongoose would
/// send nothing (the update is empty after casting); its `dropped_paths` are always reported.
pub fn prepare_update(
    schema: &Schema,
    filter: &Document,
    update: impl Into<Update>,
    options: UpdateOptions,
    ctx: &mut WriteContext,
) -> Result<PreparedUpdate, PrepareError> {
    let update = update.into();
    check_inputs(filter, &update, &options)?;
    let filter = &node_filter(filter);
    let mut caster = Caster::new(ctx);
    let prepared = match update {
        Update::Pipeline(stages) => {
            let stages = timestamps_on_pipeline(schema, stages, caster.ctx.now());
            (!stages.is_empty()).then_some(UpdateDoc::Pipeline(stages))
        }
        Update::Document(mut doc) => {
            decorate_version_key(schema, &mut doc, options.upsert);
            apply_timestamps(schema, &mut doc, caster.ctx.now());
            let mut cast = cast_update(schema, doc, options.upsert, filter, &[], &mut caster)?;
            if cast.is_empty() {
                None
            } else {
                if options.upsert && options.set_defaults_on_insert {
                    set_defaults_on_insert(schema, filter, &mut cast, &mut caster)?;
                }
                Some(UpdateDoc::Document(cast))
            }
        }
    };
    Ok(PreparedUpdate {
        filter: filter.clone(),
        update: prepared.map(UpdateDoc::node_numbers),
        upsert: options.upsert,
        array_filters: node_array_filters(options.array_filters),
        dropped_paths: caster.dropped,
    })
}

/// Which document `findOneAndUpdate` returns. Mongoose's default is the document **before**
/// the update (`new: false`), like the Rust driver's; `new: true` or
/// `returnDocument: 'after'` asks for the updated one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Returned {
    /// The document as it was before the update (the default).
    #[default]
    Before,
    /// The updated (or inserted) document.
    After,
}

impl From<Returned> for ReturnDocument {
    fn from(value: Returned) -> Self {
        match value {
            Returned::Before => ReturnDocument::Before,
            Returned::After => ReturnDocument::After,
        }
    }
}

/// A prepared `findOneAndUpdate`. Run it with [`crate::mongo::write::Writes`].
#[must_use = "a prepared update does nothing until it is executed, and its dropped paths must be checked"]
#[derive(Clone, Debug, PartialEq)]
pub struct PreparedFindAndModify {
    /// The filter to send.
    pub filter: Document,
    /// What to send, or `None` when Mongoose runs a plain `findOne` instead (empty update
    /// without upsert).
    pub update: Option<UpdateDoc>,
    /// The `arrayFilters` to send, when the caller gave some.
    pub array_filters: Option<Vec<Document>>,
    /// Which document the call returns; pass [`PreparedFindAndModify::return_document`] to the
    /// driver (rule 29).
    pub returned: Returned,
    /// Pass to the driver's `upsert`.
    pub upsert: bool,
    /// Paths strict mode dropped.
    pub dropped_paths: Vec<String>,
}

impl PreparedFindAndModify {
    /// The driver option for [`PreparedFindAndModify::returned`].
    pub fn return_document(&self) -> ReturnDocument {
        self.returned.into()
    }
}

/// `Model.findOneAndUpdate` / `findByIdAndUpdate`.
pub fn prepare_find_one_and_update(
    schema: &Schema,
    filter: &Document,
    update: impl Into<Update>,
    options: UpdateOptions,
    returned: Returned,
    ctx: &mut WriteContext,
) -> Result<PreparedFindAndModify, PrepareError> {
    let update = update.into();
    check_inputs(filter, &update, &options)?;
    let filter = &node_filter(filter);
    let mut caster = Caster::new(ctx);
    let prepared = match update {
        Update::Pipeline(stages) => {
            let stages = timestamps_on_pipeline(schema, stages, caster.ctx.now());
            (!stages.is_empty()).then_some(UpdateDoc::Pipeline(stages))
        }
        Update::Document(mut doc) => {
            decorate_version_key(schema, &mut doc, options.upsert);
            apply_timestamps(schema, &mut doc, caster.ctx.now());
            let mut cast = cast_update(schema, doc, options.upsert, filter, &[], &mut caster)?;
            if options.upsert && options.set_defaults_on_insert {
                set_defaults_on_insert(schema, filter, &mut cast, &mut caster)?;
            }
            if cast.is_empty() {
                options.upsert.then(|| {
                    let mut doc = Document::new();
                    doc.insert("$set", Document::new());
                    UpdateDoc::Document(doc)
                })
            } else {
                if matches!(cast.get("$set"), Some(Bson::Document(set)) if set.is_empty()) {
                    cast.remove("$set");
                }
                Some(UpdateDoc::Document(cast))
            }
        }
    };
    Ok(PreparedFindAndModify {
        filter: filter.clone(),
        update: prepared.map(UpdateDoc::node_numbers),
        array_filters: node_array_filters(options.array_filters),
        returned,
        upsert: options.upsert,
        dropped_paths: caster.dropped,
    })
}

/// The kind of `bulkWrite` update operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BulkUpdate {
    /// `{ updateOne: … }`.
    UpdateOne,
    /// `{ updateMany: … }`.
    UpdateMany,
}

/// The `u` of one `bulkWrite` update operation. `castBulkWrite` applies the same steps as the
/// query path but in another order (timestamps, defaults and version key before casting for
/// `updateOne`; defaults before timestamps for `updateMany`), and never skips an empty update.
pub fn prepare_bulk_update(
    schema: &Schema,
    filter: &Document,
    update: impl Into<Update>,
    kind: BulkUpdate,
    options: UpdateOptions,
    ctx: &mut WriteContext,
) -> Result<PreparedUpdate, PrepareError> {
    let update = update.into();
    check_inputs(filter, &update, &options)?;
    let filter = &node_filter(filter);
    let mut caster = Caster::new(ctx);
    let prepared = match update {
        Update::Pipeline(stages) => {
            UpdateDoc::Pipeline(timestamps_on_pipeline(schema, stages, caster.ctx.now()))
        }
        Update::Document(mut doc) => {
            let defaults = options.upsert && options.set_defaults_on_insert;
            let mut precast = Vec::new();
            match kind {
                BulkUpdate::UpdateOne => {
                    apply_timestamps(schema, &mut doc, caster.ctx.now());
                    if defaults {
                        precast = set_defaults_on_insert(schema, filter, &mut doc, &mut caster)?;
                    }
                }
                BulkUpdate::UpdateMany => {
                    if defaults {
                        precast = set_defaults_on_insert(schema, filter, &mut doc, &mut caster)?;
                    }
                    apply_timestamps(schema, &mut doc, caster.ctx.now());
                }
            }
            decorate_version_key(schema, &mut doc, options.upsert);
            UpdateDoc::Document(cast_update(
                schema,
                doc,
                options.upsert,
                filter,
                &precast,
                &mut caster,
            )?)
        }
    };
    Ok(PreparedUpdate {
        filter: filter.clone(),
        update: Some(prepared.node_numbers()),
        upsert: options.upsert,
        array_filters: node_array_filters(options.array_filters),
        dropped_paths: caster.dropped,
    })
}

/// Bounds the nesting of everything the caller passed ([`crate::mongo::cast::MAX_DEPTH`]).
fn check_inputs(
    filter: &Document,
    update: &Update,
    options: &UpdateOptions,
) -> Result<(), PrepareError> {
    check_document_depth(filter)?;
    match update {
        Update::Document(doc) => check_document_depth(doc)?,
        Update::Pipeline(stages) => stages.iter().try_for_each(check_document_depth)?,
    }
    options
        .array_filters
        .iter()
        .flatten()
        .try_for_each(check_document_depth)
}

fn node_array_filters(filters: Option<Vec<Document>>) -> Option<Vec<Document>> {
    filters.map(|filters| filters.iter().map(node_filter).collect())
}

/// The filter with its numbers typed as Node sends them (an upsert copies its equality fields
/// into the new document, so their types are stored).
fn node_filter(filter: &Document) -> Document {
    let mut filter = filter.clone();
    normalize_js_numbers(&mut filter);
    filter
}

/// `decorateUpdateWithVersionKey`: an upsert that does not set the version key gets
/// `$setOnInsert.<versionKey> = 0`.
fn decorate_version_key(schema: &Schema, update: &mut Document, upsert: bool) {
    let Some(key) = schema.version_key else {
        return;
    };
    if !upsert {
        return;
    }
    let in_op =
        |op: &str| matches!(update.get(op), Some(Bson::Document(inner)) if inner.contains_key(key));
    if update.contains_key(key) || in_op("$set") || in_op("$inc") || in_op("$setOnInsert") {
        return;
    }
    put(update, "$setOnInsert", key, Bson::Int32(0));
}

/// `applyTimestampsToUpdate` for an operator document.
fn apply_timestamps(schema: &Schema, update: &mut Document, now: bson::DateTime) {
    if schema.timestamps.is_none() {
        return;
    }
    if !matches!(update.get("$set"), Some(Bson::Document(_))) {
        update.insert("$set", Document::new());
    }
    if let Some(updated_at) = schema.updated_at() {
        let current_date = matches!(update.get("$currentDate"), Some(Bson::Document(cd)) if cd.get(updated_at).is_some_and(truthy));
        if !current_date {
            put(update, "$set", updated_at, now);
            update.remove(updated_at);
        }
    }
    if let Some(created_at) = schema.created_at() {
        if update.get(created_at).is_some_and(truthy) {
            update.remove(created_at);
        }
        if let Some(Bson::Document(set)) = update.get_mut("$set")
            && set.get(created_at).is_some_and(truthy)
        {
            set.remove(created_at);
        }
        put(update, "$setOnInsert", created_at, now);
    }
    if matches!(update.get("$set"), Some(Bson::Document(set)) if set.is_empty()) {
        update.remove("$set");
    }
}

fn timestamps_on_pipeline(
    schema: &Schema,
    mut stages: Vec<Document>,
    now: bson::DateTime,
) -> Vec<Document> {
    if let Some(updated_at) = schema.updated_at() {
        let mut set = Document::new();
        set.insert(updated_at, now);
        let mut stage = Document::new();
        stage.insert("$set", set);
        stages.push(stage);
    }
    stages
}

/// Inserts `key: value` into the operator document `name` of `update`, creating the operator
/// (at the end) when it is missing or not a document.
fn put(update: &mut Document, name: &str, key: impl Into<String>, value: impl Into<Bson>) {
    if !matches!(update.get(name), Some(Bson::Document(_))) {
        update.insert(name, Document::new());
    }
    if let Some(Bson::Document(inner)) = update.get_mut(name) {
        inner.insert(key.into(), value.into());
    }
}

/// `castUpdate` for an operator document: `$set` sugar, reverse operator order, strict mode,
/// immutable paths, value casting, removal of empty operators and the empty-upsert trick.
fn cast_update(
    schema: &Schema,
    mut update: Document,
    upsert: bool,
    filter: &Document,
    precast: &[String],
    caster: &mut Caster<'_>,
) -> Result<Document, PrepareError> {
    if upsert {
        move_immutable_properties(schema, &mut update);
    }
    let mut ops: Vec<String> = update.keys().cloned().collect();
    let mut ret = Document::new();
    let mut i = ops.len();
    while i > 0 {
        i -= 1;
        let op = ops[i].clone();
        if !UPDATE_OPERATORS.contains(&op.as_str()) {
            if !ret.contains_key("$set") {
                let existing = match update.remove("$set") {
                    Some(Bson::Document(set)) => set,
                    _ => Document::new(),
                };
                ret.insert("$set", existing);
            }
            if let (Some(value), Some(Bson::Document(set))) =
                (update.remove(&op), ret.get_mut("$set"))
            {
                set.insert(op.clone(), value);
            }
            ops.remove(i);
            if !ops.iter().any(|o| o == "$set") {
                ops.push("$set".into());
            }
        } else if op == "$set" {
            if !ret.contains_key("$set")
                && let Some(value) = update.remove("$set")
            {
                ret.insert("$set", value);
            }
        } else if let Some(value) = update.remove(&op) {
            ret.insert(op, value);
        }
    }
    let mut i = ops.len();
    while i > 0 {
        i -= 1;
        let op = ops[i].clone();
        let Some(value) = ret.get_mut(&op) else {
            continue;
        };
        let Bson::Document(body) = value else {
            return Err(PrepareError::InvalidOperatorValue { op });
        };
        let skip: &[String] = if op == "$setOnInsert" { precast } else { &[] };
        walk_update_path(schema, body, &op, "", skip, caster)?;
        if op.starts_with('$') && body.is_empty() {
            ret.remove(&op);
        }
    }
    if ret.is_empty() && upsert && !filter.is_empty() {
        let mut trick = Document::new();
        trick.insert("$setOnInsert", filter.clone());
        return Ok(trick);
    }
    Ok(ret)
}

/// `moveImmutableProperties` (upserts): immutable paths in `$set` or bare go to `$setOnInsert`.
fn move_immutable_properties(schema: &Schema, update: &mut Document) {
    let keys: Vec<String> = update.keys().cloned().collect();
    for key in keys {
        if key == "$set" {
            let paths: Vec<String> = match update.get("$set") {
                Some(Bson::Document(set)) => set.keys().cloned().collect(),
                _ => continue,
            };
            for path in paths {
                if resolve(schema, &path).is_some_and(|t| t.immutable) {
                    let value = match update.get_mut("$set") {
                        Some(Bson::Document(set)) => set.remove(&path),
                        _ => None,
                    };
                    if let Some(value) = value {
                        put(update, "$setOnInsert", path, value);
                    }
                }
            }
        } else if !key.starts_with('$')
            && resolve(schema, &key).is_some_and(|t| t.immutable)
            && let Some(value) = update.remove(&key)
        {
            put(update, "$setOnInsert", key, value);
        }
    }
}

/// `walkUpdatePath`: casts every path of one operator, walking keys from the last.
fn walk_update_path(
    schema: &Schema,
    obj: &mut Document,
    op: &str,
    prefix: &str,
    precast: &[String],
    caster: &mut Caster<'_>,
) -> Result<(), PrepareError> {
    let keys: Vec<String> = obj.keys().cloned().collect();
    for key in keys.iter().rev() {
        if precast.contains(key) {
            // A default Mongoose inserted as an already cast value (bulkWrite): left as it is.
            continue;
        }
        let path = format!("{prefix}{key}");
        let Some(value) = obj.get(key).cloned() else {
            continue;
        };
        if op == "$pull"
            && resolve(schema, &path)
                .is_some_and(|t| matches!(t.kind, TargetKind::DocumentArray(_)))
        {
            // Cast as a query against the sub-schema: conditions are kept as given.
            continue;
        }
        if let Bson::Document(inner) = value {
            let target = resolve(schema, &path);
            if op != "$setOnInsert" && target.is_some_and(|t| t.immutable) {
                obj.remove(key);
                continue;
            }
            let caster_type = target.filter(|t| {
                matches!(
                    t.kind,
                    TargetKind::Array
                        | TargetKind::MixedArray
                        | TargetKind::DocumentArray(_)
                        | TargetKind::Subdocument(_)
                )
            });
            match caster_type {
                Some(target) if CAST_OPS.contains(&op) => {
                    let cast = if inner.contains_key("$each") {
                        cast_each(target, &inner, &path, caster)?
                    } else if matches!(target.kind, TargetKind::Subdocument(_)) {
                        caster.cast_value(target, Bson::Document(inner), &path)?
                    } else if op == "$push" || op == "$addToSet" {
                        caster.cast_array_element(target, Bson::Document(inner), &path)?
                    } else {
                        caster.cast_value(target, Bson::Document(inner), &path)?
                    };
                    obj.insert(key.clone(), cast);
                }
                _ => match target {
                    Some(_) if op == "$currentDate" => {
                        let mut kept = Document::new();
                        if let Some(kind) = inner.get("$type") {
                            kept.insert("$type", kind.clone());
                        }
                        obj.insert(key.clone(), kept);
                    }
                    Some(target)
                        if CAST_OPS.contains(&op)
                            && !matches!(target.kind, TargetKind::Nested(_)) =>
                    {
                        let cast = caster.cast_value(target, Bson::Document(inner), &path)?;
                        obj.insert(key.clone(), cast);
                    }
                    Some(_) => {
                        let mut inner = inner;
                        walk_update_path(schema, &mut inner, op, &format!("{path}."), &[], caster)?;
                        obj.insert(key.clone(), inner);
                    }
                    None => {
                        obj.remove(key);
                        caster.drop_path(path);
                    }
                },
            }
            continue;
        }
        let is_modifier = matches!(key.as_str(), "$each" | "$or" | "$and" | "$in");
        if is_modifier && prefix.is_empty() {
            return Err(PrepareError::UnexpectedModifier {
                modifier: key.clone(),
            });
        }
        let check_path = if is_modifier {
            prefix.trim_end_matches('.').to_owned()
        } else {
            path.clone()
        };
        let target = resolve(schema, &check_path);
        if op != "$setOnInsert" && target.is_some_and(|t| t.immutable) {
            obj.remove(key);
            continue;
        }
        let Some(target) = target else {
            obj.remove(key);
            caster.drop_path(path);
            continue;
        };
        if op == "$rename" {
            if matches!(value, Bson::Null) {
                return Err(PrepareError::InvalidRename { path });
            }
            continue;
        }
        let cast = cast_update_value(target, value, op, &path, caster)?;
        let wrap = matches!(cast, Bson::Array(_))
            && (op == "$push" || op == "$addToSet")
            && key != "$each"
            && matches!(
                target.kind,
                TargetKind::Array | TargetKind::DocumentArray(_)
            );
        if wrap {
            let mut each = Document::new();
            each.insert("$each", cast);
            obj.insert(key.clone(), each);
        } else {
            obj.insert(key.clone(), cast);
        }
    }
    Ok(())
}

/// `{$each: […], $slice, $sort, $position}` for `$push` / `$addToSet`.
fn cast_each(
    target: crate::mongo::schema::Target,
    given: &Document,
    path: &str,
    caster: &mut Caster<'_>,
) -> Result<Bson, PrepareError> {
    let each = match given.get("$each") {
        Some(Bson::Array(items)) => Bson::Array(
            items
                .iter()
                .map(|item| caster.cast_array_element(target, item.clone(), path))
                .collect::<Result<_, _>>()?,
        ),
        Some(other) => caster.cast_array_element(target, other.clone(), path)?,
        None => Bson::Null,
    };
    let mut out = Document::new();
    out.insert("$each", each);
    if let Some(slice) = given
        .get("$slice")
        .filter(|v| !matches!(v, Bson::Null | Bson::Undefined))
    {
        out.insert("$slice", js_int32(slice));
    }
    if let Some(sort) = given.get("$sort").filter(|v| truthy(v)) {
        out.insert("$sort", sort.clone());
    }
    if let Some(position) = given
        .get("$position")
        .filter(|v| !matches!(v, Bson::Null | Bson::Undefined))
    {
        out.insert("$position", position.clone());
    }
    Ok(Bson::Document(out))
}

/// `value | 0` in JavaScript.
fn js_int32(value: &Bson) -> Bson {
    let number = crate::mongo::number::read_number(value).unwrap_or(0.0);
    if !number.is_finite() {
        return Bson::Int32(0);
    }
    // ToInt32: modulo 2^32, then into the signed range.
    let wrapped = number.trunc().rem_euclid(4_294_967_296.0);
    let signed = if wrapped >= 2_147_483_648.0 {
        wrapped - 4_294_967_296.0
    } else {
        wrapped
    };
    Bson::Int32(signed as i32)
}

/// `castUpdateVal` for a value that is not a plain object.
fn cast_update_value(
    target: crate::mongo::schema::Target,
    value: Bson,
    op: &str,
    path: &str,
    caster: &mut Caster<'_>,
) -> Result<Bson, PrepareError> {
    Ok(match op {
        "$inc" | "$pop" | "$unset" => value,
        "$currentDate" => Bson::Boolean(truthy(&value)),
        "$push" | "$addToSet" => match value {
            Bson::Array(items) => Bson::Array(
                items
                    .into_iter()
                    .map(|item| caster.cast_array_element(target, item, path))
                    .collect::<Result<_, _>>()?,
            ),
            other => caster.cast_array_element(target, other, path)?,
        },
        "$set" | "$setOnInsert" => caster.cast_value(target, value, path)?,
        _ => match (target.kind, value) {
            (TargetKind::Value, Bson::String(text)) if target.trim => {
                Bson::String(dima_text::trim(&text).to_owned())
            }
            (_, other) => other,
        },
    })
}

/// `setDefaultsOnInsert`: every schema default whose path the filter does not pin and the
/// update does not touch goes into `$setOnInsert`.
fn set_defaults_on_insert(
    schema: &Schema,
    filter: &Document,
    update: &mut Document,
    caster: &mut Caster<'_>,
) -> Result<Vec<String>, PrepareError> {
    let mut inserted = Vec::new();
    let has_dollar = update.keys().any(|k| k.starts_with('$'));
    let mut pinned: Vec<String> = Vec::new();
    for (path, condition) in filter {
        if let Bson::Document(inner) = condition
            && inner.keys().any(|k| k.starts_with('$'))
        {
            continue;
        }
        pinned.push(path.clone());
        let pieces: Vec<&str> = path.split('.').collect();
        for end in 1..pieces.len() {
            pinned.push(pieces[..end].join("."));
        }
    }
    for leaf in schema.leaves() {
        let Leaf::Field { path, field } = leaf else {
            continue;
        };
        let Some(value) = caster.default_value(field, &path, true)? else {
            continue;
        };
        if is_modified(update, &pinned, &path, has_dollar) {
            continue;
        }
        let already =
            get_path(update, &path).is_some_and(|v| !matches!(v, Bson::Null | Bson::Undefined));
        if !already {
            put(update, "$setOnInsert", path.clone(), value);
            inserted.push(path);
        } else if !update.contains_key("$setOnInsert") {
            update.insert("$setOnInsert", Document::new());
        }
    }
    Ok(inserted)
}

fn is_modified(update: &Document, pinned: &[String], path: &str, has_dollar: bool) -> bool {
    let pieces: Vec<&str> = path.split('.').collect();
    if pinned.iter().any(|p| p == path) {
        return true;
    }
    for end in 1..pieces.len() {
        let prefix = pieces[..end].join(".");
        if pinned.contains(&prefix) {
            return true;
        }
    }
    if has_dollar {
        update
            .iter()
            .filter(|(key, _)| key.starts_with('$'))
            .any(|(_, value)| matches!(value, Bson::Document(inner) if path_exists_in_update(inner, path, &pieces)))
    } else {
        path_exists_in_update(update, path, &pieces)
    }
}

fn path_exists_in_update(update: &Document, path: &str, pieces: &[&str]) -> bool {
    if update.contains_key(path) {
        return true;
    }
    for end in 1..pieces.len() {
        if update.contains_key(pieces[..end].join(".")) {
            return true;
        }
    }
    let child = format!("{path}.");
    update.keys().any(|key| key.starts_with(&child))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mongo::schema::{DefaultValue as D, Field, Timestamps};
    use bson::doc;

    static SUB: Schema = Schema::subdocument(&[
        Field::value("label").trim(),
        Field::value("n").default(D::Int(1)),
    ]);
    static S: Schema = Schema::new(&[
        Field::value("name").trim(),
        Field::value("key").immutable(),
        Field::value("count").default(D::Int(0)),
        Field::array("tags"),
        Field::document_array("items", &SUB),
    ])
    .timestamps(Timestamps::CAMEL);

    const NOW: i64 = 981_173_106_789;

    fn now() -> bson::DateTime {
        bson::DateTime::from_millis(NOW)
    }

    #[test]
    fn plain_update_gets_timestamps_and_reverse_operator_order() -> Result<(), PrepareError> {
        let mut ctx = WriteContext::new(NOW);
        let out = prepare_update(
            &S,
            &doc! {},
            doc! { "name": "  yo ", "$inc": { "count": 1 }, "count": 4 },
            UpdateOptions::default(),
            &mut ctx,
        )?;
        let expected = doc! {
            "$setOnInsert": { "createdAt": now() },
            "$set": { "updatedAt": now(), "count": 4, "name": "yo" },
            "$inc": { "count": 1 },
        };
        assert_eq!(out.update, Some(UpdateDoc::Document(expected)));
        Ok(())
    }

    #[test]
    fn upsert_adds_version_and_defaults() -> Result<(), PrepareError> {
        let mut ctx = WriteContext::new(NOW);
        let out = prepare_update(
            &S,
            &doc! { "name": "x" },
            doc! { "$set": { "key": "k" } },
            UpdateOptions::upsert(),
            &mut ctx,
        )?;
        let expected = doc! {
            "$setOnInsert": { "__v": 0, "createdAt": now(), "key": "k", "count": 0, "tags": [], "items": [] },
            "$set": { "updatedAt": now() },
        };
        assert_eq!(out.update, Some(UpdateDoc::Document(expected)));
        Ok(())
    }

    #[test]
    fn empty_update_without_timestamps_is_not_sent() -> Result<(), PrepareError> {
        static PLAIN: Schema = Schema::new(&[Field::value("a")]).no_version_key();
        let mut ctx = WriteContext::new(NOW);
        let empty = prepare_update(
            &PLAIN,
            &doc! {},
            doc! { "$set": {} },
            UpdateOptions::default(),
            &mut ctx,
        )?;
        assert_eq!((empty.update, empty.dropped_paths), (None, Vec::new()));
        let unknown = prepare_update(
            &PLAIN,
            &doc! {},
            doc! { "$set": { "zz": 1, "a": 2 } },
            UpdateOptions::default(),
            &mut ctx,
        )?;
        assert_eq!(unknown.dropped_paths, ["zz"]);
        // Only unknown paths: nothing is sent, and the caller still learns what was dropped.
        let only_unknown = prepare_update(
            &PLAIN,
            &doc! {},
            doc! { "$set": { "zz": 1 }, "yy": 2, "$inc": { "xx": 1 } },
            UpdateOptions::default(),
            &mut ctx,
        )?;
        assert_eq!(only_unknown.update, None);
        assert_eq!(only_unknown.dropped_paths, ["xx", "yy", "zz"]);
        Ok(())
    }

    #[test]
    fn push_of_array_becomes_each_and_subdocs_are_built() -> Result<(), PrepareError> {
        let mut ctx = WriteContext::with_sequential_ids(NOW, 1);
        let out = prepare_update(
            &S,
            &doc! {},
            doc! { "$push": { "tags": ["p", "q"], "items": { "label": " 👋 " } } },
            UpdateOptions::default(),
            &mut ctx,
        )?;
        let Some(UpdateDoc::Document(update)) = out.update else {
            panic!("expected an update");
        };
        let push = update
            .get_document("$push")
            .map_err(|_| PrepareError::MissingId)?;
        assert_eq!(
            push.get("tags"),
            Some(&Bson::Document(doc! { "$each": ["p", "q"] }))
        );
        let item = push
            .get_document("items")
            .map_err(|_| PrepareError::MissingId)?;
        assert_eq!(item.get_str("label").ok(), Some("👋"));
        assert_eq!(item.get("n"), Some(&Bson::Int32(1)));
        assert!(item.get_object_id("_id").is_ok());
        Ok(())
    }

    #[test]
    fn js_int32_matches_bitwise_or() {
        assert_eq!(js_int32(&Bson::Double(-10.7)), Bson::Int32(-10));
        assert_eq!(js_int32(&Bson::Double(4_294_967_297.0)), Bson::Int32(1));
        assert_eq!(
            js_int32(&Bson::Double(2_147_483_648.0)),
            Bson::Int32(-2_147_483_648)
        );
        assert_eq!(js_int32(&Bson::Double(f64::NAN)), Bson::Int32(0));
        assert_eq!(js_int32(&Bson::String("x".into())), Bson::Int32(0));
    }
}
