//! Channel TTS settings with explicit caller-owned MongoDB persistence.
//! Construction and index installation never connect implicitly.
use super::{
    Field, FieldDefault as D, FieldType as T, PersistenceError, SchemaDefinition, SchemaIndex,
    SchemaRepository, ValidationErrors, users,
};
use crate::utils::bson_compat::js_number;
use crate::utils::js_string::JsString;
use crate::utils::lossless_json::JsonValue;
use crate::utils::tts::settings::{SettingsError, normalize_channel_tts_settings};
use crate::utils::tts::{DEFAULT_KOKORO_VOICE_ES, expressive_tags};
use crate::utils::tts_defaults::{PIPER_VOICE_EN, PIPER_VOICE_ES};
use mongodb::{
    Database,
    bson::{Bson, DateTime, Document, doc},
};
use std::{fmt, sync::OnceLock};

pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "channel_tts_settings",
        collection: "channel_tts_settings",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        indexes: vec![SchemaIndex::new(doc! {"channelID": 1}).unique()],
        fields: vec![
            Field::new("channelID", T::String).required(),
            Field::new("channel", T::String).default(D::String("")),
            Field::new("enabled", T::Boolean).default(D::Boolean(true)),
            Field::new("provider", T::String)
                .enumeration(&["piper", "fish", "kokoro"])
                .default(D::String("piper")),
            Field::new("defaultLanguage", T::String)
                .enumeration(&["en", "es"])
                .default(D::String("es")),
            Field::new(
                "voices",
                T::Object(vec![
                    Field::new("en", T::String).default(D::String(PIPER_VOICE_EN)),
                    Field::new("es", T::String).default(D::String(PIPER_VOICE_ES)),
                    Field::new("cloneDefault", T::String).default(D::String("gojo")),
                    Field::new("kokoroDefault", T::String)
                        .default(D::String(DEFAULT_KOKORO_VOICE_ES)),
                ]),
            ),
            Field::new(
                "filters",
                T::Object(vec![
                    Field::new("skipEmotes", T::Boolean).default(D::Boolean(true)),
                    Field::new("stripLinks", T::Boolean).default(D::Boolean(true)),
                    Field::new("normalizeWhitespace", T::Boolean).default(D::Boolean(true)),
                    Field::new("maxLength", T::Number).default(D::Number(280.0)),
                    Field::new(
                        "expressiveTags",
                        T::Object(
                            expressive_tags()
                                .map(|tag| Field::new(tag, T::Boolean).default(D::Boolean(true)))
                                .collect(),
                        ),
                    ),
                ]),
            ),
            Field::new(
                "queue",
                T::Object(vec![
                    Field::new("maxItems", T::Number).default(D::Number(5.0)),
                ]),
            ),
        ],
    })
}

/// Construct a concrete repository using the caller's database; no connection
/// or index is created by this function.
pub fn get_channel_tts_settings_model(database: &Database) -> SchemaRepository {
    schema().repository(database)
}

/// A BSON value outside the plain-data contract cannot be silently flattened
/// into JSON: Long objects, dates and ObjectIds have their own JavaScript
/// coercion behavior. Document metadata is never normalized.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BsonBoundaryError {
    pub path: String,
    pub kind: &'static str,
}

impl fmt::Display for BsonBoundaryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Unsupported TTS settings BSON at {} ({})",
            self.path, self.kind
        )
    }
}

impl std::error::Error for BsonBoundaryError {}

#[derive(Debug)]
pub enum ChannelTtsSettingsError {
    Settings(SettingsError),
    Persistence(PersistenceError),
    Mongo(mongodb::error::Error),
    BsonBoundary(BsonBoundaryError),
}

impl fmt::Display for ChannelTtsSettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Settings(error) => error.fmt(f),
            Self::Persistence(error) => error.fmt(f),
            Self::Mongo(error) => error.fmt(f),
            Self::BsonBoundary(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for ChannelTtsSettingsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Settings(error) => error,
            Self::Persistence(error) => error,
            Self::Mongo(error) => error,
            Self::BsonBoundary(error) => error,
        })
    }
}

