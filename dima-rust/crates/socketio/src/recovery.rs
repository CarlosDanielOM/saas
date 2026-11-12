//! Connection state recovery, as `SessionAwareAdapter` of `socket.io-adapter` 2.5.8 does it.
//!
//! What is stored: every EVENT the server emits in a namespace with [`Recovery::Full`] that has
//! no acknowledgement id (the reference also skips `volatile` events, which this crate does not
//! offer), whether it goes to the whole namespace or to one socket, and whether or not anyone
//! receives it. The offset is appended as the event's last argument, so the client knows the
//! last one it processed.
//!
//! What a session keeps: the socket id, the private id, the socket's data (the same `Arc`, as the
//! reference keeps the same object) and when it disconnected. Its rooms are its own id only:
//! this crate has no application rooms. A session is kept when a socket leaves for a recoverable
//! reason ([`DisconnectReason::recoverable`]), never on a namespace disconnect.
//!
//! A reconnecting client sends `{pid, offset, ...auth}` in its CONNECT. When the session exists,
//! is not older than `recovery_max_disconnection`, and the offset is still stored, the socket
//! comes back with its id and data, the events after the offset meant for the namespace or for
//! that socket are sent before the CONNECT packet, and the CONNECT carries the same private id,
//! which is what makes the client's `recovered` true.
//!
//! Expiry follows the reference's schedule: its adapter sweeps every 60 s from the namespace's
//! creation and drops what disconnected or was emitted more than 2 minutes before that sweep,
//! so a packet stays findable for up to 3 minutes. Restoring also refuses a session older than
//! 2 minutes.
//!
//! Deliberate differences, all bounds the reference does not have ([`RecoveryLimits`]):
//!
//! - **One store for the server**, under one lock: every namespace's packets and sessions, so
//!   the server-wide limits are counted where they are enforced (no total checked under one
//!   lock and incremented under another).
//! - **Fair eviction.** A namespace over its own packet limits drops its own oldest packets;
//!   at a server-wide limit, the oldest packet of the namespace storing the most bytes goes,
//!   the writer's own namespace included. Sessions are grouped by their verified owner
//!   ([`Owner`], H3 of the re-check), not by namespace: names prove nothing, and a client can
//!   spread sessions over names it makes up. An owner over its quota drops its own oldest; a
//!   full owned pool takes from the owner holding the most; sessions without an owner share a
//!   smaller pool of their own that never takes from the owned one (see
//!   [`RecoveryLimits`] for every rule).
//! - **One reservation per stored packet.** A packet's bytes are taken from `bytes_total` when
//!   it is stored and given back when its last owner drops it: the store, or a restore sending
//!   it, which keeps it after the store evicted it. So the budget bounds what is really alive;
//!   when restores hold the rest of it, a new event is not stored (as one too large). A
//!   restore whose client takes nothing ends by the slow-consumer rule (`close_timeout`).
//! - **Sessions are measured** by what they really keep ([`crate::RetainedSize`] of the socket
//!   data, its ids and a fixed overhead), when the socket leaves and again when its last
//!   handler has ended; a session over `session_bytes` is not kept, and all of them together
//!   stay within `session_bytes_total`.
//! - **An event that could not be stored breaks recovery** instead of leaving a silent gap: it
//!   still takes its place in the namespace's sequence, and a later restore from an offset
//!   before it fails as an unknown offset would (the client connects fresh, `recovered` false).
//! - A session is claimed by the restore that uses it (the reference keeps it until it
//!   expires, so two reconnects with the same private id would both get the socket id).
//! - A client whose offset or session was dropped connects fresh, never with a partial replay.
//!
//! [`Recovery::Full`]: crate::Recovery::Full
//! [`DisconnectReason::recoverable`]: crate::DisconnectReason::recoverable

use std::any::Any;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio_util::sync::CancellationToken;

use crate::budget::{release, reserve};
use crate::config::RecoveryLimits;
use crate::telemetry::{Eviction, RecoveryOutcome, Telemetry};

/// Fixed cost counted for every stored packet and session besides its text and data.
const OVERHEAD: usize = 64;

/// Where a session is filed: the SHA-256 of its private id. The private id is the recovery
/// secret; looking it up by its digest and then comparing it in constant time means neither
/// the map's probing nor the comparison takes longer for a guess that shares a prefix with it.
type Key = [u8; 32];

fn key(pid: &str) -> Key {
    *dima_core::crypto::sha256(pid).bytes()
}

/// The anonymous pool: its sessions and bytes (at most the totals).
fn anonymous_pool(limits: &RecoveryLimits) -> (usize, usize) {
    (
        limits.anonymous_sessions.min(limits.sessions_total),
        limits
            .anonymous_session_bytes
            .min(limits.session_bytes_total),
    )
}

/// The owned pool: the totals minus the anonymous pool.
fn owned_pool(limits: &RecoveryLimits) -> (usize, usize) {
    let (sessions, bytes) = anonymous_pool(limits);
    (
        limits.sessions_total - sessions,
        limits.session_bytes_total - bytes,
    )
}

/// The session filed under `pid`'s digest, if its private id really is `pid`.
fn find<'a>(sessions: &'a HashMap<Key, Session>, pid: &str) -> Option<&'a Session> {
    sessions
        .get(&key(pid))
        .filter(|s| dima_core::crypto::constant_time_eq(s.pid.as_bytes(), pid.as_bytes()))
}

/// The store's totals (for [`crate::Stats`]). `bytes` is the packet budget itself: reserved
/// when a packet is stored, given back when the last owner of the packet (the store, or a
/// replay sending it) drops it. The others are copies written under the store lock.
#[derive(Debug, Default)]
pub struct Totals {
    pub packets: AtomicUsize,
    pub bytes: AtomicUsize,
    pub sessions: AtomicUsize,
    pub session_bytes: AtomicUsize,
}

/// A stored event's text with its share of the packet budget (`Totals::bytes`), reserved once
/// when it was stored and given back when the last reference goes: a replay that took the
/// packet keeps it charged after the store evicted it (H2 of the re-check), so the budget
/// bounds what is really alive.
pub struct Payload {
    json: Arc<str>,
    cost: usize,
    totals: Arc<Totals>,
}

impl std::ops::Deref for Payload {
    type Target = str;

    fn deref(&self) -> &str {
        &self.json
    }
}

impl Drop for Payload {
    fn drop(&mut self) {
        release(&self.totals.bytes, self.cost);
    }
}

impl std::fmt::Debug for Payload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Payload")
            .field("cost", &self.cost)
            .finish_non_exhaustive()
    }
}

