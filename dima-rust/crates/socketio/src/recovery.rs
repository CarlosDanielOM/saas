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
//! comes back with its id and data, the check is skipped (`skipMiddlewares`), the events after
//! the offset meant for the namespace or for that socket are sent before the CONNECT packet, and
//! the CONNECT carries the same private id, which is what makes the client's `recovered` true.
//!
//! Expiry follows the reference's schedule: its adapter sweeps every 60 s from the namespace's
//! creation and drops what disconnected or was emitted more than 2 minutes before that sweep,
//! so a packet stays findable for up to 3 minutes. Restoring also refuses a session older than
//! 2 minutes.
//!
//! Deliberate differences: a session is claimed by the restore that uses it (the reference keeps
//! it until it expires, so two reconnects with the same private id would both get the socket id);
//! the stores are bounded ([`RecoveryLimits`]): the oldest packets and sessions of the namespace
//! being written are dropped first, and a client whose offset or session is gone connects fresh.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::config::RecoveryLimits;
use crate::telemetry::{Eviction, RecoveryOutcome, Telemetry};

/// Fixed cost counted for every stored packet and session besides its text.
const OVERHEAD: usize = 64;

/// The server-wide totals every store counts against.
#[derive(Debug, Default)]
pub struct Totals {
    pub packets: AtomicUsize,
    pub bytes: AtomicUsize,
    pub sessions: AtomicUsize,
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

/// A kept session.
#[derive(Debug)]
pub struct Session<D> {
    pub sid: String,
    pub pid: String,
    pub data: Arc<D>,
    disconnected_ms: i64,
    cost: usize,
}

impl<D> Session<D> {
    /// A session for a socket that just left.
    pub fn new(sid: String, pid: String, data: Arc<D>, disconnected_ms: i64) -> Self {
        let cost = OVERHEAD + sid.len() + pid.len() + std::mem::size_of::<D>();
        Self {
            sid,
            pid,
            data,
            disconnected_ms,
            cost,
        }
    }
}

#[derive(Debug)]
struct Record<D> {
    created_ms: i64,
    swept_ms: i64,
    next_seq: u64,
    packets: VecDeque<Stored>,
    bytes: usize,
    sessions: HashMap<String, Session<D>>,
    /// Restores sending this record's packets; the record is kept while any runs.
    restoring: usize,
}

impl<D> Record<D> {
    fn new(now: i64) -> Self {
        Self {
            created_ms: now,
            swept_ms: now,
            next_seq: 0,
            packets: VecDeque::new(),
            bytes: 0,
            sessions: HashMap::new(),
            restoring: 0,
        }
    }

    fn is_empty(&self) -> bool {
        self.packets.is_empty() && self.sessions.is_empty() && self.restoring == 0
    }

    fn pop_packet(&mut self, totals: &Totals) -> bool {
        let Some(packet) = self.packets.pop_front() else {
            return false;
        };
        self.bytes = self.bytes.saturating_sub(packet.cost);
        totals.packets.fetch_sub(1, Ordering::AcqRel);
        totals.bytes.fetch_sub(packet.cost, Ordering::AcqRel);
        true
    }

    fn remove_session(&mut self, pid: &str, totals: &Totals) -> Option<Session<D>> {
        let session = self.sessions.remove(pid)?;
        totals.sessions.fetch_sub(1, Ordering::AcqRel);
        Some(session)
    }

    /// The reference's periodic sweep, applied for the last tick that has passed.
    fn sweep(&mut self, now: i64, timing: Timing, totals: &Totals) {
        let tick = if timing.sweep_interval_ms > 0 {
            let elapsed = now.saturating_sub(self.created_ms).max(0);
            self.created_ms + elapsed / timing.sweep_interval_ms * timing.sweep_interval_ms
        } else {
            now
        };
        if tick <= self.swept_ms {
            return;
        }
        self.swept_ms = tick;
        let threshold = tick.saturating_sub(timing.max_disconnection_ms);
        // `for (i = length - 1; i >= 0; i--) if (packets[i].emittedAt < threshold) splice(0, i + 1)`
        if let Some(last) = self.packets.iter().rposition(|p| p.emitted_ms < threshold) {
            for _ in 0..=last {
                self.pop_packet(totals);
            }
        }
        let expired: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, s)| s.disconnected_ms < threshold)
            .map(|(pid, _)| pid.clone())
            .collect();
        for pid in expired {
            self.remove_session(&pid, totals);
        }
    }
}

/// A restored session: where its missed events start.
#[derive(Debug)]
pub struct Restored<D> {
    pub sid: String,
    pub pid: String,
    pub data: Arc<D>,
    pub cursor: u64,
}

/// The next missed events for a restoring socket.
#[derive(Debug, Default)]
pub struct Batch {
    pub packets: Vec<Arc<str>>,
    pub cursor: u64,
    /// Events after the cursor were dropped: the replay would be partial.
    pub gap: bool,
}

