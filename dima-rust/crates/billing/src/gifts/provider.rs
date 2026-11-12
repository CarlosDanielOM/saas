//! `utils/credit_gift_provider.ts`: the Polar side of a gift. The pack pairs, the validation of
//! the two products of a pair, the catalog, the bounded recovery of a checkout whose creation
//! answer was lost, the order of a checkout, and the confirmation that the recipient's meter
//! credit was granted.
//!
//! Every call uses the gift profile of the Polar client (15 s, redirects refused,
//! [`crate::polar::Profile::Gift`]). Answers are read loosely, as the reference reads them, and
//! kept as JSON behind [`GiftValue`], whose `Debug` prints nothing (a checkout carries its client
//! secret and URL, an order the customer's e-mail).

use super::GiftError;
use crate::js::{ge_number, str_at, truthy_at};
use crate::polar::{PolarClient, PolarError};
use crate::products::{AI_CREDITS_METER_ID, GIFT_PACK_PAIRS, GiftPackPair};
use serde_json::Value;

/// Pages a recovery or a grant lookup reads at most (`for (page = 1; page <= 5; page++)`).
pub const MAX_PAGES: u32 = 5;

/// A Polar answer kept as JSON. Its `Debug` is redacted.
#[derive(Clone, PartialEq)]
pub struct GiftValue(pub Value);

impl std::fmt::Debug for GiftValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GiftValue(<redacted>)")
    }
}

impl GiftValue {
    /// A field.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    /// A text field (`None` when missing or not text).
    pub fn text(&self, key: &str) -> Option<&str> {
        str_at(&self.0, key)
    }
}

/// `GiftOffer`: what the buyer sees.
#[derive(Clone, Debug, PartialEq)]
pub struct GiftOffer {
    /// The paid product.
    pub id: String,
    /// `paid.name?.trim() || 'Gift credits'`.
    pub name: String,
    /// Credits given.
    pub credits: f64,
    /// Price, in the currency's minor unit.
    pub price_amount: f64,
    /// Lower-case currency.
    pub price_currency: String,
}

impl GiftOffer {
    /// `{id, name, credits, rollover: true, priceAmount, priceCurrency}`.
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "id": self.id,
            "name": self.name,
            "credits": crate::js::json_number(self.credits),
            "rollover": true,
            "priceAmount": crate::js::json_number(self.price_amount),
            "priceCurrency": self.price_currency,
        })
    }
}

/// A validated pair (`validateGiftPair`).
#[derive(Clone, Debug, PartialEq)]
pub struct GiftPair {
    /// The offer.
    pub offer: GiftOffer,
    /// The free product that delivers the credits.
    pub fulfillment_product_id: String,
    /// Its meter-credit benefit.
    pub benefit_id: String,
}

/// The message the reference's `giftPolarRequest` threw for a failed call.
pub fn provider_message(error: &PolarError) -> String {
    match error {
        PolarError::NotConfigured => "Gift provider is not configured".into(),
        PolarError::Status { status, .. } => format!("Gift provider request failed ({status})"),
        PolarError::Transport { .. } => "Gift provider connection interrupted".into(),
        // Intended difference: V8's `response.json()` message (`Unexpected token…`) is not
        // reproduced; a body read that fails after the headers was V8's `terminated`.
        PolarError::Decode { .. } => "Gift provider answered with invalid JSON".into(),
        // An id that cannot be a path segment: the reference sent it raw (a different path,
        // usually a 404).
        PolarError::InvalidInput(_) => "Gift provider request refused before sending".into(),
        PolarError::IncompleteHistory { .. } => "Gift provider list is incomplete".into(),
    }
}

/// A failed provider call as the error the reference threw.
pub fn provider_error(error: &PolarError) -> GiftError {
    GiftError::Provider {
        message: provider_message(error),
        outcome_unknown: error.outcome_unknown(),
    }
}

fn failed(message: &str) -> GiftError {
    GiftError::Failed(message.to_owned())
}

/// The pair of a paid product.
pub fn pair_of(product_id: &str) -> Option<&'static GiftPackPair> {
    GIFT_PACK_PAIRS.iter().find(|p| p.product_id == product_id)
}

/// The prices `price(p)` keeps: `one_time`, `fixed`, not archived. `None` when `prices` is not
/// an array (the reference threw a `TypeError` there).
fn fixed_prices(product: &Value) -> Option<Vec<&Value>> {
    Some(
        product
            .get("prices")?
            .as_array()?
            .iter()
            .filter(|c| {
                str_at(c, "type") == Some("one_time")
                    && str_at(c, "amount_type") == Some("fixed")
                    && !truthy_at(c, "is_archived")
            })
            .collect(),
    )
}

fn benefits(product: &Value) -> Option<&Vec<Value>> {
    product.get("benefits")?.as_array()
}

