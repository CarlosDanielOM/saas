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
//! - nothing to write: `Ok(None)`, no command at all.
//!
//! Hooks are not part of this: the `pre('save')` hooks of `admins`, `events`, `clipdesigns`,
//! `app_configs`, `referralcodes`, `channelaipersonalities` and the availability hook must be
//! reproduced by the caller as changes (for example `Change::set("updatedAt", now)`), as
//! listed in the ledger's hooks table.

use crate::mongo::cast::{
    Caster, PrepareError, WriteContext, deep_equal, get_path, remove_path, set_path,
};
use crate::mongo::schema::{Field, Kind, Schema, TargetKind, resolve};
use bson::{Bson, Document};

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

/// The `updateOne` a save sends.
#[derive(Clone, Debug, PartialEq)]
pub struct PreparedSave {
    /// `{_id, [__v]}`. A `matched_count` of 0 with `__v` in it is Mongoose's `VersionError`.
    pub filter: Document,
    /// The update.
    pub update: Document,
    /// Paths strict mode dropped (unknown to the schema).
    pub dropped_paths: Vec<String>,
}

/// What a save sends for `loaded` (the stored document, as read) after `changes`.
pub fn prepare_save(
    schema: &Schema,
    loaded: &Document,
    changes: &[Change],
    ctx: &mut WriteContext,
) -> Result<Option<PreparedSave>, PrepareError> {
    let id = loaded.get("_id").cloned().ok_or(PrepareError::MissingId)?;
    let mut caster = Caster::new(ctx);
    let (mut doc, mut defaults) = caster.hydrate(schema, loaded)?;
    let mut tracker = Tracker::default();

    for change in changes {
        match change {
            Change::Set(path, value) => {
                let Some(target) = resolve(schema, path) else {
                    caster.drop_path(path.clone());
                    continue;
                };
                let cast = match (target.kind, value) {
                    (TargetKind::Nested(fields), Bson::Document(given)) => {
                        Bson::Document(caster.set_nested(fields, given, &format!("{path}."))?)
                    }
                    _ => caster.cast_value(target, value.clone(), path)?,
                };
                let current = get_path(&doc, path);
                // Setting a defaulted path to its (current) default value still counts.
                let is_default = defaults.iter().any(|d| d == path) && !matches!(cast, Bson::Null);
                let modify = tracker.is_modified(path)
                    || !current.is_some_and(|c| deep_equal(&cast, c))
                    || is_default;
                if !modify {
                    continue;
                }
                if !set_path(&mut doc, path, cast) {
                    return Err(PrepareError::InvalidChange {
                        path: path.clone(),
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
            }
            Change::Unset(path) => {
                if resolve(schema, path).is_none() {
                    caster.drop_path(path.clone());
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
                let mut items = match get_path(&doc, path) {
                    Some(Bson::Array(items)) => items.clone(),
                    None | Some(Bson::Null) => Vec::new(),
                    Some(_) => {
                        return Err(PrepareError::InvalidChange {
                            path: path.clone(),
                            reason: "not an array",
                        });
                    }
                };
                items.extend(cast.iter().cloned());
                if !set_path(&mut doc, path, Bson::Array(items)) {
                    return Err(PrepareError::InvalidChange {
                        path: path.clone(),
                        reason: "its parent is not a document",
                    });
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
    let all: Vec<String> = dirty.iter().map(|(p, _)| p.clone()).collect();
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
    if minimal.is_empty() {
        return Ok(None);
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
    let mut filter = Document::new();
    filter.insert("_id", id);
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
    Ok(Some(PreparedSave {
        filter,
        update,
        dropped_paths: caster.dropped,
    }))
}

/// Which paths changed, in order, and how each changed array is to be written.
#[derive(Default)]
struct Tracker {
    modified: Vec<String>,
    arrays: Vec<(String, ArrayWrite)>,
}

enum ArrayWrite {
    Push(Vec<Bson>),
    Replace,
}

impl Tracker {
    fn is_modified(&self, path: &str) -> bool {
        self.modified.iter().any(|p| p == path)
    }

    fn modify(&mut self, path: &str) {
        if !self.is_modified(path) {
            self.modified.push(path.to_owned());
        }
    }

    fn replace_array(&mut self, path: &str) {
        match self.arrays.iter_mut().find(|(p, _)| p == path) {
            Some((_, write)) => *write = ArrayWrite::Replace,
            None => self.arrays.push((path.to_owned(), ArrayWrite::Replace)),
        }
    }

    fn push(&mut self, path: &str, values: Vec<Bson>) {
        match self.arrays.iter_mut().find(|(p, _)| p == path) {
            Some((_, ArrayWrite::Push(existing))) => existing.extend(values),
            Some((_, ArrayWrite::Replace)) => {}
            None => self
                .arrays
                .push((path.to_owned(), ArrayWrite::Push(values))),
        }
    }

    fn pushed(&self, path: &str) -> Option<&[Bson]> {
        self.arrays
            .iter()
            .find(|(p, _)| p == path)
            .and_then(|(_, write)| match write {
                ArrayWrite::Push(values) => Some(values.as_slice()),
                ArrayWrite::Replace => None,
            })
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
            if target.is_some_and(|t| matches!(t.kind, TargetKind::Map)) {
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
        if field.is_some_and(|f| matches!(f.kind, Kind::Map)) {
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
        assert_eq!(prepare_save(&S, &loaded(), &[], &mut ctx)?, None);
        assert_eq!(
            prepare_save(&S, &loaded(), &[Change::set("count", 2.0)], &mut ctx)?,
            None
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
            push.map(|p| (p.filter, p.update)),
            Some((
                doc! { "_id": ObjectId::from_bytes([1; 12]) },
                doc! { "$push": { "tags": { "$each": ["y"] } }, "$set": { "updatedAt": now }, "$inc": { "__v": 1 } }
            ))
        );
        let replace = prepare_save(
            &S,
            &loaded(),
            &[Change::set("tags", vec![Bson::from("z")])],
            &mut ctx,
        )?;
        assert_eq!(
            replace.map(|p| p.filter),
            Some(doc! { "_id": ObjectId::from_bytes([1; 12]), "__v": 3 })
        );
        let element = prepare_save(
            &S,
            &loaded(),
            &[Change::set("items.0.label", "  שלום ")],
            &mut ctx,
        )?;
        assert_eq!(
            element.map(|p| (p.filter, p.update)),
            Some((
                doc! { "_id": ObjectId::from_bytes([1; 12]), "__v": 3 },
                doc! { "$set": { "items.0.label": "שלום", "updatedAt": now } }
            ))
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
            out.map(|p| p.update),
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
