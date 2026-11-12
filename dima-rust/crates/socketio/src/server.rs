//! The server: declarations, the Engine.IO handler, the connections and shutdown.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use bytes::Bytes;
use dima_core::{Clock, SecureRandom, Shutdown, SystemClock, SystemRandom};
use engineioxide::config::EngineIoConfig;
use engineioxide::handler::EngineIoHandler;
use engineioxide::service::{EngineIoService, NotFoundService};
use engineioxide::{DisconnectReason as EngineReason, Str};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::config::Options;
use crate::connection::{Connection, EngineData, EngineSocket};
use crate::error::{BuildError, ConnectError};
use crate::handshake::{Handshake, Origin};
use crate::ids::Offsets;
use crate::namespace::{Def, ErasedDef, Matcher, Namespace, NamespaceOptions, NamespaceRef};
use crate::outbox::{CONTROL_PACKETS, HEADROOM};
use crate::pattern::Pattern;
use crate::recovery;
use crate::telemetry::{NoTelemetry, Telemetry};

/// What the server injects: the wall clock (recovery expiry and offsets), the secure generator
/// (socket and private ids) and the telemetry seam.
#[derive(Clone)]
pub struct Runtime {
    /// `Date.now()`.
    pub clock: Arc<dyn Clock>,
    /// Socket ids and private session ids.
    pub random: Arc<dyn SecureRandom>,
    /// Counters.
    pub telemetry: Arc<dyn Telemetry>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            clock: Arc::new(SystemClock),
            random: Arc::new(SystemRandom),
            telemetry: Arc::new(NoTelemetry),
        }
    }
}

impl std::fmt::Debug for Runtime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Runtime")
            .field("clock", &self.clock)
            .finish_non_exhaustive()
    }
}

/// What every part of the server shares.
pub(crate) struct Shared {
    pub options: Options,
    pub clock: Arc<dyn Clock>,
    pub random: Arc<dyn SecureRandom>,
    pub telemetry: Arc<dyn Telemetry>,
    pub offsets: Offsets,
    /// Bytes queued for all clients.
    pub outbound_bytes: AtomicUsize,
    pub recovery: recovery::Totals,
    /// Server-to-client acknowledgements awaited.
    pub pending_acks: AtomicUsize,
    namespaces: AtomicUsize,
    next_key: AtomicU64,
    next_ack: AtomicU64,
    /// Every task the server starts.
    pub tasks: TaskTracker,
    /// Shutdown has begun: no new connection, no new socket.
    pub stop: CancellationToken,
    /// The drain deadline has passed: handlers still running are dropped.
    pub hard_stop: CancellationToken,
}

impl Shared {
    pub fn stopping(&self) -> bool {
        self.stop.is_cancelled()
    }

    pub fn next_key(&self) -> u64 {
        self.next_key.fetch_add(1, Ordering::Relaxed)
    }

    /// The id of a server-to-client acknowledgement.
    pub fn next_ack_id(&self) -> u64 {
        self.next_ack.fetch_add(1, Ordering::Relaxed)
    }

    /// Counts a new concrete namespace; `false` at `max_namespaces`.
    pub fn reserve_namespace(&self) -> bool {
        let max = self.options.max_namespaces;
        self.namespaces
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < max).then_some(n + 1)
            })
            .is_ok()
    }

    pub fn release_namespace(&self) {
        let _ = self
            .namespaces
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                Some(n.saturating_sub(1))
            });
    }

    pub fn namespace_count(&self) -> usize {
        self.namespaces.load(Ordering::Acquire)
    }
}

/// The declarations, fixed when the server is built.
pub(crate) struct Registry {
    statics: HashMap<String, Arc<dyn ErasedDef>>,
    families: Vec<Arc<dyn ErasedDef>>,
}

impl Registry {
    /// The declaration for a name: a static one first, then the first family that matches
    /// (`_checkNamespace` tries the parents in the order they were declared).
    pub fn lookup(&self, name: &str) -> Option<Arc<dyn ErasedDef>> {
        self.statics
            .get(name)
            .cloned()
            .or_else(|| self.families.iter().find(|def| def.matches(name)).cloned())
    }

