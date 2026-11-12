//! Outside services: how each is reached, and the registry a binary fills at startup.

use crate::retry::RetryPolicy;
use http::{HeaderMap, HeaderName, HeaderValue};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;
use url::Url;

/// The default total deadline of an attempt (headers and body).
///
/// Node's `fetch` has none and most reference call sites set none; MIGRATION.md asks for a
/// generous value that only fires on a real hang. 60 s is far above any API latency in the
/// reference (its explicit timeouts are 3 to 30 s, except the AI calls that set their own), and
/// short enough that a hung peer does not hold a chat message's work for the five minutes
/// undici would wait for headers.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
/// The default connect timeout (name resolution, TCP and TLS). Set per client.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// The default idle timeout between body chunks.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// The default body limit: 8 MiB, after decompression. The largest bodies the reference reads
/// from APIs (Twitch pages of 100, Qdrant scrolls, OpenRouter answers) are well under it; TTS
/// audio, media and S3 objects set their own limits.
pub const DEFAULT_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// The default limit on a request body we send: 8 MiB. The reference's largest outgoing API
/// bodies (AI prompts with history, OTLP batches) are far below it; uploads (S3 objects, media)
/// set their own. Over it the request fails with [`crate::Error::RequestBodyTooLarge`] before
/// anything is sent (bytes, JSON, forms) or as soon as the count passes it (streams).
pub const DEFAULT_MAX_REQUEST_BYTES: u64 = 8 * 1024 * 1024;

/// What happens when a provider answers with a redirect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Redirects {
    /// A 3xx with a `Location` is [`crate::Error::Redirect`] (the default; `redirect: "error"`).
    /// No API the reference calls redirects, the reference's careful sites refuse redirects, and
    /// following one could carry credentials to another host; an unexpected redirect is a bug
    /// to see, not to follow.
    #[default]
    Error,
    /// The 3xx response is returned as it is (`redirect: "manual"`).
    Manual,
    /// Up to `max` redirects are followed while they stay on the same origin (scheme, host and
    /// port); a redirect elsewhere is [`crate::Error::Redirect`].
    SameOrigin {
        /// The hop limit.
        max: u8,
    },
}

/// Configuration errors, found when the registry is built.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    /// The base URL is not an absolute http(s) URL without credentials, query or fragment.
    #[error("provider {0}: invalid base url")]
    BaseUrl(&'static str),
    /// A default header name or value is invalid.
    #[error("provider {0}: invalid header")]
    Header(&'static str),
    /// Two providers share a name.
    #[error("provider {0} declared twice")]
    Duplicate(&'static str),
    /// An override names no provider.
    #[error("base url override for unknown provider {0}")]
    UnknownOverride(String),
    /// A lookup names no provider.
    #[error("unknown provider {0}")]
    Unknown(String),
    /// A base URL override outside a test mode (see [`TestMode`]).
    #[error("base url override for provider {0} without a test mode")]
    OverrideOutsideTestMode(String),
    /// An override to a host that is not loopback while the test mode allows loopback only.
    #[error("base url override for provider {0} is not a loopback address")]
    OverrideNotLoopback(String),
}

/// How the process runs, chosen once at startup. Only a test mode accepts base URL overrides:
/// an override receives the provider's credentials (its secret headers, a request's bearer
/// token, trace headers) and may be plain http, so it must never be a silent configuration
/// value in production.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TestMode {
    /// Production: every provider talks to the host it declares; overrides are refused.
    #[default]
    Off,
    /// The side-by-side rig or a test: providers may be pointed at local mocks.
    RigMock {
        /// Accept only loopback overrides (`127.0.0.0/8`, `::1`, `localhost`), which is what
        /// [`crate::testing::MockServer`] serves on. The rig sets it to `false` when its mocks
        /// run under their own names on a private network.
        loopback_only: bool,
    },
}

/// One outside service. Cheap to clone.
#[derive(Clone)]
pub struct Provider(pub(crate) Arc<ProviderInner>);

pub(crate) struct ProviderInner {
    pub name: &'static str,
    pub base: Url,
    pub headers: HeaderMap,
    pub timeout: Duration,
    pub headers_timeout: Option<Duration>,
    pub idle_timeout: Duration,
    pub max_bytes: u64,
    pub max_request_bytes: u64,
    pub retry: RetryPolicy,
    pub redirects: Redirects,
    pub semaphore: Option<Arc<Semaphore>>,
    pub secret_query: Arc<[&'static str]>,
    pub internal: bool,
    pub rate_limit_unprocessed: bool,
}

impl std::fmt::Debug for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let p = &self.0;
        f.debug_struct("Provider")
            .field("name", &p.name)
            .field("base", &p.base.as_str())
            .field("headers", &crate::redact::HeaderNames(&p.headers))
            .field("timeout", &p.timeout)
            .field("retry_attempts", &p.retry.attempts())
            .field("redirects", &p.redirects)
            .field("internal", &p.internal)
            .finish_non_exhaustive()
    }
}

