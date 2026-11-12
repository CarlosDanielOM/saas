//! Buying and changing plans and credit packs: the billing context of a user, the checkout or
//! portal decision with its discount, and the credit-pack catalog and checkout.
//!
//! Reference: `getBillingContext`, `createBillingCheckout`, `createCustomerPortalSession`,
//! `getCreditPackCatalog`, `createCreditPackCheckout` and their helpers in
//! `dimabot/src/utils/billing.ts`.
//!
//! - Calls to Polar happen in the reference's order and number (the two subscription lists in
//!   parallel; the product is read even when no discount competes), so the mock sees the same
//!   traffic. A checkout answered 422 is retried once without `customer_id`, with the same
//!   idempotency key; nothing else retries.
//! - Months of inactivity count UTC calendar months (`getUTCMonth`, `getUTCDate`).
//! - Redirect URLs are parsed and written by the WHATWG URL rules (`url` crate, as `new URL`);
//!   hosts are compared lower-cased with the port, as `url.host` is.
//! - The checkout body is `JSON.stringify` of the reference's object: keys in its order, an
//!   `undefined` member left out; `customer_email` and `customer_name` are left out when the user
//!   has none (the copy stores a text or nothing, never `null`).
//! - Idempotency keys end with the injected clock's epoch milliseconds, as `Date.now()`.
//!
//! Redirect targets (success, return and portal URLs) must be `https`, or `http` to a loopback
//! host, without credentials ([`is_safe_redirect`]), whatever the allowlist says; the reference
//! accepted any parsed URL with `BILLING_ALLOWED_REDIRECT_HOSTS` unset, as in production.

use super::{PaidTier, PlanTier, plan_rank};
use crate::config::{PolarConfig, RedirectConfig};
use crate::credit_packs::{
    CreditPackError, CreditPackOffer, RechargeExpiry, build_credit_pack_offers,
    credit_pack_definition, recharge_expiry,
};
use crate::js;
use crate::plans::pack_context::PackContextCache;
use crate::polar::{Discount, PolarClient, PolarError, Subscription};
use crate::products::{AI_CREDITS_METER_ID, FREE_PRODUCT_ID, PREMIUM_PRODUCT_ID, PRO_PRODUCT_ID};
use dima_core::Clock;
use dima_model::StrEnum;
use serde_json::{Map, Value};

/// `WINBACK_MONTHS`.
pub const WINBACK_MONTHS: i64 = 6;

/// The user fields the billing flows read (`IUsers`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BillingUser {
    /// `_id.toString()`.
    pub id: String,
    /// `email` (absent when not stored).
    pub email: Option<String>,
    /// `name`.
    pub name: Option<String>,
    /// `plan_tier` as stored.
    pub plan_tier: String,
    /// `polar_sh_customer_id`.
    pub polar_sh_customer_id: Option<String>,
    /// `last_app_activity_at` (epoch ms).
    pub last_app_activity_at: Option<i64>,
    /// `updated_at` (epoch ms).
    pub updated_at: Option<i64>,
    /// `referralCodeUsed`.
    pub referral_code_used: Option<String>,
}

impl BillingUser {
    /// The fields of a stored user.
    pub fn of(user: &dima_model::users::User) -> Self {
        Self {
            id: user.id.to_hex(),
            email: user.email.as_ref().map(|email| email.expose().clone()),
            name: user.name.clone(),
            plan_tier: user.plan_tier.as_str().to_owned(),
            polar_sh_customer_id: user
                .polar_sh_customer_id
                .as_ref()
                .map(|id| id.expose().clone()),
            last_app_activity_at: user.last_app_activity_at.map(|at| at.0),
            updated_at: user.updated_at.map(|at| at.0),
            referral_code_used: user.referral_code_used.clone(),
        }
    }

    fn customer_id(&self) -> Option<&str> {
        self.polar_sh_customer_id
            .as_deref()
            .filter(|id| !id.is_empty())
    }
}

/// `BillingAction`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BillingAction {
    /// Decide from the history.
    #[default]
    Auto,
    /// A new subscription.
    New,
    /// An upgrade.
    Upgrade,
    /// A change.
    Change,
    /// A reactivation.
    Reactivate,
}

impl BillingAction {
    /// `auto`, `new`, `upgrade`, `change`, `reactivate`.
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "auto" => Self::Auto,
            "new" => Self::New,
            "upgrade" => Self::Upgrade,
            "change" => Self::Change,
            "reactivate" => Self::Reactivate,
            _ => return None,
        })
    }
}

/// `BillingScenario`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BillingScenario {
    /// First subscription.
    New,
    /// To a higher tier.
    Upgrade,
    /// To another tier.
    Change,
    /// Back after six months or more.
    ReturningWinback,
    /// Back sooner, or recovering a past-due subscription.
    Reactivate,
    /// Already on the target plan.
    ActiveNoChange,
}

impl BillingScenario {
    /// The text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Upgrade => "upgrade",
            Self::Change => "change",
            Self::ReturningWinback => "returning_winback",
            Self::Reactivate => "reactivate",
            Self::ActiveNoChange => "active_no_change",
        }
    }
}

/// `diffMonths(from, to)`: whole UTC calendar months, never negative.
pub fn diff_months(from_ms: i64, to_ms: i64) -> i64 {
    let (Some(from), Some(to)) = (dima_text::utc_fields(from_ms), dima_text::utc_fields(to_ms))
    else {
        return 0;
    };
    let total = (to.year - from.year) * 12 + (i64::from(to.month) - i64::from(from.month));
    if to.day < from.day {
        (total - 1).max(0)
    } else {
        total.max(0)
    }
}

