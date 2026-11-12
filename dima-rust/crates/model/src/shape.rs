//! What a write may leave in a stored document, so that the collection's read type decodes every
//! document the write helpers produce (`MIGRATION.md` section 8).
//!
//! Every write a collection's helpers prepare (create, update, `findOneAndUpdate`, upsert, save)
//! is checked here after it is prepared and before it is returned. A value is refused, as a
//! [`ValidationError`] naming the path, when:
//!
//! - its BSON type is not the schema type of its path (kind `type`). The store's write helpers
//!   send scalar values as given, where Mongoose would cast them (`'15'` to `15`, `5` to `'5'`):
//!   Rust callers pass typed values, and a value the read type cannot decode is refused instead
//!   of stored. A plain nested object, a sub-document and the elements of a document array must be
//!   documents; an array path must hold an array; the values of a Map of values its type;
//! - it is `null` where the read type has no null state (kind `null`): a [`ReadNeed`] of the
//!   collection says so (plain nested objects and sub-documents included), and the elements of
//!   arrays and the values of a Map of values are never `null`;
//! - it removes or leaves out a path the read type needs (kind `missing`): `$unset`, a whole
//!   object written without it, an upsert or a new document without it, an array element unset.
//!
//! `Mixed` paths and everything below them are free: their read types are raw BSON. Operators no
//! reference call uses (`$rename`, `$currentDate`, `$bit`) are refused. An update pipeline cannot
//! be checked (its values are expressions: `{$literal: 'bad'}` stores a string anywhere), so the
//! ordinary entry points refuse one ([`crate::ModelError::Pipeline`]); a caller that needs one
//! uses [`CollectionInfo::prepare_pipeline_update_unchecked`] and brings its own write-then-read
//! test.

use crate::collection::CollectionInfo;
use crate::validation::{ValidationError, ValidatorError, ValidatorKind};
use bson::{Bson, Document};
use dima_store::mongo::schema::{Field, IdField, Kind, MapOf, Schema, ValueType};
use dima_store::mongo::update::UpdateDoc;

/// A path whose read type has no `null` state, no missing state, or neither.
///
/// Paths are schema paths with `$` for each document array element (`config.$.id`). Declare one
/// for every read type field that is neither an `Option` nor a raw `Bson` (a field with a serde
/// default reads a missing path: `not_null`; a field without one needs `value`, or `present` when
/// its type reads `null`). `tests/write_read.rs` finds every one that is missing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReadNeed {
    /// The path.
    pub path: &'static str,
    /// `null` is refused.
    pub refuse_null: bool,
    /// Leaving the path out is refused.
    pub refuse_missing: bool,
}

impl ReadNeed {
    /// The read type reads a missing path (a serde default) but not `null`.
    pub const fn not_null(path: &'static str) -> Self {
        Self {
            path,
            refuse_null: true,
            refuse_missing: false,
        }
    }

    /// The read type needs the path but reads `null` (a raw `Bson` value without a default).
    pub const fn present(path: &'static str) -> Self {
        Self {
            path,
            refuse_null: false,
            refuse_missing: true,
        }
    }

    /// The read type needs a value: neither `null` nor missing.
    pub const fn value(path: &'static str) -> Self {
        Self {
            path,
            refuse_null: true,
            refuse_missing: true,
        }
    }
}

