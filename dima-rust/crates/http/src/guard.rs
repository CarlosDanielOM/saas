//! The guarded client for URLs a user (or a model) chose.
//!
//! Every such site uses [`GuardedClient`]. For each hop it checks, in order: the URL parses and
//! has no IPv6 zone id; the scheme and port are allowed; there is no user name or password; the
//! host is on the policy's list (when it has one); an IP literal (in any notation the WHATWG URL
//! parser accepts: `2130706433`, `0x7f.1`, `0177.0.0.1`, `[::ffff:127.0.0.1]`...) is refused or
//! checked; a name is resolved once and *every* address must be public, and the connection is
//! made to exactly those checked addresses (the resolver result is the connector's only input,
//! so a DNS answer that changes between "check" and "connect" cannot exist). Redirects are not
//! followed by the transport: each `Location` is resolved against the current URL and goes
//! through the same checks, up to the hop limit; 301/302 turn POST into GET and 303 turns
//! everything but HEAD into GET, as fetch does. Headers the caller set are dropped when a hop
//! changes origin, so nothing set for one host reaches another. No proxy environment variables
//! are read, no cookies are kept, no `Referer` is sent, idle connections are not reused.
//!
//! **Refused addresses** (IPv4 and the IPv4 inside IPv4-mapped and IPv4-compatible IPv6):
//! `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (carrier-grade NAT; holds Alibaba's metadata
//! address), `127.0.0.0/8`, `169.254.0.0/16` (link-local; holds the AWS, GCP and Azure metadata
//! address 169.254.169.254), `172.16.0.0/12`, `192.0.0.0/24` (holds Oracle's 192.0.0.192),
//! `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`,
//! `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4` (includes broadcast) and Azure's
//! `168.63.129.16`. IPv6: `::/128`, `::1/128`, `::/96` (IPv4-compatible), `::ffff:0:0/96` when
//! the embedded IPv4 is refused, `64:ff9b::/96` and `64:ff9b:1::/48` (NAT64, any embedded
//! address), `100::/64`, `2001::/23` (Teredo, benchmarking, ORCHID...), `2001:db8::/32`,
//! `2002::/16` (6to4), `3fff::/20`, `5f00::/16`, `fc00::/7` (holds AWS's `fd00:ec2::254`),
//! `fe80::/10`, `fec0::/10`, `ff00::/8`.
//!
//! **Stricter than the reference** (`custom_widgets/media.ts` `safeFetch`): the reference checks
//! the DNS answer and then lets `fetch` resolve again (a rebinding window); here the checked
//! answer is the one connected to. It also adds the documentation ranges, `192.88.99.0/24`,
//! the Azure address, IPv4-compatible IPv6, the local NAT64 prefix, `100::/64`, `2001::/23`,
//! `2002::/16`, `3fff::/20`, `5f00::/16` and `fec0::/10`; bounds the body size on every read
//! (the reference counts streamed bytes too, but a HEAD answer is unbounded there); applies one
//! deadline across all hops instead of one per `fetch`; and refuses IPv6 zone ids. Like the
//! reference it requires https on port 443 with no credentials in the URL, accepts only the
//! listed hosts, follows at most 3 redirects re-checking each, and sends no credentials.

use crate::client::{self, Body, Cancel};
use crate::error::{BlockReason, BoxError, Error, RequestInfo, Result};
use crate::observe::{EndGuard, NoopObserver, Observer};
use crate::redact::QueryShown;
use crate::response::{Limits, Response};
use http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use url::Url;

/// A boxed future.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Name resolution, injectable so tests control the answers.
pub trait Resolver: Send + Sync + std::fmt::Debug {
    /// The addresses of `host` (a name, never an IP literal).
    fn resolve<'a>(&'a self, host: &'a str) -> BoxFuture<'a, std::io::Result<Vec<IpAddr>>>;
}

/// The operating system's resolver (`getaddrinfo` on a blocking thread, via tokio).
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve<'a>(&'a self, host: &'a str) -> BoxFuture<'a, std::io::Result<Vec<IpAddr>>> {
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((host, 0)).await?;
            Ok(addrs.map(|a| a.ip()).collect())
        })
    }
}