/// `inferScenario(...)`. `current_plan` is the stored text; a rank it does not have compares as
/// JavaScript's `undefined` does (never greater).
pub fn infer_scenario(
    requested: BillingAction,
    has_active_subscription: bool,
    target: PaidTier,
    current_plan: &str,
    winback_eligible: bool,
    has_any_history: bool,
) -> BillingScenario {
    if has_active_subscription {
        if target.as_str() == current_plan {
            return BillingScenario::ActiveNoChange;
        }
        let current_rank = PlanTier::parse(current_plan).map(plan_rank);
        if current_rank.is_some_and(|rank| plan_rank(target.tier()) > rank) {
            return BillingScenario::Upgrade;
        }
        return BillingScenario::Change;
    }
    match requested {
        BillingAction::New => BillingScenario::New,
        BillingAction::Upgrade => BillingScenario::Upgrade,
        BillingAction::Change => BillingScenario::Change,
        BillingAction::Reactivate => {
            if winback_eligible {
                BillingScenario::ReturningWinback
            } else {
                BillingScenario::Reactivate
            }
        }
        BillingAction::Auto => {
            if has_any_history && winback_eligible {
                BillingScenario::ReturningWinback
            } else if has_any_history {
                BillingScenario::Reactivate
            } else {
                BillingScenario::New
            }
        }
    }
}

/// `getCurrentPlanFromActiveSubscription(userPlan, activeProductId)`.
pub fn current_plan_from_active(user_plan: &str, active_product_id: Option<&str>) -> String {
    match active_product_id {
        Some(PRO_PRODUCT_ID) => "pro".into(),
        Some(PREMIUM_PRODUCT_ID) => "premium".into(),
        Some(FREE_PRODUCT_ID) => "free".into(),
        _ => user_plan.to_owned(),
    }
}

/// `getPaidSubscriptionFromSubscriptions(subscriptions)`: a Pro subscription, else a Premium one.
pub fn paid_subscription(subscriptions: &[Subscription]) -> Option<(PaidTier, &Subscription)> {
    let find = |product: &str| {
        subscriptions
            .iter()
            .find(|s| s.product_id.as_deref() == Some(product))
    };
    find(PRO_PRODUCT_ID)
        .map(|s| (PaidTier::Pro, s))
        .or_else(|| find(PREMIUM_PRODUCT_ID).map(|s| (PaidTier::Premium, s)))
}

/// `BillingContext`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BillingContext {
    /// The plan text (`user.plan_tier`, or the active subscription's).
    pub plan_tier: String,
    /// An active paid or free-priced subscription.
    pub has_active_subscription: bool,
    /// Any subscription ever.
    pub has_any_subscription_history: bool,
    /// Any paid subscription ever.
    pub has_paid_subscription_history: bool,
    /// Any trial ever.
    pub has_used_trial: bool,
    /// Whole months since the last activity (7 when unknown).
    pub inactivity_months: i64,
    /// Six months or more.
    pub is_winback_eligible: bool,
    /// The scenario.
    pub scenario: BillingScenario,
    /// The active subscription.
    pub active_subscription_id: Option<String>,
    /// Its product.
    pub active_product_id: Option<String>,
    /// A past-due subscription to recover in the portal.
    pub recovery_subscription_id: Option<String>,
    /// The target plan's product.
    pub target_product_id: Option<&'static str>,
    /// A referral discount may apply.
    pub is_referral_eligible: bool,
}

fn inactivity_months(user: &BillingUser, now_ms: i64) -> i64 {
    // `toDate`: a missing or invalid date is skipped.
    let valid = |ms: Option<i64>| ms.filter(|ms| dima_text::utc_fields(*ms).is_some());
    match valid(user.last_app_activity_at).or_else(|| valid(user.updated_at)) {
        Some(last) => diff_months(last, now_ms),
        None => WINBACK_MONTHS + 1,
    }
}

