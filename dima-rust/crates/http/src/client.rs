//! The shared client and request building.

use crate::error::{Error, RequestInfo, Result, TimeoutKind};
use crate::guard::{BoxFuture, PlainResolver, Resolver};
use crate::observe::{EndGuard, NoopObserver, Observer, TraceInjector};
use crate::path::Path;
use crate::provider::{DEFAULT_CONNECT_TIMEOUT, Provider, Redirects};
use crate::response::{Limits, Response};
use crate::retry::{Context, Decision, Outcome, RetryPolicy, StopReason};
use bytes::Bytes;
use dima_core::{Clock, Random, Shutdown, SystemClock, SystemRandom};
use http::header::{AUTHORIZATION, CONTENT_TYPE, LOCATION};
use http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::OwnedSemaphorePermit;
use tokio::time::Instant;
use url::Url;

/// What a credential refresh produced.
#[derive(Clone, Debug)]
pub enum Refresh {
    /// A new value: the request is retried with it.
    Rotated(HeaderValue),
    /// No new value, but the request is retried anyway with the same one (the reference's app
    /// and bot token paths).
    Retry,
    /// Stop: the 401 response is returned and [`Response::auth_refresh_unavailable`] is set (the
    /// reference's streamer path, which reports 503).
    Stop,
}

/// A credential that can be refreshed when the server answers 401 (see
/// [`RetryPolicy::refresh_unauthorized`]).
pub trait Credential: Send + Sync + std::fmt::Debug {
    /// Called once per 401 before the retry wait, with the attempt number and the value the
    /// server rejected.
    fn refresh<'a>(&'a self, attempt: u32, rejected: &'a HeaderValue) -> BoxFuture<'a, Refresh>;
}

/// Shutdown signals a wait takes part in: the client's, and optionally the request's own.
#[derive(Clone, Debug)]
pub(crate) struct Cancel {
    main: Shutdown,
    extra: Option<Shutdown>,
}

impl Cancel {
    pub(crate) fn new(main: Shutdown, extra: Option<Shutdown>) -> Self {
        Self { main, extra }
    }

    pub(crate) async fn wait(&self) {
        match &self.extra {
            Some(extra) => tokio::select! {
                () = self.main.wait() => {}
                () = extra.wait() => {}
            },
            None => self.main.wait().await,
        }
    }
}

/// Awaits a send under a deadline, an optional headers deadline and shutdown.
pub(crate) async fn await_with(
    send: impl Future<Output = reqwest::Result<reqwest::Response>>,
    deadline: Instant,
    headers_deadline: Option<Instant>,
    cancel: &Cancel,
    info: &RequestInfo,
) -> Result<reqwest::Response> {
    let headers_deadline = headers_deadline.unwrap_or(deadline);
    let (kind, at) = if headers_deadline < deadline {
        (TimeoutKind::Headers, headers_deadline)
    } else {
        (TimeoutKind::Total, deadline)
    };
    tokio::select! {
        biased;
        () = cancel.wait() => Err(Error::Cancelled { info: info.clone() }),
        () = tokio::time::sleep_until(at) => Err(Error::Timeout { info: info.clone(), kind }),
        result = send => result.map_err(|error| Error::from_reqwest(info.clone(), error)),
    }
}

/// A request body.
#[derive(Debug, Default)]
pub(crate) enum Body {
    #[default]
    Empty,
    Bytes(Bytes),
    Stream(reqwest::Body),
}

/// The shared client: one connection pool for every provider. Cheap to clone.
#[derive(Clone, Debug)]
pub struct HttpClient {
    inner: Arc<ClientInner>,
}

#[derive(Debug)]
struct ClientInner {
    http: reqwest::Client,
    observer: Arc<dyn Observer>,
    trace: Option<Arc<dyn TraceInjector>>,
    clock: Arc<dyn Clock>,
    random: Arc<dyn Random>,
    shutdown: Shutdown,
}

/// Builds an [`HttpClient`].
#[derive(Debug)]
pub struct HttpClientBuilder {
    connect_timeout: Duration,
    pool_idle_timeout: Duration,
    pool_max_idle_per_host: usize,
    resolver: Option<Arc<dyn Resolver>>,
    observer: Arc<dyn Observer>,
    trace: Option<Arc<dyn TraceInjector>>,
    clock: Arc<dyn Clock>,
    random: Arc<dyn Random>,
    shutdown: Shutdown,
}

