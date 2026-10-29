//! Narrow native persistence contracts for application documents. This is not
//! an ODM: application queries use the official MongoDB driver; this core owns
//! schema defaults, casting/validation, save-time timestamps and explicit index
//! installation. Constructors never connect or install indexes implicitly.
use mongodb::{
    Collection, Database, IndexModel,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
    options::{Acknowledgment, CollectionOptions, IndexOptions, WriteConcern},
};
use std::{fmt, time::Duration};

#[derive(Clone, Debug)]
pub enum FieldType {
    String,
    Number,
    Boolean,
    Date,
    ObjectId,
    Mixed,
    Array(Box<FieldType>),
    /// Opt-in array element casting and validators. The boxed field's name is
    /// ignored; errors use the containing array path followed by the index.
    ArrayElement(Box<Field>),
    /// Maps retain empty objects and cast each entry using the declared type.
    Map(Box<FieldType>),
    /// Inline nested paths apply child defaults even when parent is absent.
    Object(Vec<Field>),
    /// Optional single or array subdocuments are materialized only if present.
    Subdocument {
        fields: Vec<Field>,
        generate_id: bool,
    },
}
#[derive(Clone, Debug)]
pub enum FieldDefault {
    Missing,
    Null,
    String(&'static str),
    Number(f64),
    Boolean(bool),
    Array,
    Object,
    /// A reusable BSON template, cloned on every construction before casting.
    Value(Bson),
    Now,
    Epoch,
    LocalDay,
    LocalMonth,
    LocalYear,
}
#[derive(Clone, Debug)]
pub struct Field {
    pub name: &'static str,
    pub kind: FieldType,
    pub default: FieldDefault,
    pub required: bool,
    pub required_when: Option<(&'static str, &'static str)>,
    pub enum_values: &'static [&'static str],
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub max_utf16: Option<usize>,
    pub hidden: bool,
    pub trim: bool,
    pub integer: bool,
    pub immutable: bool,
    /// Opt in to Mongoose-style Mixed value minimization after validation.
    pub minimize: bool,
}
impl Field {
    pub fn new(name: &'static str, kind: FieldType) -> Self {
        Self {
            name,
            kind,
            default: FieldDefault::Missing,
            required: false,
            required_when: None,
            enum_values: &[],
            min: None,
            max: None,
            max_utf16: None,
            hidden: false,
            trim: false,
            integer: false,
            immutable: false,
            minimize: false,
        }
    }
    pub fn default(mut self, default: FieldDefault) -> Self {
        self.default = default;
        self
    }
    pub fn required(mut self) -> Self {
        self.required = true;
        self
    }
    pub fn required_when(mut self, field: &'static str, value: &'static str) -> Self {
        self.required_when = Some((field, value));
        self
    }
    pub fn enumeration(mut self, values: &'static [&'static str]) -> Self {
        self.enum_values = values;
        self
    }
    pub fn min(mut self, value: f64) -> Self {
        self.min = Some(value);
        self
    }
    pub fn max(mut self, value: f64) -> Self {
        self.max = Some(value);
        self
    }
    pub fn max_utf16(mut self, value: usize) -> Self {
        self.max_utf16 = Some(value);
        self
    }
    pub fn hidden(mut self) -> Self {
        self.hidden = true;
        self
    }
    pub fn trim(mut self) -> Self {
        self.trim = true;
        self
    }
    pub fn integer(mut self) -> Self {
        self.integer = true;
        self
    }
    /// Prune empty ordinary objects in a Mixed field when constructing output.
    pub fn minimize(mut self) -> Self {
        self.minimize = true;
        self
    }
    pub fn immutable(mut self) -> Self {
        self.immutable = true;
        self
    }
}
#[derive(Clone, Debug)]
pub struct SchemaIndex {
    pub keys: Document,
    pub unique: bool,
    pub sparse: bool,
    pub ttl: Option<Duration>,
    pub partial: Option<Document>,
}
impl SchemaIndex {
    pub fn new(keys: Document) -> Self {
        Self {
            keys,
            unique: false,
            sparse: false,
            ttl: None,
            partial: None,
        }
    }
    pub fn unique(mut self) -> Self {
        self.unique = true;
        self
    }
    pub fn sparse(mut self) -> Self {
        self.sparse = true;
        self
    }
    pub fn ttl(mut self, seconds: u64) -> Self {
        self.ttl = Some(Duration::from_secs(seconds));
        self
    }
    pub fn partial(mut self, filter: Document) -> Self {
        self.partial = Some(filter);
        self
    }
    pub fn model(&self) -> IndexModel {
        let mut options = IndexOptions::default();
        if self.unique {
            options.unique = Some(true);
        }
        if self.sparse {
            options.sparse = Some(true);
        }
        options.expire_after = self.ttl;
        options.partial_filter_expression = self.partial.clone();
        IndexModel::builder()
            .keys(self.keys.clone())
            .options(options)
            .build()
    }
}
#[derive(Clone, Debug)]
pub struct SchemaDefinition {
    pub model: &'static str,
    pub collection: &'static str,
    pub fields: Vec<Field>,
    pub string_id: bool,
    pub version_key: bool,
    pub write_concern_journaled: bool,
    pub timestamps: Option<(&'static str, &'static str)>,
    /// Only the two source pre-save hooks use these explicit clock fields.
    pub save_clock_field: Option<&'static str>,
    pub indexes: Vec<SchemaIndex>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldError {
    pub path: String,
    pub kind: &'static str,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationErrors(pub Vec<FieldError>);
impl fmt::Display for ValidationErrors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Document validation failed")?;
        for error in &self.0 {
            write!(f, "; {} ({})", error.path, error.kind)?;
        }
        Ok(())
    }
}
impl std::error::Error for ValidationErrors {}
#[derive(Debug)]
pub enum PersistenceError {
    Validation(ValidationErrors),
    Mongo(mongodb::error::Error),
    MissingId,
    NotFound,
}
impl fmt::Display for PersistenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Validation(e) => e.fmt(f),
            Self::Mongo(e) => e.fmt(f),
            Self::MissingId => f.write_str("Document _id is missing"),
            Self::NotFound => f.write_str("Document no longer exists"),
        }
    }
}
impl std::error::Error for PersistenceError {}
impl From<ValidationErrors> for PersistenceError {
    fn from(e: ValidationErrors) -> Self {
        Self::Validation(e)
    }
}
impl From<mongodb::error::Error> for PersistenceError {
    fn from(e: mongodb::error::Error) -> Self {
        Self::Mongo(e)
    }
}
impl SchemaDefinition {
    /// Match new Model(document) + validate, preserving BSON IDs/dates and
    /// null versus missing. Unknown paths are discarded (source strict mode).
    pub fn construct(&self, input: &Document, now: DateTime) -> Result<Document, ValidationErrors> {
        // Schema definitions (including nested descriptors) are shared; clone
        // only input BSON, never the descriptor tree on each construction.
        let mut fields = Vec::with_capacity(4);
        if !self.string_id {
            fields.push(Field::new("_id", FieldType::ObjectId));
        }
        if self.version_key {
            fields.push(Field::new("__v", FieldType::Number));
        }
        if let Some((created, updated)) = self.timestamps {
            fields.push(Field::new(created, FieldType::Date));
            fields.push(Field::new(updated, FieldType::Date));
        }
        let mut errors = Vec::new();
        let mut output = construct_fields(&self.fields, input, now, "", &mut errors);
        output.extend(construct_fields(&fields, input, now, "", &mut errors));
        if !self.string_id && !input.contains_key("_id") {
            output.insert("_id", ObjectId::new());
        }
        if errors.is_empty() {
            Ok(output)
        } else {
            Err(ValidationErrors(errors))
        }
    }
    pub fn prepare_insert(
        &self,
        input: Document,
        now: DateTime,
    ) -> Result<Document, ValidationErrors> {
        let mut output = self.construct(&input, now)?;
        self.apply_save_hooks(&mut output, now, true);
        if self.version_key && !output.contains_key("__v") {
            output.insert("__v", 0);
        }
        Ok(output)
    }
    pub fn prepare_save(
        &self,
        input: Document,
        now: DateTime,
    ) -> Result<Document, ValidationErrors> {
        let mut output = self.construct(&input, now)?;
        self.apply_save_hooks(&mut output, now, false);
        Ok(output)
    }
    /// Native partial save preparation. Immutable setters are ignored before
    /// validation; missing/projection-excluded fields keep their stored values.
    pub fn prepare_save_against(
        &self,
        input: &Document,
        current: &Document,
        now: DateTime,
    ) -> Result<Document, ValidationErrors> {
        let mut merged = current.clone();
        merged.extend(input.clone());
        restore_immutable(&self.fields, &mut merged, current);
        if let Some((created, _)) = self.timestamps {
            restore_value(&mut merged, current, created);
        }
        restore_value(&mut merged, current, "_id");
        self.prepare_save(merged, now)
    }
    pub fn apply_save_hooks(&self, document: &mut Document, now: DateTime, is_new: bool) {
        if let Some((created, updated)) = self.timestamps {
            if is_new
                && document
                    .get(created)
                    .is_none_or(|value| matches!(value, Bson::Null))
            {
                document.insert(created, now);
            }
            let value = if is_new {
                document
                    .get(created)
                    .cloned()
                    .unwrap_or(Bson::DateTime(now))
            } else {
                Bson::DateTime(now)
            };
            document.insert(updated, value);
        }
        if let Some(field) = self.save_clock_field {
            document.insert(field, now);
        }
    }
    pub fn default_projection(&self) -> Document {
        self.fields
            .iter()
            .filter(|field| field.hidden)
            .map(|field| (field.name.to_owned(), Bson::Int32(0)))
            .collect()
    }
    pub fn repository(&'static self, database: &Database) -> SchemaRepository {
        SchemaRepository {
            schema: self,
            collection: self.native_collection(database),
        }
    }
    pub fn native_collection(&self, database: &Database) -> Collection<Document> {
        if self.write_concern_journaled {
            let concern = WriteConcern::builder()
                .w(Acknowledgment::Nodes(1))
                .journal(true)
                .build();
            database.collection_with_options(
                self.collection,
                CollectionOptions::builder().write_concern(concern).build(),
            )
        } else {
            database.collection(self.collection)
        }
    }
    pub async fn install_indexes(&self, database: &Database) -> mongodb::error::Result<()> {
        if !self.indexes.is_empty() {
            self.native_collection(database)
                .create_indexes(self.indexes.iter().map(SchemaIndex::model))
                .await?;
        }
        Ok(())
    }
}
/// Real driver-backed persistence. Explicit methods preserve schema behavior
/// without a TypeScript adapter, callbacks, or hidden connection side effects.
#[derive(Clone)]
pub struct SchemaRepository {
    pub schema: &'static SchemaDefinition,
    pub collection: Collection<Document>,
}
impl SchemaRepository {
    pub async fn insert(
        &self,
        input: Document,
        now: DateTime,
    ) -> Result<Document, PersistenceError> {
        let output = self.schema.prepare_insert(input, now)?;
        // Mongoose saves require an identifier, including schemas with an
        // optional explicit String _id. Do not let the native driver replace
        // an absent string identifier with a generated BSON ObjectId.
        if output.get("_id").is_none_or(|id| matches!(id, Bson::Null)) {
            return Err(PersistenceError::MissingId);
        }
        self.collection.insert_one(&output).await?;
        Ok(output)
    }
    pub async fn save(&self, input: Document, now: DateTime) -> Result<Document, PersistenceError> {
        let id = input
            .get("_id")
            .filter(|id| !matches!(id, Bson::Null))
            .cloned()
            .ok_or(PersistenceError::MissingId)?;
        let current = self
            .collection
            .find_one(doc! {"_id":id.clone()})
            .await?
            .ok_or(PersistenceError::NotFound)?;
        let output = self.schema.prepare_save_against(&input, &current, now)?;
        let mut set = Document::new();
        let mut unset = Document::new();
        // Write only caller-supplied mutable paths and hook clocks. A partial
        // save must not reset defaults or overwrite concurrent unrelated data.
        for key in input.keys() {
            if key == "_id"
                || self
                    .schema
                    .timestamps
                    .is_some_and(|(created, _)| key == created)
            {
                continue;
            }
            let field = self.schema.fields.iter().find(|field| field.name == key);
            if field.is_some_and(|field| field.immutable)
                || field.is_none() && !(key == "__v" && self.schema.version_key)
            {
                continue;
            }
            match output.get(key) {
                Some(value) => {
                    set.insert(key, value.clone());
                }
                None => {
                    unset.insert(key, 1);
                }
            }
        }
        for clock in [
            self.schema.timestamps.map(|(_, updated)| updated),
            self.schema.save_clock_field,
        ]
        .into_iter()
        .flatten()
        {
            if let Some(value) = output.get(clock) {
                set.insert(clock, value.clone());
            }
        }
        let mut update = Document::new();
        if !set.is_empty() {
            update.insert("$set", set);
        }
        if !unset.is_empty() {
            update.insert("$unset", unset);
        }
        if !update.is_empty() {
            let result = self
                .collection
                .update_one(doc! {"_id":id.clone()}, update)
                .await?;
            if result.matched_count == 0 {
                return Err(PersistenceError::NotFound);
            }
        }
        // A save must not reveal query-excluded fields merely because native
        // validation fetched the complete stored record internally. Explicitly
        // supplied hidden fields (new/with-hidden documents) stay selected.
        let mut projection = self.schema.default_projection();
        for key in input.keys() {
            projection.remove(key);
        }
        self.collection
            .find_one(doc! {"_id":id})
            .projection(projection)
            .await?
            .ok_or(PersistenceError::NotFound)
    }
    pub async fn find_one(&self, filter: Document) -> mongodb::error::Result<Option<Document>> {
        self.collection
            .find_one(filter)
            .projection(self.schema.default_projection())
            .await
    }
    pub async fn find_one_with_hidden(
        &self,
        filter: Document,
    ) -> mongodb::error::Result<Option<Document>> {
        self.collection.find_one(filter).await
    }
}

