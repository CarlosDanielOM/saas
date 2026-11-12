//! Serving: HTTP/1.1 connections on a bound listener, with upgrades and graceful shutdown.
//!
//! Bounds, with the defaults of [`ServeOptions`]:
//!
//! - **Connections**: at most [`ServeOptions::max_connections`] ordinary HTTP connections open
//!   at once. At the cap the server stops accepting: new connections wait in the kernel's listen
//!   backlog (511, as in Node) until one closes, and the kernel refuses connections once the
//!   backlog is full.
//! - **Long-lived streams**: a connection that is upgraded (`101`, WebSocket) or starts an
//!   event stream (`Content-Type: text/event-stream` on an answer with a body: not HEAD, 204 or
//!   304) moves from that cap to a quota of its own, [`ServeOptions::max_streams`], and stays
//!   there until it closes, so overlays holding streams open cannot shut ordinary HTTP out. An
//!   event stream is answered with `Connection: close`: when it ends the connection closes
//!   instead of serving more requests under the stream quota. When the stream quota is full
//!   the answer is replaced with `503 Service Unavailable` (the upgrade does not happen, the
//!   event stream's body is dropped and its senders see the client gone), and observers see
//!   that `503`. That check comes after the handler ran: an owner that creates something for
//!   its stream (a session) reserves the slot first with the request's [`StreamAdmission`] and
//!   refuses before creating anything.
//! - **Shutdown**: the server stops accepting, lets open requests finish and waits for upgraded
//!   sockets and their [`UpgradeGuard`]s, all up to [`ServeOptions::drain_timeout`]; then HTTP
//!   connections are aborted and every upgraded socket fails its reads and writes (the owner
//!   then drops it, which closes it).
//! - **Request head**: the request line and all header lines together at most 16 KiB (Node's
//!   `--max-http-header-size`), and at most 100 header lines; beyond either the answer is
//!   `431 Request Header Fields Too Large` and the connection closes. So a path with its query
//!   string, and any single header value, is under 16 KiB. Node keeps the first 2000 header
//!   lines and drops the rest instead of refusing.
//! - **Time**: 60 s for a request head, 300 s from the head to the end of the body, and 5 s of
//!   keep-alive idleness between requests (Node's `headersTimeout`, `requestTimeout` and
//!   `keepAliveTimeout`).
//! - **Slow readers**: a write to the client that stays pending without progress for 60 s
//!   ([`ServeOptions::write_stall_timeout`]) closes the connection, for ordinary responses,
//!   event streams and upgraded sockets alike. Node has no such bound: a client that stops
//!   reading kept its socket until the kernel gave up.

use std::convert::Infallible;
use std::future::Future as _;
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::BoxError;
use axum::body::HttpBody;
use bytes::Bytes;
use hyper::body::{Frame, Incoming, SizeHint};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::sync::{Mutex, PoisonError};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tokio::time::Instant;
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};
use tokio_util::task::TaskTracker;
use tokio_util::task::task_tracker::TaskTrackerToken;
use tower::ServiceExt as _;

use crate::Body;
use crate::request::PeerAddr;

/// Node's `--max-http-header-size` default: request line plus headers.
pub const MAX_HEAD_BYTES: usize = 16 * 1024;

/// Header lines accepted in one request head.
pub const MAX_HEADER_LINES: usize = 100;

/// Node's default listen backlog.
const LISTEN_BACKLOG: i32 = 511;

/// After the drain deadline, how long upgraded sockets that were made to fail get to be dropped
/// by their owners before `serve` returns anyway.
const FORCE_GRACE: Duration = Duration::from_secs(1);