/// `getBillingContext(user, targetPlan, requestedAction)`.
pub async fn billing_context(
    polar: &PolarClient,
    user: &BillingUser,
    target: Option<PaidTier>,
    requested: BillingAction,
    now_ms: i64,
) -> Result<BillingContext, PolarError> {
    let inactivity = inactivity_months(user, now_ms);
    let winback = inactivity >= WINBACK_MONTHS;
    let referral = user
        .referral_code_used
        .as_deref()
        .is_some_and(|code| !code.is_empty());
    let scenario_target = target.unwrap_or(PaidTier::Premium);
    let Some(customer_id) = user.customer_id() else {
        return Ok(BillingContext {
            plan_tier: user.plan_tier.clone(),
            has_active_subscription: false,
            has_any_subscription_history: false,
            has_paid_subscription_history: false,
            has_used_trial: false,
            inactivity_months: inactivity,
            is_winback_eligible: winback,
            scenario: infer_scenario(
                requested,
                false,
                scenario_target,
                &user.plan_tier,
                winback,
                false,
            ),
            active_subscription_id: None,
            active_product_id: None,
            recovery_subscription_id: None,
            target_product_id: target.map(PaidTier::product_id),
            is_referral_eligible: referral,
        });
    };
    let (active, all) = tokio::join!(
        polar.list_subscriptions(customer_id, Some(true)),
        polar.list_subscriptions(customer_id, None),
    );
    let (active, all) = (active?, all?);
    let free = |s: &&Subscription| s.product_id.as_deref() == Some(FREE_PRODUCT_ID);
    let active_paid = paid_subscription(&active).map(|(_, s)| s);
    let active_subscription = active_paid.or_else(|| active.iter().find(free));
    let recoverable: Vec<Subscription> = all
        .iter()
        .filter(|s| s.status == "past_due" && s.ended_at.as_deref().is_none_or(str::is_empty))
        .cloned()
        .collect();
    let recovery = if active_paid.is_none() {
        paid_subscription(&recoverable)
            .map(|(_, s)| s)
            .or_else(|| recoverable.iter().find(free))
    } else {
        None
    };
    let has_any = !all.is_empty();
    let truthy = |value: &Option<String>| value.as_deref().is_some_and(|v| !v.is_empty());
    let active_product_id = active_subscription.and_then(|s| s.product_id.clone());
    let current_plan = current_plan_from_active(&user.plan_tier, active_product_id.as_deref());
    let scenario = if recovery.is_some() {
        BillingScenario::Reactivate
    } else {
        infer_scenario(
            requested,
            active_subscription.is_some(),
            scenario_target,
            &current_plan,
            winback,
            has_any,
        )
    };
    Ok(BillingContext {
        has_active_subscription: active_subscription.is_some(),
        has_any_subscription_history: has_any,
        has_paid_subscription_history: paid_subscription(&all).is_some(),
        has_used_trial: all
            .iter()
            .any(|s| truthy(&s.trial_start) || truthy(&s.trial_end)),
        inactivity_months: inactivity,
        is_winback_eligible: winback,
        scenario,
        active_subscription_id: active_subscription.map(|s| s.id.clone()),
        active_product_id,
        recovery_subscription_id: recovery.map(|s| s.id.clone()),
        target_product_id: target.map(PaidTier::product_id),
        is_referral_eligible: referral && !has_any,
        plan_tier: current_plan,
    })
}

/// Why a checkout could not be made (the reference's messages; the route decides the status).
#[derive(Debug, thiserror::Error)]
pub enum CheckoutError {
    /// Polar failed.
    #[error(transparent)]
    Polar(#[from] PolarError),
    /// `You are already subscribed to this plan.`
    #[error("You are already subscribed to this plan.")]
    AlreadySubscribed,
    /// `Invalid or inapplicable promo code for the selected plan.`
    #[error("Invalid or inapplicable promo code for the selected plan.")]
    InvalidPromoCode,
    /// `Customer does not have a Polar customer ID.`
    #[error("Customer does not have a Polar customer ID.")]
    NoCustomer,
    /// `CreditPackRequestError` (400 or 403).
    #[error("{message}")]
    CreditPackRequest {
        /// The message.
        message: &'static str,
        /// 400 or 403.
        status: u16,
    },
    /// `CreditPackConfigurationError`.
    #[error(transparent)]
    CreditPack(#[from] CreditPackError),
    /// Where the reference throws a `TypeError` on Polar's answer (a `null` discount product).
    #[error("Polar answered with an unexpected shape")]
    Malformed,
}

/// `isDiscountApplicableToProduct(discount, productId)`.
pub fn discount_applies(discount: &Discount, product_id: &str) -> Result<bool, CheckoutError> {
    let Some(Value::Array(products)) = &discount.products else {
        return Ok(true);
    };
    if products.is_empty() {
        return Ok(true);
    }
    for product in products {
        match product {
            Value::Null => return Err(CheckoutError::Malformed),
            Value::Object(object)
                if object.get("id").and_then(Value::as_str) == Some(product_id) =>
            {
                return Ok(true);
            }
            _ => {}
        }
    }
    Ok(false)
}

/// `estimateDiscountValue(discount, productBaseAmount)`.
pub fn estimate_discount_value(discount: &Discount, base_amount: f64) -> f64 {
    let or_zero = |value: Option<f64>| value.filter(|v| *v != 0.0 && !v.is_nan()).unwrap_or(0.0);
    match discount.kind.as_deref() {
        Some("fixed") => or_zero(discount.amount),
        Some("percentage") => {
            let basis_points = or_zero(discount.basis_points);
            if base_amount > 0.0 {
                (base_amount * (basis_points / 10_000.0)).floor()
            } else {
                basis_points
            }
        }
        _ => 0.0,
    }
}

/// Why a discount was chosen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiscountReason {
    /// The referral discount.
    Referral,
    /// The promo code.
    Promo,
    /// The winback discount.
    Winback,
    /// The upgrade discount.
    Upgrade,
    /// The change discount.
    Change,
}

impl DiscountReason {
    /// The text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Referral => "referral",
            Self::Promo => "promo",
            Self::Winback => "winback",
            Self::Upgrade => "upgrade",
            Self::Change => "change",
        }
    }
}

/// `selectBestDiscount(candidates, productBaseAmount)`: the first of the highest estimates.
pub fn select_best_discount(
    candidates: &[(DiscountReason, Discount)],
    base_amount: f64,
) -> Option<&(DiscountReason, Discount)> {
    let mut best = candidates.first()?;
    let mut best_value = estimate_discount_value(&best.1, base_amount);
    for candidate in candidates.iter().skip(1) {
        let value = estimate_discount_value(&candidate.1, base_amount);
        if value > best_value {
            best = candidate;
            best_value = value;
        }
    }
    Some(best)
}

