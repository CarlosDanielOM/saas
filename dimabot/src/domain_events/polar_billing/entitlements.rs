//! Polar entitlement resolution and grace-subscription discovery.
//!
//! Source contract: `dimabot/src/domain_events/polar_entitlements.ts`
//! (`POLAR_PLAN_EVENT_TYPES`, `PolarEntitlementSubscription`,
//! `PolarEntitlementState`, `PolarGraceSubscription`, `PolarGraceLookup`,
//! `PolarPlan`, `polarEntitlementFingerprint`, `POLAR_ENTITLEMENT_REQUEST_OPTIONS`,
//! `resolvePolarEntitledPlan`, `loadPolarGraceSubscriptions`).
//!
//! Preserved behaviour: state membership (never the triggering webhook's product
//! or status) grants access; the highest reachable tier wins and an equal tier
//! keeps the longest access; the expiry is the earliest of
//! `currentPeriodEnd`/`endsAt` plus `trialEnd` **only** while `trialing`; an
//! expired subscription grants nothing; a `past_due` subscription linked to a
//! live grant keeps its tier with `until = null` because Polar owns that
//! deadline; grants resolve to their actual subscription instead of guessing
//! from a shared benefit or product; and the grant scan is bounded to five pages
//! and twenty subscriptions.
//!
//! The fingerprint is `sha256(JSON.stringify([subscriptions, grants]))` over the
//! minimal `[id, productId, status, currentPeriodEnd, endsAt, trialStart,
//! trialEnd]` / `[id, benefitId]` rows, each date normalised to ISO-8601 with
//! `null` preserved, sorted by `JSON.stringify(row).localeCompare(...)`. That
//! comparison is JavaScript locale collation, so this module uses ICU root
//! collation (`icu_collator`, feature `unicode-collation`) exactly as
//! `utils::dashboard_insights` does for `localeCompare`; it is never codepoint
//! order.
//!
//! Deliberately NOT here: the plan projection, the credit snapshot, event
//! filtering, owner resolution, MongoDB, or Redis. Provider reads go through
//! [`PolarHttpEntitlementSource`], which reuses the Billing policy of
//! `utils::polar` and applies the source's 10-second bound explicitly because
//! that transport has no implicit timeout.

use super::{BillingFuture, PolarBillingError};
use crate::utils::{
    ai_credit_projection::PlanTier,
    credit_gift_provider::encode_uri_component,
    credit_policy::JsDate,
    js_date::parse_date,
    polar::{PolarClient, PolarError, PolarPolicy},
};
use icu_collator::Collator;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{fmt, time::Duration, time::SystemTime};

/// `POLAR_PLAN_EVENT_TYPES`: the shipped `provider.polar.*` lifecycle names stay
/// replayable. The source expands `3 + 6 + 4` entries, so there are thirteen.
pub const POLAR_PLAN_EVENT_TYPES: [&str; 13] = [
    "billing.order.paid",
    "billing.subscription.updated",
    "billing.customer.state.changed",
    "provider.polar.subscription.created",
    "provider.polar.subscription.active",
    "provider.polar.subscription.canceled",
    "provider.polar.subscription.uncanceled",
    "provider.polar.subscription.past_due",
    "provider.polar.subscription.revoked",
    "provider.polar.benefit_grant.created",
    "provider.polar.benefit_grant.updated",
    "provider.polar.benefit_grant.cycled",
    "provider.polar.benefit_grant.revoked",
];

/// `POLAR_ENTITLEMENT_REQUEST_OPTIONS`. Durable delivery owns retries; provider
/// calls stay bounded within its watchdog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolarEntitlementRequestOptions {
    pub timeout_ms: u64,
    pub retries: &'static str,
}

pub const POLAR_ENTITLEMENT_REQUEST_OPTIONS: PolarEntitlementRequestOptions =
    PolarEntitlementRequestOptions {
        timeout_ms: 10_000,
        retries: "none",
    };