fn restore_value(target: &mut Document, current: &Document, key: &str) {
    if let Some(value) = current.get(key) {
        target.insert(key, value.clone());
    } else {
        target.remove(key);
    }
}
fn restore_immutable(fields: &[Field], target: &mut Document, current: &Document) {
    for field in fields {
        if field.immutable {
            restore_value(target, current, field.name);
            continue;
        }
        if let FieldType::Object(children)
        | FieldType::Subdocument {
            fields: children, ..
        } = &field.kind
            && let (Some(Bson::Document(target)), Some(Bson::Document(current))) =
                (target.get_mut(field.name), current.get(field.name))
        {
            restore_immutable(children, target, current);
        }
    }
}

fn construct_fields(
    fields: &[Field],
    input: &Document,
    now: DateTime,
    prefix: &str,
    errors: &mut Vec<FieldError>,
) -> Document {
    let mut output = Document::new();
    for field in fields {
        let path = if prefix.is_empty() {
            field.name.to_owned()
        } else {
            format!("{prefix}.{}", field.name)
        };
        let required = field.required
            || field
                .required_when
                .is_some_and(|(name, expected)| input.get_str(name).ok() == Some(expected));
        let value = match input.get(field.name) {
            Some(value) => Some(value.clone()),
            None => match &field.default {
                FieldDefault::Missing => match &field.kind {
                    FieldType::Object(children) => {
                        let nested =
                            construct_fields(children, &Document::new(), now, &path, errors);
                        if nested.is_empty() {
                            None
                        } else {
                            Some(Bson::Document(nested))
                        }
                    }
                    _ => None,
                },
                FieldDefault::Null => Some(Bson::Null),
                FieldDefault::String(text) => Some((*text).into()),
                FieldDefault::Number(value) => Some(crate::utils::bson_compat::js_number(*value)),
                FieldDefault::Boolean(value) => Some((*value).into()),
                FieldDefault::Array => Some(Bson::Array(Vec::new())),
                FieldDefault::Now => Some(Bson::DateTime(now)),
                FieldDefault::Object => Some(Bson::Document(Document::new())),
                FieldDefault::Value(value) => Some(value.clone()),
                FieldDefault::Epoch => Some(Bson::DateTime(DateTime::from_millis(0))),
                FieldDefault::LocalDay | FieldDefault::LocalMonth | FieldDefault::LocalYear => {
                    local_calendar(now).map(|(year, month, day)| {
                        Bson::Int32(match &field.default {
                            FieldDefault::LocalDay => day,
                            FieldDefault::LocalMonth => month,
                            _ => year,
                        })
                    })
                }
            },
        };
        let Some(value) = value else {
            if required {
                errors.push(FieldError {
                    path,
                    kind: "required",
                });
            }
            continue;
        };
        let Some(value) = cast_field(field, value, now, &path, errors) else {
            continue;
        };
        validate_field(field, &value, required, &path, errors);
        let value = if field.minimize && matches!(field.kind, FieldType::Mixed) {
            minimize_mixed(value, false)
        } else {
            Some(value)
        };
        let Some(value) = value else { continue };
        if !matches!(&value,Bson::Document(object)if object.is_empty())
            || matches!(&field.kind, FieldType::Map(_))
        {
            output.insert(field.name, value);
        }
    }
    output
}