impl Provider {
    /// Starts a provider named `name` (the telemetry label) whose real host is `base_url`.
    pub fn builder(name: &'static str, base_url: &str) -> ProviderBuilder {
        ProviderBuilder {
            name,
            base: base_url.to_owned(),
            headers: Vec::new(),
            timeout: DEFAULT_TIMEOUT,
            headers_timeout: None,
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            max_bytes: DEFAULT_MAX_BYTES,
            max_request_bytes: DEFAULT_MAX_REQUEST_BYTES,
            retry: RetryPolicy::none(),
            redirects: Redirects::default(),
            max_concurrency: None,
            secret_query: Vec::new(),
            internal: false,
            rate_limit_unprocessed: false,
        }
    }

    /// The name.
    pub fn name(&self) -> &'static str {
        self.0.name
    }

    /// The base URL in use (the real host, or the override).
    pub fn base_url(&self) -> &Url {
        &self.0.base
    }

    /// The default limit on request bodies.
    pub fn max_request_bytes(&self) -> u64 {
        self.0.max_request_bytes
    }

    /// The default retry policy.
    pub fn retry_policy(&self) -> &RetryPolicy {
        &self.0.retry
    }
}

/// A default header as declared: secret values stay in [`dima_core::SecretString`] until the
/// provider is built.
#[derive(Clone)]
enum DeclaredHeader {
    Plain(String, String),
    Secret(String, dima_core::SecretString),
}

impl DeclaredHeader {
    fn name(&self) -> &str {
        match self {
            Self::Plain(name, _) | Self::Secret(name, _) => name,
        }
    }
}

/// Builds a [`Provider`].
#[derive(Clone)]
pub struct ProviderBuilder {
    name: &'static str,
    base: String,
    headers: Vec<DeclaredHeader>,
    timeout: Duration,
    headers_timeout: Option<Duration>,
    idle_timeout: Duration,
    max_bytes: u64,
    max_request_bytes: u64,
    retry: RetryPolicy,
    redirects: Redirects,
    max_concurrency: Option<usize>,
    secret_query: Vec<&'static str>,
    internal: bool,
    rate_limit_unprocessed: bool,
}

/// The name and the header names only: the base URL is not validated yet (it could hold
/// credentials) and header values may be secrets.
impl std::fmt::Debug for ProviderBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderBuilder")
            .field("name", &self.name)
            .field(
                "headers",
                &self
                    .headers
                    .iter()
                    .map(DeclaredHeader::name)
                    .collect::<Vec<_>>(),
            )
            .field("timeout", &self.timeout)
            .field("redirects", &self.redirects)
            .field("internal", &self.internal)
            .finish_non_exhaustive()
    }
}