/// `extractPriceAmountCents(price)`: the first of `amount`, `price_amount`, `fixed_amount`,
/// `unit_amount` that is a finite number above 0.
pub fn price_amount_cents(price: &Value) -> f64 {
    ["amount", "price_amount", "fixed_amount", "unit_amount"]
        .iter()
        .filter_map(|key| js::as_number(price.get(key)))
        .find(|amount| amount.is_finite() && *amount > 0.0)
        .unwrap_or(0.0)
}

/// `getProductBaseAmount`'s reading of a product: the highest price; 0 for anything else.
pub fn product_base_amount(product: &Value) -> f64 {
    product
        .get("prices")
        .and_then(Value::as_array)
        .map_or(0.0, |prices| {
            prices
                .iter()
                .map(price_amount_cents)
                .fold(
                    0.0,
                    |best, amount| if amount > best { amount } else { best },
                )
        })
}

/// `isUuidV4(value)` on the trimmed text.
pub fn is_uuid_v4(value: Option<&str>) -> bool {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return false;
    };
    let bytes = dima_text::trim(value).as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        14 => *byte == b'4',
        19 => matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
        _ => byte.is_ascii_hexdigit(),
    })
}

/// A `compactMetadata` value.
#[derive(Clone, Debug, PartialEq)]
pub enum MetaValue {
    /// Text (left out when blank).
    Text(String),
    /// A number.
    Number(f64),
    /// A boolean.
    Bool(bool),
    /// `null` or `undefined` (left out).
    Absent,
}

/// `compactMetadata(metadata)`.
pub fn compact_metadata(entries: Vec<(&str, MetaValue)>) -> Map<String, Value> {
    let mut map = Map::new();
    for (key, value) in entries {
        match value {
            MetaValue::Text(text) if !dima_text::trim(&text).is_empty() => {
                map.insert(key.to_owned(), Value::String(text));
            }
            MetaValue::Number(number) => {
                map.insert(key.to_owned(), crate::polar::js_number(number));
            }
            MetaValue::Bool(flag) => {
                map.insert(key.to_owned(), Value::Bool(flag));
            }
            MetaValue::Text(_) | MetaValue::Absent => {}
        }
    }
    map
}

fn url_host(url: &url::Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

/// `isAllowedHost(url)`.
fn is_allowed_host(url: &url::Url, allowed: Option<&str>) -> bool {
    let Some(list) = allowed.filter(|l| !l.is_empty()) else {
        return true;
    };
    let hosts: Vec<String> = list
        .split(',')
        .map(|host| dima_text::to_lower(dima_text::trim(host)))
        .filter(|host| !host.is_empty())
        .collect();
    hosts.is_empty() || hosts.contains(&dima_text::to_lower(&url_host(url)))
}

/// Whether `url` may be a redirect target at all: `https`, or `http` to `localhost` or a
/// loopback address, with no user name or password. Intended difference (item 8 of
/// P2-BILLING-01b, a security fix): the reference accepted any URL that parsed, `javascript:`
/// among them, when `BILLING_ALLOWED_REDIRECT_HOSTS` was unset (as in production).
pub fn is_safe_redirect(url: &url::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "https" => url.host().is_some(),
        "http" => match url.host() {
            Some(url::Host::Domain(name)) => name == "localhost",
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        },
        _ => false,
    }
}

/// `getDefaultUrl(envVar)`: the configured URL, normalised, when it parses and is a safe
/// redirect target (start-up already refuses an unsafe one: [`RedirectConfig::validate`]).
fn default_url(value: Option<&str>) -> Option<String> {
    url::Url::parse(value.filter(|v| !v.is_empty())?)
        .ok()
        .filter(is_safe_redirect)
        .map(String::from)
}

/// `sanitizeRedirectUrl(rawUrl, fallbackEnv)`, with [`is_safe_redirect`] required of the raw
/// URL before the host allowlist (which stays optional, as in the reference).
pub fn sanitize_redirect_url(
    raw: Option<&str>,
    fallback: Option<&str>,
    allowed_hosts: Option<&str>,
) -> Option<String> {
    if let Some(raw) = raw.filter(|r| !r.is_empty()) {
        match url::Url::parse(raw) {
            Ok(parsed) if is_safe_redirect(&parsed) && is_allowed_host(&parsed, allowed_hosts) => {
                return Some(parsed.into());
            }
            _ => return default_url(fallback),
        }
    }
    default_url(fallback)
}

/// Whether a configured fallback is acceptable at start-up: it parses, is a safe redirect
/// target and, when the allowlist is set, names an allowed host.
pub fn is_valid_configured_redirect(value: &str, allowed_hosts: Option<&str>) -> bool {
    url::Url::parse(value)
        .is_ok_and(|url| is_safe_redirect(&url) && is_allowed_host(&url, allowed_hosts))
}

/// `PortalSessionResponse`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortalSession {
    /// Id.
    pub session_id: String,
    /// URL.
    pub url: String,
    /// Expiry.
    pub expires_at: Option<String>,
}

/// The settings and clients of the checkout flows.
#[derive(Clone, Copy)]
pub struct Billing<'a> {
    /// Polar.
    pub polar: &'a PolarClient,
    /// Discounts.
    pub config: &'a PolarConfig,
    /// Redirects.
    pub redirects: &'a RedirectConfig,
    /// The credit-pack context cache.
    pub packs: &'a PackContextCache,
    /// The clock.
    pub clock: &'a dyn Clock,
}