    fn all(&self) -> impl Iterator<Item = &Arc<dyn ErasedDef>> {
        self.statics.values().chain(self.families.iter())
    }
}

/// The reference's `/` namespace: present, with no handler.
struct Root;

impl Namespace for Root {
    type Data = ();

    async fn check(&self, _handshake: &Handshake, _namespace: &str) -> Result<(), ConnectError> {
        Ok(())
    }
}

/// Declares the namespaces, then builds the server.
pub struct Builder {
    shared: Arc<Shared>,
    statics: HashMap<String, Arc<dyn ErasedDef>>,
    families: Vec<Arc<dyn ErasedDef>>,
    largest_queue: usize,
    shutdown: Shutdown,
}

impl std::fmt::Debug for Builder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Builder")
            .field("statics", &self.statics.keys().collect::<Vec<_>>())
            .field("families", &self.families.len())
            .finish_non_exhaustive()
    }
}

impl Builder {
    /// A server with `options`, the injected `runtime`, stopped by `shutdown`.
    pub fn new(options: Options, runtime: Runtime, shutdown: Shutdown) -> Self {
        let largest_queue = options.queue.packets;
        let shared = Arc::new(Shared {
            options,
            clock: runtime.clock,
            random: runtime.random,
            telemetry: runtime.telemetry,
            offsets: Offsets::default(),
            outbound_bytes: AtomicUsize::new(0),
            recovery: recovery::Totals::default(),
            pending_acks: AtomicUsize::new(0),
            namespaces: AtomicUsize::new(0),
            next_key: AtomicU64::new(1),
            next_ack: AtomicU64::new(0),
            tasks: TaskTracker::new(),
            stop: CancellationToken::new(),
            hard_stop: CancellationToken::new(),
        });
        Self {
            shared,
            statics: HashMap::new(),
            families: Vec::new(),
            largest_queue,
            shutdown,
        }
    }

    fn note_queue(&mut self, options: &NamespaceOptions) {
        if let Some(queue) = options.queue {
            self.largest_queue = self.largest_queue.max(queue.packets);
        }
    }

    /// `io.of("/name")`: a static namespace.
    pub fn namespace<N: Namespace>(
        &mut self,
        name: &str,
        options: NamespaceOptions,
        handler: N,
    ) -> Result<NamespaceRef<N>, BuildError> {
        if !name.starts_with('/') {
            return Err(BuildError::BadName(name.to_owned()));
        }
        if self.statics.contains_key(name) {
            return Err(BuildError::Duplicate(name.to_owned()));
        }
        self.note_queue(&options);
        let def = Arc::new(Def::new(
            Arc::clone(&self.shared),
            handler,
            options,
            Matcher::Static(name.to_owned()),
        ));
        self.shared.reserve_namespace();
        self.statics
            .insert(name.to_owned(), Arc::clone(&def) as Arc<dyn ErasedDef>);
        Ok(NamespaceRef { def })
    }

    /// `io.of(/^…$/)`: a family of namespaces named by an anchored pattern (see [`Pattern`]).
    /// Members are created when a client joins one and released when the last socket leaves.
    pub fn family<N: Namespace>(
        &mut self,
        pattern: &str,
        options: NamespaceOptions,
        handler: N,
    ) -> Result<NamespaceRef<N>, BuildError> {
        let pattern = Pattern::new(pattern)?;
        self.note_queue(&options);
        let def = Arc::new(Def::new(
            Arc::clone(&self.shared),
            handler,
            options,
            Matcher::Family(pattern),
        ));
        self.families.push(Arc::clone(&def) as Arc<dyn ErasedDef>);
        Ok(NamespaceRef { def })
    }

