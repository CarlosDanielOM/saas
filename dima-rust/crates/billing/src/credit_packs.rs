//! Credit packs: the six allow-listed Polar products, the offers built from Polar's product list,
//! and how long a recharge pack lasts.
//!
//! Reference: `dimabot/src/utils/credit_packs.ts`.
//!
//! Products are read as the JSON Polar sent ([`serde_json::Value`]) with the reference's loose
//! reads (`product.is_archived` is truthiness, prices must be numbers, `Number.isFinite`), so a
//! decision on an odd answer matches. Where the reference would throw a `TypeError` (a `null`
//! price or benefit entry, a non-array `prices`, a non-text currency) Rust returns
//! [`CreditPackError::Malformed`]; the route answers both errors with the same 502.
//! Intended difference: a product whose `name` is truthy but not text is malformed (JavaScript
//! would put that value in the offer; Polar's schema makes `name` a string).
//!
//! Dates: `Date.parse` through [`dima_text::parse_date`]; days are 86,400,000 ms (UTC, no time
//! zone), rounded up.

use crate::js;
use serde::Serialize;
use serde_json::Value;

/// `CreditPackKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CreditPackKind {
    /// One-time credits that roll over.
    Credits,
    /// A recharge for the current paid cycle (no rollover).
    Recharge,
}

impl CreditPackKind {
    /// The stored text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Credits => "credits",
            Self::Recharge => "recharge",
        }
    }
}

/// `CreditPackSize`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CreditPackSize {
    /// Sample.
    Sample,
    /// Small.
    Small,
    /// Starter.
    Starter,
    /// Medium.
    Medium,
}

impl CreditPackSize {
    /// The stored text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sample => "sample",
            Self::Small => "small",
            Self::Starter => "starter",
            Self::Medium => "medium",
        }
    }
}

/// `CreditPackDefinition`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CreditPackDefinition {
    /// The Polar product id.
    pub id: &'static str,
    /// Kind.
    pub kind: CreditPackKind,
    /// Size.
    pub size: CreditPackSize,
    /// Display order within its kind.
    pub order: u8,
}

const fn pack(
    id: &'static str,
    kind: CreditPackKind,
    size: CreditPackSize,
    order: u8,
) -> CreditPackDefinition {
    CreditPackDefinition {
        id,
        kind,
        size,
        order,
    }
}

/// `CREDIT_PACK_DEFINITIONS`, in the reference's order (the offers keep it).
pub const CREDIT_PACK_DEFINITIONS: [CreditPackDefinition; 6] = [
    pack(
        "45c32959-3fa2-41a6-855c-bbeafcf9ce3c",
        CreditPackKind::Credits,
        CreditPackSize::Sample,
        0,
    ),
    pack(
        "2f446a84-69a9-42f6-96ed-6be2b31fdf0c",
        CreditPackKind::Credits,
        CreditPackSize::Starter,
        1,
    ),
    pack(
        "4315e89b-bf47-4ddd-a889-e6be6056853d",
        CreditPackKind::Credits,
        CreditPackSize::Medium,
        2,
    ),
    pack(
        "44d391d1-8952-408d-ad51-06200404d3ad",
        CreditPackKind::Recharge,
        CreditPackSize::Small,
        0,
    ),
    pack(
        "44a6baba-e057-4af7-82c4-ec8ddd528913",
        CreditPackKind::Recharge,
        CreditPackSize::Starter,
        1,
    ),
    pack(
        "ac85860a-dee1-4399-9c32-932229d112c1",
        CreditPackKind::Recharge,
        CreditPackSize::Medium,
        2,
    ),
];

/// `getCreditPackDefinition(productId)`.
pub fn credit_pack_definition(product_id: &str) -> Option<&'static CreditPackDefinition> {
    CREDIT_PACK_DEFINITIONS
        .iter()
        .find(|pack| pack.id == product_id)
}

