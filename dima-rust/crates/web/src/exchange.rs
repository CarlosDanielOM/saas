//! The life of one exchange, from the request arriving to the last response byte or the client
//! going away: the close signal handlers can wait on and the telemetry seam.
//!
//! The server notices a client that goes away: hyper reads end-of-file while a request is in
//! progress or its response is streaming (half-close is off), closes the connection and drops
//! the handler's future or the response body. Both drops are seen here.

use std::any::Any;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::HttpBody;
use bytes::Bytes;
use http::{HeaderMap, Method};
use hyper::body::{Frame, SizeHint};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::Body;

/// A trace context an [`Observer`] (or middleware) attaches to a request: whatever the telemetry
/// implementation needs (trace and span ids, a span handle). Handlers read it with
/// [`crate::Req::trace_context`] and downcast with [`TraceContext::get`].
#[derive(Clone)]
pub struct TraceContext(Arc<dyn Any + Send + Sync>);

impl TraceContext {
    /// Wraps a value.
    pub fn new<T: Any + Send + Sync>(value: T) -> Self {
        Self(Arc::new(value))
    }

    /// The value, when it is a `T`.
    pub fn get<T: Any>(&self) -> Option<&T> {
        self.0.downcast_ref::<T>()
    }
}

impl std::fmt::Debug for TraceContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TraceContext(..)")
    }
}

/// The route that answered: Express's `req.baseUrl` at that moment and `req.route.path`, plus the
/// whole pattern with the mount patterns (`/widgets/:channelID/duel/state`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchedRoute {
    /// `req.baseUrl` when the route ran: the mount paths as requested (`/widgets/chan/duel`).
    pub base_url: String,
    /// `req.route.path`: the route's own pattern (`/state`).
    pub path: String,
    /// The mount patterns and the route's pattern (`/widgets/:channelID/duel/state`).
    pub pattern: String,
}

/// What an [`Observer`] sees when a request arrives.
#[derive(Debug)]
pub struct RequestStart<'a> {
    /// The method.
    pub method: &'a Method,
    /// `req.originalUrl`: path and query as received.
    pub url: &'a str,
    /// The request headers.
    pub headers: &'a HeaderMap,
    /// The socket peer, when served by [`crate::serve`].
    pub peer: Option<SocketAddr>,
}

/// What an [`Observer`] sees when the exchange is over.
#[derive(Debug, Clone)]
pub struct RequestEnd {
    /// The method.
    pub method: Method,
    /// `req.originalUrl`.
    pub url: String,
    /// The last route that ran, if any (Express's `req.route`; `/unmatched` in the reference's
    /// telemetry when absent).
    pub route: Option<MatchedRoute>,
    /// The status sent, or `None` when the client went away before an answer was ready.
    pub status: Option<u16>,
    /// From the request arriving to the last response byte handed to the connection (or the
    /// client going away).
    pub duration: Duration,
    /// Response body bytes handed to the connection.
    pub bytes_sent: u64,
    /// The client went away before the response was complete (Node's `close` without `finish`).
    pub aborted: bool,
    /// The context [`Observer::on_request`] returned, or one middleware set later.
    pub trace: Option<TraceContext>,
}

/// The telemetry seam: sees every request start and end. Install one with
/// [`crate::App::observe`]. Calls happen on the request's task, so keep them short (record and
/// return; export elsewhere).
pub trait Observer: Send + Sync + 'static {
    /// A request arrived. The returned context is stored in the request
    /// ([`crate::Req::trace_context`]) and handed back in [`RequestEnd::trace`].
    fn on_request(&self, start: &RequestStart<'_>) -> Option<TraceContext> {
        let _ = start;
        None
    }

    /// The exchange is over: called exactly once per request.
    fn on_response(&self, end: RequestEnd);
}

/// The route dispatch selected last, shared by the request and the exchange's completion guard
/// so that an exchange abandoned while its route runs still reports the route.
#[derive(Clone, Default)]
pub(crate) struct RouteSlot(Arc<Mutex<Option<MatchedRoute>>>);

impl RouteSlot {
    pub(crate) fn set(&self, route: MatchedRoute) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(route);
    }

    fn get(&self) -> Option<MatchedRoute> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl std::fmt::Debug for RouteSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("RouteSlot").field(&self.get()).finish()
    }
}

/// Everything needed to report the end of one exchange, taken exactly once.
struct Completion {
    observer: Option<Arc<dyn Observer>>,
    closed: CancellationToken,
    started: Instant,
    method: Method,
    url: String,
    route: RouteSlot,
    status: Option<u16>,
    trace: Option<TraceContext>,
}

impl Completion {
    fn report(self, bytes_sent: u64, aborted: bool) {
        self.closed.cancel();
        if let Some(observer) = self.observer {
            observer.on_response(RequestEnd {
                method: self.method,
                url: self.url,
                route: self.route.get(),
                status: self.status,
                duration: self.started.elapsed(),
                bytes_sent,
                aborted,
                trace: self.trace,
            });
        }
    }
}

/// One exchange in progress; reports an abort if dropped before the answer was ready.
pub(crate) struct Exchange {
    completion: Option<Completion>,
}

impl Exchange {
    pub(crate) fn start(
        observer: Option<Arc<dyn Observer>>,
        closed: CancellationToken,
        method: Method,
        url: String,
        route: RouteSlot,
        trace: Option<TraceContext>,
    ) -> Self {
        Self {
            completion: Some(Completion {
                observer,
                closed,
                started: Instant::now(),
                method,
                url,
                route,
                status: None,
                trace,
            }),
        }
    }

    /// The answer is ready: its body now carries the completion.
    pub(crate) fn finish(
        mut self,
        response: http::Response<Body>,
        trace: Option<TraceContext>,
    ) -> http::Response<Body> {
        let Some(mut completion) = self.completion.take() else {
            return response;
        };
        let status = response.status().as_u16();
        completion.status = Some(status);
        if trace.is_some() {
            completion.trace = trace;
        }
        // Bodies hyper never sends: their end is the end of the exchange.
        let bodiless = completion.method == Method::HEAD
            || status == 204
            || status == 304
            || (100..200).contains(&status);
        response.map(|inner| {
            Body::new(Finish {
                inner,
                bytes: 0,
                ended: AtomicBool::new(false),
                bodiless,
                completion: Some(completion),
            })
        })
    }
}

impl Drop for Exchange {
    fn drop(&mut self) {
        // The handler's future was dropped: the client went away before an answer was ready.
        if let Some(completion) = self.completion.take() {
            completion.report(0, true);
        }
    }
}

/// A response body that reports the end of the exchange when it ends or is dropped.
struct Finish {
    inner: Body,
    bytes: u64,
    /// `is_end_stream` said so (hyper may then drop the body without polling it).
    ended: AtomicBool,
    bodiless: bool,
    completion: Option<Completion>,
}

impl Finish {
    fn complete(&mut self, aborted: bool) {
        if let Some(completion) = self.completion.take() {
            completion.report(self.bytes, aborted);
        }
    }
}

impl HttpBody for Finish {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        let polled = Pin::new(&mut self.inner).poll_frame(cx);
        match &polled {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    self.bytes += data.len() as u64;
                }
            }
            Poll::Ready(Some(Err(_))) => self.complete(true),
            Poll::Ready(None) => self.complete(false),
            Poll::Pending => {}
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        let ended = self.inner.is_end_stream();
        if ended {
            self.ended.store(true, Ordering::Release);
        }
        ended
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for Finish {
    fn drop(&mut self) {
        let finished = self.bodiless || self.ended.load(Ordering::Acquire);
        self.complete(!finished);
    }
}
