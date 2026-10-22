//! Shared Polar JSON transport, behind opt-in `polar-client`.
//!
//! Source contracts: `dimabot/src/utils/billing.ts::polarRequest` and
//! `credit_gift_provider.ts::giftPolarRequest`. This is transport/core only:
//! no checkout recovery, grants, customer schemas, billing business rules,
//! event ingestion, environment-file loading, or production integration.
//!
//! Billing has no implicit timeout, follows same-origin redirects (up to the
//! fetch limit of 20), and exposes provider error bodies. Gift requests have a
//! 15-second total timeout, reject every redirect, and omit bodies/paths/source
//! errors from failures. Neither policy retries requests. An interrupted
//! mutation may have succeeded remotely; callers must reconcile rather than
//! create again. Constructors perform no network IO.
//!
//! Safety differences: paths must be root-relative and stay on the configured
//! origin, cross-origin redirects fail before forwarding credentials, and extra
//! headers cannot override authentication or authority. Billing errors contain
//! sensitive provider bodies by design; do not use them in gift/public logs.

use std::{fmt, time::Duration};

use reqwest::{
    Client, Method, Url,
    header::{AUTHORIZATION, CONTENT_TYPE, HOST, HeaderMap, HeaderValue, PROXY_AUTHORIZATION},
    redirect::Policy,
};
use serde::de::DeserializeOwned;
use serde_json::Value;

pub const PRODUCTION_BASE_URL: &str = "https://api.polar.sh";
pub const SANDBOX_BASE_URL: &str = "https://sandbox-api.polar.sh";
pub const GIFT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolarPolicy {
    Billing,
    Gift,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolarConfigError {
    MissingToken,
    InvalidToken,
    InvalidBaseUrl,
    ClientInitialization,
}
impl fmt::Display for PolarConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::MissingToken => "POLARSH_OAT is not set",
            Self::InvalidToken => "Invalid Polar authentication header",
            Self::InvalidBaseUrl => "Invalid Polar API base URL",
            Self::ClientInitialization => "Could not initialize Polar transport",
        })
    }
}
impl std::error::Error for PolarConfigError {}

/// Configuration deliberately has no derived Debug/Serialize exposing the OAT.
#[derive(Clone)]
pub struct PolarConfig {
    base: Url,
    base_prefix: String,
    authorization: HeaderValue,
}
impl fmt::Debug for PolarConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PolarConfig(<redacted>)")
    }
}
impl PolarConfig {
    /// Uses the exact TS environment names and truthiness/selection:
    /// POLARSH_API_BASE_URL (remove one terminal slash) wins when nonempty;
    /// otherwise exact POLARSH_ENVIRONMENT=sandbox selects sandbox. Everything
    /// else selects production. POLARSH_OAT must be nonempty. Whitespace is not
    /// trimmed, matching JS truthiness; invalid header/base values fail safely.
    pub fn from_lookup(
        lookup: impl FnMut(&str) -> Option<String>,
    ) -> Result<Self, PolarConfigError> {
        Self::from_lookup_for_policy(PolarPolicy::Billing, lookup)
    }
    /// Gift's source applies its fallback after slash removal; a custom "/"
    /// therefore falls back there, but is invalid for billing.
    pub fn from_lookup_for_policy(
        policy: PolarPolicy,
        mut lookup: impl FnMut(&str) -> Option<String>,
    ) -> Result<Self, PolarConfigError> {
        let token = lookup("POLARSH_OAT")
            .filter(|token| !token.is_empty())
            .ok_or(PolarConfigError::MissingToken)?;
        let custom = lookup("POLARSH_API_BASE_URL")
            .filter(|base| !base.is_empty())
            .map(|base| base.strip_suffix('/').unwrap_or(&base).to_owned());
        let custom = custom.filter(|base| policy == PolarPolicy::Billing || !base.is_empty());
        let base = custom.unwrap_or_else(|| {
            if lookup("POLARSH_ENVIRONMENT").as_deref() == Some("sandbox") {
                SANDBOX_BASE_URL.to_owned()
            } else {
                PRODUCTION_BASE_URL.to_owned()
            }
        });
        Self::from_normalized_base(&base, &token)
    }
    pub fn from_env() -> Result<Self, PolarConfigError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Explicit base/token injection for applications and isolated tests.
    /// HTTP(S) only; base query, fragment and userinfo are rejected. Custom
    /// path prefixes are preserved, as in TS's `${base}${path}` concatenation.
    pub fn new(base: &str, token: &str) -> Result<Self, PolarConfigError> {
        if token.is_empty() {
            return Err(PolarConfigError::MissingToken);
        }
        // JS replace(/\/$/, '') removes exactly one trailing slash.
        let base = base.strip_suffix('/').unwrap_or(base);
        Self::from_normalized_base(base, token)
    }

