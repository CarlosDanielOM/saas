//! Polar webhooks to journal events (`domain_events/polar_events.ts`).
//!
//! The route (`server/routes/webhooks/polarsh.webhook.ts`) verifies the standard-webhooks
//! signature and parses the body with the Polar SDK (`validateEvent`), then calls
//! [`super::Ingest::polar`] with the signed `webhook-id` header and the SDK's event. What the
//! reference answers Polar: 202 when the event is journaled or was already journaled, 403 when
//! the signature fails, 500 for anything else (a contract error included), so Polar delivers it
//! again.
//!
//! **Input shape.** [`PolarWebhook::data`] is the SDK's object: camelCase keys, dates as `Date`
//! values ([`Value::Date`]). Turning the raw JSON body into that shape is the Polar SDK's schema
//! work, which belongs to the Polar webhook route (`dima-billing`); this module starts from it.
//! The recorded fixtures (`tests/fixtures/recorded.json`) hold SDK objects produced by the real
//! SDK from signed bodies.

use crate::contracts::{
    ContractError, JournalInput, OccurredAt, SubjectInput, Topic,
    serialize_provider_data, sources,
};
use crate::value::{Object, Value};
use dima_model::StrEnum;
use dima_model::domain_events::SubjectKind;

/// `NormalizePolarWebhookInput`.
#[derive(Clone, Debug, PartialEq)]
pub struct PolarWebhook {
    /// The signed `webhook-id` header (the event's id at Polar).
    pub webhook_id: String,
    /// `event.type` (`order.paid`...).
    pub event_type: String,
    /// `event.timestamp`: a `Date`.
    pub timestamp: Value,
    /// `event.data`, as the SDK parsed it.
    pub data: Value,
}

type Result<T> = std::result::Result<T, ContractError>;

/// `isRecord(value)`: a plain object (not an array, not a `Date`).
fn is_record(value: &Value) -> bool {
    matches!(value, Value::Object(_) | Value::ObjectId(_) | Value::Other)
}

/// `requiredString(value, field)`: the value itself (untrimmed) when it is non-blank text.
fn required_string(value: &Value, field: &str) -> Result<String> {
    match value {
        Value::String(text) if !dima_text::trim(text).is_empty() => Ok(text.clone()),
        _ => Err(ContractError(format!("Polar webhook requires {field}"))),
    }
}

/// `optionalString(value, field)`.
fn optional_string(value: &Value, field: &str) -> Result<Option<String>> {
    if value.is_nullish() {
        Ok(None)
    } else {
        required_string(value, field).map(Some)
    }
}

/// `serializeDate(value, field)`: `None` for `undefined`, `Some(Null)` for `null`, the ISO text
/// of a valid date.
fn serialize_date(value: &Value, field: &str) -> Result<Option<Value>> {
    match value {
        Value::Undefined => Ok(None),
        Value::Null => Ok(Some(Value::Null)),
        Value::Date(ms) if ms.is_finite() => dima_text::to_iso_string(ms.trunc() as i64)
            .map(|iso| Some(Value::String(iso)))
            .ok_or_else(|| ContractError(format!("Polar webhook requires a finite Date for {field}"))),
        _ => Err(ContractError(format!(
            "Polar webhook requires a finite Date for {field}"
        ))),
    }
}

fn cadence(interval: &Value) -> Result<&'static str> {
    match interval.as_str() {
        Some("month") => Ok("monthly"),
        Some("year") => Ok("yearly"),
        _ => Err(ContractError::new(
            "Polar webhook requires a supported subscription recurringInterval",
        )),
    }
}

/// `value ?? fallback`.
fn or<'a>(value: &'a Value, fallback: &'a Value) -> &'a Value {
    if value.is_nullish() { fallback } else { value }
}