/// The timing rules.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// `maxDisconnectionDuration` in milliseconds.
    pub max_disconnection_ms: i64,
    /// The adapter's sweep interval in milliseconds (0: sweep at every access).
    pub sweep_interval_ms: i64,
}

/// One stored event.
#[derive(Debug)]
struct Stored {
    seq: u64,
    offset: String,
    /// `None`: the whole namespace; `Some(sid)`: one socket.
    target: Option<String>,
    /// The event's data array, offset included (`["name",…,"<offset>"]`), charged.
    json: Arc<Payload>,
    emitted_ms: i64,
    cost: usize,
}

/// The socket data a session keeps, whatever its type (a name belongs to one declaration, which
/// restores it as its own type).
pub type Data = Arc<dyn Any + Send + Sync>;

/// Who a socket's recovery session belongs to, as the namespace's check verified it
/// ([`crate::Namespace::owner`]). Sessions are kept and evicted per owner, so a client cannot
/// push out the sessions of an owner it is not.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub enum Owner {
    /// Nobody verified: the session shares the anonymous pool
    /// ([`RecoveryLimits::anonymous_sessions`]), which never takes room from owned sessions.
    #[default]
    Anonymous,
    /// An owner key the application chose from what its check verified (a channel id, a user
    /// id). Keys are compared as they are; give them a prefix of their kind when several kinds
    /// share a server (`channel:123`, `user:456`).
    Verified(Arc<str>),
}

impl Owner {
    /// A verified owner.
    pub fn verified(key: impl Into<Arc<str>>) -> Self {
        Self::Verified(key.into())
    }

    /// The bytes of its key, counted in the session's size.
    fn len(&self) -> usize {
        match self {
            Self::Anonymous => 0,
            Self::Verified(key) => key.len(),
        }
    }
}

/// A kept session.
pub struct Session {
    pub sid: String,
    pub pid: String,
    pub data: Data,
    /// The key of the socket that left it: only that socket's late emits may still be stored
    /// for it, and only while the session is not claimed.
    socket: u64,
    /// Who it belongs to.
    pub owner: Owner,
    /// Fires when every handler of that socket has ended: a restore waits for it.
    released: CancellationToken,
    disconnected_ms: i64,
    cost: usize,
    /// Its place in its owner's order (set when it is kept).
    stamp: u64,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("sid", &self.sid)
            .field("socket", &self.socket)
            .field("owner", &self.owner)
            .field("cost", &self.cost)
            .finish_non_exhaustive()
    }
}

/// What a session costs: its ids, its owner key, its data as it is now, and a fixed overhead.
/// Measuring compacts what the data's locks guard ([`crate::RetainedSize`]), so it takes the
/// data's own locks: never call it with the store lock held (a handler holding its data's lock
/// may be waiting for the store lock to emit).
pub fn session_cost<D: crate::RetainedSize>(
    sid: &str,
    pid: &str,
    owner: &Owner,
    data: &D,
) -> usize {
    OVERHEAD
        .saturating_add(sid.len())
        .saturating_add(pid.len())
        .saturating_add(owner.len())
        .saturating_add(std::mem::size_of::<D>())
        .saturating_add(data.retained_bytes())
}

/// Who a socket is and what it leaves behind, for [`Session::new`].
pub struct Leaving<D> {
    pub sid: String,
    pub pid: String,
    pub data: Arc<D>,
    pub socket: u64,
    pub owner: Owner,
    pub released: CancellationToken,
}

impl Session {
    /// A session for a socket that just left; `cost` is [`session_cost`] of it, measured
    /// before the store lock was taken.
    pub fn new<D: Send + Sync + 'static>(
        leaving: Leaving<D>,
        disconnected_ms: i64,
        cost: usize,
    ) -> Self {
        Self {
            sid: leaving.sid,
            pid: leaving.pid,
            data: leaving.data,
            socket: leaving.socket,
            owner: leaving.owner,
            released: leaving.released,
            disconnected_ms,
            cost,
            stamp: 0,
        }
    }

    fn order(&self) -> (i64, u64) {
        (self.disconnected_ms, self.stamp)
    }
}

/// The kept sessions of one owner, or of the anonymous pool: oldest first.
#[derive(Debug, Default)]
struct Group {
    order: BTreeMap<(i64, u64), (String, Key)>,
    bytes: usize,
}

impl Group {
    fn oldest(&self) -> Option<(String, Key)> {
        self.order.values().next().cloned()
    }
}

#[derive(Debug)]
struct Record {
    created_ms: i64,
    swept_ms: i64,
    next_seq: u64,
    /// A restore from an offset whose packet is older than this cannot be served: an event
    /// after it could not be stored.
    barrier: u64,
    packets: VecDeque<Stored>,
    /// Bytes of the packets in `packets`.
    bytes: usize,
    sessions: HashMap<Key, Session>,
    /// Restores sending this record's packets; the record is kept while any runs.
    restoring: usize,
}

impl Record {
    fn new(now: i64) -> Self {
        Self {
            created_ms: now,
            swept_ms: now,
            next_seq: 0,
            barrier: 0,
            packets: VecDeque::new(),
            bytes: 0,
            sessions: HashMap::new(),
            restoring: 0,
        }
    }

    /// Whether the record can go: nothing stored, nothing kept, nobody restoring (with no
    /// packet stored, no offset can be recovered, so a barrier has nothing left to guard).
    fn is_empty(&self) -> bool {
        self.packets.is_empty() && self.sessions.is_empty() && self.restoring == 0
    }

    /// The session this namespace gives up for a newcomer of `owner` at its own bound: its
    /// oldest anonymous session; for an owned newcomer, failing that, the oldest of the owner
    /// holding the most sessions here. An anonymous newcomer never takes an owned session's
    /// place.
    fn victim_for(&self, owner: &Owner) -> Option<Key> {
        let anonymous = self
            .sessions
            .iter()
            .filter(|(_, s)| s.owner == Owner::Anonymous)
            .min_by_key(|(_, s)| s.order())
            .map(|(key, _)| *key);
        if anonymous.is_some() || *owner == Owner::Anonymous {
            return anonymous;
        }
        let mut held: HashMap<&Owner, usize> = HashMap::new();
        for session in self.sessions.values() {
            *held.entry(&session.owner).or_default() += 1;
        }
        let greedy = held.into_iter().max_by_key(|(_, n)| *n)?.0.clone();
        self.sessions
            .iter()
            .filter(|(_, s)| s.owner == greedy)
            .min_by_key(|(_, s)| s.order())
            .map(|(key, _)| *key)
    }
}

