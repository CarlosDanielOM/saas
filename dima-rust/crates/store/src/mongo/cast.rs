//! Shared casting for the write helpers: building a document the way Mongoose's `Document`
//! constructor does, the hydration ("init") variant, value casting (`trim`, sub-documents) and
//! `minimize`.
//!
//! Key order matters because it becomes the stored field order. Mongoose builds a new document
//! in four steps (`document.js`, `Document` constructor):
//! 1. a skeleton of empty parent objects for nested paths (`$__buildDoc`);
//! 2. literal defaults, plus the implicit `[]` of value arrays and the auto `_id`, in schema
//!    path order;
//! 3. the given values, keys in schema order (unknown keys after them, then dropped by strict
//!    mode); a given nested object replaces the skeleton and gets its own defaults; then the
//!    top-level keys are put back in schema tree order;
//! 4. function defaults (`Date.now`, `() => …`, document-array `[]`) in schema path order.
//!
//! Hydration of a stored document (`init`) instead keeps the stored keys and adds missing
//! defaults: for the top level and for each element of a document array, literal defaults
//! before the stored values and function defaults after; for a single nested sub-document, the
//! stored values, then function defaults, then literal ones. A save writes these defaults back
//! (top level and single nested ones as their own paths; array elements only when the whole
//! array is `$set`).

use crate::mongo::schema::{Field, Kind, Leaf, Schema, Target, TargetKind};
use bson::oid::ObjectId;
use bson::{Bson, DateTime, Document};

/// The time and id source a write is prepared with. Everything that depends on "now" reads it
/// from here, so callers (and their tests) stay deterministic.
#[derive(Clone, Debug)]
pub struct WriteContext {
    now_ms: i64,
    sequence: Option<u64>,
}

impl WriteContext {
    /// A write at `now_ms` (epoch milliseconds); new ObjectIds come from `ObjectId::new()`.
    pub fn new(now_ms: i64) -> Self {
        Self {
            now_ms,
            sequence: None,
        }
    }

    /// A write at `now_ms` whose new ObjectIds are `<now seconds><0000000000><counter>`,
    /// counting up from `first`: deterministic ids for tests.
    pub fn with_sequential_ids(now_ms: i64, first: u64) -> Self {
        Self {
            now_ms,
            sequence: Some(first),
        }
    }

    /// The write time in epoch milliseconds.
    pub fn now_ms(&self) -> i64 {
        self.now_ms
    }

    /// The write time as a BSON date.
    pub fn now(&self) -> DateTime {
        DateTime::from_millis(self.now_ms)
    }

    /// A new ObjectId for an `_id` Mongoose would generate.
    pub fn new_object_id(&mut self) -> ObjectId {
        match &mut self.sequence {
            None => ObjectId::new(),
            Some(next) => {
                let counter = *next;
                *next = next.wrapping_add(1);
                let seconds = u32::try_from(self.now_ms.div_euclid(1000)).unwrap_or(0);
                let mut bytes = [0_u8; 12];
                bytes[..4].copy_from_slice(&seconds.to_be_bytes());
                bytes[4..].copy_from_slice(&counter.to_be_bytes());
                ObjectId::from_bytes(bytes)
            }
        }
    }
}

