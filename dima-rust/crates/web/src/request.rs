//! The request as a handler sees it (`req` in Express), plus the response headers set so far.

use std::borrow::Cow;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;
use http::header::{HeaderMap, HeaderName, HeaderValue};
use http::{Extensions, Method, Version};
use serde::de::DeserializeOwned;
use serde_json::Value;

use tokio_util::sync::CancellationToken;

use crate::Body;
use crate::error::Error;
use crate::exchange::{MatchedRoute, RouteSlot, TraceContext};
use crate::path::Params;
use crate::qs;

/// The peer address of the connection, inserted into request extensions by [`crate::serve`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerAddr(pub SocketAddr);

/// What body middleware left in `req.body`.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum BodyState {
    /// No body parser ran (`req.body === undefined`).
    #[default]
    Undefined,
    /// A JSON or urlencoded parser ran; `{}` when the request had no matching body.
    Value(Value),
    /// The raw parser read the body (`req.body` is a `Buffer`).
    Raw(Bytes),
}

/// The status and headers set on the response before it is sent (`res.statusCode`,
/// `res.setHeader` in middleware that then calls `next()`).
#[derive(Debug, Clone)]
pub struct ResponseState {
    pub(crate) status: u16,
    pub(crate) headers: HeaderMap,
}

impl Default for ResponseState {
    fn default() -> Self {
        Self {
            status: 200,
            headers: HeaderMap::new(),
        }
    }
}

impl ResponseState {
    /// The status set so far (200 by default).
    pub fn status(&self) -> u16 {
        self.status
    }

    /// The headers set so far.
    pub fn headers(&self) -> &HeaderMap {
        &self.headers
    }

    /// The first value of a header set so far, as text.
    pub(crate) fn get_str(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .map(|v| latin1(v.as_bytes()).into_owned())
    }
}

/// Converts header bytes to text the way Node does (one character per byte, latin1).
pub(crate) fn latin1(bytes: &[u8]) -> Cow<'_, str> {
    match std::str::from_utf8(bytes) {
        Ok(text) if text.is_ascii() => Cow::Borrowed(text),
        _ => Cow::Owned(bytes.iter().map(|&b| char::from(b)).collect()),
    }
}

/// Text to a header value the way Node writes it: each character must be U+0000..=U+00FF and
/// is sent as that byte; anything else is an error (Node throws `ERR_INVALID_CHAR`).
pub(crate) fn header_value(text: &str) -> Result<HeaderValue, Error> {
    let mut bytes = Vec::with_capacity(text.len());
    for c in text.chars() {
        let code = u32::from(c);
        if code > 0xFF || (code < 0x20 && c != '\t') || code == 0x7F {
            return Err(Error::msg(format!(
                "Invalid character in header content [\"{}\"]",
                text.escape_debug()
            )));
        }
        bytes.push(code as u8);
    }
    HeaderValue::from_bytes(&bytes).map_err(|_| Error::msg("Invalid character in header content"))
}

pub(crate) fn header_name(name: &str) -> Result<HeaderName, Error> {
    HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
        Error::msg(format!(
            "Header name must be a valid HTTP token [\"{}\"]",
            name.escape_debug()
        ))
    })
}

/// Request headers Node keeps only once (the first value wins); others are joined with `", "`.
fn node_drops_duplicates(name: &str) -> bool {
    matches!(
        name,
        "age"
            | "authorization"
            | "content-length"
            | "content-type"
            | "etag"
            | "expires"
            | "from"
            | "host"
            | "if-modified-since"
            | "if-unmodified-since"
            | "last-modified"
            | "location"
            | "max-forwards"
            | "proxy-authorization"
            | "referer"
            | "retry-after"
            | "server"
            | "user-agent"
    )
}

/// An incoming request moving through the layer stack (Express `req`), generic over the shared
/// application state `S`.
///
/// Handlers read the method, URL, parameters, query, headers and parsed body; middleware may
/// store values in [`Req::extensions_mut`] (Express code attaches `req.user` and similar) and set
/// response headers with [`Req::set_header`] before passing control on.
pub struct Req<S = ()> {
    state: Arc<S>,
    method: Method,
    version: Version,
    headers: HeaderMap,
    extensions: Extensions,
    original_url: String,
    pub(crate) url: String,
    pub(crate) base_url: String,
    pub(crate) params: Params,
    query: Value,
    pub(crate) body: BodyState,
    pub(crate) body_parsed: bool,
    incoming: Mutex<Option<Body>>,
    pub(crate) res: ResponseState,
    /// Cancelled when the exchange ends (response sent, or the client went away).
    pub(crate) closed: CancellationToken,
    pub(crate) trace: Option<TraceContext>,
    /// The last route that ran (`req.route`).
    pub(crate) route: Option<MatchedRoute>,
    /// The same, shared with the exchange's completion guard (see [`Req::set_route`]).
    pub(crate) route_slot: RouteSlot,
    /// The mount patterns stripped so far (the pattern form of `base_url`).
    pub(crate) pattern_base: String,
}

