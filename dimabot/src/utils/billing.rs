//! Polar billing orchestration: context, checkout decisions, and the customer portal.
//!
//! Source contract: `dimabot/src/utils/billing.ts`, limited to the non-AI-credit
//! part (`BillingAction`, `BillingScenario`, `BillingContext`, `CheckoutDecision`,
//! `CreditPackCatalog`, `CreditPackCheckoutDecision`, `CreditPackRequestError`,
//! `PLAN_PRODUCT_MAP`, `PLAN_RANK`, `WINBACK_MONTHS`,
//! `creditPackBillingContextCacheKey`, `validCachedBillingContext`,
//! `cacheCreditPackBillingContext`, `getCachedCreditPackBillingContext`,
//! `sanitizeRedirectUrl`, `isAllowedHost`, `getDefaultUrl`,
//! `extractPriceAmountCents`, `getProductBaseAmount`, `listSubscriptions`,
//! `getDiscountById`, `isDiscountApplicableToProduct`,
//! `findDiscountByPromoCode`, `estimateDiscountValue`, `compactMetadata`,
//! `selectBestDiscount`, `inferScenario`,
//! `getCurrentPlanFromActiveSubscription`, `getPaidSubscriptionFromSubscriptions`,
//! `getPaidPlanFromSubscriptions`, `diffMonths`, `getLastActivityDate`,
//! `getBillingContext`, `getCreditPackCatalog`, `createCreditPackCheckout`,
//! `createBillingCheckout`, `createCustomerPortalSession`).
//!
//! Preserved behaviour: identical request paths, query ordering, request bodies,
//! metadata keys, idempotency-key formats, redirect sanitising, discount
//! tie-breaks (first candidate wins an equal value), scenario precedence
//! (Polar's live subscription beats the caller's action), the 422 `customer_id`
//! retry, the six-month winback threshold, and the credit-pack context cache key
//! (`billing:credit-packs:context:v1:<20 hex chars>`), TTL (2 minutes, clamped to
//! the remaining subscription time, minimum 1s) and free-tier normalisation.
//!
//! Deliberately NOT here: the AI-credit projection/reader (already ported in
//! `utils::ai_credit_projection` and `utils::ai_credit_reader`), gift packs
//! (`utils::credit_gift_provider`), credit-source classification
//! (`utils::ai_credit_sources`), HTTP route/middleware wiring, MongoDB user
//! loading, and `dotenv` file loading. Constructors perform no IO; only
//! [`BillingService::from_env`], which exists solely to read the documented
//! environment names, touches the environment.
//!
//! The source's intentional `catch`-based degradations (product price lookup,
//! discount lookup, cached-context read/write) are returned as explicit
//! [`Degraded`] values instead of silent neutral results.

use super::{
    ai_credit_projection::{AI_CREDITS_METER_ID, PlanTier},
    credit_packs::{
        self, CreditPackConfigurationError, CreditPackDefinition, CreditPackOffer,
        PolarCreditPackProduct, RechargeSubscriptionCycleLike,
    },
    credit_policy::JsDate,
    js_date::parse_date,
    polar::{PolarClient, PolarError, PolarPolicy},
};
use redis::aio::ConnectionManager;
use reqwest::{
    Method, Url,
    header::{HeaderMap, HeaderValue},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

/// `PRODUCT_IDS` from `utils/referral.ts`, which `billing.ts` consumes.
pub const PLAN_PRODUCT_ID_FREE: &str = "fccf0669-adab-447d-89c8-d77d8b83bea5";
pub const PLAN_PRODUCT_ID_PREMIUM: &str = "55c8d1d0-5cb8-405c-bcf2-d8dbb9ba0134";
pub const PLAN_PRODUCT_ID_PRO: &str = "1468eea1-7ad0-40d2-b828-4d4cd6b4abdc";

/// `WINBACK_MONTHS`.
pub const WINBACK_MONTHS: f64 = 6.0;
/// `CREDIT_PACK_BILLING_CONTEXT_CACHE_TTL_SECONDS`.
pub const CREDIT_PACK_BILLING_CONTEXT_CACHE_TTL_SECONDS: u64 = 2 * 60;
/// `CREDIT_PACK_BILLING_CONTEXT_CACHE_VERSION`.
pub const CREDIT_PACK_BILLING_CONTEXT_CACHE_VERSION: u32 = 1;

/// `BillingAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BillingAction {
    Auto,
    New,
    Upgrade,
    Change,
    Reactivate,
}

impl BillingAction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::New => "new",
            Self::Upgrade => "upgrade",
            Self::Change => "change",
            Self::Reactivate => "reactivate",
        }
    }
}

impl fmt::Display for BillingAction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `BillingScenario`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BillingScenario {
    New,
    Upgrade,
    Change,
    ReturningWinback,
    Reactivate,
    ActiveNoChange,
}

impl BillingScenario {
    pub const fn as_str(self) -> &'static str {
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

impl fmt::Display for BillingScenario {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `Exclude<PlanTier, 'free'>`, the only plans a checkout can target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaidPlanTier {
    Premium,
    Pro,
}

impl PaidPlanTier {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Premium => "premium",
            Self::Pro => "pro",
        }
    }

    pub const fn plan_tier(self) -> PlanTier {
        match self {
            Self::Premium => PlanTier::Premium,
            Self::Pro => PlanTier::Pro,
        }
    }

    pub const fn product_id(self) -> &'static str {
        match self {
            Self::Premium => PLAN_PRODUCT_ID_PREMIUM,
            Self::Pro => PLAN_PRODUCT_ID_PRO,
        }
    }

    /// `PLAN_PRODUCT_MAP[targetPlan]`.
    pub fn from_plan_tier(tier: PlanTier) -> Option<Self> {
        match tier {
            PlanTier::Premium => Some(Self::Premium),
            PlanTier::Pro => Some(Self::Pro),
            _ => None,
        }
    }
}

impl fmt::Display for PaidPlanTier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `CheckoutDecision['flow']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckoutFlow {
    Checkout,
    CustomerPortal,
}

impl CheckoutFlow {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Checkout => "checkout",
            Self::CustomerPortal => "customer_portal",
        }
    }
}

/// `CheckoutDecision['selectedDiscountReason']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscountReason {
    Referral,
    Promo,
    Winback,
    Upgrade,
    Change,
}

impl DiscountReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Referral => "referral",
            Self::Promo => "promo",
            Self::Winback => "winback",
            Self::Upgrade => "upgrade",
            Self::Change => "change",
        }
    }
}

impl fmt::Display for DiscountReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `PlanTier` names as stored in metadata and the cache payload. The shared
/// projection type has no `PartialEq`, so callers compare these names.
pub fn plan_tier_name(tier: PlanTier) -> &'static str {
    match tier {
        PlanTier::Free => "free",
        PlanTier::Premium => "premium",
        PlanTier::Pro => "pro",
        PlanTier::Null => "null",
        PlanTier::Undefined => "undefined",
    }
}

fn tier_from_str(value: &str) -> Option<PlanTier> {
    match value {
        "free" => Some(PlanTier::Free),
        "premium" => Some(PlanTier::Premium),
        "pro" => Some(PlanTier::Pro),
        _ => None,
    }
}

/// PlanTier equality without requiring `PartialEq` on the shared projection type.
fn tier_eq(left: PlanTier, right: PlanTier) -> bool {
    matches!(
        (left, right),
        (PlanTier::Free, PlanTier::Free)
            | (PlanTier::Premium, PlanTier::Premium)
            | (PlanTier::Pro, PlanTier::Pro)
            | (PlanTier::Null, PlanTier::Null)
            | (PlanTier::Undefined, PlanTier::Undefined)
    )
}

/// `PLAN_RANK`. Unknown tiers stay `NaN` so the source's comparisons are false.
fn plan_rank(tier: PlanTier) -> f64 {
    match tier {
        PlanTier::Free => 0.0,
        PlanTier::Premium => 1.0,
        PlanTier::Pro => 2.0,
        PlanTier::Null | PlanTier::Undefined => f64::NAN,
    }
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}')
}