/// The source throws once more than twenty subscription ids are collected.
pub const MAX_GRACE_SUBSCRIPTIONS: usize = 20;
/// The source scans at most five grant pages.
pub const MAX_GRACE_GRANT_PAGES: u32 = 5;
/// Subscriptions are fetched four at a time.
pub const GRACE_SUBSCRIPTION_BATCH: usize = 4;

/// Typed entitlement failure. Every source-authored message is preserved
/// verbatim; `Timeout`, `CollationUnavailable`, `WrongPolicy`, and `Transport`
/// are typed replacements for a thrown transport/collation error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntitlementError {
    StateMissingOrForeign,
    MalformedSubscription,
    MalformedGrant,
    GraceCustomerMismatch,
    InvalidExpiry,
    SubscriptionLookupExceeded,
    GrantLookupExceeded,
    Timeout,
    CollationUnavailable,
    WrongPolicy,
    Transport(PolarError),
}

impl fmt::Display for EntitlementError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StateMissingOrForeign => {
                f.write_str("Polar entitlement state is missing or belongs to another customer")
            }
            Self::MalformedSubscription => f.write_str("Malformed Polar entitlement subscription"),
            Self::MalformedGrant => f.write_str("Malformed Polar entitlement grant"),
            Self::GraceCustomerMismatch => {
                f.write_str("Polar grace subscription customer mismatch")
            }
            Self::InvalidExpiry => f.write_str("Polar entitlement has an invalid expiry"),
            Self::SubscriptionLookupExceeded => {
                f.write_str("Polar entitlement subscription lookup exceeded bounded scope")
            }
            Self::GrantLookupExceeded => {
                f.write_str("Polar entitlement grant lookup exceeded bounded scope")
            }
            Self::Timeout => f.write_str("Polar entitlement request exceeded its 10s bound"),
            Self::CollationUnavailable => {
                f.write_str("Polar entitlement fingerprint collation is unavailable")
            }
            Self::WrongPolicy => {
                f.write_str("Polar entitlement reads require the Billing Polar policy")
            }
            Self::Transport(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for EntitlementError {}

impl From<PolarError> for EntitlementError {
    fn from(error: PolarError) -> Self {
        Self::Transport(error)
    }
}

impl From<EntitlementError> for PolarBillingError {
    fn from(error: EntitlementError) -> Self {
        Self::Entitlement(error)
    }
}

/// A JS `Date` value from the source's SDK object: present-and-valid, present
/// but unparseable (`NaN` time, which the source rejects), or absent/`null`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolarDate {
    Millis(i64),
    Invalid,
}

impl PolarDate {
    fn from_value(value: Option<&Value>) -> Option<Self> {
        match value? {
            Value::Null => None,
            Value::String(text) => Some(match parse_date(text) {
                Some(millis) => Self::Millis(millis),
                None => Self::Invalid,
            }),
            // The SDK hands over Date instances; JSON can only carry strings.
            _ => Some(Self::Invalid),
        }
    }
}

/// `PolarEntitlementSubscription`, accepting both the snake_case REST shape and
/// the camelCase event-payload shape.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PolarEntitlementSubscription {
    pub id: String,
    pub product_id: String,
    pub status: String,
    pub current_period_end: Option<PolarDate>,
    pub ends_at: Option<PolarDate>,
    pub trial_start: Option<PolarDate>,
    pub trial_end: Option<PolarDate>,
}

impl PolarEntitlementSubscription {
    pub fn from_json(value: &Value) -> Self {
        let object = value.as_object();
        Self {
            id: text(object, &["id"]),
            product_id: text(object, &["productId", "product_id"]),
            status: text(object, &["status"]),
            current_period_end: date(object, &["currentPeriodEnd", "current_period_end"]),
            ends_at: date(object, &["endsAt", "ends_at"]),
            trial_start: date(object, &["trialStart", "trial_start"]),
            trial_end: date(object, &["trialEnd", "trial_end"]),
        }
    }
}

