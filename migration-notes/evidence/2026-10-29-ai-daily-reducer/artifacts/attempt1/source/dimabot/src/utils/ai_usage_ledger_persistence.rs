//! Concrete, opt-in persistAiUsageReceipt and UTC daily repair.
//!
//! Construct with an explicit Database and shared ConnectionManager. No I/O,
//! indexes, bootstrap, transactions or mutation retry occurs at construction.
//! The original UTF-16 account identity reaches the existing native lock before
//! the BSON writer replaces lone surrogates. Cancellation/panic leaves that
//! lock's TTL intact: a Mongo command may have committed without a reply.
//!
//! The lossless input boundary is the source's declared plain receipt data:
//! declared string fields are missing/null/string, numeric fields are
//! missing/null/binary64 (including NaN/infinity), itemized is missing/null/bool.
//! Channel/customer are strings and occurredAt is a string. No executable
//! hooks, prototypes or implicit producer JSON serialization are involved.
//! Malformed legacy expiry arrays containing Date/RegExp, and top-level
//! RegExp expiry values, are explicitly unsupported. They fail before daily
//! deletion rather than using Number-only string markers during replacement.
use super::{
    ai_usage::{classify_adjustment, normalize_receipt_category},
    ai_usage_aggregate_policy::group_fields,
    ai_usage_ledger_reads::{AiUsageLedgerReadError, array_coercion_value, ordinary_json},
    ai_usage_lock::{AiUsageLock, AiUsageLockError},
    ai_usage_producer::{QueuedAiUsageReceipt, ReceiptClock, SystemReceiptClock},
    ai_usage_receipt_parser::{ParsedAiUsageReceipt, RetentionTier},
    bson_compat::js_number as bson_number,
    credit_policy::JsDate,
    js_date::{parse_date, parse_date_utf16},
    js_string::JsString,
    lossless_json::JsonValue,
    mongoose_date,
    tts::settings,
};
use crate::schemas::{ai_usage_daily, ai_usage_dashboard, ai_usage_receipt};
use futures_util::TryStreamExt;
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc},
};
use redis::aio::ConnectionManager;
use std::{fmt, sync::Arc};

const DAY: i64 = 86_400_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PersistAiUsageReceiptOutcome {
    Inserted,
    Duplicate,
    Expired,
}
impl PersistAiUsageReceiptOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inserted => "inserted",
            Self::Duplicate => "duplicate",
            Self::Expired => "expired",
        }
    }
}