/// A restored session: where its missed events start.
pub struct Restored {
    pub sid: String,
    pub pid: String,
    pub data: Data,
    pub cursor: u64,
    /// Who the session belongs to.
    pub owner: Owner,
    /// Fires when the socket that left the session has no handler running any more.
    pub released: CancellationToken,
}

/// The next missed events for a restoring socket.
#[derive(Debug, Default)]
pub struct Batch {
    pub packets: Vec<Arc<Payload>>,
    pub cursor: u64,
    /// Events after the cursor were dropped: the replay would be partial.
    pub gap: bool,
}

/// Everything a store operation needs besides the state.
pub struct Ctx<'a> {
    pub limits: RecoveryLimits,
    pub timing: Timing,
    pub telemetry: &'a dyn Telemetry,
    pub now: i64,
}

/// The server's store.
#[derive(Debug, Default)]
pub struct Store {
    records: HashMap<String, Record>,
    packets: usize,
    /// Bytes of the packets the store holds (what evicting can free); the budget, which also
    /// counts packets only a replay still holds, is `totals.bytes`.
    stored_bytes: usize,
    sessions: usize,
    session_bytes: usize,
    /// Sessions with a verified owner, by owner.
    owners: HashMap<Arc<str>, Group>,
    /// Sessions of the owned pool, and their bytes.
    owned: usize,
    owned_bytes: usize,
    /// Sessions without an owner.
    anonymous: Group,
    next_stamp: u64,
    totals: Arc<Totals>,
}

impl Store {
    /// An empty store whose totals are mirrored in `totals`.
    pub fn new(totals: Arc<Totals>) -> Self {
        Self {
            totals,
            ..Self::default()
        }
    }

    fn publish(&self) {
        self.totals.packets.store(self.packets, Ordering::Release);
        self.totals.sessions.store(self.sessions, Ordering::Release);
        self.totals
            .session_bytes
            .store(self.session_bytes, Ordering::Release);
    }

    /// The record of `nsp`, created if needed, after its periodic sweep.
    fn record(&mut self, nsp: &str, ctx: &Ctx<'_>) -> &mut Record {
        if !self.records.contains_key(nsp) {
            self.records.insert(nsp.to_owned(), Record::new(ctx.now));
        }
        self.sweep_one(nsp, ctx);
        self.records
            .entry(nsp.to_owned())
            .or_insert_with(|| Record::new(ctx.now))
    }

    /// The reference's periodic sweep of one namespace, applied for the last tick that passed.
    fn sweep_one(&mut self, nsp: &str, ctx: &Ctx<'_>) {
        let Some(record) = self.records.get_mut(nsp) else {
            return;
        };
        let timing = ctx.timing;
        let tick = if timing.sweep_interval_ms > 0 {
            let elapsed = ctx.now.saturating_sub(record.created_ms).max(0);
            record.created_ms + elapsed / timing.sweep_interval_ms * timing.sweep_interval_ms
        } else {
            ctx.now
        };
        if tick <= record.swept_ms {
            return;
        }
        record.swept_ms = tick;
        let threshold = tick.saturating_sub(timing.max_disconnection_ms);
        // `for (i = length - 1; i >= 0; i--) if (packets[i].emittedAt < threshold) splice(0, i + 1)`
        let expired_packets = record
            .packets
            .iter()
            .rposition(|p| p.emitted_ms < threshold)
            .map_or(0, |last| last + 1);
        let expired_sessions: Vec<Key> = record
            .sessions
            .iter()
            .filter(|(_, s)| s.disconnected_ms < threshold)
            .map(|(key, _)| *key)
            .collect();
        for _ in 0..expired_packets {
            self.pop_packet(nsp);
        }
        for key in expired_sessions {
            self.remove_session(nsp, &key);
        }
    }

    fn pop_packet(&mut self, nsp: &str) -> bool {
        let Some(record) = self.records.get_mut(nsp) else {
            return false;
        };
        let Some(packet) = record.packets.pop_front() else {
            return false;
        };
        record.bytes = record.bytes.saturating_sub(packet.cost);
        self.packets = self.packets.saturating_sub(1);
        self.stored_bytes = self.stored_bytes.saturating_sub(packet.cost);
        // Its share of the budget goes with the last reference (here, or a replay's).
        true
    }

    fn remove_session(&mut self, nsp: &str, key: &Key) -> Option<Session> {
        let session = self.records.get_mut(nsp)?.sessions.remove(key)?;
        self.sessions = self.sessions.saturating_sub(1);
        self.session_bytes = self.session_bytes.saturating_sub(session.cost);
        match &session.owner {
            Owner::Anonymous => {
                self.anonymous.order.remove(&session.order());
                self.anonymous.bytes = self.anonymous.bytes.saturating_sub(session.cost);
            }
            Owner::Verified(owner) => {
                self.owned = self.owned.saturating_sub(1);
                self.owned_bytes = self.owned_bytes.saturating_sub(session.cost);
                if let Some(group) = self.owners.get_mut(owner) {
                    group.order.remove(&session.order());
                    group.bytes = group.bytes.saturating_sub(session.cost);
                    if group.order.is_empty() {
                        self.owners.remove(owner);
                    }
                }
            }
        }
        Some(session)
    }

    /// Files a session that has room (see [`Store::room_for_session`]).
    fn insert_session(&mut self, nsp: &str, mut session: Session, ctx: &Ctx<'_>) {
        self.next_stamp += 1;
        session.stamp = self.next_stamp;
        let place = (nsp.to_owned(), key(&session.pid));
        let group = match &session.owner {
            Owner::Anonymous => &mut self.anonymous,
            Owner::Verified(owner) => {
                self.owned += 1;
                self.owned_bytes += session.cost;
                self.owners.entry(Arc::clone(owner)).or_default()
            }
        };
        group.order.insert(session.order(), place);
        group.bytes += session.cost;
        self.sessions += 1;
        self.session_bytes += session.cost;
        let record = self.record(nsp, ctx);
        record.sessions.insert(key(&session.pid), session);
    }

    /// Drops a session to make room, from wherever it is filed.
    fn evict_session(&mut self, nsp: &str, place: &(String, Key), ctx: &Ctx<'_>) {
        let (victim_nsp, victim) = place;
        self.remove_session(victim_nsp, victim);
        ctx.telemetry
            .recovery_evicted(victim_nsp, Eviction::Session);
        if victim_nsp != nsp {
            self.drop_if_empty(victim_nsp);
        }
    }

