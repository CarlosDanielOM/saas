//! Native normalization of verified Polar SDK webhook data. Date-valued SDK
//! fields are BSON DateTime, not arbitrary strings; ignored PII is not retained.

use super::{NormalizedDomainEvent, validate_normalized_event};
use crate::domain_event_contracts::{
    DomainEventContractError, DomainEventSdkValue as Sdk, serialize_domain_event_sdk_data,
    time::{native_date_iso, valid_native_millis},
};
use mongodb::bson::{Bson, DateTime, Document};
use serde_json::{Map, Value, json};

#[derive(Debug, Clone)]
pub struct NormalizePolarWebhookInput {
    pub webhook_id: String,
    pub event_type: String,
    pub timestamp: DateTime,
    pub data: Document,
}

type Result<T> = std::result::Result<T, DomainEventContractError>;
fn fail(message: impl Into<String>) -> DomainEventContractError {
    DomainEventContractError::new(message)
}
fn string(value: Option<&Bson>, field: &str) -> Result<String> {
    value
        .and_then(Bson::as_str)
        .filter(|s| !crate::utils::js_compat::trim(s).is_empty())
        .map(str::to_owned)
        .ok_or_else(|| fail(format!("Polar webhook requires {field}")))
}
fn optional_string(value: Option<&Bson>, field: &str) -> Result<Option<String>> {
    match value {
        None | Some(Bson::Null) | Some(Bson::Undefined) => Ok(None),
        value => string(value, field).map(Some),
    }
}
fn nullish(value: Option<&Bson>) -> Option<&Bson> {
    value.filter(|v| !matches!(v, Bson::Null | Bson::Undefined))
}
fn number(value: &Bson) -> Option<f64> {
    match value {
        Bson::Int32(n) => Some(f64::from(*n)),
        Bson::Int64(n) => Some(*n as f64),
        Bson::Double(n) => Some(*n),
        _ => None,
    }
}
fn cadence(value: Option<&Bson>) -> Result<&'static str> {
    match value.and_then(Bson::as_str) {
        Some("month") => Ok("monthly"),
        Some("year") => Ok("yearly"),
        _ => Err(fail(
            "Polar webhook requires a supported subscription recurringInterval",
        )),
    }
}
fn date(value: Option<&Bson>, field: &str) -> Result<Option<Value>> {
    match value {
        None | Some(Bson::Undefined) => Ok(None),
        Some(Bson::Null) => Ok(Some(Value::Null)),
        Some(Bson::DateTime(date)) if valid_native_millis(date.timestamp_millis()) => Ok(Some(
            Value::String(native_date_iso(date.timestamp_millis())),
        )),
        _ => Err(fail(format!(
            "Polar webhook requires a finite Date for {field}"
        ))),
    }
}
fn sdk_value(value: &Bson) -> Result<Sdk> {
    sdk_value_at(value, 0, &mut 0)
}
fn sdk_value_at(value: &Bson, depth: usize, budget: &mut usize) -> Result<Sdk> {
    if depth > 32 {
        return Err(fail("JSON nesting exceeds 32 levels"));
    };
    *budget += match value {
        Bson::String(s) => s.len() + 2,
        Bson::DateTime(_) => 26,
        _ => 1,
    };
    if *budget > crate::domain_event_contracts::DOMAIN_EVENT_MAX_JSON_BYTES {
        return Err(fail("JSON exceeds 256 KiB"));
    };
    Ok(match value {
        Bson::Document(doc) => Sdk::Object(
            doc.iter()
                .map(|(key, value)| {
                    *budget += key.len();
                    Ok((key.clone(), sdk_value_at(value, depth + 1, budget)?))
                })
                .collect::<Result<_>>()?,
        ),
        Bson::Array(items) => Sdk::Array(
            items
                .iter()
                .map(|value| sdk_value_at(value, depth + 1, budget))
                .collect::<Result<_>>()?,
        ),
        Bson::DateTime(date) => Sdk::Date(date.timestamp_millis()),
        Bson::Undefined => Sdk::Undefined,
        Bson::Null => Sdk::Json(Value::Null),
        Bson::String(s) => Sdk::Json(json!(s)),
        Bson::Boolean(b) => Sdk::Json(json!(b)),
        n @ (Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_)) => Sdk::Json(Value::Number(
            serde_json::Number::from_f64(number(n).unwrap())
                .ok_or_else(|| fail("JSON numbers must be finite and integers must be safe"))?,
        )),
        _ => return Err(fail("payload and metadata must be JSON-safe")),
    })
}

