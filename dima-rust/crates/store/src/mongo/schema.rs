//! The per-collection description the write helpers work from: the parts of a Mongoose schema
//! that change what Mongoose writes.
//!
//! Declare one [`Schema`] per collection as a `static`, listing the fields **in the order the
//! TypeScript schema declares them** (the order decides where defaults land in a new document).
//! Only what changes the bytes Mongoose sends is described: field shape and value type (the
//! type decides how filter values are cast, see [`crate::mongo::filter`]), defaults, `trim`,
//! `immutable`, `_id`, timestamps, version key and `minimize`. Validators, enums, `required`
//! and indexes are the model's business. The production schemas use no other setters
//! (`lowercase`, custom `set:`) and no sub-schema timestamps; those are not supported.
//!
//! ```
//! use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
//!
//! static ACCOUNT: Schema = Schema::subdocument(&[
//!     Field::string("type").default(D::Str("twitch")),
//!     Field::string("id").default(D::Null),
//! ]);
//! static USERS: Schema = Schema::new(&[
//!     Field::string("name").trim(),
//!     Field::string("plan_tier").default(D::Str("free")),
//!     Field::document_array("accounts", &ACCOUNT),
//!     Field::date("lastSeen").default_fn(D::Now),
//! ])
//! .timestamps(Timestamps::SNAKE);
//! ```

use bson::Bson;

/// A collection (or sub-document) schema.
#[derive(Clone, Copy, Debug)]
pub struct Schema {
    /// Fields in declaration order.
    pub fields: &'static [Field],
    /// How `_id` is produced.
    pub id: IdField,
    /// Mongoose `timestamps` field names, if the option is on (top-level schemas only).
    pub timestamps: Option<Timestamps>,
    /// The version key (`__v`), or `None` for `versionKey: false`.
    pub version_key: Option<&'static str>,
    /// Mongoose `minimize` (default `true`; off for `custom_widgets`, `custom_widget_store`,
    /// `site_agent_changes`).
    pub minimize: bool,
}

impl Schema {
    /// A top-level schema with Mongoose's defaults: auto ObjectId `_id`, version key `__v`,
    /// `minimize`, no timestamps.
    pub const fn new(fields: &'static [Field]) -> Self {
        Self {
            fields,
            id: IdField::Auto,
            timestamps: None,
            version_key: Some("__v"),
            minimize: true,
        }
    }

    /// A sub-schema (single nested or document array) with an auto ObjectId `_id`; chain
    /// [`Schema::no_id`] for `{ _id: false }`.
    pub const fn subdocument(fields: &'static [Field]) -> Self {
        Self {
            fields,
            id: IdField::Auto,
            timestamps: None,
            version_key: None,
            minimize: true,
        }
    }

    /// Sets the timestamp field names.
    pub const fn timestamps(mut self, timestamps: Timestamps) -> Self {
        self.timestamps = Some(timestamps);
        self
    }

    /// `versionKey: false`.
    pub const fn no_version_key(mut self) -> Self {
        self.version_key = None;
        self
    }

    /// `_id` is declared among the fields (the string-id collections).
    pub const fn declared_id(mut self) -> Self {
        self.id = IdField::Declared;
        self
    }

    /// `{ _id: false }`.
    pub const fn no_id(mut self) -> Self {
        self.id = IdField::None;
        self
    }

    /// `minimize: false`.
    pub const fn no_minimize(mut self) -> Self {
        self.minimize = false;
        self
    }

