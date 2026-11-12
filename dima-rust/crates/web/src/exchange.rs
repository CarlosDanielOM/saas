//! The life of one exchange, from the request arriving to the last response byte or the client
//! going away: the close signal handlers can wait on and the telemetry seam.
//!
//! The server notices a client that goes away: hyper reads end-of-file while a request is in
//! progress or its response is streaming (half-close is off), closes the connection and drops
//! the handler's future or the response body. Both drops are seen here.

use std::any::Any;
use std::net::SocketAddr;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::HttpBody;
use bytes::Bytes;
use http::{HeaderMap, Method};
use hyper::body::{Frame, SizeHint};
use tokio::sync::Notify;
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
/// [`crate::App::observe`].
///
/// A panic in either call is caught and counted ([`ObserverQueue::panicked`]); it never reaches
/// the request. [`Observer::on_request`] runs on the request's task (it returns the context), so
/// keep it short. [`Observer::on_response`] runs on a thread of its own, fed through a bounded
/// queue the request never waits on: when the observer falls behind and the queue is full, the
/// record is dropped and counted ([`ObserverQueue::dropped`]). When [`crate::serve`] returns it
/// shuts down the observers of the apps it served ([`ObserverQueue::shutdown`]): records queued
/// by then are delivered for up to two seconds, later ones are dropped and counted.
pub trait Observer: Send + Sync + 'static {
    /// A request arrived. The returned context is stored in the request
    /// ([`crate::Req::trace_context`]) and handed back in [`RequestEnd::trace`]. A panic here
    /// counts as `None`.
    fn on_request(&self, start: &RequestStart<'_>) -> Option<TraceContext> {
        let _ = start;
        None
    }

    /// The exchange is over: called at most once per request (exactly once unless the record
    /// was dropped because the queue was full), in the order the exchanges ended, on the
    /// observer's own thread, some time after the request ended.
    fn on_response(&self, end: RequestEnd);
}

/// Completion records waiting for an observer by default ([`crate::App::observe`]).
pub const OBSERVER_QUEUE: usize = 4096;

/// Counters of one observer's delivery, shared with its thread.
#[derive(Debug, Default)]
struct DeliveryStats {
    dropped: AtomicU64,
    panicked: AtomicU64,
    /// Records queued and not yet delivered.
    pending: AtomicUsize,
    /// Woken after every delivery, and when the observer stops.
    delivered: Notify,
    /// Shutdown began: new records are dropped (and counted).
    closed: AtomicBool,
    /// Shut down: nothing more is waited for.
    stopped: AtomicBool,
}

impl DeliveryStats {
    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.delivered.notify_waiters();
    }
}

/// What the observer's thread receives.
enum Delivery {
    End(RequestEnd),
    /// Shutdown: stop once what was queued before is delivered.
    Stop,
}

/// A view of an observer's delivery queue ([`crate::App::observer_queue`]): what was dropped,
/// what panicked, a way to wait until everything queued so far was delivered, and shutdown.
#[derive(Debug, Clone)]
pub struct ObserverQueue {
    stats: Arc<DeliveryStats>,
    /// For the stop message; `None` when the thread could not be started.
    stop: Option<SyncSender<Delivery>>,
}

impl ObserverQueue {
    /// Completion records dropped because the queue was full (or the observer's thread could
    /// not be started).
    pub fn dropped(&self) -> u64 {
        self.stats.dropped.load(Ordering::Relaxed)
    }

    /// Observer calls that panicked (both kinds).
    pub fn panicked(&self) -> u64 {
        self.stats.panicked.load(Ordering::Relaxed)
    }

    /// Records queued and not yet delivered.
    pub fn pending(&self) -> usize {
        self.stats.pending.load(Ordering::Acquire)
    }

    /// The observer was shut down ([`ObserverQueue::shutdown`]).
    pub fn is_shut_down(&self) -> bool {
        self.stats.stopped.load(Ordering::Acquire)
    }

    /// Resolves once no record is waiting: every exchange that ended before the call has been
    /// delivered (or dropped). For tests and shutdown. Also resolves once the observer is shut
    /// down, even with records still waiting behind a callback that never returned.
    pub async fn idle(&self) {
        loop {
            let delivered = self.stats.delivered.notified();
            let mut delivered = std::pin::pin!(delivered);
            delivered.as_mut().enable();
            if self.pending() == 0 || self.is_shut_down() {
                return;
            }
            delivered.await;
        }
    }

    /// Shuts the observer down: from now on completion records are dropped (and counted); the
    /// ones already queued are delivered for up to `within`, then the observer is shut down
    /// whatever its callback is doing, and [`ObserverQueue::idle`] returns. Its thread ends
    /// after the last queued record (a callback that never returns keeps it until the process
    /// exits). [`crate::serve`] does this, with two seconds, for every observer it saw.
    pub async fn shutdown(&self, within: Duration) {
        self.stats.closed.store(true, Ordering::Release);
        if let Some(stop) = &self.stop {
            // When the queue is full the thread stops after delivering it instead.
            let _ = stop.try_send(Delivery::Stop);
        }
        let _ = tokio::time::timeout(within, self.idle()).await;
        self.stats.stop();
    }

    /// The same observer.
    pub(crate) fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.stats, &other.stats)
    }
}

