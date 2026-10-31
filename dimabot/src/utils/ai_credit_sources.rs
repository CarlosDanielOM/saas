//! Reporting-only Polar credit-source classification.
//!
//! Source contract: `dimabot/src/utils/ai_credit_sources.ts`
//! (`CreditSourceEvent`, `CreditGrant`, `CreditOrder`, `CreditSourceReads`,
//! `polarCreditSourceReads`, `CREDIT_SOURCE_MATCH_MS`,
//! `classifyPolarCreditSources`).
//!
//! Preserved behaviour: Polar's public credit events carry no grant or order id,
//! so a `meter.credited` event is attributed only by a unique correlation with a
//! `benefit.granted`/`benefit.cycled` meter-credit event that follows it within
//! [`CREDIT_SOURCE_MATCH_MS`], verified against the customer's grant (id,
//! customer, benefit id/type/meter), the rollover flag, the exact unit count for
//! non-subscription grants, and then the paid order. Classification never uses
//! rollover, plan, amount or order proximity alone.
//!
//! The reads are strictly reporting: nothing here creates a grant, ingests a
//! balance change, or mutates a meter. HTTP uses the Gift policy of
//! `utils::polar`, matching the source's `giftPolarRequest` (15-second total
//! timeout, redirect rejection, body-free errors).
//!
//! Deliberately NOT here: the Polar events SDK client/ingestion path, the plan
//! cache, MongoDB, or any second HTTP client. Provider reads are injected through
//! [`CreditSourceReads`] so classification stays pure logic.

use super::{
    ai_credit_projection::AI_CREDITS_METER_ID,
    credit_gift_provider::{encode_uri_component, GIFT_PACK_PAIRS},
    credit_packs::get_credit_pack_definition,
    js_date::parse_date,
    polar::{PolarClient, PolarError, PolarPolicy},
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::{collections::BTreeMap, fmt};

/// `CREDIT_SOURCE_MATCH_MS`: the benefit event must follow the credit within
/// this window.
pub const CREDIT_SOURCE_MATCH_MS: i64 = 5_000;

/// The three classifications the source can produce.
pub const SUBSCRIPTION_CREDITS: &str = "subscription_credits";
pub const GIFTED_CREDITS: &str = "gifted_credits";
pub const PURCHASED_PACK: &str = "purchased_pack";

/// `event.timestamp`: a `Date` yields its millis, anything else is stringified
/// and parsed by `Date.parse`. An invalid `Date` is represented by
/// [`EventTimestamp::Text`] with an unparseable value.
#[derive(Debug, Clone, PartialEq)]
pub enum EventTimestamp {
    /// Source `timestamp instanceof Date` (`getTime()`).
    Date(i64),
    /// Source `String(timestamp || '')` fed to `new Date(...)`.
    Text(String),
}

impl EventTimestamp {
    /// `at(event)`; `None` stands for the source's `NaN`.
    pub fn at(&self) -> Option<i64> {
        match self {
            Self::Date(millis) => Some(*millis),
            Self::Text(text) => parse_date(text),
        }
    }
}

impl From<i64> for EventTimestamp {
    fn from(millis: i64) -> Self {
        Self::Date(millis)
    }
}

impl From<&str> for EventTimestamp {
    fn from(text: &str) -> Self {
        Self::Text(text.to_owned())
    }
}

impl From<String> for EventTimestamp {
    fn from(text: String) -> Self {
        Self::Text(text)
    }
}

/// `CreditSourceEvent`. `metadata` is the SDK's free-form object.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CreditSourceEvent {
    pub id: Option<String>,
    pub name: Option<String>,
    pub timestamp: Option<EventTimestamp>,
    pub metadata: Option<Map<String, Value>>,
}