impl std::fmt::Debug for Billing<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Billing")
    }
}

/// `CheckoutDecision`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckoutDecision {
    /// `checkout` or `customer_portal`.
    pub flow: &'static str,
    /// The scenario.
    pub scenario: BillingScenario,
    /// The chosen discount.
    pub selected_discount_id: Option<String>,
    /// Its code.
    pub selected_discount_code: Option<String>,
    /// Why.
    pub selected_discount_reason: Option<DiscountReason>,
    /// The checkout (none for the portal).
    pub checkout_id: Option<String>,
    /// The portal session.
    pub portal_session_id: Option<String>,
    /// Where to send the user.
    pub checkout_url: String,
    /// Whether Polar's form takes codes.
    pub allow_discount_codes: bool,
}

/// The input of `createBillingCheckout`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckoutRequest {
    /// The target plan.
    pub target: PaidTier,
    /// The requested action.
    pub action: BillingAction,
    /// A promo code (as sent).
    pub promo_code: Option<String>,
    /// Requested success URL.
    pub success_url: Option<String>,
    /// Requested return URL.
    pub return_url: Option<String>,
}

fn optional_text(value: Option<&str>) -> Value {
    value.map_or(Value::Null, Value::from)
}

impl Billing<'_> {
    async fn discount(&self, id: &str) -> Option<Discount> {
        // `getDiscountById`: any failure is `null`.
        self.polar.get_discount(id).await.ok()
    }

    async fn post_checkout(
        &self,
        mut payload: Map<String, Value>,
        idempotency_key: &str,
    ) -> Result<crate::polar::Checkout, PolarError> {
        match self
            .polar
            .create_checkout(&Value::Object(payload.clone()), idempotency_key)
            .await
        {
            Err(error)
                if error.status() == Some(422)
                    && payload
                        .get("customer_id")
                        .and_then(Value::as_str)
                        .is_some_and(|c| !c.is_empty()) =>
            {
                payload.shift_remove("customer_id");
                self.polar
                    .create_checkout(&Value::Object(payload), idempotency_key)
                    .await
            }
            other => other,
        }
    }

    /// `createCustomerPortalSession({user, returnUrl})`.
    pub async fn create_customer_portal_session(
        &self,
        user: &BillingUser,
        return_url: Option<&str>,
    ) -> Result<PortalSession, CheckoutError> {
        let customer = user.customer_id().ok_or(CheckoutError::NoCustomer)?;
        let return_url = sanitize_redirect_url(
            return_url,
            self.redirects.portal_return_url.as_deref(),
            self.redirects.allowed_hosts.as_deref(),
        );
        let mut payload = Map::new();
        payload.insert("customer_id".into(), Value::from(customer));
        if let Some(url) = return_url {
            payload.insert("return_url".into(), Value::String(url));
        }
        let session = self
            .polar
            .create_customer_session(&Value::Object(payload))
            .await?;
        Ok(PortalSession {
            session_id: session.id,
            url: session.customer_portal_url,
            expires_at: session.expires_at,
        })
    }

    /// `createBillingCheckout(request)`.
    pub async fn create_billing_checkout(
        &self,
        user: &BillingUser,
        request: &CheckoutRequest,
    ) -> Result<CheckoutDecision, CheckoutError> {
        let target = request.target;
        let target_product = target.product_id();
        let context = billing_context(
            self.polar,
            user,
            Some(target),
            request.action,
            self.clock.now_ms(),
        )
        .await?;
        let paid_active = matches!(
            context.active_product_id.as_deref(),
            Some(PREMIUM_PRODUCT_ID | PRO_PRODUCT_ID)
        );
        if context.recovery_subscription_id.is_some()
            || (context.scenario != BillingScenario::ActiveNoChange && paid_active)
        {
            let session = self
                .create_customer_portal_session(user, request.return_url.as_deref())
                .await?;
            return Ok(CheckoutDecision {
                flow: "customer_portal",
                scenario: context.scenario,
                selected_discount_id: None,
                selected_discount_code: None,
                selected_discount_reason: None,
                checkout_id: None,
                portal_session_id: Some(session.session_id),
                checkout_url: session.url,
                allow_discount_codes: false,
            });
        }
        if context.scenario == BillingScenario::ActiveNoChange {
            return Err(CheckoutError::AlreadySubscribed);
        }
        let mut candidates: Vec<(DiscountReason, Discount)> = Vec::new();
        if context.is_referral_eligible
            && let Some(id) = self.config.referral_discount_id.as_deref()
            && let Some(discount) = self.discount(id).await
            && discount_applies(&discount, target_product)?
        {
            candidates.push((DiscountReason::Referral, discount));
        }
        if let Some(code) = request.promo_code.as_deref().filter(|c| !c.is_empty()) {
            let query = dima_text::to_lower(dima_text::trim(code));
            let found = if query.is_empty() {
                None
            } else {
                let items = self.polar.search_discounts(&query).await?;
                match items.into_iter().find(|d| {
                    d.code.as_deref().map(dima_text::to_lower).as_deref() == Some(query.as_str())
                }) {
                    Some(discount) if discount_applies(&discount, target_product)? => {
                        Some(discount)
                    }
                    _ => None,
                }
            };
            candidates.push((
                DiscountReason::Promo,
                found.ok_or(CheckoutError::InvalidPromoCode)?,
            ));
        }
        let scenario_discount = match context.scenario {
            BillingScenario::ReturningWinback => self
                .config
                .scenario_discounts
                .winback
                .as_deref()
                .map(|id| (id, DiscountReason::Winback)),
            BillingScenario::Upgrade => self
                .config
                .scenario_discounts
                .upgrade
                .as_deref()
                .map(|id| (id, DiscountReason::Upgrade)),
            BillingScenario::Change => self
                .config
                .scenario_discounts
                .change
                .as_deref()
                .map(|id| (id, DiscountReason::Change)),
            _ => None,
        };
        if let Some((id, reason)) = scenario_discount
            && let Some(discount) = self.discount(id).await
            && discount_applies(&discount, target_product)?
        {
            candidates.push((reason, discount));
        }
        // `getProductBaseAmount`: any failure is 0.
        let base = match self.polar.get_product(target_product).await {
            Ok(product) => product_base_amount(&product),
            Err(_) => 0.0,
        };
        let best = select_best_discount(&candidates, base).cloned();
        let allowed = self.redirects.allowed_hosts.as_deref();
        let success_url = sanitize_redirect_url(
            request.success_url.as_deref(),
            self.redirects.success_url.as_deref(),
            allowed,
        );
        let return_url = sanitize_redirect_url(
            request.return_url.as_deref(),
            self.redirects.return_url.as_deref(),
            allowed,
        );
        let allow_discount_codes = !matches!(
            context.scenario,
            BillingScenario::Upgrade | BillingScenario::Change
        ) && best.is_none();
        let idempotency_key = format!(
            "billing:{}:{}:{}:{}",
            user.id,
            target.as_str(),
            context.scenario.as_str(),
            self.clock.now_ms()
        );
        let customer_id = user
            .polar_sh_customer_id
            .as_deref()
            .filter(|c| is_uuid_v4(Some(c)));
        #[allow(clippy::cast_precision_loss)]
        let metadata = compact_metadata(vec![
            ("source", MetaValue::Text("dimabot_billing".into())),
            (
                "scenario",
                MetaValue::Text(context.scenario.as_str().into()),
            ),
            ("target_plan", MetaValue::Text(target.as_str().into())),
            ("current_plan", MetaValue::Text(context.plan_tier.clone())),
            (
                "inactivity_months",
                MetaValue::Number(context.inactivity_months as f64),
            ),
            (
                "selected_discount_reason",
                best.as_ref().map_or(MetaValue::Absent, |(r, _)| {
                    MetaValue::Text(r.as_str().into())
                }),
            ),
            (
                "selected_discount_code",
                best.as_ref()
                    .and_then(|(_, d)| d.code.clone())
                    .map_or(MetaValue::Absent, MetaValue::Text),
            ),
            ("user_id", MetaValue::Text(user.id.clone())),
        ]);
        let mut payload = Map::new();
        payload.insert(
            "products".into(),
            Value::Array(vec![Value::from(target_product)]),
        );
        if context.active_product_id.as_deref() == Some(FREE_PRODUCT_ID)
            && let Some(id) = &context.active_subscription_id
        {
            payload.insert("subscription_id".into(), Value::from(id.as_str()));
        }
        if let Some(customer) = customer_id {
            payload.insert("customer_id".into(), Value::from(customer));
        }
        payload.insert("external_customer_id".into(), Value::from(user.id.as_str()));
        if let Some(email) = &user.email {
            payload.insert("customer_email".into(), optional_text(Some(email)));
        }
        if let Some(name) = &user.name {
            payload.insert("customer_name".into(), optional_text(Some(name)));
        }
        payload.insert(
            "allow_discount_codes".into(),
            Value::Bool(allow_discount_codes),
        );
        if let Some((_, discount)) = &best {
            payload.insert("discount_id".into(), Value::from(discount.id.as_str()));
        }
        payload.insert("metadata".into(), Value::Object(metadata));
        if context.has_paid_subscription_history || context.has_used_trial {
            payload.insert("allow_trial".into(), Value::Bool(false));
        }
        if let Some(url) = success_url {
            payload.insert("success_url".into(), Value::String(url));
        }
        if let Some(url) = return_url {
            payload.insert("return_url".into(), Value::String(url));
        }
        let checkout = self.post_checkout(payload, &idempotency_key).await?;
        Ok(CheckoutDecision {
            flow: "checkout",
            scenario: context.scenario,
            selected_discount_id: best
                .as_ref()
                .map(|(_, d)| d.id.clone())
                .filter(|id| !id.is_empty()),
            selected_discount_code: best
                .as_ref()
                .and_then(|(_, d)| d.code.clone())
                .filter(|c| !c.is_empty()),
            selected_discount_reason: best.as_ref().map(|(r, _)| *r),
            checkout_id: Some(checkout.id),
            portal_session_id: None,
            checkout_url: checkout.url,
            allow_discount_codes,
        })
    }

    /// `getCreditPackCatalog(user)`.
    pub async fn credit_pack_catalog(
        &self,
        user: &BillingUser,
    ) -> Result<CreditPackCatalog, CheckoutError> {
        let customer_id = user.customer_id();
        let (products, cached) = tokio::join!(self.polar.list_products(), async {
            match customer_id {
                Some(customer) => self.packs.load(customer, self.clock).await,
                None => None,
            }
        });
        let products = products?;
        let now_ms = self.clock.now_ms();
        let mut paid_plan = cached.as_ref().and_then(|c| match c.plan_tier {
            PlanTier::Premium => Some(PaidTier::Premium),
            PlanTier::Pro => Some(PaidTier::Pro),
            PlanTier::Free => None,
        });
        let mut expiry: Option<RechargeExpiry> = cached
            .as_ref()
            .and_then(|c| c.expires_at.as_deref())
            .and_then(|at| recharge_expiry(Some(at), None, now_ms));
        if let (None, Some(customer)) = (&cached, customer_id) {
            let active = self.polar.list_subscriptions(customer, Some(true)).await?;
            let paid = paid_subscription(&active);
            paid_plan = paid.map(|(tier, _)| tier);
            expiry = paid.and_then(|(_, s)| {
                recharge_expiry(
                    s.current_period_end.as_deref(),
                    s.ends_at.as_deref(),
                    now_ms,
                )
            });
            let tier = paid_plan.map_or(PlanTier::Free, PaidTier::tier);
            self.packs
                .store(
                    customer,
                    tier,
                    expiry.as_ref().map(|e| e.expires_at.as_str()),
                    self.clock,
                )
                .await;
        }
        let items: Vec<Value> = match products {
            None => Vec::new(),
            Some(Value::Array(items)) => items,
            // `.map` of a non-array: a TypeError in the reference.
            Some(_) => return Err(CheckoutError::Malformed),
        };
        let offers = build_credit_pack_offers(&items, AI_CREDITS_METER_ID, paid_plan.is_some())?;
        Ok(CreditPackCatalog {
            plan_tier: paid_plan.map_or(PlanTier::Free, PaidTier::tier),
            has_active_paid_subscription: paid_plan.is_some(),
            recharge_expires_at: expiry.as_ref().map(|e| e.expires_at.clone()),
            recharge_expiry_days: expiry.as_ref().map(|e| e.days_remaining),
            offers,
        })
    }

    /// `createCreditPackCheckout({user, productId, successUrl, returnUrl})`.
    pub async fn create_credit_pack_checkout(
        &self,
        user: &BillingUser,
        product_id: &str,
        success_url: Option<&str>,
        return_url: Option<&str>,
    ) -> Result<CreditPackCheckout, CheckoutError> {
        let definition =
            credit_pack_definition(product_id).ok_or(CheckoutError::CreditPackRequest {
                message: "Invalid credit pack product",
                status: 400,
            })?;
        let catalog = self.credit_pack_catalog(user).await?;
        let offer = catalog
            .offers
            .into_iter()
            .find(|offer| offer.id == product_id)
            .ok_or_else(|| {
                CreditPackError::Configuration(format!(
                    "Polar credit pack {product_id} is unavailable"
                ))
            })?;
        if !offer.eligible {
            return Err(CheckoutError::CreditPackRequest {
                message: "Recharge packs require an active Premium or Pro subscription",
                status: 403,
            });
        }
        let allowed = self.redirects.allowed_hosts.as_deref();
        let success_url =
            sanitize_redirect_url(success_url, self.redirects.success_url.as_deref(), allowed);
        let return_url =
            sanitize_redirect_url(return_url, self.redirects.return_url.as_deref(), allowed);
        let customer_id = user
            .polar_sh_customer_id
            .as_deref()
            .filter(|c| is_uuid_v4(Some(c)));
        let idempotency_key = format!(
            "credit-pack:{}:{product_id}:{}",
            user.id,
            self.clock.now_ms()
        );
        let metadata = compact_metadata(vec![
            ("source", MetaValue::Text("dimabot_credit_store".into())),
            (
                "pack_type",
                MetaValue::Text(definition.kind.as_str().into()),
            ),
            (
                "pack_size",
                MetaValue::Text(definition.size.as_str().into()),
            ),
            ("credits", MetaValue::Number(offer.credits)),
            ("rollover", MetaValue::Bool(offer.rollover)),
            ("user_id", MetaValue::Text(user.id.clone())),
        ]);
        let mut payload = Map::new();
        payload.insert(
            "products".into(),
            Value::Array(vec![Value::from(product_id)]),
        );
        if let Some(customer) = customer_id {
            payload.insert("customer_id".into(), Value::from(customer));
        }
        payload.insert("external_customer_id".into(), Value::from(user.id.as_str()));
        if let Some(email) = &user.email {
            payload.insert("customer_email".into(), optional_text(Some(email)));
        }
        if let Some(name) = &user.name {
            payload.insert("customer_name".into(), optional_text(Some(name)));
        }
        payload.insert("allow_discount_codes".into(), Value::Bool(false));
        payload.insert("metadata".into(), Value::Object(metadata));
        if let Some(url) = success_url {
            payload.insert("success_url".into(), Value::String(url));
        }
        if let Some(url) = return_url {
            payload.insert("return_url".into(), Value::String(url));
        }
        let checkout = self.post_checkout(payload, &idempotency_key).await?;
        Ok(CreditPackCheckout {
            checkout_id: checkout.id,
            checkout_url: checkout.url,
            offer,
        })
    }
}