/// `CreditPackOffer` (sent to the site as is, camel-case keys in this order).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditPackOffer {
    /// Product id.
    pub id: String,
    /// Product name, or the size when Polar has none.
    pub name: String,
    /// Kind.
    pub kind: CreditPackKind,
    /// Size.
    pub size: CreditPackSize,
    /// Credits granted (`Math.round(units)`).
    pub credits: f64,
    /// Whether the credits roll over.
    pub rollover: bool,
    /// Price in cents (`Math.round(price_amount)`).
    pub price_amount: f64,
    /// Lower-case currency.
    pub price_currency: String,
    /// Whether this user may buy it.
    pub eligible: bool,
    /// Why not.
    pub eligibility_reason: Option<&'static str>,
}

/// Why the catalog cannot be built.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CreditPackError {
    /// `CreditPackConfigurationError` with the reference's message.
    #[error("{0}")]
    Configuration(String),
    /// Where the reference throws a `TypeError` on the shape of Polar's answer.
    #[error("Polar credit pack {0} has a malformed product")]
    Malformed(&'static str),
}

/// `RechargeExpiry`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RechargeExpiry {
    /// ISO time.
    pub expires_at: String,
    /// Whole days left, rounded up, never negative (a JavaScript number).
    pub days_remaining: f64,
}

const MS_PER_DAY: i64 = 24 * 60 * 60 * 1000;

/// `getRechargeExpiry(subscription, now)`: the earlier of `current_period_end` and `ends_at`
/// (each parsed only when truthy).
pub fn recharge_expiry(
    current_period_end: Option<&str>,
    ends_at: Option<&str>,
    now_ms: i64,
) -> Option<RechargeExpiry> {
    let expires_at_ms = [current_period_end, ends_at]
        .into_iter()
        .flatten()
        .filter(|text| !text.is_empty())
        .filter_map(dima_text::parse_date)
        .min()?;
    let expires_at = dima_text::to_iso_string(expires_at_ms)?;
    // `Math.max(0, Math.ceil((expiresAt - now) / day))`, in doubles as JavaScript computes it.
    #[allow(clippy::cast_precision_loss)]
    let days = ((expires_at_ms as f64 - now_ms as f64) / MS_PER_DAY as f64).ceil();
    Some(RechargeExpiry {
        expires_at,
        days_remaining: js::max(0.0, days),
    })
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|object| object.get(key))
}

/// `value?.key` over an optional value; `Err` where JavaScript would read a property of `null`.
fn member<'a>(
    value: &'a Value,
    key: &str,
    id: &'static str,
) -> Result<Option<&'a Value>, CreditPackError> {
    match value {
        Value::Null => Err(CreditPackError::Malformed(id)),
        Value::Object(object) => Ok(object.get(key)),
        // A property of a number, string or boolean primitive is `undefined` (strings have
        // `length` and indices, which no caller reads).
        _ => Ok(None),
    }
}

/// `items?.find(predicate)` where `items` must be an array or nullish.
fn find_in<'a>(
    items: Option<&'a Value>,
    id: &'static str,
    mut predicate: impl FnMut(&'a Value) -> Result<bool, CreditPackError>,
) -> Result<Option<&'a Value>, CreditPackError> {
    match items {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => {
            for item in items {
                if predicate(item)? {
                    return Ok(Some(item));
                }
            }
            Ok(None)
        }
        Some(_) => Err(CreditPackError::Malformed(id)),
    }
}