/// Which range a refused address belongs to (`None` for a public address).
pub fn refused_range(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(v4) => refused_v4(v4),
        IpAddr::V6(v6) => refused_v6(v6),
    }
}

fn refused_v4(ip: Ipv4Addr) -> Option<&'static str> {
    const RANGES: &[([u8; 4], u8, &str)] = &[
        ([0, 0, 0, 0], 8, "unspecified"),
        ([10, 0, 0, 0], 8, "private"),
        ([100, 64, 0, 0], 10, "carrier-grade nat"),
        ([127, 0, 0, 0], 8, "loopback"),
        ([169, 254, 0, 0], 16, "link-local"),
        ([172, 16, 0, 0], 12, "private"),
        ([192, 0, 0, 0], 24, "ietf protocol assignments"),
        ([192, 0, 2, 0], 24, "documentation"),
        ([192, 88, 99, 0], 24, "6to4 relay"),
        ([192, 168, 0, 0], 16, "private"),
        ([198, 18, 0, 0], 15, "benchmarking"),
        ([198, 51, 100, 0], 24, "documentation"),
        ([203, 0, 113, 0], 24, "documentation"),
        ([224, 0, 0, 0], 4, "multicast"),
        ([240, 0, 0, 0], 4, "reserved"),
        ([168, 63, 129, 16], 32, "cloud metadata"),
    ];
    let value = u32::from(ip);
    RANGES.iter().find_map(|(net, prefix, name)| {
        let mask = u32::MAX.checked_shl(32 - u32::from(*prefix)).unwrap_or(0);
        (value & mask == u32::from_be_bytes(*net) & mask).then_some(*name)
    })
}

fn refused_v6(ip: Ipv6Addr) -> Option<&'static str> {
    let value = u128::from(ip);
    let within = |net: u128, prefix: u32| {
        let mask = u128::MAX.checked_shl(128 - prefix).unwrap_or(0);
        value & mask == net & mask
    };
    if value == 0 {
        return Some("unspecified");
    }
    if value == 1 {
        return Some("loopback");
    }
    if within(0xffff_0000_0000, 96) {
        let v4 = Ipv4Addr::from(u32::try_from(value & 0xffff_ffff).unwrap_or(0));
        return refused_v4(v4);
    }
    const RANGES: &[(u128, u32, &str)] = &[
        (0, 96, "ipv4-compatible"),
        (0x0064_ff9b_0000_0000_0000_0000_0000_0000, 96, "nat64"),
        (0x0064_ff9b_0001_0000_0000_0000_0000_0000, 48, "nat64"),
        (0x0100_0000_0000_0000_0000_0000_0000_0000, 64, "discard"),
        (
            0x2001_0000_0000_0000_0000_0000_0000_0000,
            23,
            "ietf protocol assignments",
        ),
        (
            0x2001_0db8_0000_0000_0000_0000_0000_0000,
            32,
            "documentation",
        ),
        (0x2002_0000_0000_0000_0000_0000_0000_0000, 16, "6to4"),
        (
            0x3fff_0000_0000_0000_0000_0000_0000_0000,
            20,
            "documentation",
        ),
        (
            0x5f00_0000_0000_0000_0000_0000_0000_0000,
            16,
            "segment routing",
        ),
        (0xfc00_0000_0000_0000_0000_0000_0000_0000, 7, "unique local"),
        (0xfe80_0000_0000_0000_0000_0000_0000_0000, 10, "link-local"),
        (0xfec0_0000_0000_0000_0000_0000_0000_0000, 10, "site-local"),
        (0xff00_0000_0000_0000_0000_0000_0000_0000, 8, "multicast"),
    ];
    RANGES
        .iter()
        .find_map(|(net, prefix, name)| within(*net, *prefix).then_some(*name))
}

