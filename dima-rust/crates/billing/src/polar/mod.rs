//! The Polar client: one provider on `dima-http`, every call the reference makes, no SDK.
//!
//! The reference reaches Polar three ways, and each call here keeps the one it used:
//!
//! | Profile | Reference | Headers sent | Timeout | Redirects |
//! |---|---|---|---|---|
//! | [`Profile::Fetch`] | `billing.ts` `polarRequest` | `authorization: Bearer`, `content-type: application/json` (also on `GET`), `user-agent: node` | none in the reference: the provider's 60 s | followed in the reference; an error here |
//! | [`Profile::Gift`] | `credit_gift_provider.ts` `giftPolarRequest` | the same | 15 s | an error, as in the reference |
//! | [`Profile::Sdk`] | `@polar-sh/sdk` 0.42.5 | `accept: application/json`, `authorization: Bearer`, `content-type` only with a body, `cookie:` (empty, as the SDK's `Request` carries it), the SDK's `user-agent` | 10 s for the entitlement calls, else none (60 s) | an error |
//!
//! No call retries (the SDK's `retryConfig` is `none` and `fetch` has none). Rules:
//!
//! - Paths are [`Path`] templates: ids are percent-encoded segments (the reference interpolates
//!   them raw; every id it passes is a UUID or an id of `[A-Za-z0-9_-]`, where both agree).
//! - Lists (subscriptions, products, discounts) are read to their end, page by page, within
//!   [`MAX_LIST_PAGES`]; past it the call fails with [`PolarError::IncompleteHistory`] rather
//!   than decide from a partial list (the reference read one page of 100). The first request
//!   is the reference's own; later ones add `page=N`.
//! - Responses tolerate fields Polar adds. Where the reference reads an answer loosely (product
//!   lists, the raw customer state, orders and grants of the credit-source report), the value is
//!   kept as JSON and read with the reference's own rules; where it reads it through the SDK's
//!   validation (entitlements, ingest), it is typed.
//! - Errors never carry the token, a response body (Polar echoes request fields there, a
//!   customer's e-mail among them; the reference put the body in its error message) or an id:
//!   paths are templates and the `customer_id`, `external_customer_id` and `query` parameters
//!   are redacted.
//! - A `POST` whose answer was lost, or whose success answer cannot be read
//!   ([`PolarError::outcome_unknown`]), may have been applied by Polar; callers reconcile, they
//!   never resend blindly (ingest relies on `external_id` deduplication, checkouts on the
//!   `Idempotency-Key`).

mod flows;
pub mod flush;
mod ingest;
mod types;

pub use flows::*;
pub use ingest::*;
pub use types::*;

use crate::config::PolarConfig;
use dima_core::SecretString;
use dima_http::{HttpClient, Method, Path, Provider, ProviderBuilder, RequestBuilder};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::time::Duration;

/// The provider's name (telemetry, the rig's mock).
pub const PROVIDER_NAME: &str = "polar";
/// The SDK's `user-agent`.
pub const SDK_USER_AGENT: &str = "speakeasy-sdk/typescript 0.42.5 2.801.0 0.1.0 @polar-sh/sdk";
/// `POLAR_ENTITLEMENT_REQUEST_OPTIONS.timeoutMs` (`polar_entitlements.ts`).
pub const ENTITLEMENT_TIMEOUT: Duration = Duration::from_secs(10);
/// `AbortSignal.timeout(15_000)` (`credit_gift_provider.ts`).
pub const GIFT_TIMEOUT: Duration = Duration::from_secs(15);

/// Pages of 100 a list is read to at most (subscriptions, products, discounts): 1,000 items,
/// far above any customer's history or the product catalog.
pub const MAX_LIST_PAGES: u32 = 10;
/// The page size the reference asks for (`limit=100`).
const LIST_PAGE_SIZE: usize = 100;

/// A list read to its end, keeping the reference's loose reading of the first page.
enum ListItems {
    /// `items` missing or `null`.
    Missing,
    /// `items` of the first page is not an array.
    NotArray(Value),
    /// Every page's items, in order.
    Items(Vec<Value>),
}

/// How the reference reached Polar for a call (see the module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    /// `polarRequest` in `billing.ts`.
    Fetch,
    /// `giftPolarRequest` in `credit_gift_provider.ts`.
    Gift,
    /// The SDK, with an explicit timeout or none.
    Sdk(Option<Duration>),
}

