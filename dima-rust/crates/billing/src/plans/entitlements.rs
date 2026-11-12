//! The plan Polar's customer state grants: tier, expiry and past-due grace, and the fingerprint
//! that lets a repeated state webhook skip the work.
//!
//! Reference: `dimabot/src/domain_events/polar_entitlements.ts`.
//!
//! - Only `active` and `trialing` subscriptions of the Premium or Pro product count. A
//!   subscription's expiry is the earliest of `current_period_end`, `ends_at` and (while
//!   trialing) `trial_end`; one that has passed grants nothing. The highest tier wins; within a
//!   tier the latest expiry wins, and no expiry beats any expiry.
//! - Grace: when the state has granted benefits and the plan is not already Pro, each grant is
//!   resolved to the subscription that granted it (never guessed from products); a `past_due`
//!   subscription found that way grants its tier with no expiry (Polar owns that deadline).
//! - Dates are compared as epoch milliseconds (`Date` semantics, UTC). Polar's text dates are
//!   parsed with [`dima_text::parse_date`]; one that does not parse is "an invalid expiry".
//! - The fingerprint sorts with `localeCompare` (ICU root collation, [`dima_text::Collator`]) and
//!   hashes `JSON.stringify` text ([`dima_text::to_js_json`]), as the reference does, so a stored
//!   `polar_plan_entitlement_fingerprint` written by TypeScript compares equal.

use super::{PlanTier, plan_rank, product_tier};
use crate::polar::{
    EntitlementState, EntitlementSubscription, GrantedBenefit, PolarClient, PolarError,
    SdkSubscription,
};
use futures_util::future::BoxFuture;
use serde_json::Value;

/// Why the entitled plan could not be resolved (the reference's messages).
#[derive(Debug, thiserror::Error)]
pub enum EntitlementError {
    /// The state is for another customer or lacks its arrays.
    #[error("Polar entitlement state is missing or belongs to another customer")]
    WrongState,
    /// A subscription without id, product or status.
    #[error("Malformed Polar entitlement subscription")]
    MalformedSubscription,
    /// A grant without id or benefit id.
    #[error("Malformed Polar entitlement grant")]
    MalformedGrant,
    /// A date that does not parse.
    #[error("Polar entitlement has an invalid expiry")]
    InvalidExpiry,
    /// A grace subscription of another customer.
    #[error("Polar grace subscription customer mismatch")]
    GraceCustomerMismatch,
    /// More than 20 subscriptions behind the grants.
    #[error("Polar entitlement subscription lookup exceeded bounded scope")]
    TooManySubscriptions,
    /// More than 5 pages of grants.
    #[error("Polar entitlement grant lookup exceeded bounded scope")]
    TooManyGrantPages,
    /// Polar failed.
    #[error(transparent)]
    Polar(#[from] PolarError),
    /// The collator could not be loaded.
    #[error("collation data unavailable")]
    Collation,
}

/// `PolarPlan`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EntitledPlan {
    /// The tier.
    pub plan_tier: PlanTier,
    /// Until when (epoch ms), `None` for no expiry.
    pub until_ms: Option<i64>,
}

impl EntitledPlan {
    /// Free with no expiry.
    pub const FREE: Self = Self {
        plan_tier: PlanTier::Free,
        until_ms: None,
    };
}

/// A subscription as `include` reads it.
#[derive(Clone, Copy, Debug)]
struct Candidate<'a> {
    id: &'a str,
    product_id: &'a str,
    status: &'a str,
    current_period_end: Option<&'a str>,
    ends_at: Option<&'a str>,
    trial_end: Option<&'a str>,
}

impl<'a> From<&'a EntitlementSubscription> for Candidate<'a> {
    fn from(s: &'a EntitlementSubscription) -> Self {
        Self {
            id: &s.id,
            product_id: &s.product_id,
            status: &s.status,
            current_period_end: s.current_period_end.as_deref(),
            ends_at: s.ends_at.as_deref(),
            trial_end: s.trial_end.as_deref(),
        }
    }
}

impl<'a> From<&'a SdkSubscription> for Candidate<'a> {
    fn from(s: &'a SdkSubscription) -> Self {
        Self {
            id: &s.id,
            product_id: &s.product_id,
            status: &s.status,
            current_period_end: s.current_period_end.as_deref(),
            ends_at: s.ends_at.as_deref(),
            trial_end: s.trial_end.as_deref(),
        }
    }
}

