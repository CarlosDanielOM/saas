//! Mongoose's update validators (`runValidators: true`), as Mongoose 8.24.3 runs them
//! (`lib/helpers/updateValidators.js`; recorded: the `rv_*` cases in `tests/mongoose/writes.json`).
//!
//! Only a call that asks for them runs them ([`crate::UpdateOptions::run_validators`]); in the
//! reference that is `commands/timer_manager.command.ts:511` (`custom_timers`). They run on the
//! update as it is sent (after casting, `trim`, timestamps and the `setDefaultsOnInsert`
//! defaults), before anything is sent, and before the write guard. Their scope:
//!
//! - **operators**: the paths of `$set`, `$setOnInsert` (also without `upsert`), `$pull` and
//!   `$pullAll` with their values, and of `$unset` as missing (only `required` can fail there);
//!   the elements of `$push` and `$addToSet`. `$inc`, `$min`, `$max`, `$mul` and the others are
//!   not validated;
//! - **paths**: only what the update names, never the rest of the document: an upsert that
//!   leaves a required path out passes. An object value is flattened into its paths (`config:
//!   {a: 1}` validates `config.a`, and a plain nested object's other paths as missing); a path
//!   below a `Mixed` path is not validated; `$` and `$[name]` count as element `0`, and a path
//!   still holding `$` after that is skipped; a path inside a document array without an index
//!   (`items.quantity`, as a `$pull` condition flattens) validates against the element's field;
//! - **whole sub-documents**: a sub-document set at a single nested path, or at an element
//!   (`items.0`), is validated whole (its missing required paths too), and the paths inside it
//!   the update also names are not validated again. A whole document array set by `$set`
//!   (`items: [...]`) gets its array validators only, its elements through their flattened
//!   paths (`items.0`, whole). A document array's `$push` validates every pushed element, but
//!   reports the errors of the **last** failing one only, under the array's path without an
//!   index (`items.quantity`); a value array's `$push` reports under the array's path;
//! - **`this`** in a validator or a `required` function is the query, not a document: a
//!   `required: function () { return this.category !== 'tts' }` sees no `category` and
//!   requires. Here a [`crate::Rule::required_when`] function is given an empty document; inside
//!   a sub-document validated whole, the sub-document;
//! - **`$pull`** of a whole array path is skipped, but its condition's paths are validated
//!   (`$pull: {items: {quantity: -1}}` fails on `items.quantity`);
//! - **order and message**: the errors of plain paths first, in the order of the sent update,
//!   then those of sub-documents validated whole (they are asynchronous); one error per path
//!   (the first validator that fails; a path reported twice keeps its first place and its last
//!   error); the message names no model: `Validation failed: frequency: …`.

use crate::collection::CollectionInfo;
use crate::validation::{LevelRule, ValidationError, ValidatorError, check, validate_level};
use bson::{Bson, Document};
use dima_store::mongo::schema::{Field, Kind, MapOf, Schema};

/// What an update path is, as `schema._getSchema(path)` resolves it.
enum Target {
    /// One schema type: its rule pattern (`$` for document array elements, `$*` for Map
    /// values) and the path its messages name (inside the sub-document it belongs to).
    Leaf { pattern: String, local: String },
    /// A single nested sub-document (or a Map value that is one).
    SingleNested {
        schema: &'static Schema,
        pattern: String,
        local: String,
    },
    /// A document array, as a whole.
    DocumentArray {
        schema: &'static Schema,
        pattern: String,
        local: String,
    },
    /// One element of a document array (`items.0`).
    Element {
        schema: &'static Schema,
        pattern: String,
    },
}

fn is_index(segment: &str) -> bool {
    !segment.is_empty() && segment.bytes().all(|b| b.is_ascii_digit())
}