/// Why a Polar call failed. Never prints a token, a body or an id.
#[derive(Debug, thiserror::Error)]
pub enum PolarError {
    /// `POLARSH_OAT is not set`: nothing was sent.
    #[error("POLARSH_OAT is not set")]
    NotConfigured,
    /// The request was refused before it was sent (what the SDK's input validation refuses, or
    /// an id that cannot be a path segment).
    #[error("Polar request refused before sending: {0}")]
    InvalidInput(&'static str),
    /// Polar answered with a non-success status.
    #[error("Polar API error {status}")]
    Status {
        /// The status code.
        status: u16,
        /// Whether the call was a `POST` (Polar may have acted on it before failing).
        mutation: bool,
    },
    /// The connection, a timeout or the body read failed.
    #[error("Polar request failed: {source}")]
    Transport {
        /// The HTTP error (provider, method and path template only).
        #[source]
        source: dima_http::Error,
        /// Whether the call was a `POST` sent before it failed.
        mutation: bool,
    },
    /// A list has more pages than [`MAX_LIST_PAGES`]: deciding from what was read would decide
    /// from a partial history (item 6 of P2-BILLING-01b).
    #[error("Polar {what} list exceeds {MAX_LIST_PAGES} pages: incomplete history")]
    IncompleteHistory {
        /// Which list.
        what: &'static str,
    },
    /// The answer was not the JSON the call expects.
    #[error("Polar answered with an unexpected shape")]
    Decode {
        /// Whether the call was a `POST`: Polar answered success, so it may have applied it.
        mutation: bool,
    },
}

impl PolarError {
    /// The HTTP status, when Polar answered.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Status { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// A mutation whose effect at Polar is unknown: a `POST` that failed in transport after it
    /// may have been sent, one answered with a 5xx, or one answered with a success whose body
    /// cannot be read (Polar may have committed it; item 7 of P2-BILLING-01b).
    pub fn outcome_unknown(&self) -> bool {
        match self {
            Self::Transport { mutation, .. } => *mutation && !self.not_sent(),
            Self::Decode { mutation } => *mutation,
            Self::Status { status, mutation } => *mutation && *status >= 500,
            _ => false,
        }
    }

    /// Nothing reached Polar: refused before sending, no connection, or a wait for a
    /// connection slot that timed out.
    pub fn not_sent(&self) -> bool {
        use dima_http::{FailureClass, TimeoutKind};
        match self {
            Self::NotConfigured | Self::InvalidInput(_) => true,
            Self::Transport { source, .. } => matches!(
                source.class(),
                FailureClass::Connect
                    | FailureClass::Timeout(TimeoutKind::Queue | TimeoutKind::Connect)
                    | FailureClass::Blocked
                    | FailureClass::Invalid
                    | FailureClass::RequestTooLarge
            ),
            _ => false,
        }
    }
}

/// The client. Cheap to clone; construction does no I/O.
#[derive(Clone)]
pub struct PolarClient {
    http: HttpClient,
    provider: Provider,
    token: Option<SecretString>,
}

impl std::fmt::Debug for PolarClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PolarClient")
            .field("provider", &self.provider.name())
            .field("configured", &self.token.is_some())
            .finish()
    }
}

impl PolarClient {
    /// The provider declaration for the binary's registry: [`PolarConfig::declared_base_url`],
    /// redirects refused, no retries, the id-carrying query
    /// parameters redacted. A test-mode registry may override the base URL
    /// ([`PolarConfig::base_url_override`]).
    pub fn provider(config: &PolarConfig) -> ProviderBuilder {
        Provider::builder(PROVIDER_NAME, config.declared_base_url()).secret_query_params(&[
            "customer_id",
            "external_customer_id",
            "query",
        ])
    }

    /// A client over a built provider.
    pub fn new(http: HttpClient, provider: Provider, token: Option<SecretString>) -> Self {
        Self {
            http,
            provider,
            token: token.filter(|token| !token.is_empty()),
        }
    }

    /// Whether `POLARSH_OAT` is set.
    pub fn is_configured(&self) -> bool {
        self.token.is_some()
    }

