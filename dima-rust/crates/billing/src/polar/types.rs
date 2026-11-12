//! Polar answers. Unknown fields are ignored everywhere.

use serde::{Deserialize, Deserializer};
use serde_json::Value;

fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// `{items: [...]}`; a missing or `null` `items` is empty (`response.items || []`).
#[derive(Clone, Debug, Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
pub struct ListResponse<T> {
    /// The items.
    #[serde(default = "Vec::new", deserialize_with = "null_as_default")]
    pub items: Vec<T>,
}

/// `{items}` kept as sent (the product list is read loosely).
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct LooseList {
    #[serde(default)]
    pub items: Option<Value>,
}

/// A subscription in a `/v1/subscriptions/` list (`PolarSubscription` in `billing.ts`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Subscription {
    /// Id.
    pub id: String,
    /// `active`, `past_due`, `canceled`, `trialing`...
    pub status: String,
    /// Product id.
    #[serde(default)]
    pub product_id: Option<String>,
    /// When it ended.
    #[serde(default)]
    pub ended_at: Option<String>,
    /// When it was canceled.
    #[serde(default)]
    pub canceled_at: Option<String>,
    /// Trial start.
    #[serde(default)]
    pub trial_start: Option<String>,
    /// Trial end.
    #[serde(default)]
    pub trial_end: Option<String>,
    /// End of the current period.
    #[serde(default)]
    pub current_period_end: Option<String>,
    /// Scheduled end.
    #[serde(default)]
    pub ends_at: Option<String>,
}

/// A discount (`DiscountLike`).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Discount {
    /// Id.
    pub id: String,
    /// The promo code.
    #[serde(default)]
    pub code: Option<String>,
    /// `fixed` or `percentage`.
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    /// Percentage in basis points.
    #[serde(default)]
    pub basis_points: Option<f64>,
    /// Fixed amount in cents.
    #[serde(default)]
    pub amount: Option<f64>,
    /// The products it applies to, as sent (an empty or non-array value means every product).
    #[serde(default)]
    pub products: Option<Value>,
}

/// A created checkout.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Checkout {
    /// Id.
    pub id: String,
    /// Where the customer pays.
    pub url: String,
}

/// A created customer portal session.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct CustomerSession {
    /// Id.
    pub id: String,
    /// The portal URL.
    pub customer_portal_url: String,
    /// Expiry.
    #[serde(default)]
    pub expires_at: Option<String>,
}

/// `customers.getState` as the entitlement code reads it (`PolarEntitlementState`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct EntitlementState {
    /// The customer id.
    pub id: String,
    /// Active subscriptions.
    pub active_subscriptions: Vec<EntitlementSubscription>,
    /// Granted benefits.
    pub granted_benefits: Vec<GrantedBenefit>,
}

/// One active subscription of the customer state (`PolarEntitlementSubscription`); dates are
/// the text Polar sent, parsed where they are used.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct EntitlementSubscription {
    /// Id.
    #[serde(default)]
    pub id: String,
    /// Product id.
    #[serde(default)]
    pub product_id: String,
    /// Status.
    #[serde(default)]
    pub status: String,
    /// End of the current period.
    #[serde(default)]
    pub current_period_end: Option<String>,
    /// Scheduled end.
    #[serde(default)]
    pub ends_at: Option<String>,
    /// Trial end.
    #[serde(default)]
    pub trial_end: Option<String>,
    /// Trial start.
    #[serde(default)]
    pub trial_start: Option<String>,
}

/// One granted benefit of the customer state.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct GrantedBenefit {
    /// The grant id.
    #[serde(default)]
    pub id: String,
    /// The benefit id.
    #[serde(default)]
    pub benefit_id: String,
}

/// One page of `benefitGrants.list`.
#[derive(Clone, Debug, Deserialize)]
pub struct BenefitGrantPage {
    /// The grants.
    pub items: Vec<BenefitGrant>,
    /// Paging.
    pub pagination: Pagination,
}

/// `pagination`.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Pagination {
    /// The last page.
    pub max_page: i64,
}

/// A benefit grant as the grace lookup reads it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct BenefitGrant {
    /// Id.
    pub id: String,
    /// Benefit id.
    pub benefit_id: String,
    /// Customer id.
    pub customer_id: String,
    /// Granted.
    #[serde(default)]
    pub is_granted: bool,
    /// Revoked.
    #[serde(default)]
    pub is_revoked: bool,
    /// The subscription that granted it.
    #[serde(default)]
    pub subscription_id: Option<String>,
}

/// `subscriptions.get` as the grace lookup reads it (`PolarGraceSubscription`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct SdkSubscription {
    /// Id.
    pub id: String,
    /// Customer id.
    pub customer_id: String,
    /// Product id.
    pub product_id: String,
    /// Status.
    pub status: String,
    /// End of the current period.
    #[serde(default)]
    pub current_period_end: Option<String>,
    /// Scheduled end.
    #[serde(default)]
    pub ends_at: Option<String>,
    /// Trial end.
    #[serde(default)]
    pub trial_end: Option<String>,
    /// Trial start.
    #[serde(default)]
    pub trial_start: Option<String>,
}

/// The ingest answer: `{inserted, duplicates}`; anything else counts as 0, as
/// `isIngestComplete` reads it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
pub struct IngestResult {
    /// Events stored.
    #[serde(default, deserialize_with = "number_or_zero")]
    pub inserted: f64,
    /// Events already stored.
    #[serde(default, deserialize_with = "number_or_zero")]
    pub duplicates: f64,
}

fn number_or_zero<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
    Ok(crate::js::as_number(Some(&Value::deserialize(deserializer)?)).unwrap_or(0.0))
}

impl IngestResult {
    /// `isIngestComplete(result, expected)`: `inserted + duplicates >= expected`.
    pub fn is_complete(&self, expected: usize) -> bool {
        #[allow(clippy::cast_precision_loss)]
        let expected = expected as f64;
        self.inserted + self.duplicates >= expected
    }
}
