//! The three read-only helpers in `ai_usage_ledger.ts`.
//!
//! Construction clones the caller's MongoDB handle and performs no I/O. Reads
//! reuse the application's ledger-state collection metadata; they install no
//! indexes, acquire no locks, write nothing, and impose no timeout/retry policy.
//! Dropping a read future is the caller's cancellation boundary.
//!
//! Inputs have the source's declared String/Date types. Strings retain UTF-16
//! until BSON encoding replaces unpaired surrogates. Lean results are raw BSON:
//! `get_state` must not cast malformed legacy fields through the schema. The
//! raw carriers distinguish undefined/missing, null, and other BSON values.
//! `get_status` preserves the source's ordered getTime/toISOString failures.
//! Ordinary JSON-backed legacy versions reuse the existing JS coercion core.
//! BSON wrappers use the installed Node BSON prototypes' numeric boundaries;
//! executable hooks, custom prototypes, and nondefault BSON promotion options
//! are outside this API, rather than an implied general JS interpreter.

use crate::{
    schemas::ai_usage_ledger_state,
    utils::{
        bson_compat::js_number as bson_number, credit_policy::JsDate, js_string::JsString,
        json_number::string_number, lossless_json::JsonValue, tts::settings,
    },
};
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc},
};
use serde::Serialize;
use std::fmt;

pub const AI_USAGE_REPORT_VERSION: i32 = 3;

/// Both identifiers are literal strings, without trimming or normalization.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiUsageLedgerStateInput {
    pub channel_id: JsString,
    pub customer_id: JsString,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiUsageLedgerCoverageInput {
    pub channel_id: JsString,
    pub customer_id: JsString,
    pub starts_at: JsDate,
}
pub type AiUsageLedgerStatusInput = AiUsageLedgerCoverageInput;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AiUsageLedgerReadiness {
    Ready,
    Pending,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageLedgerStatus {
    pub status: AiUsageLedgerReadiness,
    pub coverage_start: Option<String>,
    pub last_synced_at: Option<String>,
    pub requested_coverage_start: String,
}

/// A property read from a lean document. Missing and BSON Undefined evaluate
/// as JS undefined; explicit BSON Null remains null. Every other BSON value is
/// retained exactly, including out-of-TimeClip dates and unpromoted Longs.
#[derive(Clone, Debug, PartialEq)]
pub enum LedgerField {
    Undefined,
    Value(Bson),
}

impl LedgerField {
    pub fn from_document(document: &Document, name: &str) -> Self {
        match document.get(name) {
            None | Some(Bson::Undefined) => Self::Undefined,
            Some(value) => Self::Value(value.clone()),
        }
    }

    pub fn as_bson(&self) -> Option<&Bson> {
        match self {
            Self::Undefined => None,
            Self::Value(value) => Some(value),
        }
    }
}

/// Honest runtime shape of the source's inline Date/Date/number DTO. A lean
/// read does not enforce those declarations. Consumers requiring valid typed
/// fields must check them; this adapter does not silently repair legacy data.
#[derive(Clone, Debug, PartialEq)]
pub struct AiUsageLedgerState {
    pub coverage_start: LedgerField,
    pub backfilled_at: LedgerField,
    pub report_version: LedgerField,
}

#[derive(Debug)]
pub enum AiUsageLedgerReadError {
    /// The original driver error, including server/network/selection errors.
    Mongo(mongodb::error::Error),
    /// Mongoose rejects an invalid Date while casting the coverage filter.
    CastError { path: &'static str },
    /// A missing/null/non-Date field cannot provide the source Date method.
    TypeError {
        field: &'static str,
        method: &'static str,
    },
    /// A Date outside TimeClip cannot provide an ISO string.
    RangeError { field: &'static str },
    /// Existing ordinary-JSON Number/String coercion raised TypeError.
    CoercionTypeError(settings::SettingsError),
    /// Outside the declared inputs and the documented lean BSON subset. This
    /// is explicitly not claimed to be a JavaScript exception category.
    UnsupportedLegacyBson { bson_type: &'static str },
}

impl AiUsageLedgerReadError {
    pub fn javascript_exception_name(&self) -> Option<&'static str> {
        match self {
            Self::Mongo(_) | Self::UnsupportedLegacyBson { .. } => None,
            Self::CastError { .. } => Some("CastError"),
            Self::TypeError { .. } | Self::CoercionTypeError(_) => Some("TypeError"),
            Self::RangeError { .. } => Some("RangeError"),
        }
    }
}

impl fmt::Display for AiUsageLedgerReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mongo(error) => write!(f, "{error}"),
            Self::CastError { path } => write!(f, "Cast to date failed at path {path}"),
            Self::TypeError { field, method } => write!(f, "{field}.{method} is not a Date method"),
            Self::RangeError { .. } => f.write_str("Invalid time value"),
            Self::CoercionTypeError(error) => write!(f, "{error}"),
            Self::UnsupportedLegacyBson { bson_type } => {
                write!(f, "unsupported legacy BSON coercion: {bson_type}")
            }
        }
    }
}
impl std::error::Error for AiUsageLedgerReadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Mongo(error) => Some(error),
            Self::CoercionTypeError(error) => Some(error),
            _ => None,
        }
    }
}
impl From<mongodb::error::Error> for AiUsageLedgerReadError {
    fn from(error: mongodb::error::Error) -> Self {
        Self::Mongo(error)
    }
}