fn system_millis(now: SystemTime) -> f64 {
    match now.duration_since(UNIX_EPOCH) {
        Ok(value) => value.as_millis() as f64,
        Err(value) => -(value.duration().as_millis() as f64),
    }
}

/// Gregorian UTC date for a clipped millisecond timestamp.
fn utc_civil(millis: i64) -> (i64, i64, i64) {
    let days = millis.div_euclid(86_400_000);
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

/// `diffMonths`: whole UTC months, floored at zero, with a partial month at the
/// end counted as not-yet-elapsed. An invalid date yields `NaN`, as in JS.
pub fn diff_months(from: JsDate, to: JsDate) -> f64 {
    let (Some(from), Some(to)) = (from.timestamp_millis(), to.timestamp_millis()) else {
        return f64::NAN;
    };
    let (from_year, from_month, from_day) = utc_civil(from);
    let (to_year, to_month, to_day) = utc_civil(to);
    let total = (to_year - from_year) * 12 + (to_month - from_month);
    let total = if to_day < from_day { total - 1 } else { total };
    if total > 0 { total as f64 } else { 0.0 }
}

/// `BillingUser`: the `IUsers` fields this slice reads. Dates arrive already
/// parsed, matching the `credit_policy` boundary; pass `None` for missing or
/// invalid values (the source's `toDate` then returns `null`).
#[derive(Debug, Clone, Copy)]
pub struct BillingUser<'a> {
    pub id: &'a str,
    pub email: Option<&'a str>,
    pub name: Option<&'a str>,
    pub plan_tier: PlanTier,
    pub polar_sh_customer_id: Option<&'a str>,
    pub referral_code_used: bool,
    pub last_app_activity_at: Option<JsDate>,
    pub updated_at: Option<JsDate>,
}

impl BillingUser<'_> {
    /// `user.polar_sh_customer_id || null`.
    pub fn customer_id(&self) -> Option<&str> {
        self.polar_sh_customer_id.filter(|value| !value.is_empty())
    }

    /// `getLastActivityDate`: `last_app_activity_at`, else `updated_at`.
    fn last_activity_date(&self) -> Option<JsDate> {
        self.last_app_activity_at
            .or(self.updated_at)
            .filter(|date| date.timestamp_millis().is_some())
    }
}

/// `BillingContext`.
#[derive(Debug, Clone)]
pub struct BillingContext {
    pub plan_tier: PlanTier,
    pub has_active_subscription: bool,
    pub has_any_subscription_history: bool,
    pub inactivity_months: f64,
    pub is_winback_eligible: bool,
    pub scenario: BillingScenario,
    pub active_subscription_id: Option<String>,
    pub active_product_id: Option<String>,
    pub target_product_id: Option<String>,
    pub is_referral_eligible: bool,
}

/// `CheckoutDecision`.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckoutDecision {
    pub flow: CheckoutFlow,
    pub scenario: BillingScenario,
    pub selected_discount_id: Option<String>,
    pub selected_discount_code: Option<String>,
    pub selected_discount_reason: Option<DiscountReason>,
    pub checkout_id: Option<String>,
    pub portal_session_id: Option<String>,
    pub checkout_url: String,
    pub allow_discount_codes: bool,
}

/// `CreditPackCatalog`.
#[derive(Debug, Clone)]
pub struct CreditPackCatalog {
    pub plan_tier: PlanTier,
    pub has_active_paid_subscription: bool,
    pub recharge_expires_at: Option<String>,
    pub recharge_expiry_days: Option<f64>,
    pub offers: Vec<CreditPackOffer>,
}

/// `CreditPackCheckoutDecision`.
#[derive(Debug, Clone, PartialEq)]
pub struct CreditPackCheckoutDecision {
    pub checkout_id: String,
    pub checkout_url: String,
    pub offer: CreditPackOffer,
}

/// `PortalSessionResponse`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortalSessionResponse {
    pub session_id: String,
    pub url: String,
    pub expires_at: Option<String>,
}

/// `CreditPackRequestError`: a 400/403 client error with the source's message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreditPackRequestError {
    pub status_code: u16,
    pub message: &'static str,
}

impl CreditPackRequestError {
    /// `Invalid credit pack product` (400).
    pub const fn invalid_product() -> Self {
        Self {
            status_code: 400,
            message: "Invalid credit pack product",
        }
    }

    /// `Recharge packs require an active Premium or Pro subscription` (403).
    pub const fn paid_plan_required() -> Self {
        Self {
            status_code: 403,
            message: "Recharge packs require an active Premium or Pro subscription",
        }
    }
}

impl fmt::Display for CreditPackRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message)
    }
}

impl std::error::Error for CreditPackRequestError {}

/// Typed billing failure. Every variant that exists in the source reproduces its
/// exact message; provider failures delegate to [`PolarError`].
#[derive(Debug, Clone, PartialEq)]
pub enum BillingError {
    Polar(PolarError),
    AlreadySubscribed,
    CustomerMissingPolarId,
    InvalidPromoCode,
    CreditPack(CreditPackRequestError),
    CreditPackConfiguration(CreditPackConfigurationError),
    /// A provider response omitted a field the caller needs; the source would
    /// have propagated `undefined` into a URL or identifier.
    ProviderResponse(&'static str),
    Cache(String),
}

impl fmt::Display for BillingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Polar(error) => error.fmt(f),
            Self::AlreadySubscribed => f.write_str("You are already subscribed to this plan."),
            Self::CustomerMissingPolarId => {
                f.write_str("Customer does not have a Polar customer ID.")
            }
            Self::InvalidPromoCode => {
                f.write_str("Invalid or inapplicable promo code for the selected plan.")
            }
            Self::CreditPack(error) => error.fmt(f),
            Self::CreditPackConfiguration(error) => error.fmt(f),
            Self::ProviderResponse(field) => {
                write!(f, "Polar provider response is missing {field}")
            }
            Self::Cache(message) => write!(f, "Credit-pack billing context cache failed: {message}"),
        }
    }
}

impl std::error::Error for BillingError {}

impl From<PolarError> for BillingError {
    fn from(error: PolarError) -> Self {
        Self::Polar(error)
    }
}

impl From<CreditPackConfigurationError> for BillingError {
    fn from(error: CreditPackConfigurationError) -> Self {
        Self::CreditPackConfiguration(error)
    }
}

impl From<CreditPackRequestError> for BillingError {
    fn from(error: CreditPackRequestError) -> Self {
        Self::CreditPack(error)
    }
}

/// Why an intentionally degraded read returned its neutral value.
#[derive(Debug, Clone, PartialEq)]
pub enum DegradeReason {
    /// The cache is not configured or the Redis command failed.
    CacheUnavailable,
    /// The cached payload was not a valid, unexpired context.
    MalformedCache,
    Polar(PolarError),
}

impl fmt::Display for DegradeReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CacheUnavailable => f.write_str("credit-pack billing context cache unavailable"),
            Self::MalformedCache => f.write_str("cached credit-pack billing context is invalid"),
            Self::Polar(error) => error.fmt(f),
        }
    }
}

/// An explicit degraded result: the source swallows the error and continues with
/// a neutral value. Keeping the reason lets callers log or alert without
/// changing behaviour.
#[derive(Debug, Clone, PartialEq)]
pub struct Degraded<T> {
    pub value: T,
    pub reason: Option<DegradeReason>,
}

impl<T> Degraded<T> {
    pub fn ok(value: T) -> Self {
        Self { value, reason: None }
    }

    pub fn degraded(value: T, reason: DegradeReason) -> Self {
        Self {
            value,
            reason: Some(reason),
        }
    }

    pub fn is_degraded(&self) -> bool {
        self.reason.is_some()
    }
}

