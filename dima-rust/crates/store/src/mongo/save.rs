//! `doc.save()` of a document that was loaded, changed and saved, expressed as the
//! `updateOne(filter, update)` Mongoose sends (ledger `mongo.md`, rules 1, 5, 9, 10, 13, 14).
//!
//! Mongoose hydrates the loaded document (adding defaults for missing paths), tracks which
//! paths the code changed, and on save sends only those plus the defaults it added (gh-2558:
//! a document written without some defaulted fields gains them on its next save). The rules,
//! all pinned by the golden recording:
//!
//! - the update holds the changed paths in the order they were first changed, then
//!   `updatedAt` (only if something changed), then the hydration defaults (literal defaults,
//!   then defaults of loaded single nested sub-documents, then function defaults; `null`
//!   defaults are not written); a path under another dirty path is left out;
//! - a value equal to the current one is not a change (numbers by value, objects by keys in any
//!   order); setting a path back to its own default value is;
//! - `undefined` becomes `$unset: {path: 1}`, `null` is `$set`; pushes are
//!   `$push: {path: {$each: [...]}}`, but an array that is also replaced is `$set` whole;
//! - with a version key: a push bumps `__v` (`$inc`); replacing an array, or a `$set` whose
//!   value is an array (defaults included), both bumps it and adds the current `__v` to the
//!   filter; changing a path inside an array element adds `__v` to the filter only;
//! - with `minimize`, an object that is empty after removing its empty objects is moved from
//!   `$set` to `$unset` (appended last);
//! - immutable paths (`immutable: true` and the creation timestamp) keep their stored value:
//!   setting or unsetting one at the top level, in a nested object or in a loaded single nested
//!   sub-document is ignored; setting one inside a document array element writes the stored
//!   value back (`$set: {'entries.0.code': <stored>}`), or removes the value from an element
//!   added by this save; a whole nested object that is set loses its immutable paths, a whole
//!   single nested sub-document takes them from the stored one, and the elements of a document
//!   array that is set whole lose them (pushed elements keep them);
//! - a path inside a missing single nested sub-document creates it with its defaults and sets
//!   it whole (`$set: {one: {k: 1, when: …}}`);
//! - every number in the filter and the update is typed as the Node BSON writer types a
//!   JavaScript number (a loaded int64 `__v` goes into the filter as int32);
//! - nothing to write: `update` is `None`, no command at all (the dropped paths are still
//!   reported).
//!
//! Hooks are not part of this: the `pre('save')` hooks of `admins`, `events`, `clipdesigns`,
//! `app_configs`, `referralcodes`, `channelaipersonalities` and the availability hook must be
//! reproduced by the caller as changes (for example `Change::set("updatedAt", now)`), as
//! listed in the ledger's hooks table.

use crate::mongo::cast::{
    Caster, PrepareError, WriteContext, check_depth_at, check_document_depth, check_map_key,
    deep_equal, get_path, get_path_mut, remove_path, set_path,
};
use crate::mongo::number::normalize_js_numbers;
use crate::mongo::schema::{Field, Kind, MapOf, Schema, Target, TargetKind, resolve};
use bson::{Bson, Document};
use std::collections::{HashMap, HashSet};

/// One change the code makes to a loaded document before calling `save()`.
#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    /// `doc.set(path, value)` / `doc.path = value`.
    Set(String, Bson),
    /// `doc.set(path, undefined)`.
    Unset(String),
    /// `doc.path.push(...values)`.
    Push(String, Vec<Bson>),
}

impl Change {
    /// [`Change::Set`].
    pub fn set(path: impl Into<String>, value: impl Into<Bson>) -> Self {
        Self::Set(path.into(), value.into())
    }

    /// [`Change::Unset`].
    pub fn unset(path: impl Into<String>) -> Self {
        Self::Unset(path.into())
    }

    /// [`Change::Push`].
    pub fn push(path: impl Into<String>, values: impl IntoIterator<Item = Bson>) -> Self {
        Self::Push(path.into(), values.into_iter().collect())
    }
}