impl CreditSourceEvent {
    fn at(&self) -> Option<i64> {
        self.timestamp.as_ref().and_then(EventTimestamp::at)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct CreditGrantProperties {
    pub meter_id: Option<String>,
    pub units: Option<f64>,
    pub rollover: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct CreditGrantBenefit {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type", default)]
    pub benefit_type: String,
    #[serde(default)]
    pub properties: CreditGrantProperties,
}

/// `CreditGrant`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct CreditGrant {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub customer_id: String,
    #[serde(default)]
    pub benefit_id: String,
    pub order_id: Option<String>,
    pub subscription_id: Option<String>,
    #[serde(default)]
    pub benefit: CreditGrantBenefit,
}

/// `CreditOrder`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct CreditOrder {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub customer_id: String,
    #[serde(default)]
    pub product_id: String,
    pub subscription_id: Option<String>,
    #[serde(default)]
    pub paid: bool,
    #[serde(default)]
    pub total_amount: f64,
    pub metadata: Option<Map<String, Value>>,
}

/// `CreditSourceReads`, the injected reporting reads.
///
/// The reads are awaited in place by [`classify_polar_credit_sources`] and are
/// never spawned or boxed, so the trait does not need an explicit `Send` bound on
/// its returned futures.
#[allow(async_fn_in_trait)]
pub trait CreditSourceReads {
    /// `grant(id)`: `Ok(None)` where the source returns `null` (no such grant).
    async fn grant(&mut self, id: &str) -> Result<Option<CreditGrant>, CreditSourceError>;

    /// `order(id)`: the source propagates provider failures.
    async fn order(&mut self, id: &str) -> Result<CreditOrder, CreditSourceError>;
}

/// Typed classification failure.
#[derive(Debug, Clone, PartialEq)]
pub enum CreditSourceError {
    Transport(PolarError),
    /// The customer has more grant pages than the bounded scan allows.
    GrantHistoryTooLarge,
    WrongPolicy,
}

impl fmt::Display for CreditSourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(error) => error.fmt(f),
            Self::GrantHistoryTooLarge => f.write_str("Credit source grant history is too large"),
            Self::WrongPolicy => f.write_str("Credit source reads require the Gift Polar policy"),
        }
    }
}

impl std::error::Error for CreditSourceError {}

impl From<PolarError> for CreditSourceError {
    fn from(error: PolarError) -> Self {
        Self::Transport(error)
    }
}

/// `text(value)`: only `^[a-zA-Z0-9_-]+$` strings qualify as identifiers.
fn text(value: Option<&str>) -> Option<&str> {
    value.filter(|value| {
        !value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    })
}

/// `m.x ?? m.x_snake` — only a missing or `null` value falls through.
fn meta_value<'a>(metadata: Option<&'a Map<String, Value>>, keys: &[&str]) -> Option<&'a Value> {
    let metadata = metadata?;
    for key in keys {
        if let Some(value) = metadata.get(*key) {
            if !value.is_null() {
                return Some(value);
            }
        }
    }
    None
}

fn meta_text<'a>(metadata: Option<&'a Map<String, Value>>, keys: &[&str]) -> Option<&'a str> {
    meta_value(metadata, keys).and_then(Value::as_str)
}

fn meta_number(metadata: Option<&Map<String, Value>>, keys: &[&str]) -> Option<f64> {
    meta_value(metadata, keys).and_then(Value::as_f64)
}

fn meta_bool(metadata: Option<&Map<String, Value>>, keys: &[&str]) -> Option<bool> {
    meta_value(metadata, keys).and_then(Value::as_bool)
}

