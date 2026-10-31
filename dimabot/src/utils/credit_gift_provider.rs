//! Gift credit-pack provider for the Twitch-extension gift flow.
//!
//! Source contract: `dimabot/src/utils/credit_gift_provider.ts`
//! (`GIFT_PACK_PAIRS`, `GiftOffer`, `GiftProduct`, `GiftCheckout`, `GiftOrder`,
//! `GiftGrant`, `GiftProviderError`, `giftPolarRequest`, `validateGiftPair`,
//! `loadGiftPair`, `getGiftPackCatalog`, `recoverGiftCheckout`,
//! `getGiftCheckoutOrder`, `getGiftCreditGrant`).
//!
//! Preserved behaviour: the same three product/fulfillment pairs and credit
//! amounts, the same validation order and messages, the same bounded recovery
//! scans (5 pages), the same `-created_at` sorting and `limit=100`/`limit=2`
//! queries, and the same rule that an ambiguous create NEVER becomes a second
//! create. All HTTP goes through the already-ported Gift policy of
//! `utils::polar`, which supplies the 15-second total timeout, redirect
//! rejection, and body-free `Gift provider request failed ({status})` errors.
//!
//! Deliberately NOT here: the purchase/grant orchestration (checkout creation,
//! webhook fulfilment, credit balance mutation), environment-file loading, or
//! any second HTTP client. A caller that receives `mutation_outcome_unknown`
//! must reconcile with `recover_gift_checkout` rather than creating again.
//! Missing optional provider fields are reported as typed errors instead of the
//! source's `TypeError` on `undefined` arrays/properties; that is the only
//! intentional difference and it never turns a failure into a success.

use super::{
    ai_credit_projection::AI_CREDITS_METER_ID,
    js_date::parse_date,
    polar::{PolarClient, PolarError, PolarPolicy},
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

/// One configured gift pair: the paid product, its zero-priced fulfillment
/// product, and the permanent credit amount the fulfillment benefit grants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GiftPackPair {
    pub product_id: &'static str,
    pub fulfillment_product_id: &'static str,
    pub credits: i64,
}

/// `GIFT_PACK_PAIRS`, in source order.
pub const GIFT_PACK_PAIRS: &[GiftPackPair] = &[
    GiftPackPair {
        product_id: "6e0c530d-affc-44be-a51b-e11453ef1fa7",
        fulfillment_product_id: "f14a61f4-a572-4c05-bf4e-1b013d0dc77a",
        credits: 40_000,
    },
    GiftPackPair {
        product_id: "815d0efe-1d23-4fca-8762-ae3a9253b0bc",
        fulfillment_product_id: "019b6291-80a0-4b31-bb09-feaaa9afe5eb",
        credits: 250_000,
    },
    GiftPackPair {
        product_id: "7d0d5f0e-102a-4255-abf3-6f379e2da4ce",
        fulfillment_product_id: "3f6010b6-4108-4bf9-ab83-b035eeed6962",
        credits: 550_000,
    },
];

/// Source lookup semantics for `GIFT_PACK_PAIRS.find(p => p.productId === id)`.
pub fn find_gift_pair(product_id: &str) -> Option<&'static GiftPackPair> {
    GIFT_PACK_PAIRS
        .iter()
        .find(|pair| pair.product_id == product_id)
}

/// Source lookup semantics for
/// `GIFT_PACK_PAIRS.find(p => p.fulfillmentProductId === id)`.
pub fn find_gift_pair_by_fulfillment(product_id: &str) -> Option<&'static GiftPackPair> {
    GIFT_PACK_PAIRS
        .iter()
        .find(|pair| pair.fulfillment_product_id == product_id)
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct GiftPrice {
    #[serde(rename = "type")]
    pub price_type: Option<String>,
    pub amount_type: Option<String>,
    pub price_amount: Option<f64>,
    pub price_currency: Option<String>,
    pub is_archived: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct GiftBenefitProperties {
    pub units: Option<f64>,
    pub rollover: Option<bool>,
    pub meter_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct GiftBenefit {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub benefit_type: Option<String>,
    pub is_deleted: Option<bool>,
    pub properties: Option<GiftBenefitProperties>,
}

/// `GiftProduct`. Provider arrays default to empty so a malformed product is
/// rejected by the documented validation messages rather than a decode failure.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct GiftProduct {
    pub id: Option<String>,
    pub name: Option<String>,
    pub is_archived: Option<bool>,
    pub is_recurring: Option<bool>,
    pub visibility: Option<String>,
    #[serde(default)]
    pub prices: Vec<GiftPrice>,
    #[serde(default)]
    pub benefits: Vec<GiftBenefit>,
}

/// `GiftOffer`; `rollover` is always `true` for gift credits.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftOffer {
    pub id: String,
    pub name: String,
    pub credits: i64,
    pub rollover: bool,
    pub price_amount: f64,
    pub price_currency: String,
}