    /// Builds the server for the `dima_web` server that will serve it (`serve` are the options
    /// given to `dima_web::serve`). Must be called inside a Tokio runtime: it starts the task
    /// that runs the shutdown when the token fires.
    ///
    /// Refuses ([`BuildError::StreamQuota`]) when `max_connections` is larger than
    /// `serve.max_streams`: every WebSocket of this server also holds one of the web server's
    /// stream slots (reserved before its handshake reaches Engine.IO), so a larger cap here
    /// would promise connections the web server refuses.
    pub fn build(mut self, serve: &dima_web::ServeOptions) -> Result<SocketIo, BuildError> {
        let connections = self.shared.options.max_connections;
        if connections > serve.max_streams {
            return Err(BuildError::StreamQuota {
                connections,
                streams: serve.max_streams,
            });
        }
        if !self.statics.contains_key("/") {
            let def = Arc::new(Def::new(
                Arc::clone(&self.shared),
                Root,
                NamespaceOptions::default(),
                Matcher::Static("/".to_owned()),
            ));
            self.shared.reserve_namespace();
            self.statics.insert("/".to_owned(), def);
        }
        let options = &self.shared.options;
        // Room in the transport channel for every socket's queue, the control packets and the
        // heartbeat.
        let capacity = options
            .max_namespaces_per_connection
            .max(1)
            .saturating_mul(self.largest_queue.max(1))
            .saturating_add(CONTROL_PACKETS + HEADROOM);
        let config = EngineIoConfig::builder()
            .req_path("/socket.io/")
            .ping_interval(options.ping_interval)
            .ping_timeout(options.ping_timeout)
            .upgrade_timeout(options.upgrade_timeout)
            .max_buffer_size(capacity)
            .max_payload(options.max_http_buffer_size)
            .ws_max_message_size(
                usize::try_from(options.max_http_buffer_size).unwrap_or(usize::MAX),
            )
            .ws_max_frame_size(usize::try_from(options.max_http_buffer_size).unwrap_or(usize::MAX))
            .build();
        let registry = Arc::new(Registry {
            statics: self.statics,
            families: self.families,
        });
        let shared = self.shared;
        let inner = Arc::new_cyclic(|weak: &Weak<ServerInner>| ServerInner {
            shared: Arc::clone(&shared),
            registry,
            connections: Mutex::new(HashMap::new()),
            engine: EngineIoService::with_config(
                Arc::new(EngineHandler {
                    server: weak.clone(),
                }),
                config,
            ),
            connection_slots: Arc::new(tokio::sync::Semaphore::new(
                shared.options.max_connections,
            )),
            capacity,
            shutting_down: AtomicBool::new(false),
            done: CancellationToken::new(),
            watching_guards: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&inner);
        let shutdown = self.shutdown;
        tokio::spawn(async move {
            shutdown.wait().await;
            if let Some(inner) = weak.upgrade() {
                SocketIo { inner }.shutdown().await;
            }
        });
        // The reference's adapters sweep every 60 s; stores here are also swept when touched.
        let weak = Arc::downgrade(&inner);
        let every = shared
            .options
            .recovery_sweep_interval
            .max(Duration::from_secs(1));
        let stop = shared.stop.clone();
        shared.tasks.spawn(async move {
            let mut tick = tokio::time::interval(every);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    () = stop.cancelled() => return,
                    _ = tick.tick() => {}
                }
                let Some(inner) = weak.upgrade() else { return };
                for def in inner.registry.all() {
                    def.sweep();
                }
            }
        });
        Ok(SocketIo { inner })
    }
}

pub(crate) struct ServerInner {
    pub shared: Arc<Shared>,
    pub registry: Arc<Registry>,
    connections: Mutex<HashMap<String, Arc<Connection>>>,
    pub engine: EngineIoService<EngineHandler, NotFoundService>,
    /// `max_connections` slots: each Engine.IO session holds one from its handshake to its end.
    connection_slots: Arc<tokio::sync::Semaphore>,
    capacity: usize,
    shutting_down: AtomicBool,
    done: CancellationToken,
    watching_guards: AtomicBool,
}