/// `expiry(subscription)`.
fn expiry(candidate: &Candidate<'_>) -> Result<Option<i64>, EntitlementError> {
    let trial = (candidate.status == "trialing")
        .then_some(candidate.trial_end)
        .flatten();
    let mut earliest: Option<i64> = None;
    for text in [candidate.current_period_end, candidate.ends_at, trial]
        .into_iter()
        .flatten()
    {
        let ms = dima_text::parse_date(text).ok_or(EntitlementError::InvalidExpiry)?;
        earliest = Some(earliest.map_or(ms, |e| e.min(ms)));
    }
    Ok(earliest)
}

fn include(
    plan: &mut EntitledPlan,
    candidate: &Candidate<'_>,
    grace: bool,
    now_ms: i64,
) -> Result<(), EntitlementError> {
    if candidate.id.is_empty() || candidate.product_id.is_empty() || candidate.status.is_empty() {
        return Err(EntitlementError::MalformedSubscription);
    }
    let tier = product_tier(candidate.product_id);
    if tier == PlanTier::Free {
        return Ok(());
    }
    let until = if grace { None } else { expiry(candidate)? };
    if until.is_some_and(|until| until <= now_ms) {
        return Ok(());
    }
    if plan_rank(tier) > plan_rank(plan.plan_tier) {
        *plan = EntitledPlan {
            plan_tier: tier,
            until_ms: until,
        };
    } else if tier == plan.plan_tier
        && (until.is_none() || matches!((until, plan.until_ms), (Some(u), Some(p)) if u > p))
    {
        plan.until_ms = until;
    }
    Ok(())
}

/// Resolves granted benefits to the subscriptions that granted them
/// (`PolarGraceLookup`).
pub trait GraceLookup: Send + Sync {
    /// The subscriptions behind `grants`.
    fn grace_subscriptions<'a>(
        &'a self,
        customer_id: &'a str,
        grants: &'a [GrantedBenefit],
    ) -> BoxFuture<'a, Result<Vec<SdkSubscription>, EntitlementError>>;
}

/// `resolvePolarEntitledPlan(state, customerId, now, getGraceSubscriptions)`.
pub async fn resolve_entitled_plan(
    state: &EntitlementState,
    customer_id: &str,
    now_ms: i64,
    grace: &dyn GraceLookup,
) -> Result<EntitledPlan, EntitlementError> {
    if state.id != customer_id {
        return Err(EntitlementError::WrongState);
    }
    let mut plan = EntitledPlan::FREE;
    for subscription in &state.active_subscriptions {
        if subscription.status == "active" || subscription.status == "trialing" {
            include(&mut plan, &Candidate::from(subscription), false, now_ms)?;
        }
    }
    if !state.granted_benefits.is_empty() && plan.plan_tier != PlanTier::Pro {
        if state
            .granted_benefits
            .iter()
            .any(|g| g.id.is_empty() || g.benefit_id.is_empty())
        {
            return Err(EntitlementError::MalformedGrant);
        }
        for subscription in grace
            .grace_subscriptions(customer_id, &state.granted_benefits)
            .await?
        {
            if subscription.customer_id != customer_id {
                return Err(EntitlementError::GraceCustomerMismatch);
            }
            if subscription.status == "past_due" {
                include(&mut plan, &Candidate::from(&subscription), true, now_ms)?;
            }
        }
    }
    Ok(plan)
}

/// At most 5 pages of grants and 20 subscriptions; subscriptions are read 4 at a time.
pub const GRACE_MAX_PAGES: u32 = 5;
/// See [`GRACE_MAX_PAGES`].
pub const GRACE_MAX_SUBSCRIPTIONS: usize = 20;
/// See [`GRACE_MAX_PAGES`].
pub const GRACE_CONCURRENCY: usize = 4;

