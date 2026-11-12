//! Filters cast to the schema types, as Mongoose 8 casts them before it sends a query or an
//! update (`lib/cast.js`, the schema types' `castForQuery` and `$conditionalHandlers`,
//! `helpers/query/cast$expr.js`, `helpers/update/castArrayFilters.js`).
//!
//! The reference relies on it: a route parameter or a Redis value is a string, and
//! `findById(id)`, `{_id: {$in: [ids]}}`, `{at: {$gt: '2026-…'}}` match because Mongoose turns
//! the string into an ObjectId or a Date first. A Rust caller passing the same string through
//! [`prepare_filter`] (or any write helper, which casts its filter the same way) gets the same
//! filter; without it the query would silently match nothing.
//!
//! What is cast, per path type (every rule pinned by `golden.json`, `filters` and the
//! `*filter*` write cases):
//!
//! | type | accepted | refused (`PrepareError::Cast`) |
//! |---|---|---|
//! | ObjectId | ObjectId; 24 hex digits; `{_id: <either>}` | anything else |
//! | String | string (`trim` applied); number (`String(n)`); boolean; ObjectId (hex); `{_id: "<string>"}`; regex kept | other objects, arrays, dates |
//! | Number | number (not NaN); string through `Number()` (`""` is null); boolean (1/0); date (ms) | NaN, other strings and objects |
//! | Date | date; number (ms, cut toward zero); numeric string beyond ±275 760 (ms); date text (ISO 8601, HTTP dates); `""` is null | booleans, invalid or out-of-range values |
//! | Boolean | `true`, `"true"`, `1`, `"1"`, `"yes"`; `false`, `"false"`, `0`, `"0"`, `"no"` | anything else |
//!
//! Operators: `$in`/`$nin` (a single value is wrapped, empty arrays are kept), `$all`, `$eq`,
//! `$ne`, `$gt`/`$gte`/`$lt`/`$lte` (not on Booleans, which cast whatever operator they get),
//! `$not` (operators below it cast; a regex kept), `$exists` (cast to a boolean), `$type`
//! (checked), `$regex`/`$options` (strings without setters), `$mod` and the bitwise operators
//! on Numbers, `$size` on arrays, `$elemMatch` (against the sub-schema of a document array;
//! element operators for an array of values), `$and`/`$or`/`$nor` (each element cast; an
//! element cast to nothing is removed, an empty list is dropped), `$where` (a string, kept),
//! `$comment` (cast to a string), `$expr` (literal operands of comparisons with a field path
//! cast to that path's type; numeric operators' literals to numbers). An array given as a plain
//! value of a path that is not an array becomes `$in`. An unknown operator fails as Mongoose
//! fails (`PrepareError::Cast` for Numbers, `PrepareError::QueryOperator` otherwise).
//!
//! Paths: dotted paths into nested objects, sub-documents, document arrays (also with `0`, `$`
//! positions) and Maps are cast to the type they reach; a whole nested object is sent as it is;
//! a whole sub-document is built like a new one (defaults and `_id` included, as Mongoose does,
//! so such a filter rarely matches). Paths the schema does not know are sent as they are
//! (`strictQuery: false`), except in the filter of an upsert, where Mongoose refuses them
//! (`PrepareError::StrictFilter`). Paths below a Mixed path or a value are sent as they are.
//!
//! A query (`find`, `findOne`, `updateOne`…) also puts `$and`, then `$or`, first (Mongoose's
//! `Query.merge`); a `bulkWrite` operation keeps the caller's order. Numbers come out typed as
//! the Node BSON writer types them.
//!
//! Not reproduced (no use in the reference): geospatial operators, `$text`, discriminators,
//! casting a date to a string (Mongoose writes the local-time `Date.toString()` text; refused
//! here), and the `$expr` operators other than comparisons, `$and`/`$or`, `$not`, `$cond`,
//! `$ifNull`, `$switch`, `$in`, `$size`, `$round` and the arithmetic ones.

use crate::mongo::cast::{Caster, PrepareError, WriteContext, check_document_depth, check_map_key};
use crate::mongo::id::parse_object_id;
use crate::mongo::number::normalize_js_numbers;
use crate::mongo::schema::{Field, Kind, MapOf, Schema, TargetKind, ValueType, resolve};
use bson::{Bson, DateTime, Document};

/// The filter `Model.find(filter)` (and `findOne`, `countDocuments`, `deleteOne`, `exists`…)
/// sends: cast to the schema types, `$and` and `$or` first, numbers typed as Node types them.
/// `ctx` is only used when a filter compares a whole sub-document (which Mongoose builds with
/// its defaults and `_id`).
pub fn prepare_filter(
    schema: &Schema,
    filter: &Document,
    ctx: &mut WriteContext,
) -> Result<Document, PrepareError> {
    check_document_depth(filter)?;
    let mut caster = Caster::new(ctx);
    let mut out = FilterCaster::new(&mut caster, false).document(schema, &query_order(filter))?;
    normalize_js_numbers(&mut out);
    Ok(out)
}

/// The filter of `Model.findById(id)` (and `findByIdAndUpdate`, `findByIdAndDelete`): `{_id:
/// id}` cast like [`prepare_filter`], so a 24-hex-digit string becomes an ObjectId on a
/// collection with ObjectId ids, and any other text fails with `PrepareError::Cast`.
pub fn prepare_id_filter(
    schema: &Schema,
    id: impl Into<Bson>,
    ctx: &mut WriteContext,
) -> Result<Document, PrepareError> {
    let mut filter = Document::new();
    filter.insert("_id", id.into());
    prepare_filter(schema, &filter, ctx)
}

/// How a write helper casts its filter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FilterStyle {
    /// A query (`updateOne`, `findOneAndUpdate`…): `$and`/`$or` first, then cast.
    Query,
    /// A `bulkWrite` operation: cast in the caller's order.
    Bulk,
}