/// `validateGiftPair(paid, free)`.
pub fn validate_gift_pair(paid: &Value, free: &Value) -> Result<GiftPair, GiftError> {
    let pair = GIFT_PACK_PAIRS.iter().find(|p| {
        str_at(paid, "id") == Some(p.product_id)
            && str_at(free, "id") == Some(p.fulfillment_product_id)
    });
    let unavailable = |p: &Value| {
        truthy_at(p, "is_archived")
            || truthy_at(p, "is_recurring")
            || str_at(p, "visibility") == Some("draft")
    };
    let Some(pair) = pair.filter(|_| !unavailable(paid) && !unavailable(free)) else {
        return Err(failed("Gift pack is unavailable"));
    };
    let invalid = || failed("Gift pack prices or benefits are invalid");
    let (Some(purchase), Some(delivery)) = (fixed_prices(paid), fixed_prices(free)) else {
        return Err(invalid());
    };
    let (Some(paid_benefits), Some(free_benefits)) = (benefits(paid), benefits(free)) else {
        return Err(invalid());
    };
    let (Some(purchase), Some(delivery)) = (
        purchase.first().filter(|_| purchase.len() == 1),
        delivery.first().filter(|_| delivery.len() == 1),
    ) else {
        return Err(invalid());
    };
    let amount = purchase.get("price_amount").and_then(Value::as_f64);
    let currency = purchase.get("price_currency");
    let delivery_currency = delivery.get("price_currency");
    // `.toLowerCase()` of a currency that is not text threw in the reference.
    let lower = |v: Option<&Value>| match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.to_lowercase())),
        Some(_) => Err(()),
    };
    let (Ok(currency_lower), Ok(delivery_lower)) = (lower(currency), lower(delivery_currency))
    else {
        return Err(invalid());
    };
    let safe_positive = amount.is_some_and(|a| crate::js::is_safe_integer(a) && a > 0.0);
    if !safe_positive
        || !crate::js::truthy(currency)
        || delivery.get("price_amount").and_then(Value::as_f64) != Some(0.0)
        || delivery_lower != currency_lower
        || !paid_benefits.is_empty()
        || free_benefits.len() != 1
    {
        return Err(invalid());
    }
    let Some(benefit) = free_benefits.first() else {
        return Err(invalid());
    };
    let properties = benefit.get("properties");
    let property = |key: &str| properties.and_then(|p| p.get(key));
    if !truthy_at(benefit, "id")
        || str_at(benefit, "type") != Some("meter_credit")
        || truthy_at(benefit, "is_deleted")
        || property("meter_id").and_then(Value::as_str) != Some(AI_CREDITS_METER_ID)
        || property("rollover") != Some(&Value::Bool(true))
        || property("units").and_then(Value::as_f64) != Some(f64::from(pair.credits))
    {
        return Err(failed(
            "Gift pack must grant the configured permanent credits",
        ));
    }
    // `paid.name?.trim() || 'Gift credits'`; a name that is truthy but not text threw a
    // `TypeError` in the reference (intended difference: refused as unavailable).
    let name = match paid.get("name") {
        None | Some(Value::Null) => "Gift credits".to_owned(),
        Some(Value::String(text)) => {
            let trimmed = dima_text::trim(text);
            if trimmed.is_empty() {
                "Gift credits".to_owned()
            } else {
                trimmed.to_owned()
            }
        }
        Some(other) if !crate::js::truthy(Some(other)) => "Gift credits".to_owned(),
        Some(_) => return Err(failed("Gift pack is unavailable")),
    };
    let (Some(benefit_id), Some(price_amount), Some(price_currency)) =
        (str_at(benefit, "id"), amount, currency_lower)
    else {
        return Err(invalid());
    };
    Ok(GiftPair {
        offer: GiftOffer {
            id: pair.product_id.to_owned(),
            name,
            credits: f64::from(pair.credits),
            price_amount,
            price_currency,
        },
        fulfillment_product_id: pair.fulfillment_product_id.to_owned(),
        benefit_id: benefit_id.to_owned(),
    })
}

/// `loadGiftPair(productId)`: both products, read at the same time.
pub async fn load_gift_pair(polar: &PolarClient, product_id: &str) -> Result<GiftPair, GiftError> {
    let Some(pair) = pair_of(product_id) else {
        return Err(failed("Unknown gift pack"));
    };
    let (paid, free) = futures_util::future::join(
        polar.get_gift_product(pair.product_id),
        polar.get_gift_product(pair.fulfillment_product_id),
    )
    .await;
    let paid = paid.map_err(|e| provider_error(&e))?;
    let free = free.map_err(|e| provider_error(&e))?;
    validate_gift_pair(&paid, &free)
}

/// `getGiftPackCatalog()`: `{offers}`, every pair read at the same time; one failure fails it.
pub async fn gift_pack_catalog(polar: &PolarClient) -> Result<Vec<GiftOffer>, GiftError> {
    let loads = GIFT_PACK_PAIRS
        .iter()
        .map(|pair| load_gift_pair(polar, pair.product_id));
    futures_util::future::join_all(loads)
        .await
        .into_iter()
        .map(|pair| pair.map(|pair| pair.offer))
        .collect()
}