/// Public query value permits source-boundary parity checks without a fake
/// production repository. Execution below always uses the real driver.
#[derive(Clone, Debug, PartialEq)]
pub struct LedgerReadQuery {
    pub filter: Document,
    pub projection: Document,
}

fn identity(channel: &JsString, customer: &JsString) -> Document {
    doc! {"channelID": channel.to_utf8_lossy(),
    "customerId": customer.to_utf8_lossy()}
}

pub fn state_query(input: &AiUsageLedgerStateInput) -> LedgerReadQuery {
    LedgerReadQuery {
        filter: identity(&input.channel_id, &input.customer_id),
        // The source select() includes Mongo's default _id field as well.
        projection: doc! {"coverageStart":1, "backfilledAt":1, "reportVersion":1},
    }
}

pub fn coverage_query(
    input: &AiUsageLedgerCoverageInput,
) -> Result<LedgerReadQuery, AiUsageLedgerReadError> {
    let millis = input
        .starts_at
        .timestamp_millis()
        .ok_or(AiUsageLedgerReadError::CastError {
            path: "coverageStart",
        })?;
    let mut filter = identity(&input.channel_id, &input.customer_id);
    filter.insert(
        "coverageStart",
        doc! {"$lte": DateTime::from_millis(millis)},
    );
    filter.insert(
        "reportVersion",
        doc! {"$gte": bson_number(f64::from(AI_USAGE_REPORT_VERSION))},
    );
    Ok(LedgerReadQuery {
        filter,
        projection: doc! {"_id":1},
    })
}

/// Preserve JS `version || 0`, with Node's default BSON promotion. Normalizing
/// all result numbers here would corrupt the raw lean DTO; only the fallback
/// is encoded through the shared Node Number writer.
fn version_or_zero(value: LedgerField) -> LedgerField {
    let truthy = match &value {
        LedgerField::Undefined => false,
        LedgerField::Value(value) => ordinary_json(value)
            .map(|value| settings::truthy(&value))
            // BSON wrappers (even Decimal128/Long zero) are objects. Int64s
            // in Node's promoted interval are handled by ordinary_json.
            .unwrap_or(true),
    };
    if truthy {
        value
    } else {
        LedgerField::Value(bson_number(0.0))
    }
}

/// Adapt only ordinary BSON values to the existing JS coercion implementation.
/// Method-shadowing documents retain their keys so its TypeError is preserved.
/// This deliberately does not introduce a second Number parser or trim policy.
fn ordinary_json(value: &Bson) -> Option<JsonValue> {
    Some(match value {
        Bson::Null | Bson::Undefined => JsonValue::Null,
        Bson::Boolean(value) => JsonValue::Bool(*value),
        Bson::String(value) | Bson::Symbol(value) => JsonValue::String(value.as_str().into()),
        Bson::Int32(value) => JsonValue::Number(f64::from(*value)),
        Bson::Double(value) => JsonValue::Number(*value),
        Bson::Int64(value) => {
            // Reuse the existing inclusive +/-2^53 Node promotion boundary.
            let mut promoted = doc! {"value": *value};
            crate::utils::bson_compat::normalize_document(&mut promoted);
            match promoted.get("value")? {
                Bson::Int32(value) => JsonValue::Number(f64::from(*value)),
                Bson::Double(value) => JsonValue::Number(*value),
                _ => return None,
            }
        }
        Bson::Array(values) => JsonValue::Array(
            values
                .iter()
                .map(ordinary_json)
                .collect::<Option<Vec<_>>>()?,
        ),
        // Ordinary BSON documents have no callable values or getters. Numeric
        // coercion only observes whether their own toString shadows the
        // inherited method; field values (including BSON wrappers) are never
        // read by that method. Keep the marker, without traversing those data.
        Bson::Document(values) => JsonValue::Object(
            (values.contains_key("toString") && !node_dbref_document(values))
                .then(|| ("toString".into(), JsonValue::Null))
                .into_iter()
                .collect(),
        ),
        _ => return None,
    })
}