/// Connection settings.
#[derive(Debug, Clone, Copy)]
pub struct ServeOptions {
    /// Time a client has to send a complete request head (Node's `server.headersTimeout`, 60 s).
    /// It also runs while a keep-alive connection waits for its next request, but the shorter
    /// [`ServeOptions::keep_alive_timeout`] closes idle connections first.
    pub header_read_timeout: Duration,
    /// Time from the request head to the end of its body (Node's `server.requestTimeout`,
    /// 300 s). A body still arriving after it fails to read, which body parsers report as 400.
    pub request_timeout: Duration,
    /// How long a keep-alive connection may sit idle (no request in progress, no bytes arriving)
    /// before it is closed (Node's `server.keepAliveTimeout`, 5 s). Streaming responses and
    /// slow handlers count as in progress.
    pub keep_alive_timeout: Duration,
    /// Ordinary HTTP connections served at once (10 000 by default; Node has no cap and stops
    /// only at the file-descriptor limit). At the cap the server stops accepting until a
    /// connection closes or moves to the stream quota; waiting clients queue in the kernel
    /// backlog.
    pub max_connections: usize,
    /// Long-lived streams open at once: upgraded connections and event streams, which leave the
    /// [`ServeOptions::max_connections`] cap when they start (10 000 by default). Beyond it the
    /// answer that would start one becomes `503`. A connection that served an event stream
    /// closes when the stream ends. Handlers can reserve a slot before they create anything
    /// with [`StreamAdmission`].
    pub max_streams: usize,
    /// After shutdown is requested, how long open connections may finish their requests, and
    /// upgraded connections may close, before they are closed.
    pub drain_timeout: Duration,
    /// How long a write to the client may stay pending without making progress before the
    /// connection is closed (60 s by default; `Duration::ZERO` turns the deadline off). It
    /// covers ordinary responses, event streams and upgraded sockets: a client that stops
    /// reading would otherwise hold its connection (or stream) slot for ever, since an answer in
    /// progress is never idle. Only a write that is waiting counts: a stream that has nothing to
    /// send for a while is not stalled. On an upgraded socket the stalled write fails with
    /// `TimedOut` and every later read and write with `ConnectionAborted`.
    pub write_stall_timeout: Duration,
}

impl Default for ServeOptions {
    fn default() -> Self {
        Self {
            header_read_timeout: Duration::from_secs(60),
            request_timeout: Duration::from_secs(300),
            keep_alive_timeout: Duration::from_secs(5),
            max_connections: 10_000,
            max_streams: 10_000,
            drain_timeout: Duration::from_secs(10),
            write_stall_timeout: Duration::from_secs(60),
        }
    }
}

/// Listens on `port` the way Node's `server.listen(port)` does: on `::` with IPv6-only off, so
/// IPv4 clients arrive as IPv4-mapped addresses and [`crate::Req::ip`] reads `::ffff:a.b.c.d`
/// (rate-limit keys contain that text); when IPv6 is unavailable, on `0.0.0.0`.
/// `SO_REUSEADDR` is set and the backlog is 511, as libuv does.
///
/// Must be called inside a Tokio runtime.
pub fn bind(port: u16) -> io::Result<TcpListener> {
    match bind_to(SocketAddr::from((Ipv6Addr::UNSPECIFIED, port))) {
        Ok(listener) => Ok(listener),
        Err(_) => bind_to(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port))),
    }
}

/// Listens on one address with Node's socket options (dual-stack when it is IPv6).
pub fn bind_to(address: SocketAddr) -> io::Result<TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let domain = if address.is_ipv6() {
        Domain::IPV6
    } else {
        Domain::IPV4
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;
    if address.is_ipv6() {
        socket.set_only_v6(false)?;
    }
    socket.set_reuse_address(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&address.into())?;
    socket.listen(LISTEN_BACKLOG)?;
    TcpListener::from_std(socket.into())
}

/// A request body that fails once the request deadline has passed.
struct DeadlineBody {
    inner: Incoming,
    deadline: Pin<Box<tokio::time::Sleep>>,
}

impl HttpBody for DeadlineBody {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        if self.deadline.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Some(Err("request timeout".into())));
        }
        Pin::new(&mut self.inner).poll_frame(cx).map_err(Into::into)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// What the keep-alive watcher of one connection knows: requests in progress, responses
