//! Concrete request-time `backfillAiUsageLedger`; no constructor I/O.
//!
//! Requires MongoDB 8.0+ for the existing driver's `Client::bulk_write` API
//! (the repository's disposable fixture is mongo:8.2.6). Collection/database
//! write concern is passed explicitly, rather than accidentally inheriting only
//! the client's concern. Driver size splitting, partial results and retryable
//! write protocol remain owned by the driver. This adapter never retries an
//! application operation, including an uncertain transport/cancellation result.
//!
//! Plain data uses the producer's lossless UTF-16/binary64 carrier. Prototypes,
//! executable coercion hooks and BSON wrapper objects are outside that carrier.
//! Daily repair retains the persistence adapter's explicit legacy BSON boundary.
use super::{
    ai_usage::{classify_adjustment, normalize_receipt_category},
    ai_usage_ledger_persistence::{
        AiUsagePersistenceError, MongoAiUsageLedgerPersistence, ReceiptDocument, ReceiptUpsert,
        receipt_document,
    },
    ai_usage_lock::{AiUsageLock, AiUsageLockError},
    ai_usage_producer::{QueuedAiUsageReceipt, ReceiptClock, SystemReceiptClock},
    ai_usage_receipt_parser::RetentionTier,
    bson_compat::js_number,
    credit_policy::JsDate,
    js_date::{parse_date, parse_date_utf16},
    js_string::JsString,
    lossless_json::JsonValue,
    tts::settings,
};
use crate::schemas::{FieldDefault, SchemaDefinition, ai_usage_ledger_state, ai_usage_receipt};
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc},
    error::ErrorKind,
    options::UpdateOneModel,
};
use redis::aio::ConnectionManager;
use std::{
    fmt,
    sync::{Arc, OnceLock},
};

pub const AI_USAGE_REPORT_VERSION: i32 = 3;
pub const BACKFILL_BATCH_SIZE: usize = 500;
const DAY: i64 = 86_400_000;

#[derive(Clone, Debug)]
pub struct AiUsageLedgerBackfillInput {
    pub channel_id: JsString,
    pub customer_id: JsString,
    pub plan_tier: JsonValue,
    pub coverage_start: JsDate,
    pub rebuild_start: Option<JsDate>,
    pub transactions: Vec<JsonValue>,
    pub now: Option<JsDate>,
}
impl AiUsageLedgerBackfillInput {
    /// Borrowing the producer DTO never serializes NaN or replaces lone units.
    pub fn with_receipts(mut self, receipts: &[QueuedAiUsageReceipt]) -> Self {
        self.transactions = receipts.iter().map(|r| r.as_value().clone()).collect();
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BulkCastFailure {
    /// Index in this source batch, before cast-invalid operations are omitted.
    pub index: usize,
    pub path: &'static str,
}
#[derive(Debug)]
pub struct BackfillBulkFailure {
    pub filtered_offset: usize,
    /// Driver indices address this vector. Values address original transactions.
    pub transaction_indices: Vec<usize>,
    pub skipped: Vec<BulkCastFailure>,
    /// Includes native write concern errors, partial results and error source.
    pub source: mongodb::error::Error,
}
impl BackfillBulkFailure {
    /// Preserve both the driver's compact valid-op index and the original input.
    pub fn write_error_indices(&self) -> Vec<(usize, usize)> {
        let ErrorKind::BulkWrite(error) = self.source.kind.as_ref() else {
            return Vec::new();
        };
        let mut indices = error
            .write_errors
            .keys()
            .filter_map(|index| {
                self.transaction_indices
                    .get(*index)
                    .map(|original| (*index, *original))
            })
            .collect::<Vec<_>>();
        indices.sort_unstable();
        indices
    }
}
#[derive(Debug)]
pub enum AiUsageBackfillError {
    Policy(AiUsagePersistenceError),
    Bulk(BackfillBulkFailure),
}
impl fmt::Display for AiUsageBackfillError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Policy(error) => error.fmt(f),
            Self::Bulk(error) => error.source.fmt(f),
        }
    }
}
impl std::error::Error for AiUsageBackfillError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Policy(e) => Some(e),
            Self::Bulk(e) => Some(&e.source),
        }
    }
}
impl From<AiUsagePersistenceError> for AiUsageBackfillError {
    fn from(error: AiUsagePersistenceError) -> Self {
        Self::Policy(error)
    }
}
impl From<mongodb::error::Error> for AiUsageBackfillError {
    fn from(error: mongodb::error::Error) -> Self {
        Self::Policy(AiUsagePersistenceError::Mongo(error))
    }
}
pub type BackfillResult<T> = Result<T, AiUsageBackfillError>;
pub type LockedBackfillResult<T> = Result<T, AiUsageLockError<AiUsageBackfillError>>;