/// The store of one namespace declaration (all members of a family share it).
#[derive(Debug)]
pub struct State<D> {
    records: HashMap<String, Record<D>>,
    /// This store's packets in emission order: `(namespace, seq)`, for eviction under the
    /// server-wide caps. Entries of packets already dropped are skipped and compacted.
    order: VecDeque<(String, u64)>,
}

impl<D> Default for State<D> {
    fn default() -> Self {
        Self {
            records: HashMap::new(),
            order: VecDeque::new(),
        }
    }
}

/// Everything a store operation needs besides the state.
pub struct Ctx<'a> {
    pub limits: RecoveryLimits,
    pub timing: Timing,
    pub totals: &'a Totals,
    pub telemetry: &'a dyn Telemetry,
    pub now: i64,
}

impl<D> State<D> {
    fn record(&mut self, nsp: &str, ctx: &Ctx<'_>) -> &mut Record<D> {
        let record = self
            .records
            .entry(nsp.to_owned())
            .or_insert_with(|| Record::new(ctx.now));
        record.sweep(ctx.now, ctx.timing, ctx.totals);
        record
    }

    fn drop_if_empty(&mut self, nsp: &str) {
        if self.records.get(nsp).is_some_and(Record::is_empty) {
            self.records.remove(nsp);
        }
    }

    /// Drops this store's oldest live packet; `false` when it has none.
    fn evict_oldest(&mut self, ctx: &Ctx<'_>) -> bool {
        while let Some((nsp, seq)) = self.order.pop_front() {
            let Some(record) = self.records.get_mut(&nsp) else {
                continue;
            };
            if record.packets.front().is_some_and(|p| p.seq == seq) {
                record.pop_packet(ctx.totals);
                ctx.telemetry.recovery_evicted(&nsp, Eviction::Packet);
                self.drop_if_empty(&nsp);
                return true;
            }
        }
        false
    }