impl HttpClient {
    /// Starts a client.
    pub fn builder() -> HttpClientBuilder {
        HttpClientBuilder {
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            pool_idle_timeout: Duration::from_secs(90),
            pool_max_idle_per_host: 32,
            resolver: None,
            observer: Arc::new(NoopObserver),
            trace: None,
            clock: Arc::new(SystemClock),
            random: Arc::new(SystemRandom),
            shutdown: Shutdown::new(),
        }
    }

    /// Starts a request to `provider` at `path` (relative to its base URL).
    pub fn request<'a>(
        &'a self,
        provider: &'a Provider,
        method: Method,
        path: impl Into<Path>,
    ) -> RequestBuilder<'a> {
        RequestBuilder::new(self, provider, method, path.into())
    }

    /// A GET request.
    pub fn get<'a>(&'a self, provider: &'a Provider, path: impl Into<Path>) -> RequestBuilder<'a> {
        self.request(provider, Method::GET, path)
    }

    /// A POST request.
    pub fn post<'a>(&'a self, provider: &'a Provider, path: impl Into<Path>) -> RequestBuilder<'a> {
        self.request(provider, Method::POST, path)
    }

    /// The client's shutdown token.
    pub fn shutdown(&self) -> &Shutdown {
        &self.inner.shutdown
    }
}

impl HttpClientBuilder {
    /// The connect timeout for every connection (name resolution, TCP and TLS).
    pub fn connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    /// How long idle pooled connections are kept.
    pub fn pool_idle_timeout(mut self, timeout: Duration) -> Self {
        self.pool_idle_timeout = timeout;
        self
    }

    /// Idle connections kept per host.
    pub fn pool_max_idle_per_host(mut self, n: usize) -> Self {
        self.pool_max_idle_per_host = n;
        self
    }

    /// A resolver instead of the system's (tests).
    pub fn resolver(mut self, resolver: Arc<dyn Resolver>) -> Self {
        self.resolver = Some(resolver);
        self
    }

    /// The telemetry observer.
    pub fn observer(mut self, observer: Arc<dyn Observer>) -> Self {
        self.observer = observer;
        self
    }

    /// The trace header hook for internal providers.
    pub fn trace_injector(mut self, trace: Arc<dyn TraceInjector>) -> Self {
        self.trace = Some(trace);
        self
    }

    /// The wall clock (for `Ratelimit-Reset` and HTTP-date `Retry-After`).
    pub fn clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    /// The randomness for retry jitter.
    pub fn random(mut self, random: Arc<dyn Random>) -> Self {
        self.random = random;
        self
    }

    /// The shutdown token every wait takes part in.
    pub fn shutdown(mut self, shutdown: Shutdown) -> Self {
        self.shutdown = shutdown;
        self
    }

    /// Builds the client. Proxy environment variables are never read, nothing is retried or
    /// redirected below this crate, and no `Referer` is sent.
    pub fn build(self) -> Result<HttpClient> {
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .referer(false)
            .connect_timeout(self.connect_timeout)
            .pool_idle_timeout(self.pool_idle_timeout)
            .pool_max_idle_per_host(self.pool_max_idle_per_host)
            .tcp_nodelay(true);
        if let Some(resolver) = self.resolver {
            builder = builder.dns_resolver(Arc::new(PlainResolver(resolver)));
        }
        let http = builder.build().map_err(|error| {
            Error::from_reqwest(RequestInfo::new("client", Method::GET, "/"), error)
        })?;
        Ok(HttpClient {
            inner: Arc::new(ClientInner {
                http,
                observer: self.observer,
                trace: self.trace,
                clock: self.clock,
                random: self.random,
                shutdown: self.shutdown,
            }),
        })
    }
}

/// A request being built. Nothing is sent until [`RequestBuilder::send`].
#[derive(Debug)]
#[must_use = "a request does nothing until it is sent"]
pub struct RequestBuilder<'a> {
    client: &'a HttpClient,
    provider: &'a Provider,
    method: Method,
    template: &'static str,
    url: Option<Url>,
    headers: HeaderMap,
    body: Body,
    credential: Option<(Arc<dyn Credential>, HeaderName, HeaderValue)>,
    timeout: Duration,
    headers_timeout: Option<Duration>,
    idle_timeout: Duration,
    max_bytes: u64,
    retry: Option<RetryPolicy>,
    idempotent: Option<bool>,
    shutdown: Option<Shutdown>,
    invalid: Option<&'static str>,
}