/// finished and the last time anything happened.
struct Activity {
    started: Instant,
    /// Milliseconds after `started` of the last byte read or the last response finished.
    last: AtomicU64,
    /// Requests whose response is not finished (the response body not yet dropped).
    active: AtomicUsize,
    /// Responses finished. Before the first one only the header timeout applies, as in Node.
    finished: AtomicUsize,
}

impl Activity {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            last: AtomicU64::new(0),
            active: AtomicUsize::new(0),
            finished: AtomicUsize::new(0),
        }
    }

    fn touch(&self) {
        let elapsed = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last.fetch_max(elapsed, Ordering::Relaxed);
    }

    fn last(&self) -> Instant {
        self.started + Duration::from_millis(self.last.load(Ordering::Relaxed))
    }

    /// Resolves once the connection has been idle for `timeout` after a response.
    async fn idle(&self, timeout: Duration) {
        loop {
            tokio::time::sleep_until(self.last() + timeout).await;
            let busy = self.active.load(Ordering::Acquire) > 0
                || self.finished.load(Ordering::Acquire) == 0;
            if !busy && self.last() + timeout <= Instant::now() {
                return;
            }
            if busy {
                // Look again once a full idle period could have passed.
                tokio::time::sleep(timeout).await;
            }
        }
    }
}

/// Marks a request in progress until its response body is dropped.
struct InFlight(Arc<Activity>);

impl InFlight {
    fn new(activity: &Arc<Activity>) -> Self {
        activity.active.fetch_add(1, Ordering::AcqRel);
        Self(Arc::clone(activity))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.touch();
        self.0.finished.fetch_add(1, Ordering::AcqRel);
        self.0.active.fetch_sub(1, Ordering::AcqRel);
    }
}

/// A response body that keeps its request marked in progress while it is being sent.
struct TrackedBody {
    inner: Body,
    _in_flight: InFlight,
}

impl HttpBody for TrackedBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        Pin::new(&mut self.inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Which quota a connection counts against: ordinary HTTP, or long-lived streams once it was
/// upgraded or started an event stream. Shared by the socket (which holds it for as long as it
/// lives, upgraded or not) and the connection's request handling (which moves it).
struct Slot(Mutex<Quota>);

/// The permit held and the quota it came from.
struct Quota {
    stream: bool,
    _permit: OwnedSemaphorePermit,
}

impl Slot {
    fn http(permit: OwnedSemaphorePermit) -> Self {
        Self(Mutex::new(Quota {
            stream: false,
            _permit: permit,
        }))
    }

    /// Moves the connection to the stream quota (releasing its HTTP slot), with the permit a
    /// handler reserved or a new one; `false` when there was no reservation and the stream
    /// quota is full.
    fn promote(&self, streams: &Arc<Semaphore>, reserved: Option<OwnedSemaphorePermit>) -> bool {
        let mut quota = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if quota.stream {
            return true;
        }
        match reserved.map_or_else(|| Arc::clone(streams).try_acquire_owned(), Ok) {
            Ok(permit) => {
                *quota = Quota {
                    stream: true,
                    _permit: permit,
                };
                true
            }
            Err(_) => false,
        }
    }
}

/// The stream quota as one request sees it: [`serve`] puts one in the extensions of every
/// request (beside the [`UpgradeGuard`] of an upgrade request), so the owner of an upgrade or
/// an event stream can reserve its slot before it creates anything (a session, a subscription)
/// and refuse cleanly when there is none. Read it with [`crate::Req::stream_admission`], or
/// from `http::Request::extensions` in a service in front of the [`crate::App`].
///
/// - [`StreamAdmission::reserve`] takes a slot now or answers [`StreamsFull`]. Reserving again
///   is a no-op.
/// - An answer that starts a stream (`101`, or an event stream with a body) for a request with a
///   reservation is promoted with it, without a second check. Any other answer gives the slot
///   back, and so does a request that ends without an answer.
/// - Owners that do not reserve still get the late check: when the quota is full at the moment
///   the answer is ready, the client receives `503` instead (see [`ServeOptions::max_streams`]).
///
/// Clones share the reservation. Once the request's answer was handed to the connection,
/// `reserve` answers [`StreamsFull`].
#[derive(Clone)]
pub struct StreamAdmission {
    streams: Arc<Semaphore>,
    state: Arc<Mutex<Admission>>,
}

/// Where one request's reservation stands.
enum Admission {
    Open,
    Reserved(OwnedSemaphorePermit),
    /// The answer was handed over (the permit, if any, went with it).
    Settled,
}

/// [`StreamAdmission::reserve`]: no stream slot is free.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the stream quota is full")]
pub struct StreamsFull;

impl std::fmt::Debug for StreamAdmission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamAdmission")
            .field("reserved", &self.is_reserved())
            .field("available", &self.streams.available_permits())
            .finish()
    }
}