/// `CreditPackCatalog`.
#[derive(Clone, Debug, PartialEq)]
pub struct CreditPackCatalog {
    /// The paid plan or free.
    pub plan_tier: PlanTier,
    /// Whether recharge packs are allowed.
    pub has_active_paid_subscription: bool,
    /// End of the paid cycle.
    pub recharge_expires_at: Option<String>,
    /// Days left in it.
    pub recharge_expiry_days: Option<f64>,
    /// The offers.
    pub offers: Vec<CreditPackOffer>,
}

/// `CreditPackCheckoutDecision`.
#[derive(Clone, Debug, PartialEq)]
pub struct CreditPackCheckout {
    /// Id.
    pub checkout_id: String,
    /// URL.
    pub checkout_url: String,
    /// The offer bought.
    pub offer: CreditPackOffer,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(text: &str) -> i64 {
        dima_text::parse_date(text).unwrap()
    }

    #[test]
    fn months_count_utc_calendar_months() {
        assert_eq!(
            diff_months(ms("2026-05-11T00:00:00Z"), ms("2026-11-11T00:00:00Z")),
            6
        );
        assert_eq!(
            diff_months(ms("2026-05-12T00:00:00Z"), ms("2026-11-11T23:59:59Z")),
            5
        );
        assert_eq!(
            diff_months(ms("2027-01-01T00:00:00Z"), ms("2026-11-11T00:00:00Z")),
            0
        );
    }