/// What a dotted path points at.
#[derive(Clone, Copy)]
enum Node {
    /// One value of a type (a field, an element of an array of values, a Map value).
    Value(ValueType),
    /// `Mixed`, or anything below it.
    Free,
    /// A plain nested object.
    Nested(&'static [Field]),
    /// An array of values.
    Array(ValueType),
    /// An array of `Mixed` values.
    MixedArray,
    /// An array of sub-documents.
    DocumentArray(&'static Schema),
    /// A single nested sub-document.
    Subdocument(&'static Schema),
    /// A Map.
    Map(MapOf),
}

/// Where a node sits: a field, an array element (never `null`; `$unset` writes `null` there) or
/// a Map value (never `null`; `$unset` removes the key).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Place {
    Field,
    ArrayElement,
    MapValue,
}

fn node_of(kind: Kind) -> Node {
    match kind {
        Kind::Value(ty) => Node::Value(ty),
        Kind::Mixed => Node::Free,
        Kind::Nested(fields) => Node::Nested(fields),
        Kind::Array(ty) => Node::Array(ty),
        Kind::MixedArray => Node::MixedArray,
        Kind::DocumentArray(schema) => Node::DocumentArray(schema),
        Kind::Subdocument(schema) => Node::Subdocument(schema),
        Kind::Map(of) => Node::Map(of),
    }
}

/// `0`, `$`, `$[]`, `$[name]`.
fn is_position(segment: &str) -> bool {
    (!segment.is_empty() && segment.bytes().all(|b| b.is_ascii_digit()))
        || segment == "$"
        || (segment.starts_with("$[") && segment.ends_with(']'))
}

/// The paths Mongoose adds to a schema itself. The `_id` Mongoose adds (`IdField::Auto`) is an
/// ObjectId, at the root and in every sub-document; a declared `_id` (a string one) is a field
/// and never reaches here. `tests/write_read.rs` checks that every collection's
/// [`CollectionInfo::id_type`] agrees with its schema.
fn implicit(schema: &Schema, name: &str) -> Option<Node> {
    let timestamps = schema.timestamps;
    if name == "_id" && matches!(schema.id, IdField::Auto) {
        return Some(Node::Value(ValueType::ObjectId));
    }
    if timestamps.is_some_and(|t| t.created_at == Some(name) || t.updated_at == Some(name)) {
        return Some(Node::Value(ValueType::Date));
    }
    if schema.version_key == Some(name) {
        return Some(Node::Value(ValueType::Number));
    }
    None
}

/// What an update path resolves to.
enum Resolved {
    /// A node, its place, and the schema path with `$` for positions and `$*` for Map keys.
    At(Node, Place, String),
    /// A path below one value of a Map of values (`vars.a.b`): the store writes it, and the Map
    /// value becomes an object.
    BelowMapValue(String),
}

/// Resolves an update path. `None` for a path strict mode drops.
fn resolve(schema: &'static Schema, path: &str) -> Option<Resolved> {
    let mut segments = path.split('.');
    let first = segments.next()?;
    let mut node = match schema.fields.iter().find(|f| f.name == first) {
        Some(field) => node_of(field.kind),
        None => implicit(schema, first)?,
    };
    let mut pattern: Vec<&str> = vec![first];
    let mut place = Place::Field;
    for segment in segments {
        let (next, next_place, shown) = match node {
            Node::Value(_) if place == Place::MapValue => {
                return Some(Resolved::BelowMapValue(pattern.join(".")));
            }
            Node::Value(_) => return None,
            Node::Free | Node::MixedArray | Node::Map(MapOf::Mixed) => {
                (Node::Free, Place::Field, segment)
            }
            Node::Nested(fields) => {
                let field = fields.iter().find(|f| f.name == segment)?;
                (node_of(field.kind), Place::Field, segment)
            }
            Node::Subdocument(schema) => {
                let next = match schema.fields.iter().find(|f| f.name == segment) {
                    Some(field) => node_of(field.kind),
                    None => implicit(schema, segment)?,
                };
                (next, Place::Field, segment)
            }
            Node::DocumentArray(schema) if is_position(segment) => {
                (Node::Subdocument(schema), Place::ArrayElement, "$")
            }
            // `items.name` reaches into every element.
            Node::DocumentArray(schema) => {
                let field = schema.fields.iter().find(|f| f.name == segment)?;
                pattern.push("$");
                (node_of(field.kind), Place::Field, segment)
            }
            Node::Array(ty) if is_position(segment) => (Node::Value(ty), Place::ArrayElement, "$"),
            Node::Array(_) => return None,
            Node::Map(MapOf::Values(ty)) => (Node::Value(ty), Place::MapValue, "$*"),
            Node::Map(MapOf::Subdocuments(schema)) => {
                (Node::Subdocument(schema), Place::MapValue, "$*")
            }
        };
        pattern.push(shown);
        node = next;
        place = next_place;
    }
    Some(Resolved::At(node, place, pattern.join(".")))
}

/// Collects the refusals of one prepared write.
struct Checker<'i> {
    info: &'i CollectionInfo,
    errors: Vec<ValidatorError>,
}

impl<'i> Checker<'i> {
    fn new(info: &'i CollectionInfo) -> Self {
        Self {
            info,
            errors: Vec::new(),
        }
    }