/// The filter of a write, cast as Mongoose casts it for that write (unknown paths refused when
/// `upsert`), numbers typed as Node types them.
pub(crate) fn cast_write_filter(
    schema: &Schema,
    filter: &Document,
    style: FilterStyle,
    upsert: bool,
    caster: &mut Caster<'_>,
) -> Result<Document, PrepareError> {
    let ordered = match style {
        FilterStyle::Query => query_order(filter),
        FilterStyle::Bulk => filter.clone(),
    };
    let mut out = FilterCaster::new(caster, upsert).document(schema, &ordered)?;
    normalize_js_numbers(&mut out);
    Ok(out)
}

/// `castArrayFilters`: each array filter cast against the path its identifier stands for in
/// `update` (the update as the caller wrote it). A filter whose identifier the update does not
/// use is sent as it is; a path that does not exist fails (`Could not find path …`).
pub(crate) fn cast_array_filters(
    schema: &Schema,
    update: &Document,
    filters: Vec<Document>,
    caster: &mut Caster<'_>,
) -> Result<Vec<Document>, PrepareError> {
    let identifiers = paths_by_array_filter(update);
    let mut filters = filters;
    let mut fc = FilterCaster::new(caster, false);
    for filter in &mut filters {
        fc.array_filter(schema, &identifiers, filter)?;
    }
    for filter in &mut filters {
        normalize_js_numbers(filter);
    }
    Ok(filters)
}

