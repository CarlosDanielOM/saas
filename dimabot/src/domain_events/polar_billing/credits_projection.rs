//! Polar AI-credit snapshot projection.
//!
//! Source contract: `dimabot/src/domain_events/polar_billing_events.ts`
//! (`applyPolarCreditsDomainEvent`) and the `LEGACY_USAGE_METER_ID` fallback.
//!
//! Preserved behaviour:
//! - the filter (`source == 'polar-webhook'`, `type == 'billing.customer.state.changed'`)
//!   and the `Polar credit snapshot is missing meters` rejection before any
//!   ownership or persistence effect;
//! - the guarded write on `polar_credit_snapshot.occurredAt` /
//!   `polar_credit_snapshot.eventKey`, followed by the fallback read of the
//!   **current** stored snapshot, so a stale event still publishes the newest
//!   authoritative plan and accounts instead of its own;
//! - the AI-credit snapshot from `utils::ai_credit_projection`, the legacy
//!   usage-meter `balance` fallback when the AI meter is absent, and the
//!   `''`/`'1'`/`'0'` exhaustion flag;
//! - the padded `${String(occurredAt.getTime()).padStart(13, '0')}:${eventKey}`
//!   snapshot version, the plan version, the payload spread of
//!   `PLAN_CACHE_VERSION_FIELD`, and the empty payload when no credits exist;
//! - one `SYNC_CREDITS_SCRIPT` evaluation per owner Twitch account with the
//!   source's exact five keys and four arguments.
//!
//! Deliberately NOT here: MongoDB execution (documents are built here and run by
//! the injected store), the Lua script itself (owned by
//! `utils::plan_cache_fence::SYNC_CREDITS_SCRIPT`), event normalization, and the
//! HTTP route.

use super::{
    MISSING_METERS, PolarBillingContext, PolarBillingError, SNAPSHOT_MISSING,
    SNAPSHOT_NOT_PERSISTED, payload_object, payload_value, resolve_event_owner,
};
use crate::domain_event_contracts::DomainEventEnvelope;
use crate::utils::{
    ai_credit_projection::{
        AI_CREDITS_CACHE_TTL_SECONDS, AI_CREDITS_METER_ID, build_ai_credits_data_from_meter,
    },
    credit_policy::JsDate,
    js_date::parse_date,
    js_string::JsString,
    lossless_json::JsonValue,
    plan_cache_fence::{Exhaustion, PLAN_CACHE_VERSION_FIELD, TtlSeconds, plan_cache_version},
};
use mongodb::bson::{Bson, DateTime, Document, doc, oid::ObjectId};
use serde_json::Value;

const STATE_CHANGED: &str = "billing.customer.state.changed";
/// `LEGACY_USAGE_METER_ID`: the pre-AI-credit usage meter.
pub const LEGACY_USAGE_METER_ID: &str = "01d90c16-87d0-4e31-880a-4045a8da90cd";

/// The consumer's event filter, exactly the `domain_event_consumers` filter.
pub fn is_polar_credits_event(event: &DomainEventEnvelope) -> bool {
    event.source() == Some("polar-webhook") && event.event_type() == Some(STATE_CHANGED)
}

fn bson_instant(millis: i64) -> Bson {
    Bson::DateTime(DateTime::from_millis(millis))
}

/// The `findOneAndUpdate` filter: the same occurrence-then-key ordering fence as
/// the plan watermark, scoped to `polar_credit_snapshot`.
pub fn credit_snapshot_filter(
    owner_id: ObjectId,
    occurred_at: i64,
    event_key: &str,
) -> Document {
    doc! {
        "_id": owner_id,
        "$or": [
            doc! { "polar_credit_snapshot.occurredAt": doc! { "$exists": false } },
            doc! { "polar_credit_snapshot.occurredAt": doc! { "$lt": bson_instant(occurred_at) } },
            doc! {
                "polar_credit_snapshot.occurredAt": bson_instant(occurred_at),
                "polar_credit_snapshot.eventKey": doc! { "$lte": event_key },
            },
        ],
    }
}

/// The `$set` document: the whole snapshot is replaced, as in the source.
pub fn credit_snapshot_update(
    occurred_at: i64,
    event_key: &str,
    meters: &[Document],
) -> Document {
    doc! {
        "$set": {
            "polar_credit_snapshot": {
                "occurredAt": bson_instant(occurred_at),
                "eventKey": event_key,
                "meters": meters.to_vec(),
            },
        },
    }
}

fn event_occurred_at(event: &DomainEventEnvelope) -> Result<i64, PolarBillingError> {
    let text = event
        .occurred_at()
        .and_then(Value::as_str)
        .ok_or_else(|| PolarBillingError::Serialization("occurredAt must be an ISO date".into()))?;
    parse_date(text).ok_or_else(|| {
        PolarBillingError::Serialization("occurredAt must be a finite date".into())
    })
}

fn json_from_bson(value: &Bson) -> Result<JsonValue, PolarBillingError> {
    Ok(match value {
        Bson::Null | Bson::Undefined => JsonValue::Null,
        Bson::Boolean(value) => JsonValue::Bool(*value),
        Bson::Int32(value) => JsonValue::Number(f64::from(*value)),
        Bson::Int64(value) => JsonValue::Number(*value as f64),
        Bson::Double(value) => JsonValue::Number(*value),
        Bson::String(value) => JsonValue::String(value.as_str().into()),
        Bson::Array(values) => JsonValue::Array(
            values
                .iter()
                .map(json_from_bson)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Bson::Document(document) => json_from_document(document)?,
        _ => {
            return Err(PolarBillingError::Serialization(
                "Polar credit meter contains a non-JSON value".into(),
            ));
        }
    })
}

fn json_from_document(document: &Document) -> Result<JsonValue, PolarBillingError> {
    let mut fields = Vec::with_capacity(document.len());
    for (key, value) in document {
        fields.push((key.as_str().into(), json_from_bson(value)?));
    }
    Ok(JsonValue::Object(fields))
}

fn bson_number(document: &Document, key: &str) -> Option<f64> {
    match document.get(key)? {
        Bson::Int32(value) => Some(f64::from(*value)),
        Bson::Int64(value) => Some(*value as f64),
        Bson::Double(value) => Some(*value),
        _ => None,
    }
}

fn meter_by_id<'a>(meters: &'a [Document], meter_id: &str) -> Option<&'a Document> {
    meters
        .iter()
        .find(|meter| meter.get_str("meter_id").ok() == Some(meter_id))
}

