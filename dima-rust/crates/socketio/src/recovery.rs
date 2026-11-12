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
//! - **Fair eviction.** A namespace over its own limits drops its own oldest entries. When a
//!   server-wide limit is reached, the oldest entry of the namespace holding the most of that
//!   kind (stored bytes for packets, sessions for sessions) is dropped, the writer's own
//!   namespace included. So one channel's churn drops its own entries before it can push any
//!   other channel below its size, and the namespaces converge to equal shares of the limit.
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
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio_util::sync::CancellationToken;

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

/// The session filed under `pid`'s digest, if its private id really is `pid`.
fn find<'a>(sessions: &'a HashMap<Key, Session>, pid: &str) -> Option<&'a Session> {
    sessions
        .get(&key(pid))
        .filter(|s| dima_core::crypto::constant_time_eq(s.pid.as_bytes(), pid.as_bytes()))
}

/// Readable copies of the store's totals (for [`crate::Stats`]); written under the store lock.
#[derive(Debug, Default)]
pub struct Totals {
    pub packets: AtomicUsize,
    pub bytes: AtomicUsize,
    pub sessions: AtomicUsize,
    pub session_bytes: AtomicUsize,
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
    /// The event's data array, offset included (`["name",…,"<offset>"]`).
    json: Arc<str>,
    emitted_ms: i64,
    cost: usize,
}

/// The socket data a session keeps, whatever its type (a name belongs to one declaration, which
/// restores it as its own type).
pub type Data = Arc<dyn Any + Send + Sync>;

/// A kept session.
pub struct Session {
    pub sid: String,
    pub pid: String,
    pub data: Data,
    /// The key of the socket that left it: only that socket's late emits may still be stored
    /// for it, and only while the session is not claimed.
    owner: u64,
    /// Fires when every handler of that socket has ended: a restore waits for it.
    released: CancellationToken,
    disconnected_ms: i64,
    cost: usize,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("sid", &self.sid)
            .field("owner", &self.owner)
            .field("cost", &self.cost)
            .finish_non_exhaustive()
    }
}

/// What a session costs: its ids, its data as it is now, and a fixed overhead. Measuring
/// compacts what the data's locks guard ([`crate::RetainedSize`]), so it takes the data's own
/// locks: never call it with the store lock held (a handler holding its data's lock may be
/// waiting for the store lock to emit).
pub fn session_cost<D: crate::RetainedSize>(sid: &str, pid: &str, data: &D) -> usize {
    OVERHEAD
        .saturating_add(sid.len())
        .saturating_add(pid.len())
        .saturating_add(std::mem::size_of::<D>())
        .saturating_add(data.retained_bytes())
}

impl Session {
    /// A session for a socket that just left; `cost` is [`session_cost`] of it, measured
    /// before the store lock was taken.
    pub fn new<D: Send + Sync + 'static>(
        sid: String,
        pid: String,
        data: Arc<D>,
        owner: u64,
        released: CancellationToken,
        disconnected_ms: i64,
        cost: usize,
    ) -> Self {
        Self {
            sid,
            pid,
            data,
            owner,
            released,
            disconnected_ms,
            cost,
        }
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

    fn oldest_session(&self) -> Option<Key> {
        self.sessions
            .iter()
            .min_by_key(|(_, s)| s.disconnected_ms)
            .map(|(key, _)| *key)
    }
}

/// A restored session: where its missed events start.
pub struct Restored {
    pub sid: String,
    pub pid: String,
    pub data: Data,
    pub cursor: u64,
    /// Fires when the socket that left the session has no handler running any more.
    pub released: CancellationToken,
}