/// `classifyPolarCreditSources`.
pub async fn classify_polar_credit_sources<R: CreditSourceReads>(
    customer_id: &str,
    events: &[CreditSourceEvent],
    reads: &mut R,
) -> Result<BTreeMap<String, String>, CreditSourceError> {
    let credits: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, event)| event.name.as_deref() == Some("meter.credited") && text(event.id.as_deref()).is_some())
        .filter(|(_, event)| {
            meta_text(event.metadata.as_ref(), &["meterId", "meter_id"]) == Some(AI_CREDITS_METER_ID)
        })
        .filter(|(_, event)| {
            meta_number(event.metadata.as_ref(), &["units"])
                .is_some_and(|units| units.is_finite() && units > 0.0)
                && meta_bool(event.metadata.as_ref(), &["rollover"]).is_some()
                && event.at().is_some()
        })
        .map(|(index, _)| index)
        .collect();

    let benefits: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, event)| {
            matches!(
                event.name.as_deref(),
                Some("benefit.granted") | Some("benefit.cycled")
            )
        })
        .filter(|(_, event)| {
            meta_text(event.metadata.as_ref(), &["benefitType", "benefit_type"])
                == Some("meter_credit")
        })
        .filter(|(_, event)| {
            text(meta_text(
                event.metadata.as_ref(),
                &["benefitGrantId", "benefit_grant_id"],
            ))
            .is_some()
                && event.at().is_some()
        })
        .map(|(index, _)| index)
        .collect();

    let mut grants: BTreeMap<String, CreditGrant> = BTreeMap::new();
    let mut orders: BTreeMap<String, CreditOrder> = BTreeMap::new();
    let mut matches: Vec<(usize, usize, CreditGrant)> = Vec::new();

    for &benefit_index in &benefits {
        let benefit = &events[benefit_index];
        let Some(benefit_at) = benefit.at() else {
            continue;
        };
        let nearby: Vec<usize> = credits
            .iter()
            .copied()
            .filter(|&credit_index| {
                events[credit_index].at().is_some_and(|credit_at| {
                    benefit_at >= credit_at && benefit_at - credit_at <= CREDIT_SOURCE_MATCH_MS
                })
            })
            .collect();
        if nearby.is_empty() {
            continue;
        }
        let grant_id = text(meta_text(
            benefit.metadata.as_ref(),
            &["benefitGrantId", "benefit_grant_id"],
        ))
        .unwrap_or_default()
        .to_owned();
        let grant = match grants.get(&grant_id) {
            Some(grant) => grant.clone(),
            None => {
                let Some(found) = reads.grant(&grant_id).await? else {
                    continue;
                };
                grants.insert(grant_id.clone(), found.clone());
                found
            }
        };
        let benefit_id = meta_text(
            benefit.metadata.as_ref(),
            &["benefitId", "benefit_id"],
        );
        if grant.id != grant_id
            || grant.customer_id != customer_id
            || Some(grant.benefit_id.as_str()) != benefit_id
            || grant.benefit.id != grant.benefit_id
            || grant.benefit.benefit_type != "meter_credit"
            || grant.benefit.properties.meter_id.as_deref() != Some(AI_CREDITS_METER_ID)
        {
            continue;
        }
        for &credit_index in &nearby {
            let credit = &events[credit_index];
            // Subscription amounts can change after a historical cycle. One-time
            // purchases and gifts must match their grant's exact quantity.
            if meta_bool(credit.metadata.as_ref(), &["rollover"])
                != grant.benefit.properties.rollover
            {
                continue;
            }
            if grant.subscription_id.is_none()
                && meta_number(credit.metadata.as_ref(), &["units"])
                    != grant.benefit.properties.units
            {
                continue;
            }
            matches.push((credit_index, benefit_index, grant.clone()));
        }
    }

    let mut result: BTreeMap<String, String> = BTreeMap::new();
    for (credit_index, benefit_index, grant) in &matches {
        // Only a unique pair may be classified: one credit event and one
        // benefit event, never a guess between candidates.
        if matches
            .iter()
            .filter(|(credit, _, _)| credit == credit_index)
            .count()
            != 1
            || matches
                .iter()
                .filter(|(_, benefit, _)| benefit == benefit_index)
                .count()
                != 1
        {
            continue;
        }
        let credit_id = events[*credit_index]
            .id
            .clone()
            .unwrap_or_default();
        if grant.subscription_id.is_some() && grant.order_id.is_none() {
            result.insert(credit_id, SUBSCRIPTION_CREDITS.to_owned());
            continue;
        }
        let (Some(order_id), None) = (grant.order_id.as_deref(), grant.subscription_id.as_deref())
        else {
            continue;
        };
        if !orders.contains_key(order_id) {
            let order = reads.order(order_id).await?;
            orders.insert(order_id.to_owned(), order);
        }
        let Some(order) = orders.get(order_id) else {
            continue;
        };
        if order.id != order_id
            || order.customer_id != customer_id
            || !order.paid
            || order.subscription_id.is_some()
        {
            continue;
        }
        let metadata = order.metadata.as_ref();
        let source = meta_text(metadata, &["source"]);
        let gift_id = text(meta_text(metadata, &["gift_id"]));
        let gift_fulfillment = source == Some("dimabot_gift_fulfillment");
        if gift_fulfillment
            && gift_id.is_some()
            && GIFT_PACK_PAIRS
                .iter()
                .any(|pair| pair.fulfillment_product_id == order.product_id.as_str())
            && order.total_amount == 0.0
        {
            result.insert(credit_id, GIFTED_CREDITS.to_owned());
        } else if get_credit_pack_definition(&order.product_id).is_some() && !gift_fulfillment {
            result.insert(credit_id, PURCHASED_PACK.to_owned());
        }
    }
    Ok(result)
}