/// `{ offer, fulfillmentProductId, benefitId }` from `validateGiftPair`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftPairValidation {
    pub offer: GiftOffer,
    pub fulfillment_product_id: String,
    pub benefit_id: String,
}

/// A gift checkout carries a client secret, so this type intentionally implements
/// neither `Debug` nor `Serialize`: never log its URL or path.
#[derive(Clone, Default, Deserialize)]
pub struct GiftCheckout {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub client_secret: String,
    #[serde(default)]
    pub status: String,
    pub product_id: Option<String>,
    pub customer_id: Option<String>,
    pub customer_external_id: Option<String>,
    #[serde(default)]
    pub amount: f64,
    #[serde(default)]
    pub discount_amount: f64,
    #[serde(default)]
    pub total_amount: f64,
    #[serde(default)]
    pub currency: String,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct GiftOrderCustomer {
    #[serde(default)]
    pub id: String,
    pub external_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct GiftOrder {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub paid: bool,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub product_id: String,
    pub checkout_id: Option<String>,
    pub subscription_id: Option<String>,
    #[serde(default)]
    pub customer_id: String,
    #[serde(default)]
    pub customer: GiftOrderCustomer,
    #[serde(default)]
    pub net_amount: f64,
    #[serde(default)]
    pub total_amount: f64,
    #[serde(default)]
    pub discount_amount: f64,
    #[serde(default)]
    pub refunded_amount: f64,
    #[serde(default)]
    pub currency: String,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct GiftGrantBenefit {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type", default)]
    pub benefit_type: String,
    #[serde(default)]
    pub properties: GiftGrantProperties,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct GiftGrantProperties {
    pub meter_id: Option<String>,
    pub units: Option<f64>,
    pub rollover: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct GiftGrant {
    #[serde(default)]
    pub id: String,
    pub order_id: Option<String>,
    #[serde(default)]
    pub customer_id: String,
    #[serde(default)]
    pub benefit_id: String,
    #[serde(default)]
    pub is_granted: bool,
    #[serde(default)]
    pub is_revoked: bool,
    pub granted_at: Option<String>,
    #[serde(default)]
    pub benefit: GiftGrantBenefit,
}

/// `{ offers }` from `getGiftPackCatalog`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GiftCatalog {
    pub offers: Vec<GiftOffer>,
}

/// Typed `GiftProviderError`. Business variants keep the source's exact message;
/// transport failures delegate to the Gift-policy [`PolarError`] display, which
/// already reproduces `Gift provider is not configured`,
/// `Gift provider connection interrupted`, and
/// `Gift provider request failed ({status})` without exposing bodies.
#[derive(Debug, Clone, PartialEq)]
pub enum GiftProviderError {
    Transport(PolarError),
    Unavailable,
    InvalidPricesOrBenefits,
    InvalidCreditGrant,
    UnknownGiftPack,
    MultipleGiftCheckouts,
    GiftCheckoutRecoveryRequiresSupport,
    MultipleGiftOrders,
    GiftGrantRevoked,
    GiftGrantConfirmationMissing,
    GiftGrantLookupRequiresSupport,
    WrongPolicy,
}

impl GiftProviderError {
    /// Provider status where one exists, mirroring the source class's `status`.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Transport(error) => error.status(),
            _ => None,
        }
    }

    /// True when a write may have reached the provider; never create again.
    pub fn mutation_outcome_unknown(&self) -> bool {
        match self {
            Self::Transport(error) => error.mutation_outcome_unknown(),
            _ => false,
        }
    }
}

impl fmt::Display for GiftProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(error) => error.fmt(f),
            Self::Unavailable => f.write_str("Gift pack is unavailable"),
            Self::InvalidPricesOrBenefits => f.write_str("Gift pack prices or benefits are invalid"),
            Self::InvalidCreditGrant => {
                f.write_str("Gift pack must grant the configured permanent credits")
            }
            Self::UnknownGiftPack => f.write_str("Unknown gift pack"),
            Self::MultipleGiftCheckouts => f.write_str("Multiple gift checkouts require support"),
            Self::GiftCheckoutRecoveryRequiresSupport => {
                f.write_str("Gift checkout recovery requires support")
            }
            Self::MultipleGiftOrders => f.write_str("Multiple gift orders require support"),
            Self::GiftGrantRevoked => f.write_str("Gift credit grant was revoked"),
            Self::GiftGrantConfirmationMissing => {
                f.write_str("Gift grant permanent credit confirmation is missing")
            }
            Self::GiftGrantLookupRequiresSupport => {
                f.write_str("Gift credit grant lookup requires support")
            }
            Self::WrongPolicy => f.write_str("Gift provider requires the Gift Polar policy"),
        }
    }
}