/// A write that could not be prepared.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum PrepareError {
    /// An update operator whose value is not a document (Mongoose: "Invalid atomic update value").
    #[error("invalid atomic update value for {op}: expected an object")]
    InvalidOperatorValue {
        /// The operator.
        op: String,
    },
    /// `$each`, `$or`, `$and` or `$in` directly under an operator.
    #[error("invalid update: unexpected modifier {modifier} as a key in an operator")]
    UnexpectedModifier {
        /// The modifier.
        modifier: String,
    },
    /// A sub-document path was given something other than an object or null.
    #[error("{path}: expected an object")]
    ObjectExpected {
        /// The path.
        path: String,
    },
    /// `$rename` to a null name.
    #[error("{path}: $rename needs a string")]
    InvalidRename {
        /// The path.
        path: String,
    },
    /// A save change addressed a path that is not an array (push) or cannot hold a value.
    #[error("{path}: {reason}")]
    InvalidChange {
        /// The path.
        path: String,
        /// Why.
        reason: &'static str,
    },
    /// The loaded document of a save has no `_id`.
    #[error("the loaded document has no _id")]
    MissingId,
    /// An input nests documents and arrays deeper than [`MAX_DEPTH`] levels (MongoDB stores at
    /// most 100), or a schema refers to itself through defaults deeper than that.
    #[error("nested deeper than {limit} levels")]
    TooDeep {
        /// The limit.
        limit: usize,
    },
}

/// The deepest nesting of documents and arrays the write helpers accept in any input (the
/// top-level document is level 1). MongoDB refuses to store documents nested more than 100
/// levels, so no valid write comes close; the limit bounds the helpers' recursion.
pub const MAX_DEPTH: usize = 128;

/// Fails when `value`, placed at nesting level `level` (a value directly in the top-level
/// document is at level 2), nests documents and arrays deeper than [`MAX_DEPTH`]. Iterative, so
/// the check itself cannot overflow the stack.
pub(crate) fn check_depth_at(value: &Bson, level: usize) -> Result<(), PrepareError> {
    depth_within(vec![(value, level)])
}

/// [`check_depth`] for a document (level 1).
pub(crate) fn check_document_depth(doc: &Document) -> Result<(), PrepareError> {
    depth_within(doc.values().map(|v| (v, 2)).collect())
}

fn depth_within(mut stack: Vec<(&Bson, usize)>) -> Result<(), PrepareError> {
    while let Some((value, depth)) = stack.pop() {
        let (Bson::Document(_) | Bson::Array(_)) = value else {
            continue;
        };
        if depth > MAX_DEPTH {
            return Err(PrepareError::TooDeep { limit: MAX_DEPTH });
        }
        match value {
            Bson::Document(inner) => stack.extend(inner.values().map(|v| (v, depth + 1))),
            Bson::Array(items) => stack.extend(items.iter().map(|v| (v, depth + 1))),
            _ => {}
        }
    }
    Ok(())
}

/// Collects what strict mode dropped while casting.
pub(crate) struct Caster<'c> {
    pub ctx: &'c mut WriteContext,
    pub dropped: Vec<String>,
    /// How many documents deep the caster is building (bounds schemas that refer to themselves
    /// through their defaults).
    depth: usize,
}

impl<'c> Caster<'c> {
    pub fn new(ctx: &'c mut WriteContext) -> Self {
        Self {
            ctx,
            dropped: Vec::new(),
            depth: 0,
        }
    }

    /// Runs `build` one document level deeper, failing past [`MAX_DEPTH`].
    fn deeper<T>(
        &mut self,
        build: impl FnOnce(&mut Self) -> Result<T, PrepareError>,
    ) -> Result<T, PrepareError> {
        if self.depth >= MAX_DEPTH {
            return Err(PrepareError::TooDeep { limit: MAX_DEPTH });
        }
        self.depth += 1;
        let out = build(self);
        self.depth -= 1;
        out
    }

    pub fn drop_path(&mut self, path: String) {
        self.dropped.push(path);
    }

    /// A default value as Mongoose's `getDefault` produces it. `init` is the upsert flavour
    /// (`getDefault(null, true)`), which builds a sub-document default by hydration.
    pub fn default_value(
        &mut self,
        field: &Field,
        path: &str,
        init: bool,
    ) -> Result<Option<Bson>, PrepareError> {
        let Some(default) = field.default else {
            return Ok(None);
        };
        let raw = default.value.build(self.ctx.now_ms());
        let value = match (field.kind, raw) {
            (Kind::Subdocument(schema), Bson::Document(given)) => Bson::Document(if init {
                self.init_subdocument(schema, &given)?
            } else {
                self.construct(schema, Some(&given), path)?
            }),
            (Kind::DocumentArray(schema), Bson::Array(items)) => Bson::Array(
                items
                    .into_iter()
                    .map(|item| self.cast_element(schema, item, path, init))
                    .collect::<Result<_, _>>()?,
            ),
            (_, Bson::String(text)) if field.trim => {
                Bson::String(dima_text::trim(&text).to_owned())
            }
            (_, other) => other,
        };
        Ok(Some(value))
    }

