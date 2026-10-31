//! Stateless purchase identity and payment guards.
use sha2::{Digest, Sha256};
use mongodb::bson::Document;
use crate::utils::credit_gift_provider::{GiftCheckout, GiftOrder};

pub fn gift_id(buyer_user_id: &str, request_id: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{}:{}", buyer_user_id, request_id.to_ascii_lowercase()).as_bytes()))
}

pub fn redirect_url(raw: &str, hosts: &str) -> Result<reqwest::Url, &'static str> {
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid return URL")?;
    let host = match url.host_str() {
        Some(host) => match url.port() { Some(port) => format!("{host}:{port}"), None => host.to_string() },
        None => return Err("Invalid return URL"),
    };
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
        || !hosts.split(',').any(|h| h.trim().eq_ignore_ascii_case(&host)) {
        return Err("Invalid return URL");
    }
    Ok(url)
}

fn value<'a>(doc: &'a Document, key: &str) -> &'a str { doc.get_str(key).unwrap_or("") }
fn owner_matches(external: Option<&str>, customer: Option<&str>, user: &Document) -> bool {
    let id = user.get_object_id("_id").ok().map(|v| v.to_hex()).unwrap_or_default();
    if external.is_some_and(|v| !v.is_empty()) { return external == Some(id.as_str()); }
    let linked = value(user, "polar_sh_customer_id");
    let valid = uuid::Uuid::parse_str(linked).is_ok_and(|u| u.get_version_num() == 4 && u.get_variant() == uuid::Variant::RFC4122);
    valid && customer == Some(linked)
}

pub fn require_checkout(checkout: &GiftCheckout, gift: &Document, user: &Document, fulfillment: bool) -> Result<(), &'static str> {
    let product = value(gift, if fulfillment { "fulfillmentProductId" } else { "productId" });
    let source = if fulfillment { "dimabot_gift_fulfillment" } else { "dimabot_gift_purchase" };
    if checkout.id.is_empty() || checkout.product_id.as_deref() != Some(product)
        || !owner_matches(checkout.customer_external_id.as_deref(), checkout.customer_id.as_deref(), user)
        || checkout.metadata.get("gift_id").and_then(|v| v.as_str()) != Some(value(gift, "_id"))
        || checkout.metadata.get("source").and_then(|v| v.as_str()) != Some(source) {
        return Err("Gift checkout identity mismatch");
    }
    let price = gift.get_f64("priceAmount").ok().or_else(|| gift.get_i32("priceAmount").ok().map(f64::from)).or_else(|| gift.get_i64("priceAmount").ok().map(|n| n as f64)).unwrap_or(f64::NAN);
    if checkout.amount != if fulfillment { 0.0 } else { price } || checkout.discount_amount != 0.0 || checkout.currency != value(gift, "priceCurrency") { return Err("Gift checkout price changed"); }
    if fulfillment && checkout.total_amount != 0.0 { return Err("Gift fulfillment must be free"); }
    if fulfillment && checkout.metadata.get("parent_order_id").and_then(|v| v.as_str()) != Some(value(gift, "paidOrderId")) { return Err("Gift fulfillment parent changed"); }
    Ok(())
}

pub fn validate_gift_order(order: &GiftOrder, gift: &Document, user: &Document, fulfillment: bool) -> Result<(), &'static str> {
    let customer = value(gift, if fulfillment { "recipientCustomerId" } else { "buyerCustomerId" });
    let checkout = value(gift, if fulfillment { "fulfillmentCheckoutId" } else { "checkoutId" });
    let product = value(gift, if fulfillment { "fulfillmentProductId" } else { "productId" });
    let source = if fulfillment { "dimabot_gift_fulfillment" } else { "dimabot_gift_purchase" };
    if !order.paid || order.status != "paid" || order.subscription_id.as_ref().is_some_and(|s| !s.is_empty()) || order.refunded_amount != 0.0 || order.discount_amount != 0.0
        || order.checkout_id.as_deref() != Some(checkout) || order.product_id != product || order.customer_id != customer || order.customer.id != customer
        || !owner_matches(order.customer.external_id.as_deref(), Some(&order.customer_id), user) || order.currency != value(gift, "priceCurrency")
        || order.metadata.get("gift_id").and_then(|v| v.as_str()) != Some(value(gift, "_id")) || order.metadata.get("source").and_then(|v| v.as_str()) != Some(source)
        || if fulfillment { order.total_amount != 0.0 } else { order.total_amount <= 0.0 } { return Err("Gift paid order identity or payment mismatch"); }
    if fulfillment && order.metadata.get("parent_order_id").and_then(|v| v.as_str()) != Some(value(gift, "paidOrderId")) { return Err("Gift parent order mismatch"); }
    let prior = value(gift, if fulfillment { "fulfillmentOrderId" } else { "paidOrderId" });
    if !prior.is_empty() && prior != order.id { return Err(if fulfillment { "Gift fulfillment order changed" } else { "Gift paid order changed" }); }
    Ok(())
}