/// `{offers: [...]}` as the route sends it.
pub fn catalog_json(offers: &[GiftOffer]) -> Value {
    serde_json::json!({ "offers": offers.iter().map(GiftOffer::to_json).collect::<Vec<_>>() })
}

/// The `items` of a page; the reference threw a `TypeError` when they are not an array.
fn items(page: &Value) -> Result<&Vec<Value>, GiftError> {
    page.get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| failed("Gift provider answered with an unexpected list"))
}

/// `page >= result.pagination.max_page` (`pagination` missing threw a `TypeError`).
fn last_page(page: u32, result: &Value) -> Result<bool, GiftError> {
    let Some(pagination) = result.get("pagination").filter(|p| !p.is_null()) else {
        return Err(failed("Gift provider answered with an unexpected list"));
    };
    Ok(ge_number(f64::from(page), pagination.get("max_page")))
}

/// `recoverGiftCheckout(giftId, productId, userId)`: the checkout of this gift among the
/// user's checkouts of the product, within [`MAX_PAGES`]. An ambiguous create never becomes a
/// second create: more than one match, or more pages, is an error.
pub async fn recover_gift_checkout(
    polar: &PolarClient,
    gift_id: &str,
    product_id: &str,
    user_id: &str,
) -> Result<Option<GiftValue>, GiftError> {
    let mut matches = Vec::new();
    for page in 1..=MAX_PAGES {
        let result = polar
            .list_checkouts_page(product_id, user_id, page)
            .await
            .map_err(|e| provider_error(&e))?;
        matches.extend(
            items(&result)?
                .iter()
                .filter(|c| {
                    c.get("metadata")
                        .and_then(|m| m.get("gift_id"))
                        .and_then(Value::as_str)
                        == Some(gift_id)
                })
                .cloned(),
        );
        if last_page(page, &result)? {
            if matches.len() > 1 {
                return Err(failed("Multiple gift checkouts require support"));
            }
            return Ok(matches.into_iter().next().map(GiftValue));
        }
    }
    Err(failed("Gift checkout recovery requires support"))
}

/// `getGiftCheckoutOrder(checkoutId)`: the one order of a checkout, if any.
pub async fn gift_checkout_order(
    polar: &PolarClient,
    checkout_id: &str,
) -> Result<Option<GiftValue>, GiftError> {
    let result = polar
        .list_orders_for_checkout(checkout_id)
        .await
        .map_err(|e| provider_error(&e))?;
    let items = items(&result)?;
    if items.len() > 1 {
        return Err(failed("Multiple gift orders require support"));
    }
    Ok(items.first().cloned().map(GiftValue))
}

/// `getGiftCreditGrant(orderId, customerId, benefitId, credits)`: the recipient's grant of this
/// order's benefit, once Polar granted it (`None` before), within [`MAX_PAGES`].
pub async fn gift_credit_grant(
    polar: &PolarClient,
    order_id: &str,
    customer_id: &str,
    benefit_id: &str,
    credits: f64,
) -> Result<Option<GiftValue>, GiftError> {
    for page in 1..=MAX_PAGES {
        let result = polar
            .list_benefit_grants_page(customer_id, page)
            .await
            .map_err(|e| provider_error(&e))?;
        let grant = items(&result)?.iter().find(|g| {
            str_at(g, "order_id") == Some(order_id)
                && str_at(g, "customer_id") == Some(customer_id)
                && str_at(g, "benefit_id") == Some(benefit_id)
        });
        if let Some(grant) = grant {
            if truthy_at(grant, "is_revoked") {
                return Err(failed("Gift credit grant was revoked"));
            }
            if !truthy_at(grant, "is_granted") {
                return Ok(None);
            }
            // Public REST returns empty internal grant properties; Polar sets `is_granted` only
            // after the meter strategy created its credit event and updated the meter.
            let benefit = grant.get("benefit");
            let property = |key: &str| {
                benefit
                    .and_then(|b| b.get("properties"))
                    .and_then(|p| p.get(key))
            };
            let granted = grant
                .get("granted_at")
                .filter(|v| crate::js::truthy(Some(v)))
                .and_then(Value::as_str)
                .and_then(dima_text::parse_date);
            if granted.is_none()
                || benefit.and_then(|b| str_at(b, "id")) != Some(benefit_id)
                || benefit.and_then(|b| str_at(b, "type")) != Some("meter_credit")
                || property("meter_id").and_then(Value::as_str) != Some(AI_CREDITS_METER_ID)
                || property("units").and_then(Value::as_f64) != Some(credits)
                || property("rollover") != Some(&Value::Bool(true))
            {
                return Err(failed(
                    "Gift grant permanent credit confirmation is missing",
                ));
            }
            return Ok(Some(GiftValue(grant.clone())));
        }
        if last_page(page, &result)? {
            return Ok(None);
        }
    }
    Err(failed("Gift credit grant lookup requires support"))
}