/// The `credits?.balance ?? legacyMeter?.balance` value used for exhaustion.
pub fn snapshot_balance(
    credits: Option<&JsonValue>,
    meters: &[Document],
) -> Option<f64> {
    let from_credits = credits
        .and_then(|credits| credits.get("balance"))
        .and_then(|balance| match balance {
            JsonValue::Number(value) => Some(*value),
            _ => None,
        });
    from_credits.or_else(|| {
        meter_by_id(meters, LEGACY_USAGE_METER_ID).and_then(|meter| bson_number(meter, "balance"))
    })
}

/// `balance === undefined ? '' : balance <= 0 ? '1' : '0'`.
pub fn exhaustion_for_balance(balance: Option<f64>) -> Exhaustion {
    match balance {
        None => Exhaustion::Keep,
        Some(balance) if balance <= 0.0 => Exhaustion::Exhausted,
        Some(_) => Exhaustion::Available,
    }
}

/// `${String(occurredAt.getTime()).padStart(13, '0')}:${eventKey}`.
pub fn snapshot_version(occurred_at: i64, event_key: &str) -> String {
    format!("{occurred_at:0>13}:{event_key}")
}

fn credits_payload(
    credits: Option<&JsonValue>,
    plan_version: &str,
) -> Option<String> {
    let credits = credits?;
    let mut payload = credits.clone();
    if !plan_version.is_empty() {
        if let JsonValue::Object(fields) = &mut payload {
            // `{ ...credits, ...(planVersion ? { [PLAN_CACHE_VERSION_FIELD]: planVersion } : {}) }`
            fields.push((
                PLAN_CACHE_VERSION_FIELD.into(),
                JsonValue::String(plan_version.into()),
            ));
        }
    }
    Some(payload.to_json_string())
}

/// `applyPolarCreditsDomainEvent`.
pub async fn apply_polar_credits_domain_event(
    event: &DomainEventEnvelope,
    context: &PolarBillingContext<'_>,
) -> Result<(), PolarBillingError> {
    if !is_polar_credits_event(event) {
        return Ok(());
    }
    let payload = payload_object(event);
    let Some(meters) = payload_value(payload, "meters").and_then(Value::as_array) else {
        return Err(PolarBillingError::Business(MISSING_METERS.into()));
    };
    let owner = resolve_event_owner(event, context.store, context.owner_resolver).await?;
    let occurred_at = event_occurred_at(event)?;
    let event_key = event
        .event_key()
        .ok_or_else(|| PolarBillingError::Serialization("eventKey is required".into()))?;

    let meter_documents = meters
        .iter()
        .map(mongodb::bson::serialize_to_document)
        .collect::<Result<Vec<Document>, _>>()
        .map_err(|error| PolarBillingError::Serialization(error.to_string()))?;
    let filter = credit_snapshot_filter(owner.owner_id, occurred_at, event_key);
    let update = credit_snapshot_update(occurred_at, event_key, &meter_documents);
    let record = match context
        .store
        .credit_find_one_and_update(&filter, &update)
        .await?
    {
        Some(record) => Some(record),
        None => context.store.credit_find_by_id(owner.owner_id).await?,
    };
    let Some(record) = record else {
        return Err(PolarBillingError::prerequisite(SNAPSHOT_NOT_PERSISTED));
    };
    let Some(snapshot) = record.snapshot.as_ref() else {
        return Err(PolarBillingError::Business(SNAPSHOT_MISSING.into()));
    };

    let credits_meter = meter_by_id(&snapshot.meters, AI_CREDITS_METER_ID);
    let credits = match credits_meter {
        Some(meter) => {
            let meter = json_from_document(meter)?;
            let at = JsDate::from_millis(snapshot.occurred_at as f64)
                .to_iso_string()
                .map_err(|error| PolarBillingError::Serialization(error.to_string()))?;
            let at = JsString::from(at);
            Some(
                build_ai_credits_data_from_meter(Some(&meter), Some(record.plan_tier), Some(&at))
                    .map_err(PolarBillingError::Serialization)?,
            )
        }
        None => None,
    };
    let balance = snapshot_balance(credits.as_ref(), &snapshot.meters);
    let exhaustion = exhaustion_for_balance(balance);
    let plan_version = plan_cache_version(
        record.polar_plan_event_at,
        record.polar_plan_event_key.as_deref(),
    )?;
    if record.twitch_account_ids.is_empty() {
        return Ok(());
    }
    let raw_payload = credits_payload(credits.as_ref(), &plan_version);
    let version = snapshot_version(snapshot.occurred_at, &snapshot.event_key);
    let ttl = TtlSeconds::new(AI_CREDITS_CACHE_TTL_SECONDS)?;
    for account in &record.twitch_account_ids {
        context
            .effects
            .sync_credits(
                account,
                &version,
                raw_payload.as_deref(),
                exhaustion,
                ttl,
                &plan_version,
            )
            .await?;
    }
    Ok(())
}