impl ProviderBuilder {
    /// The provider's name.
    pub fn name(&self) -> &'static str {
        self.name
    }

    /// The path of the declared base URL (`/helix`), empty when it has none or does not parse.
    #[cfg(feature = "test-util")]
    pub(crate) fn declared_path(&self) -> String {
        Url::parse(&self.base)
            .map(|url| url.path().trim_end_matches('/').to_owned())
            .unwrap_or_default()
    }

    /// A header sent with every request.
    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers
            .push(DeclaredHeader::Plain(name.to_owned(), value.to_owned()));
        self
    }

    /// A header sent with every request whose value is a secret (never printed, marked
    /// sensitive for the HTTP stack).
    pub fn secret_header(mut self, name: &str, value: &dima_core::SecretString) -> Self {
        self.headers
            .push(DeclaredHeader::Secret(name.to_owned(), value.clone()));
        self
    }

    /// The total deadline of each attempt.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// A deadline for the response headers of each attempt.
    pub fn headers_timeout(mut self, timeout: Duration) -> Self {
        self.headers_timeout = Some(timeout);
        self
    }

    /// The idle timeout between body chunks.
    pub fn idle_timeout(mut self, timeout: Duration) -> Self {
        self.idle_timeout = timeout;
        self
    }

    /// The default body limit.
    pub fn max_bytes(mut self, max: u64) -> Self {
        self.max_bytes = max;
        self
    }

    /// The default limit on request bodies (see [`DEFAULT_MAX_REQUEST_BYTES`]).
    pub fn max_request_bytes(mut self, max: u64) -> Self {
        self.max_request_bytes = max;
        self
    }

    /// The default retry policy.
    pub fn retry(mut self, policy: RetryPolicy) -> Self {
        self.retry = policy;
        self
    }

    /// The redirect handling.
    pub fn redirects(mut self, redirects: Redirects) -> Self {
        self.redirects = redirects;
        self
    }

    /// At most `n` attempts in flight at once across the process (a response holds its slot
    /// until its body is read or dropped).
    pub fn max_concurrency(mut self, n: usize) -> Self {
        self.max_concurrency = Some(n.max(1));
        self
    }

    /// Query parameters whose values are secrets (redacted in errors, in addition to the common
    /// names such as `key`, `token` and `client_secret`).
    pub fn secret_query_params(mut self, names: &[&'static str]) -> Self {
        self.secret_query.extend_from_slice(names);
        self
    }

    /// States that this service answers 429 only for requests it did not process, so a
    /// non-idempotent request may be retried after a 429 (when the retry policy retries 429).
    /// Off by default: only set it where the service documents that guarantee.
    pub fn rate_limit_means_unprocessed(mut self, guaranteed: bool) -> Self {
        self.rate_limit_unprocessed = guaranteed;
        self
    }

    /// Marks one of our own services: the [`crate::TraceInjector`] adds trace headers.
    pub fn internal(mut self, internal: bool) -> Self {
        self.internal = internal;
        self
    }

    /// Validates and builds.
    pub fn build(self) -> Result<Provider, ConfigError> {
        let name = self.name;
        let base = Url::parse(&self.base).map_err(|_| ConfigError::BaseUrl(name))?;
        let valid = matches!(base.scheme(), "http" | "https")
            && base.has_host()
            && base.username().is_empty()
            && base.password().is_none()
            && base.query().is_none()
            && base.fragment().is_none();
        if !valid {
            return Err(ConfigError::BaseUrl(name));
        }
        let mut headers = HeaderMap::with_capacity(self.headers.len());
        for declared in &self.headers {
            let (header, value, secret) = match declared {
                DeclaredHeader::Plain(header, value) => (header, value.as_str(), false),
                DeclaredHeader::Secret(header, value) => (header, value.expose(), true),
            };
            let header =
                HeaderName::try_from(header.as_str()).map_err(|_| ConfigError::Header(name))?;
            let mut value = HeaderValue::try_from(value).map_err(|_| ConfigError::Header(name))?;
            if secret || crate::redact::is_sensitive(&header) {
                value.set_sensitive(true);
            }
            headers.append(header, value);
        }
        Ok(Provider(Arc::new(ProviderInner {
            name,
            base,
            headers,
            timeout: self.timeout,
            headers_timeout: self.headers_timeout,
            idle_timeout: self.idle_timeout,
            max_bytes: self.max_bytes,
            max_request_bytes: self.max_request_bytes,
            retry: self.retry,
            redirects: self.redirects,
            semaphore: self.max_concurrency.map(|n| Arc::new(Semaphore::new(n))),
            secret_query: Arc::from(self.secret_query),
            internal: self.internal,
            rate_limit_unprocessed: self.rate_limit_unprocessed,
        })))
    }
}

/// Every provider of a process, filled once at startup and read-only afterwards.
#[derive(Clone, Debug, Default)]
pub struct ProviderRegistry {
    providers: HashMap<&'static str, Provider>,
    test_mode: TestMode,
    overridden: Vec<&'static str>,
}

impl ProviderRegistry {
    /// Starts a registry.
    pub fn builder() -> RegistryBuilder {
        RegistryBuilder::default()
    }

    /// The provider named `name`.
    pub fn get(&self, name: &str) -> Result<&Provider, ConfigError> {
        self.providers
            .get(name)
            .ok_or_else(|| ConfigError::Unknown(name.to_owned()))
    }

    /// The provider names.
    pub fn names(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.providers.keys().copied()
    }

    /// The test mode the registry was built in.
    pub fn test_mode(&self) -> TestMode {
        self.test_mode
    }