#[derive(Debug)]
pub enum AiUsagePersistenceError {
    /// Invalid runtime types at the explicit plain-data boundary.
    InputType {
        path: &'static str,
    },
    CastError {
        path: &'static str,
    },
    RangeError {
        operation: &'static str,
    },
    GroupType {
        path: &'static str,
    },
    /// Native support boundary, deliberately not a JavaScript exception claim.
    UnsupportedLegacy {
        path: &'static str,
        bson_type: &'static str,
    },
    Coercion(AiUsageLedgerReadError),
    Mongo(mongodb::error::Error),
}
impl AiUsagePersistenceError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::CastError { .. } => "CastError",
            Self::RangeError { .. } => "RangeError",
            Self::UnsupportedLegacy { .. }
            | Self::Coercion(AiUsageLedgerReadError::UnsupportedLegacyBson { .. }) => {
                "UnsupportedLegacy"
            }
            Self::InputType { .. } | Self::GroupType { .. } | Self::Coercion(_) => "TypeError",
            Self::Mongo(_) => "MongoServerError",
        }
    }
    pub fn path(&self) -> Option<&'static str> {
        match self {
            Self::CastError { path }
            | Self::InputType { path }
            | Self::UnsupportedLegacy { path, .. } => Some(path),
            _ => None,
        }
    }
}
impl fmt::Display for AiUsagePersistenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputType { path } => write!(f, "invalid plain receipt field: {path}"),
            Self::CastError { path } => write!(f, "Mongoose cast failed at {path}"),
            Self::RangeError { .. } => f.write_str("Invalid time value"),
            Self::GroupType { path } => write!(f, "invalid aggregate property: {path}"),
            Self::UnsupportedLegacy { path, bson_type } => {
                write!(f, "unsupported legacy BSON coercion at {path}: {bson_type}")
            }
            Self::Coercion(e) => e.fmt(f),
            Self::Mongo(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for AiUsagePersistenceError {}
impl From<mongodb::error::Error> for AiUsagePersistenceError {
    fn from(e: mongodb::error::Error) -> Self {
        Self::Mongo(e)
    }
}
impl From<AiUsageLedgerReadError> for AiUsagePersistenceError {
    fn from(e: AiUsageLedgerReadError) -> Self {
        Self::Coercion(e)
    }
}
pub type PersistenceResult<T> = Result<T, AiUsagePersistenceError>;
pub type LockedPersistenceResult<T> = Result<T, AiUsageLockError<AiUsagePersistenceError>>;

fn string<'a>(row: &'a JsonValue, path: &'static str) -> PersistenceResult<&'a JsString> {
    match row.get(path) {
        Some(JsonValue::String(value)) => Ok(value),
        _ => Err(AiUsagePersistenceError::InputType { path }),
    }
}
fn category(value: Option<&JsonValue>) -> &'static str {
    normalize_receipt_category(match value {
        Some(JsonValue::String(value)) => value.as_str(),
        _ => None,
    })
}
fn parse(value: &JsString) -> JsDate {
    let ms = value
        .as_str()
        .and_then(parse_date)
        .or_else(|| parse_date_utf16(&value.units()));
    ms.map_or(JsDate::invalid(), |ms| JsDate::from_millis(ms as f64))
}
fn bson_date(value: JsDate, path: &'static str) -> PersistenceResult<DateTime> {
    value
        .timestamp_millis()
        .map(DateTime::from_millis)
        .ok_or(AiUsagePersistenceError::CastError { path })
}
fn iso_day(value: JsDate, operation: &'static str) -> PersistenceResult<String> {
    let iso = value
        .to_iso_string()
        .map_err(|_| AiUsagePersistenceError::RangeError { operation })?;
    Ok(iso[..10].into())
}
fn midnight_from_slice(value: &JsString) -> JsDate {
    let mut units = value.slice(0, 10).units();
    units.extend("T00:00:00.000Z".encode_utf16());
    parse(&JsString::from_units(units))
}
fn plus(value: JsDate, amount: i64) -> JsDate {
    JsDate::from_millis(
        value
            .timestamp_millis()
            .map_or(f64::NAN, |ms| ms as f64 + amount as f64),
    )
}

/// Raw source receiptDocument dates remain invalid until update casting. This
/// is necessary because dashboard dirtying and Date.now precede cast failure.
#[derive(Clone, Debug)]
pub struct ReceiptDocument {
    pub fields: Document,
    pub occurred_at: JsDate,
    pub expires_at: JsDate,
}

