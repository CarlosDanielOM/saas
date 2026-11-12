//! The one error type of the crate.
//!
//! Nothing in an error's `Display` or `Debug` output can carry a credential: the request is named
//! by provider, method and path *template* (never the rendered path, which may hold ids or
//! secrets such as Polar's checkout client secret); the query string is shown with the
//! provider's secret parameters replaced; response headers are kept only from an allow-list; the
//! response body is kept for the caller but printed as a length; and transport errors from
//! `reqwest` are stored without their URL.

use crate::redact;
use bytes::Bytes;
use http::{HeaderMap, Method, StatusCode};
use std::fmt;

/// A boxed error source.
pub type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;

/// Which timeout fired.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeoutKind {
    /// Waiting for a free slot under the provider's concurrency cap.
    Queue,
    /// Establishing the connection (name resolution, TCP and TLS).
    Connect,
    /// Waiting for the response headers.
    Headers,
    /// The whole attempt, headers and body.
    Total,
    /// No body bytes arrived for the idle timeout.
    Idle,
}

impl fmt::Display for TimeoutKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Queue => "queue",
            Self::Connect => "connect",
            Self::Headers => "headers",
            Self::Total => "total",
            Self::Idle => "idle",
        })
    }
}

/// Why the guarded client refused a URL (see [`crate::guard`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlockReason {
    /// The URL does not parse, or has a form the guard does not accept (for example an IPv6
    /// zone id).
    InvalidUrl,
    /// The scheme is not allowed.
    Scheme,
    /// The URL carries a user name or password.
    Userinfo,
    /// The port is not allowed.
    Port,
    /// The host is not on the policy's host list, or is an IP literal where names are required.
    Host,
    /// The name did not resolve to any address.
    Unresolvable,
    /// The host is, or resolves to, a refused address (loopback, private, metadata...).
    Address(std::net::IpAddr),
    /// More redirects than the policy allows.
    TooManyRedirects,
    /// A redirect without a usable `Location`.
    BadRedirect,
    /// A redirect from https to plain http.
    InsecureRedirect,
    /// A redirect that would carry the request body to another origin (a 307 or 308 elsewhere).
    BodyToOtherOrigin,
}

impl fmt::Display for BlockReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUrl => f.write_str("invalid url"),
            Self::Scheme => f.write_str("scheme not allowed"),
            Self::Userinfo => f.write_str("credentials in url"),
            Self::Port => f.write_str("port not allowed"),
            Self::Host => f.write_str("host not allowed"),
            Self::Unresolvable => f.write_str("host does not resolve"),
            Self::Address(ip) => write!(f, "address {ip} not allowed"),
            Self::TooManyRedirects => f.write_str("too many redirects"),
            Self::BadRedirect => f.write_str("redirect without a valid location"),
            Self::InsecureRedirect => f.write_str("redirect from https to http"),
            Self::BodyToOtherOrigin => {
                f.write_str("redirect would send the body to another origin")
            }
        }
    }
}

/// What kind of body decoding failed. Nothing of the body itself is kept: a JSON error's text
/// can quote the rejected input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeCategory {
    /// The bytes are not valid JSON.
    Syntax,
    /// Valid JSON that does not fit the expected type.
    Data,
    /// The body ended in the middle of a JSON value.
    Eof,
    /// The compressed body (gzip, deflate, brotli) could not be decompressed.
    Compression,
}

impl fmt::Display for DecodeCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Syntax => "syntax",
            Self::Data => "data",
            Self::Eof => "eof",
            Self::Compression => "compression",
        })
    }
}

impl DecodeCategory {
    /// The category of a `serde_json` error.
    pub(crate) fn of_json(error: &serde_json::Error) -> Self {
        match error.classify() {
            serde_json::error::Category::Data => Self::Data,
            serde_json::error::Category::Eof => Self::Eof,
            serde_json::error::Category::Syntax | serde_json::error::Category::Io => Self::Syntax,
        }
    }
}

/// The failure class an [`Error`] belongs to, for telemetry and retry decisions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureClass {
    /// A timeout fired.
    Timeout(TimeoutKind),
    /// The connection could not be established (includes name resolution).
    Connect,
    /// The connection failed after it was established (reset, closed early, protocol error).
    Transport,
    /// A non-success status.
    Status,
    /// The body was larger than the limit.
    TooLarge,
    /// The body could not be decoded.
    Decode,
    /// Cancelled by shutdown.
    Cancelled,
    /// The guarded client refused the URL.
    Blocked,
    /// The request could not be built.
    Invalid,
    /// An unexpected redirect.
    Redirect,
}