// Node BSON upgrades these documents to a DBRef wrapper. Extra ordinary keys
// live in wrapper.fields and do not shadow the wrapper's coercion methods.
fn node_dbref_document(value: &Document) -> bool {
    matches!(value.get("$ref"), Some(Bson::String(_) | Bson::Symbol(_)))
        && value
            .get("$id")
            .is_some_and(|id| !matches!(id, Bson::Null | Bson::Undefined))
        && matches!(
            value.get("$db"),
            None | Some(Bson::String(_) | Bson::Symbol(_))
        )
        && value
            .keys()
            .filter(|key| key.starts_with('$'))
            .all(|key| matches!(key.as_str(), "$ref" | "$id" | "$db"))
}

fn version_number(value: &Bson) -> Result<f64, AiUsageLedgerReadError> {
    if let Some(value) = ordinary_json(value) {
        return settings::js_number(Some(&value))
            .map_err(AiUsageLedgerReadError::CoercionTypeError);
    }
    // Node wrapper prototypes convert to these strings under the numeric hint.
    // Int64 reaching this branch is an unpromoted Long, not a JS Number.
    Ok(match value {
        Bson::Int64(value) => string_number(&value.to_string()),
        Bson::Decimal128(value) => string_number(&value.to_string()),
        Bson::ObjectId(value) => string_number(&value.to_hex()),
        // Node promotes valid subtype-4 binary values to UUID; its dashed
        // default string representation can never satisfy Number(...) >= 3.
        Bson::Binary(value)
            if value.subtype == mongodb::bson::spec::BinarySubtype::Uuid
                && value.bytes.len() == 16 =>
        {
            f64::NAN
        }
        Bson::Binary(value) => string_number(&String::from_utf8_lossy(&value.bytes)),
        Bson::Timestamp(value) => {
            let unsigned = (u64::from(value.time) << 32) | u64::from(value.increment);
            string_number(&unsigned.to_string())
        }
        Bson::DateTime(value) => JsDate::from_millis(value.timestamp_millis() as f64)
            .timestamp_millis()
            .map_or(f64::NAN, |value| value as f64),
        // These installed BSON wrapper prototypes inherit Object.toString;
        // native RegExp strings also never parse as numbers.
        Bson::JavaScriptCode(_)
        | Bson::JavaScriptCodeWithScope(_)
        | Bson::RegularExpression(_)
        | Bson::DbPointer(_)
        | Bson::MinKey
        | Bson::MaxKey => f64::NAN,
        Bson::Array(values) => {
            let value = JsonValue::Array(
                values
                    .iter()
                    .map(array_coercion_value)
                    .collect::<Result<_, _>>()?,
            );
            return settings::js_number(Some(&value))
                .map_err(AiUsageLedgerReadError::CoercionTypeError);
        }
        _ => {
            return Err(AiUsageLedgerReadError::UnsupportedLegacyBson {
                bson_type: "unknown",
            });
        }
    })
}

/// Values used ONLY by Number(array), whose primitive step is Array.join.
/// Wrappers with numeric string forms retain those forms. Date and RegExp
/// string forms always contain nonnumeric text; their exact timezone/escaping
/// spelling cannot affect this numeric result. The nonnumeric marker preserves
/// NaN while still letting the shared core visit later items and throw for
/// own noncallable toString fields. This is not a String(value) public API.
fn array_coercion_value(value: &Bson) -> Result<JsonValue, AiUsageLedgerReadError> {
    if let Some(value) = ordinary_json(value) {
        return Ok(value);
    }
    let text = match value {
        Bson::Int64(value) => value.to_string(),
        Bson::Decimal128(value) => value.to_string(),
        Bson::ObjectId(value) => value.to_hex(),
        Bson::Binary(value)
            if value.subtype == mongodb::bson::spec::BinarySubtype::Uuid
                && value.bytes.len() == 16 =>
        {
            "[UUID]".into()
        }
        Bson::Binary(value) => String::from_utf8_lossy(&value.bytes).into_owned(),
        Bson::Timestamp(value) => {
            ((u64::from(value.time) << 32) | u64::from(value.increment)).to_string()
        }
        Bson::DateTime(_) | Bson::RegularExpression(_) => "[nonnumeric BSON string]".into(),
        Bson::JavaScriptCode(_)
        | Bson::JavaScriptCodeWithScope(_)
        | Bson::DbPointer(_)
        | Bson::MinKey
        | Bson::MaxKey => "[object Object]".into(),
        Bson::Array(values) => {
            return Ok(JsonValue::Array(
                values
                    .iter()
                    .map(array_coercion_value)
                    .collect::<Result<_, _>>()?,
            ));
        }
        _ => {
            return Err(AiUsageLedgerReadError::UnsupportedLegacyBson {
                bson_type: "unknown",
            });
        }
    };
    Ok(JsonValue::String(text.into()))
}