    fn request(
        &self,
        method: Method,
        path: Path,
        profile: Profile,
        has_body: bool,
    ) -> Result<RequestBuilder<'_>, PolarError> {
        let token = self.token.as_ref().ok_or(PolarError::NotConfigured)?;
        let builder = self.http.request(&self.provider, method, path);
        Ok(match profile {
            Profile::Fetch | Profile::Gift => {
                let builder = builder
                    .bearer(token)
                    .header("content-type", "application/json")
                    .header("user-agent", "node")
                    .retry(dima_http::RetryPolicy::none());
                if profile == Profile::Gift {
                    builder.timeout(GIFT_TIMEOUT)
                } else {
                    builder
                }
            }
            Profile::Sdk(timeout) => {
                let builder = builder
                    .header("accept", "application/json")
                    .bearer(token)
                    .header("cookie", "")
                    .header("user-agent", SDK_USER_AGENT)
                    .retry(dima_http::RetryPolicy::none());
                let builder = if has_body {
                    builder.header("content-type", "application/json")
                } else {
                    builder
                };
                match timeout {
                    Some(timeout) => builder.timeout(timeout),
                    None => builder,
                }
            }
        })
    }

    async fn send<T: DeserializeOwned>(
        &self,
        builder: RequestBuilder<'_>,
        mutation: bool,
    ) -> Result<T, PolarError> {
        let response = builder
            .send()
            .await
            .map_err(|source| PolarError::Transport { source, mutation })?;
        let status = response.status();
        if !status.is_success() {
            // The body is drained by the drop; it is never kept.
            return Err(PolarError::Status {
                status: status.as_u16(),
                mutation,
            });
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|source| PolarError::Transport { source, mutation })?;
        serde_json::from_slice(&dima_text::sanitize_lone_surrogates(&bytes))
            .map_err(|_| PolarError::Decode { mutation })
    }

    async fn get<T: DeserializeOwned>(
        &self,
        path: Path,
        query: &[(&str, &str)],
        profile: Profile,
    ) -> Result<T, PolarError> {
        let mut builder = self.request(Method::GET, path, profile, false)?;
        if !query.is_empty() {
            builder = builder.query(query);
        }
        self.send(builder, false).await
    }

    async fn post<T: DeserializeOwned>(
        &self,
        path: Path,
        body: &Value,
        idempotency_key: Option<&str>,
        profile: Profile,
    ) -> Result<T, PolarError> {
        let mut builder = self.request(Method::POST, path, profile, true)?;
        if let Some(key) = idempotency_key {
            builder = builder.header("idempotency-key", key);
        }
        let builder = builder.json_js(body);
        self.send(builder, true).await
    }

    // ------------------------------------------------------------------ billing.ts (fetch)

    /// Reads a list to its end (item 6 of P2-BILLING-01b): the first request is the reference's
    /// own (no `page`), later ones add `page=2`, `page=3`... Polar's `pagination.max_page` says
    /// where it ends; without it, a page shorter than 100 items is the last. More than
    /// [`MAX_LIST_PAGES`] pages is [`PolarError::IncompleteHistory`]: the reference read the
    /// first page only and decided from it.
    async fn read_list(
        &self,
        path: &'static str,
        query: &[(&str, &str)],
        what: &'static str,
    ) -> Result<ListItems, PolarError> {
        let mut all = Vec::new();
        let mut page = 1_u32;
        loop {
            let number = page.to_string();
            let mut paged = query.to_vec();
            if page > 1 {
                paged.push(("page", &number));
            }
            let body: LoosePage = self.get(Path::fixed(path), &paged, Profile::Fetch).await?;
            let max_page = body.max_page();
            let items = match body.items {
                None | Some(Value::Null) if page == 1 => return Ok(ListItems::Missing),
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(items)) => items,
                Some(other) if page == 1 => return Ok(ListItems::NotArray(other)),
                Some(_) => return Err(PolarError::Decode { mutation: false }),
            };
            let count = items.len();
            all.extend(items);
            let last = match max_page {
                Some(max) => f64::from(page) >= max,
                None => count < LIST_PAGE_SIZE,
            };
            if last {
                return Ok(ListItems::Items(all));
            }
            if page >= MAX_LIST_PAGES || max_page.is_some_and(|max| max > f64::from(MAX_LIST_PAGES))
            {
                return Err(PolarError::IncompleteHistory { what });
            }
            page += 1;
        }
    }

    /// A list of typed items read to its end: missing items are none (`items || []`), anything
    /// else that is not an array, or an item of another shape, is [`PolarError::Decode`].
    async fn read_typed_list<T: DeserializeOwned>(
        &self,
        path: &'static str,
        query: &[(&str, &str)],
        what: &'static str,
    ) -> Result<Vec<T>, PolarError> {
        match self.read_list(path, query, what).await? {
            ListItems::Missing => Ok(Vec::new()),
            ListItems::NotArray(_) => Err(PolarError::Decode { mutation: false }),
            ListItems::Items(items) => items
                .into_iter()
                .map(|item| {
                    serde_json::from_value(item).map_err(|_| PolarError::Decode { mutation: false })
                })
                .collect(),
        }
    }

    /// `GET /v1/subscriptions/?customer_id=…&limit=100[&active=…]` (`listSubscriptions`), read
    /// to its end ([`MAX_LIST_PAGES`]).
    pub async fn list_subscriptions(
        &self,
        customer_id: &str,
        active: Option<bool>,
    ) -> Result<Vec<Subscription>, PolarError> {
        let active = active.map(|a| if a { "true" } else { "false" });
        let mut query = vec![("customer_id", customer_id), ("limit", "100")];
        if let Some(active) = active {
            query.push(("active", active));
        }
        self.read_typed_list("/v1/subscriptions/", &query, "subscription")
            .await
    }

    /// `GET /v1/products/?limit=100` (`getCreditPackCatalog`), read to its end: the items as
    /// Polar sent them; `None` when `items` is missing or `null` (`items || []`); a first page
    /// whose `items` is not an array is returned as it is (the catalog refuses it).
    pub async fn list_products(&self) -> Result<Option<Value>, PolarError> {
        Ok(
            match self
                .read_list("/v1/products/", &[("limit", "100")], "product")
                .await?
            {
                ListItems::Missing => None,
                ListItems::NotArray(value) => Some(value),
                ListItems::Items(items) => Some(Value::Array(items)),
            },
        )
    }

    /// `GET /v1/products/{id}/` (`getProductBaseAmount`).
    pub async fn get_product(&self, product_id: &str) -> Result<Value, PolarError> {
        let path = segment_path("/v1/products/{}/", product_id)?;
        self.get(path, &[], Profile::Fetch).await
    }

    /// `GET /v1/discounts/{id}/` (`getDiscountById`).
    pub async fn get_discount(&self, discount_id: &str) -> Result<Discount, PolarError> {
        let path = segment_path("/v1/discounts/{}/", discount_id)?;
        self.get(path, &[], Profile::Fetch).await
    }

    /// `GET /v1/discounts/?query=…&limit=100` (`findDiscountByPromoCode`), read to its end.
    pub async fn search_discounts(&self, query: &str) -> Result<Vec<Discount>, PolarError> {
        self.read_typed_list(
            "/v1/discounts/",
            &[("query", query), ("limit", "100")],
            "discount",
        )
        .await
    }

    /// `POST /v1/checkouts/` with an `Idempotency-Key` (`createBillingCheckout`,
    /// `createCreditPackCheckout`).
    pub async fn create_checkout(
        &self,
        body: &Value,
        idempotency_key: &str,
    ) -> Result<Checkout, PolarError> {
        self.post(
            Path::fixed("/v1/checkouts/"),
            body,
            Some(idempotency_key),
            Profile::Fetch,
        )
        .await
    }

    /// `POST /v1/customer-sessions/` (`createCustomerPortalSession`).
    pub async fn create_customer_session(
        &self,
        body: &Value,
    ) -> Result<CustomerSession, PolarError> {
        self.post(
            Path::fixed("/v1/customer-sessions/"),
            body,
            None,
            Profile::Fetch,
        )
        .await
    }

    /// `GET /v1/customers/{id}/state` (`getAiCredits`), as Polar sent it.
    pub async fn get_customer_state_raw(&self, customer_id: &str) -> Result<Value, PolarError> {
        let path = segment_path("/v1/customers/{}/state", customer_id)?;
        self.get(path, &[], Profile::Fetch).await
    }

    /// `customers.getState({id})` through the SDK (`resolveAiUsagePeriod`), as Polar sent it
    /// (P2-BILLING-02a). The SDK's call has no timeout: the provider's 60 s applies.
    pub async fn get_customer_state_sdk(&self, customer_id: &str) -> Result<Value, PolarError> {
        let path = segment_path("/v1/customers/{}/state", customer_id)?;
        self.get(path, &[], Profile::Sdk(None)).await
    }

    /// `events.list(request)` through the SDK (`fetchAiUsageTransactions`): one page of a
    /// customer's events, newest first, as Polar sent it (P2-BILLING-02a). The query is the
    /// SDK's, keys in its order (`customer_id`, `end_timestamp`, `limit`, `name`, `page`,
    /// `sorting`, `source`, `start_timestamp`), dates as ISO text; recorded from
    /// `@polar-sh/sdk` 0.42.5. No timeout in the reference: the provider's 60 s applies.
    pub async fn list_events_page(
        &self,
        request: &crate::usage_ledger::history::EventsRequest,
    ) -> Result<Value, PolarError> {
        let iso = |ms: i64| {
            dima_text::to_iso_string(ms)
                .ok_or(PolarError::InvalidInput("event window out of range"))
        };
        let (end, start) = (iso(request.end_ms)?, iso(request.start_ms)?);
        let page = request.page.to_string();
        let limit = crate::usage_ledger::history::POLAR_PAGE_SIZE.to_string();
        let query = [
            ("customer_id", request.customer_id.as_str()),
            ("end_timestamp", end.as_str()),
            ("limit", limit.as_str()),
            ("name", request.name),
            ("page", page.as_str()),
            ("sorting", "-timestamp"),
            ("source", request.source),
            ("start_timestamp", start.as_str()),
        ];
        self.get(Path::fixed("/v1/events/"), &query, Profile::Sdk(None))
            .await
    }

    // ------------------------------------------------------- ai_credit_sources.ts (gift profile)

    /// `GET /v1/benefit-grants/?customer_id=…&limit=100&page=…&sorting=-created_at`.
    pub async fn list_benefit_grants_page(
        &self,
        customer_id: &str,
        page: u32,
    ) -> Result<Value, PolarError> {
        let page = page.to_string();
        self.get(
            Path::fixed("/v1/benefit-grants/"),
            &[
                ("customer_id", customer_id),
                ("limit", "100"),
                ("page", &page),
                ("sorting", "-created_at"),
            ],
            Profile::Gift,
        )
        .await
    }

    /// `GET /v1/orders/{id}` (`encodeURIComponent(id)`).
    pub async fn get_order(&self, order_id: &str) -> Result<Value, PolarError> {
        let path = segment_path("/v1/orders/{}", order_id)?;
        self.get(path, &[], Profile::Gift).await
    }

    // -------------------------------------------------------- polar_entitlements.ts (SDK, 10 s)

    /// `customers.getState({id})` with the entitlement timeout.
    pub async fn get_entitlement_state(
        &self,
        customer_id: &str,
    ) -> Result<EntitlementState, PolarError> {
        let path = segment_path("/v1/customers/{}/state", customer_id)?;
        self.get(path, &[], Profile::Sdk(Some(ENTITLEMENT_TIMEOUT)))
            .await
    }

    /// `benefitGrants.list({customerId, isGranted: true, page, limit: 100})`.
    pub async fn list_granted_benefit_grants(
        &self,
        customer_id: &str,
        page: u32,
    ) -> Result<BenefitGrantPage, PolarError> {
        let page = page.to_string();
        self.get(
            Path::fixed("/v1/benefit-grants/"),
            &[
                ("customer_id", customer_id),
                ("is_granted", "true"),
                ("limit", "100"),
                ("page", &page),
            ],
            Profile::Sdk(Some(ENTITLEMENT_TIMEOUT)),
        )
        .await
    }

    /// `subscriptions.get({id})` with the entitlement timeout.
    pub async fn get_subscription(
        &self,
        subscription_id: &str,
    ) -> Result<SdkSubscription, PolarError> {
        let path = segment_path("/v1/subscriptions/{}", subscription_id)?;
        self.get(path, &[], Profile::Sdk(Some(ENTITLEMENT_TIMEOUT)))
            .await
    }

    // ------------------------------------------------------------------ polarsh.ts (SDK ingest)

    /// `events.ingest` for the queue flush: events already in their wire form
    /// ([`IngestEvent::wire`]), sent with an explicit `timeout`. A 400 or 422 means Polar
    /// refused the whole request as invalid, so nothing was stored; its answer is read for the
    /// events it names (`detail[].loc` of the form `["body", "events", <index>, ...]`, and the
    /// error `type` as the reason). Nothing else of the body is kept: Polar echoes request
    /// fields there.
    pub async fn ingest_batch(
        &self,
        wire: &[Value],
        timeout: Duration,
    ) -> Result<BatchAnswer, PolarError> {
        let body = serde_json::json!({ "events": wire });
        let builder = self
            .request(
                Method::POST,
                Path::fixed("/v1/events/ingest"),
                Profile::Sdk(Some(timeout)),
                true,
            )?
            .json_js(&body);
        let response = builder
            .send()
            .await
            .map_err(|source| PolarError::Transport {
                source,
                mutation: true,
            })?;
        let status = response.status();
        if status.as_u16() == 400 || status.as_u16() == 422 {
            let bytes = response.bytes().await.unwrap_or_default();
            return Ok(BatchAnswer::Invalid {
                events: refused_events(&bytes, wire.len()),
                status: status.as_u16(),
            });
        }
        if !status.is_success() {
            return Err(PolarError::Status {
                status: status.as_u16(),
                mutation: true,
            });
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|source| PolarError::Transport {
                source,
                mutation: true,
            })?;
        serde_json::from_slice(&dima_text::sanitize_lone_surrogates(&bytes))
            .map(BatchAnswer::Stored)
            .map_err(|_| PolarError::Decode { mutation: true })
    }

    /// `events.ingest({events})`: the SDK's input validation first ([`IngestEvent::wire`]), then
    /// `POST /v1/events/ingest` with no timeout of its own and no retry.
    pub async fn ingest_events(&self, events: &[IngestEvent]) -> Result<IngestResult, PolarError> {
        let wire = events
            .iter()
            .map(IngestEvent::wire)
            .collect::<Result<Vec<_>, _>>()?;
        let body = serde_json::json!({ "events": wire });
        self.post(
            Path::fixed("/v1/events/ingest"),
            &body,
            None,
            Profile::Sdk(None),
        )
        .await
    }
}