    fn need(&self, pattern: &str) -> Option<&ReadNeed> {
        // Mongoose's own root `_id` is read as an `ObjectId`: never `null`, never missing.
        static ROOT_ID: ReadNeed = ReadNeed::value("_id");
        if pattern == "_id" && matches!(self.info.schema.id, IdField::Auto) {
            return Some(&ROOT_ID);
        }
        self.info.read_needs.iter().find(|n| n.path == pattern)
    }

    fn refuse(&mut self, path: &str, kind: ValidatorKind, message: String) {
        if self.errors.iter().any(|e| e.path == path) {
            return;
        }
        self.errors.push(ValidatorError {
            path: path.to_owned(),
            kind,
            message,
        });
    }

    fn type_error(&mut self, path: &str, expected: &str, value: &Bson) {
        let found = bson_type(value);
        self.refuse(
            path,
            ValidatorKind::Type,
            format!("Path `{path}` holds {expected}, not {found} (values are not cast)."),
        );
    }

    fn null_error(&mut self, path: &str) {
        self.refuse(
            path,
            ValidatorKind::Null,
            format!("Path `{path}` cannot be null (its read type has no null)."),
        );
    }

    fn missing_error(&mut self, path: &str) {
        self.refuse(
            path,
            ValidatorKind::Missing,
            format!("Path `{path}` cannot be removed or left out (its read type needs it)."),
        );
    }

    /// A value written at `path` (`pattern` its schema path).
    fn value(&mut self, node: Node, place: Place, path: &str, pattern: &str, value: &Bson) {
        if matches!(value, Bson::Null | Bson::Undefined) {
            // An array element or a Map value is never `null`; a plain nested object is when its
            // read type is an `Option` (no `ReadNeed` refuses it), like any other path.
            let structural = place != Place::Field && !matches!(node, Node::Free);
            if structural || self.need(pattern).is_some_and(|n| n.refuse_null) {
                self.null_error(path);
            }
            return;
        }
        match node {
            Node::Free => {}
            Node::Value(ty) => {
                if !has_type(ty, value) {
                    self.type_error(path, type_name(ty), value);
                }
            }
            Node::Nested(fields) => match value {
                Bson::Document(document) => self.fields(fields, None, path, pattern, document),
                other => self.type_error(path, "an object", other),
            },
            Node::Subdocument(schema) => match value {
                Bson::Document(document) => {
                    self.fields(schema.fields, Some(schema), path, pattern, document);
                }
                other => self.type_error(path, "an object", other),
            },
            Node::Array(ty) => match value {
                Bson::Array(items) => {
                    for (i, item) in items.iter().enumerate() {
                        let at = format!("{path}.{i}");
                        let element = format!("{pattern}.$");
                        self.value(Node::Value(ty), Place::ArrayElement, &at, &element, item);
                    }
                }
                other => self.type_error(path, "an array", other),
            },
            Node::MixedArray => {
                if !matches!(value, Bson::Array(_)) {
                    self.type_error(path, "an array", value);
                }
            }
            Node::DocumentArray(schema) => match value {
                Bson::Array(items) => {
                    for (i, item) in items.iter().enumerate() {
                        let at = format!("{path}.{i}");
                        let element = format!("{pattern}.$");
                        let node = Node::Subdocument(schema);
                        self.value(node, Place::ArrayElement, &at, &element, item);
                    }
                }
                other => self.type_error(path, "an array", other),
            },
            Node::Map(of) => match value {
                Bson::Document(entries) => {
                    let (inner, element) = match of {
                        MapOf::Values(ty) => (Node::Value(ty), Place::MapValue),
                        MapOf::Mixed => (Node::Free, Place::Field),
                        MapOf::Subdocuments(schema) => (Node::Subdocument(schema), Place::MapValue),
                    };
                    for (key, entry) in entries {
                        let at = format!("{path}.{key}");
                        self.value(inner, element, &at, &format!("{pattern}.$*"), entry);
                    }
                }
                other => self.type_error(path, "an object", other),
            },
        }
    }