/// An installed observer: `on_request` guarded on the request's task, `on_response` through the
/// bounded queue to the observer's thread. The thread ends when the last handle is dropped.
pub(crate) struct ObserverHub {
    observer: Arc<dyn Observer>,
    queue: Option<SyncSender<Delivery>>,
    stats: Arc<DeliveryStats>,
    /// The server this observer was last registered with ([`crate::serve`] shuts it down).
    registered: AtomicUsize,
}

impl ObserverHub {
    pub(crate) fn new(observer: Arc<dyn Observer>, capacity: usize) -> Self {
        let stats = Arc::new(DeliveryStats::default());
        let (sender, receiver) = std::sync::mpsc::sync_channel::<Delivery>(capacity.max(1));
        let delivering = Arc::clone(&observer);
        let thread_stats = Arc::clone(&stats);
        let spawned = std::thread::Builder::new()
            .name("dima-web-observer".to_owned())
            .spawn(move || {
                while let Ok(Delivery::End(end)) = receiver.recv() {
                    let call = AssertUnwindSafe(|| delivering.on_response(end));
                    if std::panic::catch_unwind(call).is_err() {
                        thread_stats.panicked.fetch_add(1, Ordering::Relaxed);
                    }
                    let left = thread_stats
                        .pending
                        .fetch_sub(1, Ordering::AcqRel)
                        .saturating_sub(1);
                    thread_stats.delivered.notify_waiters();
                    if left == 0 && thread_stats.closed.load(Ordering::Acquire) {
                        break;
                    }
                }
                // Records that raced with the shutdown are dropped and counted.
                while let Ok(delivery) = receiver.try_recv() {
                    if let Delivery::End(_) = delivery {
                        thread_stats.pending.fetch_sub(1, Ordering::AcqRel);
                        thread_stats.dropped.fetch_add(1, Ordering::Relaxed);
                    }
                }
                thread_stats.stop();
            });
        Self {
            observer,
            queue: spawned.ok().map(|_| sender),
            stats,
            registered: AtomicUsize::new(0),
        }
    }

    pub(crate) fn queue(&self) -> ObserverQueue {
        ObserverQueue {
            stats: Arc::clone(&self.stats),
            stop: self.queue.clone(),
        }
    }

    /// Registers this observer with the server `link` belongs to, once per server, so that
    /// shutdown drains it.
    pub(crate) fn register(&self, link: &crate::server::ServerLink) {
        let id = link.id();
        if self.registered.swap(id, Ordering::AcqRel) != id {
            link.register(self.queue());
        }
    }

    /// `on_request`, with a panic counted as `None`.
    pub(crate) fn on_request(&self, start: &RequestStart<'_>) -> Option<TraceContext> {
        let call = AssertUnwindSafe(|| self.observer.on_request(start));
        std::panic::catch_unwind(call).unwrap_or_else(|_| {
            self.stats.panicked.fetch_add(1, Ordering::Relaxed);
            None
        })
    }

    /// Queues the record without waiting; drops and counts it when the queue is full.
    fn deliver(&self, end: RequestEnd) {
        let queue = match &self.queue {
            Some(queue) if !self.stats.closed.load(Ordering::Acquire) => queue,
            _ => {
                self.stats.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
        };
        self.stats.pending.fetch_add(1, Ordering::AcqRel);
        if queue.try_send(Delivery::End(end)).is_err() {
            self.stats.pending.fetch_sub(1, Ordering::AcqRel);
            self.stats.dropped.fetch_add(1, Ordering::Relaxed);
            self.stats.delivered.notify_waiters();
        }
    }
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
    observer: Option<Arc<ObserverHub>>,
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
            observer.deliver(RequestEnd {
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
        observer: Option<Arc<ObserverHub>>,
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
        if trace.is_some() {
            completion.trace = trace;
        }
        attach(response, completion)
    }
}

/// The completion of an answer [`crate::App`] built, kept in the response's extensions so that
/// the server, when it sends another answer instead (the stream quota was full), reports the
/// answer that was sent.
#[derive(Clone)]
struct Answer(Arc<Mutex<Option<Completion>>>);

/// Wraps `response`'s body so that it reports `completion` with the response's status.
fn attach(response: http::Response<Body>, mut completion: Completion) -> http::Response<Body> {
    let status = response.status().as_u16();
    completion.status = Some(status);
    // Bodies hyper never sends: their end is the end of the exchange.
    let bodiless = completion.method == Method::HEAD
        || status == 204
        || status == 304
        || (100..200).contains(&status);
    let completion = Arc::new(Mutex::new(Some(completion)));
    let mut response = response.map(|inner| {
        Body::new(Finish {
            inner,
            bytes: 0,
            ended: AtomicBool::new(false),
            bodiless,
            completion: Arc::clone(&completion),
        })
    });
    response.extensions_mut().insert(Answer(completion));
    response
}

/// Sends `instead` in place of `built`: the exchange `built` would have reported (if it came
/// from an [`crate::App`]) is reported with `instead`'s status, bytes and end, and `built` is
/// dropped without a report.
pub(crate) fn replace_answer(
    built: http::Response<Body>,
    instead: http::Response<Body>,
) -> http::Response<Body> {
    let completion = built.extensions().get::<Answer>().and_then(|answer| {
        answer
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    });
    drop(built);
    match completion {
        Some(completion) => attach(instead, completion),
        None => instead,
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
    /// Shared with the response's [`Answer`]; taken by the first report.
    completion: Arc<Mutex<Option<Completion>>>,
}

impl Finish {
    fn complete(&mut self, aborted: bool) {
        let completion = self
            .completion
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(completion) = completion {
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
