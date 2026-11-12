//! Where AI credits came from: which `meter.credited` events of a customer were a subscription's
//! credits, a purchased pack or a gift. Reporting only: nothing here grants credits.
//!
//! Reference: `classifyPolarCreditSources` and `polarCreditSourceReads` in
//! `dimabot/src/utils/ai_credit_sources.ts`.
//!
//! Polar's credit events carry no grant or order id. A `benefit.granted` or `benefit.cycled`
//! event follows its `meter.credited` within [`CREDIT_SOURCE_MATCH_MS`]; only a pair that is
//! unique on both sides and verified against the customer's grant (and, for one-time grants, its
//! paid order) is classified. Events are read with the reference's loose rules: metadata keys in
//! either case, ids of `[A-Za-z0-9_-]` only, JavaScript strict equality between Polar's values.
//! Where the reference would throw a `TypeError` on a grant or order (a `null` `benefit` or
//! `properties`), this returns [`CreditSourceError::Malformed`].

use crate::credit_packs::credit_pack_definition;
use crate::polar::{PolarClient, PolarError};
use crate::products::{AI_CREDITS_METER_ID, GIFT_PACK_PAIRS};
use dima_model::Private;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value};
use std::collections::HashMap;

/// `CREDIT_SOURCE_MATCH_MS`.
pub const CREDIT_SOURCE_MATCH_MS: i64 = 5_000;
/// Pages of grants read at most (100 per page).
pub const MAX_GRANT_PAGES: u32 = 100;

/// Why the report failed.
#[derive(Debug, thiserror::Error)]
pub enum CreditSourceError {
    /// Polar failed (`Gift provider request failed (status)` in the reference).
    #[error(transparent)]
    Polar(#[from] PolarError),
    /// More than [`MAX_GRANT_PAGES`] pages of grants.
    #[error("Credit source grant history is too large")]
    TooLarge,
    /// Polar's grant or order has a shape the reference would throw on.
    #[error("Polar credit source answer is malformed")]
    Malformed,
}

/// One event of the customer (`CreditSourceEvent`).
#[derive(Clone, Debug, PartialEq)]
pub struct CreditSourceEvent {
    /// `id`.
    pub id: Value,
    /// `name`.
    pub name: Value,
    /// `at(event)`: the event time, `None` when it is not a valid date.
    pub at_ms: Option<i64>,
    /// `metadata`.
    pub metadata: Value,
}

impl CreditSourceEvent {
    /// An event as JSON (`timestamp` text is parsed as `new Date(String(timestamp || ''))`).
    pub fn from_json(event: &Value) -> Self {
        let get = |key: &str| event.get(key).cloned().unwrap_or(Value::Null);
        let timestamp = event.get("timestamp");
        let at_ms = if crate::js::truthy(timestamp) {
            timestamp.and_then(|t| dima_text::parse_date(&dima_text::string_of(t)))
        } else {
            None
        };
        Self {
            id: get("id"),
            name: get("name"),
            at_ms,
            metadata: get("metadata"),
        }
    }

    fn meta(&self, key: &str, snake: &str) -> Option<&Value> {
        // `metadata(event)` is `{}` for anything that is not an object; then `m.a ?? m.b`.
        let object = self.metadata.as_object()?;
        match object.get(key) {
            None | Some(Value::Null) => object.get(snake),
            found => found,
        }
    }
}

/// `text(value)`: an id of `[A-Za-z0-9_-]+`.
fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

/// JavaScript `===` between JSON values (objects and arrays are never equal: different
/// references).
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

fn str_eq(a: Option<&Value>, b: &str) -> bool {
    a.and_then(Value::as_str) == Some(b)
}

/// Property read where the reference would throw on `null` or `undefined`.
fn prop<'a>(value: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, CreditSourceError> {
    match value {
        None | Some(Value::Null) => Err(CreditSourceError::Malformed),
        Some(Value::Object(object)) => Ok(object.get(key)),
        Some(_) => Ok(None),
    }
}