/// Source mapping without parser normalization: no trim, finite-number filter,
/// enum enforcement, or JSON stringify/parse boundary. Missing values are kept
/// absent so Mongoose setDefaultsOnInsert applies only the actual defaults.
pub fn receipt_document(
    row: &JsonValue,
    tier: RetentionTier,
) -> PersistenceResult<ReceiptDocument> {
    let occurred_at = parse(string(row, "occurredAt")?);
    let mut fields = Document::new();
    let strings = [
        "channelID",
        "customerId",
        "id",
        "requestId",
        "entryKind",
        "operation",
        "source",
        "adjustmentType",
        "provider",
        "model",
        "unit",
        "resourceType",
        "resourceId",
    ];
    for key in strings {
        if !matches!(
            row.get(key),
            None | Some(JsonValue::Null | JsonValue::String(_))
        ) {
            return Err(AiUsagePersistenceError::InputType { path: key });
        }
    }
    for key in ["quantity", "credits"] {
        if !matches!(
            row.get(key),
            None | Some(JsonValue::Null | JsonValue::Number(_))
        ) {
            return Err(AiUsagePersistenceError::InputType { path: key });
        }
    }
    if !matches!(
        row.get("itemized"),
        None | Some(JsonValue::Null | JsonValue::Bool(_))
    ) {
        return Err(AiUsagePersistenceError::InputType { path: "itemized" });
    }
    let scalar = |v: &JsonValue| match v {
        JsonValue::Null => Bson::Null,
        JsonValue::Bool(v) => Bson::Boolean(*v),
        JsonValue::Number(v) => bson_number(*v),
        JsonValue::String(v) => Bson::String(v.to_utf8_lossy()),
        _ => unreachable!("declared scalar checked"),
    };
    for (target, source) in [
        ("channelID", "channelID"),
        ("customerId", "customerId"),
        ("entryId", "id"),
        ("requestId", "requestId"),
    ] {
        if let Some(value) = row.get(source) {
            fields.insert(target, scalar(value));
        }
    }
    // Placeholder for an invalid Date is never sent: checked below in source
    // reverse update-path order. A sentinel BSON Date would silently TimeClip.
    fields.insert(
        "occurredAt",
        occurred_at
            .timestamp_millis()
            .map_or(Bson::Null, |v| DateTime::from_millis(v).into()),
    );
    if let Some(value) = row.get("entryKind") {
        fields.insert("entryKind", scalar(value));
    }
    fields.insert("category", category(row.get("category")));
    if let Some(value) = row.get("operation") {
        fields.insert("operation", scalar(value));
    }
    fields.insert(
        "source",
        row.get("source")
            .filter(|v| settings::truthy(v))
            .map_or(Bson::Null, scalar),
    );
    let explicit = row.get("adjustmentType").filter(|v| settings::truthy(v));
    let adjustment = if let Some(value) = explicit {
        scalar(value)
    } else {
        let mut input = serde_json::Map::new();
        for key in [
            "entryKind",
            "source",
            "operation",
            "reason",
            "adjustmentType",
        ] {
            if let Some(JsonValue::String(value)) = row.get(key) {
                input.insert(key.into(), serde_json::Value::String(value.to_utf8_lossy()));
            }
        }
        classify_adjustment(&serde_json::Value::Object(input)).map_or(Bson::Null, Bson::from)
    };
    fields.insert("adjustmentType", adjustment);
    for key in [
        "provider",
        "model",
        "quantity",
        "unit",
        "credits",
        "resourceType",
        "resourceId",
        "itemized",
    ] {
        if let Some(value) = row.get(key) {
            fields.insert(key, scalar(value));
        }
    }
    fields.insert("retentionTier", tier.as_str());
    let expires_at = plus(occurred_at, tier.days() * DAY);
    fields.insert(
        "expiresAt",
        expires_at
            .timestamp_millis()
            .map_or(Bson::Null, |v| DateTime::from_millis(v).into()),
    );
    Ok(ReceiptDocument {
        fields,
        occurred_at,
        expires_at,
    })
}

#[derive(Clone, Debug)]
pub struct ReceiptUpsert {
    pub filter: Document,
    pub update: Document,
}

/// Selected Mongoose 8.24.2 updateOne policy, not schema save validation.
/// Reverse caster order checks updated_at then created_at, expiresAt, credits,
/// quantity, occurredAt. Required and enum validators do NOT run on this update.
/// __v is updateOne decoration; defaults follow setDefaultsOnInsert schema order.
pub fn receipt_upsert(
    row: &JsonValue,
    document: &ReceiptDocument,
    middleware_now: JsDate,
) -> PersistenceResult<ReceiptUpsert> {
    let stamp = bson_date(middleware_now, "updated_at")?;
    let mut insert = document.fields.clone();
    insert.insert("__v", 0);
    insert.insert("created_at", stamp);
    bson_date(document.expires_at, "expiresAt")?;
    for key in ["credits", "quantity"] {
        if matches!(insert.get(key), Some(Bson::Double(v)) if v.is_nan()) {
            return Err(AiUsagePersistenceError::CastError { path: key });
        }
    }
    bson_date(document.occurred_at, "occurredAt")?;
    for key in [
        "requestId",
        "source",
        "adjustmentType",
        "model",
        "quantity",
        "unit",
        "resourceType",
        "resourceId",
    ] {
        if !insert.contains_key(key) {
            insert.insert(key, Bson::Null);
        }
    }
    let mut filter = identity(string(row, "channelID")?, string(row, "customerId")?);
    // The MongoDB driver's default ignoreUndefined:false encodes an undefined filter value
    // as null. update $setOnInsert instead removes undefined before defaults.
    filter.insert(
        "entryId",
        row.get("id").map_or(Bson::Null, |v| match v {
            JsonValue::String(v) => Bson::String(v.to_utf8_lossy()),
            _ => Bson::Null,
        }),
    );
    Ok(ReceiptUpsert {
        filter,
        update: doc! {"$set":{"updated_at":stamp},"$setOnInsert":insert},
    })
}
fn identity(channel: &JsString, customer: &JsString) -> Document {
    doc! {"channelID":channel.to_utf8_lossy(),"customerId":customer.to_utf8_lossy()}
}