    #[test]
    fn scenarios_follow_the_reference() {
        use BillingAction::*;
        assert_eq!(
            infer_scenario(New, true, PaidTier::Pro, "premium", false, true),
            BillingScenario::Upgrade
        );
        assert_eq!(
            infer_scenario(Auto, true, PaidTier::Premium, "pro", false, true),
            BillingScenario::Change
        );
        assert_eq!(
            infer_scenario(Auto, true, PaidTier::Pro, "gold", false, true),
            BillingScenario::Change
        );
        assert_eq!(
            infer_scenario(Auto, true, PaidTier::Pro, "pro", false, true),
            BillingScenario::ActiveNoChange
        );
        assert_eq!(
            infer_scenario(Reactivate, false, PaidTier::Pro, "free", true, false),
            BillingScenario::ReturningWinback
        );
        assert_eq!(
            infer_scenario(Auto, false, PaidTier::Pro, "free", true, true),
            BillingScenario::ReturningWinback
        );
        assert_eq!(
            infer_scenario(Auto, false, PaidTier::Pro, "free", false, false),
            BillingScenario::New
        );
    }

    #[test]
    fn redirects_and_ids_follow_the_reference() {
        assert_eq!(
            sanitize_redirect_url(
                Some("https://Example.com:8443/a?b#c"),
                None,
                Some(" example.com:8443 ")
            ),
            Some("https://example.com:8443/a?b#c".into())
        );
        assert_eq!(
            sanitize_redirect_url(
                Some("https://evil.test/"),
                Some("https://domdimabot.com"),
                Some("domdimabot.com")
            ),
            Some("https://domdimabot.com/".into())
        );
        assert_eq!(sanitize_redirect_url(Some("not a url"), None, None), None);
        assert_eq!(
            sanitize_redirect_url(None, Some("https://x.test/ok"), None),
            Some("https://x.test/ok".into())
        );
        assert!(is_uuid_v4(Some(" 55C8D1D0-5cb8-405c-bcf2-d8dbb9ba0134\n")));
    }

