//! Namespaces: what a feature package declares, admission, and the life of a socket.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use futures_util::FutureExt as _;
use serde_json::{Map, Value};
use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

use crate::codec;
use crate::config::{Dispatch, QueueLimits, Recovery};
use crate::connection::{Connection, Ticket};
use crate::error::{ConnectError, DisconnectReason, SendError};
use crate::handshake::Handshake;
use crate::ids;
use crate::outbox::Delivery;
use crate::pattern::Pattern;
use crate::recovery::{self, Session};
use crate::server::Shared;
use crate::socket::{Core, ErasedSocket, Event, Socket};
use crate::telemetry::{RecoveryOutcome, Refusal, SendOutcome};

/// What a feature package implements for one namespace or family (`io.of(name)` and its
/// `connection` handler in the reference). Every method is async and runs in a task the server
/// owns; a panic is contained (and counted), it never takes the connection down.
///
/// Order, for one socket: [`Namespace::check`] (skipped when the socket is recovered), then
/// [`Namespace::on_connect`], then [`Namespace::on_event`] for each client event (events that
/// arrive meanwhile wait, so none is lost the way a listener registered after an `await` misses
/// them in the reference), then [`Namespace::on_disconnect`] exactly once.
pub trait Namespace: Send + Sync + 'static {
    /// `socket.data`: what the check returns and the handlers share for this socket.
    type Data: Send + Sync + 'static;

    /// The reference's middleware (`nsp.use`): admits the socket with its data, or refuses it
    /// with a CONNECT_ERROR. `namespace` is the concrete name (`/clip/123` in a family).
    fn check(
        &self,
        handshake: &Handshake,
        namespace: &str,
    ) -> impl Future<Output = Result<Self::Data, ConnectError>> + Send;

    /// The `connection` handler. The CONNECT packet has been sent.
    fn on_connect(&self, socket: Socket<Self::Data>) -> impl Future<Output = ()> + Send {
        let _ = socket;
        async {}
    }

    /// A client event (`socket.on(name, listener)`). Take the acknowledgement with
    /// [`Event::take_ack`] when the client waits for one.
    fn on_event(
        &self,
        socket: Socket<Self::Data>,
        event: Event,
    ) -> impl Future<Output = ()> + Send {
        let _ = (socket, event);
        async {}
    }

    /// The `disconnect` listener.
    fn on_disconnect(
        &self,
        socket: Socket<Self::Data>,
        reason: DisconnectReason,
    ) -> impl Future<Output = ()> + Send {
        let _ = (socket, reason);
        async {}
    }
}

/// Per-namespace settings.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NamespaceOptions {
    /// Connection state recovery in this namespace.
    pub recovery: Recovery,
    /// The send queue of its sockets (`None`: the server's default).
    pub queue: Option<QueueLimits>,
    /// How events reach [`Namespace::on_event`].
    pub dispatch: Dispatch,
}

/// Which names a declaration covers.
#[derive(Debug, Clone)]
pub(crate) enum Matcher {
    Static(String),
    Family(Pattern),
}

/// One concrete namespace: its sockets in the order they joined.
pub(crate) struct Child<D> {
    name: String,
    members: Mutex<Members<D>>,
}

struct Members<D> {
    sockets: BTreeMap<u64, Arc<Core<D>>>,
    /// Admitted sockets whose check or restore is still running.
    pending: usize,
}