impl<'a> RequestBuilder<'a> {
    fn new(client: &'a HttpClient, provider: &'a Provider, method: Method, path: Path) -> Self {
        let p = &provider.0;
        let base = p.base.path().trim_end_matches('/');
        let mut url = p.base.clone();
        let mut joined = String::with_capacity(base.len() + path.as_str().len());
        joined.push_str(base);
        joined.push_str(path.as_str());
        url.set_path(&joined);
        Self {
            client,
            provider,
            method,
            template: path.template_str(),
            url: Some(url),
            headers: HeaderMap::new(),
            body: Body::Empty,
            credential: None,
            timeout: p.timeout,
            headers_timeout: p.headers_timeout,
            idle_timeout: p.idle_timeout,
            max_bytes: p.max_bytes,
            retry: None,
            idempotent: None,
            shutdown: None,
            invalid: None,
        }
    }

    fn mark_invalid(mut self, reason: &'static str) -> Self {
        self.invalid.get_or_insert(reason);
        self
    }

    /// Appends query parameters, encoded as `URLSearchParams` does.
    pub fn query<K: AsRef<str>, V: AsRef<str>>(mut self, pairs: &[(K, V)]) -> Self {
        if let Some(url) = &mut self.url {
            let mut query = url.query_pairs_mut();
            for (k, v) in pairs {
                query.append_pair(k.as_ref(), v.as_ref());
            }
        }
        self
    }

    /// Sets the query string as given (characters a URL cannot hold are percent-encoded; `&`
    /// and `=` are kept), for call sites whose reference concatenates the query by hand.
    pub fn raw_query(mut self, query: &str) -> Self {
        if let Some(url) = &mut self.url {
            url.set_query(Some(query));
        }
        self
    }

    /// Adds a header (replacing a provider default of the same name).
    pub fn header(mut self, name: &str, value: &str) -> Self {
        match (HeaderName::try_from(name), HeaderValue::try_from(value)) {
            (Ok(name), Ok(mut value)) => {
                if crate::redact::is_sensitive(&name) {
                    value.set_sensitive(true);
                }
                self.headers.insert(name, value);
                self
            }
            _ => self.mark_invalid("header name or value"),
        }
    }

    /// Adds a header whose value is a secret.
    pub fn secret_header(self, name: &str, value: &dima_core::SecretString) -> Self {
        match (
            HeaderName::try_from(name),
            HeaderValue::try_from(value.expose()),
        ) {
            (Ok(name), Ok(mut value)) => {
                value.set_sensitive(true);
                let mut this = self;
                this.headers.insert(name, value);
                this
            }
            _ => self.mark_invalid("header name or value"),
        }
    }

    /// `Authorization: Bearer <token>`.
    pub fn bearer(self, token: &dima_core::SecretString) -> Self {
        match HeaderValue::try_from(format!("Bearer {}", token.expose())) {
            Ok(mut value) => {
                value.set_sensitive(true);
                let mut this = self;
                this.headers.insert(AUTHORIZATION, value);
                this
            }
            Err(_) => self.mark_invalid("bearer token"),
        }
    }

    /// Sends `value` in header `name` and refreshes it through `credential` on 401 when the
    /// retry policy asks for it.
    pub fn credential(
        mut self,
        name: HeaderName,
        mut value: HeaderValue,
        credential: Arc<dyn Credential>,
    ) -> Self {
        value.set_sensitive(true);
        self.credential = Some((credential, name, value));
        self
    }

    fn with_body(mut self, body: Bytes, content_type: &'static str) -> Self {
        self.body = Body::Bytes(body);
        if !self.headers.contains_key(CONTENT_TYPE) {
            self.headers
                .insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
        }
        self
    }

    /// A JSON body (`serde_json` bytes) with `Content-Type: application/json`.
    pub fn json<T: Serialize + ?Sized>(self, value: &T) -> Self {
        match serde_json::to_vec(value) {
            Ok(bytes) => self.with_body(Bytes::from(bytes), "application/json"),
            Err(_) => self.mark_invalid("json body"),
        }
    }