    pub(crate) fn created_at(&self) -> Option<&'static str> {
        self.timestamps.and_then(|t| t.created_at)
    }

    pub(crate) fn updated_at(&self) -> Option<&'static str> {
        self.timestamps.and_then(|t| t.updated_at)
    }

    pub(crate) fn has_auto_id(&self) -> bool {
        self.id == IdField::Auto
    }

    /// Top-level keys in schema tree order: the fields, then the auto `_id`, the timestamps and
    /// the version key (Mongoose adds them in that order).
    pub(crate) fn tree_keys(&self) -> Vec<&'static str> {
        let mut keys: Vec<&'static str> = self.fields.iter().map(|f| f.name).collect();
        let mut push = |key: &'static str| {
            if !keys.contains(&key) {
                keys.push(key);
            }
        };
        if self.has_auto_id() {
            push("_id");
        }
        if let Some(name) = self.created_at() {
            push(name);
        }
        if let Some(name) = self.updated_at() {
            push(name);
        }
        if let Some(name) = self.version_key {
            push(name);
        }
        keys
    }

    /// Every schema path (nested objects flattened, sub-documents and arrays as one path), in
    /// Mongoose's path order, with the field that holds it. The auto `_id` is reported as
    /// [`Leaf::AutoId`] after the fields.
    pub(crate) fn leaves(&self) -> Vec<Leaf> {
        let mut out = Vec::new();
        collect_leaves(self.fields, "", &mut out);
        if self.has_auto_id() {
            out.push(Leaf::AutoId);
        }
        out
    }
}

fn collect_leaves(fields: &'static [Field], prefix: &str, out: &mut Vec<Leaf>) {
    for field in fields {
        let path = format!("{prefix}{}", field.name);
        match field.kind {
            Kind::Nested(children) => collect_leaves(children, &format!("{path}."), out),
            _ => out.push(Leaf::Field { path, field }),
        }
    }
}

/// One schema path.
#[derive(Clone, Debug)]
pub(crate) enum Leaf {
    /// A declared field (never a nested object: those are flattened).
    Field { path: String, field: &'static Field },
    /// The automatic ObjectId `_id`.
    AutoId,
}

/// How `_id` is produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdField {
    /// Mongoose adds an ObjectId `_id` after the declared fields and generates it on insert.
    Auto,
    /// `_id` is one of the declared fields (no generation).
    Declared,
    /// `{ _id: false }` sub-documents.
    None,
}

/// Timestamp field names (`timestamps: true` or `{ createdAt, updatedAt }`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timestamps {
    /// The creation field, immutable once written.
    pub created_at: Option<&'static str>,
    /// The update field.
    pub updated_at: Option<&'static str>,
}

impl Timestamps {
    /// `timestamps: true`.
    pub const CAMEL: Self = Self {
        created_at: Some("createdAt"),
        updated_at: Some("updatedAt"),
    };
    /// `timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }` (13 collections).
    pub const SNAKE: Self = Self {
        created_at: Some("created_at"),
        updated_at: Some("updated_at"),
    };
}

/// A schema field.
#[derive(Clone, Copy, Debug)]
pub struct Field {
    /// The key (no dots: nested objects are [`Kind::Nested`]).
    pub name: &'static str,
    /// The shape.
    pub kind: Kind,
    /// The default, if any.
    pub default: Option<FieldDefault>,
    /// `trim: true` (a string value, or each string element of an array, is trimmed with
    /// JavaScript's whitespace set).
    pub trim: bool,
    /// `immutable: true`.
    pub immutable: bool,
}

impl Field {
    const fn with_kind(name: &'static str, kind: Kind) -> Self {
        Self {
            name,
            kind,
            default: None,
            trim: false,
            immutable: false,
        }
    }

    /// A single value of type `ty`. The type decides how filter values are cast
    /// ([`crate::mongo::filter`]); the shorthands below say the same thing.
    pub const fn value(name: &'static str, ty: ValueType) -> Self {
        Self::with_kind(name, Kind::Value(ty))
    }

    /// `String`.
    pub const fn string(name: &'static str) -> Self {
        Self::value(name, ValueType::String)
    }

    /// `Number`.
    pub const fn number(name: &'static str) -> Self {
        Self::value(name, ValueType::Number)
    }

    /// `Date`.
    pub const fn date(name: &'static str) -> Self {
        Self::value(name, ValueType::Date)
    }

    /// `Boolean`.
    pub const fn boolean(name: &'static str) -> Self {
        Self::value(name, ValueType::Boolean)
    }

    /// `Schema.Types.ObjectId`.
    pub const fn object_id(name: &'static str) -> Self {
        Self::value(name, ValueType::ObjectId)
    }

    /// `Schema.Types.Mixed`: anything, stored as given.
    pub const fn mixed(name: &'static str) -> Self {
        Self::with_kind(name, Kind::Mixed)
    }