/// `BillingConfig`: the environment-derived policy this slice needs. Nothing is
/// read at module scope; [`BillingConfig::from_env`] is the only env reader and
/// invalid default URLs are normalised to `None`, exactly like `getDefaultUrl`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BillingConfig {
    allowed_redirect_hosts: Vec<String>,
    success_url: Option<String>,
    return_url: Option<String>,
    portal_return_url: Option<String>,
    referral_discount_id: Option<String>,
    winback_discount_id: Option<String>,
    upgrade_discount_id: Option<String>,
    change_discount_id: Option<String>,
}

/// `getDefaultUrl(envVar)` targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefaultUrl {
    Success,
    Return,
    PortalReturn,
}

impl BillingConfig {
    pub fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// `process.env` replacement. `BILLING_ALLOWED_REDIRECT_HOSTS` keeps the
    /// source's comma split, trim, lowercase and empty-entry filtering.
    pub fn from_lookup(mut lookup: impl FnMut(&str) -> Option<String>) -> Self {
        let allowed_redirect_hosts = lookup("BILLING_ALLOWED_REDIRECT_HOSTS")
            .map(|list| {
                list.split(',')
                    .map(|host| host.trim().to_lowercase())
                    .filter(|host| !host.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let mut config = Self {
            allowed_redirect_hosts,
            referral_discount_id: non_empty(lookup("POLARSH_REFERRAL_DISCOUNT_ID")),
            winback_discount_id: non_empty(lookup("POLARSH_WINBACK_DISCOUNT_ID")),
            upgrade_discount_id: non_empty(lookup("POLARSH_UPGRADE_DISCOUNT_ID")),
            change_discount_id: non_empty(lookup("POLARSH_CHANGE_DISCOUNT_ID")),
            ..Self::default()
        };
        config.success_url = normalize_url(lookup("BILLING_SUCCESS_URL"));
        config.return_url = normalize_url(lookup("BILLING_RETURN_URL"));
        config.portal_return_url = normalize_url(lookup("BILLING_PORTAL_RETURN_URL"));
        config
    }

    pub fn with_allowed_redirect_hosts(mut self, hosts: impl IntoIterator<Item = String>) -> Self {
        self.allowed_redirect_hosts = hosts
            .into_iter()
            .map(|host| host.trim().to_lowercase())
            .filter(|host| !host.is_empty())
            .collect();
        self
    }

    pub fn with_default_url(mut self, target: DefaultUrl, url: impl Into<String>) -> Self {
        let url = normalize_url(Some(url.into()));
        match target {
            DefaultUrl::Success => self.success_url = url,
            DefaultUrl::Return => self.return_url = url,
            DefaultUrl::PortalReturn => self.portal_return_url = url,
        }
        self
    }

    pub fn with_discount_id(mut self, scenario: BillingScenario, id: impl Into<String>) -> Self {
        let id = non_empty(Some(id.into()));
        match scenario {
            BillingScenario::ReturningWinback => self.winback_discount_id = id,
            BillingScenario::Upgrade => self.upgrade_discount_id = id,
            BillingScenario::Change => self.change_discount_id = id,
            _ => {}
        }
        self
    }

    pub fn with_referral_discount_id(mut self, id: impl Into<String>) -> Self {
        self.referral_discount_id = non_empty(Some(id.into()));
        self
    }

    fn default_url(&self, target: DefaultUrl) -> Option<&str> {
        match target {
            DefaultUrl::Success => self.success_url.as_deref(),
            DefaultUrl::Return => self.return_url.as_deref(),
            DefaultUrl::PortalReturn => self.portal_return_url.as_deref(),
        }
    }

    /// `getDiscountConfigByScenario`.
    fn discount_for_scenario(&self, scenario: BillingScenario) -> Option<&str> {
        match scenario {
            BillingScenario::ReturningWinback => self.winback_discount_id.as_deref(),
            BillingScenario::Upgrade => self.upgrade_discount_id.as_deref(),
            BillingScenario::Change => self.change_discount_id.as_deref(),
            _ => None,
        }
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

/// `new URL(value).toString()`, `None` when the value is missing or invalid.
fn normalize_url(value: Option<String>) -> Option<String> {
    value
        .filter(|value| !value.is_empty())
        .and_then(|value| Url::parse(&value).ok())
        .map(|url| url.to_string())
}

/// WHATWG `URL.host` (hostname plus a non-default port).
fn url_host(url: &Url) -> Option<String> {
    let host = url.host_str()?.to_lowercase();
    match url.port() {
        Some(port) => Some(format!("{host}:{port}")),
        None => Some(host),
    }
}

/// `isAllowedHost`.
pub fn is_allowed_host(config: &BillingConfig, url: &Url) -> bool {
    if config.allowed_redirect_hosts.is_empty() {
        return true;
    }
    url_host(url).is_some_and(|host| {
        config
            .allowed_redirect_hosts
            .iter()
            .any(|allowed| *allowed == host)
    })
}

/// `sanitizeRedirectUrl`.
pub fn sanitize_redirect_url(
    config: &BillingConfig,
    raw_url: Option<&str>,
    fallback: DefaultUrl,
) -> Option<String> {
    if let Some(raw_url) = raw_url.filter(|value| !value.is_empty()) {
        return match Url::parse(raw_url) {
            Ok(url) if is_allowed_host(config, &url) => Some(url.to_string()),
            Ok(_) => config.default_url(fallback).map(str::to_owned),
            Err(_) => config.default_url(fallback).map(str::to_owned),
        };
    }
    config.default_url(fallback).map(str::to_owned)
}

/// `compactMetadata`: drops `null`/`undefined`, blank strings, and every value
/// that is not a string, number, or boolean.
pub fn compact_metadata(fields: &[(&str, Option<Value>)]) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in fields {
        let Some(value) = value else { continue };
        match value {
            Value::String(text) if js_trim(text).is_empty() => continue,
            Value::String(_) | Value::Number(_) | Value::Bool(_) => {
                out.insert((*key).to_owned(), value.clone());
            }
            _ => continue,
        }
    }
    out
}

/// `extractPriceAmountCents`: the first finite positive candidate, else zero.
pub fn extract_price_amount_cents(price: &Value) -> f64 {
    for key in ["amount", "price_amount", "fixed_amount", "unit_amount"] {
        if let Some(amount) = price.get(key).and_then(Value::as_f64) {
            if amount.is_finite() && amount > 0.0 {
                return amount;
            }
        }
    }
    0.0
}

/// `DiscountLike`. Provider fields are optional so malformed discounts degrade
/// exactly where the source's optional chaining would.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct DiscountLike {
    #[serde(default)]
    pub id: String,
    pub code: Option<String>,
    #[serde(rename = "type")]
    pub discount_type: Option<String>,
    pub basis_points: Option<f64>,
    pub amount: Option<f64>,
    pub products: Option<Vec<DiscountProduct>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct DiscountProduct {
    pub id: Option<String>,
}

/// `isDiscountApplicableToProduct`.
pub fn is_discount_applicable_to_product(discount: &DiscountLike, product_id: &str) -> bool {
    match discount.products.as_deref() {
        Some(products) if !products.is_empty() => {
            products.iter().any(|product| product.id.as_deref() == Some(product_id))
        }
        _ => true,
    }
}

/// `estimateDiscountValue`.
pub fn estimate_discount_value(discount: &DiscountLike, product_base_amount: f64) -> f64 {
    match discount.discount_type.as_deref() {
        Some("fixed") => discount.amount.unwrap_or(0.0),
        Some("percentage") => {
            let basis_points = discount.basis_points.unwrap_or(0.0);
            if product_base_amount > 0.0 {
                (product_base_amount * (basis_points / 10_000.0)).floor()
            } else {
                basis_points
            }
        }
        _ => 0.0,
    }
}

#[derive(Debug, Clone)]
pub struct DiscountCandidate {
    pub reason: DiscountReason,
    pub discount: DiscountLike,
}

/// `selectBestDiscount`: strictly greater value wins, so the first candidate
/// (referral, then promo, then scenario) wins an exact tie.
pub fn select_best_discount(
    candidates: &[DiscountCandidate],
    product_base_amount: f64,
) -> Option<&DiscountCandidate> {
    let mut best: Option<&DiscountCandidate> = None;
    let mut best_value = f64::NEG_INFINITY;
    for candidate in candidates {
        let value = estimate_discount_value(&candidate.discount, product_base_amount);
        if best.is_none() || value > best_value {
            best = Some(candidate);
            best_value = value;
        }
    }
    best
}

/// `PolarSubscription`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PolarSubscription {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub status: String,
    pub product_id: Option<String>,
    pub ended_at: Option<String>,
    pub canceled_at: Option<String>,
    pub current_period_end: Option<String>,
    pub ends_at: Option<String>,
}

/// `getPaidSubscriptionFromSubscriptions`: Pro wins over Premium.
pub fn get_paid_subscription_from_subscriptions(
    subscriptions: &[PolarSubscription],
) -> Option<(PaidPlanTier, &PolarSubscription)> {
    if let Some(subscription) = subscriptions
        .iter()
        .find(|subscription| subscription.product_id.as_deref() == Some(PLAN_PRODUCT_ID_PRO))
    {
        return Some((PaidPlanTier::Pro, subscription));
    }
    subscriptions
        .iter()
        .find(|subscription| subscription.product_id.as_deref() == Some(PLAN_PRODUCT_ID_PREMIUM))
        .map(|subscription| (PaidPlanTier::Premium, subscription))
}

/// `getPaidPlanFromSubscriptions`.
pub fn get_paid_plan_from_subscriptions(
    subscriptions: &[PolarSubscription],
) -> Option<PaidPlanTier> {
    get_paid_subscription_from_subscriptions(subscriptions).map(|(plan, _)| plan)
}

/// `getCurrentPlanFromActiveSubscription`.
pub fn get_current_plan_from_active_subscription(
    user_plan: PlanTier,
    active_product_id: Option<&str>,
) -> PlanTier {
    match active_product_id {
        Some(PLAN_PRODUCT_ID_PRO) => PlanTier::Pro,
        Some(PLAN_PRODUCT_ID_PREMIUM) => PlanTier::Premium,
        Some(PLAN_PRODUCT_ID_FREE) => PlanTier::Free,
        _ => user_plan,
    }
}

/// `inferScenario`. A live Polar subscription outranks the requested action, so
/// `action=new` can never buy a second plan or bypass the same-plan guard.
pub fn infer_scenario(
    requested_action: BillingAction,
    has_active_subscription: bool,
    target_plan: PaidPlanTier,
    current_plan: PlanTier,
    winback_eligible: bool,
    has_any_subscription_history: bool,
) -> BillingScenario {
    if has_active_subscription {
        if tier_eq(target_plan.plan_tier(), current_plan) {
            return BillingScenario::ActiveNoChange;
        }
        if plan_rank(target_plan.plan_tier()) > plan_rank(current_plan) {
            return BillingScenario::Upgrade;
        }
        return BillingScenario::Change;
    }
    if requested_action != BillingAction::Auto {
        return match requested_action {
            BillingAction::New => BillingScenario::New,
            BillingAction::Upgrade => BillingScenario::Upgrade,
            BillingAction::Change => BillingScenario::Change,
            _ => {
                if winback_eligible {
                    BillingScenario::ReturningWinback
                } else {
                    BillingScenario::Reactivate
                }
            }
        };
    }
    if has_any_subscription_history && winback_eligible {
        return BillingScenario::ReturningWinback;
    }
    if has_any_subscription_history {
        BillingScenario::Reactivate
    } else {
        BillingScenario::New
    }
}

/// The inline `activeProductId P` branch of `createBillingCheckout`.
pub fn plan_checkout_flow(active_product_id: Option<&str>) -> CheckoutFlow {
    match active_product_id {
        Some(PLAN_PRODUCT_ID_PREMIUM) | Some(PLAN_PRODUCT_ID_PRO) => CheckoutFlow::CustomerPortal,
        _ => CheckoutFlow::Checkout,
    }
}

/// `creditPackBillingContextCacheKey`.
pub fn credit_pack_billing_context_cache_key(customer_id: &str) -> String {
    let hash = format!("{:x}", Sha256::digest(customer_id.as_bytes()));
    format!(
        "billing:credit-packs:context:v{CREDIT_PACK_BILLING_CONTEXT_CACHE_VERSION}:{}",
        &hash[..20]
    )
}

/// Normalised cached value from `validCachedBillingContext`.
#[derive(Debug, Clone)]
pub struct CachedBillingContext {
    pub version: u32,
    pub plan_tier: PlanTier,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct CreditPackBillingContextCacheValue {
    version: u32,
    #[serde(rename = "planTier")]
    plan_tier: &'static str,
    #[serde(rename = "expiresAt")]
    expires_at: Option<String>,
}

fn truthy_json(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string_of(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(items) => items
            .iter()
            .map(js_string_of)
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `validCachedBillingContext`. Free-tier contexts are normalised to no expiry;
/// a paid context expires at a parsed timestamp strictly after `now_ms`.
pub fn valid_cached_billing_context(
    value: &Value,
    now_ms: f64,
) -> Option<CachedBillingContext> {
    let object = value.as_object()?;
    if object.get("version").and_then(Value::as_f64) != Some(f64::from(CREDIT_PACK_BILLING_CONTEXT_CACHE_VERSION)) {
        return None;
    }
    let plan_tier = object.get("planTier").and_then(Value::as_str)?;
    let plan_tier = tier_from_str(plan_tier)?;
    if matches!(plan_tier, PlanTier::Free) {
        return Some(CachedBillingContext {
            version: CREDIT_PACK_BILLING_CONTEXT_CACHE_VERSION,
            plan_tier,
            expires_at: None,
        });
    }
    let raw = match object.get("expiresAt") {
        Some(value) if truthy_json(value) => js_string_of(value),
        _ => String::new(),
    };
    let expires_at_ms = parse_date(&raw)? as f64;
    if !(expires_at_ms > now_ms) {
        return None;
    }
    let expires_at = JsDate::from_millis(expires_at_ms).to_iso_string().ok()?;
    Some(CachedBillingContext {
        version: CREDIT_PACK_BILLING_CONTEXT_CACHE_VERSION,
        plan_tier,
        expires_at: Some(expires_at),
    })
}

/// TTL for a normalised context: the remaining subscription seconds, clamped to
/// `[1, 120]`; a free context uses the full two minutes.
fn cache_ttl_seconds(context: &CachedBillingContext, now_ms: f64) -> u64 {
    let remaining = match context.expires_at.as_deref().and_then(parse_date) {
        Some(expires_at_ms) => ((expires_at_ms as f64 - now_ms) / 1000.0).ceil(),
        None => CREDIT_PACK_BILLING_CONTEXT_CACHE_TTL_SECONDS as f64,
    };
    let clamped = remaining.clamp(1.0, CREDIT_PACK_BILLING_CONTEXT_CACHE_TTL_SECONDS as f64);
    clamped as u64
}

#[derive(Debug, Deserialize)]
struct PolarListResponse<T> {
    #[serde(default)]
    items: Option<Vec<T>>,
}

/// A provider value the source would have written into a URL or identifier.
fn required(value: Option<String>, field: &'static str) -> Result<String, BillingError> {
    value
        .filter(|value| !value.is_empty())
        .ok_or(BillingError::ProviderResponse(field))
}

/// `CheckoutCreateRequest`.
#[derive(Debug, Clone, Copy)]
pub struct CheckoutCreateRequest<'a> {
    pub user: BillingUser<'a>,
    pub target_plan: PaidPlanTier,
    pub action: Option<BillingAction>,
    pub promo_code: Option<&'a str>,
    pub success_url: Option<&'a str>,
    pub return_url: Option<&'a str>,
    pub referral_code: Option<&'a str>,
}

/// `CreditPackCheckoutRequest`.
#[derive(Debug, Clone, Copy)]
pub struct CreditPackCheckoutRequest<'a> {
    pub user: BillingUser<'a>,
    pub product_id: &'a str,
    pub success_url: Option<&'a str>,
    pub return_url: Option<&'a str>,
}

/// `CreatePortalSessionRequest`.
#[derive(Debug, Clone, Copy)]
pub struct PortalSessionRequest<'a> {
    pub user: BillingUser<'a>,
    pub return_url: Option<&'a str>,
}

/// A checkout was retried without `customer_id` after Polar's 422. The source
/// logs a warning; this typed notice is the explicit sink for that event.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckoutRetryNotice {
    pub user_id: String,
    pub customer_id: String,
    pub target_plan: PaidPlanTier,
    pub scenario: BillingScenario,
    pub provider_body: Option<String>,
}

/// Pooled-client service. Clones share the Polar connection pool and the Redis
/// multiplexed socket; construction performs no IO.
#[derive(Clone)]
pub struct BillingService {
    polar: PolarClient,
    cache: Option<ConnectionManager>,
    config: BillingConfig,
    clock: Option<SystemTime>,
    retry_notice: Option<Arc<dyn Fn(&CheckoutRetryNotice) + Send + Sync>>,
}

impl fmt::Debug for BillingService {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BillingService")
            .field("polar_policy", &self.polar.policy())
            .field("cache_configured", &self.cache.is_some())
            .field("config", &self.config)
            .field("fixed_clock", &self.clock)
            .finish()
    }
}

impl BillingService {
    /// No network, Redis, or environment work. The client must use the Billing
    /// policy so provider error bodies stay available for 422 handling.
    pub fn new(polar: PolarClient, cache: Option<ConnectionManager>, config: BillingConfig) -> Self {
        Self {
            polar,
            cache,
            config,
            clock: None,
            retry_notice: None,
        }
    }