/// One `grantedBenefits` entry: only the identity pair matters.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PolarEntitlementGrant {
    pub id: String,
    pub benefit_id: String,
}

impl PolarEntitlementGrant {
    pub fn from_json(value: &Value) -> Self {
        let object = value.as_object();
        Self {
            id: text(object, &["id"]),
            benefit_id: text(object, &["benefitId", "benefit_id"]),
        }
    }

    /// Parses a payload array of grants, accepting the camelCase and snake_case
    /// key shapes and skipping nothing (malformed entries are validated later).
    pub fn list_from_json(values: &[Value]) -> Vec<Self> {
        values.iter().map(Self::from_json).collect()
    }
}

/// `PolarEntitlementState`. Vectors cannot be absent, so the source's "both
/// arrays must be present" rule is enforced by [`Self::from_json`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PolarEntitlementState {
    pub id: String,
    pub active_subscriptions: Vec<PolarEntitlementSubscription>,
    pub granted_benefits: Vec<PolarEntitlementGrant>,
}

impl PolarEntitlementState {
    /// Decodes a customer-state response. A missing `id` is left empty so the
    /// resolver reports the same "missing or belongs to another customer"
    /// message the source uses for all three malformed-state cases.
    pub fn from_json(value: &Value) -> Result<Self, EntitlementError> {
        let object = value
            .as_object()
            .ok_or(EntitlementError::StateMissingOrForeign)?;
        let subscriptions = object
            .get("activeSubscriptions")
            .or_else(|| object.get("active_subscriptions"))
            .and_then(Value::as_array)
            .ok_or(EntitlementError::StateMissingOrForeign)?;
        let grants = object
            .get("grantedBenefits")
            .or_else(|| object.get("granted_benefits"))
            .and_then(Value::as_array)
            .ok_or(EntitlementError::StateMissingOrForeign)?;
        Ok(Self {
            id: text(Some(object), &["id"]),
            active_subscriptions: subscriptions
                .iter()
                .map(PolarEntitlementSubscription::from_json)
                .collect(),
            granted_benefits: PolarEntitlementGrant::list_from_json(grants),
        })
    }

    /// Parses an event payload's `activeSubscriptions` array.
    pub fn subscriptions_from_payload(values: &[Value]) -> Vec<PolarEntitlementSubscription> {
        values
            .iter()
            .map(PolarEntitlementSubscription::from_json)
            .collect()
    }
}

/// `PolarGraceSubscription`: an entitlement subscription plus its customer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PolarGraceSubscription {
    pub customer_id: String,
    pub subscription: PolarEntitlementSubscription,
}

/// `PolarPlan`.
#[derive(Debug, Clone, Copy)]
pub struct PolarPlan {
    pub plan_tier: PlanTier,
    pub until: Option<i64>,
}

impl PolarPlan {
    pub const fn free() -> Self {
        Self {
            plan_tier: PlanTier::Free,
            until: None,
        }
    }
}

/// `PolarGraceLookup`, injected so resolution stays pure logic in tests.
pub trait PolarGraceLookup: Send + Sync {
    fn grace_subscriptions<'a>(
        &'a self,
        customer_id: &'a str,
        grants: &'a [PolarEntitlementGrant],
    ) -> BillingFuture<'a, Vec<PolarGraceSubscription>>;
}

/// The customer-state half of the provider reads, injected for the projections.
pub trait PolarCustomerStateSource: Send + Sync {
    fn customer_state<'a>(&'a self, customer_id: &'a str)
    -> BillingFuture<'a, PolarEntitlementState>;
}

fn text(object: Option<&Map<String, Value>>, keys: &[&str]) -> String {
    let Some(object) = object else {
        return String::new();
    };
    for key in keys {
        if let Some(value) = object.get(*key).and_then(Value::as_str) {
            return value.to_owned();
        }
    }
    String::new()
}

