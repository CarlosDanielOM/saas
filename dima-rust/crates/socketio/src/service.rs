//! The tower service in front of the `dima_web::App`.
//!
//! Routing as the reference's listeners do it on the raw request target: the client files first
//! (`attachServe`), then anything starting with `/socket.io/` goes to Engine.IO (`attach`'s
//! `check`, a plain prefix comparison, so `/socket.io/anything` is an Engine.IO request), then
//! the app. Upgrades follow the same rule; with `destroyUpgrade: false` other upgrades reach the
//! app untouched.
//!
//! Before `engineioxide` sees a request, the checks of `engine.io`'s `verify` run here with its
//! answers (`400 {"code":N,"message":…}`; for an upgrade, a `400` text answer), the polling
//! request limits are applied, and the target is rewritten to the plain form `engineioxide`
//! parses (the reference reads the query with `URLSearchParams`, last value winning). Polling
//! responses get the reference's headers (`cache-control: no-store`, `text/html` for the POST
//! acknowledgement, `X-XSS-Protection: 0` for old Internet Explorer) and its compression
//! (gzip or deflate from 1024 bytes, when the client accepts it).

use std::convert::Infallible;
use std::future::Future;
use std::io::Write as _;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};

use bytes::Bytes;
use dima_web::{Body, UpgradeGuard};
use http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode, header};
use http_body_util::BodyExt as _;
use tokio::sync::OwnedSemaphorePermit;
use tower::ServiceExt as _;

use crate::client_files;
use crate::handshake::{Origin, Query};
use crate::negotiate;
use crate::server::ServerInner;

/// What the handshake request leaves for the new connection (an extension `engineioxide` keeps
/// with the request parts).
#[derive(Clone)]
pub(crate) struct FirstRequest {
    pub origin: Arc<Origin>,
    guard: Arc<Mutex<Option<UpgradeGuard>>>,
    /// The connection's slot, reserved before the handshake reached Engine.IO (for a WebSocket,
    /// before its asynchronous part). Dropped with the request when no session comes of it.
    permit: Arc<Mutex<Option<OwnedSemaphorePermit>>>,
}

impl FirstRequest {
    pub fn take_guard(&self) -> Option<UpgradeGuard> {
        self.guard
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }

    pub fn take_permit(&self) -> Option<OwnedSemaphorePermit> {
        self.permit
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }
}

/// Socket.IO in front of `S` (see [`crate::SocketIo::layer`]).
pub struct SocketIoService<S> {
    io: Arc<ServerInner>,
    inner: S,
}

impl<S: Clone> Clone for SocketIoService<S> {
    fn clone(&self) -> Self {
        Self {
            io: Arc::clone(&self.io),
            inner: self.inner.clone(),
        }
    }
}

impl<S> std::fmt::Debug for SocketIoService<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SocketIoService")
    }
}

impl<S> SocketIoService<S> {
    pub(crate) fn new(io: Arc<ServerInner>, inner: S) -> Self {
        Self { io, inner }
    }
}

type Respond = Pin<Box<dyn Future<Output = Result<Response<Body>, Infallible>> + Send>>;

impl<S> tower::Service<Request<Body>> for SocketIoService<S>
where
    S: tower::Service<Request<Body>, Response = Response<Body>, Error = Infallible>
        + Clone
        + Send
        + 'static,
    S::Future: Send + 'static,
{
    type Response = Response<Body>;
    type Error = Infallible;
    type Future = Respond;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
        // Each call drives a clone of the inner service to readiness itself (`oneshot`).
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, req: Request<Body>) -> Self::Future {
        let io = Arc::clone(&self.io);
        let inner = self.inner.clone();
        Box::pin(async move { Ok(route(io, inner, req).await) })
    }
}

async fn route<S>(io: Arc<ServerInner>, inner: S, req: Request<Body>) -> Response<Body>
where
    S: tower::Service<Request<Body>, Response = Response<Body>, Error = Infallible>,
{
    if let Some(guard) = req.extensions().get::<UpgradeGuard>() {
        io.watch_guard(guard.shutdown());
    }
    // Node's `req.url` is the raw target; an absolute-form target never matches the prefix.
    let target = match (req.uri().authority(), req.uri().path_and_query()) {
        (None, Some(target)) => Some(target.as_str().to_owned()),
        _ => None,
    };
    // An upgrade never reaches the client files (they listen to `request` events only).
    let upgrade = wants_upgrade(req.headers());
    match target {
        Some(target) if !upgrade && client_files::is_client_path(&target) => {
            io.client_files.serve(req.headers(), &target)
        }
        Some(target) if target.starts_with("/socket.io/") => engine(io, req, target).await,
        _ => match inner.oneshot(req).await {
            Ok(response) => response,
            Err(never) => match never {},
        },
    }
}