    /// Explicit environment loading: `POLARSH_*` for the client and the billing
    /// redirect/discount names for [`BillingConfig`]. Redis is not opened; call
    /// [`Self::with_default_cache`] for the shared process client.
    pub fn from_env() -> Result<Self, BillingError> {
        let polar = PolarClient::from_env(PolarPolicy::Billing)?;
        Ok(Self::new(polar, None, BillingConfig::from_env()))
    }

    /// Opens the shared Dragonfly manager lazily; this is an async initializer,
    /// not part of construction.
    pub async fn with_default_cache(mut self) -> Result<Self, BillingError> {
        self.cache = Some(
            super::redis::get_redis_client()
                .await
                .map_err(|error| BillingError::Cache(error.to_string()))?,
        );
        Ok(self)
    }

    /// Fixture clock for deterministic idempotency keys and cache TTLs.
    pub fn with_fixed_clock(mut self, now: SystemTime) -> Self {
        self.clock = Some(now);
        self
    }

    /// Installs the explicit warning sink for the 422 `customer_id` retry.
    pub fn with_checkout_retry_notice(
        mut self,
        sink: Arc<dyn Fn(&CheckoutRetryNotice) + Send + Sync>,
    ) -> Self {
        self.retry_notice = Some(sink);
        self
    }