fn date(object: Option<&Map<String, Value>>, keys: &[&str]) -> Option<PolarDate> {
    let object = object?;
    for key in keys {
        if let Some(value) = object.get(*key) {
            return PolarDate::from_value(Some(value));
        }
    }
    None
}

/// The stored name of an entitlement tier (`free`/`premium`/`pro`).
pub fn plan_tier_name(tier: PlanTier) -> &'static str {
    crate::utils::billing::plan_tier_name(tier)
}

/// `tier(productId)`: only the two paid product ids rank above free.
pub fn plan_tier_for_product(product_id: &str) -> PlanTier {
    match product_id {
        crate::utils::billing::PLAN_PRODUCT_ID_PRO => PlanTier::Pro,
        crate::utils::billing::PLAN_PRODUCT_ID_PREMIUM => PlanTier::Premium,
        _ => PlanTier::Free,
    }
}

fn plan_rank(tier: PlanTier) -> u8 {
    match tier {
        PlanTier::Free => 0,
        PlanTier::Premium => 1,
        PlanTier::Pro => 2,
        // Not producible here: `plan_tier_for_product` yields only the three
        // ranked tiers. Unknown shared-state variants rank as free.
        PlanTier::Null | PlanTier::Undefined => 0,
    }
}

/// `expiry`: the earliest of the period end, the scheduled end, and (only while
/// `trialing`) the trial end. A present but unparseable date is an error.
pub fn subscription_expiry(
    subscription: &PolarEntitlementSubscription,
) -> Result<Option<i64>, EntitlementError> {
    let mut candidates = vec![subscription.current_period_end, subscription.ends_at];
    if subscription.status == "trialing" {
        candidates.push(subscription.trial_end);
    }
    let mut earliest: Option<i64> = None;
    for candidate in candidates.into_iter().flatten() {
        match candidate {
            PolarDate::Millis(millis) => {
                earliest = Some(match earliest {
                    Some(current) => current.min(millis),
                    None => millis,
                });
            }
            PolarDate::Invalid => return Err(EntitlementError::InvalidExpiry),
        }
    }
    Ok(earliest)
}

fn include(
    plan: &mut PolarPlan,
    subscription: &PolarEntitlementSubscription,
    grace: bool,
    now_millis: i64,
) -> Result<(), EntitlementError> {
    if subscription.id.is_empty()
        || subscription.product_id.is_empty()
        || subscription.status.is_empty()
    {
        return Err(EntitlementError::MalformedSubscription);
    }
    let plan_tier = plan_tier_for_product(&subscription.product_id);
    if matches!(plan_tier, PlanTier::Free) {
        return Ok(());
    }
    // During past_due the renewed period is not paid access. Only an actual live
    // subscription-linked grant proves Polar grace; its deadline is Polar's.
    let until = if grace {
        None
    } else {
        subscription_expiry(subscription)?
    };
    if let Some(until) = until {
        if until <= now_millis {
            return Ok(());
        }
    }
    if plan_rank(plan_tier) > plan_rank(plan.plan_tier) {
        plan.plan_tier = plan_tier;
        plan.until = until;
    } else if plan_rank(plan_tier) == plan_rank(plan.plan_tier) {
        let take_later = match (until, plan.until) {
            (None, _) => true,
            (Some(value), Some(current)) => value > current,
            (Some(_), None) => false,
        };
        if take_later {
            plan.until = until;
        }
    }
    Ok(())
}