    // Item 8 of P2-BILLING-01b: a redirect target is https (or http to a loopback host), with no
    // user name or password, whatever the allowlist says; an unsafe one falls back.
    #[test]
    fn unsafe_redirect_targets_fall_back() {
        let fallback = Some("https://domdimabot.com/billing");
        for raw in [
            "javascript:alert(1)",
            "JavaScript:alert(document.cookie)",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox(1)",
            "file:///etc/passwd",
            "ftp://domdimabot.com/",
            "http://domdimabot.com/billing",
            "HTTP://WWW.DomDimaBot.com:80/",
            "http://localhost.evil.test/",
            "https://user:pass@domdimabot.com/",
            "https://user@domdimabot.com/",
            "https://:pass@domdimabot.com/",
        ] {
            for allowed in [None, Some("domdimabot.com,www.domdimabot.com")] {
                assert_eq!(
                    sanitize_redirect_url(Some(raw), fallback, allowed),
                    Some("https://domdimabot.com/billing".to_owned()),
                    "{raw} {allowed:?}"
                );
                assert_eq!(
                    sanitize_redirect_url(Some(raw), None, allowed),
                    None,
                    "{raw}"
                );
            }
        }
        for (raw, expected) in [
            (
                "http://localhost:4200/billing",
                "http://localhost:4200/billing",
            ),
            ("http://127.0.0.1:4200/x", "http://127.0.0.1:4200/x"),
            ("http://[::1]:4200/x", "http://[::1]:4200/x"),
            ("https://domdimabot.com/ok", "https://domdimabot.com/ok"),
        ] {
            assert_eq!(
                sanitize_redirect_url(Some(raw), None, None).as_deref(),
                Some(expected)
            );
        }
        // An unsafe configured fallback is never used either (start-up refuses it).
        assert_eq!(
            sanitize_redirect_url(None, Some("javascript:alert(1)"), None),
            None
        );
        assert_eq!(
            sanitize_redirect_url(Some("javascript:x"), Some("http://evil.test/"), None),
            None
        );
        assert!(!is_uuid_v4(Some("55c8d1d0-5cb8-305c-bcf2-d8dbb9ba0134")));
        let meta = compact_metadata(vec![
            ("a", MetaValue::Text("  ".into())),
            ("b", MetaValue::Number(7.0)),
            ("c", MetaValue::Absent),
        ]);
        assert_eq!(dima_text::to_js_json(&Value::Object(meta)), r#"{"b":7}"#);
    }
}