/// Polar's answer to a flush's ingest.
#[derive(Clone, Debug, PartialEq)]
pub enum BatchAnswer {
    /// Accepted: what it stored.
    Stored(IngestResult),
    /// Refused as invalid (400 or 422): nothing was stored.
    Invalid {
        /// The events Polar named, by index in the request, with its error type (lower-case
        /// letters, digits, `_` and `.` only; `invalid` otherwise). Empty when it named none.
        events: Vec<(usize, String)>,
        /// The status.
        status: u16,
    },
}

/// The events a 400/422 answer names: `detail[].loc == ["body", "events", i, ...]`.
fn refused_events(body: &[u8], sent: usize) -> Vec<(usize, String)> {
    let Ok(value) = serde_json::from_slice::<Value>(&dima_text::sanitize_lone_surrogates(body))
    else {
        return Vec::new();
    };
    let Some(details) = value.get("detail").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut events: Vec<(usize, String)> = Vec::new();
    for detail in details.iter().take(1000) {
        let Some(loc) = detail.get("loc").and_then(Value::as_array) else {
            continue;
        };
        let index = loc
            .windows(2)
            .find(|pair| pair.first().and_then(Value::as_str) == Some("events"))
            .and_then(|pair| pair.get(1))
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
            .filter(|index| *index < sent);
        let Some(index) = index else {
            continue;
        };
        let reason = detail
            .get("type")
            .and_then(Value::as_str)
            .filter(|kind| {
                !kind.is_empty()
                    && kind.len() <= 64
                    && kind.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.'
                    })
            })
            .unwrap_or("invalid");
        if !events.iter().any(|(known, _)| *known == index) {
            events.push((index, reason.to_owned()));
        }
    }
    events.sort_unstable_by_key(|(index, _)| *index);
    events
}

fn segment_path(template: &'static str, id: &str) -> Result<Path, PolarError> {
    Path::template(template, &[id])
        .map_err(|_| PolarError::InvalidInput("id is not a path segment"))
}