impl From<SettingsError> for ChannelTtsSettingsError {
    fn from(error: SettingsError) -> Self {
        Self::Settings(error)
    }
}

impl From<PersistenceError> for ChannelTtsSettingsError {
    fn from(error: PersistenceError) -> Self {
        Self::Persistence(error)
    }
}

impl From<ValidationErrors> for ChannelTtsSettingsError {
    fn from(error: ValidationErrors) -> Self {
        Self::Persistence(PersistenceError::Validation(error))
    }
}

impl From<mongodb::error::Error> for ChannelTtsSettingsError {
    fn from(error: mongodb::error::Error) -> Self {
        Self::Mongo(error)
    }
}

impl From<BsonBoundaryError> for ChannelTtsSettingsError {
    fn from(error: BsonBoundaryError) -> Self {
        Self::BsonBoundary(error)
    }
}

fn boundary(path: &str, kind: &'static str) -> BsonBoundaryError {
    BsonBoundaryError {
        path: path.into(),
        kind,
    }
}

/// Convert plain BSON values as the Node driver's default promoted read does.
/// Int64 values outside its inclusive +/-2^53 promotion range are Long objects
/// and are explicitly unsupported here instead of being rounded to Numbers.
pub fn bson_to_settings_json(value: &Bson) -> Result<JsonValue, BsonBoundaryError> {
    bson_to_json_at(value, "$", 0)
}

fn bson_to_json_at(value: &Bson, path: &str, depth: usize) -> Result<JsonValue, BsonBoundaryError> {
    if depth > 128 {
        return Err(boundary(path, "nesting limit"));
    }
    Ok(match value {
        Bson::Null => JsonValue::Null,
        Bson::Boolean(value) => JsonValue::Bool(*value),
        Bson::String(value) => JsonValue::String(value.clone().into()),
        Bson::Int32(value) => JsonValue::Number(f64::from(*value)),
        Bson::Int64(value) if (-9_007_199_254_740_992..=9_007_199_254_740_992).contains(value) => {
            JsonValue::Number(*value as f64)
        }
        Bson::Double(value) => JsonValue::Number(*value),
        Bson::Array(values) => JsonValue::Array(
            values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    bson_to_json_at(value, &format!("{path}[{index}]"), depth + 1)
                })
                .collect::<Result<_, _>>()?,
        ),
        Bson::Document(values) => JsonValue::Object(
            values
                .iter()
                .map(|(key, value)| {
                    Ok((
                        JsString::from(key.as_str()),
                        bson_to_json_at(value, &format!("{path}.{key}"), depth + 1)?,
                    ))
                })
                .collect::<Result<_, _>>()?,
        ),
        _ => return Err(boundary(path, "non-plain BSON value")),
    })
}

/// Apply Node's BSON write boundary only when persisting: each unpaired UTF-16
/// code unit becomes U+FFFD, and Numbers use the shared JS BSON representation.
pub fn settings_json_to_bson(value: &JsonValue) -> Result<Bson, BsonBoundaryError> {
    json_to_bson_at(value, "$", 0)
}

fn json_to_bson_at(value: &JsonValue, path: &str, depth: usize) -> Result<Bson, BsonBoundaryError> {
    if depth > 128 {
        return Err(boundary(path, "nesting limit"));
    }
    Ok(match value {
        JsonValue::Null => Bson::Null,
        JsonValue::Bool(value) => Bson::Boolean(*value),
        JsonValue::Number(value) => js_number(*value),
        JsonValue::String(value) => Bson::String(value.to_utf8_lossy()),
        JsonValue::Array(values) => Bson::Array(
            values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    json_to_bson_at(value, &format!("{path}[{index}]"), depth + 1)
                })
                .collect::<Result<_, _>>()?,
        ),
        JsonValue::Object(values) => {
            let mut output = Document::new();
            for (key, value) in values {
                let key = key.to_utf8_lossy();
                if key.contains('\0') {
                    return Err(boundary(path, "NUL in BSON key"));
                }
                if output.contains_key(&key) {
                    return Err(boundary(path, "duplicate BSON key after UTF-8 encoding"));
                }
                output.insert(
                    &key,
                    json_to_bson_at(value, &format!("{path}.{key}"), depth + 1)?,
                );
            }
            Bson::Document(output)
        }
    })
}