    fn drop_if_empty(&mut self, nsp: &str) {
        if self.records.get(nsp).is_some_and(Record::is_empty) {
            self.records.remove(nsp);
        }
    }

    /// The namespace holding the most stored bytes (a scan of the namespaces that have
    /// something stored, at most `packets_total + sessions_total` of them).
    fn largest_by_bytes(&self) -> Option<String> {
        self.records
            .iter()
            .filter(|(_, r)| !r.packets.is_empty())
            .max_by_key(|(_, r)| r.bytes)
            .map(|(name, _)| name.clone())
    }

    /// The oldest session of the owner holding the most: by sessions when the owned pool's
    /// count is what is full, by bytes otherwise (a scan of the owners, at most
    /// `sessions_total` of them).
    fn greediest_owner_oldest(&self, by_count: bool) -> Option<(String, Key)> {
        self.owners
            .values()
            .max_by_key(|group| {
                if by_count {
                    (group.order.len(), group.bytes)
                } else {
                    (group.bytes, group.order.len())
                }
            })
            .and_then(Group::oldest)
    }

    /// Stores one eligible event. When the bounds leave no room for it (it alone is larger than
    /// a namespace's or the server's byte limit, or replays hold the rest of the budget after
    /// everything evictable was evicted), it is not stored but still takes its place in the
    /// sequence, and offsets before it can no longer be recovered. Returns whether it was
    /// stored.
    pub fn append(
        &mut self,
        nsp: &str,
        target: Option<&str>,
        offset: &str,
        json: Arc<str>,
        ctx: &Ctx<'_>,
    ) -> bool {
        let cost = OVERHEAD + json.len() + offset.len() + target.map_or(0, str::len);
        let limits = ctx.limits;
        if cost > limits.bytes_per_namespace || cost > limits.bytes_total {
            return self.not_stored(nsp, ctx);
        }
        // Room in the namespace: its own oldest go.
        loop {
            let record = self.record(nsp, ctx);
            let full = !record.packets.is_empty()
                && (record.packets.len() >= limits.packets_per_namespace
                    || record.bytes + cost > limits.bytes_per_namespace);
            if !full {
                break;
            }
            self.pop_packet(nsp);
            ctx.telemetry.recovery_evicted(nsp, Eviction::Packet);
        }
        // Room in the server: the largest namespace's oldest go, until the packet count fits
        // and the budget (what is stored and what replays still hold) can take this one.
        while self.packets >= limits.packets_total {
            if !self.evict_largest(nsp, ctx) {
                break;
            }
        }
        while !reserve(&self.totals.bytes, cost, limits.bytes_total) {
            if !self.evict_largest(nsp, ctx) {
                // Replays hold the rest: nothing more can be freed now.
                return self.not_stored(nsp, ctx);
            }
        }
        let payload = Arc::new(Payload {
            json,
            cost,
            totals: Arc::clone(&self.totals),
        });
        let record = self.record(nsp, ctx);
        let seq = record.next_seq;
        record.next_seq += 1;
        record.bytes += cost;
        record.packets.push_back(Stored {
            seq,
            offset: offset.to_owned(),
            target: target.map(str::to_owned),
            json: payload,
            emitted_ms: ctx.now,
            cost,
        });
        self.packets += 1;
        self.stored_bytes += cost;
        self.publish();
        true
    }

    /// Drops the oldest packet of the namespace storing the most bytes; `false` when nothing is
    /// stored.
    fn evict_largest(&mut self, nsp: &str, ctx: &Ctx<'_>) -> bool {
        let Some(largest) = self.largest_by_bytes() else {
            return false;
        };
        self.pop_packet(&largest);
        ctx.telemetry.recovery_evicted(&largest, Eviction::Packet);
        if largest != nsp {
            self.drop_if_empty(&largest);
        }
        true
    }

    /// An event that is not stored still takes its place in its namespace's sequence: a
    /// restore from an earlier offset would miss it, so the barrier moves past it.
    fn not_stored(&mut self, nsp: &str, ctx: &Ctx<'_>) -> bool {
        let record = self.record(nsp, ctx);
        let seq = record.next_seq;
        record.next_seq += 1;
        record.barrier = seq + 1;
        ctx.telemetry.recovery_evicted(nsp, Eviction::NotStored);
        self.drop_if_empty(nsp);
        self.publish();
        false
    }

    /// Makes room for one more session of `owner` and `cost` bytes in `nsp`; `false` when
    /// there is none.
    ///
    /// - The namespace's bound (`sessions_per_namespace`) gives up its oldest anonymous session,
    ///   or for an owned newcomer the oldest of the owner holding the most there.
    /// - An owner at its quota (`sessions_per_owner`) gives up its own oldest.
    /// - The owned pool (the totals minus the anonymous pool) full: the owner holding the most
    ///   gives up its oldest, the newcomer's own owner included.
    /// - The anonymous pool full: its oldest goes. It never takes from the owned pool.
    fn room_for_session(&mut self, nsp: &str, owner: &Owner, cost: usize, ctx: &Ctx<'_>) -> bool {
        let limits = ctx.limits;
        while self
            .records
            .get(nsp)
            .is_some_and(|r| r.sessions.len() >= limits.sessions_per_namespace)
        {
            let Some(victim) = self.records.get(nsp).and_then(|r| r.victim_for(owner)) else {
                return false;
            };
            self.evict_session(nsp, &(nsp.to_owned(), victim), ctx);
        }
        match owner {
            Owner::Anonymous => {
                let (max, max_bytes) = anonymous_pool(&limits);
                while self.anonymous.order.len() >= max || self.anonymous.bytes + cost > max_bytes {
                    let Some(oldest) = self.anonymous.oldest() else {
                        return false;
                    };
                    self.evict_session(nsp, &oldest, ctx);
                }
            }
            Owner::Verified(key) => {
                while self
                    .owners
                    .get(key)
                    .is_some_and(|g| g.order.len() >= limits.sessions_per_owner)
                {
                    let Some(oldest) = self.owners.get(key).and_then(Group::oldest) else {
                        return false;
                    };
                    self.evict_session(nsp, &oldest, ctx);
                }
                let (max, max_bytes) = owned_pool(&limits);
                loop {
                    let by_count = self.owned >= max;
                    if !by_count && self.owned_bytes + cost <= max_bytes {
                        break;
                    }
                    let Some(oldest) = self.greediest_owner_oldest(by_count) else {
                        return false;
                    };
                    self.evict_session(nsp, &oldest, ctx);
                }
            }
        }
        true
    }