    fn from_normalized_base(base: &str, token: &str) -> Result<Self, PolarConfigError> {
        let url = Url::parse(base).map_err(|_| PolarConfigError::InvalidBaseUrl)?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(PolarConfigError::InvalidBaseUrl);
        }
        let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| PolarConfigError::InvalidToken)?;
        authorization.set_sensitive(true);
        Ok(Self {
            base: url,
            base_prefix: base.to_owned(),
            authorization,
        })
    }

    /// Returns a credential-free base suitable for configuration inspection.
    pub fn base_url(&self) -> &Url {
        &self.base
    }

    fn request_url(&self, path: &str) -> Result<Url, PolarError> {
        if !path.starts_with('/')
            || path.starts_with("//")
            || path.contains(['\\', '#'])
            || path.chars().any(char::is_control)
        {
            return Err(PolarError::InvalidPath);
        }
        // Preserve the exact single-slash removal, including repeated slashes
        // in custom bases, before the final URL parser applies fetch semantics.
        let url = Url::parse(&format!("{}{path}", self.base_prefix))
            .map_err(|_| PolarError::InvalidPath)?;
        if url.origin() != self.base.origin()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(PolarError::InvalidPath);
        }
        Ok(url)
    }
}

/// No error carries a request path/URL or raw transport/JSON exception. Gift
/// failures also omit provider bodies. Billing HTTP bodies remain available
/// (and appear in Display) to preserve its reviewed TS error contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolarError {
    Configuration {
        policy: PolarPolicy,
        kind: PolarConfigError,
    },
    InvalidPath,
    ProtectedHeader,
    ConnectionInterrupted {
        policy: PolarPolicy,
        mutation_outcome_unknown: bool,
    },
    Http {
        policy: PolarPolicy,
        status: u16,
        body: Option<String>,
        mutation_outcome_unknown: bool,
    },
    InvalidJson {
        policy: PolarPolicy,
        mutation_outcome_unknown: bool,
    },
}
impl PolarError {
    /// Never interpret a failed mutation response as proof it did not happen.
    /// Transport/decoding failures and server errors conservatively flag that
    /// reconciliation may be required. No retries are initiated by this client.
    pub fn mutation_outcome_unknown(&self) -> bool {
        match self {
            Self::ConnectionInterrupted {
                mutation_outcome_unknown,
                ..
            }
            | Self::Http {
                mutation_outcome_unknown,
                ..
            }
            | Self::InvalidJson {
                mutation_outcome_unknown,
                ..
            } => *mutation_outcome_unknown,
            _ => false,
        }
    }
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Http { status, .. } => Some(*status),
            _ => None,
        }
    }
    /// Gift errors always return None. Billing bodies may contain secrets.
    pub fn billing_body(&self) -> Option<&str> {
        match self {
            Self::Http {
                policy: PolarPolicy::Billing,
                body,
                ..
            } => body.as_deref(),
            _ => None,
        }
    }
}
impl fmt::Display for PolarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configuration {
                policy: PolarPolicy::Gift,
                ..
            } => f.write_str("Gift provider is not configured"),
            Self::Configuration {
                kind: PolarConfigError::MissingToken,
                ..
            } => f.write_str("POLARSH_OAT is not set"),
            Self::Configuration { .. } => f.write_str("Invalid Polar provider configuration"),
            Self::InvalidPath => f.write_str("Invalid Polar request path"),
            Self::ProtectedHeader => {
                f.write_str("Polar authentication or authority header cannot be overridden")
            }
            Self::ConnectionInterrupted {
                policy: PolarPolicy::Gift,
                ..
            } => f.write_str("Gift provider connection interrupted"),
            Self::ConnectionInterrupted { .. } => {
                f.write_str("Polar provider connection interrupted")
            }
            Self::Http {
                policy: PolarPolicy::Gift,
                status,
                ..
            } => write!(f, "Gift provider request failed ({status})"),
            Self::Http { status, body, .. } => write!(
                f,
                "Polar API error {status}: {}",
                body.as_deref().unwrap_or("")
            ),
            Self::InvalidJson {
                policy: PolarPolicy::Gift,
                ..
            } => f.write_str("Gift provider returned invalid JSON"),
            Self::InvalidJson { .. } => f.write_str("Polar provider returned invalid JSON"),
        }
    }
}
impl std::error::Error for PolarError {}