    fn cast_element(
        &mut self,
        schema: &Schema,
        item: Bson,
        path: &str,
        init: bool,
    ) -> Result<Bson, PrepareError> {
        match item {
            Bson::Document(given) => Ok(Bson::Document(if init {
                self.init_subdocument(schema, &given)?
            } else {
                self.construct(schema, Some(&given), path)?
            })),
            other => Ok(other),
        }
    }

    /// A new document built from `input` as Mongoose's `Document` constructor builds it (see
    /// the module notes). Unknown keys are dropped and recorded.
    pub fn construct(
        &mut self,
        schema: &Schema,
        input: Option<&Document>,
        prefix: &str,
    ) -> Result<Document, PrepareError> {
        self.deeper(|caster| caster.construct_here(schema, input, prefix))
    }

    fn construct_here(
        &mut self,
        schema: &Schema,
        input: Option<&Document>,
        prefix: &str,
    ) -> Result<Document, PrepareError> {
        let leaves = schema.leaves();
        let mut doc = Document::new();
        // 1. Skeleton of nested parents.
        for leaf in &leaves {
            if let Leaf::Field { path, .. } = leaf {
                let pieces: Vec<&str> = path.split('.').collect();
                if let Some((_, parents)) = pieces.split_last() {
                    ensure_parents(&mut doc, parents);
                }
            }
        }
        // 2. Literal defaults (and the auto `_id`).
        let has_given_id = input.is_some_and(|i| i.contains_key("_id"));
        for leaf in &leaves {
            match leaf {
                Leaf::AutoId => {
                    if !has_given_id && !doc.contains_key("_id") {
                        let id = self.ctx.new_object_id();
                        doc.insert("_id", id);
                    }
                }
                Leaf::Field { path, field } if !field.default_after_setters() => {
                    self.apply_default(&mut doc, path, field, false)?;
                }
                Leaf::Field { .. } => {}
            }
        }
        // 3. The given values.
        if let Some(input) = input {
            for key in keys_in_schema_order(schema, input) {
                let Some(value) = input.get(&key) else {
                    continue;
                };
                let path = format!("{prefix}{key}");
                let field = schema.fields.iter().find(|f| f.name == key);
                match field.map(|f| f.kind) {
                    Some(Kind::Nested(children)) => match value {
                        Bson::Document(given) => {
                            doc.remove(&key);
                            let mut nested =
                                self.set_nested(children, given, &format!("{path}."))?;
                            self.apply_defaults_to_nested(&mut nested, children, "")?;
                            doc.insert(key, nested);
                        }
                        Bson::Null => {
                            doc.insert(key, Bson::Null);
                        }
                        Bson::Undefined => {}
                        _ => self.drop_path(path),
                    },
                    Some(_) => {
                        if matches!(value, Bson::Undefined) {
                            continue;
                        }
                        let Some(field) = field else {
                            continue;
                        };
                        let cast =
                            self.cast_value(Target::of_field(field), value.clone(), &path)?;
                        doc.insert(key, cast);
                    }
                    None if is_special_key(schema, &key) => {
                        if !matches!(value, Bson::Undefined) {
                            doc.insert(key, value.clone());
                        }
                    }
                    None => self.drop_path(path),
                }
            }
            doc = reorder(doc, &schema.tree_keys());
        }
        // 4. Function defaults.
        for leaf in &leaves {
            if let Leaf::Field { path, field } = leaf
                && field.default_after_setters()
            {
                self.apply_default(&mut doc, path, field, false)?;
            }
        }
        Ok(doc)
    }