impl<S> Req<S> {
    pub(crate) fn new(state: Arc<S>, parts: http::request::Parts, body: Body) -> Self {
        let original_url = match parts.uri.path_and_query() {
            Some(pq) => pq.as_str().to_owned(),
            None => parts.uri.to_string(),
        };
        let query = match original_url.split_once('?') {
            Some((_, query)) => qs::parse_query(query),
            None => Value::Object(serde_json::Map::new()),
        };
        Self {
            state,
            method: parts.method,
            version: parts.version,
            headers: parts.headers,
            extensions: parts.extensions,
            url: original_url.clone(),
            original_url,
            base_url: String::new(),
            params: Params::default(),
            query,
            body: BodyState::Undefined,
            body_parsed: false,
            incoming: Mutex::new(Some(body)),
            res: ResponseState::default(),
            closed: CancellationToken::new(),
            trace: None,
            route: None,
            route_slot: RouteSlot::default(),
            pattern_base: String::new(),
        }
    }

    /// Cancelled when the exchange is over: the response was handed to the connection in full,
    /// or the client went away first (Node's `res.on('close')`). Work a handler spawns on behalf
    /// of the request (an SSE producer, a long upstream call) waits on this to stop. The handler
    /// itself needs nothing: when the client goes away before the answer, its future is dropped.
    pub fn closed(&self) -> CancellationToken {
        self.closed.clone()
    }

    /// The trace context the [`crate::Observer`] or a middleware attached.
    pub fn trace_context(&self) -> Option<&TraceContext> {
        self.trace.as_ref()
    }

    /// Attaches a trace context (it reaches [`crate::RequestEnd::trace`]).
    pub fn set_trace_context(&mut self, context: TraceContext) {
        self.trace = Some(context);
    }

    /// The last route that ran (`req.route` with `req.baseUrl`), if any.
    pub fn route(&self) -> Option<&MatchedRoute> {
        self.route.as_ref()
    }

    /// Dispatch selected `route`: visible to handlers and, at once, to the exchange's report
    /// (even when the client leaves while the route runs).
    pub(crate) fn set_route(&mut self, route: MatchedRoute) {
        self.route_slot.set(route.clone());
        self.route = Some(route);
    }

    /// The shared application state.
    pub fn state(&self) -> &S {
        &self.state
    }

    /// The shared application state as an `Arc`, to move into spawned tasks.
    pub fn state_arc(&self) -> Arc<S> {
        Arc::clone(&self.state)
    }

    /// The request method (`req.method`).
    pub fn method(&self) -> &Method {
        &self.method
    }

    /// The HTTP version.
    pub fn version(&self) -> Version {
        self.version
    }

    /// `req.originalUrl`: path and query as received.
    pub fn original_url(&self) -> &str {
        &self.original_url
    }

    /// `req.url`: path and query relative to the current mount point.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// `req.path`: the pathname relative to the current mount point.
    pub fn path(&self) -> &str {
        pathname(&self.url)
    }

    /// `req.baseUrl`: the mount path(s) stripped so far.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The raw query string (after `?`, empty when there is none).
    pub fn query_string(&self) -> &str {
        self.original_url
            .split_once('?')
            .map(|(_, q)| q)
            .unwrap_or("")
    }

    /// `req.params`.
    pub fn params(&self) -> &Params {
        &self.params
    }

    /// `req.params[name]`, decoded.
    pub fn param(&self, name: &str) -> Option<&str> {
        self.params.get(name)
    }

    /// `req.query`, parsed like Express's "extended" parser (qs): may hold nested objects and
    /// arrays.
    pub fn query(&self) -> &Value {
        &self.query
    }

    /// `req.query[name]` when it is a string (the reference's `typeof x === 'string'` guard).
    pub fn query_str(&self, name: &str) -> Option<&str> {
        self.query.get(name).and_then(Value::as_str)
    }

    /// `req.query` deserialized into `T`.
    pub fn query_as<T: DeserializeOwned>(&self) -> Result<T, Error> {
        T::deserialize(&self.query)
            .map_err(|e| Error::new(400, e.to_string()).with_kind("query.invalid"))
    }

    /// All request headers, as received.
    pub fn headers(&self) -> &HeaderMap {
        &self.headers
    }