impl<D> Child<D> {
    fn new(name: String) -> Self {
        Self {
            name,
            members: Mutex::new(Members {
                sockets: BTreeMap::new(),
                pending: 0,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Members<D>> {
        self.members.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A declaration: the handler, its settings, its members and its recovery store.
pub(crate) struct Def<N: Namespace> {
    pub shared: Arc<Shared>,
    pub handler: Arc<N>,
    pub recovery: Recovery,
    pub queue: QueueLimits,
    pub dispatch: Dispatch,
    pub matcher: Matcher,
    children: Mutex<HashMap<String, Arc<Child<N::Data>>>>,
    store: Option<Mutex<recovery::State<N::Data>>>,
}

/// What a socket needs from its declaration.
pub(crate) trait DefOps<D>: Send + Sync {
    fn shared(&self) -> &Shared;
    fn recovery(&self) -> Recovery;
    fn queue(&self) -> QueueLimits;
    /// Stores an eligible event (full recovery), then runs `send` under the same lock.
    fn store_and_send(
        &self,
        nsp: &str,
        target: Option<&str>,
        offset: &str,
        json: Arc<str>,
        send: &mut dyn FnMut() -> Result<(), SendError>,
    ) -> Result<(), SendError>;
    /// The socket leaves: keep its session when the reason allows, then drop its membership.
    fn leave(&self, core: &Core<D>, reason: DisconnectReason);
}

/// A declaration as the connection sees it.
pub(crate) trait ErasedDef: Send + Sync {
    fn matches(&self, name: &str) -> bool;
    fn admit(
        self: Arc<Self>,
        conn: &Arc<Connection>,
        nsp: &str,
        auth: Map<String, Value>,
        ticket: Ticket,
    ) -> Result<(), Refusal>;
    /// Applies the recovery store's periodic sweep.
    fn sweep(&self);
    fn clear(&self);
}

impl<N: Namespace> Def<N> {
    pub(crate) fn new(
        shared: Arc<Shared>,
        handler: N,
        options: NamespaceOptions,
        matcher: Matcher,
    ) -> Self {
        let queue = options.queue.unwrap_or(shared.options.queue);
        let store =
            (options.recovery == Recovery::Full).then(|| Mutex::new(recovery::State::default()));
        let mut children = HashMap::new();
        if let Matcher::Static(name) = &matcher {
            children.insert(name.clone(), Arc::new(Child::new(name.clone())));
        }
        Self {
            shared,
            handler: Arc::new(handler),
            recovery: options.recovery,
            queue,
            dispatch: options.dispatch,
            matcher,
            children: Mutex::new(children),
            store,
        }
    }

    fn children(&self) -> MutexGuard<'_, HashMap<String, Arc<Child<N::Data>>>> {
        self.children.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn store(&self) -> Option<MutexGuard<'_, recovery::State<N::Data>>> {
        self.store
            .as_ref()
            .map(|store| store.lock().unwrap_or_else(PoisonError::into_inner))
    }

    fn ctx(&self, now: i64) -> recovery::Ctx<'_> {
        let options = &self.shared.options;
        recovery::Ctx {
            limits: options.recovery,
            timing: recovery::Timing {
                max_disconnection_ms: millis(options.recovery_max_disconnection),
                sweep_interval_ms: millis(options.recovery_sweep_interval),
            },
            totals: &self.shared.recovery,
            telemetry: self.shared.telemetry.as_ref(),
            now,
        }
    }

    fn child(&self, name: &str) -> Option<Arc<Child<N::Data>>> {
        self.children().get(name).cloned()
    }

    /// Drops a family member that has no socket left and none on the way.
    fn release_if_empty(&self, child: &Arc<Child<N::Data>>) {
        if matches!(self.matcher, Matcher::Static(_)) {
            return;
        }
        let mut children = self.children();
        let empty = {
            let members = child.lock();
            members.sockets.is_empty() && members.pending == 0
        };
        if empty
            && children
                .get(&child.name)
                .is_some_and(|current| Arc::ptr_eq(current, child))
        {
            children.remove(&child.name);
            self.shared.release_namespace();
        }
    }

    /// An admitted socket that will not join.
    fn abandon(&self, child: &Arc<Child<N::Data>>, conn: &Connection, nsp: &str, ticket: &Ticket) {
        {
            let mut members = child.lock();
            members.pending = members.pending.saturating_sub(1);
        }
        self.release_if_empty(child);
        conn.remove_pending(nsp, ticket);
    }

    /// The live members of `child`.
    fn members(child: &Child<N::Data>) -> Vec<Arc<Core<N::Data>>> {
        child.lock().sockets.values().cloned().collect()
    }
}

fn millis(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

impl<N: Namespace> DefOps<N::Data> for Def<N> {
    fn shared(&self) -> &Shared {
        &self.shared
    }

    fn recovery(&self) -> Recovery {
        self.recovery
    }

    fn queue(&self) -> QueueLimits {
        self.queue
    }

    fn store_and_send(
        &self,
        nsp: &str,
        target: Option<&str>,
        offset: &str,
        json: Arc<str>,
        send: &mut dyn FnMut() -> Result<(), SendError>,
    ) -> Result<(), SendError> {
        let now = self.shared.clock.now_ms();
        match self.store() {
            Some(mut store) => {
                store.append(nsp, target, offset, json, &self.ctx(now));
                send()
            }
            None => send(),
        }
    }

    fn leave(&self, core: &Core<N::Data>, reason: DisconnectReason) {
        let Some(child) = self.child(&core.nsp) else {
            return;
        };
        let persist = reason.recoverable() && !self.shared.stopping();
        {
            let store = self.store();
            if let (Some(mut store), true) = (store, persist) {
                let now = self.shared.clock.now_ms();
                let session = Session::new(
                    core.id.clone(),
                    core.pid.clone(),
                    Arc::clone(&core.data),
                    now,
                );
                store.persist(&core.nsp, session, &self.ctx(now));
                child.lock().sockets.remove(&core.key);
            } else {
                child.lock().sockets.remove(&core.key);
            }
        }
        self.release_if_empty(&child);
        self.shared.telemetry.socket_disconnected(&core.nsp, reason);
    }
}

impl<N: Namespace> ErasedDef for Def<N> {
    fn matches(&self, name: &str) -> bool {
        match &self.matcher {
            Matcher::Static(own) => own == name,
            Matcher::Family(pattern) => pattern.matches(name),
        }
    }

    fn admit(
        self: Arc<Self>,
        conn: &Arc<Connection>,
        nsp: &str,
        auth: Map<String, Value>,
        ticket: Ticket,
    ) -> Result<(), Refusal> {
        let child = {
            let mut children = self.children();
            let child = match children.get(nsp) {
                Some(child) => Arc::clone(child),
                None => {
                    if !self.shared.reserve_namespace() {
                        return Err(Refusal::TooManyNamespaces);
                    }
                    let child = Arc::new(Child::new(nsp.to_owned()));
                    children.insert(nsp.to_owned(), Arc::clone(&child));
                    child
                }
            };
            child.lock().pending += 1;
            child
        };
        let shared = Arc::clone(&self.shared);
        let conn = Arc::clone(conn);
        let nsp = nsp.to_owned();
        shared
            .tasks
            .spawn(run_socket(self, child, conn, nsp, auth, ticket));
        Ok(())
    }

    fn sweep(&self) {
        if let Some(mut store) = self.store() {
            store.sweep(&self.ctx(self.shared.clock.now_ms()));
        }
    }

    fn clear(&self) {
        if let Some(mut store) = self.store() {
            store.clear(&self.shared.recovery);
        }
    }
}

/// Runs one handler future: contained panics, dropped at the hard stop of a shutdown.
async fn guarded(shared: &Shared, nsp: &str, future: impl Future<Output = ()>) {
    tokio::select! {
        biased;
        () = shared.hard_stop.cancelled() => {}
        outcome = AssertUnwindSafe(future).catch_unwind() => {
            if outcome.is_err() {
                shared.telemetry.handler_panicked(nsp);
            }
        }
    }
}

/// Missed events sent per round of a restore.
const REPLAY_BATCH: usize = 64;

/// The life of one admitted socket.
async fn run_socket<N: Namespace>(
    def: Arc<Def<N>>,
    child: Arc<Child<N::Data>>,
    conn: Arc<Connection>,
    nsp: String,
    auth: Map<String, Value>,
    ticket: Ticket,
) {
    let shared = Arc::clone(&def.shared);
    let now = shared.clock.now_ms();

    // Recovery: `{pid, offset}` strings in the CONNECT data, in a namespace that keeps sessions.
    let mut restored = None;
    if let (Some(Value::String(pid)), Some(Value::String(offset))) =
        (auth.get("pid"), auth.get("offset"))
        && let Some(mut store) = def.store()
    {
        match store.restore(&nsp, pid, offset, &def.ctx(now)) {
            Ok(session) => restored = Some(session),
            Err(outcome) => shared.telemetry.recovery(&nsp, outcome),
        }
    }

    let handshake = Handshake::new(Arc::clone(&conn.first), auth, now);
    let (sid, pid, data, cursor) = match restored {
        Some(session) => (session.sid, session.pid, session.data, Some(session.cursor)),
        None => {
            let check = AssertUnwindSafe(def.handler.check(&handshake, &nsp)).catch_unwind();
            let result = tokio::select! {
                biased;
                () = ticket.cancel.cancelled() => None,
                () = shared.hard_stop.cancelled() => None,
                result = check => Some(result),
            };
            let Some(result) =
                result.filter(|_| !conn.is_closed() && !ticket.cancel.is_cancelled())
            else {
                def.abandon(&child, &conn, &nsp, &ticket);
                return;
            };
            let refusal = match result {
                Ok(Ok(data)) => match (
                    ids::base64id(shared.random.as_ref()),
                    ids::base64id(shared.random.as_ref()),
                ) {
                    (Some(sid), Some(pid)) => {
                        let data = Arc::new(data);
                        Ok((sid, pid, data))
                    }
                    _ => Err((
                        ConnectError::new("Internal server error"),
                        Refusal::CheckPanicked,
                    )),
                },
                Ok(Err(error)) => Err((error, Refusal::Check)),
                Err(_) => {
                    shared.telemetry.handler_panicked(&nsp);
                    Err((
                        ConnectError::new("Internal server error"),
                        Refusal::CheckPanicked,
                    ))
                }
            };
            match refusal {
                Ok((sid, pid, data)) => (sid, pid, data, None),
                Err((error, refusal)) => {
                    shared.telemetry.connect_refused(&nsp, refusal);
                    conn.push_control(codec::encode_connect_error(
                        &nsp,
                        &error.message,
                        error.data.as_ref(),
                    ));
                    def.abandon(&child, &conn, &nsp, &ticket);
                    return;
                }
            }
        }
    };

    let (inbound_tx, inbound) = mpsc::channel(shared.options.max_inbound_queue.max(1));
    let core = Arc::new(Core {
        key: shared.next_key(),
        id: sid,
        pid,
        nsp: nsp.clone(),
        recovered: cursor.is_some(),
        handshake,
        data,
        conn: Arc::clone(&conn),
        def: Arc::clone(&def) as Arc<dyn DefOps<N::Data>>,
        state: Core::<N::Data>::new_state(),
        closed: CancellationToken::new(),
        reason: OnceLock::new(),
        joined: std::sync::atomic::AtomicBool::new(false),
        inbound: inbound_tx,
        me: OnceLock::new(),
    });
    let _ = core.me.set(Arc::downgrade(&core));
    conn.open_socket(core.key);

    let joined = match cursor {
        Some(cursor) => replay(&def, &child, &core, cursor, &ticket).await,
        None => register(&child, &core, &ticket),
    };
    if !joined {
        conn.forget_socket(core.key);
        def.abandon(&child, &conn, &nsp, &ticket);
        return;
    }
    conn.mark_joined();
    shared.telemetry.socket_connected(&nsp, core.recovered);

    let socket = Socket {
        core: Arc::clone(&core),
    };
    guarded(&shared, &nsp, def.handler.on_connect(socket.clone())).await;
    events(&def, &socket, inbound).await;
    let reason = core
        .reason
        .get()
        .copied()
        .unwrap_or(DisconnectReason::TransportClose);
    guarded(&shared, &nsp, def.handler.on_disconnect(socket, reason)).await;
}

/// Makes the socket a member and sends its CONNECT, under the member lock, so a namespace emit
/// either sees the socket after its CONNECT or not at all. `false` when the attempt was
/// cancelled or the connection closed meanwhile; a CONNECT that does not fit the connection's
/// queue (every other socket of it backlogged) gets the connection closed as a slow consumer.
fn register<D: Send + Sync + 'static>(
    child: &Child<D>,
    core: &Arc<Core<D>>,
    ticket: &Ticket,
) -> bool {
    let sent = {
        let mut members = child.lock();
        let erased: Arc<dyn ErasedSocket> = Arc::clone(core) as Arc<dyn ErasedSocket>;
        if ticket.cancel.is_cancelled() || !core.conn.join(&core.nsp, ticket, erased) {
            return false;
        }
        members.pending = members.pending.saturating_sub(1);
        members.sockets.insert(core.key, Arc::clone(core));
        let sent = core.conn.push(crate::outbox::Outgoing {
            socket: Some((core.key, core.def.queue())),
            packet: codec::encode_connect(&core.nsp, &core.id, &core.pid),
            delivery: &Delivery::Reliable,
        });
        core.joined
            .store(true, std::sync::atomic::Ordering::Release);
        sent
    };
    if sent.is_err() {
        // The store lock may be held (a restore): the connection's task closes it.
        core.conn.close_soon(DisconnectReason::SlowConsumer);
    }
    true
}

/// Sends the missed events after `cursor`, then registers, with no event lost or repeated in
/// between: registration happens under the store lock once nothing is left after the cursor.
async fn replay<N: Namespace>(
    def: &Def<N>,
    child: &Child<N::Data>,
    core: &Arc<Core<N::Data>>,
    mut cursor: u64,
    ticket: &Ticket,
) -> bool {
    let shared = &def.shared;
    let nsp = core.nsp.as_str();
    loop {
        let now = shared.clock.now_ms();
        let batch = {
            let Some(mut store) = def.store() else {
                return false;
            };
            let batch = store.missed(nsp, cursor, &core.id, REPLAY_BATCH, &def.ctx(now));
            if batch.gap {
                store.finish_restore(nsp);
                drop(store);
                shared.telemetry.recovery(nsp, RecoveryOutcome::Gap);
                core.conn.close(DisconnectReason::ForcedServerClose);
                return false;
            }
            if batch.packets.is_empty() && batch.cursor == cursor {
                // Nothing after the cursor: register while no emit can store a packet.
                let joined = register(child, core, ticket);
                store.finish_restore(nsp);
                if joined {
                    shared.telemetry.recovery(nsp, RecoveryOutcome::Recovered);
                }
                return joined;
            }
            batch
        };
        cursor = batch.cursor;
        for json in batch.packets {
            let packet = codec::encode_event(nsp, None, &json);
            if !core
                .conn
                .push_waiting(core.key, def.queue, packet, ticket)
                .await
            {
                if let Some(mut store) = def.store() {
                    store.finish_restore(nsp);
                }
                return false;
            }
        }
    }
}

/// Feeds client events to the handler until the socket leaves.
async fn events<N: Namespace>(
    def: &Arc<Def<N>>,
    socket: &Socket<N::Data>,
    mut inbound: mpsc::Receiver<Event>,
) {
    let shared = Arc::clone(&def.shared);
    let core = &socket.core;
    match def.dispatch {
        Dispatch::Sequential => loop {
            let event = tokio::select! {
                biased;
                () = core.closed.cancelled() => break,
                () = shared.hard_stop.cancelled() => break,
                event = inbound.recv() => event,
            };
            let Some(event) = event else { break };
            guarded(
                &shared,
                &core.nsp,
                def.handler.on_event(socket.clone(), event),
            )
            .await;
        },
        Dispatch::Concurrent(limit) => {
            let slots = Arc::new(Semaphore::new(limit.max(1)));
            loop {
                let slot = tokio::select! {
                    biased;
                    () = core.closed.cancelled() => break,
                    () = shared.hard_stop.cancelled() => break,
                    slot = Arc::clone(&slots).acquire_owned() => slot,
                };
                let Ok(slot) = slot else { break };
                let event = tokio::select! {
                    biased;
                    () = core.closed.cancelled() => break,
                    () = shared.hard_stop.cancelled() => break,
                    event = inbound.recv() => event,
                };
                let Some(event) = event else { break };
                let def = Arc::clone(def);
                let socket = socket.clone();
                let task_shared = Arc::clone(&shared);
                shared.tasks.spawn(async move {
                    let shared = task_shared;
                    let nsp = socket.core.nsp.clone();
                    guarded(&shared, &nsp, def.handler.on_event(socket, event)).await;
                    drop(slot);
                });
            }
        }
    }
}

/// A typed handle on a declared namespace or family, for server-side sends and lookups
/// (`io.of(name)` in the reference). Cheap to clone.
pub struct NamespaceRef<N: Namespace> {
    pub(crate) def: Arc<Def<N>>,
}

impl<N: Namespace> Clone for NamespaceRef<N> {
    fn clone(&self) -> Self {
        Self {
            def: Arc::clone(&self.def),
        }
    }
}

impl<N: Namespace> std::fmt::Debug for NamespaceRef<N> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NamespaceRef")
            .field("matcher", &self.def.matcher)
            .finish_non_exhaustive()
    }
}

impl<N: Namespace> NamespaceRef<N> {
    /// Whether `name` belongs to this declaration.
    pub fn covers(&self, name: &str) -> bool {
        self.def.matches(name)
    }

    /// The handler.
    pub fn handler(&self) -> &Arc<N> {
        &self.def.handler
    }

    /// `io.of(name).emit(event, ...args)`: to every socket of the namespace, reliable. Returns
    /// how many sockets it was handed to. With full recovery the event is stored even when
    /// nobody is connected.
    pub fn emit(&self, name: &str, event: &str, args: &[Value]) -> Result<usize, SendError> {
        self.emit_with(name, &Delivery::Reliable, event, args)
    }

    /// [`NamespaceRef::emit`] with a delivery policy for full send queues (applied per socket:
    /// a reliable event closes only the connections that cannot take it).
    pub fn emit_with(
        &self,
        name: &str,
        delivery: &Delivery,
        event: &str,
        args: &[Value],
    ) -> Result<usize, SendError> {
        if !self.def.matches(name) {
            return Err(SendError::UnknownNamespace);
        }
        if codec::RESERVED_EVENTS.contains(&event) {
            return Err(SendError::Reserved);
        }
        let def = &self.def;
        let shared = &def.shared;
        let offset =
            (def.recovery != Recovery::Off).then(|| shared.offsets.next(shared.clock.as_ref()));
        let json = codec::array_json(Some(event), args, offset.as_deref());
        let packet = codec::encode_event(name, None, &json);
        if packet.len() > shared.options.max_outbound_message {
            shared.telemetry.send(name, SendOutcome::TooLarge);
            return Err(SendError::TooLarge);
        }
        let deliver = |child: Option<Arc<Child<N::Data>>>| -> usize {
            let Some(child) = child else { return 0 };
            let members = Def::<N>::members(&child);
            let mut sent = 0;
            for core in members {
                if core.push(packet.clone(), delivery).is_ok() {
                    sent += 1;
                }
            }
            sent
        };
        match (def.store(), offset) {
            (Some(mut store), Some(offset)) => {
                let now = shared.clock.now_ms();
                store.append(name, None, &offset, Arc::from(json.as_str()), &def.ctx(now));
                Ok(deliver(def.child(name)))
            }
            _ => Ok(deliver(def.child(name))),
        }
    }

    /// `io.of(name).sockets` / `fetchSockets()`: the connected sockets in the order they joined.
    pub fn sockets(&self, name: &str) -> Vec<Socket<N::Data>> {
        self.def
            .child(name)
            .map(|child| {
                Def::<N>::members(&child)
                    .into_iter()
                    .filter(|core| core.is_connected())
                    .map(|core| Socket { core })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The connected socket with this id in the namespace.
    pub fn socket(&self, name: &str, id: &str) -> Option<Socket<N::Data>> {
        self.sockets(name)
            .into_iter()
            .find(|socket| socket.id() == id)
    }

    /// The concrete names that currently have sockets (or sockets joining): for a static
    /// namespace its name, for a family its live members (`io._nsps` in the reference).
    pub fn names(&self) -> Vec<String> {
        self.def.children().keys().cloned().collect()
    }
}