#[derive(Clone)]
pub struct PolarClient {
    http: Client,
    config: PolarConfig,
    policy: PolarPolicy,
}
impl PolarClient {
    /// Builds a reusable pool without connecting. Billing permits only redirects
    /// to the configured origin. Gift rejects redirects and fixes the entire
    /// send/body/decode deadline to 15 seconds, like AbortSignal.timeout.
    pub fn new(config: PolarConfig, policy: PolarPolicy) -> Result<Self, PolarError> {
        let origin = config.base.origin();
        let redirects = match policy {
            PolarPolicy::Gift => Policy::none(),
            PolarPolicy::Billing => Policy::custom(move |attempt| {
                if attempt.previous().len() > 20 {
                    attempt.error("Polar redirect limit exceeded")
                } else if attempt.url().origin() != origin
                    || !attempt.url().username().is_empty()
                    || attempt.url().password().is_some()
                {
                    attempt.error("Polar redirect origin rejected")
                } else {
                    attempt.follow()
                }
            }),
        };
        let mut builder = Client::builder().redirect(redirects);
        if policy == PolarPolicy::Gift {
            builder = builder.timeout(GIFT_TIMEOUT);
        }
        let http = builder.build().map_err(|_| PolarError::Configuration {
            policy,
            kind: PolarConfigError::ClientInitialization,
        })?;
        Ok(Self {
            http,
            config,
            policy,
        })
    }

    /// Explicit process-env loading; missing/invalid values are never echoed.
    pub fn from_env(policy: PolarPolicy) -> Result<Self, PolarError> {
        Self::from_lookup(policy, |name| std::env::var(name).ok())
    }
    pub fn from_lookup(
        policy: PolarPolicy,
        lookup: impl FnMut(&str) -> Option<String>,
    ) -> Result<Self, PolarError> {
        let config = PolarConfig::from_lookup_for_policy(policy, lookup)
            .map_err(|kind| PolarError::Configuration { policy, kind })?;
        Self::new(config, policy)
    }
    pub fn policy(&self) -> PolarPolicy {
        self.policy
    }
    pub fn timeout(&self) -> Option<Duration> {
        if self.policy == PolarPolicy::Gift {
            Some(GIFT_TIMEOUT)
        } else {
            None
        }
    }