    /// `req.headers[name]` as Node presents it: header bytes read as latin1; duplicates joined
    /// with `", "` (`"; "` for `cookie`), except the headers Node keeps once, where the first
    /// value wins. `name` is case-insensitive.
    pub fn header(&self, name: &str) -> Option<Cow<'_, str>> {
        let lower = name.to_ascii_lowercase();
        let mut values = self.headers.get_all(lower.as_str()).iter();
        let first = values.next()?;
        if node_drops_duplicates(&lower) {
            return Some(latin1(first.as_bytes()));
        }
        let rest: Vec<&HeaderValue> = values.collect();
        if rest.is_empty() {
            return Some(latin1(first.as_bytes()));
        }
        let separator = if lower == "cookie" { "; " } else { ", " };
        let mut joined = latin1(first.as_bytes()).into_owned();
        for value in rest {
            joined.push_str(separator);
            joined.push_str(&latin1(value.as_bytes()));
        }
        Some(Cow::Owned(joined))
    }

    /// `req.get(name)`: like [`Req::header`], with Express's `Referrer`/`Referer` aliasing.
    pub fn get(&self, name: &str) -> Option<Cow<'_, str>> {
        let lower = name.to_ascii_lowercase();
        if lower == "referer" || lower == "referrer" {
            return self.header("referrer").or_else(|| self.header("referer"));
        }
        self.header(&lower)
    }

    /// The socket peer address (set by [`crate::serve`]).
    pub fn peer_addr(&self) -> Option<SocketAddr> {
        self.extensions.get::<PeerAddr>().map(|peer| peer.0)
    }

    /// `req.ip` with `trust proxy` off: the socket peer's address. On a dual-stack listener an
    /// IPv4 client shows as `::ffff:a.b.c.d`, as in Node.
    pub fn ip(&self) -> Option<String> {
        self.peer_addr().map(|addr| addr.ip().to_string())
    }

    /// Typed per-request values (Express code hangs these on `req`, such as `req.user`).
    pub fn extensions(&self) -> &Extensions {
        &self.extensions
    }

    /// Mutable access to the per-request values.
    pub fn extensions_mut(&mut self) -> &mut Extensions {
        &mut self.extensions
    }

    /// `req.body`: the parsed JSON or urlencoded value. `Null` when no parser ran (JavaScript
    /// `undefined`) or when the raw parser ran (use [`Req::body_bytes`]).
    pub fn body(&self) -> &Value {
        static NULL: Value = Value::Null;
        match &self.body {
            BodyState::Value(value) => value,
            BodyState::Undefined | BodyState::Raw(_) => &NULL,
        }
    }

    /// The exact bytes the raw parser read (signature checks).
    pub fn body_bytes(&self) -> Option<&Bytes> {
        match &self.body {
            BodyState::Raw(bytes) => Some(bytes),
            _ => None,
        }
    }

    /// What body middleware left in `req.body`.
    pub fn body_state(&self) -> &BodyState {
        &self.body
    }

    /// Replaces `req.body` (handlers and tests sometimes do).
    pub fn set_body(&mut self, body: BodyState) {
        self.body = body;
    }

    /// `req._body`: a body parser already read the body.
    pub fn body_parsed(&self) -> bool {
        self.body_parsed
    }

    /// The parsed body deserialized into `T`. A mismatch is a 400 error with kind `body.invalid`.
    pub fn body_as<T: DeserializeOwned>(&self) -> Result<T, Error> {
        T::deserialize(self.body())
            .map_err(|e| Error::new(400, e.to_string()).with_kind("body.invalid"))
    }

    /// Takes the unread request body stream (for upload and proxy handlers); `None` once a body
    /// parser or an earlier caller consumed it.
    pub fn take_body_stream(&mut self) -> Option<Body> {
        self.incoming
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }

    /// Takes hyper's upgrade handle (WebSocket and other protocol upgrades on this port).
    /// Take the [`crate::UpgradeGuard`] with it ([`Req::take_upgrade_guard`]).
    pub fn take_upgrade(&mut self) -> Option<hyper::upgrade::OnUpgrade> {
        self.extensions.remove::<hyper::upgrade::OnUpgrade>()
    }

    /// Takes the guard [`crate::serve`] attaches to a request that asks for an upgrade: hold it
    /// while you own the upgraded socket and watch its shutdown token (see
    /// [`crate::UpgradeGuard`]). `None` when the request was not served by [`crate::serve`] or
    /// asked for no upgrade.
    pub fn take_upgrade_guard(&mut self) -> Option<crate::UpgradeGuard> {
        self.extensions.remove::<crate::UpgradeGuard>()
    }

    /// `typeis.hasBody(req)`: a `Transfer-Encoding` or a numeric `Content-Length` header.
    pub fn has_body(&self) -> bool {
        if self.headers.contains_key(http::header::TRANSFER_ENCODING) {
            return true;
        }
        self.header("content-length")
            .is_some_and(|value| js_number_is_finite(&value))
    }

    /// The response status set so far (`res.statusCode`).
    pub fn response_status(&self) -> u16 {
        self.res.status
    }

    /// `res.status(code)` from middleware that then calls `next()`.
    pub fn set_status(&mut self, status: u16) {
        self.res.status = status;
    }

    /// The response headers set so far.
    pub fn response_headers(&self) -> &HeaderMap {
        &self.res.headers
    }

    /// `res.setHeader(name, value)` from middleware: replaces any previous value.
    pub fn set_header(&mut self, name: &str, value: &str) -> Result<(), Error> {
        let name = header_name(name)?;
        let value = header_value(value)?;
        self.res.headers.insert(name, value);
        Ok(())
    }

    /// `res.append(name, value)` from middleware: adds a value.
    pub fn append_header(&mut self, name: &str, value: &str) -> Result<(), Error> {
        let name = header_name(name)?;
        let value = header_value(value)?;
        self.res.headers.append(name, value);
        Ok(())
    }

    /// `res.removeHeader(name)`.
    pub fn remove_header(&mut self, name: &str) {
        if let Ok(name) = header_name(name) {
            self.res.headers.remove(name);
        }
    }

    /// `res.vary(field)` from middleware.
    pub fn vary(&mut self, field: &str) -> Result<(), Error> {
        let current = self.res.get_str("vary");
        if let Some(value) = crate::response::vary_append(current.as_deref().unwrap_or(""), field) {
            self.set_header("Vary", &value)?;
        }
        Ok(())
    }
}