#[derive(Clone, Debug)]
pub struct DailyRebuildQuery {
    pub pipeline: Vec<Document>,
    pub delete_filter: Document,
    pub from: JsDate,
    pub to: JsDate,
}
pub fn daily_rebuild_range(from: JsDate, to: JsDate) -> PersistenceResult<(JsDate, JsDate)> {
    let from = midnight_from_slice(&iso_day(from, "from.toISOString")?.as_str().into());
    let to = plus(
        midnight_from_slice(&iso_day(to, "to.toISOString")?.as_str().into()),
        DAY - 1,
    );
    Ok((from, to))
}
/// Source slices ISO strings before constructing dates. An extended-year
/// prefix can reparse as the first day of its month; it must not be assumed
/// invalid or replaced with mathematical UTC flooring.
pub fn daily_rebuild_query(
    channel: &JsString,
    customer: &JsString,
    from: JsDate,
    to: JsDate,
    now: JsDate,
) -> PersistenceResult<DailyRebuildQuery> {
    let (from, to) = daily_rebuild_range(from, to)?;
    Ok(daily_rebuild_query_for_range(
        channel, customer, from, to, now,
    ))
}
fn daily_rebuild_query_for_range(
    channel: &JsString,
    customer: &JsString,
    from: JsDate,
    to: JsDate,
    now: JsDate,
) -> DailyRebuildQuery {
    // aggregate is uncast. Node BSON serializes invalid Dates as epoch zero.
    let raw_date = |v: JsDate| DateTime::from_millis(v.timestamp_millis().unwrap_or(0));
    let mut matching = identity(channel, customer);
    matching.insert(
        "occurredAt",
        doc! {"$gte":raw_date(from),"$lte":raw_date(to)},
    );
    matching.insert("expiresAt", doc! {"$gt":raw_date(now)});
    // Source computes these strings after awaiting aggregate. The execution
    // adapter defers this validation until that read has finished.
    let delete_filter = identity(channel, customer);
    DailyRebuildQuery {
        pipeline: vec![
            doc! {"$match":matching},
            doc! {"$group":group_fields(doc! {"date":{"$dateToString":{"date":"$occurredAt","format":"%Y-%m-%d","timezone":"UTC"}},"category":"$category"}, false)},
        ],
        delete_filter,
        from,
        to,
    }
}