/// The query parameters Engine.IO reads (`req._query`, last value winning).
#[derive(Default)]
struct Params {
    eio: Option<String>,
    transport: Option<String>,
    sid: Option<String>,
}

impl Params {
    fn parse(raw: &str) -> Self {
        let mut params = Self::default();
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            match key.as_ref() {
                "EIO" => params.eio = Some(value.into_owned()),
                "transport" => params.transport = Some(value.into_owned()),
                "sid" => params.sid = Some(value.into_owned()),
                _ => {}
            }
        }
        params
    }
}

/// `Connection: upgrade` with an `Upgrade` header: Node's `upgrade` event.
fn wants_upgrade(headers: &HeaderMap) -> bool {
    let connection_upgrade = headers.get_all(header::CONNECTION).iter().any(|value| {
        value.to_str().is_ok_and(|value| {
            value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
        })
    });
    connection_upgrade && headers.contains_key(header::UPGRADE)
}

/// `Server.errorMessages`.
fn message(code: u8) -> &'static str {
    match code {
        0 => "Transport unknown",
        1 => "Session ID unknown",
        2 => "Bad handshake method",
        3 => "Bad request",
        4 => "Forbidden",
        _ => "Unsupported protocol version",
    }
}

fn plain(
    status: StatusCode,
    content_type: Option<&'static str>,
    body: impl Into<Body>,
) -> Response<Body> {
    let mut response = Response::new(body.into());
    *response.status_mut() = status;
    if let Some(content_type) = content_type {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    }
    response
}

/// The answer when no connection or stream slot is free.
fn unavailable() -> Response<Body> {
    plain(
        StatusCode::SERVICE_UNAVAILABLE,
        Some("text/plain; charset=utf-8"),
        "Service Unavailable",
    )
}

/// `abortRequest` / `abortUpgrade`.
fn abort(upgrade: bool, code: u8) -> Response<Body> {
    if upgrade {
        let mut response = plain(StatusCode::BAD_REQUEST, Some("text/html"), message(code));
        response
            .headers_mut()
            .insert(header::CONNECTION, HeaderValue::from_static("close"));
        return response;
    }
    let status = if code == 4 {
        StatusCode::FORBIDDEN
    } else {
        StatusCode::BAD_REQUEST
    };
    plain(
        status,
        Some("application/json"),
        format!("{{\"code\":{code},\"message\":\"{}\"}}", message(code)),
    )
}