impl FailureClass {
    /// A short stable label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Timeout(TimeoutKind::Queue) => "timeout_queue",
            Self::Timeout(TimeoutKind::Connect) => "timeout_connect",
            Self::Timeout(TimeoutKind::Headers) => "timeout_headers",
            Self::Timeout(TimeoutKind::Total) => "timeout_total",
            Self::Timeout(TimeoutKind::Idle) => "timeout_idle",
            Self::Connect => "connect",
            Self::Transport => "transport",
            Self::Status => "status",
            Self::TooLarge => "too_large",
            Self::Decode => "decode",
            Self::Cancelled => "cancelled",
            Self::Blocked => "blocked",
            Self::Invalid => "invalid",
            Self::Redirect => "redirect",
        }
    }
}

/// What request an error belongs to, safe to print.
#[derive(Clone, PartialEq, Eq)]
pub struct RequestInfo {
    /// The provider name.
    pub provider: &'static str,
    /// The method.
    pub method: Method,
    /// The path template (`/v1/customers/{}/state`), never the rendered path.
    pub template: &'static str,
    /// The query string with secret parameters replaced by `<redacted>`.
    pub query: Option<Box<str>>,
}

impl RequestInfo {
    pub(crate) fn new(provider: &'static str, method: Method, template: &'static str) -> Self {
        Self {
            provider,
            method,
            template,
            query: None,
        }
    }

    /// The same, with the redacted query of `url`.
    pub(crate) fn with_query(mut self, url: &url::Url, secrets: &[&'static str]) -> Self {
        self.query = redact::query(url, secrets);
        self
    }
}

impl fmt::Display for RequestInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {} {}", self.provider, self.method, self.template)?;
        if let Some(query) = &self.query {
            write!(f, "?{query}")?;
        }
        Ok(())
    }
}

impl fmt::Debug for RequestInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RequestInfo({self})")
    }
}

/// A non-success response, kept with an allow-listed set of headers and the first bytes of the
/// body.
#[derive(Clone)]
pub struct StatusError {
    /// The request.
    pub info: RequestInfo,
    /// The status.
    pub status: StatusCode,
    /// Allow-listed response headers (rate limits, retry hints, content type, request ids).
    pub headers: HeaderMap,
    /// Up to [`StatusError::BODY_SLICE`] bytes of the body. Not shown by `Display` or `Debug`:
    /// some services echo input there.
    pub body: Bytes,
    /// Whether the body was longer than the slice.
    pub body_truncated: bool,
}

impl StatusError {
    /// How many body bytes are kept.
    pub const BODY_SLICE: usize = 4096;

    /// The kept body bytes as text (lossy UTF-8).
    pub fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

impl fmt::Debug for StatusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StatusError")
            .field("info", &self.info)
            .field("status", &self.status.as_u16())
            .field("headers", &redact::HeadersDebug(&self.headers))
            .field("body_len", &self.body.len())
            .field("body_truncated", &self.body_truncated)
            .finish()
    }
}

/// Every failure of an outbound request.
#[derive(thiserror::Error)]
pub enum Error {
    /// A timeout fired.
    #[error("{info}: {kind} timeout")]
    Timeout {
        /// The request.
        info: RequestInfo,
        /// Which timeout.
        kind: TimeoutKind,
    },
    /// The connection could not be established.
    #[error("{info}: connection failed")]
    Connect {
        /// The request.
        info: RequestInfo,
        /// The cause, without any URL.
        #[source]
        source: BoxError,
    },
    /// The connection failed after it was established.
    #[error("{info}: transport failed")]
    Transport {
        /// The request.
        info: RequestInfo,
        /// The cause, without any URL.
        #[source]
        source: BoxError,
    },
    /// A non-success status.
    #[error("{}: status {}", .0.info, .0.status.as_u16())]
    Status(Box<StatusError>),
    /// The body was longer than the limit (decompressed bytes are counted).
    #[error("{info}: body larger than {limit} bytes")]
    BodyTooLarge {
        /// The request.
        info: RequestInfo,
        /// The limit.
        limit: u64,
    },
    /// The body could not be decoded (JSON, decompression). Only where it failed is kept, never
    /// the parser's message, which can quote the body.
    #[error("{info}: decode failed ({category} at line {line} column {column})")]
    Decode {
        /// The request.
        info: RequestInfo,
        /// What failed.
        category: DecodeCategory,
        /// The 1-based line of a JSON error (0 when unknown).
        line: usize,
        /// The 1-based column of a JSON error (0 when unknown).
        column: usize,
    },
    /// Shutdown fired while the request was waiting.
    #[error("{info}: cancelled")]
    Cancelled {
        /// The request.
        info: RequestInfo,
    },
    /// Retries ran out; `last` is the final attempt's error.
    #[error("{}: gave up after {attempts} attempts: {last}", last.info())]
    RetriesExhausted {
        /// Attempts made.
        attempts: u32,
        /// The last cause.
        last: Box<Error>,
    },
    /// The guarded client refused the URL or a redirect hop.
    #[error("{info}: blocked: {reason}")]
    Blocked {
        /// The request.
        info: RequestInfo,
        /// Why.
        reason: BlockReason,
    },
    /// The server redirected where the provider does not follow.
    #[error("{info}: unexpected redirect (status {status})")]
    Redirect {
        /// The request.
        info: RequestInfo,
        /// The 3xx status.
        status: u16,
    },
    /// The request could not be built (bad path argument, header value, URL).
    #[error("{info}: invalid request: {reason}")]
    Invalid {
        /// The request.
        info: RequestInfo,
        /// What was wrong.
        reason: &'static str,
    },
}

impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Status(status) => fmt::Debug::fmt(status, f),
            Self::Connect { info, source } | Self::Transport { info, source } => f
                .debug_struct(if matches!(self, Self::Connect { .. }) {
                    "Connect"
                } else {
                    "Transport"
                })
                .field("info", info)
                .field("source", &redact::ErrorChain(source.as_ref()))
                .finish(),
            Self::RetriesExhausted { attempts, last } => f
                .debug_struct("RetriesExhausted")
                .field("attempts", attempts)
                .field("last", last)
                .finish(),
            other => write!(f, "{other}"),
        }
    }
}

impl Error {
    /// The request this error belongs to.
    pub fn info(&self) -> &RequestInfo {
        match self {
            Self::Status(status) => &status.info,
            Self::RetriesExhausted { last, .. } => last.info(),
            Self::Timeout { info, .. }
            | Self::Connect { info, .. }
            | Self::Transport { info, .. }
            | Self::BodyTooLarge { info, .. }
            | Self::Decode { info, .. }
            | Self::Cancelled { info }
            | Self::Blocked { info, .. }
            | Self::Redirect { info, .. }
            | Self::Invalid { info, .. } => info,
        }
    }

    /// The failure class (of the last cause, for [`Error::RetriesExhausted`]).
    pub fn class(&self) -> FailureClass {
        match self {
            Self::Timeout { kind, .. } => FailureClass::Timeout(*kind),
            Self::Connect { .. } => FailureClass::Connect,
            Self::Transport { .. } => FailureClass::Transport,
            Self::Status(_) => FailureClass::Status,
            Self::BodyTooLarge { .. } => FailureClass::TooLarge,
            Self::Decode { .. } => FailureClass::Decode,
            Self::Cancelled { .. } => FailureClass::Cancelled,
            Self::RetriesExhausted { last, .. } => last.class(),
            Self::Blocked { .. } => FailureClass::Blocked,
            Self::Redirect { .. } => FailureClass::Redirect,
            Self::Invalid { .. } => FailureClass::Invalid,
        }
    }

    /// The status of a non-success response (also behind [`Error::RetriesExhausted`]).
    pub fn status(&self) -> Option<StatusCode> {
        match self {
            Self::Status(status) => Some(status.status),
            Self::RetriesExhausted { last, .. } => last.status(),
            _ => None,
        }
    }

    /// The status error, if this is one (also behind [`Error::RetriesExhausted`]).
    pub fn as_status(&self) -> Option<&StatusError> {
        match self {
            Self::Status(status) => Some(status),
            Self::RetriesExhausted { last, .. } => last.as_status(),
            _ => None,
        }
    }

    /// Whether a timeout fired (of any kind).
    pub fn is_timeout(&self) -> bool {
        matches!(self.class(), FailureClass::Timeout(_))
    }

    /// Whether the guarded client refused the URL, and why.
    pub fn block_reason(&self) -> Option<&BlockReason> {
        match self {
            Self::Blocked { reason, .. } => Some(reason),
            Self::RetriesExhausted { last, .. } => last.block_reason(),
            _ => None,
        }
    }

    /// Maps a `reqwest` error, dropping its URL.
    pub(crate) fn from_reqwest(info: RequestInfo, error: reqwest::Error) -> Self {
        if let Some(reason) = crate::guard::find_block(&error) {
            return Self::Blocked { info, reason };
        }
        let connect = error.is_connect();
        let timeout = error.is_timeout();
        // `Response::chunk` reports every body failure as "decode"; a failure of the connection
        // underneath shows as a body error in the source chain.
        let decode = error.is_decode() && !has_body_error(&error);
        if decode {
            return Self::Decode {
                info,
                category: DecodeCategory::Compression,
                line: 0,
                column: 0,
            };
        }
        let source: BoxError = Box::new(error.without_url());
        if connect && timeout {
            Self::Timeout {
                info,
                kind: TimeoutKind::Connect,
            }
        } else if connect {
            Self::Connect { info, source }
        } else {
            Self::Transport { info, source }
        }
    }
}

/// Whether a "decode" error from `reqwest` is really a broken connection: the decompression
/// layer fails with an `io::Error` (invalid data), while a connection that closes or resets
/// mid-body surfaces as the HTTP stack's own error.
fn has_body_error(error: &reqwest::Error) -> bool {
    match std::error::Error::source(error) {
        Some(source) => match source.downcast_ref::<std::io::Error>() {
            Some(io) => !matches!(
                io.kind(),
                std::io::ErrorKind::InvalidData | std::io::ErrorKind::Other
            ),
            None => true,
        },
        None => false,
    }
}

/// The result type of the crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;