    /// A whole object written at `path`: every field it holds, and every needed field it lacks.
    fn fields(
        &mut self,
        fields: &'static [Field],
        schema: Option<&'static Schema>,
        path: &str,
        pattern: &str,
        document: &Document,
    ) {
        let join = |base: &str, name: &str| {
            if base.is_empty() {
                name.to_owned()
            } else {
                format!("{base}.{name}")
            }
        };
        for field in fields {
            let at = join(path, field.name);
            let at_pattern = join(pattern, field.name);
            match document.get(field.name) {
                Some(value) => {
                    self.value(node_of(field.kind), Place::Field, &at, &at_pattern, value)
                }
                None => {
                    if self.need(&at_pattern).is_some_and(|n| n.refuse_missing) {
                        self.missing_error(&at);
                    }
                }
            }
        }
        if let Some(schema) = schema {
            for (key, value) in document {
                if fields.iter().all(|f| f.name != key.as_str())
                    && let Some(node) = implicit(schema, key)
                {
                    self.value(
                        node,
                        Place::Field,
                        &join(path, key),
                        &join(pattern, key),
                        value,
                    );
                }
            }
        }
    }

    /// A write at `path` that may create the objects on its way: each one that may be missing and
    /// would then be created partial (a sub-document or nested object whose read type needs
    /// fields), and an array element at a numeric position (past the end, the server pads the
    /// array with `null`), must be proven to exist: by the update's filter, or by the loaded
    /// document of a save.
    fn creates_partial(&mut self, schema: &'static Schema, path: &str, against: Against<'_>) {
        let segments: Vec<&str> = path.split('.').collect();
        // Every proper prefix, and the path itself when it ends at an array position.
        for end in 1..=segments.len() {
            let Some(prefix) = segments.get(..end).map(|s| s.join(".")) else {
                continue;
            };
            let Some(Resolved::At(node, place, pattern)) = resolve(schema, &prefix) else {
                return;
            };
            // Only a real array position: a numeric Map key (`variables.123`) or a numeric key of
            // a plain object below `Mixed` is a key like any other, and the server creates it.
            let numeric = place == Place::ArrayElement
                && segments
                    .get(end - 1)
                    .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
            let object = end < segments.len()
                && matches!(node, Node::Subdocument(_) | Node::Nested(_))
                && place != Place::ArrayElement;
            let below = format!("{pattern}.");
            let needs_fields = self
                .info
                .read_needs
                .iter()
                .any(|n| n.refuse_missing && n.path.starts_with(&below));
            let exists = match against {
                Against::Filter { filter, .. } => proves_exists(filter, &prefix),
                Against::Loaded(loaded) => crate::writes::at(loaded, &prefix)
                    .is_some_and(|v| !matches!(v, Bson::Null | Bson::Undefined)),
            };
            if (numeric || object && needs_fields) && !exists {
                self.refuse(
                    path,
                    ValidatorKind::Missing,
                    format!(
                        "Path `{path}` would create `{prefix}` partially when it does not exist: \
                         the filter must prove it exists (a condition on `{prefix}` or a path in it)."
                    ),
                );
                return;
            }
        }
    }

