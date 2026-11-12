//! `requireCheckout` and `validateGiftOrder` (`utils/credit_gifts.ts`): what a Polar checkout
//! and order must show before a gift moves on. Every comparison is the reference's strict
//! equality on the JSON Polar sent (`undefined` is a missing field, `null` is `null`), and every
//! number comparison its coercion ([`crate::js`]).

use super::{Gift, GiftError, is_uuid_v4};
use crate::js::{le_number, number_is, str_at, truthy, truthy_at};
use serde_json::Value;

/// `source` of a purchase checkout and order.
pub const PURCHASE_SOURCE: &str = "dimabot_gift_purchase";
/// `source` of a fulfillment checkout and order.
pub const FULFILLMENT_SOURCE: &str = "dimabot_gift_fulfillment";

/// The owner a checkout or order must belong to: our user id, or its linked Polar customer.
#[derive(Clone, Copy, Debug)]
pub struct Owner<'a> {
    /// `user._id.toString()`.
    pub user_id: &'a str,
    /// `user.polar_sh_customer_id`.
    pub customer_id: Option<&'a str>,
}

impl Owner<'_> {
    /// `UUID.test(user.polar_sh_customer_id || '') ? user.polar_sh_customer_id : null`.
    fn linked(&self) -> Option<&str> {
        self.customer_id.filter(|id| is_uuid_v4(id))
    }
}

/// `a === b` where `a` is a JSON field and `b` a value that may be `undefined`.
fn same_text(value: Option<&Value>, expected: Option<&str>) -> bool {
    match (value, expected) {
        (None, None) => true,
        (Some(Value::String(a)), Some(b)) => a == b,
        _ => false,
    }
}

fn metadata(value: &Value) -> Option<&Value> {
    value.get("metadata").filter(|m| !m.is_null())
}

/// `requireCheckout(checkout, gift, user, fulfillment)`.
pub fn require_checkout(
    checkout: &Value,
    gift: &Gift,
    owner: Owner<'_>,
    fulfillment: bool,
) -> Result<(), GiftError> {
    let product = if fulfillment {
        &gift.fulfillment_product_id
    } else {
        &gift.product_id
    };
    let source = if fulfillment {
        FULFILLMENT_SOURCE
    } else {
        PURCHASE_SOURCE
    };
    let external = checkout.get("customer_external_id");
    let owner_matches = str_at(checkout, "customer_external_id") == Some(owner.user_id)
        || (!truthy(external)
            && owner
                .linked()
                .is_some_and(|linked| str_at(checkout, "customer_id") == Some(linked)));
    let meta = metadata(checkout);
    if !truthy_at(checkout, "id")
        || str_at(checkout, "product_id") != Some(product.as_str())
        || !owner_matches
        || meta.and_then(|m| str_at(m, "gift_id")) != Some(gift.id.as_str())
        || meta.and_then(|m| str_at(m, "source")) != Some(source)
    {
        return Err(GiftError::Failed("Gift checkout identity mismatch".into()));
    }
    let amount = if fulfillment { 0.0 } else { gift.price_amount };
    if !number_is(checkout.get("amount"), amount)
        || !number_is(checkout.get("discount_amount"), 0.0)
        || str_at(checkout, "currency") != Some(gift.price_currency.as_str())
    {
        return Err(GiftError::Failed("Gift checkout price changed".into()));
    }
    if fulfillment
        && (!number_is(checkout.get("total_amount"), 0.0)
            || str_at(checkout, "currency") != Some(gift.price_currency.as_str()))
    {
        return Err(GiftError::Failed("Gift fulfillment must be free".into()));
    }
    if fulfillment
        && !same_text(
            meta.and_then(|m| m.get("parent_order_id")),
            gift.paid_order_id.as_deref(),
        )
    {
        return Err(GiftError::Failed("Gift fulfillment parent changed".into()));
    }
    Ok(())
}

/// `validateGiftOrder(order, gift, user, fulfillment)`. `gift` is the gift the reference passed
/// (with `buyerCustomerId` replaced by the checkout's customer where it did so).
pub fn validate_gift_order(
    order: &Value,
    gift: &Gift,
    owner: Owner<'_>,
    fulfillment: bool,
) -> Result<(), GiftError> {
    let (customer, checkout, product, source) = if fulfillment {
        (
            gift.recipient_customer_id.as_deref(),
            gift.fulfillment_checkout_id.as_deref(),
            gift.fulfillment_product_id.as_str(),
            FULFILLMENT_SOURCE,
        )
    } else {
        (
            gift.buyer_customer_id.as_deref(),
            gift.checkout_id.as_deref(),
            gift.product_id.as_str(),
            PURCHASE_SOURCE,
        )
    };
    let order_customer = order.get("customer").filter(|c| !c.is_null());
    let external = order_customer.and_then(|c| c.get("external_id"));
    let owner_matches = external.and_then(Value::as_str) == Some(owner.user_id)
        || (!truthy(external)
            && owner.customer_id.is_some_and(is_uuid_v4)
            && str_at(order, "customer_id").is_some()
            && str_at(order, "customer_id") == owner.customer_id);
    let meta = metadata(order);
    let total = order.get("total_amount");
    let total_ok = if fulfillment {
        number_is(total, 0.0)
    } else {
        // `order.total_amount <= 0` fails it; a missing amount compares as NaN (passes).
        !le_number(total, 0.0)
    };
    if order.get("paid") != Some(&Value::Bool(true))
        || str_at(order, "status") != Some("paid")
        || truthy_at(order, "subscription_id")
        || !number_is(order.get("refunded_amount"), 0.0)
        || !number_is(order.get("discount_amount"), 0.0)
        || !same_text(order.get("checkout_id"), checkout)
        || str_at(order, "product_id") != Some(product)
        || !same_text(order.get("customer_id"), customer)
        || !same_text(order_customer.and_then(|c| c.get("id")), customer)
        || !owner_matches
        || str_at(order, "currency") != Some(gift.price_currency.as_str())
        || meta.and_then(|m| str_at(m, "gift_id")) != Some(gift.id.as_str())
        || meta.and_then(|m| str_at(m, "source")) != Some(source)
        || !total_ok
    {
        return Err(GiftError::Failed(
            "Gift paid order identity or payment mismatch".into(),
        ));
    }
    if fulfillment
        && !same_text(
            meta.and_then(|m| m.get("parent_order_id")),
            gift.paid_order_id.as_deref(),
        )
    {
        return Err(GiftError::Failed("Gift parent order mismatch".into()));
    }
    if !fulfillment
        && let Some(paid) = gift.paid_order_id.as_deref().filter(|p| !p.is_empty())
        && str_at(order, "id") != Some(paid)
    {
        return Err(GiftError::Failed("Gift paid order changed".into()));
    }
    if fulfillment
        && let Some(known) = gift
            .fulfillment_order_id
            .as_deref()
            .filter(|p| !p.is_empty())
        && str_at(order, "id") != Some(known)
    {
        return Err(GiftError::Failed("Gift fulfillment order changed".into()));
    }
    Ok(())
}