const GRANT_PAGES: u32 = 100;

/// The exact `GET /v1/benefit-grants/` query the source builds with
/// `URLSearchParams({ customer_id, limit: '100', page, sorting: '-created_at' })`,
/// including its parameter order.
pub fn grant_list_path(customer_id: &str, page: u32) -> String {
    format!(
        "/v1/benefit-grants/?customer_id={}&limit=100&page={page}&sorting=-created_at",
        encode_uri_component(customer_id)
    )
}

/// The exact `GET /v1/orders/{encodeURIComponent(id)}` path.
pub fn order_path(order_id: &str) -> String {
    format!("/v1/orders/{}", encode_uri_component(order_id))
}

#[derive(Debug, Default, Deserialize)]
struct GrantList {
    #[serde(default)]
    items: Vec<CreditGrant>,
    pagination: Option<GrantPagination>,
}

#[derive(Debug, Default, Deserialize)]
struct GrantPagination {
    max_page: Option<f64>,
}

/// `polarCreditSourceReads`: the concrete reporting reader. Construction performs
/// no IO; the customer's grant list is loaded at most once per instance and the
/// client must use [`PolarPolicy::Gift`].
pub struct PolarCreditSourceReads {
    polar: PolarClient,
    customer_id: String,
    grants: Option<BTreeMap<String, CreditGrant>>,
}

impl PolarCreditSourceReads {
    pub fn new(
        polar: PolarClient,
        customer_id: impl Into<String>,
    ) -> Result<Self, CreditSourceError> {
        if polar.policy() != PolarPolicy::Gift {
            return Err(CreditSourceError::WrongPolicy);
        }
        Ok(Self {
            polar,
            customer_id: customer_id.into(),
            grants: None,
        })
    }

    /// Explicit environment loading through the shared Gift transport.
    pub fn from_env(customer_id: impl Into<String>) -> Result<Self, CreditSourceError> {
        let polar = PolarClient::from_env(PolarPolicy::Gift)?;
        Self::new(polar, customer_id)
    }

    fn no_headers() -> reqwest::header::HeaderMap {
        reqwest::header::HeaderMap::new()
    }

    /// Bounded complete grant list; Polar exposes no get-by-id operation.
    async fn list_grants(&self) -> Result<BTreeMap<String, CreditGrant>, CreditSourceError> {
        let mut result = BTreeMap::new();
        for page in 1..=GRANT_PAGES {
            let path = grant_list_path(&self.customer_id, page);
            let response: GrantList = self
                .polar
                .request_json(Method::GET, &path, None, &Self::no_headers())
                .await?;
            let item_count = response.items.len();
            for grant in response.items {
                result.insert(grant.id.clone(), grant);
            }
            let finished = match response.pagination.and_then(|pagination| pagination.max_page) {
                Some(max_page) => f64::from(page) >= max_page,
                None => item_count < 100,
            };
            if finished {
                return Ok(result);
            }
        }
        Err(CreditSourceError::GrantHistoryTooLarge)
    }
}

impl CreditSourceReads for PolarCreditSourceReads {
    async fn grant(&mut self, id: &str) -> Result<Option<CreditGrant>, CreditSourceError> {
        if self.grants.is_none() {
            let grants = self.list_grants().await?;
            self.grants = Some(grants);
        }
        Ok(self.grants.as_ref().and_then(|grants| grants.get(id)).cloned())
    }

    async fn order(&mut self, id: &str) -> Result<CreditOrder, CreditSourceError> {
        let path = order_path(id);
        Ok(self
            .polar
            .request_json(Method::GET, &path, None, &Self::no_headers())
            .await?)
    }
}