    /// One operator of an update or a save delta.
    fn operator(
        &mut self,
        schema: &'static Schema,
        operator: &str,
        paths: &Document,
        against: Against<'_>,
    ) {
        for (path, value) in paths {
            if !matches!(
                operator,
                "$unset" | "$setOnInsert" | "$pull" | "$pullAll" | "$pop"
            ) {
                self.creates_partial(schema, path, against);
            }
            let (node, place, pattern) = match resolve(schema, path) {
                None => continue,
                Some(Resolved::At(node, place, pattern)) => (node, place, pattern),
                Some(Resolved::BelowMapValue(map_value)) => {
                    self.refuse(
                        path,
                        ValidatorKind::Type,
                        format!("Path `{path}` is below the Map value `{map_value}`, which holds one value."),
                    );
                    continue;
                }
            };
            match operator {
                "$set" | "$setOnInsert" => self.value(node, place, path, &pattern, value),
                "$unset" => {
                    let needed = self.need(&pattern).is_some_and(|n| n.refuse_missing);
                    if needed || place == Place::ArrayElement && !matches!(node, Node::Free) {
                        self.missing_error(path);
                    }
                }
                "$push" | "$addToSet" => {
                    let each = match value {
                        Bson::Document(each) if each.contains_key("$each") => {
                            each.get_array("$each").ok().cloned().unwrap_or_default()
                        }
                        other => vec![other.clone()],
                    };
                    let element = match node {
                        Node::Array(ty) => Node::Value(ty),
                        Node::DocumentArray(schema) => Node::Subdocument(schema),
                        Node::MixedArray | Node::Free => Node::Free,
                        _ => {
                            self.type_error(path, "an array", &Bson::Array(each));
                            continue;
                        }
                    };
                    for (i, item) in each.iter().enumerate() {
                        let at = format!("{path}.{i}");
                        let element_pattern = format!("{pattern}.$");
                        self.value(element, Place::ArrayElement, &at, &element_pattern, item);
                    }
                }
                "$inc" | "$mul" | "$min" | "$max" => match node {
                    Node::Free => {}
                    Node::Value(ty) if has_type(ty, value) => {
                        if operator != "$min" && operator != "$max" && ty != ValueType::Number {
                            self.type_error(path, "a Number", value);
                        }
                    }
                    Node::Value(ty) => self.type_error(path, type_name(ty), value),
                    _ => self.type_error(path, "a single value", value),
                },
                "$pull" | "$pullAll" | "$pop" => {}
                other => self.unsupported(path, other),
            }
        }
    }

    fn unsupported(&mut self, path: &str, what: &str) {
        self.refuse(
            path,
            ValidatorKind::Type,
            format!("`{what}` is not supported by dima-model (no reference call uses it)."),
        );
    }

    fn finish(self) -> Result<(), ValidationError> {
        if self.errors.is_empty() {
            Ok(())
        } else {
            Err(ValidationError {
                model: self.info.model,
                on_update: false,
                errors: self.errors,
            })
        }
    }
}

impl CollectionInfo {
    /// Refuses a new document the read type could not decode (see the module docs).
    pub(crate) fn check_insert(&self, document: &Document) -> Result<(), ValidationError> {
        let mut checker = Checker::new(self);
        checker.fields(self.schema.fields, Some(self.schema), "", "", document);
        checker.finish()
    }