    /// A JSON body written exactly as JavaScript's `JSON.stringify` would (for bodies whose bytes
    /// are signed or matter to a cache).
    pub fn json_js<T: Serialize + ?Sized>(self, value: &T) -> Self {
        match dima_text::to_js_json_from(value) {
            Ok(bytes) => self.with_body(Bytes::from(bytes), "application/json"),
            Err(_) => self.mark_invalid("json body"),
        }
    }

    /// An `application/x-www-form-urlencoded` body, encoded as `URLSearchParams` does.
    pub fn form<K: AsRef<str>, V: AsRef<str>>(self, pairs: &[(K, V)]) -> Self {
        let mut out = url::form_urlencoded::Serializer::new(String::new());
        for (k, v) in pairs {
            out.append_pair(k.as_ref(), v.as_ref());
        }
        self.with_body(
            Bytes::from(out.finish()),
            "application/x-www-form-urlencoded",
        )
    }

    /// These exact bytes as the body (no `Content-Type` is added; set one with
    /// [`RequestBuilder::header`]). MessagePack and other formats are built by their clients.
    pub fn body(mut self, bytes: impl Into<Bytes>) -> Self {
        self.body = Body::Bytes(bytes.into());
        self
    }

    /// A streamed body. It cannot be replayed, so the request is never retried after it was
    /// sent.
    pub fn body_stream(mut self, body: reqwest::Body) -> Self {
        self.body = Body::Stream(body);
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

    /// The body limit.
    pub fn max_bytes(mut self, max: u64) -> Self {
        self.max_bytes = max;
        self
    }

    /// The retry policy for this request (instead of the provider's).
    pub fn retry(mut self, policy: RetryPolicy) -> Self {
        self.retry = Some(policy);
        self
    }

    /// Declares whether the request is idempotent (by default: GET, HEAD, OPTIONS, TRACE, PUT
    /// and DELETE are).
    pub fn idempotent(mut self, idempotent: bool) -> Self {
        self.idempotent = Some(idempotent);
        self
    }

    /// A shutdown token for this request, in addition to the client's.
    pub fn cancel_on(mut self, shutdown: &Shutdown) -> Self {
        self.shutdown = Some(shutdown.clone());
        self
    }

    /// Sends the request, retrying as the policy says. Any status is `Ok`; use
    /// [`Response::error_for_status`] or [`RequestBuilder::send_json`] to turn a non-success
    /// status into an error.
    pub async fn send(self) -> Result<Response> {
        Sender::new(self).run().await
    }

    /// Sends, requires a 2xx status, and parses the JSON body.
    pub async fn send_json<T: serde::de::DeserializeOwned>(self) -> Result<T> {
        self.send().await?.error_for_status().await?.json().await
    }
}

fn method_is_idempotent(method: &Method) -> bool {
    matches!(
        *method,
        Method::GET | Method::HEAD | Method::OPTIONS | Method::TRACE | Method::PUT | Method::DELETE
    )
}

/// The send loop's state.
struct Sender<'a> {
    client: &'a ClientInner,
    provider: &'a Provider,
    method: Method,
    template: &'static str,
    url: Url,
    headers: HeaderMap,
    body: Body,
    credential: Option<(Arc<dyn Credential>, HeaderName, HeaderValue)>,
    timeout: Duration,
    headers_timeout: Option<Duration>,
    idle_timeout: Duration,
    max_bytes: u64,
    retry: Option<RetryPolicy>,
    idempotent: bool,
    cancel: Cancel,
    invalid: Option<&'static str>,
}

enum AttemptResult {
    Answer(reqwest::Response),
    Failed(Error),
}

impl<'a> Sender<'a> {
    fn new(request: RequestBuilder<'a>) -> Self {
        let client = &*request.client.inner;
        let idempotent = request
            .idempotent
            .unwrap_or_else(|| method_is_idempotent(&request.method));
        let (url, invalid) = match request.url {
            Some(url) => (url, request.invalid),
            None => (request.provider.0.base.clone(), Some("url")),
        };
        Self {
            client,
            provider: request.provider,
            method: request.method,
            template: request.template,
            url,
            headers: request.headers,
            body: request.body,
            credential: request.credential,
            timeout: request.timeout,
            headers_timeout: request.headers_timeout,
            idle_timeout: request.idle_timeout,
            max_bytes: request.max_bytes,
            retry: request.retry,
            idempotent,
            cancel: Cancel::new(client.shutdown.clone(), request.shutdown),
            invalid,
        }
    }