impl StreamAdmission {
    fn new(streams: &Arc<Semaphore>) -> Self {
        Self {
            streams: Arc::clone(streams),
            state: Arc::new(Mutex::new(Admission::Open)),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Admission> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Reserves a stream slot for this request's answer, or says the quota is full.
    pub fn reserve(&self) -> Result<(), StreamsFull> {
        let mut state = self.lock();
        match &*state {
            Admission::Reserved(_) => Ok(()),
            Admission::Settled => Err(StreamsFull),
            Admission::Open => match Arc::clone(&self.streams).try_acquire_owned() {
                Ok(permit) => {
                    *state = Admission::Reserved(permit);
                    Ok(())
                }
                Err(_) => Err(StreamsFull),
            },
        }
    }

    /// A slot is reserved for this request.
    pub fn is_reserved(&self) -> bool {
        matches!(&*self.lock(), Admission::Reserved(_))
    }

    /// Gives a reserved slot back (the owner decided not to start a stream after all).
    pub fn release(&self) {
        let mut state = self.lock();
        if matches!(&*state, Admission::Reserved(_)) {
            *state = Admission::Open;
        }
    }

    /// The answer is ready: the reserved permit, if any; later reservations are refused.
    fn settle(&self) -> Option<OwnedSemaphorePermit> {
        match std::mem::replace(&mut *self.lock(), Admission::Settled) {
            Admission::Reserved(permit) => Some(permit),
            Admission::Open | Admission::Settled => None,
        }
    }
}

/// What the server shares with every connection.
#[derive(Clone)]
struct Shared {
    streams: Arc<Semaphore>,
    /// Every socket holds a token until it is dropped; shutdown waits for them.
    sockets: TaskTracker,
    /// Cancelled when shutdown begins: upgrade owners watch it ([`UpgradeGuard::shutdown`]).
    shutdown: CancellationToken,
    /// Cancelled at the drain deadline: every socket still open fails its reads and writes.
    force: CancellationToken,
}

/// What an upgrade owner holds: a token to watch and a guard that keeps shutdown waiting.
///
/// [`serve`] puts one in the extensions of every request that asks for an upgrade; take it with
/// [`crate::Req::take_upgrade_guard`] (or from `http::Request::extensions_mut` in a service in
/// front of the [`crate::App`]) together with the upgrade itself. The contract:
///
/// - Hold the guard (move it into the task that owns the upgraded socket) for as long as you
///   own the socket; drop it when you are done.
/// - Watch [`UpgradeGuard::shutdown`]: when it is cancelled the server is shutting down. Say
///   goodbye (a WebSocket close frame, a Socket.IO disconnect) and drop the socket and the
///   guard.
/// - Shutdown waits for every guard and every upgraded socket up to
///   [`ServeOptions::drain_timeout`]. After it, the socket's reads and writes fail with
///   `ConnectionAborted` (a pending read is woken); drop it then. `serve` returns at most one
///   more second later whatever the owners do.
/// - An owner whose socket's I/O cannot finish on its own (a write pending to a peer that
///   stopped reading) can end it before that with [`UpgradeGuard::abort`]: the same failure,
///   for this connection only.
///
/// The connection counts against [`ServeOptions::max_streams`] once the `101` is sent, until the
/// socket is dropped. To refuse before creating a session when that quota is full, reserve the
/// slot first with the request's [`StreamAdmission`]. A clone is a second guard: shutdown waits for every one.
#[derive(Clone)]
pub struct UpgradeGuard {
    shutdown: CancellationToken,
    /// This connection's share of the drain deadline: cancelled by it, or by [`Self::abort`].
    abort: CancellationToken,
    _tracked: TaskTrackerToken,
}

impl std::fmt::Debug for UpgradeGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpgradeGuard")
            .field("shutting_down", &self.shutdown.is_cancelled())
            .finish_non_exhaustive()
    }
}