    /// Refuses a prepared update (or save delta) that could leave a document the read type could
    /// not decode. An upsert's inserted document is checked whole.
    pub(crate) fn check_update(
        &self,
        update: &UpdateDoc,
        against: Against<'_>,
    ) -> Result<(), ValidationError> {
        let mut checker = Checker::new(self);
        match update {
            UpdateDoc::Document(update) => {
                for (operator, paths) in update {
                    match paths {
                        Bson::Document(paths) if operator.starts_with('$') => {
                            checker.operator(self.schema, operator, paths, against);
                        }
                        // A bare key is `$set`.
                        value if !operator.starts_with('$') => {
                            let mut one = Document::new();
                            one.insert(operator.clone(), value.clone());
                            checker.operator(self.schema, "$set", &one, against);
                        }
                        _ => checker.unsupported(operator, operator),
                    }
                }
                if let Against::Filter {
                    filter,
                    upsert: true,
                } = against
                {
                    checker.fields(
                        self.schema.fields,
                        Some(self.schema),
                        "",
                        "",
                        &upserted(filter, update),
                    );
                }
            }
            // An expression (`{$literal: …}`, `'$field'`) cannot be checked without running it:
            // the ordinary entry points refuse a pipeline before it gets here, and
            // `prepare_pipeline_update_unchecked` does not call the guard.
            UpdateDoc::Pipeline(_) => checker.unsupported("", "an update pipeline"),
        }
        checker.finish()
    }
}

/// `true` when no document lacking `path` can match `filter`: a condition on `path` or on a path
/// inside it that a missing value does not satisfy (a literal other than `null`, `$exists: true`,
/// a comparison, `$in` without `null`, `$elemMatch`, `$size`, `$type`), at the top level or in
/// an `$and`.
fn proves_exists(filter: &Document, path: &str) -> bool {
    let inside = format!("{path}.");
    filter.iter().any(|(key, condition)| {
        if key == "$and" {
            return matches!(condition, Bson::Array(all) if all.iter().any(
                |c| matches!(c, Bson::Document(c) if proves_exists(c, path))
            ));
        }
        (key == path || key.starts_with(&inside)) && excludes_missing(condition)
    })
}

/// A condition a missing value does not satisfy.
fn excludes_missing(condition: &Bson) -> bool {
    match condition {
        Bson::Null | Bson::Undefined => false,
        Bson::Document(operators) if operators.keys().any(|k| k.starts_with('$')) => operators
            .iter()
            .any(|(operator, operand)| match operator.as_str() {
                "$exists" => matches!(operand, Bson::Boolean(true)),
                "$eq" => !matches!(operand, Bson::Null),
                "$gt" | "$gte" | "$lt" | "$lte" | "$elemMatch" | "$size" | "$type" | "$regex" => {
                    true
                }
                "$in" => matches!(operand, Bson::Array(items)
                    if !items.is_empty() && items.iter().all(|i| !matches!(i, Bson::Null))),
                _ => false,
            }),
        _ => true,
    }
}

/// What tells whether the objects a write goes into exist.
#[derive(Clone, Copy)]
pub(crate) enum Against<'a> {
    /// An update: its prepared filter, and whether it upserts.
    Filter {
        /// The filter.
        filter: &'a Document,
        /// `upsert: true`.
        upsert: bool,
    },
    /// A save: the loaded document.
    Loaded(&'a Document),
}

/// The document an upsert inserts: the filter's equality fields, then `$setOnInsert`, `$set`,
/// `$min`, `$max` and `$inc` applied.
fn upserted(filter: &Document, update: &Document) -> Document {
    let mut document = Document::new();
    for (key, value) in filter {
        let operator = matches!(value, Bson::Document(d) if d.keys().any(|k| k.starts_with('$')));
        if !key.starts_with('$') && !operator {
            crate::writes::put(&mut document, key, value.clone());
        }
    }
    // `$min`, `$max` and `$inc` of a missing path store their value on insert.
    for operator in ["$setOnInsert", "$set", "$min", "$max", "$inc"] {
        if let Ok(paths) = update.get_document(operator) {
            for (path, value) in paths {
                crate::writes::put(&mut document, path, value.clone());
            }
        }
    }
    for (key, value) in update {
        if !key.starts_with('$') {
            crate::writes::put(&mut document, key, value.clone());
        }
    }
    document
}

fn has_type(ty: ValueType, value: &Bson) -> bool {
    match ty {
        ValueType::String => matches!(value, Bson::String(_)),
        ValueType::Number => matches!(value, Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_)),
        ValueType::Date => matches!(value, Bson::DateTime(_)),
        ValueType::Boolean => matches!(value, Bson::Boolean(_)),
        ValueType::ObjectId => matches!(value, Bson::ObjectId(_)),
    }
}

fn type_name(ty: ValueType) -> &'static str {
    match ty {
        ValueType::String => "a String",
        ValueType::Number => "a Number",
        ValueType::Date => "a Date",
        ValueType::Boolean => "a Boolean",
        ValueType::ObjectId => "an ObjectId",
    }
}