/// The `updateOne` a save sends. Run it with [`crate::mongo::write::Writes::save`], which
/// enforces [`PreparedSave::dropped_paths`] and reports a conflict when nothing matched.
#[must_use = "a prepared save does nothing until it is executed, and its dropped paths must be checked"]
#[derive(Clone, Debug, PartialEq)]
pub struct PreparedSave {
    /// `{_id, [__v]}`. A `matched_count` of 0 with `__v` in it is Mongoose's `VersionError`.
    pub filter: Document,
    /// The update, or `None` when nothing changed (Mongoose sends no command).
    pub update: Option<Document>,
    /// Paths strict mode dropped (unknown to the schema).
    pub dropped_paths: Vec<String>,
}

impl PreparedSave {
    /// Adds compare-and-set predicates to the filter, as Mongoose's `doc.$where` does
    /// (`ai_personality.service.ts:414` guards a save with `{updatedAt, __v}`): each key goes
    /// after `_id` and the version condition, and a key already there (the version key) keeps
    /// its position and takes the predicate's value. The values are sent as given (Mongoose does
    /// not cast them), numbers typed as Node types them.
    ///
    /// A save with nothing to write ignores the predicates, as Mongoose does: it only checks that
    /// the document still exists (`findOne({_id})`), so it succeeds even when a predicate no
    /// longer holds. Run the save with [`crate::mongo::write::Writes::save`], which reports a
    /// filter that matched nothing as [`crate::mongo::write::SaveOutcome::Conflict`].
    pub fn with_predicates(mut self, predicates: &Document) -> Result<Self, PrepareError> {
        check_document_depth(predicates)?;
        if self.update.is_none() {
            return Ok(self);
        }
        for (key, value) in predicates {
            self.filter.insert(key.clone(), value.clone());
        }
        normalize_js_numbers(&mut self.filter);
        Ok(self)
    }
}