    /// Sets the default of `path` in `doc` when the value there is missing and every parent
    /// exists as an object (null parents stop it, as in `applyDefaults`).
    fn apply_default(
        &mut self,
        doc: &mut Document,
        path: &str,
        field: &Field,
        init: bool,
    ) -> Result<(), PrepareError> {
        let pieces: Vec<&str> = path.split('.').collect();
        let Some((last, parents)) = pieces.split_last() else {
            return Ok(());
        };
        let mut cursor = doc;
        for piece in parents {
            match cursor.get_mut(*piece) {
                Some(Bson::Document(inner)) => cursor = inner,
                _ => return Ok(()),
            }
        }
        if cursor.contains_key(*last) {
            return Ok(());
        }
        if let Some(value) = self.default_value(field, path, init)? {
            cursor.insert(*last, value);
        }
        Ok(())
    }

    /// `$set(nestedPath, object)` while constructing: keys in schema order, each one set
    /// recursively; unknown keys dropped.
    pub fn set_nested(
        &mut self,
        fields: &'static [Field],
        given: &Document,
        prefix: &str,
    ) -> Result<Document, PrepareError> {
        self.deeper(|caster| caster.set_nested_here(fields, given, prefix))
    }

    fn set_nested_here(
        &mut self,
        fields: &'static [Field],
        given: &Document,
        prefix: &str,
    ) -> Result<Document, PrepareError> {
        let mut out = Document::new();
        for key in keys_in_order(fields.iter().map(|f| f.name), given) {
            let Some(value) = given.get(&key) else {
                continue;
            };
            let path = format!("{prefix}{key}");
            match fields.iter().find(|f| f.name == key) {
                Some(field) => match (field.kind, value) {
                    (Kind::Nested(children), Bson::Document(inner)) => {
                        let nested = self.set_nested(children, inner, &format!("{path}."))?;
                        out.insert(key, nested);
                    }
                    (_, Bson::Undefined) => {}
                    _ => {
                        let cast =
                            self.cast_value(Target::of_field(field), value.clone(), &path)?;
                        out.insert(key, cast);
                    }
                },
                None => self.drop_path(path),
            }
        }
        Ok(out)
    }

    /// `$applyDefaultsToNested`: every default under a given nested object, in path order,
    /// creating missing (or null) intermediate objects on the way.
    fn apply_defaults_to_nested(
        &mut self,
        nested: &mut Document,
        fields: &'static [Field],
        prefix: &str,
    ) -> Result<(), PrepareError> {
        self.deeper(|caster| caster.apply_defaults_to_nested_here(nested, fields, prefix))
    }