/// What the guarded client accepts.
#[derive(Clone, Debug)]
pub struct GuardPolicy {
    https: bool,
    http: bool,
    ports: Vec<u16>,
    hosts: Option<Vec<String>>,
    ip_literals: bool,
    max_redirects: u8,
    timeout: Duration,
    connect_timeout: Duration,
    idle_timeout: Duration,
    max_bytes: u64,
    exempt: Vec<IpAddr>,
}

impl GuardPolicy {
    /// https on port 443 to the listed hosts only (exact, case-insensitive names), up to 3
    /// redirects, 30 s for the whole fetch, 5 s to connect, 30 s idle, 8 MiB.
    pub fn https_hosts<I, S>(hosts: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            hosts: Some(
                hosts
                    .into_iter()
                    .map(|h| h.into().to_ascii_lowercase())
                    .collect(),
            ),
            ..Self::any_public_host()
        }
    }

    /// https on port 443 to any host whose addresses are all public (IP literals refused).
    pub fn any_public_host() -> Self {
        Self {
            https: true,
            http: false,
            ports: vec![443],
            hosts: None,
            ip_literals: false,
            max_redirects: 3,
            timeout: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(5),
            idle_timeout: Duration::from_secs(30),
            max_bytes: 8 * 1024 * 1024,
            exempt: Vec::new(),
        }
    }

    /// Also allows plain http (on the ports in [`GuardPolicy::ports`]).
    pub fn allow_http(mut self, allow: bool) -> Self {
        self.http = allow;
        self
    }

    /// The allowed ports (by default only 443).
    pub fn ports(mut self, ports: &[u16]) -> Self {
        self.ports = ports.to_vec();
        self
    }

    /// Accepts public IP literals as hosts (when there is no host list).
    pub fn allow_ip_literals(mut self, allow: bool) -> Self {
        self.ip_literals = allow;
        self
    }

    /// The redirect hop limit.
    pub fn max_redirects(mut self, hops: u8) -> Self {
        self.max_redirects = hops;
        self
    }

    /// The default deadline for a whole fetch, all hops and the body.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The connect timeout.
    pub fn connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    /// The default body limit.
    pub fn max_bytes(mut self, max: u64) -> Self {
        self.max_bytes = max;
        self
    }

    /// Lets one otherwise refused address through, so tests can serve on loopback. Only with
    /// the `test-util` feature.
    #[cfg(feature = "test-util")]
    pub fn allow_address_for_tests(mut self, ip: IpAddr) -> Self {
        self.exempt.push(ip);
        self
    }

    fn address_allowed(&self, ip: IpAddr) -> bool {
        refused_range(ip).is_none() || self.exempt.contains(&ip)
    }

    /// Checks one URL (scheme, credentials, port, host, literal address). Names are checked when
    /// they are resolved.
    pub fn check_url(&self, url: &Url) -> std::result::Result<(), BlockReason> {
        match url.scheme() {
            "https" if self.https => {}
            "http" if self.http => {}
            _ => return Err(BlockReason::Scheme),
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(BlockReason::Userinfo);
        }
        let port = url.port_or_known_default().ok_or(BlockReason::Port)?;
        if !self.ports.contains(&port) {
            return Err(BlockReason::Port);
        }
        match url.host() {
            Some(url::Host::Domain(name)) => {
                if let Some(hosts) = &self.hosts
                    && !hosts.iter().any(|h| h.eq_ignore_ascii_case(name))
                {
                    return Err(BlockReason::Host);
                }
                Ok(())
            }
            Some(url::Host::Ipv4(v4)) => self.check_literal(IpAddr::V4(v4)),
            Some(url::Host::Ipv6(v6)) => self.check_literal(IpAddr::V6(v6)),
            None => Err(BlockReason::InvalidUrl),
        }
    }

    fn check_literal(&self, ip: IpAddr) -> std::result::Result<(), BlockReason> {
        if !self.address_allowed(ip) {
            return Err(BlockReason::Address(ip));
        }
        if self.hosts.is_some() || (!self.ip_literals && !self.exempt.contains(&ip)) {
            return Err(BlockReason::Host);
        }
        Ok(())
    }
}