    /// Keeps a session (`persistSession`). Returns `false` when it was not kept.
    pub fn persist(&mut self, nsp: &str, session: Session, ctx: &Ctx<'_>) -> bool {
        let limits = ctx.limits;
        let pool_bytes = match session.owner {
            Owner::Anonymous => anonymous_pool(&limits).1,
            Owner::Verified(_) => owned_pool(&limits).1,
        };
        if session.cost > limits.session_bytes || session.cost > pool_bytes {
            ctx.telemetry
                .recovery_evicted(nsp, Eviction::SessionTooLarge);
            return false;
        }
        if self
            .records
            .get(nsp)
            .is_some_and(|r| find(&r.sessions, &session.pid).is_some())
        {
            self.remove_session(nsp, &key(&session.pid));
        }
        if !self.room_for_session(nsp, &session.owner, session.cost, ctx) {
            self.drop_if_empty(nsp);
            self.publish();
            return false;
        }
        self.insert_session(nsp, session, ctx);
        self.publish();
        true
    }

    /// Measures a kept session again once the socket that left it has no handler running
    /// (`on_disconnect` may have changed its data): `cost` is its size now. A session that grew
    /// past `session_bytes` is dropped; one that grew is given room as a new one would be.
    pub fn settle(&mut self, nsp: &str, pid: &str, socket: u64, cost: usize, ctx: &Ctx<'_>) {
        let unchanged = self
            .records
            .get(nsp)
            .and_then(|r| find(&r.sessions, pid))
            .filter(|s| s.socket == socket)
            .is_none_or(|s| s.cost == cost);
        if unchanged {
            return;
        }
        let Some(mut session) = self.remove_session(nsp, &key(pid)) else {
            return;
        };
        session.cost = cost;
        self.persist(nsp, session, ctx);
        self.drop_if_empty(nsp);
        self.publish();
    }

    /// `restoreSession(pid, offset)`, claiming the session.
    pub fn restore(
        &mut self,
        nsp: &str,
        pid: &str,
        offset: &str,
        ctx: &Ctx<'_>,
    ) -> Result<Restored, RecoveryOutcome> {
        if !self.records.contains_key(nsp) {
            return Err(RecoveryOutcome::UnknownSession);
        }
        self.sweep_one(nsp, ctx);
        let max = ctx.timing.max_disconnection_ms;
        let found = match self.records.get(nsp) {
            None => Err(RecoveryOutcome::UnknownSession),
            Some(record) => match find(&record.sessions, pid) {
                None => Err(RecoveryOutcome::UnknownSession),
                Some(session) if session.disconnected_ms.saturating_add(max) < ctx.now => {
                    Err(RecoveryOutcome::Expired)
                }
                Some(_) => match record.packets.iter().find(|p| p.offset == offset) {
                    // The session stays, as in the reference: another offset may still be found.
                    None => Err(RecoveryOutcome::UnknownOffset),
                    // An event after this offset could not be stored: the replay would miss it.
                    Some(packet) if packet.seq < record.barrier => {
                        Err(RecoveryOutcome::Discontinuity)
                    }
                    Some(packet) => Ok(packet.seq),
                },
            },
        };
        let outcome = match found {
            Ok(cursor) => match self.remove_session(nsp, &key(pid)) {
                Some(session) => {
                    if let Some(record) = self.records.get_mut(nsp) {
                        record.restoring += 1;
                    }
                    Ok(Restored {
                        sid: session.sid,
                        pid: session.pid,
                        data: session.data,
                        cursor,
                        owner: session.owner,
                        released: session.released,
                    })
                }
                None => Err(RecoveryOutcome::UnknownSession),
            },
            Err(RecoveryOutcome::Expired) => {
                self.remove_session(nsp, &key(pid));
                Err(RecoveryOutcome::Expired)
            }
            Err(other) => Err(other),
        };
        self.drop_if_empty(nsp);
        self.publish();
        outcome
    }

    /// Whether the session of `pid` is still kept, unclaimed, for the socket `socket` that
    /// left it (its late emits may then still be stored for it).
    pub fn owns(&self, nsp: &str, pid: &str, socket: u64) -> bool {
        self.records
            .get(nsp)
            .and_then(|record| find(&record.sessions, pid))
            .is_some_and(|session| session.socket == socket)
    }

    /// Up to `max` missed events after `cursor` for socket `sid` (`shouldIncludePacket`: sent to
    /// the namespace, or to that socket).
    pub fn missed(
        &mut self,
        nsp: &str,
        cursor: u64,
        sid: &str,
        max: usize,
        ctx: &Ctx<'_>,
    ) -> Batch {
        let mut batch = Batch {
            packets: Vec::new(),
            cursor,
            gap: false,
        };
        self.sweep_one(nsp, ctx);
        self.publish();
        let Some(record) = self.records.get(nsp) else {
            batch.gap = true;
            return batch;
        };
        let first = record.packets.front().map_or(record.next_seq, |p| p.seq);
        if first > cursor.saturating_add(1) || cursor < record.barrier {
            batch.gap = true;
            return batch;
        }
        for packet in record.packets.iter().filter(|p| p.seq > cursor) {
            if batch.packets.len() >= max {
                break;
            }
            batch.cursor = packet.seq;
            if packet.target.as_deref().is_none_or(|target| target == sid) {
                batch.packets.push(Arc::clone(&packet.json));
            }
        }
        batch
    }

    /// Ends a restore (successful or not).
    pub fn finish_restore(&mut self, nsp: &str) {
        if let Some(record) = self.records.get_mut(nsp) {
            record.restoring = record.restoring.saturating_sub(1);
        }
        self.drop_if_empty(nsp);
    }

    /// The periodic sweep over every namespace.
    pub fn sweep(&mut self, ctx: &Ctx<'_>) {
        let names: Vec<String> = self.records.keys().cloned().collect();
        for name in names {
            self.sweep_one(&name, ctx);
            self.drop_if_empty(&name);
        }
        self.publish();
    }

    /// Drops everything (shutdown). Packets a replay still holds stay charged until it lets go.
    pub fn clear(&mut self) {
        self.records.clear();
        self.owners.clear();
        self.anonymous = Group::default();
        self.owned = 0;
        self.owned_bytes = 0;
        self.packets = 0;
        self.stored_bytes = 0;
        self.sessions = 0;
        self.session_bytes = 0;
        self.publish();
    }

    #[cfg(test)]
    fn stored(&self, nsp: &str) -> usize {
        self.records.get(nsp).map_or(0, |r| r.packets.len())
    }

    #[cfg(test)]
    fn kept(&self, nsp: &str) -> usize {
        self.records.get(nsp).map_or(0, |r| r.sessions.len())
    }