fn bson_type(value: &Bson) -> &'static str {
    match value {
        Bson::String(_) => "a string",
        Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_) | Bson::Decimal128(_) => "a number",
        Bson::Boolean(_) => "a boolean",
        Bson::DateTime(_) => "a date",
        Bson::ObjectId(_) => "an ObjectId",
        Bson::Document(_) => "an object",
        Bson::Array(_) => "an array",
        Bson::Null | Bson::Undefined => "null",
        _ => "another BSON type",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    #[test]
    fn paths_resolve_to_schema_paths() {
        let pattern = |schema, path: &str| match resolve(schema, path) {
            Some(Resolved::At(_, _, pattern)) => Some(pattern),
            Some(Resolved::BelowMapValue(map_value)) => Some(format!("below {map_value}")),
            None => None,
        };
        let users = crate::users::INFO.schema;
        assert_eq!(
            pattern(users, "accounts.0.type").as_deref(),
            Some("accounts.$.type")
        );
        assert_eq!(
            pattern(users, "accounts.$[a].id").as_deref(),
            Some("accounts.$.id")
        );
        assert_eq!(
            pattern(users, "accounts.type").as_deref(),
            Some("accounts.$.type")
        );
        assert_eq!(pattern(users, "accounts.0").as_deref(), Some("accounts.$"));
        assert_eq!(
            pattern(users, "free_credit_reset.status").as_deref(),
            Some("free_credit_reset.status")
        );
        assert_eq!(pattern(users, "updated_at").as_deref(), Some("updated_at"));
        assert_eq!(pattern(users, "nope"), None);
        let commands = crate::commands::INFO.schema;
        assert_eq!(
            pattern(commands, "variables.k").as_deref(),
            Some("variables.$*")
        );
        assert_eq!(
            pattern(commands, "variables.k.x").as_deref(),
            Some("below variables.$*")
        );
        assert_eq!(
            pattern(commands, "permissions.a.b").as_deref(),
            Some("permissions.a.b")
        );
    }

    #[test]
    fn refusals_name_the_path() {
        let info = &crate::commands::INFO;
        let update = UpdateDoc::Document(doc! {
            "$set": { "paused": Bson::Null, "cooldown": "5", "responses": 3, "variables.k": 1 },
            "$unset": { "channelID": 1 },
        });
        let Err(error) = info.check_update(&update, Against::Loaded(&doc! {})) else {
            panic!("must be refused");
        };
        let found: Vec<_> = error
            .errors
            .iter()
            .map(|e| (e.path.as_str(), e.kind))
            .collect();
        assert_eq!(
            found,
            [
                ("paused", ValidatorKind::Null),
                ("cooldown", ValidatorKind::Type),
                ("responses", ValidatorKind::Type),
                ("variables.k", ValidatorKind::Type),
                ("channelID", ValidatorKind::Missing),
            ]
        );
        // Mixed paths are free; an upsert's document must hold what the read type needs.
        let free = UpdateDoc::Document(doc! { "$set": { "permissions": false, "blocks": 1 } });
        assert_eq!(info.check_update(&free, Against::Loaded(&doc! {})), Ok(()));
        let upsert = UpdateDoc::Document(doc! { "$set": { "message": "m" } });
        let Err(error) = info.check_update(
            &upsert,
            Against::Filter {
                filter: &doc! { "cmd": "!x" },
                upsert: true,
            },
        ) else {
            panic!("an upsert without channelID must be refused");
        };
        assert_eq!(error.errors[0].path, "channelID");
        assert_eq!(
            info.check_update(
                &upsert,
                Against::Filter {
                    filter: &doc! { "channelID": "1" },
                    upsert: true
                }
            ),
            Ok(())
        );
    }

    #[test]
    fn partial_objects_need_a_filter_that_proves_them() {
        let info = &crate::users::INFO;
        let dotted =
            UpdateDoc::Document(doc! { "$set": { "free_credit_reset.status": "completed" } });
        let by_id = doc! { "_id": 1 };
        assert!(
            info.check_update(
                &dotted,
                Against::Filter {
                    filter: &by_id,
                    upsert: false
                }
            )
            .is_err()
        );
        // The reference's filter (`free_credit_reset.worker.ts`) proves the reset exists.
        let proven = doc! { "_id": 1, "free_credit_reset.externalId": "x", "free_credit_reset.status": "pending" };
        assert_eq!(
            info.check_update(
                &dotted,
                Against::Filter {
                    filter: &proven,
                    upsert: false
                }
            ),
            Ok(())
        );
        // A numeric position may pad the array with nulls; `$` needs no proof.
        let numeric = UpdateDoc::Document(doc! { "$set": { "accounts.0.chat_enabled": false } });
        assert!(
            info.check_update(
                &numeric,
                Against::Filter {
                    filter: &by_id,
                    upsert: false
                }
            )
            .is_err()
        );
        let exists = doc! { "_id": 1, "accounts.0": { "$exists": true } };
        assert_eq!(
            info.check_update(
                &numeric,
                Against::Filter {
                    filter: &exists,
                    upsert: false
                }
            ),
            Ok(())
        );
        let positional = UpdateDoc::Document(doc! { "$set": { "accounts.$.chat_enabled": false } });
        assert_eq!(
            info.check_update(
                &positional,
                Against::Filter {
                    filter: &by_id,
                    upsert: false
                }
            ),
            Ok(())
        );
        // A save: what the loaded document has.
        let loaded = doc! { "_id": 1, "accounts": [{ "id": "1" }] };
        assert_eq!(
            info.check_update(&numeric, Against::Loaded(&loaded)),
            Ok(())
        );
        assert!(
            info.check_update(&numeric, Against::Loaded(&doc! { "_id": 1 }))
                .is_err()
        );
    }

    /// Mongoose's implicit `_id` is an ObjectId, at the root and in sub-documents.
    #[test]
    fn implicit_ids_are_typed() {
        let users = &crate::users::INFO;
        let by_id = doc! { "_id": 1 };
        let plain = Against::Filter {
            filter: &by_id,
            upsert: false,
        };
        let bad_push = UpdateDoc::Document(
            doc! { "$push": { "accounts": { "_id": "bad", "type": "twitch", "id": "1" } } },
        );
        let Err(error) = users.check_update(&bad_push, plain) else {
            panic!("a string sub-document `_id` must be refused");
        };
        assert_eq!(
            (error.errors[0].path.as_str(), error.errors[0].kind),
            ("accounts.0._id", ValidatorKind::Type)
        );
        let good_push = UpdateDoc::Document(
            doc! { "$push": { "accounts": { "_id": bson::oid::ObjectId::new(), "type": "twitch", "id": "1" } } },
        );
        assert_eq!(users.check_update(&good_push, plain), Ok(()));
        let Err(error) = users.check_insert(&doc! { "_id": "bad" }) else {
            panic!("a string root `_id` must be refused where the id is an ObjectId");
        };
        assert!(
            error
                .errors
                .iter()
                .any(|e| e.path == "_id" && e.kind == ValidatorKind::Type)
        );
        // A declared string `_id` stays a string.
        let gifts = &crate::credit_gifts::INFO;
        let typed = gifts.check_insert(&doc! { "_id": bson::oid::ObjectId::new() });
        assert!(typed.is_err_and(|e| {
            e.errors
                .iter()
                .any(|e| e.path == "_id" && e.kind == ValidatorKind::Type)
        }));
    }

    /// A numeric Map key or a numeric key below `Mixed` is no array position: the reference
    /// upserts `variables.123` (`handlers/special_parser.handler.ts:288`), and Mongoose takes it.
    #[test]
    fn numeric_keys_are_not_positions() {
        let filter = doc! { "channelID": "1", "scopeType": "channel", "scopeName": "s" };
        let upsert = Against::Filter {
            filter: &filter,
            upsert: true,
        };
        let ast = &crate::ast_variables::INFO;
        let numeric_key = UpdateDoc::Document(doc! {
            "$set": { "variables.123": "v" },
            "$setOnInsert": { "channelID": "1", "scopeType": "channel", "scopeName": "s" },
        });
        assert_eq!(ast.check_update(&numeric_key, upsert), Ok(()));
        let by_id = doc! { "_id": 1 };
        let plain = Against::Filter {
            filter: &by_id,
            upsert: false,
        };
        let commands = &crate::commands::INFO;
        let map_key = UpdateDoc::Document(doc! { "$set": { "variables.7": "v" } });
        assert_eq!(commands.check_update(&map_key, plain), Ok(()));
        let mixed_key = UpdateDoc::Document(doc! { "$set": { "permissions.0": "v" } });
        assert_eq!(commands.check_update(&mixed_key, plain), Ok(()));
    }
}