fn identity(channel: &JsString, customer: &JsString) -> Document {
    doc! {"channelID":channel.to_utf8_lossy(),"customerId":customer.to_utf8_lossy()}
}
fn set(row: &mut JsonValue, key: &'static str, value: JsonValue) {
    let JsonValue::Object(fields) = row else {
        unreachable!()
    };
    if let Some((_, previous)) = fields
        .iter_mut()
        .find(|(name, _)| name.as_str() == Some(key))
    {
        *previous = value;
    } else {
        fields.push((key.into(), value));
    }
}
fn raw_bson(value: &JsonValue) -> Bson {
    match value {
        JsonValue::Null => Bson::Null,
        JsonValue::Bool(v) => Bson::Boolean(*v),
        JsonValue::Number(v) => js_number(*v),
        JsonValue::String(v) => Bson::String(v.to_utf8_lossy()),
        JsonValue::Array(v) => Bson::Array(v.iter().map(raw_bson).collect()),
        JsonValue::Object(v) => Bson::Document(
            v.iter()
                .map(|(k, v)| (k.to_utf8_lossy(), raw_bson(v)))
                .collect(),
        ),
    }
}
/// `new Date(value)`, distinct from Mongoose's millisecond-string caster.
/// Missing is undefined (invalid); explicit null is the epoch.
pub fn transaction_date(value: Option<&JsonValue>) -> Result<JsDate, AiUsagePersistenceError> {
    Ok(match value {
        None => JsDate::invalid(),
        Some(JsonValue::Null) => JsDate::from_millis(0.0),
        Some(JsonValue::Number(v)) => JsDate::from_millis(*v),
        Some(JsonValue::Bool(v)) => JsDate::from_millis(if *v { 1.0 } else { 0.0 }),
        Some(v) => {
            let string = settings::js_string(v)
                .map_err(|_| AiUsagePersistenceError::GroupType { path: "occurredAt" })?;
            string
                .as_str()
                .and_then(parse_date)
                .or_else(|| parse_date_utf16(&string.units()))
                .map_or(JsDate::invalid(), |v| JsDate::from_millis(v as f64))
        }
    })
}
#[derive(Clone, Debug)]
pub struct BackfillReceipt {
    pub transaction_index: usize,
    pub value: JsonValue,
}
/// Mapping/filtering is complete before the first receipt batch is written.
/// A Date object, even invalid, is truthy: Some(invalid) is never replaced.
pub fn filter_backfill_receipts(
    input: &AiUsageLedgerBackfillInput,
    now: JsDate,
) -> Result<Vec<BackfillReceipt>, AiUsagePersistenceError> {
    let floor = now
        .timestamp_millis()
        .map(|now| now as f64 - (RetentionTier::from_value(&input.plan_tier).days() * DAY) as f64);
    let mut receipts = Vec::new();
    for (index, transaction) in input.transactions.iter().enumerate() {
        // Object spread permits null/scalar inputs; none has occurredAt.
        let mut value = if matches!(transaction, JsonValue::Object(_)) {
            transaction.clone()
        } else {
            JsonValue::Object(Vec::new())
        };
        set(
            &mut value,
            "channelID",
            JsonValue::String(input.channel_id.clone()),
        );
        set(
            &mut value,
            "customerId",
            JsonValue::String(input.customer_id.clone()),
        );
        let occurred = transaction_date(value.get("occurredAt"))?;
        if matches!((occurred.timestamp_millis(),floor),(Some(occurred),Some(floor)) if occurred as f64 >= floor)
        {
            receipts.push(BackfillReceipt {
                transaction_index: index,
                value,
            });
        }
    }
    Ok(receipts)
}