impl GraceLookup for PolarClient {
    /// `loadPolarGraceSubscriptions(client, customerId, grants)`.
    fn grace_subscriptions<'a>(
        &'a self,
        customer_id: &'a str,
        grants: &'a [GrantedBenefit],
    ) -> BoxFuture<'a, Result<Vec<SdkSubscription>, EntitlementError>> {
        Box::pin(async move {
            // `new Map(grants.map(g => [g.id, g.benefitId]))`: the last grant with an id wins.
            let requested = |id: &str| {
                grants
                    .iter()
                    .rev()
                    .find(|g| g.id == id)
                    .map(|g| g.benefit_id.as_str())
            };
            let mut ids: Vec<String> = Vec::new();
            for page in 1..=GRACE_MAX_PAGES {
                let response = self.list_granted_benefit_grants(customer_id, page).await?;
                for grant in &response.items {
                    let Some(subscription) =
                        grant.subscription_id.as_deref().filter(|s| !s.is_empty())
                    else {
                        continue;
                    };
                    if requested(&grant.id) != Some(grant.benefit_id.as_str())
                        || grant.customer_id != customer_id
                        || !grant.is_granted
                        || grant.is_revoked
                    {
                        continue;
                    }
                    if !ids.iter().any(|id| id == subscription) {
                        ids.push(subscription.to_owned());
                    }
                }
                if ids.len() > GRACE_MAX_SUBSCRIPTIONS {
                    return Err(EntitlementError::TooManySubscriptions);
                }
                if i64::from(page) >= response.pagination.max_page {
                    let mut subscriptions = Vec::with_capacity(ids.len());
                    for chunk in ids.chunks(GRACE_CONCURRENCY) {
                        let fetched = futures_util::future::join_all(
                            chunk.iter().map(|id| self.get_subscription(id)),
                        )
                        .await;
                        for subscription in fetched {
                            subscriptions.push(subscription?);
                        }
                    }
                    return Ok(subscriptions);
                }
            }
            Err(EntitlementError::TooManyGrantPages)
        })
    }
}

/// A date of a fingerprinted subscription: absent or `null`, text (`new Date(text)`) or a time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FingerprintDate {
    /// `null` or `undefined`.
    None,
    /// Text Polar sent.
    Text(String),
    /// A `Date`.
    Ms(i64),
}

impl FingerprintDate {
    fn iso(&self) -> Result<Value, EntitlementError> {
        let ms = match self {
            Self::None => return Ok(Value::Null),
            Self::Text(text) => {
                dima_text::parse_date(text).ok_or(EntitlementError::InvalidExpiry)?
            }
            Self::Ms(ms) => *ms,
        };
        // `new Date(value).toISOString()` throws on an invalid date.
        dima_text::to_iso_string(ms)
            .map(Value::String)
            .ok_or(EntitlementError::InvalidExpiry)
    }

    fn of(text: Option<&str>) -> Self {
        text.map_or(Self::None, |t| Self::Text(t.to_owned()))
    }
}

/// One subscription as the fingerprint reads it (camel-case SDK objects or v1 JSON).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FingerprintSubscription {
    /// `id` (`None` is `undefined`, written `null`).
    pub id: Option<String>,
    /// `productId`.
    pub product_id: Option<String>,
    /// `status`.
    pub status: Option<String>,
    /// `currentPeriodEnd`.
    pub current_period_end: FingerprintDate,
    /// `endsAt`.
    pub ends_at: FingerprintDate,
    /// `trialStart`.
    pub trial_start: FingerprintDate,
    /// `trialEnd`.
    pub trial_end: FingerprintDate,
}

impl From<&EntitlementSubscription> for FingerprintSubscription {
    fn from(s: &EntitlementSubscription) -> Self {
        Self {
            id: Some(s.id.clone()),
            product_id: Some(s.product_id.clone()),
            status: Some(s.status.clone()),
            current_period_end: FingerprintDate::of(s.current_period_end.as_deref()),
            ends_at: FingerprintDate::of(s.ends_at.as_deref()),
            trial_start: FingerprintDate::of(s.trial_start.as_deref()),
            trial_end: FingerprintDate::of(s.trial_end.as_deref()),
        }
    }
}

/// `polarEntitlementFingerprint({activeSubscriptions, grantedBenefits})`: SHA-256 hex.
pub fn entitlement_fingerprint(
    subscriptions: &[FingerprintSubscription],
    grants: &[(Option<String>, Option<String>)],
) -> Result<String, EntitlementError> {
    let collator = dima_text::Collator::new().map_err(|_| EntitlementError::Collation)?;
    let text = |value: &Option<String>| {
        value
            .as_ref()
            .map_or(Value::Null, |v| Value::String(v.clone()))
    };
    let mut rows = Vec::with_capacity(subscriptions.len());
    for s in subscriptions {
        let row = Value::Array(vec![
            text(&s.id),
            text(&s.product_id),
            text(&s.status),
            s.current_period_end.iso()?,
            s.ends_at.iso()?,
            s.trial_start.iso()?,
            s.trial_end.iso()?,
        ]);
        rows.push((dima_text::to_js_json(&row), row));
    }
    let mut grant_rows: Vec<(String, Value)> = grants
        .iter()
        .map(|(id, benefit)| {
            let row = Value::Array(vec![text(id), text(benefit)]);
            (dima_text::to_js_json(&row), row)
        })
        .collect();
    rows.sort_by(|a, b| collator.compare(&a.0, &b.0));
    grant_rows.sort_by(|a, b| collator.compare(&a.0, &b.0));
    let all = Value::Array(vec![
        Value::Array(rows.into_iter().map(|(_, row)| row).collect()),
        Value::Array(grant_rows.into_iter().map(|(_, row)| row).collect()),
    ]);
    Ok(dima_core::crypto::sha256(dima_text::to_js_json(&all)).hex())
}