/// `resolvePolarEntitledPlan`.
pub async fn resolve_polar_entitled_plan(
    state: &PolarEntitlementState,
    customer_id: &str,
    now_millis: i64,
    grace: &dyn PolarGraceLookup,
) -> Result<PolarPlan, EntitlementError> {
    if state.id != customer_id {
        return Err(EntitlementError::StateMissingOrForeign);
    }
    let mut plan = PolarPlan::free();
    for subscription in &state.active_subscriptions {
        if subscription.status == "active" || subscription.status == "trialing" {
            include(&mut plan, subscription, false, now_millis)?;
        }
    }
    if !state.granted_benefits.is_empty() && !matches!(plan.plan_tier, PlanTier::Pro) {
        for grant in &state.granted_benefits {
            if grant.id.is_empty() || grant.benefit_id.is_empty() {
                return Err(EntitlementError::MalformedGrant);
            }
        }
        let subscriptions = grace
            .grace_subscriptions(customer_id, &state.granted_benefits)
            .await?;
        for subscription in subscriptions {
            if subscription.customer_id != customer_id {
                return Err(EntitlementError::GraceCustomerMismatch);
            }
            if subscription.subscription.status == "past_due" {
                include(&mut plan, &subscription.subscription, true, now_millis)?;
            }
        }
    }
    Ok(plan)
}

fn iso(millis: i64) -> Result<String, EntitlementError> {
    JsDate::from_millis(millis as f64)
        .to_iso_string()
        .map_err(|_| EntitlementError::InvalidExpiry)
}

fn fingerprint_dates(dates: [Option<PolarDate>; 4]) -> Result<[Value; 4], EntitlementError> {
    let mut output = [Value::Null, Value::Null, Value::Null, Value::Null];
    for (index, date) in dates.into_iter().enumerate() {
        output[index] = match date {
            None => Value::Null,
            Some(PolarDate::Millis(millis)) => Value::String(iso(millis)?),
            Some(PolarDate::Invalid) => return Err(EntitlementError::InvalidExpiry),
        };
    }
    Ok(output)
}

/// `polarEntitlementFingerprint`: compare minimal entitlement contents across
/// SDK `Date` values and normalized v1 JSON.
pub fn polar_entitlement_fingerprint(
    active_subscriptions: &[PolarEntitlementSubscription],
    granted_benefits: &[PolarEntitlementGrant],
) -> Result<String, EntitlementError> {
    let collator = Collator::try_new(Default::default(), Default::default())
        .map_err(|_| EntitlementError::CollationUnavailable)?;

    let mut subscription_rows: Vec<(String, Value)> =
        Vec::with_capacity(active_subscriptions.len());
    for subscription in active_subscriptions {
        let mut row = vec![
            Value::String(subscription.id.clone()),
            Value::String(subscription.product_id.clone()),
            Value::String(subscription.status.clone()),
        ];
        row.extend(fingerprint_dates([
            subscription.current_period_end,
            subscription.ends_at,
            subscription.trial_start,
            subscription.trial_end,
        ])?);
        let row = Value::Array(row);
        let serialized = serde_json::to_string(&row).map_err(|_| EntitlementError::InvalidExpiry)?;
        subscription_rows.push((serialized, row));
    }
    subscription_rows.sort_by(|left, right| collator.compare(&left.0, &right.0));

    let mut grant_rows: Vec<(String, Value)> = Vec::with_capacity(granted_benefits.len());
    for grant in granted_benefits {
        let row = Value::Array(vec![
            Value::String(grant.id.clone()),
            Value::String(grant.benefit_id.clone()),
        ]);
        let serialized = serde_json::to_string(&row).map_err(|_| EntitlementError::InvalidExpiry)?;
        grant_rows.push((serialized, row));
    }
    grant_rows.sort_by(|left, right| collator.compare(&left.0, &right.0));

    let document = Value::Array(vec![
        Value::Array(subscription_rows.into_iter().map(|(_, row)| row).collect()),
        Value::Array(grant_rows.into_iter().map(|(_, row)| row).collect()),
    ]);
    let serialized =
        serde_json::to_string(&document).map_err(|_| EntitlementError::InvalidExpiry)?;
    Ok(format!("{:x}", Sha256::digest(serialized.as_bytes())))
}