    /// Sends exactly one JSON request (billing redirects follow fetch semantics).
    /// `path` is root-relative, including any already encoded query. Authentication,
    /// Host and proxy authorization overrides fail before IO. Additional headers
    /// such as idempotency keys are supported; the caller owns their semantics.
    /// Successful empty/204 responses fail JSON decoding, as in TS response.json().
    pub async fn request_json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        extra_headers: &HeaderMap,
    ) -> Result<T, PolarError> {
        let url = self.config.request_url(path)?;
        if extra_headers.contains_key(AUTHORIZATION)
            || extra_headers.contains_key(HOST)
            || extra_headers.contains_key(PROXY_AUTHORIZATION)
        {
            return Err(PolarError::ProtectedHeader);
        }
        let mutation = method != Method::GET && method != Method::HEAD && method != Method::OPTIONS;
        let mut headers = extra_headers.clone();
        headers.insert(AUTHORIZATION, self.config.authorization.clone());
        if !headers.contains_key(CONTENT_TYPE) {
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        }
        let mut request = self.http.request(method, url).headers(headers);
        if let Some(body) = body {
            request = request.json(body);
        }
        let send_and_read = async {
            let response = request
                .send()
                .await
                .map_err(|_| self.connection_error(mutation))?;
            let status = response.status().as_u16();
            // Gift fetch redirect:error is a connection exception, not an HTTP
            // GiftProviderError. reqwest Policy::none returns the 3xx response.
            if self.policy == PolarPolicy::Gift
                && matches!(status, 301 | 302 | 303 | 307 | 308)
                && response.headers().contains_key("location")
            {
                return Err(self.connection_error(mutation));
            }
            if !response.status().is_success() {
                let body = if self.policy == PolarPolicy::Billing {
                    Some(
                        response
                            .text()
                            .await
                            .map_err(|_| self.connection_error(mutation))?,
                    )
                } else {
                    None
                };
                return Err(PolarError::Http {
                    policy: self.policy,
                    status,
                    body,
                    mutation_outcome_unknown: mutation && status >= 500,
                });
            }
            let bytes = response
                .bytes()
                .await
                .map_err(|_| self.connection_error(mutation))?;
            serde_json::from_slice(&bytes).map_err(|_| PolarError::InvalidJson {
                policy: self.policy,
                mutation_outcome_unknown: mutation,
            })
        };
        // The deadline includes body consumption as well as headers. No timeout
        // is silently added to billing's source contract.
        if self.policy == PolarPolicy::Gift {
            tokio::time::timeout(GIFT_TIMEOUT, send_and_read)
                .await
                .map_err(|_| self.connection_error(mutation))?
        } else {
            send_and_read.await
        }
    }

    fn connection_error(&self, mutation: bool) -> PolarError {
        PolarError::ConnectionInterrupted {
            policy: self.policy,
            mutation_outcome_unknown: mutation,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_http::{CannedResponse, Recorder};
    use serde_json::json;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    fn client(recorder: &Recorder, policy: PolarPolicy) -> PolarClient {
        PolarClient::new(
            PolarConfig::new(&recorder.base_url, "fixture-oat").unwrap(),
            policy,
        )
        .unwrap()
    }

    #[test]
    fn environment_names_sandbox_and_custom_base_fixtures() {
        for (environment, expected) in [
            ("sandbox", SANDBOX_BASE_URL),
            ("Sandbox", PRODUCTION_BASE_URL),
            ("production", PRODUCTION_BASE_URL),
            ("", PRODUCTION_BASE_URL),
        ] {
            let config = PolarConfig::from_lookup(|name| match name {
                "POLARSH_OAT" => Some("oat".into()),
                "POLARSH_ENVIRONMENT" => Some(environment.into()),
                _ => None,
            })
            .unwrap();
            assert_eq!(config.base_url().as_str().trim_end_matches('/'), expected);
        }
        let config = PolarConfig::from_lookup(|name| match name {
            "POLARSH_OAT" => Some("oat".into()),
            "POLARSH_ENVIRONMENT" => Some("sandbox".into()),
            "POLARSH_API_BASE_URL" => Some("http://127.0.0.1:1234/prefix/".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(
            config.request_url("/v1/products/?page=1").unwrap().as_str(),
            "http://127.0.0.1:1234/prefix/v1/products/?page=1"
        );
        let slash_lookup = |name: &str| match name {
            "POLARSH_OAT" => Some("oat".into()),
            "POLARSH_API_BASE_URL" => Some("/".into()),
            "POLARSH_ENVIRONMENT" => Some("sandbox".into()),
            _ => None,
        };
        assert!(PolarConfig::from_lookup_for_policy(PolarPolicy::Billing, slash_lookup).is_err());
        assert_eq!(
            PolarConfig::from_lookup_for_policy(PolarPolicy::Gift, slash_lookup)
                .unwrap()
                .base_url()
                .as_str()
                .trim_end_matches('/'),
            SANDBOX_BASE_URL
        );
        assert_eq!(
            PolarConfig::new("http://127.0.0.1:1234//", "oat")
                .unwrap()
                .request_url("/v1/")
                .unwrap()
                .path(),
            "//v1/"
        );
        assert_eq!(
            PolarClient::from_lookup(PolarPolicy::Gift, |_| None)
                .err()
                .unwrap()
                .to_string(),
            "Gift provider is not configured"
        );
        assert_eq!(
            PolarClient::from_lookup(PolarPolicy::Billing, |_| None)
                .err()
                .unwrap()
                .to_string(),
            "POLARSH_OAT is not set"
        );
        for base in [
            "https://u:secret@example.invalid",
            "file:///secret",
            "https://example.invalid/?token=secret",
            "https://example.invalid/#secret",
        ] {
            let error = PolarConfig::new(base, "fixture").unwrap_err();
            assert_eq!(error, PolarConfigError::InvalidBaseUrl);
            assert!(!format!("{error:?}").contains("secret"));
        }
        assert_eq!(
            PolarConfig::new(PRODUCTION_BASE_URL, "bad\r\ntoken").unwrap_err(),
            PolarConfigError::InvalidToken
        );
    }

    #[tokio::test]
    async fn request_shape_json_headers_path_and_policy_deadlines() {
        for policy in [PolarPolicy::Billing, PolarPolicy::Gift] {
            let recorder = Recorder::start(|_| CannedResponse::json(200, r#"{"id":"created"}"#));
            let client = client(&recorder, policy);
            assert_eq!(
                client.timeout(),
                if policy == PolarPolicy::Gift {
                    Some(Duration::from_secs(15))
                } else {
                    None
                }
            );
            let mut headers = HeaderMap::new();
            headers.insert(
                "idempotency-key",
                HeaderValue::from_static("fixture-idempotency"),
            );
            let result: Value = client
                .request_json(
                    Method::POST,
                    "/v1/checkouts/?page=1",
                    Some(&json!({"product_id":"fixture-product"})),
                    &headers,
                )
                .await
                .unwrap();
            assert_eq!(result["id"], "created");
            let request = recorder.next(Duration::from_secs(2));
            assert_eq!(request.method, "POST");
            assert_eq!(request.path, "/v1/checkouts/?page=1");
            assert_eq!(request.header("authorization"), Some("Bearer fixture-oat"));
            assert_eq!(request.header("content-type"), Some("application/json"));
            assert_eq!(
                request.header("idempotency-key"),
                Some("fixture-idempotency")
            );
            assert_eq!(
                serde_json::from_slice::<Value>(&request.body).unwrap(),
                json!({"product_id":"fixture-product"})
            );
        }
    }

    #[tokio::test]
    async fn request_injection_is_rejected_before_io() {
        // No listener is necessary: each invalid request must fail before send.
        let client = PolarClient::new(
            PolarConfig::new("http://127.0.0.1:1", "fixture").unwrap(),
            PolarPolicy::Gift,
        )
        .unwrap();
        for path in [
            "https://evil.invalid/",
            "//evil.invalid/",
            "\\\\evil.invalid",
            "/\\evil.invalid/",
            "/v1/\r\n",
            "/v1/#secret",
        ] {
            assert_eq!(
                client
                    .request_json::<Value>(Method::GET, path, None, &HeaderMap::new())
                    .await
                    .unwrap_err(),
                PolarError::InvalidPath
            );
        }
        for name in [AUTHORIZATION, HOST, PROXY_AUTHORIZATION] {
            let mut headers = HeaderMap::new();
            headers.insert(name, HeaderValue::from_static("override"));
            assert_eq!(
                client
                    .request_json::<Value>(Method::GET, "/v1/products/", None, &headers)
                    .await
                    .unwrap_err(),
                PolarError::ProtectedHeader
            );
        }
    }

    #[tokio::test]
    async fn billing_preserves_error_body_and_gifts_redact_without_retries() {
        for policy in [PolarPolicy::Billing, PolarPolicy::Gift] {
            let count = Arc::new(AtomicUsize::new(0));
            let observed = count.clone();
            let recorder = Recorder::start(move |_| {
                observed.fetch_add(1, Ordering::SeqCst);
                CannedResponse::json(503, r#"{"message":"provider-private"}"#)
            });
            let error = client(&recorder, policy)
                .request_json::<Value>(
                    Method::POST,
                    "/v1/checkouts/client-secret/",
                    Some(&json!({})),
                    &HeaderMap::new(),
                )
                .await
                .unwrap_err();
            assert_eq!(count.load(Ordering::SeqCst), 1);
            assert_eq!(error.status(), Some(503));
            assert!(error.mutation_outcome_unknown());
            assert!(!format!("{error:?} {error}").contains("client-secret"));
            if policy == PolarPolicy::Gift {
                assert!(error.billing_body().is_none());
                assert!(!format!("{error:?} {error}").contains("provider-private"));
                assert_eq!(error.to_string(), "Gift provider request failed (503)");
            } else {
                assert!(error.billing_body().unwrap().contains("provider-private"));
            }
        }
    }

    #[tokio::test]
    async fn gift_rejects_redirect_billing_follows_same_origin() {
        for policy in [PolarPolicy::Billing, PolarPolicy::Gift] {
            let recorder = Recorder::start(|request| {
                if request.path == "/first" {
                    CannedResponse {
                        status: 302,
                        headers: vec![("location", "/second".into())],
                        body: Vec::new(),
                    }
                } else {
                    CannedResponse::json(200, r#"{"ok":true}"#)
                }
            });
            let result = client(&recorder, policy)
                .request_json::<Value>(Method::GET, "/first", None, &HeaderMap::new())
                .await;
            let first = recorder.next(Duration::from_secs(2));
            assert_eq!(first.path, "/first");
            if policy == PolarPolicy::Gift {
                assert_eq!(
                    result.unwrap_err().to_string(),
                    "Gift provider connection interrupted"
                );
            } else {
                assert_eq!(result.unwrap()["ok"], true);
                let second = recorder.next(Duration::from_secs(2));
                assert_eq!(second.path, "/second");
                assert_eq!(second.header("authorization"), Some("Bearer fixture-oat"));
            }
        }
    }

    #[tokio::test]
    async fn cross_origin_redirect_never_forwards_oat() {
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let target = Recorder::start(move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
            CannedResponse::json(200, "{}")
        });
        let destination = format!("{}/must-not-receive", target.base_url);
        let recorder = Recorder::start(move |_| CannedResponse {
            status: 307,
            headers: vec![("location", destination.clone())],
            body: Vec::new(),
        });
        let error = client(&recorder, PolarPolicy::Billing)
            .request_json::<Value>(
                Method::POST,
                "/private-secret",
                Some(&json!({"private":true})),
                &HeaderMap::new(),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, PolarError::ConnectionInterrupted { .. }));
        assert!(error.mutation_outcome_unknown());
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert!(!error.to_string().contains("secret"));
    }

    #[tokio::test]
    async fn invalid_json_empty_and_connection_errors_are_safe() {
        for policy in [PolarPolicy::Billing, PolarPolicy::Gift] {
            for (status, body) in [(200, "private-invalid-json"), (204, "")] {
                let recorder = Recorder::start(move |_| CannedResponse::json(status, body));
                let error = client(&recorder, policy)
                    .request_json::<Value>(
                        Method::POST,
                        "/v1/checkouts/private-secret",
                        None,
                        &HeaderMap::new(),
                    )
                    .await
                    .unwrap_err();
                assert!(matches!(error, PolarError::InvalidJson { .. }));
                assert!(error.mutation_outcome_unknown());
                assert!(!format!("{error:?} {error}").contains("private"));
            }
            // Reserve the port without listening. Releasing a listener here
            // lets a concurrent recorder reuse it and answer this request.
            let reserved = tokio::net::TcpSocket::new_v4().unwrap();
            reserved.bind("127.0.0.1:0".parse().unwrap()).unwrap();
            let base = format!("http://{}", reserved.local_addr().unwrap());
            let client =
                PolarClient::new(PolarConfig::new(&base, "fixture-oat").unwrap(), policy).unwrap();
            let error = client
                .request_json::<Value>(Method::POST, "/secret-path", None, &HeaderMap::new())
                .await
                .unwrap_err();
            drop(reserved);
            assert!(error.mutation_outcome_unknown());
            assert!(!format!("{error:?} {error}").contains("secret-path"));
        }
    }
}