/// What a save sends for `loaded` (the stored document, as read) after `changes`.
pub fn prepare_save(
    schema: &Schema,
    loaded: &Document,
    changes: &[Change],
    ctx: &mut WriteContext,
) -> Result<PreparedSave, PrepareError> {
    let id = loaded.get("_id").cloned().ok_or(PrepareError::MissingId)?;
    check_document_depth(loaded)?;
    for change in changes {
        match change {
            // A value set at `a.b` sits at level 3 of the document; a pushed one, one deeper.
            Change::Set(path, value) => check_depth_at(value, path.split('.').count() + 1)?,
            Change::Unset(_) => {}
            Change::Push(path, values) => {
                let level = path.split('.').count() + 2;
                values
                    .iter()
                    .try_for_each(|value| check_depth_at(value, level))?;
            }
        }
    }
    let mut caster = Caster::new(ctx);
    let (mut doc, mut defaults) = caster.hydrate(schema, loaded)?;
    let mut tracker = Tracker::default();
    // Document arrays this save replaced whole: their elements are all new.
    let mut replaced: HashSet<String> = HashSet::new();

    for change in changes {
        match change {
            Change::Set(path, value) => {
                let Some(target) = resolve(schema, path) else {
                    caster.drop_path(path.clone());
                    continue;
                };
                let place = place_of(schema, path);
                if let Place::InMap {
                    path: map_path,
                    key,
                    of,
                } = &place
                {
                    check_map_key(map_path, key)?;
                    // An entry of a missing (or null) Map: Mongoose sets the whole Map.
                    if path.split('.').count() == map_path.split('.').count() + 1
                        && matches!(get_path(&doc, map_path), None | Some(Bson::Null))
                    {
                        let mut built = Document::new();
                        built.insert(key.clone(), cast_change(&mut caster, target, path, value)?);
                        let whole = Target::of_kind(TargetKind::Map(*of));
                        commit(
                            &mut doc,
                            &mut defaults,
                            &mut tracker,
                            map_path,
                            Bson::Document(built),
                            whole,
                        )?;
                        continue;
                    }
                }
                // A path inside a missing (or null) single nested sub-document: Mongoose builds
                // the sub-document (with its defaults) and sets it whole.
                if let Place::InSubdocument {
                    path: sub_path,
                    schema: sub,
                } = &place
                    && matches!(get_path(&doc, sub_path), None | Some(Bson::Null))
                {
                    let mut built = caster.construct(sub, None, "")?;
                    let rest = path
                        .strip_prefix(sub_path.as_str())
                        .and_then(|rest| rest.strip_prefix('.'))
                        .unwrap_or_default();
                    if !target.immutable {
                        let cast = cast_change(&mut caster, target, path, value)?;
                        set_path(&mut built, rest, cast);
                    }
                    let whole = Target::of_kind(TargetKind::Subdocument(sub));
                    commit(
                        &mut doc,
                        &mut defaults,
                        &mut tracker,
                        sub_path,
                        Bson::Document(built),
                        whole,
                    )?;
                    continue;
                }
                if target.immutable {
                    // An immutable path keeps its stored value. Top-level, nested and single
                    // nested paths: the change is ignored. Inside a document array element:
                    // the element's value becomes the stored one again (none for an element
                    // added by this save), and the path counts as changed unless both are
                    // missing (recorded: `save_immutable_*`).
                    if let Place::InElement { array, index } = &place {
                        let original = !replaced.contains(array)
                            && matches!(get_path(loaded, array), Some(Bson::Array(items)) if *index < items.len());
                        let prior = original.then(|| get_path(loaded, path).cloned()).flatten();
                        let current = get_path(&doc, path).is_some();
                        match prior {
                            Some(value) => {
                                set_path(&mut doc, path, value);
                            }
                            None if current => {
                                remove_path(&mut doc, path);
                            }
                            None => continue,
                        }
                        tracker.modify(path);
                    }
                    continue;
                }
                let mut cast = cast_change(&mut caster, target, path, value)?;
                // Immutable paths inside a whole new value (recorded): a nested object loses
                // them, a single nested sub-document takes the stored values, the elements of a
                // replaced document array lose them.
                match (target.kind, &mut cast) {
                    (TargetKind::Nested(fields), Bson::Document(built)) => {
                        drop_immutables(fields, built);
                    }
                    (TargetKind::Subdocument(sub), Bson::Document(built)) => {
                        let prior = get_path(loaded, path).and_then(Bson::as_document);
                        restore_immutables(sub.fields, built, prior);
                    }
                    (TargetKind::DocumentArray(sub), Bson::Array(items)) => {
                        for item in items.iter_mut() {
                            if let Bson::Document(built) = item {
                                drop_immutables(sub.fields, built);
                            }
                        }
                        replaced.insert(path.clone());
                    }
                    _ => {}
                }
                commit(&mut doc, &mut defaults, &mut tracker, path, cast, target)?;
            }
            Change::Unset(path) => {
                let Some(target) = resolve(schema, path) else {
                    caster.drop_path(path.clone());
                    continue;
                };
                if target.immutable {
                    // `doc.set(path, undefined)` on an immutable path keeps the stored value.
                    continue;
                }
                let was_default = defaults.iter().any(|d| d == path);
                let present = get_path(&doc, path).is_some();
                remove_path(&mut doc, path);
                if present && !was_default || tracker.is_modified(path) {
                    tracker.modify(path);
                }
            }
            Change::Push(path, values) => {
                let target = resolve(schema, path).filter(|t| {
                    matches!(
                        t.kind,
                        TargetKind::Array | TargetKind::MixedArray | TargetKind::DocumentArray(_)
                    )
                });
                let Some(target) = target else {
                    return Err(PrepareError::InvalidChange {
                        path: path.clone(),
                        reason: "not an array path",
                    });
                };
                let cast: Vec<Bson> = values
                    .iter()
                    .map(|value| caster.cast_array_element(target, value.clone(), path))
                    .collect::<Result<_, _>>()?;
                // Appended in place: repeated pushes stay linear in what they add.
                match get_path_mut(&mut doc, path) {
                    Some(Bson::Array(items)) => items.extend(cast.iter().cloned()),
                    None | Some(Bson::Null) => {
                        if !set_path(&mut doc, path, Bson::Array(cast.clone())) {
                            return Err(PrepareError::InvalidChange {
                                path: path.clone(),
                                reason: "its parent is not a document",
                            });
                        }
                    }
                    Some(_) => {
                        return Err(PrepareError::InvalidChange {
                            path: path.clone(),
                            reason: "not an array",
                        });
                    }
                }
                defaults.retain(|d| d != path);
                tracker.modify(path);
                tracker.push(path, cast);
            }
        }
    }

    if !tracker.modified.is_empty()
        && let Some(updated_at) = schema.updated_at()
    {
        doc.insert(updated_at, caster.ctx.now());
        tracker.modify(updated_at);
    }

    // `$__dirty`: changed paths, then non-null defaults; then the minimal set.
    let mut dirty: Vec<(String, Option<Bson>)> = tracker
        .modified
        .iter()
        .map(|path| (path.clone(), get_path(&doc, path).cloned()))
        .collect();
    for path in &defaults {
        if path == "_id" {
            continue;
        }
        if let Some(value) =
            get_path(&doc, path).filter(|v| !matches!(v, Bson::Null | Bson::Undefined))
        {
            dirty.push((path.clone(), Some(value.clone())));
        }
    }
    let all: HashSet<String> = dirty.iter().map(|(p, _)| p.clone()).collect();
    let mut minimal = Vec::new();
    for (path, value) in dirty {
        let pieces: Vec<&str> = path.split('.').collect();
        let parent = (1..pieces.len())
            .map(|end| pieces[..end].join("."))
            .find(|prefix| all.contains(prefix));
        match parent {
            None => minimal.push((path, value)),
            Some(parent) => tracker.replace_array(&parent),
        }
    }
    let mut filter = Document::new();
    filter.insert("_id", id);
    if minimal.is_empty() {
        normalize_js_numbers(&mut filter);
        return Ok(PreparedSave {
            filter,
            update: None,
            dropped_paths: caster.dropped,
        });
    }

    // `$__delta` with versioning.
    let mut update = Document::new();
    let mut version = Version::default();
    for (path, value) in minimal {
        match value {
            None => operand(&mut update, &mut version, "$unset", &path, Bson::Int32(1)),
            Some(Bson::Null) => operand(&mut update, &mut version, "$set", &path, Bson::Null),
            Some(value) => match tracker.pushed(&path) {
                Some(items) => {
                    let mut each = Document::new();
                    each.insert("$each", Bson::Array(items.to_vec()));
                    operand(
                        &mut update,
                        &mut version,
                        "$push",
                        &path,
                        Bson::Document(each),
                    );
                }
                None => operand(&mut update, &mut version, "$set", &path, value),
            },
        }
    }
    if let Some(key) = schema.version_key {
        if version.where_clause
            && let Some(current) = doc
                .get(key)
                .filter(|v| !matches!(v, Bson::Null | Bson::Undefined))
        {
            filter.insert(key, current.clone());
        }
        if version.increment {
            let bumped = match update
                .get_document_mut("$set")
                .ok()
                .and_then(|set| set.get_mut(key))
            {
                Some(value) if !matches!(value, Bson::Null) => {
                    let next = crate::mongo::number::read_number(value).unwrap_or(0.0) + 1.0;
                    *value = crate::mongo::number::js_number(next);
                    true
                }
                _ => false,
            };
            if !bumped {
                let mut inc = match update.remove("$inc") {
                    Some(Bson::Document(inc)) => inc,
                    _ => Document::new(),
                };
                inc.insert(key, Bson::Int32(1));
                update.insert("$inc", inc);
            }
        }
    }
    if schema.minimize {
        minimize_update(schema, &mut update);
    }
    normalize_js_numbers(&mut filter);
    normalize_js_numbers(&mut update);
    Ok(PreparedSave {
        filter,
        update: Some(update),
        dropped_paths: caster.dropped,
    })
}