/// `normalizePolarDomainEvent(input)`: the event to journal, validated (`ingest` mode).
pub fn normalize(input: &PolarWebhook, now_ms: i64) -> Result<JournalInput> {
    let source_event_id = required_string(&Value::from(input.webhook_id.as_str()), "webhookId")?;
    let original = required_string(&Value::from(input.event_type.as_str()), "event.type")?;
    let Value::Date(timestamp) = input.timestamp else {
        return Err(ContractError::new("Polar webhook requires a finite event.timestamp"));
    };
    if !timestamp.is_finite() {
        return Err(ContractError::new("Polar webhook requires a finite event.timestamp"));
    }
    let data = &input.data;
    if !is_record(data) {
        return Err(ContractError::new("Polar webhook requires record event.data"));
    }
    let resource_id = required_string(data.at("id"), "data.id")?;
    let customer_event = original.starts_with("customer.");
    let customer = if is_record(data.at("customer")) {
        data.at("customer")
    } else {
        &Value::Undefined
    };
    if !data.at("customerId").is_nullish()
        && !customer.at("id").is_nullish()
        && !same(data.at("customerId"), customer.at("id"))
    {
        return Err(ContractError::new("Polar customerId/customer.id mismatch"));
    }
    let mut customer_id = if customer_event {
        Some(resource_id.clone())
    } else {
        optional_string(or(data.at("customerId"), customer.at("id")), "customerId")?
    };
    let external_customer_id = optional_string(
        if customer_event {
            data.at("externalId")
        } else {
            customer.at("externalId")
        },
        "externalCustomerId",
    )?;
    let customer_metadata = if is_record(customer.at("metadata")) {
        customer.at("metadata")
    } else {
        &Value::Undefined
    };
    let event_metadata = if is_record(data.at("metadata")) {
        data.at("metadata")
    } else {
        &Value::Undefined
    };
    let legacy_twitch_channel_id = optional_string(
        or(
            customer_metadata.at("twitch_user_id"),
            event_metadata.at("twitch_user_id"),
        ),
        "legacyTwitchChannelId",
    )?;
    let mut metadata = Object::new();
    metadata.insert("originalEventType", Value::from(original.as_str()));
    if let Some(external) = &external_customer_id {
        metadata.insert("externalCustomerId", Value::from(external.as_str()));
    }
    if let Some(legacy) = &legacy_twitch_channel_id {
        metadata.insert("legacyTwitchChannelId", Value::from(legacy.as_str()));
    }

    let kind: String;
    let mut payload = Object::new();
    if original == "order.paid" || original == "subscription.updated" {
        let id = required_string(data.at("customerId"), "customerId")?;
        customer_id = Some(id.clone());
        payload.insert("customerId", Value::from(id));
        payload.insert("status", Value::from(required_string(data.at("status"), "status")?));
        if original == "order.paid" {
            if !matches!(data.at("paid"), Value::Bool(true)) {
                return Err(ContractError::new("Polar order.paid requires paid=true"));
            }
            kind = "billing.order.paid".into();
            payload.insert("orderId", Value::from(resource_id.as_str()));
            payload.insert("paid", Value::Bool(true));
            let total = data.at("totalAmount");
            if !total.is_undefined() {
                if !matches!(total, Value::Number(n) if crate::contracts::validate_is_safe_integer(*n) && *n >= 0.0)
                {
                    return Err(ContractError::new(
                        "Polar order.paid requires a nonnegative totalAmount in cents",
                    ));
                }
                payload.insert("totalAmount", total.clone());
            }
            let product_id = optional_string(data.at("productId"), "productId")?;
            let subscription_id = optional_string(data.at("subscriptionId"), "subscriptionId")?;
            if let Some(product) = product_id {
                payload.insert("productId", Value::from(product));
            }
            if let Some(subscription) = &subscription_id {
                payload.insert("subscriptionId", Value::from(subscription.as_str()));
            }
            let subscription = data.at("subscription");
            if !subscription.is_nullish() {
                if !is_record(subscription) {
                    return Err(ContractError::new("Polar webhook requires record subscription"));
                }
                if let Some(expected) = &subscription_id
                    && !subscription.at("id").is_nullish()
                    && subscription.at("id").as_str() != Some(expected.as_str())
                {
                    return Err(ContractError::new("Polar subscriptionId/subscription.id mismatch"));
                }
                payload.insert(
                    "cadence",
                    Value::from(cadence(subscription.at("recurringInterval"))?),
                );
                if let Some(end) = serialize_date(
                    subscription.at("currentPeriodEnd"),
                    "subscription.currentPeriodEnd",
                )? {
                    payload.insert("periodEnd", end);
                }
            } else if subscription_id.is_some() {
                return Err(ContractError::new(
                    "Polar paid subscription order requires subscription recurringInterval",
                ));
            }
        } else {
            kind = "billing.subscription.updated".into();
            payload.insert("subscriptionId", Value::from(resource_id.as_str()));
            payload.insert(
                "productId",
                Value::from(required_string(data.at("productId"), "productId")?),
            );
            payload.insert("cadence", Value::from(cadence(data.at("recurringInterval"))?));
            let end = if is_str(data.at("status"), "canceled") {
                or(or(data.at("endsAt"), data.at("endedAt")), data.at("currentPeriodEnd"))
            } else {
                data.at("currentPeriodEnd")
            };
            if let Some(end) = serialize_date(end, "subscription periodEnd")? {
                payload.insert("periodEnd", end);
            }
        }
    } else if original == "customer.state_changed" {
        kind = "billing.customer.state.changed".into();
        let Value::Array(meters) = data.at("activeMeters") else {
            return Err(ContractError::new("Polar webhook requires activeMeters"));
        };
        payload.insert("customerId", Value::from(resource_id.as_str()));
        let mut normalized_meters = Vec::with_capacity(meters.len());
        for meter in meters {
            if !is_record(meter) {
                return Err(ContractError::new(
                    "Polar webhook requires record activeMeters entry",
                ));
            }
            let mut normalized = Object::new();
            normalized.insert("meter_id", Value::from(required_string(meter.at("meterId"), "meterId")?));
            for (sdk_field, field) in [
                ("consumedUnits", "consumed_units"),
                ("creditedUnits", "credited_units"),
                ("balance", "balance"),
            ] {
                let value = meter.at(sdk_field);
                if value.is_undefined() {
                    continue;
                }
                if !matches!(value, Value::Number(n) if n.is_finite()) {
                    return Err(ContractError(format!(
                        "Polar webhook requires finite {sdk_field}"
                    )));
                }
                normalized.insert(field, value.clone());
            }
            normalized_meters.push(Value::Object(normalized));
        }
        payload.insert("meters", Value::Array(normalized_meters));
        // Optional for retained v1 rows and older producers; new SDK snapshots keep both lists.
        let subscriptions = data.at("activeSubscriptions");
        let grants = data.at("grantedBenefits");
        if !subscriptions.is_undefined() || !grants.is_undefined() {
            let (Value::Array(subscriptions), Value::Array(grants)) = (subscriptions, grants) else {
                return Err(ContractError::new(
                    "Polar customer state requires both entitlement arrays",
                ));
            };
            let mut active = Vec::with_capacity(subscriptions.len());
            for value in subscriptions {
                if !is_record(value) {
                    return Err(ContractError::new(
                        "Polar customer state requires record subscription",
                    ));
                }
                let mut subscription = Object::new();
                subscription.insert("id", Value::from(required_string(value.at("id"), "subscription.id")?));
                subscription.insert(
                    "productId",
                    Value::from(required_string(value.at("productId"), "subscription.productId")?),
                );
                subscription.insert(
                    "status",
                    Value::from(required_string(value.at("status"), "subscription.status")?),
                );
                for field in ["currentPeriodEnd", "endsAt", "trialStart", "trialEnd"] {
                    if let Some(date) = serialize_date(value.at(field), &format!("subscription.{field}"))? {
                        subscription.insert(field, date);
                    }
                }
                active.push(Value::Object(subscription));
            }
            let mut granted = Vec::with_capacity(grants.len());
            for value in grants {
                if !is_record(value) {
                    return Err(ContractError::new("Polar customer state requires record grant"));
                }
                let mut grant = Object::new();
                grant.insert("id", Value::from(required_string(value.at("id"), "grant.id")?));
                grant.insert(
                    "benefitId",
                    Value::from(required_string(value.at("benefitId"), "grant.benefitId")?),
                );
                granted.push(Value::Object(grant));
            }
            payload.insert("activeSubscriptions", Value::Array(active));
            payload.insert("grantedBenefits", Value::Array(granted));
        }
    } else {
        kind = format!("provider.polar.{original}");
        metadata.insert("unmapped", Value::Bool(true));
        // Keep validated SDK data JSON-safe without promoting it to a billing mutation.
        payload.insert("providerData", Value::Object(serialize_provider_data(data)?));
    }

    let subject = match &customer_id {
        Some(id) if !id.is_empty() => SubjectInput::new("polar", SubjectKind::Customer, id.as_str()),
        Some(id) => SubjectInput::new("polar", SubjectKind::Resource, id.as_str()),
        None => SubjectInput::new("polar", SubjectKind::Resource, resource_id.as_str()),
    };
    let normalized = JournalInput {
        source: sources::POLAR.to_owned(),
        source_event_id,
        kind,
        topic: Topic::Domain,
        schema_version: Some(1.0),
        owner_user_id: None,
        subject: Some(subject),
        channel_id: None,
        stream_id: None,
        occurred_at: Some(OccurredAt::Date(timestamp)),
        payload,
        metadata: Some(metadata),
        retention_seconds: None,
    };
    normalized.validate(crate::contracts::Check::ingest(now_ms))?;
    Ok(normalized)
}

/// The owner lookup arguments of a Polar event (`polarWebhookProducer.resolveOwner`): only a
/// customer subject has an owner, looked up with the external id and the legacy channel id.
pub fn owner_hints(input: &JournalInput) -> Option<(Option<String>, Option<String>)> {
    let subject = input.subject.as_ref()?;
    if subject.kind != SubjectKind::Customer.as_str() {
        return None;
    }
    let metadata = input.metadata.as_ref();
    let text = |key: &str| {
        metadata
            .and_then(|m| m.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    Some((text("externalCustomerId"), text("legacyTwitchChannelId")))
}

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => a == b,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        _ => false,
    }
}

fn is_str(value: &Value, expected: &str) -> bool {
    value.as_str() == Some(expected)
}