    pub fn config(&self) -> &BillingConfig {
        &self.config
    }

    fn now_millis(&self) -> f64 {
        self.clock.map(system_millis).unwrap_or_else(|| system_millis(SystemTime::now()))
    }

    fn now_date(&self) -> JsDate {
        JsDate::from_millis(self.now_millis())
    }

    fn no_headers() -> HeaderMap {
        HeaderMap::new()
    }

    fn idempotency_headers(key: &str) -> Result<HeaderMap, BillingError> {
        let value = HeaderValue::from_str(key)
            .map_err(|_| BillingError::ProviderResponse("Idempotency-Key"))?;
        let mut headers = HeaderMap::new();
        headers.insert("idempotency-key", value);
        Ok(headers)
    }

    // --- cache -----------------------------------------------------------

    async fn cache_get(&self, key: &str) -> Result<Option<String>, BillingError> {
        let Some(connection) = self.cache.clone() else {
            return Err(BillingError::Cache("cache is not configured".into()));
        };
        let mut connection = connection;
        redis::cmd("GET")
            .arg(key)
            .query_async(&mut connection)
            .await
            .map_err(|error| BillingError::Cache(error.to_string()))
    }

    async fn cache_set_ex(&self, key: &str, value: &str, ttl: u64) -> Result<(), BillingError> {
        let Some(connection) = self.cache.clone() else {
            return Err(BillingError::Cache("cache is not configured".into()));
        };
        let mut connection = connection;
        redis::cmd("SET")
            .arg(key)
            .arg(value)
            .arg("EX")
            .arg(ttl)
            .query_async::<()>(&mut connection)
            .await
            .map_err(|error| BillingError::Cache(error.to_string()))
    }

    /// `getCachedCreditPackBillingContext`.
    async fn get_cached_context(&self, customer_id: &str) -> Degraded<Option<CachedBillingContext>> {
        let key = credit_pack_billing_context_cache_key(customer_id);
        let raw = match self.cache_get(&key).await {
            Ok(raw) => raw,
            Err(_) => return Degraded::degraded(None, DegradeReason::CacheUnavailable),
        };
        let Some(raw) = raw else {
            return Degraded::ok(None);
        };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            return Degraded::degraded(None, DegradeReason::MalformedCache);
        };
        match valid_cached_billing_context(&value, self.now_millis()) {
            Some(context) => Degraded::ok(Some(context)),
            None => Degraded::degraded(None, DegradeReason::MalformedCache),
        }
    }

    /// `cacheCreditPackBillingContext`. Returns whether the write was stored.
    async fn cache_context(
        &self,
        customer_id: &str,
        plan_tier: PlanTier,
        expires_at: Option<&str>,
    ) -> Degraded<bool> {
        let normalized = valid_cached_billing_context(
            &json!({
                "version": CREDIT_PACK_BILLING_CONTEXT_CACHE_VERSION,
                "planTier": plan_tier_name(plan_tier),
                "expiresAt": expires_at,
            }),
            self.now_millis(),
        );
        let Some(normalized) = normalized else {
            return Degraded::ok(false);
        };
        let ttl = cache_ttl_seconds(&normalized, self.now_millis());
        let payload = CreditPackBillingContextCacheValue {
            version: normalized.version,
            plan_tier: plan_tier_name(normalized.plan_tier),
            expires_at: normalized.expires_at.clone(),
        };
        let Ok(serialized) = serde_json::to_string(&payload) else {
            return Degraded::degraded(false, DegradeReason::CacheUnavailable);
        };
        match self
            .cache_set_ex(
                &credit_pack_billing_context_cache_key(customer_id),
                &serialized,
                ttl,
            )
            .await
        {
            Ok(()) => Degraded::ok(true),
            Err(_) => Degraded::degraded(false, DegradeReason::CacheUnavailable),
        }
    }

    // --- provider reads --------------------------------------------------

    async fn list_subscriptions(
        &self,
        customer_id: &str,
        active: Option<bool>,
    ) -> Result<Vec<PolarSubscription>, BillingError> {
        let mut query = format!(
            "/v1/subscriptions/?customer_id={}&limit=100",
            form_component(customer_id)
        );
        if let Some(active) = active {
            // `String(true)` / `String(false)`.
            query.push_str(if active { "&active=true" } else { "&active=false" });
        }
        let response: PolarListResponse<PolarSubscription> = self
            .polar
            .request_json(Method::GET, &query, None, &Self::no_headers())
            .await?;
        Ok(response.items.unwrap_or_default())
    }

    async fn list_credit_pack_products(&self) -> Result<Vec<PolarCreditPackProduct>, BillingError> {
        let response: PolarListResponse<PolarCreditPackProduct> = self
            .polar
            .request_json(
                Method::GET,
                "/v1/products/?limit=100",
                None,
                &Self::no_headers(),
            )
            .await?;
        Ok(response.items.unwrap_or_default())
    }