/// The value a `Set` change writes, cast for its path.
fn cast_change(
    caster: &mut Caster<'_>,
    target: Target,
    path: &str,
    value: &Bson,
) -> Result<Bson, PrepareError> {
    match (target.kind, value) {
        (TargetKind::Nested(fields), Bson::Document(given)) => Ok(Bson::Document(
            caster.set_nested(fields, given, &format!("{path}."))?,
        )),
        _ => caster.cast_value(target, value.clone(), path),
    }
}

/// Writes `cast` at `path` unless it equals the current value (Mongoose's `$__set` checks).
fn commit(
    doc: &mut Document,
    defaults: &mut Vec<String>,
    tracker: &mut Tracker,
    path: &str,
    cast: Bson,
    target: Target,
) -> Result<(), PrepareError> {
    let current = get_path(doc, path);
    // Setting a defaulted path to its (current) default value still counts.
    let is_default = defaults.iter().any(|d| d == path) && !matches!(cast, Bson::Null);
    let modify =
        tracker.is_modified(path) || !current.is_some_and(|c| deep_equal(&cast, c)) || is_default;
    if !modify {
        return Ok(());
    }
    if !set_path(doc, path, cast) {
        return Err(PrepareError::InvalidChange {
            path: path.to_owned(),
            reason: "its parent is not a document",
        });
    }
    defaults.retain(|d| d != path);
    tracker.modify(path);
    if matches!(
        target.kind,
        TargetKind::Array | TargetKind::MixedArray | TargetKind::DocumentArray(_)
    ) {
        tracker.replace_array(path);
    }
    Ok(())
}