pub fn decode_state(document: Option<Document>) -> Option<AiUsageLedgerState> {
    document.map(|state| AiUsageLedgerState {
        coverage_start: LedgerField::from_document(&state, "coverageStart"),
        backfilled_at: LedgerField::from_document(&state, "backfilledAt"),
        report_version: version_or_zero(LedgerField::from_document(&state, "reportVersion")),
    })
}

fn date_method(
    value: &LedgerField,
    field: &'static str,
    method: &'static str,
) -> Result<JsDate, AiUsageLedgerReadError> {
    match value {
        LedgerField::Value(Bson::DateTime(value)) => {
            Ok(JsDate::from_millis(value.timestamp_millis() as f64))
        }
        _ => Err(AiUsageLedgerReadError::TypeError { field, method }),
    }
}
fn iso(value: &LedgerField, field: &'static str) -> Result<Option<String>, AiUsageLedgerReadError> {
    if matches!(
        value,
        LedgerField::Undefined | LedgerField::Value(Bson::Null)
    ) {
        return Ok(None);
    }
    date_method(value, field, "toISOString")?
        .to_iso_string()
        .map(Some)
        .map_err(|_| AiUsageLedgerReadError::RangeError { field })
}

pub fn decode_status(
    document: Option<Document>,
    starts_at: JsDate,
) -> Result<AiUsageLedgerStatus, AiUsageLedgerReadError> {
    let state = decode_state(document);
    let ready = if let Some(state) = &state {
        let coverage = date_method(&state.coverage_start, "coverageStart", "getTime")?;
        // Invalid Dates compare false; short-circuit before version coercion.
        match (coverage.timestamp_millis(), starts_at.timestamp_millis()) {
            (Some(coverage), Some(requested)) if coverage <= requested => {
                version_number(
                    state
                        .report_version
                        .as_bson()
                        .expect("version || 0 is defined"),
                )? >= f64::from(AI_USAGE_REPORT_VERSION)
            }
            _ => false,
        }
    } else {
        false
    };
    // Preserve object-literal evaluation order: coverage, sync, requested.
    let coverage_start = state
        .as_ref()
        .map(|s| iso(&s.coverage_start, "coverageStart"))
        .transpose()?
        .flatten();
    let last_synced_at = state
        .as_ref()
        .map(|s| iso(&s.backfilled_at, "backfilledAt"))
        .transpose()?
        .flatten();
    let requested_coverage_start = starts_at
        .to_iso_string()
        .map_err(|_| AiUsageLedgerReadError::RangeError { field: "startsAt" })?;
    Ok(AiUsageLedgerStatus {
        status: if ready {
            AiUsageLedgerReadiness::Ready
        } else {
            AiUsageLedgerReadiness::Pending
        },
        coverage_start,
        last_synced_at,
        requested_coverage_start,
    })
}

#[derive(Clone, Debug)]
pub struct MongoAiUsageLedgerReads {
    collection: Collection<Document>,
}
impl MongoAiUsageLedgerReads {
    pub fn new(database: &Database) -> Self {
        Self {
            collection: ai_usage_ledger_state::schema().native_collection(database),
        }
    }

    pub fn collection(&self) -> &Collection<Document> {
        &self.collection
    }

    pub async fn has_ai_usage_ledger_coverage(
        &self,
        input: &AiUsageLedgerCoverageInput,
    ) -> Result<bool, AiUsageLedgerReadError> {
        let query = coverage_query(input)?;
        // Execute Mongo's range query, preserving type bracketing and array
        // matching rather than replacing it with the status JS comparison.
        Ok(self
            .collection
            .find_one(query.filter)
            .projection(query.projection)
            .await?
            .is_some())
    }

    pub async fn get_ai_usage_ledger_state(
        &self,
        input: &AiUsageLedgerStateInput,
    ) -> Result<Option<AiUsageLedgerState>, AiUsageLedgerReadError> {
        let query = state_query(input);
        Ok(decode_state(
            self.collection
                .find_one(query.filter)
                .projection(query.projection)
                .await?,
        ))
    }

    pub async fn get_ai_usage_ledger_status(
        &self,
        input: &AiUsageLedgerStatusInput,
    ) -> Result<AiUsageLedgerStatus, AiUsageLedgerReadError> {
        let query = state_query(&AiUsageLedgerStateInput {
            channel_id: input.channel_id.clone(),
            customer_id: input.customer_id.clone(),
        });
        let state = self
            .collection
            .find_one(query.filter)
            .projection(query.projection)
            .await?;
        decode_status(state, input.starts_at)
    }
}