    /// A plain nested object (`{ a: String, b: { c: Number } }` in the TypeScript schema).
    pub const fn nested(name: &'static str, fields: &'static [Field]) -> Self {
        Self::with_kind(name, Kind::Nested(fields))
    }

    /// An array of values of type `ty` (`[String]`), with Mongoose's implicit `[]` default.
    pub const fn array(name: &'static str, ty: ValueType) -> Self {
        Self::with_kind(name, Kind::Array(ty)).default(DefaultValue::EmptyArray)
    }

    /// An array of anything (`{ type: Array }`, `[Mixed]`), with the implicit `[]` default.
    pub const fn mixed_array(name: &'static str) -> Self {
        Self::with_kind(name, Kind::MixedArray).default(DefaultValue::EmptyArray)
    }

    /// An array of sub-documents, with the implicit `[]` default.
    pub const fn document_array(name: &'static str, schema: &'static Schema) -> Self {
        Self::with_kind(name, Kind::DocumentArray(schema)).default_fn(DefaultValue::EmptyArray)
    }

    /// A single nested sub-document (`{ type: SubSchema }`).
    pub const fn subdocument(name: &'static str, schema: &'static Schema) -> Self {
        Self::with_kind(name, Kind::Subdocument(schema))
    }

    /// A `Map` (`{ type: Map, of: String }`, `{ type: Map, of: SubSchema }`): a document whose
    /// keys the caller chooses, each value of the kind `of` says. Keys may not contain `.` or
    /// start with `$` ([`crate::mongo::PrepareError::InvalidMapKey`]).
    pub const fn map(name: &'static str, of: MapOf) -> Self {
        Self::with_kind(name, Kind::Map(of))
    }

    /// A literal default (`default: 'x'`, `default: null`, `default: []`).
    pub const fn default(mut self, value: DefaultValue) -> Self {
        self.default = Some(FieldDefault {
            value,
            function: false,
        });
        self
    }

    /// A function default (`default: Date.now`, `default: () => new Date(0)`).
    pub const fn default_fn(mut self, value: DefaultValue) -> Self {
        self.default = Some(FieldDefault {
            value,
            function: true,
        });
        self
    }

    /// No default at all (`default: undefined` on an array).
    pub const fn no_default(mut self) -> Self {
        self.default = None;
        self
    }

    /// `trim: true`.
    pub const fn trim(mut self) -> Self {
        self.trim = true;
        self
    }

    /// `immutable: true`.
    pub const fn immutable(mut self) -> Self {
        self.immutable = true;
        self
    }

    /// Whether Mongoose applies this default after the document's given values are set (a
    /// function default) rather than before (a literal). Mongoose turns `{}` and `[]` literals
    /// on Mixed paths into functions and always wraps document-array defaults in one.
    pub(crate) fn default_after_setters(&self) -> bool {
        let Some(default) = self.default else {
            return false;
        };
        match (self.kind, default.value) {
            (Kind::DocumentArray(_), _) => true,
            (Kind::Mixed, DefaultValue::EmptyArray | DefaultValue::EmptyDocument) => true,
            (_, DefaultValue::Now | DefaultValue::NowMillis) => true,
            _ => default.function,
        }
    }
}

/// The type of a single value path (Mongoose's schema type).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValueType {
    /// `String`.
    String,
    /// `Number`.
    Number,
    /// `Date`.
    Date,
    /// `Boolean`.
    Boolean,
    /// `Schema.Types.ObjectId`.
    ObjectId,
}

