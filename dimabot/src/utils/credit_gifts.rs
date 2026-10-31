//! Credit gift lifecycle; incomplete until the adapters described in the handoff are connected.
mod lookup;
mod checkout;
mod delivery;

pub use lookup::{normalize_recipient, valid_recipient, GiftRecipient, find_gift_recipient, search_gift_recipients};
pub use checkout::{gift_id, redirect_url, require_checkout, validate_gift_order};
pub use delivery::{gift_announcement, LEASE_MS};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreditGiftRequestError {
    pub message: String,
    pub status_code: u16,
}

impl std::fmt::Display for CreditGiftRequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for CreditGiftRequestError {}

/// Paid-order wakeup using the real MongoDB and Polar transports. The caller
/// supplies the same Gift-policy client used to construct the provider.
#[derive(Clone)]
pub struct CreditGiftAcceptor {
    pub provider: crate::utils::credit_gift_provider::GiftProvider,
    pub polar: crate::utils::polar::PolarClient,
    pub gifts: mongodb::Collection<mongodb::bson::Document>,
    pub users: mongodb::Collection<mongodb::bson::Document>,
}

impl CreditGiftAcceptor {
    pub fn new(polar: crate::utils::polar::PolarClient, database: &mongodb::Database) -> Result<Self, crate::utils::credit_gift_provider::GiftProviderError> {
        let provider = crate::utils::credit_gift_provider::GiftProvider::new(polar.clone())?;
        Ok(Self { provider, polar, gifts: database.collection("creditgifts"), users: database.collection("users") })
    }

    pub async fn accept_credit_gift_paid_order(&self, order_id: &str) -> Result<(), crate::domain_event_contracts::polar_billing::PolarBillingError> {
        use crate::domain_event_contracts::polar_billing::PolarBillingError as E;
        use crate::utils::credit_gift_provider::{GiftCheckout, GiftOrder};
        use mongodb::bson::{doc, DateTime};
        use reqwest::{Method, header::HeaderMap};
        fn path(kind: &str, id: &str) -> String {
            let mut url = reqwest::Url::parse("https://example.invalid/").expect("static URL");
            url.path_segments_mut().expect("base URL").extend(["v1", kind, id]);
            url.path().to_owned()
        }
        let headers = HeaderMap::new();
        let order: GiftOrder = self.polar.request_json(Method::GET, &path("orders", order_id), None, &headers).await.map_err(E::Transport)?;
        if order.metadata.get("source").and_then(|v| v.as_str()) != Some("dimabot_gift_purchase") { return Ok(()); }
        let Some(gift_id) = order.metadata.get("gift_id").and_then(|v| v.as_str()) else { return Ok(()); };
        let mut gift = self.gifts.find_one(doc! {"_id": gift_id}).await.map_err(|e| E::Runtime(e.to_string()))?
            .ok_or_else(|| E::Business("Gift reservation missing for paid order".into()))?;
        let Some(checkout_id) = gift.get_str("checkoutId").ok().filter(|v| !v.is_empty()).map(str::to_owned) else { return Ok(()); };
        let buyer_id = gift.get_object_id("buyerId").map_err(|e| E::Runtime(e.to_string()))?;
        let buyer = self.users.find_one(doc! {"_id": buyer_id}).await.map_err(|e| E::Runtime(e.to_string()))?
            .ok_or_else(|| E::Business("Gift buyer no longer exists".into()))?;
        let checkout: GiftCheckout = self.polar.request_json(Method::GET, &path("checkouts", &checkout_id), None, &headers).await.map_err(E::Transport)?;
        require_checkout(&checkout, &gift, &buyer, false).map_err(|s| E::Business(s.into()))?;
        if let Some(customer) = &checkout.customer_id { gift.insert("buyerCustomerId", customer.clone()); }
        validate_gift_order(&order, &gift, &buyer, false).map_err(|s| E::Business(s.into()))?;
        let now = DateTime::now();
        self.gifts.update_one(doc! {"_id": gift_id, "paidAt": {"$exists": false}}, doc! {"$set": {"paidOrderId": &order.id, "buyerCustomerId": &order.customer_id, "paidAt": now, "status": "payment_received", "nextAttemptAt": now}}).await.map_err(|e| E::Runtime(e.to_string()))?;
        Ok(())
    }
}

impl crate::domain_event_contracts::polar_billing::PolarGiftAcceptor for CreditGiftAcceptor {
    fn accept_credit_gift_paid_order<'a>(&'a self, order_id: &'a str) -> crate::domain_event_contracts::polar_billing::BillingFuture<'a, ()> {
        Box::pin(CreditGiftAcceptor::accept_credit_gift_paid_order(self, order_id))
    }
}