// Keep the normal producer path on the shared mapper. This fallback broadens
// only its declared scalar boundary for malformed ordinary bulk input; it does
// not add a second classifier, Date parser, category registry or schema caster.
fn mapped_receipt(
    row: &JsonValue,
    tier: RetentionTier,
) -> Result<ReceiptDocument, AiUsagePersistenceError> {
    match receipt_document(row, tier) {
        Ok(document) => return Ok(document),
        Err(AiUsagePersistenceError::InputType { .. }) => {}
        Err(error) => return Err(error),
    }
    let occurred_at = transaction_date(row.get("occurredAt"))?;
    let expires_at = JsDate::from_millis(
        occurred_at
            .timestamp_millis()
            .map_or(f64::NAN, |v| v as f64 + (tier.days() * DAY) as f64),
    );
    let mut fields = Document::new();
    for (target, source) in [
        ("channelID", "channelID"),
        ("customerId", "customerId"),
        ("entryId", "id"),
        ("requestId", "requestId"),
    ] {
        if let Some(value) = row.get(source) {
            fields.insert(target, raw_bson(value));
        }
    }
    fields.insert(
        "occurredAt",
        occurred_at
            .timestamp_millis()
            .map_or(Bson::Null, |v| DateTime::from_millis(v).into()),
    );
    if let Some(value) = row.get("entryKind") {
        fields.insert("entryKind", raw_bson(value));
    }
    fields.insert(
        "category",
        normalize_receipt_category(match row.get("category") {
            Some(JsonValue::String(s)) => s.as_str(),
            _ => None,
        }),
    );
    if let Some(value) = row.get("operation") {
        fields.insert("operation", raw_bson(value));
    }
    fields.insert(
        "source",
        row.get("source")
            .filter(|v| settings::truthy(v))
            .map_or(Bson::Null, raw_bson),
    );
    let adjustment = if let Some(value) = row.get("adjustmentType").filter(|v| settings::truthy(v))
    {
        raw_bson(value)
    } else if !matches!(row.get("entryKind"),Some(JsonValue::String(v)) if v.as_str()==Some("adjustment"))
    {
        Bson::Null
    } else {
        let mut projection = serde_json::Map::new();
        for key in [
            "entryKind",
            "source",
            "operation",
            "reason",
            "adjustmentType",
        ] {
            if let Some(value) = row.get(key) {
                let text = match value {
                    JsonValue::String(s) => s.clone(),
                    _ if ["source", "operation"].contains(&key) && settings::truthy(value) => {
                        settings::js_string(value)
                            .map_err(|_| AiUsagePersistenceError::GroupType { path: key })?
                    }
                    _ => continue,
                };
                projection.insert(key.into(), serde_json::Value::String(text.to_utf8_lossy()));
            }
        }
        classify_adjustment(&projection.into()).map_or(Bson::Null, Bson::from)
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
            fields.insert(key, raw_bson(value));
        }
    }
    fields.insert("retentionTier", tier.as_str());
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