fn normalized_document(value: &JsonValue) -> Result<Document, BsonBoundaryError> {
    match settings_json_to_bson(value)? {
        Bson::Document(document) => Ok(document),
        _ => Err(boundary("$", "normalized settings must be an object")),
    }
}

fn project_object(value: &Bson, fields: &[&str]) -> Bson {
    let Bson::Document(document) = value else {
        return value.clone();
    };
    Bson::Document(
        fields
            .iter()
            .filter_map(|field| {
                document
                    .get(*field)
                    .map(|value| ((*field).to_owned(), value.clone()))
            })
            .collect(),
    )
}

fn settings_input(document: &Document) -> Document {
    let mut input = Document::new();
    for field in [
        "channel",
        "enabled",
        "provider",
        "defaultLanguage",
        "voices",
        "filters",
        "queue",
    ] {
        if let Some(value) = document.get(field) {
            input.insert(field, value.clone());
        }
    }
    if let Some(value) = input.get_mut("voices") {
        *value = project_object(value, &["en", "es", "cloneDefault", "kokoroDefault"]);
    }
    if let Some(value) = input.get_mut("queue") {
        *value = project_object(value, &["maxItems"]);
    }
    if let Some(value) = input.get_mut("filters") {
        *value = project_object(
            value,
            &[
                "skipEmotes",
                "stripLinks",
                "normalizeWhitespace",
                "maxLength",
                "expressiveTags",
            ],
        );
        if let Bson::Document(filters) = value
            && let Some(tags) = filters.get_mut("expressiveTags")
        {
            let mut fields: Vec<_> = expressive_tags().collect();
            fields.extend(["inline", "wrapping"]);
            *tags = project_object(tags, &fields);
            if let Bson::Document(tags) = tags {
                let fields: Vec<_> = expressive_tags()
                    .map(|tag| {
                        if tag == "long-pause" {
                            "longPause"
                        } else {
                            tag
                        }
                    })
                    .collect();
                for key in ["inline", "wrapping"] {
                    if let Some(value) = tags.get_mut(key) {
                        *value = project_object(value, &fields);
                    }
                }
            }
        }
    }
    input
}

/// Saved settings always take precedence, including an otherwise empty saved
/// record. A missing record consults only the Twitch user's registration marker;
/// a read never inserts defaults or changes either collection.
pub async fn get_channel_tts_settings(
    database: &Database,
    channel_id: &JsString,
    channel: &JsString,
) -> Result<JsonValue, ChannelTtsSettingsError> {
    let model = get_channel_tts_settings_model(database);
    if let Some(document) = model
        .find_one(doc! {"channelID": channel_id.to_utf8_lossy()})
        .await?
    {
        // Metadata and unknown top-level fields are not inputs to the source
        // normalizer; preserving them in storage does not require flattening
        // BSON IDs and timestamps into JSON.
        let input = bson_to_settings_json(&Bson::Document(settings_input(&document)))?;
        return Ok(normalize_channel_tts_settings(
            Some(&input),
            channel_id,
            channel,
        )?);
    }
    let user = users::schema()
        .native_collection(database)
        .find_one(doc! {
            "accounts": {"$elemMatch": {"type": "twitch", "id": channel_id.to_utf8_lossy()}}
        })
        .projection(doc! {"tts_default_provider": 1})
        .await?;
    let provider = if user
        .as_ref()
        .and_then(|user| user.get_str("tts_default_provider").ok())
        == Some("kokoro")
    {
        "kokoro"
    } else {
        "piper"
    };
    let input = JsonValue::Object(vec![(
        "provider".into(),
        JsonValue::String(provider.into()),
    )]);
    Ok(normalize_channel_tts_settings(
        Some(&input),
        channel_id,
        channel,
    )?)
}