/// `Query.merge` of a plain filter: an `$and` list first, then an `$or` list, then the other
/// keys in their order.
fn query_order(filter: &Document) -> Document {
    let mut out = Document::new();
    for key in ["$and", "$or"] {
        if let Some(value @ Bson::Array(_)) = filter.get(key) {
            out.insert(key, value.clone());
        }
    }
    for (key, value) in filter {
        if !out.contains_key(key) {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

/// `isOperator`: a key starting with `$`, except the DBRef keys.
fn is_operator(key: &str) -> bool {
    key.starts_with('$') && !matches!(key, "$ref" | "$id" | "$db")
}

/// What a filter path is, for casting.
#[derive(Clone, Copy, Debug)]
enum PathType {
    /// One value (also an array element, a Map value, a Mixed path itself).
    Scalar(Elem),
    /// An array of elements.
    Array(Elem),
    /// A Map path itself.
    Map(MapOf),
    /// Sent as it is: a whole nested object, a path below a Mixed path or below a value.
    Keep,
}

/// One value's caster.
#[derive(Clone, Copy, Debug)]
enum Elem {
    /// A typed value, with its `trim` setter.
    Value(ValueType, bool),
    /// Mixed: anything, as it is.
    Any,
    /// A sub-document built from the value.
    Document(&'static Schema),
}

struct FilterCaster<'a, 'c> {
    caster: &'a mut Caster<'c>,
    upsert: bool,
}

impl<'a, 'c> FilterCaster<'a, 'c> {
    fn new(caster: &'a mut Caster<'c>, upsert: bool) -> Self {
        Self { caster, upsert }
    }

    /// `cast(schema, obj)`: every key, from the last (so the error Mongoose raises first is the
    /// one raised here), into the same positions.
    fn document(&mut self, schema: &Schema, filter: &Document) -> Result<Document, PrepareError> {
        let entries: Vec<(&String, &Bson)> = filter.iter().collect();
        let mut cast: Vec<Option<Bson>> = vec![None; entries.len()];
        for (index, (key, value)) in entries.iter().enumerate().rev() {
            cast[index] = self.condition(schema, key, value)?;
        }
        Ok(entries
            .into_iter()
            .zip(cast)
            .filter_map(|((key, _), value)| value.map(|value| (key.clone(), value)))
            .collect())
    }

    /// One key of a filter; `None` removes it.
    fn condition(
        &mut self,
        schema: &Schema,
        key: &str,
        value: &Bson,
    ) -> Result<Option<Bson>, PrepareError> {
        match key {
            "$or" | "$and" | "$nor" => self.logical(schema, key, value),
            "$where" => match value {
                Bson::String(_) | Bson::JavaScriptCode(_) => Ok(Some(value.clone())),
                _ => Err(operator_error(
                    key,
                    "Must have a string or function for $where",
                )),
            },
            "$expr" => Ok(Some(self.expr(schema, value)?)),
            "$elemMatch" => match value {
                Bson::Document(inner) => Ok(Some(Bson::Document(self.document(schema, inner)?))),
                other => Ok(Some(other.clone())),
            },
            "$text" => Ok(Some(value.clone())),
            "$comment" if !schema.fields.iter().any(|f| f.name == "$comment") => {
                cast_string(value, key, false).map(Some)
            }
            _ => self.path(schema, key, value),
        }
    }

    fn logical(
        &mut self,
        schema: &Schema,
        key: &str,
        value: &Bson,
    ) -> Result<Option<Bson>, PrepareError> {
        let Bson::Array(items) = value else {
            return Err(cast_error("Array", key));
        };
        let mut kept: Vec<Bson> = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate().rev() {
            let Bson::Document(inner) = item else {
                return Err(cast_error("Object", &format!("{key}.{index}")));
            };
            let cast = self.document(schema, inner)?;
            // An element that had conditions and has none left is removed.
            if cast.is_empty() && !inner.is_empty() {
                continue;
            }
            kept.push(Bson::Document(cast));
        }
        kept.reverse();
        Ok((!kept.is_empty()).then_some(Bson::Array(kept)))
    }

    /// A field path's condition.
    fn path(
        &mut self,
        schema: &Schema,
        path: &str,
        value: &Bson,
    ) -> Result<Option<Bson>, PrepareError> {
        let Some(target) = resolve(schema, path) else {
            return self.unknown(schema, path, value);
        };
        let ty = path_type(schema, path, target.kind, target.trim);
        if matches!(ty, PathType::Keep) || matches!(value, Bson::Null | Bson::Undefined) {
            return Ok(Some(value.clone()));
        }
        match value {
            Bson::Document(condition) if condition.keys().any(|k| is_operator(k)) => {
                Ok(Some(Bson::Document(self.operators(ty, path, condition)?)))
            }
            Bson::Array(items) if !matches!(ty, PathType::Array(_)) => {
                let cast = items
                    .iter()
                    .map(|item| self.equality(ty, item, path))
                    .collect::<Result<Vec<_>, _>>()?;
                let mut in_list = Document::new();
                in_list.insert("$in", cast);
                Ok(Some(Bson::Document(in_list)))
            }
            _ => self.equality(ty, value, path).map(Some),
        }
    }

    /// A path the schema does not resolve: below a sub-document it is cast against the
    /// sub-schema; below another schema path it is kept; otherwise it is kept, or refused in
    /// the filter of an upsert.
    fn unknown(
        &mut self,
        schema: &Schema,
        path: &str,
        value: &Bson,
    ) -> Result<Option<Bson>, PrepareError> {
        let segments: Vec<&str> = path.split('.').collect();
        for end in (1..segments.len()).rev() {
            let prefix = segments[..end].join(".");
            let Some(target) = resolve(schema, &prefix) else {
                continue;
            };
            match target.kind {
                TargetKind::Nested(_) => continue,
                TargetKind::DocumentArray(sub) | TargetKind::Subdocument(sub) => {
                    let rest = segments[end..].join(".");
                    return self.path(sub, &rest, value);
                }
                _ => return Ok(Some(value.clone())),
            }
        }
        if self.upsert {
            return Err(PrepareError::StrictFilter {
                path: path.to_owned(),
            });
        }
        Ok(Some(value.clone()))
    }

    /// `{path: {$op: …, …}}`, every operator from the last.
    fn operators(
        &mut self,
        ty: PathType,
        path: &str,
        condition: &Document,
    ) -> Result<Document, PrepareError> {
        let entries: Vec<(&String, &Bson)> = condition.iter().collect();
        let mut cast: Vec<Bson> = entries.iter().map(|(_, v)| (*v).clone()).collect();
        for (index, (op, nested)) in entries.iter().enumerate().rev() {
            let op = op.as_str();
            cast[index] = match op {
                "$elemMatch" => match (ty, nested) {
                    (_, Bson::Null | Bson::Undefined) => (*nested).clone(),
                    (PathType::Array(Elem::Document(sub)), Bson::Document(inner)) => {
                        Bson::Document(self.document(sub, inner)?)
                    }
                    (PathType::Scalar(Elem::Document(sub)), Bson::Document(inner)) => {
                        Bson::Document(self.document(sub, inner)?)
                    }
                    (PathType::Array(elem), _) => {
                        self.operator(PathType::Array(elem), op, nested, path)?
                    }
                    _ => (*nested).clone(),
                },
                "$not" => match nested {
                    Bson::Null | Bson::Undefined => (*nested).clone(),
                    Bson::Document(inner)
                        if inner.keys().next().is_some_and(|k| is_operator(k)) =>
                    {
                        let mut out = Document::new();
                        for (key, value) in inner.iter().collect::<Vec<_>>().into_iter().rev() {
                            out.insert(key.clone(), self.operator(ty, key, value, path)?);
                        }
                        reorder_like(out, inner)
                    }
                    _ => self.operator(ty, "$not", nested, path)?,
                },
                _ => self.operator(ty, op, nested, path)?,
            };
        }
        Ok(entries
            .into_iter()
            .zip(cast)
            .map(|((key, _), value)| (key.clone(), value))
            .collect())
    }

    /// `schematype.castForQuery($op, value)`.
    fn operator(
        &mut self,
        ty: PathType,
        op: &str,
        value: &Bson,
        path: &str,
    ) -> Result<Bson, PrepareError> {
        match ty {
            PathType::Keep => Ok(value.clone()),
            PathType::Scalar(elem) => match (op, elem) {
                ("$all", _) => self.each_or_one(ty, value, path, false),
                ("$eq" | "$ne", _) => self.equality(ty, value, path),
                ("$in" | "$nin", _) => self.each_or_one(ty, value, path, true),
                ("$exists", _) => cast_boolean(value, path, "boolean"),
                ("$type", _) => check_type(value),
                (_, Elem::Any) => Ok(value.clone()),
                (_, Elem::Value(ValueType::Boolean, _)) => self.equality(ty, value, path),
                (
                    "$gt" | "$gte" | "$lt" | "$lte",
                    Elem::Value(
                        ValueType::String
                        | ValueType::Number
                        | ValueType::Date
                        | ValueType::ObjectId,
                        _,
                    ),
                ) => self.equality(ty, value, path),
                ("$not", Elem::Value(ValueType::String, _)) => self.equality(ty, value, path),
                ("$options", Elem::Value(ValueType::String, _)) => cast_string(value, path, false),
                ("$regex", Elem::Value(ValueType::String, _)) => match value {
                    Bson::RegularExpression(_) => Ok(value.clone()),
                    _ => cast_string(value, path, false),
                },
                ("$mod", Elem::Value(ValueType::Number, _)) => {
                    self.each_or_one(ty, value, path, false)
                }
                (
                    "$bitsAllClear" | "$bitsAnyClear" | "$bitsAllSet" | "$bitsAnySet",
                    Elem::Value(ValueType::Number, _),
                ) => match value {
                    Bson::Array(items) => items
                        .iter()
                        .map(|item| cast_number(item, path))
                        .collect::<Result<Vec<_>, _>>()
                        .map(Bson::Array),
                    Bson::Binary(_) => Ok(value.clone()),
                    other => cast_number(other, path),
                },
                (_, Elem::Value(ValueType::Number, _)) => Err(cast_error("number", path)),
                (_, Elem::Value(ValueType::String, _)) => {
                    Err(operator_error(op, &format!("Can't use {op} with String.")))
                }
                (_, Elem::Value(ValueType::Date, _)) => {
                    Err(operator_error(op, &format!("Can't use {op} with Date.")))
                }
                _ => Err(operator_error(op, &format!("Can't use {op}"))),
            },
            PathType::Array(elem) => match op {
                "$all" => {
                    let items = match value {
                        Bson::Array(items) => items.clone(),
                        other => vec![other.clone()],
                    };
                    let mut out = Vec::with_capacity(items.len());
                    for item in items {
                        out.push(match (&item, elem) {
                            (Bson::Document(inner), Elem::Document(sub))
                                if inner.contains_key("$elemMatch") =>
                            {
                                let mut wrapped = Document::new();
                                let matched = match inner.get("$elemMatch") {
                                    Some(Bson::Document(m)) => {
                                        Bson::Document(self.document(sub, m)?)
                                    }
                                    Some(other) => other.clone(),
                                    None => Bson::Null,
                                };
                                wrapped.insert("$elemMatch", matched);
                                Bson::Document(wrapped)
                            }
                            (Bson::Document(inner), _) if inner.contains_key("$elemMatch") => item,
                            _ => self.element(elem, &item, path)?,
                        });
                    }
                    Ok(Bson::Array(out))
                }
                "$elemMatch" => match value {
                    Bson::Document(inner) => {
                        let mut out = inner.clone();
                        for (key, nested) in inner.iter().collect::<Vec<_>>().into_iter().rev() {
                            if is_operator(key) && !matches!(nested, Bson::Null | Bson::Undefined) {
                                out.insert(key.clone(), self.operator(ty, key, nested, path)?);
                            }
                        }
                        Ok(Bson::Document(out))
                    }
                    other => Ok(other.clone()),
                },
                "$size" | "$minDistance" | "$maxDistance" => cast_number(value, path),
                "$exists" => cast_boolean(value, path, "boolean"),
                "$type" => check_type(value),
                "$eq" | "$gt" | "$gte" | "$lt" | "$lte" | "$not" | "$regex" | "$ne" => {
                    self.equality(ty, value, path)
                }
                "$in" | "$nin" => self.each_or_one(ty, value, path, true),
                "$options" => cast_string(value, path, false),
                "$or" | "$and" | "$nor" => {
                    let Bson::Array(items) = value else {
                        return Err(operator_error(
                            op,
                            &format!("conditional {op} requires an array"),
                        ));
                    };
                    let mut out = Vec::with_capacity(items.len());
                    for item in items {
                        out.push(match (item, elem) {
                            (Bson::Document(inner), Elem::Document(sub)) => {
                                Bson::Document(self.document(sub, inner)?)
                            }
                            (other, _) => other.clone(),
                        });
                    }
                    Ok(Bson::Array(out))
                }
                _ => Err(operator_error(op, &format!("Can't use {op} with Array."))),
            },
            PathType::Map(_) => match op {
                "$all" => self.each_or_one(ty, value, path, false),
                "$eq" | "$ne" => self.equality(ty, value, path),
                "$in" | "$nin" => self.each_or_one(ty, value, path, true),
                "$exists" => cast_boolean(value, path, "boolean"),
                "$type" => check_type(value),
                _ => Err(operator_error(op, &format!("Can't use {op}"))),
            },
        }
    }

    /// `handleArray` (`in_list` false) and `handle$in` (true, which keeps empty arrays).
    fn each_or_one(
        &mut self,
        ty: PathType,
        value: &Bson,
        path: &str,
        in_list: bool,
    ) -> Result<Bson, PrepareError> {
        match value {
            Bson::Array(items) => items
                .iter()
                .map(|item| match item {
                    Bson::Array(inner) if in_list && inner.is_empty() => Ok(item.clone()),
                    _ => self.equality(ty, item, path),
                })
                .collect::<Result<Vec<_>, _>>()
                .map(Bson::Array),
            other => Ok(Bson::Array(vec![self.equality(ty, other, path)?])),
        }
    }

    /// `schematype.castForQuery(null, value)`.
    fn equality(&mut self, ty: PathType, value: &Bson, path: &str) -> Result<Bson, PrepareError> {
        match ty {
            PathType::Keep => Ok(value.clone()),
            PathType::Scalar(elem) => self.element(elem, value, path),
            // `_castForQuery`: an array element by element, a single value as one element.
            PathType::Array(elem) => match value {
                Bson::Array(items) => items
                    .iter()
                    .map(|item| match item {
                        Bson::Document(inner) if inner.contains_key("$elemMatch") => {
                            Ok(item.clone())
                        }
                        _ => self.element(elem, item, path),
                    })
                    .collect::<Result<Vec<_>, _>>()
                    .map(Bson::Array),
                other => self.element(elem, other, path),
            },
            PathType::Map(of) => match value {
                Bson::Document(given) => {
                    let mut out = Document::new();
                    for (key, entry) in given {
                        check_map_key(path, key)?;
                        let entry_path = format!("{path}.{key}");
                        let cast = match of {
                            MapOf::Values(ty) => cast_value(ty, entry, &entry_path, false)?,
                            MapOf::Mixed => entry.clone(),
                            MapOf::Subdocuments(sub) => {
                                self.element(Elem::Document(sub), entry, &entry_path)?
                            }
                        };
                        out.insert(key.clone(), cast);
                    }
                    Ok(Bson::Document(out))
                }
                other => Ok(other.clone()),
            },
        }
    }

    /// One value cast by its element caster.
    fn element(&mut self, elem: Elem, value: &Bson, path: &str) -> Result<Bson, PrepareError> {
        match elem {
            Elem::Any => Ok(value.clone()),
            Elem::Value(ty, trim) => cast_value(ty, value, path, trim),
            Elem::Document(sub) => match value {
                Bson::Null | Bson::Undefined => Ok(value.clone()),
                Bson::Document(given) => {
                    // Mongoose builds a new sub-document from the value (defaults, `_id`).
                    let mut built = self
                        .caster
                        .construct(sub, Some(given), &format!("{path}."))?;
                    cast_leaves(sub.fields, &mut built, path)?;
                    Ok(Bson::Document(built))
                }
                _ => Err(cast_error("Embedded", path)),
            },
        }
    }

    /// One array filter.
    fn array_filter(
        &mut self,
        schema: &Schema,
        identifiers: &[(String, String)],
        filter: &mut Document,
    ) -> Result<(), PrepareError> {
        let keys: Vec<String> = filter
            .iter()
            .filter(|(_, v)| !matches!(v, Bson::Null | Bson::Undefined))
            .map(|(k, _)| k.clone())
            .collect();
        let Some(first) = keys.first() else {
            return Ok(());
        };
        if first == "$and" || first == "$or" {
            for key in &keys {
                if let Some(Bson::Array(items)) = filter.get_mut(key) {
                    for item in items.iter_mut() {
                        if let Bson::Document(inner) = item {
                            self.array_filter(schema, identifiers, inner)?;
                        }
                    }
                }
            }
            return Ok(());
        }
        let wildcard = first.split('.').next().unwrap_or_default();
        let Some((_, base)) = identifiers.iter().rev().find(|(id, _)| id == wildcard) else {
            return Ok(());
        };
        let base = clean_positional(base);
        let not_found = |relative: Option<&str>| {
            let path = match relative {
                Some(rest) => format!("{base}.0.{rest}"),
                None => format!("{base}.0"),
            };
            operator_error(
                "arrayFilters",
                &format!("Could not find path \"{path}\" in schema"),
            )
        };
        let Some(base_target) = resolve(schema, &base) else {
            return Err(not_found(None));
        };
        let base_schema = match base_target.kind {
            TargetKind::DocumentArray(sub) | TargetKind::Subdocument(sub) => Some(sub),
            _ => None,
        };
        for key in keys {
            let relative = key.split_once('.').map(|(_, rest)| rest);
            let target = match (relative, base_schema) {
                (Some(rest), Some(sub)) => resolve(sub, &clean_positional(rest)),
                _ => Some(base_target),
            };
            let Some(target) = target else {
                return Err(not_found(relative));
            };
            let ty = match (relative, base_schema) {
                (Some(rest), Some(sub)) => path_type(sub, rest, target.kind, target.trim),
                _ => path_type(schema, &base, target.kind, target.trim),
            };
            let Some(value) = filter.get(&key).cloned() else {
                continue;
            };
            let cast = match &value {
                // `castFilterPath`: operators cast one by one (no `$elemMatch` special case).
                Bson::Document(condition) if condition.keys().any(|k| is_operator(k)) => {
                    let mut out = condition.clone();
                    for (op, nested) in condition.iter().collect::<Vec<_>>().into_iter().rev() {
                        let cast = match (op.as_str(), nested) {
                            ("$not", Bson::Document(inner))
                                if !matches!(ty, PathType::Array(_))
                                    && inner.keys().next().is_some_and(|k| is_operator(k)) =>
                            {
                                let mut not = inner.clone();
                                for (k, v) in inner {
                                    not.insert(k.clone(), self.operator(ty, k, v, &key)?);
                                }
                                Bson::Document(not)
                            }
                            _ => self.operator(ty, op, nested, &key)?,
                        };
                        out.insert(op.clone(), cast);
                    }
                    Bson::Document(out)
                }
                other => self.equality(ty, other, &key)?,
            };
            filter.insert(key, cast);
        }
        Ok(())
    }

    /// `cast$expr`.
    fn expr(&mut self, schema: &Schema, value: &Bson) -> Result<Bson, PrepareError> {
        match value {
            Bson::Boolean(_) => Ok(value.clone()),
            Bson::Document(_) => Ok(expression(schema, value.clone())?),
            _ => Err(operator_error(
                "$expr",
                "`$expr` must be an object or boolean literal",
            )),
        }
    }
}

/// The document with `order`'s keys first, in that order.
fn reorder_like(doc: Document, order: &Document) -> Bson {
    let mut doc = doc;
    let mut out = Document::new();
    for key in order.keys() {
        if let Some(value) = doc.remove(key) {
            out.insert(key.clone(), value);
        }
    }
    for (key, value) in doc {
        out.insert(key, value);
    }
    Bson::Document(out)
}

/// How a resolved path is cast.
fn path_type(schema: &Schema, path: &str, kind: TargetKind, trim: bool) -> PathType {
    match kind {
        TargetKind::Value(ty) => PathType::Scalar(Elem::Value(ty, trim)),
        TargetKind::Free if own_mixed(schema, path) => PathType::Scalar(Elem::Any),
        TargetKind::Free | TargetKind::Nested(_) => PathType::Keep,
        TargetKind::Array(ty) => PathType::Array(Elem::Value(ty, trim)),
        TargetKind::MixedArray => PathType::Array(Elem::Any),
        TargetKind::DocumentArray(sub) => PathType::Array(Elem::Document(sub)),
        TargetKind::Subdocument(sub) => PathType::Scalar(Elem::Document(sub)),
        TargetKind::Map(of) => PathType::Map(of),
    }
}

/// Whether `path` is a Mixed path of the schema itself (cast as Mixed), not a path below one.
fn own_mixed(schema: &Schema, path: &str) -> bool {
    match path.rsplit_once('.') {
        None => true,
        Some((parent, _)) => matches!(
            resolve(schema, parent).map(|t| t.kind),
            Some(TargetKind::Nested(_) | TargetKind::Subdocument(_) | TargetKind::DocumentArray(_))
        ),
    }
}

/// `cleanPositionalOperators`: `$` and `$[…]` segments become `0`.
fn clean_positional(path: &str) -> String {
    path.split('.')
        .map(|segment| {
            if segment == "$" || (segment.starts_with("$[") && segment.ends_with(']')) {
                "0"
            } else {
                segment
            }
        })
        .collect::<Vec<_>>()
        .join(".")
}

/// `updatedPathsByArrayFilter`: for each `$[identifier]` in the update's paths, the path of the
/// array it stands for (earlier identifiers replaced by `0`), later paths winning.
fn paths_by_array_filter(update: &Document) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut paths: Vec<&str> = Vec::new();
    for (key, value) in update {
        match value {
            Bson::Document(inner) if key.starts_with('$') => {
                paths.extend(inner.keys().map(String::as_str));
            }
            _ => paths.push(key),
        }
    }
    for path in paths {
        let segments: Vec<&str> = path.split('.').collect();
        for (index, segment) in segments.iter().enumerate() {
            if let Some(identifier) = segment
                .strip_prefix("$[")
                .and_then(|rest| rest.strip_suffix(']'))
                .filter(|id| !id.is_empty())
            {
                let base = segments[..index]
                    .iter()
                    .map(|s| if s.starts_with("$[") { "0" } else { s })
                    .collect::<Vec<_>>()
                    .join(".");
                out.push((identifier.to_owned(), base));
            }
        }
    }
    out
}

/// The declared values of a sub-document built for a filter, cast to their types (Mongoose's
/// sub-document constructor casts them).
fn cast_leaves(
    fields: &'static [Field],
    doc: &mut Document,
    prefix: &str,
) -> Result<(), PrepareError> {
    for field in fields {
        let path = format!("{prefix}.{}", field.name);
        let Some(value) = doc.get_mut(field.name) else {
            continue;
        };
        match (field.kind, &mut *value) {
            (_, Bson::Null | Bson::Undefined) => {}
            (Kind::Value(ty), _) => *value = cast_value(ty, value, &path, false)?,
            (Kind::Array(ty), Bson::Array(items)) => {
                for item in items.iter_mut() {
                    *item = cast_value(ty, item, &path, false)?;
                }
            }
            (Kind::Nested(children), Bson::Document(inner)) => cast_leaves(children, inner, &path)?,
            (Kind::Subdocument(sub), Bson::Document(inner)) => {
                cast_leaves(sub.fields, inner, &path)?
            }
            (Kind::DocumentArray(sub), Bson::Array(items)) => {
                for item in items.iter_mut() {
                    if let Bson::Document(inner) = item {
                        cast_leaves(sub.fields, inner, &path)?;
                    }
                }
            }
            (Kind::Map(MapOf::Values(ty)), Bson::Document(inner)) => {
                for (_, entry) in inner.iter_mut() {
                    *entry = cast_value(ty, entry, &path, false)?;
                }
            }
            (Kind::Map(MapOf::Subdocuments(sub)), Bson::Document(inner)) => {
                for (_, entry) in inner.iter_mut() {
                    if let Bson::Document(entry) = entry {
                        cast_leaves(sub.fields, entry, &path)?;
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- value casters

/// A value cast to `ty` as `castForQuery(null, value)` casts it (`trim` applied when the path
/// has the setter).
pub(crate) fn cast_value(
    ty: ValueType,
    value: &Bson,
    path: &str,
    trim: bool,
) -> Result<Bson, PrepareError> {
    match ty {
        ValueType::String => cast_string(value, path, trim),
        ValueType::Number => cast_number(value, path),
        ValueType::Date => cast_date(value, path),
        ValueType::Boolean => cast_boolean(value, path, "Boolean"),
        ValueType::ObjectId => cast_object_id(value, path),
    }
}

fn cast_error(kind: &'static str, path: &str) -> PrepareError {
    PrepareError::Cast {
        kind,
        path: path.to_owned(),
    }
}

fn operator_error(operator: &str, message: &str) -> PrepareError {
    PrepareError::QueryOperator {
        operator: operator.to_owned(),
        message: message.to_owned(),
    }
}

/// A BSON number as the JavaScript number it stands for.
fn js_value(value: &Bson) -> Option<f64> {
    crate::mongo::number::read_number(value)
}

/// `castString` (and the `trim` setter).
fn cast_string(value: &Bson, path: &str, trim: bool) -> Result<Bson, PrepareError> {
    let text = match value {
        Bson::Null | Bson::Undefined => return Ok(value.clone()),
        Bson::RegularExpression(_) => return Ok(value.clone()),
        Bson::String(text) => text.clone(),
        Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_) => {
            dima_text::number_to_string(js_value(value).unwrap_or(f64::NAN))
        }
        Bson::Boolean(v) => v.to_string(),
        Bson::ObjectId(id) => id.to_hex(),
        Bson::Document(doc) => match doc.get("_id") {
            Some(Bson::String(id)) if !id.is_empty() => id.clone(),
            _ => return Err(cast_error("string", path)),
        },
        _ => return Err(cast_error("string", path)),
    };
    Ok(Bson::String(if trim {
        dima_text::trim(&text).to_owned()
    } else {
        text
    }))
}

/// `castNumber`.
fn cast_number(value: &Bson, path: &str) -> Result<Bson, PrepareError> {
    let number = match value {
        Bson::Null | Bson::Undefined => return Ok(value.clone()),
        Bson::String(text) if text.is_empty() => return Ok(Bson::Null),
        Bson::String(text) => dima_text::parse_number(text),
        Bson::Boolean(v) => f64::from(u8::from(*v)),
        Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_) => js_value(value).unwrap_or(f64::NAN),
        Bson::DateTime(date) => date.timestamp_millis() as f64,
        // `Number(objectId)`: its hex text through `Number()`.
        Bson::ObjectId(id) => dima_text::parse_number(&id.to_hex()),
        _ => f64::NAN,
    };
    if number.is_nan() {
        return Err(cast_error("Number", path));
    }
    Ok(Bson::Double(number))
}

/// `castDate`.
fn cast_date(value: &Bson, path: &str) -> Result<Bson, PrepareError> {
    const MAX: f64 = 8.64e15;
    let clip = |ms: f64| -> Result<Bson, PrepareError> {
        if !ms.is_finite() || ms.abs() > MAX {
            return Err(cast_error("date", path));
        }
        // TimeClip: toward zero (so -0 is 0); in range, so the conversion is exact.
        Ok(Bson::DateTime(DateTime::from_millis(ms.trunc() as i64)))
    };
    match value {
        Bson::Null | Bson::Undefined => Ok(value.clone()),
        Bson::String(text) if text.is_empty() => Ok(Bson::Null),
        Bson::DateTime(date) if (date.timestamp_millis() as f64).abs() <= MAX => Ok(value.clone()),
        Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_) => {
            clip(js_value(value).unwrap_or(f64::NAN))
        }
        Bson::String(text) => {
            let number = dima_text::parse_number(text);
            if !number.is_nan() && !(-271_820.0..275_761.0).contains(&number) {
                return clip(number);
            }
            match dima_text::parse_date(text) {
                Some(ms) => clip(ms as f64),
                None => Err(cast_error("date", path)),
            }
        }
        _ => Err(cast_error("date", path)),
    }
}

/// `castBoolean` (`kind` names the cast in the error: `Boolean` for a path, `boolean` for
/// `$exists`).
fn cast_boolean(value: &Bson, path: &str, kind: &'static str) -> Result<Bson, PrepareError> {
    let truth = match value {
        Bson::Null | Bson::Undefined => return Ok(value.clone()),
        Bson::Boolean(v) => *v,
        Bson::String(text) => match text.as_str() {
            "true" | "1" | "yes" => true,
            "false" | "0" | "no" => false,
            _ => return Err(cast_error(kind, path)),
        },
        // SameValueZero, as the reference's `Set` lookup: `-0` is `0`.
        Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_) => {
            let n = js_value(value).unwrap_or(f64::NAN);
            if n == 1.0 {
                true
            } else if n == 0.0 {
                false
            } else {
                return Err(cast_error(kind, path));
            }
        }
        _ => return Err(cast_error(kind, path)),
    };
    Ok(Bson::Boolean(truth))
}

/// `castObjectId`.
fn cast_object_id(value: &Bson, path: &str) -> Result<Bson, PrepareError> {
    match value {
        Bson::Null | Bson::Undefined | Bson::ObjectId(_) => Ok(value.clone()),
        Bson::String(text) => parse_object_id(text)
            .map(Bson::ObjectId)
            .map_err(|_| cast_error("ObjectId", path)),
        Bson::Document(doc) => match doc.get("_id") {
            Some(Bson::ObjectId(id)) => Ok(Bson::ObjectId(*id)),
            Some(Bson::String(text)) if !text.is_empty() => parse_object_id(text)
                .map(Bson::ObjectId)
                .map_err(|_| cast_error("ObjectId", path)),
            _ => Err(cast_error("ObjectId", path)),
        },
        _ => Err(cast_error("ObjectId", path)),
    }
}

/// The `$type` operator's check.
fn check_type(value: &Bson) -> Result<Bson, PrepareError> {
    let simple = |v: &Bson| {
        matches!(
            v,
            Bson::String(_) | Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_)
        )
    };
    match value {
        Bson::Array(items) if items.iter().all(simple) => Ok(value.clone()),
        Bson::Array(_) => Err(operator_error(
            "$type",
            "$type array values must be strings or numbers",
        )),
        other if simple(other) => Ok(value.clone()),
        _ => Err(operator_error(
            "$type",
            "$type parameter must be number, string, or array of numbers and strings",
        )),
    }
}

// ---------------------------------------------------------------- $expr

const COMPARISON: [&str; 6] = ["$cmp", "$eq", "$lt", "$lte", "$gt", "$gte"];
const ARITHMETIC_ARRAY: [&str; 11] = [
    "$multiply",
    "$divide",
    "$log",
    "$mod",
    "$trunc",
    "$avg",
    "$max",
    "$min",
    "$stdDevPop",
    "$stdDevSamp",
    "$sum",
];
const ARITHMETIC_NUMBER: [&str; 22] = [
    "$abs",
    "$exp",
    "$ceil",
    "$floor",
    "$ln",
    "$log10",
    "$sqrt",
    "$sin",
    "$cos",
    "$tan",
    "$asin",
    "$acos",
    "$atan",
    "$atan2",
    "$asinh",
    "$acosh",
    "$atanh",
    "$sinh",
    "$cosh",
    "$tanh",
    "$degreesToRadians",
    "$radiansToDegrees",
];
const DATE_PARTS: [&str; 12] = [
    "$year",
    "$month",
    "$week",
    "$dayOfMonth",
    "$dayOfYear",
    "$hour",
    "$minute",
    "$second",
    "$isoDayOfWeek",
    "$isoWeekYear",
    "$isoWeek",
    "$millisecond",
];
const ARRAY_ELEMENT: [&str; 3] = ["$arrayElemAt", "$first", "$last"];

/// `isLiteral`: not a field path, and not an object with `$` keys unless it is `{$literal}`.
fn is_literal(value: &Bson) -> bool {
    match value {
        Bson::String(text) => !text.starts_with('$'),
        Bson::Document(doc) if doc.keys().any(|k| k.starts_with('$')) => doc
            .get("$literal")
            .is_some_and(|v| !matches!(v, Bson::Null)),
        _ => true,
    }
}

/// `_castExpression`.
fn expression(schema: &Schema, value: Bson) -> Result<Bson, PrepareError> {
    let Bson::Document(mut doc) = value else {
        return Ok(value);
    };
    if let Some(cond) = doc
        .get("$cond")
        .cloned()
        .filter(|c| !matches!(c, Bson::Null))
    {
        let cast = match cond {
            Bson::Array(items) => Bson::Array(
                items
                    .into_iter()
                    .map(|item| expression(schema, item))
                    .collect::<Result<_, _>>()?,
            ),
            Bson::Document(mut branches) => {
                for key in ["if", "then", "else"] {
                    let branch = branches.remove(key).unwrap_or(Bson::Undefined);
                    let cast = expression(schema, branch)?;
                    if !matches!(cast, Bson::Undefined) {
                        branches.insert(key, cast);
                    }
                }
                Bson::Document(branches)
            }
            other => other,
        };
        doc.insert("$cond", cast);
    } else if let Some(Bson::Array(items)) = doc.get("$ifNull").cloned() {
        // Mongoose maps and drops the result: only objects (changed in place) are affected.
        let cast = items
            .into_iter()
            .map(|item| match item {
                Bson::Document(_) => expression(schema, item),
                other => Ok(other),
            })
            .collect::<Result<Vec<_>, _>>()?;
        doc.insert("$ifNull", cast);
    } else if let Some(Bson::Document(mut switch)) = doc.get("$switch").cloned() {
        if let Some(Bson::Array(branches)) = switch.get("branches").cloned() {
            let cast = branches
                .into_iter()
                .map(|b| expression(schema, b))
                .collect::<Result<Vec<_>, _>>()?;
            switch.insert("branches", cast);
        }
        if let Some(default) = switch.get("default").cloned() {
            switch.insert("default", expression(schema, default)?);
        }
        doc.insert("$switch", switch);
    }
    let keys: Vec<String> = doc.keys().cloned().collect();
    for key in keys {
        let Some(value) = doc.get(&key).cloned() else {
            continue;
        };
        let cast = if key == "$and" || key == "$or" {
            match value {
                Bson::Array(items) => Bson::Array(
                    items
                        .into_iter()
                        .map(|item| expression(schema, item))
                        .collect::<Result<_, _>>()?,
                ),
                other => other,
            }
        } else if COMPARISON.contains(&key.as_str()) {
            comparison(schema, value)?
        } else if ARITHMETIC_ARRAY.contains(&key.as_str()) {
            match value {
                Bson::Array(items) => Bson::Array(
                    items
                        .into_iter()
                        .map(expr_number)
                        .collect::<Result<_, _>>()?,
                ),
                other => expr_number(other)?,
            }
        } else if ARITHMETIC_NUMBER.contains(&key.as_str()) {
            expr_number(value)?
        } else if key == "$not" {
            expression(schema, value)?
        } else {
            continue;
        };
        doc.insert(key, cast);
    }
    if let Some(Bson::Array(items)) = doc.get("$in").cloned()
        && let (Some(search), Some(Bson::String(field))) = (items.first(), items.get(1))
        && field.starts_with('$')
    {
        let name = field.trim_start_matches('$');
        let cast = match resolve(schema, name).map(|t| t.kind) {
            Some(TargetKind::Array(ty)) => cast_value(ty, search, name, false)?,
            Some(TargetKind::DocumentArray(_) | TargetKind::MixedArray) | None => search.clone(),
            Some(_) => {
                return Err(operator_error("$in", "Path must be an array for $in"));
            }
        };
        doc.insert("$in", vec![cast, Bson::String(field.clone())]);
    }
    if let Some(size) = doc
        .get("$size")
        .cloned()
        .filter(|v| !matches!(v, Bson::Null))
    {
        doc.insert("$size", expr_number(size)?);
    }
    if let Some(round) = doc
        .get("$round")
        .cloned()
        .filter(|v| !matches!(v, Bson::Null))
    {
        match round {
            Bson::Array(items) if (1..=2).contains(&items.len()) => {
                let cast = items
                    .into_iter()
                    .map(expr_number)
                    .collect::<Result<Vec<_>, _>>()?;
                doc.insert("$round", cast);
            }
            _ => return Err(cast_error("Array", "$round")),
        }
    }
    Ok(Bson::Document(doc))
}

/// A numeric operator's literal, through `castNumber`.
fn expr_number(value: Bson) -> Result<Bson, PrepareError> {
    if !is_literal(&value) {
        return Ok(value);
    }
    cast_number(&value, "")
}

/// `castComparison`: `[lhs, rhs]`; a literal `rhs` compared with a field path is cast to that
/// path's type.
fn comparison(schema: &Schema, value: Bson) -> Result<Bson, PrepareError> {
    let Bson::Array(items) = value else {
        return Err(operator_error(
            "$expr",
            "Comparison operator must be an array of length 2",
        ));
    };
    let [lhs, rhs]: [Bson; 2] = items
        .try_into()
        .map_err(|_| operator_error("$expr", "Comparison operator must be an array of length 2"))?;
    let lhs = expression(schema, lhs)?;
    if !is_literal(&rhs) {
        let rhs = expression(schema, rhs)?;
        return Ok(Bson::Array(vec![lhs, rhs]));
    }
    // The type of what the literal is compared with.
    let mut ty: Option<ValueType> = None;
    let mut path = String::new();
    if let Bson::String(field) = &lhs
        && field.starts_with('$')
    {
        path = field.trim_start_matches('$').to_owned();
        ty = value_type_of(schema, &path);
    } else if let Bson::Document(inner) = &lhs {
        for (key, operand) in inner {
            let Bson::String(field) = operand else {
                continue;
            };
            if !field.starts_with('$') {
                continue;
            }
            let name = field.trim_start_matches('$');
            if DATE_PARTS.contains(&key.as_str()) {
                path = format!("{name}.{key}");
                ty = Some(ValueType::Number);
            } else if ARRAY_ELEMENT.contains(&key.as_str()) {
                path = format!("{name}.{key}");
                ty = match resolve(schema, name).map(|t| t.kind) {
                    Some(TargetKind::Array(element)) => Some(element),
                    Some(TargetKind::Value(element)) => Some(element),
                    _ => None,
                };
            }
        }
    }
    let rhs = match ty {
        None => rhs,
        Some(ty) => match rhs {
            Bson::Document(literal) if literal.contains_key("$literal") => {
                let inner = literal.get("$literal").cloned().unwrap_or(Bson::Null);
                let mut out = Document::new();
                out.insert(
                    "$literal",
                    cast_value(ty, &inner, &format!("{path}.$literal"), false)?,
                );
                Bson::Document(out)
            }
            other => cast_value(ty, &other, &path, false)?,
        },
    };
    Ok(Bson::Array(vec![lhs, rhs]))
}

/// The value type a field path resolves to, if it is a single value.
fn value_type_of(schema: &Schema, path: &str) -> Option<ValueType> {
    match resolve(schema, path)?.kind {
        TargetKind::Value(ty) => Some(ty),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_order_puts_and_then_or_first() {
        let filter = bson::doc! { "a": 1, "$or": [{ "b": 1 }], "$nor": [], "$and": [{ "c": 1 }] };
        let keys: Vec<String> = query_order(&filter).keys().cloned().collect();
        assert_eq!(keys, ["$and", "$or", "a", "$nor"]);
        // Not a list: merged like any other key.
        let odd = bson::doc! { "a": 1, "$and": { "c": 1 } };
        let keys: Vec<String> = query_order(&odd).keys().cloned().collect();
        assert_eq!(keys, ["a", "$and"]);
    }

    #[test]
    fn positional_segments_and_array_filter_identifiers() {
        assert_eq!(clean_positional("a.$.b.$[x].c.$[]"), "a.0.b.0.c.0");
        let update = bson::doc! {
            "$set": { "entries.$[e].n": 1, "a.$[x].b.$[y].c": 2 },
            "plain.$[p]": 3,
        };
        assert_eq!(
            paths_by_array_filter(&update),
            [
                ("e".to_owned(), "entries".to_owned()),
                ("x".to_owned(), "a".to_owned()),
                ("y".to_owned(), "a.0.b".to_owned()),
                ("p".to_owned(), "plain".to_owned()),
            ]
        );
    }
}