// Reuse application schema field casting without save validators, defaults,
// ObjectId entropy or save hooks. Query updateOne does not run save validation.
fn cast_field(path: &'static str, value: Bson) -> Result<Bson, AiUsagePersistenceError> {
    static FIELDS: OnceLock<Vec<SchemaDefinition>> = OnceLock::new();
    let schemas = FIELDS.get_or_init(|| {
        ai_usage_receipt::schema()
            .fields
            .iter()
            .map(|field| {
                let mut field = field.clone();
                field.required = false;
                field.required_when = None;
                field.enum_values = &[];
                field.default = FieldDefault::Missing;
                SchemaDefinition {
                    model: "bulk_field",
                    collection: "unused",
                    fields: vec![field],
                    string_id: true,
                    version_key: false,
                    write_concern_journaled: false,
                    timestamps: None,
                    save_clock_field: None,
                    indexes: vec![],
                }
            })
            .collect()
    });
    let schema = schemas
        .iter()
        .find(|s| s.fields[0].name == path)
        .expect("receipt field");
    // Mongoose's document-like String shortcut requires a truthy string _id.
    // Shared save casting accepts an empty _id, so isolate that bulk edge.
    if matches!(&schema.fields[0].kind, crate::schemas::FieldType::String)
        && matches!(&value,Bson::Document(document) if document.get_str("_id").ok()==Some(""))
    {
        return Err(AiUsagePersistenceError::CastError { path });
    }
    let mut input = Document::new();
    input.insert(path, value);
    schema
        .construct(&input, DateTime::from_millis(0))
        .map_err(|_| AiUsagePersistenceError::CastError { path })?
        .remove(path)
        .ok_or(AiUsagePersistenceError::CastError { path })
}
fn stamp(value: JsDate, path: &'static str) -> Result<DateTime, AiUsagePersistenceError> {
    value
        .timestamp_millis()
        .map(DateTime::from_millis)
        .ok_or(AiUsagePersistenceError::CastError { path })
}
/// Bulk cast order: filter first, then $set in reverse path order, then
/// $setOnInsert in reverse order. Nullable missing fields stay absent because
/// source receiptDocument has own undefined paths when defaults are evaluated.
pub fn backfill_receipt_upsert(
    row: &JsonValue,
    document: &ReceiptDocument,
    now: JsDate,
) -> Result<ReceiptUpsert, AiUsagePersistenceError> {
    let mut filter = Document::new();
    for (path, source) in [
        ("channelID", "channelID"),
        ("customerId", "customerId"),
        ("entryId", "id"),
    ] {
        let value = row.get(source).map(raw_bson).unwrap_or(Bson::Null);
        let value = if let Bson::Array(values) = value {
            doc! {"$in":values.into_iter().map(|v|cast_field(path,v)).collect::<Result<Vec<_>,_>>()?}.into()
        } else {
            cast_field(path, value)?
        };
        filter.insert(path, value);
    }
    let timestamp = stamp(now, "updated_at")?;
    let mut insert = document.fields.clone();
    let source = insert.remove("source").expect("mapper source");
    let adjustment = insert.remove("adjustmentType").expect("mapper adjustment");
    let adjustment = cast_field("adjustmentType", adjustment)?;
    let source = cast_field("source", source)?;
    insert.insert("created_at", timestamp);
    insert.insert("__v", 0);
    stamp(document.expires_at, "expiresAt")?;
    // Visits retain the original insertion order in the returned document.
    for path in [
        "itemized",
        "resourceId",
        "resourceType",
        "credits",
        "unit",
        "quantity",
        "model",
        "provider",
        "operation",
        "entryKind",
    ] {
        if let Some(value) = insert.get(path).cloned() {
            insert.insert(path, cast_field(path, value)?);
        }
    }
    stamp(document.occurred_at, "occurredAt")?;
    for path in ["requestId", "entryId", "customerId", "channelID"] {
        if let Some(value) = insert.get(path).cloned() {
            insert.insert(path, cast_field(path, value)?);
        }
    }
    Ok(ReceiptUpsert {
        filter,
        update: doc! {"$set":{"source":source,"adjustmentType":adjustment,"updated_at":timestamp},"$setOnInsert":insert},
    })
}
#[derive(Clone, Debug)]
pub struct PreparedBackfillBatch {
    pub operations: Vec<ReceiptUpsert>,
    pub transaction_indices: Vec<usize>,
    pub skipped: Vec<BulkCastFailure>,
}
/// Build source operations first, sample every middleware clock second, then
/// cast. Default unordered Mongoose drops invalid operations and resolves an
/// entirely invalid batch; it does not turn a cast error into a whole-run error.
pub fn prepare_backfill_batch(
    rows: &[BackfillReceipt],
    tier: RetentionTier,
    clock: &dyn ReceiptClock,
) -> Result<PreparedBackfillBatch, AiUsagePersistenceError> {
    let documents = rows
        .iter()
        .map(|row| mapped_receipt(&row.value, tier))
        .collect::<Result<Vec<_>, _>>()?;
    let stamps = rows.iter().map(|_| clock.now()).collect::<Vec<_>>();
    let mut batch = PreparedBackfillBatch {
        operations: vec![],
        transaction_indices: vec![],
        skipped: vec![],
    };
    for (index, ((row, document), now)) in rows.iter().zip(documents.iter()).zip(stamps).enumerate()
    {
        match backfill_receipt_upsert(&row.value, document, now) {
            Ok(operation) => {
                batch.operations.push(operation);
                batch.transaction_indices.push(row.transaction_index);
            }
            Err(AiUsagePersistenceError::CastError { path }) => {
                batch.skipped.push(BulkCastFailure { index, path })
            }
            Err(error) => return Err(error),
        }
    }
    Ok(batch)
}
pub fn backfill_state_upsert(
    input: &AiUsageLedgerBackfillInput,
    now: JsDate,
    middleware_now: JsDate,
) -> Result<ReceiptUpsert, AiUsagePersistenceError> {
    let created = stamp(middleware_now, "created_at")?;
    let backfilled = stamp(now, "backfilledAt")?;
    let coverage = stamp(input.coverage_start, "coverageStart")?;
    let identity = identity(&input.channel_id, &input.customer_id);
    let mut insert = identity.clone();
    insert.insert("__v", 0);
    insert.insert("created_at", created);
    Ok(ReceiptUpsert {
        filter: identity,
        update: doc! {
            "$setOnInsert":insert,"$set":{"backfilledAt":backfilled,"reportVersion":AI_USAGE_REPORT_VERSION,"updated_at":created},
            "$min":{"coverageStart":coverage}
        },
    })
}