async fn engine(io: Arc<ServerInner>, mut req: Request<Body>, target: String) -> Response<Body> {
    let raw_query = req.uri().query().unwrap_or("").to_owned();
    let params = Params::parse(&raw_query);
    let upgrade = wants_upgrade(req.headers());
    let method = req.method().clone();
    let transport = match params.transport.as_deref() {
        Some(transport @ ("polling" | "websocket")) => transport,
        _ => return abort(upgrade, 0),
    };
    let polling = transport == "polling";
    let sid = params.sid.as_deref().filter(|sid| !sid.is_empty());
    let conn = match sid {
        Some(sid) => {
            let Some(conn) = io.connection(sid) else {
                return abort(upgrade, 1);
            };
            if !upgrade && conn.transport() != transport {
                return abort(upgrade, 3);
            }
            Some(conn)
        }
        None => {
            if method != Method::GET {
                return abort(upgrade, 2);
            }
            if !polling && !upgrade {
                return abort(upgrade, 3);
            }
            if params.eio.as_deref() != Some("4") {
                return abort(upgrade, 5);
            }
            None
        }
    };
    // A new session takes its connection slot now, before Engine.IO creates anything (for a
    // WebSocket, before the asynchronous part of its handshake); the slot is released when the
    // session ends, or with the request when none comes of it.
    let permit = match &conn {
        Some(_) => None,
        None => match io.reserve_connection() {
            Some(permit) => Some(permit),
            None => {
                io.shared.telemetry.connection_refused();
                return unavailable();
            }
        },
    };
    // A WebSocket (a new session or an upgrade) holds one of `dima-web`'s stream slots once it
    // is upgraded: reserve it before Engine.IO sees the request, so a full quota refuses here
    // instead of after the session was created.
    if upgrade
        && let Some(admission) = req.extensions().get::<dima_web::StreamAdmission>()
        && admission.reserve().is_err()
    {
        io.shared.telemetry.connection_refused();
        return unavailable();
    }
    if let (Some(conn), true) = (&conn, polling) {
        if method == Method::POST {
            let binary = req
                .headers()
                .get(header::CONTENT_TYPE)
                .is_some_and(|value| value == "application/octet-stream");
            let length = req
                .headers()
                .get(header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok());
            if binary {
                // "invalid content": binary payloads do not exist in protocol 4 polling.
                conn.close(crate::DisconnectReason::TransportError);
                return plain(StatusCode::BAD_REQUEST, None, Body::empty());
            }
            if length.is_some_and(|length| length > io.shared.options.max_http_buffer_size) {
                // The session stays; the client gives up on the 413 and abandons its poll, which
                // ends the session as a transport error (see `PollGuard`).
                return plain(StatusCode::PAYLOAD_TOO_LARGE, None, Body::empty());
            }
        } else if method != Method::GET {
            return plain(StatusCode::INTERNAL_SERVER_ERROR, None, Body::empty());
        }
    }

    // The upgrade guard stays with the connection, not with the request parts `engineioxide`
    // keeps.
    let guard = req.extensions_mut().remove::<UpgradeGuard>();
    match &conn {
        Some(conn) => {
            if let Some(guard) = guard {
                conn.attach_guard(guard);
            }
        }
        None => {
            let origin = Arc::new(Origin {
                headers: req.headers().clone(),
                url: target,
                query: Query::parse(&raw_query),
                peer: req
                    .extensions()
                    .get::<dima_web::PeerAddr>()
                    .map(|peer| peer.0),
            });
            req.extensions_mut().insert(FirstRequest {
                origin,
                guard: Arc::new(Mutex::new(guard)),
                permit: Arc::new(Mutex::new(permit)),
            });
        }
    }
    let canonical = match sid {
        Some(sid) => format!("/socket.io/?EIO=4&transport={transport}&sid={sid}"),
        None => format!("/socket.io/?EIO=4&transport={transport}"),
    };
    match canonical.parse() {
        Ok(uri) => *req.uri_mut() = uri,
        Err(_) => return abort(upgrade, 3),
    }

    let accept = req
        .headers()
        .contains_key(header::ACCEPT_ENCODING)
        .then(|| {
            req.headers()
                .get_all(header::ACCEPT_ENCODING)
                .iter()
                .filter_map(|value| value.to_str().ok())
                .collect::<Vec<_>>()
                .join(", ")
        });
    let old_ie = req
        .headers()
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|ua| ua.contains(";MSIE") || ua.contains("Trident/"));

    // A poll waits in Engine.IO, a POST is read there; the client abandoning either ends the
    // session, and a second POST while one is read is an overlap (`engine.io` closes then).
    let guard = match (&conn, polling) {
        (Some(conn), true) if method == Method::GET => Some(conn.poll_started()),
        (Some(conn), true) => match conn.post_started() {
            Some(guard) => Some(guard),
            None => {
                conn.close(crate::DisconnectReason::TransportError);
                return plain(StatusCode::BAD_REQUEST, None, Body::empty());
            }
        },
        _ => None,
    };
    let response = match io.engine.clone().oneshot(req).await {
        Ok(response) => response,
        Err(never) => match never {},
    };
    if let Some(guard) = guard {
        guard.finish();
    }
    let (mut parts, body) = response.into_parts();
    if !polling || parts.status != StatusCode::OK {
        return Response::from_parts(parts, Body::new(body));
    }
    parts
        .headers
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if old_ie {
        parts
            .headers
            .insert("x-xss-protection", HeaderValue::from_static("0"));
    }
    if method == Method::POST {
        parts
            .headers
            .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html"));
        return Response::from_parts(parts, Body::new(body));
    }
    // A poll: whether its body is compressed depends on `Accept-Encoding` (from the threshold
    // on), which a shared cache must know; the reference sends no `Vary`.
    parts
        .headers
        .insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    // The payload is complete (`engineioxide` answers with a full body). Its frames are read
    // without consuming the body: Engine.IO counts the messages in it as done when the body is
    // dropped, and the outbox releases their charge then. So the body becomes the owner of the
    // bytes this answer sends (H1 of the re-check): it is dropped with the last reference to
    // them, which hyper holds until it has written them to the socket, or until it drops them
    // with the connection (closed by the client, by `dima-web`'s write-stall timeout, or by the
    // shutdown). Taking the answer's body out of the response and dropping it, as hyper does
    // once it has the last frame, no longer releases anything.
    let mut body = Box::pin(body);
    let mut payload = bytes::BytesMut::new();
    while let Some(frame) = body.frame().await {
        let frame = match frame {
            Ok(frame) => frame,
            Err(never) => match never {},
        };
        if let Ok(data) = frame.into_data() {
            payload.extend_from_slice(&data);
        }
    }
    let payload = payload.freeze();
    let threshold = io.shared.options.http_compression_threshold;
    let encoding = (payload.len() >= threshold)
        .then(|| negotiate::preferred(accept.as_deref(), &["gzip", "deflate"]))
        .flatten();
    let payload = match encoding {
        Some(encoding) => {
            let gzip = encoding == "gzip";
            let compressed =
                tokio::task::spawn_blocking(move || compress(&payload, gzip).map(|c| (c, payload)))
                    .await
                    .ok()
                    .flatten();
            match compressed {
                Some((compressed, _)) => {
                    parts
                        .headers
                        .insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding));
                    compressed
                }
                None => {
                    return plain(StatusCode::INTERNAL_SERVER_ERROR, None, Body::empty());
                }
            }
        }
        None => payload,
    };
    parts
        .headers
        .insert(header::CONTENT_LENGTH, HeaderValue::from(payload.len()));
    Response::from_parts(parts, Body::from(written_with(payload, body)))
}