/// The resolver the guarded transport connects with: it resolves once per connection, refuses
/// the whole answer if any address is refused, and hands exactly the checked addresses to the
/// connector.
#[derive(Debug)]
struct CheckingResolver {
    inner: Arc<dyn Resolver>,
    policy: Arc<GuardPolicy>,
}

/// The error the checking resolver returns; found again in the transport error's source chain.
#[derive(Debug)]
struct Refused(BlockReason);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "refused: {}", self.0)
    }
}

impl std::error::Error for Refused {}

impl reqwest::dns::Resolve for CheckingResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let inner = Arc::clone(&self.inner);
        let policy = Arc::clone(&self.policy);
        Box::pin(async move {
            let host = name.as_str();
            let addrs = inner
                .resolve(host)
                .await
                .map_err(|_| -> BoxError { Box::new(Refused(BlockReason::Unresolvable)) })?;
            if addrs.is_empty() {
                return Err(Box::new(Refused(BlockReason::Unresolvable)) as BoxError);
            }
            if let Some(bad) = addrs.iter().find(|ip| !policy.address_allowed(**ip)) {
                return Err(Box::new(Refused(BlockReason::Address(*bad))) as BoxError);
            }
            let addrs: reqwest::dns::Addrs =
                Box::new(addrs.into_iter().map(|ip| SocketAddr::new(ip, 0)));
            Ok(addrs)
        })
    }
}

/// A resolver adapter for the provider client (no checks).
#[derive(Debug)]
pub(crate) struct PlainResolver(pub Arc<dyn Resolver>);

impl reqwest::dns::Resolve for PlainResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let inner = Arc::clone(&self.0);
        Box::pin(async move {
            let addrs = inner.resolve(name.as_str()).await?;
            let addrs: reqwest::dns::Addrs =
                Box::new(addrs.into_iter().map(|ip| SocketAddr::new(ip, 0)));
            Ok(addrs)
        })
    }
}

/// The block reason in a transport error's source chain, if the checking resolver refused.
pub(crate) fn find_block(error: &(dyn std::error::Error + 'static)) -> Option<BlockReason> {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(e) = current {
        if let Some(Refused(reason)) = e.downcast_ref::<Refused>() {
            return Some(reason.clone());
        }
        current = e.source();
    }
    None
}

/// The client for user-supplied URLs (see the module docs).
#[derive(Clone, Debug)]
pub struct GuardedClient {
    inner: reqwest::Client,
    policy: Arc<GuardPolicy>,
    shutdown: dima_core::Shutdown,
    observer: Arc<dyn Observer>,
}

/// What the observer is told about a guarded fetch instead of its URL: the provider is
/// `"guarded"` and the template is the class of the host the caller asked for.
pub mod host_class {
    /// A name on the policy's host list.
    pub const LISTED: &str = "listed-host";
    /// Any public name (the policy has no host list).
    pub const PUBLIC_NAME: &str = "public-name";
    /// An IP literal.
    pub const IP_LITERAL: &str = "ip-literal";
    /// The URL did not parse.
    pub const INVALID: &str = "invalid";
}

fn host_class(policy: &GuardPolicy, url: Option<&Url>) -> &'static str {
    match url.and_then(Url::host) {
        Some(url::Host::Domain(_)) if policy.hosts.is_some() => host_class::LISTED,
        Some(url::Host::Domain(_)) => host_class::PUBLIC_NAME,
        Some(url::Host::Ipv4(_) | url::Host::Ipv6(_)) => host_class::IP_LITERAL,
        None => host_class::INVALID,
    }
}

const INFO_PROVIDER: &str = "guarded";
const INFO_TEMPLATE: &str = "<user url>";

impl GuardedClient {
    /// A client with the system resolver.
    pub fn new(policy: GuardPolicy, shutdown: dima_core::Shutdown) -> Result<Self> {
        Self::with_resolver(policy, Arc::new(SystemResolver), shutdown)
    }