impl UpgradeGuard {
    /// Cancelled when the server begins to shut down.
    pub fn shutdown(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    /// Resolves when the server begins to shut down.
    pub async fn shutting_down(&self) {
        self.shutdown.cancelled().await;
    }

    /// Fails this connection's reads and writes from now on with `ConnectionAborted` (a pending
    /// read or write is woken), as the drain deadline does for every connection. For an owner
    /// that cannot otherwise stop I/O it does not drive itself, such as a library's writer stuck
    /// on a peer that stopped reading. The owner then drops the socket, which closes it.
    pub fn abort(&self) {
        self.abort.cancel();
    }
}

/// The connection's socket: notes reads for the keep-alive watcher, holds the connection's slot
/// for as long as the socket lives (an upgrade takes the socket, and the slot with it), keeps
/// shutdown waiting, fails every read and write once shutdown forces it closed or its upgrade
/// owner aborts it, and gives up on a write that stays pending without progress for
/// [`ServeOptions::write_stall_timeout`].
struct ConnectionIo {
    stream: TcpStream,
    activity: Arc<Activity>,
    _slot: Arc<Slot>,
    _tracked: TaskTrackerToken,
    /// Two waiters, so a reader and a writer on different tasks are both woken.
    forced_read: Pin<Box<WaitForCancellationFutureOwned>>,
    forced_write: Pin<Box<WaitForCancellationFutureOwned>>,
    /// This connection's abort: cancelled when a write stalls, so reads fail too.
    abort: CancellationToken,
    stall: WriteStall,
}

/// The write-stall deadline of one socket: armed when a write first returns `Pending`, disarmed
/// by any write that makes progress.
struct WriteStall {
    timeout: Duration,
    /// Created on the first stall and reset afterwards.
    timer: Option<Pin<Box<tokio::time::Sleep>>>,
    armed: bool,
}

impl WriteStall {
    fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            timer: None,
            armed: false,
        }
    }

    /// Notes the outcome of a write; `true` when it has now been pending for too long.
    fn stalled<T>(&mut self, polled: &Poll<io::Result<T>>, cx: &mut Context<'_>) -> bool {
        if !polled.is_pending() {
            self.armed = false;
            return false;
        }
        if self.timeout.is_zero() {
            return false;
        }
        let deadline = Instant::now() + self.timeout;
        let timer = self
            .timer
            .get_or_insert_with(|| Box::pin(tokio::time::sleep_until(deadline)));
        if !self.armed {
            self.armed = true;
            timer.as_mut().reset(deadline);
        }
        timer.as_mut().poll(cx).is_ready()
    }
}

fn forced() -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionAborted, "server shut down")
}

fn write_stalled() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "write stalled")
}

impl ConnectionIo {
    fn forced_write(&mut self, cx: &mut Context<'_>) -> bool {
        self.forced_write.as_mut().poll(cx).is_ready()
    }

    /// A write's outcome, failed (and the connection aborted) once it stalled for too long.
    fn checked<T>(
        &mut self,
        polled: Poll<io::Result<T>>,
        cx: &mut Context<'_>,
    ) -> Poll<io::Result<T>> {
        if self.stall.stalled(&polled, cx) {
            self.abort.cancel();
            return Poll::Ready(Err(write_stalled()));
        }
        polled
    }
}

impl AsyncRead for ConnectionIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.forced_read.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(forced()));
        }
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.stream).poll_read(cx, buf);
        if matches!(polled, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.activity.touch();
        }
        polled
    }
}