/// The fingerprint of a customer state read through the SDK.
pub fn state_fingerprint(state: &EntitlementState) -> Result<String, EntitlementError> {
    let subscriptions: Vec<_> = state
        .active_subscriptions
        .iter()
        .map(FingerprintSubscription::from)
        .collect();
    let grants: Vec<_> = state
        .granted_benefits
        .iter()
        .map(|g| (Some(g.id.clone()), Some(g.benefit_id.clone())))
        .collect();
    entitlement_fingerprint(&subscriptions, &grants)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::products::{PREMIUM_PRODUCT_ID, PRO_PRODUCT_ID};

    struct NoGrace(Vec<SdkSubscription>);

    impl GraceLookup for NoGrace {
        fn grace_subscriptions<'a>(
            &'a self,
            _customer_id: &'a str,
            _grants: &'a [GrantedBenefit],
        ) -> BoxFuture<'a, Result<Vec<SdkSubscription>, EntitlementError>> {
            Box::pin(async move { Ok(self.0.clone()) })
        }
    }

    fn sub(product: &str, status: &str, end: Option<&str>) -> EntitlementSubscription {
        EntitlementSubscription {
            id: "s".into(),
            product_id: product.into(),
            status: status.into(),
            current_period_end: end.map(Into::into),
            ..Default::default()
        }
    }

    fn ms(text: &str) -> i64 {
        dima_text::parse_date(text).unwrap()
    }

    #[tokio::test]
    async fn the_highest_live_tier_wins_and_expired_access_is_dropped() {
        let now = ms("2026-11-11T00:00:00Z");
        let state = EntitlementState {
            id: "c".into(),
            active_subscriptions: vec![
                sub(PRO_PRODUCT_ID, "active", Some("2026-11-10T23:59:59.999Z")),
                sub(
                    PREMIUM_PRODUCT_ID,
                    "trialing",
                    Some("2026-12-01T00:00:00.000Z"),
                ),
                sub(PREMIUM_PRODUCT_ID, "canceled", None),
            ],
            granted_benefits: vec![],
        };
        let plan = resolve_entitled_plan(&state, "c", now, &NoGrace(vec![]))
            .await
            .unwrap();
        assert_eq!(
            plan,
            EntitledPlan {
                plan_tier: PlanTier::Premium,
                until_ms: Some(ms("2026-12-01T00:00:00Z"))
            }
        );
        assert!(matches!(
            resolve_entitled_plan(&state, "other", now, &NoGrace(vec![])).await,
            Err(EntitlementError::WrongState)
        ));
    }

    #[tokio::test]
    async fn past_due_grace_grants_without_expiry() {
        let now = ms("2026-11-11T00:00:00Z");
        let state = EntitlementState {
            id: "c".into(),
            active_subscriptions: vec![],
            granted_benefits: vec![GrantedBenefit {
                id: "g".into(),
                benefit_id: "b".into(),
            }],
        };
        let grace = NoGrace(vec![SdkSubscription {
            id: "s".into(),
            customer_id: "c".into(),
            product_id: PRO_PRODUCT_ID.into(),
            status: "past_due".into(),
            current_period_end: Some("2026-01-01T00:00:00Z".into()),
            ..Default::default()
        }]);
        let plan = resolve_entitled_plan(&state, "c", now, &grace)
            .await
            .unwrap();
        assert_eq!(
            plan,
            EntitledPlan {
                plan_tier: PlanTier::Pro,
                until_ms: None
            }
        );
    }

    #[test]
    fn fingerprints_are_order_independent() {
        let a = FingerprintSubscription {
            id: Some("a".into()),
            product_id: Some("p".into()),
            status: Some("active".into()),
            current_period_end: FingerprintDate::Text("2026-12-01T00:00:00.123456Z".into()),
            ends_at: FingerprintDate::None,
            trial_start: FingerprintDate::None,
            trial_end: FingerprintDate::Ms(0),
        };
        let mut b = a.clone();
        b.id = Some("B".into());
        let one = entitlement_fingerprint(&[a.clone(), b.clone()], &[]).unwrap();
        let two = entitlement_fingerprint(&[b, a], &[]).unwrap();
        assert_eq!(one, two);
        assert_eq!(one.len(), 64);
    }
}