    /// A client with the given resolver.
    pub fn with_resolver(
        policy: GuardPolicy,
        resolver: Arc<dyn Resolver>,
        shutdown: dima_core::Shutdown,
    ) -> Result<Self> {
        let policy = Arc::new(policy);
        let inner = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .referer(false)
            .pool_max_idle_per_host(0)
            .connect_timeout(policy.connect_timeout)
            .dns_resolver(Arc::new(CheckingResolver {
                inner: resolver,
                policy: Arc::clone(&policy),
            }))
            .build()
            .map_err(|error| Error::from_reqwest(info(Method::GET), error))?;
        Ok(Self {
            inner,
            policy,
            shutdown,
            observer: Arc::new(NoopObserver),
        })
    }

    /// Reports every fetch to `observer`: provider `"guarded"`, the method, and a
    /// [`host_class`] as the template; never the URL, its host or its path.
    pub fn with_observer(mut self, observer: Arc<dyn Observer>) -> Self {
        self.observer = observer;
        self
    }

    /// Starts a GET of `url`.
    pub fn get(&self, url: &str) -> GuardedRequest<'_> {
        self.request(Method::GET, url)
    }

    /// Starts a request of `url`.
    pub fn request(&self, method: Method, url: &str) -> GuardedRequest<'_> {
        GuardedRequest {
            client: self,
            method,
            url: url.to_owned(),
            headers: HeaderMap::new(),
            body: Body::Empty,
            timeout: self.policy.timeout,
            max_bytes: self.policy.max_bytes,
            idle_timeout: self.policy.idle_timeout,
            invalid: None,
        }
    }
}

fn info(method: Method) -> RequestInfo {
    RequestInfo::new(INFO_PROVIDER, method, INFO_TEMPLATE)
}

/// A request through the [`GuardedClient`].
pub struct GuardedRequest<'a> {
    client: &'a GuardedClient,
    method: Method,
    url: String,
    headers: HeaderMap,
    body: Body,
    timeout: Duration,
    max_bytes: u64,
    idle_timeout: Duration,
    invalid: Option<&'static str>,
}

/// Method, header names and body length: never the URL (a user's URL can hold anything), a
/// header value or the body.
impl std::fmt::Debug for GuardedRequest<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GuardedRequest")
            .field("method", &self.method.as_str())
            .field("url", &INFO_TEMPLATE)
            .field("headers", &crate::redact::HeaderNames(&self.headers))
            .field("body", &self.body)
            .finish_non_exhaustive()
    }
}