pub fn normalize_polar_domain_event(
    input: &NormalizePolarWebhookInput,
) -> Result<NormalizedDomainEvent> {
    let source_id = string(Some(&Bson::String(input.webhook_id.clone())), "webhookId")?;
    let original = string(Some(&Bson::String(input.event_type.clone())), "event.type")?;
    if !valid_native_millis(input.timestamp.timestamp_millis()) {
        return Err(fail("Polar webhook requires a finite event.timestamp"));
    };
    let data = &input.data;
    let resource = string(data.get("id"), "data.id")?;
    let customer_event = original.starts_with("customer.");
    let customer = data.get_document("customer").ok();
    let nested_customer_id = customer.and_then(|c| c.get("id"));
    if nullish(data.get("customerId")).is_some()
        && nullish(nested_customer_id).is_some()
        && data.get("customerId") != nested_customer_id
    {
        return Err(fail("Polar customerId/customer.id mismatch"));
    };
    let mut customer_id = if customer_event {
        Some(resource.clone())
    } else {
        optional_string(
            nullish(data.get("customerId")).or(nested_customer_id),
            "customerId",
        )?
    };
    let external = optional_string(
        if customer_event {
            data.get("externalId")
        } else {
            customer.and_then(|c| c.get("externalId"))
        },
        "externalCustomerId",
    )?;
    let legacy = optional_string(
        customer
            .and_then(|c| c.get_document("metadata").ok())
            .and_then(|m| m.get("twitch_user_id"))
            .and_then(|value| nullish(Some(value)))
            .or_else(|| {
                data.get_document("metadata")
                    .ok()
                    .and_then(|m| m.get("twitch_user_id"))
            }),
        "legacyTwitchChannelId",
    )?;
    let mut metadata = json!({"originalEventType":original});
    if let Some(external) = external {
        metadata["externalCustomerId"] = json!(external)
    };
    if let Some(legacy) = legacy {
        metadata["legacyTwitchChannelId"] = json!(legacy)
    };
    let event_type;
    let mut payload = Map::new();
    if original == "order.paid" || original == "subscription.updated" {
        let id = string(data.get("customerId"), "customerId")?;
        customer_id = Some(id.clone());
        payload.insert("customerId".into(), json!(id));
        payload.insert(
            "status".into(),
            json!(string(data.get("status"), "status")?),
        );
        if original == "order.paid" {
            if data.get_bool("paid").ok() != Some(true) {
                return Err(fail("Polar order.paid requires paid=true"));
            };
            event_type = "billing.order.paid".to_owned();
            payload.insert("orderId".into(), json!(resource));
            payload.insert("paid".into(), json!(true));
            if let Some(amount) = data.get("totalAmount") {
                let n = number(amount)
                    .filter(|n| {
                        n.is_finite()
                            && n.fract() == 0.0
                            && *n >= 0.0
                            && *n <= 9_007_199_254_740_991.0
                    })
                    .ok_or_else(|| {
                        fail("Polar order.paid requires a nonnegative totalAmount in cents")
                    })?;
                payload.insert("totalAmount".into(), json!(n));
            }
            let subscription_id = optional_string(data.get("subscriptionId"), "subscriptionId")?;
            if let Some(product) = optional_string(data.get("productId"), "productId")? {
                payload.insert("productId".into(), json!(product));
            }
            if let Some(subscription) = &subscription_id {
                payload.insert("subscriptionId".into(), json!(subscription));
            }
            if let Some(subscription) = nullish(data.get("subscription")) {
                let subscription = subscription
                    .as_document()
                    .ok_or_else(|| fail("Polar webhook requires record subscription"))?;
                if subscription_id.as_ref().is_some_and(|id| {
                    nullish(subscription.get("id"))
                        .is_some_and(|other| other.as_str() != Some(id.as_str()))
                }) {
                    return Err(fail("Polar subscriptionId/subscription.id mismatch"));
                };
                payload.insert(
                    "cadence".into(),
                    json!(cadence(subscription.get("recurringInterval"))?),
                );
                if let Some(period) = date(
                    subscription.get("currentPeriodEnd"),
                    "subscription.currentPeriodEnd",
                )? {
                    payload.insert("periodEnd".into(), period);
                }
            } else if subscription_id.is_some() {
                return Err(fail(
                    "Polar paid subscription order requires subscription recurringInterval",
                ));
            };
        } else {
            event_type = "billing.subscription.updated".to_owned();
            payload.insert("subscriptionId".into(), json!(resource));
            payload.insert(
                "productId".into(),
                json!(string(data.get("productId"), "productId")?),
            );
            payload.insert(
                "cadence".into(),
                json!(cadence(data.get("recurringInterval"))?),
            );
            let period = if data.get_str("status").ok() == Some("canceled") {
                nullish(data.get("endsAt"))
                    .or_else(|| nullish(data.get("endedAt")))
                    .or_else(|| data.get("currentPeriodEnd"))
            } else {
                data.get("currentPeriodEnd")
            };
            if let Some(period) = date(period, "subscription periodEnd")? {
                payload.insert("periodEnd".into(), period);
            }
        }
    } else if original == "customer.state_changed" {
        event_type = "billing.customer.state.changed".to_owned();
        payload.insert("customerId".into(), json!(resource));
        let meters = data
            .get_array("activeMeters")
            .map_err(|_| fail("Polar webhook requires activeMeters"))?;
        let mut normalized_meters = Vec::with_capacity(meters.len());
        for meter in meters {
            let meter = meter
                .as_document()
                .ok_or_else(|| fail("Polar webhook requires record activeMeters entry"))?;
            let mut normalized = json!({"meter_id":string(meter.get("meterId"),"meterId")?});
            for (sdk, field) in [
                ("consumedUnits", "consumed_units"),
                ("creditedUnits", "credited_units"),
                ("balance", "balance"),
            ] {
                if let Some(value) = meter.get(sdk) {
                    if matches!(value, Bson::Undefined) {
                        continue;
                    };
                    let number = number(value)
                        .filter(|n| n.is_finite())
                        .ok_or_else(|| fail(format!("Polar webhook requires finite {sdk}")))?;
                    normalized[field] = json!(number);
                }
            }
            normalized_meters.push(normalized);
        }
        payload.insert("meters".into(), json!(normalized_meters));
        if data.contains_key("activeSubscriptions") || data.contains_key("grantedBenefits") {
            let (subscriptions, grants) = match (
                data.get_array("activeSubscriptions"),
                data.get_array("grantedBenefits"),
            ) {
                (Ok(s), Ok(g)) => (s, g),
                _ => {
                    return Err(fail(
                        "Polar customer state requires both entitlement arrays",
                    ));
                }
            };
            let mut normalized_subscriptions = Vec::with_capacity(subscriptions.len());
            for subscription in subscriptions {
                let subscription = subscription
                    .as_document()
                    .ok_or_else(|| fail("Polar customer state requires record subscription"))?;
                let mut normalized = Map::new();
                for field in ["id", "productId", "status"] {
                    normalized.insert(
                        field.into(),
                        json!(string(
                            subscription.get(field),
                            &format!("subscription.{field}")
                        )?),
                    );
                }
                for field in ["currentPeriodEnd", "endsAt", "trialStart", "trialEnd"] {
                    if let Some(date) =
                        date(subscription.get(field), &format!("subscription.{field}"))?
                    {
                        normalized.insert(field.into(), date);
                    }
                }
                normalized_subscriptions.push(Value::Object(normalized));
            }
            let mut normalized_grants = Vec::with_capacity(grants.len());
            for grant in grants {
                let grant = grant
                    .as_document()
                    .ok_or_else(|| fail("Polar customer state requires record grant"))?;
                normalized_grants.push(json!({"id":string(grant.get("id"),"grant.id")?,"benefitId":string(grant.get("benefitId"),"grant.benefitId")?}));
            }
            payload.insert(
                "activeSubscriptions".into(),
                json!(normalized_subscriptions),
            );
            payload.insert("grantedBenefits".into(), json!(normalized_grants));
        }
    } else {
        event_type = format!("provider.polar.{original}");
        metadata["unmapped"] = json!(true);
        payload.insert(
            "providerData".into(),
            serialize_domain_event_sdk_data(&sdk_value(&Bson::Document(data.clone()))?)?,
        );
    }
    let output = NormalizedDomainEvent {
        input: json!({"source":"polar-webhook","sourceEventId":source_id,"type":event_type,"topic":"domain","schemaVersion":1,
        "subject":{"provider":"polar","kind":if customer_id.is_some(){"customer"}else{"resource"},"id":customer_id.as_deref().unwrap_or(&resource)},
        "occurredAt":native_date_iso(input.timestamp.timestamp_millis()),"payload":payload,"metadata":metadata}),
        native_occurred_at: Some(input.timestamp),
    };
    validate_normalized_event(&output)?;
    Ok(output)
}