    /// Stores one eligible event. Returns `false` when the bounds left no room.
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
            return false;
        }
        // Room in the namespace.
        {
            let record = self.record(nsp, ctx);
            while !record.packets.is_empty()
                && (record.packets.len() >= limits.packets_per_namespace
                    || record.bytes + cost > limits.bytes_per_namespace)
            {
                record.pop_packet(ctx.totals);
                ctx.telemetry.recovery_evicted(nsp, Eviction::Packet);
            }
        }
        // Room in the server.
        while ctx.totals.packets.load(Ordering::Acquire) >= limits.packets_total
            || ctx.totals.bytes.load(Ordering::Acquire) + cost > limits.bytes_total
        {
            if !self.evict_oldest(ctx) {
                self.drop_if_empty(nsp);
                return false;
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
        ctx.totals.packets.fetch_add(1, Ordering::AcqRel);
        ctx.totals.bytes.fetch_add(cost, Ordering::AcqRel);
        self.order.push_back((nsp.to_owned(), seq));
        self.compact(limits);
        true
    }

    /// Drops index entries of packets that are gone once they outnumber the live ones.
    fn compact(&mut self, limits: RecoveryLimits) {
        if self.order.len() <= limits.packets_total.saturating_mul(2).max(1024) {
            return;
        }
        let records = &self.records;
        self.order.retain(|(nsp, seq)| {
            records
                .get(nsp)
                .and_then(|r| r.packets.front())
                .is_some_and(|front| *seq >= front.seq)
        });
    }

    /// Keeps a session (`persistSession`). Returns `false` when it was not kept.
    pub fn persist(&mut self, nsp: &str, session: Session<D>, ctx: &Ctx<'_>) -> bool {
        let limits = ctx.limits;
        if session.cost > limits.session_bytes {
            ctx.telemetry
                .recovery_evicted(nsp, Eviction::SessionTooLarge);
            return false;
        }
        let replaced = {
            let record = self.record(nsp, ctx);
            record.remove_session(&session.pid, ctx.totals).is_some()
        };
        let _ = replaced;
        // Room in the namespace: drop its oldest session.
        loop {
            let record = self.record(nsp, ctx);
            if record.sessions.len() < limits.sessions_per_namespace {
                break;
            }
            let Some(oldest) = oldest_session(record) else {
                break;
            };
            record.remove_session(&oldest, ctx.totals);
            ctx.telemetry.recovery_evicted(nsp, Eviction::Session);
        }
        // Room in the server: drop this store's oldest session.
        while ctx.totals.sessions.load(Ordering::Acquire) >= limits.sessions_total {
            let oldest = self
                .records
                .iter()
                .filter_map(|(name, record)| {
                    oldest_session(record).and_then(|pid| {
                        record
                            .sessions
                            .get(&pid)
                            .map(|s| (s.disconnected_ms, name.clone(), pid))
                    })
                })
                .min_by_key(|(at, _, _)| *at);
            let Some((_, name, pid)) = oldest else {
                self.drop_if_empty(nsp);
                return false;
            };
            if let Some(record) = self.records.get_mut(&name) {
                record.remove_session(&pid, ctx.totals);
            }
            ctx.telemetry.recovery_evicted(&name, Eviction::Session);
            if name != nsp {
                self.drop_if_empty(&name);
            }
        }
        let record = self.record(nsp, ctx);
        record.sessions.insert(session.pid.clone(), session);
        ctx.totals.sessions.fetch_add(1, Ordering::AcqRel);
        true
    }

    /// `restoreSession(pid, offset)`, claiming the session.
    pub fn restore(
        &mut self,
        nsp: &str,
        pid: &str,
        offset: &str,
        ctx: &Ctx<'_>,
    ) -> Result<Restored<D>, RecoveryOutcome> {
        let max = ctx.timing.max_disconnection_ms;
        let Some(record) = self.records.get_mut(nsp) else {
            return Err(RecoveryOutcome::UnknownSession);
        };
        record.sweep(ctx.now, ctx.timing, ctx.totals);
        let outcome = match record.sessions.get(pid) {
            None => Err(RecoveryOutcome::UnknownSession),
            Some(session) if session.disconnected_ms.saturating_add(max) < ctx.now => {
                record.remove_session(pid, ctx.totals);
                Err(RecoveryOutcome::Expired)
            }
            Some(_) => match record.packets.iter().find(|p| p.offset == offset) {
                // The session stays, as in the reference: another offset may still be found.
                None => Err(RecoveryOutcome::UnknownOffset),
                Some(packet) => {
                    let cursor = packet.seq;
                    match record.remove_session(pid, ctx.totals) {
                        Some(session) => {
                            record.restoring += 1;
                            Ok(Restored {
                                sid: session.sid,
                                pid: session.pid,
                                data: session.data,
                                cursor,
                            })
                        }
                        None => Err(RecoveryOutcome::UnknownSession),
                    }
                }
            },
        };
        self.drop_if_empty(nsp);
        outcome
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
        let Some(record) = self.records.get_mut(nsp) else {
            batch.gap = true;
            return batch;
        };
        record.sweep(ctx.now, ctx.timing, ctx.totals);
        let first = record.packets.front().map_or(record.next_seq, |p| p.seq);
        if first > cursor.saturating_add(1) {
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

    /// Whether events after `cursor` exist.
    #[cfg(test)]
    pub fn has_after(&self, nsp: &str, cursor: u64) -> bool {
        self.records
            .get(nsp)
            .and_then(|r| r.packets.back())
            .is_some_and(|last| last.seq > cursor)
    }

    /// Drops everything (shutdown), releasing the totals.
    pub fn clear(&mut self, totals: &Totals) {
        for record in self.records.values_mut() {
            while record.pop_packet(totals) {}
            let pids: Vec<String> = record.sessions.keys().cloned().collect();
            for pid in pids {
                record.remove_session(&pid, totals);
            }
        }
        self.records.clear();
        self.order.clear();
    }

    #[cfg(test)]
    fn stored(&self, nsp: &str) -> usize {
        self.records.get(nsp).map_or(0, |r| r.packets.len())
    }
}

fn oldest_session<D>(record: &Record<D>) -> Option<String> {
    record
        .sessions
        .values()
        .min_by_key(|s| s.disconnected_ms)
        .map(|s| s.pid.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::NoTelemetry;

    fn ctx(totals: &Totals, now: i64) -> Ctx<'_> {
        Ctx {
            limits: RecoveryLimits::default(),
            timing: Timing {
                max_disconnection_ms: 120_000,
                sweep_interval_ms: 60_000,
            },
            totals,
            telemetry: &NoTelemetry,
            now,
        }
    }

    fn json(text: &str) -> Arc<str> {
        Arc::from(text)
    }

    #[test]
    fn restore_replays_after_the_offset_for_the_namespace_and_the_socket() {
        let totals = Totals::default();
        let mut state: State<u8> = State::default();
        let c = ctx(&totals, 1_000);
        assert!(state.append("/n", None, "o1", json("[\"a\",\"o1\"]"), &c));
        state.persist(
            "/n",
            Session::new("sid1".into(), "pid1".into(), Arc::new(7), 1_000),
            &c,
        );
        assert!(state.append("/n", None, "o2", json("[\"b\",\"o2\"]"), &c));
        assert!(state.append("/n", Some("other"), "o3", json("[\"c\",\"o3\"]"), &c));
        assert!(state.append("/n", Some("sid1"), "o4", json("[\"d\",\"o4\"]"), &c));
        let restored = state.restore("/n", "pid1", "o1", &c).unwrap();
        assert_eq!((restored.sid.as_str(), *restored.data), ("sid1", 7));
        let batch = state.missed("/n", restored.cursor, "sid1", 100, &c);
        assert_eq!(
            batch.packets.iter().map(|p| p.as_ref()).collect::<Vec<_>>(),
            ["[\"b\",\"o2\"]", "[\"d\",\"o4\"]"]
        );
        assert!(!state.has_after("/n", batch.cursor));
        // Claimed: a second reconnect with the same private id gets nothing.
        assert_eq!(
            state.restore("/n", "pid1", "o1", &c).map(|r| r.sid),
            Err(RecoveryOutcome::UnknownSession)
        );
        state.finish_restore("/n");
        assert_eq!(totals.sessions.load(Ordering::Acquire), 0);
    }

    #[test]
    fn misses_unknown_offsets_expired_sessions_and_wrong_namespaces() {
        let totals = Totals::default();
        let mut state: State<()> = State::default();
        let c = ctx(&totals, 0);
        state.append("/n", None, "o1", json("[\"a\",\"o1\"]"), &c);
        state.persist(
            "/n",
            Session::new("s".into(), "p".into(), Arc::new(()), 0),
            &c,
        );
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
        assert!(
            state
                .restore("/n", "p", "o1", &ctx(&totals, 120_000))
                .is_ok()
        );
        state.finish_restore("/n");
        state.persist(
            "/n",
            Session::new("s".into(), "p2".into(), Arc::new(()), 0),
            &c,
        );
        state.append("/n", None, "o2", json("[\"a\",\"o2\"]"), &c);
        assert!(matches!(
            state.restore("/n", "p2", "o2", &ctx(&totals, 120_001)),
            Err(RecoveryOutcome::Expired)
        ));
    }

    #[test]
    fn packets_expire_on_the_sweep_schedule() {
        let totals = Totals::default();
        let mut state: State<()> = State::default();
        // Created at 0: sweeps at 60 s, 120 s, 180 s…
        state.append("/n", None, "o1", json("[1]"), &ctx(&totals, 0));
        state.append("/n", None, "o2", json("[2]"), &ctx(&totals, 50_000));
        // At 170 s the last sweep was at 120 s (threshold 0): nothing older than 0.
        state.persist(
            "/n",
            Session::new("s".into(), "p".into(), Arc::new(()), 169_000),
            &ctx(&totals, 170_000),
        );
        assert_eq!(state.stored("/n"), 2);
        // At 180 s (threshold 60 s) both are gone.
        assert!(matches!(
            state.restore("/n", "p", "o2", &ctx(&totals, 180_000)),
            Err(RecoveryOutcome::UnknownOffset)
        ));
        assert_eq!(state.stored("/n"), 0);
    }

    #[test]
    fn bounds_drop_the_oldest_and_a_gap_is_reported() {
        let totals = Totals::default();
        let mut state: State<()> = State::default();
        let mut c = ctx(&totals, 0);
        c.limits.packets_per_namespace = 3;
        for i in 0..5 {
            assert!(state.append("/n", None, &format!("o{i}"), json("[0]"), &c));
        }
        assert_eq!(state.stored("/n"), 3);
        assert_eq!(totals.packets.load(Ordering::Acquire), 3);
        // A cursor before the retained range is a gap.
        state.persist(
            "/n",
            Session::new("s".into(), "p".into(), Arc::new(()), 0),
            &c,
        );
        let restored = state.restore("/n", "p", "o2", &c).unwrap();
        assert!(!state.missed("/n", restored.cursor, "s", 10, &c).gap);
        assert!(state.missed("/n", 0, "s", 10, &c).gap);
        // Server-wide: the store evicts its own oldest.
        c.limits.packets_per_namespace = 100;
        c.limits.packets_total = 4;
        assert!(state.append("/m", None, "x1", json("[0]"), &c));
        assert!(state.append("/m", None, "x2", json("[0]"), &c));
        assert_eq!(totals.packets.load(Ordering::Acquire), 4);
        // Sessions.
        c.limits.sessions_per_namespace = 2;
        for i in 0..4 {
            state.persist(
                "/s",
                Session::new(format!("s{i}"), format!("p{i}"), Arc::new(()), i),
                &c,
            );
        }
        assert_eq!(totals.sessions.load(Ordering::Acquire), 2);
        c.limits.session_bytes = 10;
        assert!(!state.persist(
            "/s",
            Session::new("s".into(), "p".into(), Arc::new(()), 9),
            &c
        ));
        state.clear(&totals);
        assert_eq!(totals.packets.load(Ordering::Acquire), 0);
        assert_eq!(totals.sessions.load(Ordering::Acquire), 0);
        assert_eq!(totals.bytes.load(Ordering::Acquire), 0);
    }
}