/// Where a path lies, for immutability.
enum Place {
    /// Not inside a sub-document.
    Plain,
    /// Inside element `index` of the document array at `array`.
    InElement { array: String, index: usize },
    /// Inside the single nested sub-document at `path`.
    InSubdocument {
        path: String,
        schema: &'static Schema,
    },
    /// At or below entry `key` of the Map at `path`.
    InMap {
        path: String,
        key: String,
        of: MapOf,
    },
}

/// The first sub-document (array element or single nested) that `path` goes through, the
/// path's own last segment excluded.
fn place_of(schema: &Schema, path: &str) -> Place {
    let segments: Vec<&str> = path.split('.').collect();
    let Some((_, parents)) = segments.split_last() else {
        return Place::Plain;
    };
    let mut fields: &'static [Field] = schema.fields;
    for (i, segment) in parents.iter().enumerate() {
        let Some(field) = fields.iter().find(|f| f.name == *segment) else {
            return Place::Plain;
        };
        match field.kind {
            Kind::Nested(children) => fields = children,
            Kind::Subdocument(sub) => {
                return Place::InSubdocument {
                    path: segments[..=i].join("."),
                    schema: sub,
                };
            }
            Kind::Map(of) => {
                return match segments.get(i + 1) {
                    Some(key) => Place::InMap {
                        path: segments[..=i].join("."),
                        key: (*key).to_owned(),
                        of,
                    },
                    None => Place::Plain,
                };
            }
            Kind::DocumentArray(_) => {
                return match parents.get(i + 1).and_then(|s| s.parse::<usize>().ok()) {
                    Some(index) => Place::InElement {
                        array: segments[..=i].join("."),
                        index,
                    },
                    None => Place::Plain,
                };
            }
            _ => return Place::Plain,
        }
    }
    Place::Plain
}

/// Removes the immutable paths present in `doc` (nested objects included).
fn drop_immutables(fields: &[Field], doc: &mut Document) {
    for field in fields {
        match field.kind {
            Kind::Nested(children) => {
                if let Some(Bson::Document(inner)) = doc.get_mut(field.name) {
                    drop_immutables(children, inner);
                }
            }
            _ if field.immutable => {
                doc.remove(field.name);
            }
            _ => {}
        }
    }
}

/// Gives each immutable path present in `doc` the value it has in `prior` (removing it when
/// `prior` has none), keeping its position.
fn restore_immutables(fields: &[Field], doc: &mut Document, prior: Option<&Document>) {
    for field in fields {
        let before = prior.and_then(|p| p.get(field.name));
        match field.kind {
            Kind::Nested(children) => {
                if let Some(Bson::Document(inner)) = doc.get_mut(field.name) {
                    restore_immutables(children, inner, before.and_then(Bson::as_document));
                }
            }
            _ if field.immutable && doc.contains_key(field.name) => match before {
                Some(value) => {
                    doc.insert(field.name, value.clone());
                }
                None => {
                    doc.remove(field.name);
                }
            },
            _ => {}
        }
    }
}

/// Which paths changed, in order, and how each changed array is to be written. Lookups are
/// hashed, so a save with many changes stays linear.
#[derive(Default)]
struct Tracker {
    modified: Vec<String>,
    modified_set: HashSet<String>,
    arrays: HashMap<String, ArrayWrite>,
}

enum ArrayWrite {
    Push(Vec<Bson>),
    Replace,
}

impl Tracker {
    fn is_modified(&self, path: &str) -> bool {
        self.modified_set.contains(path)
    }

    fn modify(&mut self, path: &str) {
        if self.modified_set.insert(path.to_owned()) {
            self.modified.push(path.to_owned());
        }
    }

    fn replace_array(&mut self, path: &str) {
        self.arrays.insert(path.to_owned(), ArrayWrite::Replace);
    }