    /// The providers whose base URL was overridden (sorted by name).
    pub fn overridden(&self) -> &[&'static str] {
        &self.overridden
    }

    /// A line for the binary to log at startup when the registry runs in a test mode, naming
    /// every overridden provider and where it now sends its credentials; `None` in production.
    pub fn startup_report(&self) -> Option<String> {
        let TestMode::RigMock { loopback_only } = self.test_mode else {
            return None;
        };
        let mut line =
            format!("http providers in TEST MODE (rig-mock, loopback_only={loopback_only}): ");
        if self.overridden.is_empty() {
            line.push_str("no base url overrides");
        } else {
            line.push_str("base url overrides receive provider credentials:");
            for name in &self.overridden {
                if let Some(provider) = self.providers.get(name) {
                    line.push_str(&format!(" {name} -> {};", provider.base_url()));
                }
            }
            line.pop();
        }
        Some(line)
    }
}

/// Builds a [`ProviderRegistry`].
#[derive(Clone, Default)]
pub struct RegistryBuilder {
    providers: Vec<ProviderBuilder>,
    overrides: Vec<(String, String)>,
    test_mode: TestMode,
}

/// The providers and the names of the overrides: an override URL is not validated yet.
impl std::fmt::Debug for RegistryBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RegistryBuilder")
            .field("providers", &self.providers)
            .field(
                "overrides",
                &self
                    .overrides
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .field("test_mode", &self.test_mode)
            .finish()
    }
}