/// Preserve the source's find + set + save sequence, including save validation
/// and duplicate-key races. This is intentionally not an atomic upsert.
pub async fn upsert_channel_tts_settings(
    database: &Database,
    channel_id: &JsString,
    input: Option<&JsonValue>,
    channel: &JsString,
    now: DateTime,
) -> Result<JsonValue, ChannelTtsSettingsError> {
    let normalized = normalize_channel_tts_settings(input, channel_id, channel)?;
    let mut next = normalized_document(&normalized)?;
    let model = get_channel_tts_settings_model(database);
    if let Some(existing) = model
        .find_one(doc! {"channelID": channel_id.to_utf8_lossy()})
        .await?
    {
        let id = existing
            .get("_id")
            .cloned()
            .ok_or(PersistenceError::MissingId)?;
        next.insert("_id", id.clone());
        // Use shared save validation and clocks, but select this source's dirty
        // paths ourselves: generic repository.save stamps every supplied field.
        let prepared = schema().prepare_save_against(&next, &existing, now)?;
        let mut set = Document::new();
        for field in &schema().fields {
            let previous = hydrated_field(field, &existing, now);
            let same = if field.name == "enabled" {
                previous.as_ref() == prepared.get(field.name)
            } else {
                previous
                    .as_ref()
                    .zip(normalized.get(field.name))
                    .is_some_and(|(previous, next)| bson_matches_json(previous, next))
            };
            // Scalar setters also dirty a hydrated default that was missing on
            // disk. Nested setters compare the entire hydrated object instead.
            let missing_scalar =
                !matches!(&field.kind, T::Object(_)) && !existing.contains_key(field.name);
            // Source doc.set(normalized) dirties filters.expressiveTags and
            // filters even when their values are unchanged. Its nested setter
            // therefore saves the whole filters object and advances updatedAt;
            // other unchanged settings retain their ordinary dirty comparison.
            if (field.name == "filters" || !same || missing_scalar)
                && let Some(value) = prepared.get(field.name)
            {
                set.insert(field.name, value.clone());
            }
        }
        let modified = !set.is_empty();
        add_missing_defaults(&schema().fields, &existing, &prepared, "", &mut set);
        if modified {
            set.insert("updatedAt", now);
        }
        if set.is_empty() {
            // Mongoose's no-op save still verifies that the record exists.
            if model.collection.find_one(doc! {"_id": id}).await?.is_none() {
                return Err(PersistenceError::NotFound.into());
            }
        } else if model
            .collection
            .update_one(doc! {"_id": id}, doc! {"$set": set})
            .await?
            .matched_count
            == 0
        {
            return Err(PersistenceError::NotFound.into());
        }
    } else {
        model.insert(next, now).await?;
    }
    get_channel_tts_settings(database, channel_id, channel).await
}

fn comparison_field(field: &Field) -> Field {
    let mut field = field.clone();
    // Hydration casts and applies defaults; validators run only after .set().
    field.required = false;
    field.required_when = None;
    field.enum_values = &[];
    if let T::Object(children) = &mut field.kind {
        *children = children.iter().map(comparison_field).collect();
    }
    field
}

fn merge_unknown_fields(previous: &Bson, hydrated: Bson) -> Bson {
    match (previous, hydrated) {
        (Bson::Document(previous), Bson::Document(hydrated)) => {
            let mut output = previous.clone();
            for (key, value) in hydrated {
                let value = previous.get(&key).map_or_else(
                    || value.clone(),
                    |previous| merge_unknown_fields(previous, value.clone()),
                );
                output.insert(key, value);
            }
            Bson::Document(output)
        }
        (_, hydrated) => hydrated,
    }
}

fn hydrated_field(field: &Field, existing: &Document, now: DateTime) -> Option<Bson> {
    let mut comparison = schema().clone();
    comparison.fields = vec![comparison_field(field)];
    comparison.timestamps = None;
    comparison.version_key = false;
    let mut hydrated = comparison.construct(existing, now).ok()?;
    let value = hydrated.remove(field.name)?;
    Some(existing.get(field.name).map_or_else(
        || value.clone(),
        |previous| merge_unknown_fields(previous, value.clone()),
    ))
}