impl<S> std::fmt::Debug for Req<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Req")
            .field("method", &self.method)
            .field("original_url", &self.original_url)
            .field("url", &self.url)
            .field("base_url", &self.base_url)
            .field("params", &self.params)
            .finish_non_exhaustive()
    }
}

/// The path part of a URL (before `?`).
pub(crate) fn pathname(url: &str) -> &str {
    match url.split_once('?') {
        Some((path, _)) => path,
        None => url,
    }
}

/// `!isNaN(value)` for a header string: JavaScript `Number(value)` is not NaN.
fn js_number_is_finite(value: &str) -> bool {
    let trimmed = crate::mediatype::trim_js(value);
    if trimmed.is_empty() {
        return true;
    }
    let unsigned = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    if unsigned == "Infinity" {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    if let Some(hex) = lower.strip_prefix("0x") {
        return !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit());
    }
    if let Some(bin) = lower.strip_prefix("0b") {
        return !bin.is_empty() && bin.bytes().all(|b| b == b'0' || b == b'1');
    }
    if let Some(oct) = lower.strip_prefix("0o") {
        return !oct.is_empty() && oct.bytes().all(|b| (b'0'..=b'7').contains(&b));
    }
    let plain = unsigned
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'));
    plain && unsigned.parse::<f64>().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(builder: http::request::Builder) -> Req<()> {
        let (parts, ()) = builder.body(()).expect("request").into_parts();
        Req::new(Arc::new(()), parts, Body::empty())
    }

    #[test]
    fn joins_headers_like_node() {
        let req = request(
            http::Request::builder()
                .uri("/a?x=1")
                .header("Accept", "text/html")
                .header("accept", "application/json")
                .header("Content-Type", "application/json")
                .header("content-type", "text/plain")
                .header("Cookie", "a=1")
                .header("cookie", "b=2")
                .header(
                    "X-Latin",
                    HeaderValue::from_bytes(b"caf\xe9").expect("value"),
                ),
        );
        assert_eq!(
            req.header("ACCEPT").as_deref(),
            Some("text/html, application/json")
        );
        assert_eq!(
            req.header("content-type").as_deref(),
            Some("application/json")
        );
        assert_eq!(req.header("cookie").as_deref(), Some("a=1; b=2"));
        assert_eq!(req.header("x-latin").as_deref(), Some("café"));
        assert_eq!(req.path(), "/a");
        assert_eq!(req.query_str("x"), Some("1"));
        assert!(!req.has_body());
    }

    #[test]
    fn has_body_follows_type_is() {
        let req = request(
            http::Request::builder()
                .uri("/")
                .header("content-length", "0"),
        );
        assert!(req.has_body());
        let req = request(
            http::Request::builder()
                .uri("/")
                .header("transfer-encoding", "chunked"),
        );
        assert!(req.has_body());
        assert!(js_number_is_finite("12"));
        assert!(!js_number_is_finite("12a"));
    }

    #[test]
    fn header_values_are_latin1() {
        assert_eq!(
            header_value("café").map(|v| v.as_bytes().to_vec()).ok(),
            Some(b"caf\xe9".to_vec())
        );
        assert!(header_value("😀").is_err());
        assert!(header_value("a\nb").is_err());
    }
}