fn is_str(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

/// `buildCreditPackOffers(products, aiCreditsMeterId, hasActivePaidSubscription)`.
pub fn build_credit_pack_offers(
    products: &[Value],
    ai_credits_meter_id: &str,
    has_active_paid_subscription: bool,
) -> Result<Vec<CreditPackOffer>, CreditPackError> {
    CREDIT_PACK_DEFINITIONS
        .iter()
        .map(|definition| {
            build_offer(
                products,
                definition,
                ai_credits_meter_id,
                has_active_paid_subscription,
            )
        })
        .collect()
}

fn build_offer(
    products: &[Value],
    definition: &CreditPackDefinition,
    meter_id: &str,
    has_paid: bool,
) -> Result<CreditPackOffer, CreditPackError> {
    let id = definition.id;
    let configuration =
        |what: &str| CreditPackError::Configuration(format!("Polar credit pack {id} {what}"));
    // `new Map(products.map(p => [p.id, p]))`: the last product with the id wins. A `null`
    // entry throws on `p.id`.
    let mut product = None;
    for candidate in products {
        if candidate.is_null() {
            return Err(CreditPackError::Malformed(id));
        }
        if is_str(field(candidate, "id"), id) {
            product = Some(candidate);
        }
    }
    let product = product.ok_or_else(|| configuration("is missing"))?;
    if js::truthy(field(product, "is_archived")) || is_str(field(product, "visibility"), "draft") {
        return Err(configuration("is unavailable"));
    }

    let price = find_in(field(product, "prices"), id, |candidate| {
        Ok(is_str(member(candidate, "type", id)?, "one_time")
            && is_str(member(candidate, "amount_type", id)?, "fixed")
            && member(candidate, "is_archived", id)?.and_then(Value::as_bool) != Some(true)
            && js::as_number(member(candidate, "price_amount", id)?).is_some_and(f64::is_finite))
    })?;
    let (price_amount, price_currency) = match price {
        Some(price) => (
            js::as_number(field(price, "price_amount")),
            field(price, "price_currency"),
        ),
        None => (None, None),
    };
    let (Some(price_amount), true) = (price_amount, js::truthy(price_currency)) else {
        return Err(configuration("has no active fixed price"));
    };

    let benefit = find_in(field(product, "benefits"), id, |candidate| {
        Ok(is_str(member(candidate, "type", id)?, "meter_credit")
            && match member(candidate, "properties", id)? {
                None | Some(Value::Null) => false,
                Some(properties) => is_str(member(properties, "meter_id", id)?, meter_id),
            })
    })?;
    let properties = benefit.and_then(|benefit| field(benefit, "properties"));
    let units = properties.and_then(|p| js::as_number(field(p, "units")));
    let rollover = properties
        .and_then(|p| field(p, "rollover"))
        .and_then(Value::as_bool);
    let (Some(units), Some(rollover)) = (units.filter(|u| u.is_finite() && *u > 0.0), rollover)
    else {
        return Err(configuration("has an invalid credit benefit"));
    };
    if rollover != (definition.kind == CreditPackKind::Credits) {
        return Err(configuration("rollover does not match its configured type"));
    }

    let name = match field(product, "name") {
        Some(Value::String(name)) if !name.is_empty() => name.clone(),
        name if js::truthy(name) => return Err(CreditPackError::Malformed(id)),
        _ => definition.size.as_str().to_owned(),
    };
    // `price.price_currency.toLowerCase()` throws for a truthy value that is not text.
    let price_currency = price_currency
        .and_then(Value::as_str)
        .ok_or(CreditPackError::Malformed(id))?;
    let eligible = definition.kind == CreditPackKind::Credits || has_paid;
    Ok(CreditPackOffer {
        id: id.to_owned(),
        name,
        kind: definition.kind,
        size: definition.size,
        credits: js::round(units),
        rollover,
        price_amount: js::round(price_amount),
        price_currency: dima_text::to_lower(price_currency),
        eligible,
        eligibility_reason: (!eligible).then_some("paid_plan_required"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const METER_ID: &str = "meter-ai";

    fn product(definition: &CreditPackDefinition, units: f64) -> Value {
        json!({
            "id": definition.id,
            "name": format!("{} {}", definition.size.as_str(), definition.kind.as_str()),
            "visibility": "private",
            "is_archived": false,
            "prices": [{"type": "one_time", "amount_type": "fixed", "price_amount": 500,
                        "price_currency": "usd", "is_archived": false}],
            "benefits": [{"type": "meter_credit", "properties": {
                "units": units, "rollover": definition.kind == CreditPackKind::Credits, "meter_id": METER_ID}}]
        })
    }

    fn configured() -> Vec<Value> {
        CREDIT_PACK_DEFINITIONS
            .iter()
            .enumerate()
            .map(|(index, definition)| product(definition, (index as f64 + 1.0) * 10_000.0))
            .collect()
    }

    #[test]
    fn credit_packs_are_available_to_every_authenticated_user_and_retain_rollover() {
        let offers = build_credit_pack_offers(&configured(), METER_ID, false).unwrap();
        let credits: Vec<_> = offers
            .iter()
            .filter(|o| o.kind == CreditPackKind::Credits)
            .collect();
        assert_eq!(credits.len(), 3);
        assert!(credits.iter().all(|o| o.eligible && o.rollover));
    }

    #[test]
    fn recharge_packs_require_an_active_paid_subscription_and_remain_non_rollover() {
        let locked = build_credit_pack_offers(&configured(), METER_ID, false).unwrap();
        let locked: Vec<_> = locked
            .iter()
            .filter(|o| o.kind == CreditPackKind::Recharge)
            .collect();
        assert!(locked.iter().all(|o| !o.eligible && !o.rollover));
        assert!(
            locked
                .iter()
                .all(|o| o.eligibility_reason == Some("paid_plan_required"))
        );
        let unlocked = build_credit_pack_offers(&configured(), METER_ID, true).unwrap();
        assert!(
            unlocked
                .iter()
                .filter(|o| o.kind == CreditPackKind::Recharge)
                .all(|o| o.eligible)
        );
    }

    #[test]
    fn catalog_validation_fails_closed_when_polar_rollover_configuration_drifts() {
        let mut drifted = configured();
        drifted[0]["benefits"][0]["properties"]["rollover"] = json!(false);
        assert!(matches!(
            build_credit_pack_offers(&drifted, METER_ID, true),
            Err(CreditPackError::Configuration(_))
        ));
    }

    #[test]
    fn only_the_six_allowlisted_polar_products_resolve_as_credit_packs() {
        assert!(credit_pack_definition(CREDIT_PACK_DEFINITIONS[0].id).is_some());
        assert!(credit_pack_definition("00000000-0000-4000-8000-000000000000").is_none());
    }

    fn ms(text: &str) -> i64 {
        dima_text::parse_date(text).unwrap()
    }

    #[test]
    fn recharge_expiry_reports_the_remaining_paid_plan_cycle_in_whole_days() {
        let now = ms("2026-09-19T12:00:00.000Z");
        assert_eq!(
            recharge_expiry(Some("2026-09-26T12:00:00.000Z"), None, now),
            Some(RechargeExpiry {
                expires_at: "2026-09-26T12:00:00.000Z".into(),
                days_remaining: 7.0
            })
        );
        assert_eq!(
            recharge_expiry(Some("2026-09-20T11:59:59.000Z"), None, now).map(|e| e.days_remaining),
            Some(1.0)
        );
    }

    #[test]
    fn recharge_expiry_uses_the_earlier_subscription_end_and_handles_missing_dates() {
        let now = ms("2026-09-19T12:00:00.000Z");
        assert_eq!(
            recharge_expiry(
                Some("2026-09-29T12:00:00.000Z"),
                Some("2026-09-22T12:00:00.000Z"),
                now
            ),
            Some(RechargeExpiry {
                expires_at: "2026-09-22T12:00:00.000Z".into(),
                days_remaining: 3.0
            })
        );
        assert_eq!(recharge_expiry(Some("not-a-date"), None, now), None);
        assert_eq!(
            recharge_expiry(Some("2026-09-01T00:00:00.000Z"), None, now).map(|e| e.days_remaining),
            Some(0.0)
        );
    }
}