fn bson_matches_json(previous: &Bson, next: &JsonValue) -> bool {
    match (previous, next) {
        (Bson::Null, JsonValue::Null) => true,
        (Bson::Boolean(previous), JsonValue::Bool(next)) => previous == next,
        (Bson::String(previous), JsonValue::String(next)) => {
            JsString::from(previous.as_str()) == *next
        }
        (Bson::Int32(previous), JsonValue::Number(next)) => f64::from(*previous) == *next,
        (Bson::Int64(previous), JsonValue::Number(next))
            if (-9_007_199_254_740_992..=9_007_199_254_740_992).contains(previous) =>
        {
            *previous as f64 == *next
        }
        (Bson::Double(previous), JsonValue::Number(next)) => previous == next,
        (Bson::Array(previous), JsonValue::Array(next)) => {
            previous.len() == next.len()
                && previous
                    .iter()
                    .zip(next)
                    .all(|(previous, next)| bson_matches_json(previous, next))
        }
        (Bson::Document(previous), JsonValue::Object(next)) => {
            previous.len() == next.len()
                && next.iter().all(|(key, next)| {
                    key.as_str()
                        .and_then(|key| previous.get(key))
                        .is_some_and(|previous| bson_matches_json(previous, next))
                })
        }
        _ => false,
    }
}

fn add_missing_defaults(
    fields: &[Field],
    existing: &Document,
    prepared: &Document,
    prefix: &str,
    set: &mut Document,
) {
    for field in fields {
        let path = if prefix.is_empty() {
            field.name.into()
        } else {
            format!("{prefix}.{}", field.name)
        };
        if set.contains_key(&path) {
            continue;
        }
        if let T::Object(children) = &field.kind {
            if let Some(Bson::Document(prepared)) = prepared.get(field.name) {
                let empty = Document::new();
                let existing = existing.get_document(field.name).unwrap_or(&empty);
                add_missing_defaults(children, existing, prepared, &path, set);
            }
        } else if !existing.contains_key(field.name)
            && !matches!(field.default, D::Missing)
            && let Some(value) = prepared.get(field.name)
        {
            set.insert(path, value.clone());
        }
    }
}

fn flatten_defaults(input: Document, prefix: &str, output: &mut Document) {
    for (key, value) in input {
        let path = if prefix.is_empty() {
            key
        } else {
            format!("{prefix}.{key}")
        };
        if let Bson::Document(document) = value {
            flatten_defaults(document, &path, output);
        } else {
            output.insert(path, value);
        }
    }
}

/// Change exactly the provider and Fish default, preserving concurrent edits to
/// every other setting. Source updateOne does not enable save validators.
pub async fn set_channel_fish_voice(
    database: &Database,
    channel_id: &JsString,
    voice: &JsString,
    channel: &JsString,
    now: DateTime,
) -> Result<(), ChannelTtsSettingsError> {
    // Reuse declared defaults and timestamps without imposing the save-only
    // required validator: updateOne({ upsert: true }) accepts an empty ID.
    let mut update_schema = schema().clone();
    for field in &mut update_schema.fields {
        field.required = false;
    }
    let mut defaults = update_schema.prepare_insert(
        doc! {
            "channelID": channel_id.to_utf8_lossy(),
            "channel": channel.to_utf8_lossy(),
        },
        now,
    )?;
    // MongoDB supplies an upsert's _id; Mongoose supplies version/defaults.
    defaults.remove("_id");
    let mut on_insert = Document::new();
    flatten_defaults(defaults, "", &mut on_insert);
    // A parent/path pair across $set and $setOnInsert conflicts in MongoDB.
    // Flatten insertion defaults so siblings of voices.cloneDefault survive.
    for path in ["provider", "voices.cloneDefault", "updatedAt"] {
        on_insert.remove(path);
    }
    get_channel_tts_settings_model(database).collection.update_one(
        doc! {"channelID": channel_id.to_utf8_lossy()},
        doc! {
            "$set": {"provider": "fish", "voices.cloneDefault": voice.to_utf8_lossy(), "updatedAt": now},
            "$setOnInsert": on_insert,
        },
    ).upsert(true).await?;
    Ok(())
}