// This is the narrow += primitive policy for Mongo's $sum outputs. Promoted
// Int32/Long/Double are JS Numbers. Unpromoted Long and Decimal128 objects have
// string-valued default primitives: 0 + Decimal128('2') is '02', not 2.
#[derive(Clone, Debug)]
enum Sum {
    Number(f64),
    String(JsString),
}
impl Sum {
    fn primitive(value: Option<&Bson>) -> PersistenceResult<Self> {
        let Some(value) = value else {
            return Ok(Self::Number(f64::NAN));
        };
        if let Some(value) = ordinary_json(value) {
            return Ok(match value {
                JsonValue::String(v) => Self::String(v),
                _ => Self::Number(
                    settings::js_number(Some(&value))
                        .map_err(|_| AiUsagePersistenceError::GroupType { path: "sum" })?,
                ),
            });
        }
        Ok(match value {
            Bson::Int64(v) => Self::String(v.to_string().into()),
            Bson::Decimal128(v) => Self::String(v.to_string().into()),
            _ => return Err(AiUsagePersistenceError::GroupType { path: "sum" }),
        })
    }
    fn text(&self) -> JsString {
        match self {
            Self::String(v) => v.clone(),
            Self::Number(v) => super::json_number::number_string(*v).as_str().into(),
        }
    }
    fn add(self, right: Self) -> Self {
        match (self, right) {
            (Self::Number(a), Self::Number(b)) => Self::Number(a + b),
            (a, b) => {
                let mut units = a.text().units();
                units.extend(b.text().code_units());
                Self::String(JsString::from_units(units))
            }
        }
    }
    fn number(&self) -> f64 {
        match self {
            Self::Number(v) => *v,
            Self::String(v) => v
                .as_str()
                .map_or(f64::NAN, super::json_number::string_number),
        }
    }
    fn bson(&self) -> Bson {
        match self {
            Self::Number(v) => bson_number(*v),
            Self::String(v) => Bson::String(v.to_utf8_lossy()),
        }
    }
}
fn bson_truthy(value: Option<&Bson>) -> bool {
    value.is_some_and(|v| ordinary_json(v).is_none_or(|v| settings::truthy(&v)))
}
// The shared adapter's Date/RegExp markers are valid only for Number(array).
// They cannot stand in for Array.join's actual strings when comparing expiry
// values or casting them to Date. Refuse that unsupported projection before
// reduction can reach deleteMany. BSON is an owned, finite, acyclic tree;
// an explicit stack handles nested arrays without recursive call-stack growth.
// Documents are leaves: Object.toString never visits their stored fields.
fn ensure_supported_expiry_projection(value: &Bson) -> PersistenceResult<()> {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        let bson_type = match value {
            Bson::DateTime(_) => Some("Date in expiry array"),
            Bson::RegularExpression(_) => Some("RegExp expiry primitive"),
            Bson::Array(values) => {
                pending.extend(values.iter().rev());
                None
            }
            _ => None,
        };
        if let Some(bson_type) = bson_type {
            return Err(AiUsagePersistenceError::UnsupportedLegacy {
                path: "expiresAt",
                bson_type,
            });
        }
    }
    Ok(())
}
// BSON-specific default primitive projection. Reuse the existing shared
// array/Object coercion core; Date's numeric hint is the one special case for
// relational comparison. This projection is never used for public String().
fn comparison_primitive(value: &Bson) -> PersistenceResult<Sum> {
    if let Bson::DateTime(value) = value {
        return Ok(Sum::Number(
            JsDate::from_millis(value.timestamp_millis() as f64)
                .timestamp_millis()
                .map_or(f64::NAN, |v| v as f64),
        ));
    }
    if matches!(value, Bson::Undefined) {
        return Ok(Sum::Number(f64::NAN));
    }
    // Top-level Date above is supported. Only string projections reach this
    // check, including first-group self-comparison, so rejection precedes any
    // destructive daily replacement even when this is the only group.
    ensure_supported_expiry_projection(value)?;
    if let Some(value) = ordinary_json(value) {
        return Ok(match value {
            JsonValue::Array(_) | JsonValue::Object(_) => Sum::String(
                settings::js_string(&value)
                    .map_err(|_| AiUsagePersistenceError::GroupType { path: "expiresAt" })?,
            ),
            JsonValue::String(v) => Sum::String(v),
            _ => Sum::Number(
                settings::js_number(Some(&value))
                    .map_err(|_| AiUsagePersistenceError::GroupType { path: "expiresAt" })?,
            ),
        });
    }
    let value = array_coercion_value(value)?;
    Ok(Sum::String(settings::js_string(&value).map_err(|_| {
        AiUsagePersistenceError::GroupType { path: "expiresAt" }
    })?))
}
fn relational_greater(left: Option<&Bson>, right: Option<&Bson>) -> PersistenceResult<bool> {
    let (Some(left), Some(right)) = (left, right) else {
        return Ok(false);
    };
    // Mongo expiry maxima can retain malformed legacy strings. JS compares
    // two string primitives lexicographically; Dates use the numeric hint.
    let left = comparison_primitive(left)?;
    let right = comparison_primitive(right)?;
    if let (Sum::String(a), Sum::String(b)) = (&left, &right) {
        return Ok(a.code_units().cmp(b.code_units()).is_gt());
    }
    Ok(left.number() > right.number())
}