// Mongoose cloneObject preserves an object immediately beneath an array, even
// when its properties have all been minimized. Arrays and null remain values.
fn minimize_mixed(value: Bson, array_child: bool) -> Option<Bson> {
    match value {
        Bson::Document(document) => {
            let mut result = Document::new();
            for (key, value) in document {
                // Mongoose cloneObject excludes these special property names.
                if matches!(key.as_str(), "__proto__" | "constructor" | "prototype") {
                    continue;
                }
                if let Some(value) = minimize_mixed(value, false) {
                    result.insert(key, value);
                }
            }
            if result.is_empty() && !array_child {
                None
            } else {
                Some(Bson::Document(result))
            }
        }
        Bson::Array(values) => Some(Bson::Array(
            values
                .into_iter()
                .map(|value| {
                    // Array children are always retained by the clone algorithm.
                    minimize_mixed(value, true).expect("array child is retained")
                })
                .collect(),
        )),
        other => Some(other),
    }
}

fn cast_field(
    field: &Field,
    value: Bson,
    now: DateTime,
    path: &str,
    errors: &mut Vec<FieldError>,
) -> Option<Bson> {
    let result = if matches!(value, Bson::Null) {
        Ok(value)
    } else {
        cast(&field.kind, value, now, path, errors)
    };
    let mut value = match result {
        Ok(value) => value,
        Err(()) => {
            errors.push(FieldError {
                path: path.to_owned(),
                kind: "cast",
            });
            return None;
        }
    };
    if field.trim
        && let Bson::String(text) = &mut value
    {
        *text = crate::utils::js_compat::trim(text).into();
    }
    Some(value)
}