    #[cfg(test)]
    fn has_after(&self, nsp: &str, cursor: u64) -> bool {
        self.records
            .get(nsp)
            .and_then(|r| r.packets.back())
            .is_some_and(|last| last.seq > cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::NoTelemetry;

    fn ctx(now: i64) -> Ctx<'static> {
        Ctx {
            limits: RecoveryLimits::default(),
            timing: Timing {
                max_disconnection_ms: 120_000,
                sweep_interval_ms: 60_000,
            },
            telemetry: &NoTelemetry,
            now,
        }
    }

    fn json(text: &str) -> Arc<str> {
        Arc::from(text)
    }

    fn session<D: crate::RetainedSize + Send + Sync + 'static>(
        sid: &str,
        pid: &str,
        data: D,
        at: i64,
    ) -> Session {
        owned(sid, pid, data, at, Owner::Anonymous)
    }

    fn owned<D: crate::RetainedSize + Send + Sync + 'static>(
        sid: &str,
        pid: &str,
        data: D,
        at: i64,
        owner: Owner,
    ) -> Session {
        let cost = session_cost(sid, pid, &owner, &data);
        let leaving = Leaving {
            sid: sid.into(),
            pid: pid.into(),
            data: Arc::new(data),
            socket: 0,
            owner,
            released: CancellationToken::new(),
        };
        Session::new(leaving, at, cost)
    }

    fn store() -> (Arc<Totals>, Store) {
        let totals = Arc::new(Totals::default());
        (Arc::clone(&totals), Store::new(totals))
    }

    #[test]
    fn restore_replays_after_the_offset_for_the_namespace_and_the_socket() {
        let (totals, mut state) = store();
        let c = ctx(1_000);
        assert!(state.append("/n", None, "o1", json("[\"a\",\"o1\"]"), &c));
        state.persist("/n", session("sid1", "pid1", 7_u8, 1_000), &c);
        assert!(state.append("/n", None, "o2", json("[\"b\",\"o2\"]"), &c));
        assert!(state.append("/n", Some("other"), "o3", json("[\"c\",\"o3\"]"), &c));
        assert!(state.append("/n", Some("sid1"), "o4", json("[\"d\",\"o4\"]"), &c));
        let restored = state.restore("/n", "pid1", "o1", &c).unwrap();
        let sid = restored.sid.clone();
        let data = Arc::downcast::<u8>(restored.data).unwrap();
        assert_eq!((sid.as_str(), *data), ("sid1", 7));
        let batch = state.missed("/n", restored.cursor, "sid1", 100, &c);
        assert_eq!(
            batch.packets.iter().map(|p| &***p).collect::<Vec<_>>(),
            ["[\"b\",\"o2\"]", "[\"d\",\"o4\"]"]
        );
        assert!(!state.has_after("/n", batch.cursor));
        // Claimed: a second reconnect with the same private id gets nothing.
        assert_eq!(
            state.restore("/n", "pid1", "o1", &c).map(|r| r.sid).err(),
            Some(RecoveryOutcome::UnknownSession)
        );
        state.finish_restore("/n");
        assert_eq!(totals.sessions.load(Ordering::Acquire), 0);
    }

    #[test]
    fn misses_unknown_offsets_expired_sessions_and_wrong_namespaces() {
        let (_, mut state) = store();
        let c = ctx(0);
        state.append("/n", None, "o1", json("[\"a\",\"o1\"]"), &c);
        state.persist("/n", session("s", "p", (), 0), &c);
        assert!(matches!(
            state.restore("/n", "p", "nope", &c),
            Err(RecoveryOutcome::UnknownOffset)
        ));
        assert!(matches!(
            state.restore("/other", "p", "o1", &c),
            Err(RecoveryOutcome::UnknownSession)
        ));
        assert!(matches!(
            state.restore("/n", "forged", "o1", &c),
            Err(RecoveryOutcome::UnknownSession)
        ));
        // 120 s later is still in time; 120.001 s is not.
        assert!(state.restore("/n", "p", "o1", &ctx(120_000)).is_ok());
        state.finish_restore("/n");
        state.persist("/n", session("s", "p2", (), 0), &c);
        state.append("/n", None, "o2", json("[\"a\",\"o2\"]"), &c);
        assert!(matches!(
            state.restore("/n", "p2", "o2", &ctx(120_001)),
            Err(RecoveryOutcome::Expired)
        ));
    }

    #[test]
    fn packets_expire_on_the_sweep_schedule() {
        let (_, mut state) = store();
        // Created at 0: sweeps at 60 s, 120 s, 180 s…
        state.append("/n", None, "o1", json("[1]"), &ctx(0));
        state.append("/n", None, "o2", json("[2]"), &ctx(50_000));
        // At 170 s the last sweep was at 120 s (threshold 0): nothing older than 0.
        state.persist("/n", session("s", "p", (), 169_000), &ctx(170_000));
        assert_eq!(state.stored("/n"), 2);
        // At 180 s (threshold 60 s) both are gone.
        assert!(matches!(
            state.restore("/n", "p", "o2", &ctx(180_000)),
            Err(RecoveryOutcome::UnknownOffset)
        ));
        assert_eq!(state.stored("/n"), 0);
        // The periodic sweep drops namespaces nobody touches any more.
        state.append("/m", None, "o3", json("[3]"), &ctx(200_000));
        state.sweep(&ctx(260_000));
        assert_eq!(state.stored("/m"), 1);
        state.sweep(&ctx(380_000));
        assert_eq!(state.stored("/m"), 0);
        assert!(!state.records.contains_key("/m"));
    }

    #[test]
    fn bounds_drop_the_oldest_and_a_gap_is_reported() {
        let (totals, mut state) = store();
        let mut c = ctx(0);
        c.limits.packets_per_namespace = 3;
        for i in 0..5 {
            assert!(state.append("/n", None, &format!("o{i}"), json("[0]"), &c));
        }
        assert_eq!(state.stored("/n"), 3);
        assert_eq!(totals.packets.load(Ordering::Acquire), 3);
        // A cursor before the retained range is a gap.
        state.persist("/n", session("s", "p", (), 0), &c);
        let restored = state.restore("/n", "p", "o2", &c).unwrap();
        assert!(!state.missed("/n", restored.cursor, "s", 10, &c).gap);
        assert!(state.missed("/n", 0, "s", 10, &c).gap);
        // Server-wide: the largest namespace gives way.
        c.limits.packets_per_namespace = 100;
        c.limits.packets_total = 4;
        assert!(state.append("/m", None, "x1", json("[0]"), &c));
        assert!(state.append("/m", None, "x2", json("[0]"), &c));
        assert_eq!(totals.packets.load(Ordering::Acquire), 4);
        assert_eq!((state.stored("/n"), state.stored("/m")), (2, 2));
        // Sessions.
        c.limits.sessions_per_namespace = 2;
        for i in 0..4 {
            state.persist("/s", session(&format!("s{i}"), &format!("p{i}"), (), i), &c);
        }
        assert_eq!(totals.sessions.load(Ordering::Acquire), 2);
        c.limits.session_bytes = 10;
        assert!(!state.persist("/s", session("s", "p", (), 9), &c));
        state.clear();
        assert_eq!(totals.packets.load(Ordering::Acquire), 0);
        assert_eq!(totals.sessions.load(Ordering::Acquire), 0);
        assert_eq!(totals.bytes.load(Ordering::Acquire), 0);
    }

    /// Finding 6: one channel's churn cannot evict the others'. Changed on purpose by H3: for
    /// sessions, fairness is between verified owners (a namespace name proves nothing), so
    /// the churning and the quiet channel are owners here; packets stay fair between
    /// namespaces (the server emits them, no client chooses how many).
    #[test]
    fn eviction_at_the_server_limit_is_fair_between_owners() {
        let (_, mut state) = store();
        let mut c = ctx(0);
        c.limits.sessions_per_namespace = 100;
        c.limits.sessions_per_owner = 100;
        c.limits.sessions_total = 10;
        c.limits.anonymous_sessions = 0;
        let quiet = Owner::verified("channel:quiet");
        let busy = Owner::verified("channel:busy");
        for i in 0..3 {
            let s = owned(&format!("q{i}"), &format!("qp{i}"), (), i, quiet.clone());
            state.persist("/quiet", s, &c);
        }
        // A churning channel keeps disconnecting new sockets.
        for i in 0..1000 {
            let s = owned(
                &format!("b{i}"),
                &format!("bp{i}"),
                (),
                10 + i,
                busy.clone(),
            );
            state.persist("/busy", s, &c);
        }
        assert_eq!((state.kept("/quiet"), state.kept("/busy")), (3, 7));
        // The quiet one still gets room, from the busy one.
        let s = owned("q9", "qp9", (), 5_000, quiet.clone());
        state.persist("/quiet", s, &c);
        assert_eq!((state.kept("/quiet"), state.kept("/busy")), (4, 6));
        // Packets: the same rule by stored bytes, between namespaces.
        c.limits.packets_total = 10;
        for i in 0..3 {
            assert!(state.append("/quiet", None, &format!("q{i}"), json("[0]"), &c));
        }
        for i in 0..1000 {
            assert!(state.append("/busy", None, &format!("b{i}"), json("[0]"), &c));
        }
        assert_eq!((state.stored("/quiet"), state.stored("/busy")), (3, 7));
    }

    /// H3 (re-check of 2026-11-12), the review's case: three slots, the real channel holds two
    /// sessions, an outsider spreads sessions over made-up names of the same family. Before,
    /// eviction was fair between namespaces and the real channel, holding the most, gave
    /// first (it kept 0 of 2). Its sessions now belong to its verified owner; the outsider's,
    /// anonymous, share their own pool and push out only each other, whatever the names, and
    /// also inside the real channel's own namespace.
    #[test]
    fn made_up_namespaces_cannot_push_a_real_channel_out() {
        let (totals, mut state) = store();
        let mut c = ctx(0);
        c.limits.sessions_total = 3;
        c.limits.anonymous_sessions = 1;
        c.limits.sessions_per_namespace = 3;
        let channel = Owner::verified("channel:1");
        state.persist("/clip/chan", owned("r1", "rp1", (), 0, channel.clone()), &c);
        state.persist("/clip/chan", owned("r2", "rp2", (), 1, channel.clone()), &c);
        for i in 0..100 {
            let nsp = format!("/clip/x{i}");
            state.persist(
                &nsp,
                session(&format!("x{i}"), &format!("xp{i}"), (), 10 + i),
                &c,
            );
        }
        assert_eq!(state.kept("/clip/chan"), 2);
        assert_eq!(state.kept("/clip/x99"), 1);
        assert_eq!(totals.sessions.load(Ordering::Acquire), 3);
        // The same from inside the real channel's namespace: at the namespace's bound an
        // anonymous newcomer takes only an anonymous session's place.
        for i in 0..100 {
            let s = session(&format!("y{i}"), &format!("yp{i}"), (), 200 + i);
            state.persist("/clip/chan", s, &c);
        }
        assert_eq!(state.kept("/clip/chan"), 3);
        let kept = &state.records["/clip/chan"].sessions;
        assert!(find(kept, "rp1").is_some() && find(kept, "rp2").is_some());
        assert_eq!(state.anonymous.order.len(), 1);
    }

    /// H3, the reverse: many owners, one greedy. The greedy owner is held to its quota, and
    /// when the owned pool is full it is the one that gives; the others keep everything.
    #[test]
    fn a_greedy_owner_gives_first_and_stops_at_its_quota() {
        let (_, mut state) = store();
        let mut c = ctx(0);
        c.limits.sessions_total = 30;
        c.limits.anonymous_sessions = 0;
        c.limits.sessions_per_owner = 100;
        for owner in 0..10 {
            for i in 0..2 {
                let key = format!("o{owner}-{i}");
                let s = owned(&key, &key, (), i, Owner::verified(format!("user:{owner}")));
                state.persist(&format!("/u/{owner}"), s, &c);
            }
        }
        let greedy = Owner::verified("user:greedy");
        for i in 0..1000 {
            let key = format!("g{i}");
            let s = owned(&key, &key, (), 10 + i, greedy.clone());
            state.persist(&format!("/g/{i}"), s, &c);
        }
        assert!((0..10).all(|owner| state.kept(&format!("/u/{owner}")) == 2));
        assert_eq!(state.owners["user:greedy"].order.len(), 10);
        // The newest of the greedy owner are the ones kept.
        assert_eq!(state.kept("/g/999"), 1);
        assert_eq!(state.kept("/g/989"), 0);
        // Its quota, with room in the pool: 5.
        c.limits.sessions_total = 1000;
        c.limits.sessions_per_owner = 5;
        for i in 0..20 {
            let key = format!("h{i}");
            let s = owned(&key, &key, (), 2_000 + i, greedy.clone());
            state.persist(&format!("/h/{i}"), s, &c);
        }
        assert_eq!(state.owners["user:greedy"].order.len(), 5);
        assert!((0..10).all(|owner| state.kept(&format!("/u/{owner}")) == 2));
        // Bytes: when bytes are what is full, the owner holding the most bytes gives first.
        let big = Owner::verified("user:big");
        c.limits.anonymous_session_bytes = 0;
        c.limits.session_bytes_total = state.session_bytes + 3_000;
        for i in 0..4 {
            let key = format!("big{i}");
            let s = owned(&key, &key, "z".repeat(1_000), 3_000 + i, big.clone());
            assert!(state.persist("/big", s, &c));
        }
        assert_eq!(state.kept("/big"), 2);
        assert!((0..10).all(|owner| state.kept(&format!("/u/{owner}")) == 2));
        assert_eq!(state.owners["user:greedy"].order.len(), 5);
    }

    /// Finding 7: a session costs what its data really keeps.
    #[test]
    fn sessions_are_measured_by_what_their_data_keeps() {
        let (totals, mut state) = store();
        let mut c = ctx(0);
        c.limits.session_bytes = 16 << 10;
        // `size_of::<String>()` is 24 bytes; its contents are 20 kB.
        assert!(!state.persist("/n", session("s", "p", "x".repeat(20_000), 0), &c));
        let mut map = std::collections::HashMap::new();
        map.insert("k".to_owned(), vec![0_u8; 20_000]);
        assert!(!state.persist("/n", session("s", "p", map, 0), &c));
        assert!(state.persist("/n", session("s", "p", "x".repeat(1_000), 0), &c));
        let kept = totals.session_bytes.load(Ordering::Acquire);
        assert!((1_000..1_200).contains(&kept), "{kept}");
        // All sessions together stay within their own total.
        c.limits.session_bytes_total = 3_000;
        assert!(state.persist("/n", session("s2", "p2", "y".repeat(1_000), 1), &c));
        assert!(state.persist("/n", session("s3", "p3", "z".repeat(1_000), 2), &c));
        assert_eq!(state.kept("/n"), 2);
        assert!(totals.session_bytes.load(Ordering::Acquire) <= 3_000);
        // Measured again once the old socket's handlers ended: grown past the limit, dropped.
        state.settle("/n", "p3", 0, 20_000, &c);
        assert_eq!(state.kept("/n"), 1);
    }

    /// Finding 9: sessions are filed under the digest of their private id; a private id that
    /// differs from the kept one, however slightly, finds nothing.
    #[test]
    fn private_ids_are_looked_up_by_digest_and_compared_whole() {
        let (_, mut state) = store();
        let c = ctx(0);
        state.append("/n", None, "o1", json("[0]"), &c);
        state.persist("/n", session("s", "abcdefghijklmnopqrst", (), 0), &c);
        let record = &state.records["/n"];
        assert!(record.sessions.contains_key(&key("abcdefghijklmnopqrst")));
        for forged in [
            "abcdefghijklmnopqrsu",
            "abcdefghijklmnopqrs",
            "",
            "Abcdefghijklmnopqrst",
        ] {
            assert!(find(&record.sessions, forged).is_none(), "{forged}");
            assert!(!state.owns("/n", forged, 0));
        }
        assert!(
            state
                .restore("/n", "abcdefghijklmnopqrst", "o1", &c)
                .is_ok()
        );
    }

    /// H2 (re-check of 2026-11-12): a replay shares the store's reservation. The review's
    /// sequence: a restore takes its batch, newer events evict the batch's packets from the
    /// store; the budget's figure is what is alive (stored, or held by the replay), never above
    /// the bound, and the replay's share comes back when it lets go.
    #[test]
    fn a_replay_batch_keeps_its_packets_charged_until_it_lets_go() {
        let (totals, mut state) = store();
        let mut c = ctx(0);
        let text = |i: usize| json(&format!("[\"{}\",\"o{i}\"]", "x".repeat(1_000)));
        // Every packet costs the same: its text, its offset and the fixed overhead.
        let cost = OVERHEAD + text(0).len() + "o0".len();
        c.limits.bytes_total = 6 * cost;
        for i in 0..4 {
            assert!(state.append("/n", None, &format!("o{i}"), text(i), &c));
        }
        state.persist("/n", session("s", "p", (), 0), &c);
        let restored = state.restore("/n", "p", "o0", &c).unwrap();
        let batch = state.missed("/n", restored.cursor, "s", 64, &c);
        assert_eq!(batch.packets.len(), 3);
        // Six newer events: the store keeps the newest it can; the batch's three stay alive.
        for i in 4..10 {
            state.append("/n", None, &format!("o{i}"), text(i), &c);
        }
        let stored = state.stored("/n");
        assert_eq!(
            totals.bytes.load(Ordering::Acquire),
            (stored + batch.packets.len()) * cost,
            "the figure is what is alive"
        );
        assert!(totals.bytes.load(Ordering::Acquire) <= c.limits.bytes_total);
        assert_eq!(stored, 3);
        // The replay ends: its share is given back; the store has room again.
        drop(batch);
        assert_eq!(totals.bytes.load(Ordering::Acquire), stored * cost);
        assert!(state.append("/n", None, "o9x", text(9), &c));
        // One byte more: its offset is one character longer.
        assert_eq!(totals.bytes.load(Ordering::Acquire), 4 * cost + 1);
        state.finish_restore("/n");
    }

    /// Finding 8: an event that cannot be stored still takes its place in the sequence, and
    /// a restore from an offset before it fails instead of replaying around the hole.
    #[test]
    fn an_event_that_could_not_be_stored_breaks_earlier_offsets() {
        let (_, mut state) = store();
        let mut c = ctx(0);
        c.limits.bytes_per_namespace = 1_000;
        assert!(state.append("/n", None, "o1", json("[\"a\"]"), &c));
        state.persist("/n", session("s", "p", (), 0), &c);
        let big = json(&format!("[\"{}\"]", "x".repeat(2_000)));
        assert!(!state.append("/n", None, "o2", big, &c));
        assert!(state.append("/n", None, "o3", json("[\"c\"]"), &c));
        assert!(matches!(
            state.restore("/n", "p", "o1", &c),
            Err(RecoveryOutcome::Discontinuity)
        ));
        // From after the hole, recovery works.
        let restored = state.restore("/n", "p", "o3", &c).unwrap();
        let batch = state.missed("/n", restored.cursor, "s", 10, &c);
        assert!(!batch.gap && batch.packets.is_empty());
        // A cursor before the hole is a gap for a restore already under way.
        assert!(state.missed("/n", 0, "s", 10, &c).gap);
    }
}