/// A field's shape.
#[derive(Clone, Copy, Debug)]
pub enum Kind {
    /// A single value.
    Value(ValueType),
    /// `Mixed`: no casting below it.
    Mixed,
    /// A plain nested object.
    Nested(&'static [Field]),
    /// An array of values.
    Array(ValueType),
    /// An array of `Mixed` values (an array pushed onto it is one element, not `$each`).
    MixedArray,
    /// An array of sub-documents.
    DocumentArray(&'static Schema),
    /// A single nested sub-document.
    Subdocument(&'static Schema),
    /// A `Map` (stored as a document; never minimized).
    Map(MapOf),
}

/// What the values of a `Map` are.
#[derive(Clone, Copy, Debug)]
pub enum MapOf {
    /// Single values of one type (`of: String`, `of: Number`).
    Values(ValueType),
    /// Anything (`of: Mixed`, or no `of`).
    Mixed,
    /// Sub-documents (`of: new Schema({...})`): each value is built like a sub-document, with
    /// its defaults, its `_id` unless the sub-schema has `{ _id: false }`, unknown keys dropped.
    Subdocuments(&'static Schema),
}

/// A default and whether it is a function in the TypeScript schema.
#[derive(Clone, Copy, Debug)]
pub struct FieldDefault {
    /// The value.
    pub value: DefaultValue,
    /// `true` for `default: () => …` / `Date.now`; `false` for a literal.
    pub function: bool,
}

/// A default value.
#[derive(Clone, Copy, Debug)]
pub enum DefaultValue {
    /// `null`.
    Null,
    /// A boolean.
    Bool(bool),
    /// An integral number in the int32 range.
    Int(i32),
    /// Any other number.
    Double(f64),
    /// A string.
    Str(&'static str),
    /// A date (epoch milliseconds), e.g. `() => new Date(0)`.
    DateMs(i64),
    /// `[]`.
    EmptyArray,
    /// `{}`.
    EmptyDocument,
    /// An array of strings.
    Strings(&'static [&'static str]),
    /// `Date.now` on a `Date` path: the write time as a date.
    Now,
    /// `Date.now` on a `Number` path: the write time as epoch milliseconds.
    NowMillis,
    /// Built at write time from the time (epoch milliseconds); for object defaults and anything
    /// else not covered above.
    With(fn(i64) -> Bson),
}

impl DefaultValue {
    /// The value at `now_ms`.
    pub fn build(self, now_ms: i64) -> Bson {
        match self {
            Self::Null => Bson::Null,
            Self::Bool(v) => Bson::Boolean(v),
            Self::Int(v) => Bson::Int32(v),
            Self::Double(v) => crate::mongo::number::js_number(v),
            Self::Str(v) => Bson::String(v.to_owned()),
            Self::DateMs(ms) => Bson::DateTime(bson::DateTime::from_millis(ms)),
            Self::EmptyArray => Bson::Array(Vec::new()),
            Self::EmptyDocument => Bson::Document(bson::Document::new()),
            Self::Strings(items) => Bson::Array(
                items
                    .iter()
                    .map(|s| Bson::String((*s).to_owned()))
                    .collect(),
            ),
            Self::Now => Bson::DateTime(bson::DateTime::from_millis(now_ms)),
            Self::NowMillis => crate::mongo::number::js_int(now_ms),
            Self::With(build) => build(now_ms),
        }
    }
}

/// What a dotted path points at.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Target {
    pub kind: TargetKind,
    pub trim: bool,
    pub immutable: bool,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum TargetKind {
    /// A single value (also one element of an array of values, a map value, `_id`, the
    /// timestamps and the version key).
    Value(ValueType),
    /// Mixed, or anything below it: no casting.
    Free,
    /// A plain nested object.
    Nested(&'static [Field]),
    /// An array of values.
    Array(ValueType),
    /// An array of Mixed values.
    MixedArray,
    /// An array of sub-documents.
    DocumentArray(&'static Schema),
    /// A single nested sub-document, or one element of a document array.
    Subdocument(&'static Schema),
    /// A Map.
    Map(MapOf),
}

impl Target {
    pub(crate) fn of_field(field: &Field) -> Self {
        let kind = match field.kind {
            Kind::Value(ty) => TargetKind::Value(ty),
            Kind::Mixed => TargetKind::Free,
            Kind::Nested(fields) => TargetKind::Nested(fields),
            Kind::Array(ty) => TargetKind::Array(ty),
            Kind::MixedArray => TargetKind::MixedArray,
            Kind::DocumentArray(schema) => TargetKind::DocumentArray(schema),
            Kind::Subdocument(schema) => TargetKind::Subdocument(schema),
            Kind::Map(of) => TargetKind::Map(of),
        };
        Self {
            kind,
            trim: field.trim,
            immutable: field.immutable,
        }
    }

    /// A target of `kind` with no setters.
    pub(crate) fn of_kind(kind: TargetKind) -> Self {
        Self::plain(kind)
    }

    fn plain(kind: TargetKind) -> Self {
        Self {
            kind,
            trim: false,
            immutable: false,
        }
    }
}

/// `true` for an array index or a positional operator (`0`, `$`, `$[]`, `$[name]`).
pub(crate) fn is_position(segment: &str) -> bool {
    (!segment.is_empty() && segment.bytes().all(|b| b.is_ascii_digit()))
        || segment == "$"
        || (segment.starts_with("$[") && segment.ends_with(']'))
}

/// Resolves a dotted update path against `schema`; `None` when Mongoose's strict mode would
/// drop it.
pub(crate) fn resolve(schema: &Schema, path: &str) -> Option<Target> {
    let segments: Vec<&str> = path.split('.').collect();
    resolve_in_schema(schema, &segments)
}

fn resolve_in_schema(schema: &Schema, segments: &[&str]) -> Option<Target> {
    let (first, rest) = segments.split_first()?;
    if let Some(field) = schema.fields.iter().find(|f| f.name == *first) {
        return resolve_field(field, rest);
    }
    if !rest.is_empty() {
        return None;
    }
    if *first == "_id" && schema.has_auto_id() {
        return Some(Target::plain(TargetKind::Value(ValueType::ObjectId)));
    }
    if schema.updated_at() == Some(*first) {
        return Some(Target::plain(TargetKind::Value(ValueType::Date)));
    }
    if schema.version_key == Some(*first) {
        return Some(Target::plain(TargetKind::Value(ValueType::Number)));
    }
    if schema.created_at() == Some(*first) {
        return Some(Target {
            kind: TargetKind::Value(ValueType::Date),
            trim: false,
            immutable: true,
        });
    }
    None
}

fn resolve_in_fields(fields: &'static [Field], segments: &[&str]) -> Option<Target> {
    let (first, rest) = segments.split_first()?;
    let field = fields.iter().find(|f| f.name == *first)?;
    resolve_field(field, rest)
}

fn resolve_field(field: &'static Field, rest: &[&str]) -> Option<Target> {
    if rest.is_empty() {
        return Some(Target::of_field(field));
    }
    match field.kind {
        Kind::Value(_) => None,
        Kind::Mixed => Some(Target::plain(TargetKind::Free)),
        Kind::Nested(children) => resolve_in_fields(children, rest),
        Kind::Subdocument(schema) => resolve_in_schema(schema, rest),
        Kind::DocumentArray(schema) => match rest.split_first() {
            Some((segment, [])) if is_position(segment) => {
                Some(Target::plain(TargetKind::Subdocument(schema)))
            }
            Some((segment, deeper)) if is_position(segment) => resolve_in_schema(schema, deeper),
            _ => resolve_in_schema(schema, rest),
        },
        Kind::Array(ty) => match rest {
            [segment] if is_position(segment) => Some(Target {
                kind: TargetKind::Value(ty),
                trim: field.trim,
                immutable: false,
            }),
            _ => None,
        },
        Kind::MixedArray => Some(Target::plain(TargetKind::Free)),
        // `map.<key>` is one value; below it, a sub-document's paths, or anything (Mongoose
        // sends `vars.a.b` as it is for a map of strings).
        Kind::Map(of) => match (of, rest) {
            (MapOf::Values(ty), [_]) => Some(Target::plain(TargetKind::Value(ty))),
            (MapOf::Subdocuments(schema), [_]) => {
                Some(Target::plain(TargetKind::Subdocument(schema)))
            }
            (MapOf::Subdocuments(schema), [_, deeper @ ..]) => resolve_in_schema(schema, deeper),
            _ => Some(Target::plain(TargetKind::Free)),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static ITEM: Schema = Schema::subdocument(&[
        Field::string("label").trim(),
        Field::number("n").default(DefaultValue::Int(1)),
    ]);
    static TEST: Schema = Schema::new(&[
        Field::string("name").trim(),
        Field::string("key").immutable(),
        Field::array("tags", ValueType::String),
        Field::document_array("items", &ITEM),
        Field::nested(
            "nested",
            &[
                Field::string("a"),
                Field::nested("deep", &[Field::boolean("c")]),
            ],
        ),
        Field::subdocument("opts", &ITEM),
        Field::mixed("meta"),
        Field::map("vars", MapOf::Values(ValueType::String)),
    ])
    .timestamps(Timestamps::CAMEL);

    fn kind(path: &str) -> Option<String> {
        resolve(&TEST, path).map(|t| {
            let debug = format!("{:?}", t.kind);
            let name = debug.split('(').next().unwrap_or_default().to_owned();
            format!("{name}/{}/{}", t.trim, t.immutable)
        })
    }

    #[test]
    fn resolves_paths_like_mongoose() {
        assert!(resolve(&TEST, "name").is_some_and(|t| t.trim));
        assert!(resolve(&TEST, "key").is_some_and(|t| t.immutable));
        assert!(resolve(&TEST, "createdAt").is_some_and(|t| t.immutable));
        assert!(resolve(&TEST, "updatedAt").is_some_and(|t| !t.immutable));
        assert!(resolve(&TEST, "__v").is_some());
        assert!(resolve(&TEST, "_id").is_some());
        assert_eq!(kind("nested").as_deref(), Some("Nested/false/false"));
        assert_eq!(kind("nested.deep.c").as_deref(), Some("Value/false/false"));
        assert!(resolve(&TEST, "nested.zz").is_none());
        assert!(resolve(&TEST, "name.x").is_none());
        assert!(resolve(&TEST, "items.0.label").is_some_and(|t| t.trim));
        assert!(resolve(&TEST, "items.$[el].label").is_some_and(|t| t.trim));
        assert!(resolve(&TEST, "items.$.label").is_some_and(|t| t.trim));
        assert!(resolve(&TEST, "items.label").is_some_and(|t| t.trim));
        assert_eq!(kind("items.0").as_deref(), Some("Subdocument/false/false"));
        assert_eq!(kind("opts.n").as_deref(), Some("Value/false/false"));
        assert_eq!(kind("tags.0").as_deref(), Some("Value/false/false"));
        assert!(resolve(&TEST, "tags.0.x").is_none());
        assert_eq!(kind("meta.any.thing").as_deref(), Some("Free/false/false"));
        assert_eq!(kind("vars.clé 👋").as_deref(), Some("Value/false/false"));
        assert!(resolve(&TEST, "nope").is_none());
        assert!(resolve(&TEST, "").is_none());
    }

    #[test]
    fn leaves_and_tree_order() {
        let leaves: Vec<String> = TEST
            .leaves()
            .into_iter()
            .map(|leaf| match leaf {
                Leaf::Field { path, .. } => path,
                Leaf::AutoId => "_id".into(),
            })
            .collect();
        assert_eq!(
            leaves,
            [
                "name",
                "key",
                "tags",
                "items",
                "nested.a",
                "nested.deep.c",
                "opts",
                "meta",
                "vars",
                "_id"
            ]
        );
        assert_eq!(
            TEST.tree_keys(),
            [
                "name",
                "key",
                "tags",
                "items",
                "nested",
                "opts",
                "meta",
                "vars",
                "_id",
                "createdAt",
                "updatedAt",
                "__v"
            ]
        );
    }

    #[test]
    fn default_timing() {
        assert!(!Field::array("a", ValueType::String).default_after_setters());
        assert!(Field::document_array("d", &ITEM).default_after_setters());
        assert!(
            Field::mixed("m")
                .default(DefaultValue::EmptyDocument)
                .default_after_setters()
        );
        assert!(
            !Field::mixed("m")
                .default(DefaultValue::Str("x"))
                .default_after_setters()
        );
        assert!(
            Field::date("t")
                .default(DefaultValue::Now)
                .default_after_setters()
        );
        assert!(
            !Field::string("s")
                .default(DefaultValue::Str("x"))
                .default_after_setters()
        );
        assert!(
            Field::string("s")
                .default_fn(DefaultValue::DateMs(0))
                .default_after_setters()
        );
        assert!(is_position("0") && is_position("$") && is_position("$[]") && is_position("$[el]"));
        assert!(!is_position("a") && !is_position("") && !is_position("1a"));
    }
}