/// The reads the report makes (`CreditSourceReads`).
pub trait CreditSourceReads: Send + Sync {
    /// The customer's grant `id`, if any.
    fn grant<'a>(
        &'a mut self,
        id: &'a str,
    ) -> BoxFuture<'a, Result<Option<Value>, CreditSourceError>>;
    /// Order `id`.
    fn order<'a>(&'a mut self, id: &'a str) -> BoxFuture<'a, Result<Value, CreditSourceError>>;
}

/// `polarCreditSourceReads(customerId)`: the customer's whole grant list read once (Polar has
/// no get-by-id for grants), orders one by one. The customer id and the cached grants are
/// [`Private`]: `Debug` prints a placeholder.
#[derive(Debug)]
pub struct PolarCreditSourceReads<'a> {
    polar: &'a PolarClient,
    customer_id: Private<String>,
    grants: Option<Result<Private<HashMap<String, Value>>, String>>,
}

impl<'a> PolarCreditSourceReads<'a> {
    /// For one customer.
    pub fn new(polar: &'a PolarClient, customer_id: &str) -> Self {
        Self {
            polar,
            customer_id: Private::new(customer_id.to_owned()),
            grants: None,
        }
    }

    async fn list_grants(&self) -> Result<HashMap<String, Value>, CreditSourceError> {
        let mut result = HashMap::new();
        for page in 1..=MAX_GRANT_PAGES {
            let response = self
                .polar
                .list_benefit_grants_page(self.customer_id.expose(), page)
                .await?;
            let items = match response.get("items") {
                Some(Value::Array(items)) => items,
                _ => return Err(CreditSourceError::Malformed),
            };
            for grant in items {
                match grant {
                    Value::Null => return Err(CreditSourceError::Malformed),
                    Value::Object(object) => {
                        if let Some(id) = object.get("id").and_then(Value::as_str) {
                            result.insert(id.to_owned(), grant.clone());
                        }
                    }
                    _ => {}
                }
            }
            let max_page = response
                .get("pagination")
                .and_then(|p| p.get("max_page"))
                .and_then(Value::as_f64);
            let done = match max_page {
                Some(max) => f64::from(page) >= max,
                None => items.len() < 100,
            };
            if done {
                return Ok(result);
            }
        }
        Err(CreditSourceError::TooLarge)
    }
}

impl CreditSourceReads for PolarCreditSourceReads<'_> {
    fn grant<'b>(
        &'b mut self,
        id: &'b str,
    ) -> BoxFuture<'b, Result<Option<Value>, CreditSourceError>> {
        Box::pin(async move {
            if self.grants.is_none() {
                // The reference caches the promise: a failed listing fails every later lookup.
                self.grants = Some(
                    self.list_grants()
                        .await
                        .map(Private::new)
                        .map_err(|e| e.to_string()),
                );
            }
            match &self.grants {
                Some(Ok(grants)) => Ok(grants.expose().get(id).cloned()),
                _ => Err(CreditSourceError::Malformed),
            }
        })
    }

    fn order<'b>(&'b mut self, id: &'b str) -> BoxFuture<'b, Result<Value, CreditSourceError>> {
        Box::pin(async move { Ok(self.polar.get_order(id).await?) })
    }
}