/// Resolves an update path (positional operators already cleaned) to the schema type Mongoose
/// validates it with; `None` for a path without one (unknown, implicit, a plain nested object,
/// below a value or below `Mixed`).
fn resolve(schema: &'static Schema, path: &str) -> Option<Target> {
    let segments: Vec<&str> = path.split('.').collect();
    let mut fields: &'static [Field] = schema.fields;
    let mut pattern: Vec<&str> = Vec::new();
    let mut local: Vec<&str> = Vec::new();
    let mut i = 0;
    while let Some(segment) = segments.get(i).copied() {
        let last = i + 1 == segments.len();
        let field = fields.iter().find(|f| f.name == segment)?;
        pattern.push(field.name);
        local.push(field.name);
        match field.kind {
            Kind::Value(_) | Kind::Mixed => {
                return last.then(|| Target::Leaf {
                    pattern: pattern.join("."),
                    local: local.join("."),
                });
            }
            Kind::Nested(children) => {
                if last {
                    return None;
                }
                fields = children;
            }
            Kind::Subdocument(sub) => {
                if last {
                    return Some(Target::SingleNested {
                        schema: sub,
                        pattern: pattern.join("."),
                        local: local.join("."),
                    });
                }
                fields = sub.fields;
                local.clear();
            }
            Kind::DocumentArray(sub) => {
                if last {
                    return Some(Target::DocumentArray {
                        schema: sub,
                        pattern: pattern.join("."),
                        local: local.join("."),
                    });
                }
                pattern.push("$");
                if segments.get(i + 1).is_some_and(|s| is_index(s)) {
                    i += 1;
                    if i + 1 == segments.len() {
                        return Some(Target::Element {
                            schema: sub,
                            pattern: pattern.join("."),
                        });
                    }
                }
                fields = sub.fields;
                local.clear();
            }
            Kind::Array(_) | Kind::MixedArray => {
                if last {
                    return Some(Target::Leaf {
                        pattern: pattern.join("."),
                        local: local.join("."),
                    });
                }
                // `tags.0`: the element's own schema type (no rule of this crate is on one).
                let index = segments.get(i + 1).copied().filter(|s| is_index(s))?;
                if i + 2 != segments.len() {
                    return None;
                }
                pattern.push("$");
                local.push(index);
                return Some(Target::Leaf {
                    pattern: pattern.join("."),
                    local: local.join("."),
                });
            }
            Kind::Map(of) => {
                if last {
                    return Some(Target::Leaf {
                        pattern: pattern.join("."),
                        local: local.join("."),
                    });
                }
                let key = segments.get(i + 1).copied()?;
                i += 1;
                pattern.push("$*");
                local.push(key);
                let deeper = i + 1 < segments.len();
                match of {
                    MapOf::Values(_) | MapOf::Mixed => {
                        return (!deeper).then(|| Target::Leaf {
                            pattern: pattern.join("."),
                            local: local.join("."),
                        });
                    }
                    MapOf::Subdocuments(sub) => {
                        if !deeper {
                            return Some(Target::SingleNested {
                                schema: sub,
                                pattern: pattern.join("."),
                                local: local.join("."),
                            });
                        }
                        fields = sub.fields;
                        local.clear();
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// `true` when `path` is a `Mixed` path (or a Map value of `Mixed`): `flatten` does not go into
/// it.
fn is_mixed(schema: &'static Schema, path: &str) -> bool {
    let mut fields: &'static [Field] = schema.fields;
    let mut segments = path.split('.').peekable();
    while let Some(segment) = segments.next() {
        let Some(field) = fields.iter().find(|f| f.name == segment) else {
            return false;
        };
        let last = segments.peek().is_none();
        match field.kind {
            Kind::Mixed => return last,
            Kind::Nested(children) if !last => fields = children,
            Kind::Subdocument(sub) if !last => fields = sub.fields,
            Kind::DocumentArray(sub) if !last => {
                if segments.peek().is_some_and(|s| is_index(s)) {
                    segments.next();
                    if segments.peek().is_none() {
                        return false;
                    }
                }
                fields = sub.fields;
            }
            Kind::Map(MapOf::Mixed) if !last => {
                segments.next();
                return segments.peek().is_none();
            }
            Kind::Map(MapOf::Subdocuments(sub)) if !last => {
                segments.next();
                if segments.peek().is_none() {
                    return false;
                }
                fields = sub.fields;
            }
            _ => return false,
        }
    }
    false
}

/// The fields of the plain nested object at `path` of the root schema (`schema.nested`), if it
/// is one.
fn nested_fields(schema: &'static Schema, path: &str) -> Option<&'static [Field]> {
    let mut fields: &'static [Field] = schema.fields;
    for segment in path.split('.') {
        match fields.iter().find(|f| f.name == segment)?.kind {
            Kind::Nested(children) => fields = children,
            _ => return None,
        }
    }
    Some(fields)
}

/// Every schema path below a plain nested object, as `schema.paths` lists them.
fn leaf_paths(fields: &'static [Field], prefix: &str, out: &mut Vec<String>) {
    for field in fields {
        let path = format!("{prefix}.{}", field.name);
        match field.kind {
            Kind::Nested(children) => leaf_paths(children, &path, out),
            _ => out.push(path),
        }
    }
}

/// A JavaScript object's keys: insertion order, a key set again keeps its place.
#[derive(Default)]
struct Ordered<V> {
    entries: Vec<(String, V)>,
}

impl<V> Ordered<V> {
    fn set(&mut self, key: String, value: V) {
        match self.entries.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = value,
            None => self.entries.push((key, value)),
        }
    }

    fn contains(&self, key: &str) -> bool {
        self.entries.iter().any(|(k, _)| k == key)
    }
}

/// Mongoose's `flatten(update, path, null, schema)`: every key, and the keys of the objects and
/// non-empty arrays inside it (not below `Mixed`); a plain nested object also lists its other
/// schema paths as missing (`None`).
fn flatten(
    schema: &'static Schema,
    value: &Document,
    prefix: &str,
    out: &mut Ordered<Option<Bson>>,
) {
    for (key, val) in value {
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        out.set(path.clone(), Some(val.clone()));
        if is_mixed(schema, &path) {
            continue;
        }
        match val {
            Bson::Document(inner) => flatten(schema, inner, &path, out),
            Bson::Array(items) if !items.is_empty() => {
                let as_document: Document = items
                    .iter()
                    .enumerate()
                    .map(|(i, item)| (i.to_string(), item.clone()))
                    .collect();
                flatten(schema, &as_document, &path, out);
                out.set(path.clone(), Some(val.clone()));
            }
            _ => {}
        }
        if let Some(fields) = nested_fields(schema, &path) {
            let mut below = Vec::new();
            leaf_paths(fields, &path, &mut below);
            for leaf in below {
                if !out.contains(&leaf) {
                    out.set(leaf, None);
                }
            }
        }
    }
}

/// `cleanPositionalOperators`: `$` and `$[name]` become `0`.
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

/// Collects the errors in Mongoose's order: plain paths as they run, sub-documents afterwards.
struct Run<'i> {
    info: &'i CollectionInfo,
    plain: Vec<ValidatorError>,
    later: Vec<ValidatorError>,
}

impl Run<'_> {
    /// The first failing rule of the schema type at `pattern` for `value` (`this` is the query:
    /// a `required` function sees an empty document).
    fn leaf(
        &self,
        pattern: &str,
        local: &str,
        value: Option<&Bson>,
    ) -> Option<(crate::ValidatorKind, String)> {
        let query = Document::new();
        self.info
            .rules
            .iter()
            .filter(|rule| rule.path == pattern)
            .find_map(|rule| check(rule.check, local, value, &query))
    }

    fn plain_error(&mut self, path: &str, failed: Option<(crate::ValidatorKind, String)>) -> bool {
        match failed {
            Some((kind, message)) => {
                self.plain.push(ValidatorError {
                    path: path.to_owned(),
                    kind,
                    message,
                });
                true
            }
            None => false,
        }
    }

    /// A sub-document validated whole: the errors, with paths inside it.
    fn subdocument(
        &self,
        schema: &'static Schema,
        pattern: &str,
        document: &Document,
    ) -> Vec<ValidatorError> {
        let inside = format!("{pattern}.");
        let split: Vec<(Vec<&'static str>, crate::validation::Check)> = self
            .info
            .rules
            .iter()
            .filter_map(|rule| {
                rule.path
                    .strip_prefix(inside.as_str())
                    .map(|rest| (rest.split('.').collect(), rule.check))
            })
            .collect();
        let rules: Vec<LevelRule<'_>> = split
            .iter()
            .map(|(segments, check)| LevelRule {
                segments,
                check: *check,
            })
            .collect();
        let mut errors = Vec::new();
        validate_level(
            schema.fields,
            document,
            None,
            &rules,
            "",
            document,
            None,
            &mut errors,
        );
        errors
    }

    fn later_errors(&mut self, prefix: &str, errors: Vec<ValidatorError>) {
        for mut error in errors {
            error.path = format!("{prefix}.{}", error.path);
            self.later.push(error);
        }
    }
}

/// Runs Mongoose's update validators on a prepared operator update (see the module docs).
pub(crate) fn validate_update(
    info: &CollectionInfo,
    update: &Document,
) -> Result<(), ValidationError> {
    let schema = info.schema;
    // `updatedValues` (`None` for `$unset`), whether each came from `$pull`/`$pullAll`, and the
    // elements of `$push`/`$addToSet` per path.
    let mut values: Ordered<(Option<Bson>, bool)> = Ordered::default();
    let mut atomic: Ordered<Vec<Bson>> = Ordered::default();
    for (operator, body) in update {
        let Bson::Document(body) = body else {
            continue;
        };
        if operator == "$push" || operator == "$addToSet" {
            for (path, value) in body {
                let elements = match value {
                    Bson::Document(each) if each.contains_key("$each") => {
                        each.get_array("$each").cloned().unwrap_or_default()
                    }
                    other => vec![other.clone()],
                };
                let mut all = atomic
                    .entries
                    .iter()
                    .find(|(k, _)| k == path)
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default();
                all.extend(elements);
                atomic.set(path.clone(), all);
            }
            continue;
        }
        let mut flat = Ordered::default();
        flatten(schema, body, "", &mut flat);
        for (path, value) in flat.entries {
            let path = clean_positional(&path);
            if path.contains('$') {
                continue;
            }
            match operator.as_str() {
                "$set" | "$setOnInsert" => values.set(path, (value, false)),
                "$pull" | "$pullAll" => values.set(path, (value, true)),
                "$unset" => values.set(path, (None, false)),
                _ => {}
            }
        }
    }
    let mut run = Run {
        info,
        plain: Vec::new(),
        later: Vec::new(),
    };
    // A whole element (`items.0`) marks its paths validated before anything runs; a single
    // nested sub-document when its turn comes.
    let mut validated: Vec<String> = values
        .entries
        .iter()
        .filter(|(path, (value, _))| {
            matches!(value, Some(Bson::Document(_)))
                && matches!(resolve(schema, path), Some(Target::Element { .. }))
        })
        .map(|(path, _)| path.clone())
        .collect();
    for (path, (value, pull)) in &values.entries {
        let Some(target) = resolve(schema, path) else {
            continue;
        };
        // `$pull: {tags: {$in: [...]}}`: each listed value.
        if let Some(Bson::Document(condition)) = value
            && let Ok(listed) = condition.get_array("$in")
        {
            let (pattern, local) = match &target {
                Target::Leaf { pattern, local }
                | Target::SingleNested { pattern, local, .. }
                | Target::DocumentArray { pattern, local, .. } => (pattern.clone(), local.clone()),
                Target::Element { pattern, .. } => (pattern.clone(), path.clone()),
            };
            for (j, item) in listed.iter().enumerate() {
                let failed = run.leaf(&pattern, &local, Some(item));
                run.plain_error(&format!("{path}.$in.{j}"), failed);
            }
            continue;
        }
        if *pull && matches!(target, Target::DocumentArray { .. })
            || *pull
                && matches!(&target, Target::Leaf { pattern, .. } if is_array_pattern(schema, pattern))
        {
            continue;
        }
        if let Target::Element {
            schema: sub,
            pattern,
        } = &target
            && let Some(Bson::Document(element)) = value
        {
            let errors = run.subdocument(sub, pattern, element);
            run.later_errors(path, errors);
            continue;
        }
        if validated.iter().any(|v| path.starts_with(&format!("{v}."))) {
            continue;
        }
        match target {
            Target::Leaf { pattern, local } => {
                let failed = run.leaf(&pattern, &local, value.as_ref());
                run.plain_error(path, failed);
            }
            Target::SingleNested {
                schema: sub,
                pattern,
                local,
            } => {
                validated.push(path.clone());
                let failed = run.leaf(&pattern, &local, value.as_ref());
                if !run.plain_error(path, failed)
                    && let Some(Bson::Document(inner)) = value
                {
                    let errors = run.subdocument(sub, &pattern, inner);
                    run.later_errors(path, errors);
                }
            }
            Target::DocumentArray { pattern, local, .. } => {
                let failed = run.leaf(&pattern, &local, value.as_ref());
                run.plain_error(path, failed);
            }
            Target::Element { pattern, .. } => {
                let failed = run.leaf(&pattern, path, value.as_ref());
                run.plain_error(path, failed);
            }
        }
    }
    for (path, elements) in &atomic.entries {
        match resolve(schema, path) {
            Some(Target::DocumentArray {
                schema: sub,
                pattern,
                local,
            }) => {
                let array = Bson::Array(elements.clone());
                let failed = run.leaf(&pattern, &local, Some(&array));
                if run.plain_error(path, failed) {
                    continue;
                }
                // Every element is validated; the last failing one's errors are reported.
                let element = format!("{pattern}.$");
                let last = elements
                    .iter()
                    .filter_map(|item| match item {
                        Bson::Document(document) => Some(run.subdocument(sub, &element, document)),
                        _ => None,
                    })
                    .rfind(|errors| !errors.is_empty());
                if let Some(errors) = last {
                    run.later_errors(path, errors);
                }
            }
            _ => {
                if let Some(Target::Leaf { pattern, local }) = resolve(schema, &format!("{path}.0"))
                {
                    for item in elements {
                        let failed = run.leaf(&pattern, &local, Some(item));
                        run.plain_error(path, failed);
                    }
                }
            }
        }
    }
    // `err.addError(path, error)`: a path reported again keeps its place and takes the error.
    let mut errors: Vec<ValidatorError> = Vec::new();
    for error in run.plain.into_iter().chain(run.later) {
        match errors.iter_mut().find(|e| e.path == error.path) {
            Some(slot) => *slot = error,
            None => errors.push(error),
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(ValidationError {
            model: info.model,
            on_update: true,
            errors,
        })
    }
}

/// `true` when the leaf at `pattern` is an array of values (a `$pull` of it is not validated).
fn is_array_pattern(schema: &'static Schema, pattern: &str) -> bool {
    let mut fields: &'static [Field] = schema.fields;
    let mut segments = pattern
        .split('.')
        .filter(|s| *s != "$" && *s != "$*")
        .peekable();
    while let Some(segment) = segments.next() {
        let Some(field) = fields.iter().find(|f| f.name == segment) else {
            return false;
        };
        let last = segments.peek().is_none();
        match field.kind {
            Kind::Array(_) | Kind::MixedArray => return last,
            Kind::Nested(children) => fields = children,
            Kind::Subdocument(sub) | Kind::DocumentArray(sub) => fields = sub.fields,
            Kind::Map(MapOf::Subdocuments(sub)) => fields = sub.fields,
            _ => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    fn paths(error: Result<(), ValidationError>) -> Vec<String> {
        error
            .err()
            .map(|e| e.errors.into_iter().map(|e| e.path).collect())
            .unwrap_or_default()
    }

    #[test]
    fn scope_follows_mongoose() {
        let timers = &crate::custom_timers::INFO;
        // `$inc` and `$max` are not validated; `$setOnInsert` is, also without an upsert.
        let skipped = doc! { "$inc": { "frequency": -100 }, "$max": { "frequency": 5000 } };
        assert_eq!(validate_update(timers, &skipped), Ok(()));
        let on_insert = doc! { "$setOnInsert": { "frequency": 0 } };
        assert_eq!(paths(validate_update(timers, &on_insert)), ["frequency"]);
        // `$unset` checks `required` only.
        let unset = doc! { "$unset": { "message": 1, "frequencyUnit": 1 } };
        let error = validate_update(timers, &unset).err();
        assert_eq!(
            error.map(|e| e.to_string()).as_deref(),
            Some("Validation failed: message: Path `message` is required.")
        );
        // Pushed sub-documents: the last failing one, without an index.
        let wallets = &crate::user_extension_inventories::INFO;
        let push = doc! { "$push": { "items": { "$each": [
            { "quantity": -1, "source": "stolen" },
            {
                "channelExtensionItemID": bson::oid::ObjectId::new(),
                "quantity": -2,
                "purchasePriceBits": 100,
                "source": "gift",
            },
        ] } } };
        assert_eq!(paths(validate_update(wallets, &push)), ["items.quantity"]);
        // A whole element; positional paths count as element `0`.
        // (The store adds the element's defaults before validation; given here.)
        let element = doc! { "$set": { "items.0": { "quantity": -1, "purchasePriceBits": 0, "source": "gift" } } };
        assert_eq!(
            paths(validate_update(wallets, &element)),
            ["items.0.channelExtensionItemID", "items.0.quantity"]
        );
        let positional = doc! { "$set": { "items.$.quantity": -5 } };
        assert_eq!(
            paths(validate_update(wallets, &positional)),
            ["items.0.quantity"]
        );
        // `this` is the query: `required: function () { return this.category !== 'tts' }`.
        let items = &crate::channel_extension_items::INFO;
        let unset = doc! { "$set": { "volume": 101 }, "$unset": { "assetID": 1 } };
        assert_eq!(paths(validate_update(items, &unset)), ["volume", "assetID"]);
    }
}