/// The bytes of an answer, owning `held` (Engine.IO's body) for as long as any reference to
/// them lives: `held` is dropped when the HTTP server has written the bytes or dropped them.
fn written_with<H: Send + 'static>(data: Bytes, held: H) -> Bytes {
    Bytes::from_owner(Written { data, _held: held })
}

struct Written<H> {
    data: Bytes,
    _held: H,
}

impl<H> AsRef<[u8]> for Written<H> {
    fn as_ref(&self) -> &[u8] {
        &self.data
    }
}

/// `zlib.createGzip()` / `createDeflate()` with the default level.
fn compress(data: &[u8], gzip: bool) -> Option<Bytes> {
    let level = flate2::Compression::default();
    let written = if gzip {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), level);
        encoder.write_all(data).and_then(|()| encoder.finish())
    } else {
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), level);
        encoder.write_all(data).and_then(|()| encoder.finish())
    };
    written.ok().map(Bytes::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Flag(Arc<std::sync::atomic::AtomicBool>);

    impl Drop for Flag {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::Release);
        }
    }

    /// H1: Engine.IO's body (whose drop marks its messages written) lives as long as the
    /// answer's bytes, not as long as the answer's body: hyper takes the last frame and drops
    /// the body before the bytes are written.
    #[tokio::test]
    async fn a_polling_answer_holds_the_engine_body_until_its_bytes_are_gone() {
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let body = Body::from(written_with(
            Bytes::from_static(b"40"),
            Flag(Arc::clone(&dropped)),
        ));
        let mut body = Box::pin(body);
        let frame = body.frame().await.unwrap().unwrap().into_data().unwrap();
        assert!(body.frame().await.is_none());
        drop(body);
        // The bytes are still waiting to be written.
        assert!(!dropped.load(std::sync::atomic::Ordering::Acquire));
        assert_eq!(&frame[..], b"40");
        let part = frame.slice(1..);
        drop(frame);
        assert!(!dropped.load(std::sync::atomic::Ordering::Acquire));
        drop(part);
        assert!(dropped.load(std::sync::atomic::Ordering::Acquire));
    }
}