impl std::error::Error for GiftProviderError {}

impl From<PolarError> for GiftProviderError {
    fn from(error: PolarError) -> Self {
        Self::Transport(error)
    }
}

/// JS `String.prototype.trim()` also removes U+FEFF, which Rust's `trim` does not.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}')
}

/// `Number.isSafeInteger`.
fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

/// Application/x-www-form-urlencoded serialization used by `URLSearchParams`.
/// Unreserved characters stay literal, a space becomes `+`, and everything else
/// is percent-encoded with uppercase hex.
fn encode_form_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// `encodeURIComponent`, used by the credit-source `/v1/orders/{id}` path.
pub(crate) fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*'
            | b'\'' | b'(' | b')' => out.push(*byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn query_path(path: &str, pairs: &[(&str, String)]) -> String {
    let mut out = String::from(path);
    out.push('?');
    for (index, (key, value)) in pairs.iter().enumerate() {
        if index > 0 {
            out.push('&');
        }
        out.push_str(&encode_form_component(key));
        out.push('=');
        out.push_str(&encode_form_component(value));
    }
    out
}

/// `validateGiftPair`. Validation order is the source's: pair/state, then prices
/// and benefit counts, then the exact permanent-credit benefit, then the offer.
pub fn validate_gift_pair(
    paid: &GiftProduct,
    free: &GiftProduct,
) -> Result<GiftPairValidation, GiftProviderError> {
    let paid_id = paid.id.as_deref().unwrap_or_default();
    let free_id = free.id.as_deref().unwrap_or_default();
    let pair = GIFT_PACK_PAIRS
        .iter()
        .find(|pair| pair.product_id == paid_id && pair.fulfillment_product_id == free_id);

    let unusable = |product: &GiftProduct| {
        product.is_archived == Some(true)
            || product.is_recurring == Some(true)
            || product.visibility.as_deref() == Some("draft")
    };
    let Some(pair) = pair else {
        return Err(GiftProviderError::Unavailable);
    };
    if unusable(paid) || unusable(free) {
        return Err(GiftProviderError::Unavailable);
    }

    let purchasable = |product: &GiftProduct| {
        product
            .prices
            .iter()
            .filter(|price| {
                price.price_type.as_deref() == Some("one_time")
                    && price.amount_type.as_deref() == Some("fixed")
                    && price.is_archived != Some(true)
            })
            .collect::<Vec<_>>()
    };
    let purchase_prices = purchasable(paid);
    let delivery_prices = purchasable(free);
    let purchase = purchase_prices
        .first()
        .copied()
        .filter(|_| purchase_prices.len() == 1 && delivery_prices.len() == 1);
    let delivery = delivery_prices.first().copied();
    let (Some(purchase), Some(delivery)) = (purchase, delivery) else {
        return Err(GiftProviderError::InvalidPricesOrBenefits);
    };

    let purchase_amount = purchase.price_amount.unwrap_or(f64::NAN);
    let purchase_currency = purchase
        .price_currency
        .as_deref()
        .filter(|currency| !currency.is_empty());
    let currencies_match = delivery
        .price_currency
        .as_deref()
        .map(str::to_lowercase)
        == purchase_currency.map(str::to_lowercase);
    if !is_safe_integer(purchase_amount)
        || purchase_amount <= 0.0
        || purchase_currency.is_none()
        || delivery.price_amount != Some(0.0)
        || !currencies_match
        || !paid.benefits.is_empty()
        || free.benefits.len() != 1
    {
        return Err(GiftProviderError::InvalidPricesOrBenefits);
    }
    let (Some(purchase_currency), Some(purchase_amount)) = (purchase_currency, purchase.price_amount)
    else {
        return Err(GiftProviderError::InvalidPricesOrBenefits);
    };

    let benefit = &free.benefits[0];
    let properties = benefit.properties.as_ref();
    if benefit.id.as_deref().is_none_or(|id| id.is_empty())
        || benefit.benefit_type.as_deref() != Some("meter_credit")
        || benefit.is_deleted == Some(true)
        || properties.and_then(|p| p.meter_id.as_deref()) != Some(AI_CREDITS_METER_ID)
        || properties.and_then(|p| p.rollover) != Some(true)
        || properties.and_then(|p| p.units) != Some(pair.credits as f64)
    {
        return Err(GiftProviderError::InvalidCreditGrant);
    }
    let benefit_id = benefit.id.clone().unwrap_or_default();

    let name = paid
        .name
        .as_deref()
        .map(js_trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Gift credits");
    Ok(GiftPairValidation {
        offer: GiftOffer {
            id: paid_id.to_owned(),
            name: name.to_owned(),
            credits: pair.credits,
            rollover: true,
            price_amount: purchase_amount,
            price_currency: purchase_currency.to_lowercase(),
        },
        fulfillment_product_id: free_id.to_owned(),
        benefit_id,
    })
}

#[derive(Default, Deserialize)]
struct GiftCheckoutList {
    #[serde(default)]
    items: Vec<GiftCheckout>,
    pagination: Option<GiftPagination>,
}

#[derive(Debug, Default, Deserialize)]
struct GiftOrderList {
    #[serde(default)]
    items: Vec<GiftOrder>,
}

#[derive(Debug, Default, Deserialize)]
struct GiftGrantList {
    #[serde(default)]
    items: Vec<GiftGrant>,
    pagination: Option<GiftPagination>,
}

#[derive(Debug, Default, Deserialize)]
struct GiftPagination {
    max_page: Option<f64>,
}

const RECOVERY_PAGES: u32 = 5;

/// Gift-polar-backed provider. Construction performs no IO and reads no
/// environment; the client must have been built with [`PolarPolicy::Gift`].
#[derive(Clone)]
pub struct GiftProvider {
    polar: PolarClient,
}

impl GiftProvider {
    /// Rejects a billing-policy client rather than silently changing redirect,
    /// timeout, and error-body behaviour.
    pub fn new(polar: PolarClient) -> Result<Self, GiftProviderError> {
        if polar.policy() != PolarPolicy::Gift {
            return Err(GiftProviderError::WrongPolicy);
        }
        Ok(Self { polar })
    }

    /// Explicit environment loading through the shared transport.
    pub fn from_env() -> Result<Self, GiftProviderError> {
        let polar = PolarClient::from_env(PolarPolicy::Gift)?;
        Self::new(polar)
    }

    fn no_headers() -> reqwest::header::HeaderMap {
        reqwest::header::HeaderMap::new()
    }

    async fn get_product(&self, product_id: &str) -> Result<GiftProduct, GiftProviderError> {
        Ok(self
            .polar
            .request_json(
                Method::GET,
                &format!("/v1/products/{product_id}"),
                None,
                &Self::no_headers(),
            )
            .await?)
    }

    /// `loadGiftPair`: an unconfigured product id is rejected, then the paid and
    /// fulfillment products are fetched concurrently and validated together.
    pub async fn load_gift_pair(
        &self,
        product_id: &str,
    ) -> Result<GiftPairValidation, GiftProviderError> {
        let pair = find_gift_pair(product_id).ok_or(GiftProviderError::UnknownGiftPack)?;
        let (paid, free) = tokio::try_join!(
            self.get_product(pair.product_id),
            self.get_product(pair.fulfillment_product_id)
        )?;
        validate_gift_pair(&paid, &free)
    }

    /// `getGiftPackCatalog`: offers for every configured pair, in pair order.
    pub async fn get_gift_pack_catalog(&self) -> Result<GiftCatalog, GiftProviderError> {
        let mut offers = Vec::with_capacity(GIFT_PACK_PAIRS.len());
        for pair in GIFT_PACK_PAIRS {
            offers.push(self.load_gift_pair(pair.product_id).await?.offer);
        }
        Ok(GiftCatalog { offers })
    }

    /// Bounded recovery scan (5 pages, newest first). An ambiguous result is a
    /// typed failure so the caller never starts a second checkout.
    pub async fn recover_gift_checkout(
        &self,
        gift_id: &str,
        product_id: &str,
        user_id: &str,
    ) -> Result<Option<GiftCheckout>, GiftProviderError> {
        let mut matches: Vec<GiftCheckout> = Vec::new();
        for page in 1..=RECOVERY_PAGES {
            let path = query_path(
                "/v1/checkouts/",
                &[
                    ("product_id", product_id.to_owned()),
                    ("external_customer_id", user_id.to_owned()),
                    ("limit", "100".to_owned()),
                    ("page", page.to_string()),
                    ("sorting", "-created_at".to_owned()),
                ],
            );
            let result: GiftCheckoutList = self
                .polar
                .request_json(Method::GET, &path, None, &Self::no_headers())
                .await?;
            matches.extend(
                result.items.into_iter().filter(|checkout| {
                    checkout.metadata.get("gift_id").and_then(Value::as_str) == Some(gift_id)
                }),
            );
            if page as f64 >= result.pagination.and_then(|p| p.max_page).unwrap_or(1.0) {
                if matches.len() > 1 {
                    return Err(GiftProviderError::MultipleGiftCheckouts);
                }
                return Ok(matches.pop());
            }
        }
        Err(GiftProviderError::GiftCheckoutRecoveryRequiresSupport)
    }

    /// `getGiftCheckoutOrder`: at most one order may exist for a checkout.
    pub async fn get_gift_checkout_order(
        &self,
        checkout_id: &str,
    ) -> Result<Option<GiftOrder>, GiftProviderError> {
        let path = query_path(
            "/v1/orders/",
            &[
                ("checkout_id", checkout_id.to_owned()),
                ("limit", "2".to_owned()),
            ],
        );
        let result: GiftOrderList = self
            .polar
            .request_json(Method::GET, &path, None, &Self::no_headers())
            .await?;
        if result.items.len() > 1 {
            return Err(GiftProviderError::MultipleGiftOrders);
        }
        Ok(result.items.into_iter().next())
    }

    /// `getGiftCreditGrant`: bounded scan for this order's grant, then the
    /// permanent-credit confirmation checks. A missing `is_granted` grant is a
    /// successful "not yet" (source `null`), not an error.
    pub async fn get_gift_credit_grant(
        &self,
        order_id: &str,
        customer_id: &str,
        benefit_id: &str,
        credits: i64,
    ) -> Result<Option<GiftGrant>, GiftProviderError> {
        for page in 1..=RECOVERY_PAGES {
            let path = query_path(
                "/v1/benefit-grants/",
                &[
                    ("customer_id", customer_id.to_owned()),
                    ("limit", "100".to_owned()),
                    ("page", page.to_string()),
                    ("sorting", "-created_at".to_owned()),
                ],
            );
            let result: GiftGrantList = self
                .polar
                .request_json(Method::GET, &path, None, &Self::no_headers())
                .await?;
            let grant = result.items.into_iter().find(|grant| {
                grant.order_id.as_deref() == Some(order_id)
                    && grant.customer_id == customer_id
                    && grant.benefit_id == benefit_id
            });
            if let Some(grant) = grant {
                if grant.is_revoked {
                    return Err(GiftProviderError::GiftGrantRevoked);
                }
                if !grant.is_granted {
                    return Ok(None);
                }
                // Public REST intentionally returns empty internal grant
                // properties. Polar sets is_granted only after the meter
                // strategy creates its system credit event and updates the meter.
                let properties = &grant.benefit.properties;
                let confirmed = grant
                    .granted_at
                    .as_deref()
                    .is_some_and(|value| parse_date(value).is_some())
                    && grant.benefit.id == benefit_id
                    && grant.benefit.benefit_type == "meter_credit"
                    && properties.meter_id.as_deref() == Some(AI_CREDITS_METER_ID)
                    && properties.units == Some(credits as f64)
                    && properties.rollover == Some(true);
                if !confirmed {
                    return Err(GiftProviderError::GiftGrantConfirmationMissing);
                }
                return Ok(Some(grant));
            }
            if page as f64 >= result.pagination.and_then(|p| p.max_page).unwrap_or(1.0) {
                return Ok(None);
            }
        }
        Err(GiftProviderError::GiftGrantLookupRequiresSupport)
    }
}