#[derive(Clone, Debug)]
pub struct DailyRows {
    rows: Vec<(Bson, DailyRow)>,
}
impl DailyRows {
    pub fn len(&self) -> usize {
        self.rows.len()
    }
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
}
#[derive(Clone, Debug)]
struct DailyRow {
    spent: Sum,
    granted: Sum,
    debited: Sum,
    count: Sum,
    categories: Document,
    expires: Option<Bson>,
}

/// Preserve group encounter order, Map insertion order and normalized-category
/// overwrite. A Decimal/Long count is an object and is truthy even when zero.
pub fn reduce_daily_groups(groups: &[Document]) -> PersistenceResult<DailyRows> {
    let mut rows: Vec<(Bson, DailyRow)> = Vec::new();
    for group in groups {
        let id = group
            .get_document("_id")
            .map_err(|_| AiUsagePersistenceError::GroupType { path: "_id" })?;
        // $dateToString yields only string or null under this exact pipeline.
        let day = id.get("date").cloned().unwrap_or(Bson::Null);
        if !matches!(day, Bson::String(_) | Bson::Null) {
            return Err(AiUsagePersistenceError::GroupType { path: "_id.date" });
        }
        let index = match rows.iter().position(|(key, _)| key == &day) {
            Some(i) => i,
            None => {
                rows.push((
                    day,
                    DailyRow {
                        spent: Sum::Number(0.0),
                        granted: Sum::Number(0.0),
                        debited: Sum::Number(0.0),
                        count: Sum::Number(0.0),
                        categories: Document::new(),
                        expires: group.get("expiresAt").cloned(),
                    },
                ));
                rows.len() - 1
            }
        };
        let row = &mut rows[index].1;
        row.spent = row.spent.clone().add(Sum::primitive(group.get("spent"))?);
        row.granted = row
            .granted
            .clone()
            .add(Sum::primitive(group.get("granted"))?);
        row.debited = row
            .debited
            .clone()
            .add(Sum::primitive(group.get("debited"))?);
        row.count = row.count.clone().add(Sum::primitive(group.get("count"))?);
        if relational_greater(group.get("expiresAt"), row.expires.as_ref())? {
            row.expires = group.get("expiresAt").cloned();
        }
        if bson_truthy(group.get("count")) {
            let cat = match id.get("category") {
                Some(Bson::String(v)) => category(Some(&JsonValue::String(v.as_str().into()))),
                _ => "uncategorized",
            };
            // Mixed categories retain BSON wrapper values; they are NOT cast
            // to daily Number paths. Node default promotions happen on read.
            let mut entry = Document::new();
            for (target, source) in [("credits", "spent"), ("transactionCount", "count")] {
                if let Some(value) = group.get(source) {
                    let mut value = doc! {"v":value.clone()};
                    super::bson_compat::normalize_document(&mut value);
                    entry.insert(target, value.remove("v").expect("inserted"));
                }
            }
            row.categories.insert(cat, entry);
        }
    }
    Ok(DailyRows { rows })
}