impl AsyncWrite for ConnectionIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.forced_write(cx) {
            return Poll::Ready(Err(forced()));
        }
        let polled = Pin::new(&mut self.stream).poll_write(cx, buf);
        self.checked(polled, cx)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.forced_write(cx) {
            return Poll::Ready(Err(forced()));
        }
        let polled = Pin::new(&mut self.stream).poll_flush(cx);
        self.checked(polled, cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        if self.forced_write(cx) {
            return Poll::Ready(Err(forced()));
        }
        let polled = Pin::new(&mut self.stream).poll_write_vectored(cx, bufs);
        self.checked(polled, cx)
    }

    fn is_write_vectored(&self) -> bool {
        self.stream.is_write_vectored()
    }
}

/// Serves `service` on `listener` until `shutdown` is cancelled, then stops accepting, lets open
/// requests finish and upgraded connections close (up to [`ServeOptions::drain_timeout`]) and
/// returns.
///
/// Every request carries the connection's [`PeerAddr`] in its extensions, and a request that
/// asks for an upgrade also carries hyper's upgrade handle and an [`UpgradeGuard`], so a service
/// in front of the [`crate::App`] (Socket.IO) or a handler ([`crate::Req::take_upgrade`]) can
/// take over the connection on the same port.
pub async fn serve<T, B>(
    listener: TcpListener,
    service: T,
    shutdown: CancellationToken,
    options: ServeOptions,
) -> io::Result<()>
where
    T: tower::Service<http::Request<Body>, Response = http::Response<B>, Error = Infallible>
        + Clone
        + Send
        + 'static,
    T::Future: Send + 'static,
    B: HttpBody<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    let slots = Arc::new(Semaphore::new(options.max_connections.max(1)));
    let shared = Shared {
        streams: Arc::new(Semaphore::new(options.max_streams.max(1))),
        sockets: TaskTracker::new(),
        shutdown: shutdown.clone(),
        force: CancellationToken::new(),
    };
    let mut connections = JoinSet::new();
    let mut slot: Option<OwnedSemaphorePermit> = None;
    loop {
        tokio::select! {
            () = shutdown.cancelled() => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            // At the cap no slot is free, so nothing is accepted until a connection closes.
            acquired = Arc::clone(&slots).acquire_owned(), if slot.is_none() => match acquired {
                Ok(permit) => slot = Some(permit),
                Err(_) => break,
            },
            accepted = listener.accept(), if slot.is_some() => match accepted {
                Ok((stream, peer)) => {
                    if let Some(permit) = slot.take() {
                        let service = service.clone();
                        let shared = shared.clone();
                        connections.spawn(connection(stream, peer, permit, service, shared, options));
                    }
                }
                // Accept errors (descriptor exhaustion, aborted handshakes) are transient: like
                // Node, keep listening, after a short pause so a hot loop cannot form.
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            },
        }
    }
    drop(listener);
    shared.sockets.close();
    // HTTP connections finish their requests; upgrade owners saw the shutdown token and close.
    let drained = tokio::time::timeout(options.drain_timeout, async {
        while connections.join_next().await.is_some() {}
        shared.sockets.wait().await;
    })
    .await;
    if drained.is_err() {
        shared.force.cancel();
        connections.shutdown().await;
        let _ = tokio::time::timeout(FORCE_GRACE, shared.sockets.wait()).await;
    }
    Ok(())
}

/// An answer that starts a long-lived stream: a protocol switch, or an event stream with a body
/// (not the answer to HEAD, not 204, 304 or another informational status).
fn is_long_lived<B>(method: &http::Method, response: &http::Response<B>) -> bool {
    let status = response.status();
    if status == http::StatusCode::SWITCHING_PROTOCOLS {
        return true;
    }
    if method == http::Method::HEAD
        || status == http::StatusCode::NO_CONTENT
        || status == http::StatusCode::NOT_MODIFIED
        || status.is_informational()
    {
        return false;
    }
    response
        .headers()
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .trim_start()
                .get(..17)
                .is_some_and(|kind| kind.eq_ignore_ascii_case("text/event-stream"))
        })
}