    fn info(&self) -> RequestInfo {
        RequestInfo::new(self.provider.0.name, self.method.clone(), self.template)
            .with_query(&self.url, &self.provider.0.secret_query)
    }

    async fn run(mut self) -> Result<Response> {
        if let Some(reason) = self.invalid {
            return Err(Error::Invalid {
                info: self.info(),
                reason,
            });
        }
        let provider = Arc::clone(&self.provider.0);
        let policy = self.retry.take();
        let policy = policy.as_ref().unwrap_or(&provider.retry);
        let first_started = Instant::now();
        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            let deadline = Instant::now() + self.timeout;
            let permit = match &provider.semaphore {
                Some(semaphore) => Some(self.acquire(semaphore, deadline).await?),
                None => None,
            };
            let replayable = !matches!(self.body, Body::Stream(_));
            let (result, mut end) = self.attempt(attempt, deadline).await;
            let elapsed = first_started.elapsed();
            let ctx = |refreshable| Context {
                attempt,
                idempotent: self.idempotent,
                replayable,
                refreshable,
                elapsed,
            };
            match result {
                AttemptResult::Answer(response) => {
                    let status = response.status();
                    end.set_status(status.as_u16());
                    let refreshable = self.credential.is_some();
                    let decision = if status.is_success() {
                        Decision::Stop(StopReason::NotRetryable)
                    } else {
                        policy.decide(
                            ctx(refreshable),
                            Outcome::Status {
                                status,
                                headers: response.headers(),
                            },
                            &*self.client.clock,
                            &*self.client.random,
                        )
                    };
                    let delay = match decision {
                        Decision::Retry(delay) => delay,
                        Decision::Stop(_) => {
                            return Ok(self.finish(
                                response,
                                attempt,
                                false,
                                policy.retries_status(status),
                                end,
                                permit,
                                deadline,
                            ));
                        }
                    };
                    if status == StatusCode::UNAUTHORIZED
                        && policy.refreshes_unauthorized()
                        && let Some((credential, _, value)) = &mut self.credential
                    {
                        match credential.refresh(attempt, value).await {
                            Refresh::Rotated(mut fresh) => {
                                fresh.set_sensitive(true);
                                *value = fresh;
                            }
                            Refresh::Retry => {}
                            Refresh::Stop => {
                                return Ok(self.finish(
                                    response, attempt, true, false, end, permit, deadline,
                                ));
                            }
                        }
                    }
                    drop(response);
                    drop(end);
                    drop(permit);
                    self.sleep(delay).await?;
                }
                AttemptResult::Failed(error) => {
                    end.fail(error.class());
                    drop(end);
                    drop(permit);
                    let decision = policy.decide(
                        ctx(false),
                        Outcome::Failure(error.class()),
                        &*self.client.clock,
                        &*self.client.random,
                    );
                    match decision {
                        Decision::Retry(delay) => self.sleep(delay).await?,
                        Decision::Stop(_) if attempt > 1 => {
                            return Err(Error::RetriesExhausted {
                                attempts: attempt,
                                last: Box::new(error),
                            });
                        }
                        Decision::Stop(_) => return Err(error),
                    }
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn finish(
        &self,
        response: reqwest::Response,
        attempts: u32,
        refresh_unavailable: bool,
        retried_status: bool,
        end: EndGuard,
        permit: Option<OwnedSemaphorePermit>,
        deadline: Instant,
    ) -> Response {
        let limits = Limits {
            max_bytes: self.max_bytes,
            idle: self.idle_timeout,
            deadline,
        };
        Response::new(
            response,
            RequestInfo::new(self.provider.0.name, self.method.clone(), self.template),
            &self.provider.0.secret_query,
            limits,
            self.cancel.clone(),
        )
        .with_attempt_state(attempts, refresh_unavailable, retried_status, end, permit)
    }

    async fn acquire(
        &self,
        semaphore: &Arc<tokio::sync::Semaphore>,
        deadline: Instant,
    ) -> Result<OwnedSemaphorePermit> {
        tokio::select! {
            biased;
            () = self.cancel.wait() => Err(Error::Cancelled { info: self.info() }),
            () = tokio::time::sleep_until(deadline) => Err(Error::Timeout { info: self.info(), kind: TimeoutKind::Queue }),
            permit = Arc::clone(semaphore).acquire_owned() => permit.map_err(|_| Error::Cancelled { info: self.info() }),
        }
    }

    async fn sleep(&self, delay: Duration) -> Result<()> {
        tokio::select! {
            biased;
            () = self.cancel.wait() => Err(Error::Cancelled { info: self.info() }),
            () = tokio::time::sleep(delay) => Ok(()),
        }
    }

    /// One attempt, following same-origin redirects when the provider allows them.
    async fn attempt(&mut self, attempt: u32, deadline: Instant) -> (AttemptResult, EndGuard) {
        let bytes_sent = match &self.body {
            Body::Empty => Some(0),
            Body::Bytes(bytes) => Some(bytes.len() as u64),
            Body::Stream(_) => None,
        };
        let end = EndGuard::start(
            Arc::clone(&self.client.observer),
            self.provider.0.name,
            &self.method,
            self.template,
            attempt,
            bytes_sent,
        );
        let headers_deadline = self.headers_timeout.map(|t| Instant::now() + t);
        let mut url = self.url.clone();
        let mut method = self.method.clone();
        let mut hops: u8 = 0;
        loop {
            let headers = self.headers_for_attempt();
            let mut builder = self
                .client
                .http
                .request(method.clone(), url.clone())
                .headers(headers);
            match &mut self.body {
                Body::Empty => {}
                Body::Bytes(bytes) => builder = builder.body(bytes.clone()),
                Body::Stream(_) => {
                    if let Body::Stream(stream) = std::mem::take(&mut self.body) {
                        builder = builder.body(stream);
                    }
                    // The stream is consumed: a later attempt or hop has no body to send.
                    self.body = Body::Stream(reqwest::Body::from(Bytes::new()));
                }
            }
            let info = self.info();
            let response = match await_with(
                builder.send(),
                deadline,
                headers_deadline,
                &self.cancel,
                &info,
            )
            .await
            {
                Ok(response) => response,
                Err(error) => return (AttemptResult::Failed(error), end),
            };
            let status = response.status();
            if !status.is_redirection() || !response.headers().contains_key(LOCATION) {
                return (AttemptResult::Answer(response), end);
            }
            let redirect = Error::Redirect {
                info,
                status: status.as_u16(),
            };
            let max = match self.provider.0.redirects {
                Redirects::Manual => return (AttemptResult::Answer(response), end),
                Redirects::Error => return (AttemptResult::Failed(redirect), end),
                Redirects::SameOrigin { max } => max,
            };
            let next = response
                .headers()
                .get(LOCATION)
                .and_then(|l| l.to_str().ok())
                .and_then(|l| url.join(l).ok());
            let replay_ok = !matches!(self.body, Body::Stream(_))
                || !matches!(
                    status,
                    StatusCode::TEMPORARY_REDIRECT | StatusCode::PERMANENT_REDIRECT
                );
            match next {
                Some(next) if hops < max && next.origin() == url.origin() && replay_ok => {
                    let to_get =
                        (matches!(status, StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND)
                            && method == Method::POST)
                            || (status == StatusCode::SEE_OTHER && method != Method::HEAD);
                    if to_get {
                        method = Method::GET;
                        self.body = Body::Empty;
                        self.headers.remove(CONTENT_TYPE);
                    }
                    url = next;
                    hops += 1;
                }
                _ => return (AttemptResult::Failed(redirect), end),
            }
        }
    }

    fn headers_for_attempt(&self) -> HeaderMap {
        let provider = &self.provider.0;
        let mut headers = provider.headers.clone();
        headers.extend(self.headers.clone());
        if let Some((_, name, value)) = &self.credential {
            headers.insert(name.clone(), value.clone());
        }
        if provider.internal
            && let Some(trace) = &self.client.trace
        {
            trace.inject(provider.name, &mut headers);
        }
        headers
    }
}