    fn push(&mut self, path: &str, values: Vec<Bson>) {
        match self.arrays.get_mut(path) {
            Some(ArrayWrite::Push(existing)) => existing.extend(values),
            Some(ArrayWrite::Replace) => {}
            None => {
                self.arrays
                    .insert(path.to_owned(), ArrayWrite::Push(values));
            }
        }
    }

    fn pushed(&self, path: &str) -> Option<&[Bson]> {
        match self.arrays.get(path) {
            Some(ArrayWrite::Push(values)) => Some(values.as_slice()),
            _ => None,
        }
    }
}

/// Mongoose's version flags (`VERSION_WHERE`, `VERSION_INC`).
#[derive(Default)]
struct Version {
    where_clause: bool,
    increment: bool,
}

impl Version {
    fn all(&self) -> bool {
        self.where_clause && self.increment
    }
}

/// `operand()`: adds `path` to operator `op` and updates the version flags.
fn operand(update: &mut Document, version: &mut Version, op: &str, path: &str, value: Bson) {
    let is_array = matches!(value, Bson::Array(_));
    if !matches!(update.get(op), Some(Bson::Document(_))) {
        update.insert(op, Document::new());
    }
    if let Some(Bson::Document(inner)) = update.get_mut(op) {
        inner.insert(path, value);
    }
    if version.all() {
        return;
    }
    let indexed = has_index_segment(path);
    match op {
        "$push" | "$addToSet" | "$pull" | "$pullAll" => {
            if indexed {
                *version = Version {
                    where_clause: true,
                    increment: true,
                };
            } else {
                version.increment = true;
            }
        }
        _ if op.starts_with("$p") => {
            *version = Version {
                where_clause: true,
                increment: true,
            }
        }
        _ if is_array => {
            *version = Version {
                where_clause: true,
                increment: true,
            }
        }
        _ if indexed => version.where_clause = true,
        _ => {}
    }
}

/// `/\.\d+\.|\.\d+$/`: the path goes through an array index.
fn has_index_segment(path: &str) -> bool {
    path.split('.')
        .skip(1)
        .any(|piece| !piece.is_empty() && piece.bytes().all(|b| b.is_ascii_digit()))
}

/// `minimize` in `$__handleSave`: every plain object in the update is minimized; one that ends
/// up empty moves to `$unset`.
fn minimize_update(schema: &Schema, update: &mut Document) {
    let mut unset: Vec<String> = Vec::new();
    for (op, body) in update.iter_mut() {
        let Bson::Document(body) = body else {
            continue;
        };
        let keys: Vec<String> = body.keys().cloned().collect();
        for key in keys {
            let target = if op == "$push" {
                None
            } else {
                resolve(schema, &key)
            };
            if target.is_some_and(|t| matches!(t.kind, TargetKind::Map(_))) {
                continue;
            }
            let fields = target.and_then(|t| match t.kind {
                TargetKind::Nested(fields) => Some(fields),
                TargetKind::Subdocument(sub) | TargetKind::DocumentArray(sub) => Some(sub.fields),
                _ => None,
            });
            let emptied = match body.get_mut(&key) {
                Some(Bson::Document(inner)) => {
                    minimize_fields(fields, inner);
                    inner.is_empty()
                }
                _ => false,
            };
            if emptied {
                body.remove(&key);
                unset.push(key);
            }
        }
    }
    if !unset.is_empty() {
        let mut existing = match update.remove("$unset") {
            Some(Bson::Document(existing)) => existing,
            _ => Document::new(),
        };
        for key in unset {
            existing.insert(key, Bson::Int32(1));
        }
        update.insert("$unset", existing);
    }
}