/// One benefit-grant row as the REST API returns it (`is_granted`,
/// `customer_id`, `subscription_id`). Only live, subscription-linked grants for a
/// requested benefit count.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct PolarGrantRecord {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub benefit_id: String,
    #[serde(default)]
    pub customer_id: String,
    #[serde(default)]
    pub is_granted: bool,
    #[serde(default)]
    pub is_revoked: bool,
    pub subscription_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct GrantListJson {
    #[serde(default)]
    items: Vec<PolarGrantRecord>,
    pagination: Option<GrantPaginationJson>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct GrantPaginationJson {
    max_page: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct SubscriptionCustomerJson {
    #[serde(default)]
    customer_id: String,
}

/// `benefitGrants.list(...)` request parameters, in the source's object order.
pub fn grant_list_path(customer_id: &str, page: u32) -> String {
    format!(
        "/v1/benefit-grants/?customer_id={}&is_granted=true&page={page}&limit=100",
        encode_uri_component(customer_id)
    )
}

/// `Map(grants.map(grant => [grant.id, grant.benefitId]))`: the last duplicate
/// id wins, exactly like the source's `new Map(...)`.
pub fn requested_grants(grants: &[PolarEntitlementGrant]) -> Vec<(String, String)> {
    let mut requested: Vec<(String, String)> = Vec::with_capacity(grants.len());
    for grant in grants {
        if let Some(existing) = requested.iter_mut().find(|(id, _)| *id == grant.id) {
            existing.1 = grant.benefit_id.clone();
        } else {
            requested.push((grant.id.clone(), grant.benefit_id.clone()));
        }
    }
    requested
}

/// Absorbs one grant page and enforces the source's two bounds: more than
/// [`MAX_GRACE_SUBSCRIPTIONS`] collected subscriptions fails immediately, and a
/// page at or past `maxPage` is the last page. Returns whether the scan is done.
pub fn absorb_grant_page(
    requested: &[(String, String)],
    customer_id: &str,
    page_grants: &[PolarGrantRecord],
    subscription_ids: &mut Vec<String>,
    page: u32,
    max_page: Option<f64>,
) -> Result<bool, EntitlementError> {
    for grant in page_grants {
        let matches_requested = requested
            .iter()
            .find(|(id, _)| *id == grant.id)
            .is_some_and(|(_, benefit_id)| *benefit_id == grant.benefit_id);
        if !matches_requested
            || grant.customer_id != customer_id
            || !grant.is_granted
            || grant.is_revoked
        {
            continue;
        }
        let Some(subscription_id) = grant.subscription_id.as_deref() else {
            continue;
        };
        if subscription_id.is_empty() {
            continue;
        }
        if !subscription_ids.iter().any(|id| id == subscription_id) {
            subscription_ids.push(subscription_id.to_owned());
        }
    }
    if subscription_ids.len() > MAX_GRACE_SUBSCRIPTIONS {
        return Err(EntitlementError::SubscriptionLookupExceeded);
    }
    // `page >= pagination.maxPage`; an absent max_page never terminates the scan.
    Ok(max_page.is_some_and(|max_page| f64::from(page) >= max_page))
}

/// `loadPolarGraceSubscriptions`. Grants resolve to their actual subscription;
/// one-time or shared-benefit grants never become a guessed tier.
pub async fn load_polar_grace_subscriptions(
    polar: &PolarClient,
    customer_id: &str,
    grants: &[PolarEntitlementGrant],
    timeout: Duration,
) -> Result<Vec<PolarGraceSubscription>, EntitlementError> {
    let requested = requested_grants(grants);
    let mut subscription_ids: Vec<String> = Vec::new();
    for page in 1..=MAX_GRACE_GRANT_PAGES {
        let response: GrantListJson =
            fetch_json(polar, &grant_list_path(customer_id, page), timeout).await?;
        let finished = absorb_grant_page(
            &requested,
            customer_id,
            &response.items,
            &mut subscription_ids,
            page,
            response.pagination.as_ref().and_then(|pagination| pagination.max_page),
        )?;
        if finished {
            let mut subscriptions = Vec::with_capacity(subscription_ids.len());
            for batch in subscription_ids.chunks(GRACE_SUBSCRIPTION_BATCH) {
                let futures = batch.iter().map(|id| async move {
                    let path = format!("/v1/subscriptions/{}", encode_uri_component(id));
                    let value: Value = fetch_json(polar, &path, timeout).await?;
                    let customer: SubscriptionCustomerJson =
                        serde_json::from_value(value.clone()).unwrap_or_default();
                    Ok::<PolarGraceSubscription, EntitlementError>(PolarGraceSubscription {
                        customer_id: customer.customer_id,
                        subscription: PolarEntitlementSubscription::from_json(&value),
                    })
                });
                for subscription in futures_util::future::join_all(futures).await {
                    subscriptions.push(subscription?);
                }
            }
            return Ok(subscriptions);
        }
    }
    Err(EntitlementError::GrantLookupExceeded)
}

async fn fetch_json<T: DeserializeOwned>(
    polar: &PolarClient,
    path: &str,
    timeout: Duration,
) -> Result<T, EntitlementError> {
    let headers = reqwest::header::HeaderMap::new();
    match tokio::time::timeout(
        timeout,
        polar.request_json(reqwest::Method::GET, path, None, &headers),
    )
    .await
    {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(EntitlementError::Transport(error)),
        Err(_) => Err(EntitlementError::Timeout),
    }
}

/// Concrete Billing-polar entitlement reads. Construction performs no IO and
/// reads no environment; the client must use [`PolarPolicy::Billing`].
#[derive(Clone)]
pub struct PolarHttpEntitlementSource {
    polar: PolarClient,
    timeout: Duration,
}

impl PolarHttpEntitlementSource {
    pub fn new(polar: PolarClient) -> Result<Self, EntitlementError> {
        if polar.policy() != PolarPolicy::Billing {
            return Err(EntitlementError::WrongPolicy);
        }
        Ok(Self {
            polar,
            timeout: Duration::from_millis(POLAR_ENTITLEMENT_REQUEST_OPTIONS.timeout_ms),
        })
    }

    /// Explicit environment loading through the shared transport.
    pub fn from_env() -> Result<Self, EntitlementError> {
        Self::new(PolarClient::from_env(PolarPolicy::Billing)?)
    }

    /// The source's request options bound each read, not the whole walk.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub async fn customer_state(
        &self,
        customer_id: &str,
    ) -> Result<PolarEntitlementState, EntitlementError> {
        let path = format!("/v1/customers/{}/state", encode_uri_component(customer_id));
        let value: Value = fetch_json(&self.polar, &path, self.timeout).await?;
        PolarEntitlementState::from_json(&value)
    }

    pub async fn load_grace_subscriptions(
        &self,
        customer_id: &str,
        grants: &[PolarEntitlementGrant],
    ) -> Result<Vec<PolarGraceSubscription>, EntitlementError> {
        load_polar_grace_subscriptions(&self.polar, customer_id, grants, self.timeout).await
    }
}

impl PolarCustomerStateSource for PolarHttpEntitlementSource {
    fn customer_state<'a>(
        &'a self,
        customer_id: &'a str,
    ) -> BillingFuture<'a, PolarEntitlementState> {
        Box::pin(async move { PolarHttpEntitlementSource::customer_state(self, customer_id).await })
    }
}

impl PolarGraceLookup for PolarHttpEntitlementSource {
    fn grace_subscriptions<'a>(
        &'a self,
        customer_id: &'a str,
        grants: &'a [PolarEntitlementGrant],
    ) -> BillingFuture<'a, Vec<PolarGraceSubscription>> {
        Box::pin(async move { self.load_grace_subscriptions(customer_id, grants).await })
    }
}

/// System clock in epoch milliseconds, the `now()` boundary for callers.
pub fn system_now_millis() -> i64 {
    match SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) {
        Ok(value) => value.as_millis() as i64,
        Err(value) => -(value.duration().as_millis() as i64),
    }
}
