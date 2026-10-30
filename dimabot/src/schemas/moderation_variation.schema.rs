//! Disconnected definitions for the two variation collections. Mixed fields
//! remain BSON: Mongoose does not validate the TypeScript interface at runtime.
use super::{
    Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository,
};
use crate::utils::{
    bson_compat,
    js_string::JsString,
    moderation::types::{GeneratedVariation, ModerationPattern, PatternBoundary},
};
use mongodb::{
    Database,
    bson::{Bson, DateTime, Document, doc},
};
use std::sync::OnceLock;

pub fn cache_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "moderation_variation_cache",
        collection: "moderation_variation_caches",
        string_id: true,
        version_key: false,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("_id", T::String),
            Field::new("channelID", T::String),
            Field::new("entry", T::Mixed).minimize(),
            Field::new("model", T::String),
            Field::new("expiresAt", T::Date),
        ],
        indexes: vec![SchemaIndex::new(doc! {"expiresAt": 1}).ttl(0)],
    })
}
pub fn job_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "moderation_variation_job",
        collection: "moderation_variation_jobs",
        string_id: true,
        version_key: false,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("_id", T::String),
            Field::new("channelID", T::String),
            Field::new("terms", T::Array(Box::new(T::String))).default(D::Array),
            Field::new("state", T::String),
            Field::new("entries", T::Array(Box::new(T::Mixed)))
                .default(D::Array)
                .minimize(),
            Field::new("error", T::String).default(D::String("")),
            Field::new("attempts", T::Number).default(D::Number(1.0)),
            Field::new("createdAt", T::Date),
            Field::new("deadline", T::Date),
            Field::new("expiresAt", T::Date),
            Field::new("model", T::String),
            Field::new("version", T::String),
            Field::new("providerUsage", T::Mixed)
                .default(D::Array)
                .minimize(),
            Field::new("creditsCharged", T::Number).default(D::Number(0.0)),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"state": 1, "createdAt": 1}),
            SchemaIndex::new(doc! {"expiresAt": 1}).ttl(0),
        ],
    })
}
pub fn get_moderation_variation_cache_model(database: &Database) -> SchemaRepository {
    cache_schema().repository(database)
}
pub fn get_moderation_variation_job_model(database: &Database) -> SchemaRepository {
    job_schema().repository(database)
}

/// Typed application value; use the raw repository for missing/null or other
/// Mixed shapes accepted by Mongoose. Dates use the BSON millisecond boundary.
#[derive(Clone, Debug, PartialEq)]
pub struct VariationJob {
    pub id: JsString,
    pub channel_id: JsString,
    pub terms: Vec<JsString>,
    pub state: VariationJobState,
    pub entries: Vec<GeneratedVariation>,
    pub error: JsString,
    pub attempts: f64,
    pub created_at: DateTime,
    pub deadline: DateTime,
    pub expires_at: DateTime,
    pub model: JsString,
    pub version: JsString,
    pub provider_usage: Vec<Document>,
    pub credits_charged: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VariationJobState {
    Reserved,
    Pending,
    Processing,
    Completed,
    Failed,
}
impl VariationJobState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reserved => "reserved",
            Self::Pending => "pending",
            Self::Processing => "processing",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}