#[derive(Clone)]
pub struct MongoAiUsageLedgerBackfill {
    persistence: MongoAiUsageLedgerPersistence,
    states: Collection<Document>,
    lock: AiUsageLock,
    application_clock: Arc<dyn ReceiptClock>,
    middleware_clock: Arc<dyn ReceiptClock>,
}
impl MongoAiUsageLedgerBackfill {
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
            persistence: MongoAiUsageLedgerPersistence::with_clocks(
                database,
                cache.clone(),
                application_clock.clone(),
                middleware_clock.clone(),
            ),
            states: ai_usage_ledger_state::schema().native_collection(database),
            lock: AiUsageLock::new(cache),
            application_clock,
            middleware_clock,
        }
    }
    pub fn persistence(&self) -> &MongoAiUsageLedgerPersistence {
        &self.persistence
    }
    pub fn state_collection(&self) -> &Collection<Document> {
        &self.states
    }
    pub async fn backfill_ai_usage_ledger(
        &self,
        input: &AiUsageLedgerBackfillInput,
    ) -> LockedBackfillResult<()> {
        self.lock
            .with(&input.channel_id, &input.customer_id, || async {
                self.persistence
                    .dashboard_collection()
                    .update_many(
                        identity(&input.channel_id, &input.customer_id),
                        doc! {"$set":{"dirty":true}},
                    )
                    .await?;
                let tier = RetentionTier::from_value(&input.plan_tier);
                let now = input.now.unwrap_or_else(|| self.application_clock.now());
                let receipts = filter_backfill_receipts(input, now)?;
                for (batch_number, rows) in receipts.chunks(BACKFILL_BATCH_SIZE).enumerate() {
                    let batch = prepare_backfill_batch(rows, tier, self.middleware_clock.as_ref())?;
                    if !batch.operations.is_empty() {
                        let collection = self.persistence.receipt_collection();
                        let operations = batch
                            .operations
                            .into_iter()
                            .map(|operation| {
                                UpdateOneModel::builder()
                                    .namespace(collection.namespace())
                                    .filter(operation.filter)
                                    .update(operation.update)
                                    .upsert(true)
                                    .build()
                            })
                            .collect::<Vec<_>>();
                        let mut write = collection.client().bulk_write(operations).ordered(false);
                        if let Some(concern) = collection.write_concern() {
                            write = write.write_concern(concern.clone());
                        }
                        if let Err(source) = write.await {
                            return Err(AiUsageBackfillError::Bulk(BackfillBulkFailure {
                                filtered_offset: batch_number * BACKFILL_BATCH_SIZE,
                                transaction_indices: batch.transaction_indices,
                                skipped: batch.skipped,
                                source,
                            }));
                        }
                    }
                    // Cooperate at the bounded batch boundary without sleeping
                    // while ready work exists or changing the existing lock waits.
                    tokio::task::yield_now().await;
                }
                self.persistence
                    .rebuild_utc_daily_aggregates(
                        &input.channel_id,
                        &input.customer_id,
                        tier,
                        input.rebuild_start.unwrap_or(input.coverage_start),
                        now,
                    )
                    .await?;
                let state = backfill_state_upsert(input, now, self.middleware_clock.now())?;
                self.states
                    .find_one_and_update(state.filter, state.update)
                    .upsert(true)
                    .await?;
                Ok(())
            })
            .await
    }
}