impl GuardedRequest<'_> {
    /// Adds a header (dropped on a hop to another origin).
    pub fn header(mut self, name: &str, value: &str) -> Self {
        match (HeaderName::try_from(name), HeaderValue::try_from(value)) {
            (Ok(name), Ok(value)) => {
                self.headers.append(name, value);
            }
            _ => self.invalid = Some("header name or value"),
        }
        self
    }

    /// Sends these bytes as the body (re-sent only on a 307/308 to the same origin).
    pub fn body(mut self, bytes: impl Into<bytes::Bytes>) -> Self {
        self.body = Body::Bytes(bytes.into());
        self
    }

    /// The deadline for the whole fetch.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The body limit.
    pub fn max_bytes(mut self, max: u64) -> Self {
        self.max_bytes = max;
        self
    }

    /// The idle timeout between body chunks.
    pub fn idle_timeout(mut self, timeout: Duration) -> Self {
        self.idle_timeout = timeout;
        self
    }

    /// Sends the request, following and re-checking redirects.
    pub async fn send(self) -> Result<Response> {
        let parsed = parse(&self.url);
        let class = host_class(&self.client.policy, parsed.as_ref().ok());
        let bytes_sent = match &self.body {
            Body::Bytes(bytes) => Some(bytes.len() as u64),
            _ => Some(0),
        };
        let mut end = EndGuard::start(
            Arc::clone(&self.client.observer),
            INFO_PROVIDER,
            &self.method,
            class,
            1,
            bytes_sent,
        );
        match self.fetch(parsed).await {
            Ok((response, info, limits, cancel)) => {
                end.set_status(response.status().as_u16());
                Ok(
                    Response::new(response, info, QueryShown::NamesOnly, limits, cancel)
                        .with_attempt_state(1, false, false, Some(end), None),
                )
            }
            Err(error) => {
                end.fail(error.class());
                Err(error)
            }
        }
    }

    /// The hops of one fetch, up to the final response.
    async fn fetch(
        self,
        parsed: std::result::Result<Url, BlockReason>,
    ) -> Result<(reqwest::Response, RequestInfo, Limits, Cancel)> {
        let mut method = self.method;
        if let Some(reason) = self.invalid {
            return Err(Error::Invalid {
                info: info(method),
                reason,
            });
        }
        let deadline = tokio::time::Instant::now() + self.timeout;
        let mut url = parsed.map_err(|reason| Error::Blocked {
            info: info(method.clone()),
            reason,
        })?;
        let origin = url.origin();
        let mut headers = self.headers;
        let mut body = self.body;
        let policy = &self.client.policy;
        let cancel = Cancel::new(self.client.shutdown.clone(), None);
        let mut hop: u8 = 0;
        loop {
            policy.check_url(&url).map_err(|reason| Error::Blocked {
                info: info(method.clone()),
                reason,
            })?;
            if url.origin() != origin {
                headers.clear();
            }
            let mut builder = self
                .client
                .inner
                .request(method.clone(), url.clone())
                .headers(headers.clone());
            if let Body::Bytes(bytes) = &body {
                builder = builder.body(bytes.clone());
            }
            let response = client::await_with(builder.send(), deadline, None, &cancel, || {
                info(method.clone())
            })
            .await?;
            let status = response.status();
            if status.is_redirection()
                && let Some(location) = response.headers().get(http::header::LOCATION)
            {
                if hop >= policy.max_redirects {
                    return Err(Error::Blocked {
                        info: info(method),
                        reason: BlockReason::TooManyRedirects,
                    });
                }
                let next = location
                    .to_str()
                    .ok()
                    .and_then(|l| url.join(l).ok())
                    .filter(|u| !has_zone(u.as_str()))
                    .ok_or_else(|| Error::Blocked {
                        info: info(method.clone()),
                        reason: BlockReason::BadRedirect,
                    })?;
                drop(response);
                let to_get = redirect_to_get(status, &method);
                let carries_body = !to_get && !matches!(body, Body::Empty);
                check_hop(&url, &origin, &next, carries_body).map_err(|reason| Error::Blocked {
                    info: info(method.clone()),
                    reason,
                })?;
                if to_get {
                    method = Method::GET;
                    body = Body::Empty;
                    for name in client::BODY_HEADERS {
                        headers.remove(name);
                    }
                }
                url = next;
                hop += 1;
                continue;
            }
            let limits = Limits {
                max_bytes: self.max_bytes,
                idle: self.idle_timeout,
                deadline,
            };
            return Ok((response, info(method), limits, cancel));
        }
    }
}

/// Whether a redirect with `status` turns `method` into GET: 301/302 turn POST into GET and 303
/// turns everything but HEAD into GET, as fetch does.
pub(crate) fn redirect_to_get(status: StatusCode, method: &Method) -> bool {
    (matches!(status, StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND) && *method == Method::POST)
        || (status == StatusCode::SEE_OTHER && *method != Method::HEAD)
}

/// The two rules every followed redirect obeys, in the guarded client and the provider client
/// alike: never from https to plain http, and never with a request body to an origin other than
/// `origin`, the one the caller addressed (a 307 or 308 keeps the body; a key inside a JSON body
/// must not reach another host, scheme or port).
pub(crate) fn check_hop(
    current: &Url,
    origin: &url::Origin,
    next: &Url,
    carries_body: bool,
) -> std::result::Result<(), BlockReason> {
    if current.scheme() == "https" && next.scheme() != "https" {
        return Err(BlockReason::InsecureRedirect);
    }
    if carries_body && next.origin() != *origin {
        return Err(BlockReason::BodyToOtherOrigin);
    }
    Ok(())
}