/// The next missed events for a restoring socket.
#[derive(Debug, Default)]
pub struct Batch {
    pub packets: Vec<Arc<str>>,
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
    bytes: usize,
    sessions: usize,
    session_bytes: usize,
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
        self.totals.bytes.store(self.bytes, Ordering::Release);
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
        self.bytes = self.bytes.saturating_sub(packet.cost);
        true
    }

    fn remove_session(&mut self, nsp: &str, key: &Key) -> Option<Session> {
        let session = self.records.get_mut(nsp)?.sessions.remove(key)?;
        self.sessions = self.sessions.saturating_sub(1);
        self.session_bytes = self.session_bytes.saturating_sub(session.cost);
        Some(session)
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

    /// The namespace keeping the most sessions.
    fn largest_by_sessions(&self) -> Option<String> {
        self.records
            .iter()
            .filter(|(_, r)| !r.sessions.is_empty())
            .max_by_key(|(_, r)| r.sessions.len())
            .map(|(name, _)| name.clone())
    }

    /// Stores one eligible event. When the bounds leave no room for it (it alone is larger than
    /// a namespace's or the server's byte limit), it is not stored but still takes its place in
    /// the sequence, and offsets before it can no longer be recovered. Returns whether it was
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
            let record = self.record(nsp, ctx);
            let seq = record.next_seq;
            record.next_seq += 1;
            record.barrier = seq + 1;
            ctx.telemetry.recovery_evicted(nsp, Eviction::NotStored);
            self.drop_if_empty(nsp);
            self.publish();
            return false;
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
        // Room in the server: the largest namespace's oldest go.
        while self.packets >= limits.packets_total || self.bytes + cost > limits.bytes_total {
            let Some(largest) = self.largest_by_bytes() else {
                break;
            };
            self.pop_packet(&largest);
            ctx.telemetry.recovery_evicted(&largest, Eviction::Packet);
            if largest != nsp {
                self.drop_if_empty(&largest);
            }
        }
        let record = self.record(nsp, ctx);
        let seq = record.next_seq;
        record.next_seq += 1;
        record.bytes += cost;
        record.packets.push_back(Stored {
            seq,
            offset: offset.to_owned(),
            target: target.map(str::to_owned),
            json,
            emitted_ms: ctx.now,
            cost,
        });
        self.packets += 1;
        self.bytes += cost;
        self.publish();
        true
    }

    /// Makes room for one more session of `cost` bytes in `nsp`; `false` when there is none.
    fn room_for_session(&mut self, nsp: &str, cost: usize, ctx: &Ctx<'_>) -> bool {
        let limits = ctx.limits;
        loop {
            let record = self.record(nsp, ctx);
            if record.sessions.len() < limits.sessions_per_namespace {
                break;
            }
            let Some(oldest) = record.oldest_session() else {
                break;
            };
            self.remove_session(nsp, &oldest);
            ctx.telemetry.recovery_evicted(nsp, Eviction::Session);
        }
        while self.sessions >= limits.sessions_total
            || self.session_bytes + cost > limits.session_bytes_total
        {
            let Some(largest) = self.largest_by_sessions() else {
                return false;
            };
            let Some(oldest) = self.records.get(&largest).and_then(Record::oldest_session) else {
                return false;
            };
            self.remove_session(&largest, &oldest);
            ctx.telemetry.recovery_evicted(&largest, Eviction::Session);
            if largest != nsp {
                self.drop_if_empty(&largest);
            }
        }
        true
    }

    /// Keeps a session (`persistSession`). Returns `false` when it was not kept.
    pub fn persist(&mut self, nsp: &str, session: Session, ctx: &Ctx<'_>) -> bool {
        let limits = ctx.limits;
        if session.cost > limits.session_bytes || session.cost > limits.session_bytes_total {
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
        if !self.room_for_session(nsp, session.cost, ctx) {
            self.drop_if_empty(nsp);
            self.publish();
            return false;
        }
        self.sessions += 1;
        self.session_bytes += session.cost;
        let record = self.record(nsp, ctx);
        record.sessions.insert(key(&session.pid), session);
        self.publish();
        true
    }

    /// Measures a kept session again once the socket that left it has no handler running
    /// (`on_disconnect` may have changed its data): `cost` is its size now. A session that grew
    /// past `session_bytes` is dropped; one that grew is given room as a new one would be.
    pub fn settle(&mut self, nsp: &str, pid: &str, owner: u64, cost: usize, ctx: &Ctx<'_>) {
        let unchanged = self
            .records
            .get(nsp)
            .and_then(|r| find(&r.sessions, pid))
            .filter(|s| s.owner == owner)
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

    /// Whether the session of `pid` is still kept, unclaimed, for the socket `owner` that left
    /// it (its late emits may then still be stored for it).
    pub fn owns(&self, nsp: &str, pid: &str, owner: u64) -> bool {
        self.records
            .get(nsp)
            .and_then(|record| find(&record.sessions, pid))
            .is_some_and(|session| session.owner == owner)
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

    /// Drops everything (shutdown).
    pub fn clear(&mut self) {
        self.records.clear();
        self.packets = 0;
        self.bytes = 0;
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
        let cost = session_cost(sid, pid, &data);
        Session::new(
            sid.into(),
            pid.into(),
            Arc::new(data),
            0,
            CancellationToken::new(),
            at,
            cost,
        )
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
            batch.packets.iter().map(|p| p.as_ref()).collect::<Vec<_>>(),
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

    /// Finding 6: one namespace's churn cannot evict every other namespace's sessions or
    /// packets: at the server-wide limit the largest namespace gives way first.
    #[test]
    fn eviction_at_the_server_limit_is_fair_between_namespaces() {
        let (_, mut state) = store();
        let mut c = ctx(0);
        c.limits.sessions_per_namespace = 100;
        c.limits.sessions_total = 10;
        for i in 0..3 {
            state.persist(
                "/quiet",
                session(&format!("q{i}"), &format!("qp{i}"), (), i),
                &c,
            );
        }
        // A churning namespace keeps disconnecting new sockets.
        for i in 0..1000 {
            state.persist(
                "/busy",
                session(&format!("b{i}"), &format!("bp{i}"), (), 10 + i),
                &c,
            );
        }
        assert_eq!((state.kept("/quiet"), state.kept("/busy")), (3, 7));
        // The quiet one still gets room, from the busy one.
        state.persist("/quiet", session("q9", "qp9", (), 5_000), &c);
        assert_eq!((state.kept("/quiet"), state.kept("/busy")), (4, 6));
        // Packets: the same rule by stored bytes.
        c.limits.packets_total = 10;
        for i in 0..3 {
            assert!(state.append("/quiet", None, &format!("q{i}"), json("[0]"), &c));
        }
        for i in 0..1000 {
            assert!(state.append("/busy", None, &format!("b{i}"), json("[0]"), &c));
        }
        assert_eq!((state.stored("/quiet"), state.stored("/busy")), (3, 7));
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