    /// `getProductBaseAmount`: the source returns 0 on any failure.
    async fn get_product_base_amount(&self, product_id: &str) -> Degraded<f64> {
        let result: Result<Value, PolarError> = self
            .polar
            .request_json(
                Method::GET,
                &format!("/v1/products/{product_id}/"),
                None,
                &Self::no_headers(),
            )
            .await;
        match result {
            Ok(product) => {
                let mut best = 0.0;
                if let Some(prices) = product.get("prices").and_then(Value::as_array) {
                    for price in prices {
                        let amount = extract_price_amount_cents(price);
                        if amount > best {
                            best = amount;
                        }
                    }
                }
                Degraded::ok(best)
            }
            Err(error) => Degraded::degraded(0.0, DegradeReason::Polar(error)),
        }
    }

    /// `getDiscountById`: the source returns `null` on any failure or blank id.
    async fn get_discount_by_id(&self, discount_id: Option<&str>) -> Degraded<Option<DiscountLike>> {
        let Some(discount_id) = discount_id.filter(|value| !value.is_empty()) else {
            return Degraded::ok(None);
        };
        let result: Result<DiscountLike, PolarError> = self
            .polar
            .request_json(
                Method::GET,
                &format!("/v1/discounts/{discount_id}/"),
                None,
                &Self::no_headers(),
            )
            .await;
        match result {
            Ok(discount) => Degraded::ok(Some(discount)),
            Err(error) => Degraded::degraded(None, DegradeReason::Polar(error)),
        }
    }

    /// `findDiscountByPromoCode`. Provider failures propagate, unlike the
    /// by-id lookup.
    async fn find_discount_by_promo_code(
        &self,
        code: &str,
        product_id: &str,
    ) -> Result<Option<DiscountLike>, BillingError> {
        let query_code = code.trim().to_lowercase();
        if query_code.is_empty() {
            return Ok(None);
        }
        let path = format!(
            "/v1/discounts/?query={}&limit=100",
            form_component(&query_code)
        );
        let response: PolarListResponse<DiscountLike> = self
            .polar
            .request_json(Method::GET, &path, None, &Self::no_headers())
            .await?;
        let discount = response
            .items
            .unwrap_or_default()
            .into_iter()
            .find(|item| item.code.as_deref().map(str::to_lowercase) == Some(query_code.clone()));
        Ok(discount.filter(|discount| is_discount_applicable_to_product(discount, product_id)))
    }

    // --- public operations ----------------------------------------------

    /// `getBillingContext`.
    pub async fn get_billing_context(
        &self,
        user: &BillingUser<'_>,
        target_plan: Option<PaidPlanTier>,
        requested_action: BillingAction,
    ) -> Result<BillingContext, BillingError> {
        let inactivity_months = match user.last_activity_date() {
            Some(last_activity) => diff_months(last_activity, self.now_date()),
            None => WINBACK_MONTHS + 1.0,
        };
        let is_winback_eligible = inactivity_months >= WINBACK_MONTHS;
        let requested_target = target_plan;
        let target_plan = target_plan.unwrap_or(PaidPlanTier::Premium);

        let Some(customer_id) = user.customer_id() else {
            return Ok(BillingContext {
                plan_tier: user.plan_tier,
                has_active_subscription: false,
                has_any_subscription_history: false,
                inactivity_months,
                is_winback_eligible,
                scenario: infer_scenario(
                    requested_action,
                    false,
                    target_plan,
                    user.plan_tier,
                    is_winback_eligible,
                    false,
                ),
                active_subscription_id: None,
                active_product_id: None,
                target_product_id: requested_target.map(|plan| plan.product_id().to_owned()),
                is_referral_eligible: user.referral_code_used,
            });
        };

        let (active_subscriptions, all_subscriptions) = tokio::try_join!(
            self.list_subscriptions(customer_id, Some(true)),
            self.list_subscriptions(customer_id, None)
        )?;

        let active_subscription = get_paid_subscription_from_subscriptions(&active_subscriptions)
            .map(|(_, subscription)| subscription)
            .or_else(|| {
                active_subscriptions
                    .iter()
                    .find(|subscription| {
                        subscription.product_id.as_deref() == Some(PLAN_PRODUCT_ID_FREE)
                    })
            });
        let has_active_subscription = active_subscription.is_some();
        let has_any_subscription_history = !all_subscriptions.is_empty();
        let is_referral_eligible = user.referral_code_used && !has_any_subscription_history;
        let active_product_id = active_subscription.and_then(|s| s.product_id.clone());
        let current_plan = get_current_plan_from_active_subscription(
            user.plan_tier,
            active_product_id.as_deref(),
        );
        let scenario = infer_scenario(
            requested_action,
            has_active_subscription,
            target_plan,
            current_plan,
            is_winback_eligible,
            has_any_subscription_history,
        );
        Ok(BillingContext {
            plan_tier: current_plan,
            has_active_subscription,
            has_any_subscription_history,
            inactivity_months,
            is_winback_eligible,
            scenario,
            active_subscription_id: active_subscription.map(|s| s.id.clone()),
            active_product_id,
            target_product_id: requested_target.map(|plan| plan.product_id().to_owned()),
            is_referral_eligible,
        })
    }

    /// `getCreditPackCatalog`.
    pub async fn get_credit_pack_catalog(
        &self,
        user: &BillingUser<'_>,
    ) -> Result<CreditPackCatalog, BillingError> {
        let customer_id = user.customer_id();
        let (products, cached_context) = tokio::try_join!(
            self.list_credit_pack_products(),
            async {
                match customer_id {
                    Some(customer_id) => Ok::<_, BillingError>(self.get_cached_context(customer_id).await),
                    None => Ok(Degraded::ok(None)),
                }
            }
        )?;

        let mut paid_plan = cached_context
            .value
            .as_ref()
            .and_then(|context| PaidPlanTier::from_plan_tier(context.plan_tier));
        let mut recharge_expiry = cached_context
            .value
            .as_ref()
            .and_then(|context| context.expires_at.as_deref())
            .and_then(|expires_at| {
                credit_packs::get_recharge_expiry(
                    &RechargeSubscriptionCycleLike {
                        current_period_end: Some(expires_at),
                        ends_at: None,
                    },
                    self.now_date(),
                )
            });

        if cached_context.value.is_none() {
            if let Some(customer_id) = customer_id {
                let active_subscriptions =
                    self.list_subscriptions(customer_id, Some(true)).await?;
                let paid_subscription =
                    get_paid_subscription_from_subscriptions(&active_subscriptions);
                paid_plan = paid_subscription.map(|(plan, _)| plan);
                recharge_expiry = paid_subscription.and_then(|(_, subscription)| {
                    credit_packs::get_recharge_expiry(
                        &RechargeSubscriptionCycleLike {
                            current_period_end: subscription.current_period_end.as_deref(),
                            ends_at: subscription.ends_at.as_deref(),
                        },
                        self.now_date(),
                    )
                });
                let _ = self
                    .cache_context(
                        customer_id,
                        paid_plan.map_or(PlanTier::Free, PaidPlanTier::plan_tier),
                        recharge_expiry.as_ref().map(|expiry| expiry.expires_at.as_str()),
                    )
                    .await;
            }
        }

        let offers = credit_packs::build_credit_pack_offers(
            &products,
            AI_CREDITS_METER_ID,
            paid_plan.is_some(),
        )?;
        Ok(CreditPackCatalog {
            plan_tier: paid_plan.map_or(PlanTier::Free, PaidPlanTier::plan_tier),
            has_active_paid_subscription: paid_plan.is_some(),
            recharge_expires_at: recharge_expiry.as_ref().map(|expiry| expiry.expires_at.clone()),
            recharge_expiry_days: recharge_expiry.as_ref().map(|expiry| expiry.days_remaining),
            offers,
        })
    }