    fn apply_defaults_to_nested_here(
        &mut self,
        nested: &mut Document,
        fields: &'static [Field],
        prefix: &str,
    ) -> Result<(), PrepareError> {
        for field in fields {
            match field.kind {
                Kind::Nested(children) => {
                    if !children_have_defaults(children) {
                        continue;
                    }
                    let needs_object = !matches!(nested.get(field.name), Some(Bson::Document(_)));
                    if needs_object {
                        nested.insert(field.name, Document::new());
                    }
                    if let Some(Bson::Document(inner)) = nested.get_mut(field.name) {
                        self.apply_defaults_to_nested(
                            inner,
                            children,
                            &format!("{prefix}{}.", field.name),
                        )?;
                    }
                }
                _ => {
                    if field.default.is_some() && !nested.contains_key(field.name) {
                        let path = format!("{prefix}{}", field.name);
                        if let Some(value) = self.default_value(field, &path, false)? {
                            nested.insert(field.name, value);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// A single nested sub-document hydrated from `given` (Mongoose's `cast(val, doc, init)`):
    /// skeleton, given keys, then function defaults, then literal defaults.
    pub fn init_subdocument(
        &mut self,
        schema: &Schema,
        given: &Document,
    ) -> Result<Document, PrepareError> {
        self.init_subdocument_tracked(schema, given)
            .map(|(doc, _)| doc)
    }

    /// [`Caster::init_subdocument`], also returning the paths it filled with defaults, in order.
    fn init_subdocument_tracked(
        &mut self,
        schema: &Schema,
        given: &Document,
    ) -> Result<(Document, Vec<String>), PrepareError> {
        self.deeper(|caster| caster.init_subdocument_here(schema, given))
    }

    fn init_subdocument_here(
        &mut self,
        schema: &Schema,
        given: &Document,
    ) -> Result<(Document, Vec<String>), PrepareError> {
        let mut doc = skeleton(schema);
        merge_init(&mut doc, given);
        let mut added = Vec::new();
        for after in [true, false] {
            for leaf in schema.leaves() {
                if let Leaf::Field { path, field } = leaf
                    && field.default_after_setters() == after
                    && !has_path(&doc, &path)
                {
                    self.apply_default(&mut doc, &path, field, true)?;
                    if has_path(&doc, &path) {
                        added.push(path);
                    }
                }
            }
        }
        Ok((doc, added))
    }

    /// Hydrates a stored top-level document (or a document array element): literal defaults
    /// into the skeleton, the stored values over them, then function defaults. Returns the
    /// document and the default paths in the order Mongoose marks them (paths inside single
    /// nested sub-documents included).
    pub fn hydrate(
        &mut self,
        schema: &Schema,
        stored: &Document,
    ) -> Result<(Document, Vec<String>), PrepareError> {
        self.deeper(|caster| caster.hydrate_here(schema, stored))
    }

    fn hydrate_here(
        &mut self,
        schema: &Schema,
        stored: &Document,
    ) -> Result<(Document, Vec<String>), PrepareError> {
        let mut defaults: Vec<String> = Vec::new();
        let mut doc = skeleton(schema);
        let leaves = schema.leaves();
        for leaf in &leaves {
            if let Leaf::Field { path, field } = leaf
                && !field.default_after_setters()
                && self.default_if_missing(&mut doc, path, field, stored)?
            {
                defaults.push(path.clone());
            }
        }
        merge_init(&mut doc, stored);
        // Single nested sub-documents hydrate themselves and report their defaults upwards.
        for leaf in &leaves {
            if let Leaf::Field {
                path,
                field:
                    Field {
                        kind: Kind::Subdocument(sub),
                        ..
                    },
            } = leaf
                && let Some(Bson::Document(given)) = get_path(&doc, path)
                    .cloned()
                    .filter(|_| has_path(stored, path))
            {
                let (hydrated, added) = self.init_subdocument_tracked(sub, &given)?;
                defaults.extend(added.into_iter().map(|inner| format!("{path}.{inner}")));
                set_path(&mut doc, path, Bson::Document(hydrated));
            }
            if let Leaf::Field {
                path,
                field:
                    Field {
                        kind: Kind::DocumentArray(sub),
                        ..
                    },
            } = leaf
                && let Some(Bson::Array(items)) = get_path(&doc, path)
                    .cloned()
                    .filter(|_| has_path(stored, path))
            {
                let hydrated: Vec<Bson> = items
                    .into_iter()
                    .map(|item| match item {
                        // Array elements hydrate like a top-level document (literal
                        // defaults before the stored keys); their defaults are not reported.
                        Bson::Document(given) => self
                            .hydrate(sub, &given)
                            .map(|(doc, _)| Bson::Document(doc)),
                        other => Ok(other),
                    })
                    .collect::<Result<_, _>>()?;
                set_path(&mut doc, path, Bson::Array(hydrated));
            }
        }
        for leaf in &leaves {
            if let Leaf::Field { path, field } = leaf
                && field.default_after_setters()
                && self.default_if_missing(&mut doc, path, field, stored)?
            {
                defaults.push(path.clone());
            }
        }
        Ok((doc, defaults))
    }

    fn default_if_missing(
        &mut self,
        doc: &mut Document,
        path: &str,
        field: &Field,
        stored: &Document,
    ) -> Result<bool, PrepareError> {
        if has_path(stored, path) || has_path(doc, path) {
            return Ok(false);
        }
        self.apply_default(doc, path, field, false)?;
        Ok(has_path(doc, path))
    }

    /// Casts a value for a resolved path the way Mongoose's setters and casters do here: `trim`
    /// on strings, sub-documents built with their defaults and `_id`, arrays element by element.
    pub fn cast_value(
        &mut self,
        target: Target,
        value: Bson,
        path: &str,
    ) -> Result<Bson, PrepareError> {
        Ok(match (target.kind, value) {
            (_, Bson::Null) => Bson::Null,
            (TargetKind::Value, Bson::String(text)) if target.trim => {
                Bson::String(dima_text::trim(&text).to_owned())
            }
            (TargetKind::Subdocument(schema), Bson::Document(given)) => {
                Bson::Document(self.construct(schema, Some(&given), "")?)
            }
            (TargetKind::Subdocument(_), _) => {
                return Err(PrepareError::ObjectExpected {
                    path: path.to_owned(),
                });
            }
            (TargetKind::DocumentArray(schema), Bson::Array(items)) => Bson::Array(
                items
                    .into_iter()
                    .map(|item| self.cast_element(schema, item, path, false))
                    .collect::<Result<_, _>>()?,
            ),
            (TargetKind::DocumentArray(schema), Bson::Document(given)) => {
                Bson::Array(vec![Bson::Document(self.construct(
                    schema,
                    Some(&given),
                    "",
                )?)])
            }
            (TargetKind::Array, Bson::Array(items)) => Bson::Array(
                items
                    .into_iter()
                    .map(|item| trim_if(item, target.trim))
                    .collect(),
            ),
            (TargetKind::Array, other) if !matches!(other, Bson::Document(_)) => {
                Bson::Array(vec![trim_if(other, target.trim)])
            }
            (_, other) => other,
        })
    }

    /// One element pushed onto an array path (`$push`, `$addToSet`, save `push`).
    pub fn cast_array_element(
        &mut self,
        target: Target,
        value: Bson,
        _path: &str,
    ) -> Result<Bson, PrepareError> {
        Ok(match (target.kind, value) {
            (TargetKind::DocumentArray(schema), Bson::Document(given)) => {
                Bson::Document(self.construct(schema, Some(&given), "")?)
            }
            (TargetKind::Array, other) => trim_if(other, target.trim),
            (_, other) => other,
        })
    }
}

fn trim_if(value: Bson, trim: bool) -> Bson {
    match value {
        Bson::String(text) if trim => Bson::String(dima_text::trim(&text).to_owned()),
        other => other,
    }
}

fn children_have_defaults(fields: &[Field]) -> bool {
    fields.iter().any(|f| match f.kind {
        Kind::Nested(children) => children_have_defaults(children),
        _ => f.default.is_some(),
    })
}

fn is_special_key(schema: &Schema, key: &str) -> bool {
    (key == "_id" && schema.has_auto_id())
        || schema.created_at() == Some(key)
        || schema.updated_at() == Some(key)
        || schema.version_key == Some(key)
}

/// `getKeysInSchemaOrder`: with more than one key, the schema's keys present in `given` (in
/// schema order), then the others in their order; a single key as it is.
fn keys_in_schema_order(schema: &Schema, given: &Document) -> Vec<String> {
    keys_in_order(schema.tree_keys().into_iter(), given)
}

fn keys_in_order<'a>(schema_keys: impl Iterator<Item = &'a str>, given: &Document) -> Vec<String> {
    if given.len() <= 1 {
        return given.keys().cloned().collect();
    }
    let mut keys: Vec<String> = schema_keys
        .filter(|k| given.contains_key(*k))
        .map(str::to_owned)
        .collect();
    for key in given.keys() {
        if !keys.contains(key) {
            keys.push(key.clone());
        }
    }
    keys
}

/// The document with `order` keys first (those present), then the rest as they were.
pub(crate) fn reorder(mut doc: Document, order: &[&str]) -> Document {
    let mut out = Document::new();
    for key in order {
        if let Some(value) = doc.remove(*key) {
            out.insert(*key, value);
        }
    }
    for (key, value) in doc {
        out.insert(key, value);
    }
    out
}

/// The `$__buildDoc` skeleton: empty parent objects for nested paths.
fn skeleton(schema: &Schema) -> Document {
    let mut doc = Document::new();
    for leaf in schema.leaves() {
        if let Leaf::Field { path, .. } = leaf {
            let pieces: Vec<&str> = path.split('.').collect();
            if let Some((_, parents)) = pieces.split_last() {
                ensure_parents(&mut doc, parents);
            }
        }
    }
    doc
}

fn ensure_parents(doc: &mut Document, parents: &[&str]) {
    let mut cursor = doc;
    for piece in parents {
        if !matches!(cursor.get(*piece), Some(Bson::Document(_))) {
            if cursor.contains_key(*piece) {
                return;
            }
            cursor.insert(*piece, Document::new());
        }
        match cursor.get_mut(*piece) {
            Some(Bson::Document(inner)) => cursor = inner,
            _ => return,
        }
    }
}

/// `init`: stored values merged into the skeleton (objects merged key by key, keeping the
/// skeleton's position for keys it already has).
fn merge_init(doc: &mut Document, stored: &Document) {
    for (key, value) in stored {
        match (doc.get_mut(key), value) {
            (Some(Bson::Document(existing)), Bson::Document(inner)) => merge_init(existing, inner),
            _ => {
                doc.insert(key.clone(), value.clone());
            }
        }
    }
}

/// The value at a dotted path, descending into documents only.
pub(crate) fn get_path<'a>(doc: &'a Document, path: &str) -> Option<&'a Bson> {
    let mut pieces = path.split('.');
    let first = pieces.next()?;
    let mut current = doc.get(first)?;
    for piece in pieces {
        current = match current {
            Bson::Document(inner) => inner.get(piece)?,
            Bson::Array(items) => items.get(piece.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

/// [`get_path`], mutably.
pub(crate) fn get_path_mut<'a>(doc: &'a mut Document, path: &str) -> Option<&'a mut Bson> {
    let mut pieces = path.split('.');
    let first = pieces.next()?;
    let mut current = doc.get_mut(first)?;
    for piece in pieces {
        current = match current {
            Bson::Document(inner) => inner.get_mut(piece)?,
            Bson::Array(items) => items.get_mut(piece.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

pub(crate) fn has_path(doc: &Document, path: &str) -> bool {
    get_path(doc, path).is_some()
}

/// Sets a dotted path, creating missing parent documents. Returns `false` when a parent is
/// not a document (or an array index out of range).
pub(crate) fn set_path(doc: &mut Document, path: &str, value: Bson) -> bool {
    let pieces: Vec<&str> = path.split('.').collect();
    let Some((last, parents)) = pieces.split_last() else {
        return false;
    };
    let mut cursor = Container::Doc(doc);
    for piece in parents {
        cursor = match cursor {
            Container::Doc(d) => {
                if !d.contains_key(*piece) {
                    d.insert(*piece, Document::new());
                }
                match d.get_mut(*piece) {
                    Some(Bson::Document(inner)) => Container::Doc(inner),
                    Some(Bson::Array(items)) => Container::Arr(items),
                    _ => return false,
                }
            }
            Container::Arr(items) => {
                let Some(item) = piece.parse::<usize>().ok().and_then(|i| items.get_mut(i)) else {
                    return false;
                };
                match item {
                    Bson::Document(inner) => Container::Doc(inner),
                    Bson::Array(inner) => Container::Arr(inner),
                    _ => return false,
                }
            }
        };
    }
    match cursor {
        Container::Doc(d) => {
            d.insert(*last, value);
            true
        }
        Container::Arr(items) => match last.parse::<usize>().ok().and_then(|i| items.get_mut(i)) {
            Some(slot) => {
                *slot = value;
                true
            }
            None => false,
        },
    }
}

/// Removes a dotted path; `true` when something was removed.
pub(crate) fn remove_path(doc: &mut Document, path: &str) -> bool {
    match path.split_once('.') {
        None => doc.remove(path).is_some(),
        Some((head, rest)) => match doc.get_mut(head) {
            Some(Bson::Document(inner)) => remove_path(inner, rest),
            Some(Bson::Array(items)) => match rest.split_once('.') {
                Some((index, deeper)) => {
                    match index.parse::<usize>().ok().and_then(|i| items.get_mut(i)) {
                        Some(Bson::Document(inner)) => remove_path(inner, deeper),
                        _ => false,
                    }
                }
                None => false,
            },
            _ => false,
        },
    }
}

enum Container<'a> {
    Doc(&'a mut Document),
    Arr(&'a mut Vec<Bson>),
}

/// Mongoose `minimize` on a document being written: empty objects are removed recursively; an
/// object inside an array is minimized but kept even when it ends up empty; arrays and `Map`
/// fields are kept as they are.
pub(crate) fn minimize(schema: &Schema, doc: &mut Document) {
    if !schema.minimize {
        return;
    }
    minimize_with_fields(Some(schema.fields), doc);
}

fn minimize_with_fields(fields: Option<&'static [Field]>, doc: &mut Document) {
    let keys: Vec<String> = doc.keys().cloned().collect();
    for key in keys {
        let field = fields.and_then(|fs| fs.iter().find(|f| f.name == key));
        if field.is_some_and(|f| matches!(f.kind, Kind::Map)) {
            continue;
        }
        let child_fields = field.and_then(|f| match f.kind {
            Kind::Nested(children) => Some(children),
            Kind::Subdocument(schema) | Kind::DocumentArray(schema) => Some(schema.fields),
            _ => None,
        });
        let remove = match doc.get_mut(&key) {
            Some(Bson::Document(inner)) => {
                minimize_with_fields(child_fields, inner);
                inner.is_empty()
            }
            Some(Bson::Array(items)) => {
                minimize_array(child_fields, items);
                false
            }
            _ => false,
        };
        if remove {
            doc.remove(&key);
        }
    }
}

fn minimize_array(fields: Option<&'static [Field]>, items: &mut [Bson]) {
    for item in items {
        match item {
            Bson::Document(inner) => minimize_with_fields(fields, inner),
            Bson::Array(inner) => minimize_array(fields, inner),
            _ => {}
        }
    }
}

/// JavaScript truthiness of a BSON value.
pub(crate) fn truthy(value: &Bson) -> bool {
    match value {
        Bson::Null | Bson::Undefined => false,
        Bson::Boolean(v) => *v,
        Bson::Int32(v) => *v != 0,
        Bson::Int64(v) => *v != 0,
        Bson::Double(v) => *v != 0.0 && !v.is_nan(),
        Bson::String(v) => !v.is_empty(),
        _ => true,
    }
}

/// Mongoose's `deepEqual` over values as JavaScript sees them: numbers by value whatever their
/// BSON width, dates by time, documents by keys in any order.
pub(crate) fn deep_equal(a: &Bson, b: &Bson) -> bool {
    use crate::mongo::number::read_number;
    match (a, b) {
        (Bson::Document(x), Bson::Document(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| deep_equal(v, w)))
        }
        (Bson::Array(x), Bson::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(v, w)| deep_equal(v, w))
        }
        (
            Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_),
            Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_),
        ) => read_number(a) == read_number(b),
        _ => a == b,
    }
}