fn string(value: &JsString) -> Bson {
    Bson::String(value.to_utf8_lossy())
}
/// Convert the shared value to its ordinary Mixed BSON representation.
pub fn generated_variation_to_bson(value: &GeneratedVariation) -> Bson {
    let mut result = doc! {"term": string(&value.term), "spellings": value.spellings.iter().map(string).collect::<Vec<_>>(),
    "pattern": {"id": string(&value.pattern.id), "source": string(&value.pattern.source),
        "boundary": match value.pattern.boundary { PatternBoundary::WholeWord => "whole_word", PatternBoundary::Anywhere => "anywhere" },
        "ignoreCase": value.pattern.ignore_case}, "version": string(&value.version)};
    if let Some(value) = value.allow_spaces {
        result.insert("allowSpaces", value);
    }
    if let Some(value) = &value.symbol_version {
        result.insert("symbolVersion", string(value));
    }
    Bson::Document(result)
}
/// Decode only well-formed typed entries; raw Mixed values remain accessible.
pub fn generated_variation_from_bson(value: &Bson) -> Result<GeneratedVariation, &'static str> {
    let d = value.as_document().ok_or("entry must be a document")?;
    let p = d
        .get_document("pattern")
        .map_err(|_| "pattern must be a document")?;
    let get = |d: &Document, key: &str| -> Result<JsString, &'static str> {
        Ok(d.get_str(key).map_err(|_| "expected string")?.into())
    };
    let spellings = d
        .get_array("spellings")
        .map_err(|_| "spellings must be an array")?
        .iter()
        .map(|v| {
            v.as_str()
                .map(JsString::from)
                .ok_or("expected spelling string")
        })
        .collect::<Result<_, _>>()?;
    let boundary = match p.get_str("boundary").map_err(|_| "expected boundary")? {
        "whole_word" => PatternBoundary::WholeWord,
        "anywhere" => PatternBoundary::Anywhere,
        _ => return Err("invalid boundary"),
    };
    let allow_spaces = match d.get("allowSpaces") {
        None => None,
        Some(Bson::Boolean(v)) => Some(*v),
        _ => return Err("invalid allowSpaces"),
    };
    let symbol_version = match d.get("symbolVersion") {
        None => None,
        Some(Bson::String(v)) => Some(v.as_str().into()),
        _ => return Err("invalid symbolVersion"),
    };
    Ok(GeneratedVariation {
        term: get(d, "term")?,
        spellings,
        pattern: ModerationPattern {
            id: get(p, "id")?,
            source: get(p, "source")?,
            boundary,
            ignore_case: p.get_bool("ignoreCase").map_err(|_| "invalid ignoreCase")?,
        },
        version: get(d, "version")?,
        allow_spaces,
        symbol_version,
    })
}
impl VariationJob {
    /// Borrowed conversion; the owned variant moves the Mixed usage records.
    pub fn to_document(&self) -> Document {
        let mut document = self.fields_document();
        document.insert(
            "providerUsage",
            self.provider_usage
                .iter()
                .cloned()
                .map(Bson::Document)
                .collect::<Vec<_>>(),
        );
        document.insert(
            "creditsCharged",
            bson_compat::js_number(self.credits_charged),
        );
        bson_compat::normalize_document(&mut document);
        document
    }
    /// Serialize the declared type, moving usage records without BSON clones.
    pub fn into_document(self) -> Document {
        let mut document = self.fields_document();
        document.insert(
            "providerUsage",
            self.provider_usage
                .into_iter()
                .map(Bson::Document)
                .collect::<Vec<_>>(),
        );
        document.insert(
            "creditsCharged",
            bson_compat::js_number(self.credits_charged),
        );
        bson_compat::normalize_document(&mut document);
        document
    }
    fn fields_document(&self) -> Document {
        doc! {"_id": string(&self.id), "channelID": string(&self.channel_id), "terms": self.terms.iter().map(string).collect::<Vec<_>>(),
        "state": self.state.as_str(), "entries": self.entries.iter().map(generated_variation_to_bson).collect::<Vec<_>>(),
        "error": string(&self.error), "attempts": bson_compat::js_number(self.attempts), "createdAt": self.created_at,
        "deadline": self.deadline, "expiresAt": self.expires_at, "model": string(&self.model), "version": string(&self.version)}
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct VariationCache {
    pub id: JsString,
    pub channel_id: JsString,
    pub entry: GeneratedVariation,
    pub model: JsString,
    pub expires_at: DateTime,
}
impl VariationCache {
    pub fn to_document(&self) -> Document {
        doc! {"_id":string(&self.id),"channelID":string(&self.channel_id),"entry":generated_variation_to_bson(&self.entry),"model":string(&self.model),"expiresAt":self.expires_at}
    }
    pub fn from_document(document: &Document) -> Result<Self, &'static str> {
        Ok(Self {
            id: read_string(document, "_id")?,
            channel_id: read_string(document, "channelID")?,
            entry: generated_variation_from_bson(document.get("entry").ok_or("missing entry")?)?,
            model: read_string(document, "model")?,
            expires_at: read_date(document, "expiresAt")?,
        })
    }
}
fn read_string(document: &Document, key: &str) -> Result<JsString, &'static str> {
    Ok(document.get_str(key).map_err(|_| "expected string")?.into())
}
fn read_date(document: &Document, key: &str) -> Result<DateTime, &'static str> {
    document
        .get_datetime(key)
        .copied()
        .map_err(|_| "expected date")
}
fn read_number(document: &Document, key: &str) -> Result<f64, &'static str> {
    match document.get(key) {
        Some(Bson::Int32(n)) => Ok(f64::from(*n)),
        Some(Bson::Int64(n)) => Ok(*n as f64),
        Some(Bson::Double(n)) => Ok(*n),
        _ => Err("expected number"),
    }
}
impl VariationJob {
    /// Decode a complete application-typed job, rejecting other valid Mixed
    /// or missing shapes instead of silently coercing them.
    pub fn from_document(document: &Document) -> Result<Self, &'static str> {
        let usage = document
            .get("providerUsage")
            .ok_or("missing providerUsage")?
            .clone();
        Self::from_document_with_usage(document, usage)
    }
    /// Decode an owned raw document without cloning its provider usage records.
    pub fn from_owned_document(mut document: Document) -> Result<Self, &'static str> {
        let usage = document
            .remove("providerUsage")
            .ok_or("missing providerUsage")?;
        Self::from_document_with_usage(&document, usage)
    }
    fn from_document_with_usage(document: &Document, usage: Bson) -> Result<Self, &'static str> {
        let provider_usage = match usage {
            Bson::Array(records) => records
                .into_iter()
                .map(|record| match record {
                    Bson::Document(record) => Ok(record),
                    _ => Err("expected providerUsage record"),
                })
                .collect::<Result<Vec<_>, _>>()?,
            _ => return Err("expected providerUsage array"),
        };
        let state = match document.get_str("state").map_err(|_| "expected state")? {
            "reserved" => VariationJobState::Reserved,
            "pending" => VariationJobState::Pending,
            "processing" => VariationJobState::Processing,
            "completed" => VariationJobState::Completed,
            "failed" => VariationJobState::Failed,
            _ => return Err("invalid typed state"),
        };
        let terms = document
            .get_array("terms")
            .map_err(|_| "expected terms")?
            .iter()
            .map(|v| v.as_str().map(JsString::from).ok_or("expected term"))
            .collect::<Result<_, _>>()?;
        let entries = document
            .get_array("entries")
            .map_err(|_| "expected entries")?
            .iter()
            .map(generated_variation_from_bson)
            .collect::<Result<_, _>>()?;
        Ok(Self {
            id: read_string(document, "_id")?,
            channel_id: read_string(document, "channelID")?,
            terms,
            state,
            entries,
            error: read_string(document, "error")?,
            attempts: read_number(document, "attempts")?,
            created_at: read_date(document, "createdAt")?,
            deadline: read_date(document, "deadline")?,
            expires_at: read_date(document, "expiresAt")?,
            model: read_string(document, "model")?,
            version: read_string(document, "version")?,
            provider_usage,
            credits_charged: read_number(document, "creditsCharged")?,
        })
    }
}