/// The answer when the stream quota is full.
fn streams_full() -> http::Response<Body> {
    let mut response = http::Response::new(Body::from("Service Unavailable"));
    *response.status_mut() = http::StatusCode::SERVICE_UNAVAILABLE;
    response.headers_mut().insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

async fn connection<T, B>(
    stream: TcpStream,
    peer: SocketAddr,
    permit: OwnedSemaphorePermit,
    service: T,
    shared: Shared,
    options: ServeOptions,
) where
    T: tower::Service<http::Request<Body>, Response = http::Response<B>, Error = Infallible>
        + Clone
        + Send
        + 'static,
    T::Future: Send + 'static,
    B: HttpBody<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    // Node sets TCP_NODELAY on server sockets by default.
    let _ = stream.set_nodelay(true);
    let activity = Arc::new(Activity::new());
    let slot = Arc::new(Slot::http(permit));
    // Fires at the drain deadline, or when an upgrade owner aborts this connection.
    let abort = shared.force.child_token();
    let io = ConnectionIo {
        stream,
        activity: Arc::clone(&activity),
        _slot: Arc::clone(&slot),
        _tracked: shared.sockets.token(),
        forced_read: Box::pin(abort.clone().cancelled_owned()),
        forced_write: Box::pin(abort.clone().cancelled_owned()),
        abort: abort.clone(),
        stall: WriteStall::new(options.write_stall_timeout),
    };
    let tracker = Arc::clone(&activity);
    let shutdown = shared.shutdown.clone();
    let handler = hyper::service::service_fn(move |request: http::Request<Incoming>| {
        let in_flight = InFlight::new(&tracker);
        let deadline = Box::pin(tokio::time::sleep(options.request_timeout));
        let mut request = request.map(|inner| Body::new(DeadlineBody { inner, deadline }));
        request.extensions_mut().insert(PeerAddr(peer));
        let admission = StreamAdmission::new(&shared.streams);
        request.extensions_mut().insert(admission.clone());
        if request
            .extensions()
            .get::<hyper::upgrade::OnUpgrade>()
            .is_some()
        {
            request.extensions_mut().insert(UpgradeGuard {
                shutdown: shared.shutdown.clone(),
                abort: abort.clone(),
                _tracked: shared.sockets.token(),
            });
        }
        let method = request.method().clone();
        let response = service.clone().oneshot(request);
        let slot = Arc::clone(&slot);
        let streams = Arc::clone(&shared.streams);
        async move {
            let mut response = response.await?.map(Body::new);
            let reserved = admission.settle();
            if is_long_lived(&method, &response) {
                if !slot.promote(&streams, reserved) {
                    response = crate::exchange::replace_answer(response, streams_full());
                } else if response.status() != http::StatusCode::SWITCHING_PROTOCOLS {
                    // The stream slot stays with the connection until it closes, so it must
                    // not go back to ordinary requests: close it when the stream ends.
                    response.headers_mut().insert(
                        http::header::CONNECTION,
                        http::HeaderValue::from_static("close"),
                    );
                }
            }
            Ok::<_, Infallible>(response.map(|inner| TrackedBody {
                inner,
                _in_flight: in_flight,
            }))
        }
    });
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder
        .timer(TokioTimer::new())
        .header_read_timeout(options.header_read_timeout)
        .max_header_size(MAX_HEAD_BYTES)
        .max_headers(MAX_HEADER_LINES)
        .keep_alive(true);
    let connection = builder
        .serve_connection(TokioIo::new(io), handler)
        .with_upgrades();
    let mut connection = std::pin::pin!(connection);
    tokio::select! {
        _ = connection.as_mut() => {}
        () = activity.idle(options.keep_alive_timeout) => {
            connection.as_mut().graceful_shutdown();
            let _ = connection.await;
        }
        () = shutdown.cancelled() => {
            connection.as_mut().graceful_shutdown();
            let _ = connection.await;
        }
    }
}