fn legacy_date(value: &Bson) -> Option<Bson> {
    // Mongoose Date wrapper path: value.valueOf() then new Date(value). Long
    // and Decimal128 retain their numeric string through ToPrimitive; unlike
    // a primitive string, the millisecond-string special case does not run.
    match value {
        Bson::Int64(_) if ordinary_json(value).is_none() => {
            let s = match value {
                Bson::Int64(v) => v.to_string(),
                _ => unreachable!(),
            };
            parse_date(&s).map(|v| Bson::DateTime(DateTime::from_millis(v)))
        }
        Bson::Decimal128(v) => {
            parse_date(&v.to_string()).map(|v| Bson::DateTime(DateTime::from_millis(v)))
        }
        Bson::Array(values) => {
            let array = JsonValue::Array(
                values
                    .iter()
                    .map(array_coercion_value)
                    .collect::<Result<_, _>>()
                    .ok()?,
            );
            let s = settings::js_string(&array).ok()?;
            let date = parse(&s).timestamp_millis()?;
            Some(Bson::DateTime(DateTime::from_millis(date)))
        }
        value => mongoose_date::cast(value).ok(),
    }
}

/// Mongoose ordered:false insertMany prevalidates every row, silently omits
/// invalid rows, then stamps only valid rows. Delete has already happened.
/// The shared schema core provides defaults/required/enum/minimize casting;
/// wrapper dates and += Number casting are adapted before that selected core.
pub fn prepare_daily_inserts(
    channel: &JsString,
    customer: &JsString,
    tier: RetentionTier,
    rows: &DailyRows,
    clock: &dyn ReceiptClock,
) -> Vec<Document> {
    let mut valid = Vec::new();
    for (date, row) in &rows.rows {
        let mut input = identity(channel, customer);
        input.insert("date", date.clone());
        let date_text = match date {
            Bson::String(v) => v.as_str(),
            Bson::Null => "null",
            _ => unreachable!(),
        };
        let day_start = parse(&format!("{date_text}T00:00:00.000Z").as_str().into());
        let Some(ms) = day_start.timestamp_millis() else {
            continue;
        };
        input.insert("dayStart", DateTime::from_millis(ms));
        input.insert("spentCredits", row.spent.bson());
        input.insert("grantedCredits", row.granted.bson());
        let net = row.spent.clone().add(row.debited.clone()).number() - row.granted.number();
        input.insert("netConsumedCredits", bson_number(net));
        input.insert("transactionCount", row.count.bson());
        input.insert("categories", row.categories.clone());
        input.insert("retentionTier", tier.as_str());
        if let Some(expiry) = row.expires.as_ref().and_then(legacy_date) {
            input.insert("expiresAt", expiry);
        } else {
            continue;
        }
        // Validation occurs before initializeTimestamps, whose assignments do
        // not get revalidated. In particular an invalid middleware clock does
        // not prevent this insertMany; failed timestamp setters leave missing.
        let Ok(mut document) = ai_usage_daily::schema().construct(&input, DateTime::from_millis(0))
        else {
            continue;
        };
        // The pinned actual-source oracle emits daily fields in schema order.
        // construct already provides that order; moving defaults to the front
        // changes BSON bytes despite equal values. Append only the selected
        // insertMany version/timestamp middleware fields below.
        document.insert("__v", 0);
        if let Some(ms) = clock.now().timestamp_millis() {
            let stamp = DateTime::from_millis(ms);
            document.insert("created_at", stamp);
            document.insert("updated_at", stamp);
        }
        valid.push(document);
    }
    valid
}

#[derive(Clone)]
pub struct MongoAiUsageLedgerPersistence {
    dashboards: Collection<Document>,
    receipts: Collection<Document>,
    daily: Collection<Document>,
    lock: AiUsageLock,
    application_clock: Arc<dyn ReceiptClock>,
    middleware_clock: Arc<dyn ReceiptClock>,
}
impl MongoAiUsageLedgerPersistence {
    pub fn new(database: &Database, cache: ConnectionManager) -> Self {
        Self::with_clocks(
            database,
            cache,
            Arc::new(SystemReceiptClock),
            Arc::new(SystemReceiptClock),
        )
    }
    pub fn with_clocks(
        database: &Database,
        cache: ConnectionManager,
        application_clock: Arc<dyn ReceiptClock>,
        middleware_clock: Arc<dyn ReceiptClock>,
    ) -> Self {
        Self {
            dashboards: ai_usage_dashboard::schema().native_collection(database),
            receipts: ai_usage_receipt::schema().native_collection(database),
            daily: ai_usage_daily::schema().native_collection(database),
            lock: AiUsageLock::new(cache),
            application_clock,
            middleware_clock,
        }
    }
    pub fn receipt_collection(&self) -> &Collection<Document> {
        &self.receipts
    }
    pub fn daily_collection(&self) -> &Collection<Document> {
        &self.daily
    }
    pub fn dashboard_collection(&self) -> &Collection<Document> {
        &self.dashboards
    }