    /// `createCreditPackCheckout`.
    pub async fn create_credit_pack_checkout(
        &self,
        request: &CreditPackCheckoutRequest<'_>,
    ) -> Result<CreditPackCheckoutDecision, BillingError> {
        let definition = credit_packs::get_credit_pack_definition(request.product_id)
            .ok_or_else(CreditPackRequestError::invalid_product)?;
        let catalog = self.get_credit_pack_catalog(&request.user).await?;
        let offer = catalog
            .offers
            .iter()
            .find(|offer| offer.id == request.product_id)
            .cloned()
            .ok_or_else(|| {
                CreditPackConfigurationError(format!(
                    "Polar credit pack {} is unavailable",
                    request.product_id
                ))
            })?;
        if !offer.eligible {
            return Err(CreditPackRequestError::paid_plan_required().into());
        }

        let success_url = sanitize_redirect_url(
            &self.config,
            request.success_url,
            DefaultUrl::Success,
        );
        let return_url =
            sanitize_redirect_url(&self.config, request.return_url, DefaultUrl::Return);
        let idempotency_key = format!(
            "credit-pack:{}:{}:{}",
            request.user.id,
            request.product_id,
            self.now_millis()
        );
        let metadata = credit_pack_metadata(definition, &offer, request.user.id);
        let payload = credit_pack_checkout_payload(
            request,
            success_url.as_deref(),
            return_url.as_deref(),
            &metadata,
        );
        let checkout = self
            .create_pack_checkout(&payload, &idempotency_key)
            .await?;
        Ok(CreditPackCheckoutDecision {
            checkout_id: checkout.0,
            checkout_url: checkout.1,
            offer,
        })
    }