/// Whether an override URL's host is loopback.
fn is_loopback(base: &str) -> bool {
    match Url::parse(base).ok().as_ref().and_then(Url::host) {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

impl RegistryBuilder {
    /// Adds a provider.
    pub fn provider(mut self, provider: ProviderBuilder) -> Self {
        self.providers.push(provider);
        self
    }

    /// The test mode, chosen once at startup (production leaves it [`TestMode::Off`]).
    pub fn test_mode(mut self, mode: TestMode) -> Self {
        self.test_mode = mode;
        self
    }

    /// Replaces a provider's base URL. Accepted only in a [`TestMode`]: outside one,
    /// [`RegistryBuilder::build`] fails with [`ConfigError::OverrideOutsideTestMode`]. An unknown
    /// name is an error too, so a typo cannot silently send traffic to the real host. Log
    /// [`ProviderRegistry::startup_report`] at startup.
    pub fn base_url_override(mut self, name: &str, base_url: &str) -> Self {
        self.overrides.push((name.to_owned(), base_url.to_owned()));
        self
    }

    /// Validates and builds.
    pub fn build(self) -> Result<ProviderRegistry, ConfigError> {
        let mut builders = self.providers;
        let mut overridden = Vec::with_capacity(self.overrides.len());
        for (name, base) in self.overrides {
            match self.test_mode {
                TestMode::Off => return Err(ConfigError::OverrideOutsideTestMode(name)),
                TestMode::RigMock { loopback_only } if loopback_only && !is_loopback(&base) => {
                    return Err(ConfigError::OverrideNotLoopback(name));
                }
                TestMode::RigMock { .. } => {}
            }
            let builder = builders
                .iter_mut()
                .find(|b| b.name == name)
                .ok_or(ConfigError::UnknownOverride(name))?;
            builder.base = base;
            overridden.push(builder.name);
        }
        overridden.sort_unstable();
        overridden.dedup();
        let mut providers = HashMap::with_capacity(builders.len());
        for builder in builders {
            let name = builder.name;
            if providers.insert(name, builder.build()?).is_some() {
                return Err(ConfigError::Duplicate(name));
            }
        }
        Ok(ProviderRegistry {
            providers,
            test_mode: self.test_mode,
            overridden,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RIG: TestMode = TestMode::RigMock {
        loopback_only: true,
    };

    #[test]
    fn overrides_need_an_explicit_test_mode() {
        let declared = || {
            ProviderRegistry::builder()
                .provider(
                    Provider::builder("polar", "https://api.polar.sh")
                        .secret_header("authorization", &"Bearer polar_oat_x".into()),
                )
                .provider(Provider::builder("twitch", "https://api.twitch.tv"))
                .base_url_override("polar", "http://127.0.0.1:9999/mock/polar")
        };
        // Production: refused, whatever the target.
        assert_eq!(
            declared().build().unwrap_err(),
            ConfigError::OverrideOutsideTestMode("polar".into())
        );
        assert_eq!(
            declared().test_mode(TestMode::Off).build().unwrap_err(),
            ConfigError::OverrideOutsideTestMode("polar".into())
        );
        // A loopback-only test mode refuses any other host.
        assert_eq!(
            declared()
                .test_mode(RIG)
                .base_url_override("twitch", "http://mock-twitch:8080")
                .build()
                .unwrap_err(),
            ConfigError::OverrideNotLoopback("twitch".into())
        );
        for loopback in ["http://localhost:1", "http://[::1]:1", "http://127.1.2.3:1"] {
            assert!(
                declared()
                    .test_mode(RIG)
                    .base_url_override("twitch", loopback)
                    .build()
                    .is_ok(),
                "{loopback}"
            );
        }
        let rig = declared()
            .test_mode(TestMode::RigMock {
                loopback_only: false,
            })
            .base_url_override("twitch", "http://mock-twitch:8080")
            .build()
            .unwrap();
        assert_eq!(rig.overridden(), ["polar", "twitch"]);
        // The startup line names every override and where its credentials now go.
        let report = rig.startup_report().unwrap();
        assert!(report.contains("TEST MODE"), "{report}");
        assert!(
            report.contains("polar -> http://127.0.0.1:9999/mock/polar"),
            "{report}"
        );
        assert!(
            report.contains("twitch -> http://mock-twitch:8080/"),
            "{report}"
        );
        assert!(!report.contains("polar_oat"), "{report}");
        // Production has nothing to report; a test mode without overrides still says so.
        let production = ProviderRegistry::builder()
            .provider(Provider::builder("twitch", "https://api.twitch.tv"))
            .build()
            .unwrap();
        assert_eq!(production.test_mode(), TestMode::Off);
        assert!(production.startup_report().is_none());
        assert!(production.overridden().is_empty());
        let quiet = ProviderRegistry::builder().test_mode(RIG).build().unwrap();
        assert!(
            quiet
                .startup_report()
                .unwrap()
                .contains("no base url overrides")
        );
    }

    #[test]
    fn registry_overrides_and_validation() {
        let registry = ProviderRegistry::builder()
            .provider(Provider::builder("twitch", "https://api.twitch.tv"))
            .provider(Provider::builder("polar", "https://api.polar.sh"))
            .test_mode(RIG)
            .base_url_override("polar", "http://127.0.0.1:9999/mock/polar")
            .build()
            .unwrap();
        assert_eq!(
            registry.get("polar").unwrap().base_url().as_str(),
            "http://127.0.0.1:9999/mock/polar"
        );
        assert_eq!(
            registry.get("twitch").unwrap().base_url().as_str(),
            "https://api.twitch.tv/"
        );
        assert_eq!(
            registry.get("nope").unwrap_err(),
            ConfigError::Unknown("nope".into())
        );
        let typo = ProviderRegistry::builder()
            .provider(Provider::builder("twitch", "https://api.twitch.tv"))
            .test_mode(RIG)
            .base_url_override("twich", "http://127.0.0.1:1")
            .build();
        assert_eq!(
            typo.unwrap_err(),
            ConfigError::UnknownOverride("twich".into())
        );
        let twice = ProviderRegistry::builder()
            .provider(Provider::builder("a", "https://a.test"))
            .provider(Provider::builder("a", "https://b.test"))
            .build();
        assert_eq!(twice.unwrap_err(), ConfigError::Duplicate("a"));
        for bad in [
            "ftp://x.test",
            "https://u:p@x.test",
            "https://x.test/?q=1",
            "nope",
            "https://x.test/#f",
        ] {
            assert_eq!(
                Provider::builder("bad", bad).build().unwrap_err(),
                ConfigError::BaseUrl("bad")
            );
        }
        assert_eq!(
            Provider::builder("bad", "https://x.test")
                .header("bad header", "v")
                .build()
                .unwrap_err(),
            ConfigError::Header("bad")
        );
    }

    #[test]
    fn provider_debug_hides_secret_headers() {
        let provider = Provider::builder("openrouter", "https://openrouter.ai/api/v1")
            .secret_header("authorization", &"Bearer sk-or-SECRET".into())
            .secret_header("x-custom-key", &"SECRET2".into())
            .header("http-referer", "https://domdimabot.com")
            .build()
            .unwrap();
        let text = format!("{provider:?}");
        assert!(!text.contains("SECRET"), "{text}");
        assert!(text.contains("http-referer"), "{text}");
        assert!(!text.contains("domdimabot.com"), "{text}");
    }
}