/// Whether the authority holds an IPv6 zone id (`%25` inside brackets).
fn has_zone(raw: &str) -> bool {
    let authority = raw
        .split_once("//")
        .map_or(raw, |(_, rest)| rest)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    authority.contains('[') && authority.contains('%')
}

fn parse(raw: &str) -> std::result::Result<Url, BlockReason> {
    if has_zone(raw) {
        return Err(BlockReason::InvalidUrl);
    }
    Url::parse(raw).map_err(|_| BlockReason::InvalidUrl)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(text: &str) -> bool {
        refused_range(text.parse().unwrap()).is_some()
    }

    #[test]
    fn refused_and_public_addresses() {
        for ip in [
            "0.0.0.0",
            "10.1.2.3",
            "100.64.0.1",
            "100.100.100.200",
            "127.0.0.1",
            "127.255.255.254",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.192",
            "192.0.2.1",
            "192.88.99.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.19.255.255",
            "198.51.100.7",
            "203.0.113.9",
            "224.0.0.1",
            "239.255.255.250",
            "240.0.0.1",
            "255.255.255.255",
            "168.63.129.16",
            "::",
            "::1",
            "::127.0.0.1",
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
            "::ffff:169.254.169.254",
            "::ffff:10.0.0.1",
            "64:ff9b::7f00:1",
            "64:ff9b::808:808",
            "64:ff9b:1::1",
            "100::1",
            "2001::1",
            "2001:2::1",
            "2001:db8::1",
            "2002:7f00:1::",
            "3fff::1",
            "5f00::1",
            "fc00::1",
            "fd00:ec2::254",
            "fe80::1",
            "fec0::1",
            "ff02::1",
        ] {
            assert!(refused(ip), "{ip} must be refused");
        }
        for ip in [
            "1.1.1.1",
            "8.8.8.8",
            "93.184.215.14",
            "100.63.255.255",
            "100.128.0.0",
            "172.15.255.255",
            "172.32.0.0",
            "192.0.1.1",
            "198.17.255.255",
            "223.255.255.255",
            "168.63.129.17",
            "::ffff:8.8.8.8",
            "2606:4700:4700::1111",
            "2a00:1450:4001::200e",
        ] {
            assert!(!refused(ip), "{ip} must be allowed");
        }
    }

    #[test]
    fn literal_hosts_in_every_notation() {
        let policy = GuardPolicy::any_public_host().allow_ip_literals(true);
        let blocked = |raw: &str| parse(raw).and_then(|url| policy.check_url(&url)).err();
        let loopback = Some(BlockReason::Address("127.0.0.1".parse().unwrap()));
        for raw in [
            "https://127.0.0.1/",
            "https://2130706433/",
            "https://0x7f000001/",
            "https://0x7f.0.0.1/",
            "https://0177.0.0.1/",
            "https://0177.1/",
            "https://127.1/",
            "https://127.0.1/",
            "https://0x7F.1/",
        ] {
            assert_eq!(blocked(raw), loopback, "{raw}");
        }
        assert_eq!(
            blocked("https://[::ffff:127.0.0.1]/"),
            Some(BlockReason::Address("::ffff:127.0.0.1".parse().unwrap()))
        );
        assert_eq!(
            blocked("https://[::1]/"),
            Some(BlockReason::Address("::1".parse().unwrap()))
        );
        assert_eq!(
            blocked("https://[0:0:0:0:0:ffff:a9fe:a9fe]/"),
            Some(BlockReason::Address(
                "::ffff:169.254.169.254".parse().unwrap()
            ))
        );
        assert_eq!(
            blocked("https://[fe80::1%25eth0]/"),
            Some(BlockReason::InvalidUrl)
        );
        assert_eq!(
            blocked("https://[fe80::1%eth0]/"),
            Some(BlockReason::InvalidUrl)
        );
        assert_eq!(
            blocked("https://0/"),
            Some(BlockReason::Address("0.0.0.0".parse().unwrap()))
        );
        assert_eq!(blocked("https://8.8.8.8/"), None);
        assert_eq!(blocked("https://[2606:4700:4700::1111]/"), None);
        // Literals are refused outright unless enabled, and always with a host list.
        let strict = GuardPolicy::any_public_host();
        assert_eq!(
            strict.check_url(&Url::parse("https://8.8.8.8/").unwrap()),
            Err(BlockReason::Host)
        );
    }

    #[test]
    fn redirects_never_downgrade_and_never_carry_a_body_elsewhere() {
        let url = |raw: &str| Url::parse(raw).unwrap();
        let start = url("https://a.test/start");
        let origin = start.origin();
        // A downgrade is refused with or without a body, even to the same host.
        for body in [false, true] {
            assert_eq!(
                check_hop(&start, &origin, &url("http://a.test/x"), body),
                Err(BlockReason::InsecureRedirect)
            );
        }
        // A body stays on the addressed origin: host, scheme and port all count.
        for other in ["https://b.test/x", "https://a.test:8443/x"] {
            assert_eq!(
                check_hop(&start, &origin, &url(other), true),
                Err(BlockReason::BodyToOtherOrigin),
                "{other}"
            );
            assert_eq!(check_hop(&start, &origin, &url(other), false), Ok(()));
        }
        assert_eq!(
            check_hop(&start, &origin, &url("https://a.test/kept"), true),
            Ok(())
        );
        // A hop back to the addressed origin after leaving it is still checked against it.
        let away = url("https://b.test/x");
        assert_eq!(
            check_hop(&away, &origin, &url("https://a.test/back"), true),
            Ok(())
        );
        // Plain http to plain http is the policy's business, not this rule's.
        let plain = url("http://a.test/");
        assert_eq!(
            check_hop(&plain, &plain.origin(), &url("http://a.test/y"), true),
            Ok(())
        );
        // Which redirects drop the body.
        assert!(redirect_to_get(StatusCode::FOUND, &Method::POST));
        assert!(!redirect_to_get(StatusCode::FOUND, &Method::PUT));
        assert!(redirect_to_get(StatusCode::SEE_OTHER, &Method::PUT));
        assert!(!redirect_to_get(StatusCode::SEE_OTHER, &Method::HEAD));
        assert!(!redirect_to_get(
            StatusCode::TEMPORARY_REDIRECT,
            &Method::POST
        ));
    }

    #[test]
    fn scheme_port_userinfo_and_host_list() {
        let policy =
            GuardPolicy::https_hosts(["cdn.streamelements.com", "static.streamelements.com"]);
        let check = |raw: &str| policy.check_url(&Url::parse(raw).unwrap());
        assert_eq!(check("https://cdn.streamelements.com/a.png"), Ok(()));
        assert_eq!(check("https://CDN.StreamElements.com:443/a.png"), Ok(()));
        assert_eq!(
            check("http://cdn.streamelements.com/a.png"),
            Err(BlockReason::Scheme)
        );
        assert_eq!(
            check("ftp://cdn.streamelements.com/a.png"),
            Err(BlockReason::Scheme)
        );
        assert_eq!(check("file:///etc/passwd"), Err(BlockReason::Scheme));
        assert_eq!(
            check("https://cdn.streamelements.com:8443/"),
            Err(BlockReason::Port)
        );
        assert_eq!(
            check("https://u:p@cdn.streamelements.com/"),
            Err(BlockReason::Userinfo)
        );
        assert_eq!(
            check("https://u@cdn.streamelements.com/"),
            Err(BlockReason::Userinfo)
        );
        assert_eq!(check("https://evil.com/"), Err(BlockReason::Host));
        assert_eq!(
            check("https://cdn.streamelements.com.evil.com/"),
            Err(BlockReason::Host)
        );
        assert_eq!(
            check("https://cdn.streamelements.com./"),
            Err(BlockReason::Host)
        );
        assert_eq!(check("https://93.184.215.14/"), Err(BlockReason::Host));
    }
}