    /// `createBillingCheckout`.
    pub async fn create_billing_checkout(
        &self,
        request: &CheckoutCreateRequest<'_>,
    ) -> Result<CheckoutDecision, BillingError> {
        let action = request.action.unwrap_or(BillingAction::Auto);
        let context = self
            .get_billing_context(&request.user, Some(request.target_plan), action)
            .await?;
        if context.scenario == BillingScenario::ActiveNoChange {
            return Err(BillingError::AlreadySubscribed);
        }

        if plan_checkout_flow(context.active_product_id.as_deref()) == CheckoutFlow::CustomerPortal {
            // Paid-to-paid changes require Polar's subscription change
            // confirmation. Never fall back to a new purchase if this fails.
            let session = self
                .create_customer_portal_session(&PortalSessionRequest {
                    user: request.user,
                    return_url: request.return_url,
                })
                .await?;
            return Ok(CheckoutDecision {
                flow: CheckoutFlow::CustomerPortal,
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

        let target_product_id = request.target_plan.product_id();
        let mut candidates: Vec<DiscountCandidate> = Vec::new();
        if context.is_referral_eligible {
            if let Some(referral_discount_id) = self.config.referral_discount_id.as_deref() {
                if let Some(discount) = self
                    .get_discount_by_id(Some(referral_discount_id))
                    .await
                    .value
                {
                    if is_discount_applicable_to_product(&discount, target_product_id) {
                        candidates.push(DiscountCandidate {
                            reason: DiscountReason::Referral,
                            discount,
                        });
                    }
                }
            }
        }
        if let Some(promo_code) = request.promo_code.filter(|code| !code.is_empty()) {
            let promo_discount = self
                .find_discount_by_promo_code(promo_code, target_product_id)
                .await?;
            let Some(promo_discount) = promo_discount else {
                return Err(BillingError::InvalidPromoCode);
            };
            candidates.push(DiscountCandidate {
                reason: DiscountReason::Promo,
                discount: promo_discount,
            });
        }
        if let Some(scenario_discount_id) = self.config.discount_for_scenario(context.scenario) {
            if let Some(discount) = self
                .get_discount_by_id(Some(scenario_discount_id))
                .await
                .value
            {
                if is_discount_applicable_to_product(&discount, target_product_id) {
                    if let Some(reason) = scenario_discount_reason(context.scenario) {
                        candidates.push(DiscountCandidate { reason, discount });
                    }
                }
            }
        }

        let product_base_amount = self.get_product_base_amount(target_product_id).await.value;
        let best_discount = select_best_discount(&candidates, product_base_amount).cloned();
        let success_url =
            sanitize_redirect_url(&self.config, request.success_url, DefaultUrl::Success);
        let return_url =
            sanitize_redirect_url(&self.config, request.return_url, DefaultUrl::Return);
        let allow_discount_codes = if matches!(
            context.scenario,
            BillingScenario::Upgrade | BillingScenario::Change
        ) {
            false
        } else {
            best_discount.is_none()
        };
        let idempotency_key = format!(
            "billing:{}:{}:{}:{}",
            request.user.id,
            request.target_plan,
            context.scenario,
            self.now_millis()
        );
        let metadata = billing_metadata(
            &context,
            request.target_plan,
            request.user.id,
            best_discount.as_ref(),
        );
        let payload = billing_checkout_payload(
            request,
            &context,
            success_url.as_deref(),
            return_url.as_deref(),
            allow_discount_codes,
            best_discount.as_ref(),
            metadata,
        );

        let requires_customer_retry = payload
            .get("customer_id")
            .and_then(Value::as_str)
            .is_some_and(|customer_id| !customer_id.is_empty());
        let (checkout_id, checkout_url) = match self
            .post_checkout(&payload, &idempotency_key)
            .await
        {
            Ok(checkout) => checkout,
            Err(error) => {
                if provider_status(&error) != Some(422) || !requires_customer_retry {
                    return Err(error);
                }
                if let Some(sink) = &self.retry_notice {
                    sink(&CheckoutRetryNotice {
                        user_id: request.user.id.to_owned(),
                        customer_id: payload
                            .get("customer_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        target_plan: request.target_plan,
                        scenario: context.scenario,
                        provider_body: match &error {
                            BillingError::Polar(polar) => polar.billing_body().map(str::to_owned),
                            _ => None,
                        },
                    });
                }
                self.post_checkout(&without_customer_id(&payload), &idempotency_key)
                    .await?
            }
        };

        Ok(CheckoutDecision {
            flow: CheckoutFlow::Checkout,
            scenario: context.scenario,
            selected_discount_id: best_discount
                .as_ref()
                .map(|candidate| candidate.discount.id.clone())
                .filter(|id| !id.is_empty()),
            selected_discount_code: best_discount
                .as_ref()
                .and_then(|candidate| candidate.discount.code.clone())
                .filter(|code| !code.is_empty()),
            selected_discount_reason: best_discount.as_ref().map(|candidate| candidate.reason),
            checkout_id: Some(checkout_id),
            portal_session_id: None,
            checkout_url,
            allow_discount_codes,
        })
    }

    /// `createCustomerPortalSession`.
    pub async fn create_customer_portal_session(
        &self,
        request: &PortalSessionRequest<'_>,
    ) -> Result<PortalSessionResponse, BillingError> {
        let customer_id = request
            .user
            .customer_id()
            .ok_or(BillingError::CustomerMissingPolarId)?;
        let return_url =
            sanitize_redirect_url(&self.config, request.return_url, DefaultUrl::PortalReturn);
        let payload = portal_session_payload(customer_id, return_url.as_deref());
        let session: Value = self
            .polar
            .request_json(
                Method::POST,
                "/v1/customer-sessions/",
                Some(&payload),
                &Self::no_headers(),
            )
            .await?;
        portal_session_from_response(&session)
    }

    /// Shared `POST /v1/checkouts/` used by both checkout flows.
    async fn post_checkout(
        &self,
        payload: &Value,
        idempotency_key: &str,
    ) -> Result<(String, String), BillingError> {
        let headers = Self::idempotency_headers(idempotency_key)?;
        let checkout: Value = self
            .polar
            .request_json(Method::POST, "/v1/checkouts/", Some(payload), &headers)
            .await?;
        Ok((
            required(
                checkout.get("id").and_then(Value::as_str).map(str::to_owned),
                "id",
            )?,
            required(
                checkout
                    .get("url")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                "url",
            )?,
        ))
    }

    /// Credit-pack path: a 422 with a customer id retries once without it.
    async fn create_pack_checkout(
        &self,
        payload: &Value,
        idempotency_key: &str,
    ) -> Result<(String, String), BillingError> {
        let error = match self.post_checkout(payload, idempotency_key).await {
            Ok(checkout) => return Ok(checkout),
            Err(error) => error,
        };
        let retryable = provider_status(&error) == Some(422)
            && payload.get("customer_id").and_then(Value::as_str).is_some();
        if !retryable {
            return Err(error);
        }
        let fallback = without_customer_id(payload);
        self.post_checkout(&fallback, idempotency_key).await
    }
}

fn provider_status(error: &BillingError) -> Option<u16> {
    match error {
        BillingError::Polar(error) => error.status(),
        _ => None,
    }
}

fn without_customer_id(payload: &Value) -> Value {
    let mut fallback = payload.clone();
    if let Some(object) = fallback.as_object_mut() {
        object.remove("customer_id");
    }
    fallback
}

/// The scenario-to-reason mapping inside `createBillingCheckout`.
fn scenario_discount_reason(scenario: BillingScenario) -> Option<DiscountReason> {
    match scenario {
        BillingScenario::ReturningWinback => Some(DiscountReason::Winback),
        BillingScenario::Upgrade => Some(DiscountReason::Upgrade),
        BillingScenario::Change => Some(DiscountReason::Change),
        _ => None,
    }
}

/// Application/x-www-form-urlencoded component encoding for query values.
fn form_component(value: &str) -> String {
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

fn metadata_value_str(value: &str) -> Option<Value> {
    Some(Value::String(value.to_owned()))
}

fn metadata_value_opt(value: Option<&str>) -> Option<Value> {
    value.map(|value| Value::String(value.to_owned()))
}

/// `compactMetadata({ source: 'dimabot_credit_store', ... })`.
fn credit_pack_metadata(
    definition: &CreditPackDefinition,
    offer: &CreditPackOffer,
    user_id: &str,
) -> Map<String, Value> {
    compact_metadata(&[
        ("source", metadata_value_str("dimabot_credit_store")),
        ("pack_type", metadata_value_str(definition.kind.as_str())),
        ("pack_size", metadata_value_str(definition.size.as_str())),
        ("credits", Some(Value::from(offer.credits))),
        ("rollover", Some(Value::Bool(offer.rollover))),
        ("user_id", metadata_value_str(user_id)),
    ])
}

/// `compactMetadata({ source: 'dimabot_billing', ... })`.
fn billing_metadata(
    context: &BillingContext,
    target_plan: PaidPlanTier,
    user_id: &str,
    best_discount: Option<&DiscountCandidate>,
) -> Map<String, Value> {
    compact_metadata(&[
        ("source", metadata_value_str("dimabot_billing")),
        ("scenario", metadata_value_str(context.scenario.as_str())),
        ("target_plan", metadata_value_str(target_plan.as_str())),
        ("current_plan", metadata_value_str(plan_tier_name(context.plan_tier))),
        (
            "inactivity_months",
            Some(Value::from(context.inactivity_months)),
        ),
        (
            "selected_discount_reason",
            metadata_value_opt(best_discount.map(|candidate| candidate.reason.as_str())),
        ),
        (
            "selected_discount_code",
            metadata_value_opt(
                best_discount
                    .and_then(|candidate| candidate.discount.code.as_deref())
                    .filter(|code| !code.is_empty()),
            ),
        ),
        ("user_id", metadata_value_str(user_id)),
    ])
}

/// The `creditPackCheckoutPayload` object.
fn credit_pack_checkout_payload(
    request: &CreditPackCheckoutRequest<'_>,
    success_url: Option<&str>,
    return_url: Option<&str>,
    metadata: &Map<String, Value>,
) -> Value {
    let mut payload = Map::new();
    payload.insert("products".into(), json!([request.product_id]));
    if let Some(customer_id) = valid_customer_id(request.user.customer_id()) {
        payload.insert("customer_id".into(), Value::String(customer_id.to_owned()));
    }
    payload.insert(
        "external_customer_id".into(),
        Value::String(request.user.id.to_owned()),
    );
    if let Some(email) = request.user.email {
        payload.insert("customer_email".into(), Value::String(email.to_owned()));
    }
    if let Some(name) = request.user.name {
        payload.insert("customer_name".into(), Value::String(name.to_owned()));
    }
    payload.insert("allow_discount_codes".into(), Value::Bool(false));
    payload.insert("metadata".into(), Value::Object(metadata.clone()));
    if let Some(success_url) = success_url {
        payload.insert("success_url".into(), Value::String(success_url.to_owned()));
    }
    if let Some(return_url) = return_url {
        payload.insert("return_url".into(), Value::String(return_url.to_owned()));
    }
    Value::Object(payload)
}

/// The `checkoutPayload` object of `createBillingCheckout`.
fn billing_checkout_payload(
    request: &CheckoutCreateRequest<'_>,
    context: &BillingContext,
    success_url: Option<&str>,
    return_url: Option<&str>,
    allow_discount_codes: bool,
    best_discount: Option<&DiscountCandidate>,
    metadata: Map<String, Value>,
) -> Value {
    let mut payload = Map::new();
    payload.insert(
        "products".into(),
        json!([request.target_plan.product_id()]),
    );
    if context.active_product_id.as_deref() == Some(PLAN_PRODUCT_ID_FREE) {
        if let Some(subscription_id) = context.active_subscription_id.as_deref() {
            payload.insert(
                "subscription_id".into(),
                Value::String(subscription_id.to_owned()),
            );
        }
    }
    if let Some(customer_id) = valid_customer_id(request.user.customer_id()) {
        payload.insert("customer_id".into(), Value::String(customer_id.to_owned()));
    }
    payload.insert(
        "external_customer_id".into(),
        Value::String(request.user.id.to_owned()),
    );
    if let Some(email) = request.user.email {
        payload.insert("customer_email".into(), Value::String(email.to_owned()));
    }
    if let Some(name) = request.user.name {
        payload.insert("customer_name".into(), Value::String(name.to_owned()));
    }
    payload.insert(
        "allow_discount_codes".into(),
        Value::Bool(allow_discount_codes),
    );
    if let Some(discount_id) = best_discount
        .map(|candidate| candidate.discount.id.as_str())
        .filter(|id| !id.is_empty())
    {
        payload.insert("discount_id".into(), Value::String(discount_id.to_owned()));
    }
    payload.insert("metadata".into(), Value::Object(metadata));
    if let Some(success_url) = success_url {
        payload.insert("success_url".into(), Value::String(success_url.to_owned()));
    }
    if let Some(return_url) = return_url {
        payload.insert("return_url".into(), Value::String(return_url.to_owned()));
    }
    Value::Object(payload)
}

/// The `customer-sessions` request body.
pub fn portal_session_payload(customer_id: &str, return_url: Option<&str>) -> Value {
    let mut payload = Map::new();
    payload.insert(
        "customer_id".into(),
        Value::String(customer_id.to_owned()),
    );
    if let Some(return_url) = return_url {
        payload.insert("return_url".into(), Value::String(return_url.to_owned()));
    }
    Value::Object(payload)
}

/// Maps `{ id, customer_portal_url, expires_at }` onto the typed response.
pub fn portal_session_from_response(session: &Value) -> Result<PortalSessionResponse, BillingError> {
    Ok(PortalSessionResponse {
        session_id: required(
            session.get("id").and_then(Value::as_str).map(str::to_owned),
            "id",
        )?,
        url: required(
            session
                .get("customer_portal_url")
                .and_then(Value::as_str)
                .map(str::to_owned),
            "customer_portal_url",
        )?,
        expires_at: session
            .get("expires_at")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
    })
}

/// `isUuidV4`. Trimmed, lowercase or uppercase, version nibble `4` and the
/// RFC 4122 variant nibble.
pub fn is_uuid_v4(value: Option<&str>) -> bool {
    let Some(value) = value else { return false };
    let bytes = value.trim().as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => *byte == b'4',
            19 => matches!(*byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
            _ => byte.is_ascii_hexdigit(),
        })
}

fn valid_customer_id(customer_id: Option<&str>) -> Option<&str> {
    customer_id.filter(|value| is_uuid_v4(Some(*value)))
}