    /// Borrow the producer's original structured receipt, including NaN. Do
    /// not send it through parseQueuedAiUsageReceipt: that changes semantics.
    pub async fn persist_ai_usage_receipt(
        &self,
        receipt: &QueuedAiUsageReceipt,
        tier: &JsonValue,
    ) -> LockedPersistenceResult<PersistAiUsageReceiptOutcome> {
        self.persist_value(receipt.as_value(), tier).await
    }
    pub async fn persist_parsed_receipt(
        &self,
        receipt: &ParsedAiUsageReceipt,
        tier: &JsonValue,
    ) -> LockedPersistenceResult<PersistAiUsageReceiptOutcome> {
        self.persist_value(&receipt.as_value(), tier).await
    }
    pub async fn persist_value(
        &self,
        receipt: &JsonValue,
        tier: &JsonValue,
    ) -> LockedPersistenceResult<PersistAiUsageReceiptOutcome> {
        let channel = string(receipt, "channelID").map_err(AiUsageLockError::Callback)?;
        let customer = string(receipt, "customerId").map_err(AiUsageLockError::Callback)?;
        self.lock.with(channel,customer,|| async {
            let tier=RetentionTier::from_value(tier);
            self.dashboards.update_many(identity(channel,customer),doc! {"$set":{"dirty":true}}).await?;
            let document=receipt_document(receipt,tier)?;
            let now=self.application_clock.now();
            if matches!((document.expires_at.timestamp_millis(),now.timestamp_millis()),(Some(expiry),Some(now)) if expiry<=now) { return Ok(PersistAiUsageReceiptOutcome::Expired) }
            let upsert=receipt_upsert(receipt,&document,self.middleware_clock.now())?;
            let result=self.receipts.update_one(upsert.filter,upsert.update).upsert(true).await?;
            let day=midnight_from_slice(string(receipt,"occurredAt")?);
            self.rebuild_utc_daily_aggregates(channel,customer,tier,day,plus(day,DAY-1)).await?;
            Ok(if result.upserted_id.is_some() { PersistAiUsageReceiptOutcome::Inserted } else { PersistAiUsageReceiptOutcome::Duplicate })
        }).await
    }

    /// The source private helper itself does not acquire a lock. Public native
    /// callers must already own this account's lock (persist does), or arrange
    /// equivalent exclusive ownership. Intended for future backfill reuse.
    pub async fn rebuild_utc_daily_aggregates(
        &self,
        channel: &JsString,
        customer: &JsString,
        tier: RetentionTier,
        from: JsDate,
        to: JsDate,
    ) -> PersistenceResult<()> {
        // The from/to ISO operations precede the aggregate's new Date clock.
        let (from, to) = daily_rebuild_range(from, to)?;
        let query = daily_rebuild_query_for_range(
            channel,
            customer,
            from,
            to,
            self.application_clock.now(),
        );
        let groups: Vec<Document> = self
            .receipts
            .aggregate(query.pipeline)
            .await?
            .try_collect()
            .await?;
        let rows = reduce_daily_groups(&groups)?;
        let from_date = iso_day(from, "from.toISOString after aggregate")?;
        let to_date = iso_day(to, "to.toISOString after aggregate")?;
        let mut filter = query.delete_filter;
        filter.insert("date", doc! {"$gte":from_date,"$lte":to_date});
        self.daily.delete_many(filter).await?;
        let documents = prepare_daily_inserts(
            channel,
            customer,
            tier,
            &rows,
            self.middleware_clock.as_ref(),
        );
        if !documents.is_empty() {
            self.daily.insert_many(documents).ordered(false).await?;
        }
        Ok(())
    }
}