impl ServerInner {
    fn connections(&self) -> MutexGuard<'_, HashMap<String, Arc<Connection>>> {
        self.connections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// The connection with this Engine.IO session id.
    pub fn connection(&self, sid: &str) -> Option<Arc<Connection>> {
        self.connections().get(sid).cloned()
    }

    pub fn connection_count(&self) -> usize {
        self.connections().len()
    }

    /// A connection slot (`max_connections`), or `None` when every one is taken or the server
    /// is stopping.
    pub fn reserve_connection(&self) -> Option<tokio::sync::OwnedSemaphorePermit> {
        if self.shared.stopping() {
            return None;
        }
        Arc::clone(&self.connection_slots).try_acquire_owned().ok()
    }

    /// Runs the shutdown when the server that delivers upgrades shuts down (the
    /// [`dima_web::UpgradeGuard`] contract), in case the binary passed a different token.
    pub fn watch_guard(self: &Arc<Self>, token: CancellationToken) {
        if self.watching_guards.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            token.cancelled().await;
            if let Some(inner) = weak.upgrade() {
                SocketIo { inner }.shutdown().await;
            }
        });
    }
}

/// The Engine.IO side: sessions opening and closing, and their messages.
pub(crate) struct EngineHandler {
    server: Weak<ServerInner>,
}

impl std::fmt::Debug for EngineHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EngineHandler")
    }
}

impl EngineIoHandler for EngineHandler {
    type Data = EngineData;

    fn on_connect(self: Arc<Self>, socket: Arc<EngineSocket>) {
        let Some(server) = self.server.upgrade() else {
            socket.close(EngineReason::ClosingServer);
            return;
        };
        if server.shared.stopping() {
            socket.close(EngineReason::ClosingServer);
            return;
        }
        let first_request = socket
            .req_parts
            .extensions
            .get::<crate::service::FirstRequest>();
        // The slot reserved by the handshake (always there for a handshake that came through
        // the service; taken here otherwise).
        let permit = first_request
            .and_then(crate::service::FirstRequest::take_permit)
            .or_else(|| server.reserve_connection());
        let Some(permit) = permit else {
            server.shared.telemetry.connection_refused();
            socket.close(EngineReason::ClosingServer);
            return;
        };
        let (first, guard) = match first_request {
            Some(first) => (Arc::clone(&first.origin), first.take_guard()),
            None => (
                Arc::new(Origin {
                    headers: socket.req_parts.headers.clone(),
                    url: socket.req_parts.uri.to_string(),
                    query: crate::handshake::Query::parse(
                        socket.req_parts.uri.query().unwrap_or(""),
                    ),
                    peer: socket
                        .req_parts
                        .extensions
                        .get::<dima_web::PeerAddr>()
                        .map(|peer| peer.0),
                }),
                None,
            ),
        };
        let conn = Connection::new(
            Arc::clone(&server.shared),
            Arc::clone(&server.registry),
            Arc::clone(&socket),
            first,
            guard,
            permit,
            server.capacity,
        );
        socket.data.set(Arc::clone(&conn));
        server
            .connections()
            .insert(socket.id.as_str().to_owned(), Arc::clone(&conn));
        server.shared.telemetry.connection_opened();
        server.shared.tasks.spawn(conn.run());
    }

    fn on_disconnect(&self, socket: Arc<EngineSocket>, reason: EngineReason) {
        let conn = socket.data.take();
        if let Some(server) = self.server.upgrade() {
            server.connections().remove(socket.id.as_str());
        }
        if let Some(conn) = conn {
            conn.on_engine_closed(&reason);
        }
    }

    fn on_message(self: &Arc<Self>, msg: Str, socket: Arc<EngineSocket>) {
        if let Some(conn) = socket.data.get() {
            conn.on_message(&msg);
        }
    }

    fn on_binary(self: &Arc<Self>, _data: Bytes, socket: Arc<EngineSocket>) {
        if let Some(conn) = socket.data.get() {
            conn.on_binary();
        }
    }
}

