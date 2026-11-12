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
//! - Responses tolerate fields Polar adds. Where the reference reads an answer loosely (product
//!   lists, the raw customer state, orders and grants of the credit-source report), the value is
//!   kept as JSON and read with the reference's own rules; where it reads it through the SDK's
//!   validation (entitlements, ingest), it is typed.
//! - Errors never carry the token, a response body (Polar echoes request fields there, a
//!   customer's e-mail among them; the reference put the body in its error message) or an id:
//!   paths are templates and the `customer_id`, `external_customer_id` and `query` parameters
//!   are redacted.
//! - A `POST` whose answer was lost ([`PolarError::outcome_unknown`]) may have been applied by
//!   Polar; callers reconcile, they never resend blindly (ingest relies on `external_id`
//!   deduplication, checkouts on the `Idempotency-Key`).

mod ingest;
mod types;

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
    /// The answer was not the JSON the call expects.
    #[error("Polar answered with an unexpected shape")]
    Decode,
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
    /// may have been sent, or one answered with a 5xx.
    pub fn outcome_unknown(&self) -> bool {
        match self {
            Self::Transport { mutation, .. } => *mutation,
            Self::Status { status, mutation } => *mutation && *status >= 500,
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
    /// The provider declaration for the binary's registry: the host of
    /// [`PolarConfig::environment`], redirects refused, no retries, the id-carrying query
    /// parameters redacted. A test-mode registry may override the base URL
    /// ([`PolarConfig::base_url_override`]).
    pub fn provider(config: &PolarConfig) -> ProviderBuilder {
        Provider::builder(PROVIDER_NAME, config.environment.base_url()).secret_query_params(&[
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
            .map_err(|_| PolarError::Decode)
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

    /// `GET /v1/subscriptions/?customer_id=…&limit=100[&active=…]` (`listSubscriptions`).
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
        let list: ListResponse<Subscription> = self
            .get(Path::fixed("/v1/subscriptions/"), &query, Profile::Fetch)
            .await?;
        Ok(list.items)
    }

    /// `GET /v1/products/?limit=100` (`getCreditPackCatalog`): the items as Polar sent them;
    /// `None` when `items` is missing or `null` (`items || []`).
    pub async fn list_products(&self) -> Result<Option<Value>, PolarError> {
        let list: LooseList = self
            .get(
                Path::fixed("/v1/products/"),
                &[("limit", "100")],
                Profile::Fetch,
            )
            .await?;
        Ok(list.items.filter(|items| !items.is_null()))
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

    /// `GET /v1/discounts/?query=…&limit=100` (`findDiscountByPromoCode`).
    pub async fn search_discounts(&self, query: &str) -> Result<Vec<Discount>, PolarError> {
        let list: ListResponse<Discount> = self
            .get(
                Path::fixed("/v1/discounts/"),
                &[("query", query), ("limit", "100")],
                Profile::Fetch,
            )
            .await?;
        Ok(list.items)
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

fn segment_path(template: &'static str, id: &str) -> Result<Path, PolarError> {
    Path::template(template, &[id])
        .map_err(|_| PolarError::InvalidInput("id is not a path segment"))
}