fn minimize_fields(fields: Option<&'static [Field]>, doc: &mut Document) {
    let keys: Vec<String> = doc.keys().cloned().collect();
    for key in keys {
        let field = fields.and_then(|fs| fs.iter().find(|f| f.name == key));
        if field.is_some_and(|f| matches!(f.kind, Kind::Map(_))) {
            continue;
        }
        let child = field.and_then(|f| match f.kind {
            Kind::Nested(children) => Some(children),
            Kind::Subdocument(sub) | Kind::DocumentArray(sub) => Some(sub.fields),
            _ => None,
        });
        let remove = match doc.get_mut(&key) {
            Some(Bson::Document(inner)) => {
                minimize_fields(child, inner);
                inner.is_empty()
            }
            Some(Bson::Array(items)) => {
                for item in items.iter_mut() {
                    if let Bson::Document(inner) = item {
                        minimize_fields(child, inner);
                    }
                }
                false
            }
            _ => false,
        };
        if remove {
            doc.remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mongo::schema::{DefaultValue as D, Timestamps};
    use bson::{DateTime, doc, oid::ObjectId};

    static SUB: Schema = Schema::subdocument(&[
        Field::value("label").trim(),
        Field::value("n").default(D::Int(1)),
    ]);
    static S: Schema = Schema::new(&[
        Field::value("name").trim(),
        Field::value("count").default(D::Int(0)),
        Field::array("tags"),
        Field::document_array("items", &SUB),
        Field::mixed("meta").default_fn(D::EmptyDocument),
    ])
    .timestamps(Timestamps::CAMEL);

    const NOW: i64 = 1_000;

    fn loaded() -> Document {
        doc! {
            "_id": ObjectId::from_bytes([1; 12]),
            "name": "a",
            "count": 2,
            "tags": ["x"],
            "items": [{ "label": "l", "n": 1, "_id": ObjectId::from_bytes([2; 12]) }],
            "meta": { "k": 1 },
            "createdAt": DateTime::from_millis(1),
            "updatedAt": DateTime::from_millis(1),
            "__v": 3,
        }
    }

    #[test]
    fn no_change_sends_nothing() -> Result<(), PrepareError> {
        let mut ctx = WriteContext::new(NOW);
        assert_eq!(prepare_save(&S, &loaded(), &[], &mut ctx)?.update, None);
        assert_eq!(
            prepare_save(&S, &loaded(), &[Change::set("count", 2.0)], &mut ctx)?.update,
            None
        );
        // Only unknown paths: nothing to send, and the caller still learns what was dropped.
        let unknown = prepare_save(
            &S,
            &loaded(),
            &[Change::set("zz", 1), Change::unset("yy")],
            &mut ctx,
        )?;
        assert_eq!(
            (unknown.update, unknown.dropped_paths),
            (None, vec!["zz".to_owned(), "yy".to_owned()])
        );
        Ok(())
    }

    #[test]
    fn push_increments_version_and_replace_adds_where() -> Result<(), PrepareError> {
        let mut ctx = WriteContext::new(NOW);
        let push = prepare_save(
            &S,
            &loaded(),
            &[Change::push("tags", [Bson::from("y")])],
            &mut ctx,
        )?;
        let now = DateTime::from_millis(NOW);
        assert_eq!(
            Some((push.filter, push.update)),
            Some((
                doc! { "_id": ObjectId::from_bytes([1; 12]) },
                Some(
                    doc! { "$push": { "tags": { "$each": ["y"] } }, "$set": { "updatedAt": now }, "$inc": { "__v": 1 } }
                )
            ))
        );
        let replace = prepare_save(
            &S,
            &loaded(),
            &[Change::set("tags", vec![Bson::from("z")])],
            &mut ctx,
        )?;
        assert_eq!(
            replace.filter,
            doc! { "_id": ObjectId::from_bytes([1; 12]), "__v": 3 }
        );
        let element = prepare_save(
            &S,
            &loaded(),
            &[Change::set("items.0.label", "  שלום ")],
            &mut ctx,
        )?;
        assert_eq!(
            (element.filter, element.update),
            (
                doc! { "_id": ObjectId::from_bytes([1; 12]), "__v": 3 },
                Some(doc! { "$set": { "items.0.label": "שלום", "updatedAt": now } })
            )
        );
        Ok(())
    }

    #[test]
    fn empty_object_moves_to_unset() -> Result<(), PrepareError> {
        let mut ctx = WriteContext::new(NOW);
        let out = prepare_save(
            &S,
            &loaded(),
            &[Change::set("meta", doc! { "a": {} })],
            &mut ctx,
        )?;
        assert_eq!(
            out.update,
            Some(
                doc! { "$set": { "updatedAt": DateTime::from_millis(NOW) }, "$unset": { "meta": 1 } }
            )
        );
        assert!(
            has_index_segment("items.0.label")
                && has_index_segment("items.12")
                && !has_index_segment("a0.b")
        );
        Ok(())
    }
}