/// The Socket.IO server. Clones share it.
///
/// Mount it with [`SocketIo::layer`] in front of the `dima_web::App`, serve that with
/// `dima_web::serve` and the same shutdown token the server was built with, and wait for
/// [`SocketIo::closed`] next to `serve` so the drain finishes before the process exits.
#[derive(Clone)]
pub struct SocketIo {
    pub(crate) inner: Arc<ServerInner>,
}

impl std::fmt::Debug for SocketIo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SocketIo")
            .field("connections", &self.inner.connection_count())
            .finish_non_exhaustive()
    }
}

/// Counters, for diagnostics and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    /// Engine.IO connections open.
    pub connections: usize,
    /// Concrete namespaces in existence (static ones included).
    pub namespaces: usize,
    /// Bytes queued for clients.
    pub outbound_bytes: usize,
    /// Packets kept for recovery.
    pub stored_packets: usize,
    /// Bytes kept for recovery.
    pub stored_bytes: usize,
    /// Sessions kept for recovery.
    pub sessions: usize,
    /// Server-to-client acknowledgements awaited.
    pub pending_acks: usize,
}

impl SocketIo {
    /// Starts declaring namespaces.
    pub fn builder(options: Options, runtime: Runtime, shutdown: Shutdown) -> Builder {
        Builder::new(options, runtime, shutdown)
    }

    /// The service to serve: `/socket.io/` requests go to Socket.IO (Engine.IO sessions and
    /// the client files), everything else, other WebSocket upgrades included, to `app`.
    pub fn layer<S>(&self, app: S) -> crate::service::SocketIoService<S> {
        crate::service::SocketIoService::new(Arc::clone(&self.inner), app)
    }

    /// The current counters.
    pub fn stats(&self) -> Stats {
        let shared = &self.inner.shared;
        Stats {
            connections: self.inner.connection_count(),
            namespaces: shared.namespace_count(),
            outbound_bytes: shared.outbound_bytes.load(Ordering::Acquire),
            stored_packets: shared.recovery.packets.load(Ordering::Acquire),
            stored_bytes: shared.recovery.bytes.load(Ordering::Acquire),
            sessions: shared.recovery.sessions.load(Ordering::Acquire),
            pending_acks: shared.pending_acks.load(Ordering::Acquire),
        }
    }

    /// Resolves once a shutdown has finished.
    pub async fn closed(&self) {
        self.inner.done.cancelled().await;
    }

    /// Shuts down (also run when the builder's token fires): stops admitting connections and
    /// sockets; every socket leaves with `server shutting down`; queued output gets up to
    /// `shutdown_drain` to reach the clients; every connection is closed; handlers still
    /// running at the deadline are dropped; the recovery stores are released. Idempotent:
    /// a second call waits for the first.
    pub async fn shutdown(&self) {
        let inner = &self.inner;
        if inner.shutting_down.swap(true, Ordering::AcqRel) {
            inner.done.cancelled().await;
            return;
        }
        let shared = &inner.shared;
        shared.stop.cancel();
        let deadline = tokio::time::Instant::now() + shared.options.shutdown_drain;
        let connections: Vec<Arc<Connection>> = inner.connections().values().cloned().collect();
        for conn in &connections {
            conn.leave_all(crate::DisconnectReason::ServerShuttingDown);
        }
        while tokio::time::Instant::now() < deadline
            && connections.iter().any(|conn| conn.has_queued())
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let connections: Vec<Arc<Connection>> = inner.connections().values().cloned().collect();
        for conn in &connections {
            conn.close(crate::DisconnectReason::ServerShuttingDown);
        }
        shared.tasks.close();
        let _ = tokio::time::timeout_at(deadline, shared.tasks.wait()).await;
        shared.hard_stop.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(1), shared.tasks.wait()).await;
        for def in inner.registry.all() {
            def.clear();
        }
        inner.done.cancel();
    }
}