fn validate_field(
    field: &Field,
    value: &Bson,
    required: bool,
    path: &str,
    errors: &mut Vec<FieldError>,
) {
    if required
        && (matches!(value, Bson::Null) || matches!(value, Bson::String(text) if text.is_empty()))
    {
        errors.push(FieldError {
            path: path.to_owned(),
            kind: "required",
        });
        return;
    }
    // Mongoose validateSync retains the first failed validator per path.
    let failed = if let Bson::String(text) = value {
        if !field.enum_values.is_empty() && !field.enum_values.contains(&text.as_str()) {
            Some("enum")
        } else if field
            .max_utf16
            .is_some_and(|max| text.encode_utf16().count() > max)
        {
            Some("maxlength")
        } else {
            None
        }
    } else if let Some(value) = number(value) {
        if field.min.is_some_and(|min| value < min) {
            Some("min")
        } else if field.max.is_some_and(|max| value > max) {
            Some("max")
        } else if field.integer && (!value.is_finite() || value.fract() != 0.0) {
            Some("user defined")
        } else {
            None
        }
    } else {
        None
    };
    if let Some(kind) = failed {
        errors.push(FieldError {
            path: path.to_owned(),
            kind,
        });
    }
}

#[cfg(unix)]
fn local_calendar(now: DateTime) -> Option<(i32, i32, i32)> {
    let seconds = now.timestamp_millis().div_euclid(1000) as _;
    let mut local: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&seconds, &mut local) }.is_null() {
        return None;
    }
    Some((local.tm_year + 1900, local.tm_mon + 1, local.tm_mday))
}
#[cfg(not(unix))]
fn local_calendar(_now: DateTime) -> Option<(i32, i32, i32)> {
    None
}
fn number(value: &Bson) -> Option<f64> {
    match value {
        Bson::Int32(value) => Some(f64::from(*value)),
        Bson::Int64(value) => Some(*value as f64),
        Bson::Double(value) => Some(*value),
        _ => None,
    }
}
fn js_number_string(number: f64) -> String {
    crate::utils::json_number::number_string(number)
}
fn cast(
    kind: &FieldType,
    value: Bson,
    now: DateTime,
    path: &str,
    errors: &mut Vec<FieldError>,
) -> Result<Bson, ()> {
    match kind {
        FieldType::Mixed => Ok(value),
        FieldType::String => match value {
            Bson::String(_) => Ok(value),
            Bson::Boolean(value) => Ok(value.to_string().into()),
            Bson::ObjectId(value) => Ok(value.to_hex().into()),
            Bson::Document(document) => document
                .get_str("_id")
                .map(|value| Bson::String(value.into()))
                .map_err(|_| ()),
            value => number(&value)
                .map(|value| Bson::String(js_number_string(value)))
                .ok_or(()),
        },
        FieldType::Number => {
            let value = match value {
                Bson::String(text) if text.is_empty() => return Ok(Bson::Null),
                Bson::String(text) => {
                    crate::utils::json_number::to_number(&serde_json::Value::String(text))
                }
                Bson::Boolean(value) => {
                    if value {
                        1.0
                    } else {
                        0.0
                    }
                }
                value => number(&value).ok_or(())?,
            };
            if value.is_nan() {
                Err(())
            } else {
                Ok(crate::utils::bson_compat::js_number(value))
            }
        }
        FieldType::Boolean => match value {
            Bson::Boolean(_) => Ok(value),
            Bson::String(text) => match text.as_str() {
                "true" | "1" | "yes" => Ok(true.into()),
                "false" | "0" | "no" => Ok(false.into()),
                _ => Err(()),
            },
            value => match number(&value) {
                Some(1.0) => Ok(true.into()),
                Some(0.0) => Ok(false.into()),
                _ => Err(()),
            },
        },
        FieldType::ObjectId => match value {
            Bson::ObjectId(_) => Ok(value),
            Bson::String(text) => ObjectId::parse_str(text)
                .map(Bson::ObjectId)
                .map_err(|_| ()),
            Bson::Document(document) => cast(
                kind,
                document.get("_id").cloned().ok_or(())?,
                now,
                path,
                errors,
            ),
            _ => Err(()),
        },
        FieldType::Date => crate::utils::mongoose_date::cast(&value).map_err(|_| ()),
        FieldType::Array(element) => {
            let values = match value {
                Bson::Array(values) => values,
                value => vec![value],
            };
            let mut output = Vec::with_capacity(values.len());
            for (index, value) in values.into_iter().enumerate() {
                let path = format!("{path}.{index}");
                if matches!(value, Bson::Null) {
                    output.push(value);
                } else {
                    match cast(element, value, now, &path, errors) {
                        Ok(value) => output.push(value),
                        Err(()) => {
                            errors.push(FieldError { path, kind: "cast" });
                        }
                    }
                }
            }
            Ok(Bson::Array(output))
        }
        FieldType::ArrayElement(element) => {
            let values = match value {
                Bson::Array(values) => values,
                value => vec![value],
            };
            let mut output = Vec::with_capacity(values.len());
            // Mongoose casts the entire array first, aborting on the first
            // cast failure before running per-element validators.
            for (index, value) in values.into_iter().enumerate() {
                let element_path = format!("{path}.{index}");
                match cast_field(element, value, now, &element_path, errors) {
                    Some(value) => output.push(value),
                    None => return Ok(Bson::Array(Vec::new())),
                }
            }
            for (index, value) in output.iter().enumerate() {
                validate_field(
                    element,
                    value,
                    element.required,
                    &format!("{path}.{index}"),
                    errors,
                );
            }
            Ok(Bson::Array(output))
        }
        FieldType::Map(element) => {
            let Bson::Document(input) = value else {
                return Err(());
            };
            let mut output = Document::new();
            for (key, value) in input {
                if key.starts_with('$')
                    || key.contains('.')
                    || matches!(key.as_str(), "prototype" | "constructor" | "__proto__")
                {
                    return Err(());
                }
                let path = format!("{path}.{key}");
                if matches!(value, Bson::Null) {
                    output.insert(key, value);
                } else {
                    match cast(element, value, now, &path, errors) {
                        Ok(value) => {
                            output.insert(key, value);
                        }
                        Err(()) => errors.push(FieldError { path, kind: "cast" }),
                    }
                }
            }
            Ok(Bson::Document(output))
        }
        FieldType::Object(fields) | FieldType::Subdocument { fields, .. } => {
            let Bson::Document(input) = value else {
                return Err(());
            };
            let mut output = construct_fields(fields, &input, now, path, errors);
            if matches!(
                kind,
                FieldType::Subdocument {
                    generate_id: true,
                    ..
                }
            ) {
                match input.get("_id") {
                    None => {
                        output.insert("_id", ObjectId::new());
                    }
                    Some(Bson::Null) => {
                        output.insert("_id", Bson::Null);
                    }
                    Some(value) => match cast(
                        &FieldType::ObjectId,
                        value.clone(),
                        now,
                        &format!("{path}._id"),
                        errors,
                    ) {
                        Ok(id) => {
                            output.insert("_id", id);
                        }
                        Err(()) => errors.push(FieldError {
                            path: format!("{path}._id"),
                            kind: "cast",
                        }),
                    },
                }
            }
            Ok(Bson::Document(output))
        }
    }
}