/// `classifyPolarCreditSources(customerId, events, reads)`: credit event id to
/// `subscription_credits`, `purchased_pack` or `gifted_credits`, in classification order.
pub async fn classify_credit_sources(
    customer_id: &str,
    events: &[CreditSourceEvent],
    reads: &mut dyn CreditSourceReads,
) -> Result<Map<String, Value>, CreditSourceError> {
    let credits: Vec<usize> = (0..events.len())
        .filter(|&i| {
            let e = &events[i];
            let units = e.meta("units", "units").and_then(Value::as_f64);
            str_eq(Some(&e.name), "meter.credited")
                && text(Some(&e.id)).is_some()
                && str_eq(e.meta("meterId", "meter_id"), AI_CREDITS_METER_ID)
                && units.is_some_and(|u| u.is_finite() && u > 0.0)
                && e.meta("rollover", "rollover")
                    .is_some_and(Value::is_boolean)
                && e.at_ms.is_some()
        })
        .collect();
    let benefits: Vec<usize> = (0..events.len())
        .filter(|&i| {
            let e = &events[i];
            let name = dima_text::string_of(&e.name);
            (name == "benefit.granted" || name == "benefit.cycled")
                && str_eq(e.meta("benefitType", "benefit_type"), "meter_credit")
                && text(e.meta("benefitGrantId", "benefit_grant_id")).is_some()
                && e.at_ms.is_some()
        })
        .collect();

    let mut grants: HashMap<String, Value> = HashMap::new();
    let mut orders: HashMap<String, Value> = HashMap::new();
    let mut matches: Vec<(usize, usize, String)> = Vec::new();
    for &benefit in &benefits {
        let b = &events[benefit];
        let benefit_at = b.at_ms.unwrap_or_default();
        let nearby: Vec<usize> = credits
            .iter()
            .copied()
            .filter(|&c| {
                let credit_at = events[c].at_ms.unwrap_or_default();
                benefit_at >= credit_at && benefit_at - credit_at <= CREDIT_SOURCE_MATCH_MS
            })
            .collect();
        if nearby.is_empty() {
            continue;
        }
        let Some(id) = text(b.meta("benefitGrantId", "benefit_grant_id")) else {
            continue;
        };
        if !grants.contains_key(id) {
            let Some(found) = reads.grant(id).await? else {
                continue;
            };
            grants.insert(id.to_owned(), found);
        }
        let Some(grant) = grants.get(id) else {
            continue;
        };
        let g = Some(grant);
        let verified = str_eq(prop(g, "id")?, id)
            && str_eq(prop(g, "customer_id")?, customer_id)
            && strict_eq(prop(g, "benefit_id")?, b.meta("benefitId", "benefit_id"))
            && strict_eq(prop(prop(g, "benefit")?, "id")?, prop(g, "benefit_id")?)
            && str_eq(prop(prop(g, "benefit")?, "type")?, "meter_credit")
            && str_eq(
                prop(prop(prop(g, "benefit")?, "properties")?, "meter_id")?,
                AI_CREDITS_METER_ID,
            );
        if !verified {
            continue;
        }
        let properties = prop(prop(g, "benefit")?, "properties")?;
        for &credit in &nearby {
            let c = &events[credit];
            if !strict_eq(
                c.meta("rollover", "rollover"),
                prop(properties, "rollover")?,
            ) || (!crate::js::truthy(prop(g, "subscription_id")?)
                && !strict_eq(c.meta("units", "units"), prop(properties, "units")?))
            {
                continue;
            }
            matches.push((credit, benefit, id.to_owned()));
        }
    }

    let mut result = Map::new();
    for (credit, benefit, grant_id) in &matches {
        if matches.iter().filter(|m| m.0 == *credit).count() != 1
            || matches.iter().filter(|m| m.1 == *benefit).count() != 1
        {
            continue;
        }
        let Some(grant) = grants.get(grant_id) else {
            continue;
        };
        let g = Some(grant);
        let credit_id = dima_text::string_of(&events[*credit].id);
        let subscription = crate::js::truthy(prop(g, "subscription_id")?);
        let order_id = prop(g, "order_id")?;
        if subscription && !crate::js::truthy(order_id) {
            result.insert(credit_id, Value::from("subscription_credits"));
        } else if crate::js::truthy(order_id) && !subscription {
            let order_key = dima_text::string_of(order_id.unwrap_or(&Value::Null));
            if !orders.contains_key(&order_key) {
                let order = reads.order(&order_key).await?;
                orders.insert(order_key.clone(), order);
            }
            let Some(order) = orders.get(&order_key) else {
                continue;
            };
            let o = Some(order);
            if !strict_eq(prop(o, "id")?, order_id)
                || !str_eq(prop(o, "customer_id")?, customer_id)
                || !crate::js::truthy(prop(o, "paid")?)
                || crate::js::truthy(prop(o, "subscription_id")?)
            {
                continue;
            }
            let metadata = prop(o, "metadata")?;
            let source = match metadata {
                None | Some(Value::Null) => None,
                Some(_) => prop(metadata, "source")?,
            };
            let product = prop(o, "product_id")?;
            let gift = str_eq(source, "dimabot_gift_fulfillment")
                && text(prop(metadata, "gift_id")?).is_some()
                && GIFT_PACK_PAIRS
                    .iter()
                    .any(|p| str_eq(product, p.fulfillment_product_id))
                && strict_eq(prop(o, "total_amount")?, Some(&Value::from(0)));
            if gift {
                result.insert(credit_id, Value::from("gifted_credits"));
            } else if product
                .and_then(Value::as_str)
                .and_then(credit_pack_definition)
                .is_some()
                && !str_eq(source, "dimabot_gift_fulfillment")
            {
                result.insert(credit_id, Value::from("purchased_pack"));
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixed(HashMap<String, Value>, HashMap<String, Value>);

    impl CreditSourceReads for Fixed {
        fn grant<'a>(
            &'a mut self,
            id: &'a str,
        ) -> BoxFuture<'a, Result<Option<Value>, CreditSourceError>> {
            Box::pin(async move { Ok(self.0.get(id).cloned()) })
        }
        fn order<'a>(&'a mut self, id: &'a str) -> BoxFuture<'a, Result<Value, CreditSourceError>> {
            Box::pin(async move { self.1.get(id).cloned().ok_or(CreditSourceError::Malformed) })
        }
    }

    fn event(id: &str, name: &str, at: &str, metadata: Value) -> CreditSourceEvent {
        CreditSourceEvent::from_json(
            &json!({"id": id, "name": name, "timestamp": at, "metadata": metadata}),
        )
    }

    #[tokio::test]
    async fn a_unique_verified_pair_is_classified() {
        let events = vec![
            event(
                "c1",
                "meter.credited",
                "2026-11-11T00:00:00.000Z",
                json!({"meter_id": AI_CREDITS_METER_ID, "units": 40000, "rollover": true}),
            ),
            event(
                "b1",
                "benefit.granted",
                "2026-11-11T00:00:04.000Z",
                json!({"benefit_type": "meter_credit", "benefit_grant_id": "g1", "benefit_id": "ben"}),
            ),
            event(
                "c2",
                "meter.credited",
                "2026-11-11T00:01:00.000Z",
                json!({"meterId": AI_CREDITS_METER_ID, "units": 1000, "rollover": false}),
            ),
            event(
                "b2",
                "benefit.cycled",
                "2026-11-11T00:01:01.000Z",
                json!({"benefitType": "meter_credit", "benefitGrantId": "g2", "benefitId": "ben2"}),
            ),
        ];
        let grant = |id: &str,
                     benefit: &str,
                     units: i64,
                     rollover: bool,
                     order: Value,
                     subscription: Value| {
            json!({"id": id, "customer_id": "cust", "benefit_id": benefit, "order_id": order, "subscription_id": subscription,
                   "benefit": {"id": benefit, "type": "meter_credit", "properties": {"meter_id": AI_CREDITS_METER_ID, "units": units, "rollover": rollover}}})
        };
        let mut reads = Fixed(
            [
                (
                    "g1".to_owned(),
                    grant("g1", "ben", 40000, true, json!("o1"), Value::Null),
                ),
                (
                    "g2".to_owned(),
                    grant("g2", "ben2", 5, false, Value::Null, json!("sub")),
                ),
            ]
            .into_iter()
            .collect(),
            [(
                "o1".to_owned(),
                json!({"id": "o1", "customer_id": "cust", "paid": true, "subscription_id": null,
                "product_id": GIFT_PACK_PAIRS[0].fulfillment_product_id, "total_amount": 0,
                "metadata": {"source": "dimabot_gift_fulfillment", "gift_id": "gift_1"}}),
            )]
            .into_iter()
            .collect(),
        );
        let result = classify_credit_sources("cust", &events, &mut reads)
            .await
            .unwrap();
        assert_eq!(
            Value::Object(result),
            json!({"c1": "gifted_credits", "c2": "subscription_credits"})
        );
    }
}
